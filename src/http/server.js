import http from 'node:http';
import fs from 'node:fs';
import { finished } from 'node:stream';
import { errorBody } from './errors.js';
import { postAsk } from './handlers/ask.js';
import { ASK_HEADER } from '../ask/protocol.js';
import { cancelAsk, resolveAskToken } from '../ask/store.js';
import { buildRoutes } from './routes.js';
import { isSecureRequest } from './auth.js';
import { appendAuditEvent } from '../audit.js';
import { scopeRepo } from '../scope.js';
import { cacheOf, isMobileUA, mimeOf, pickWebRoot, resolveStatic, webRootLabel } from './static.js';
import { MAX_BYTES } from '../upload.js';

// 传输层的闸比业务层高一点：多出来的余量留给 HTTP 分块开销，
// 让「文件超限」这个更具体的错误由 upload.js 报出来，而不是被这里一刀切成 413。
const MAX_UPLOAD = MAX_BYTES + 1024 * 1024;

// 「我确实到达了源站」的正面标记。没有它，客户端分不清 Baton 的 401 与
// 中间设备的 200：公司网的强制门户会拿任意 HTML 回 200，隧道断了 CF 回 1033，
// Baton 挂了 cloudflared 回 502——全都不是 Baton 说的话。
// 客户端只认带这个头的响应。
const ORIGIN_MARK = { 'X-Baton': '1' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', ...ORIGIN_MARK, ...SEC_HEADERS, ...headers,
  });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}
class BodyBudgetBusy extends Error {}
class BodyTimedOut extends Error {}

function bodyCapacity(req, limit) {
  const declared = req.headers['content-length'];
  const capacity = declared === undefined ? (req.headers['transfer-encoding'] ? limit : 0) : Number(declared);
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > limit) throw new BodyTooLarge();
  return capacity;
}

// The deadline applies to the entire pairing body, including a client that keeps sending small pieces.
function receivePairBody(req, capacity, timeoutMs) {
  const bytes = Buffer.allocUnsafe(capacity);
  return new Promise((resolve, reject) => {
    let length = 0;
    const timer = setTimeout(() => finish(new BodyTimedOut()), timeoutMs);
    timer.unref();
    const unwatch = finished(req, { readable: true, writable: false }, finish);
    function append(chunk) {
      if (chunk.length > capacity - length) { finish(new BodyTooLarge()); return; }
      chunk.copy(bytes, length);
      length += chunk.length;
    }
    function finish(err) {
      clearTimeout(timer);
      unwatch();
      req.off('data', append);
      if (err) {
        req.pause();
        req.once('error', () => {}); // the client can still disconnect before the error response is flushed
        reject(err);
      } else {
        resolve(bytes.subarray(0, length));
      }
    }
    req.on('data', append);
  });
}

// 每个请求只分配一份缓冲。分块传输在开始时预留该路由的最大容量。
function bodyReader(budget) {
  let reserved = 0;
  return async function readBody(req, limit, consume) {
    const capacity = bodyCapacity(req, limit);
    if (capacity > budget - reserved) throw new BodyBudgetBusy();
    reserved += capacity;
    try {
      const bytes = Buffer.allocUnsafe(capacity);
      let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        if (chunk.length > capacity - length) throw new BodyTooLarge();
        chunk.copy(bytes, length);
        length += chunk.length;
      }
      return await consume(bytes.subarray(0, length));
    } finally {
      reserved -= capacity;
    }
  };
}

// JSON 体的上限。最长的合法 JSON 请求是发消息（正文上限 10 万字符），
// 按最坏情况的 UTF-8 膨胀 + 转义算，2 MB 绰绰有余。
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PAIR_BODY = 1024; // a 12-character code and an optional response format

function parseBodyJson(bytes) {
  let v;
  try {
    v = JSON.parse(bytes.toString('utf8') || '{}');
  } catch {
    return {}; // 坏 JSON 当空对象，由各 handler 自己校验必填字段
  }
  // 只收对象。`null`、数组、数字都是合法 JSON，而各 handler 都按对象解构——
  // 原来 `POST /api/pair` 带个 `null` 就能不登录直接把守护进程打挂（2026-10-01 审查）
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * 开发期跨源放行。
 *
 * 只在 config.devCorsOrigin 精确等于请求的 Origin 时才发头，三条刻意的限制：
 *
 * 1. **不接受 '*'**。通配等于允许任何网站的脚本调这台 Baton。
 * 2. **不发 Access-Control-Allow-Credentials**。于是浏览器不会带 cookie 跨源，
 *    唯一能用的凭据是显式的 Bearer——而那个值恶意站点读不到。少了这个头，
 *    "某个网站趁你登着就把会话读走"这条路径根本不存在。
 * 3. **默认关闭**，且开启时启动横幅要喊一嗓子。
 */
function corsHeaders(config, req) {
  const allow = config.devCorsOrigin;
  if (!allow || allow === '*') return null;
  const origin = req.headers.origin;
  if (!origin || origin !== allow) return null;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    // 跨源时浏览器只让 JS 读几个白名单响应头，X-Baton 不在其中——不暴露的话
    // 客户端看不见源站标记，会把 Baton 自己的 200 判成「被中间设备拦截」。
    // 实测踩过：web 端配对报「intercepted，HTTP 200」，而请求其实已经到了 Baton。
    // 原生客户端没有同源模型，不受这条影响。
    'Access-Control-Expose-Headers': 'X-Baton',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function isCrossOriginWrite(req, pathname, config) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  if (pathname === '/api/ask') return false;
  if (req.headers.authorization && pathname !== '/api/pair' && pathname !== '/api/unpair') return false;
  if (config.devCorsOrigin && config.devCorsOrigin !== '*'
    && req.headers.origin === config.devCorsOrigin && !req.headers.cookie) {
    return false;
  }

  const sfs = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return true;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return true;
    try {
      const u = new URL(origin);
      const host = String(req.headers.host ?? '').toLowerCase();
      if (!host || u.host.toLowerCase() !== host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function createServer({ repo, auth, config, maxBodyBytesInFlight = 64 * 1024 * 1024,
  maxPairBodiesInFlight = 8, pairBodyTimeoutMs = 10_000 }) {
  // 路由表来自 routes.js（唯一真源），这里只负责分发——
  // 不再有散落的正则与 if 链，也就不会再出现「分支永远进不去」
  const routes = buildRoutes({ auth });
  const readBody = bodyReader(maxBodyBytesInFlight);
  let pendingPairBodies = 0;
  async function readPairBody(req) {
    const capacity = bodyCapacity(req, MAX_PAIR_BODY);
    if (pendingPairBodies >= maxPairBodiesInFlight) throw new BodyBudgetBusy();
    pendingPairBodies++;
    try {
      return parseBodyJson(await receivePairBody(req, capacity, pairBodyTimeoutMs));
    } finally {
      pendingPairBodies--;
    }
  }
  const readJson = (req) => readBody(req, MAX_JSON, parseBodyJson);
  const unauthorized = (reason) => errorBody('unauthorized', reason,
    '在跑着 Baton 的电脑上执行 npm run pair 取得配对码，在页面顶部的输入框里录入即可。');

  function accessContext(authorized) {
    const principal = authorized.principal;
    return {
      principal, deviceId: authorized.deviceId ?? null, isLegacy: authorized.isLegacy ?? false,
      repo: scopeRepo(repo, principal),
      config: { ...config, allowSend: config.allowSend === true && (principal.allowSend ?? true) },
    };
  }

  async function handle(req, res) {
    let parsed;
    let pathname;
    try {
      parsed = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      // 坏掉的百分号转义（比如 /%E0%A4%A）。这一步在认证之前，原来不用登录就能打挂守护进程
      send(res, 400, errorBody('bad_path', '请求地址里有解不开的字符。', '检查链接是不是被截断、或者被手动改坏了。'));
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';

    const cors = corsHeaders(config, req);
    if (req.method === 'OPTIONS') {
      // 预检。没开 CORS 时同样回 204 但不带放行头——浏览器据此拒绝，
      // 这比回 404 更容易看懂发生了什么。
      res.writeHead(204, { ...ORIGIN_MARK, ...cors });
      res.end();
      return;
    }
    if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    // 静态资源：页面必须能在未配对时加载，否则配对输入框都出不来。
    // 走在认证之前——这些只是代码，不含任何会话数据。
    if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
      // 按这次请求的 UA 挑。**不能在启动时定死**：同一台 Baton 同时服务
      // 手机和电脑，而它们该拿到的是不同的那一套。
      const webRoot = pickWebRoot({ mobile: isMobileUA(req.headers['user-agent']) });
      const file = resolveStatic(webRoot.dir, pathname, { spa: webRoot.kind === 'spa' });
      if (file) {
        try {
          const buf = fs.readFileSync(file);
          res.writeHead(200, {
            'Content-Type': mimeOf(file),
            'Cache-Control': cacheOf(file),
            ...ORIGIN_MARK,
            ...SEC_HEADERS,
          });
          res.end(req.method === 'HEAD' ? undefined : buf);
        } catch {
          send(res, 500, errorBody('asset_missing', '静态资源读不到。',
            `确认 ${webRootLabel(webRoot.kind)} 下的文件完整；`
            + ' Expo 那套要先跑 npm run build:web。'));
        }
        return;
      }
    }

    if (isCrossOriginWrite(req, pathname, config)) {
      send(res, 403, errorBody('cross_origin', '拒绝跨源写入请求。', '请从 Baton 自己的页面直接操作。'));
      return;
    }

    if (pathname === '/api/pair' && req.method === 'POST') {
      const limited = auth.rateLimit(ip);
      if (!limited.ok) {
        send(res, 429, errorBody('rate_limited', '配对尝试过于频繁。', `等 ${limited.retryAfterSec} 秒后再试。`),
          { 'Retry-After': String(limited.retryAfterSec) });
        return;
      }
      const secure = isSecureRequest(req);
      const { code, want } = await readPairBody(req);
      const r = auth.verifyPair(code, { secure, userAgent: String(req.headers['user-agent'] ?? '') });
      if (!r.ok) {
        auth.noteFailure(ip);
        try { appendAuditEvent({ type: 'pair_fail', ip }); } catch { /* ignore */ }
        send(res, 400, errorBody('bad_pairing_code', r.reason,
          '在跑着 Baton 的电脑上执行 npm run pair 取一个新的，10 分钟内有效。'));
        return;
      }
      try {
        appendAuditEvent({ type: 'pair_ok', principal: r.principal.id, deviceId: r.deviceId ?? null });
      } catch { /* ignore */ }
      // 原生客户端读不到 Set-Cookie，要显式索取 bearer。网页端不传 want，
      // 就拿不到这个值——HttpOnly 对网页那条路径因此仍然作数。
      const body = { ok: true, deviceId: r.deviceId, ...(want === 'bearer' ? { bearer: r.bearer } : {}) };
      send(res, 200, body, { 'Set-Cookie': r.setCookie });
      return;
    }

    // 解除配对。**放在认证之前**，且不要求已认证：
    // 已经半解除（本地清了、cookie 还在）的客户端也得能把 cookie 清掉，
    // 否则它会卡在「看着没配对、其实还连着」的状态里出不来。
    // 这个端点不泄露任何东西，无需鉴权。
    //
    // 带来的若是设备凭据（cookie 或 Bearer），顺手把它写进吊销表：之后谁拿这个值重放都是 401。
    // 只作废**请求自己出示的那张**，且得验得过——编一个设备号来踢别人做不到（auth.revoke）。
    // 升级前的共用凭据分不出设备，这里只能清 cookie；revoked 字段把这件事如实告诉客户端。
    if (pathname === '/api/unpair' && req.method === 'POST') {
      const secure = isSecureRequest(req);
      const revoked = auth.revoke(req);
      if (revoked === 'device') {
        try { appendAuditEvent({ type: 'unpair', kind: revoked }); } catch { /* ignore */ }
      }
      send(res, 200, { ok: true, revoked }, { 'Set-Cookie': auth.clearCookie({ secure }) });
      return;
    }

    /*
      agent 送来一道选择题。**走在 authorize 之前**，因为打这个端点的不是人：
      是 claude 拉起的 MCP 服务器（src/ask/mcp.js），它没有、也不该有任何人的
      凭据。它出示的是守护进程在起这一轮时塞给它的一次性令牌，令牌自己就说明了
      「哪个会话、哪一轮」——身份不从请求体读（读了 agent 就能自报别人的会话）。

      这条响应会**一直挂着**直到用户答完。挂住它就是挂住 agent 那一轮，
      而那正是这个功能的全部意义。
    */
    if (pathname === '/api/ask' && req.method === 'POST') {
      const who = resolveAskToken(req.headers[ASK_HEADER]);
      if (!who) {
        const denied = await postAsk({ headers: req.headers, body: {} });
        send(res, denied.status, denied.body, { Connection: 'close' });
        return;
      }
      const body = await readJson(req);
      let settled = false;
      /*
        连接断了 = 那一轮的进程没了（被停止、超时被杀、claude 自己退了）。
        撤掉挂起的题，否则手机上会留下一张点了也没人接的卡。

        挂在 **res** 上不是 req 上：req 的 'close' 在请求体读完时就发过了
        （实测踩过——挂在 req 上等于永远收不到「客户端走了」），
        而 ServerResponse 的 'close' 才是连接真正终止的那一刻。

        `settled` 拦的是正常收尾：res.end() 之后 'close' 照样会发一次，
        那时这道题早已答完，不该再去撤一道**后来新开的**题。
      */
      res.on('close', () => {
        if (!settled) cancelAsk(who.key);
      });
      const r = await postAsk({ headers: req.headers, body });
      settled = true;
      if (!res.writableEnded && !res.destroyed) send(res, r.status, r.body);
      return;
    }

    const authed = auth.authorize(req);
    if (!authed.ok) {
      send(res, 401, unauthorized(authed.reason), {
        'Cache-Control': 'private, no-store', ...(req.method === 'POST' ? { Connection: 'close' } : {}),
      });
      return;
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.match(pathname);
      if (match === null) continue;
      const context = {
        match, query: parsed.searchParams, req, res,
        ...accessContext(authed),
      };
      const pre = route.preflight?.(context);
      if (pre?.status) {
        send(res, pre.status, pre.body, { Connection: 'close' });
        return;
      }
      const runAfterRead = (body, raw = undefined) => {
        const current = auth.authorize(req);
        if (!current.ok || current.principal.id !== context.principal.id || current.principal.generation !== context.principal.generation
            || (current.deviceId ?? null) !== context.deviceId) {
          return { status: 401, body: unauthorized('设备配对状态已改变。') };
        }
        const fresh = { ...context, ...accessContext(current), body, raw };
        const denied = route.preflight?.(fresh);
        return denied?.status ? denied : route.run(fresh);
      };
      let out;
      if (route.rawBody) out = await readBody(req, MAX_UPLOAD, (raw) => runAfterRead({}, raw));
      else if (route.needsBody) out = await runAfterRead(await readJson(req));
      else out = await route.run({ ...context, body: {} });
      if (out) send(res, out.status, out.body); // out 为 null 表示响应已被接管（SSE）
      return;
    }

    send(res, 404, errorBody('not_found', `没有这个端点：${req.method} ${pathname}`,
      '检查请求路径与方法；全部端点见 src/http/routes.js。'));
  }

  /*
    整个请求处理套一层兜底。

    handle 是 async 的，里面任何一处抛出来都会变成「没人处理的拒绝」，而 Node
    对它的默认处理是**让整个进程退出**——2026-10-01 审查复现了三种，其中两种不用
    登录。守护进程一退，手机上所有会话都断，正在跑的轮次也没人收尾了。
    所以：没预料到的异常回 500、原文只进日志（不回给客户端，那里面可能有路径）；
    响应已经发出去一半（SSE）的，只能断开连接。
  */
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.destroyed) return;
      if (!res.headersSent && err instanceof BodyTooLarge) {
        send(res, 413, errorBody('body_too_large', '请求正文超过上限。', '缩小文件或消息后重试。'), { Connection: 'close' });
        return;
      }
      if (!res.headersSent && err instanceof BodyBudgetBusy) {
        send(res, 503, errorBody('body_budget_busy', '其他请求正在传输数据。', '稍后重试。'), { Connection: 'close', 'Retry-After': '1' });
        return;
      }
      if (!res.headersSent && err instanceof BodyTimedOut) {
        send(res, 408, errorBody('body_timeout', '配对请求未在限定时间内传完。', '请重新提交配对码。'), { Connection: 'close' });
        return;
      }
      console.error(`  ⚠ ${req.method} ${String(req.url).split('?')[0]} 处理时抛了异常：`, err?.stack ?? err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, 500, errorBody('internal_error', '服务端出了一个没预料到的错。',
        '再试一次；还不行的话看那台电脑上的 ~/.baton/daemon.out.log，这次的报错在里面。'));
    });
  });
}
