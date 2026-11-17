/**
 * Zero-downtime updates and VM-side probes.
 *
 * generateUpdateScript() is sent to the VM over SSH. It reads the state the
 * startup script recorded in /var/lib/devlups/<repo>/state.env and updates the
 * app according to its mode:
 *   docker          -> real blue/green: build a new image, start it on the idle
 *                      slot port, health-check it locally, switch the NGINX
 *                      upstream with a graceful reload, then stop the old slot.
 *                      A failed health check keeps the old slot live.
 *   compose         -> docker compose up -d --build (rolling container recreate)
 *   node-service /
 *   python-service  -> reinstall dependencies, rebuild, systemctl restart
 *   vite-static     -> rebuild dist/ (NGINX keeps serving)
 *   static/fallback -> pull only
 */
import { authedRepoUrl } from './startup-script.js';

export const blueGreenService = {
  getNextSlot(currentSlot = 'blue') {
    return currentSlot === 'blue' ? 'green' : 'blue';
  },

  getSlotPorts(basePort = 3000) {
    return { blue: Number(basePort), green: Number(basePort) + 1 };
  },

  generateUpdateScript(dep) {
    const repo = dep.repo_name;
    const image = repo.toLowerCase();
    const branch = dep.branch || 'main';
    return `#!/bin/bash
set -e
STATE="/var/lib/devlups/${repo}/state.env"
if [ ! -f "$STATE" ]; then
  echo "[Update] This VM has no deployment state file (it was created by an older version). Redeploy it once to enable updates."
  exit 3
fi
source "$STATE"
cd "/opt/${repo}"
echo "[Update] Fetching branch ${branch}..."
git -c credential.helper= fetch --depth 1 '${authedRepoUrl(dep)}' '${branch}'
git reset --hard FETCH_HEAD
COMMIT=$(git rev-parse --short HEAD)
echo "[Update] Checked out $COMMIT: $(git log -1 --pretty=%s)"
ENV_FLAG=""
[ -f "/opt/${repo}/.env" ] && ENV_FLAG="--env-file /opt/${repo}/.env"

case "$MODE" in
  docker)
    if [ "$ACTIVE_SLOT" = "blue" ]; then NEXT=green; OLD_PORT=$BLUE_PORT; NEW_PORT=$GREEN_PORT;
    else NEXT=blue; OLD_PORT=$GREEN_PORT; NEW_PORT=$BLUE_PORT; fi
    echo "[Blue/Green] Live slot: $ACTIVE_SLOT (:$OLD_PORT). Building $NEXT (:$NEW_PORT)..."
    cd "$APP_DIR"
    docker build -t "${image}:$COMMIT" .
    docker rm -f "${repo}-$NEXT" >/dev/null 2>&1 || true
    docker run -d --name "${repo}-$NEXT" --restart unless-stopped $ENV_FLAG -p 127.0.0.1:$NEW_PORT:$CONTAINER_PORT "${image}:$COMMIT"
    CODE=000
    for i in $(seq 1 45); do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$NEW_PORT/" || true)
      if [ "$CODE" != "000" ] && [ "$CODE" -lt 500 ]; then break; fi
      sleep 2
    done
    if [ "$CODE" = "000" ] || [ "$CODE" -ge 500 ]; then
      echo "[Blue/Green] New slot $NEXT failed its health check (HTTP $CODE). Keeping $ACTIVE_SLOT live."
      docker logs --tail 30 "${repo}-$NEXT" || true
      docker rm -f "${repo}-$NEXT" >/dev/null 2>&1 || true
      exit 4
    fi
    echo "[Blue/Green] $NEXT is healthy (HTTP $CODE). Switching NGINX upstream to :$NEW_PORT..."
    sed -i "s#proxy_pass http://localhost:$OLD_PORT;#proxy_pass http://localhost:$NEW_PORT;#g" "/etc/nginx/conf.d/${repo}.conf"
    nginx -t
    systemctl reload nginx
    sleep 5
    echo "[Blue/Green] Draining and stopping old slot $ACTIVE_SLOT..."
    docker rm -f "${repo}-$ACTIVE_SLOT" "${repo}-app" >/dev/null 2>&1 || true
    sed -i "s/^ACTIVE_SLOT=.*/ACTIVE_SLOT=$NEXT/" "$STATE"
    echo "DEVLUPS_ACTIVE_SLOT=$NEXT"
    ;;
  compose)
    cd "$APP_DIR"
    if docker compose version >/dev/null 2>&1; then docker compose up -d --build --remove-orphans; else docker-compose up -d --build --remove-orphans; fi
    ;;
  node-service)
    cd "$APP_DIR"
    npm install
    npm run build --if-present
    systemctl restart "$SERVICE"
    ;;
  python-service)
    cd "$APP_DIR"
    [ -f requirements.txt ] && venv/bin/pip install -r requirements.txt
    [ -f manage.py ] && venv/bin/python manage.py migrate || true
    systemctl restart "$SERVICE"
    ;;
  vite-static)
    cd "$APP_DIR"
    npm install
    npm run build
    ;;
  static|fallback)
    echo "[Update] Static content updated."
    ;;
  *)
    echo "[Update] Unknown mode '$MODE'."; exit 5 ;;
esac
echo "DEVLUPS_UPDATE_OK commit=$COMMIT"
`;
  },

  /** Prints one JSON line with live VM metrics (CPU sampled over 1 s). */
  metricsScript() {
    return `#!/bin/bash
read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 _ < /proc/stat
sleep 1
read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
T1=$((u1+n1+s1+i1+w1+q1+sq1+st1)); T2=$((u2+n2+s2+i2+w2+q2+sq2+st2))
IDLE=$(( (i2+w2) - (i1+w1) )); TOTAL=$((T2-T1)); [ "$TOTAL" -le 0 ] && TOTAL=1
CPU_X10=$(( (1000*(TOTAL-IDLE))/TOTAL ))
MEM_TOTAL=$(awk '/MemTotal/{print $2}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
read -r DISK_TOTAL DISK_USED < <(df -B1 / | awk 'NR==2{print $2, $3}')
IFACE=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
RX=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null || echo 0)
TX=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null || echo 0)
UP=$(awk '{print int($1)}' /proc/uptime)
LOAD=$(awk '{print $1}' /proc/loadavg)
CONTAINERS=$(docker ps -q 2>/dev/null | wc -l)
echo "DEVLUPS_METRICS {\\"cpuX10\\":$CPU_X10,\\"memTotalKb\\":$MEM_TOTAL,\\"memAvailKb\\":$MEM_AVAIL,\\"diskTotal\\":$DISK_TOTAL,\\"diskUsed\\":$DISK_USED,\\"rxBytes\\":$RX,\\"txBytes\\":$TX,\\"uptime\\":$UP,\\"load1\\":$LOAD,\\"containers\\":$CONTAINERS}"
`;
  },

  /** Configures HTTPS on an already running VM (any provider). */
  sslScript(domain, email, repo) {
    const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y certbot python3-certbot-nginx
sed -i ${q(`s/server_name [^;]*;/server_name ${domain};/`)} /etc/nginx/conf.d/${repo}.conf
nginx -t && systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --email ${q(email)} --redirect -d ${q(domain)}
systemctl enable --now certbot.timer
echo "[SSL] HTTPS enabled at https://${domain}"
`;
  },
};
