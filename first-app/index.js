/**
 * DeployBase: GitHub App (Probot) for Deployment Server.
 *
 * Slash commands (issue body/title or comment):
 *   /deploy [gcp | aws | azure | digitalocean | cheapest]
 *   /update  (or /redeploy)   zero-downtime update of the existing deployment
 *   /status                   current status and URL
 * Pushes to the deployed branch trigger the same zero-downtime update.
 *
 * Env: API_URL (Deployment Server URL), DEPLOYMENT_API_TOKEN (same value as on the server).
 */
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const API_BASE_URL = (process.env.API_URL || "http://localhost:3000").replace(/\/+$/, "");
const PROVIDERS = { gcp: "gcp", google: "gcp", aws: "aws", azure: "azure", digitalocean: "digitalocean", do: "digitalocean", cheapest: "cheapest" };

export function parseCommand(text) {
  const t = String(text || "").toLowerCase();
  const deploy = t.match(/(?:^|\s)\/(?:deploy|launch)(?:\s+(gcp|google|aws|azure|digitalocean|do|cheapest))?(?=\s|$)/);
  if (deploy) return { action: "deploy", provider: PROVIDERS[deploy[1] || "cheapest"] };
  if (/(?:^|\s)\/(?:update|redeploy)(?=\s|$)/.test(t)) return { action: "update" };
  if (/(?:^|\s)\/status(?=\s|$)/.test(t)) return { action: "status" };
  return null;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(process.env.DEPLOYMENT_API_TOKEN ? { Authorization: `Bearer ${process.env.DEPLOYMENT_API_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function findDeployment(repoName) {
  const { deployments = [] } = await api("/api/deployments");
  return deployments
    .filter(d => d.repo_name.toLowerCase() === repoName.toLowerCase() && !["registered", "destroyed", "destroying"].includes(d.status))
    .sort((a, b) => b.id - a.id)[0];
}

const liveUrl = (d) => (d.domain && d.domain !== "_" ? `${d.ssl_enabled ? "https" : "http"}://${d.domain}` : `http://${d.vm_ip}`);

export default (app) => {
  app.log.info(`DeployBase bot ready. Deployment Server: ${API_BASE_URL}`);
  if (!process.env.DEPLOYMENT_API_TOKEN) app.log.warn("DEPLOYMENT_API_TOKEN is not set; the Deployment Server will reject bot requests.");

  // Repositories added to the app are registered (not deployed).
  app.on("installation_repositories", async (context) => {
    const { action, repositories_added = [], sender } = context.payload;
    if (action !== "added") return;
    for (const repo of repositories_added) {
      try {
        await api("/api/repositories/register", {
          method: "POST",
          body: { repo_name: repo.name, git_username: sender?.login, repo_url: `https://github.com/${repo.full_name}`, repo_type: repo.private ? "private" : "public" },
        });
        app.log.info(`Registered ${repo.full_name}`);
      } catch (err) {
        app.log.error(`Could not register ${repo.full_name}: ${err.message}`);
      }
    }
  });

  app.on("issues.opened", async (context) => {
    const { issue } = context.payload;
    const cmd = parseCommand(`${issue.title}\n${issue.body || ""}`);
    if (cmd) await handle(context, cmd);
  });

  app.on("issue_comment.created", async (context) => {
    if (context.payload.comment.user.type === "Bot") return; // never react to our own comments
    const cmd = parseCommand(context.payload.comment.body);
    if (cmd) await handle(context, cmd);
  });

  // Push to the deployed branch: zero-downtime update.
  app.on("push", async (context) => {
    const { repository, ref, head_commit, pusher } = context.payload;
    const branch = (ref || "").replace("refs/heads/", "");
    try {
      const dep = await findDeployment(repository.name);
      if (!dep || branch !== (dep.branch || "main")) return;
      await api(`/api/deployments/${dep.id}/update`, { method: "POST" });
      app.log.info(`Update started for #${dep.id} (${head_commit?.id?.slice(0, 7)} by ${pusher?.name})`);
    } catch (err) {
      app.log.error(`Push update failed for ${repository.full_name}: ${err.message}`);
    }
  });

  async function handle(context, cmd) {
    const { repository } = context.payload;
    const username = context.payload.sender?.login || "someone";
    try {
      if (cmd.action === "deploy") return await deploy(context, repository, username, cmd.provider);
      if (cmd.action === "update") return await update(context, repository);
      if (cmd.action === "status") return await status(context, repository);
    } catch (err) {
      await context.octokit.issues.createComment(context.issue({ body: `❌ **Deployment Server:** ${err.message}` }));
    }
  }

  async function deploy(context, repository, username, provider) {
    const progress = await context.octokit.issues.createComment(context.issue({
      body: `⏳ **Deployment Server**\n\nDeployment requested by @${username}.\n- **Repository:** \`${repository.full_name}\`\n- **Branch:** \`${repository.default_branch}\`\n- **Cloud:** \`${provider.toUpperCase()}\`\n\nProvisioning a VM, building the app and checking the public URL. This comment updates when it is live.`,
    }));
    const edit = (body) => context.octokit.issues.updateComment(context.issue({ comment_id: progress.data.id, body }));

    try {
      const { id } = await api("/api/deployments", {
        method: "POST",
        body: {
          repo_name: repository.name,
          git_username: repository.owner.login,
          repo_url: `https://github.com/${repository.full_name}`,
          repo_type: repository.private ? "private" : "public",
          branch: repository.default_branch,
          cloud_provider: provider,
        },
      });

      // Provisioning + first build + health check can take several minutes.
      let dep = null;
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 10000));
        dep = (await api(`/api/deployments/${id}`)).deployment;
        if (dep.status === "ready" || dep.status === "failed") break;
      }
      if (dep?.status === "failed") throw new Error(dep.error_message || "Deployment failed");
      if (dep?.status !== "ready") throw new Error(`Still ${dep?.status} after 15 minutes. Check the dashboard log for deployment #${id}.`);

      const url = liveUrl(dep);
      await edit(`🚀 **Deployment Server: live**\n\n| | |\n| :--- | :--- |\n| **URL** | [${url}](${url}) |\n| **Cloud** | \`${(dep.cloud_provider || provider).toUpperCase()}\`${dep.simulated ? " (sandbox, simulated)" : ""} |\n| **Deployment** | \`#${id}\` |\n| **Public IP** | \`${dep.vm_ip}\` |\n| **Health check** | public URL answered through NGINX |\n\nPush to \`${dep.branch}\` or comment \`/update\` for a zero-downtime update.`);
      try {
        await context.octokit.issues.addLabels(context.issue({ labels: ["deployed"] }));
        if (context.payload.issue?.state === "open") await context.octokit.issues.update(context.issue({ state: "closed" }));
      } catch { /* labels/close are best effort */ }
    } catch (err) {
      await edit(`❌ **Deployment Server: deployment failed**\n\n\`${err.message}\`\n\nOpen the dashboard (${API_BASE_URL}) for the full log.`);
    }
  }

  async function update(context, repository) {
    const dep = await findDeployment(repository.name);
    if (!dep) throw new Error(`No deployment found for \`${repository.name}\`. Comment \`/deploy\` first.`);
    await api(`/api/deployments/${dep.id}/update`, { method: "POST" });
    await context.octokit.issues.createComment(context.issue({
      body: `⚡ **Update started** for deployment \`#${dep.id}\`: pulling \`${dep.branch}\`, building the new version next to the live one and switching traffic only after it passes a health check.`,
    }));
  }

  async function status(context, repository) {
    const dep = await findDeployment(repository.name);
    if (!dep) throw new Error(`No deployment found for \`${repository.name}\`.`);
    const url = liveUrl(dep);
    await context.octokit.issues.createComment(context.issue({
      body: `📊 **Deployment Server: status**\n\n- **Status:** \`${dep.status.toUpperCase()}\`\n- **URL:** [${url}](${url})\n- **Cloud:** \`${(dep.cloud_provider || "gcp").toUpperCase()}\`\n- **Live slot:** \`${(dep.active_slot || "blue").toUpperCase()}\`\n- **Updated:** \`${dep.updated_at}\``,
    }));
  }
};
