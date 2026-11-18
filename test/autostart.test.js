import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsStartupScript,
  installAutostart,
  targetPathForPlatform,
} from '../scripts/install-autostart.mjs';
import { tmpDir } from './helpers.js';

test('buildLaunchdPlist escapes XML and emits valid launchd structure', () => {
  const plist = buildLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    cliPath: '/Users/alice/baton&co/src/cli.js',
    workDir: '/Users/alice/baton&co',
    logDir: '/Users/alice/.baton/logs',
    port: 4000,
    host: '127.0.0.1',
    readOnly: true,
  });
  assert.match(plist, /<key>Label<\/key>/);
  assert.match(plist, /dev\.baton\.daemon/);
  assert.match(plist, /baton&amp;co/);
  assert.match(plist, /<string>--port<\/string>\s*<string>4000<\/string>/);
  assert.match(plist, /<string>--read-only<\/string>/);
});

test('buildSystemdUnit quotes paths safely and enables restart', () => {
  const unit = buildSystemdUnit({
    nodePath: '/usr/bin/node',
    cliPath: '/home/alice/my repo/src/cli.js',
    workDir: '/home/alice/my repo',
    port: 3002,
  });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/alice\/my repo\/src\/cli\.js" "start" "--port" "3002"/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('buildWindowsStartupScript targets start-daemon.ps1 safely', () => {
  const cmd = buildWindowsStartupScript({
    scriptPath: 'C:\\tools\\baton\\scripts\\start-daemon.ps1',
    port: 3002,
    readOnly: true,
  });
  assert.match(cmd, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden/);
  assert.match(cmd, /start-daemon\.ps1/);
  assert.match(cmd, /-Port 3002/);
  assert.match(cmd, /-ReadOnly/);
});

test('rejects unsafe control characters or out-of-range ports', () => {
  assert.throws(() => buildSystemdUnit({ host: '127.0.0.1\nExecStart=/bin/sh' }));
  assert.throws(() => buildLaunchdPlist({ port: 99999 }));
});

test('dry-run and isolated directory install/uninstall do not touch real host startup dirs', () => {
  const dry = installAutostart({ platform: 'darwin', dryRun: true, port: 3005 });
  assert.equal(dry.dryRun, true);
  assert.match(dry.content, /3005/);

  const dir = tmpDir('autostart-');
  const installed = installAutostart({ platform: 'linux', outDir: dir, port: 3009 });
  assert.equal(fs.existsSync(installed.target), true);
  assert.match(fs.readFileSync(installed.target, 'utf8'), /3009/);

  const removed = installAutostart({ platform: 'linux', outDir: dir, uninstall: true });
  assert.equal(removed.action, 'uninstall');
  assert.equal(fs.existsSync(installed.target), false);
});

test('targetPathForPlatform computes expected paths for all 3 OSes', () => {
  assert.match(targetPathForPlatform('darwin', '/Users/alice'), /Library[\\/]LaunchAgents[\\/]dev\.baton\.daemon\.plist$/);
  assert.match(targetPathForPlatform('linux', '/home/alice'), /\.config[\\/]systemd[\\/]user[\\/]baton\.service$/);
  assert.equal(
    targetPathForPlatform('win32', 'C:\\Users\\alice', 'C:\\Users\\alice\\AppData\\Roaming'),
    path.join('C:\\Users\\alice\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Baton.cmd'),
  );
});
