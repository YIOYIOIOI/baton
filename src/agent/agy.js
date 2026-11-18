import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killChildTree } from './spawn.js';

/** 查找本机 `agy` CLI 可执行文件（`AGY_BIN`、常见安装目录与 `PATH`）。 */
export function findAgyBinary({ env = process.env } = {}) {
  const candidates = [];
  if (env.AGY_BIN) candidates.push(env.AGY_BIN);

  const localAppData = env.LOCALAPPDATA ?? '';
  if (process.platform === 'win32' && localAppData) {
    candidates.push(
      path.join(localAppData, 'agy', 'bin', 'agy.exe'),
      path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      path.join(localAppData, 'Programs', 'antigravity', 'bin', 'agy.cmd'),
    );
  } else {
    candidates.push('/usr/local/bin/agy', '/opt/homebrew/bin/agy');
  }

  const pathDirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
  for (const dir of pathDirs) {
    for (const exe of exts) candidates.push(path.join(dir, exe));
  }

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不在
    }
  }
  return null;
}

/** 读取 `agy` 出站所需代理：优先环境变量，缺失时复用 `~/.claude/settings.json` 的 `env.HTTPS_PROXY`。 */
export function agyProxy({ home = os.homedir(), env = process.env } = {}) {
  const direct = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (direct) return String(direct);
  try {
    const cfgDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const s = JSON.parse(fs.readFileSync(path.join(cfgDir, 'settings.json'), 'utf8'))?.env ?? {};
    const v = s.HTTPS_PROXY ?? s.https_proxy ?? s.HTTP_PROXY ?? s.http_proxy;
    if (v) return String(v);
  } catch {
    // 忽略读取失败
  }
  return null;
}

/** 当进程环境未带代理时补齐 `HTTPS_PROXY`/`HTTP_PROXY`，确保守护进程子进程能访问云端接口。 */
export function withAgyEnv(env = process.env, { home = os.homedir() } = {}) {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) return env;
  const p = agyProxy({ home, env });
  return p ? { ...env, HTTPS_PROXY: p, HTTP_PROXY: p } : env;
}

/**
 * 执行短命 `agy` CLI 命令（如 `--print=/usage` 或 `models`），带独立超时树杀与输出上限。
 * @param {string[]} args
 * @param {{ agyBin?: string|null, env?: NodeJS.ProcessEnv, home?: string, timeoutMs?: number, maxBuffer?: number, input?: string }} [opts]
 */
export function execAgy(args, {
  agyBin = null, env = process.env, home = os.homedir(), timeoutMs = 15_000, maxBuffer = 8 * 1024 * 1024, input = '',
} = {}) {
  const bin = agyBin ?? findAgyBinary({ env });
  if (!bin) return Promise.resolve({ code: -1, stdout: '', stderr: '未找到 agy 可执行文件' });

  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const cmd = useShell && /\s/.test(bin) ? `"${bin}"` : bin;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: withAgyEnv(env, { home }),
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    const out = [];
    const err = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const append = (list) => (d) => {
      if (settled) return;
      totalBytes += d.length;
      if (totalBytes > maxBuffer) {
        killChildTree(child);
        finish({ code: -1, stdout: '', stderr: 'agy 输出超过上限' });
        return;
      }
      list.push(d);
    };

    const timer = setTimeout(() => {
      killChildTree(child);
      finish({
        code: null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: `${Buffer.concat(err).toString('utf8')}\nagy 执行超时（${timeoutMs}ms）`.trim(),
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', append(out));
    child.stderr?.on('data', append(err));
    child.on('error', (e) => {
      finish({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: e.message });
    });
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });

    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '', 'utf8');
  });
}
