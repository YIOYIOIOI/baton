import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpDir } from './helpers.js';
import { startTurn, listTurns, reconcileRunning, ownedProcessAlive } from '../src/runtime/turns.js';
import { sendMessage } from '../src/http/handlers/turns.js';
import { runProcess } from '../src/agent/spawn.js';
import { pidAlive } from '../src/runtime/live.js';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('two daemon CLI processes using separate ports share one directory lease and recover after its holder exits', { timeout: 18_000 }, async (t) => {
  const dir = tmpDir();
  const home = tmpDir();
  const env = { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home, BATON_DIR: dir, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: home, APPDATA: home, PATH: '', BATON_NO_CLI_PROBES: '1' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ allowSend: false, workspacesRoot: dir }));
  const active = new Set();
  t.after(async () => {
    await Promise.all([...active].map(async (p) => { const done = once(p, 'exit'); p.kill(); await done; }));
  });
  const start = (port) => {
    const p = spawn(process.execPath, ['src/cli.js', 'start', '--port', String(port), '--read-only'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(p);
    let buffer = '';
    const ready = Promise.withResolvers();
    p.stdout.on('data', (data) => { buffer += data; if (buffer.includes('已启动')) ready.resolve('started'); });
    p.stderr.resume();
    p.once('exit', () => { active.delete(p); ready.resolve('exited'); });
    return { p, result: ready.promise };
  };
  const firstPort = await unusedPort();
  let secondPort = await unusedPort();
  while (secondPort === firstPort) secondPort = await unusedPort();
  const first = start(firstPort);
  assert.equal(await first.result, 'started');
  const second = start(secondPort);
  assert.equal(await second.result, 'exited');
  assert.notEqual(second.p.exitCode, 0);
  const closed = once(first.p, 'exit');
  first.p.kill('SIGKILL');
  await closed;
  assert.equal(await start(secondPort).result, 'started');
});

test('graceful shutdown waits for its own runner and leaves the next queued item for recovery', async () => {
  const { acquireInstance, shutdownExecutions } = await import('../src/runtime/instance.js');
  const lease = acquireInstance(process.env.BATON_DIR);
  try {
    const key = 'claude:graceful-turn';
    const close = Promise.withResolvers();
    let kills = 0;
    const calls = [];
    const repo = { getSession: () => ({ key, agent: 'claude', providerId: 'g' }) };
    const opts = { repo, config: { allowSend: true }, key, live: () => new Map(), env: { ANTHROPIC_AUTH_TOKEN: 'fixture' }, audit: () => {},
      runner: async ({ onStart, message }) => {
        calls.push(message);
        onStart({ kill: () => { kills += 1; } });
        await close.promise;
        return { summary: { status: 'ok', eventCount: 1 } };
      } };
    await sendMessage({ ...opts, message: '先执行' });
    await sendMessage({ ...opts, message: '稍后执行' });
    const turn = listTurns(key)[0];
    assert.equal(turn.ownerId, lease.id);
    let ended = false;
    const stopping = shutdownExecutions().then(() => { ended = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ended, false);
    assert.equal(kills, 1);
    close.resolve();
    await stopping;
    assert.equal(listTurns(key)[0].status, 'aborted');
    assert.deepEqual(calls, ['先执行']);
  } finally { lease.release(); }
});

test('restart keeps recovered process and desktop ownership until each execution has a confirmed ending', () => {
  const dir = tmpDir();
  const processTurn = startTurn({ key: 'claude:recover', turnId: 'owned', agent: 'claude' }, { dir });
  const bridgeTurn = startTurn({ key: 'antigravity:recover', turnId: 'external', agent: 'antigravity' }, { dir });
  for (const [turn, fields] of [[processTurn, { childPid: 6789 }], [bridgeTurn, { canStop: false }]]) {
    const file = path.join(dir, 'runs', encodeURIComponent(turn.key), `${turn.turnId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...turn, ownerId: 'previous', ...fields }));
  }
  assert.deepEqual(reconcileRunning({ dir, alive: () => true, inspectMonitor: () => null }), []);
  assert.deepEqual(reconcileRunning({ dir, alive: () => false, inspectMonitor: () => ({ status: 'ok', eventCount: 1 }) }).map((r) => r.status).sort(), ['failed', 'ok']);
});

test('a recovered POSIX execution keeps its session while descendants still occupy its original group', () => {
  const signals = [];
  const probe = (pid, signal) => { signals.push([pid, signal]); if (pid > 0) throw Object.assign(new Error(), { code: 'ESRCH' }); };
  assert.equal(ownedProcessAlive(12345, { childGroup: 12345 }, { platform: 'linux', probe }), true);
  assert.deepEqual(signals, [[12345, 0], [-12345, 0]]);
});

test('recovery compares a recorded birth identity, preserves unknown legacy executions, and only observes processes', () => {
  const observed = [];
  const probe = (pid, signal) => { observed.push([pid, signal]); };
  const opts = { platform: 'win32', probe, birthOf: () => 'win32:new-creation-time' };
  assert.equal(ownedProcessAlive(24680, { childStarted: 'win32:previous-creation-time' }, opts), false);
  assert.equal(ownedProcessAlive(24680, { childStarted: 'win32:new-creation-time' }, opts), true);
  assert.equal(ownedProcessAlive(24680, {}, opts), true);
  assert.equal(ownedProcessAlive(24680, { childStarted: 'win32:new-creation-time' }, { ...opts, birthOf: () => null }), true);
  assert.deepEqual(observed, Array.from({ length: 4 }, () => [24680, 0]));
});

test('normal shutdown records the actual isolated Node worker PID and waits for it to exit', { timeout: 10_000 }, async (t) => {
  const { acquireInstance, shutdownExecutions } = await import('../src/runtime/instance.js');
  const lease = acquireInstance(process.env.BATON_DIR);
  const dir = tmpDir();
  const key = 'claude:real-worker';
  fs.writeFileSync(path.join(dir, 'ordinary-worker.cjs'), "process.stdin.resume(); process.stdin.on('end', () => console.log('ready')); setTimeout(() => {}, 8000);\n");
  const ready = Promise.withResolvers();
  let handle;
  let closed = false;
  t.after(() => { if (!closed) handle?.kill(); lease.release(); });
  const accepted = await sendMessage({ key, message: '执行普通工作', config: { allowSend: true }, repo: { getSession: () => ({ key, agent: 'claude', cwd: dir, providerId: 'worker' }) },
    env: { ANTHROPIC_AUTH_TOKEN: 'fixture' }, live: () => new Map(), audit: () => {},
    runner: async ({ onStart }) => {
      const result = await runProcess({ command: process.execPath, args: ['ordinary-worker.cjs'], cwd: dir,
        onStart: (h) => { handle = h; onStart(h); }, onLine: (line) => { if (line === 'ready') ready.resolve(); } });
      closed = true;
      ready.reject(new Error(result.stderr || 'worker closed before readiness'));
      return { summary: { status: 'ok', eventCount: 1 } };
    } });
  assert.equal(accepted.body.queued, false, JSON.stringify(accepted.body));
  await ready.promise;
  const { childPid, childStarted } = listTurns(key)[0];
  assert.ok(pidAlive(childPid));
  assert.match(childStarted, new RegExp('^' + process.platform + ':'));
  assert.equal(ownedProcessAlive(childPid, { childStarted }), true);
  await shutdownExecutions();
  assert.equal(closed, true);
  assert.equal(pidAlive(childPid), false);
});
