# Deployment Server: 6-minute script

Speaker: Mohit Meemrauth · 9 slides · total ≈ 6:00
(The same text is in each slide's speaker notes.)

| # | Slide | Time | Running total |
|---|-------|------|---------------|
| 1 | Opening | 0:20 | 0:20 |
| 2 | The problem | 0:40 | 1:00 |
| 3 | The solution | 0:35 | 1:35 |
| 4 | System architecture | 0:55 | 2:30 |
| 5 | End-to-end flow | 0:50 | 3:20 |
| 6 | Engineering deep dive | 1:00 | 4:20 |
| 7 | What I built & how it evolved | 0:50 | 5:10 |
| 8 | Results & impact | 0:30 | 5:40 |
| 9 | Closing | 0:20 | 6:00 |

---

## 1 · Opening (~20 seconds)
**Main message:** This is a platform that turns a GitHub comment into a running, verified application on a real cloud VM.

Hi, I'm Mohit Meemrauth. This is Deployment Server. The idea fits in one line along the bottom of the slide: you write /deploy in a GitHub issue, and you get back a live URL for your app running on a real cloud VM, after the system has checked that it actually loads.
I designed and built all of it: the GitHub bot, the control plane, the engine that runs on the VM, and the dashboard. Today I'm showing version 2.

**Transition:** Before the how, let me show you why this was worth building.

## 2 · The problem (~40 seconds)
**Main message:** Deploying a small web app by hand is a nine-step, stack-specific, invisible process — and the goal is to collapse it into one auditable command.

On the left is what deploying even a small app looks like by hand: create a VM, open the firewall, SSH in, install Docker and NGINX, clone the repo, write the env file, hand-write a reverse-proxy config, start the app, which is different for every stack, run Certbot, and then check it actually loads. These nine steps are not invented: they are exactly what my startup script now does.
Why it hurts: it's repetitive, it's stack-specific, it's invisible because progress lives in someone's terminal, and it's risky because keys and tokens get copied around by hand.
What I wanted instead is on the right: one command in GitHub, and a live URL posted back to the same issue, so the issue itself becomes the record of the deployment.

**Transition:** So here is the system that does that.

## 3 · The solution (~35 seconds)
**Main message:** Deployment Server is one control plane with two entry points (GitHub and a dashboard) and six capabilities around it.

In the middle is the platform: a Node.js and Express backend with a SQLite store, and a dashboard. These are real screens from the app.
There are two ways in. From GitHub, the DeployBase bot listens for /deploy, /update and /status. Or from the dashboard, where you fill in the repo, branch, routes, ports, environment variables, an optional database and HTTPS.
Around that: provisioning on GCP through Terraform, plus AWS, Azure and DigitalOcean; one engine that detects how a repo should be started; live logs, metrics and health checks; and zero-downtime updates when you push.
The point is that one system owns the whole path, so it can tell you honestly what state your deployment is in.

**Transition:** Let's open it up and look at the actual components.

## 4 · System architecture (~55 seconds)
**Main message:** Four layers — triggers, the GitHub bot, an Express control plane with a SQLite store, and per-deployment cloud VMs — connected by commands one way and logs/status the other way.

Read it left to right. Triggers come from GitHub or from the dashboard.
GitHub events go to the DeployBase bot, a Probot app. It calls POST /api/deployments on my server, polls the deployment by ID, and when it's done it comments on the issue, labels it and closes it. There's also a direct webhook endpoint on the server as an alternative path.
The control plane is an Express server with 32 routes, and every input that ends up on a VM is validated first. A provider router sends each deployment to the GCP, AWS, Azure or DigitalOcean service, or picks the cheapest verified credential. Every route needs a signed-in user or the bot's service token; Google sign-in is verified with Google. Secrets are encrypted with AES-256-GCM, and all state lives in SQLite through Node's built-in sqlite module.
On the right, for GCP, the server runs terraform apply in its own directory per deployment, so every deployment has its own state. That creates a firewall rule and an Ubuntu VM with a generated startup script. Inside the VM, NGINX fronts the app; the app runs in a blue or green container slot, under Compose, or as a systemd service; Certbot handles HTTPS.
The VM ops layer talks to every VM over SSH with a key generated for that deployment: it streams the build log, reads live metrics, runs updates, HTTPS setup and the web terminal. Red solid lines are commands, blue dashed lines are data, green is the health probe.

**Transition:** Now let's follow one deployment through this system, step by step.

## 5 · End-to-end flow (~50 seconds (click through the seven steps))
**Main message:** Each step is a real operation with a recorded state, so a deployment is never a black box.

One. Someone comments /deploy gcp, or uses the dashboard form, and the bot immediately posts a progress comment.
Two. The API validates every field that will end up in a shell on the VM — repo name, branch, routes, ports, domain — so nothing can be injected. It picks a cloud credential, or the cheapest verified one, and stores a deployment row. Status: pending.
Three. It runs terraform apply in a directory of its own, so each deployment has its own state, creating a firewall rule and an Ubuntu VM. Status moves to provisioning.
Four. On the VM, the generated startup script installs Docker and NGINX, clones the repo — with a token if it's private — writes the env file, starts an optional database, and detects the stack.
Five. NGINX routes slash to the frontend and slash-api to the backend, and Certbot adds HTTPS if requested.
Six. Meanwhile the server is tailing the VM's log over SSH, using a key generated just for this deployment; each line is sanitised, stored and streamed to the dashboard.
Seven. The health service probes the public IP every ten seconds, up to sixty times. Only when the real page answers does the status become ready, and the bot edits the issue with the live URL and closes it.
At the bottom is the state machine. Note "degraded": that comes back to "ready" on its own if the service recovers. And from here, every push to the branch is a zero-downtime update.

**Transition:** Three of these steps hid the hardest engineering decisions. Let's look at them.

## 6 · Engineering deep dive (~60 seconds)
**Main message:** The interesting work was deciding what "running", "safe to switch" and "secure" should mean.

First: one script, any stack. Real repos are packaged in very different ways. Instead of asking users for a deploy config, the startup script looks for the most specific signal first: a Compose file, then a Dockerfile, where it even reads the EXPOSE port, then package.json, where it tells Next.js from Vite from a plain Node server, then Python, where it tells Django, FastAPI and Flask apart, then a static site, and finally a placeholder page.

Second: zero-downtime updates. When you push, the new version is built and started in the idle slot, blue or green, on a port that only the VM can reach. The VM checks it locally. Only if it answers does NGINX switch with a graceful reload, and the old slot is removed. If the check fails, the script stops and the old version simply keeps serving, so users never see a broken deploy.

Third: security. This system holds cloud keys and runs shell commands on remote machines, so I treated it that way. Every field that ends up in a shell is validated, so an injection payload is a 400 error. Every API call needs a signed-in user or the bot's token; GitHub webhooks must carry a valid HMAC signature; secrets are encrypted with AES-256-GCM; each deployment gets its own SSH key; and every log line is scrubbed of tokens before it is stored or streamed.

**Transition:** Here is how the project got from its first version to this one.

## 7 · What I built & how it evolved (~50 seconds)
**Main message:** The project grew in three steps — from a bot that could only verify cloud access to a hardened platform that deploys, observes and safely updates apps — and I built every layer.

Version one was DeployBase: a GitHub bot that reacted to new issues, fetched the GCP key from S3 and used Terraform to check that the account could access the project. The setup scripts for Docker, NGINX and cloning existed, but you ran them separately, and there was no dashboard, no status and no logs.
Version two turned it into a platform: a real backend and dashboard, Terraform that actually provisions a VM, the stack-detection engine, live logs, health checks and HTTPS, four clouds, and a bot that reports the live URL back to the issue.
And this release is about making it production-grade: blue/green updates that are gated by a health check, an SSH layer that gives live metrics, a terminal and HTTPS on any cloud, a separate Terraform state per deployment with proper teardown, authentication on every route, signed webhooks, input validation, and fixed boot scripts for AWS, Azure and DigitalOcean.
Across all of it I built every layer: the GitHub bot, the control plane, the VM engine and the runtime setup.

**Transition:** So what does it actually do today, and how do I know?

## 8 · Results & impact (~30 seconds)
**Main message:** The core path works end to end on a real cloud, and every new capability in this release has been tested.

The headline: nine manual steps become one command, on four clouds, with updates designed for zero downtime, and every one of the 32 API routes behind authentication.
On the left is a live run on GCP: an issue was opened, a VM was provisioned, a Docker container was built, NGINX served it, the public URL returned HTTP 200 with the real Vite and React page, and the issue was updated and closed.
On the right is what I tested for this release: the blue/green switch in both directions, including a failing build that correctly keeps the old version live; the VM engine on Dockerfile and Node repos, including a reboot; the SSH layer; the security checks; and the bot's automated tests. The next step is the same live run on AWS, Azure and DigitalOcean.

**Transition:** Let me close with the one thing I'd like you to remember.

## 9 · Closing (~20 seconds)
**Main message:** One comment in, a verified URL out — and the lesson that observability and safe rollouts are product, not debugging.

To sum up: one GitHub comment becomes a provisioned VM, a detected stack, a routed app and a verified URL — and every later push ships without downtime.
The main thing I learned is that logs, health checks and safe rollouts are part of the product, not debugging output.
Next, I want a live test matrix on all four clouds, a job queue for many concurrent deployments, and stable hostnames. The code is on GitHub at the link shown. Thank you — happy to take questions.

**Transition:** (end — open for questions)
