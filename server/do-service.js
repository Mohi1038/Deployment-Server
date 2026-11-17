/**
 * Devlups Lab — DigitalOcean Droplets Provider Service
 * Uses the DigitalOcean REST API v2 (native fetch — no external packages)
 * Credential schema stored in DB:
 *   { "api_token": "dop_v1_..." }
 */

import { db } from './db.js';
import { generateStartupScript } from './startup-script.js';
import { vmOps } from './vm-ops-service.js';
import { gcpService } from './gcp-service.js';

const DO_API = 'https://api.digitalocean.com/v2';

// GCP machine type → DigitalOcean Droplet size slug
const DO_SIZE_MAP = {
  'e2-micro':      's-1vcpu-1gb',
  'e2-small':      's-1vcpu-2gb',
  'e2-medium':     's-2vcpu-4gb',
  'e2-standard-2': 's-2vcpu-4gb',
  'e2-standard-4': 's-4vcpu-8gb',
};

// GCP zone → DigitalOcean region slug
const ZONE_TO_DO_REGION = {
  'asia-south1-a':  'blr1',   // Bangalore
  'asia-south2-a':  'blr1',
  'us-central1-a':  'nyc3',
  'us-east1-b':     'nyc1',
  'europe-west1-b': 'ams3',
  'asia-east1-a':   'sgp1',   // Singapore
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doRequest(token, method, path, body) {
  const res = await fetch(`${DO_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`DigitalOcean API error ${res.status}: ${data.message || data.id || text.slice(0, 200)}`);
  }
  return data;
}

export const doService = {

  async verifyCredentials({ apiToken }) {
    if (!apiToken) throw new Error('DigitalOcean API token is required.');
    if (!apiToken.startsWith('dop_') && !apiToken.startsWith('do_')) {
      throw new Error('Invalid API token format. Expected token starting with "dop_v1_".');
    }

    try {
      const data = await doRequest(apiToken, 'GET', '/account');
      const acc = data.account;
      return {
        success: true,
        email: acc.email,
        dropletLimit: acc.droplet_limit,
        status: acc.status,
        message: `Verified! DigitalOcean account: ${acc.email} · Droplet limit: ${acc.droplet_limit} · Status: ${acc.status}`,
      };
    } catch (err) {
      throw new Error(`DigitalOcean Verification Failed: ${err.message}`);
    }
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const deployment = db.getDeploymentById(deploymentId);
    if (!deployment) throw new Error('Deployment not found.');
    const log = (msg) => db.appendDeploymentLog(deploymentId, `[${new Date().toISOString()}] [DigitalOcean] ${msg}`);
    const cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;
    if (simulate) return gcpService.simulate(deploymentId, deployment, cred, log);

    try {
      if (!cred) throw new Error('No DigitalOcean credential selected.');
      const apiToken = JSON.parse(cred.credentials_json).api_token;
      const region = ZONE_TO_DO_REGION[deployment.vm_zone] || 'nyc3';
      const size = DO_SIZE_MAP[deployment.machine_type] || 's-1vcpu-1gb';
      const vmName = (deployment.vm_name || `devlups-do-${deploymentId}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');

      db.updateDeploymentStatus(deploymentId, 'provisioning');
      log(`Phase 1/4: region ${region}, size ${size}, Droplet ${vmName}.`);
      const sshPublicKey = vmOps.ensureKeyPair(deploymentId);
      const created = await doRequest(apiToken, 'POST', '/droplets', {
        name: vmName, region, size, image: 'ubuntu-22-04-x64',
        user_data: generateStartupScript(deployment, { provider: 'digitalocean', sshPublicKey }),
        tags: ['deployment-server', `dep-${deploymentId}`], monitoring: true,
      });
      const dropletId = created.droplet.id;
      db.updateDeploymentStatus(deploymentId, 'provisioning', { resource_meta: { provider: 'digitalocean', dropletId } });
      log(`Phase 2/4: Droplet ${dropletId} created. Waiting for it to become active...`);

      let ip = null;
      for (let attempt = 0; attempt < 30 && !ip; attempt++) {
        await sleep(10000);
        const { droplet } = await doRequest(apiToken, 'GET', `/droplets/${dropletId}`);
        if (droplet.status === 'active') ip = (droplet.networks?.v4 || []).find(n => n.type === 'public')?.ip_address || null;
        else if (droplet.status === 'off' || droplet.status === 'archive') throw new Error(`Droplet entered status ${droplet.status}.`);
      }
      if (!ip) throw new Error('Droplet did not become active within 5 minutes.');

      log(`Phase 3/4: Droplet ${dropletId} active at ${ip}.`);
      log('Phase 4/4: cloud-init is installing, detecting the stack and configuring NGINX.');
      db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: ip, vm_name: vmName });
      return { success: true, ip, dropletId };
    } catch (err) {
      log(`Deployment Failed: ${err.message}`);
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    }
  },

  async destroy(deployment, log) {
    const dropletId = deployment.resource_meta?.dropletId;
    if (!dropletId) throw new Error('No Droplet recorded for this deployment. Remove it in the DigitalOcean console.');
    const cred = db.getCredentialById(deployment.gcp_credential_id);
    if (!cred) throw new Error('The DigitalOcean credential for this deployment no longer exists.');
    log(`[DigitalOcean] Deleting Droplet ${dropletId}...`);
    const res = await fetch(`${DO_API}/droplets/${dropletId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${JSON.parse(cred.credentials_json).api_token}` } });
    if (!res.ok && res.status !== 404) throw new Error(`DigitalOcean API error ${res.status}`);
  },
};
