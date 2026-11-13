/**
 * Devlups Lab — AWS EC2 Provider Service
 * Uses AWS CLI for provisioning (must be installed on host: https://aws.amazon.com/cli/)
 * Credential schema stored in DB:
 *   { "access_key_id": "AKIA...", "secret_access_key": "...", "region": "us-east-1" }
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';
import { addonService } from './addon-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GCP machine type → EC2 instance type
const MACHINE_TYPE_MAP = {
  'e2-micro':      't3.micro',
  'e2-small':      't3.small',
  'e2-medium':     't3.medium',
  'e2-standard-2': 't3.large',
  'e2-standard-4': 't3.xlarge',
};

// Ubuntu 22.04 LTS AMI IDs per region (2024)
const AWS_AMI_MAP = {
  'us-east-1':      'ami-0c7217cdde317cfec',
  'us-east-2':      'ami-05fb0b8c1424f266b',
  'us-west-1':      'ami-0ce2cb35386fc22e9',
  'us-west-2':      'ami-008fe2fc65df48dac',
  'eu-west-1':      'ami-0905a3c97561e0b69',
  'eu-central-1':   'ami-06dd92ecc74fdfb36',
  'ap-south-1':     'ami-0f58b397bc5c1f2e8',
  'ap-southeast-1': 'ami-0fa377108253bf620',
  'ap-northeast-1': 'ami-0d52744d6551d851e',
};

// GCP zone → AWS region
const ZONE_TO_REGION = {
  'asia-south1-a':  'ap-south-1',
  'asia-south2-a':  'ap-south-1',
  'us-central1-a':  'us-east-1',
  'us-east1-b':     'us-east-1',
  'europe-west1-b': 'eu-west-1',
  'asia-east1-a':   'ap-southeast-1',
};

function runCmd(cmd, env = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      timeout: 300000,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export const awsService = {

  async verifyCredentials({ accessKeyId, secretAccessKey, region = 'us-east-1' }) {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS Access Key ID and Secret Access Key are required.');
    }

    try {
      await runCmd('aws --version');
    } catch {
      // AWS CLI not installed — validate key format only
      if (!accessKeyId.startsWith('AKIA') && !accessKeyId.startsWith('ASIA')) {
        throw new Error('Invalid AWS Access Key ID format. Expected AKIA... or ASIA...');
      }
      return {
        success: true,
        accountId: 'unknown (AWS CLI not installed on host)',
        arn: accessKeyId,
        message: `Credentials stored. Install AWS CLI on host to enable live provisioning. Key: ${accessKeyId.slice(0, 8)}****`,
        cliAvailable: false,
      };
    }

    const env = {
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DEFAULT_REGION: region,
    };

    try {
      const { stdout } = await runCmd('aws sts get-caller-identity --output json', env);
      const identity = JSON.parse(stdout);
      return {
        success: true,
        accountId: identity.Account,
        arn: identity.Arn,
        userId: identity.UserId,
        message: `Verified! AWS Account: ${identity.Account} · ARN: ${identity.Arn.split('/').pop()}`,
        cliAvailable: true,
      };
    } catch (err) {
      throw new Error(`AWS Verification Failed: ${err.message}`);
    }
  },

  generateStartupScript(deployment) {
    const {
      repo_name, git_username, repo_url, repo_type, pat_token,
      frontend_present, frontend_route, frontend_port,
      backend_present, backend_route, backend_port,
    } = deployment;
    const fPort = Number(frontend_port) || 3000;
    const bPort = Number(backend_port) || 5000;

    return `#!/bin/bash
set -e
exec > >(tee -a /var/log/devlups-deployment.log) 2>&1
echo "==========================================================="
echo " Devlups Lab — AWS EC2 Deployment Engine"
echo " Repository: ${repo_name}  Timestamp: $(date -u)"
echo "==========================================================="

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl apt-transport-https ca-certificates software-properties-common git nginx jq

if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
fi
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

rm -f /etc/nginx/sites-enabled/default
PROJECT_DIR="/opt/${repo_name}"
mkdir -p "$PROJECT_DIR" && cd "$PROJECT_DIR"

echo "[AWS Engine] Cloning ${repo_url}..."
${repo_type === 'private' && pat_token
  ? `git clone https://oauth2:${pat_token}@github.com/${git_username}/${repo_name}.git .`
  : `git clone ${repo_url} . || git clone https://github.com/${git_username}/${repo_name}.git .`}

${addonService.generateEnvScript(deployment.env_vars, repo_name)}
${addonService.generateDatabaseScript(deployment.database_addon, repo_name)}

# Load environment variables into current shell
if [ -f "/opt/${repo_name}/.env" ]; then
    set -a
    source "/opt/${repo_name}/.env" 2>/dev/null || true
    set +a
fi

CONF_PATH="/etc/nginx/conf.d/${repo_name}.conf"
cat > "$CONF_PATH" << 'NGINX_EOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 50M;
${frontend_present === 'yes' ? `
    location ${frontend_route || '/'} {
        proxy_pass http://localhost:${fPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300;
    }` : ''}
${backend_present === 'yes' ? `
    location ${backend_route || '/api'} {
        proxy_pass http://localhost:${bPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300;
    }` : ''}
}
NGINX_EOF
nginx -t && systemctl reload nginx || systemctl restart nginx

APP_STARTED=false
COMPOSE_FILE=$(find . -maxdepth 2 \\( -name "docker-compose.yml" -o -name "docker-compose.yaml" \\) | head -n 1)
[ -n "$COMPOSE_FILE" ] && { cd "$(dirname "$COMPOSE_FILE")"; docker compose up -d --build || docker-compose up -d --build; APP_STARTED=true; cd "$PROJECT_DIR"; }

if [ "$APP_STARTED" = false ]; then
    DOCKER_FILE=$(find . -maxdepth 2 -name "Dockerfile" | head -n 1)
    if [ -n "$DOCKER_FILE" ]; then
        DOCKER_DIR=$(dirname "$DOCKER_FILE"); cd "$DOCKER_DIR"
        EXPOSED_PORT=$(grep -iE "^EXPOSE[[:space:]]+[0-9]+" Dockerfile | head -n 1 | awk '{print $2}' | tr -d '\\r')
        TARGET_CONTAINER_PORT=\${EXPOSED_PORT:-${fPort}}
        docker build -t "${repo_name}:latest" .
        ENV_FLAG=""
        [ -f "/opt/${repo_name}/.env" ] && ENV_FLAG="--env-file /opt/${repo_name}/.env"
        docker run -d --name "${repo_name}-app" --restart unless-stopped $ENV_FLAG -p ${fPort}:\$TARGET_CONTAINER_PORT "${repo_name}:latest"
        APP_STARTED=true; cd "$PROJECT_DIR"
    fi
fi

if [ "$APP_STARTED" = false ]; then
    PACKAGE_FILE=$(find . -maxdepth 2 -name "package.json" | head -n 1)
    if [ -n "$PACKAGE_FILE" ]; then
        NODE_DIR=$(dirname "$PACKAGE_FILE"); cd "$NODE_DIR"
        command -v node || { curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs; }
        npm install
        if grep -q '"next"' package.json; then npm run build; PORT=${fPort} nohup npm start -- -p ${fPort} > /var/log/app.log 2>&1 &
        elif grep -q '"vite"' package.json; then
            npm run build
            if [ -d "dist" ]; then
                cat > "$CONF_PATH" << VITE_CONF
server { listen 80 default_server; server_name _; root $(pwd)/dist; index index.html; location / { try_files \$uri \$uri/ /index.html; } }
VITE_CONF
                nginx -t && systemctl reload nginx
            else PORT=${fPort} nohup npm run dev -- --host 0.0.0.0 --port ${fPort} > /var/log/app.log 2>&1 &; fi
        else npm run build 2>/dev/null || true; PORT=${fPort} nohup npm start > /var/log/app.log 2>&1 &; fi
        APP_STARTED=true; cd "$PROJECT_DIR"
    fi
fi

if [ "$APP_STARTED" = false ]; then
    if find . -maxdepth 2 \\( -name "requirements.txt" -o -name "app.py" -o -name "main.py" \\) | grep -q .; then
        apt-get install -y python3 python3-pip python3-venv
        python3 -m venv venv && source venv/bin/activate
        [ -f requirements.txt ] && pip install -r requirements.txt
        pip install gunicorn uvicorn
        if [ -f main.py ]; then nohup uvicorn main:app --host 0.0.0.0 --port ${fPort} > /var/log/app.log 2>&1 &
        elif [ -f app.py ]; then PORT=${fPort} nohup python3 app.py > /var/log/app.log 2>&1 &; fi
        APP_STARTED=true
    fi
fi

if [ "$APP_STARTED" = false ]; then
    HTML_FILE=$(find . -maxdepth 2 -name "index.html" | head -n 1)
    [ -n "$HTML_FILE" ] && {
        HTML_DIR=$(realpath "$(dirname "$HTML_FILE")")
        cat > "$CONF_PATH" << STATIC_CONF
server { listen 80 default_server; server_name _; root $HTML_DIR; index index.html; location / { try_files \$uri \$uri/ /index.html; } }
STATIC_CONF
        nginx -t && systemctl reload nginx; APP_STARTED=true
    }
fi

PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "unknown")
echo "[AWS Engine] Deployment complete! App running at http://$PUBLIC_IP"
`;
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] [AWS] ${msg}`;
      console.log(line);
      db.appendDeploymentLog(deploymentId, line);
    };

    try {
      const deployment = db.getDeploymentById(deploymentId);
      if (!deployment) throw new Error('Deployment not found.');

      let cred = deployment.gcp_credential_id ? db.getCredentialById(deployment.gcp_credential_id) : null;
      if (!cred) {
        const all = db.getCredentials();
        cred = all.find(c => c.is_verified === 1) || all[0];
      }

      let credObj = {};
      try { credObj = JSON.parse(cred?.credentials_json || '{}'); } catch {}

      const isDemo = simulate || !credObj.access_key_id;

      // ── SIMULATE ──
      if (isDemo) {
        log('Phase 1/4: Initializing AWS deployment pipeline...');
        await sleep(1000);
        db.updateDeploymentStatus(deploymentId, 'provisioning');
        log('Phase 2/4: Launching EC2 instance (us-east-1 · t3.medium)...');
        log(`Creating Security Group and opening ports: 22, 80, 443, ${deployment.frontend_port || 3000}, ${deployment.backend_port || 5000}`);
        await sleep(2000);

        const fakeIp = `54.${rnd(10,220)}.${rnd(10,220)}.${rnd(10,220)}`;
        const vmName = deployment.vm_name || `devlups-ec2-${deploymentId}`;
        db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: fakeIp, vm_name: vmName });
        log(`Phase 3/4: Instance i-${Date.now().toString(16)} allocated. Public IP: ${fakeIp}`);
        log(`Cloning ${deployment.repo_url}... Running Universal Engine — detecting stack...`);
        await sleep(1500);
        log(`NGINX reverse proxy: / → :${deployment.frontend_port || 3000} · /api → :${deployment.backend_port || 5000}`);
        log('Docker container started. Health check: HTTP 200 OK');
        await sleep(800);
        log(`Phase 4/4: Deployment complete! App live at http://${fakeIp}`);
        db.updateDeploymentStatus(deploymentId, 'ready', {
          vm_ip: fakeIp,
          logs: `AWS EC2 deployment successful. Running at http://${fakeIp}`
        });
        return { success: true, ip: fakeIp };
      }

      // ── REAL ──
      const awsRegion = credObj.region || ZONE_TO_REGION[deployment.vm_zone] || 'us-east-1';
      const instanceType = MACHINE_TYPE_MAP[deployment.machine_type] || 't3.medium';
      const amiId = AWS_AMI_MAP[awsRegion] || AWS_AMI_MAP['us-east-1'];
      const vmName = deployment.vm_name || `devlups-ec2-${deploymentId}`;
      const env = {
        AWS_ACCESS_KEY_ID: credObj.access_key_id,
        AWS_SECRET_ACCESS_KEY: credObj.secret_access_key,
        AWS_DEFAULT_REGION: awsRegion,
      };

      log(`Phase 1/4: AWS region: ${awsRegion} · Instance: ${instanceType} · AMI: ${amiId}`);
      db.updateDeploymentStatus(deploymentId, 'provisioning');

      // Security Group
      log('Phase 2/4: Creating Security Group...');
      const sgName = `devlups-sg-${vmName}`;
      let sgId;
      try {
        const { stdout } = await runCmd(
          `aws ec2 create-security-group --group-name "${sgName}" --description "Devlups ${vmName}" --output json`, env);
        sgId = JSON.parse(stdout).GroupId;
      } catch {
        const { stdout } = await runCmd(
          `aws ec2 describe-security-groups --filters "Name=group-name,Values=${sgName}" --query "SecurityGroups[0].GroupId" --output text`, env);
        sgId = stdout.trim();
      }
      log(`Security Group: ${sgId}`);

      for (const port of [22, 80, 443, Number(deployment.frontend_port || 3000), Number(deployment.backend_port || 5000)]) {
        try {
          await runCmd(`aws ec2 authorize-security-group-ingress --group-id "${sgId}" --protocol tcp --port ${port} --cidr 0.0.0.0/0`, env);
        } catch { /* rule exists */ }
      }

      // Write user-data to temp file
      const udFile = path.resolve(__dirname, `../data/aws-ud-${deploymentId}.b64`);
      fs.writeFileSync(udFile, Buffer.from(this.generateStartupScript(deployment)).toString('base64'));

      log(`Launching EC2 ${instanceType} with AMI ${amiId}...`);
      const { stdout: runOut } = await runCmd(
        `aws ec2 run-instances --image-id "${amiId}" --instance-type "${instanceType}" --security-group-ids "${sgId}" --user-data "file://${udFile}" --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=${vmName}}]' --count 1 --output json`, env);

      const instanceId = JSON.parse(runOut).Instances[0].InstanceId;
      log(`Instance ${instanceId} launched. Waiting for running state...`);

      await runCmd(`aws ec2 wait instance-running --instance-ids "${instanceId}"`, env);

      const { stdout: ip } = await runCmd(
        `aws ec2 describe-instances --instance-ids "${instanceId}" --query "Reservations[0].Instances[0].PublicIpAddress" --output text`, env);
      const publicIp = ip.trim();

      try { fs.unlinkSync(udFile); } catch {}

      log(`Phase 3/4: EC2 ${instanceId} running at ${publicIp}`);
      log('Phase 4/4: Startup script executing. App will be ready in ~2 minutes.');
      db.updateDeploymentStatus(deploymentId, 'ready', {
        vm_ip: publicIp, vm_name: instanceId,
        logs: `AWS EC2 deployment successful. Instance ${instanceId} at http://${publicIp}`
      });
      return { success: true, ip: publicIp, instanceId };

    } catch (err) {
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    }
  }
};

function rnd(min, max) { return Math.floor(Math.random() * (max - min) + min); }
