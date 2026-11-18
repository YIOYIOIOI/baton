import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  ensureKeys, publicKey, vapidJwt, subscribe, unsubscribe, listSubscriptions, notify,
  setLatest, getLatest,
} from '../src/push.js';
import { pushUnsubscribeHandler } from '../src/http/handlers/push.js';
import { buildRoutes } from '../src/http/routes.js';
import { createAuth } from '../src/http/auth.js';

/**
 * Web Push 的坑集中在两处：JWT 的签名编码，和订阅的生命周期。
 * 两处出错的表现都是「推送就是不到」，且推送服务不会告诉你为什么。
 */

test('VAPID 公钥是 65 字节的未压缩点格式', () => {
  const k = publicKey();
  const raw = Buffer.from(k, 'base64url');
  assert.equal(raw.length, 65, '推送服务只认 0x04||X||Y 这 65 字节');
  assert.equal(raw[0], 0x04, '首字节必须是 0x04（未压缩标记）');
});

test('密钥落盘复用，不每次重新生成', () => {
  // 换了密钥，所有已有订阅立刻全部失效——推送服务按公钥认订阅
  assert.equal(publicKey(), publicKey());
  assert.equal(ensureKeys().publicKey, publicKey());
});

test('JWT 的签名是裸的 r||s（64 字节），不是 DER', () => {
  // node 默认签出 DER 包装的签名，而 JWT 要裸的。用默认值推送服务一律回 401，
  // 且错误信息里不会提这件事——这是最难查的那种。
  const state = ensureKeys();
  const jwt = vapidJwt('https://web.push.apple.com/xyz', state.privateKeyPem);
  const [h, p, sig] = jwt.split('.');
  assert.equal(Buffer.from(sig, 'base64url').length, 64);

  const head = JSON.parse(Buffer.from(h, 'base64url'));
  assert.equal(head.alg, 'ES256');
  const body = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(body.aud, 'https://web.push.apple.com', 'aud 是推送服务的 origin，不是完整 endpoint');
  assert.ok(body.exp > Math.floor(Date.now() / 1000), 'exp 必须在未来');
  assert.ok(body.exp < Math.floor(Date.now() / 1000) + 24 * 3600, 'exp 上限 24 小时');
});

test('签名能被公钥验过', () => {
  const state = ensureKeys();
  const jwt = vapidJwt('https://fcm.googleapis.com/x', state.privateKeyPem);
  const [h, p, sig] = jwt.split('.');
  const pub = crypto.createPublicKey({ key: state.privateKeyPem, format: 'pem' });
  const ok = crypto.verify(
    'sha256', Buffer.from(`${h}.${p}`),
    { key: pub, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'),
  );
  assert.equal(ok, true);
});

test('aud 随 endpoint 变——一个 JWT 不能拿去敲另一家的门', () => {
  const state = ensureKeys();
  const a = JSON.parse(Buffer.from(vapidJwt('https://a.example/x', state.privateKeyPem).split('.')[1], 'base64url'));
  const b = JSON.parse(Buffer.from(vapidJwt('https://b.example/y', state.privateKeyPem).split('.')[1], 'base64url'));
  assert.notEqual(a.aud, b.aud);
});

// ── 订阅 ────────────────────────────────────────

test('同一个 endpoint 重复订阅只留一条', () => {
  // 不去重的话每次重装 PWA 都多一条，最后一个轮次推十几遍
  const before = listSubscriptions().length;
  subscribe({ endpoint: 'https://push.example/aaa' });
  subscribe({ endpoint: 'https://push.example/aaa' });
  subscribe({ endpoint: 'https://push.example/aaa' });
  assert.equal(listSubscriptions().filter((s) => s.endpoint.endsWith('/aaa')).length, 1);
  unsubscribe('https://push.example/aaa');
  assert.equal(listSubscriptions().length, before);
});

test('没有 endpoint 的订阅被拒', () => {
  assert.throws(() => subscribe({}), /endpoint/);
  assert.throws(() => subscribe(null), /endpoint/);
});

// ── 发送 ────────────────────────────────────────

test('没有订阅时不发也不报错', async () => {
  const r = await notify({ fetchImpl: () => { throw new Error('不该被调用'); } });
  assert.deepEqual(r, { sent: 0, dropped: 0 });
});

test('发送带上 VAPID 头与 TTL，且不带载荷', async () => {
  subscribe({ endpoint: 'https://push.example/live' });
  let seen = null;
  await notify({
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201 }; },
  });
  assert.equal(seen.url, 'https://push.example/live');
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(seen.init.headers.TTL, '600');
  assert.equal(seen.init.body, undefined, '不带载荷——内容由 SW 醒来后自己 fetch');
  unsubscribe('https://push.example/live');
});

test('404 / 410 的订阅就地删掉，网络抖动不删', async () => {
  // 留着死订阅的话，每轮都去敲一次注定失败的门
  subscribe({ endpoint: 'https://push.example/gone' });
  subscribe({ endpoint: 'https://push.example/flaky' });

  const r = await notify({
    fetchImpl: async (url) => {
      if (url.endsWith('/gone')) return { ok: false, status: 410 };
      throw new Error('网络抖了一下');
    },
  });
  assert.equal(r.dropped, 1);
  const left = listSubscriptions().map((s) => s.endpoint);
  assert.ok(!left.includes('https://push.example/gone'), '410 的要删');
  assert.ok(left.includes('https://push.example/flaky'), '网络异常的不能删');
  unsubscribe('https://push.example/flaky');
});

// ── 按身份分区 ──────────────────────────────────

test('推送按身份分区——访客收不到 owner 的会话标题', async () => {
  // 订阅表整个文件共享（都落在同一个 BATON_DIR），前面的用例往里加过东西。
  // 先清干净，否则这条断言会被别人的订阅打乱。
  for (const s of listSubscriptions()) unsubscribe(s.endpoint);

  subscribe({ endpoint: 'https://push.example/owner' }, 'owner');
  subscribe({ endpoint: 'https://push.example/friend' }, 'friend');

  const hit = [];
  const fetchImpl = async (url) => { hit.push(url); return { ok: true, status: 201 }; };
  await notify({ principalId: 'owner', fetchImpl });
  assert.deepEqual(hit, ['https://push.example/owner']);

  hit.length = 0;
  await notify({ principalId: 'friend', fetchImpl });
  assert.deepEqual(hit, ['https://push.example/friend']);
});

test('没有 principalId 的旧订阅视为 owner', () => {
  for (const s of listSubscriptions()) unsubscribe(s.endpoint);
  subscribe({ endpoint: 'https://push.example/legacy' });
  assert.equal(listSubscriptions()[0].principalId, 'owner');
});

test('latest 按身份各存各的', () => {
  setLatest('owner', { key: 'claude:o', title: 'owner 的活', status: 'ok' });
  setLatest('friend', { key: 'claude:f', title: '朋友的活', status: 'ok' });
  assert.equal(getLatest('owner').title, 'owner 的活');
  assert.equal(getLatest('friend').title, '朋友的活');
  assert.equal(getLatest('nobody'), null);
});

// ── SSRF 与跨身份订阅/退订防护 ──────────────────────

test('subscribe 拒绝非 HTTPS 与本机/内网/保留地址（防 SSRF）', () => {
  for (const s of listSubscriptions()) unsubscribe(s.endpoint);
  for (const bad of [
    'http://push.example/plain',
    'https://127.0.0.1/hook',
    'https://localhost/hook',
    'https://sub.localhost/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/hook',
    'https://10.0.0.1/hook',
    'https://172.16.0.1/hook',
    'https://100.64.0.1/hook',
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://user:pass@push.example/cred',
    'https://printer.local/hook',
  ]) {
    assert.throws(() => subscribe({ endpoint: bad }), undefined, `${bad} 必须被拒`);
  }
});

test('访客不能劫持或退订 owner 的推送订阅', async () => {
  for (const s of listSubscriptions()) unsubscribe(s.endpoint);
  const sharedEp = 'https://push.example/owner-device';
  subscribe({ endpoint: sharedEp }, 'owner');

  // 访客尝试用同一个 endpoint 覆盖归属
  assert.throws(() => subscribe({ endpoint: sharedEp }, 'friend'), /其他身份/);
  assert.equal(listSubscriptions().find((s) => s.endpoint === sharedEp)?.principalId, 'owner');

  // 访客直接调 handler 或经路由退订同一个 endpoint，不能删掉 owner 的
  pushUnsubscribeHandler({ endpoint: sharedEp }, 'friend');
  assert.equal(listSubscriptions().length, 1, '直接调 pushUnsubscribeHandler 也不能跨身份删除');

  const auth = createAuth({ token: 'p'.repeat(64) });
  const unsubRoute = buildRoutes({ auth }).find((r) => r.name === 'pushUnsubscribeHandler');
  await unsubRoute.run({ body: { endpoint: sharedEp }, principal: { id: 'friend' } });
  assert.equal(listSubscriptions().length, 1, '路由未传入 principal.id 会让访客退订 owner');

  // owner 自己退订才删得掉
  await unsubRoute.run({ body: { endpoint: sharedEp }, principal: { id: 'owner' } });
  assert.equal(listSubscriptions().length, 0);
});
