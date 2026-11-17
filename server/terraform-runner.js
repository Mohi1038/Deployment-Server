/**
 * Runs the GCP Terraform module with one working directory (and therefore one
 * state file) per deployment, so deployments never replace each other's VMs.
 * Credentials are passed as TF_VAR_credentials in the environment and are never
 * written to disk by this runner.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_FILE = path.resolve(__dirname, '../gcp-auth/main.tf');
const TF_ROOT = path.resolve(__dirname, '../data/terraform');
const PLUGIN_CACHE = path.join(TF_ROOT, '.plugin-cache');

function run(args, { cwd, env, timeoutMs, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn('terraform', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const feed = (d) => { if (onLine) d.toString().split('\n').filter(l => l.trim()).forEach(onLine); };
    child.stdout.on('data', d => { out += d; feed(d); });
    child.stderr.on('data', d => { err += d; feed(d); });
    child.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'Terraform is not installed on the Deployment Server host.' : e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error((err || out).trim().split('\n').slice(-15).join('\n') || `terraform ${args[0]} exited with ${code}`));
    });
  });
}

export const terraformRunner = {
  dirFor(key) { return path.join(TF_ROOT, key); },

  /** Prepares the working directory and runs `terraform init` if needed. */
  async prepare(key, publicVars, { onLine } = {}) {
    const dir = this.dirFor(key);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(PLUGIN_CACHE, { recursive: true });
    fs.copyFileSync(MODULE_FILE, path.join(dir, 'main.tf'));
    fs.writeFileSync(path.join(dir, 'vars.auto.tfvars.json'), JSON.stringify(publicVars, null, 2), { mode: 0o600 });
    if (!fs.existsSync(path.join(dir, '.terraform'))) {
      await run(['init', '-input=false', '-no-color'], { cwd: dir, env: this.env(), timeoutMs: 180000, onLine });
    }
    return dir;
  },

  env(credentialsJson) {
    const env = { ...process.env, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_IN_AUTOMATION: '1' };
    if (credentialsJson) env.TF_VAR_credentials = credentialsJson;
    return env;
  },

  async apply(key, publicVars, credentialsJson, { onLine, timeoutMs = 600000 } = {}) {
    const dir = await this.prepare(key, publicVars, { onLine });
    await run(['apply', '-auto-approve', '-input=false', '-no-color'], { cwd: dir, env: this.env(credentialsJson), timeoutMs, onLine });
    const { stdout } = await run(['output', '-json'], { cwd: dir, env: this.env(credentialsJson), timeoutMs: 60000 });
    const outputs = JSON.parse(stdout || '{}');
    return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.value]));
  },

  async destroy(key, credentialsJson, { onLine } = {}) {
    const dir = this.dirFor(key);
    if (!fs.existsSync(path.join(dir, 'terraform.tfstate'))) return false;
    await run(['destroy', '-auto-approve', '-input=false', '-no-color'], { cwd: dir, env: this.env(credentialsJson), timeoutMs: 600000, onLine });
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  },

  remove(key) { fs.rmSync(this.dirFor(key), { recursive: true, force: true }); },
};
