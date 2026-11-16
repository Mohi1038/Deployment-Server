/**
 * Devlups Lab — Automated Health Check & Self-Healing Service
 * Monitors deployed instances, verifies HTTP status, and handles auto-recovery.
 */

import http from 'http';
import { db } from './db.js';

export const healthService = {
  failedProbes: new Map(),

  /**
   * Ping an IP / URL to check if web service is responding
   */
  async pingUrl(url, timeoutMs = 5000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
          const latency = Date.now() - startTime;
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => {
            if (body.length < 65536) body += chunk;
          });
          res.on('end', () => {
            const isDefaultNginxPage = body.includes('<title>Welcome to nginx!</title>');
            const isHealthy = res.statusCode >= 200 && res.statusCode < 400 && !isDefaultNginxPage;
            resolve({
              healthy: isHealthy,
              statusCode: res.statusCode,
              error: isDefaultNginxPage ? 'Default NGINX page is still serving' : undefined,
              latencyMs: latency,
              url
            });
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ healthy: false, statusCode: 408, error: 'Connection timed out', latencyMs: timeoutMs, url });
        });

        req.on('error', (err) => {
          resolve({ healthy: false, statusCode: 0, error: err.message, latencyMs: Date.now() - startTime, url });
        });
      } catch (err) {
        resolve({ healthy: false, statusCode: 0, error: err.message, latencyMs: 0, url });
      }
    });
  },

  /**
   * Monitor a deployment until it responds with HTTP 200/3xx or times out
   */
  async verifyDeploymentHealth(deploymentId, targetIp, port = 80, maxRetries = 60, delayMs = 10000) {
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] [HealthCheck] ${msg}`;
      console.log(line);
      db.appendDeploymentLog(deploymentId, line);
    };

    const targetUrl = port === 80 ? `http://${targetIp}` : `http://${targetIp}:${port}`;
    log(`Starting health probes for ${targetUrl}...`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await new Promise(r => setTimeout(r, delayMs));
      const res = await this.pingUrl(targetUrl);

      if (res.healthy) {
        log(`Probe ${attempt}/${maxRetries}: SUCCESS! HTTP ${res.statusCode} in ${res.latencyMs}ms. Service is healthy.`);
        db.updateDeploymentStatus(deploymentId, 'ready', {
          logs: `\n[Health Check] Verified live at ${targetUrl} (HTTP ${res.statusCode}, latency: ${res.latencyMs}ms)`
        });
        return { success: true, statusCode: res.statusCode, latencyMs: res.latencyMs, url: targetUrl };
      } else {
        log(`Probe ${attempt}/${maxRetries}: Pending response (${res.error || `HTTP ${res.statusCode}`}). Retrying...`);
      }
    }

    log(`Health check timed out after ${maxRetries * (delayMs / 1000)}s. Container may still be compiling or installing dependencies.`);
    db.updateDeploymentStatus(deploymentId, 'failed', {
      error_message: `Public health check timed out for ${targetUrl} after ${maxRetries * (delayMs / 1000)} seconds.`
    });
    return { success: false, url: targetUrl };
  },

  /**
   * Reconcile reachability without destroying deployment history. A failed
   * probe is recorded as degraded and can recover to ready later.
   */
  async pruneUnreachableDeployments(workspaceId = null) {
    const deployments = db.getDeployments(workspaceId);
    const candidates = deployments.filter(d => ['ready', 'degraded'].includes(d.status));

    await Promise.all(candidates.map(async (deployment) => {
      const createdAt = deployment.created_at ? new Date(`${deployment.created_at.replace(' ', 'T')}Z`).getTime() : NaN;
      const ageMs = Date.now() - createdAt;
      if (Number.isFinite(ageMs) && ageMs < 10 * 60 * 1000) return;

      if (!deployment.vm_ip) {
        db.updateDeploymentStatus(deployment.id, 'degraded', {
          error_message: 'Deployment has no recorded VM address; record retained for investigation.',
          logs: '\n[Health Monitor] VM address is missing; retaining deployment record.'
        });
        return;
      }

      const result = await this.pingUrl(`http://${deployment.vm_ip}`, 2000);
      if (result.healthy) {
        this.failedProbes.delete(deployment.id);
        if (deployment.status === 'degraded') {
          db.updateDeploymentStatus(deployment.id, 'ready', {
            error_message: '',
            logs: '\n[Health Monitor] Service recovered and is reachable again.'
          });
        }
        return;
      }

      const failures = (this.failedProbes.get(deployment.id) || 0) + 1;
      if (failures >= 2) {
        console.warn(`[Health Monitor] Marking deployment #${deployment.id} degraded; retaining record.`);
        db.updateDeploymentStatus(deployment.id, 'degraded', {
          error_message: `Health probe failed: ${result.error || `HTTP ${result.statusCode}`}`,
          logs: `\n[Health Monitor] Service is unreachable; deployment record retained. (${result.error || `HTTP ${result.statusCode}`})`
        });
        this.failedProbes.set(deployment.id, 0);
      } else {
        this.failedProbes.set(deployment.id, failures);
      }
    }));
  }
};
