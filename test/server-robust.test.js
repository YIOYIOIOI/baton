import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { runProcess } from '../src/agent/spawn.js';
import { streamSession } from '../src/http/handlers/sessions.js';
import { tmpDir, writeJsonl } from './helpers.js';

/*
  一个请求就能让守护进程退出的那几种形状（2026-10-01 代码审查，前三条当时复现过）。

  这个文件单独放：修之前这些请求会让**整个进程**退出，和别的测试放在一起，
  红的时候会把不相干的测试一起带走，看不清到底是哪一条。
*/

const TOKEN = 'c'.repeat(64);

// 修之前那几个请求**永远等不到回应**（处理函数死在半路），不给超时的话测试就挂住了
const get = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });

function realRepo() {
  const claudeRoot = tmpDir();
  const id = 'aaaaaaaa-0000-0000-0000-000000000002';
  writeJsonl(claudeRoot, path.join('C--proj', `${id}.jsonl`), [
    { type: 'user', sessionId: id, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '第一句' } },
  ]);
  const stateFile = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));
  return createRepo({ claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: stateFile });
}

async function withServer(repo, fn) {
  const auth = createAuth({ token: TOKEN });
  const server = createServer({ repo, auth, config: { host: '127.0.0.1', port: 0, allowSend: false } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `baton_session=${/baton_session=([^;]+)/.exec(auth.verifyPair(auth.newPairingCode()).setCookie)[1]}`;
  try {
    await fn({ base, cookie });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function alive(base) {
  const r = await get(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200, '服务还得活着');
}

test('地址里有坏掉的百分号转义：回 400，不崩（不用登录就能打）', async () => {
  await withServer(realRepo(), async ({ base }) => {
    const r = await get(`${base}/%E0%A4%A`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'bad_path');
    await alive(base);
  });
});

test('请求体是 null / 数组 / 数字：当空对象，由接口自己校验，不崩', async () => {
  await withServer(realRepo(), async ({ base }) => {
    for (const body of ['null', '[]', '42']) {
      const r = await get(`${base}/api/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      assert.ok(r.status >= 400 && r.status < 500, `${body} → ${r.status}`);
    }
    await alive(base);
  });
});

test('翻页游标不是数字：回 400，不崩', async () => {
  const repo = realRepo();
  const key = repo.listChains()[0].members[0].key;
  await withServer(repo, async ({ base, cookie }) => {
    const r = await get(`${base}/api/sessions/${encodeURIComponent(key)}/events?before=abc`, {
      headers: { cookie },
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'bad_cursor');
    await alive(base);
  });
});

test('接口里抛了没想到的异常：回 500 且说清楚，进程不退', async () => {
  const repo = {
    listChains: () => [],
    getSession: () => { throw new Error('盘读坏了'); },
  };
  await withServer(repo, async ({ base, cookie }) => {
    const r = await get(`${base}/api/sessions/claude%3AYWJj/state`, { headers: { cookie } });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error.code, 'internal_error');
    assert.ok(body.error.fix);
    assert.ok(!JSON.stringify(body).includes('盘读坏了'), '内部报错原文只进日志，不回给客户端');
    await alive(base);
  });
});

test('streamSession 超过单会话并发连接上限时返回 429，连接断开后释放名额', () => {
  const repo = realRepo();
  const key = repo.listChains()[0].members[0].key;
  const fakeRes = () => {
    const handlers = {};
    return {
      headersSent: false,
      writeHead() { this.headersSent = true; },
      write() {},
      end() {},
      on(ev, fn) { handlers[ev] = fn; },
      emitClose() { handlers.close?.(); },
    };
  };
  const r1 = fakeRes();
  const r2 = fakeRes();
  const r3 = fakeRes();
  assert.equal(streamSession(repo, key, r1, { maxStreams: 2 }), null);
  assert.equal(streamSession(repo, key, r2, { maxStreams: 2 }), null);
  const blocked = streamSession(repo, key, r3, { maxStreams: 2 });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_streams');
  r1.emitClose();
  assert.equal(streamSession(repo, key, fakeRes(), { maxStreams: 2 }), null);
  r2.emitClose();
});

test('agent 一起来就退出、stdin 还没写完：记成失败的一轮，不崩', async () => {
  // 管道缓冲只有几十 KB，写 5 MB 必然在对方退出之后才写到一半 → EPIPE
  const r = await runProcess({
    command: process.execPath, args: ['-e', '"process.exit(3)"'], cwd: tmpDir(),
    message: 'x'.repeat(5_000_000),
  });
  assert.equal(r.code, 3);
});

test('漏网的 Promise 拒绝：记日志，进程继续', () => {
  // 在独立进程里验：这里要看的正是「进程还在不在」
  const guards = new URL('../src/runtime/guards.js', import.meta.url).href;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installGuards } from ${JSON.stringify(guards)};
    installGuards();
    Promise.reject(new Error('漏网的'));
    setTimeout(() => { console.log('还活着'); }, 100);
  `], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /还活着/);
  assert.match(out.stderr, /漏网的/, '拒绝原因要进日志，不能吞掉');
});
