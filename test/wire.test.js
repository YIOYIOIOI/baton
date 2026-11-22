import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { truncatePayload, eventsFor, eventsForFull } from '../src/wire.js';
import { pageEvents } from '../src/paginate.js';
import { createFollower } from '../src/follow.js';
import { getEventFull } from '../src/http/handlers/sessions.js';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { tmpDir } from './helpers.js';

// 真实语料实测：单条 tool.output 最长 347,481 字，一页 50 条事件 418.7 KB。
// 整条塞进 SSE 既拖死手机滚动，也把「断连补上 N 条」的滚动锚定弄坏。

const HUGE = 'A'.repeat(50_000) + '【尾部才有的关键信息】';

function fixture() {
  const root = tmpDir();
  const id = 'aaaaaaaa-0000-0000-0000-0000000000ff';
  const dir = path.join(root, 'C--proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: 'user', sessionId: id, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '跑一下测试' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T03:00:01Z', isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'B'.repeat(9000) } }] } },
    { type: 'user', sessionId: id, uuid: 'u2', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: HUGE }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { member: { key: 'claude:fix', agent: 'claude', file, providerId: id, cwd: 'C:\\proj' }, file, root };
}

// 走真实 HTTP 的夹具。查询参数的语义只有在这里才是真的：
// URLSearchParams.get() 缺参数返回 null，而直接调函数传的是 undefined。
async function withHttp(fn) {
  const { root } = fixture();
  const repo = createRepo({
    claudeRoot: root, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: null,
  });
  const TOKEN = 'c'.repeat(64);
  const server = createServer({
    repo, auth: createAuth({ token: TOKEN }),
    config: { host: '127.0.0.1', port: 0, allowSend: false },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: `Bearer ${TOKEN}` };
  try {
    const key = repo.listChains()[0].members[0].key;
    await fn({ base, H, key, get: (p) => fetch(`${base}${p}`, { headers: H }) });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── 截断本身 ────────────────────────────────────

test('短载荷原样放行，不加任何元数据', () => {
  const r = truncatePayload('很短');
  assert.equal(r.value, '很短');
  assert.equal(r.truncation, null);
});

test('超长载荷首尾都留——失败信息几乎总在尾部', () => {
  const r = truncatePayload(HUGE);
  assert.ok(r.value.length < HUGE.length / 10);
  assert.ok(r.value.startsWith('A'.repeat(100)), '开头要留');
  assert.ok(r.value.endsWith('【尾部才有的关键信息】'), '尾部必须留，否则最该看的那段被扔掉');
  assert.match(r.value, /省略 \d+ 字/);
  assert.equal(r.truncation.totalChars, HUGE.length);
});

// ── 两条出网路径都必须截断 ────────────────────────

test('分页路径截断 tool.output 与 tool.input', async () => {
  const { member } = fixture();
  const { events } = await pageEvents(member, { limit: 50 });

  const result = events.find((e) => e.kind === 'tool_result');
  assert.ok(result.tool.output.length < 5000, `分页没截断：${result.tool.output.length} 字`);
  assert.equal(result.truncation.output.totalChars, HUGE.length);

  const call = events.find((e) => e.kind === 'tool_call');
  assert.ok(JSON.stringify(call.tool.input).length < 5000, '超长 input 同样要截');
  assert.ok(call.truncation.input);
});

test('tail-follow 路径同样截断——两条路径漏一条就等于没做', () => {
  const { member, file } = fixture();
  const seen = [];
  const f = createFollower(member, (evs) => seen.push(...evs), { fromOffset: 0 });
  f.tick();

  const result = seen.find((e) => e.kind === 'tool_result');
  assert.ok(result, 'follower 该产出 tool_result');
  assert.ok(result.tool.output.length < 5000, `SSE 路径没截断：${result.tool.output.length} 字`);
  assert.ok(String(fs.readFileSync(file)).includes(HUGE), '原始文件不受影响，截断只发生在出网时');
});

test('text 不截——它是用户真正要读的回答', async () => {
  const root = tmpDir();
  const id = 'aaaaaaaa-0000-0000-0000-0000000000ee';
  const dir = path.join(root, 'C--proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const long = '答'.repeat(17_000); // 实测 text 最长 17,751 字
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T03:00:00Z', isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: long }] },
  }) + '\n');
  const member = { key: 'claude:t', agent: 'claude', file, providerId: id, cwd: 'C:\\proj' };
  const { events } = await pageEvents(member, { limit: 10 });
  assert.equal(events[0].text.length, long.length, 'text 截了等于藏答案');
});

test('事件带 offset——没有它取全文就得扫完整个 transcript（实测最大 175 MB）', async () => {
  const { member } = fixture();
  const { events } = await pageEvents(member, { limit: 50 });
  for (const e of events) assert.equal(typeof e.offset, 'number');
});

// ── 取全文 ──────────────────────────────────────

test('按 offset + 事件 id 取回未截断的全文', async () => {
  const { member } = fixture();
  const repo = { getSession: (k) => (k === member.key ? member : null) };
  const ev = (await pageEvents(member, { limit: 50 })).events.find((e) => e.kind === 'tool_result');

  const r = getEventFull(repo, member.key, ev.id, { offset: ev.offset });
  assert.equal(r.status, 200);
  assert.equal(r.body.totalChars, HUGE.length);
  assert.equal(r.body.text, HUGE);
  assert.equal(r.body.hasMore, false);
});

test('取指定事件全文，读到行尾就停止读取后续转录', async (t) => {
  const { member, file } = fixture();
  const first = (await pageEvents(member)).events[0];
  fs.appendFileSync(file, Buffer.alloc(2 * 1024 * 1024, 32));
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    bytes += count;
    return count;
  });
  const r = getEventFull({ getSession: () => member }, member.key, first.id, { offset: first.offset });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, first.text);
  assert.ok(bytes <= 64 * 1024, `读取了 ${bytes} 字节`);
});

test('支持按字符区间续取——347 KB 一次推给手机同样不合适', async () => {
  const { member } = fixture();
  const repo = { getSession: () => member };
  const ev = (await pageEvents(member, { limit: 50 })).events.find((e) => e.kind === 'tool_result');

  const r = getEventFull(repo, member.key, ev.id, { offset: ev.offset, from: 0, to: 100 });
  assert.equal(r.body.text.length, 100);
  assert.equal(r.body.hasMore, true);
  assert.equal(r.body.totalChars, HUGE.length);
});

test('不带 offset 时拒绝并说清为什么', () => {
  const { member } = fixture();
  const repo = { getSession: () => member };
  const r = getEventFull(repo, member.key, 'x#0', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'missing_offset');
  assert.match(r.body.error.fix, /offset/);
});

test('偏移已越过文件末尾时给出可操作的 409，而不是崩', () => {
  const { member } = fixture();
  const repo = { getSession: () => member };
  const r = getEventFull(repo, member.key, 'x#0', { offset: 99_999_999 });
  assert.equal(r.status, 409);
  assert.match(r.body.error.fix, /重新拉一页/);
});

test('eventsForFull 是唯一豁免路径，确实不截断', () => {
  const { member } = fixture();
  const records = [{
    type: 'user', sessionId: 'x', uuid: 'u', timestamp: '2026-09-08T03:00:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: HUGE }] },
  }];
  const wired = eventsFor(member, records)[0];
  const full = eventsForFull(member, records)[0];
  assert.ok(wired.tool.output.length < 5000);
  assert.equal(full.tool.output.length, HUGE.length);
});

// ── 真实 HTTP：查询参数的语义只有在这一层才是真的 ──

test('走 HTTP 取全文：省略 from/to 时必须返回完整内容', async () => {
  // 曾经的 bug：URLSearchParams.get('to') 缺参数返回 null，Number(null) === 0，
  // 于是 slice(0, 0) 返回空串。单测直接传 undefined（Number(undefined) 是 NaN）
  // 全绿，只有真实请求能暴露。
  await withHttp(async ({ get, key }) => {
    const page = await (await get(`/api/sessions/${encodeURIComponent(key)}/events?limit=50`)).json();
    const ev = page.events.find((e) => e.truncation?.output);
    assert.ok(ev, '夹具里该有被截断的事件');

    const u = `/api/sessions/${encodeURIComponent(key)}/events/${encodeURIComponent(ev.id)}/full`;
    const body = await (await get(`${u}?offset=${ev.offset}`)).json();
    assert.equal(body.totalChars, HUGE.length);
    assert.equal(body.text.length, body.totalChars, '省略 to 时必须给全文，不是空串');
    assert.equal(body.text, HUGE);
    assert.equal(body.hasMore, false);
  });
});

test('走 HTTP 取全文：省略 offset 必须报 400，而不是从文件开头读', async () => {
  // 同一个根因：Number(null) === 0 会让「没传 offset」变成「传了 offset=0」，
  // 校验形同虚设。
  await withHttp(async ({ get, key }) => {
    const u = `/api/sessions/${encodeURIComponent(key)}/events/${encodeURIComponent('x#0')}/full`;
    const res = await get(u);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'missing_offset');
  });
});

test('走 HTTP 取全文：区间续取', async () => {
  await withHttp(async ({ get, key }) => {
    const page = await (await get(`/api/sessions/${encodeURIComponent(key)}/events?limit=50`)).json();
    const ev = page.events.find((e) => e.truncation?.output);
    const u = `/api/sessions/${encodeURIComponent(key)}/events/${encodeURIComponent(ev.id)}/full`;

    const b = await (await get(`${u}?offset=${ev.offset}&from=0&to=50`)).json();
    assert.equal(b.text.length, 50);
    assert.equal(b.hasMore, true);

    const tailStart = HUGE.length - 20;
    const t = await (await get(`${u}?offset=${ev.offset}&from=${tailStart}`)).json();
    assert.equal(t.text, HUGE.slice(tailStart), '省略 to 时取到末尾');
    assert.equal(t.hasMore, false);
  });
});

test('所有响应带 X-Baton——客户端要分得清 Baton 与中间设备', async () => {
  await withHttp(async ({ base, get }) => {
    assert.equal((await get('/api/sessions')).headers.get('x-baton'), '1');
    assert.equal((await fetch(`${base}/`)).headers.get('x-baton'), '1', '静态资源也要带');
    const bad = await get('/api/不存在');
    assert.equal(bad.headers.get('x-baton'), '1', '404 也要带，否则分不清是 Baton 回的还是中间设备回的');
  });
});

// ── 结构性：不许绕过唯一出口 ──────────────────────

test('分页与 tail-follow 不得直接引用 claudeEvents/codexEvents', () => {
  // 它们曾各自持有 agent → 转换函数 的分派，于是任何出网前的处理都要在两处
  // 各做一遍，做漏一处就是超长载荷直接进隧道。唯一出口收在 wire.js。
  for (const f of ['src/paginate.js', 'src/follow.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/claudeEvents|codexEvents/.test(src),
      `${f} 绕过了 wire.js 的唯一出口——出网处理会漏做`);
    assert.match(src, /from '\.\/wire\.js'/, `${f} 必须经由 wire.js`);
  }
});

test('截断不丢 tool.failed——出错的输出往往正是最长的那种', () => {
  const evs = eventsFor({ agent: 'claude' }, [
    { type: 'user', uuid: 'u9', isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: HUGE, is_error: true }] } },
  ]);
  const r = evs.find((e) => e.kind === 'tool_result');
  assert.ok(r.truncation?.output, '这条要真的被截断，才测得到');
  assert.equal(r.tool.failed, true);
});
