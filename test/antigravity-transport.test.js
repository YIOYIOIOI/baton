import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { callBridge, ensureAntigravityPlugin, findLiveBridge } from '../src/agent/antigravityBridge.js';
import { runAntigravityAcpTurn, runAntigravityTurn } from '../src/agent/antigravityRun.js';
import { matchesProof, newNonce, requestHeaders, responseProof, verifyRequest } from '../sidecars/baton-bridge/sidecars/bridge/protocol.mjs';
import { tmpDir, writeJsonl } from './helpers.js';

const peer = fileURLToPath(new URL('./fixtures/antigravity-acp-peer.mjs', import.meta.url));
const fixtureDeadlineMs = 10_000;

async function waitForFile(file) {
  const deadline = Date.now() + fixtureDeadlineMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(15);
  assert.ok(fs.existsSync(file), '模拟进程应完成文件写入');
}

test('桥接签名绑定消息、回执和实例，一个 nonce 只接受一次', () => {
  const instance = { instanceId: crypto.randomUUID(), secret: newNonce() };
  const pathname = '/send-message';
  const data = JSON.stringify({ message: '正常消息' });
  const nonce = newNonce();
  const headers = requestHeaders(instance, pathname, data, nonce);
  const used = new Map();
  assert.equal(verifyRequest(instance, pathname, JSON.stringify({ message: '另一条消息' }), headers, used), false);
  assert.equal(verifyRequest(instance, '/metadata', data, headers, used), false);
  assert.equal(verifyRequest(instance, pathname, data, headers, used), true);
  assert.equal(verifyRequest(instance, pathname, data, headers, used), false);
  const proof = responseProof(instance, nonce, 200, '{}');
  assert.equal(matchesProof(proof, responseProof(instance, newNonce(), 200, '{}')), false);
  assert.equal(matchesProof(proof, responseProof({ ...instance, instanceId: crypto.randomUUID() }, nonce, 200, '{}')), false);
});

test('旧登记和非固定回环地址跳过，一般 HTTP 健康响应无法识别为桌面实例', async (t) => {
  const root = tmpDir();
  const dir = path.join(root, 'antigravity-bridges');
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, process.pid + '.json');
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const legacy = { host: '127.0.0.1', pid: process.pid, port: srv.address().port };
  fs.writeFileSync(path.join(root, 'token'), 'owner-only-fixture');
  fs.writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
  assert.equal(await findLiveBridge({ batonDir: root }), null);
  assert.equal(requests.length, 0);
  const current = { ...legacy, protocol: 2, instanceId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('hex'), projectId: null };
  fs.writeFileSync(file, JSON.stringify({ ...current, host: 'localhost' }));
  assert.equal(await findLiveBridge({ batonDir: root }), null);
  assert.equal(requests.length, 0);
  fs.writeFileSync(file, JSON.stringify(current));
  assert.equal(await findLiveBridge({ batonDir: root }), null);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/health\?challenge=/);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.ok(!JSON.stringify(requests).includes(current.secret));
  assert.ok(!JSON.stringify(requests).includes('owner-only-fixture'));
  await assert.rejects(callBridge(current, '/metadata', { body: {} }));
  assert.equal(requests.length, 1);
});

test('临时目录里的真实 sidecar 验证实例，签收调用并区分已拒绝与回执丢失', async (t) => {
  const root = tmpDir();
  const { destDir } = ensureAntigravityPlugin({ geminiConfigDir: path.join(root, 'config') });
  const sidecar = path.join(destDir, 'sidecars', 'bridge', 'main.mjs');
  const env = {
    BATON_DIR: root, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot,
    ANTIGRAVITY_AGENTAPI_EXE: process.execPath, ANTIGRAVITY_PROJECT_ID: 'fixture-project',
  };
  fs.writeFileSync(path.join(root, 'agentapi'), [
    "const fs = require('node:fs');",
    "const message = process.argv.at(-1);",
    "if (message === '继续桌面') {",
    "  const rows = [{ step_index: 12, type: 'PLANNER_RESPONSE', status: 'DONE', content: '以前的回复' },",
    "    { step_index: 13, type: 'USER_INPUT', content: message },",
    "    { step_index: 14, type: 'GENERIC', content: '界'.repeat(1500000) },",
    "    { step_index: 15, type: 'PLANNER_RESPONSE', status: 'DONE', content: '本轮完成', output_tokens: 8 }];",
    "  fs.renameSync('transcript.jsonl', 'previous.jsonl');",
    "  fs.writeFileSync('transcript.jsonl', rows.map((r) => JSON.stringify(r)).join('\\n'));",
    "}",
    "setTimeout(() => {",
    "  if (message === 'late') fs.writeFileSync('receipt.finished', 'done');",
    "  process.stdout.write(JSON.stringify({ message }));",
    "}, message === 'late' ? 150 : 0);",
  ].join('\n'));
  const child = spawn(process.execPath, [sidecar], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  const registration = path.join(root, 'antigravity-bridges', child.pid + '.json');
  await waitForFile(registration);
  const registered = JSON.parse(fs.readFileSync(registration, 'utf8'));
  assert.equal(registered.protocol, 2);
  assert.equal(registered.host, '127.0.0.1');
  assert.equal(registered.pid, child.pid);
  fs.writeFileSync(registration, JSON.stringify({ ...registered, instanceId: crypto.randomUUID() }));
  assert.equal(await findLiveBridge({ batonDir: root }), null);
  fs.writeFileSync(registration, JSON.stringify(registered));
  const live = await findLiveBridge({ batonDir: root, projectId: env.ANTIGRAVITY_PROJECT_ID });
  assert.equal(live?.pid, child.pid);
  assert.ok(!JSON.stringify(live).includes(registered.secret));
  const sent = await callBridge(live, '/send-message', { body: { conversationId: 'normal', message: '一条消息' } });
  assert.deepEqual(sent.result, { message: '一条消息' });
  const transcript = writeJsonl(root, 'transcript.jsonl', [
    { step_index: 12, type: 'PLANNER_RESPONSE', status: 'DONE', content: '以前的回复' },
  ]);
  const delivered = [];
  const desktop = await runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'normal', file: transcript, cwd: root }, message: '继续桌面',
    batonDir: root, geminiRoot: root, geminiConfigDir: root, agyBin: null, pollMs: 10,
    onLine: (line) => delivered.push(JSON.parse(line)),
  });
  assert.equal(desktop.summary.status, 'ok');
  assert.equal(desktop.summary.tokens.output, 8);
  assert.equal(desktop.summary.eventCount, 1);
  assert.deepEqual(delivered.filter((r) => r.type === 'PLANNER_RESPONSE').map((r) => r.content), ['本轮完成']);
  await assert.rejects(callBridge(live, '/metadata', { body: {} }), (err) => (
    err.message === 'missing_conversation_id' && !err.deliveryUnknown
  ));
  await assert.rejects(callBridge(live, '/send-message', {
    body: { conversationId: 'normal', message: 'late' }, timeoutMs: 50,
  }), { deliveryUnknown: true });
  const completed = path.join(root, 'receipt.finished');
  await waitForFile(completed);
});

function runPeer(scenario, limits = {}) {
  const seen = [];
  const root = tmpDir();
  const result = runAntigravityAcpTurn({
    agyBin: process.execPath, member: { cwd: root, providerId: 'test-session' }, message: '继续',
    spawnFn: (_command, _args, opts) => spawn(process.execPath, [peer, scenario], opts),
    timeoutMs: fixtureDeadlineMs, ...limits, onLine: (line) => seen.push(line),
  });
  return { result, seen };
}

test('双向 ACP 可并行使用相同请求 ID，权限和不支持的方法分别收到宿主答复', async () => {
  const { result } = runPeer('permission');
  const { summary } = await result;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.tokens?.output_tokens, 17);
});

test('ACP 跨块中文完整推送，返回的历史行按 UTF-8 字节数封顶', async () => {
  const { result, seen } = runPeer('output', { maxRetainedBytes: 480, maxLineBytes: 512 });
  const { summary, lines } = await result;
  assert.equal(summary.eventCount, 24);
  assert.equal(summary.tokens?.output_tokens, 17);
  assert.equal(seen.filter((l) => l.includes('跨块中文')).length, 24);
  assert.ok(lines.reduce((bytes, l) => bytes + Buffer.byteLength(l) + 1, 0) <= 480);
  assert.ok(lines.at(-1).includes('"event":"result"'));
});

test('ACP 未换行的帧按字节超限时结束子进程并报告协议错误', async () => {
  const { result, seen } = runPeer('long-frame', { maxLineBytes: 512 });
  const { summary } = await result;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /512.*字节/);
  assert.ok(seen.every((l) => Buffer.byteLength(l) <= 512));
});

test('目录探针分别处理宿主请求和回执，遇到超限片段时等模拟进程退出再回退', async () => {
  const { probeAntigravityViaAcp } = await import('../src/agent/catalog.js');
  for (const scenario of ['catalog-permission', 'catalog-long']) {
    let closed = false;
    const directory = await probeAntigravityViaAcp({
      agyBin: process.execPath, cwd: tmpDir(), env: {}, timeoutMs: fixtureDeadlineMs, maxLineBytes: 512,
      spawnFn: (_bin, _args, opts) => {
        const child = spawn(process.execPath, [peer, scenario], opts);
        child.once('close', () => { closed = true; });
        return child;
      },
    });
    assert.equal(closed, true);
    if (scenario === 'catalog-permission') assert.equal(directory.defaultModel.name, '示例模型');
    else assert.equal(directory, null);
  }
});
