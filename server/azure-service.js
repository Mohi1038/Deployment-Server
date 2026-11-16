/**
 * Devlups Lab — Azure Virtual Machines Provider Service
 * Uses Azure CLI (az) for provisioning — install from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
 * Credential schema stored in DB:
 *   { "tenant_id": "...", "client_id": "...", "client_secret": "...", "subscription_id": "..." }
 */

import { exec } from 'child_process';
import { db } from './db.js';
import { addonService } from './addon-service.js';

// GCP machine type → Azure VM size
const AZURE_SIZE_MAP = {
  'e2-micro':      'Standard_B1s',
  'e2-small':      'Standard_B1ms',
  'e2-medium':     'Standard_B2s',
  'e2-standard-2': 'Standard_B2ms',
  'e2-standard-4': 'Standard_B4ms',
};

// GCP zone → Azure location
const ZONE_TO_LOCATION = {
  'asia-south1-a':  'centralindia',
  'asia-south2-a':  'centralindia',
  'us-central1-a':  'centralus',
  'us-east1-b':     'eastus',
  'europe-west1-b': 'westeurope',
  'asia-east1-a':   'eastasia',
};

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rnd(a, b) { return Math.floor(Math.random() * (b - a) + a); }

export const azureService = {

  async verifyCredentials({ tenantId, clientId, clientSecret, subscriptionId }) {
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('Azure Tenant ID, Client ID, and Client Secret are all required.');
    }

    try {
      await runCmd('az --version');
    } catch {
      return {
        success: true,
        subscriptionName: 'unknown (Azure CLI not installed on host)',
        subscriptionId,
        message: `Credentials stored. Install Azure CLI on host to enable live provisioning. Client: ${clientId.slice(0, 8)}****`,
        cliAvailable: false,
      };
    }

    try {
      await runCmd(
        `az login --service-principal -u "${clientId}" -p "${clientSecret}" --tenant "${tenantId}" --only-show-errors --output none`
      );
      const subcmd = subscriptionId
        ? `az account show --subscription "${subscriptionId}" --output json`
        : `az account show --output json`;
      const { stdout } = await runCmd(subcmd);
      const account = JSON.parse(stdout);

      return {
        success: true,
        subscriptionName: account.name,
        subscriptionId: account.id,
        tenantId: account.tenantId,
        state: account.state,
        message: `Verified! Azure Subscription: "${account.name}" (${account.id}) · State: ${account.state}`,
        cliAvailable: true,
      };
    } catch (err) {
      throw new Error(`Azure Verification Failed: ${err.message}`);
    }
  },

  generateStartupScript(deployment) {
    const {
      repo_name, git_username, repo_url, repo_type, pat_token,
      frontend_present, frontend_route, frontend_port,
      backend_present, backend_route, backend_port,
      domain, ssl_enabled, ssl_email,
    } = deployment;
    const fPort = Number(frontend_port) || 3000;
    const bPort = Number(backend_port) || 5000;

    return `#!/bin/bash
set -e
exec > >(tee -a /var/log/devlups-deployment.log) 2>&1
echo "==========================================================="
echo " Devlups Lab — Azure VM Deployment Engine"
echo " Repository: ${repo_name}  Timestamp: $(date -u)"
echo "==========================================================="

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl apt-transport-https ca-certificates software-properties-common git nginx jq

if ! command -v docker &> /dev/null; then curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh; fi
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

rm -f /etc/nginx/sites-enabled/default
PROJECT_DIR="/opt/${repo_name}"
mkdir -p "$PROJECT_DIR" && cd "$PROJECT_DIR"

echo "[Azure Engine] Cloning ${repo_url}..."
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
        cd "$(dirname "$DOCKER_FILE")"
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

if [ "${ssl_enabled ? 'true' : 'false'}" = "true" ]; then
    PUBLIC_IP=$(curl -4 -s --max-time 10 https://ifconfig.me)
    SSL_DOMAIN="${domain && domain !== '_' ? domain : ''}"
    [ -z "$SSL_DOMAIN" ] && SSL_DOMAIN="${repo_name.toLowerCase().replace(/[^a-z0-9-]/g, '')}.$PUBLIC_IP.sslip.io"
    apt-get install -y certbot python3-certbot-nginx
    sed -i "s/server_name _;/server_name $SSL_DOMAIN;/g" "$CONF_PATH"
    nginx -t && systemctl reload nginx
    certbot --nginx --non-interactive --agree-tos --email "${ssl_email || ''}" --redirect -d "$SSL_DOMAIN"
    systemctl enable --now certbot.timer
    echo "[SSL] HTTPS enabled at https://$SSL_DOMAIN"
fi
echo "[Azure Engine] Deployment complete!"
`;
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] [Azure] ${msg}`;
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

      const isDemo = simulate || !credObj.tenant_id;

      // ── SIMULATE ──
      if (isDemo) {
        log('Phase 1/4: Initializing Azure deployment pipeline...');
        await sleep(1000);
        db.updateDeploymentStatus(deploymentId, 'provisioning');
        log('Phase 2/4: Creating Resource Group and Virtual Machine (Standard_B2s, Ubuntu 22.04)...');
        log(`Resource Group: devlups-rg-${deploymentId}  Location: centralindia`);
        await sleep(2200);

        const fakeIp = `20.${rnd(10,220)}.${rnd(10,220)}.${rnd(10,220)}`;
        const vmName = deployment.vm_name || `devlups-azure-${deploymentId}`;
        db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: fakeIp, vm_name: vmName });
        log(`Phase 3/4: VM "${vmName}" provisioned. Public IP: ${fakeIp}`);
        log(`NSG rules opened: 22, 80, 443, ${deployment.frontend_port || 3000}, ${deployment.backend_port || 5000}`);
        log(`Cloning ${deployment.repo_url}... Running Universal Engine...`);
        await sleep(1500);
        log('Docker container started. NGINX reverse proxy configured.');
        await sleep(800);
        log(`Phase 4/4: Deployment complete! App live at http://${fakeIp}`);
        db.updateDeploymentStatus(deploymentId, 'ready', {
          vm_ip: fakeIp,
          logs: `Azure VM deployment successful. Running at http://${fakeIp}`
        });
        return { success: true, ip: fakeIp };
      }

      // ── REAL ──
      const location = ZONE_TO_LOCATION[deployment.vm_zone] || 'centralus';
      const azureSize = AZURE_SIZE_MAP[deployment.machine_type] || 'Standard_B2s';
      const vmName = deployment.vm_name || `devlups-azure-${deploymentId}`;
      const rgName = `devlups-rg-${vmName}`;

      log(`Phase 1/4: Azure location: ${location} · VM size: ${azureSize}`);
      db.updateDeploymentStatus(deploymentId, 'provisioning');

      log('Authenticating with Azure service principal...');
      await runCmd(
        `az login --service-principal -u "${credObj.client_id}" -p "${credObj.client_secret}" --tenant "${credObj.tenant_id}" --only-show-errors --output none`
      );
      if (credObj.subscription_id) {
        await runCmd(`az account set --subscription "${credObj.subscription_id}" --only-show-errors`);
      }

      log(`Phase 2/4: Creating Resource Group "${rgName}"...`);
      await runCmd(`az group create --name "${rgName}" --location "${location}" --output none`);

      const startupB64 = Buffer.from(this.generateStartupScript(deployment)).toString('base64');

      log(`Deploying VM "${vmName}" (${azureSize})...`);
      const { stdout: vmOut } = await runCmd(
        `az vm create --resource-group "${rgName}" --name "${vmName}" --image Ubuntu2204 --size "${azureSize}" --admin-username devlups --generate-ssh-keys --custom-data "${startupB64}" --only-show-errors --output json`
      );
      const vmData = JSON.parse(vmOut);
      const publicIp = vmData.publicIpAddress;

      log(`Opening ports 80, 443, ${deployment.frontend_port || 3000}, ${deployment.backend_port || 5000}...`);
      await runCmd(
        `az vm open-port --resource-group "${rgName}" --name "${vmName}" --port '80,443,${deployment.frontend_port || 3000},${deployment.backend_port || 5000}' --priority 100 --only-show-errors --output none`
      );

      log(`Phase 3/4: VM "${vmName}" running at ${publicIp}`);
      log('Phase 4/4: cloud-init startup script executing. App ready in ~3 minutes.');

      db.updateDeploymentStatus(deploymentId, 'ready', {
        vm_ip: publicIp,
        vm_name: vmName,
        logs: `Azure deployment successful. VM "${vmName}" at http://${publicIp}  Resource Group: ${rgName}`
      });
      return { success: true, ip: publicIp, vmName, resourceGroup: rgName };

    } catch (err) {
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    }
  }
};
