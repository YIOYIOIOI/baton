import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLaunch } from './codexRuntime.js';
import { agyLaunch, withAgyEnv } from './agy.js';
import { antigravityModelSupportsEffort, assertModel, isEffort } from './args.js';
import { BATON_DIR } from '../config.js';
import { getMode, isMode, modeFlags } from '../permission.js';
import { effectiveEffort, getDefaultEffort, getEffort, getModel } from '../runtime/prefs.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const WIN_START_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$utf8 = [Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $utf8',
  '[Console]::OutputEncoding = $utf8',
  'try {',
  '  $cfg = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '  Start-Process -FilePath $cfg.filePath -WorkingDirectory $cfg.cwd -ArgumentList $cfg.argString',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

const NESTED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_HOST_SESSION_ID',
];
const NESTED_SESSION_ENV = new Set(NESTED_SESSION_VARS);

/** Typed error for local terminal launches so HTTP handlers can return actionable messages. */
export class TerminalLaunchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} fix
   * @param {number} [status]
   */
  constructor(code, message, fix, status = 400) {
    super(message);
    this.name = 'TerminalLaunchError';
    this.code = code;
    this.fix = fix;
    this.status = status;
  }
}

/** Whether a string contains ASCII control characters (0x00–0x1F or 0x7F). */
export function hasControlChars(value) {
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function envGet(env, name) {
  if (!env || typeof env !== 'object') return undefined;
  const target = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === target) return v;
  }
  return undefined;
}

function decodeAntigravityKeyRel(key) {
  if (typeof key !== 'string' || !key.startsWith('antigravity:')) return '';
  try {
    return Buffer.from(key.slice('antigravity:'.length), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Identify which Antigravity product owns a session record.
 * Anchors strictly to the `<product>/brain/` segment (using the last match) so an
 * unrelated ancestor directory named `antigravity-cli` cannot misclassify a desktop session.
 */
export function detectAntigravityProduct(member) {
  const candidates = [
    typeof member?.relPath === 'string' ? member.relPath : '',
    decodeAntigravityKeyRel(member?.key),
    typeof member?.file === 'string' ? member.file : '',
  ];
  const re = /(?:^|[\\/])(antigravity-cli|antigravity-ide|antigravity)[\\/]brain[\\/]/g;
  for (const raw of candidates) {
    if (!raw) continue;
    let last = null;
    for (const m of raw.matchAll(re)) last = m[1];
    if (last) return last;
  }
  return 'antigravity';
}

/** Verify a session working directory is a true absolute path (rejecting relative and Win32 root-relative paths). */
export function isAbsoluteSessionCwd(cwd, platform = process.platform) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;
  if (hasControlChars(cwd)) return false;
  if (platform === 'win32') {
    return path.win32.isAbsolute(cwd) && path.win32.parse(cwd).root.length > 1;
  }
  return path.posix.isAbsolute(cwd);
}

/**
 * Whether this session can be resumed in an interactive local CLI terminal.
 * Claude Code, Codex, and Antigravity CLI (`agy`) support direct terminal resume;
 * Antigravity Desktop / IDE sessions are managed by the GUI app rather than `agy`.
 */
export function supportsLocalTerminal(member, platform = process.platform) {
  if (!member || !isAbsoluteSessionCwd(member.cwd, platform)) return false;
  if (typeof member.providerId !== 'string' || !UUID.test(member.providerId)) return false;
  if (member.agent === 'claude' || member.agent === 'codex') return true;
  if (member.agent === 'antigravity') return detectAntigravityProduct(member) === 'antigravity-cli';
  return false;
}

function appliedInteractiveEffort(agent, effort, model) {
  if (!isEffort(effort)) return null;
  if (agent === 'codex') return effort;
  if (effort === 'ultra') return null;
  if (agent === 'claude') return effort;
  if (agent === 'antigravity') return antigravityModelSupportsEffort(model) ? effort : null;
  return null;
}

function interactiveEffortFlags(agent, effort, model) {
  const applied = appliedInteractiveEffort(agent, effort, model);
  if (!applied) return [];
  if (agent === 'codex') return ['-c', `model_reasoning_effort=${applied}`];
  return ['--effort', applied];
}

/**
 * Build the strict allowlisted CLI name and interactive resume argv for a session,
 * carrying over Baton's permission mode, model, and reasoning effort settings.
 * @param {any} member
 * @param {{ permissionMode?: string, model?: string | null, effort?: string | null }} [settings]
 */
export function buildInteractiveAgentCommand(member, { permissionMode = 'default', model = null, effort = null } = {}) {
  if (!member || typeof member.providerId !== 'string' || !UUID.test(member.providerId)) {
    throw new TerminalLaunchError(
      'invalid_session_id',
      '会话标识格式无效，无法在本地终端恢复。',
      '返回会话列表刷新后重试。',
      400,
    );
  }
  let safeModel = null;
  try {
    safeModel = assertModel(model);
    if (safeModel?.startsWith('-')) {
      throw new Error(`拒绝以短横线开头的模型名：${JSON.stringify(safeModel)}`);
    }
  } catch (err) {
    throw new TerminalLaunchError(
      'invalid_model',
      err?.message || '会话模型名称无效，无法传给本地终端。',
      '在 Baton 中重新选择有效模型或切回默认模型后重试。',
      400,
    );
  }
  const sessionId = member.providerId;
  const appliedEffort = appliedInteractiveEffort(member.agent, effort, safeModel);
  const effortArgs = interactiveEffortFlags(member.agent, appliedEffort, safeModel);
  if (member.agent === 'claude') {
    const args = ['--resume', sessionId];
    if (safeModel) args.push('--model', safeModel);
    args.push(...modeFlags('claude', permissionMode));
    args.push(...effortArgs);
    return { cli: 'claude', args, sessionId, model: safeModel, effort: appliedEffort };
  }
  if (member.agent === 'codex') {
    const args = ['resume'];
    if (safeModel) args.push('--model', safeModel);
    args.push(...modeFlags('codex', permissionMode));
    args.push(...effortArgs);
    args.push(sessionId);
    return { cli: 'codex', args, sessionId, model: safeModel, effort: appliedEffort };
  }
  if (member.agent === 'antigravity') {
    if (detectAntigravityProduct(member) !== 'antigravity-cli') {
      throw new TerminalLaunchError(
        'unsupported_terminal_session',
        '该 Antigravity 会话属于桌面端或 IDE，agy 命令行暂不支持在终端中直接恢复它。',
        '请在 Antigravity 桌面端或 IDE 中打开该会话；由 agy CLI 创建的会话支持直接打开本地终端。',
        400,
      );
    }
    const args = ['--conversation', sessionId];
    if (safeModel) args.push('--model', safeModel);
    args.push(...modeFlags('antigravity', permissionMode));
    args.push(...effortArgs);
    return { cli: 'agy', args, sessionId, model: safeModel, effort: appliedEffort };
  }
  throw new TerminalLaunchError(
    'unsupported_terminal_session',
    `暂不支持为 ${String(member.agent ?? '未知')} 会话打开本地终端。`,
    '目前支持 Claude Code、Codex 与 Antigravity CLI 会话。',
    400,
  );
}

/** Strip control characters, separators, and leading dashes from a terminal title. */
export function sanitizeTerminalTitle(member, cwd) {
  const fallback = `${member?.agent ?? 'baton'} · ${path.basename(cwd) || cwd}`;
  const raw = typeof member?.title === 'string' && member.title.trim() ? member.title : fallback;
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === ';') cleaned += ' ';
    else cleaned += ch;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim().replace(/^-+/, '').trim();
  return (collapsed || fallback).slice(0, 64);
}

/** Quote one argument according to Win32 CommandLineToArgvW rules. */
export function win32QuoteArg(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    if (slashes) {
      out += '\\'.repeat(slashes);
      slashes = 0;
    }
    out += ch;
  }
  if (slashes) out += '\\'.repeat(slashes * 2);
  return out + '"';
}

/** Strict POSIX single-quote escaping for macOS Terminal.app AppleScript `do script`. */
export function posixQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Remove parent nested-session markers so an interactive CLI can start cleanly. */
export function cleanTerminalEnv(env = process.env, agent = null, home = os.homedir()) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) continue;
    if (NESTED_SESSION_ENV.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return agent === 'antigravity' ? withAgyEnv(out, { home }) : out;
}

function ordinaryWindowsPath(file) {
  return String(file).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, '');
}

/** Locate PowerShell 7 (`pwsh.exe`) or built-in Windows PowerShell (`powershell.exe`). */
export function findWindowsPowerShell({ env = process.env, fsOps = fs } = {}) {
  const prog = envGet(env, 'ProgramW6432') || envGet(env, 'ProgramFiles');
  const sysRoot = envGet(env, 'SystemRoot') || 'C:\\Windows';
  const candidates = [
    ...(prog ? [path.win32.join(prog, 'PowerShell', '7', 'pwsh.exe')] : []),
    path.win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fsOps.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try fallback
    }
  }
  return candidates.at(-1);
}

function isInsidePosixDir(target, workspace) {
  if (!workspace || workspace === '/') return false;
  return target === workspace || target.startsWith(workspace + '/');
}

/**
 * Locate an executable on POSIX PATH / standard user bin directories outside the session workspace.
 * Checks both the directory entry and the symlink target against `cwd`, and returns the directory
 * entry path (preserving `argv[0]` for Snap / Volta multi-call symlinks).
 */
export function findPosixBinary(name, {
  env = process.env,
  cwd = null,
  home = os.homedir(),
  execDir = path.posix.dirname(process.execPath),
  fsOps = fs,
} = {}) {
  const realCwd = (() => {
    if (!cwd) return null;
    try { return fsOps.realpathSync.native(cwd); } catch { return null; }
  })();
  const searchDirs = [
    ...String(env?.PATH ?? '').split(':').filter(Boolean),
    ...(execDir && execDir.startsWith('/') ? [execDir] : []),
    ...(home ? [path.posix.join(home, '.local', 'bin')] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const seen = new Set();
  for (const dir of searchDirs) {
    if (!dir || !dir.startsWith('/') || seen.has(dir)) continue;
    seen.add(dir);
    let realDir;
    try {
      realDir = fsOps.realpathSync.native(dir);
    } catch {
      continue;
    }
    if (isInsidePosixDir(realDir, realCwd)) continue;
    const entry = path.posix.join(realDir, name);
    try {
      const target = fsOps.realpathSync.native(entry);
      if (isInsidePosixDir(target, realCwd)) continue;
      if (!fsOps.statSync(target).isFile()) continue;
      fsOps.accessSync(target, fs.constants.X_OK);
      return entry;
    } catch {
      // Not present or not executable
    }
  }
  return null;
}

const LINUX_TERMINALS = [
  { name: 'ghostty', args: (cwd, _title, cmd) => [`--working-directory=${cwd}`, '-e', ...cmd] },
  { name: 'kitty', args: (cwd, title, cmd) => ['--directory', cwd, `--title=${title}`, ...cmd] },
  { name: 'alacritty', args: (cwd, title, cmd) => ['--working-directory', cwd, `--title=${title}`, '-e', ...cmd] },
  { name: 'wezterm', args: (cwd, _title, cmd) => ['start', '--cwd', cwd, '--', ...cmd] },
  { name: 'gnome-terminal', args: (cwd, title, cmd) => [`--working-directory=${cwd}`, `--title=${title}`, '--', ...cmd] },
  { name: 'konsole', args: (cwd, _title, cmd) => ['--workdir', cwd, '-e', ...cmd] },
  { name: 'xfce4-terminal', args: (cwd, title, cmd) => [`--working-directory=${cwd}`, `--title=${title}`, '-x', ...cmd] },
  { name: 'x-terminal-emulator', args: (_cwd, _title, cmd) => ['-e', ...cmd] },
  { name: 'xterm', args: (_cwd, title, cmd) => ['-T', title, '-e', ...cmd] },
];

/** Locate the first available Linux GUI terminal emulator. */
export function findLinuxTerminal({ env = process.env, cwd = null, home = os.homedir(), fsOps = fs } = {}) {
  for (const spec of LINUX_TERMINALS) {
    const bin = findPosixBinary(spec.name, { env, cwd, home, fsOps });
    if (bin) return { ...spec, bin };
  }
  return null;
}

/** Verify the session working directory exists on disk and return its canonical path. */
export function resolveSessionCwd(cwd, fsOps = fs, platform = process.platform) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new TerminalLaunchError(
      'missing_cwd',
      '这个会话没有记录工作目录，无法在本地终端打开。',
      '请先确认该会话包含有效的工作目录。',
      400,
    );
  }
  if (hasControlChars(cwd)) {
    throw new TerminalLaunchError(
      'invalid_cwd',
      '会话的工作目录路径包含控制字符，无法安全在本地终端打开。',
      '请检查该会话目录名称后重试。',
      400,
    );
  }
  if (!isAbsoluteSessionCwd(cwd, platform)) {
    throw new TerminalLaunchError(
      'invalid_cwd',
      '会话的工作目录不是有效的绝对路径，无法在本地终端打开。',
      '请确认该会话记录了完整的绝对工作目录路径。',
      400,
    );
  }
  try {
    const real = fsOps.realpathSync.native(cwd);
    const normalized = platform === 'win32' ? ordinaryWindowsPath(real) : real;
    if (hasControlChars(normalized)) {
      throw new TerminalLaunchError(
        'invalid_cwd',
        '会话的真实工作目录路径包含控制字符，无法安全在本地终端打开。',
        '请检查该会话目录名称后重试。',
        400,
      );
    }
    if (!fsOps.statSync(normalized).isDirectory()) {
      throw new Error('not a directory');
    }
    return normalized;
  } catch (err) {
    if (err instanceof TerminalLaunchError) throw err;
    throw new TerminalLaunchError(
      'missing_cwd',
      `会话的工作目录已不存在或无法访问：${cwd}`,
      '确认该目录未被移动、删除或卸载后重试。',
      400,
    );
  }
}

/**
 * Resolve the host binary for `claude`, `codex`, or `agy` outside the session workspace.
 * @param {string} cli
 * @param {{ cwd?: string | null, env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform }} [opts]
 */
export async function resolveInteractiveBinary(cli, {
  cwd = null, env = process.env, home = os.homedir(), platform = process.platform,
} = {}) {
  if (cli === 'agy') {
    const launch = agyLaunch({ cwd, env, home });
    if (!launch?.file) {
      throw new TerminalLaunchError(
        'cli_not_found',
        '本机未找到 agy 命令行工具。',
        '安装 agy CLI 并将其加入 PATH（或设置 AGY_BIN）后重试。',
        503,
      );
    }
    return { executable: launch.file, env: launch.env };
  }

  if (platform === 'win32') {
    try {
      const launch = await cliLaunch(cli, env, false, cwd);
      const raw = launch.file ?? launch.command;
      const executable = typeof raw === 'string' ? raw.replace(/^"(.*)"$/, '$1') : '';
      if (!executable || executable === cli) {
        throw new Error(`找不到 ${cli}`);
      }
      return { executable, env: launch.env ?? env };
    } catch (err) {
      throw new TerminalLaunchError(
        'cli_not_found',
        `本机未找到 ${cli} 命令行工具。`,
        err?.message || `请确认已安装 ${cli} 并将其目录加入系统 PATH 后重试。`,
        503,
      );
    }
  }

  const bin = findPosixBinary(cli, { env, cwd, home });
  if (!bin) {
    throw new TerminalLaunchError(
      'cli_not_found',
      `本机未找到 ${cli} 命令行工具。`,
      `请确认已安装 ${cli} 并将其目录加入 PATH（如 ~/.local/bin、/opt/homebrew/bin 或 /usr/local/bin）后重试。`,
      503,
    );
  }
  return { executable: bin, env };
}

function buildDarwinShellCommand({ cwd, executable, agentArgs, agent, env }) {
  if (hasControlChars(cwd) || hasControlChars(executable) || agentArgs.some(hasControlChars)) {
    throw new TerminalLaunchError(
      'invalid_terminal_args',
      '会话路径或命令包含控制字符，无法安全传给 macOS 终端。',
      '请检查工作目录和 CLI 安装路径后重试。',
      400,
    );
  }
  const envArgs = [];
  for (const name of NESTED_SESSION_VARS) {
    envArgs.push('-u', name);
  }
  if (agent === 'antigravity') {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      const val = env?.[key];
      if (typeof val === 'string' && val && !hasControlChars(val)) {
        envArgs.push(`${key}=${val}`);
      }
    }
  }
  const invoke = ['env', ...envArgs, executable, ...agentArgs].map(posixQuote).join(' ');
  return `cd -- ${posixQuote(cwd)} && ${invoke}`;
}

/**
 * Pure planner producing the OS-specific terminal spawn specification.
 * - Windows: invokes PowerShell `Start-Process` with a UTF-8 JSON payload on stdin
 *   so paths with spaces/Unicode/semicolons need zero shell interpolation. Windows 11
 *   routes console apps launched via `Start-Process` into the user's default terminal
 *   (Windows Terminal by default) while preserving the cleaned environment variables.
 * - macOS: resolves `osascript` outside `cwd`, invokes `on run argv` with strict
 *   POSIX single-quoting and control-character rejection, and clears nested-session
 *   env vars inside the opened shell.
 * - Linux: launches the first available desktop terminal emulator with `shell: false`.
 */
export function buildTerminalLaunchSpec({
  platform = process.platform,
  cwd,
  executable,
  agentArgs,
  agent = null,
  title,
  env = process.env,
  home = os.homedir(),
  findWinPowerShell = findWindowsPowerShell,
  findLinTerminal = findLinuxTerminal,
  findPosixBin = findPosixBinary,
}) {
  if (platform === 'win32') {
    const psExe = findWinPowerShell({ env });
    const argString = agentArgs.map(win32QuoteArg).join(' ');
    return {
      terminal: 'windows-terminal',
      command: psExe,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-Command',
        WIN_START_PROCESS_SCRIPT,
      ],
      stdin: JSON.stringify({ filePath: executable, cwd, argString }),
      options: {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      },
      waitForExit: true,
    };
  }

  if (platform === 'darwin') {
    const shellCmd = buildDarwinShellCommand({ cwd, executable, agentArgs, agent, env });
    const osascript = findPosixBin('osascript', { env, cwd, home }) ?? '/usr/bin/osascript';
    return {
      terminal: 'Terminal.app',
      command: osascript,
      args: [
        '-e', 'on run argv',
        '-e', 'tell application "Terminal"',
        '-e', 'activate',
        '-e', 'do script (item 1 of argv)',
        '-e', 'end tell',
        '-e', 'end run',
        '--',
        shellCmd,
      ],
      stdin: null,
      options: {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
      waitForExit: true,
    };
  }

  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      throw new TerminalLaunchError(
        'terminal_unavailable',
        '当前主机未检测到图形桌面环境（缺少 DISPLAY / WAYLAND_DISPLAY），无法弹出本地终端窗口。',
        '请在带桌面环境的本地登录会话中运行 Baton 后重试。',
        503,
      );
    }
    const term = findLinTerminal({ env, cwd, home });
    if (!term) {
      throw new TerminalLaunchError(
        'terminal_unavailable',
        '未在 PATH 中找到可用的本地终端模拟器。',
        '请安装 ghostty、kitty、alacritty、wezterm、gnome-terminal、konsole、xfce4-terminal 或 xterm 后重试。',
        503,
      );
    }
    return {
      terminal: term.name,
      command: term.bin,
      args: term.args(cwd, title, [executable, ...agentArgs]),
      stdin: null,
      options: {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: 'ignore',
      },
      waitForExit: false,
    };
  }

  throw new TerminalLaunchError(
    'terminal_unavailable',
    `暂不支持在当前系统（${platform}）上直接打开本地终端。`,
    '目前支持 Windows、macOS 与 Linux 桌面环境。',
    503,
  );
}

function runTerminalSpec(spec, spawnFn = spawn, graceMs = 150) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(spec.command, spec.args, spec.options);
    } catch (err) {
      reject(new TerminalLaunchError(
        'terminal_launch_failed',
        `拉起本地终端失败：${err?.message ?? err}`,
        '检查本机终端程序是否正常安装并可执行。',
        500,
      ));
      return;
    }

    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    if (spec.waitForExit) {
      const errChunks = [];
      let errBytes = 0;
      child.stderr?.on('data', (chunk) => {
        if (errBytes < 16_384) {
          errChunks.push(chunk);
          errBytes += chunk.length;
        }
      });
      child.stdin?.on('error', () => {});
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(reject, new TerminalLaunchError(
          'terminal_launch_failed',
          `拉起 ${spec.terminal} 超时。`,
          '检查系统终端或自动化权限设置后重试。',
          500,
        ));
      }, 10_000);
      timer.unref?.();

      child.once('error', (err) => {
        clearTimeout(timer);
        finish(reject, new TerminalLaunchError(
          'terminal_launch_failed',
          `拉起 ${spec.terminal} 失败：${err.message}`,
          '确认本机终端程序可用后重试。',
          500,
        ));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          finish(resolve, { terminal: spec.terminal });
          return;
        }
        const detail = Buffer.concat(errChunks).toString('utf8').trim();
        finish(reject, new TerminalLaunchError(
          'terminal_launch_failed',
          `拉起 ${spec.terminal} 失败（退出码 ${code}）${detail ? `：${detail}` : ''}。`,
          '检查终端应用与系统权限设置后重试。',
          500,
        ));
      });
      if (typeof spec.stdin === 'string') {
        child.stdin?.end(spec.stdin, 'utf8');
      }
      return;
    }

    let graceTimer = null;
    const onError = (err) => {
      if (graceTimer) clearTimeout(graceTimer);
      child.off?.('close', onClose);
      finish(reject, new TerminalLaunchError(
        'terminal_launch_failed',
        `拉起 ${spec.terminal} 失败：${err.message}`,
        '检查终端程序是否存在且有执行权限后重试。',
        500,
      ));
    };
    const onClose = (code, signal) => {
      if (graceTimer) clearTimeout(graceTimer);
      child.off?.('error', onError);
      if (code === 0 && !signal) {
        finish(resolve, { terminal: spec.terminal });
      } else {
        const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
        finish(reject, new TerminalLaunchError(
          'terminal_launch_failed',
          `${spec.terminal} 启动后立即退出（${reason}）。`,
          '检查系统终端配置及 CLI 安装状态后重试。',
          500,
        ));
      }
    };
    child.once('error', onError);
    child.once('close', onClose);
    child.once('spawn', () => {
      graceTimer = setTimeout(() => {
        child.off?.('error', onError);
        child.off?.('close', onClose);
        child.unref?.();
        finish(resolve, { terminal: spec.terminal });
      }, graceMs);
      graceTimer.unref?.();
    });
  });
}

/**
 * Open a local interactive terminal window resuming the given Baton session,
 * preserving Baton's current permission mode, model, and effort settings.
 * @param {{
 *   member: { agent: string, providerId: string, cwd?: string | null, title?: string | null, file?: string, relPath?: string, key?: string },
 *   batonDir?: string,
 *   permissionMode?: string,
 *   model?: string | null,
 *   effort?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   platform?: NodeJS.Platform,
 *   spawnFn?: typeof spawn,
 *   resolveBinary?: typeof resolveInteractiveBinary,
 *   resolveCwd?: typeof resolveSessionCwd,
 *   findWinPowerShell?: typeof findWindowsPowerShell,
 *   findLinTerminal?: typeof findLinuxTerminal,
 *   findPosixBin?: typeof findPosixBinary,
 *   graceMs?: number,
 * }} opts
 */
export async function launchLocalTerminal({
  member,
  batonDir = BATON_DIR,
  permissionMode = undefined,
  model = undefined,
  effort = undefined,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  spawnFn = spawn,
  resolveBinary = resolveInteractiveBinary,
  resolveCwd = resolveSessionCwd,
  findWinPowerShell = findWindowsPowerShell,
  findLinTerminal = findLinuxTerminal,
  findPosixBin = findPosixBinary,
  graceMs = 150,
}) {
  const rawPermission = permissionMode !== undefined
    ? permissionMode
    : getMode(member?.agent, { dir: batonDir });
  const effectivePermission = isMode(member?.agent, rawPermission) ? rawPermission : 'default';
  const rawModel = model !== undefined
    ? model
    : (member?.key ? getModel(member.key, { dir: batonDir }) : null);
  const normalizedModel = rawModel === '' ? null : rawModel;
  const savedEffort = member?.key ? getEffort(member.key, { dir: batonDir }) : null;
  const validSavedEffort = isEffort(savedEffort) ? savedEffort : null;
  const rawEffort = effort !== undefined
    ? effort
    : effectiveEffort({
      model: normalizedModel,
      effort: validSavedEffort,
      fallback: getDefaultEffort(member?.agent, { dir: batonDir }),
    });
  const {
    cli, args: agentArgs, sessionId, model: appliedModel, effort: appliedEffort,
  } = buildInteractiveAgentCommand(member, {
    permissionMode: effectivePermission,
    model: normalizedModel,
    effort: rawEffort,
  });
  const cwd = resolveCwd(member.cwd, fs, platform);
  const baseEnv = cleanTerminalEnv(env, member.agent, home);
  const { executable, env: resolvedEnv } = await resolveBinary(cli, { cwd, env: baseEnv, home, platform });
  const title = sanitizeTerminalTitle(member, cwd);
  const spec = buildTerminalLaunchSpec({
    platform,
    cwd,
    executable,
    agentArgs,
    agent: member.agent,
    title,
    env: resolvedEnv,
    home,
    findWinPowerShell,
    findLinTerminal,
    findPosixBin,
  });
  const launched = await runTerminalSpec(spec, spawnFn, graceMs);
  return {
    ok: true,
    terminal: launched.terminal,
    agent: member.agent,
    cwd,
    sessionId,
    permissionMode: effectivePermission,
    model: appliedModel,
    effort: appliedEffort,
  };
}
