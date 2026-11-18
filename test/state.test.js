import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState } from '../src/http/handlers/sessions.js';

const member = { key: 'claude:abc', agent: 'claude', lastTs: '2026-09-10T03:00:00Z' };
const repo = { getSession: (k) => (k === member.key ? member : null) };

test('有 running 轮次时 running 为 true', () => {
  const turns = () => [{ turnId: 't1', status: 'running', startedAt: 1 }];
  const r = sessionState({ repo, key: member.key, turns });
  assert.equal(r.body.running, true);
  assert.equal(r.body.latestTurn.turnId, 't1');
});

test('最后一轮失败时如实透出错误', () => {
  const turns = () => [{ turnId: 't1', status: 'failed', error: '服务器过载', startedAt: 1, endedAt: 2 }];
  const r = sessionState({ repo, key: member.key, turns });
  assert.equal(r.body.running, false);
  assert.match(r.body.latestTurn.error, /服务器过载/);
});

test('从未跑过轮次时 latestTurn 为 null 而不报错', () => {
  const r = sessionState({ repo, key: member.key, turns: () => [] });
  assert.equal(r.body.running, false);
  assert.equal(r.body.latestTurn, null);
});

test('透出 lastEventTs，客户端据此判断有没有落后', () => {
  const r = sessionState({ repo, key: member.key, turns: () => [] });
  assert.equal(r.body.lastEventTs, '2026-09-10T03:00:00Z');
});

test('未知会话 404', () => {
  const r = sessionState({ repo, key: 'claude:zzz', turns: () => [] });
  assert.equal(r.status, 404);
  assert.ok(r.body.error.fix);
});

test('只取最后一轮，不把全部历史轮次倒给客户端', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ turnId: `t${i}`, status: 'ok', startedAt: i }));
  const r = sessionState({ repo, key: member.key, turns: () => many });
  assert.equal(r.body.latestTurn.turnId, 't49');
  assert.equal(r.body.turns, undefined);
});
