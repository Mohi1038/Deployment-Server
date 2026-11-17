import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { DatabaseSync } from 'node:sqlite';
import { cryptoService } from './crypto-service.js';
import { sanitizerService } from './sanitizer-service.js';

export const logEmitter = new EventEmitter();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.resolve(__dirname, '../data/deployment_server.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let dbInstance = null;

function initDatabase() {
  if (dbInstance) return dbInstance;

  try {
    dbInstance = new DatabaseSync(DB_FILE);

    // Initialize Schema
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS gcp_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL,
        client_email TEXT NOT NULL,
        region TEXT DEFAULT 'us-central1',
        zone TEXT DEFAULT 'us-central1-a',
        credentials_json TEXT NOT NULL,
        cloud_provider TEXT DEFAULT 'gcp',
        is_verified INTEGER DEFAULT 0,
        verification_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_name TEXT NOT NULL,
        git_username TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        repo_type TEXT DEFAULT 'public',
        pat_token TEXT,
        branch TEXT DEFAULT 'main',
        frontend_present TEXT DEFAULT 'yes',
        frontend_route TEXT DEFAULT '/',
        frontend_port INTEGER DEFAULT 3000,
        backend_present TEXT DEFAULT 'yes',
        backend_route TEXT DEFAULT '/api',
        backend_port INTEGER DEFAULT 5000,
        domain TEXT DEFAULT '_',
        ssl_enabled INTEGER DEFAULT 0,
        ssl_email TEXT,
        gcp_credential_id INTEGER,
        machine_type TEXT DEFAULT 'e2-micro',
        vm_name TEXT,
        vm_zone TEXT DEFAULT 'us-central1-a',
        vm_ip TEXT,
        status TEXT DEFAULT 'pending',
        logs TEXT DEFAULT '',
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id INTEGER,
        level TEXT DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        provider TEXT DEFAULT 'local',
        avatar_url TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_id INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT DEFAULT 'owner',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Migrations for existing DBs
    try { dbInstance.exec(`ALTER TABLE gcp_credentials ADD COLUMN cloud_provider TEXT DEFAULT 'gcp'`); } catch {}
    try { dbInstance.exec(`ALTER TABLE gcp_credentials ADD COLUMN workspace_id INTEGER DEFAULT 1`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN env_vars TEXT`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN database_addon TEXT DEFAULT 'none'`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN workspace_id INTEGER DEFAULT 1`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN active_slot TEXT DEFAULT 'blue'`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN ssl_enabled INTEGER DEFAULT 0`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN ssl_email TEXT`); } catch {}
    try { dbInstance.exec(`ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'local'`); } catch {}
    try { dbInstance.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN simulated INTEGER DEFAULT 0`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN resource_meta TEXT`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN ssh_public_key TEXT`); } catch {}
    try { dbInstance.exec(`ALTER TABLE deployments ADD COLUMN ssh_private_key TEXT`); } catch {}

    // Seed default workspace if none
    const wsCount = dbInstance.prepare('SELECT COUNT(*) as count FROM workspaces').get();
    if (wsCount.count === 0) {
      dbInstance.prepare(`
        INSERT INTO workspaces (id, name, slug, owner_id)
        VALUES (1, 'Production Workspace', 'production-team', 1)
      `).run();
      dbInstance.prepare(`
        INSERT INTO workspaces (id, name, slug, owner_id)
        VALUES (2, 'Staging & Sandbox', 'staging-team', 1)
      `).run();
    }

    // Older versions seeded admin@devlups.com / admin123. Disable that account
    // if it still has the default password; the first sign-up becomes the owner.
    dbInstance.prepare(`UPDATE users SET password_hash = 'disabled:default-admin'
      WHERE email = 'admin@devlups.com' AND password_hash = 'a1b2c3d4e5f60718:c589cb87119627338a0d84e028017cd87d6e68fb892528af34e1952d0b34089c'`).run();

    return dbInstance;
  } catch (err) {
    console.error('[Database] SQLite initialization error:', err);
    throw err;
  }
}

function parseMeta(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

export const db = {
  getRaw: () => initDatabase(),

  // Credentials
  getCredentials: (workspaceId = null) => {
    const database = initDatabase();
    if (workspaceId) {
      return database.prepare('SELECT id, name, project_id, client_email, region, zone, cloud_provider, is_verified, verification_message, workspace_id, created_at, updated_at FROM gcp_credentials WHERE workspace_id = ? ORDER BY id DESC').all(workspaceId);
    }
    return database.prepare('SELECT id, name, project_id, client_email, region, zone, cloud_provider, is_verified, verification_message, workspace_id, created_at, updated_at FROM gcp_credentials ORDER BY id DESC').all();
  },

  getCredentialById: (id) => {
    const database = initDatabase();
    const cred = database.prepare('SELECT * FROM gcp_credentials WHERE id = ?').get(id);
    if (cred && cred.credentials_json) {
      // Decrypt credentials in-memory for cloud provisioning
      cred.credentials_json = cryptoService.decrypt(cred.credentials_json);
    }
    return cred;
  },

  addCredential: ({ name, project_id, client_email, region, zone, credentials_json, cloud_provider = 'gcp', workspace_id = 1, is_verified = 0, verification_message = '' }) => {
    const database = initDatabase();
    // Bank-grade AES-256-GCM encryption at rest
    const encryptedCredentials = cryptoService.encrypt(credentials_json);

    const stmt = database.prepare(`
      INSERT INTO gcp_credentials (name, project_id, client_email, region, zone, credentials_json, cloud_provider, workspace_id, is_verified, verification_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const res = stmt.run(name, project_id, client_email, region || 'us-central1', zone || 'us-central1-a', encryptedCredentials, cloud_provider, workspace_id || 1, is_verified, verification_message);
    return res.lastInsertRowid;
  },

  updateCredentialVerification: (id, is_verified, message) => {
    const database = initDatabase();
    const stmt = database.prepare(`
      UPDATE gcp_credentials SET is_verified = ?, verification_message = ?, updated_at = datetime('now') WHERE id = ?
    `);
    return stmt.run(is_verified ? 1 : 0, message, id);
  },

  deleteCredential: (id) => {
    const database = initDatabase();
    return database.prepare('DELETE FROM gcp_credentials WHERE id = ?').run(id);
  },

  // Deployments
  getDeployments: (workspaceId = null) => {
    const database = initDatabase();
    let sql = `
      SELECT deployments.*, COALESCE(gcp_credentials.cloud_provider, 'gcp') AS cloud_provider
      FROM deployments
      LEFT JOIN gcp_credentials ON deployments.gcp_credential_id = gcp_credentials.id
    `;
    const params = [];
    if (workspaceId) {
      sql += ' WHERE deployments.workspace_id = ?';
      params.push(workspaceId);
    }
    sql += ' ORDER BY deployments.id DESC';

    const list = database.prepare(sql).all(...params);

    // Redact secret tokens in list API
    return list.map(({ ssh_private_key, ...d }) => ({
      ...d,
      pat_token: d.pat_token ? '••••••••' : null,
      env_vars: d.env_vars ? '••••••••' : null,
      resource_meta: parseMeta(d.resource_meta)
    }));
  },

  getDeploymentById: (id) => {
    const database = initDatabase();
    const dep = database.prepare(`
      SELECT deployments.*, COALESCE(gcp_credentials.cloud_provider, 'gcp') AS cloud_provider
      FROM deployments
      LEFT JOIN gcp_credentials ON deployments.gcp_credential_id = gcp_credentials.id
      WHERE deployments.id = ?
    `).get(id);

    if (dep) {
      if (dep.pat_token) dep.pat_token = cryptoService.decrypt(dep.pat_token);
      if (dep.env_vars) dep.env_vars = cryptoService.decrypt(dep.env_vars);
      delete dep.ssh_private_key;
      dep.simulated = dep.simulated === 1;
      dep.resource_meta = parseMeta(dep.resource_meta);
    }
    return dep;
  },

  /** SSH key pair for VM operations (private key encrypted at rest). */
  getDeploymentSshKey: (id) => {
    const row = initDatabase().prepare('SELECT ssh_public_key, ssh_private_key FROM deployments WHERE id = ?').get(id);
    if (!row || !row.ssh_public_key) return null;
    return { publicKey: row.ssh_public_key, privateKey: row.ssh_private_key ? cryptoService.decrypt(row.ssh_private_key) : null };
  },

  setDeploymentSshKey: (id, publicKey, privateKeyPem) => {
    return initDatabase().prepare('UPDATE deployments SET ssh_public_key = ?, ssh_private_key = ? WHERE id = ?')
      .run(publicKey, cryptoService.encrypt(privateKeyPem), id);
  },

  addDeployment: (data) => {
    const database = initDatabase();
    const encryptedPat = data.pat_token ? cryptoService.encrypt(data.pat_token) : null;
    const encryptedEnv = data.env_vars ? cryptoService.encrypt(data.env_vars) : null;

    const stmt = database.prepare(`
      INSERT INTO deployments (
        repo_name, git_username, repo_url, repo_type, pat_token, branch,
        frontend_present, frontend_route, frontend_port,
        backend_present, backend_route, backend_port,
        domain, gcp_credential_id, machine_type, vm_name, vm_zone,
        ssl_enabled, ssl_email, env_vars, database_addon, workspace_id, active_slot, status, logs, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const res = stmt.run(
      data.repo_name,
      data.git_username || 'git-user',
      data.repo_url,
      data.repo_type || 'public',
      encryptedPat,
      data.branch || 'main',
      data.frontend_present || 'yes',
      data.frontend_route || '/',
      data.frontend_port || 3000,
      data.backend_present || 'yes',
      data.backend_route || '/api',
      data.backend_port || 5000,
      data.domain || '_',
      data.gcp_credential_id || null,
      data.machine_type || 'e2-micro',
      data.vm_name || `devlups-vm-${Date.now().toString().slice(-6)}`,
      data.vm_zone || 'us-central1-a',
      data.ssl_enabled ? 1 : 0,
      data.ssl_email || null,
      encryptedEnv,
      data.database_addon || 'none',
      data.workspace_id || 1,
      data.active_slot || 'blue',
      data.status || 'pending',
      sanitizerService.sanitize(data.logs || `[${new Date().toISOString()}] Deployment queued...\n`)
    );
    return res.lastInsertRowid;
  },

  updateDeploymentStatus: (id, status, extra = {}) => {
    const database = initDatabase();
    const fields = ['status = ?', "updated_at = datetime('now')"];
    const params = [status];

    if (extra.vm_ip !== undefined) {
      fields.push('vm_ip = ?');
      params.push(extra.vm_ip);
    }
    if (extra.vm_name !== undefined) {
      fields.push('vm_name = ?');
      params.push(extra.vm_name);
    }
    if (extra.domain !== undefined) {
      fields.push('domain = ?');
      params.push(sanitizerService.sanitize(extra.domain));
    }
    if (extra.ssl_enabled !== undefined) {
      fields.push('ssl_enabled = ?');
      params.push(extra.ssl_enabled ? 1 : 0);
    }
    if (extra.ssl_email !== undefined) {
      fields.push('ssl_email = ?');
      params.push(sanitizerService.sanitize(extra.ssl_email));
    }
    if (extra.vm_zone !== undefined) {
      fields.push('vm_zone = ?');
      params.push(extra.vm_zone);
    }
    if (extra.simulated !== undefined) {
      fields.push('simulated = ?');
      params.push(extra.simulated ? 1 : 0);
    }
    if (extra.resource_meta !== undefined) {
      fields.push('resource_meta = ?');
      params.push(JSON.stringify(extra.resource_meta));
    }
    if (extra.active_slot !== undefined) {
      fields.push('active_slot = ?');
      params.push(extra.active_slot);
    }
    if (extra.error_message !== undefined) {
      fields.push('error_message = ?');
      params.push(sanitizerService.sanitize(extra.error_message));
    }
    if (extra.logs !== undefined) {
      const cleanLogs = sanitizerService.sanitize(extra.logs);
      fields.push('logs = logs || ?');
      params.push('\n' + cleanLogs);
      logEmitter.emit(`log:${id}`, cleanLogs);
    }

    params.push(id);
    const sql = `UPDATE deployments SET ${fields.join(', ')} WHERE id = ?`;
    return database.prepare(sql).run(...params);
  },

  appendDeploymentLog: (id, text) => {
    const database = initDatabase();
    const sanitized = sanitizerService.sanitize(text);
    logEmitter.emit(`log:${id}`, sanitized);
    return database.prepare("UPDATE deployments SET logs = logs || ?, updated_at = datetime('now') WHERE id = ?").run('\n' + sanitized, id);
  },

  deleteDeployment: (id) => {
    const database = initDatabase();
    return database.prepare('DELETE FROM deployments WHERE id = ?').run(id);
  },

  // ==========================================
  // MULTI-TENANT WORKSPACES & USERS
  // ==========================================
  getWorkspaces: (userId = null) => {
    const database = initDatabase();
    return database.prepare(`
      SELECT workspaces.*,
        (SELECT COUNT(*) FROM deployments WHERE deployments.workspace_id = workspaces.id) as deployment_count,
        (SELECT COUNT(*) FROM gcp_credentials WHERE gcp_credentials.workspace_id = workspaces.id) as credential_count
      FROM workspaces
      ORDER BY workspaces.id ASC
    `).all();
  },

  createWorkspace: ({ name, slug, owner_id = 1 }) => {
    const database = initDatabase();
    const cleanSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const stmt = database.prepare('INSERT INTO workspaces (name, slug, owner_id) VALUES (?, ?, ?)');
    const res = stmt.run(name, cleanSlug, owner_id);
    return { id: res.lastInsertRowid, name, slug: cleanSlug, owner_id };
  },

  countUsers: () => initDatabase().prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash NOT LIKE 'disabled:%'").get().n,

  getUserByEmail: (email) => {
    const database = initDatabase();
    return database.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  },

  getUserById: (id) => {
    const database = initDatabase();
    return database.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(id);
  },

  createUser: ({ email, password_hash, name, role = 'developer', provider = 'local', avatar_url = '' }) => {
    const database = initDatabase();
    const stmt = database.prepare('INSERT INTO users (email, password_hash, name, role, provider, avatar_url) VALUES (?, ?, ?, ?, ?, ?)');
    const res = stmt.run(email.toLowerCase(), password_hash, name, role, provider, avatar_url);
    return { id: res.lastInsertRowid, email, name, role, provider, avatar_url };
  },

  findOrCreateOAuthUser: ({ email, name, provider, avatar_url = '' }) => {
    const database = initDatabase();
    const cleanEmail = email.toLowerCase().trim();
    let user = database.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user) {
      const stmt = database.prepare('INSERT INTO users (email, password_hash, name, role, provider, avatar_url) VALUES (?, ?, ?, ?, ?, ?)');
      const res = stmt.run(cleanEmail, `oauth:${provider}`, name || cleanEmail.split('@')[0], 'developer', provider, avatar_url);
      user = { id: res.lastInsertRowid, email: cleanEmail, name: name || cleanEmail.split('@')[0], role: 'developer', provider, avatar_url };
      try {
        database.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (1, ?, ?)').run(user.id, 'member');
      } catch {}
    } else {
      try {
        database.prepare('UPDATE users SET provider = ?, avatar_url = CASE WHEN avatar_url IS NULL OR avatar_url = "" THEN ? ELSE avatar_url END WHERE id = ?')
          .run(provider, avatar_url, user.id);
      } catch {}
      user.provider = provider;
      if (!user.avatar_url && avatar_url) user.avatar_url = avatar_url;
    }
    return { id: user.id, email: user.email, name: user.name, role: user.role, provider: user.provider, avatar_url: user.avatar_url };
  }
};
