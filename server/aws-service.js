/**
 * AWS EC2 provider (AWS CLI v2 on the host).
 * Credential: { access_key_id, secret_access_key, region }
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db.js';
import { runCli } from './cli-runner.js';
import { generateStartupScript } from './startup-script.js';
import { vmOps } from './vm-ops-service.js';
import { gcpService } from './gcp-service.js';

const MACHINE_TYPE_MAP = {
  'e2-micro': 't3.micro', 'e2-small': 't3.small', 'e2-medium': 't3.medium',
  'e2-standard-2': 't3.large', 'e2-standard-4': 't3.xlarge',
};
// Used only if the SSM public parameter lookup fails.
const AWS_AMI_FALLBACK = {
  'us-east-1': 'ami-0c7217cdde317cfec', 'us-east-2': 'ami-05fb0b8c1424f266b', 'us-west-1': 'ami-0ce2cb35386fc22e9',
  'us-west-2': 'ami-008fe2fc65df48dac', 'eu-west-1': 'ami-0905a3c97561e0b69', 'eu-central-1': 'ami-06dd92ecc74fdfb36',
  'ap-south-1': 'ami-0f58b397bc5c1f2e8', 'ap-southeast-1': 'ami-0fa377108253bf620', 'ap-northeast-1': 'ami-0d52744d6551d851e',
};
const UBUNTU_SSM = '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id';

function envFor(credObj, region) {
  return { AWS_ACCESS_KEY_ID: credObj.access_key_id, AWS_SECRET_ACCESS_KEY: credObj.secret_access_key, AWS_DEFAULT_REGION: region };
}
const aws = (args, env, timeoutMs) => runCli('aws', [...args, '--output', 'json'], { env, timeoutMs });

export const awsService = {
  async verifyCredentials({ accessKeyId, secretAccessKey, region = 'us-east-1' }) {
    if (!accessKeyId || !secretAccessKey) throw new Error('AWS Access Key ID and Secret Access Key are required.');
    try {
      const { stdout } = await aws(['sts', 'get-caller-identity'], envFor({ access_key_id: accessKeyId, secret_access_key: secretAccessKey }, region));
      const id = JSON.parse(stdout);
      return { success: true, accountId: id.Account, arn: id.Arn, message: `Verified AWS account ${id.Account} (${id.Arn.split('/').pop()}).` };
    } catch (err) {
      throw new Error(`AWS Verification Failed: ${err.message}`);
    }
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const deployment = db.getDeploymentById(deploymentId);
    if (!deployment) throw new Error('Deployment not found.');
    const log = (msg) => db.appendDeploymentLog(deploymentId, `[${new Date().toISOString()}] [AWS] ${msg}`);
    const cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;
    if (simulate) return gcpService.simulate(deploymentId, deployment, cred, log);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlups-aws-'));
    try {
      if (!cred) throw new Error('No AWS credential selected.');
      const credObj = JSON.parse(cred.credentials_json);
      const region = credObj.region || 'us-east-1';
      const env = envFor(credObj, region);
      const instanceType = MACHINE_TYPE_MAP[deployment.machine_type] || 't3.micro';
      const vmName = deployment.vm_name || `devlups-ec2-${deploymentId}`;

      db.updateDeploymentStatus(deploymentId, 'verifying');
      let amiId;
      try { amiId = JSON.parse((await aws(['ssm', 'get-parameter', '--name', UBUNTU_SSM], env)).stdout).Parameter.Value; }
      catch { amiId = AWS_AMI_FALLBACK[region]; }
      if (!amiId) throw new Error(`No Ubuntu 22.04 AMI known for region ${region}.`);
      log(`Phase 1/4: region ${region}, instance ${instanceType}, Ubuntu 22.04 AMI ${amiId}.`);

      const sshPublicKey = vmOps.ensureKeyPair(deploymentId);
      const keyName = `devlups-${vmName}`;
      const sgName = `devlups-sg-${vmName}`;
      db.updateDeploymentStatus(deploymentId, 'provisioning', { resource_meta: { provider: 'aws', region, keyName, sgName } });

      log('Phase 2/4: Importing the deployment SSH key and creating the security group...');
      const pubFile = path.join(tmp, 'key.pub');
      fs.writeFileSync(pubFile, sshPublicKey);
      await aws(['ec2', 'import-key-pair', '--key-name', keyName, '--public-key-material', `fileb://${pubFile}`], env).catch(() => {});
      let sgId;
      try { sgId = JSON.parse((await aws(['ec2', 'create-security-group', '--group-name', sgName, '--description', `Deployment Server ${vmName}`], env)).stdout).GroupId; }
      catch { sgId = JSON.parse((await aws(['ec2', 'describe-security-groups', '--group-names', sgName], env)).stdout).SecurityGroups[0].GroupId; }
      for (const port of [22, 80, 443]) {
        await aws(['ec2', 'authorize-security-group-ingress', '--group-id', sgId, '--protocol', 'tcp', '--port', String(port), '--cidr', '0.0.0.0/0'], env).catch(() => {});
      }

      const udFile = path.join(tmp, 'user-data.sh');
      fs.writeFileSync(udFile, generateStartupScript(deployment, { provider: 'aws', sshPublicKey }));
      log(`Launching EC2 ${instanceType}...`);
      const run = JSON.parse((await aws(['ec2', 'run-instances', '--image-id', amiId, '--instance-type', instanceType,
        '--key-name', keyName, '--security-group-ids', sgId, '--user-data', `file://${udFile}`, '--count', '1',
        '--tag-specifications', `ResourceType=instance,Tags=[{Key=Name,Value=${vmName}}]`], env)).stdout);
      const instanceId = run.Instances[0].InstanceId;
      db.updateDeploymentStatus(deploymentId, 'provisioning', { resource_meta: { provider: 'aws', region, keyName, sgName, sgId, instanceId } });
      log(`Instance ${instanceId} launched. Waiting for it to run...`);
      await aws(['ec2', 'wait', 'instance-running', '--instance-ids', instanceId], env, 600000);
      const desc = JSON.parse((await aws(['ec2', 'describe-instances', '--instance-ids', instanceId], env)).stdout);
      const ip = desc.Reservations[0].Instances[0].PublicIpAddress;
      if (!ip) throw new Error('The instance has no public IP (is the default VPC subnet public?).');

      log(`Phase 3/4: EC2 ${instanceId} running at ${ip}.`);
      log('Phase 4/4: Startup script is installing, detecting the stack and configuring NGINX.');
      db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: ip, vm_name: vmName });
      return { success: true, ip, instanceId };
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
    if (!meta.instanceId) throw new Error('No EC2 instance recorded for this deployment. Remove it in the AWS console.');
    const cred = db.getCredentialById(deployment.gcp_credential_id);
    if (!cred) throw new Error('The AWS credential for this deployment no longer exists.');
    const env = envFor(JSON.parse(cred.credentials_json), meta.region);
    log(`[AWS] Terminating ${meta.instanceId}...`);
    await aws(['ec2', 'terminate-instances', '--instance-ids', meta.instanceId], env);
    await aws(['ec2', 'wait', 'instance-terminated', '--instance-ids', meta.instanceId], env, 600000);
    if (meta.sgId) await aws(['ec2', 'delete-security-group', '--group-id', meta.sgId], env).catch(e => log(`[AWS] Security group not deleted: ${e.message}`));
    if (meta.keyName) await aws(['ec2', 'delete-key-pair', '--key-name', meta.keyName], env).catch(() => {});
  },
};
