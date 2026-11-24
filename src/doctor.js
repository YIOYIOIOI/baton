import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BATON_DIR, loadConfig } from './config.js';
import { runBuffered } from './agent/spawn.js';
import { agyLaunch } from './agent/agy.js';
import { windowsFilePwsh } from './file-identity.js';
import { claudeLoggedIn, claudeConfigDir } from './agent/preflight.js';
import { pickNetworkAddresses } from './lan.js';
import { VERSION } from './version.js';

async function probeBinary(cmd, runtime = null) {
  try {
    const r = await runBuffered(cmd, ['--version'], { timeoutMs: 3000, runtime });
    if (r.code !== 0) return { ok: false, version: null };
    const line = String(r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || '';
    return { ok: true, version: line || 'installed' };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * Inspect local runtime readiness for running Baton and its supported agent CLIs.
 * Never mutates host state or connects to live agents.
 * @param {{ batonDir?: string, home?: string, env?: NodeJS.ProcessEnv, config?: any,
 *   interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>, checkCmd?: (cmd: string, runtime?: ReturnType<typeof agyLaunch>) => Promise<{ ok: boolean, version: string | null }> }} [opts]
 */
export async function runDoctor({
  batonDir = BATON_DIR,
  home = os.homedir(),
  env = process.env,
  config = loadConfig({ dir: batonDir }),
  interfaces = os.networkInterfaces(),
  checkCmd = probeBinary,
} = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  let hasSqlite = false;
  try {
    await import('node:sqlite');
    hasSqlite = true;
  } catch {
    hasSqlite = false;
  }
  checks.push({
    id: 'node',
    status: major >= 24 && hasSqlite ? 'ok' : 'fail',
    detail: `Node ${process.version} (node:sqlite: ${hasSqlite ? 'available' : 'missing'})`,
    fix: major >= 24 ? null : 'Install Node.js 24+ (required for built-in node:sqlite and TS type stripping).',
  });

  const configPath = path.join(batonDir, 'config.json');
  const tokenPath = path.join(batonDir, 'token');
  checks.push({
    id: 'state',
    status: fs.existsSync(batonDir) ? 'ok' : 'warn',
    detail: `${batonDir} (config: ${fs.existsSync(configPath) ? 'present' : 'defaults'}, token: ${fs.existsSync(tokenPath) ? 'present' : 'generated on start'})`,
    fix: null,
  });

  const webDist = fs.existsSync(new URL('../web/dist/index.html', import.meta.url));
  const appDist = fs.existsSync(new URL('../app/dist/index.html', import.meta.url));
  checks.push({
    id: 'bundles',
    status: webDist || appDist ? 'ok' : 'warn',
    detail: `web/dist: ${webDist ? 'built' : 'missing'}, app/dist: ${appDist ? 'built' : 'missing'}`,
    fix: webDist && appDist ? null : 'Run `npm run web:build` and/or `npm run build:web` to serve the modern web/mobile UIs.',
  });

  if (process.platform === 'win32') {
    const pwsh = windowsFilePwsh(env);
    const location = pwsh.path ?? 'Invalid BATON_PWSH7';
    const availability = pwsh.file ? 'present' : (pwsh.present ? 'present, invalid executable' : 'missing or unavailable');
    checks.push({
      id: 'file-verifier', status: pwsh.file ? 'ok' : 'warn',
      detail: `${location} (${availability}) for GET /api/sessions/:key/file and GET /api/sessions/:key/upload`,
      fix: pwsh.file ? null : 'Install PowerShell 7 or set BATON_PWSH7 to the canonical absolute path of a trusted pwsh.exe, then restart Baton.',
    });
  }

  const agy = agyLaunch({ env, home });
  for (const cmd of ['claude', 'codex', 'agy', 'cloudflared']) {
    const runtime = cmd === 'agy' ? agy : null;
    const res = cmd === 'agy' && !runtime ? { ok: false, version: null } : await checkCmd(runtime?.file ?? cmd, runtime);
    checks.push({
      id: `cli:${cmd}`,
      status: res.ok ? 'ok' : 'warn',
      detail: res.ok ? `${cmd} (${res.version})` : `${cmd} not found in PATH`,
      fix: res.ok ? null : (cmd === 'cloudflared'
        ? 'Optional for public access. See INSTALL.md for Quick Tunnel / Named Tunnel setup.'
        : `Install ${cmd} CLI if you want Baton to control ${cmd} sessions.`),
    });
  }

  const claudeReady = Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) || claudeLoggedIn(env, { home });
  const codexReady = fs.existsSync(path.join(home, '.codex', 'config.toml')) || fs.existsSync(path.join(home, '.codex', 'sessions'));
  const agyReady = Boolean(agy)
    || fs.existsSync(path.join(home, '.gemini', 'antigravity'))
    || fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'));
  const cfgDir = claudeConfigDir(env, home);
  checks.push({
    id: 'credentials',
    status: claudeReady || codexReady || agyReady ? 'ok' : 'warn',
    detail: `Claude auth (${cfgDir}): ${claudeReady ? 'ready' : 'not detected'}, Codex dir: ${codexReady ? 'present' : 'not detected'}, Antigravity: ${agyReady ? 'ready' : 'not detected'}`,
    fix: claudeReady || codexReady || agyReady ? null : 'Sign in with `claude` (/login), `codex`, or Antigravity, or set ANTHROPIC_AUTH_TOKEN.',
  });

  const network = pickNetworkAddresses(interfaces);
  checks.push({
    id: 'network',
    status: 'ok',
    detail: `LAN: ${network.lan ?? 'none'}, Tailscale: ${network.tailscale ?? 'none'}, publicUrl: ${config.publicUrl ?? 'unset'}`,
    fix: null,
  });

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    version: VERSION,
    platform: `${process.platform}/${process.arch}`,
    config: { host: config.host, port: config.port, allowSend: config.allowSend, publicUrl: config.publicUrl ?? null },
    network,
    checks,
  };
}
