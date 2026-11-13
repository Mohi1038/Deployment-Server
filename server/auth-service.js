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
      window.opener.postMessage(payload, '*');
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
      }, '*');
      setTimeout(() => window.close(), 3000);
    }
  </script>
</body>
</html>`;
    }
  },

  /**
   * Render production OAuth Setup & Quick-Sign-In HTML
   * Transparently explains OAuth credentials requirement and allows instant key entry or dev bypass
   */
  renderOAuthSetupHtml({ provider, redirectUri }) {
    const isGoogle = provider === "google";
    const brandName = isGoogle ? "Google" : "GitHub";
    const setupUrl = isGoogle 
      ? "https://console.cloud.google.com/apis/credentials" 
      : "https://github.com/settings/developers";
    const logoSvg = isGoogle 
      ? `<svg width="24" height="24" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>`
      : `<svg width="24" height="24" viewBox="0 0 24 24" fill="#24292F"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brandName} Authentication — Deployment Server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Plus Jakarta Sans", -apple-system, sans-serif;
      background: #F4F5F7;
      color: #0F172A;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid #E2E8F0;
      border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.06);
      width: 100%;
      max-width: 480px;
      overflow: hidden;
    }
    .header {
      padding: 24px 28px 18px;
      border-bottom: 1px solid #E2E8F0;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .header-text h1 { font-size: 17px; font-weight: 700; color: #0F172A; margin-bottom: 2px; }
    .header-text p { font-size: 12px; color: #64748B; }
    .body { padding: 22px 28px; }
    .info-banner {
      background: #F0F9FF;
      border: 1px solid #BAE6FD;
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 12px;
      color: #0369A1;
      line-height: 1.5;
      margin-bottom: 18px;
    }
    .tabs { display: flex; border-bottom: 1px solid #E2E8F0; margin-bottom: 18px; }
    .tab-btn {
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 600;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #64748B;
      cursor: pointer;
    }
    .tab-btn.active { color: #E8524A; border-bottom-color: #E8524A; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin-bottom: 6px; }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #CBD5E1;
      border-radius: 7px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border 0.15s;
    }
    input:focus { border-color: #5BC8F5; box-shadow: 0 0 0 3px rgba(91,200,245,0.15); }
    .uri-box {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 6px;
      padding: 8px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #334155;
      word-break: break-all;
      user-select: all;
      margin-top: 4px;
    }
    .btn-primary {
      width: 100%;
      background: #E8524A;
      color: #FFFFFF;
      border: none;
      padding: 11px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.15s;
    }
    .btn-primary:hover { background: #D03D35; }
    .btn-secondary {
      width: 100%;
      background: #FFFFFF;
      color: #0F172A;
      border: 1px solid #CBD5E1;
      padding: 10px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
      text-decoration: none;
      text-align: center;
      display: block;
    }
    .btn-secondary:hover { background: #F8F9FA; }
    .alert-err { color: #DC2626; font-size: 12px; margin-top: 8px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand-icon">${logoSvg}</div>
      <div class="header-text">
        <h1>${brandName} Authentication</h1>
        <p>Deployment Server Multi-Cloud Engine</p>
      </div>
    </div>
    <div class="body">
      <div class="info-banner">
        <strong>OAuth 2.0 Notice:</strong> Official account selection on <code>${isGoogle ? "accounts.google.com" : "github.com"}</code> requires an authorized Client ID. Configure your real OAuth keys below to enable the genuine ${brandName} screen, or use Developer Mode for instant testing.
      </div>

      <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('keys')">1. Enter OAuth Keys</button>
        <button class="tab-btn" onclick="switchTab('bypass')">2. Developer Quick-Login</button>
      </div>

      <!-- Tab 1: Real Keys -->
      <div id="tab-keys" class="tab-content active">
        <div class="form-group">
          <label>${brandName} Client ID</label>
          <input type="text" id="cfg-client-id" placeholder="${isGoogle ? "xxxx.apps.googleusercontent.com" : "Iv1.xxxx"}" />
        </div>
        <div class="form-group">
          <label>${brandName} Client Secret</label>
          <input type="password" id="cfg-client-secret" placeholder="••••••••••••••••" />
        </div>
        <div class="form-group">
          <label>Authorized Redirect URI (Copy to Console)</label>
          <div class="uri-box">${redirectUri}</div>
        </div>
        <button class="btn-primary" onclick="saveKeysAndRedirect()">
          Save Keys &amp; Redirect to Real ${brandName}
        </button>
        <a class="btn-secondary" href="${setupUrl}" target="_blank" rel="noopener">
          Open ${brandName} Developer Console ↗
        </a>
        <div id="cfg-err" class="alert-err"></div>
      </div>

      <!-- Tab 2: Quick Developer Bypass -->
      <div id="tab-bypass" class="tab-content">
        <div class="form-group">
          <label>Sign in as Email</label>
          <input type="text" id="dev-email" value="b23cs1038@iitj.ac.in" />
        </div>
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" id="dev-name" value="Mohit" />
        </div>
        <button class="btn-primary" onclick="quickDevLogin()">
          Sign In Immediately (Bypass)
        </button>
      </div>
    </div>
  </div>

  <script>
    function switchTab(name) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      if (name === "keys") {
        document.querySelectorAll(".tab-btn")[0].classList.add("active");
        document.getElementById("tab-keys").classList.add("active");
      } else {
        document.querySelectorAll(".tab-btn")[1].classList.add("active");
        document.getElementById("tab-bypass").classList.add("active");
      }
    }

    async function saveKeysAndRedirect() {
      const clientId = document.getElementById("cfg-client-id").value.trim();
      const clientSecret = document.getElementById("cfg-client-secret").value.trim();
      const errEl = document.getElementById("cfg-err");
      errEl.style.display = "none";

      if (!clientId || !clientSecret) {
        errEl.textContent = "Please enter both Client ID and Client Secret.";
        errEl.style.display = "block";
        return;
      }

      try {
        const body = ${isGoogle} 
          ? { googleClientId: clientId, googleClientSecret: clientSecret }
          : { githubClientId: clientId, githubClientSecret: clientSecret };

        const res = await fetch("/api/auth/oauth/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = "/api/auth/${provider}";
        } else {
          errEl.textContent = data.error || "Failed to save configuration.";
          errEl.style.display = "block";
        }
      } catch (e) {
        errEl.textContent = "Network error: " + e.message;
        errEl.style.display = "block";
      }
    }

    async function quickDevLogin() {
      const email = document.getElementById("dev-email").value.trim();
      const name = document.getElementById("dev-name").value.trim();
      if (!email) return alert("Email required");

      try {
        const res = await fetch("/api/auth/oauth/continue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "${provider}",
            email,
            name: name || email.split("@")[0],
            avatar_url: "https://ui-avatars.com/api/?name=" + encodeURIComponent(name || email) + "&background=E8524A&color=fff"
          })
        });
        const data = await res.json();
        if (data.success && window.opener) {
          window.opener.postMessage({
            type: "DEPLOYMENT_SERVER_OAUTH_SUCCESS",
            provider: "${provider}",
            token: data.token,
            user: data.user
          }, "*");
          setTimeout(() => window.close(), 300);
        } else if (data.success) {
          window.location.href = "/?auth_token=" + encodeURIComponent(data.token) + "&provider=${provider}";
        } else {
          alert(data.error || "Login failed");
        }
      } catch (err) {
        alert("Network error: " + err.message);
      }
    }
  </script>
</body>
</html>`;
  }
};
