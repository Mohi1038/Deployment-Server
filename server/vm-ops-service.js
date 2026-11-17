/**
 * VM operations over SSH: live log streaming, zero-downtime updates, metrics,
 * the web terminal and post-deploy HTTPS.
 *
 * Every deployment gets its own RSA key pair. The public key is baked into the
 * startup script (user `devlups`), the private key is stored AES-256-GCM
 * encrypted in SQLite and only written to a 0600 temp file for the lifetime of
 * one SSH call. Older GCP deployments without a key fall back to
 * `gcloud compute ssh` with the deployment's own service-account key.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { db } from './db.js';
import { blueGreenService } from './blue-green-service.js';
import { sanitizerService } from './sanitizer-service.js';
import { COMPLETION_MARKER, FAILURE_MARKER } from './startup-script.js';

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'LogLevel=ERROR'];

function sshString(buf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}
function sshMpint(b64url) {
  let buf = Buffer.from(b64url, 'base64url');
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return sshString(buf);
}

/** RSA key pair: PEM (PKCS#1) private key + OpenSSH public key line. */
export function generateKeyPair(comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = publicKey.export({ format: 'jwk' });
  const blob = Buffer.concat([sshString(Buffer.from('ssh-rsa')), sshMpint(jwk.e), sshMpint(jwk.n)]);
  return {
    publicKey: `ssh-rsa ${blob.toString('base64')} ${comment}`,
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  };
}

function tempFile(content, suffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devlups-'));
  const file = path.join(dir, `f${suffix || ''}`);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const metricsCache = new Map(); // depId -> { at, sample, metrics }

export const vmOps = {
  /** Returns the deployment's SSH public key, creating the key pair if needed. */
  ensureKeyPair(deploymentId) {
    const existing = db.getDeploymentSshKey(deploymentId);
    if (existing?.publicKey) return existing.publicKey;
    const { publicKey, privateKeyPem } = generateKeyPair(`deployment-server-${deploymentId}`);
    db.setDeploymentSshKey(deploymentId, publicKey, privateKeyPem);
    return publicKey;
  },

  /** Builds the command used to reach the VM. Caller must call cleanup(). */
  accessFor(dep) {
    if (!dep?.vm_ip || dep.simulated) {
      throw new Error(dep?.simulated ? 'This is a sandbox (simulated) deployment; there is no VM to connect to.' : 'The VM has no IP address yet.');
    }
    const key = db.getDeploymentSshKey(dep.id);
    if (key?.privateKey) {
      const k = tempFile(key.privateKey, '.pem');
      return {
        mode: 'ssh',
        argv: (remoteCmd) => ['ssh', ['-i', k.file, ...SSH_OPTS, `devlups@${dep.vm_ip}`, remoteCmd]],
        env: process.env,
        cleanup: k.cleanup,
      };
    }
    if ((dep.cloud_provider || 'gcp') === 'gcp' && dep.gcp_credential_id) {
      const cred = db.getCredentialById(dep.gcp_credential_id);
      if (!cred) throw new Error('The GCP credential for this deployment no longer exists.');
      const k = tempFile(cred.credentials_json, '.json');
      const zone = dep.resource_meta?.zone || cred.zone || `${cred.region}-a`;
      return {
        mode: 'gcloud',
        argv: (remoteCmd) => ['gcloud', ['compute', 'ssh', dep.vm_name, '--project', cred.project_id, '--zone', zone, '--quiet', '--command', remoteCmd]],
        env: { ...process.env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: k.file, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
        cleanup: k.cleanup,
      };
    }
    throw new Error('No SSH access for this deployment (it was created before per-deployment keys). Redeploy it once to enable VM operations.');
  },

  /**
   * Runs a bash script as root on the VM (script sent on stdin).
   * onLine receives each output line as it arrives.
   */
  runScript(deploymentId, script, { timeoutMs = 120000, onLine } = {}) {
    const dep = db.getDeploymentById(deploymentId);
    const access = this.accessFor(dep);
    const [cmd, args] = access.argv('sudo bash -s');
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: access.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', buf = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
      const feed = (chunk) => {
        if (!onLine) return;
        buf += chunk;
        const lines = buf.split('\n'); buf = lines.pop();
        lines.forEach(l => l.trim() && onLine(sanitizerService.sanitize(l)));
      };
      child.stdout.on('data', d => { out += d; feed(d.toString()); });
      child.stderr.on('data', d => { err += d; feed(d.toString()); });
      child.on('error', e => { clearTimeout(timer); access.cleanup(); reject(new Error(`${cmd}: ${e.message}`)); });
      child.on('close', (code, signal) => {
        clearTimeout(timer); access.cleanup();
        if (onLine && buf.trim()) onLine(sanitizerService.sanitize(buf));
        resolve({ code: signal ? 124 : code, stdout: out, stderr: err, timedOut: Boolean(signal) });
      });
      child.stdin.end(script);
    });
  },

  /**
   * Follows /var/log/devlups-deployment.log until the startup script reports
   * completion or failure. Retries while sshd / the operator user come up.
   */
  async streamDeploymentLog(deploymentId, log, { maxWaitMs = 20 * 60 * 1000 } = {}) {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < maxWaitMs) {
      attempt++;
      const dep = db.getDeploymentById(deploymentId);
      let access;
      try { access = this.accessFor(dep); } catch (e) { log(`[VM Log Stream] ${e.message}`); return; }
      const [cmd, args] = access.argv('sudo tail -n +1 -F /var/log/devlups-deployment.log');
      const result = await new Promise((resolve) => {
        const child = spawn(cmd, args, { env: access.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '', done = null, gotLines = false;
        const stopAt = setTimeout(() => { done = 'timeout'; child.kill('SIGTERM'); }, Math.max(1000, maxWaitMs - (Date.now() - started)));
        child.stdout.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            gotLines = true;
            log(line);
            if (line.includes(COMPLETION_MARKER)) { done = 'complete'; child.kill('SIGTERM'); }
            if (line.includes(FAILURE_MARKER)) { done = 'failed'; child.kill('SIGTERM'); }
          }
        });
        child.on('error', () => resolve({ done: 'no-client', gotLines }));
        child.on('close', () => { clearTimeout(stopAt); access.cleanup(); resolve({ done, gotLines }); });
      });
      if (result.done === 'no-client') { log(`[VM Log Stream] ${access.mode === 'gcloud' ? 'gcloud' : 'ssh'} is not installed on the Deployment Server host.`); return; }
      if (result.done) return result.done;
      if (attempt === 1 || attempt % 6 === 0) log('[VM Log Stream] Waiting for the VM to accept SSH connections...');
      await new Promise(r => setTimeout(r, 10000));
    }
    return 'timeout';
  },

  /** Zero-downtime update from the latest commit of the deployment's branch. */
  async update(deploymentId, log) {
    const dep = db.getDeploymentById(deploymentId);
    const script = blueGreenService.generateUpdateScript(dep);
    let activeSlot = null, ok = false;
    const res = await this.runScript(deploymentId, script, {
      timeoutMs: 15 * 60 * 1000,
      onLine: (line) => {
        const m = line.match(/DEVLUPS_ACTIVE_SLOT=(blue|green)/);
        if (m) { activeSlot = m[1]; return; }
        if (line.includes('DEVLUPS_UPDATE_OK')) { ok = true; log(`[Update] ${line.replace('DEVLUPS_UPDATE_OK', 'Update finished:')}`); return; }
        log(line);
      },
    });
    return { ok: ok && res.code === 0, code: res.code, activeSlot };
  },

  /** Live CPU / memory / disk / network numbers read from the VM (cached 10 s). */
  async metrics(deploymentId) {
    const cached = metricsCache.get(deploymentId);
    if (cached && Date.now() - cached.at < 10000) return cached.metrics;
    const dep = db.getDeploymentById(deploymentId);
    const res = await this.runScript(deploymentId, blueGreenService.metricsScript(), { timeoutMs: 30000 });
    const line = res.stdout.split('\n').find(l => l.startsWith('DEVLUPS_METRICS '));
    if (!line) throw new Error((res.stderr || 'VM did not return metrics').trim().slice(0, 300));
    const s = JSON.parse(line.slice('DEVLUPS_METRICS '.length));
    const now = Date.now();
    const prev = cached?.sample;
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const rate = (a, b) => (prev && dt > 0 ? Math.max(0, (a - b) / 1024 / dt) : 0);
    const memUsedMb = Math.round((s.memTotalKb - s.memAvailKb) / 1024);
    const memTotalMb = Math.round(s.memTotalKb / 1024);
    const metrics = {
      source: 'vm',
      deploymentId: dep.id,
      repoName: dep.repo_name,
      status: dep.status,
      ip: dep.vm_ip,
      cpuPercent: s.cpuX10 / 10,
      load1: s.load1,
      memory: { usedMb: memUsedMb, totalMb: memTotalMb, percent: Number(((memUsedMb / memTotalMb) * 100).toFixed(1)) },
      disk: { usedGb: Number((s.diskUsed / 1e9).toFixed(1)), totalGb: Number((s.diskTotal / 1e9).toFixed(1)), percent: Number(((s.diskUsed / s.diskTotal) * 100).toFixed(1)) },
      network: {
        rxMb: Number((s.rxBytes / 1048576).toFixed(1)), txMb: Number((s.txBytes / 1048576).toFixed(1)),
        rxKBps: Number(rate(s.rxBytes, prev?.rxBytes).toFixed(1)), txKBps: Number(rate(s.txBytes, prev?.txBytes).toFixed(1)),
      },
      containers: s.containers,
      uptimeSeconds: s.uptime,
      sampledAt: new Date(now).toISOString(),
    };
    metricsCache.set(deploymentId, { at: now, sample: { at: now, rxBytes: s.rxBytes, txBytes: s.txBytes }, metrics });
    return metrics;
  },

  /** Web terminal: runs one command as root in the project directory on the VM. */
  async exec(deploymentId, command) {
    const dep = db.getDeploymentById(deploymentId);
    const script = `cd /opt/${dep.repo_name} 2>/dev/null || cd /\n${command}\n`;
    const res = await this.runScript(deploymentId, script, { timeoutMs: 20000 });
    let output = (res.stdout || '') + (res.stderr || '');
    if (res.timedOut) output += '\n[terminal] Command stopped after 20 s.';
    if (output.length > 200000) output = output.slice(-200000);
    return { output: sanitizerService.sanitize(output), exitCode: res.code };
  },

  async enableSsl(deploymentId, email) {
    const dep = db.getDeploymentById(deploymentId);
    const domain = dep.domain && dep.domain !== '_'
      ? dep.domain
      : `${dep.repo_name.toLowerCase().replace(/[^a-z0-9]/g, '')}.${dep.vm_ip}.sslip.io`;
    const res = await this.runScript(deploymentId, blueGreenService.sslScript(domain, email, dep.repo_name), {
      timeoutMs: 5 * 60 * 1000,
      onLine: (l) => db.appendDeploymentLog(deploymentId, `[SSL] ${l}`),
    });
    if (res.code !== 0) throw new Error(`Certbot failed (exit ${res.code}). Check that ${domain} resolves to ${dep.vm_ip} and ports 80/443 are open.`);
    return { domain };
  },
};
