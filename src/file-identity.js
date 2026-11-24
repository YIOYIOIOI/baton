import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_PENDING_CHECKS = 24;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_WINDOWS_FALLBACKS = 2;
const busy = () => Object.assign(new Error('文件校验繁忙。'), { code: 'FILE_CHECK_BUSY' });
const unavailable = () => Object.assign(new Error('系统无法核实文件句柄。'), { code: 'FILE_CHECK_UNAVAILABLE' });

const windowsScript = fileURLToPath(new URL('windows-file-identity.ps1', import.meta.url));
const windowsArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsScript];
const windowsOptions = {
  cwd: path.dirname(windowsScript), windowsHide: true,
  env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' },
};

/** Only the host's explicitly selected executable is eligible. Do not search PATH. */
export function windowsFilePwsh(env = process.env) {
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  const selected = env.BATON_PWSH7 ?? path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  const absolute = /^[A-Za-z]:\\|^\\\\(?![.?]\\)[^\\]+\\[^\\]+\\/.test(selected);
  if (!absolute || path.win32.normalize(selected) !== selected
    || path.win32.basename(selected).toLowerCase() !== 'pwsh.exe'
    || Array.from(selected).some((c) => c.charCodeAt(0) < 32)) {
    return { path: null, present: false, file: null };
  }
  try {
    const real = fs.realpathSync.native(selected);
    const file = path.win32.basename(real).toLowerCase() === 'pwsh.exe' && fs.statSync(real).isFile() ? real : null;
    return { path: selected, present: true, file };
  } catch {
    return { path: selected, present: false, file: null };
  }
}

// Windows has no /proc/self/fd. The helper verifies a second live handle's
// kernel path and file ID. The caller keeps the first fd open until IDs match.
// One helper handles thumbnail bursts without starting PowerShell for each file.
let windowsWorker;
let windowsRetryAt = 0;
function windowsIdentity(full, info, pwsh) {
  if (windowsWorker && windowsWorker.pwsh !== pwsh) windowsWorker.stop();
  if (Date.now() < windowsRetryAt) throw unavailable();
  if (!windowsWorker) {
    const child = spawn(pwsh, windowsArgs, { ...windowsOptions, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = [];
    let timer;
    const stop = () => {
      clearTimeout(timer);
      if (windowsWorker?.child === child) windowsWorker = null;
      child.kill();
      if (pending.length) windowsRetryAt = Date.now() + 1000;
      for (const job of pending.splice(0)) job.reject(unavailable());
    };
    function schedule() {
      clearTimeout(timer);
      const active = pending.length > 0;
      const method = active ? 'ref' : 'unref';
      child[method]();
      for (const pipe of [child.stdout, child.stdin]) if (pipe instanceof Socket) pipe[method]();
      timer = setTimeout(stop, active ? Math.max(1, pending[0].deadline - Date.now()) : 30_000);
      if (!active) timer.unref();
    }
    const replies = createInterface({ input: child.stdout });
    replies.on('error', stop);
    replies.on('line', (line) => {
      const job = pending.shift();
      if (!job) { stop(); return; }
      if (line === '?') job.resolve(null);
      else job.resolve(line === job.expected);
      schedule();
    });
    child.once('error', stop);
    child.once('close', stop);
    child.stdin.on('error', stop);
    windowsWorker = {
      child, pwsh, stop,
      check(name, expected) {
        return new Promise((resolve, reject) => {
          pending.push({ expected, resolve, reject, deadline: Date.now() + CHECK_TIMEOUT_MS });
          if (pending.length === 1) schedule();
          child.stdin.write(Buffer.from(path.toNamespacedPath(name)).toString('base64') + '\n');
        });
      },
    };
  }
  return windowsWorker.check(full, String(info.dev) + ' ' + String(info.ino));
}

let windowsChecks = 0;
let windowsFallbacks = 0;
const waitingFallbacks = [];

function acquireFallback(deadline) {
  if (windowsFallbacks < MAX_WINDOWS_FALLBACKS) { windowsFallbacks++; return; }
  return new Promise((resolve, reject) => {
    const grant = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      waitingFallbacks.splice(waitingFallbacks.indexOf(grant), 1);
      reject(unavailable());
    }, Math.max(1, deadline - Date.now()));
    waitingFallbacks.push(grant);
  });
}

async function windowsPath(fd, full, info) {
  if (windowsChecks >= MAX_PENDING_CHECKS) throw busy();
  windowsChecks++;
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  try {
    const pwsh = windowsFilePwsh().file;
    if (!pwsh) throw unavailable();
    if (info) {
      const same = await windowsIdentity(full, info, pwsh);
      if (same !== null) return same;
    }
    await acquireFallback(deadline);
    try {
      return await inheritedPath(fd, path.toNamespacedPath(full), pwsh, [...windowsArgs, '-InheritedHandle'],
        128 * 1024, deadline, windowsOptions);
    } finally {
      const next = waitingFallbacks.shift();
      if (next) next();
      else windowsFallbacks--;
    }
  } finally {
    windowsChecks--;
  }
}

// macOS fcntl(F_GETPATH) operates on the actual fd inherited as stdin.
const darwinCheck = String.raw`
use strict;
my $path = "\0" x 1024;
defined(fcntl(STDIN, 50, $path)) or exit 1;
$path =~ s/\0.*\z//s;
binmode STDOUT;
print STDOUT $path;
`;
let darwinChecks = 0;
async function darwinPath(fd, expected) {
  if (darwinChecks >= MAX_PENDING_CHECKS) throw busy();
  darwinChecks++;
  try {
    return await inheritedPath(fd, expected, '/usr/bin/perl', ['-T', '-e', darwinCheck], 1024, Date.now() + CHECK_TIMEOUT_MS);
  } finally {
    darwinChecks--;
  }
}

function inheritedPath(fd, expected, command, args, maxBytes, deadline, options = {}) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw unavailable();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: [fd, 'pipe', 'ignore'], timeout, killSignal: 'SIGKILL' });
    const bytes = [];
    let length = 0;
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length <= maxBytes) bytes.push(chunk);
      else child.kill();
    });
    child.stdout.once('error', () => { child.kill(); reject(unavailable()); });
    child.once('error', () => reject(unavailable()));
    child.once('close', (code) => {
      if (code !== 0) reject(unavailable());
      else resolve(length <= maxBytes && Buffer.concat(bytes).toString() === expected);
    });
  });
}

export async function matchesHandlePath(fd, full, info) {
  if (process.platform === 'linux') {
    try { return fs.readlinkSync('/proc/self/fd/' + fd) === full; }
    catch { throw unavailable(); }
  }
  if (process.platform === 'win32') return windowsPath(fd, full, info);
  if (process.platform === 'darwin') return darwinPath(fd, full);
  throw unavailable();
}
