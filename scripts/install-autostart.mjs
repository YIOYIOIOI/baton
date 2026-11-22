#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BATON_DIR } from '../src/config.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LABEL = 'dev.baton.daemon';

function assertSafeValue(name, val) {
  const s = String(val ?? '');
  if (!s || /[\r\n\0]/.test(s)) {
    throw new Error(`Invalid ${name}: control characters are not allowed.`);
  }
  return s;
}

function assertSafeHost(host) {
  const s = assertSafeValue('host', host);
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(s)) {
    throw new Error(`Invalid host syntax: ${s}`);
  }
  return s;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function systemdQuote(s) {
  return `"${String(s).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildStartArgs({ port = null, host = null, readOnly = false } = {}) {
  const args = ['start'];
  if (port != null) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid port: ${port}`);
    args.push('--port', String(p));
  }
  if (host) args.push('--host', assertSafeHost(host));
  if (readOnly) args.push('--read-only');
  return args;
}

export function buildLaunchdPlist({
  nodePath = process.execPath,
  cliPath = path.join(REPO_ROOT, 'src', 'cli.js'),
  workDir = REPO_ROOT,
  dataDir = path.resolve(BATON_DIR),
  logDir = path.posix.join(dataDir, 'logs'),
  port = null,
  host = null,
  readOnly = false,
} = {}) {
  const safeNode = assertSafeValue('nodePath', nodePath);
  const safeCli = assertSafeValue('cliPath', cliPath);
  const safeWork = assertSafeValue('workDir', workDir);
  const safeLog = assertSafeValue('logDir', logDir);
  const argv = [safeNode, safeCli, ...buildStartArgs({ port, host, readOnly })];
  const programArgs = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(safeWork)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>BATON_DIR</key>',
    `    <string>${xmlEscape(assertSafeValue('dataDir', dataDir))}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(path.posix.join(safeLog, 'baton.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(path.posix.join(safeLog, 'baton.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function buildSystemdUnit({
  nodePath = process.execPath,
  cliPath = path.join(REPO_ROOT, 'src', 'cli.js'),
  workDir = REPO_ROOT,
  dataDir = path.resolve(BATON_DIR),
  port = null,
  host = null,
  readOnly = false,
} = {}) {
  const safeNode = assertSafeValue('nodePath', nodePath);
  const safeCli = assertSafeValue('cliPath', cliPath);
  const safeWork = assertSafeValue('workDir', workDir);
  const argv = [safeNode, safeCli, ...buildStartArgs({ port, host, readOnly })]
    .map((arg) => systemdQuote(arg.replaceAll('$', () => '$$')))
    .join(' ');
  return [
    '[Unit]',
    'Description=Baton Remote AI Coding Daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${safeWork.replaceAll('%', '%%')}`,
    `Environment=${systemdQuote('BATON_DIR=' + assertSafeValue('dataDir', dataDir))}`,
    `ExecStart=${argv}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function buildWindowsStartupScript({
  scriptPath = path.join(REPO_ROOT, 'scripts', 'start-daemon.ps1'),
  port = null,
  host = null,
  readOnly = false,
} = {}) {
  const rawScript = assertSafeValue('scriptPath', scriptPath);
  if (/["&|<>^!%`]/.test(rawScript)) {
    throw new Error('Invalid scriptPath: shell metacharacters are not allowed.');
  }
  // Validate port, host, and readOnly uniformly via buildStartArgs.
  buildStartArgs({ port, host, readOnly });
  const psArgs = [];
  if (port != null) psArgs.push(`-Port ${Number(port)}`);
  if (host) psArgs.push(`-HostAddr ${assertSafeHost(host)}`);
  if (readOnly) psArgs.push('-ReadOnly');
  const tail = psArgs.length ? ` ${psArgs.join(' ')}` : '';
  return [
    '@echo off',
    'setlocal',
    `pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${rawScript}"${tail}`,
    '',
  ].join('\r\n');
}

export function targetPathForPlatform(platform, home = os.homedir(), appData = process.env.APPDATA || '') {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }
  if (platform === 'linux') {
    return path.join(home, '.config', 'systemd', 'user', 'baton.service');
  }
  if (platform === 'win32') {
    const base = appData || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Baton.cmd');
  }
  throw new Error(`Unsupported platform for autostart: ${platform}`);
}

export function parseAutostartArgs(argv) {
  let platform = process.platform;
  let dryRun = false;
  let uninstall = false;
  let port = null;
  let host = null;
  let readOnly = false;
  let outDir = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--uninstall') uninstall = true;
    else if (a === '--read-only') readOnly = true;
    else if (a === '--platform' && argv[i + 1]) { platform = argv[++i]; }
    else if (a === '--port' && argv[i + 1]) { port = Number(argv[++i]); }
    else if (a === '--host' && argv[i + 1]) { host = argv[++i]; }
    else if (a === '--dir' && argv[i + 1]) { outDir = argv[++i]; }
    else if (a === '--help' || a === '-h') return { help: true };
    else throw new Error(`Unknown option: ${a}`);
  }
  return { help: false, platform, dryRun, uninstall, port, host, readOnly, outDir };
}

export function installAutostart(opts) {
  const { platform, dryRun = false, uninstall = false, port = null, host = null, readOnly = false, outDir = null } = opts;
  const target = outDir
    ? path.join(outDir, path.basename(targetPathForPlatform(platform)))
    : targetPathForPlatform(platform);

  if (uninstall) {
    if (dryRun) return { action: 'uninstall', target, content: null, dryRun: true };
    if (platform === 'darwin' && !outDir) {
      try { execFileSync('launchctl', ['unload', target], { stdio: 'ignore' }); } catch { /* not loaded */ }
    } else if (platform === 'linux' && !outDir) {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', 'baton.service'], { stdio: 'ignore' }); } catch { /* not loaded */ }
    }
    fs.rmSync(target, { force: true });
    return { action: 'uninstall', target, content: null, dryRun: false };
  }

  let content;
  if (platform === 'darwin') content = buildLaunchdPlist({ port, host, readOnly });
  else if (platform === 'linux') content = buildSystemdUnit({ port, host, readOnly });
  else if (platform === 'win32') content = buildWindowsStartupScript({ port, host, readOnly });
  else throw new Error(`Unsupported platform: ${platform}`);

  if (dryRun) return { action: 'install', target, content, dryRun: true };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (platform === 'darwin') {
    fs.mkdirSync(path.join(BATON_DIR, 'logs'), { recursive: true });
  }
  fs.writeFileSync(target, content, 'utf8');

  if (platform === 'darwin' && !outDir) {
    try { execFileSync('launchctl', ['load', '-w', target], { stdio: 'ignore' }); } catch { /* caller may load manually */ }
  } else if (platform === 'linux' && !outDir) {
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'baton.service'], { stdio: 'ignore' });
    } catch {
      /* systemd user session may not be active in container */
    }
  }
  return { action: 'install', target, content, dryRun: false };
}

function main() {
  const opts = parseAutostartArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/install-autostart.mjs [--platform win32|darwin|linux] [--port N] [--host ADDR] [--read-only] [--dry-run] [--uninstall]');
    return;
  }
  const res = installAutostart(opts);
  if (res.dryRun) {
    console.log(`[dry-run] target: ${res.target}`);
    if (res.content) {
      console.log('---');
      console.log(res.content);
    }
  } else {
    console.log(`${res.action === 'uninstall' ? 'Removed' : 'Installed'} autostart: ${res.target}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
