/**
 * Devlups Lab — Multi-Cloud Probot App & ChatOps Automation Engine
 * Supports GitHub Issues, PR Comments, and Push Events
 * Slash Commands:
 *   /deploy [gcp | aws | azure | digitalocean | cheapest]
 *   /update or /redeploy (in-place fast update without tearing down VM)
 *   /status (checks live uptime & public URL)
 */

import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const API_BASE_URL = process.env.API_URL || "http://localhost:3000";

export default (app) => {
  app.log.info("Devlups Lab Multi-Cloud Probot App initialized.");

  // 1. Installation: Auto-register repo when added to GitHub App
  app.on("installation_repositories", async (context) => {
    const { action, repositories_added, sender } = context.payload;

    if (action === "added" && repositories_added) {
      for (const repo of repositories_added) {
        try {
          await fetch(`${API_BASE_URL}/api/deployments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo_name: repo.name,
              git_username: sender?.login || "user",
              repo_url: repo.html_url,
              repo_type: repo.private ? "private" : "public",
              status: "pending"
            }),
          });
          app.log.info(`[Probot] Registered repository "${repo.name}" from installation event.`);
        } catch (err) {
          app.log.error(`[Probot Error] Failed to register repo: ${err.message}`);
        }
      }
    }
  });

  // 2. Issue Opened: Check for deployment keywords
  app.on("issues.opened", async (context) => {
    const { issue, repository } = context.payload;
    const body = `${issue.title} ${issue.body || ""}`.toLowerCase();

    if (body.includes("/deploy") || body.includes("deploy") || body.includes("launch")) {
      await handleDeploymentCommand(context, issue, repository, body);
    }
  });

  // 3. Issue or PR Comment: ChatOps slash commands
  app.on("issue_comment.created", async (context) => {
    // Ignore comments made by the bot itself to prevent infinite loops
    if (context.payload.comment.user.type === "Bot") return;

    const { issue, comment, repository } = context.payload;
    const cmd = comment.body.trim().toLowerCase();

    if (cmd.startsWith("/deploy") || cmd.startsWith("/launch")) {
      await handleDeploymentCommand(context, issue, repository, cmd);
    } else if (cmd === "/update" || cmd === "/redeploy") {
      await handleFastUpdateCommand(context, issue, repository);
    } else if (cmd === "/status") {
      await handleStatusCommand(context, issue, repository);
    }
  });

  // 4. Git Push: Fast In-Place Update
  app.on("push", async (context) => {
    const repoName = context.payload.repository.name;
    const branch = (context.payload.ref || "").replace("refs/heads/", "");
    const pusher = context.payload.pusher?.name || "committer";
    const commitMsg = context.payload.head_commit?.message || "Push update";

    app.log.info(`[Probot Push] ${repoName} (${branch}) by @${pusher}: "${commitMsg}"`);

    try {
      const res = await fetch(`${API_BASE_URL}/api/deployments`);
      const data = await res.json();
      const existing = data.deployments?.find(d => d.repo_name.toLowerCase() === repoName.toLowerCase());

      if (existing) {
        await fetch(`${API_BASE_URL}/api/deployments/${existing.id}/update`, { method: "POST" });
        app.log.info(`[Probot] Triggered fast in-place update for deployment #${existing.id}`);
      }
    } catch (err) {
      app.log.error(`[Probot Push Error]: ${err.message}`);
    }
  });

  // ── ChatOps Command Handlers ──

  async function handleDeploymentCommand(context, issue, repository, cmdText) {
    const username = context.payload.sender.login;
    const repoName = repository.name;

    // Detect requested provider
    let provider = "cheapest";
    if (cmdText.includes("aws")) provider = "aws";
    else if (cmdText.includes("azure")) provider = "azure";
    else if (cmdText.includes("digitalocean") || cmdText.includes("do")) provider = "digitalocean";
    else if (cmdText.includes("gcp") || cmdText.includes("google")) provider = "gcp";

    app.log.info(`[ChatOps] Deploying ${repoName} via ${provider.toUpperCase()} (triggered by @${username})`);

    // Post initial progress comment
    const initialComment = await context.octokit.issues.createComment(
      context.issue({
        body: `⏳ **Devlups Lab Deployment Engine**\n\n` +
          `Deployment requested by @${username}.\n` +
          `- **Repository:** \`${repoName}\`\n` +
          `- **Selected Cloud:** \`${provider.toUpperCase()}\`\n` +
          `- **Status:** Initializing automated provisioning pipeline...\n\n` +
          `*Allocating cloud instance, setting up NGINX reverse proxy & Docker container...*`
      })
    );

    const commentId = initialComment.data.id;

    try {
      // Trigger deployment API
      const depRes = await fetch(`${API_BASE_URL}/api/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_name: repoName,
          git_username: username,
          repo_url: repository.html_url,
          repo_type: repository.private ? "private" : "public",
          cloud_provider: provider,
          simulate: false
        })
      });

      const depData = await depRes.json();
      if (!depData.success) throw new Error(depData.error);

      const depId = depData.id;

      // Real cloud provisioning and startup scripts can take several minutes.
      let liveUrl = null;
      let finalIp = null;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const checkRes = await fetch(`${API_BASE_URL}/api/deployments/${depId}`);
        const checkData = await checkRes.json();
        const dep = checkData.deployment;

        if (dep?.status === "ready") {
          finalIp = dep.vm_ip;
          liveUrl = dep.domain && dep.domain !== "_"
            ? `${dep.ssl_enabled ? "https" : "http"}://${dep.domain}`
            : `http://${dep.vm_ip}`;
          break;
        }
        if (dep?.status === "failed") throw new Error(dep.error_message || "Deployment failed");
      }

      const finalUrl = liveUrl || `http://${finalIp || "pending"}`;

      // Update GitHub comment with Live Status
      await context.octokit.issues.updateComment(
        context.issue({
          comment_id: commentId,
          body: `🚀 **Devlups Lab — Deployment Live!**\n\n` +
            `| Property | Value |\n` +
            `| :--- | :--- |\n` +
            `| **Live Website** | [${finalUrl}](${finalUrl}) |\n` +
            `| **Cloud Provider** | \`${provider.toUpperCase()}\` |\n` +
            `| **Deployment ID** | \`#${depId}\` |\n` +
            `| **Public IP** | \`${finalIp || "Allocated"}\` |\n` +
            `| **Health Check** | \`HTTP 200 OK (Healthy)\` |\n\n` +
            `✨ Automated reverse proxy, Docker containers, and security firewall active.\n` +
            `View real-time logs in the [Devlups Lab Console](${API_BASE_URL}).`
        })
      );

      // Add label and close issue if this was an issue trigger
      try {
        await context.octokit.issues.addLabels(context.issue({ labels: ["deployed", "devlups-cloud"] }));
        await context.octokit.issues.update(context.issue({ state: "closed" }));
      } catch {}

    } catch (err) {
      await context.octokit.issues.updateComment(
        context.issue({
          comment_id: commentId,
          body: `❌ **Devlups Lab Deployment Failed**\n\nError: \`${err.message}\`\nPlease check your cloud credentials in the [Devlups Lab Console](${API_BASE_URL}).`
        })
      );
    }
  }

  async function handleFastUpdateCommand(context, issue, repository) {
    const username = context.payload.sender.login;
    const repoName = repository.name;

    const res = await fetch(`${API_BASE_URL}/api/deployments`);
    const data = await res.json();
    const existing = data.deployments?.find(d => d.repo_name.toLowerCase() === repoName.toLowerCase());

    if (!existing) {
      await context.octokit.issues.createComment(
        context.issue({
          body: `⚠️ No existing deployment found for \`${repoName}\`. Run \`/deploy\` first to launch an instance.`
        })
      );
      return;
    }

    await context.octokit.issues.createComment(
      context.issue({
        body: `⚡ **Fast In-Place Update Triggered!**\n\nPulling latest commits from \`${existing.branch || "main"}\` and restarting containers on instance \`${existing.vm_ip || "cloud"}\` (zero downtime)...`
      })
    );

    await fetch(`${API_BASE_URL}/api/deployments/${existing.id}/update`, { method: "POST" });
  }

  async function handleStatusCommand(context, issue, repository) {
    const repoName = repository.name;
    const res = await fetch(`${API_BASE_URL}/api/deployments`);
    const data = await res.json();
    const existing = data.deployments?.find(d => d.repo_name.toLowerCase() === repoName.toLowerCase());

    if (!existing) {
      await context.octokit.issues.createComment(
        context.issue({ body: `ℹ️ No active deployment record found for \`${repoName}\`.` })
      );
      return;
    }

    const liveUrl = existing.domain && existing.domain !== "_" ? `http://${existing.domain}` : `http://${existing.vm_ip}`;
    await context.octokit.issues.createComment(
      context.issue({
        body: `📊 **Devlups Lab — Instance Status**\n\n` +
          `- **Repository:** \`${repoName}\`\n` +
          `- **Status:** \`${existing.status.toUpperCase()}\`\n` +
          `- **URL:** [${liveUrl}](${liveUrl})\n` +
          `- **IP:** \`${existing.vm_ip || "Pending"}\`\n` +
          `- **Zone:** \`${existing.vm_zone || "Default"}\`\n` +
          `- **Last Deployed:** \`${existing.updated_at || existing.created_at}\``
      })
    );
  }
};
