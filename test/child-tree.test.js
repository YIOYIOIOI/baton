import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { makeChildTree } from '../src/agent/childTree.js';

function childFixture() {
  return Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, kill() {} });
}

test('POSIX waits for an owned descendant after leader close and escalates exactly once', async () => {
  const child = childFixture();
  const group = new Map([[child.pid, 'leader-start'], [12346, 'worker-start']]);
  const signals = [];
  const tree = makeChildTree(child, { platform: 'linux', graceMs: 15, members: () => new Map(group),
    signal(pid, value) {
      assert.equal(pid, -child.pid);
      signals.push(value);
      if (value === 'SIGTERM') {
        group.delete(child.pid); child.signalCode = 'SIGTERM'; child.emit('exit'); child.emit('close');
      } else group.clear();
    } });
  tree.stop();
  tree.stop();
  assert.deepEqual(signals, ['SIGTERM']);
  await tree.wait();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('a recycled process group without an original member is never signalled again', async () => {
  const child = childFixture();
  let group = new Map([[child.pid, 'first'], [12346, 'old-worker']]);
  const signals = [];
  const tree = makeChildTree(child, { platform: 'linux', graceMs: 10, members: () => new Map(group),
    signal(_pid, value) {
      signals.push(value);
      child.signalCode = 'SIGTERM'; child.emit('exit');
      group = new Map([[child.pid, 'another-leader'], [12346, 'another-worker']]);
      child.emit('close');
    } });
  tree.stop();
  await tree.wait();
  assert.deepEqual(signals, ['SIGTERM']);
});

test('stop in the same tick as leader exit still terminates the owned descendant holding the pipe', async () => {
  const child = childFixture();
  const group = new Map([[12346, 'worker-start']]);
  const signals = [];
  const tree = makeChildTree(child, { platform: 'linux', graceMs: 10, members: () => new Map(group),
    signal(_pid, name) {
      signals.push(name);
      if (name === 'SIGKILL') { group.clear(); child.emit('close'); }
    } });
  child.exitCode = 0;
  child.emit('exit');
  tree.stop();
  try { assert.deepEqual(signals, ['SIGTERM']); } finally {
    if (!signals.length) child.emit('close');
  }
  await tree.wait();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Windows reports taskkill failure and keeps waiting until a tree retry and actual close succeed', async () => {
  const child = childFixture();
  const errors = [];
  let attempts = 0;
  const tree = makeChildTree(child, { platform: 'win32', graceMs: 5, report: (message) => errors.push(message),
    spawnKiller() {
      attempts++;
      const cmd = new EventEmitter();
      setImmediate(() => {
        const code = attempts > 1 ? 0 : 5;
        cmd.emit('close', code);
        if (code === 0) { child.signalCode = 'SIGKILL'; child.emit('exit'); child.emit('close'); }
      });
      return cmd;
    } });
  child.kill = () => assert.fail('a failed tree termination must not discard ownership of descendants');
  tree.stop();
  await tree.wait();
  assert.equal(attempts, 2);
  assert.ok(errors.some((message) => message.includes('5')));
});

test('a repeatedly failing Windows tree cancellation retains ownership until the child really closes', async () => {
  const child = childFixture();
  const retries = Promise.withResolvers();
  let attempts = 0;
  let parentOnly = 0;
  child.kill = () => { parentOnly++; };
  const tree = makeChildTree(child, { platform: 'win32', graceMs: 5, report() {}, spawnKiller() {
    const cmd = new EventEmitter();
    setImmediate(() => { cmd.emit('close', 5); if (++attempts === 2) retries.resolve(); });
    return cmd;
  } });
  tree.stop();
  let ended = false;
  const waiting = tree.wait().then(() => { ended = true; });
  await retries.promise;
  assert.equal(parentOnly, 0);
  assert.equal(ended, false);
  child.exitCode = 0; child.emit('exit'); child.emit('close');
  await waiting;
});

test('a real POSIX process ignoring TERM closes after group escalation', { skip: process.platform === 'win32', timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 3000);"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
  const tree = makeChildTree(child, { graceMs: 25 });
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  tree.stop();
  await tree.wait();
  const [, signal] = await closed;
  assert.equal(signal, 'SIGKILL');
});
