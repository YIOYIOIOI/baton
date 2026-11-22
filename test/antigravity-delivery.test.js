import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { callBridge, ensureAntigravityPlugin, findLiveBridge } from '../src/agent/antigravityBridge.js';
import { runAntigravityTurn } from '../src/agent/antigravityRun.js';
import { healthProof, newNonce, responseProof } from '../sidecars/baton-bridge/sidecars/bridge/protocol.mjs';
import { readRegistration, registryDirectory, trustedRegistryEntry } from '../sidecars/baton-bridge/sidecars/bridge/registry.mjs';
import { tmpDir, writeJsonl } from './helpers.js';

async function startSidecar(t, root, executable) {
  const { destDir } = ensureAntigravityPlugin({ geminiConfigDir: path.join(root, 'config') });
  const child = spawn(process.execPath, [path.join(destDir, 'sidecars', 'bridge', 'main.mjs')], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { BATON_DIR: root, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, ANTIGRAVITY_AGENTAPI_EXE: executable },
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  const file = path.join(root, 'antigravity-bridges', child.pid + '.json');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(15);
  const live = await findLiveBridge({ batonDir: root });
  assert.equal(live?.pid, child.pid);
  return live;
}

test('真实 sidecar 启动 agentapi 失败时，新建和续聊均结束；已启动的程序退出失败仍保留送达不确定性', async (t) => {
  const root = tmpDir();
  const live = await startSidecar(t, root, path.join(root, 'missing-agentapi'));
  await assert.rejects(callBridge(live, '/send-message', { body: { conversationId: 'current', message: '继续' } }), (err) => (
    !err.deliveryUnknown && /agentapi/.test(err.message)
  ));
  for (const isNew of [false, true]) {
    const result = await runAntigravityTurn({
      isNew, member: { agent: 'antigravity', providerId: isNew ? null : 'current', cwd: root },
      message: '继续', agyBin: null, batonDir: root, geminiRoot: root, geminiConfigDir: root,
    });
    assert.equal(result.summary.status, 'failed');
    assert.equal(result.summary.sessionId, isNew ? null : 'current');
    assert.match(result.summary.error, /agentapi/);
  }
  const startedRoot = tmpDir();
  fs.writeFileSync(path.join(startedRoot, 'agentapi'), "process.stderr.write('agentapi fixture exit'); process.exitCode = 1;");
  const started = await startSidecar(t, startedRoot, process.execPath);
  await assert.rejects(callBridge(started, '/new-conversation', { body: { message: '新建' } }), { deliveryUnknown: true });
});

test('写出的 POST 只有经签名且一致的失败回执才能证明未派发', async (t) => {
  const root = tmpDir();
  const instance = { protocol: 2, host: '127.0.0.1', pid: process.pid, projectId: null, instanceId: crypto.randomUUID(), secret: newNonce() };
  let reply;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, protocol: 2, instanceId: instance.instanceId, pid: instance.pid, projectId: null,
        proof: healthProof(instance, url.searchParams.get('challenge')) }));
      return;
    }
    req.resume();
    const [code, body, signed] = reply;
    const raw = JSON.stringify(body);
    if (signed) res.setHeader('x-baton-proof', responseProof(instance, req.headers['x-baton-nonce'], code, raw));
    res.writeHead(code).end(raw);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  instance.port = server.address().port;
  const dir = path.join(root, 'antigravity-bridges');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, process.pid + '.json'), JSON.stringify(instance), { mode: 0o600 });
  const live = await findLiveBridge({ batonDir: root });
  assert.ok(live);
  for (reply of [
    [200, {}, true], [200, null, true], [200, { ok: false, delivery: 'not_dispatched' }, true],
    [200, { ok: true, delivery: 'not_dispatched' }, true], [500, { ok: false, error: 'earlier sidecar' }, true],
    [503, { ok: false, delivery: 'not_dispatched' }, false],
  ]) {
    await assert.rejects(callBridge(live, '/send-message', { body: { conversationId: 'current', message: '继续' } }), { deliveryUnknown: true });
  }
});

test('真实 sidecar 的签收先于己方 USER_INPUT 时，继续同一轮观察且只提交一次', async (t) => {
  const root = tmpDir();
  await startSidecar(t, root, process.execPath);
  const file = writeJsonl(root, 'transcript.jsonl', [{ step_index: 0, type: 'USER_INPUT', content: '同一条指令' }]);
  fs.writeFileSync(path.join(root, 'agentapi'), [
    "const fs = require('node:fs');",
    "fs.appendFileSync('dispatches.txt', '1');",
    "fs.appendFileSync('transcript.jsonl', JSON.stringify({ step_index: 1, type: 'ERROR_MESSAGE', content: '上一轮错误' }) + '\\n');",
    "process.stdout.write('{}');",
  ].join('\n'));
  const receipt = Promise.withResolvers();
  let settled = false;
  const accepted = runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'current', file, cwd: root }, message: '同一条指令',
    agyBin: null, batonDir: root, geminiRoot: root, geminiConfigDir: root, pollMs: 10,
    bridgeCaller: async (...args) => {
      const response = await callBridge(...args);
      receipt.resolve();
      return response;
    },
  }).then((r) => { settled = true; return r; });
  await receipt.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  fs.appendFileSync(file, JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: '同一条指令' }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '本轮完成', output_tokens: 9 }) + '\n');
  const { summary } = await accepted;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.tokens.output, 9);
  assert.equal(fs.readFileSync(path.join(root, 'dispatches.txt'), 'utf8'), '1');
});

test('登记只信任本 UID 下的安全目录、私有普通文件，排除链接', () => {
  const uid = 1001;
  const directory = { uid, mode: 0o700, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
  const file = { ...directory, mode: 0o600, nlink: 1, isDirectory: () => false, isFile: () => true };
  assert.equal(trustedRegistryEntry(directory, 'registry', uid), true);
  assert.equal(trustedRegistryEntry({ ...directory, mode: 0o770 }, 'registry', uid), false);
  assert.equal(trustedRegistryEntry({ ...directory, uid: 1002 }, 'registry', uid), false);
  assert.equal(trustedRegistryEntry({ ...directory, mode: 0o777 }, 'base', uid), false);
  assert.equal(trustedRegistryEntry({ ...file, mode: 0o640 }, 'file', uid), false);
  assert.equal(trustedRegistryEntry({ ...file, uid: 1002 }, 'file', uid), false);
  assert.equal(trustedRegistryEntry({ ...file, isSymbolicLink: () => true }, 'file', uid), false);
  assert.equal(trustedRegistryEntry({ ...file, isFile: () => false }, 'file', uid), false);
  const root = tmpDir();
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, path.join(root, 'antigravity-bridges'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => registryDirectory(root, { publish: true }));
  const ordinary = path.join(target, 'one.json');
  fs.writeFileSync(ordinary, '{}', { mode: 0o600 });
  assert.deepEqual(readRegistration(ordinary), {});
  const link = path.join(target, 'two.json');
  fs.linkSync(ordinary, link);
  assert.equal(readRegistration(link), null);
});

test('POSIX 发布前将本人旧登记目录收紧为 0700，并拒绝可替换子目录的数据根', {
  skip: typeof process.geteuid !== 'function',
}, () => {
  const root = tmpDir();
  const dir = path.join(root, 'antigravity-bridges');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o770);
  assert.throws(() => registryDirectory(root));
  assert.equal(registryDirectory(root, { publish: true }), dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.chmodSync(root, 0o770);
  assert.throws(() => registryDirectory(root, { publish: true }));
  assert.equal(fs.statSync(root).mode & 0o777, 0o770);
  const child = path.join(root, 'nested');
  fs.mkdirSync(child, { mode: 0o700 });
  assert.throws(() => registryDirectory(child, { publish: true }));
});
