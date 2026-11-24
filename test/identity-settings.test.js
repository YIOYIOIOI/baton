import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/http/auth.js';
import { createServer } from '../src/http/server.js';
import { OWNER } from '../src/principals.js';
import { getModel, getEffort } from '../src/runtime/prefs.js';
import { tmpDir } from './helpers.js';

test('模型和思考强度同时受全局只读、访客只读与目录授权约束', async () => {
  const dir = tmpDir();
  const key = 'claude:settings-identity';
  const guest = { id: 'viewer', roots: [dir], allowSend: false };
  const outside = { id: 'other-writer', roots: [tmpDir()], allowSend: true };
  const auth = createAuth({ token: 's'.repeat(64), principals: [OWNER, guest, outside] });
  const member = { key, cwd: dir, agent: 'claude' };
  const repo = { getSession: (k) => k === key ? member : null, listChains: () => [] };
  const guestToken = auth.verifyPair(auth.newPairingCode('viewer')).bearer;
  const outsideToken = auth.verifyPair(auth.newPairingCode('other-writer')).bearer;
  for (const allowSend of [false, true]) {
    const server = createServer({ repo, auth, config: { allowSend } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const [name, value, read] of [['model', 'selected-model', getModel], ['effort', 'high', getEffort]]) {
        const url = `http://127.0.0.1:${server.address().port}/api/sessions/${encodeURIComponent(key)}/${name}`;
        for (const [bearer, expected] of [[guestToken, 403], [outsideToken, allowSend ? 404 : 403], ['s'.repeat(64), allowSend ? 200 : 403]]) {
          const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ [name]: value }) });
          assert.equal(response.status, expected);
          assert.equal(read(key), expected === 200 ? value : null);
        }
      }
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});
