import crypto from 'node:crypto';
import { OWNER, OWNER_ID, isCurrentPrincipal } from '../principals.js';
import { memoryRevocations } from '../revocations.js';
import { memoryDevices } from '../devices.js';
import { removeDeviceSubscriptions } from '../push.js';

const COOKIE = 'baton_session';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 0O1I

/** Determine whether the incoming HTTP request arrived over TLS (directly or via reverse proxy). */
export function isSecureRequest(req) {
  if (req?.socket?.encrypted === true) return true;
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/**
 * 某个身份的会话凭据。由 token 派生，故守护进程重启后依然有效，且不暴露 token 本身。
 *
 * **owner 那条 salt 必须保持 'baton-session-v1' 逐字节不变**——它是加 principals
 * 之前就在用的值。改了的话 owner 的手机、iOS 客户端、PWA 会在下一次请求时全部 401，
 * 而他们不知道为什么。
 */
function credentialFor(token, principalId) {
  const label = principalId === OWNER_ID
    ? 'baton-session-v1'
    : `baton-principal-v1:${principalId}`;
  return crypto.createHmac('sha256', token).update(label).digest('base64url');
}

/**
 * 每台设备自己的凭据：`d1.<设备号>.<HMAC(token, 身份 + 设备号)>`。
 *
 * 上面那种共用凭据的问题是**分不出设备**：同一身份所有设备拿的是同一个值，服务端没法
 * 只作废其中一台。这一种仍然无状态（设备号 + 签名，验的时候现算），但设备号让「作废这一台」
 * 有了落点——见 revocations.js。
 *
 * 身份不写进凭据：验的时候对每个身份各算一次（个位数），算得上的就是它。这样凭据里没有
 * 任何可读信息，删掉一个身份它也自然失效（和共用凭据同一条路）。
 *
 * 设备号 12 字节随机数 base64url，字符集里没有 `.`，切分无歧义。
 */
const DEVICE_PREFIX = 'd1.';

function deviceMac(token, principalId, deviceId, generation = null) {
  return crypto.createHmac('sha256', token)
    .update(generation ? `baton-device-v2:${principalId}:${generation}:${deviceId}` : `baton-device-v1:${principalId}:${deviceId}`).digest('base64url');
}

function mintDeviceCredential(token, principal) {
  const deviceId = crypto.randomBytes(12).toString('base64url');
  return {
    deviceId,
    credential: `${principal.generation ? 'd2.' : DEVICE_PREFIX}${deviceId}.${deviceMac(token, principal.id, deviceId, principal.generation)}`,
  };
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * @param {{ token: string, principals?: object[], now?: () => number, codeTtlMs?: number,
 *   maxFails?: number, globalMaxFails?: number, windowMs?: number,
 *   revocations?: ReturnType<typeof memoryRevocations>,
 *   devices?: ReturnType<typeof memoryDevices>, revokedQueueGrant?: (id: string, generation: string | null) => boolean }} opts
 *   revocations  被解除的设备表。守护进程传 ~/.baton/revoked.json 那份（cli.js），
 *                不传就是一张空的内存表——和加这个功能之前的行为一致。
 */
export function createAuth({
  token, principals = [OWNER], now = () => Date.now(), codeTtlMs = 600000,
  maxFails = 10, globalMaxFails = 30, windowMs = 60000,
  revocations = memoryRevocations(), devices = memoryDevices(), revokedQueueGrant = null,
}) {
  if (!token) throw new Error('createAuth 需要 token');

  // 配置在启动时载入；验证已配对访客时另查持久化代际，防止沿用其他进程已撤销的授权。
  const byId = new Map();
  for (const p of principals) {
    const credential = !p.generation || p.acceptLegacy ? credentialFor(token, p.id) : null;
    byId.set(p.id, { principal: p, credential });
  }

  const codes = new Map(); // code -> { expiresAt, principalId }
  const fails = new Map(); // ip -> number[]（失败时间戳）
  let globalFails = []; // 全局失败时间戳：按 IP 的限流挡不住分布式攻击

  // 逐个比对。集合是个位数，且凭据不可猜——提前返回带来的那点时序差异
  // 只能透露「匹配到的是第几个身份」，对攻击者无用。
  //
  // 返回 { principal, deviceId }：deviceId 为 null 表示是升级前那种共用凭据。
  // 这里只核签名。鉴权还需经过下面的 identify 检查吊销状态。
  function signedCredential(value) {
    const v = String(value ?? '');
    const hasGeneration = v.startsWith('d2.');
    if (hasGeneration || v.startsWith(DEVICE_PREFIX)) {
      const rest = v.slice(DEVICE_PREFIX.length);
      const dot = rest.indexOf('.');
      if (dot <= 0) return null;
      const deviceId = rest.slice(0, dot);
      const mac = rest.slice(dot + 1);
      for (const { principal } of byId.values()) {
        if (hasGeneration ? !principal.generation : principal.generation && !principal.acceptLegacy) continue;
        if (timingSafeEqual(mac, deviceMac(token, principal.id, deviceId, hasGeneration ? principal.generation : null))) {
          return { principal, deviceId };
        }
      }
      return null;
    }
    for (const { principal, credential } of byId.values()) {
      if (credential && timingSafeEqual(v, credential)) {
        return { principal, deviceId: null };
      }
    }
    return null;
  }

  function identify(value) {
    const hit = signedCredential(value);
    if (!hit || !isCurrentPrincipal(hit.principal)) return null;
    const revoked = hit.deviceId ? revocations.isRevoked(hit.deviceId) : revocations.isLegacyRevoked(hit.principal.id);
    return revoked ? null : hit;
  }

  /** 请求里出示的凭据：cookie 优先，其次 Authorization: Bearer。 */
  function presented(req) {
    const fromCookie = readCookie(req?.headers?.cookie, COOKIE);
    const auth = String(req?.headers?.authorization ?? '');
    return [fromCookie, auth.startsWith('Bearer ') ? auth.slice(7) : null].filter(Boolean);
  }

  const revokeListeners = new Set();
  function currentPrincipal(id) {
    const p = byId.get(id)?.principal;
    return p && isCurrentPrincipal(p) ? p : null;
  }
  const emitRevoke = (ev) => {
    for (const fn of revokeListeners) {
      try {
        fn(ev);
      } catch {
        // Non-fatal listener failure
      }
    }
  };

  function revokePairedDevice(deviceId, principalId) {
    const changed = revocations.revoke(deviceId, principalId) !== false;
    if (changed) emitRevoke({ deviceId, principalId });
    try { removeDeviceSubscriptions(deviceId); }
    catch (err) { console.error('[baton] 已吊销设备，但清理推送订阅时出错。', err.message); }
    try {
      devices.remove(deviceId);
    } catch (err) {
      // 凭据已经从账本吊销；设备清单同样会按账本过滤。
      console.error('[baton] 已吊销设备，但清理设备清单时出错。', err.message);
    }
    return changed;
  }

  return {
    principalIds() {
      return [...byId.keys()].filter(currentPrincipal);
    },

    principalOf(id, queuedGeneration = undefined) {
      const principal = currentPrincipal(id);
      // Queue recovery distinguishes a temporarily unverifiable grant from a confirmed removal.
      if (!principal && queuedGeneration !== undefined && revokedQueueGrant && !revokedQueueGrant(id, queuedGeneration)) return undefined;
      return principal;
    },

    onRevoke(fn) {
      revokeListeners.add(fn);
      return () => revokeListeners.delete(fn);
    },

    isSessionValid({ deviceId = null, principalId = null, isLegacy = false } = {}) {
      if (principalId && !currentPrincipal(principalId)) return false;
      if (deviceId) return !revocations.isRevoked(deviceId);
      if (isLegacy && principalId) return !revocations.isLegacyRevoked(principalId);
      return true;
    },

    newPairingCode(principalId = OWNER_ID) {
      // 过期未使用的码只在验证时才会被删，不清理就会一直留着。
      // 量极小，但既然每次生成都要动这张表，就在这里顺手清掉。
      const t = now();
      for (const [c, entry] of codes) if (t > entry.expiresAt) codes.delete(c);

      if (!currentPrincipal(principalId)) {
        throw new Error(`没有这个身份：${principalId}`);
      }

      // 12 字符 ≈ 60 bit（32^12 ≈ 1.15e18）。加固前是 8 字符 ≈ 40 bit，
      // 在没有 Cloudflare Access 兜底的前提下不够——大型僵尸网络数周可破。
      // 一辈子只打几次，长度成本为零。
      const bytes = crypto.randomBytes(12);
      let code = '';
      for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
      codes.set(code, { expiresAt: t + codeTtlMs, principalId });
      return code;
    },

    // 仅供测试断言清理生效
    pendingCodeCount() {
      return codes.size;
    },

    verifyPair(code, { secure = true, userAgent = '' } = {}) {
      const normalized = String(code ?? '').trim().toUpperCase();
      const entry = codes.get(normalized);
      if (entry === undefined) {
        return { ok: false, reason: '配对码无效或已被使用。请在电脑终端重新获取一个。' };
      }
      if (now() > entry.expiresAt) {
        codes.delete(normalized);
        return { ok: false, reason: '配对码已过期（有效期 10 分钟）。请在电脑终端重新获取。' };
      }
      const hit = byId.get(entry.principalId);
      if (!hit || !isCurrentPrincipal(hit.principal)) {
        // 铸码之后 principals.json 被改过并重启了。重启会清空 codes，所以这条
        // 不该发生；留着是因为静默下发一个没有身份的凭据比报错糟得多。
        return {
          ok: false,
          reason: `这个配对码属于已不存在的身份 "${entry.principalId}"。请重新取一个码。`,
        };
      }
      // 每次配对一张新的设备凭据（不再是同一身份共用的那个值），解除时才能只作废这一台。
      // 升级前配过的设备手里还是共用凭据，照样认（identify 的第二段），不用重新配对。
      const { deviceId, credential } = mintDeviceCredential(token, hit.principal);
      devices.register({ deviceId, principalId: hit.principal.id, generation: hit.principal.generation, userAgent, now: now() });
      codes.delete(normalized); // 登记成功才消耗一次性配对码。
      const secAttr = secure ? '; Secure' : '';
      const attrs = `${COOKIE}=${credential}; Path=/; HttpOnly${secAttr}; SameSite=Lax; Max-Age=31536000`;
      // bearer 与 cookie 是同一个值（由 token 派生的 HMAC，不是 token 本身）。
      // 原生客户端读不到 Set-Cookie——iOS 的 NSURLSession 把 cookie 收进自己的
      // 存储，fetch 层看不见——所以必须有一条能自己拿到凭据的路。
      // **调用方要显式索取**：网页端不要，它就拿不到，HttpOnly 对那条路径才仍然作数。
      return { ok: true, setCookie: attrs, bearer: credential, principal: hit.principal, deviceId };
    },

    /**
     * 解除配对：把这台设备的 cookie 作废。
     *
     * **原来根本没有这个东西**，客户端的「解除配对」只清了本地存储——而浏览器里
     * 真正起作用的是 HttpOnly cookie，JS 删不掉它，服务端也照样认。
     * 结果是点完「解除配对」看着像退出了，一刷新又自动登了回去。
     * owner 实测发现：解除后点「配对」，不输码就直接恢复了。
     *
     * 只作废**这一台**，不动 token 本身——那会把电脑、其他手机一起踢掉，
     * 而用户点的是「这台设备解除」，不是「吊销所有设备」。
     *
     * 原生端拿的是 bearer，存在 Keychain 里，客户端自己删得掉；但「删掉」只是这台不再用它，
     * 值本身还活着。所以 /api/unpair 还会调下面的 revoke()，把出示的设备凭据拉进黑名单。
     */
    clearCookie({ secure = true } = {}) {
      // Max-Age=0 + 同样的 Path/属性，否则浏览器认为是另一个 cookie 而不覆盖
      const secAttr = secure ? '; Secure' : '';
      return `${COOKIE}=; Path=/; HttpOnly${secAttr}; SameSite=Lax; Max-Age=0`;
    },

    revoke(req) {
      let kind = 'none';
      for (const value of new Set(presented(req))) {
        if (timingSafeEqual(value, token)) continue; // 本机 token 不归这里管
        // 这里核验出示的签名后直接请求持久化。账本不可用时应报错，让客户端能重试。
        const hit = signedCredential(value);
        if (!hit) continue;
        if (hit.deviceId) {
          if (revokePairedDevice(hit.deviceId, hit.principal.id)) kind = 'device';
        } else if (kind === 'none' && !revocations.isLegacyRevoked(hit.principal.id)) {
          kind = 'legacy';
        }
      }
      return kind;
    },

    listDevices({ principalId = null } = {}) {
      return devices.list({ principalId }).filter((d) => {
        const principal = currentPrincipal(d.principalId);
        return principal && (d.generation ? d.generation === principal.generation : !principal.generation || principal.acceptLegacy)
          && !revocations.isRevoked(d.id);
      });
    },

    revokeDevice(deviceId, principalId = OWNER_ID) {
      if (!deviceId) return false;
      revokePairedDevice(deviceId, principalId);
      return true;
    },

    // 凭据以「Bearer 凭据」为内部抽象，cookie 只是 v1 的承载形态。
    // 只看 header，绝不看 query——token 进 query 会落 CF 日志与浏览器历史。
    authorize(req) {
      const fromCookie = readCookie(req?.headers?.cookie, COOKIE);
      if (fromCookie) {
        const hit = identify(fromCookie);
        if (hit) {
          if (hit.deviceId) devices.touch(hit.deviceId, now());
          return { ok: true, principal: hit.principal, deviceId: hit.deviceId, isLegacy: !hit.deviceId };
        }
      }
      const auth = String(req?.headers?.authorization ?? '');
      if (auth.startsWith('Bearer ')) {
        const given = auth.slice(7);
        // 两种 Bearer 都收：
        //   token      —— 本机工具（npm run pair 读 ~/.baton/token，权威是文件权限）。
        //                 一律判为 owner：能读到那个文件的人本来就是 owner
        //   派生凭据    —— 配对下发的会话凭据（token 派生的 HMAC），带身份
        // 原生客户端拿到的是后者。只认 token 的话它每次请求都会 401，
        // 而这条路径在浏览器里试不出来——浏览器走的是 cookie。
        if (timingSafeEqual(given, token)) return { ok: true, principal: OWNER, deviceId: null, isLegacy: false };
        const hit = identify(given);
        if (hit) {
          if (hit.deviceId) devices.touch(hit.deviceId, now());
          return { ok: true, principal: hit.principal, deviceId: hit.deviceId, isLegacy: !hit.deviceId };
        }
      }
      return {
        ok: false,
        reason: '未配对。请在跑着 Baton 的电脑上执行 `npm run pair` 取得配对码，在本页输入后即可访问。',
      };
    },

    noteFailure(ip) {
      const t = now();
      const cutoff = t - windowMs;
      if (!fails.has(ip) && fails.size >= 10_000) {
        for (const [k, v] of fails) {
          const fresh = v.filter((ts) => ts > cutoff);
          if (fresh.length === 0) fails.delete(k);
          else fails.set(k, fresh);
          if (fails.size < 10_000) break;
        }
        if (fails.size >= 10_000) {
          const oldestKey = fails.keys().next().value;
          if (oldestKey !== undefined) fails.delete(oldestKey);
        }
      }
      const list = fails.get(ip) ?? [];
      list.push(t);
      fails.set(ip, list);
      globalFails.push(t);
    },

    rateLimit(ip) {
      const cutoff = now() - windowMs;
      const retryFrom = (oldest) => Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));

      // 全局闸门优先：按 IP 的限流对分布式攻击无效，
      // 一万个 IP 各试一次就能绕过每 IP 额度。
      globalFails = globalFails.filter((t) => t > cutoff);
      if (globalFails.length >= globalMaxFails) {
        return { ok: false, retryAfterSec: retryFrom(globalFails[0]) };
      }

      const list = (fails.get(ip) ?? []).filter((t) => t > cutoff);
      if (list.length === 0) {
        fails.delete(ip);
        return { ok: true };
      }
      fails.set(ip, list);
      if (list.length < maxFails) return { ok: true };
      return { ok: false, retryAfterSec: retryFrom(list[0]) };
    },

    rateLimitBucketCount() {
      return fails.size;
    },
  };
}
