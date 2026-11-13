/**
 * Devlups Lab — Automated Health Check & Self-Healing Service
 * Monitors deployed instances, verifies HTTP status, and handles auto-recovery.
 */

import http from 'http';
import { db } from './db.js';

export const healthService = {
  /**
   * Ping an IP / URL to check if web service is responding
   */
  async pingUrl(url, timeoutMs = 5000) {
    const startTime = Date.now();
    return new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
          const latency = Date.now() - startTime;
          const isHealthy = res.statusCode >= 200 && res.statusCode < 400;
          resolve({
            healthy: isHealthy,
            statusCode: res.statusCode,
            latencyMs: latency,
            url
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
  async verifyDeploymentHealth(deploymentId, targetIp, port = 80, maxRetries = 15, delayMs = 6000) {
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
    return { success: false, url: targetUrl };
  }
};

