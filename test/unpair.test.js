import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { tmpDir, writeJsonl } from './helpers.js';

/**
 * 「解除配对」必须真的解除。
 *
 * 这个文件是为一个真实事故写的：客户端的 unpair 只清了本地存储，而浏览器里
 * 真正让服务端认人的是 HttpOnly cookie——JS 删不掉它，服务端也照收。
 * owner 实测：点完「解除配对」，回到首页不输码就自动恢复了配对。
 *
 * **这是安全问题，不只是体验问题**：按钮宣称断开了，实际没断。
 * 手机丢了的时候，用户以为自己已经解除了。
 */

const TOKEN = 'd'.repeat(64);

function boot() {
  const claudeRoot = tmpDir();
  const OWN = 'aaaaaaaa-0000-0000-0000-000000000001';
  writeJsonl(claudeRoot, path.join('C--proj', `${OWN}.jsonl`), [
    { type: 'user', sessionId: OWN, uuid: 'u1', cwd: 'C:\\proj', timestamp: '2026-09-08T03:00:00Z',
      message: { role: 'user', content: '第一句' } },
  ]);
  const stateFile = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));
  const repo = createRepo({
    claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: stateFile,
  });
  return {
    repo,
    config: { host: '127.0.0.1', port: 0, allowSend: false },
    auth: createAuth({ token: TOKEN }),
  };
}

async function withServer(fn) {
  const ctx = boot();
  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, ctx);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** 从 Set-Cookie 里取出 baton_session 的值（可能为空串）。 */
function sessionCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  const line = raw.find((c) => c.startsWith('baton_session='));
  if (!line) return null;
  return { value: line.slice('baton_session='.length).split(';')[0], line };
}

test('配对下发 cookie，带着它能访问', async () => {
  await withServer(async (base) => {
    const code = (await (await fetch(`${base}/api/pair/new`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
    })).json()).code;

    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const c = sessionCookie(paired);
    assert.ok(c?.value, '配对必须下发 cookie');

    const ok = await fetch(`${base}/api/sessions`, { headers: { cookie: `baton_session=${c.value}` } });
    assert.equal(ok.status, 200, '带着 cookie 应当能访问');
  });
});

test('解除配对下发一个立即过期的 cookie，把浏览器里那份清掉', async () => {
  await withServer(async (base) => {
    const out = await fetch(`${base}/api/unpair`, { method: 'POST' });
    assert.equal(out.status, 200);

    const c = sessionCookie(out);
    assert.ok(c, '解除配对必须下发 Set-Cookie，否则浏览器里那份根本清不掉');
    assert.equal(c.value, '', 'cookie 值要清空');
    assert.match(c.line, /Max-Age=0/, '必须立即过期');
    // Path 要和下发时一致，否则浏览器当成另一个 cookie，不会覆盖
    assert.match(c.line, /Path=\/(;|$)/, 'Path 必须和配对时下发的一致');
    assert.match(c.line, /HttpOnly/);
  });
});

test('解除配对不吊销 token 本身——那会把其他设备一起踢掉', async () => {
  // 用户点的是「这台设备解除」，不是「吊销所有设备」。
  // 电脑上的工具、另一台手机不该被牵连。
  await withServer(async (base) => {
    await fetch(`${base}/api/unpair`, { method: 'POST' });
    const still = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(still.status, 200, '本机 token 应当仍然有效');
  });
});

test('解除配对不需要先通过鉴权', async () => {
  // 已经半解除的客户端（本地清了、cookie 还在）也得能把 cookie 清掉，
  // 否则它会卡在「看着没配对、其实还连着」里出不来。
  await withServer(async (base) => {
    const out = await fetch(`${base}/api/unpair`, { method: 'POST' });
    assert.equal(out.status, 200, '未鉴权也要能解除');
    assert.equal(out.headers.get('x-baton'), '1', '仍然要带源站标记');
  });
});

test('解除配对之后，原来那个 cookie 值重放也不认了', async () => {
  // 以前这条断言的是反面（「重放仍然通过，这是刻意的」）：凭据由 token 派生、同一身份
  // 共用一个值，服务端没法单独作废。现在每次配对发设备凭据，解除时写进吊销表。
  await withServer(async (base) => {
    const code = (await (await fetch(`${base}/api/pair/new`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
    })).json()).code;
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const value = sessionCookie(paired).value;

    const out = await fetch(`${base}/api/unpair`, { method: 'POST', headers: { cookie: `baton_session=${value}` } });
    assert.equal((await out.json()).revoked, 'device');

    const replay = await fetch(`${base}/api/sessions`, { headers: { cookie: `baton_session=${value}` } });
    assert.equal(replay.status, 401, '解除过的 cookie 被人拷走重放也不该再通过');
  });
});

test('原生 App 带 bearer 解除：这张 bearer 作废，另一台设备照常', async () => {
  // 原生端读不到 Set-Cookie，凭据是配对时显式索取的 bearer，存在 Keychain。
  // 以前解除只能删本地那份，值本身还活着——手机丢了、点了解除也没用。
  await withServer(async (base) => {
    const pairOnce = async () => {
      const code = (await (await fetch(`${base}/api/pair/new`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
      })).json()).code;
      return (await (await fetch(`${base}/api/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, want: 'bearer' }),
      })).json()).bearer;
    };
    const phone = await pairOnce();
    const tablet = await pairOnce();

    const out = await fetch(`${base}/api/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${phone}` } });
    assert.equal(out.status, 200);
    assert.equal((await out.json()).revoked, 'device');

    const replay = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${phone}` } });
    assert.equal(replay.status, 401);
    const other = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${tablet}` } });
    assert.equal(other.status, 200, '解除一台不能牵连同一身份的其他设备');
  });
});
