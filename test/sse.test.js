import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseStream } from '../src/http/sse.js';

function fakeRes() {
  return {
    chunks: [], headers: null, ended: false, statusCode: 0,
    writeHead(code, h) { this.statusCode = code; this.headers = h; },
    write(s) { this.chunks.push(s); return true; },
    end() { this.ended = true; },
    on() {},
    get text() { return this.chunks.join(''); },
  };
}

test('构造时写出 SSE 响应头', () => {
  const res = fakeRes();
  createSseStream(res).close();
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.equal(res.headers['Cache-Control'], 'no-cache');
  assert.equal(res.headers['X-Accel-Buffering'], 'no', '禁止中间层缓冲，否则事件会被攒住');
});

test('先写一行 open 注释，让客户端与中间层确认流已建立', () => {
  const res = fakeRes();
  createSseStream(res).close();
  assert.equal(res.chunks[0], ': open\n\n');
});

test('send 输出合法的 SSE 帧', () => {
  const res = fakeRes();
  const s = createSseStream(res);
  s.send('events', { a: 1 });
  s.close();
  assert.equal(res.chunks[1], 'event: events\ndata: {"a":1}\n\n');
});

test('多行数据每行都带注释前缀', () => {
  const res = fakeRes();
  const s = createSseStream(res);
  s.comment('第一行\n第二行');
  s.close();
  assert.match(res.text, /: 第一行\n: 第二行\n\n/);
});

test('空闲时自动发心跳', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeRes();
  const s = createSseStream(res, { pingMs: 15000 });
  t.mock.timers.tick(15000);
  assert.match(res.text, /: ping\n\n/, '15 秒内必须有一行心跳，否则 CF 会在 100 秒时切流');
  t.mock.timers.tick(15000);
  assert.equal(res.text.match(/: ping/g).length, 2);
  s.close();
});

test('给了 tick 就发具名事件而不是注释心跳（秒表要有服务器权威）', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeRes();
  const s = createSseStream(res, {
    pingMs: 15000,
    tick: () => ({ turnId: 'T1', running: true, elapsedMs: 42000 }),
  });
  t.mock.timers.tick(15000);
  assert.match(res.text, /event: tick\ndata: \{"turnId":"T1","running":true,"elapsedMs":42000\}\n\n/);
  assert.ok(!res.text.includes(': ping'), 'tick 完全取代注释心跳，具名事件同样重置 CF 的源站超时');
  s.close();
});

test('tick 抛错不能让心跳停摆——那会直接触发 CF 524', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeRes();
  const s = createSseStream(res, {
    pingMs: 15000,
    tick: () => { throw new Error('轮次记录读坏了'); },
  });
  t.mock.timers.tick(15000);
  t.mock.timers.tick(15000);
  assert.equal(res.text.match(/: ping/g)?.length, 2,
    'tick 失败时必须退回注释心跳，绝不能一次都不发');
  s.close();
});

test('close 后不再写入且清掉定时器', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeRes();
  const s = createSseStream(res, { pingMs: 1000 });
  s.close();
  const before = res.text.length;
  t.mock.timers.tick(10000);
  s.send('events', { x: 1 });
  assert.equal(res.text.length, before, 'close 之后一个字节都不该再写');
  assert.equal(s.closed, true);
  assert.equal(res.ended, true);
});
