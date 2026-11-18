import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normStatus, readCodexGoal } from '../src/agent/codexGoal.js';
import { codexEvents, userGoalOf } from '../src/codex.js';
import { setGoal } from '../src/http/handlers/goal.js';
import {
  continueGoal, defaultRunner, GOAL_CONTINUE, GOAL_IN_APP_NOTE, MAX_GOAL_RUNS,
} from '../src/http/handlers/turns.js';

/*
  2026-11-11 owner：「codex 那里还是看不到目标啊」。Codex 自己有一套目标（实测见 agent-protocol §20）：
  存在 ~/.codex/goals_1.sqlite 的 thread_goals；人设 / 暂停 / 恢复时会话里写一条 user_goal 内部上下文；
  Codex 自己改状态（完成、卡住、额度用完）时写 thread_goal_updated。
*/

const NL = String.fromCharCode(10);

test('normStatus：app-server 消息里的驼峰统一成库里的蛇形', () => {
  assert.equal(normStatus('usageLimited'), 'usage_limited');
  assert.equal(normStatus('budgetLimited'), 'budget_limited');
  assert.equal(normStatus('active'), 'active');
  assert.equal(normStatus(undefined), null);
});

test('readCodexGoal：只读 thread_goals 里这个会话那一行；库不在返回 null', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-goal-'));
  fs.mkdirSync(path.join(home, '.codex'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, '.codex', 'goals_1.sqlite'));
  db.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('t1', 'g1', '把排名打到前 10', 'usage_limited', null, 9588990, 78943, 1, 2);
  db.close();
  const g = await readCodexGoal('t1', { home });
  assert.deepEqual(g, {
    objective: '把排名打到前 10', status: 'usage_limited', tokenBudget: null, tokensUsed: 9588990,
    timeUsedSeconds: 78943, createdAt: 1, updatedAt: 2,
  });
  assert.equal(await readCodexGoal('nope', { home }), null);
  assert.equal(await readCodexGoal('t1', { home: path.join(home, 'missing') }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

// 示例目标上下文载荷
const SET_GOAL = ['<codex_internal_context source="user_goal">', 'User set the goal: "重构数据管道的取数流程' + NL + '结果文件要一致"', 'User set goal status: "active".', '</codex_internal_context>'].join(NL);
const RESUME = ['<codex_internal_context source="user_goal">', 'User set goal status: "active".', '</codex_internal_context>'].join(NL);
const CONTINUE = ['<codex_internal_context source="goal">', 'Continue working toward the active thread goal.', '</codex_internal_context>'].join(NL);

test('userGoalOf：设定（多行目标）、只改状态；别的内部上下文不算', () => {
  assert.deepEqual(userGoalOf(SET_GOAL), { objective: '重构数据管道的取数流程' + NL + '结果文件要一致', status: 'active' });
  assert.deepEqual(userGoalOf(RESUME), { objective: null, status: 'active' });
  assert.equal(userGoalOf(CONTINUE), null);
  assert.equal(userGoalOf('普通的一句话'), null);
});

test('codexEvents：人设的目标一行；Codex 自己标完成一行；人改状态那条 thread_goal_updated 不重复；续跑上下文和 Baton 的续跑指令都不冒成气泡', () => {
  const msg = (text, i) => ({ type: 'response_item', ordinal: i, timestamp: `t${i}`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const upd = (status, i) => ({ type: 'event_msg', ordinal: i, timestamp: `t${i}`, payload: { type: 'thread_goal_updated', goal: { objective: '重构', status } } });
  const evs = codexEvents([
    msg(SET_GOAL, 1),
    upd('active', 2),
    msg(CONTINUE, 3),
    msg(GOAL_CONTINUE, 4),
    upd('complete', 5),
    upd('usageLimited', 6),
  ]);
  assert.deepEqual(evs.map((e) => [e.kind, e.goal?.status, e.text.slice(0, 4)]), [
    ['goal', 'active', '重构数据'],
    ['goal', 'complete', '重构'],
    ['goal', 'usage_limited', '重构'],
  ]);
  assert.equal(evs[1].goal.met, true);
});

const claudeRepo = { getSession: () => ({ key: 'claude:k', agent: 'claude', providerId: 'p', cwd: 'C:/x' }) };
const codexRepo = { getSession: () => ({ key: 'codex:k', agent: 'codex', providerId: 'th1', cwd: 'C:/x' }) };
const ON = { allowSend: true };

test('setGoal：Claude 变成一条 /goal 消息；清是 /goal clear', async () => {
  const sent = [];
  const send = async (o) => { sent.push(o.message); return { status: 202, body: { turnId: 'x' } }; };
  await setGoal({ repo: claudeRepo, config: ON, key: 'claude:k', objective: ' 测试全绿 ', send });
  await setGoal({ repo: claudeRepo, config: ON, key: 'claude:k', clear: true, send });
  assert.deepEqual(sent, ['/goal 测试全绿', '/goal clear']);
});

test('setGoal：Codex 先用官方接口设目标、再发一轮开工（发的就是目标原文）；清目标不发消息', async () => {
  const calls = [];
  const codex = {
    set: async (o) => { calls.push(['set', o]); return { objective: o.objective, status: 'active' }; },
    clear: async (o) => { calls.push(['clear', o]); },
  };
  const send = async (o) => { calls.push(['send', o.message]); return { status: 202, body: { turnId: 'x', queued: false } }; };
  const r = await setGoal({ repo: codexRepo, config: ON, key: 'codex:k', objective: '重构数据管道', send, codex });
  assert.equal(r.status, 202);
  assert.equal(r.body.goal.status, 'active');
  const c = await setGoal({ repo: codexRepo, config: ON, key: 'codex:k', clear: true, send, codex });
  assert.deepEqual(c.body, { cleared: true });
  assert.deepEqual(calls, [
    ['set', { threadId: 'th1', objective: '重构数据管道' }],
    ['send', '重构数据管道'],
    ['clear', { threadId: 'th1' }],
  ]);
});

test('setGoal：只读模式不让设（设了就会开始跑）；空目标 400', async () => {
  assert.equal((await setGoal({ repo: codexRepo, config: { allowSend: false }, key: 'codex:k', objective: 'x' })).status, 403);
  assert.equal((await setGoal({ repo: codexRepo, config: ON, key: 'codex:k', objective: '  ' })).status, 400);
});

/** continueGoal 的依赖：轮次、队列、跑一轮都是假的，只看它决定续不续、怎么续 */
function rig({ lastStatus = 'ok', queued = 0, goal = { status: 'active' }, repo = codexRepo } = {}) {
  const started = [];
  const ran = [];
  const deps = {
    turns: {
      latest: () => ({ status: lastStatus }),
      start: (t) => { started.push(t); },
      end: () => ({ status: 'ok' }),
    },
    queue: { list: () => Array.from({ length: queued }), enqueue: () => ({ id: 'q' }) },
    runner: (o) => { ran.push(o); return new Promise(() => {}); }, // 不结束：只看它被怎么调
    audit: () => {},
    live: () => new Map(),
    push: { send: async () => {} },
    prefs: { get: () => null },
    env: {},
  };
  return {
    started, ran,
    go: (key = 'codex:k') => continueGoal({ repo, config: ON, principal: null, key, goalOf: async () => goal, deps }),
  };
}

test('continueGoal：上一轮 ok、没人排队、Codex 目标还 active → 起一轮续跑，不带原文、不交给 App', async () => {
  const r = rig();
  assert.equal(await r.go('codex:a'), true);
  assert.equal(r.ran[0].message, GOAL_CONTINUE);
  assert.equal(r.ran[0].handoff, false);
  assert.equal('prompt' in r.started[0], false, '轮次记录不带原文，客户端就不会把续跑指令摆成你的气泡');
});

test('continueGoal：被停了、失败了、有人排着、目标不 active、Claude 会话——都不续', async () => {
  assert.equal(await rig({ lastStatus: 'aborted' }).go('codex:b'), false);
  assert.equal(await rig({ lastStatus: 'failed' }).go('codex:b'), false);
  assert.equal(await rig({ queued: 1 }).go('codex:b'), false);
  assert.equal(await rig({ goal: { status: 'complete' } }).go('codex:b'), false);
  assert.equal(await rig({ goal: { status: 'usage_limited' } }).go('codex:b'), false);
  assert.equal(await rig({ goal: null }).go('codex:b'), false);
  assert.equal(await rig({ repo: claudeRepo }).go('codex:b'), false);
});

test('continueGoal：连续自动续到上限就停（保险丝）', async () => {
  const r = rig();
  for (let i = 0; i < MAX_GOAL_RUNS; i += 1) assert.equal(await r.go('codex:c'), true);
  assert.equal(await r.go('codex:c'), false);
});

test('defaultRunner：续跑那一轮撞上 Codex App 的锁 → 交给 App 自己续，不往它的队列里塞续跑指令', async () => {
  let asked = 0;
  const r = await defaultRunner({
    member: { key: 'codex:k', agent: 'codex', providerId: '01a1a01d-3e59-7fa1-943a-ea783d8cd850', cwd: process.cwd() },
    message: GOAL_CONTINUE, fork: false, turnId: 't', handoff: false,
    run: async () => ({ code: 1, lines: [], stderr: 'Error: thread/resume failed: thread 01a1a01d-3e59-7fa1-943a-ea783d8cd850 already has an active writer (code -32600)' + NL, timedOut: false }),
    toApp: async () => { asked += 1; return { id: 'q' }; },
  });
  assert.equal(asked, 0);
  assert.equal(r.summary.status, 'handoff');
  assert.equal(r.summary.error, GOAL_IN_APP_NOTE);
});
