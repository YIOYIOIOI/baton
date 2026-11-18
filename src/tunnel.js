import { spawn } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

/** Extract the assigned Cloudflare Quick Tunnel URL from cloudflared output. */
export function parseTunnelUrl(text) {
  const m = URL_RE.exec(String(text ?? ''));
  return m ? m[0] : null;
}

function installHint(platform = process.platform) {
  if (platform === 'win32') return 'Install cloudflared: winget install --id Cloudflare.cloudflared';
  if (platform === 'darwin') return 'Install cloudflared: brew install cloudflared';
  return 'Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

/**
 * Start a temporary Cloudflare Quick Tunnel (`trycloudflare.com`) pointing at a local HTTP target.
 * Resolves with `{ url, stop }` once the tunnel URL is published on stderr/stdout.
 * @param {{ targetUrl: string, spawnFn?: typeof spawn, timeoutMs?: number }} opts
 * @returns {Promise<{ url: string, stop: () => void }>}
 */
export function startQuickTunnel({ targetUrl, spawnFn = spawn, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--url', targetUrl, '--no-autoupdate'];
    const child = spawnFn('cloudflared', args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let buf = '';
    const stop = () => {
      try {
        child.kill?.('SIGTERM');
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error('cloudflared Quick Tunnel timed out waiting for a public URL. Check outbound internet access and try again.'));
    }, timeoutMs);
    timer.unref?.();

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(err);
    };

    const onChunk = (chunk) => {
      if (settled) return;
      buf += String(chunk);
      if (buf.length > 32_768) buf = buf.slice(-16_384);
      const url = parseTunnelUrl(buf);
      if (url) {
        settled = true;
        clearTimeout(timer);
        resolve({ url, stop });
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') {
        finishErr(new Error(`cloudflared binary not found in PATH. ${installHint()}`));
      } else {
        finishErr(new Error(`Failed to launch cloudflared: ${err?.message || err}`));
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        finishErr(new Error(`cloudflared exited unexpectedly (code ${code ?? 'unknown'}) before publishing a tunnel URL.`));
      }
    });
  });
}
