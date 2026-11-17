/**
 * Azure VM provider (Azure CLI on the host).
 * Credential: { tenant_id, client_id, client_secret, subscription_id }
 * Each credential gets its own AZURE_CONFIG_DIR so logins never collide.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';
import { runCli } from './cli-runner.js';
import { generateStartupScript } from './startup-script.js';
import { vmOps } from './vm-ops-service.js';
import { gcpService } from './gcp-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AZURE_SIZE_MAP = {
  'e2-micro': 'Standard_B1s', 'e2-small': 'Standard_B1ms', 'e2-medium': 'Standard_B2s',
  'e2-standard-2': 'Standard_B2ms', 'e2-standard-4': 'Standard_B4ms',
};
const ZONE_TO_LOCATION = {
  'asia-south1-a': 'centralindia', 'asia-south2-a': 'centralindia', 'us-central1-a': 'centralus',
  'us-east1-b': 'eastus', 'europe-west1-b': 'westeurope', 'asia-east1-a': 'southeastasia',
};

async function login(credKey, credObj) {
  const configDir = path.resolve(__dirname, `../data/azure/${credKey}`);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const env = { AZURE_CONFIG_DIR: configDir };
  await runCli('az', ['login', '--service-principal', '-u', credObj.client_id, '-p', credObj.client_secret,
    '--tenant', credObj.tenant_id, '--only-show-errors', '--output', 'none'], { env });
  if (credObj.subscription_id) await runCli('az', ['account', 'set', '--subscription', credObj.subscription_id], { env });
  return (args, timeoutMs) => runCli('az', [...args, '--only-show-errors', '--output', 'json'], { env, timeoutMs });
}

export const azureService = {
  async verifyCredentials({ tenantId, clientId, clientSecret, subscriptionId }) {
    if (!tenantId || !clientId || !clientSecret) throw new Error('Azure Tenant ID, Client ID, and Client Secret are all required.');
    try {
      const az = await login(`verify-${clientId.slice(0, 8)}`, { tenant_id: tenantId, client_id: clientId, client_secret: clientSecret, subscription_id: subscriptionId });
      const account = JSON.parse((await az(['account', 'show'])).stdout);
      return { success: true, subscriptionId: account.id, message: `Verified Azure subscription "${account.name}" (${account.id}), state ${account.state}.` };
    } catch (err) {
      throw new Error(`Azure Verification Failed: ${err.message}`);
    }
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const deployment = db.getDeploymentById(deploymentId);
    if (!deployment) throw new Error('Deployment not found.');
    const log = (msg) => db.appendDeploymentLog(deploymentId, `[${new Date().toISOString()}] [Azure] ${msg}`);
    const cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;
    if (simulate) return gcpService.simulate(deploymentId, deployment, cred, log);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlups-az-'));
    try {
      if (!cred) throw new Error('No Azure credential selected.');
      const credObj = JSON.parse(cred.credentials_json);
      const location = ZONE_TO_LOCATION[deployment.vm_zone] || 'centralus';
      const size = AZURE_SIZE_MAP[deployment.machine_type] || 'Standard_B1s';
      const vmName = deployment.vm_name || `devlups-azure-${deploymentId}`;
      const rg = `devlups-rg-${vmName}`;

      db.updateDeploymentStatus(deploymentId, 'verifying');
      const az = await login(`cred-${cred.id}`, credObj);
      log(`Phase 1/4: location ${location}, size ${size}, resource group ${rg}.`);
      const sshPublicKey = vmOps.ensureKeyPair(deploymentId);
      db.updateDeploymentStatus(deploymentId, 'provisioning', { resource_meta: { provider: 'azure', resourceGroup: rg, vmName, credId: cred.id } });
      await az(['group', 'create', '--name', rg, '--location', location]);

      const pubFile = path.join(tmp, 'key.pub');
      const dataFile = path.join(tmp, 'custom-data.sh');
      fs.writeFileSync(pubFile, sshPublicKey);
      fs.writeFileSync(dataFile, generateStartupScript(deployment, { provider: 'azure', sshPublicKey }));
      log('Phase 2/4: Creating the VM (Ubuntu 22.04)...');
      const vm = JSON.parse((await az(['vm', 'create', '--resource-group', rg, '--name', vmName, '--image', 'Ubuntu2204',
        '--size', size, '--admin-username', 'devlups', '--ssh-key-values', pubFile, '--custom-data', dataFile,
        '--public-ip-sku', 'Standard'], 900000)).stdout);
      const ip = vm.publicIpAddress;
      await az(['vm', 'open-port', '--resource-group', rg, '--name', vmName, '--port', '80,443', '--priority', '900']);

      log(`Phase 3/4: VM ${vmName} running at ${ip}.`);
      log('Phase 4/4: cloud-init is installing, detecting the stack and configuring NGINX.');
      db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: ip, vm_name: vmName });
      return { success: true, ip };
    } catch (err) {
      log(`Deployment Failed: ${err.message}`);
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },

  async destroy(deployment, log) {
    const meta = deployment.resource_meta || {};
    if (!meta.resourceGroup) throw new Error('No Azure resource group recorded for this deployment. Remove it in the Azure portal.');
    const cred = db.getCredentialById(deployment.gcp_credential_id);
    if (!cred) throw new Error('The Azure credential for this deployment no longer exists.');
    const az = await login(`cred-${cred.id}`, JSON.parse(cred.credentials_json));
    log(`[Azure] Deleting resource group ${meta.resourceGroup} (VM, disk, IP, NSG)...`);
    await az(['group', 'delete', '--name', meta.resourceGroup, '--yes'], 1200000);
  },
};
