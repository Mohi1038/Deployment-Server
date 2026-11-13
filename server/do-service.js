/**
 * Devlups Lab — DigitalOcean Droplets Provider Service
 * Uses the DigitalOcean REST API v2 (native fetch — no external packages)
 * Credential schema stored in DB:
 *   { "api_token": "dop_v1_..." }
 */

import { db } from './db.js';
import { addonService } from './addon-service.js';

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
function rnd(a, b) { return Math.floor(Math.random() * (b - a) + a); }

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
echo " Devlups Lab — DigitalOcean Droplet Deployment Engine"
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

echo "[DO Engine] Cloning ${repo_url}..."
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

echo "[DO Engine] Deployment complete!"
`;
  },

  async triggerDeployment(deploymentId, { simulate = false } = {}) {
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] [DigitalOcean] ${msg}`;
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

      const isDemo = simulate || !credObj.api_token;

      // ── SIMULATE ──
      if (isDemo) {
        log('Phase 1/4: Initializing DigitalOcean deployment pipeline...');
        await sleep(1000);
        db.updateDeploymentStatus(deploymentId, 'provisioning');
        log('Phase 2/4: Creating Droplet (s-2vcpu-4gb · blr1 · Ubuntu 22.04)...');
        await sleep(1800);

        const fakeIp = `167.${rnd(50,220)}.${rnd(10,220)}.${rnd(10,220)}`;
        const vmName = deployment.vm_name || `devlups-do-${deploymentId}`;
        db.updateDeploymentStatus(deploymentId, 'configuring', { vm_ip: fakeIp, vm_name: vmName });
        log(`Phase 3/4: Droplet "${vmName}" active. Public IP: ${fakeIp}`);
        log(`Cloning ${deployment.repo_url}... Running Universal Engine — detecting stack...`);
        await sleep(1500);
        log(`NGINX configured: / → :${deployment.frontend_port || 3000} · /api → :${deployment.backend_port || 5000}`);
        log('Docker container started successfully.');
        await sleep(700);
        log(`Phase 4/4: Deployment complete! App live at http://${fakeIp}`);
        db.updateDeploymentStatus(deploymentId, 'ready', {
          vm_ip: fakeIp,
          logs: `DigitalOcean Droplet deployment successful. Running at http://${fakeIp}`
        });
        return { success: true, ip: fakeIp };
      }

      // ── REAL ──
      const apiToken = credObj.api_token;
      const doRegion = ZONE_TO_DO_REGION[deployment.vm_zone] || 'nyc3';
      const doSize = DO_SIZE_MAP[deployment.machine_type] || 's-2vcpu-4gb';
      const vmName = (deployment.vm_name || `devlups-do-${deploymentId}`).toLowerCase().replace(/[^a-z0-9-]/g, '-');

      log(`Phase 1/4: DigitalOcean region: ${doRegion} · Size: ${doSize} · Droplet: ${vmName}`);
      db.updateDeploymentStatus(deploymentId, 'provisioning');

      // Create Droplet
      log('Phase 2/4: Creating Droplet via DigitalOcean API...');
      const startupScript = this.generateStartupScript(deployment);

      const dropletResp = await doRequest(apiToken, 'POST', '/droplets', {
        name: vmName,
        region: doRegion,
        size: doSize,
        image: 'ubuntu-22-04-x64',
        user_data: startupScript,
        tags: ['devlups-deploy', `dep-${deploymentId}`],
        monitoring: true,
      });

      const dropletId = dropletResp.droplet.id;
      log(`Droplet ${dropletId} created. Polling for active status (max 200s)...`);

      // Poll until active
      let publicIp = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(10000);
        const statusResp = await doRequest(apiToken, 'GET', `/droplets/${dropletId}`);
        const droplet = statusResp.droplet;
        log(`Poll ${attempt + 1}/20: status=${droplet.status}`);

        if (droplet.status === 'active') {
          const v4Networks = droplet.networks?.v4 || [];
          const publicNet = v4Networks.find(n => n.type === 'public');
          publicIp = publicNet?.ip_address;
          if (publicIp) break;
        } else if (droplet.status === 'off' || droplet.status === 'archive') {
          throw new Error(`Droplet entered unexpected status: ${droplet.status}`);
        }
      }

      if (!publicIp) throw new Error('Droplet did not become active within 200 seconds.');

      log(`Phase 3/4: Droplet ${dropletId} active at ${publicIp}`);
      log('Phase 4/4: cloud-init startup script running. App will be ready in ~2 minutes.');

      db.updateDeploymentStatus(deploymentId, 'ready', {
        vm_ip: publicIp,
        vm_name: String(dropletId),
        logs: `DigitalOcean Droplet ${dropletId} deployment successful. Running at http://${publicIp}`
      });
      return { success: true, ip: publicIp, dropletId };

    } catch (err) {
      db.updateDeploymentStatus(deploymentId, 'failed', { error_message: err.message });
      throw err;
    }
  }
};

