import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { currentInstanceId } from './instance.js';

const exec = promisify(execFile);
let bootId;

// Linux's start ticks are monotonic within one boot. Include its boot UUID so
// a reused PID and tick count on a later boot are also distinguishable.
export function linuxProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    bootId ??= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { group: Number(fields[2]), state: fields[0], birth: `linux:${bootId}:${fields[19]}` };
  } catch { return null; }
}

function identityCommand(pid) {
  if (process.platform === 'win32') {
    const command = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    // Same native creation timestamp as scripts/windows-supervision.ps1. The PID is a validated integer.
    const script = `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${pid}); try { [Console]::Write($p.StartTime.ToUniversalTime().Ticks) } finally { $p.Dispose() }`;
    return { command, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return { command: '/bin/ps', args: ['-p', String(pid), '-o', 'lstart='] };
}

const options = { encoding: /** @type {const} */ ('utf8'), windowsHide: true, timeout: 5000, maxBuffer: 4096 };
function identityFrom(stdout) {
  const value = stdout.trim();
  return value && (process.platform !== 'win32' || /^\d+$/.test(value)) ? process.platform + ':' + value : null;
}

export function processBirth(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxProcess(pid)?.birth ?? null;
  try {
    const { command, args } = identityCommand(pid);
    return identityFrom(execFileSync(command, args, { ...options, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

async function birthAtLaunch(pid) {
  if (process.platform === 'linux') return linuxProcess(pid)?.birth ?? null;
  const { command, args } = identityCommand(pid);
  try { return identityFrom((await exec(command, args, { ...options, env: { ...process.env, LC_ALL: 'C' } })).stdout); } catch { return null; }
}

// Recovery starts conservatively, then samples known survivors without blocking the
// HTTP event loop on a PowerShell/ps process per orphan every timer tick.
export function recoveryBirthLookup() {
  if (process.platform === 'linux') return processBirth;
  const observations = new Map();
  let probing = 0;
  return (pid) => {
    const entry = observations.get(pid) ?? { value: null, next: 0 };
    if (probing < 3 && entry.next <= Date.now()) {
      observations.set(pid, entry);
      entry.next = Infinity;
      probing++;
      void birthAtLaunch(pid).then((value) => { entry.value = value; }).finally(() => {
        entry.next = Date.now() + 3000;
        probing--;
      });
    }
    return entry.value;
  };
}

// Register before or after spawn. The new-session handler can land later and still
// claim the exact same worker. The launch path waits for bind() before sending a prompt.
export function workerIdentity() {
  let listener;
  let pid;
  let birth;
  return {
    observe(next) { listener = next; if (pid) next(pid, birth); },
    async bind(child) {
      const childPid = child?.pid;
      if (!Number.isInteger(childPid) || childPid <= 0) return;
      if (currentInstanceId()) {
        birth = await birthAtLaunch(childPid);
        if (!birth) throw new Error('系统未能确认新进程的创建时间。');
      }
      if (child.exitCode != null || child.signalCode != null) throw new Error('登记运行身份前，原子进程已经退出。');
      pid = childPid;
      listener?.(pid, birth);
    },
  };
}
