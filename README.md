# Deployment Server

**From a GitHub issue to a live, health-checked app on a real cloud VM.**

Comment `/deploy gcp` on an issue (or use the dashboard). Deployment Server then does the rest:

1. provisions a VM on Google Cloud, AWS, Azure or DigitalOcean;
2. detects how the repository should run;
3. puts it behind NGINX, with optional Let's Encrypt HTTPS;
4. streams the VM's build log to the dashboard live;
5. posts the URL back to the issue once the public URL actually answers.

Pushing to the deployed branch (or commenting `/update`) ships the new commit with a zero-downtime blue/green switch.

Author: **Mohit Meemrauth**

---

## How it works

```
GitHub issue / comment / push ──► DeployBase bot (Probot, first-app/)
                                        │  REST + service token
Web dashboard (public/) ──── REST ────► Deployment Server (Express, server/) ── SQLite (node:sqlite)
          ▲                                │
          └──── SSE live logs ─────────────┤ terraform apply / aws / az / DigitalOcean API
                                           ▼
                              Cloud VM (Ubuntu 22.04, generated startup script)
                              NGINX :80/:443 ─► app (Docker slot blue|green, Compose, systemd, static)
                              Certbot (optional) · operator user over SSH (per-deployment key)
```

| Step | What happens | Status |
|---|---|---|
| Trigger | `/deploy [gcp\|aws\|azure\|digitalocean\|cheapest]`, or the dashboard form | `pending` |
| Validate | Inputs validated (nothing user-supplied reaches a shell unchecked); credential chosen: explicit, by provider, or cheapest verified | `pending` |
| Provision | GCP: Terraform in `data/terraform/dep-<id>` (own state per deployment). AWS / Azure: CLI. DigitalOcean: REST API | `verifying → provisioning` |
| Boot | Startup script: operator SSH user, Docker + NGINX, clone the branch, `.env`, optional database container, stack detection | `configuring` |
| Observe | The server tails `/var/log/devlups-deployment.log` over SSH and streams each sanitised line to the dashboard (SSE) | `configuring` |
| Verify | Probes `http://<ip>` through NGINX every 10 s (up to 60 times). NGINX's default page counts as "not ready" | `ready` / `failed` |
| Operate | Zero-downtime updates, live metrics, web terminal, HTTPS, teardown, all over SSH | `deploying`, `degraded`, `destroyed` |

### Stack detection (most specific wins)

| Found in the repo (depth ≤ 2) | How it runs | Updates |
|---|---|---|
| `docker-compose.yml` / `compose.yml` | `docker compose up -d --build` | rebuild + recreate |
| `Dockerfile` | image `<repo>:<commit>`, container bound to `127.0.0.1`, port from `EXPOSE` | **blue/green**: new slot on the idle port, local health check, NGINX switch, old slot removed. A failed check keeps the old slot live |
| `package.json` (Next.js) | `npm run build`, systemd `npm start -p <port>` | reinstall, rebuild, restart |
| `package.json` (Vite) | `npm run build`, NGINX serves `dist/` | rebuild |
| `package.json` (other) | systemd `npm start` | reinstall, rebuild, restart |
| `requirements.txt` / `manage.py` / `main.py` / `app.py` | venv. Django `runserver`, FastAPI `uvicorn`, Flask `app.py`, under systemd | reinstall, restart |
| `index.html` | NGINX static root | pull |
| nothing runnable | placeholder page | pull |

The startup script is idempotent: GCP re-runs startup scripts on every boot, and a re-run only makes sure the services are up.

## Security model

- **Sign-in:** every `/api` route requires a signed-in user. The exceptions are sign-in itself, `/api/health`, `/api/pricing` and the signed webhook.
  - Passwords are hashed with PBKDF2-SHA256 (50,000 iterations). Sessions are HMAC-SHA256 tokens.
  - Google sign-in tokens are verified with Google, and their audience is checked.
- **Who can sign up:** only the first account (the owner) by default. Others need `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`.
- **GitHub bot:** authenticates with `DEPLOYMENT_API_TOKEN`. The webhook endpoint verifies `X-Hub-Signature-256`.
- **Secrets at rest:** cloud credentials, GitHub tokens, env vars and per-deployment SSH private keys are encrypted with AES-256-GCM in SQLite.
- **Secrets in transit:** credentials go to Terraform as `TF_VAR_credentials` (environment, not a file). SSH keys exist on disk only as a 0600 temp file for one call. Every log line passes through a sanitiser that masks tokens, keys and connection-string passwords.
- **Least exposure on the VM:** app containers bind to `127.0.0.1`, so only NGINX is public. The clone's `.git/config` keeps no access token, because updates pass it per request.
- **Web terminal:** runs on the deployment's own VM over SSH, with a 20 s timeout and a block-list for destructive commands.

## Getting started

### Prerequisites (on the Deployment Server host)
- **Node.js ≥ 22.5** (built-in `node:sqlite`) and `ssh`.
- **Cloud tools, one per provider you use:**
  - Terraform ≥ 1.0 (GCP).
  - Google Cloud CLI (optional; used for GCP credential verification and for VMs created before per-deployment keys).
  - AWS CLI v2 (AWS).
  - Azure CLI (Azure).
  - DigitalOcean needs only the API token.

### Run the server and dashboard
```sh
cp .env.example .env       # set DEPLOYMENT_API_TOKEN, GITHUB_WEBHOOK_SECRET, ALLOWED_EMAILS
npm install
npm start                  # http://localhost:3000
```
Sign up (the first account becomes the owner), then add a credential under **Cloud Credentials** and verify it:
- **GCP:** a service-account JSON key with Compute Admin permissions.
- **AWS:** an access key.
- **Azure:** a service principal.
- **DigitalOcean:** an API token.

A GCP key whose project ID contains `sandbox` or `demo` runs **simulated** deployments (no VM). These are clearly labelled and useful for demos.

### Run the GitHub bot
```sh
cd first-app
cp .env.example .env       # APP_ID, PRIVATE_KEY, WEBHOOK_SECRET, API_URL, DEPLOYMENT_API_TOKEN
npm install && npm start
npm test                   # command parsing + /status flow
```
Alternatively, point a plain repository webhook at `POST /api/webhook/github` with the same `GITHUB_WEBHOOK_SECRET`. That path deploys and updates, but it can't comment on issues.

## API (main routes)

| Method & path | Purpose |
|---|---|
| `POST /api/deployments` | create + start a deployment |
| `GET /api/deployments[/:id]` | list / detail (secrets masked) |
| `GET /api/deployments/:id/logs/stream` | live log (SSE; `?token=` for EventSource) |
| `POST /api/deployments/:id/update` | zero-downtime update |
| `POST /api/deployments/:id/ssl` | enable HTTPS on a running deployment |
| `GET /api/deployments/:id/metrics` | live CPU / memory / disk / network from the VM |
| `POST /api/deployments/:id/terminal/exec` | run a command on the VM |
| `POST /api/deployments/:id/destroy` | tear down all cloud resources |
| `DELETE /api/deployments/:id` | remove the record |
| `POST /api/credentials`, `POST /api/credentials/:id/verify` | cloud credentials |
| `POST /api/webhook/github` | signed GitHub webhook (`/deploy`, `/update`, push) |
| `GET /api/health`, `GET /api/pricing` | public health check, list-price comparison |

## Repository layout

```
server/            Express API, provider services, startup-script and update-script generators, SSH layer
public/            dashboard (HTML/CSS/JS, deployable to Vercel)
first-app/         DeployBase GitHub App (Probot)
gcp-auth/main.tf   Terraform module (firewall + Compute Engine VM), copied per deployment
data/              runtime state: SQLite DB, per-deployment Terraform dirs (git-ignored)
deploy.sh, nginx-clone.sh, nginx_file.sh, keys.sh   original v1 setup scripts (kept for reference)
```

## Known limitations

- **Deployment flow:** each deployment is an async task inside one Node process. There's no job queue yet.
- **Ephemeral IPs:** VMs use ephemeral public IPs, so an `sslip.io` hostname changes if the VM is recreated.
- **Pricing:** "cheapest" uses a static list-price table, not live pricing.
- **Startup script contents:** the script (including a private-repo token and env vars) is visible in the VM's metadata / user-data, and in Terraform state on the server host.

## License

ISC
