import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRoutes, ROUTED_HANDLERS } from '../src/http/routes.js';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { OWNER } from '../src/principals.js';
import { tmpDir, writeJsonl } from './helpers.js';

// 所有 handler 模块的导出。直接读目录：以后新加一个模块，也自动在下面的对账范围里。
// （2026-10-01 之前这些都在一个 1661 行的 src/http/api.js 里。）
const HANDLERS_DIR = new URL('../src/http/handlers/', import.meta.url);
const api = {};
for (const f of fs.readdirSync(HANDLERS_DIR).filter((n) => n.endsWith('.js'))) {
  Object.assign(api, await import(new URL(f, HANDLERS_DIR)));
}

// 这个文件存在是为了修一类事故，不是为了覆盖率：
// /state 的正则漏了分支、/stop 整条路由没加，而两者的 handler 单测都是绿的。
// handler 单测测不到「可达性」。

const TOKEN = 'c'.repeat(64);

// handlers/ 里不需要路由的导出。新增 handler 若既不在这里、也不在路由表里，
// 下面的对账测试就会红——这就是那条可枚举的不变式。
const NOT_REQUEST_HANDLERS = new Set([
  // 断线续传的辅助：把客户端给的 Last-Event-ID / ?from= 解析成一个能用的起点，
  // 由 streamSession 自己调。它不是端点——给它开路由等于让外部直接指挥重放。
  'resumeOffset',
  'MAX_REPLAY_BYTES',
  'visibleCwds',      // 列表的 cwds 字段与目录浏览起点的数据源
  'sessionUploadDestination', 'cwdUploadDestination', // 上传前校验目标，随后由对应端点落盘
  'defaultRunner',    // agent 进程启动器
  'defaultRegistrar', // 注册项写入器
  'liveTurns',        // turnId -> kill 的内存表
  // 队列的消费侧。触发者是「上一轮结束」和「守护进程启动」，不是 HTTP 请求——
  // 给它们开路由等于给外部一个「立刻抢跑队列」的入口，那正是队列要防的并发。
  'drainQueue',
  'reconcileQueues',
  // Codex 目标的「接着干」：触发者是「上一轮 ok 地结束、目标还 active」，不是 HTTP 请求——
  // 开路由等于给外部一个「再起一轮」的入口。和它配套的几个常量一并不算
  'continueGoal',
  'MAX_GOAL_RUNS',
  'GOAL_CONTINUE',
  'GOAL_IN_APP_NOTE',
  // 定时排空的看门狗：电脑上那轮跑完时没人通知 Baton，只能自己盯。
  // 由 cli.js 在 listen 之后开，同样不是端点。
  'watchQueues',
  // 推送发送侧。触发者是「轮次跑完」，不是 HTTP 请求。
  'defaultPushSend',
  /*
    agent 送选择题过来的那个入口。它**确实**是个端点（POST /api/ask），但
    **不在这张路由表里**，而是接在 server.js 里 authorize 之前——和 /api/pair、
    /api/unpair 同一类。

    理由：打它的不是人，是 claude 拉起的 MCP 服务器，它没有任何人的凭据。
    这张路由表上的每一条都跑在「已认证的 principal + 收窄过的 repo」之后，
    把一个无凭据端点塞进来，等于在那层保证上开一个例外——那种例外迟早会被
    别的 handler 顺手用上。它自己认一次性令牌，见 src/ask/store.js。
  */
  'postAsk',
]);

function boot() {
  const claudeRoot = tmpDir();
  const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
  writeJsonl(claudeRoot, path.join('C--proj', `${OWN}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '第一句' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T03:00:05Z', isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: '回复一' }] } },
  ]);
  const stateFile = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));

  const repo = createRepo({
    claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: stateFile,
  });
  const config = { host: '127.0.0.1', port: 0, allowSend: false };
  const auth = createAuth({ token: TOKEN });
  const terminalLauncher = async ({ member }) => ({
    ok: true,
    terminal: 'mock',
    agent: member.agent,
    cwd: member.cwd,
    sessionId: member.providerId,
  });
  return {
    repo,
    config,
    auth,
    terminalLauncher,
    routes: buildRoutes({ auth, terminalLauncher }),
  };
}

test('路由表与 handler 清单双向一致', () => {
  const { routes } = boot();
  const inTable = routes.map((r) => r.name).sort();
  assert.deepEqual(inTable, [...ROUTED_HANDLERS].sort(),
    'ROUTED_HANDLERS 与路由表必须一一对应');
});

test('handlers/ 导出的每个请求 handler 都登记了路由', () => {
  const exported = Object.keys(api).filter((k) => !NOT_REQUEST_HANDLERS.has(k));
  const routed = new Set(ROUTED_HANDLERS);
  const unrouted = exported.filter((k) => !routed.has(k));
  assert.deepEqual(unrouted, [],
    `这些 handler 没有可达路由：${unrouted.join(', ')}。`
    + '要么在 routes.js 里登记，要么加进 NOT_REQUEST_HANDLERS 并说明为什么不需要路由。');
});

test('每条路由都能被真实请求命中（不返回 404）', async () => {
  const ctx = boot();
  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
  const sampleKey = list.chains[0].members[0].key;

  try {
    for (const route of ctx.routes) {
      const url = `${base}${route.probe(sampleKey)}`;
      const ctrl = new AbortController();
      const res = await fetch(url, {
        method: route.method,
        headers,
        body: route.method === 'POST' ? '{}' : undefined,
        signal: ctrl.signal,
      });
      // SSE 不会自己结束，取到响应头就够
      if (route.name === 'streamSession') ctrl.abort();

      // 可达性的标志是 error.code，不是状态码本身。server.js 的兜底分支回
      // code='not_found'（「没有这个端点」），而 handler 自己也可能合法地回 404
      // ——比如拿一个不存在的事件 id 去取全文。只看状态码会把后者误判成路由不通。
      if (res.status === 404 && route.name !== 'streamSession') {
        const body = await res.clone().json();
        assert.notEqual(body.error?.code, 'not_found',
          `${route.method} ${route.probe(sampleKey)} 落到了兜底 404——路由不可达（handler: ${route.name}）`);
      }

      if (res.status >= 400 && route.name !== 'streamSession') {
        const body = await res.json();
        assert.notEqual(body.error?.code, 'not_found',
          `${route.name} 落到了兜底 404 分支`);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('未登记的路径仍然返回带 fix 的 404', async () => {
  const ctx = boot();
  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'not_found');
    assert.ok(body.error.fix);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('方法不匹配时不会误命中同路径的另一条路由', async () => {
  const ctx = boot();
  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // /api/sessions 上 GET 是列表、POST 是新建；DELETE 两者都不是
    const res = await fetch(`${base}/api/sessions`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── 铸码的身份闸门 ──────────────────────────────

const GUEST = { id: 'friend', name: 'Alice', roots: ['C:\\ws\\friend'], allowSend: null };

test('访客不能铸配对码——堵住提权', async () => {
  // 加固前：任何已认证者都能铸码，而铸出来的码兑换的是 owner 凭据。
  // 访客铸一个、自己兑一下就成了 owner，工作区隔离当场归零。
  const auth = createAuth({ token: TOKEN, principals: [OWNER, GUEST] });
  const mint = buildRoutes({ auth }).find((r) => r.name === 'mintPairingCode');
  const r = await mint.run({ body: {}, principal: GUEST });
  assert.equal(r.status, 403);
  assert.match(r.body.error.fix, /owner/);
});

test('owner 能给指定身份铸码', async () => {
  const auth = createAuth({ token: TOKEN, principals: [OWNER, GUEST] });
  const mint = buildRoutes({ auth }).find((r) => r.name === 'mintPairingCode');
  const r = await mint.run({ body: { for: 'friend' }, principal: OWNER });
  assert.equal(r.status, 200);
  assert.equal(r.body.for, 'friend');
  assert.equal(auth.verifyPair(r.body.code).principal.id, 'friend');
});

test('给不存在的身份铸码：400 且列出可用身份', async () => {
  const auth = createAuth({ token: TOKEN, principals: [OWNER, GUEST] });
  const mint = buildRoutes({ auth }).find((r) => r.name === 'mintPairingCode');
  const r = await mint.run({ body: { for: 'nobody' }, principal: OWNER });
  assert.equal(r.status, 400);
  assert.match(r.body.error.fix, /friend/);
  assert.match(r.body.error.fix, /principals\.json/);
});
