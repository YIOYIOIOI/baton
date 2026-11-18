import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDoctor, codexSandboxState, clearSandboxCache } from '../src/agent/sandbox.js';

/*
  2026-11-10，codex 0.164：
  - doctor 要跑 100 秒，原先同步等它（上限 20 秒），打开会话配置时「权限档位」卡 20 秒，
    而且次次超时、答案永远是 unknown
  - 输出换了格式，沙箱那段里 `sandbox backend  elevated` 排在 `sandbox provisioning` 前面，
    旧判据抓到 backend 那行，沙箱没装好也答 ready
*/

// 2026-11-10 `codex doctor --no-color` 原文里的那一段（缩进照抄）
const V164 = [
  '  ✓ sandbox      unrestricted fs + enabled network · approval Never',
  '      approval policy          Never',
  '      filesystem sandbox       unrestricted',
  '      network sandbox          enabled',
  '      sandbox backend          elevated',
  '      denied-read restrictions false',
  '      sandbox provisioning     complete',
  '  ✓ sandbox      no explicit filesystem paths to probe',
].join('\n');

test('parseDoctor：0.164 的格式只认 provisioning 那行', () => {
  assert.equal(parseDoctor(V164), 'ready');
  // 同一段，只有 provisioning 那行变了：backend 那行排在前面也不能把它说成 ready
  assert.equal(parseDoctor(V164.replace('provisioning     complete', 'provisioning     incomplete')), 'missing');
  assert.equal(parseDoctor(V164.replace('provisioning     complete', 'provisioning     outdated')), 'missing');
  // 只有 backend 那行、没有 provisioning：说不准
  assert.equal(parseDoctor('      sandbox backend          elevated'), 'unknown');
});

test('codexSandboxState：头一回最多等一小会儿，等不到先答 unknown，跑完自己填上', async () => {
  clearSandboxCache();
  let release;
  let calls = 0;
  const run = () => { calls += 1; return new Promise((r) => { release = r; }); };
  const t0 = Date.now();
  assert.equal(await codexSandboxState({ run, waitMs: 30, now: 1000 }), 'unknown');
  assert.ok(Date.now() - t0 < 1000, '不能等 doctor 跑完');
  // 还在跑的时候再问：不另起一个，也不再等
  const t1 = Date.now();
  assert.equal(await codexSandboxState({ run, waitMs: 500, now: 1001 }), 'unknown');
  assert.ok(Date.now() - t1 < 200, '已经有一次在跑就直接答');
  assert.equal(calls, 1);
  release(V164);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await codexSandboxState({ run, waitMs: 30, now: 1002 }), 'ready');
  assert.equal(calls, 1);
  clearSandboxCache();
});

test('codexSandboxState：过期了先回旧答案，后台刷新', async () => {
  clearSandboxCache();
  await codexSandboxState({ run: async () => V164, now: 0 });
  let refreshed = false;
  const slow = () => new Promise((r) => { setTimeout(() => { refreshed = true; r(V164.replace('complete', 'incomplete')); }, 50); });
  const later = 31 * 60 * 1000;
  assert.equal(await codexSandboxState({ run: slow, now: later }), 'ready', '旧答案立刻回');
  assert.equal(refreshed, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await codexSandboxState({ run: slow, now: later + 1 }), 'missing', '刷新完是新的');
  clearSandboxCache();
});

test('BATON_NO_CLI_PROBES=1 时跳过真实 CLI 探针且不挂起进程', async () => {
  clearSandboxCache();
  const prev = process.env.BATON_NO_CLI_PROBES;
  process.env.BATON_NO_CLI_PROBES = '1';
  try {
    const t0 = Date.now();
    assert.equal(await codexSandboxState({ waitMs: 500, now: 5000 }), 'unknown');
    assert.ok(Date.now() - t0 < 200);
  } finally {
    if (prev === undefined) delete process.env.BATON_NO_CLI_PROBES;
    else process.env.BATON_NO_CLI_PROBES = prev;
    clearSandboxCache();
  }
});
