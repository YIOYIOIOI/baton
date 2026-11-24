import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
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

// Windows 的裸命令会先在工作目录里找。目录由会话选择，安装路径只能来自宿主的绝对 PATH。
function ordinaryPath(file) {
  return file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, '');
}

function windowsAgentLaunch(name, env, cwd, preferred = [], searchPath = true) {
  let physicalCwd;
  try { physicalCwd = ordinaryPath(fs.realpathSync.native(cwd)); } catch { return null; }
  const workspaces = [ordinaryPath(path.resolve(cwd)), physicalCwd];
  const insideWorkspace = (file, isFile = false) => workspaces.some((workspace) => {
    const rel = path.relative(workspace, file);
    if (!rel) return true;
    // 在盘符根启动会话时，仍允许使用安装在该卷的程序。
    const below = rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    return below && (workspace !== path.parse(workspace).root || (isFile && !rel.includes(path.sep)));
  });
  const absolute = (file) => /^(?:[a-z]:[\\/]|\\\\(?![?.][\\/])[^\\/]+[\\/][^\\/]+)/i.test(file);
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const dirs = [];
  for (const entry of (env[pathKey] ?? '').split(';')) {
    const dir = ordinaryPath(entry.trim().replace(/^"(.*)"$/, '$1'));
    // '\bin' 和 'C:bin' 都依赖当前目录或盘符。
    if (!absolute(dir) || insideWorkspace(dir)) continue;
    try {
      const real = ordinaryPath(fs.realpathSync.native(dir));
      if (!insideWorkspace(real) && !real.includes(';') && !dirs.includes(real)) dirs.push(real);
    } catch {
      // PATH 里已经卸载的目录。
    }
  }

  const candidates = [...preferred];
  if (searchPath) {
    for (const dir of dirs) {
      for (const ext of ['.exe', '.cmd', '.bat']) candidates.push(path.join(dir, name + ext));
    }
  }
  for (const entry of candidates) {
    if (!entry) continue;
    const candidate = ordinaryPath(entry);
    if (!absolute(candidate) || insideWorkspace(candidate, true)) continue;
    let file;
    try {
      file = ordinaryPath(fs.realpathSync.native(candidate));
      if (insideWorkspace(file, true) || !fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    if (/\.exe$/i.test(file)) return { file, command: file, shell: false, env };
    if (!/\.(?:cmd|bat)$/i.test(file) || /[%!]/.test(file)) continue;
    // A batch shim may launch another program by name. Exclude the session directory from that lookup too.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PATH|NoDefaultCurrentDirectoryInExePath)$/i.test(key)));
    childEnv.PATH = dirs.join(';');
    childEnv.NoDefaultCurrentDirectoryInExePath = '1';
    return { file, command: '"' + file + '"', shell: path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), env: childEnv };
  }
  return null;
}

export function windowsAgyLaunch(env, cwd, explicit = undefined) {
  if (explicit !== undefined) return windowsAgentLaunch('agy', env, cwd, [explicit], false);
  const preferred = [env.AGY_BIN];
  if (env.LOCALAPPDATA) preferred.push(
    path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    path.join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
    path.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'bin', 'agy.cmd'),
  );
  return windowsAgentLaunch('agy', env, cwd, preferred);
}

function requiredWindowsAgent(name, env, cwd, explicit = undefined) {
  const launch = name === 'agy' ? windowsAgyLaunch(env, cwd, explicit) : windowsAgentLaunch(name, env, cwd);
  if (launch) return launch;
  throw new Error('在宿主的绝对 PATH 中找不到 ' + name + '。请将 CLI 的安装目录加入 PATH 并重启 Baton。');
}

export async function cliLaunch(command, env = process.env, shell = process.platform === 'win32', cwd = undefined) {
  if (command === 'codex') {
    const runtime = await codexRuntime(env);
    if (process.platform === 'win32' && cwd && runtime.shell) return requiredWindowsAgent(command, runtime.env, cwd);
    return runtime;
  }
  if (process.platform === 'win32' && (command === 'claude' || command === 'agy')) return requiredWindowsAgent(command, env, cwd ?? process.cwd());
  if (process.platform === 'win32' && /^agy\.(exe|cmd|bat)$/i.test(path.basename(command))) {
    return requiredWindowsAgent('agy', env, cwd ?? process.cwd(), command);
  }
  return { command: shell && /\s/.test(command) ? `"${command}"` : command, shell, env };
}

export function spawnCodexAppServer({ command, shell, env }, spawnFn = spawn) {
  return spawnFn(command, ['app-server'], {
    shell, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });
}
