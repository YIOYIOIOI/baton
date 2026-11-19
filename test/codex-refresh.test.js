import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { discoverModels } from '../src/models.js';
import { summarizeTurn } from '../src/agent/adapt.js';
import { runProcess } from '../src/agent/spawn.js';

test('下一轮采用更新后的桌面 CLI 和登录环境，不复活已移除的 API', async () => {
  const { codexRuntime } = await import('../src/agent/codexRuntime.js');
  const env = { BATON_CODEX_LOGIN_ENV: '1', OPENAI_BASE_URL: 'https://old.invalid', OTHER: 'keep' };
  let snapshot = { desktop: 'C:\\Test App\\v1\\codex.exe', variables: { OPENAI_BASE_URL: 'https://new.invalid' } };
  const readWindows = async () => snapshot;
  const first = await codexRuntime(env, { platform: 'win32', readWindows });
  assert.equal(first.command, snapshot.desktop);
  assert.equal(first.shell, false);
  assert.equal(first.env.OPENAI_BASE_URL, 'https://new.invalid');
  snapshot = { desktop: 'C:\\Test App\\v2\\codex.exe', variables: {} };
  const next = await codexRuntime(env, { platform: 'win32', readWindows });
  assert.equal(next.command, snapshot.desktop);
  assert.equal(next.env.OPENAI_BASE_URL, undefined);
  assert.equal(next.env.OTHER, 'keep');
  snapshot = { desktop: null, variables: {} };
  const standalone = await codexRuntime({ OPENAI_BASE_URL: 'https://manual.invalid' }, { platform: 'win32', readWindows });
  assert.equal(standalone.command, 'codex');
  assert.equal(standalone.shell, true);
  assert.equal(standalone.env.OPENAI_BASE_URL, 'https://manual.invalid');
});

test('配置、账号或目录文件变化立即刷新模型，历史型号不冒充当前推荐', async () => {
  const home = tmpDir('baton-codex-refresh-');
  const codexHome = path.join(home, 'custom');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'sessions', 'old.jsonl'), JSON.stringify({ payload: { model: 'old-relay' } }));
  const config = path.join(codexHome, 'config.toml');
  fs.writeFileSync(config, "model = 'first'\n[profiles.previous]\nmodel = 'old-relay'");
  let probes = 0;
  const opts = { home, env: { CODEX_HOME: codexHome }, now: 100, catalog: async () => [{ id: `live-${++probes}` }] };
  const [first, same] = await Promise.all([discoverModels(opts), discoverModels(opts)]);
  assert.deepEqual(first, same);
  assert.equal(first.config.codex.defaultModel?.id, 'first');
  assert.equal(first.codex.find(({ id }) => id === 'old-relay')?.hidden, true);
  await discoverModels(opts);
  assert.equal(probes, 1);
  fs.writeFileSync(config, 'model = "other"');
  assert.equal((await discoverModels(opts)).config.codex.defaultModel?.id, 'other');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  await discoverModels(opts);
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), '{}');
  await discoverModels(opts);
  await discoverModels({ ...opts, force: true });
  await discoverModels({ ...opts, env: { ...opts.env, OPENAI_BASE_URL: 'https://new.invalid' } });
  assert.equal(probes, 6);
});

test('在解析 CLI 时停止，不会继续启动这一轮', async () => {
  let handle;
  const result = runProcess({ command: process.execPath, args: ['--version'], onStart: (started) => { handle = started; } });
  assert.ok(handle);
  handle.kill();
  const stopped = await result;
  assert.equal(stopped.killed, true);
  assert.deepEqual(stopped.lines, []);
});

test('model_not_found 保留服务端原因并提示重新选模型', () => {
  const message = JSON.stringify({ error: { code: 'model_not_found', message: 'Model unavailable for this account.' } });
  const result = summarizeTurn('codex', [JSON.stringify({ type: 'turn.failed', error: { message } })]);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Model unavailable for this account/);
  assert.match(result.error, /模型菜单/);
});
