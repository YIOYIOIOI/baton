import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSession } from '../src/http/handlers/create.js';
import { visibleCwds, listSessions } from '../src/http/handlers/sessions.js';
import { sendMessage, stopTurn, liveTurns } from '../src/http/handlers/turns.js';
import { buildClaudeNewArgs, buildCodexNewArgs } from '../src/agent/args.js';
import { tmpDir } from './helpers.js';

// 新规则要求工作目录**真实存在**，所以夹具用一个真的临时目录，
// 不再用写死的项目路径——那个只在 owner 那台机器上才有。
const CWD = tmpDir();
const OWNER_P = { id: 'owner', name: 'owner', roots: null, allowSend: null };

const repo = {
  listChains: () => [{ agent: 'claude', members: [{ cwd: CWD }] }],
  getSession: () => null,
};
const ENV = { ANTHROPIC_AUTH_TOKEN: 'test-token' };
const OK = { code: 0, lines: [], summary: { status: 'ok', tokens: { output_tokens: 7 }, eventCount: 2 } };

/**
 * 一个会「落地」的假 agent：像真的 CLI 那样，一起来就把会话文件写出来（这里是往假仓库里
 * 加一个成员），然后按 `finish` 决定什么时候跑完。
 *
 * claude 的会话 id 是 Baton 自己用 --session-id 给的；codex 的要等 stdout 里的
 * thread.started 才知道——两条路都照真的来。
 */
function world({ finish = () => Promise.resolve(OK), land = true } = {}) {
  const members = [{ cwd: CWD }];
  const w = { members, calls: [], killed: 0 };
  w.repo = {
    listChains: () => [{ agent: 'claude', members }],
    getSession: (k) => members.find((m) => m.key === k) ?? null,
  };
  w.runner = async (opts) => {
    w.calls.push(opts);
    opts.onStart?.({ kill: () => { w.killed += 1; } });
    if (opts.isNew && land) {
      const { args } = opts;
      const claude = args.includes('--session-id');
      const id = claude ? args[args.indexOf('--session-id') + 1] : 'eeeeeeee-0000-4000-8000-00000000000e';
      if (!claude) opts.onLine?.(JSON.stringify({ type: 'thread.started', thread_id: id }));
      members.push({ cwd: CWD, providerId: id, key: `${claude ? 'claude' : 'codex'}:${id}`, agent: claude ? 'claude' : 'codex' });
    }
    return finish(opts);
  };
  return w;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * 每个用例拿一份新的：新建会往假仓库里加成员，共用一份会互相串。
 *
 * **registrar 必须默认就是假的。** 漏注入时 createSession 用的是真的
 * defaultRegistrar，会往桌面 App 的注册表里写 `local_*.json`——2026-09-30
 * 「默认强度」那三条用例就这么漏的，跑一次测试 App 侧栏里多三个叫「你好」、
 * 目录在 Temp 下的会话，一晚上攒了 40 个。test/setup.js 另把注册表根目录
 * 整体重定向到了临时目录，这里是第一道。
 */
const base = () => {
  const w = world();
  return {
    repo: w.repo, runner: w.runner, config: { allowSend: true }, principal: OWNER_P, message: '你好', env: ENV,
    registrar: () => 'C:\\reg\\local_x.json',
    // 起名字那一步同样必须是假的：真的会起一个 claude 进程、真的发一次请求
    titler: async () => null,
    retitle: () => false,
  };
};

test('新建参数带 --session-id，不带 --resume', () => {
  const a = buildClaudeNewArgs({ sessionId: 'dddddddd-0000-4000-8000-000000000001' });
  assert.ok(a.includes('--session-id'));
  assert.ok(!a.includes('--resume'));
  assert.deepEqual(buildCodexNewArgs(), ['exec', '--json', '--skip-git-repo-check']);
});

test('visibleCwds 收集可见会话用过的目录', () => {
  const s = visibleCwds(repo);
  assert.ok(s.has(CWD));
  assert.equal(s.size, 1);
});

test('allowSend 关闭时也不能新建', async () => {
  const r = await createSession({ ...base(), config: { allowSend: false }, agent: 'claude', cwd: CWD });
  assert.equal(r.status, 403);
  assert.match(r.body.error.fix, /allowSend/);
});

// 原本这里是「工作目录不在白名单时拒绝」，断言 C:\Windows\System32 被拒。
// 新规则下 owner 在任何**存在的**目录里都能新建，而那个目录在 Windows 上是存在的
// ——那条断言会从「测对了一件事」变成「测错了一件事」，所以整条换掉。
test('工作目录不是绝对路径时拒绝', async () => {
  const r = await createSession({ ...base(), agent: 'claude', cwd: 'relative\\path' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /绝对路径/);
  assert.ok(r.body.error.fix);
});

test('已存在的目录可新建，返回 202 与新会话 id', async () => {
  const r = await createSession({
    ...base(), agent: 'claude', cwd: CWD,
    registrar: () => 'C:\\reg\\local_x.json',
  });
  assert.equal(r.status, 202);
  assert.ok(r.body.sessionId);
  assert.equal(r.body.registered, true);
  assert.match(r.body.note, /重启/, '必须告诉用户 App 要重启才看得到');
});

test('Codex 新建不写注册项', async () => {
  let called = false;
  const r = await createSession({
    ...base(), agent: 'codex', cwd: CWD,
    registrar: () => { called = true; },
  });
  assert.equal(r.status, 202);
  assert.equal(called, false, '注册表是 Claude 桌面 App 的，Codex 不适用');
  assert.equal(r.body.registered, false);
});

test('注册失败不影响会话创建成功', async () => {
  const r = await createSession({
    ...base(), agent: 'claude', cwd: CWD,
    registrar: () => { throw new Error('注册表目录找不到'); },
  });
  assert.equal(r.status, 202, '会话已经建起来了，注册只是让它在 App 里可见');
  assert.equal(r.body.registered, false);
  assert.match(r.body.note, /注册表目录找不到/);
});

test('不支持的 agent 被拒', async () => {
  const r = await createSession({ ...base(), agent: 'gpt', cwd: CWD });
  assert.equal(r.status, 400);
  assert.match(r.body.error.fix, /claude|codex/);
});

test('空消息被拒', async () => {
  const r = await createSession({ ...base(), agent: 'claude', cwd: CWD, message: '  ' });
  assert.equal(r.status, 400);
});

test('缺凭据时 Claude 新建被拦下', async () => {
  const r = await createSession({ ...base(), agent: 'claude', cwd: CWD, env: {} });
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /ANTHROPIC_AUTH_TOKEN/);
});

test('注册用的标题取第一句并截断', async () => {
  let seen = null;
  await createSession({
    ...base(), agent: 'claude', cwd: CWD,
    message: '这是一句很长的开场白'.repeat(20),
    registrar: (a) => { seen = a; return 'x'; },
  });
  assert.ok(seen.title.length <= 60);
  assert.equal(seen.cwd, CWD);
  assert.match(seen.cliSessionId, /^[0-9a-f-]{36}$/);
});

// ── 创建那一轮也要有终态记录（spec §12）────────────

test('新建：会话一落地就登记成正常的一轮并返回，不等第一轮跑完', { timeout: 5000 }, async () => {
  // 原来要等第一轮整个跑完才返回：这一轮停不下来、别处看不见它在跑、超过 100 秒
  // 还会被 Cloudflare 先回 524（2026-10-01 审查）
  const first = deferred();
  const w = world({ finish: () => first.promise });
  const started = [];
  const ended = [];
  const r = await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD, registrar: () => 'x',
    turns: { start: (t) => started.push(t), end: (t) => ended.push(t) },
  });
  assert.equal(r.status, 202);
  assert.match(r.body.key, /^claude:/, '返回里直接带上新会话的 key');
  assert.equal(started.length, 1, '返回之前就已经登记成「在跑」');
  assert.equal(started[0].key, r.body.key);
  assert.equal(started[0].turnId, r.body.turnId);
  assert.equal(ended.length, 0, '第一轮还没跑完');
  assert.ok(liveTurns.has(r.body.turnId), '有停止用的句柄');

  first.resolve(OK);
  await r.settled;
  assert.equal(ended.length, 1);
  assert.equal(ended[0].status, 'ok');
  assert.equal(ended[0].eventCount, 2);
  assert.ok(!liveTurns.has(r.body.turnId));
});

test('新建：第一轮还在跑时再发的消息排队，跑完就接着发出去', { timeout: 5000 }, async () => {
  // 原来第一轮没有「在跑」的记录：这时发消息会起第二个 --resume 写同一份 transcript
  const first = deferred();
  const w = world({ finish: (o) => (o.isNew ? first.promise : Promise.resolve(OK)) });
  const r = await createSession({ ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD, registrar: () => 'x' });
  const second = await sendMessage({
    repo: w.repo, config: { allowSend: true }, principal: OWNER_P, key: r.body.key,
    message: '第二句', runner: w.runner, env: ENV,
  });
  assert.equal(second.body.queued, true, '第一轮在跑，第二句必须排队');

  first.resolve(OK);
  await r.settled;
  assert.deepEqual(w.calls.map((c) => c.message), ['你好', '第二句'], '第一轮跑完，排着的那句接着发');
});

test('新建：第一轮能停', { timeout: 5000 }, async () => {
  const first = deferred();
  const w = world({ finish: () => first.promise });
  const r = await createSession({ ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD, registrar: () => 'x' });
  const s = stopTurn({ repo: w.repo, config: { allowSend: true }, key: r.body.key, turnId: r.body.turnId });
  assert.equal(s.body.stopped, true);
  assert.equal(w.killed, 1);
  first.resolve({ code: 1, lines: [], summary: { status: 'failed', error: 'killed' } });
  await r.settled;
});

test('新建：落地之前 agent 就退出了，把它的报错如实回给客户端', async () => {
  const started = [];
  const w = world({
    land: false,
    finish: () => Promise.resolve({ code: 1, lines: [], summary: { status: 'failed', error: 'Not logged in · Please run /login' } }),
  });
  const r = await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD, registrar: () => 'x',
    turns: { start: (t) => started.push(t), end: () => {} },
  });
  assert.equal(r.status, 502, '原来这里回 202，客户端以为建好了，列表里却什么都没有');
  assert.equal(r.body.error.code, 'create_failed');
  assert.match(r.body.error.message, /Not logged in/);
  assert.ok(r.body.error.fix);
  assert.equal(started.length, 0, '没有那个会话，就没有它的一轮可记');
});

test('新建：一直等不到落地，也不把请求一直挂着', { timeout: 5000 }, async () => {
  const w = world({ land: false, finish: () => new Promise(() => {}) });
  const r = await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD, registrar: () => 'x', landWaitMs: 50,
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.key, null);
  assert.match(r.body.note, /还在/);
});

// ── 工作目录规则：绝对路径 + 已存在 + 在调用者 roots 之下 ──────

test('owner 可以在一个从没出现过会话的目录里新建', async () => {
  // 这推翻了 v1 §17「只能选已有会话出现过的目录」。依据是 owner 明确要求
  // 能选任意文件夹，且他的工作摊在至少四棵顶层树上，白名单覆盖不住。
  const fresh = tmpDir(); // 真实存在，但没有任何会话用过它
  const r = await createSession({
    ...base(), agent: 'claude', cwd: fresh, registrar: () => {},
  });
  assert.equal(r.status, 202, `不该再因为「目录没出现过」被拒：${JSON.stringify(r.body)}`);
});

test('访客不能在自己 roots 之外新建', async () => {
  const outside = tmpDir();
  const guest = { id: 'friend', name: 'Alice', roots: [tmpDir()], allowSend: null };
  const r = await createSession({
    ...base(), principal: guest, agent: 'claude', cwd: outside, registrar: () => {},
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'cwd_not_allowed');
  assert.match(r.body.error.fix, /工作区/);
});

test('访客在自己 roots 之下可以新建', async () => {
  const root = tmpDir();
  const guest = { id: 'friend', name: 'Alice', roots: [root], allowSend: null };
  const r = await createSession({
    ...base(), principal: guest, agent: 'claude', cwd: root, registrar: () => {},
  });
  assert.equal(r.status, 202);
});

test('目录不存在时 400，并指向新建目录的端点', async () => {
  const r = await createSession({
    ...base(), agent: 'claude', cwd: path.join(tmpDir(), 'nope'), registrar: () => {},
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'cwd_not_found');
  assert.match(r.body.error.fix, /\/api\/dirs/);
});

// ── 列表的 cwds 字段 ────────────────────────────

test('listSessions 返回 cwds，访客零会话时仍含自己的 root', () => {
  const root = tmpDir();
  const guest = { id: 'friend', name: 'Alice', roots: [root], allowSend: null };
  const empty = { listChains: () => [], getSession: () => null, stats: () => ({}) };
  const body = listSessions(empty, { running: new Set(), principal: guest });
  assert.deepEqual(body.cwds, [root], '零会话时选单不能是空的，否则他压根开不了头');
});

test('listSessions 的 cwds 对 owner 就是可见会话那些', () => {
  const body = listSessions(repo, { running: new Set(), principal: OWNER_P });
  assert.deepEqual(body.cwds, [CWD]);
});

// ── 默认强度（owner：「默认改成opus5.5max」）──────────────

function capture() {
  const seen = {};
  const w = world();
  const runner = async (o) => { seen.args = o.args; return w.runner(o); };
  return { seen, runner, repo: w.repo };
}
const effortOf = (args) => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null);

test('新建：模型和强度都没选，第一轮就带上整台电脑的默认强度', async () => {
  const { seen, runner, repo: r0 } = capture();
  const r = await createSession({
    ...base(), runner, repo: r0, agent: 'claude', cwd: CWD, prefs: { set: () => {}, defaultEffort: () => 'max' },
  });
  assert.equal(r.status, 202);
  assert.equal(effortOf(seen.args), 'max');
  assert.ok(!seen.args.includes('--model'), '模型不钉死：显式传 claude-opus-5-5 会丢掉 1M 上下文');
});

test('新建：选了模型就不塞默认强度，选了强度就用选的', async () => {
  const a = capture();
  await createSession({
    ...base(), runner: a.runner, repo: a.repo, agent: 'claude', cwd: CWD, model: 'claude-sonnet-5',
    prefs: { set: () => {}, defaultEffort: () => 'max' },
  });
  assert.equal(effortOf(a.seen.args), null);
  const b = capture();
  await createSession({
    ...base(), runner: b.runner, repo: b.repo, agent: 'claude', cwd: CWD, effort: 'low',
    prefs: { set: () => {}, defaultEffort: () => 'max' },
  });
  assert.equal(effortOf(b.seen.args), 'low');
});

// ── 名字由模型起（owner 2026-10-08：「让他自己去取标题」）──────────────

/** 起名慢（实测 6–11 秒），所以每条都要能单独控制它什么时候回来。 */
function titleLater() {
  const d = deferred();
  return { promise: d.promise, give: d.resolve, titler: () => d.promise };
}

test('新建：不等起名字——它慢，而这一屏等的是第一轮', { timeout: 5000 }, async () => {
  const w = world();
  const slow = titleLater();
  const r = await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD,
    message: '修一下手机上发消息之后那个转圈一直不停的问题，我这边点了发送就一直在转',
    titler: slow.titler, registrar: () => 'C:\\reg\\local_x.json',
  });
  assert.equal(r.status, 202, '名字还没起回来，会话已经建好返回了');
  slow.give(null);
});

test('新建：名字起回来就换上注册项的标题', { timeout: 5000 }, async () => {
  const w = world();
  const slow = titleLater();
  const seen = { reg: null, retitled: [] };
  const r = await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD,
    message: '修一下手机上发消息之后那个转圈一直不停的问题，我这边点了发送就一直在转',
    titler: slow.titler,
    registrar: (a) => { seen.reg = a; return 'C:\\reg\\local_x.json'; },
    retitle: (file, t) => { seen.retitled.push([file, t]); return true; },
  });
  assert.ok(seen.reg.title.startsWith('修一下手机上发消息'), '先按首句写，别让会话一开始没名字');
  assert.deepEqual(seen.retitled, [], '还没起回来之前不许动');

  slow.give('修发送转圈不停');
  await r.settled;
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen.retitled, [['C:\\reg\\local_x.json', '修发送转圈不停']]);
});

test('新建：没起到名字、起名炸了、注册项没写成——都不碰标题，也不影响建会话', { timeout: 5000 }, async () => {
  for (const titler of [async () => null, async () => { throw new Error('起名炸了'); }]) {
    const w = world();
    const retitled = [];
    const r = await createSession({
      ...base(), repo: w.repo, runner: w.runner, agent: 'claude', cwd: CWD,
      titler, retitle: (f, t) => { retitled.push([f, t]); return true; },
    });
    assert.equal(r.status, 202);
    await r.settled;
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(retitled, []);
  }

  const w2 = world();
  const retitled2 = [];
  const r2 = await createSession({
    ...base(), repo: w2.repo, runner: w2.runner, agent: 'claude', cwd: CWD,
    titler: async () => '起好的名字',
    registrar: () => { throw new Error('注册表目录找不到'); },
    retitle: (f, t) => { retitled2.push([f, t]); return true; },
  });
  assert.equal(r2.status, 202, '注册项写不成也照样建会话');
  await r2.settled;
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(retitled2, [], '没有注册项可改');
});

test('新建：codex 不起名——它的名字在 Codex App 自己的索引里，Baton 不写那个文件', async () => {
  const w = world();
  let called = false;
  await createSession({
    ...base(), repo: w.repo, runner: w.runner, agent: 'codex', cwd: CWD,
    titler: () => { called = true; return Promise.resolve('x'); },
  });
  assert.equal(called, false);
});
