import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { codexRpc } from '../src/agent/codexRpc.js';

function fakeRpcSpawn(onCall) {
  let lastOpts = null;
  let killCalls = 0;
  const spawnFn = (_cmd, _args, opts) => {
    lastOpts = opts;
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => { killCalls += 1; };

    let buf = '';
    child.stdin.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: msg.id, result: {} })}\n`);
        } else if (msg.id !== undefined) {
          onCall(msg, child);
        }
      }
    });
    return child;
  };
  return { spawnFn, getOpts: () => lastOpts, getKills: () => killCalls };
}

test('codexRpc 顺序执行 JSON-RPC 调用并按平台清理进程树', async () => {
  const { spawnFn, getOpts } = fakeRpcSpawn((msg, child) => {
    child.stdout.write(`${JSON.stringify({ id: msg.id, result: { method: msg.method } })}\n`);
  });
  let killArgs = null;
  const res = await codexRpc(
    [{ method: 'thread/list' }, { method: 'skills/list', params: { cwds: ['C:\\proj'] } }],
    {
      spawnFn,
      killTreeFn: (pid) => { killArgs = pid; },
    },
  );
  assert.deepEqual(res, [{ method: 'thread/list' }, { method: 'skills/list' }]);
  assert.equal(killArgs, 424242);
  assert.equal(Boolean(getOpts().detached), process.platform !== 'win32');
});
