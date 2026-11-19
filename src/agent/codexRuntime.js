import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const probe = fileURLToPath(new URL('../../scripts/codex-runtime.ps1', import.meta.url));

async function readWindowsRuntime(env, managed) {
  if (process.env.BATON_NO_CLI_PROBES === '1') return { desktop: null, variables: {} };
  const pwsh = path.join(process.env.ProgramW6432 || process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe];
  if (managed) args.push('-LoginEnvironment');
  const { stdout } = await exec(pwsh, args, { env, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
  return JSON.parse(stdout);
}

export async function codexRuntime(env = process.env, { platform = process.platform, readWindows = readWindowsRuntime } = {}) {
  const fallback = { command: 'codex', shell: platform === 'win32', env };
  if (platform !== 'win32') return fallback;
  const managed = env.BATON_CODEX_LOGIN_ENV === '1';
  let snapshot;
  try {
    snapshot = await readWindows(env, managed);
  } catch {
    if (managed) throw new Error('无法读取 Windows 的 Codex 登录环境，请检查 PowerShell 7。');
    return fallback;
  }
  const command = snapshot.desktop || fallback.command;
  let childEnv = env;
  if (managed) {
    const names = new Set(Object.keys(snapshot.variables).map((name) => name.toUpperCase()));
    childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(OPENAI_|CODEX_)/i.test(name) && !names.has(name.toUpperCase())));
    for (const [name, value] of Object.entries(snapshot.variables)) {
      if (typeof value === 'string' && value) childEnv[name] = value;
    }
  }
  return { command, shell: !snapshot.desktop, env: childEnv };
}

export async function cliLaunch(command, env = process.env, shell = process.platform === 'win32') {
  if (command === 'codex') return codexRuntime(env);
  return { command: shell && /\s/.test(command) ? `"${command}"` : command, shell, env };
}

export function spawnCodexAppServer({ command, shell, env }, spawnFn = spawn) {
  return spawnFn(command, ['app-server'], {
    shell, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });
}
