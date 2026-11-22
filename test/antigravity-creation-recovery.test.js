import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpDir } from './helpers.js';
import { creationStatus } from '../src/http/handlers/create.js';
import { saveCreation } from '../src/runtime/creations.js';
import { scopeRepo } from '../src/scope.js';
import { endTurn, latestTurn, startTurn } from '../src/runtime/turns.js';
import { drainQueue, promoteQueued, sendMessage } from '../src/http/handlers/turns.js';
import { listQueue } from '../src/runtime/queue.js';

test('新建状态只向相同身份、授权代和当前工作区提供查询，并隐藏恢复所用的正文', () => {
  const cwd = tmpDir();
  const who = { id: 'guest', generation: 'g1', roots: [cwd] };
  const receipt = saveCreation({ turnId: crypto.randomUUID(), cwd, principalId: who.id, generation: 'g1',
    status: 'unconfirmed', delivery: 'unknown', prompt: '仅用于恢复', evidence: { baseline: [] } });
  const check = (principal, candidate = cwd) => creationStatus({ turnId: receipt.turnId, principal,
    repo: scopeRepo({ getSession: (key) => ({ key, cwd: candidate }) }, principal) });
  const status = check(who);
  assert.equal(status.status, 200);
  assert.equal(status.body.prompt, undefined);
  assert.equal(status.body.evidence, undefined);
  assert.equal(check({ ...who, id: 'other' }).status, 404);
  assert.equal(check({ ...who, generation: 'g2' }).status, 404);
  assert.equal(check({ ...who, roots: [tmpDir()] }).status, 404);
  saveCreation({ ...receipt, status: 'identified', key: 'hosted' });
  assert.equal(check(who, tmpDir()).status, 404);
});

test('桌面结果待确认会持久化，普通发送保留队列，同一次请求不会自动重发，人工提升能继续', async () => {
  const key = 'antigravity:await-confirmation';
  const hosted = { key, agent: 'antigravity', cwd: tmpDir(), providerId: 'desktop' };
  const old = startTurn({ key, turnId: crypto.randomUUID(), agent: 'antigravity', prompt: '旧任务' });
  const error = '桌面执行结果待确认';
  endTurn({ key, turnId: old.turnId, status: 'unconfirmed', error, eventCount: 0, tokens: null });
  assert.equal(latestTurn(key).status, 'unconfirmed');
  assert.equal(latestTurn(key).error, error);
  let sends = 0;
  const opts = { key, repo: { getSession: () => hosted }, config: { allowSend: true }, live: () => new Map(),
    audit() {}, runner: async () => { sends++; return { summary: { status: 'ok', eventCount: 1 } }; } };
  const queued = await sendMessage({ ...opts, message: '后续任务', when: 'auto' });
  assert.equal(queued.body.queued, true);
  assert.match(queued.body.note, /待确认/);
  assert.equal(await drainQueue(opts), null);
  assert.equal(sends, 0);
  assert.deepEqual(listQueue(key).map((item) => item.id), [queued.body.queueId]);
  const manual = await promoteQueued({ ...opts, id: queued.body.queueId });
  assert.equal(manual.body.queued, false);
  assert.equal(sends, 1);
  assert.deepEqual(listQueue(key), []);
  await manual.settled;
});
