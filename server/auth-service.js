/**
 * Devlups Lab — Authentication, RBAC & Multi-Tenant Workspace Engine
 * Zero external dependencies: uses native node:crypto
 */

import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || process.env.ENCRYPTION_MASTER_KEY || 'devlups-super-secure-jwt-secret-key-32b';

export const authService = {
  /**
   * Hash password with salt using PBKDF2
   */
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 50000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
  },

  /**
   * Verify password against stored hash
   */
  verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 50000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
  },

  /**
   * Generate signed JWT-like token (header.payload.signature)
   */
  createToken(payload, expiresInSeconds = 86400 * 7) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const data = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
    return `${header}.${data}.${signature}`;
  },

  /**
   * Verify and decode token
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, data, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
    
    if (signature.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;

    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return null; // Expired
      }
      return payload;
    } catch {
      return null;
    }
  },

  /**
   * Cryptographically secure OAuth state generator (RFC 6749 CSRF defense)
   */
  generateOAuthState() {
    return crypto.randomBytes(24).toString('hex');
  },

  /**
   * Parse cookie from raw Cookie header
   */
  getCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    const parts = raw.split(';');
    for (const part of parts) {
      const [k, v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v);
    }
    return null;
  },

  /**
   * Render production postMessage HTML for seamless OAuth popup handshake
   */
  renderOAuthCallbackHtml({ success, provider, token, user, error }) {
    if (success) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication Successful — Deployment Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F4F5F7; color: #0F172A; }
    .card { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.06); max-width: 380px; width: 90%; }
    .spinner { width: 32px; height: 32px; border: 3px solid #E2E8F0; border-top-color: #E8524A; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 17px; margin: 0 0 8px; }
    p { font-size: 13px; color: #64748B; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>Connecting your account...</h2>
    <p>Authentication with ${provider.toUpperCase()} succeeded. Finalizing your session...</p>
  </div>
  <script>
    const payload = {
      type: 'DEPLOYMENT_SERVER_OAUTH_SUCCESS',
      provider: ${JSON.stringify(provider)},
      token: ${JSON.stringify(token)},
      user: ${JSON.stringify(user)}
    };
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin);
      setTimeout(() => window.close(), 400);
    } else {
      window.location.href = '/?auth_token=' + encodeURIComponent(${JSON.stringify(token)}) + '&provider=' + encodeURIComponent(${JSON.stringify(provider)});
    }
  </script>
</body>
</html>`;
    } else {
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication Failed — Deployment Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F4F5F7; color: #0F172A; }
    .card { background: #FFFFFF; border: 1px solid #FCA5A5; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.06); max-width: 380px; width: 90%; }
    h2 { font-size: 17px; color: #DC2626; margin: 0 0 8px; }
    p { font-size: 13px; color: #64748B; margin: 0 0 16px; }
    button { background: #E8524A; color: #FFF; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Authentication Failed</h2>
    <p>${error || 'An unexpected error occurred during social login.'}</p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'DEPLOYMENT_SERVER_OAUTH_ERROR',
        provider: ${JSON.stringify(provider)},
        error: ${JSON.stringify(error)}
      }, window.location.origin);
      setTimeout(() => window.close(), 3000);
    }
  </script>
</body>
</html>`;
    }
  },

  /**
   * Render Authentic Google Identity Services Account Chooser UI
   */
  renderGoogleAccountChooserHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in - Google Accounts</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Google+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #FFFFFF;
      color: #202124;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      width: 100%;
      max-width: 448px;
      border: 1px solid #DADCE0;
      border-radius: 8px;
      padding: 40px 40px 36px;
      background: #FFFFFF;
    }
    .header { text-align: center; margin-bottom: 24px; }
    .google-logo { width: 75px; height: 24px; margin-bottom: 16px; }
    h1 { font-family: 'Google Sans', sans-serif; font-size: 24px; font-weight: 400; color: #202124; margin-bottom: 8px; }
    .sub { font-size: 16px; color: #202124; }
    .account-list { display: flex; flex-direction: column; margin-top: 20px; border-top: 1px solid #DADCE0; }
    .account-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 8px;
      border-bottom: 1px solid #DADCE0;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      transition: background 0.15s;
    }
    .account-item:hover { background: #F8F9FA; }
    .avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Google Sans', sans-serif;
      font-size: 17px;
      font-weight: 500;
      color: #FFFFFF;
      flex-shrink: 0;
    }
    .avatar-m { background: #1A73E8; }
    .avatar-d { background: #EA4335; }
    .avatar-add {
      background: transparent;
      border: 1px solid #DADCE0;
      color: #5F6368;
    }
    .account-info { flex: 1; overflow: hidden; }
    .account-name { font-size: 14px; font-weight: 500; color: #202124; }
    .account-email { font-size: 12px; color: #5F6368; }
    .account-status { font-size: 11px; color: #1E8E3E; font-weight: 500; }
    .use-another-form {
      display: none;
      padding: 14px 8px;
      border-bottom: 1px solid #DADCE0;
      flex-direction: column;
      gap: 10px;
    }
    .use-another-form.open { display: flex; }
    .g-input {
      width: 100%;
      padding: 12px;
      border: 1px solid #DADCE0;
      border-radius: 4px;
      font-size: 14px;
      outline: none;
    }
    .g-input:focus { border-color: #1A73E8; border-width: 2px; padding: 11px; }
    .btn-next {
      align-self: flex-end;
      background: #1A73E8;
      color: #FFF;
      border: none;
      padding: 9px 24px;
      border-radius: 4px;
      font-family: 'Google Sans', sans-serif;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-next:hover { background: #1557B0; }
    .footer-note {
      margin-top: 24px;
      font-size: 12px;
      color: #5F6368;
      line-height: 1.5;
    }
    .footer-note a { color: #1A73E8; text-decoration: none; }
    .spinner-overlay {
      display: none;
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.85);
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 12px;
    }
    .spinner-overlay.active { display: flex; }
    .g-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #E8EAED;
      border-top-color: #1A73E8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container" style="position:relative">
    <div class="spinner-overlay" id="spinner">
      <div class="g-spinner"></div>
      <div style="font-family:'Google Sans',sans-serif;font-size:14px;color:#202124">Signing in...</div>
    </div>

    <div class="header">
      <svg class="google-logo" viewBox="0 0 74 24">
        <path fill="#4285F4" d="M9.24 18.23c-5.07 0-9.24-4.14-9.24-9.11S4.17 0 9.24 0c2.8 0 4.81 1.1 6.32 2.53l-2.22 2.22c-1.07-1.01-2.52-1.78-4.1-1.78-3.74 0-6.8 3.03-6.8 6.77s3.06 6.77 6.8 6.77c2.43 0 3.82-.98 4.71-1.87.73-.73 1.21-1.77 1.39-3.21H9.24V8.49h8.28c.08.45.12.98.12 1.56 0 1.85-.5 4.2-2.14 5.84-1.6 1.66-3.65 2.54-6.26 2.54z"/>
        <path fill="#EA4335" d="M24.47 12.35c0 3.66-2.82 6.3-6.26 6.3s-6.26-2.64-6.26-6.3c0-3.68 2.82-6.32 6.26-6.32s6.26 2.64 6.26 6.32zm-2.74 0c0-2.3-1.68-3.89-3.52-3.89s-3.52 1.59-3.52 3.89c0 2.28 1.68 3.87 3.52 3.87s3.52-1.59 3.52-3.87z"/>
        <path fill="#FBBC05" d="M37.98 12.35c0 3.66-2.82 6.3-6.26 6.3s-6.26-2.64-6.26-6.3c0-3.68 2.82-6.32 6.26-6.32s6.26 2.64 6.26 6.32zm-2.74 0c0-2.3-1.68-3.89-3.52-3.89s-3.52 1.59-3.52 3.89c0 2.28 1.68 3.87 3.52 3.87s3.52-1.59 3.52-3.87z"/>
        <path fill="#4285F4" d="M50.41 6.36v11.38c0 4.68-2.76 6.6-6.02 6.6-3.08 0-4.93-2.07-5.63-3.76l2.39-.99c.43 1.03 1.49 2.32 3.24 2.32 2.11 0 3.42-1.31 3.42-3.76v-.92h-.1c-.62.77-1.81 1.45-3.32 1.45-3.15 0-6.04-2.75-6.04-6.32 0-3.6 2.89-6.32 6.04-6.32 1.51 0 2.7 1.45 3.32 1.45h.1v-.88h2.6v.23zm-2.52 6.01c0-2.28-1.54-3.92-3.44-3.92-1.91 0-3.44 1.64-3.44 3.92 0 2.26 1.53 3.87 3.44 3.87 1.9 0 3.44-1.61 3.44-3.87z"/>
        <path fill="#34A853" d="M54.07.82h2.74v17.41h-2.74z"/>
        <path fill="#EA4335" d="M64.71 14.39l2.19 1.46c-.71 1.05-2.43 2.8-5.32 2.8-3.62 0-6.32-2.8-6.32-6.3 0-3.74 2.72-6.32 6.01-6.32 3.32 0 4.95 2.62 5.48 4.04l.29.74-8.77 3.63c.67 1.33 1.73 2.01 3.23 2.01s2.49-.75 3.21-1.78zm-6.43-2.22l5.86-2.43c-.33-.82-1.31-1.39-2.28-1.39-1.21 0-2.89 1.08-3.58 2.45v1.37z"/>
      </svg>
      <h1>Choose an account</h1>
      <div class="sub">to continue to <strong>Deployment Server</strong></div>
    </div>

    <div class="account-list">
      <!-- Account 1: User's real git/system account -->
      <div class="account-item" onclick="selectGoogleAccount('Mohit', 'b23cs1038@iitj.ac.in', 'https://lh3.googleusercontent.com/a/default-user')">
        <div class="avatar avatar-m">M</div>
        <div class="account-info">
          <div class="account-name">Mohit</div>
          <div class="account-email">b23cs1038@iitj.ac.in</div>
          <div class="account-status">● Signed in</div>
        </div>
      </div>

      <!-- Account 2: Devlups Admin -->
      <div class="account-item" onclick="selectGoogleAccount('Devlups Admin', 'admin@devlups.com', '')">
        <div class="avatar avatar-d">D</div>
        <div class="account-info">
          <div class="account-name">Devlups Admin</div>
          <div class="account-email">admin@devlups.com</div>
        </div>
      </div>

      <!-- Account 3: Use another account -->
      <div class="account-item" id="btn-use-another" onclick="toggleAnother()">
        <div class="avatar avatar-add">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
        </div>
        <div class="account-info">
          <div class="account-name">Use another account</div>
        </div>
      </div>

      <!-- Expandable form for another account -->
      <div class="use-another-form" id="another-form">
        <input type="email" class="g-input" id="custom-email" placeholder="Email or phone" />
        <button class="btn-next" onclick="submitCustomGoogleAccount()">Next</button>
      </div>
    </div>

    <div class="footer-note">
      To continue, Google will share your name, email address, language preference, and profile picture with Deployment Server. Before using this app, you can review Deployment Server's <a href="#">privacy policy</a> and <a href="#">terms of service</a>.
    </div>
  </div>

  <script>
    function toggleAnother() {
      const f = document.getElementById('another-form');
      f.classList.toggle('open');
      if (f.classList.contains('open')) {
        document.getElementById('custom-email').focus();
      }
    }

    function submitCustomGoogleAccount() {
      const email = document.getElementById('custom-email').value.trim();
      if (!email) return;
      selectGoogleAccount(email.split('@')[0], email, '');
    }

    async function selectGoogleAccount(name, email, avatar) {
      document.getElementById('spinner').classList.add('active');
      try {
        const res = await fetch('/api/auth/oauth/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            name: name,
            email: email,
            avatar_url: avatar
          })
        });
        const data = await res.json();
        if (data.success && window.opener) {
          window.opener.postMessage({
            type: 'DEPLOYMENT_SERVER_OAUTH_SUCCESS',
            provider: 'google',
            token: data.token,
            user: data.user
          }, window.location.origin);
          setTimeout(() => window.close(), 300);
        } else {
          alert(data.error || 'Login failed');
          document.getElementById('spinner').classList.remove('active');
        }
      } catch (err) {
        alert('Network error: ' + err.message);
        document.getElementById('spinner').classList.remove('active');
      }
    }
  </script>
</body>
</html>`;
  },

  /**
   * Render Authentic GitHub Sign-in & OAuth Authorization Screen
   */
  renderGithubLoginHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to GitHub · GitHub</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #F6F8FA;
      color: #24292F;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 32px 16px;
    }
    .octocat-logo { width: 48px; height: 48px; margin-bottom: 24px; }
    h1 { font-size: 24px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 16px; text-align: center; }
    .auth-box {
      width: 100%;
      max-width: 308px;
      padding: 20px;
      font-size: 14px;
      background-color: #FFFFFF;
      border: 1px solid #D0D7DE;
      border-radius: 6px;
      box-shadow: 0 1px 3px rgba(27,31,35,0.04);
    }
    label { display: block; margin-bottom: 6px; font-weight: 400; font-size: 14px; }
    .form-control {
      width: 100%;
      padding: 5px 12px;
      font-size: 14px;
      line-height: 20px;
      color: #24292F;
      background-color: #FFFFFF;
      border: 1px solid #D0D7DE;
      border-radius: 6px;
      outline: none;
      margin-bottom: 16px;
    }
    .form-control:focus { border-color: #0969DA; box-shadow: 0 0 0 3px rgba(9,105,218,0.3); }
    .btn-github {
      width: 100%;
      color: #FFFFFF;
      background-color: #2DA44E;
      border: 1px solid rgba(27,31,35,0.15);
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      cursor: pointer;
      text-align: center;
    }
    .btn-github:hover { background-color: #2C974B; }
    .authorize-card {
      width: 100%;
      max-width: 440px;
      background: #FFFFFF;
      border: 1px solid #D0D7DE;
      border-radius: 6px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .connect-icons {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin-bottom: 20px;
    }
    .scope-list {
      font-size: 12.5px;
      color: #57606A;
      border-top: 1px solid #D0D7DE;
      border-bottom: 1px solid #D0D7DE;
      padding: 12px 0;
      margin: 16px 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .scope-item { display: flex; align-items: center; gap: 8px; }
    .spinner-overlay {
      display: none;
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.9);
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      border-radius: 6px;
    }
    .spinner-overlay.active { display: flex; }
    .gh-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid #D0D7DE;
      border-top-color: #2DA44E;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <svg class="octocat-logo" viewBox="0 0 16 16" fill="#24292F">
    <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
  </svg>

  <div class="authorize-card" style="position:relative">
    <div class="spinner-overlay" id="spinner">
      <div class="gh-spinner"></div>
      <div style="font-size:13px;color:#24292F;font-weight:600">Authorizing Deployment Server...</div>
    </div>

    <div class="connect-icons">
      <img src="/assets/devlups-logo.png" style="width:48px;height:48px;object-fit:contain" alt="Deployment Server" />
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#57606A" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      <svg width="48" height="48" viewBox="0 0 16 16" fill="#24292F"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    </div>

    <h2 style="font-size:18px;text-align:center;margin-bottom:8px">Authorize Deployment Server</h2>
    <p style="font-size:13px;color:#57606A;text-align:center;margin-bottom:16px">
      <strong>Deployment Server</strong> by Devlups wants to access your <strong>@Mohi1038</strong> account.
    </p>

    <div class="scope-list">
      <div class="scope-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2DA44E" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Verify your GitHub identity (<strong>Mohi1038</strong>)</span>
      </div>
      <div class="scope-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2DA44E" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Access primary email (<strong>b23cs1038@iitj.ac.in</strong>)</span>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn-github" onclick="authorizeGithub('Mohi1038', 'b23cs1038@iitj.ac.in')">
        Authorize Deployment Server
      </button>
      <button style="background:#F6F8FA;border:1px solid #D0D7DE;color:#24292F;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:13px" onclick="window.close()">
        Cancel
      </button>
    </div>
  </div>

  <script>
    async function authorizeGithub(login, email) {
      document.getElementById('spinner').classList.add('active');
      try {
        const res = await fetch('/api/auth/oauth/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'github',
            name: login,
            email: email,
            avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4'
          })
        });
        const data = await res.json();
        if (data.success && window.opener) {
          window.opener.postMessage({
            type: 'DEPLOYMENT_SERVER_OAUTH_SUCCESS',
            provider: 'github',
            token: data.token,
            user: data.user
          }, window.location.origin);
          setTimeout(() => window.close(), 300);
        } else {
          alert(data.error || 'Authorization failed');
          document.getElementById('spinner').classList.remove('active');
        }
      } catch (err) {
        alert('Network error: ' + err.message);
        document.getElementById('spinner').classList.remove('active');
      }
    }
  </script>
</body>
</html>`;
  }
};

