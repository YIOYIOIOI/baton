import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import {
  normalizeAsk, formatAnswer, ASK_TOOL, ASK_HEADER, ASK_TIMEOUT_TEXT, ASK_CANCELLED_TEXT,
} from '../src/ask/protocol.js';
import {
  openAsk, answerAsk, cancelAsk, pendingAsk, pendingCount,
  mintAskToken, resolveAskToken, revokeAskToken, reconcileAsks,
} from '../src/ask/store.js';
import { shellPath, loopbackUrl, prepareAsk, reconcileAskConfigs } from '../src/ask/setup.js';
import { buildClaudeArgs, buildClaudeNewArgs } from '../src/agent/args.js';
import { tmpDir, writeJsonl } from './helpers.js';

/**
 * 「让 agent 出选择题」。
 *
 * 这套东西的每一条设计依据都来自 2026-09-24 的实测，依据写在
 * src/ask/protocol.js 的抬头里；这里测的是实现本身。
 *
 * 两条最容易在重构里被悄悄改掉、而改掉之后没有任何报错的性质，各有一条测试钉住：
 *
 *   1. **新建会话那一轮不能开提问通道**——createSession 会 await 到第一轮跑完，
 *      此时客户端还在「新建」那一屏，问题推不到任何地方，开了就是一次 4 分钟死等
 *   2. **身份只认令牌，不读请求体**——读了的话 agent 就能自报别人的会话
 */

const TOKEN = 'c'.repeat(64);

function boot(configOverrides = {}) {
  const claudeRoot = tmpDir();
  const OWN = 'aaaaaaaa-0000-0000-0000-00000000000a';
  writeJsonl(claudeRoot, path.join('C--proj', `${OWN}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '第一句' } },
  ]);
  const stateFile = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));
  const repo = createRepo({
    claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: stateFile,
  });
  const auth = createAuth({ token: TOKEN });
  const server = createServer({
    repo, auth, config: { host: '127.0.0.1', port: 0, allowSend: true, ...configOverrides },
  });
  return { server, auth, repo };
}

async function withServer(fn, configOverrides) {
  const ctx = boot(configOverrides);
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  try {
    await fn({ ...ctx, base });
  } finally {
    await new Promise((r) => ctx.server.close(r));
  }
}

const cookieOf = (auth) =>
  `baton_session=${/baton_session=([^;]+)/.exec(auth.verifyPair(auth.newPairingCode()).setCookie)[1]}`;

const OPTS = [{ label: 'A 先写测试' }, { label: 'B 先写实现', description: '代价是返工' }];

/* ── 参数整形 ──────────────────────────────────────────────────────────── */

test('没有问题文本就拒绝，并把原因告诉 agent', () => {
  assert.match(normalizeAsk({ options: OPTS }).error, /question/);
  assert.match(normalizeAsk({ question: '   ', options: OPTS }).error, /question/);
});

test('少于两个可区分选项就拒绝——只有一个按钮的卡片点不出区别', () => {
  assert.match(normalizeAsk({ question: '选哪个？', options: [{ label: 'A' }] }).error, /2 个/);
  // 重复项去掉之后只剩一个，同样不合格
  assert.match(
    normalizeAsk({ question: '选哪个？', options: [{ label: 'A' }, { label: 'A' }] }).error,
    /2 个/,
  );
});

test('裸字符串选项照收——模型最省事的写法不该被判不合格', () => {
  const { ask } = normalizeAsk({ question: '选哪个？', options: ['甲', '乙'] });
  assert.deepEqual(ask.options, [
    { label: '甲', description: null },
    { label: '乙', description: null },
  ]);
  assert.equal(ask.multiSelect, false);
});

test('选项封顶 8 个，超出部分丢掉而不是报错', () => {
  const many = Array.from({ length: 20 }, (_, i) => `选项${i}`);
  const { ask } = normalizeAsk({ question: '选哪个？', options: many });
  assert.equal(ask.options.length, 8);
});

test('回答交回 agent 的句式照抄 AskUserQuestion 的实测样本', () => {
  const s = formatAnswer({ question: '选哪个？', picked: ['A 先写测试'] });
  assert.match(s, /^The user answered: "选哪个？"="A 先写测试"\./);
});

test('选中项与自己写的那段可以同时出现', () => {
  const s = formatAnswer({ question: 'Q', picked: ['甲'], free: '其实我想先看看数据' });
  assert.match(s, /"甲、其实我想先看看数据"/);
});

/* ── 令牌 ─────────────────────────────────────────────────────────────── */

test('令牌自己说明是哪个会话哪一轮；撤了就认不出', () => {
  const t = mintAskToken({ key: 'claude:k', turnId: 't1' });
  assert.deepEqual(resolveAskToken(t), { key: 'claude:k', turnId: 't1' });
  revokeAskToken(t);
  assert.equal(resolveAskToken(t), null);
  assert.equal(resolveAskToken('不存在的令牌'), null);
  assert.equal(resolveAskToken(undefined), null);
});

/* ── 待答存储 ─────────────────────────────────────────────────────────── */

test('开一道题：落盘、可查、可答，答完盘上那份就没了', async () => {
  const dir = tmpDir();
  const key = 'claude:s1';
  const { ask, promise } = openAsk(
    { key, turnId: 't', question: '选哪个？', options: OPTS, multiSelect: false }, { dir },
  );
  const file = path.join(dir, 'asks', `${encodeURIComponent(key)}.json`);
  assert.ok(fs.existsSync(file), '挂起期间必须落盘：手机断连是常态，重连要补得回来');
  assert.equal(pendingAsk(key)?.askId, ask.askId);

  const r = answerAsk({ key, askId: ask.askId, picked: ['A 先写测试'] }, { dir });
  assert.equal(r.ok, true);
  assert.match(await promise, /"A 先写测试"/);
  assert.equal(pendingAsk(key), null);
  assert.equal(fs.existsSync(file), false);
});

test('答案只认给定的 label——别的字符串一律不作数', () => {
  const dir = tmpDir();
  const key = 'claude:s2';
  const { ask } = openAsk({ key, turnId: 't', question: 'Q', options: OPTS }, { dir });
  const r = answerAsk({ key, askId: ask.askId, picked: ['我自己编的选项'] }, { dir });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_answer');
  cancelAsk(key, ASK_CANCELLED_TEXT, { dir });
});

test('单选题塞两个选项要挡住，不能悄悄只取第一个', () => {
  const dir = tmpDir();
  const key = 'claude:s3';
  const { ask } = openAsk({ key, turnId: 't', question: 'Q', options: OPTS, multiSelect: false }, { dir });
  const r = answerAsk({ key, askId: ask.askId, picked: ['A 先写测试', 'B 先写实现'] }, { dir });
  assert.equal(r.reason, 'single_only');
  cancelAsk(key, ASK_CANCELLED_TEXT, { dir });
});

test('多选题可以一次选两个', async () => {
  const dir = tmpDir();
  const key = 'claude:s4';
  const { ask, promise } = openAsk(
    { key, turnId: 't', question: 'Q', options: OPTS, multiSelect: true }, { dir },
  );
  assert.equal(answerAsk({ key, askId: ask.askId, picked: ['A 先写测试', 'B 先写实现'] }, { dir }).ok, true);
  assert.match(await promise, /"A 先写测试、B 先写实现"/);
});

test('过期的卡片答不进去——断线期间这轮可能已经换了一道题', () => {
  const dir = tmpDir();
  const key = 'claude:s5';
  openAsk({ key, turnId: 't', question: 'Q', options: OPTS }, { dir });
  const r = answerAsk({ key, askId: '不是现在这一道', picked: ['A 先写测试'] }, { dir });
  assert.equal(r.reason, 'stale');
  cancelAsk(key, ASK_CANCELLED_TEXT, { dir });
});

test('没人在等的时候回答不会假装成功', () => {
  assert.equal(answerAsk({ key: 'claude:没有这个会话', picked: ['A'] }).reason, 'no_pending');
});

test('超时之后 agent 拿到的是一句能让它自己收尾的话，不是挂着', async () => {
  const dir = tmpDir();
  const key = 'claude:s6';
  const { promise } = openAsk(
    { key, turnId: 't', question: 'Q', options: OPTS }, { dir, timeoutMs: 20 },
  );
  assert.equal(await promise, ASK_TIMEOUT_TEXT);
  assert.equal(pendingAsk(key), null);
});

test('同一个会话再开一道题，上一道当场作废——屏幕上不该同时挂两张卡', async () => {
  const dir = tmpDir();
  const key = 'claude:s7';
  const first = openAsk({ key, turnId: 't', question: '第一道', options: OPTS }, { dir });
  const second = openAsk({ key, turnId: 't', question: '第二道', options: OPTS }, { dir });
  assert.equal(await first.promise, ASK_CANCELLED_TEXT);
  assert.equal(pendingAsk(key).question, '第二道');
  cancelAsk(key, ASK_CANCELLED_TEXT, { dir });
  assert.equal(await second.promise, ASK_CANCELLED_TEXT);
});

test('题结束后不留定时器也不留条目', async () => {
  const dir = tmpDir();
  const before = pendingCount();
  const key = 'claude:s8';
  const { ask, promise } = openAsk({ key, turnId: 't', question: 'Q', options: OPTS }, { dir });
  answerAsk({ key, askId: ask.askId, picked: ['A 先写测试'] }, { dir });
  await promise;
  assert.equal(pendingCount(), before);
});

test('启动时清掉盘上的残留——真相是那条挂着的响应，它随上个进程一起没了', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'asks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'asks', 'x.json'), '{}');
  assert.equal(reconcileAsks({ dir }), 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'asks')), []);
});

/* ── 每轮配置 ─────────────────────────────────────────────────────────── */

test('带空格的路径进 argv 要加引号——shell:true 下参数只拼接不转义', () => {
  assert.equal(shellPath('C:\\Users\\a\\.baton\\x.json'), 'C:\\Users\\a\\.baton\\x.json');
  assert.equal(shellPath('C:\\Program Files\\x.json'), '"C:\\Program Files\\x.json"');
  assert.equal(shellPath('C:\\tmp\\a&b\\x.json'), '"C:\\tmp\\a&b\\x.json"');
  assert.equal(shellPath('C:\\tmp\\a(1)\\x.json'), '"C:\\tmp\\a(1)\\x.json"');
  assert.throws(() => shellPath('C:\\bad\npath'));
});

test('回连地址走回环——监听在 0.0.0.0 时那不是一个可连的目标', () => {
  assert.equal(loopbackUrl({ host: '0.0.0.0', port: 3002 }), 'http://127.0.0.1:3002');
  assert.equal(loopbackUrl({ host: '127.0.0.1', port: 3002 }), 'http://127.0.0.1:3002');
  assert.equal(loopbackUrl({ host: '::', port: 3002 }), 'http://127.0.0.1:3002');
});

test('每轮的 MCP 配置带令牌、0600、跑完删掉', () => {
  const dir = tmpDir();
  const ask = prepareAsk({ key: 'claude:k', turnId: 'turn-1', baseUrl: 'http://127.0.0.1:1', dir });
  const conf = JSON.parse(fs.readFileSync(ask.configPath, 'utf8'));
  assert.equal(conf.mcpServers.baton.env.BATON_ASK_TOKEN, ask.token);
  assert.equal(conf.mcpServers.baton.env.BATON_ASK_URL, 'http://127.0.0.1:1');
  assert.ok(conf.mcpServers.baton.args[0].endsWith('mcp.js'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(ask.configPath).mode & 0o777, 0o600);
  }
  assert.ok(resolveAskToken(ask.token));
  ask.cleanup();
  assert.equal(fs.existsSync(ask.configPath), false);
  assert.equal(resolveAskToken(ask.token), null, '跑完令牌必须作废，否则它能一直往这个会话推问题');
});

test('缺少回连地址就不开这一轮的提问通道', () => {
  assert.equal(prepareAsk({ key: 'k', turnId: 't', baseUrl: '' }), null);
  assert.equal(prepareAsk({ key: 'k', turnId: null, baseUrl: 'http://x' }), null);
});

test('启动时清掉上次跑剩的每轮配置——里面是已作废的令牌', () => {
  const dir = tmpDir();
  const ask = prepareAsk({ key: 'k', turnId: 't', baseUrl: 'http://127.0.0.1:1', dir });
  assert.equal(reconcileAskConfigs({ dir }), 1);
  assert.equal(fs.existsSync(ask.configPath), false);
  revokeAskToken(ask.token);
});

/* ── 启动参数 ─────────────────────────────────────────────────────────── */

const SID = 'aaaaaaaa-0000-0000-0000-00000000000b';

test('续写这一轮带上 --mcp-config 与只放行一个工具的白名单', () => {
  const args = buildClaudeArgs({ sessionId: SID, ask: { configPath: 'C:\\x\\t.json' } });
  const i = args.indexOf('--mcp-config');
  assert.ok(i > 0);
  assert.equal(args[i + 1], 'C:\\x\\t.json');
  assert.equal(args[args.indexOf('--allowedTools') + 1], ASK_TOOL);
});

test('不给 ask 就一个参数都不加——老会话与老测试的行为一字不变', () => {
  const args = buildClaudeArgs({ sessionId: SID });
  assert.equal(args.includes('--mcp-config'), false);
  assert.equal(args.includes('--allowedTools'), false);
});

test('新建会话那一轮不开提问通道：那一屏根本没有地方显示问题', () => {
  const args = buildClaudeNewArgs({ sessionId: SID });
  assert.equal(args.includes('--mcp-config'), false);
  assert.equal(args.includes('--allowedTools'), false);
});

/* ── HTTP 端到端 ──────────────────────────────────────────────────────── */

test('POST /api/ask 一直挂着，直到有人在会话里答了它', async () => {
  await withServer(async ({ base, auth, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-x' });

    let settled = false;
    const held = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: '选哪个？', options: ['甲', '乙'] }),
    }).then(async (r) => { settled = true; return r.json(); });

    // 给它时间走到「挂起」为止；此时绝不能已经返回
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, false, '这条响应必须挂着——挂住它就是挂住 agent 那一轮');
    assert.equal(pendingAsk(key)?.question, '选哪个？');

    const ans = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieOf(auth) },
      body: JSON.stringify({ askId: pendingAsk(key).askId, picked: ['乙'] }),
    });
    assert.equal(ans.status, 200);
    assert.match((await held).answer, /"乙"/);
    revokeAskToken(token);
  });
});

test('令牌不对就拒——身份不从请求体读，读了 agent 就能推到别人手机上', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: 'forged-token' },
      body: JSON.stringify({ question: 'Q', options: ['甲', '乙'], key: 'claude:别人的会话' }),
    });
    assert.equal(res.status, 401);
    assert.ok((await res.json()).error.fix);
  });
});

test('参数不合格时把原因返给 agent，让它改正而不是把半张卡推给用户', async () => {
  await withServer(async ({ base, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-y' });
    const res = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: 'Q', options: ['只有一个'] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /2 个/);
    assert.equal(pendingAsk(key), null, '不合格的题绝不能挂起');
    revokeAskToken(token);
  });
});

test('只读模式下答不进去——和发消息同一条纪律', async () => {
  await withServer(async ({ base, auth, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-z' });
    const held = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: 'Q', options: ['甲', '乙'] }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 120));

    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieOf(auth) },
      body: JSON.stringify({ askId: pendingAsk(key).askId, picked: ['甲'] }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'send_disabled');

    cancelAsk(key);
    await held;
    revokeAskToken(token);
  }, { allowSend: false });
});

test('会话状态里带着待答问题——重连后那张卡要自己回来', async () => {
  await withServer(async ({ base, auth, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-w' });
    const held = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: '还在等你', options: ['甲', '乙'] }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 120));

    const st = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/state`, {
      headers: { Cookie: cookieOf(auth) },
    }).then((r) => r.json());
    assert.equal(st.pendingAsk.question, '还在等你');
    assert.equal(st.pendingAsk.options.length, 2);

    cancelAsk(key);
    await held;
    revokeAskToken(token);
  });
});

test('访客答不了 owner 会话里的题——工作区隔离这条不能有例外', async () => {
  /*
    这条是冲着已经栽过的那个口子来的：访客配对后看到了 owner 的工作区。
    答题端点是**新开的一条能把内容送进 agent 的路**，它必须和发消息受同一层约束。

    实现上靠的是路由走会话路径（`/api/sessions/:key/answer`），于是 scopeRepo
    那层自动生效、handler 一个字都不用写。但「靠某某自动生效」正是最该钉住的
    那类性质——它可以在一次看似无关的重构里悄悄失效，而且没有任何报错。
  */
  const ctx = boot();
  // friend 的根指向一个空目录，所以 owner 那条会话必然在他视野之外
  ctx.auth = createAuth({
    token: TOKEN,
    principals: [
      { id: 'owner', roots: null },
      { id: 'friend', roots: [tmpDir()] },
    ],
  });
  const server = createServer({
    repo: ctx.repo, auth: ctx.auth, config: { host: '127.0.0.1', port: 0, allowSend: true },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const key = ctx.repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-guest' });
    const held = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: 'Q', options: ['甲', '乙'] }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 120));

    const guest = `baton_session=${/baton_session=([^;]+)/.exec(
      ctx.auth.verifyPair(ctx.auth.newPairingCode('friend')).setCookie,
    )[1]}`;
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: guest },
      body: JSON.stringify({ askId: pendingAsk(key).askId, picked: ['甲'] }),
    });
    assert.equal(res.status, 404, '对访客来说这个会话根本不存在，不该暴露「有但你不能答」');
    assert.ok(pendingAsk(key), '被拒之后那道题必须还挂着——owner 回来仍要能答');

    cancelAsk(key);
    await held;
    revokeAskToken(token);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('连接断了就撤题——那一轮的进程已经没了，卡留着也没人接', async () => {
  await withServer(async ({ base, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const token = mintAskToken({ key, turnId: 'turn-v' });
    const ctl = new AbortController();
    const held = fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: token },
      body: JSON.stringify({ question: 'Q', options: ['甲', '乙'] }),
      signal: ctl.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(pendingAsk(key));

    ctl.abort();
    await held;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pendingAsk(key), null);
    revokeAskToken(token);
  });
});
