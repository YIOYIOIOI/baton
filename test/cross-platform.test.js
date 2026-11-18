import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { claudeRegistryRoots } from '../src/titles.js';
import { buildRegistryEntry, loadTemplate, pickRegistryDir } from '../src/agent/registry.js';
import { defaultRegistrar } from '../src/http/handlers/create.js';
import { claudeLoggedIn, claudeConfigDir, readClaudeOAuth } from '../src/agent/preflight.js';
import { claudeUsage } from '../src/usage.js';
import { scanRecent } from '../src/models.js';
import { appendAuditEvent } from '../src/audit.js';
import { tmpDir } from './helpers.js';

test('claudeRegistryRoots 覆盖 macOS、Linux 与 Windows 的候选路径', () => {
  const mac = claudeRegistryRoots({ platform: 'darwin', home: '/Users/alice', env: {} });
  assert.ok(mac.some((p) => p.includes('Library/Application Support/Claude/claude-code-sessions')));

  const linux = claudeRegistryRoots({ platform: 'linux', home: '/home/alice', env: {} });
  assert.ok(linux.some((p) => p.includes('.config/Claude/claude-code-sessions')));

  const win = claudeRegistryRoots({
    platform: 'win32',
    home: 'C:\\Users\\alice',
    env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
  });
  assert.ok(win.some((p) => p.includes('Claude-3p')));
  assert.ok(win.some((p) => p.includes('AnthropicClaude')));
});

test('缺少桌面 App 模板时 buildRegistryEntry 降级产出条目，defaultRegistrar 返回 null 而不抛异常', () => {
  const empty = tmpDir();
  assert.equal(pickRegistryDir({ root: empty }), null);
  assert.equal(loadTemplate(null), null);
  const minimal = buildRegistryEntry({
    template: null, cliSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: empty, title: 'hi',
  });
  assert.equal(minimal.isArchived, false);
  assert.equal(defaultRegistrar({ cliSessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: empty, title: 'hi' }), null);
});

test('macOS Keychain 与 CLAUDE_CONFIG_DIR 凭证兼容（preflight 与 usage 共用同一助手）', async () => {
  const cfgDir = tmpDir();
  const env = { CLAUDE_CONFIG_DIR: cfgDir };
  assert.equal(claudeConfigDir(env, '/tmp/home'), cfgDir);

  // 无文件时在 darwin 走 keychain 回调
  const keychainOauth = { accessToken: 'sk-test-kc', subscriptionType: 'max', expiresAt: 9999999999999 };
  const fakeKeychain = () => keychainOauth;
  assert.equal(claudeLoggedIn(env, { platform: 'darwin', keychain: fakeKeychain }), true);
  assert.deepEqual(readClaudeOAuth({ home: '/tmp/home', env, platform: 'darwin', keychain: fakeKeychain }), keychainOauth);

  // usage 也走同一套 helper 并读取 CLAUDE_CONFIG_DIR/settings.json
  let gotAuth = '';
  const usage = await claudeUsage({
    home: '/tmp/home',
    env,
    platform: 'darwin',
    keychain: fakeKeychain,
    now: 1000,
    get: async (_url, headers) => {
      gotAuth = headers.Authorization;
      return { status: 200, body: JSON.stringify({ limits: [{ kind: 'session', percent: 15 }] }) };
    },
  });
  assert.equal(gotAuth, 'Bearer sk-test-kc');
  assert.equal(usage.available, true);
  assert.equal(usage.windows[0].percent, 15);
});

test('scanRecent 对超大 transcript 采用有界窗口读取，不整体 readFileSync', () => {
  const dir = tmpDir();
  const big = path.join(dir, 'huge.jsonl');
  // 头部放一个模型，中间填充 1.2 MB 空白/文本，尾部放一个新模型
  const pad = 'x'.repeat(1024 * 64);
  const headLine = `${JSON.stringify({ message: { model: 'claude-sonnet-5' } })}\n`;
  const midLine = `${JSON.stringify({ message: { content: pad } })}\n`.repeat(16);
  const tailLine = `${JSON.stringify({ message: { model: 'claude-opus-5-5' } })}\n`;
  fs.writeFileSync(big, headLine + midLine + tailLine);

  const models = scanRecent(dir, { max: 5 });
  assert.ok(models.includes('claude-opus-5-5'));
  assert.ok(models.includes('claude-sonnet-5'));
});

test('appendAuditEvent 支持安全事件记账与超过上限时自动轮转至 audit.log.1', () => {
  const dir = tmpDir();
  appendAuditEvent({ type: 'pair_ok', principal: 'owner', deviceId: 'dev1' }, { dir, maxBytes: 120 });
  appendAuditEvent({ type: 'device_revoked', principal: 'owner', deviceId: 'dev1' }, { dir, maxBytes: 120 });
  appendAuditEvent({ type: 'unpair', principal: 'owner', deviceId: 'dev2' }, { dir, maxBytes: 120 });

  assert.ok(fs.existsSync(path.join(dir, 'audit.log')));
  assert.ok(fs.existsSync(path.join(dir, 'audit.log.1')));
});
