import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  claudeSessionFiles, codexRolloutFiles, parseRolloutName, encodeKey, decodeKey,
} from '../src/providers.js';
import { tmpDir, writeJsonl } from './helpers.js';

test('claudeSessionFiles 只取项目目录下一层，跳过 subagents/', () => {
  const root = tmpDir();
  writeJsonl(root, path.join('C--proj', 'aaaaaaaa-0000-0000-0000-000000000001.jsonl'), [{ sessionId: 'x' }]);
  writeJsonl(root, path.join('C--proj', 'aaaaaaaa-0000-0000-0000-000000000002.jsonl'), [{ sessionId: 'y' }]);
  writeJsonl(root, path.join('C--proj', 'aaaaaaaa-0000-0000-0000-000000000001', 'subagents', 'agent-deadbeef.jsonl'), [{ sessionId: 'z' }]);
  const files = claudeSessionFiles({ root });
  assert.equal(files.length, 2, 'subagents 下的文件不得计入会话');
  assert.ok(files.every((f) => !f.relPath.includes('subagents')));
  assert.equal(files[0].agent, 'claude');
  assert.equal(files[0].project, 'C--proj');
  assert.ok(files[0].size > 0);
});

test('parseRolloutName 解析单 uuid 与双 uuid 两种形态', () => {
  const single = parseRolloutName('rollout-2026-09-10T11-18-29-01a08952-f1de-7f62-8cf7-6d96d018aef8.jsonl');
  assert.equal(single.threadId, '01a08952-f1de-7f62-8cf7-6d96d018aef8');
  assert.equal(single.rolloutId, null);

  const dbl = parseRolloutName('rollout-2026-09-08T12-40-00-01a07f29-14bf-7560-b7df-c3eb784ec556_01a07f50-dbab-7803-af62-e231358ba7bd.jsonl');
  assert.equal(dbl.threadId, '01a07f29-14bf-7560-b7df-c3eb784ec556', '首段 uuid 是会话链 id');
  assert.equal(dbl.rolloutId, '01a07f50-dbab-7803-af62-e231358ba7bd');

  assert.equal(parseRolloutName('notarollout.jsonl'), null);
});

test('codexRolloutFiles 递归枚举并带出 threadId', () => {
  const root = tmpDir();
  writeJsonl(root, path.join('2026', '09', '10', 'rollout-2026-09-10T11-18-29-01a08952-f1de-7f62-8cf7-6d96d018aef8.jsonl'), [{ type: 'session_meta' }]);
  const files = codexRolloutFiles({ root });
  assert.equal(files.length, 1);
  assert.equal(files[0].agent, 'codex');
  assert.equal(files[0].providerId, '01a08952-f1de-7f62-8cf7-6d96d018aef8');
});

test('key 编解码可逆', () => {
  const roots = { claude: '/r/claude', codex: '/r/codex' };
  const key = encodeKey('claude', 'C--proj/aaa.jsonl');
  const back = decodeKey(key, roots);
  assert.equal(back.agent, 'claude');
  assert.equal(back.relPath, 'C--proj/aaa.jsonl');
  assert.equal(back.file, path.join('/r/claude', 'C--proj/aaa.jsonl'));
});

test('decodeKey 拒绝目录穿越', () => {
  const roots = { claude: '/r/claude', codex: '/r/codex' };
  assert.throws(() => decodeKey(encodeKey('claude', '../../etc/passwd'), roots), /穿越|traversal/i);
  assert.throws(() => decodeKey(encodeKey('claude', 'C:/Windows/x.jsonl'), roots), /穿越|traversal/i);
  assert.throws(() => decodeKey('bogus', roots), /key/i);
});
