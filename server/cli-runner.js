/** Runs a CLI with an argument array (no shell, so secrets are never shell-quoted). */
import { execFile } from 'child_process';

export function runCli(cmd, args, { env = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') return reject(new Error(`The ${cmd} CLI is not installed on the Deployment Server host.`));
        return reject(new Error((stderr || error.message).trim()));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
