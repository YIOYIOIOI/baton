import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/http/server.js';
import { createAuth } from '../src/http/auth.js';
import { createRepo } from '../src/repo.js';
import { encodeKey } from '../src/providers.js';
import { renderSessionMarkdown } from '../src/export.js';
import { OWNER } from '../src/principals.js';
import { tmpDir, writeJsonl } from './helpers.js';

const TOKEN = 'e'.repeat(64);

test('renderSessionMarkdown 渲染对话正文、折叠工具调用与元信息', () => {
  const md = renderSessionMarkdown(
    { key: 'claude:abc', agent: 'claude', title: 'Fix auth bug', cwd: '/workspace/baton' },
    [
      { kind: 'text', role: 'user', ts: '2026-11-17T10:00:00Z', text: 'Check the cookie check.' },
      { kind: 'thinking', role: 'agent', ts: '2026-11-17T10:00:02Z', text: 'Inspecting auth module.' },
      { kind: 'tool_call', role: 'system', ts: '2026-11-17T10:00:03Z', tool: { id: 't1', name: 'Read', input: { file_path: 'src/auth.js' } } },
      { kind: 'tool_result', role: 'system', ts: '2026-11-17T10:00:04Z', tool: { id: 't1', name: 'Read', output: 'ok', failed: false } },
      { kind: 'text', role: 'agent', ts: '2026-11-17T10:00:05Z', text: 'Updated HTTP cookie logic.' },
    ],
    { exportedAt: '2026-11-17T11:00:00Z' },
  );
  assert.match(md, /^# Fix auth bug/m);
  assert.match(md, /## User/);
  assert.match(md, /Check the cookie check\./);
  assert.match(md, /## Assistant/);
  assert.match(md, /Updated HTTP cookie logic\./);
  assert.match(md, /<details>/);
  assert.match(md, /Read/);
});

test('GET /api/sessions/:key/export 返回 Markdown 下载并遵守访客作用域隔离', async () => {
  const claudeRoot = tmpDir();
  const id = 'aaaaaaaa-0000-0000-0000-000000000010';
  const sessionCwd = tmpDir();
  writeJsonl(claudeRoot, path.join('proj', `${id}.jsonl`), [
    { type: 'user', sessionId: id, uuid: 'u1', cwd: sessionCwd, timestamp: '2026-11-17T10:00:00Z', message: { role: 'user', content: 'Hello world' } },
    { type: 'assistant', sessionId: id, uuid: 'a1', timestamp: '2026-11-17T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] } },
  ]);
  const repo = createRepo({
    claudeRoot, codexRoot: tmpDir(), registryRoot: tmpDir(), codexStateFile: path.join(tmpDir(), 'missing.json'),
  });
  const key = encodeKey('claude', `proj/${id}.jsonl`);
  const guest = { id: 'friend', name: 'Alice', roots: [tmpDir()], allowSend: false };
  const auth = createAuth({ token: TOKEN, principals: [OWNER, guest] });
  const guestBearer = auth.verifyPair(auth.newPairingCode('friend')).bearer;

  const server = createServer({ repo, auth, config: { host: '127.0.0.1', port: 0, allowSend: false } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/export`, {
      headers: { authorization: `Bearer ${guestBearer}` },
    });
    assert.equal(denied.status, 404);

    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/export`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-baton'), '1');
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/i);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment;.*\.md/i);
    const text = await res.text();
    assert.match(text, /Hello world/);
    assert.match(text, /Hi there!/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
