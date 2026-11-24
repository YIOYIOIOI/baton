import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const project = path.resolve(process.env.BATON_E2E_ROOT || path.join(import.meta.dirname, '../..'));

export async function eventually(check, timeout = 15000, label = 'condition') {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + label, { cause: lastError });
}

export async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  if (port === 3002) throw new Error('Refusing to use the production port.');
  return port;
}

export async function startHost(t, { guestCanSend = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-e2e-'));
  let child;
  let closed;
  async function stop() {
    const force = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('shutdown');
        else child.kill();
      }
      if (closed) await closed;
    } finally {
      clearTimeout(force);
    }
  }
  t.after(async () => {
    try { await stop(); }
    finally { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); }
  });
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const cwd = path.join(root, 'guest-workspace');
  const bin = path.join(root, 'bin');
  const transcriptDir = path.join(home, '.claude', 'projects', 'fixture');
  const accountData = path.join(home, 'AppData');
  for (const dir of [state, cwd, bin, transcriptDir, path.join(accountData, 'Local'), path.join(accountData, 'Roaming')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sessionId = crypto.randomUUID();
  const transcript = path.join(transcriptDir, sessionId + '.jsonl');
  const greeting = 'Baton E2E first message';
  const entry = { type: 'user', sessionId, uuid: crypto.randomUUID(), cwd, timestamp: new Date().toISOString(),
    message: { role: 'user', content: greeting } };
  fs.writeFileSync(transcript, JSON.stringify(entry) + '\n');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 });
  const port = await unusedPort();
  const base = 'http://127.0.0.1:' + port;
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ port, allowSend: true, workspacesRoot: cwd }));
  fs.writeFileSync(path.join(state, 'principals.json'), JSON.stringify({ guests: [{ id: 'reader', root: cwd, allowSend: guestCanSend }] }));
  const win = process.platform === 'win32';
  const shim = win ? '@echo off\r\n@"%BATON_E2E_NODE%" "%BATON_E2E_AGENT%" %*\r\n'
    : '#!/bin/sh\nexec "$BATON_E2E_NODE" "$BATON_E2E_AGENT" "$@"\n';
  fs.writeFileSync(path.join(bin, win ? 'claude.cmd' : 'claude'), shim, { mode: 0o755 });
  const env = {
    HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(accountData, 'Local'), APPDATA: path.join(accountData, 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'), BATON_DIR: state, BATON_NO_CLI_PROBES: '1',
    BATON_E2E_NODE: process.execPath, BATON_E2E_AGENT: path.join(import.meta.dirname, 'agent.mjs'),
    BATON_E2E_TRANSCRIPT: transcript, ANTHROPIC_AUTH_TOKEN: 'isolated-test',
    PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
    TEMP: root, TMP: root, TMPDIR: root,
  };
  for (const name of ['SystemRoot', 'ComSpec', 'ProgramFiles', 'ProgramW6432', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  async function launch() {
    const signalFixture = pathToFileURL(path.join(import.meta.dirname, '../fixtures/graceful-daemon-signal.mjs')).href;
    child = spawn(process.execPath, ['--import', signalFixture, path.join(project, 'src/cli.js'), 'start', '--port', String(port)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    closed = once(child, 'close');
    let banner = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { banner = (banner + chunk).slice(-8192); });
    child.stderr.resume();
    await eventually(() => child.exitCode === null && banner.includes('已启动'), 15000, 'isolated daemon startup');
  }
  await launch();
  async function request(route, { bearer = token, body, method, headers, signal } = {}) {
    const verb = method || (body === undefined ? 'GET' : 'POST');
    try {
      return await fetch(base + route, {
        method: verb,
        headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
          ...(body === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }), ...headers },
        body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10000),
      });
    } catch (cause) {
      throw new Error(`${verb} ${route.split('?')[0]} failed`, { cause });
    }
  }
  async function codeFor(id) {
    const res = await request('/api/pair/new', { body: { for: id } });
    if (!res.ok) throw new Error('Mint test pairing code: HTTP ' + res.status);
    return (await res.json()).code;
  }
  const response = await request('/api/sessions');
  if (!response.ok) throw new Error('List isolated sessions: HTTP ' + response.status);
  const member = (await response.json()).chains.flatMap((chain) => chain.members).find((m) => m.providerId === sessionId);
  if (!member) throw new Error('Fixture session missing from daemon.');
  async function restart() { await stop(); await launch(); }
  return { base, cwd, root, transcript, sessionId, greeting, key: member.key, request, codeFor, restart };
}
