import { parseChunk } from '../sse';

/**
 * SSE 解析是整个客户端唯一一处"字节流拼装"逻辑，出错的方式又多又安静。
 * 这里每一条都对应一种真实会发生的切法。
 */

const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

test('一次拿到一个完整帧', () => {
  const r = parseChunk(frame('tick', { turnId: 'T', running: true, elapsedMs: 1000, queued: 0 }));
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].type).toBe('tick');
  expect(r.rest).toBe('');
  expect(r.heardFromServer).toBe(true);
});

test('一个 chunk 里有好几个帧', () => {
  const buf = frame('turn_start', { turnId: 'A' }) + frame('events', { events: [] }) + frame('turn_end', { turnId: 'A' });
  const r = parseChunk(buf);
  expect(r.frames.map((f) => f.type)).toEqual(['turn_start', 'events', 'turn_end']);
});

test('半个帧留在 rest 里，下次拼上', () => {
  const whole = frame('tick', { turnId: 'T', running: false, elapsedMs: 0, queued: 0 });
  const cut = Math.floor(whole.length / 2);

  const first = parseChunk(whole.slice(0, cut));
  expect(first.frames).toHaveLength(0);
  expect(first.rest).toBe(whole.slice(0, cut));

  const second = parseChunk(first.rest + whole.slice(cut));
  expect(second.frames).toHaveLength(1);
  expect(second.rest).toBe('');
});

test('注释心跳不产生事件，但算"听到服务器了"', () => {
  // 这条很关键：注释心跳是防 Cloudflare 524 的手段，也是秒表活性的唯一证据。
  // 当垃圾丢掉的话，一个安静但活着的轮次会被误判成断线。
  const r = parseChunk(': ping\n\n');
  expect(r.frames).toHaveLength(0);
  expect(r.heardFromServer).toBe(true);
});

test('开流的 : open 与紧跟其后的帧在同一个 chunk 里', () => {
  // 实测服务端就是这么发的：`: open\n\n` 之后立刻补一帧当前轮次
  const r = parseChunk(': open\n\n' + frame('turn_end', { turnId: 'X', status: 'ok' }));
  expect(r.frames.map((f) => f.type)).toEqual(['turn_end']);
});

test('data 不是合法 JSON 时跳过这一帧，流继续', () => {
  // 宁可少一个事件，也不要让整个会话界面因为一帧坏数据卡死
  const r = parseChunk('event: tick\ndata: {坏的\n\n' + frame('events', { events: [] }));
  expect(r.frames.map((f) => f.type)).toEqual(['events']);
});

test('认不出的帧跳过，不中断整条流', () => {
  const r = parseChunk('id: 7\n\n' + frame('tick', { turnId: null, running: false, elapsedMs: 0, queued: 0 }));
  expect(r.frames).toHaveLength(1);
});

test('data 里含换行的 JSON 不会被截断', () => {
  // [\s\S]* 而不是 .*：工具输出里换行很常见
  const r = parseChunk(frame('events', { events: [{ text: '第一行\n第二行' }] }));
  expect((r.frames[0].data as { events: { text: string }[] }).events[0].text).toBe('第一行\n第二行');
});

/**
 * `id:` 行——SSE 自带的断点续传。
 *
 * 2026-09-24 服务端开始给每帧发 `id: <字节偏移>`，客户端重连时把它作为
 * `Last-Event-ID` 送回去，服务端据此重放断开期间的事件。
 *
 * **这一组是被一次险些发出去的事故逼出来的**：原来的帧正则是 `^event:` 开头，
 * 加了 id 行之后**一帧都匹配不上**，而 `if (!m) continue` 会把它们静默丢掉——
 * 界面看着在线、心跳照常、就是永远不再出新消息。类型检查和构建都不会报。
 */
test('带 id 的帧照样解析，并把 id 交出来', () => {
  const r = parseChunk('id: 4096\nevent: events\ndata: {"events":[]}\n\n');
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].type).toBe('events');
  expect(r.lastId).toBe('4096');
});

test('没有 id 的帧照旧（tick / turn_end 都不带）', () => {
  const r = parseChunk('event: tick\ndata: {"running":false}\n\n');
  expect(r.frames).toHaveLength(1);
  expect(r.lastId).toBeNull();
});

test('一批里有多个 id 时，留最后那个——它才是「推到哪儿了」', () => {
  const r = parseChunk(
    'id: 10\nevent: events\ndata: {"events":[]}\n\n'
    + 'event: tick\ndata: {"running":true}\n\n'
    + 'id: 99\nevent: events\ndata: {"events":[]}\n\n',
  );
  expect(r.frames).toHaveLength(3);
  expect(r.lastId).toBe('99');
});

test('data 坏掉也要记住 id —— 推到哪儿了和这一帧能不能用是两回事', () => {
  const r = parseChunk('id: 77\nevent: events\ndata: {坏的\n\n');
  expect(r.frames).toHaveLength(0);
  expect(r.lastId).toBe('77');
});

test('gap 帧认得出来（服务端说「中间还缺一段」）', () => {
  const r = parseChunk('event: gap\ndata: {"from":100,"droppedBefore":100}\n\n');
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].type).toBe('gap');
});

/**
 * 选择题那两个帧。
 *
 * 钉它们是因为帧类型的正则是 `[a-z_]+`——`ask_end` 里那个下划线正好落在边界上。
 * 认不出来的后果和上面那次一样安静：`if (!m) continue` 把帧丢掉，卡片永远
 * 不出现，而 agent 那一轮正停在那儿等，最后白等 4 分钟超时。
 */
test('ask 帧认得出来（agent 出了一道题，正停着等）', () => {
  const r = parseChunk(
    'event: ask\ndata: {"askId":"a1","question":"选哪个？","options":[{"label":"甲"}]}\n\n',
  );
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].type).toBe('ask');
  expect((r.frames[0].data as { question: string }).question).toBe('选哪个？');
});

test('ask_end 帧认得出来——下划线在帧类型正则的边界上', () => {
  const r = parseChunk('event: ask_end\ndata: {"askId":"a1","reason":"answered"}\n\n');
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].type).toBe('ask_end');
});
