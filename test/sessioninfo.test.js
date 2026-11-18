import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPlan, applyClaude, applyCodex, emptyState, readSessionInfo, fileEdits, gitBranch, clearInfoCache,
} from '../src/sessioninfo.js';
import { startTurn } from '../src/runtime/turns.js';

/*
  2026-11-10：会话页右侧「信息」窗格。Claude Desktop 那个窗格画的是它注入给 agent 的工具留下的
  数据，本机会话里的真实形状（值删短了）：
    mcp__ccd_turn__update_plan  { items: [{content, status}], scope }，之后 { advance: true }
    mcp__ccd_turn__wrap_up      { recap }
*/

const tool = (name, input, ts = '2026-11-10T00:00:00Z') => ({
  type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: name, name, input }] },
});

test('applyPlan：items 换整张表；advance 把进行中的打勾、下一条待办变成进行中', () => {
  let p = applyPlan(null, { items: [
    { content: '核对', status: 'in_progress' }, { content: '实现', status: 'pending' }, { content: '验证', status: 'pending' },
  ] });
  p = applyPlan(p, { advance: true });
  assert.deepEqual(p.map((x) => x.status), ['completed', 'in_progress', 'pending']);
  p = applyPlan(p, { advance: true });
  p = applyPlan(p, { advance: true });
  assert.deepEqual(p.map((x) => x.status), ['completed', 'completed', 'completed']);
});

test('applyClaude：计划、收尾总结、改过的文件、上下文、目标', () => {
  const s = emptyState();
  s.cwd = path.join('C:', 'proj');
  applyClaude(s, tool('mcp__ccd_turn__update_plan', { items: [{ content: '一', status: 'in_progress' }] }));
  applyClaude(s, tool('mcp__ccd_turn__wrap_up', { recap: '做完了一半' }));
  applyClaude(s, tool('Edit', { file_path: path.join('C:', 'proj', 'src', 'a.js'), old_string: 'x\ny', new_string: 'x\ny\nz' }));
  applyClaude(s, tool('Write', { file_path: path.join('C:', 'proj', 'b.md'), content: '1\n2' }));
  applyClaude(s, tool('Edit', { file_path: path.join('C:', 'proj', 'src', 'a.js'), old_string: 'z', new_string: 'w' }));
  applyClaude(s, { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 }, content: [] } });
  applyClaude(s, { type: 'attachment', timestamp: 't1', attachment: { type: 'goal_status', met: false, sentinel: true, condition: '测试全绿' } });
  assert.deepEqual(s.plan, [{ content: '一', status: 'in_progress' }]);
  assert.equal(s.recap.text, '做完了一半');
  assert.deepEqual(s.files.get('src/a.js'), { path: 'src/a.js', edits: 2, added: 4, removed: 3, lastTs: '2026-11-10T00:00:00Z', created: false });
  assert.equal(s.files.get('b.md').created, true);
  assert.equal(s.context.used, 1015, '上下文 = 这次请求带进去的全部：新输入 + 缓存读 + 缓存写');
  assert.deepEqual(s.goal, { condition: '测试全绿', met: false, reason: null, setAt: 't1' });
  applyClaude(s, { type: 'attachment', attachment: { type: 'goal_status', met: true, condition: '测试全绿', reason: '都过了' } });
  assert.equal(s.goal.met, true);
  assert.equal(s.goal.setAt, 't1', '同一个目标的设定时间不被后面的检查改掉');
  applyClaude(s, { type: 'user', entrypoint: 'sdk-cli', message: { content: '<command-name>/goal</command-name>\n<command-args>clear</command-args>' } });
  assert.equal(s.goal, null, '/goal clear 清掉');
});

test('applyClaude：子 agent 的记录不算', () => {
  const s = emptyState();
  applyClaude(s, { ...tool('Edit', { file_path: 'C:/x.js', old_string: '', new_string: 'a' }), isSidechain: true });
  assert.equal(s.files.size, 0);
});

test('applyCodex：模型取 turn_context，上下文取 token_count 的 last_token_usage 与窗口', () => {
  const s = emptyState();
  applyCodex(s, { type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: 'C:/w' } });
  applyCodex(s, { type: 'event_msg', timestamp: 't', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 999999 }, last_token_usage: { input_tokens: 242163 }, model_context_window: 258400,
  } } });
  assert.equal(s.model, 'gpt-6-astra');
  assert.deepEqual(s.context, { used: 242163, window: 258400, ts: 't' });
});

test('readSessionInfo：增量读——追加的记录下次读得到，没变时不重读', () => {
  clearInfoCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-info-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(tool('mcp__ccd_turn__wrap_up', { recap: '第一次' }))}\n`);
  const member = { agent: 'claude', file, cwd: dir };
  assert.equal(readSessionInfo(member, { windowOf: () => 1_000_000 }).recap.text, '第一次');
  fs.appendFileSync(file, `${JSON.stringify(tool('mcp__ccd_turn__wrap_up', { recap: '第二次' }))}\n`);
  // 半行（还没写完）不读
  fs.appendFileSync(file, '{"type":"assistant","message":{"con');
  const b = readSessionInfo(member, { windowOf: () => 1_000_000 });
  assert.equal(b.recap.text, '第二次');
  assert.equal(b.model.name, 'Opus 5.5');
  assert.equal(b.filesTracked, true);
  fs.rmSync(dir, { recursive: true, force: true });
  clearInfoCache();
});

test('fileEdits：某个文件在这个会话里的每一次改动（改前 / 改后）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-info-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, [
    tool('Write', { file_path: path.join(dir, 'a.txt'), content: 'v1' }),
    tool('Edit', { file_path: path.join(dir, 'a.txt'), old_string: 'v1', new_string: 'v2' }),
    tool('Edit', { file_path: path.join(dir, 'other.txt'), old_string: 'x', new_string: 'y' }),
  ].map((r) => JSON.stringify(r)).join('\n'));
  const edits = fileEdits({ agent: 'claude', file, cwd: dir }, 'a.txt');
  assert.deepEqual(edits.map((e) => [e.kind, e.before, e.after]), [['write', '', 'v1'], ['edit', 'v1', 'v2']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gitBranch：普通仓库读 HEAD；worktree 的 .git 是文件，顺着 gitdir 找', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-git-'));
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(dir, 'repo', 'sub'), { recursive: true });
  assert.equal(gitBranch(path.join(dir, 'repo', 'sub')), 'main', '从子目录往上找');
  fs.mkdirSync(path.join(dir, 'wtgit'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wtgit', 'HEAD'), 'ref: refs/heads/claude/nifty\n');
  fs.mkdirSync(path.join(dir, 'wt'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wt', '.git'), `gitdir: ${path.join(dir, 'wtgit')}\n`);
  assert.equal(gitBranch(path.join(dir, 'wt')), 'claude/nifty');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startTurn：轮次记录带上发出去的那句话，客户端据此先把消息摆出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-turn-'));
  const t = startTurn({ key: 'claude:k', turnId: 't1', agent: 'claude', prompt: '继续' }, { dir, now: 5 });
  assert.equal(t.prompt, '继续');
  const none = startTurn({ key: 'claude:k2', turnId: 't2', agent: 'claude' }, { dir, now: 5 });
  assert.equal('prompt' in none, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
