import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseClaudeUsage, parseCodexLine, parseCodexLive, latestCodexUsage, claudeUsage, claudeProxy, readUsage,
  parseAntigravityUsage, antigravityUsage, clearUsageCache,
} from '../src/usage.js';
import { tmpDir } from './helpers.js';

// 2026-11-06 实测 /api/oauth/usage 的返回（删掉了全是 null 的那几十个键）
const REAL = {
  five_hour: { utilization: 73, resets_at: '2026-11-06T20:19:59.989193+00:00' },
  seven_day: { utilization: 15, resets_at: '2026-11-12T22:59:59.989210+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', group: 'session', percent: 73, resets_at: '2026-11-06T20:19:59.989193+00:00', is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 15, resets_at: '2026-11-12T22:59:59.989210+00:00', is_active: false },
  ],
};

test('parseClaudeUsage：认 limits 数组，种类换成中文名，时间换成毫秒', () => {
  const u = parseClaudeUsage(REAL);
  assert.deepEqual(u.windows.map((w) => [w.label, w.percent]), [['5 小时内', 73], ['本周 · 全部模型', 15]]);
  assert.equal(u.windows[0].resetsAt, Date.parse('2026-11-06T20:19:59.989193+00:00'));
  assert.equal(u.extraUsage, false);
});

test('parseClaudeUsage：没有 limits 时退回 five_hour / seven_day；没见过的种类照原名', () => {
  const u = parseClaudeUsage({ ...REAL, limits: undefined });
  assert.deepEqual(u.windows.map((w) => w.id), ['five_hour', 'seven_day']);
  const v = parseClaudeUsage({ limits: [{ kind: 'weekly_mystery', percent: 140 }] });
  assert.deepEqual(v.windows.map((w) => [w.label, w.percent]), [['weekly_mystery', 100]], '百分比夹在 0–100');
});

// 2026-11-04 一份真 rollout 里的那一行（info 删了）
const CODEX_LINE = JSON.stringify({
  timestamp: '2026-11-04T12:09:50.840Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: null,
    rate_limits: {
      limit_id: 'codex', primary: { used_percent: 19, window_minutes: 10080, resets_at: 1794290073 },
      secondary: null, plan_type: 'pro', rate_limit_reached_type: null,
    },
  },
});

test('parseCodexLine：token_count 里的 rate_limits → 窗口、套餐、时间点', () => {
  const u = parseCodexLine(CODEX_LINE);
  assert.equal(u.plan, 'pro');
  assert.deepEqual(u.windows, [{ id: 'primary', label: '本周', percent: 19, resetsAt: 1794290073000 }]);
  assert.equal(u.asOf, Date.parse('2026-11-04T12:09:50.840Z'));
  assert.equal(u.source, 'rollout');
  assert.equal(parseCodexLine('{"type":"event_msg","payload":{"type":"agent_message"}}'), null);
  assert.equal(parseCodexLine('不是 JSON'), null);
});

// 2026-11-07 实测 codex 0.164.0 app-server account/rateLimits/read 的返回（删了 rateLimitsByLimitId 那份重复的）
const LIVE = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1794290073 },
    secondary: null, planType: 'pro', rateLimitReachedType: null,
  },
};

test('parseCodexLive：app-server 的驼峰字段 → 同一套窗口；标明是现问的', () => {
  const u = parseCodexLive(LIVE, 123);
  assert.deepEqual(u.windows, [{ id: 'primary', label: '本周', percent: 40, resetsAt: 1794290073000 }]);
  assert.equal(u.plan, 'pro');
  assert.equal(u.source, 'live');
  assert.equal(u.asOf, 123);
  assert.equal(parseCodexLive({}), null);
});

test('readUsage：Codex 先现问；问不到才退回 rollout，并带上原因', async () => {
  clearUsageCache();
  const claude = async () => ({ available: true, windows: [] });
  const live = await readUsage({ force: true, claude, codexLive: async () => parseCodexLive(LIVE), codex: () => { throw new Error('不该读 rollout'); } });
  assert.equal(live.codex.source, 'live');
  assert.equal(live.codex.windows[0].percent, 40);

  const old = await readUsage({
    force: true, claude, codexLive: async () => { throw new Error('codex 没在时限内回话'); }, codex: () => parseCodexLine(CODEX_LINE),
  });
  assert.equal(old.codex.source, 'rollout');
  assert.equal(old.codex.windows[0].percent, 19);
  assert.match(old.codex.liveError, /时限/);
  clearUsageCache();
});

test('latestCodexUsage：取最新那份 rollout 里最后一条带额度的', () => {
  const home = tmpDir('baton-usage-');
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  const older = CODEX_LINE.replace('"used_percent":19', '"used_percent":5');
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), `${older}\n${CODEX_LINE}\n{"type":"event_msg","payload":{"type":"agent_message"}}\n`);
  assert.equal(latestCodexUsage({ home }).windows[0].percent, 19);
  assert.equal(latestCodexUsage({ home: tmpDir('baton-usage-empty-') }), null);
});

function claudeHome({ settingsEnv = {}, oauth } = {}) {
  const home = tmpDir('baton-usage-claude-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: settingsEnv }));
  if (oauth) fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  return home;
}

test('claudeUsage：走中转、没登录、凭据过期都不发请求，各给一句能照做的话', async () => {
  const never = async () => { throw new Error('不该发请求'); };
  const relay = await claudeUsage({ home: claudeHome({ settingsEnv: { ANTHROPIC_BASE_URL: 'https://relay.example' } }), env: {}, get: never });
  assert.equal(relay.available, false);
  assert.match(relay.reason, /中转/);

  const none = await claudeUsage({ home: claudeHome(), env: {}, get: never });
  assert.match(none.reason, /没有登录/);

  const expired = await claudeUsage({
    home: claudeHome({ oauth: { accessToken: 't', expiresAt: 1, subscriptionType: 'pro' } }), env: {}, now: 10, get: never,
  });
  assert.equal(expired.plan, 'pro');
  assert.match(expired.reason, /过期/);
});

test('claudeUsage：带令牌与 beta 头、走 settings.json 里的代理去问；403 时提示代理', async () => {
  const home = claudeHome({
    settingsEnv: { HTTPS_PROXY: 'http://127.0.0.1:10808' },
    oauth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000, subscriptionType: 'pro' },
  });
  let seen;
  const ok = await claudeUsage({
    home, env: {},
    get: async (url, headers, opts) => {
      seen = { url, headers, opts };
      return { status: 200, body: JSON.stringify(REAL) };
    },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.headers.Authorization, 'Bearer tok');
  assert.equal(seen.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen.opts.proxy, 'http://127.0.0.1:10808');
  assert.equal(ok.available, true);
  assert.equal(ok.windows.length, 2);
  assert.ok(!JSON.stringify(ok).includes('tok'), '令牌不能出现在回给页面的东西里');

  const denied = await claudeUsage({ home, env: {}, get: async () => ({ status: 403, body: '{}' }) });
  assert.match(denied.reason, /代理/);
});

test('claudeProxy：settings.json 的 env 优先于进程环境', () => {
  assert.equal(claudeProxy({ home: claudeHome({ settingsEnv: { HTTPS_PROXY: 'http://a:1' } }), env: { HTTPS_PROXY: 'http://b:2' } }), 'http://a:1');
  assert.equal(claudeProxy({ home: claudeHome(), env: { HTTPS_PROXY: 'http://b:2' } }), 'http://b:2');
});

test('readUsage：60 秒内复用，force 跳过缓存；Codex 没数据时给原因', async () => {
  clearUsageCache();
  let calls = 0;
  const claude = async () => {
    calls += 1;
    return { available: true, windows: [] };
  };
  const none = async () => { throw new Error('没有 codex'); };
  const a = await readUsage({ now: 1000, claude, codexLive: none, codex: () => null });
  await readUsage({ now: 30_000, claude, codexLive: none, codex: () => null });
  assert.equal(calls, 1);
  await readUsage({ now: 30_000, force: true, claude, codexLive: none, codex: () => null });
  assert.equal(calls, 2);
  assert.equal(a.codex.available, false);
  assert.match(a.codex.reason, /Codex/);
  clearUsageCache();
});

const AGY_USAGE_STDOUT = [
  JSON.stringify({
    event: 'command_result',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.7566387057304382, reset_time: '2026-11-24T08:35:44Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.9225422739982605, reset_time: '2026-11-17T20:42:48Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.15558911859989166, reset_time: '2026-11-24T09:28:12Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 0.3389012813568115, reset_time: '2026-11-17T20:43:19Z' },
            ],
          },
        ],
      },
    },
  }),
  JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }),
].join('\n');

test('parseAntigravityUsage：转换 remaining_fraction 为已用百分比并把 5h 排在本周前', () => {
  const u = parseAntigravityUsage(AGY_USAGE_STDOUT, { plan: 'Google AI Ultra', now: 12345 });
  assert.equal(u.plan, 'Google AI Ultra');
  assert.equal(u.asOf, 12345);
  assert.equal(u.source, 'live');
  assert.deepEqual(
    u.windows.map((w) => [w.label, Math.round(100 - w.percent)]),
    [
      ['Gemini · 5 小时内', 92],
      ['Gemini · 本周', 76],
      ['Claude / GPT · 5 小时内', 34],
      ['Claude / GPT · 本周', 16],
    ],
  );
  assert.equal(u.windows[0].resetsAt, Date.parse('2026-11-17T20:42:48Z'));
  assert.equal(parseAntigravityUsage('{"event":"error"}'), null);
});

test('antigravityUsage 与 readUsage：注入真实 CLI stdout 时返回 available: true', async () => {
  clearUsageCache();
  const ag = await antigravityUsage({
    planHint: 'Google AI Ultra',
    now: 5000,
    run: async () => ({ code: 0, stdout: AGY_USAGE_STDOUT, stderr: '' }),
  });
  assert.equal(ag.available, true);
  assert.equal(ag.plan, 'Google AI Ultra');
  assert.equal(ag.windows.length, 4);

  const combined = await readUsage({
    force: true,
    claude: async () => ({ available: false, reason: 'none' }),
    codexLive: async () => null,
    codex: () => null,
    antigravity: async () => ag,
  });
  assert.equal(combined.antigravity.available, true);
  assert.equal(combined.antigravity.windows.length, 4);
  clearUsageCache();
});
