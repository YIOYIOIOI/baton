import { spawn } from 'node:child_process';
import { killChildTree } from './spawn.js';

/**
 * 起一个 `codex app-server`，按顺序调几个方法，拿到结果就收掉。
 *
 * 和 codexQueue.js / commands.js 的 listCodexSkills 同一套启动与收尾：Windows 上 codex 是 .cmd，
 * 必须经 shell；收的时候按平台清理整棵进程树（win32 用 taskkill /t，POSIX 用负 pid 杀组）。
 * `initialize` 带 `experimentalApi: true`——目标、队列这些方法都是 experimental 的。
 *
 * @param {Array<{ method: string, params?: object }>} calls
 * @returns {Promise<Array<any>>} 每个调用的 result；任何一个回错误就抛
 */
export function codexRpc(calls, {
  command = 'codex', timeoutMs = 30_000, spawnFn = spawn, killTreeFn = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, ['app-server'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    const NL = String.fromCharCode(10);
    let buf = '';
    let settled = false;
    const results = [];
    let at = -1;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end?.();
      } catch {
        // ignore
      }
      try {
        if (killTreeFn) killTreeFn(child.pid, child);
        else killChildTree(child);
      } catch {
        // 已经退了
      }
      if (err) reject(err);
      else resolve(results);
    };
    const timer = setTimeout(() => finish(new Error('codex 没在时限内回话')), timeoutMs);
    timer.unref?.();
    child.stdin?.on?.('error', (e) => finish(e));
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}${NL}`);
    const next = () => {
      at += 1;
      if (at >= calls.length) return finish(null);
      send({ id: 100 + at, method: calls[at].method, params: calls[at].params ?? {} });
      return undefined;
    };
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`codex app-server 提前退出了（${code}）`)));
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) {
        finish(new Error('codex app-server 输出超过上限'));
        return;
      }
      let i;
      while ((i = buf.indexOf(NL)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          next();
        } else if (m.id === 100 + at) {
          if (m.error) {
            finish(new Error(m.error.message ?? `${calls[at].method} 失败`));
            return;
          }
          results.push(m.result);
          next();
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'baton', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}
