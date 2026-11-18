// 两个 agent 的套餐额度（用量）。owner：「我需要一个查看额度的功能」。
//
// ## 数据从哪来（2026-11-06 实测）
//
// **Claude**：Claude Code 自己的 `/usage` 请求的是 `GET https://api.anthropic.com/api/oauth/usage`
// 带账号登录的 OAuth 令牌（~/.claude/.credentials.json）+ `anthropic-beta: oauth-2025-04-20`。
// 返回里有 `limits` 数组（kind / percent / resets_at），也有 five_hour、seven_day 这些单项。
//
//   直连回 403「Request not allowed」——这台电脑的出口在国内，而 claude 自己是走
//   `~/.claude/settings.json` 的 `env.HTTPS_PROXY` 出去的。走同一个代理就是 200。所以这里也走它。
//
// 令牌**只在服务端用、不出这台电脑**，回给页面的只有百分比和重置时间。令牌过期了**不去刷新**：
// refresh token 可能是一次性的，抢着刷会把 claude 自己的登录弄掉。过期就说过期，claude 下次
// 跑一轮会自己续上。
//
// **Codex**：现问 `codex app-server`（stdio JSON-RPC）的 `account/rateLimits/read`——codex 0.164.0
// 里有这个方法，回的是和它自己 /status 一样的数，登录续期、代理都由 codex 自己管，Baton 不碰它的凭据。
//
//   第一版读的是 rollout 里最后一条 `token_count.rate_limits`。owner 当天就说「codex 的用量不准确，
//   我刚刚看了这周还剩余 60%」：那条是 11-04 本机最后一次跑 Codex 时记的（已用 19%），之后在别处
//   用掉的这台电脑的文件里没有。实测 app-server 回的是已用 40%，正好对上。
//   所以 rollout 只在问不到（codex 起不来、超时）时兜底，并且标明是旧数。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execAgy, findAgyBinary } from './agent/agy.js';
import { antigravityCatalog, antigravityTier } from './agent/catalog.js';
import { claudeRoute } from './models.js';
import { killChildTree } from './agent/spawn.js';
import { claudeConfigDir, readClaudeOAuth } from './agent/preflight.js';
import { VERSION } from './version.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 60_000;

/** Claude 的窗口种类 → 界面上的名字。没见过的种类照原名显示，不丢 */
const CLAUDE_KINDS = {
  session: '5 小时内',
  five_hour: '5 小时内',
  weekly_all: '本周 · 全部模型',
  seven_day: '本周 · 全部模型',
  weekly_opus: '本周 · Opus',
  seven_day_opus: '本周 · Opus',
  weekly_sonnet: '本周 · Sonnet',
  seven_day_sonnet: '本周 · Sonnet',
};

const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);

/** `/api/oauth/usage` 的返回 → 窗口列表。优先认 `limits` 数组，没有就退回 five_hour / seven_day 单项 */
export function parseClaudeUsage(j) {
  const windows = [];
  if (Array.isArray(j?.limits) && j.limits.length) {
    for (const l of j.limits) {
      const p = pct(l?.percent);
      if (p === null) continue;
      windows.push({
        id: String(l.kind ?? l.group ?? windows.length),
        label: CLAUDE_KINDS[l.kind] ?? String(l.kind ?? '额度'),
        percent: p,
        resetsAt: toMs(l.resets_at),
      });
    }
  } else {
    for (const k of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const p = pct(j?.[k]?.utilization);
      if (p === null) continue;
      windows.push({ id: k, label: CLAUDE_KINDS[k], percent: p, resetsAt: toMs(j[k].resets_at) });
    }
  }
  return {
    windows,
    // 超额用量（额度用完之后按量付费）。没开就是 false
    extraUsage: j?.extra_usage?.is_enabled === true,
  };
}

/** app-server `account/rateLimits/read` 的结果 → 额度。没有 rateLimits 时回 null */
export function parseCodexLive(result, now = Date.now()) {
  const rl = result?.rateLimits ?? result?.rateLimitsByLimitId?.codex ?? null;
  if (!rl) return null;
  return {
    plan: typeof rl.planType === 'string' ? rl.planType : null,
    windows: [codexWindow('primary', rl.primary), codexWindow('secondary', rl.secondary)].filter(Boolean),
    reached: rl.rateLimitReachedType ?? null,
    asOf: now,
    source: 'live',
  };
}

/**
 * 起一次 `codex app-server`，问 `account/rateLimits/read`，拿到就收掉。
 *
 * 和 agent/spawn.js 同一套启动方式（Windows 上 codex 是 .cmd，必须经 shell）；收的时候也一样
 * 要 taskkill /t：shell 下 child 是那层 cmd.exe，只杀它会把 codex 本身留下。
 */
export function codexRateLimitsLive({ command = 'codex', timeoutMs = 20_000, now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    let buf = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // 已经关了
      }
      killChildTree(child);
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('codex 没在时限内回话')), timeoutMs);
    timer.unref?.();
    child.stdin?.on?.('error', (e) => finish(reject, e));
    const send = (o) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    child.on('error', (e) => finish(reject, e));
    child.on('exit', (code) => finish(reject, new Error(`codex app-server 提前退出了（${code}）`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) {
        finish(reject, new Error('codex app-server 输出超过上限'));
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          if (m.error) return finish(reject, new Error(m.error.message ?? 'rateLimits/read 出错'));
          const u = parseCodexLive(m.result, now());
          return u ? finish(resolve, u) : finish(reject, new Error('codex 没有回额度（可能没用 ChatGPT 账号登录）'));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'baton', title: 'Baton', version: VERSION } } });
  });
}

/** Codex 的一个窗口。窗口长度 300 分钟 = 5 小时，10080 = 一周。rollout 用下划线、app-server 用驼峰 */
function codexWindow(id, w) {
  const p = pct(w?.used_percent ?? w?.usedPercent);
  if (p === null) return null;
  const m = Number(w.window_minutes ?? w.windowDurationMins);
  const label = m === 300 ? '5 小时内' : m === 10080 ? '本周' : m % 1440 === 0 ? `${m / 1440} 天内` : m % 60 === 0 ? `${m / 60} 小时内` : `${m} 分钟内`;
  return { id, label, percent: p, resetsAt: toMs(w.resets_at ?? w.resetsAt) };
}

/** rollout 里一行 token_count → 额度。不是这种行、或者没带 rate_limits，回 null */
export function parseCodexLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const rl = o?.payload?.type === 'token_count' ? o.payload.rate_limits : null;
  if (!rl) return null;
  return {
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    windows: [codexWindow('primary', rl.primary), codexWindow('secondary', rl.secondary)].filter(Boolean),
    reached: rl.rate_limit_reached_type ?? null,
    asOf: toMs(o.timestamp),
    source: 'rollout',
  };
}

/** 最近几份 rollout 里最后一条带额度的 token_count。只读每个文件的尾巴，rollout 可能有几十 MB */
export function latestCodexUsage({ home = os.homedir(), files = 6, tailBytes = 512 * 1024 } = {}) {
  const root = path.join(home, '.codex', 'sessions');
  const all = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          all.push({ p, m: fs.statSync(p).mtimeMs });
        } catch {
          // 刚被挪走
        }
      }
    }
  };
  walk(root, 0);
  all.sort((a, b) => b.m - a.m);
  for (const { p } of all.slice(0, files)) {
    let text;
    try {
      const st = fs.statSync(p);
      const len = Math.min(st.size, tailBytes);
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, st.size - len);
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const hit = parseCodexLine(lines[i]);
      if (hit && hit.windows.length) return hit;
    }
  }
  return null;
}

/** claude 自己出站用的代理：settings.json 的 env 优先，其次进程环境 */
export function claudeProxy({ home = os.homedir(), env = process.env } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(env, home), 'settings.json'), 'utf8'))?.env ?? {};
    const v = s.HTTPS_PROXY ?? s.https_proxy;
    if (v) return String(v);
  } catch {
    // 没有或坏了：退回进程环境
  }
  return env.HTTPS_PROXY ?? env.https_proxy ?? null;
}

const MAX_USAGE_RESPONSE_BYTES = 1024 * 1024;

/**
 * GET 一个 HTTPS 地址，可选经 HTTP 代理（CONNECT 隧道）。Node 自带的 fetch 不认代理环境变量
 * （除非进程启动时就带 NODE_USE_ENV_PROXY），所以这里手写那一层隧道。
 */
export function httpsGet(url, headers, { proxy = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    let activeReq = null;
    let activeConnect = null;
    let activeSocket = null;
    const finish = (fn, v, errAbort = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (errAbort) {
        try { activeReq?.destroy(); } catch { /* ignore */ }
        try { activeConnect?.destroy(); } catch { /* ignore */ }
        try { activeSocket?.destroy(); } catch { /* ignore */ }
      }
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('超时'), true), timeoutMs);
    timer.unref?.();
    const request = (socket) => {
      activeSocket = socket;
      const req = https.request({
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        ...(socket ? { createConnection: () => tls.connect({ socket, servername: u.hostname }) } : {}),
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (body.length + c.length > MAX_USAGE_RESPONSE_BYTES) {
            finish(reject, new Error('额度响应超过上限'), true);
            return;
          }
          body += c;
        });
        res.on('end', () => finish(resolve, { status: res.statusCode ?? 0, body }));
        res.on('error', (e) => finish(reject, e, true));
      });
      activeReq = req;
      req.on('error', (e) => finish(reject, e, true));
      req.end();
    };
    if (!proxy) return request(null);
    let p;
    try {
      p = new URL(proxy);
    } catch {
      return finish(reject, new Error(`代理地址看不懂：${proxy}`));
    }
    const c = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: `${u.hostname}:${u.port || 443}`,
      headers: { host: `${u.hostname}:${u.port || 443}` },
    });
    activeConnect = c;
    c.on('connect', (res, socket) => {
      activeSocket = socket;
      if (res.statusCode === 200) request(socket);
      else finish(reject, new Error(`代理拒绝了连接（${res.statusCode}）`), true);
    });
    c.on('error', (e) => finish(reject, e, true));
    c.end();
  });
}

/**
 * Claude 账号额度。拿不到时回 `{ available: false, reason }`，reason 要能照着做。
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, keychain?: typeof import('./agent/preflight.js').readClaudeKeychain, now?: number, get?: typeof httpsGet }} [opts]
 */
export async function claudeUsage({
  home = os.homedir(), env = process.env, platform = process.platform, keychain = undefined, now = Date.now(), get = httpsGet,
} = {}) {
  let settings = '';
  try {
    settings = fs.readFileSync(path.join(claudeConfigDir(env, home), 'settings.json'), 'utf8');
  } catch {
    // 没有 settings.json 就按进程环境判
  }
  if (claudeRoute({ env, settings }) === 'relay') {
    return { available: false, reason: '这台电脑的 Claude 走第三方中转，账号额度只有中转那边看得到。' };
  }
  const oauth = readClaudeOAuth({ home, env, platform, ...(keychain ? { keychain } : {}) });
  if (!oauth?.accessToken) {
    return { available: false, reason: '电脑上的 claude 没有登录账号。在电脑上跑一次 claude 并 /login。' };
  }
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now) {
    return {
      available: false, plan,
      reason: '登录凭据刚过期。电脑上下次跑 claude 时会自动续上，之后再来看——Baton 不替它续，免得把它的登录弄掉。',
    };
  }
  let res;
  try {
    res = await get(USAGE_URL, {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    }, { proxy: claudeProxy({ home, env }) });
  } catch (e) {
    return { available: false, plan, reason: `问不到额度：${e.message}。检查电脑能不能连上 api.anthropic.com（claude 用的那个代理开着没有）。` };
  }
  if (res.status === 401) {
    return { available: false, plan, reason: '登录凭据被拒了（401）。电脑上跑一次 claude 让它续上登录。' };
  }
  if (res.status === 403) {
    return { available: false, plan, reason: '请求被拒（403）。多半是没走代理：claude 的代理写在 ~/.claude/settings.json 的 env.HTTPS_PROXY。' };
  }
  if (res.status !== 200) {
    return { available: false, plan, reason: `问额度时出错（HTTP ${res.status}），等一会儿再试。` };
  }
  let j;
  try {
    j = JSON.parse(res.body);
  } catch {
    return { available: false, plan, reason: '额度接口回的不是 JSON，可能是 Claude Code 换了格式。' };
  }
  return { available: true, plan, asOf: now, ...parseClaudeUsage(j) };
}

const AG_WINDOW_ORDER = { '5h': 0, weekly: 1 };

/**
 * 解析 `agy --output-format=stream-json --print=/usage` 的返回。
 * Antigravity 给的是 `remaining_fraction`（剩余比例 0..1），而 Baton 窗口统一存已用百分比
 * （`0..100`），界面再 `Math.round(100 - w.percent)` 还原为剩余。
 */
export function parseAntigravityUsage(raw, { plan = null, now = Date.now() } = {}) {
  let data = null;
  if (raw && typeof raw === 'object' && Array.isArray(raw.groups)) {
    data = raw;
  } else {
    for (const line of String(raw ?? '').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] !== '{') continue;
      let o;
      try {
        o = JSON.parse(s);
      } catch {
        continue;
      }
      if (o?.event === 'command_result' && o?.command?.name === 'usage' && o.command.data) {
        data = o.command.data;
        break;
      }
      if (o?.event === 'result' && o?.result?.command?.name === 'usage' && o.result.command.data) {
        data = o.result.command.data;
      }
    }
  }
  if (!Array.isArray(data?.groups)) return null;

  const windows = [];
  for (const g of data.groups) {
    const gName = String(g?.name ?? '');
    const shortGroup = /gemini/i.test(gName)
      ? 'Gemini'
      : /claude|gpt/i.test(gName)
        ? 'Claude / GPT'
        : (gName || '额度');
    const buckets = Array.isArray(g?.buckets) ? [...g.buckets] : [];
    buckets.sort((a, b) => (AG_WINDOW_ORDER[a?.window] ?? 9) - (AG_WINDOW_ORDER[b?.window] ?? 9));
    for (const b of buckets) {
      if (typeof b?.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue;
      const used = pct((1 - b.remaining_fraction) * 100);
      if (used === null) continue;
      const winLabel = b.window === '5h'
        ? '5 小时内'
        : b.window === 'weekly'
          ? '本周'
          : String(b.name || b.id || '额度');
      windows.push({
        id: String(b.id || `${shortGroup}-${b.window || windows.length}`),
        label: `${shortGroup} · ${winLabel}`,
        percent: used,
        resetsAt: toMs(b.reset_time),
      });
    }
  }
  return {
    plan,
    windows,
    asOf: now,
    source: 'live',
  };
}

/** 现问 `agy --output-format=stream-json --print=/usage` 获取 Antigravity 套餐实时余量。 */
export async function antigravityUsage({
  home = os.homedir(), env = process.env, now = Date.now(), run = null, planHint = undefined,
} = {}) {
  const agyBin = findAgyBinary({ env });
  if (!agyBin && !run) {
    return { available: false, reason: '本机未安装 agy CLI，安装后即可自动查询 Antigravity 实时套餐额度。' };
  }
  if (!run && env.BATON_NO_CLI_PROBES === '1') {
    return { available: false, reason: '测试环境已禁用 CLI 实时探测。' };
  }
  const r = run
    ? await run()
    : await execAgy(['--output-format=stream-json', '--print-timeout=15s', '--print=/usage'], {
      agyBin, env, home, timeoutMs: 18_000,
    });
  let tier = planHint !== undefined ? planHint : antigravityTier();
  if (!tier && !run && env.BATON_NO_CLI_PROBES !== '1') {
    await Promise.race([
      antigravityCatalog().catch(() => null),
      new Promise((resolve) => { setTimeout(resolve, 2500).unref?.(); }),
    ]);
    tier = antigravityTier();
  }
  const parsed = parseAntigravityUsage(r?.stdout ?? '', { plan: tier, now });
  if (parsed && parsed.windows.length > 0) {
    return { available: true, ...parsed };
  }
  const errLine = String(r?.stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return {
    available: false,
    ...(tier ? { plan: tier } : {}),
    reason: `问不到 Antigravity 额度：${errLine || 'CLI 未返回额度窗口'}。`,
  };
}

let cache = null;

/**
 * 三个 agent 的套餐额度。Claude 与 Antigravity 结果缓存 60 秒；`force` 是界面上的「刷新」。
 */
export async function readUsage({
  force = false, now = Date.now(), claude = claudeUsage, codexLive = codexRateLimitsLive,
  codex = latestCodexUsage, antigravity = antigravityUsage,
} = {}) {
  if (!force && cache && now - cache.at < TTL_MS) return cache.value;
  const [c, x, a] = await Promise.all([
    claude().catch((e) => ({ available: false, reason: `问不到额度：${e.message}` })),
    // 先现问；问不到再退回 rollout 里上一轮记下的，并且带上为什么问不到
    codexLive().catch((e) => {
      const old = (() => {
        try {
          return codex();
        } catch {
          return null;
        }
      })();
      return old ? { ...old, liveError: e.message } : null;
    }),
    antigravity().catch((e) => ({ available: false, reason: `问不到 Antigravity 额度：${e.message}` })),
  ]);
  const value = {
    claude: c,
    codex: x
      ? { available: true, ...x }
      : { available: false, reason: '问不到 Codex 的额度：codex 没起来，这台电脑上也还没有带额度信息的 Codex 会话。' },
    antigravity: a,
  };
  cache = { at: now, value };
  return value;
}

export function clearUsageCache() {
  cache = null;
}
