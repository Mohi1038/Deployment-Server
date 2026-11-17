import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db, logEmitter } from './db.js';
import { gcpService, isSandboxCredential } from './gcp-service.js';
import { awsService } from './aws-service.js';
import { azureService } from './azure-service.js';
import { doService } from './do-service.js';
import { pricingService } from './pricing-service.js';
import { healthService } from './health-service.js';
import { authService } from './auth-service.js';
import { blueGreenService } from './blue-green-service.js';
import { vmOps } from './vm-ops-service.js';
import { safeName } from './startup-script.js';

// Provider router: picks the service for a deployment's cloud_provider
function getProviderService(provider) {
  switch ((provider || 'gcp').toLowerCase()) {
    case 'aws':          return awsService;
    case 'azure':        return azureService;
    case 'digitalocean':
    case 'do':           return doService;
    case 'gcp':
    default:             return gcpService;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 'loopback');

function setSessionCookie(res, token) {
  const isCrossOrigin = Boolean(process.env.FRONTEND_ORIGINS);
  const secure = isCrossOrigin || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = isCrossOrigin ? 'None' : 'Lax';
  res.setHeader('Set-Cookie', `deployment_session=${encodeURIComponent(token)}; Path=/; Max-Age=604800; HttpOnly; SameSite=${sameSite}${secure}`);
}

// Multer for JSON credential uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const allowedOrigins = (process.env.FRONTEND_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));
// Keep the raw body for GitHub webhook signature verification
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Identify the caller: user session (Bearer header, cookie, or ?token= for
// EventSource) or the GitHub bot's service token (DEPLOYMENT_API_TOKEN).
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = req.path.endsWith('/logs/stream') ? req.query.token : null;
  const token = headerToken || authService.getCookie(req, 'deployment_session') || queryToken;
  if (token) {
    const serviceToken = process.env.DEPLOYMENT_API_TOKEN;
    if (serviceToken && safeEqual(token, serviceToken)) {
      req.user = { id: 0, email: 'github-bot', name: 'DeployBase bot', role: 'service' };
    } else {
      const user = authService.verifyToken(token);
      if (user) req.user = user;
    }
  }
  const wsHeader = req.headers['x-workspace-id'] || req.query.workspace_id;
  req.workspaceId = wsHeader ? parseInt(wsHeader, 10) : 1;
  next();
});

// Every /api route needs a signed-in user, except sign-in itself, the
// public health check, the pricing table and the signed GitHub webhook.
const PUBLIC_API = [
  /^\/api\/health$/, /^\/api\/pricing$/, /^\/api\/webhook\/github$/, /^\/api\/github\/app\/setup$/,
  /^\/api\/auth\/(register|login|oauth\/config|oauth\/continue|oauth\/configure|google|google\/callback|github|github\/callback|me)$/,
];
app.use('/api', (req, res, next) => {
  if (PUBLIC_API.some(r => r.test(req.originalUrl.split('?')[0])) || req.user) return next();
  res.status(401).json({ success: false, error: 'Sign in required.' });
});

app.get('/api/health', (req, res) => res.json({ success: true, status: 'ok', uptime: process.uptime() }));

// Serve frontend static files
app.use(express.static(path.resolve(__dirname, '../public')));

// Who may create an account: ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS when set,
// otherwise only the very first account (the owner).
function canCreateAccount(email) {
  const e = String(email || '').toLowerCase();
  const emails = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || '').toLowerCase().split(',').map(x => x.trim().replace(/^@/, '')).filter(Boolean);
  if (emails.length || domains.length) return emails.includes(e) || domains.includes(e.split('@')[1]);
  return db.countUsers() === 0;
}
const SIGNUP_CLOSED = 'Sign-up is closed. Ask the owner to add your email to ALLOWED_EMAILS.';

function oauthUserAllowed(email) {
  return Boolean(db.getUserByEmail(email)) || canCreateAccount(email);
}

const DEFAULT_GOOGLE_CLIENT_ID = '130895062908-rlr407sbhr21hhdvfch8nvhp6k9pgvpu.apps.googleusercontent.com';
/** Verifies a Google Identity Services ID token with Google and checks its audience. */
async function verifyGoogleIdToken(idToken) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw Object.assign(new Error('Google sign-in token is invalid or expired.'), { status: 401 });
  const p = await r.json();
  const audiences = [process.env.GOOGLE_CLIENT_ID, DEFAULT_GOOGLE_CLIENT_ID].filter(Boolean);
  if (!audiences.includes(p.aud)) throw Object.assign(new Error('Google token was issued for a different app.'), { status: 401 });
  if (!(p.email_verified === true || p.email_verified === 'true')) throw Object.assign(new Error('Google account email is not verified.'), { status: 401 });
  return { email: String(p.email).toLowerCase(), name: p.name || '', picture: p.picture || '' };
}

// ==========================================
// AUTH & MULTI-TENANT WORKSPACE APIS
// ==========================================

// Register new user
app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required' });
    const existing = db.getUserByEmail(email);
    if (existing) return res.status(400).json({ success: false, error: 'User already exists' });
    if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    if (!canCreateAccount(email)) return res.status(403).json({ success: false, error: SIGNUP_CLOSED });
    const passwordHash = authService.hashPassword(password);
    const user = db.createUser({ email, password_hash: passwordHash, name: name || email.split('@')[0], role: db.countUsers() === 0 ? 'owner' : 'developer' });
    const token = authService.createToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    setSessionCookie(res, token);
    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.getUserByEmail(email);
    if (!user || !authService.verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    const token = authService.createToken({ id: user.id, email: user.email, role: user.role, name: user.name });
    setSessionCookie(res, token);
    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// OAuth Configuration status
app.get('/api/auth/oauth/config', (req, res) => {
  res.json({
    success: true,
    google: {
      enabled: true,
      configured: Boolean(process.env.GOOGLE_CLIENT_ID),
      clientId: process.env.GOOGLE_CLIENT_ID || null
    },
    github: {
      enabled: true,
      configured: Boolean(process.env.GITHUB_CLIENT_ID),
      clientId: process.env.GITHUB_CLIENT_ID || null
    }
  });
});

// One-Click & Verified OAuth Sign-In (Google & GitHub)
app.post('/api/auth/oauth/continue', async (req, res) => {
  try {
    const { provider, email, name, avatar_url, credential } = req.body;
    if (!provider || !['google', 'github'].includes(provider.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Valid provider (google or github) is required' });
    }

    let userEmail, userName, userAvatar;
    if (credential && provider.toLowerCase() === 'google') {
      // Google Identity Services: the ID token is verified by Google.
      const g = await verifyGoogleIdToken(credential);
      userEmail = g.email; userName = g.name; userAvatar = g.picture;
    } else if (process.env.ALLOW_DEV_LOGIN === 'true') {
      // Local development only: sign in with an email address.
      userEmail = String(email || '').trim().toLowerCase();
      userName = String(name || '').trim();
      userAvatar = String(avatar_url || '').trim();
    } else {
      return res.status(400).json({ success: false, error: 'Use the Google or GitHub sign-in buttons. Email-only sign-in is disabled (ALLOW_DEV_LOGIN).' });
    }

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'Email is required for OAuth authentication' });
    }
    if (!oauthUserAllowed(userEmail)) return res.status(403).json({ success: false, error: SIGNUP_CLOSED });

    const user = db.findOrCreateOAuthUser({
      email: userEmail,
      name: userName || userEmail.split('@')[0],
      provider: provider.toLowerCase(),
      avatar_url: userAvatar
    });

    const token = authService.createToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      provider: user.provider,
      avatar_url: user.avatar_url
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        provider: user.provider,
        avatar_url: user.avatar_url
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Save & Configure OAuth credentials in .env
app.post('/api/auth/oauth/configure', (req, res) => {
  try {
    // Signed-in users may change OAuth settings; before any OAuth app is
    // configured, first-run setup is allowed from this machine only.
    const firstRun = !process.env.GOOGLE_CLIENT_ID && !process.env.GITHUB_CLIENT_ID;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!req.user && !(firstRun && local)) {
      return res.status(401).json({ success: false, error: 'Sign in to change OAuth settings.' });
    }
    const { googleClientId, googleClientSecret, githubClientId, githubClientSecret } = req.body;
    const envPath = path.resolve(__dirname, '../.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    function updateEnvKey(content, key, val) {
      if (!val) return content;
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        return content.replace(regex, `${key}=${val.trim()}`);
      } else {
        return content + `\n${key}=${val.trim()}`;
      }
    }

    if (googleClientId) {
      envContent = updateEnvKey(envContent, 'GOOGLE_CLIENT_ID', googleClientId);
      process.env.GOOGLE_CLIENT_ID = googleClientId.trim();
    }
    if (googleClientSecret) {
      envContent = updateEnvKey(envContent, 'GOOGLE_CLIENT_SECRET', googleClientSecret);
      process.env.GOOGLE_CLIENT_SECRET = googleClientSecret.trim();
    }
    if (githubClientId) {
      envContent = updateEnvKey(envContent, 'GITHUB_CLIENT_ID', githubClientId);
      process.env.GITHUB_CLIENT_ID = githubClientId.trim();
    }
    if (githubClientSecret) {
      envContent = updateEnvKey(envContent, 'GITHUB_CLIENT_SECRET', githubClientSecret);
      process.env.GITHUB_CLIENT_SECRET = githubClientSecret.trim();
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');

    res.json({
      success: true,
      message: 'OAuth credentials configured successfully.',
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      githubConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Google OAuth redirect initiation (RFC 6749 + OIDC with CSRF State Nonce)
app.get('/api/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  if (!clientId) {
    return res.send(authService.renderOAuthSetupHtml({ provider: 'google', redirectUri }));
  }

  const state = authService.generateOAuthState();
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const scope = encodeURIComponent('openid email profile');
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}&access_type=offline&prompt=select_account`;
  res.redirect(googleAuthUrl);
});

// Google OAuth callback (Validates CSRF State and performs token exchange)
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

  if (oauthError) {
    return res.status(400).send(authService.renderOAuthCallbackHtml({ success: false, provider: 'google', error: oauthError }));
  }

  // Validate CSRF state
  const savedState = authService.getCookie(req, 'oauth_state');
  res.setHeader('Set-Cookie', `oauth_state=; Path=/; HttpOnly; Max-Age=0`);
  if (!state || !savedState || state !== savedState) {
    return res.status(403).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'google',
      error: 'Security verification failed: CSRF state mismatch.'
    }));
  }

  if (!code || !clientId || !clientSecret) {
    return res.status(400).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'google',
      error: 'Missing authorization code or OAuth credentials.'
    }));
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token && !tokenData.access_token) {
      return res.status(400).send(authService.renderOAuthCallbackHtml({
        success: false,
        provider: 'google',
        error: tokenData.error_description || tokenData.error || 'Failed to exchange authorization code for token.'
      }));
    }

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await userInfoRes.json();

    if (!profile.email || !oauthUserAllowed(profile.email)) {
      return res.status(403).send(SIGNUP_CLOSED);
    }
    const user = db.findOrCreateOAuthUser({
      email: profile.email,
      name: profile.name,
      provider: 'google',
      avatar_url: profile.picture || ''
    });

    const token = authService.createToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      provider: 'google',
      avatar_url: user.avatar_url
    });

    setSessionCookie(res, token);
    res.send(authService.renderOAuthCallbackHtml({
      success: true,
      provider: 'google',
      token,
      user
    }));
  } catch (err) {
    res.status(500).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'google',
      error: err.message
    }));
  }
});

// GitHub OAuth redirect initiation (RFC 6749 with CSRF State Nonce)
app.get('/api/auth/github', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/github/callback`;
  if (!clientId) {
    return res.send(authService.renderOAuthSetupHtml({ provider: 'github', redirectUri }));
  }

  const state = authService.generateOAuthState();
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const scope = encodeURIComponent('read:user user:email');
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
  res.redirect(githubAuthUrl);
});

// GitHub OAuth callback (Validates CSRF State, fetches primary verified email and issues session)
app.get('/api/auth/github/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/github/callback`;

  if (oauthError) {
    return res.status(400).send(authService.renderOAuthCallbackHtml({ success: false, provider: 'github', error: oauthError }));
  }

  // Validate CSRF state
  const savedState = authService.getCookie(req, 'oauth_state');
  res.setHeader('Set-Cookie', `oauth_state=; Path=/; HttpOnly; Max-Age=0`);
  if (!state || !savedState || state !== savedState) {
    return res.status(403).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'github',
      error: 'Security verification failed: CSRF state mismatch.'
    }));
  }

  if (!code || !clientId || !clientSecret) {
    return res.status(400).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'github',
      error: 'Missing authorization code or OAuth credentials.'
    }));
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).send(authService.renderOAuthCallbackHtml({
        success: false,
        provider: 'github',
        error: tokenData.error_description || tokenData.error || 'Failed to exchange authorization code for token.'
      }));
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'Deployment-Server'
      }
    });
    const profile = await userRes.json();

    let email = profile.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'Deployment-Server'
        }
      });
      const emails = await emailsRes.json();
      const primary = Array.isArray(emails) ? (emails.find(e => e.primary && e.verified) || emails[0]) : null;
      email = primary ? primary.email : `${profile.login}@users.noreply.github.com`;
    }

    if (!oauthUserAllowed(email)) {
      return res.status(403).send(SIGNUP_CLOSED);
    }
    const user = db.findOrCreateOAuthUser({
      email,
      name: profile.name || profile.login,
      provider: 'github',
      avatar_url: profile.avatar_url || ''
    });

    const token = authService.createToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      provider: 'github',
      avatar_url: user.avatar_url
    });

    setSessionCookie(res, token);
    const sessionUser = { ...user, login: profile.login };
    res.send(authService.renderOAuthCallbackHtml({
      success: true,
      provider: 'github',
      token,
      user: sessionUser
    }));
  } catch (err) {
    res.status(500).send(authService.renderOAuthCallbackHtml({
      success: false,
      provider: 'github',
      error: err.message
    }));
  }
});

// Every user installs the same existing app. They do not create their own bot.
app.get('/api/github/app/setup', (req, res) => {
  const configuredUrl = (process.env.GITHUB_APP_URL || '').trim();
  if (configuredUrl) {
    try {
      const appUrl = new URL(configuredUrl);
      if (appUrl.hostname !== 'github.com' || !appUrl.pathname.startsWith('/apps/')) {
        return res.status(500).json({
          success: false,
          error: 'GITHUB_APP_URL must be a GitHub App URL such as https://github.com/apps/deploybase/installations/new.'
        });
      }
      return res.redirect(appUrl.toString());
    } catch {
      return res.status(500).json({
        success: false,
        error: 'GITHUB_APP_URL is not a valid URL.'
      });
    }
  }

  const slug = (process.env.GITHUB_APP_SLUG || 'deploybase').trim();
  if (!slug) {
    return res.status(500).json({
      success: false,
      error: 'GitHub App is not configured. Set GITHUB_APP_SLUG or GITHUB_APP_URL.'
    });
  }
  res.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
});

// Current user profile
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  res.json({ success: true, user: req.user });
});

// Workspaces list
app.get('/api/workspaces', (req, res) => {
  try {
    const workspaces = db.getWorkspaces(req.user?.id);
    res.json({ success: true, workspaces });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create workspace
app.post('/api/workspaces', (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Workspace name is required' });
    const ws = db.createWorkspace({ name, slug, owner_id: req.user?.id || 1 });
    res.json({ success: true, workspace: ws });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// CREDENTIALS API — Multi-Cloud
// ==========================================

// Get credentials for current workspace
app.get('/api/credentials', (req, res) => {
  try {
    const list = db.getCredentials(req.workspaceId);
    res.json({ success: true, credentials: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add credential — provider-aware (GCP / AWS / Azure / DigitalOcean)
app.post('/api/credentials', upload.single('credentials_file'), async (req, res) => {
  try {
    const provider = (req.body.cloud_provider || 'gcp').toLowerCase();
    const name = req.body.name || `${provider.toUpperCase()} Account`;
    const region = req.body.region || 'us-central1';

    let credentialsJson, projectId, clientEmail;

    if (provider === 'aws') {
      // AWS: access_key_id + secret_access_key stored as JSON
      const accessKeyId = req.body.access_key_id || '';
      const secretAccessKey = req.body.secret_access_key || '';
      const awsRegion = req.body.aws_region || 'us-east-1';
      if (!accessKeyId || !secretAccessKey) {
        return res.status(400).json({ success: false, error: 'AWS Access Key ID and Secret Access Key are required.' });
      }
      credentialsJson = JSON.stringify({ access_key_id: accessKeyId, secret_access_key: secretAccessKey, region: awsRegion });
      projectId = `aws-${awsRegion}`;
      clientEmail = `iam-user@aws-${accessKeyId.slice(0, 8)}`;

    } else if (provider === 'azure') {
      // Azure: service principal fields
      const tenantId = req.body.tenant_id || '';
      const clientId = req.body.client_id || '';
      const clientSecret = req.body.client_secret || '';
      const subscriptionId = req.body.subscription_id || '';
      if (!tenantId || !clientId || !clientSecret) {
        return res.status(400).json({ success: false, error: 'Azure Tenant ID, Client ID, and Client Secret are required.' });
      }
      credentialsJson = JSON.stringify({ tenant_id: tenantId, client_id: clientId, client_secret: clientSecret, subscription_id: subscriptionId });
      projectId = subscriptionId || `azure-tenant-${tenantId.slice(0, 8)}`;
      clientEmail = `sp-${clientId.slice(0, 8)}@azure`;

    } else if (provider === 'digitalocean' || provider === 'do') {
      // DigitalOcean: API token
      const apiToken = req.body.api_token || '';
      if (!apiToken) {
        return res.status(400).json({ success: false, error: 'DigitalOcean API Token is required.' });
      }
      credentialsJson = JSON.stringify({ api_token: apiToken });
      projectId = `digitalocean-${apiToken.slice(-8)}`;
      clientEmail = `api@digitalocean`;

    } else {
      // GCP: service account JSON (original path)
      let credContent = req.body.credentials_json;
      if (req.file) credContent = req.file.buffer.toString('utf8');
      if (!credContent) {
        return res.status(400).json({ success: false, error: 'GCP Service Account JSON key is required.' });
      }
      let parsed;
      try { parsed = JSON.parse(credContent); } catch {
        return res.status(400).json({ success: false, error: 'Invalid JSON format for GCP credentials.' });
      }
      projectId = req.body.project_id || parsed.project_id;
      if (!projectId) {
        return res.status(400).json({ success: false, error: 'GCP Project ID could not be determined.' });
      }
      clientEmail = parsed.client_email || req.body.client_email || 'service-account@gcp';
      credentialsJson = JSON.stringify(parsed, null, 2);
    }

    const id = db.addCredential({
      name,
      project_id: projectId,
      client_email: clientEmail,
      region,
      zone: `${region}-a`,
      credentials_json: credentialsJson,
      cloud_provider: provider,
      is_verified: 0,
      verification_message: 'Pending verification',
    });

    res.json({
      success: true,
      id,
      message: `${provider.toUpperCase()} credentials stored securely.`,
      credential: { id, name, project_id: projectId, client_email: clientEmail, region, cloud_provider: provider }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify credential — routes to correct provider
app.post('/api/credentials/:id/verify', async (req, res) => {
  try {
    const cred = db.getCredentialById(req.params.id);
    if (!cred) return res.status(404).json({ success: false, error: 'Credential not found.' });

    const provider = cred.cloud_provider || 'gcp';
    let result;

    if (provider === 'aws') {
      const credObj = JSON.parse(cred.credentials_json);
      result = await awsService.verifyCredentials({
        accessKeyId: credObj.access_key_id,
        secretAccessKey: credObj.secret_access_key,
        region: credObj.region || 'us-east-1',
      });

    } else if (provider === 'azure') {
      const credObj = JSON.parse(cred.credentials_json);
      result = await azureService.verifyCredentials({
        tenantId: credObj.tenant_id,
        clientId: credObj.client_id,
        clientSecret: credObj.client_secret,
        subscriptionId: credObj.subscription_id,
      });

    } else if (provider === 'digitalocean' || provider === 'do') {
      const credObj = JSON.parse(cred.credentials_json);
      result = await doService.verifyCredentials({ apiToken: credObj.api_token });

    } else {
      // GCP
      result = await gcpService.verifyCredentials({
        credentialsJson: cred.credentials_json,
        projectId: cred.project_id,
        region: cred.region,
      });
    }

    db.updateCredentialVerification(cred.id, 1, result.message);
    res.json({ success: true, message: result.message, provider });

  } catch (err) {
    db.updateCredentialVerification(req.params.id, 0, err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete credential
app.delete('/api/credentials/:id', (req, res) => {
  try {
    db.deleteCredential(req.params.id);
    res.json({ success: true, message: 'Credential deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// DEPLOYMENTS API
// ==========================================

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const sendError = (res, err) => res.status(err.status || 500).json({ success: false, error: err.message });

const RE = {
  repo: /^[A-Za-z0-9._-]{1,100}$/,
  user: /^[A-Za-z0-9-]{1,39}$/,
  branch: /^[A-Za-z0-9._\/-]{1,100}$/,
  route: /^\/[A-Za-z0-9._~\/-]{0,100}$/,
  url: /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+$/,
  token: /^[A-Za-z0-9_]{10,255}$/,
  slug: /^[a-z0-9-]{1,40}$/,
  domain: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i,
  email: /^[^@\s'"`$\\]+@[^@\s'"`$\\]+\.[^@\s'"`$\\]+$/,
};
const ADDONS = ['none', 'postgres', 'postgresql', 'redis', 'mysql', 'mongo', 'mongodb'];
const PROVIDER_ALIASES = { google: 'gcp', gcp: 'gcp', aws: 'aws', azure: 'azure', do: 'digitalocean', digitalocean: 'digitalocean', cheapest: 'cheapest' };

function truthy(v) { return v === true || ['true', 'yes', 'on', '1'].includes(String(v).toLowerCase()); }

/** Validates everything that ends up inside the VM startup script. */
function validateDeploymentInput(b) {
  const fail = (m) => { throw new HttpError(400, m); };
  if (!RE.repo.test(b.repo_name || '')) fail('Repository name may only contain letters, digits, ".", "_" and "-".');
  if (b.git_username && !RE.user.test(b.git_username)) fail('Invalid Git username.');
  if (b.branch && !RE.branch.test(b.branch)) fail('Invalid branch name.');
  if (b.repo_url && !RE.url.test(String(b.repo_url).replace(/\.git$/, ''))) fail('Repository URL must be an https:// Git URL.');
  if (b.pat_token && !RE.token.test(b.pat_token)) fail('The personal access token has an unexpected format.');
  for (const k of ['frontend_route', 'backend_route']) if (b[k] && !RE.route.test(b[k])) fail(`Invalid ${k.replace('_', ' ')}.`);
  for (const k of ['frontend_port', 'backend_port']) {
    if (b[k] !== undefined && b[k] !== '') {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < 1 || n > 65534) fail(`${k.replace('_', ' ')} must be between 1 and 65534.`);
    }
  }
  if (b.machine_type && !RE.slug.test(b.machine_type)) fail('Invalid machine type.');
  if (b.vm_zone && !RE.slug.test(b.vm_zone)) fail('Invalid zone.');
  if (b.domain && b.domain !== '_' && !RE.domain.test(String(b.domain).trim())) fail('The domain contains invalid characters.');
  if (b.database_addon && !ADDONS.includes(b.database_addon)) fail('Unknown database add-on.');
  if (b.env_vars && /^ENV_EOF$/m.test(b.env_vars)) fail('Environment variables may not contain the line ENV_EOF.');
  if (truthy(b.ssl_enabled) && !RE.email.test(String(b.ssl_email || '').trim())) fail('A valid email address is required to issue and renew the HTTPS certificate.');
}

/** Picks the credential: explicit id, else a verified credential of the requested provider, else the cheapest verified one. */
function resolveCredential({ credentialId, provider, machineType, workspaceId }) {
  if (credentialId && credentialId !== 'cheapest') {
    const cred = db.getCredentialById(Number(credentialId));
    if (!cred) throw new HttpError(400, 'The selected cloud credential does not exist.');
    return cred;
  }
  const verified = db.getCredentials(workspaceId).filter(c => c.is_verified === 1);
  const wanted = PROVIDER_ALIASES[String(provider || 'cheapest').toLowerCase()] || 'cheapest';
  if (wanted !== 'cheapest') {
    const cred = verified.find(c => (c.cloud_provider || 'gcp') === wanted);
    if (!cred) throw new HttpError(400, `No verified ${wanted.toUpperCase()} credential. Add one under Cloud Credentials.`);
    return cred;
  }
  if (!verified.length) throw new HttpError(400, 'No verified cloud credential. Add and verify one under Cloud Credentials.');
  return pricingService.selectCheapestProvider(verified, machineType || 'e2-micro');
}

function publicDeployment(dep) {
  if (!dep) return dep;
  const { pat_token, env_vars, ...rest } = dep;
  return { ...rest, pat_token: pat_token ? '••••••••' : null, env_vars: env_vars ? '••••••••' : null };
}

/** Provision, then follow the VM log and probe the public URL until it is healthy. */
async function startDeployment(id, { simulate = false } = {}) {
  const dep = db.getDeploymentById(id);
  const service = getProviderService(dep.cloud_provider);
  const result = await service.triggerDeployment(id, { simulate });
  if (!result?.ip || result.simulated) return result;

  const fresh = db.getDeploymentById(id);
  const host = fresh.domain && fresh.domain !== '_' ? fresh.domain : `${safeName(fresh.repo_name)}.${result.ip}.sslip.io`;
  db.updateDeploymentStatus(id, 'configuring', { domain: host, logs: `[DNS] Hostname: ${fresh.ssl_enabled ? 'https' : 'http'}://${host}` });

  vmOps.streamDeploymentLog(id, (line) => db.appendDeploymentLog(id, line)).then((outcome) => {
    if (outcome === 'failed') {
      db.updateDeploymentStatus(id, 'failed', { error_message: 'The startup script failed on the VM. See the deployment log for the failing step.' });
    }
  }).catch(err => db.appendDeploymentLog(id, `[VM Log Stream] ${err.message}`));

  // Public traffic enters through NGINX on port 80/443; the app port is internal to the VM.
  healthService.verifyDeploymentHealth(id, result.ip, 80).catch(console.error);
  return result;
}

/** Zero-downtime update on the existing VM (blue/green for Docker apps). */
function runUpdate(id, trigger) {
  const dep = db.getDeploymentById(id);
  if (!dep) throw new HttpError(404, 'Deployment not found');
  if (dep.simulated) throw new HttpError(409, 'This is a sandbox deployment; there is no VM to update.');
  if (!['ready', 'degraded', 'failed'].includes(dep.status)) throw new HttpError(409, `Deployment is busy (${dep.status}). Try again when it is ready.`);
  if (!dep.vm_ip) throw new HttpError(409, 'Deployment has no VM yet.');

  db.updateDeploymentStatus(id, 'deploying', { error_message: '', logs: `\n[${new Date().toISOString()}] [Update] Triggered by ${trigger}. Pulling ${dep.branch || 'main'}...` });
  (async () => {
    try {
      const r = await vmOps.update(id, (line) => db.appendDeploymentLog(id, line.startsWith('[') ? line : `[Update] ${line}`));
      const probe = await healthService.pingUrl(`http://${dep.vm_ip}`, 8000);
      const status = probe.healthy ? 'ready' : 'degraded';
      if (r.ok) {
        db.updateDeploymentStatus(id, status, {
          active_slot: r.activeSlot || undefined,
          logs: `[Update] Done${r.activeSlot ? `; live slot ${r.activeSlot.toUpperCase()}` : ''}. Public check: ${probe.healthy ? `HTTP ${probe.statusCode}` : probe.error || `HTTP ${probe.statusCode}`}.`,
        });
      } else {
        db.updateDeploymentStatus(id, status, {
          error_message: `Update failed (exit ${r.code}); the previous version is still serving.`,
          logs: `[Update] Failed with exit code ${r.code}. The previous version is still serving.`,
        });
      }
    } catch (err) {
      db.updateDeploymentStatus(id, 'degraded', { error_message: err.message, logs: `[Update] ${err.message}` });
    }
  })();
  return dep;
}

function getDeploymentOr404(id) {
  const dep = db.getDeploymentById(id);
  if (!dep) throw new HttpError(404, 'Deployment not found');
  return dep;
}

app.get('/api/deployments', (req, res) => {
  try {
    res.json({ success: true, deployments: db.getDeployments(req.workspaceId) });
  } catch (err) { sendError(res, err); }
});

app.get('/api/deployments/:id', (req, res) => {
  try {
    res.json({ success: true, deployment: publicDeployment(getDeploymentOr404(req.params.id)) });
  } catch (err) { sendError(res, err); }
});

app.post('/api/deployments', async (req, res) => {
  try {
    const b = req.body;
    validateDeploymentInput(b);
    const simulate = truthy(b.simulate);
    const sslEnabled = truthy(b.ssl_enabled);
    const cred = resolveCredential({ credentialId: b.gcp_credential_id, provider: b.cloud_provider, machineType: b.machine_type, workspaceId: req.workspaceId });
    const sandbox = simulate || isSandboxCredential(cred);
    const repoName = b.repo_name;

    const id = db.addDeployment({
      repo_name: repoName,
      git_username: b.git_username || 'user',
      repo_url: (b.repo_url || `https://github.com/${b.git_username || 'user'}/${repoName}`).replace(/\.git$/, ''),
      repo_type: b.repo_type === 'private' ? 'private' : 'public',
      pat_token: b.pat_token || null,
      branch: b.branch || 'main',
      frontend_present: b.frontend_present === 'no' ? 'no' : 'yes',
      frontend_route: b.frontend_route || '/',
      frontend_port: Number(b.frontend_port) || 3000,
      backend_present: b.backend_present === 'no' ? 'no' : 'yes',
      backend_route: b.backend_route || '/api',
      backend_port: Number(b.backend_port) || 5000,
      domain: b.domain ? String(b.domain).trim().toLowerCase() : '_',
      ssl_enabled: sslEnabled,
      ssl_email: String(b.ssl_email || '').trim(),
      gcp_credential_id: cred.id,
      machine_type: b.machine_type || 'e2-micro',
      vm_name: `devlups-${repoName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}-${Date.now().toString().slice(-4)}`,
      vm_zone: b.vm_zone || 'us-central1-a',
      env_vars: b.env_vars || '',
      database_addon: b.database_addon || 'none',
      workspace_id: req.workspaceId || 1,
      active_slot: 'blue',
      status: 'pending',
    });
    if (sandbox) db.updateDeploymentStatus(id, 'pending', { simulated: true });

    startDeployment(id, { simulate }).catch(err => console.error(`Deployment #${id} failed:`, err.message));
    res.json({
      success: true,
      id,
      message: `Deployment queued on ${(cred.cloud_provider || 'gcp').toUpperCase()}${sandbox ? ' (sandbox, simulated)' : ''}.`,
      deployment: publicDeployment(db.getDeploymentById(id)),
    });
  } catch (err) { sendError(res, err); }
});

/** Registers a repository (GitHub App installation) without deploying it. */
app.post('/api/repositories/register', (req, res) => {
  try {
    const { repo_name, git_username, repo_url, repo_type } = req.body;
    if (!RE.repo.test(repo_name || '')) throw new HttpError(400, 'Invalid repository name.');
    const exists = db.getDeployments().find(d => d.repo_name.toLowerCase() === repo_name.toLowerCase());
    if (exists) return res.json({ success: true, id: exists.id, message: 'Repository already known.' });
    const id = db.addDeployment({
      repo_name, git_username: git_username || 'github-user', repo_url, repo_type: repo_type === 'private' ? 'private' : 'public',
      status: 'registered', workspace_id: req.workspaceId || 1,
      logs: `Registered via GitHub App installation by @${git_username || 'unknown'}. Comment /deploy on an issue to launch it.`,
    });
    res.json({ success: true, id });
  } catch (err) { sendError(res, err); }
});

// Zero-downtime update (real blue/green for Docker apps)
app.post('/api/deployments/:id/update', (req, res) => {
  try {
    const dep = runUpdate(req.params.id, req.user?.email || req.user?.name || 'dashboard');
    const ports = blueGreenService.getSlotPorts(dep.frontend_port || 3000);
    const current = dep.active_slot || 'blue';
    res.json({ success: true, message: 'Update started. Follow the deployment log for progress.', currentSlot: current, nextSlot: blueGreenService.getNextSlot(current), ports });
  } catch (err) { sendError(res, err); }
});

// Enable HTTPS on a running deployment (any provider)
app.post('/api/deployments/:id/ssl', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!RE.email.test(email)) throw new HttpError(400, 'A valid certificate email is required.');
    const dep = getDeploymentOr404(req.params.id);
    if (dep.simulated) throw new HttpError(409, 'This is a sandbox deployment; there is no VM to configure.');
    db.updateDeploymentStatus(dep.id, dep.status, { logs: "[SSL] Installing Certbot and requesting a Let's Encrypt certificate..." });
    const { domain } = await vmOps.enableSsl(dep.id, email);
    db.updateDeploymentStatus(dep.id, 'ready', { domain, ssl_enabled: true, ssl_email: email, logs: `[SSL] HTTPS enabled at https://${domain}` });
    res.json({ success: true, deployment: publicDeployment(db.getDeploymentById(dep.id)), url: `https://${domain}` });
  } catch (err) {
    db.appendDeploymentLog(req.params.id, `[SSL] Failed: ${err.message}`);
    sendError(res, err);
  }
});

// Web terminal: runs the command on the deployment's VM over SSH
const BLOCKED_COMMANDS = [/rm\s+-rf\s+\/(\s|$)/, /\bmkfs\b/, /:\(\)\s*\{\s*:\|:&\s*\};:/, /\bshutdown\b/, /\breboot\b/, /\bdd\s+if=.*of=\/dev\//];
app.post('/api/deployments/:id/terminal/exec', async (req, res) => {
  try {
    const dep = getDeploymentOr404(req.params.id);
    const command = String(req.body.command || '').trim();
    if (!command) return res.json({ success: true, output: '' });
    if (command.length > 2000) throw new HttpError(400, 'Command is too long.');
    if (BLOCKED_COMMANDS.some(r => r.test(command))) throw new HttpError(400, 'This command is blocked by the Deployment Server terminal policy.');
    const result = await vmOps.exec(dep.id, command);
    console.log(`[Terminal] ${req.user?.email || 'user'} on #${dep.id}: ${command.slice(0, 200)}`);
    res.json({ success: true, command, output: result.output, exitCode: result.exitCode, cwd: `/opt/${dep.repo_name}`, activeSlot: dep.active_slot || 'blue', host: dep.vm_name });
  } catch (err) { sendError(res, err); }
});

// Live log stream (Server-Sent Events)
app.get('/api/deployments/:id/logs/stream', (req, res) => {
  const dep = db.getDeploymentById(req.params.id);
  if (!dep) return res.status(404).json({ success: false, error: 'Deployment not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const send = (text) => res.write(`data: ${JSON.stringify({ text, timestamp: new Date().toISOString() })}\n\n`);
  (dep.logs || '').split('\n').filter(l => l.trim()).forEach(send);
  const handler = (text) => send(text);
  logEmitter.on(`log:${dep.id}`, handler);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => { clearInterval(keepAlive); logEmitter.off(`log:${dep.id}`, handler); });
});

// Live VM metrics (read from the VM over SSH, cached 10 s)
app.get('/api/deployments/:id/metrics', async (req, res) => {
  try {
    const dep = getDeploymentOr404(req.params.id);
    if (dep.simulated) throw new HttpError(409, 'Sandbox deployment: no VM metrics.');
    res.json({ success: true, metrics: await vmOps.metrics(dep.id) });
  } catch (err) { sendError(res, err); }
});

// Pricing comparison (static list-price table)
app.get('/api/pricing', (req, res) => {
  try {
    res.json({ success: true, ...pricingService.getComparison(req.query.tier || 'e2-micro') });
  } catch (err) { sendError(res, err); }
});

// Tear down the cloud resources of a deployment
app.post('/api/deployments/:id/destroy', (req, res) => {
  try {
    const dep = getDeploymentOr404(req.params.id);
    if (['destroying', 'destroyed'].includes(dep.status)) throw new HttpError(409, `Deployment is already ${dep.status}.`);
    const log = (line) => db.appendDeploymentLog(dep.id, line);
    if (dep.simulated) {
      db.updateDeploymentStatus(dep.id, 'destroyed', { logs: '[Destroy] Sandbox deployment closed (no cloud resources existed).' });
      return res.json({ success: true, message: 'Sandbox deployment closed.' });
    }
    db.updateDeploymentStatus(dep.id, 'destroying', { logs: `[Destroy] Tearing down cloud resources (requested by ${req.user?.email || 'user'})...` });
    getProviderService(dep.cloud_provider).destroy(dep, log)
      .then(() => db.updateDeploymentStatus(dep.id, 'destroyed', { logs: '[Destroy] All cloud resources removed.' }))
      .catch(err => db.updateDeploymentStatus(dep.id, 'failed', { error_message: `Destroy failed: ${err.message}`, logs: `[Destroy] Failed: ${err.message}` }));
    res.json({ success: true, message: 'Teardown started. Follow the deployment log for progress.' });
  } catch (err) { sendError(res, err); }
});

// Delete the deployment record (use /destroy first to remove cloud resources)
app.delete('/api/deployments/:id', (req, res) => {
  try {
    const dep = getDeploymentOr404(req.params.id);
    if (dep.status === 'destroying') throw new HttpError(409, 'Teardown is still running.');
    db.deleteDeployment(dep.id);
    res.json({ success: true, message: 'Deployment record removed.' });
  } catch (err) { sendError(res, err); }
});

// ==========================================
// GITHUB WEBHOOK (signed with GITHUB_WEBHOOK_SECRET)
// ==========================================

function verifyGithubSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const sig = req.headers['x-hub-signature-256'];
  if (!secret || !sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** Parses "/deploy [provider]", "/update", "/redeploy" ChatOps commands. */
export function parseChatOpsCommand(text) {
  const t = String(text || '').toLowerCase();
  const deploy = t.match(/(?:^|\s)\/(?:deploy|launch)(?:\s+(gcp|google|aws|azure|digitalocean|do|cheapest))?(?=\s|$)/);
  if (deploy) return { action: 'deploy', provider: PROVIDER_ALIASES[deploy[1] || 'cheapest'] };
  if (/(?:^|\s)\/(?:update|redeploy)(?=\s|$)/.test(t)) return { action: 'update' };
  if (/(?:^|\s)\/status(?=\s|$)/.test(t)) return { action: 'status' };
  return null;
}

app.post('/api/webhook/github', async (req, res) => {
  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, error: 'Webhook disabled: set GITHUB_WEBHOOK_SECRET on the server and in the GitHub webhook settings.' });
  }
  if (!verifyGithubSignature(req)) return res.status(401).json({ success: false, error: 'Invalid webhook signature.' });

  try {
    const event = req.headers['x-github-event'];
    const payload = req.body;
    const repository = payload.repository;
    const sender = payload.sender?.login || 'github-user';
    const findDeployment = () => repository && db.getDeployments()
      .filter(d => d.repo_name.toLowerCase() === repository.name.toLowerCase() && !['registered', 'destroyed', 'destroying'].includes(d.status))
      .sort((a, b) => b.id - a.id)[0];

    if (event === 'ping') return res.json({ success: true, message: 'pong' });

    if (event === 'push') {
      const branch = (payload.ref || '').replace('refs/heads/', '');
      const dep = findDeployment();
      if (dep && branch === (dep.branch || 'main')) {
        runUpdate(dep.id, `push by @${payload.pusher?.name || sender} (${payload.head_commit?.id?.slice(0, 7) || 'latest'})`);
        return res.json({ success: true, message: `Update started for deployment #${dep.id}.` });
      }
      return res.json({ success: true, message: 'No deployment tracks this branch.' });
    }

    if (event === 'issues' || event === 'issue_comment') {
      if (event === 'issue_comment' && payload.comment?.user?.type === 'Bot') return res.json({ success: true });
      if (event === 'issues' && payload.action !== 'opened') return res.json({ success: true });
      const text = event === 'issue_comment' ? payload.comment?.body : `${payload.issue?.title || ''}\n${payload.issue?.body || ''}`;
      const cmd = parseChatOpsCommand(text);
      if (cmd?.action === 'deploy') {
        const cred = resolveCredential({ provider: cmd.provider });
        const id = db.addDeployment({
          repo_name: repository.name, git_username: repository.owner?.login || sender, repo_url: repository.html_url,
          repo_type: repository.private ? 'private' : 'public', branch: repository.default_branch || 'main',
          gcp_credential_id: cred.id, status: 'pending', logs: `ChatOps /deploy by @${sender} (${cmd.provider}).`,
        });
        startDeployment(id).catch(err => console.error(`ChatOps deployment #${id} failed:`, err.message));
        return res.json({ success: true, id, message: `Deployment #${id} started on ${(cred.cloud_provider || 'gcp').toUpperCase()}.` });
      }
      if (cmd?.action === 'update') {
        const dep = findDeployment();
        if (!dep) throw new HttpError(404, 'No deployment found for this repository.');
        runUpdate(dep.id, `/update by @${sender}`);
        return res.json({ success: true, message: `Update started for deployment #${dep.id}.` });
      }
    }

    res.json({ success: true, message: 'Event ignored.' });
  } catch (err) {
    console.error('[GitHub Webhook Error]:', err.message);
    sendError(res, err);
  }
});

// System stats
app.get('/api/system/stats', (req, res) => {
  try {
    const creds = db.getCredentials();
    const deps = db.getDeployments();
    res.json({
      success: true,
      stats: {
        totalDeployments: deps.filter(d => !['registered', 'destroyed'].includes(d.status)).length,
        activeVMs: deps.filter(d => d.status === 'ready' && !d.simulated).length,
        totalCredentials: creds.length,
        verifiedCredentials: creds.filter(c => c.is_verified === 1).length,
        platforms: 'GCP · AWS · Azure · DigitalOcean',
        storageEngine: 'SQLite',
        systemUptime: process.uptime(),
      },
    });
  } catch (err) { sendError(res, err); }
});

// SPA fallback for non-API routes
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, error: 'Not found' });
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

const server = app.listen(PORT, () => {
  console.log('====================================================');
  console.log(' Deployment Server: multi-cloud deployment engine');
  console.log(` Listening on http://localhost:${PORT}`);
  console.log(' Providers: GCP (Terraform) · AWS (CLI) · Azure (CLI) · DigitalOcean (API)');
  if (!process.env.DEPLOYMENT_API_TOKEN) console.log(' Note: set DEPLOYMENT_API_TOKEN so the GitHub bot can call the API.');
  console.log('====================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
    process.exit(1);
  }
  console.error('Server error:', err);
});

// Reconcile deployment records with what is actually reachable. Deployment
// records are never deleted because a probe failed.
const healthMonitor = setInterval(() => {
  healthService.pruneUnreachableDeployments().catch(err => console.error('[Health Monitor] Reconciliation failed:', err.message));
}, 60000);
healthMonitor.unref();
healthService.pruneUnreachableDeployments().catch(err => console.error('[Health Monitor] Initial reconciliation failed:', err.message));
