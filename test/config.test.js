import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureToken, BATON_DIR, defaultWorkspacesRoot } from '../src/config.js';
import { tmpDir } from './helpers.js';

// BATON_DIR 是模块级常量，测试里靠带查询串的动态 import 拿到新实例，
// 以便在不同环境变量下分别验证默认值与覆盖值。
async function freshConfig(tag) {
  return import(`../src/config.js?probe=${tag}`);
}

test('BATON_DIR 默认指向 ~/.baton', async () => {
  const saved = process.env.BATON_DIR;
  delete process.env.BATON_DIR;
  try {
    const m = await freshConfig('default');
    assert.equal(m.BATON_DIR, path.join(os.homedir(), '.baton'));
  } finally {
    if (saved !== undefined) process.env.BATON_DIR = saved;
  }
});

test('BATON_DIR 可由环境变量覆盖（测试据此整体重定向，见 test/setup.js）', async () => {
  const saved = process.env.BATON_DIR;
  process.env.BATON_DIR = path.join(os.tmpdir(), 'baton-override-probe');
  try {
    const m = await freshConfig('override');
    assert.equal(m.BATON_DIR, path.join(os.tmpdir(), 'baton-override-probe'));
  } finally {
    if (saved !== undefined) process.env.BATON_DIR = saved;
    else delete process.env.BATON_DIR;
  }
});

test('测试运行时 BATON_DIR 不得指向真实 ~/.baton', () => {
  // 这条是防回归：审计日志曾被测试数据污染 142 行
  assert.notEqual(BATON_DIR, path.join(os.homedir(), '.baton'),
    '测试必须经 --import ./test/setup.js 启动，否则会写进真实数据目录');
});

test('缺少 config.json 时给出默认值', () => {
  const cfg = loadConfig({ dir: tmpDir('baton-') });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3002);
  assert.equal(cfg.allowSend, true, 'allowSend 默认应开启');
});

test('config.json 覆盖默认值', () => {
  const dir = tmpDir('baton-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4000, allowSend: true }));
  const cfg = loadConfig({ dir });
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.allowSend, true);
  assert.equal(cfg.host, '127.0.0.1', '未指定的字段仍取默认');
});

test('ensureToken 生成 64 位十六进制并复用', () => {
  const dir = tmpDir('baton-');
  const a = ensureToken({ dir });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(ensureToken({ dir }), a, '第二次调用必须复用同一个 token');
});

test('defaultWorkspacesRoot 按平台区分：win32 落盘根，POSIX 落用户家目录', () => {
  assert.equal(defaultWorkspacesRoot('win32', 'C:\\Users\\alice'), 'C:\\BatonWorkspaces');
  assert.equal(defaultWorkspacesRoot('darwin', '/Users/alice'), '/Users/alice/BatonWorkspaces');
  assert.equal(defaultWorkspacesRoot('linux', '/home/alice'), '/home/alice/BatonWorkspaces');
});
