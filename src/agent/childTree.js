import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { linuxProcess } from '../runtime/processIdentity.js';

// A detached child leads its own POSIX session and process group. Track birth identities
// before signalling, so a recycled numeric group ID cannot become an escalation target.
function groupMembers(group) {
  try {
    const members = new Map();
    if (process.platform === 'linux') {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const proc = linuxProcess(pid);
        if (proc?.group === group && proc.state !== 'Z') members.set(pid, proc.birth);
      }
      return members;
    }
    const output = execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', env: { LC_ALL: 'C' },
      timeout: 1000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!match || Number(match[2]) !== group || match[3].includes('Z')) continue;
      members.set(Number(match[1]), match[4].trim());
    }
    return members;
  } catch { return new Map(); }
}

export function makeChildTree(child, { platform = process.platform, graceMs = 1000,
  signal = process.kill.bind(process), members = groupMembers, spawnKiller = spawn, report = (message) => console.warn(message) } = {}) {
  const pid = child.pid;
  const validPid = Number.isInteger(pid) && pid > 0;
  const windows = platform === 'win32';
  let exited = child.exitCode != null || child.signalCode != null;
  let closed = false;
  let witnesses = new Map();
  let completion = null;
  let timer;
  let taskkillPending = false;
  let attempts = 0;

  function ownsGroup() {
    if (!validPid) return false;
    if (!exited && child.exitCode == null && child.signalCode == null) return true;
    const current = members(pid);
    if (current.has(pid)) return false; // 原组长已被收割；当前同号组长属于另一棵树。
    return [...witnesses].some(([member, birth]) => current.get(member) === birth);
  }
  function finishIfClosed() {
    if (!completion || !closed || taskkillPending || (!windows && ownsGroup())) return false;
    clearTimeout(timer);
    completion.resolve();
    return true;
  }
  child.once?.('exit', () => {
    exited = true;
    if (!windows && validPid && !completion) {
      // stop() 可能是下一个 exit 监听器。此时就固定原组中的存活成员；
      // 延到下一轮事件循环会丢掉组长已退出、但后代仍持有输出管道的情况。
      const survivors = members(pid);
      if (!survivors.has(pid)) witnesses = survivors;
    }
  });
  child.once?.('close', () => { closed = true; exited = true; finishIfClosed(); });

  function sendGroup(value) {
    if (!ownsGroup()) return;
    try { signal(-pid, value); } catch (err) {
      if (err.code !== 'ESRCH') report(`进程组 ${pid} 未能接收 ${value}（${err.code ?? err.message}）。`);
      if (!exited) {
        try { child.kill(value); } catch (error) { report(`子进程 ${pid} 未能接收 ${value}（${error.message}）。`); }
      }
    }
  }
  function windowsStop() {
    if (exited || child.exitCode != null || child.signalCode != null) {
      if (!closed) report(`进程 ${pid} 已退出，正在等待其输出管道关闭。`);
      finishIfClosed();
      return;
    }
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    attempts++;
    taskkillPending = true;
    let replied = false;
    const finished = (failure) => {
      if (replied) return;
      replied = true;
      taskkillPending = false;
      if (failure && !closed) {
        if (attempts <= 2) report(`终止进程树 ${pid} 的 taskkill 失败（${failure}），仍在等待进程退出。`);
        // 单独杀父进程会丢掉后代的树句柄，让未确认的工作继续运行。
        if (!exited) timer = setTimeout(windowsStop, attempts < 2 ? graceMs : Math.max(5000, graceMs));
        return;
      }
      finishIfClosed();
    };
    try {
      const killer = spawnKiller(cmd, ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 4000 });
      killer.once('error', (err) => finished(/** @type {NodeJS.ErrnoException} */ (err).code ?? err.message));
      killer.once('close', (code, sig) => finished(code === 0 ? null : `exit ${code ?? sig}`));
    } catch (err) { finished(err.code ?? err.message); }
  }

  return {
    stop() {
      if (completion || closed) return;
      completion = Promise.withResolvers();
      if (!validPid) {
        try { child.kill?.(); } catch (err) { report(`终止子进程失败（${err.message}）。`); }
        return;
      }
      if (windows) { windowsStop(); return; }
      if (!exited) witnesses = members(pid);
      sendGroup('SIGTERM');
      if (finishIfClosed()) return;
      timer = setTimeout(() => {
        sendGroup('SIGKILL');
        const confirm = () => {
          if (!finishIfClosed()) timer = setTimeout(confirm, 250);
        };
        confirm();
      }, graceMs);
    },
    wait() { return completion?.promise ?? Promise.resolve(); },
  };
}

const controls = new WeakMap();
export function childTree(child) {
  let control = controls.get(child);
  if (!control) { control = makeChildTree(child); controls.set(child, control); }
  return control;
}

export function killChildTree(child) {
  if (!child || (!controls.has(child) && (child.exitCode != null || child.signalCode != null))) return;
  childTree(child).stop();
}
