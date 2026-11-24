import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRunner } from '../src/http/handlers/turns.js';
import { encodeKey } from '../src/providers.js';
import { createRepo } from '../src/repo.js';
import { tmpDir, writeJsonl } from './helpers.js';

const sessionId = 'aaaa0000-0000-4000-8000-000000000001';

test('续跑重新读取后来写入的原目录，不采用后续轮次的目录', async () => {
  const root = tmpDir();
  const project = path.join(root, 'original project');
  fs.mkdirSync(project);
  const claudeRoot = path.join(root, 'transcripts');
  const repo = createRepo({ claudeRoot, codexRoot: path.join(root, 'codex'), registryRoot: path.join(root, 'registry'), codexStateFile: null });
  const rel = `project/${sessionId}.jsonl`;
  const file = writeJsonl(claudeRoot, rel, [{ type: 'session-owner', sessionId }]);
  const key = encodeKey('claude', rel);
  assert.equal(repo.getSession(key).cwd, null);
  fs.appendFileSync(file, [
    { type: 'queue-operation', content: 'x'.repeat(70 * 1024) },
    { type: 'user', sessionId, cwd: project },
    { type: 'assistant', sessionId, cwd: root },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');

  const member = repo.getSession(key);
  let childCwd;
  const result = await defaultRunner({
    member, message: 'test', run: async ({ command, args, cwd }) => {
      assert.equal(command, 'claude');
      assert.equal(args[args.indexOf('--resume') + 1], sessionId);
      childCwd = execFileSync(process.execPath, ['-p', 'process.cwd()'], { cwd, encoding: 'utf8' }).trim();
      return { code: 0, lines: ['{"type":"result","is_error":false}'], stderr: '' };
    },
  });
  assert.equal(result.summary.status, 'ok');
  assert.equal(fs.realpathSync.native(childCwd), fs.realpathSync.native(project));
});

test('原会话目录缺失、非绝对路径或不可用时不启动进程', async () => {
  const root = tmpDir();
  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, '');
  let launches = 0;
  for (const cwd of [null, '.', path.join(root, 'gone'), file]) {
    const result = await defaultRunner({
      member: { key: 'claude:test', agent: 'claude', providerId: sessionId, cwd }, message: 'test',
      run: async () => { launches++; return { code: 0, lines: ['{"type":"result"}'], stderr: '' }; },
    });
    assert.equal(launches, 0);
    assert.equal(result.summary.status, 'failed');
    assert.match(result.summary.error, /原会话.*目录/);
  }
});
