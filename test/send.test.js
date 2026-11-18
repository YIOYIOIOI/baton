import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sendMessage } from '../src/http/handlers/turns.js';
import { appendAudit } from '../src/audit.js';
import { missingCredentials, claudeLoggedIn } from '../src/agent/preflight.js';
import { tmpDir } from './helpers.js';

const member = {
  key: 'claude:abc', agent: 'claude',
  providerId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: 'C:\\proj', file: 'x',
};
const repo = { getSession: (k) => (k === member.key ? member : null) };
const okRunner = async () => ({ code: 0, lines: [], stderr: '', timedOut: false, summary: { status: 'ok' } });

// 测试发送路径时凭据显式给足，不依赖运行环境（本仓库的 CI/宿主可能剥掉该变量）
const ENV = { ANTHROPIC_AUTH_TOKEN: 'test-token' };
// 轮次落盘由 turns.test.js 覆盖，这里注入不落盘的假实现
const TURNS = { start: () => {}, end: () => ({ status: 'ok' }) };

test('allowSend 关闭时返回 403 且指出具体怎么开', async () => {
  const r = await sendMessage({ repo, config: { allowSend: false }, key: member.key, message: '你好', runner: okRunner });
  assert.equal(r.status, 403);
  assert.match(r.body.error.fix, /config\.json/);
  assert.match(r.body.error.fix, /allowSend/);
  assert.match(r.body.error.fix, /重启/);
});

test('allowSend 打开时受理并返回 202 与 turnId', async () => {
  const r = await sendMessage({ repo, config: { allowSend: true }, key: member.key, message: '你好', runner: okRunner, env: ENV, turns: TURNS });
  assert.equal(r.status, 202);
  assert.ok(r.body.turnId);
  assert.equal(r.body.events, undefined, 'agent 输出不走这里回传，走 SSE');
});

test('空消息与超长消息被拒', async () => {
  const cfg = { allowSend: true };
  assert.equal((await sendMessage({ repo, config: cfg, key: member.key, message: '   ', runner: okRunner, env: ENV, turns: TURNS })).status, 400);
  assert.equal((await sendMessage({ repo, config: cfg, key: member.key, message: 'x'.repeat(100001), runner: okRunner, env: ENV, turns: TURNS })).status, 400);
});

test('未知会话返回 404', async () => {
  const r = await sendMessage({ repo, config: { allowSend: true }, key: 'claude:zzz', message: '你好', runner: okRunner, env: ENV, turns: TURNS });
  assert.equal(r.status, 404);
});

test('消息原样交给 runner，不做任何 shell 转义', async () => {
  let seen = null;
  const spy = async (opts) => { seen = opts; return { code: 0, lines: [], summary: { status: 'ok' } }; };
  await sendMessage({ repo, config: { allowSend: true }, key: member.key, message: '& calc.exe', runner: spy, env: ENV, turns: TURNS });
  assert.equal(seen.message, '& calc.exe');
  assert.equal(seen.member.cwd, 'C:\\proj');
});

test('审计只记长度与预览，不记全文', () => {
  const dir = tmpDir();
  appendAudit({ key: 'claude:abc', agent: 'claude', message: '这是一条很长的消息'.repeat(50) }, { dir });
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim());
  assert.ok(line.ts);
  assert.equal(line.key, 'claude:abc');
  assert.ok(line.length > 80);
  assert.ok(line.preview.length <= 80);
  assert.equal(line.message, undefined, '审计不得留存消息全文');
});

test('缺少 ANTHROPIC_AUTH_TOKEN 时 Claude 会话拒绝发送并给出修复指引', async () => {
  const r = await sendMessage({
    repo, config: { allowSend: true }, key: member.key, message: '你好',
    runner: okRunner, turns: TURNS, env: { ANTHROPIC_BASE_URL: 'https://x' },
  });
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(r.body.error.fix, /ANTHROPIC_AUTH_TOKEN|login/);
});

test('Codex 会话不受 ANTHROPIC_AUTH_TOKEN 影响（凭据在 config.toml）', async () => {
  const codexMember = { ...member, key: 'codex:abc', agent: 'codex' };
  const codexRepo = { getSession: () => codexMember };
  const r = await sendMessage({
    repo: codexRepo, config: { allowSend: true }, key: 'codex:abc', message: '你好',
    runner: okRunner, turns: TURNS, env: {},
  });
  assert.equal(r.status, 202);
});

test('missingCredentials 只对 claude 检查 token', () => {
  assert.equal(missingCredentials('claude', { ANTHROPIC_AUTH_TOKEN: 'x' }), null);
  assert.equal(missingCredentials('claude', { ANTHROPIC_API_KEY: 'x' }), null, 'API key 也算凭据');
  assert.equal(missingCredentials('claude', {}, () => false), 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(missingCredentials('claude', {}, () => true), null, '电脑上登录了账号也算凭据');
  assert.equal(missingCredentials('codex', {}), null);
});

test('claudeLoggedIn 认 ~/.claude/.credentials.json 里的 OAuth token', () => {
  const dir = tmpDir();
  const env = { CLAUDE_CONFIG_DIR: dir };
  assert.equal(claudeLoggedIn(env), false, '没有凭据文件');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
  assert.equal(claudeLoggedIn(env), false, '有文件但没 token');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"r"}}');
  assert.equal(claudeLoggedIn(env), true);
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{坏的');
  assert.equal(claudeLoggedIn(env), false, '文件坏了当没登录');
});

// ── 谁发的 ──────────────────────────────────────

const FRIEND = { id: 'friend', name: 'Alice', roots: null, allowSend: null };

test('审计日志记下是谁发的', async () => {
  // 不记这个，审计日志就答不了「这条是我发的还是他发的」——而那正是它存在的理由
  const seen = [];
  await sendMessage({
    repo, config: { allowSend: true }, principal: FRIEND,
    key: member.key, message: '你好',
    runner: okRunner, audit: (e) => seen.push(e), env: ENV, turns: TURNS,
  });
  assert.equal(seen[0].principal, 'friend');
});

test('排队的消息把发起人一起落盘', async () => {
  // 队列跨重启，启动时替它们发出的那一刻没有 HTTP 请求，身份只能来自盘上
  let captured = null;
  const r = await sendMessage({
    repo, config: { allowSend: true }, principal: FRIEND,
    key: member.key, message: '排一条',
    runner: okRunner, audit: () => {}, env: ENV,
    turns: { ...TURNS, latest: () => ({ status: 'running', turnId: 't0' }) },
    queue: { enqueue: (x) => { captured = x; return { id: 'q1' }; }, list: () => [] },
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued, true);
  assert.equal(captured.principalId, 'friend');
});

test('不传 principal 时按 owner 记', async () => {
  const seen = [];
  await sendMessage({
    repo, config: { allowSend: true },
    key: member.key, message: '你好',
    runner: okRunner, audit: (e) => seen.push(e), env: ENV, turns: TURNS,
  });
  assert.equal(seen[0].principal, 'owner');
});

// ── 电脑上正在跑时也要排队（2026-10-09）──────────────────────────
//
// 「两个 --resume 同时续写同一份 transcript 会造成语义损坏」这条纪律，原来只防得住
// Baton 自己起的轮次——电脑上（桌面 App、终端）起的那一轮它根本不知道，于是手机上
// 一发就是第二个进程。现在 runtime/live.js 认得出来了，这里把它接上。
//
// `waiting` 同样不许发：那是 CLI 卡在一个对话框上（实测 waitingFor 有
// input needed / dialog open / sandbox request 几种），进程还在，照样会撞。

/** 假的「电脑上在跑」：只给这个会话一种状态。 */
const hostIs = (state) => () => new Map(state ? [[member.providerId, state]] : []);

test('电脑上这轮还在跑：排队，绝不起第二个进程', async () => {
  const q = [];
  let spawned = 0;
  const r = await sendMessage({
    repo, config: { allowSend: true }, key: member.key, message: '手机上插一句',
    runner: async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: ENV, turns: TURNS, live: hostIs('busy'),
    queue: { enqueue: (i) => { q.push(i); return { id: 'Q1' }; }, list: () => q, takeNext: () => null },
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued, true);
  assert.equal(spawned, 0, '起了第二个进程就是在同一份 transcript 上打架');
  assert.equal(q.length, 1);
  assert.match(r.body.note, /电脑上/, '得说清是在等电脑上那轮，不是等 Baton 自己那轮');
});

/*
  电脑上开着一个框（waiting）**不挡发送**。

  一度挡过，owner 2026-10-09 当场否掉：「那我不是离开电脑就永远发不了消息了吗」。
  那个框要人在电脑前点才会消失，而 waiting 的五种来源里有一种只是「某个本地命令的
  界面开着、什么都没在跑」（agent-protocol §11.4）——拿它挡发送，等于把这个项目
  存在的理由（在手机上继续电脑上的活）交出去。

  busy 不一样：那一轮自己会跑完，排着的消息几分钟内就出去了。
*/
test('电脑上开着个框（waiting）：照发不误', async () => {
  let spawned = 0;
  let queuedTimes = 0;
  const r = await sendMessage({
    repo, config: { allowSend: true }, key: member.key, message: '手机上插一句',
    runner: async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: ENV, turns: TURNS, live: hostIs('waiting'),
    queue: { enqueue: () => { queuedTimes += 1; return { id: 'Q2' }; }, list: () => [], takeNext: () => null },
  });
  assert.equal(r.body.queued, false, '离开电脑就发不出消息，等于这个项目白做');
  assert.equal(queuedTimes, 0);
  await new Promise((done) => setImmediate(done));
  assert.equal(spawned, 1);
});

test('电脑上闲着就照常发', async () => {
  let spawned = 0;
  const r = await sendMessage({
    repo, config: { allowSend: true }, key: member.key, message: '照常发',
    runner: async () => { spawned += 1; return { code: 0, lines: [], summary: { status: 'ok' } }; },
    env: ENV, turns: TURNS, live: hostIs(null),
  });
  assert.equal(r.body.queued, false);
  assert.ok(r.body.turnId);
  await new Promise((done) => setImmediate(done));
  assert.equal(spawned, 1);
});

test('别的会话在电脑上跑，不影响这条', async () => {
  const r = await sendMessage({
    repo, config: { allowSend: true }, key: member.key, message: '照常发',
    runner: okRunner, env: ENV, turns: TURNS,
    live: () => new Map([['99999999-0000-4000-8000-000000000099', 'busy']]),
  });
  assert.equal(r.body.queued, false);
});
