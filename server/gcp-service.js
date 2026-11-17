/**
 * Google Cloud provider: verification (gcloud CLI, Terraform fallback),
 * provisioning (Terraform, one state per deployment) and teardown.
 */
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db.js';
import { generateStartupScript } from './startup-script.js';
import { terraformRunner } from './terraform-runner.js';
import { vmOps } from './vm-ops-service.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function isSandboxCredential(cred) {
  return Boolean(cred && /demo|sandbox/i.test(cred.project_id || ''));
}

export const gcpService = {
  async verifyCredentials({ credentialsJson, projectId, region = 'asia-south2' }) {
    let credObj;
    try {
      credObj = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
    } catch {
      throw new Error('Invalid JSON format for GCP credentials.');
    }
    if (!credObj.project_id && !projectId) throw new Error('Missing project_id in credentials.');
    if (credObj.web || credObj.installed || (credObj.client_id && !credObj.private_key)) {
      throw new Error('This is a Google OAuth client JSON, not a GCP service-account key. Create a Service Account in Google Cloud IAM, download its JSON key, and upload that file.');
    }
    if (credObj.type !== 'service_account' || !credObj.client_email || !credObj.private_key) {
      throw new Error('Invalid GCP credentials. Upload the JSON key for a service account with type "service_account", client_email, and private_key.');
    }

    const actualProjectId = projectId || credObj.project_id;
    if (credObj.demo_placeholder || isSandboxCredential({ project_id: actualProjectId })) {
      return { success: true, projectId: actualProjectId, message: `Sandbox credential accepted for ${actualProjectId}. Deployments with it are simulated (no VM is created).` };
    }

    // 1) Google Cloud CLI, authenticated with this key only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devlups-gcp-'));
    const keyFile = path.join(dir, 'key.json');
    try {
      fs.writeFileSync(keyFile, JSON.stringify(credObj), { mode: 0o600 });
      const project = await new Promise((resolve, reject) => {
        exec(`gcloud projects describe "${actualProjectId}" --format=json`, {
          timeout: 60000,
          env: { ...process.env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: keyFile, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
        }, (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message));
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Google Cloud CLI returned an invalid project response.')); }
        });
      });
      return { success: true, projectId: actualProjectId, projectNumber: project.projectNumber,
        message: `GCP credentials verified for project ${actualProjectId} (${project.name || actualProjectId}).` };
    } catch (err) {
      if (!/command not found|not found|ENOENT/i.test(err.message)) throw new Error(`GCP Verification Failed: ${err.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // 2) Terraform fallback: a throw-away working dir that creates no resources.
    const key = `verify-${Date.now()}`;
    try {
      const out = await terraformRunner.apply(key,
        { project_id: actualProjectId, region, zone: `${region}-a`, create_vm: false },
        JSON.stringify(credObj), { timeoutMs: 240000 });
      return { success: true, projectId: actualProjectId, projectNumber: out.project_number, message: out.verification_status || `GCP project ${actualProjectId} verified.` };
    } catch (err) {
      throw new Error(`GCP Verification Failed: ${err.message}`);
    } finally {
      terraformRunner.remove(key);
    }
  },

  async simulate(deploymentId, deployment, cred, log) {
    db.updateDeploymentStatus(deploymentId, 'provisioning', { simulated: true });
    log(`[Sandbox] Simulated deployment (credential ${cred ? cred.project_id : 'none'}). No cloud resources are created.`);
    await sleep(1500);
    const ip = `34.135.${Math.floor(Math.random() * 200 + 20)}.${Math.floor(Math.random() * 200 + 10)}`;
    db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: ip });
    log(`[Sandbox] Would provision ${deployment.machine_type} VM, firewall 80/443, clone ${deployment.repo_url} (${deployment.branch}), detect stack, configure NGINX.`);
    await sleep(1500);
    db.updateDeploymentStatus(deploymentId, 'ready', { vm_ip: ip, logs: `[Sandbox] Simulated deployment complete at ${ip}.` });
    return { success: true, ip, simulated: true };
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const deployment = db.getDeploymentById(deploymentId);
    if (!deployment) throw new Error('Deployment not found');
    const log = (msg) => db.appendDeploymentLog(deploymentId, `[${new Date().toISOString()}] ${msg}`);
    const cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;

    try {
      if (simulate || isSandboxCredential(cred)) return await this.simulate(deploymentId, deployment, cred, log);
      if (!cred) throw new Error('No GCP credential selected. Add and verify one under Cloud Credentials.');

      db.updateDeploymentStatus(deploymentId, 'verifying');
      log('Phase 1/4: Preparing deployment (per-deployment SSH key, startup script).');
      const sshPublicKey = vmOps.ensureKeyPair(deploymentId);
      const startupScript = generateStartupScript(deployment, { provider: 'gcp', sshPublicKey });

      const vmName = deployment.vm_name || `devlups-vm-${deploymentId}`;
      const region = cred.region || 'asia-south2';
      const zone = cred.zone || `${region}-a`;
      const tfKey = `dep-${deploymentId}`;
      const vars = {
        project_id: cred.project_id, region, zone, create_vm: true, vm_name: vmName,
        machine_type: deployment.machine_type || 'e2-micro', startup_script: startupScript,
        app_ports: ['22', '80', '443', String(deployment.frontend_port || 3000), String(deployment.backend_port || 5000)],
      };

      db.updateDeploymentStatus(deploymentId, 'provisioning', { resource_meta: { provider: 'gcp', tfKey, vmName, zone, project: cred.project_id } });
      log(`Phase 2/4: terraform apply in data/terraform/${tfKey} (project ${cred.project_id}, zone ${zone}).`);
      const outputs = await terraformRunner.apply(tfKey, vars, cred.credentials_json, {
        onLine: (l) => { if (/Creating|Creation complete|Error|Apply complete|Initializing/.test(l)) log(`[Terraform] ${l.trim()}`); },
      });
      const ip = outputs.instance_ip;
      if (!ip) throw new Error('Terraform finished without an instance IP.');

      log(`Phase 3/4: Compute Engine VM ${vmName} is up at ${ip}.`);
      db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: ip, vm_name: vmName, vm_zone: zone });
      log('Phase 4/4: Startup script is installing, detecting the stack and configuring NGINX.');
      return { success: true, ip };
    } catch (err) {
      log(`Deployment Failed: ${err.message}`);
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    }
  },

  async destroy(deployment, log) {
    const cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;
    if (!cred) throw new Error('The GCP credential for this deployment no longer exists.');
    const tfKey = deployment.resource_meta?.tfKey || `dep-${deployment.id}`;
    const removed = await terraformRunner.destroy(tfKey, cred.credentials_json, {
      onLine: (l) => { if (/Destroying|Destruction complete|Destroy complete|Error/.test(l)) log(`[Terraform] ${l.trim()}`); },
    });
    if (!removed) throw new Error('No Terraform state for this deployment (created by an older version). Delete the VM in the Google Cloud console.');
  },
};
