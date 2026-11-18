import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { OWNER } from '../src/principals.js';
import { tmpDir, writeJsonl } from './helpers.js';

const TOKEN = 'b'.repeat(64);

function boot(authOpts = {}, configOverrides = {}) {
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
  const auth = createAuth({ token: TOKEN, ...authOpts });
  const server = createServer({
    repo,
    auth,
    config: { host: '127.0.0.1', port: 0, allowSend: false, ...configOverrides },
  });
  return { server, auth, repo };
}

async function withServer(fn, authOpts, configOverrides) {
  const ctx = boot(authOpts, configOverrides);
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  try {
    await fn({ ...ctx, base });
  } finally {
    await new Promise((r) => ctx.server.close(r));
  }
}

// id 不传就是 owner，所以既有调用点全部不受影响
const cookieOf = (auth, id) =>
  `baton_session=${/baton_session=([^;]+)/.exec(auth.verifyPair(auth.newPairingCode(id)).setCookie)[1]}`;

test('未配对时受保护端点返回 401 且带可操作提示', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/sessions`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.message);
    assert.ok(body.error.fix, '错误体必须带 fix 字段说明怎么修');
  });
});

test('/api/health 未配对 401、已配对 200', async () => {
  await withServer(async ({ base, auth }) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    const ok = await fetch(`${base}/api/health`, { headers: { cookie: cookieOf(auth) } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  });
});

test('POST /api/pair 用配对码换 cookie', async () => {
  await withServer(async ({ base, auth }) => {
    const code = auth.newPairingCode();
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /baton_session=.*HttpOnly/);
  });
});

test('原生客户端可显式索取 bearer；不索取就拿不到（HttpOnly 对网页那条路仍作数）', async () => {
  // RN 读不到 Set-Cookie——iOS 的 NSURLSession 把 cookie 收进自己的存储，
  // fetch 层看不见。所以必须有一条自取凭据的路，但不能无条件开，
  // 否则网页端把 HttpOnly 白设了。
  await withServer(async ({ base, auth }) => {
    const web = await (await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.newPairingCode() }),
    })).json();
    assert.equal(web.bearer, undefined, '没索取就不该给');

    const res = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.newPairingCode(), want: 'bearer' }),
    });
    const native = await res.json();
    assert.ok(native.bearer, '索取了就要给');
    assert.notEqual(native.bearer, TOKEN, 'bearer 是 token 派生的 HMAC，不是 token 本身');

    // 必须走原生客户端真正会走的那条路：Authorization: Bearer。
    // 用 cookie 头验会漏掉一个真 bug——authorize 的 Bearer 分支原先只比对原始
    // token，而配对下发的是它派生的 HMAC，RN 每个请求都会 401，
    // 而这在浏览器里试不出来（浏览器走 cookie）。
    const ok = await fetch(`${base}/api/sessions`, {
      headers: { Authorization: `Bearer ${native.bearer}` },
    });
    assert.equal(ok.status, 200, '配对下发的凭据必须能当 Bearer 用');
  });
});

test('错误的配对码返回 400 且不下发 cookie', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'WRONG123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('/api/sessions 返回链列表与 titleTier，且不透出绝对路径', async () => {
  await withServer(async ({ base, auth }) => {
    const body = await (await fetch(`${base}/api/sessions`, { headers: { cookie: cookieOf(auth) } })).json();
    assert.equal(body.chains.length, 1);
    const m = body.chains[0].members[0];
    assert.ok(m.key);
    assert.ok(typeof m.titleTier === 'number');
    assert.equal(m.file, undefined, '不得把本机绝对路径透给客户端');
  });
});

test('/events 返回事件与游标', async () => {
  await withServer(async ({ base, auth }) => {
    const cookie = cookieOf(auth);
    const list = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json();
    const key = list.chains[0].members[0].key;
    const page = await (await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/events?limit=10`, { headers: { cookie } })).json();
    assert.deepEqual(page.events.map((e) => e.text), ['第一句', '回复一']);
    assert.ok('nextBefore' in page);
  });
});

test('未知 key 返回 404 且带 fix', async () => {
  await withServer(async ({ base, auth }) => {
    const res = await fetch(`${base}/api/sessions/claude:bm9wZQ/events`, { headers: { cookie: cookieOf(auth) } });
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error.fix);
  });
});

test('/stream 返回 SSE 头', async () => {
  await withServer(async ({ base, auth }) => {
    const cookie = cookieOf(auth);
    const list = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json();
    const key = list.chains[0].members[0].key;
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/stream`, {
      headers: { cookie }, signal: ctrl.signal,
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    ctrl.abort();
  });
});

test('页面本身不需要认证即可加载（否则连配对输入框都出不来）', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('匿名访问不再铸造配对码（撤 Cloudflare Access 前的加固）', async () => {
  // 加固前：任何匿名请求打到 / 就铸一个码，每 30 秒一个。有 Access 挡着时
  // 无害，撤掉后就是远程可触发的铸码入口——稳态同时有效码从 0 变成约 20 个，
  // 把 40 bit 的配对码从「几乎不可能」推到「大型僵尸网络数周可破」。
  await withServer(async ({ base, auth }) => {
    const before = auth.pendingCodeCount();
    await fetch(`${base}/`);
    await fetch(`${base}/style.css`);
    await fetch(`${base}/app.js`);
    assert.equal(auth.pendingCodeCount(), before, '匿名访问不得铸造配对码');
  });
});

test('两套客户端的配对输入框都要装得下真实配对码', async () => {
  // 认证层把码从 8 位加长到 12 位时，v1 的 index.html 的 maxlength="8" 没跟着改——
  // 输入框物理上打不完整个码，配对整个失效，而 217 个测试全绿。
  // 根因是没有任何东西把「界面接受多长」和「实现生成多长」绑在一起。
  // 现在有两套客户端，两套都得绑。
  const auth = createAuth({ token: TOKEN });
  const len = auth.newPairingCode().length;

  const legacy = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'index.html'), 'utf8');
  const tag = /<input[^>]*id="pair-code"[^>]*>/.exec(legacy);
  assert.ok(tag, 'v1 客户端的配对输入框不见了');
  const max = Number(/maxlength="(\d+)"/.exec(tag[0])?.[1]);
  assert.ok(Number.isInteger(max), 'v1 的配对输入框必须显式限长');
  assert.ok(len <= max, `v1：配对码 ${len} 位，输入框只收 ${max} 位——用户打不完`);
  assert.ok(tag[0].includes(`${len} 位配对码`), 'v1 的 placeholder 要说真实位数');

  // Expo 客户端是另一门语言，但同一个不变式。做**静态源码检查**而不是让它去
  // 网络上问服务端：问一次要多加一个未认证端点，且问失败时还得退回一个硬编码
  // 常量——等于把重复又搬了回来。
  const expo = fs.readFileSync(path.join(process.cwd(), 'app', 'src', 'app', 'pair.tsx'), 'utf8');
  const maxLen = Number(/maxLength=\{(\d+)\}/.exec(expo)?.[1]);
  assert.equal(maxLen, len, `Expo：配对码 ${len} 位，maxLength 却是 ${maxLen}`);
  assert.ok(expo.includes(`slice(0, ${len})`), 'Expo 的输入过滤也要按真实位数截断');
  assert.ok(expo.includes(`${len} 位配对码`), 'Expo 的无障碍标签要说真实位数');
});

test('限流键不得采信 CF-Connecting-IP（客户端可伪造，会把唯一的桶变成无限个桶）', async () => {
  // 隧道下 req.socket.remoteAddress 恒为 127.0.0.1，所有公网流量共用一个限流桶——
  // 看起来像 bug，实际是攻击者换 IP 也绕不过去。若有人"修好"成读 CF-Connecting-IP，
  // 只要能直连到端口就能每请求换一个假 IP，限流当场归零。此测试守住这条。
  await withServer(async ({ base }) => {
    const tryCode = (fakeIp) => fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': fakeIp },
      body: JSON.stringify({ code: 'ZZZZZZZZZZZZ' }),
    });

    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await tryCode(`203.0.113.${i}`)).status);

    assert.deepEqual(codes.slice(0, 3), [400, 400, 400], '前 3 次是码错');
    assert.ok(codes.includes(429),
      '每次换一个 CF-Connecting-IP 仍必须被限流——说明限流键没采信这个头');
  }, { maxFails: 3 });
});

test('铸配对码必须持有凭据（本机能读 ~/.baton/token）', async () => {
  await withServer(async ({ base, auth }) => {
    const anon = await fetch(`${base}/api/pair/new`, { method: 'POST' });
    assert.equal(anon.status, 401, '没有凭据不能铸码');

    const ok = await fetch(`${base}/api/pair/new`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(ok.status, 200);
    const { code } = await ok.json();
    assert.match(code, /^[A-Z2-9]{12}$/);
    assert.equal(auth.verifyPair(code).ok, true, '铸出来的码要能用');
  });
});

// ── 开发期跨源放行 ──────────────────────────────

async function withCors(devCorsOrigin, fn) {
  const ctx = boot();
  ctx.server.close();
  const server = createServer({
    repo: ctx.repo, auth: ctx.auth,
    config: { host: '127.0.0.1', port: 0, allowSend: false, devCorsOrigin },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('默认不放行任何跨源请求', async () => {
  await withCors(null, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:8081' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      '默认必须是关的——开着等于任何网站的脚本都能调这台 Baton');
  });
});

test('只放行精确匹配的那一个来源', async () => {
  await withCors('http://localhost:8081', async (base) => {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:8081' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8081');

    const bad = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null, '别的来源一律不放');
  });
});

test('通配 * 一律当作没配置', async () => {
  await withCors('*', async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      '接受 * 就等于对全网开放，必须拒绝这种配置');
  });
});

test('放行时也绝不发 Allow-Credentials', async () => {
  // 不发这个头，浏览器就不会带 cookie 跨源，唯一能用的凭据是显式 Bearer
  // ——而那个值恶意站点读不到。「趁你登着就把会话读走」这条路径因此不存在。
  await withCors('http://localhost:8081', async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:8081' } });
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });
});

test('预检请求被正确应答', async () => {
  await withCors('http://localhost:8081', async (base) => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8081',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8081');
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  });
});

test('跨源时必须暴露 X-Baton，否则客户端看不见源站标记', async () => {
  // 浏览器跨源只让 JS 读几个白名单响应头。不暴露 X-Baton 的话，客户端会把
  // Baton 自己的 200 判成「被中间设备拦截」——实测踩过这个。
  await withCors('http://localhost:8081', async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:8081' } });
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /X-Baton/i);
  });
});

// ── 身份与作用域 ────────────────────────────────

test('/api/health 的 allowSend 是调用者自己的', async () => {
  // /api/health 是客户端判断「输入框该不该禁用」的依据。
  // 返回全局值的话，访客的界面会说谎。
  const guest = { id: 'friend', name: 'Alice', roots: ['C:\\proj'], allowSend: false };
  await withServer(async ({ base, auth }) => {
    const asOwner = await (await fetch(`${base}/api/health`,
      { headers: { cookie: cookieOf(auth) } })).json();
    assert.equal(asOwner.allowSend, true, 'owner 跟全局走');

    const asGuest = await (await fetch(`${base}/api/health`,
      { headers: { cookie: cookieOf(auth, 'friend') } })).json();
    assert.equal(asGuest.allowSend, false, '访客的覆盖必须生效');
  }, { principals: [OWNER, guest] }, { allowSend: true });
});

test('访客拿越界会话 key 打每一个端点，全部 404', async () => {
  // **404 不是 403**：403 等于确认「这个 key 真的存在」。
  //
  // 这条必须是端到端的。scope.test.js 只能证明 getSession 返回 null，
  // 证明不了这八个端点都真的走到了那个分支——而「handler 单测绿着、
  // 路由却不可达」正是 routes.test.js 当初被建出来修的那类事故。
  const guest = { id: 'friend', name: 'Alice', roots: ['C:\\somewhere\\else'], allowSend: null };
  await withServer(async ({ base, auth, repo }) => {
    // 夹具里那个会话的 cwd 是 C:\proj，不在访客的 roots 之下
    const key = repo.listChains()[0].members[0].key;
    const e = encodeURIComponent(key);
    const jar = cookieOf(auth, 'friend');
    const calls = [
      ['GET', `/api/sessions/${e}/events?limit=3`],
      ['GET', `/api/sessions/${e}/events/${encodeURIComponent('u1#0')}/full?offset=0`],
      ['GET', `/api/sessions/${e}/state`],
      ['GET', `/api/sessions/${e}/stream`],
      ['POST', `/api/sessions/${e}/send`],
      ['POST', `/api/sessions/${e}/stop`],
      ['POST', `/api/sessions/${e}/model`],
      ['POST', `/api/sessions/${e}/upload?name=x.txt`],
    ];
    for (const [method, p] of calls) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { cookie: jar, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ message: '你好', turnId: 't1' }) : undefined,
      });
      assert.equal(res.status, 404, `${method} ${p} 应当 404，实际 ${res.status}`);
    }

    // 列表里也不该有它
    const list = await (await fetch(`${base}/api/sessions`, { headers: { cookie: jar } })).json();
    assert.equal(list.chains.length, 0);
  }, { principals: [OWNER, guest] }, { allowSend: true });

  // 同一个 key 对 owner 仍然可达——否则上面那条只证明了「全都坏了」
  await withServer(async ({ base, auth, repo }) => {
    const key = repo.listChains()[0].members[0].key;
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/state`,
      { headers: { cookie: cookieOf(auth) } });
    assert.equal(res.status, 200);
  });
});

// ── 安全响应头与跨源写入（CSRF）防护 ────────────────────

test('JSON、静态页与 404 均带基础安全响应头', async () => {
  await withServer(async ({ base, auth }) => {
    const jar = cookieOf(auth);
    for (const url of [`${base}/api/health`, `${base}/`, `${base}/api/nope`]) {
      const res = await fetch(url, { headers: { cookie: jar } });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', url);
    }
  });
});

test('Cookie 鉴权下的跨源或同站子域写入请求一律 403，同源与 Bearer 放行', async () => {
  await withServer(async ({ base, auth }) => {
    const jar = cookieOf(auth);
    const code = auth.newPairingCode();
    const port = new URL(base).port;

    // 1) 同根域子站发起 POST /api/pair/new（Sec-Fetch-Site: same-site）
    const rSameSite = await fetch(`${base}/api/pair/new`, {
      method: 'POST',
      headers: {
        cookie: jar,
        'content-type': 'application/json',
        Origin: `http://sibling.example.net`,
        'Sec-Fetch-Site': 'same-site',
      },
      body: '{}',
    });
    assert.equal(rSameSite.status, 403);
    assert.equal((await rSameSite.json()).error.code, 'cross_origin');

    // 2) Origin: null（沙箱 iframe）对 /api/unpair
    const rNull = await fetch(`${base}/api/unpair`, {
      method: 'POST',
      headers: { cookie: jar, Origin: 'null' },
    });
    assert.equal(rNull.status, 403);

    // 3) 仅 Origin 与 Host 不匹配（没有 Sec-Fetch-Site）
    const rBadOrigin = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(rBadOrigin.status, 403);

    // 4) 同源请求正常通过
    const rOk = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(rOk.status, 200);

    // 5) 显式 Bearer（无 cookie）的 /api/pair/new 不受浏览器跨源影响
    const rBearer = await fetch(`${base}/api/pair/new`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        Origin: 'http://localhost:8081',
      },
      body: '{}',
    });
    assert.equal(rBearer.status, 200);
  });
});
