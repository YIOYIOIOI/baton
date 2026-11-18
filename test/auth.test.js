import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAuth, isSecureRequest } from '../src/http/auth.js';
import { OWNER, OWNER_ID } from '../src/principals.js';
import { memoryRevocations } from '../src/revocations.js';

const TOKEN = 'a'.repeat(64);
const req = (headers = {}, url = '/api/sessions') => ({ headers, url });

test('未带凭据一律拒绝', () => {
  const a = createAuth({ token: TOKEN });
  const r = a.authorize(req());
  assert.equal(r.ok, false);
  assert.ok(r.reason, '拒绝必须带原因，供上层拼可操作提示');
});

test('配对码可用一次，第二次失效', () => {
  const a = createAuth({ token: TOKEN });
  const code = a.newPairingCode();
  assert.match(code, /^[A-Z2-9]{12}$/);
  const first = a.verifyPair(code);
  assert.equal(first.ok, true);
  assert.match(first.setCookie, /HttpOnly/);
  assert.match(first.setCookie, /Secure/);
  assert.match(first.setCookie, /SameSite=Lax/);
  assert.equal(a.verifyPair(code).ok, false, '配对码必须一次性');
});

test('配对码超过 TTL 失效', () => {
  let t = 1000;
  const a = createAuth({ token: TOKEN, now: () => t, codeTtlMs: 5000 });
  const code = a.newPairingCode();
  t += 6000;
  const r = a.verifyPair(code);
  assert.equal(r.ok, false);
  assert.match(r.reason, /过期|失效/);
});

test('配对后下发的 cookie 能通过 authorize', () => {
  const a = createAuth({ token: TOKEN });
  const { setCookie } = a.verifyPair(a.newPairingCode());
  const value = /baton_session=([^;]+)/.exec(setCookie)[1];
  assert.equal(a.authorize(req({ cookie: `baton_session=${value}` })).ok, true);
});

test('cookie 值不是原始 token', () => {
  const a = createAuth({ token: TOKEN });
  const { setCookie } = a.verifyPair(a.newPairingCode());
  assert.ok(!setCookie.includes(TOKEN), 'cookie 不得直接承载 token');
});

test('cookie 凭据跨实例重启后仍有效', () => {
  const a1 = createAuth({ token: TOKEN });
  const value = /baton_session=([^;]+)/.exec(a1.verifyPair(a1.newPairingCode()).setCookie)[1];
  const a2 = createAuth({ token: TOKEN }); // 模拟守护进程重启，token 从磁盘读回
  assert.equal(a2.authorize(req({ cookie: `baton_session=${value}` })).ok, true,
    '重启不得要求重新配对');
});

test('Authorization: Bearer 也被接受（为 v2 原生客户端留位置）', () => {
  const a = createAuth({ token: TOKEN });
  assert.equal(a.authorize(req({ authorization: `Bearer ${TOKEN}` })).ok, true);
  assert.equal(a.authorize(req({ authorization: 'Bearer wrong' })).ok, false);
});

test('query string 里的凭据一律无效', () => {
  const a = createAuth({ token: TOKEN });
  assert.equal(a.authorize(req({}, `/api/sessions?token=${TOKEN}`)).ok, false,
    'token 不得进 query，否则会落 CF 日志与浏览器历史');
});

test('失败次数超限后限流并给出重试秒数', () => {
  let t = 0;
  const a = createAuth({ token: TOKEN, now: () => t, maxFails: 3, windowMs: 60000 });
  for (let i = 0; i < 3; i += 1) a.noteFailure('1.2.3.4');
  const r = a.rateLimit('1.2.3.4');
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterSec > 0);
  assert.equal(a.rateLimit('5.6.7.8').ok, true, '限流按 IP 隔离');
  t += 61000;
  assert.equal(a.rateLimit('1.2.3.4').ok, true, '窗口过后恢复');
});

test('过期未使用的配对码会在下次生成时被清掉', () => {
  let t = 0;
  const a = createAuth({ token: TOKEN, now: () => t, codeTtlMs: 1000 });
  a.newPairingCode();
  a.newPairingCode();
  assert.equal(a.pendingCodeCount(), 2);
  t += 2000;                 // 两个都过期
  a.newPairingCode();        // 生成第三个时顺手清理
  assert.equal(a.pendingCodeCount(), 1, '过期码不该一直留在表里');
});

// ── 撤掉 Cloudflare Access 前的加固 ──────────────────

test('配对码 12 字符，约 60 bit', () => {
  const a = createAuth({ token: TOKEN });
  const code = a.newPairingCode();
  assert.match(code, /^[A-Z2-9]{12}$/);
  // 32^12 ≈ 1.15e18；对比加固前 32^8 ≈ 1.1e12
  assert.equal(code.length, 12);
});

test('全局失败锁定：按 IP 限流挡不住分布式，需要总量闸门', () => {
  let t = 0;
  const a = createAuth({ token: TOKEN, now: () => t, maxFails: 3, globalMaxFails: 5, windowMs: 60000 });
  // 5 个不同 IP 各失败 1 次，任一 IP 都没超自己的额度
  for (let i = 0; i < 5; i += 1) a.noteFailure(`10.0.0.${i}`);
  const r = a.rateLimit('10.0.0.99');
  assert.equal(r.ok, false, '全局额度耗尽后，新 IP 也要被挡住');
  assert.ok(r.retryAfterSec > 0);
});

test('全局锁定同样随窗口恢复', () => {
  let t = 0;
  const a = createAuth({ token: TOKEN, now: () => t, maxFails: 3, globalMaxFails: 5, windowMs: 60000 });
  for (let i = 0; i < 5; i += 1) a.noteFailure(`10.0.0.${i}`);
  assert.equal(a.rateLimit('10.0.0.99').ok, false);
  t += 61000;
  assert.equal(a.rateLimit('10.0.0.99').ok, true);
});

// ── 按人派生的凭据 ──────────────────────────────

const FRIEND = { id: 'friend', name: 'Alice', roots: ['C:\\ws\\friend'], allowSend: null };
const withGuests = () => createAuth({ token: TOKEN, principals: [OWNER, FRIEND] });
const cookieValue = (setCookie) => /baton_session=([^;]+)/.exec(setCookie)[1];

test('owner 的旧凭据派生串照样认——现有设备不必重新配对', () => {
  // 这个值是加 principals 之前就在用的，升级前配过的设备手里都是它。现在新配对
  // 改发设备凭据，但旧值必须继续有效，否则 owner 的手机、iOS 客户端、PWA
  // 会在下一次请求时全部 401，而他们不知道为什么。
  const a = withGuests();
  const legacy = crypto
    .createHmac('sha256', TOKEN).update('baton-session-v1').digest('base64url');
  assert.equal(a.authorize(req({ cookie: `baton_session=${legacy}` })).principal.id, OWNER_ID);
  assert.equal(a.authorize(req({ authorization: `Bearer ${legacy}` })).principal.id, OWNER_ID);
});

/* ── 设备凭据与吊销（2026-11-15：解除配对要能作废原生 App 的 bearer） ── */

const legacyOwner = () => crypto
  .createHmac('sha256', TOKEN).update('baton-session-v1').digest('base64url');

test('每次配对发一张不同的设备凭据', () => {
  const a = createAuth({ token: TOKEN });
  const one = a.verifyPair(a.newPairingCode()).bearer;
  const two = a.verifyPair(a.newPairingCode()).bearer;
  assert.notEqual(one, two);
  assert.match(one, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(a.authorize(req({ authorization: `Bearer ${one}` })).ok, true);
  assert.equal(a.authorize(req({ authorization: `Bearer ${two}` })).ok, true);
});

test('解除后这张设备凭据 cookie 和 bearer 都不认了，别的设备不受影响', () => {
  const a = createAuth({ token: TOKEN });
  const gone = a.verifyPair(a.newPairingCode()).bearer;
  const kept = a.verifyPair(a.newPairingCode()).bearer;
  assert.equal(a.revoke(req({ authorization: `Bearer ${gone}` })), 'device');
  assert.equal(a.authorize(req({ authorization: `Bearer ${gone}` })).ok, false);
  assert.equal(a.authorize(req({ cookie: `baton_session=${gone}` })).ok, false);
  assert.equal(a.authorize(req({ authorization: `Bearer ${kept}` })).ok, true);
  assert.equal(a.authorize(req({ cookie: `baton_session=${legacyOwner()}` })).ok, true, '旧凭据不受牵连');
  assert.equal(a.authorize(req({ authorization: `Bearer ${TOKEN}` })).ok, true, '本机 token 不受牵连');
});

test('编出来的设备号作废不了任何东西', () => {
  const a = createAuth({ token: TOKEN });
  const real = a.verifyPair(a.newPairingCode()).bearer;
  const deviceId = real.split('.')[1];
  assert.equal(a.revoke(req({ authorization: `Bearer d1.${deviceId}.forged` })), 'none');
  assert.equal(a.authorize(req({ authorization: `Bearer ${real}` })).ok, true);
});

test('设备凭据换个身份验不过：访客的设备号套不到 owner 头上', () => {
  const a = withGuests();
  const guest = a.verifyPair(a.newPairingCode('friend')).bearer;
  assert.equal(a.authorize(req({ authorization: `Bearer ${guest}` })).principal.id, 'friend');
  const after = createAuth({ token: TOKEN, principals: [OWNER] });
  assert.equal(after.authorize(req({ authorization: `Bearer ${guest}` })).ok, false, '删掉身份后设备凭据也失效');
});

test('旧的共用凭据解除时报 legacy、不作废；本机 token 报 none', () => {
  const a = createAuth({ token: TOKEN });
  assert.equal(a.revoke(req({ cookie: `baton_session=${legacyOwner()}` })), 'legacy');
  assert.equal(a.authorize(req({ cookie: `baton_session=${legacyOwner()}` })).ok, true);
  assert.equal(a.revoke(req({ authorization: `Bearer ${TOKEN}` })), 'none');
  assert.equal(a.revoke(req()), 'none');
});

test('整个身份的旧凭据可以一起断，新配的设备凭据不受影响', () => {
  const revocations = memoryRevocations();
  const a = createAuth({ token: TOKEN, revocations });
  const fresh = a.verifyPair(a.newPairingCode()).bearer;
  revocations.revokeLegacy(OWNER_ID);
  assert.equal(a.authorize(req({ cookie: `baton_session=${legacyOwner()}` })).ok, false);
  assert.equal(a.authorize(req({ authorization: `Bearer ${fresh}` })).ok, true);
  assert.equal(a.authorize(req({ authorization: `Bearer ${TOKEN}` })).ok, true);
});

test('authorize 返回是谁', () => {
  const a = withGuests();
  const value = cookieValue(a.verifyPair(a.newPairingCode('friend')).setCookie);
  const r = a.authorize(req({ cookie: `baton_session=${value}` }));
  assert.equal(r.ok, true);
  assert.equal(r.principal.id, 'friend');
  assert.deepEqual(r.principal.roots, ['C:\\ws\\friend']);
});

test('访客与 owner 的凭据互不通用', () => {
  const a = withGuests();
  const guestCookie = cookieValue(a.verifyPair(a.newPairingCode('friend')).setCookie);
  const ownerCookie = cookieValue(a.verifyPair(a.newPairingCode()).setCookie);
  assert.notEqual(guestCookie, ownerCookie);
  assert.equal(a.authorize(req({ cookie: `baton_session=${ownerCookie}` })).principal.id, OWNER_ID);
});

test('从 principals 里删掉一个访客，它原先的凭据立刻失效', () => {
  const a = withGuests();
  const cookie = cookieValue(a.verifyPair(a.newPairingCode('friend')).setCookie);
  assert.equal(a.authorize(req({ cookie: `baton_session=${cookie}` })).ok, true);

  // 重启 Baton，principals.json 里已经没有 friend 了
  const after = createAuth({ token: TOKEN, principals: [OWNER] });
  assert.equal(after.authorize(req({ cookie: `baton_session=${cookie}` })).ok, false);
});

test('本机 token 走 Bearer 判为 owner', () => {
  const a = withGuests();
  const r = a.authorize(req({ authorization: `Bearer ${TOKEN}` }));
  assert.equal(r.ok, true);
  assert.equal(r.principal.id, OWNER_ID);
});

test('访客的 bearer 也认，且身份正确', () => {
  const a = withGuests();
  const { bearer } = a.verifyPair(a.newPairingCode('friend'));
  assert.equal(a.authorize(req({ authorization: `Bearer ${bearer}` })).principal.id, 'friend');
});

test('给不存在的身份铸码会抛', () => {
  assert.throws(() => withGuests().newPairingCode('nobody'), /nobody/);
});

test('principalIds 列出全部身份', () => {
  assert.deepEqual(withGuests().principalIds(), [OWNER_ID, 'friend']);
});

test('不带 principals 时退化为只有 owner，行为与改动前一致', () => {
  const a = createAuth({ token: TOKEN });
  assert.deepEqual(a.principalIds(), [OWNER_ID]);
  assert.equal(a.verifyPair(a.newPairingCode()).principal.id, OWNER_ID);
});

test('isSecureRequest 与动态 Secure Cookie 属性（HTTPS 带 Secure，明文 HTTP 局域网不带）', () => {
  assert.equal(isSecureRequest({ headers: {} }), false);
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }), true);

  const a = createAuth({ token: TOKEN });
  const httpsCookie = a.verifyPair(a.newPairingCode(), { secure: true }).setCookie;
  assert.match(httpsCookie, /;\s*Secure\b/i);
  const httpCookie = a.verifyPair(a.newPairingCode(), { secure: false }).setCookie;
  assert.doesNotMatch(httpCookie, /;\s*Secure\b/i);
  assert.match(httpCookie, /HttpOnly/i);
  assert.doesNotMatch(a.clearCookie({ secure: false }), /;\s*Secure\b/i);
  assert.match(a.clearCookie({ secure: true }), /;\s*Secure\b/i);
});
