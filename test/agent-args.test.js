import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, buildCodexArgs } from '../src/agent/args.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

test('Claude 参数：print + resume + stream-json', () => {
  const a = buildClaudeArgs({ sessionId: ID });
  assert.ok(a.includes('-p'));
  assert.ok(a.includes('--resume') && a.includes(ID));
  assert.deepEqual(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json']);
  assert.ok(a.includes('--verbose'));
  assert.ok(!a.includes('--fork-session'), '默认直连不分叉');
});

test('Claude fork 时才带 --fork-session', () => {
  assert.ok(buildClaudeArgs({ sessionId: ID, fork: true }).includes('--fork-session'));
});

test('非法会话 id 一律拒绝，绝不拼进命令行', () => {
  for (const bad of ['a && calc.exe', '../../x', '', 'not-a-uuid', `${ID} extra`]) {
    assert.throws(() => buildClaudeArgs({ sessionId: bad }), /会话 id/);
    assert.throws(() => buildCodexArgs({ threadId: bad }), /会话 id/);
  }
});

test('Codex 参数：exec resume + --json + --skip-git-repo-check', () => {
  const a = buildCodexArgs({ threadId: ID });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', ID]);
  assert.ok(a.includes('--json'));
  // 实测：非 git 或未登记为受信任的目录下，codex exec 直接拒绝启动
  assert.ok(a.includes('--skip-git-repo-check'), '缺这个参数会在非受信任目录直接拒绝启动');
});

test('Codex fork 用 exec fork', () => {
  const a = buildCodexArgs({ threadId: ID, fork: true });
  assert.deepEqual(a.slice(0, 3), ['exec', 'fork', ID]);
});
