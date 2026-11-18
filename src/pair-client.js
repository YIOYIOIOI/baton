import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BATON_DIR, loadConfig } from './config.js';
import { encode, toSvg } from './qr.js';
import { pickLanIp, formatHttpUrl } from './lan.js';
import { parsePairArgs } from './pairargs.js';
import { loadPrincipals } from './principals.js';

function openFile(file) {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [file], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref();
  } catch {
    // Non-fatal if default image viewer is unavailable.
  }
}

/**
 * Request a one-time pairing code from a running Baton daemon and emit a local QR SVG.
 * @param {string[]} argv
 * @param {{ batonDir?: string, openQr?: boolean, host?: string | null, port?: number | null }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runPairCommand(argv = [], { batonDir = BATON_DIR, openQr = true, host = null, port = null } = {}) {
  const parsed = parsePairArgs(argv);
  if (parsed.ok === false) {
    console.error(`\n  ${parsed.error}\n  ${parsed.fix}\n`);
    return 1;
  }

  const config = loadConfig({ dir: batonDir });
  const targetHost = host || config.host;
  const targetPort = port ?? config.port;
  const connectHost = targetHost === '0.0.0.0' || targetHost === '::' ? '127.0.0.1' : targetHost;
  const tokenFile = path.join(batonDir, 'token');
  let token;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    console.error(`Cannot read ${tokenFile}. Start Baton once with \`baton start\` first.`);
    return 1;
  }

  const forId = parsed.for;
  const url = `${formatHttpUrl(connectHost, targetPort)}/api/pair/new`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(forId ? { for: forId } : {}),
    });
  } catch {
    console.error(`Cannot reach ${url}. Is Baton running? Run \`baton start\` or check config.json.`);
    return 1;
  }

  if (!res.ok) {
    /** @type {any} */
    const body = await res.json().catch(() => null);
    console.error(`Pairing code failed (HTTP ${res.status}): ${body?.error?.message ?? ''} ${body?.error?.fix ?? ''}`);
    return 1;
  }

  const { code, for: pairedWith } = /** @type {{ code: string, for: string }} */ (await res.json());
  const origin = config.publicUrl
    ? { url: String(config.publicUrl).replace(/\/+$/, ''), how: 'publicUrl' }
    : (() => {
      const ip = pickLanIp(os.networkInterfaces());
      return ip ? { url: formatHttpUrl(ip, targetPort), how: 'lan' } : null;
    })();

  console.log('');
  if (origin) {
    const link = `${origin.url}/pair?c=${code}`;
    const qrFile = path.join(batonDir, 'pairing-qr.svg');
    fs.writeFileSync(qrFile, toSvg(encode(link), { quiet: 4, scale: 20 }), { encoding: 'utf8', mode: 0o600 });
    console.log(`  QR SVG   ${qrFile}`);
    console.log(`  URL      ${link}`);
    if (openQr) openFile(qrFile);
    if (origin.how === 'lan') {
      console.log(`  (LAN/Tailscale address — set "publicUrl" in ${path.join(batonDir, 'config.json')} for public URLs)`);
    }
    console.log('');
  }

  if (pairedWith && pairedWith !== 'owner') {
    const root = loadPrincipals().principals.find((p) => p.id === pairedWith)?.roots?.[0];
    console.log(`  ▸ Guest code for ${pairedWith} (scoped to ${root ?? 'workspace root'})`);
  } else {
    console.log('  ⚠ OWNER pairing code — grants full access to your workspaces.');
    console.log('    For a restricted guest, run: baton pair --for <principal-id>');
  }
  console.log('');
  console.log(`  Code     ${code}`);
  console.log('  Expires  10 minutes (single use)');
  console.log('');
  return 0;
}
