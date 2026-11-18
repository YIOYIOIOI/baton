import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { BATON_DIR } from './config.js';

/**
 * Web Push。零依赖实现，只用 node:crypto。
 *
 * **不带载荷**。RFC 8291 的载荷加密（ECDH + HKDF + aes128gcm）要多写一百多行，
 * 而它换来的只是「通知内容随推送一起到达」。不带载荷的做法是：推送只当一记
 * 敲门，service worker 醒来后自己去 fetch 当前状态再决定显示什么。
 * 这样反而更好——通知内容**永远是此刻的真实状态**，而不是几分钟前排队时的快照。
 *
 * 认证只需要 VAPID：一个 ES256 签的 JWT + 公钥，都在 header 里。
 */

const FILE = () => path.join(BATON_DIR, 'push.json');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function save(state) {
  fs.mkdirSync(BATON_DIR, { recursive: true });
  const tmp = `${FILE()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  // 私钥不能给别人读——和 ~/.baton/token 同一个道理
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  return state;
}

function isDisallowedIp(rawHost) {
  const host = String(rawHost ?? '').replace(/^\[|\]$/g, '');
  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (ipVer === 6) {
    const low = host.toLowerCase();
    if (low === '::1' || low === '::' || /^f[cd]/.test(low)
      || /^fe[89ab]/.test(low) || low.startsWith('::ffff:')) {
      return true;
    }
  }
  return false;
}

export async function resolvePublicTarget(endpoint, lookup = dns.promises.lookup) {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipVer = net.isIP(host);
  if (ipVer) {
    if (isDisallowedIp(host)) throw new Error('推送 endpoint 解析到本机或私有 IP');
    return { url, host, address: host, family: ipVer };
  }
  if (!lookup) {
    return { url, host, address: null, family: 0 };
  }
  const addrs = await lookup(host, { all: true });
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error('推送 endpoint 无法解析主机名');
  }
  for (const a of addrs) {
    if (isDisallowedIp(a?.address)) {
      throw new Error('推送 endpoint 解析到本机或私有 IP');
    }
  }
  const picked = addrs[0];
  const family = picked.family || net.isIP(picked.address) || 4;
  return { url, host, address: picked.address, family };
}

function sendPinnedPush({ url, target, headers, timeoutMs, requestImpl = https.request }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };
    const reqOpts = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: timeoutMs,
      ...(target.address
        ? {
          lookup(_hostname, opts, cb) {
            if (typeof opts === 'function') {
              opts(null, target.address, target.family);
              return;
            }
            if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
            else cb(null, target.address, target.family);
          },
        }
        : {}),
    };
    const req = requestImpl(reqOpts, (res) => {
      const status = res.statusCode ?? 0;
      // Do not follow 3xx redirects; drain and discard body immediately to release socket.
      res.resume();
      done(null, { status, ok: status >= 200 && status < 300 });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Push request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => done(err));
    req.end();
  });
}

/**
 * VAPID 密钥对，一次生成长期用。
 * 换了密钥，所有已有订阅**立刻全部失效**——推送服务按公钥认订阅。
 * 所以它必须落盘，不能每次启动重新生成。
 */
export function ensureKeys() {
  const existing = load();
  if (existing?.privateKeyPem && existing?.publicKey) return existing;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // 未压缩点格式 0x04||X||Y，共 65 字节——推送服务只认这个
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);

  return save({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: b64url(raw),
    subscriptions: existing?.subscriptions ?? [],
  });
}

export function publicKey() {
  return ensureKeys().publicKey;
}

/**
 * 一个 VAPID JWT。
 *
 * `dsaEncoding: 'ieee-p1363'` 是关键：node 默认签出 DER 包装的签名，
 * 而 JWT 要的是裸的 r||s（64 字节）。用默认值的话推送服务一律回 401，
 * 且错误信息里不会告诉你是这个原因。
 */
function vapidJwt(endpoint, privateKeyPem, { now = Date.now(), subject = 'mailto:Baton@localhost' } = {}) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud,
    exp: Math.floor(now / 1000) + 12 * 3600, // 上限 24 小时，取一半留余量
    sub: subject,
  }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  return `${data}.${b64url(sig)}`;
}

export { vapidJwt };

// ── 订阅 ────────────────────────────────────────

const ownerOf = (s) => s?.principalId ?? 'owner';

/** 校验 Web Push endpoint，只放行公网 HTTPS，阻断内网/本机/保留地址（防 SSRF）。 */
export function validatePushEndpoint(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('订阅缺少 endpoint');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('推送 endpoint 不是合法 URL');
  }
  if (u.protocol !== 'https:') throw new Error('推送 endpoint 必须使用 https://');
  if (u.username || u.password) throw new Error('推送 endpoint 不允许携带账号密码');

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.includes('%') || host === 'localhost'
    || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('推送 endpoint 不能指向本机或内网域名');
  }
  if (isDisallowedIp(host)) {
    throw new Error('推送 endpoint 不能指向本机或私有 IP');
  }
  return u;
}

export function listSubscriptions() {
  return ensureKeys().subscriptions ?? [];
}

export function subscribe(sub, principalId = 'owner') {
  validatePushEndpoint(sub?.endpoint);
  const state = ensureKeys();
  const subs = state.subscriptions ?? [];
  if (subs.some((s) => s.endpoint === sub.endpoint && ownerOf(s) !== principalId)) {
    throw new Error('该推送订阅已归属其他身份');
  }
  // endpoint + principalId 作为去重键，同一身份重复订阅覆盖而不是堆叠
  const next = subs.filter((s) => !(s.endpoint === sub.endpoint && ownerOf(s) === principalId));
  // principalId 由服务端从已认证的身份填入，**不信客户端自报**——
  // 信了的话访客报一个 'owner' 就能收到 owner 的全部通知。
  next.push({ endpoint: sub.endpoint, principalId, addedAt: Date.now() });
  save({ ...state, subscriptions: next });
  return next.length;
}

export function unsubscribe(endpoint, principalId = null) {
  const state = ensureKeys();
  const subs = (state.subscriptions ?? []).filter(
    (s) => !(s.endpoint === endpoint && (principalId === null || ownerOf(s) === principalId)),
  );
  save({ ...state, subscriptions: subs });
  return subs.length;
}

// ── 发送 ────────────────────────────────────────

/**
 * 敲一记门。不带载荷，所以只有 header。
 *
 * 推送服务回 404 / 410 表示这个订阅已经死了（用户卸了 PWA、清了数据），
 * **必须就地删掉**——留着的话每轮都去敲一次注定失败的门，日志里全是噪音。
 */
export async function notify({
  principalId = 'owner', fetchImpl = fetch,
  lookup = fetchImpl === fetch ? dns.promises.lookup : null,
  requestImpl = https.request,
  now = Date.now(), ttl = 600, timeoutMs = 10_000,
} = {}) {
  const state = ensureKeys();
  // 只推给这个身份的订阅。不分区的话，访客的手机会弹出 owner 的会话标题。
  // 旧订阅没有 principalId，视为 owner。
  const subs = (state.subscriptions ?? []).filter((s) => ownerOf(s) === principalId);
  if (!subs.length) return { sent: 0, dropped: 0 };

  let sent = 0;
  const dead = [];
  for (const s of subs) {
    let res = null;
    try {
      validatePushEndpoint(s.endpoint);
      const target = await resolvePublicTarget(s.endpoint, lookup);
      const headers = {
        TTL: String(ttl),
        Authorization: `vapid t=${vapidJwt(s.endpoint, state.privateKeyPem, { now })}, k=${state.publicKey}`,
        'Content-Length': '0',
      };
      if (fetchImpl !== fetch) {
        res = await fetchImpl(s.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers,
        });
      } else {
        res = await sendPinnedPush({ url: target.url, target, headers, timeoutMs, requestImpl });
      }
      if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else if (res.ok || res.status === 201) sent += 1;
    } catch {
      // 网络抖动或 SSRF/重定向拦截不算可恢复订阅变更——只有推送服务明确说 404/410 才删
    } finally {
      await res?.body?.cancel?.().catch(() => {});
    }
  }

  if (dead.length) {
    // Re-read current disk state after async network awaits so concurrent subscribe/setLatest
    // calls during notify are never clobbered.
    const latest = ensureKeys();
    save({
      ...latest,
      subscriptions: (latest.subscriptions ?? []).filter(
        (s) => !(dead.includes(s.endpoint) && ownerOf(s) === principalId),
      ),
    });
  }
  return { sent, dropped: dead.length };
}

// ── 最近一次结束的轮次 ──────────────────────────

/**
 * 推送不带载荷，所以 service worker 醒来后要自己来问「刚才结束的是哪一轮」。
 *
 * 记在这里而不是让 SW 去扫轮次记录：扫一遍要读该会话下所有轮次文件，
 * 而这里只有一条，读一次就够。也更准——SW 拿到的就是触发这次推送的那一轮。
 */
export function setLatest(principalId, latest) {
  const state = ensureKeys();
  const byPrincipal = { ...state.latestByPrincipal };
  byPrincipal[principalId] = { ...latest, at: latest.at ?? Date.now() };
  save({ ...state, latestByPrincipal: byPrincipal });
  return latest;
}

export function getLatest(principalId) {
  return load()?.latestByPrincipal?.[principalId] ?? null;
}
