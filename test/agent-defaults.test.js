import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultsFromRequest, defaultsFromInit, probeEnv, probeClaudeDefaults, claudeDefaults,
  resetClaudeDefaults,
} from '../src/agent/defaults.js';
import { tmpDir } from './helpers.js';

// ── 从截下的请求里读 ───────────────────────────────

test('defaultsFromRequest：模型、1M 上下文、强度都从那条请求里读', () => {
  // 形状取自 2026-10-01 实测：claude 2.1.281 不传 --model / --effort 时发出的那条
  const r = defaultsFromRequest({
    body: { model: 'claude-opus-5-5', output_config: { effort: 'medium' }, messages: [] },
    beta: 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14',
  });
  assert.deepEqual(r, { id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1_000_000, effort: 'medium' });
});

test('defaultsFromRequest：不带 context-1m 就不报窗口，不猜一个 200K', () => {
  // 显式选 claude-opus-5-5 时实测就是这样：同一个模型，请求里没有 1M 那一项
  const r = defaultsFromRequest({ body: { model: 'claude-opus-5-5' }, beta: 'claude-code-20250219' });
  assert.equal(r.contextWindow, null);
  assert.equal(r.effort, null, '请求里没有强度就是不知道');
});

test('defaultsFromRequest：认不得的强度当成不知道', () => {
  const r = defaultsFromRequest({ body: { model: 'claude-opus-5-5', output_config: { effort: 'turbo' } } });
  assert.equal(r.effort, null);
});

test('defaultsFromInit：拿不到请求时，至少从 init 读出模型和 1M', () => {
  assert.deepEqual(defaultsFromInit('claude-opus-5-5[1m]'),
    { id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1_000_000, effort: null });
  assert.equal(defaultsFromInit('claude-opus-5-5').contextWindow, null);
  assert.equal(defaultsFromInit(''), null);
  assert.equal(defaultsFromInit(undefined), null);
});

// ── 探测进程的环境：两层保险里的第二层 ───────────────

test('probeEnv：本机以外的出站全走一个不存在的代理，大小写变体一并换掉', () => {
  const env = probeEnv({ PATH: 'x', https_proxy: 'http://corp:8080', Http_Proxy: 'http://corp:8080', no_proxy: '*' },
    'http://127.0.0.1:5555');
  const proxyKeys = Object.keys(env).filter((k) => /^(https?|no|all)_proxy$/i.test(k));
  assert.deepEqual(proxyKeys.sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'],
    'Windows 上环境变量不分大小写，留着小写那份等于两个值打架');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5555');
  assert.equal(env.PATH, 'x');
});

// ── 真起一个假的 claude ───────────────────────────

/** 假 claude：照真 CLI 的样子先吐 init，再按 mode 行事。 */
function fakeClaude(dir, mode) {
  const file = path.join(dir, `fake-claude-${mode}.mjs`);
  fs.writeFileSync(file, `
    import fs from 'node:fs';
    const i = process.argv.indexOf('--settings');
    const settings = process.argv[i + 1].replace(/^"|"$/g, '');
    const url = JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_BASE_URL;
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]' }));
    if (${JSON.stringify(mode)} === 'capture') {
      await fetch(url + '/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }],
          output_config: { effort: process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : 'medium' } }),
      }).catch(() => {});
      setInterval(() => {}, 1000);
    } else if (${JSON.stringify(mode)} === 'escaped') {
      console.log(JSON.stringify({ type: 'result', is_error: false, result: 'OK' }));
    } else {
      setInterval(() => {}, 1000);
    }
  `);
  return file;
}

const run = (dir, mode, opts = {}) => probeClaudeDefaults({
  command: process.execPath, prefixArgs: [`"${fakeClaude(dir, mode)}"`], cwd: dir, dir, ...opts,
});

test('probeClaudeDefaults：截到请求就读出来，进程被收掉，临时设置文件被删掉', async () => {
  const dir = tmpDir();
  const r = await run(dir, 'capture');
  assert.deepEqual(r, {
    value: { id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1_000_000, effort: 'medium' },
    escaped: false,
  });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('probe-settings')), []);
});

test('probeClaudeDefaults：拿到了真回答 = 请求漏出去了，要报出来', async () => {
  const dir = tmpDir();
  const r = await run(dir, 'escaped');
  assert.equal(r.escaped, true);
  assert.equal(r.value.id, 'claude-opus-5-5', '模型还能从 init 读出来');
  assert.equal(r.value.effort, null);
});

test('probeClaudeDefaults：一直不发请求，到点就收，给出 init 里读到的那部分', async () => {
  const dir = tmpDir();
  const r = await run(dir, 'hang', { timeoutMs: 3000 });
  assert.equal(r.escaped, false);
  assert.equal(r.value.id, 'claude-opus-5-5');
  assert.equal(r.value.effort, null);
});

// ── 缓存 ───────────────────────────────────────

test('claudeDefaults：有效期内只探一次；settings.json 一改就重探', async () => {
  resetClaudeDefaults();
  const dir = tmpDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{}');
  let calls = 0;
  const probe = async () => { calls += 1; return { value: { id: `m${calls}` }, escaped: false }; };
  const opts = { probe, settingsPath, ttlMs: 60_000 };
  assert.equal((await claudeDefaults(opts)).id, 'm1');
  assert.equal((await claudeDefaults(opts)).id, 'm1');
  assert.equal(calls, 1);
  // 同一时刻两个请求只起一个进程
  resetClaudeDefaults();
  calls = 0;
  const [a, b] = await Promise.all([claudeDefaults(opts), claudeDefaults(opts)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(settingsPath, later, later);
  assert.equal((await claudeDefaults(opts)).id, 'm2');
  resetClaudeDefaults();
});

test('claudeDefaults：请求漏出去过一次，就不再探了', async () => {
  resetClaudeDefaults();
  const dir = tmpDir();
  let calls = 0;
  const probe = async () => { calls += 1; return { value: { id: 'x' }, escaped: true }; };
  const opts = { probe, settingsPath: path.join(dir, 'none.json'), ttlMs: 0, log: () => {} };
  await claudeDefaults(opts);
  await claudeDefaults(opts);
  assert.equal(calls, 1, '两层保险都失效时，每次探测都是真花钱');
  resetClaudeDefaults();
});

// ── 接口 ───────────────────────────────────────

import { listModels } from '../src/http/handlers/settings.js';

const DISCOVERED = {
  claude: [], codex: [], note: '',
  config: {
    claude: { effort: null, contextWindow: null, defaultModel: null },
    codex: { effort: 'low', contextWindow: null, defaultModel: null },
  },
};

test('listModels：把问到的 Claude 默认补进 config.claude.defaultModel', async () => {
  const dm = { id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1_000_000, effort: 'medium' };
  const r = await listModels({ discover: async () => DISCOVERED, claude: async () => dm });
  assert.deepEqual(r.body.config.claude, { effort: null, contextWindow: null, defaultModel: dm });
  assert.equal(r.body.config.codex.effort, 'low', 'Codex 那一格原样透出');
});

test('listModels：还没问完就不等了，照常返回模型表', async () => {
  const t0 = Date.now();
  const r = await listModels({
    discover: async () => DISCOVERED, claude: () => new Promise(() => {}), waitMs: 50,
  });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.body.config.claude.defaultModel, null);
});

test('listModels：扫盘失败时 config 也有完整的形状', async () => {
  const r = await listModels({
    discover: async () => { throw new Error('boom'); }, claude: async () => null,
  });
  assert.deepEqual(r.body.config.claude, { effort: null, contextWindow: null, defaultModel: null });
});

test('probeClaudeDefaults：带上 Baton 默认轮次会带的参数去探，报的就是那一轮真正发出去的', async () => {
  const dir = tmpDir();
  const r = await run(dir, 'capture', { extraArgs: ['--effort', 'max'] });
  assert.equal(r.value.effort, 'max');
  assert.equal(r.value.contextWindow, 1_000_000);
});

test('claudeDefaults：默认强度要进探测参数，也要进缓存的键', async () => {
  resetClaudeDefaults();
  const dir = tmpDir();
  const calls = [];
  const probe = async (o) => { calls.push(o?.extraArgs ?? []); return { value: { id: 'm', effort: 'x' }, escaped: false }; };
  const opts = { probe, settingsPath: path.join(dir, 'none.json'), ttlMs: 60_000 };
  await claudeDefaults({ ...opts, effort: 'max' });
  await claudeDefaults({ ...opts, effort: 'max' });
  assert.deepEqual(calls, [['--effort', 'max']], '同一个默认只探一次');
  await claudeDefaults({ ...opts, effort: null });
  assert.deepEqual(calls.at(-1), [], '默认改回 CLI 自己的，就要重探');
  resetClaudeDefaults();
});
