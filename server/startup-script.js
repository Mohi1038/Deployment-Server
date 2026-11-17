/**
 * Universal VM startup script (shared by GCP, AWS, Azure and DigitalOcean).
 *
 * Runs as root on first boot (GCP metadata startup-script, EC2 user-data,
 * Azure custom-data, Droplet user_data). It:
 *   1. creates the `devlups` operator user with the deployment's SSH public key
 *      (used for live logs, updates, metrics, terminal and HTTPS setup),
 *   2. installs Docker, Compose and NGINX, clones the repository branch,
 *   3. detects the stack and starts it (Compose, Dockerfile, Node, Python,
 *      static HTML, or a fallback page) under Docker or systemd,
 *   4. writes NGINX reverse-proxy config, optional Let's Encrypt HTTPS,
 *   5. records state in /var/lib/devlups/<repo>/state.env for later updates.
 *
 * The script is idempotent: GCP re-runs startup scripts on every boot, so a
 * second run only makes sure services are up and exits.
 */
import { addonService } from './addon-service.js';

export const COMPLETION_MARKER = 'Universal Cloud Deployment Completed Successfully';
export const FAILURE_MARKER = 'Universal Cloud Deployment Failed';

const PUBLIC_IP_LOOKUP = {
  gcp: `curl -fsS --max-time 5 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip`,
  aws: `TOKEN=$(curl -fsS --max-time 5 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4`,
  azure: `curl -fsS --max-time 5 -H Metadata:true "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text"`,
  digitalocean: `curl -fsS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address`,
};

export function safeName(repoName) {
  return String(repoName).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function plainRepoUrl(dep) {
  return dep.repo_url || `https://github.com/${dep.git_username}/${dep.repo_name}`;
}

export function authedRepoUrl(dep) {
  const url = plainRepoUrl(dep);
  if (dep.repo_type === 'private' && dep.pat_token) {
    return url.replace(/^https:\/\//, `https://oauth2:${dep.pat_token}@`);
  }
  return url;
}

function proxyLocation(route, port) {
  return `
    location ${route} {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300;
    }`;
}

export function generateStartupScript(dep, { provider = 'gcp', sshPublicKey = '' } = {}) {
  const repo = dep.repo_name;
  const svc = `devlups-${safeName(repo)}`;
  const fPort = Number(dep.frontend_port) || 3000;
  const bPort = Number(dep.backend_port) || 5000;
  const greenPort = fPort + 1;
  const branch = dep.branch || 'main';
  const sslDomain = dep.domain && dep.domain !== '_' ? String(dep.domain).trim() : '';
  const ipLookup = PUBLIC_IP_LOOKUP[provider] || PUBLIC_IP_LOOKUP.gcp;
  const pubKey = String(sshPublicKey || '').replace(/'/g, '');

  return `#!/bin/bash
set -e
exec > >(tee -a /var/log/devlups-deployment.log) 2>&1
trap 'echo "[Engine] Step failed at line $LINENO (exit $?)"; echo " ${FAILURE_MARKER}"' ERR

STATE_DIR="/var/lib/devlups/${repo}"
PROJECT_DIR="/opt/${repo}"
CONF_PATH="/etc/nginx/conf.d/${repo}.conf"
mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------
# 0. Operator access (logs, updates, metrics, terminal, HTTPS)
# ---------------------------------------------------------------
if [ -n '${pubKey}' ]; then
    id -u devlups >/dev/null 2>&1 || useradd -m -s /bin/bash devlups
    mkdir -p /home/devlups/.ssh
    touch /home/devlups/.ssh/authorized_keys
    grep -qxF '${pubKey}' /home/devlups/.ssh/authorized_keys || echo '${pubKey}' >> /home/devlups/.ssh/authorized_keys
    chown -R devlups:devlups /home/devlups/.ssh
    chmod 700 /home/devlups/.ssh && chmod 600 /home/devlups/.ssh/authorized_keys
    echo 'devlups ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-devlups && chmod 440 /etc/sudoers.d/90-devlups
fi

# Re-run on reboot (GCP runs startup scripts on every boot): just make sure
# everything is running, never re-clone.
if [ -f "$STATE_DIR/deployed" ]; then
    echo "[Engine] Existing deployment found; ensuring services are running."
    systemctl start docker nginx 2>/dev/null || true
    systemctl start ${svc}.service 2>/dev/null || true
    echo " ${COMPLETION_MARKER}"
    exit 0
fi

echo "==========================================================="
echo " Deployment Server: Universal Deployment Engine (${provider})"
echo " Repository: ${repo}  Branch: ${branch}"
echo " Timestamp: $(date -u)"
echo "==========================================================="

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git nginx jq

if ! command -v docker >/dev/null 2>&1; then
    echo "[Engine] Installing Docker Engine..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
fi
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    echo "[Engine] Installing Docker Compose..."
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi
compose() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

rm -f /etc/nginx/sites-enabled/default /var/www/html/index.nginx-debian.html

# ---------------------------------------------------------------
# 1. Source code
# ---------------------------------------------------------------
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
echo "[Engine] Cloning ${plainRepoUrl(dep)} (branch ${branch})..."
git clone --depth 1 --branch '${branch}' '${authedRepoUrl(dep)}' . || git clone --depth 1 '${authedRepoUrl(dep)}' .
# Do not keep the access token in .git/config; updates pass it per request.
git remote set-url origin '${plainRepoUrl(dep)}'

${addonService.generateEnvScript(dep.env_vars, repo)}
${addonService.generateDatabaseScript(dep.database_addon, repo)}
ENV_FLAG=""
[ -f "$PROJECT_DIR/.env" ] && ENV_FLAG="--env-file $PROJECT_DIR/.env"

# ---------------------------------------------------------------
# 2. NGINX reverse proxy
# ---------------------------------------------------------------
cat > "$CONF_PATH" << 'NGINX_EOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 50M;
${dep.frontend_present !== 'no' ? proxyLocation(dep.frontend_route || '/', fPort) : ''}
${dep.backend_present !== 'no' ? proxyLocation(dep.backend_route || '/api', bPort) : ''}
}
NGINX_EOF
nginx -t && systemctl reload nginx || systemctl restart nginx

static_site() { # $1 = document root
    cat > "$CONF_PATH" << NGINX_STATIC
server {
    listen 80 default_server;
    server_name _;
    root $1;
    index index.html;
    location / { try_files \\$uri \\$uri/ /index.html; }
}
NGINX_STATIC
    nginx -t && systemctl reload nginx
}

make_service() { # $1 = working dir, $2 = command
    cat > /etc/systemd/system/${svc}.service << UNIT
[Unit]
Description=Deployment Server app ${repo}
After=network.target

[Service]
WorkingDirectory=$1
EnvironmentFile=-$PROJECT_DIR/.env
Environment=PORT=${fPort}
ExecStart=/bin/bash -lc '$2'
Restart=always
RestartSec=3
StandardOutput=append:/var/log/devlups-app.log
StandardError=append:/var/log/devlups-app.log

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now ${svc}.service
}

write_state() { # $1 = mode, $2 = app dir, $3 = container port
    cat > "$STATE_DIR/state.env" << STATE
MODE=$1
APP_DIR=$2
CONTAINER_PORT=$3
ACTIVE_SLOT=blue
BLUE_PORT=${fPort}
GREEN_PORT=${greenPort}
BRANCH=${branch}
SERVICE=${svc}
STATE
}

# ---------------------------------------------------------------
# 3. Stack detection (most specific packaging wins)
# ---------------------------------------------------------------
MODE=""
COMPOSE_FILE=$(find . -maxdepth 2 \\( -name "docker-compose.yml" -o -name "docker-compose.yaml" -o -name "compose.yml" -o -name "compose.yaml" \\) | head -n 1)
DOCKER_FILE=$(find . -maxdepth 2 -name "Dockerfile" | head -n 1)
PACKAGE_FILE=$(find . -maxdepth 2 -name "package.json" -not -path "*/node_modules/*" | head -n 1)
PY_FILE=$(find . -maxdepth 2 \\( -name "requirements.txt" -o -name "manage.py" -o -name "main.py" -o -name "app.py" \\) | head -n 1)
HTML_FILE=$(find . -maxdepth 2 -name "index.html" | head -n 1)

if [ -n "$COMPOSE_FILE" ]; then
    APP_DIR=$(realpath "$(dirname "$COMPOSE_FILE")")
    echo "[Engine] Detected Docker Compose in $APP_DIR. Launching services..."
    cd "$APP_DIR" && compose up -d --build
    MODE=compose; write_state compose "$APP_DIR" ""

elif [ -n "$DOCKER_FILE" ]; then
    APP_DIR=$(realpath "$(dirname "$DOCKER_FILE")")
    cd "$APP_DIR"
    EXPOSED_PORT=$(grep -iE "^EXPOSE[[:space:]]+[0-9]+" Dockerfile | head -n 1 | awk '{print $2}' | tr -d '\\r')
    CPORT=\${EXPOSED_PORT:-${fPort}}
    echo "[Engine] Detected Dockerfile in $APP_DIR (container port $CPORT). Building image..."
    COMMIT=$(git -C "$PROJECT_DIR" rev-parse --short HEAD)
    docker build -t "${repo.toLowerCase()}:$COMMIT" .
    docker run -d --name "${repo}-blue" --restart unless-stopped $ENV_FLAG -p 127.0.0.1:${fPort}:$CPORT "${repo.toLowerCase()}:$COMMIT"
    MODE=docker; write_state docker "$APP_DIR" "$CPORT"

elif [ -n "$PACKAGE_FILE" ]; then
    APP_DIR=$(realpath "$(dirname "$PACKAGE_FILE")")
    cd "$APP_DIR"
    echo "[Engine] Detected Node.js project in $APP_DIR."
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi
    npm install
    if grep -q '"next"' package.json; then
        echo "[Engine] Next.js: building and starting a production server..."
        npm run build
        make_service "$APP_DIR" "npm start -- -p ${fPort}"
        MODE=node-service; write_state node-service "$APP_DIR" ""
    elif grep -q '"vite"' package.json && npm run build && [ -d dist ]; then
        echo "[Engine] Vite: serving the production build with NGINX..."
        static_site "$APP_DIR/dist"
        MODE=vite-static; write_state vite-static "$APP_DIR" ""
    else
        echo "[Engine] Starting the Node.js server with systemd..."
        npm run build --if-present || true
        make_service "$APP_DIR" "npm start"
        MODE=node-service; write_state node-service "$APP_DIR" ""
    fi

elif [ -n "$PY_FILE" ]; then
    APP_DIR=$(realpath "$(dirname "$PY_FILE")")
    cd "$APP_DIR"
    echo "[Engine] Detected Python application in $APP_DIR."
    apt-get install -y python3 python3-pip python3-venv
    python3 -m venv venv
    [ -f requirements.txt ] && venv/bin/pip install -r requirements.txt
    venv/bin/pip install gunicorn uvicorn
    if [ -f manage.py ]; then
        venv/bin/python manage.py migrate || true
        make_service "$APP_DIR" "venv/bin/python manage.py runserver 0.0.0.0:${fPort}"
    elif [ -f main.py ]; then
        make_service "$APP_DIR" "venv/bin/uvicorn main:app --host 0.0.0.0 --port ${fPort}"
    else
        make_service "$APP_DIR" "venv/bin/python app.py"
    fi
    MODE=python-service; write_state python-service "$APP_DIR" ""

elif [ -n "$HTML_FILE" ]; then
    APP_DIR=$(realpath "$(dirname "$HTML_FILE")")
    echo "[Engine] Detected a static website in $APP_DIR."
    static_site "$APP_DIR"
    MODE=static; write_state static "$APP_DIR" ""

else
    echo "[Engine] No runnable stack found. Serving a placeholder page."
    mkdir -p /var/www/devlups
    cat > /var/www/devlups/index.html << 'HTML_EOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>${repo}: deployed</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px">
<h1>Deployment active</h1><p>Repository <strong>${repo}</strong> is provisioned. Add a Dockerfile, package.json, requirements.txt or index.html to run your app.</p>
</body></html>
HTML_EOF
    static_site /var/www/devlups
    MODE=fallback; write_state fallback /var/www/devlups ""
fi
cd "$PROJECT_DIR"

# ---------------------------------------------------------------
# 4. HTTPS (Let's Encrypt, automatic renewal)
# ---------------------------------------------------------------
if [ "${dep.ssl_enabled ? 'true' : 'false'}" = "true" ]; then
    PUBLIC_IP=$( { ${ipLookup}; } 2>/dev/null || curl -fsS --max-time 5 https://api.ipify.org || true)
    SSL_DOMAIN='${sslDomain}'
    [ -z "$SSL_DOMAIN" ] && [ -n "$PUBLIC_IP" ] && SSL_DOMAIN="${safeName(repo)}.$PUBLIC_IP.sslip.io"
    if [ -n "$SSL_DOMAIN" ]; then
        apt-get install -y certbot python3-certbot-nginx
        sed -i "s/server_name _;/server_name $SSL_DOMAIN;/g" "$CONF_PATH"
        nginx -t && systemctl reload nginx
        if certbot --nginx --non-interactive --agree-tos --email '${dep.ssl_email || ''}' --redirect -d "$SSL_DOMAIN"; then
            systemctl enable --now certbot.timer || true
            echo "[SSL] HTTPS enabled at https://$SSL_DOMAIN"
        else
            echo "[SSL] Certificate request failed (DNS must point at this VM, ports 80/443 open). Serving HTTP."
        fi
    else
        echo "[SSL] Could not determine a hostname for the certificate. Serving HTTP."
    fi
fi

touch "$STATE_DIR/deployed"
echo "[Engine] Stack mode: $MODE"
echo "==========================================================="
echo " ${COMPLETION_MARKER}"
echo "==========================================================="
`;
}
