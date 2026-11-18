import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexHead, isSyntheticPreamble, stripPluginMention, codexFirstUserText, codexEvents, extractUserRequest,
} from '../src/codex.js';
import { tmpDir, writeJsonl } from './helpers.js';

const rec = (type, payload, ordinal = 0) => ({ ordinal, type, timestamp: '2026-09-10T03:18:29Z', payload });
const userMsg = (text, ordinal = 0) =>
  rec('response_item', { type: 'message', id: `m${ordinal}`, role: 'user', content: [{ type: 'input_text', text }] }, ordinal);

test('codexHead 取 session_meta 字段', () => {
  const h = codexHead([rec('session_meta', {
    session_id: '01a08952', cwd: 'C:\\workspace\\example', cli_version: '0.153.4',
    originator: 'Codex Desktop', source: 'vscode', context_window: 828400, thread_source: 'user',
  })]);
  assert.equal(h.cwd, 'C:\\workspace\\example');
  assert.equal(h.contextWindow, 828400);
  assert.equal(h.cliVersion, '0.153.4');
  assert.equal(h.threadSource, 'user');
});

test('codexHead 透出 thread_source 以区分真会话与子 agent 运行', () => {
  // 实测 148 个 rollout 中：subagent 110、user 37、guardian_review 1。
  // 子 agent 运行与 Claude 侧的 subagents/*.jsonl 是同一回事，只是 Codex 放在同一目录同样前缀下。
  assert.equal(codexHead([rec('session_meta', { thread_source: 'subagent' })]).threadSource, 'subagent');
  assert.equal(codexHead([rec('session_meta', { thread_source: 'guardian_review' })]).threadSource, 'guardian_review');
  assert.equal(codexHead([rec('session_meta', { cwd: 'C:\\p' })]).threadSource, null,
    '缺字段时返回 null，由上层决定放行还是过滤（宁可多显示一条，不可丢真会话）');
});

test('isSyntheticPreamble 认出三种实测前言，含连字符标签', () => {
  assert.equal(isSyntheticPreamble('<environment_context>\n  <cwd>C:\\x</cwd>'), true);
  assert.equal(isSyntheticPreamble('<recommended_plugins> Here is a list'), true);
  assert.equal(isSyntheticPreamble('<app-context>\n# Codex desktop context'), true, '连字符标签也是合成前言');
  assert.equal(isSyntheticPreamble('看一下当前工程'), false);
  assert.equal(isSyntheticPreamble('<3 这个方案'), false, '不是标签形状');
  assert.equal(isSyntheticPreamble('<Foo>bar</Foo>'), false, '大写开头不算');
});

// ── Markdown 井号式注入（实测：8 条受污染标题全在 Codex 侧）──────

test('井号式注入前言也算合成前言', () => {
  // 实测分布：2 条 "# Chrome tabs:"、6 条 "# Files mentioned by the user:"
  // 原判据 /^<([a-z][a-z0-9_-]*)[\s>]/ 只认尖括号式，认不出这一类
  assert.equal(isSyntheticPreamble('# Chrome tabs:\n- Current URL: https://x'), true);
  assert.equal(isSyntheticPreamble('# Files mentioned by the user: ## a.png'), true);
  assert.equal(isSyntheticPreamble('# AGENTS.md instructions for C:\\proj'), true);
  assert.equal(isSyntheticPreamble('# Current working directory'), true);
});

test('真的以井号开头的用户正文不算前言', () => {
  assert.equal(isSyntheticPreamble('# 我的笔记\n今天想做的事'), false);
  assert.equal(isSyntheticPreamble('## 为什么这个函数会崩'), false);
  assert.equal(isSyntheticPreamble('#1 号问题优先'), false);
});

test('注入块里夹着真实请求时优先抢救，不降级', () => {
  const raw = '# Chrome tabs:\n- Current URL: https://v.wjx.cn/vm/x.aspx\n'
    + '## My request:\n这个第十题，一般是多少轮啊，我也不记得';
  assert.equal(extractUserRequest(raw), '这个第十题，一般是多少轮啊，我也不记得');
});

test('抢救不到时返回 null，由调用方顺延到下一条消息', () => {
  assert.equal(extractUserRequest('# Files mentioned by the user: ## clipboard-1.png'), null);
  assert.equal(extractUserRequest('普通消息'), null, '非注入块不归它管');
});

test('stripPluginMention 剥掉插件提及前缀', () => {
  assert.equal(
    stripPluginMention('[@chrome](plugin://chrome@openai-bundled) file my expenses for me'),
    'file my expenses for me',
  );
  assert.equal(stripPluginMention('普通消息'), '普通消息');
});

test('codexFirstUserText 跳过合成前言取到真实首句', () => {
  const dir = tmpDir();
  const f = writeJsonl(dir, 'r.jsonl', [
    rec('session_meta', { cwd: 'C:\\p' }),
    rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context> x' }] }, 1),
    userMsg('<environment_context>\n  <cwd>C:\\p</cwd>\n', 2),
    userMsg('看一下当前工程，继续接手完成论文研究', 3),
  ]);
  assert.equal(codexFirstUserText(f), '看一下当前工程，继续接手完成论文研究');
});

test('codexFirstUserText 剥掉插件前缀', () => {
  const f = writeJsonl(tmpDir(), 'r.jsonl', [
    userMsg('<recommended_plugins> Here is a list of plugins', 1),
    userMsg('[@chrome](plugin://chrome@openai-bundled) file my expenses for me', 2),
  ]);
  assert.equal(codexFirstUserText(f), 'file my expenses for me');
});

test('codexFirstUserText 全是前言时返回 null', () => {
  const f = writeJsonl(tmpDir(), 'r.jsonl', [
    userMsg('<recommended_plugins> Here is a list of plugins', 1),
    userMsg('<environment_context> x', 2),
  ]);
  assert.equal(codexFirstUserText(f), null);
});

test('codexFirstUserText 超出字节上限返回 null 而不是全扫', () => {
  const dir = tmpDir();
  const pad = 'p'.repeat(2000);
  const many = Array.from({ length: 400 }, (_, i) =>
    rec('response_item', { type: 'reasoning', id: `r${i}`, summary: [], encrypted_content: pad }, i));
  const f = writeJsonl(dir, 'r.jsonl', [...many, userMsg('真实首句', 999)]);
  assert.equal(codexFirstUserText(f, { capBytes: 4096 }), null);
  assert.equal(codexFirstUserText(f), '真实首句', '放开上限后应能找到');
});

test('codexEvents 归一化四类并丢弃空 reasoning 与 developer', () => {
  const evs = codexEvents([
    rec('response_item', { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'gAAA...' }, 1),
    rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>' }] }, 2),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '开始' }] }, 3),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' }, 4),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'a.txt' }] }, 5),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }, 6),
  ]);
  assert.deepEqual(evs.map((e) => e.kind), ['text', 'tool_call', 'tool_result', 'text']);
  assert.equal(evs[0].role, 'user');
  assert.equal(evs[1].tool.name, 'exec');
  assert.equal(evs[2].tool.output, 'a.txt');
  assert.equal(evs[3].role, 'agent');
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length);
});

test('codexEvents 保留非空 reasoning 的 summary', () => {
  const evs = codexEvents([
    rec('response_item', { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '先看目录' }] }, 1),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'thinking');
  assert.equal(evs[0].text, '先看目录');
});

test('codexEvents 把失败的 task_complete 变成带 error 的 turn_end', () => {
  const evs = codexEvents([
    rec('event_msg', {
      type: 'task_complete', turn_id: 't1', last_agent_message: null,
      error: { message: 'stream disconnected before completion: Our servers are currently overloaded.' },
    }, 9),
  ]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'turn_end');
  assert.match(evs[0].error, /stream disconnected/);
});

test('事件流也要滤掉注入的前言——不是只有 developer 角色才是前言', () => {
  // 实测 Codex 每轮开头插一条 `<environment_context><current_date>…`，
  // 而且它是 **user 角色**。不滤的话手机上每次发消息都先看到一大坨 XML，
  // 看着像是自己发出去的。这层过滤原先只做在标题上，事件流漏了。
  const evs = codexEvents([
    { type: 'response_item', ordinal: 1, timestamp: 'T1',
      payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <current_date>2026-09-12</current_date>\n</environment_context>' }] } },
    { type: 'response_item', ordinal: 2, timestamp: 'T2',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真正说的话' }] } },
  ]);
  assert.deepEqual(evs.map((e) => e.text), ['真正说的话']);
});

test('注入块里夹着的真实请求要抢救出来，不是整条丢掉', () => {
  // 浏览器插件那种：前言里夹着 `## My request:`，后面才是人打的字
  const evs = codexEvents([
    { type: 'response_item', ordinal: 1, timestamp: 'T1',
      payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '# Chrome tabs:\n- Current URL: https://x\n## My request:\n这个第十题怎么做' }] } },
  ]);
  assert.deepEqual(evs.map((e) => e.text), ['这个第十题怎么做']);
});

test('assistant 的正文不过这层过滤——它本来就不会是前言', () => {
  const evs = codexEvents([
    { type: 'response_item', ordinal: 1, timestamp: 'T1',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<x>这是回复里的尖括号</x>' }] } },
  ]);
  assert.equal(evs[0].text, '<x>这是回复里的尖括号</x>');
});

test('工具结果开头写着失败的，透出为 tool.failed', () => {
  // 2026-10-10 全量（153 个 rollout）：shell_command 与 apply_patch 的结果以「Exit code: N」开头
  // （0 的 5676 条、正数 800、负数 11——Windows 的异常码）；exec（code mode）以
  // 「Script completed / running / failed / terminated」开头。输出正文里的 error、fatal 不算数
  const evs = codexEvents([
    rec('response_item', { type: 'function_call', call_id: 'c1', name: 'shell_command', arguments: '{"command":"pytest"}' }, 1),
    rec('response_item', { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 1\nWall time: 0.4 seconds\nOutput:\n1 failed' }, 2),
    rec('response_item', { type: 'function_call', call_id: 'c2', name: 'shell_command', arguments: '{"command":"ls"}' }, 3),
    rec('response_item', { type: 'function_call_output', call_id: 'c2', output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nerror.log' }, 4),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c3', name: 'exec', input: 'await tools.exec_command({cmd:"x"})' }, 5),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'Script failed\nWall time 0.4 seconds\nOutput:\nScript error: Exit code: 1' }] }, 6),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'await tools.exec_command({cmd:"y"})' }, 7),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c4', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\nfatal: not a git repository' }] }, 8),
    rec('response_item', { type: 'function_call', call_id: 'c5', name: 'shell_command', arguments: '{"command":"node a.js"}' }, 9),
    rec('response_item', { type: 'function_call_output', call_id: 'c5', output: 'Exit code: -2147450749\nWall time: 3 seconds\nOutput:\n' }, 10),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c6', name: 'exec', input: 'await tools.exec_command({cmd:"z"})' }, 11),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c6', output: [{ type: 'input_text', text: 'Script terminated\nWall time 9 seconds' }] }, 12),
    rec('response_item', { type: 'custom_tool_call', call_id: 'c7', name: 'exec', input: 'await tools.exec_command({cmd:"w"})' }, 13),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c7', output: [{ type: 'input_text', text: 'Script running with cell ID 3' }] }, 14),
    rec('response_item', { type: 'function_call', call_id: 'c8', name: 'wait_agent', arguments: '{}' }, 15),
    rec('response_item', { type: 'function_call_output', call_id: 'c8', output: '{"message":"Wait timed out.","timed_out":true}' }, 16),
  ]);
  const results = evs.filter((e) => e.kind === 'tool_result');
  assert.deepEqual(results.map((e) => e.tool.failed === true), [true, false, true, false, true, true, false, false]);
  // 还在跑、等子 agent 超时都不是失败；没有失败标记就不带这个字段
  assert.ok(results.filter((e) => e.tool.failed !== true).every((e) => !('failed' in e.tool)));
});
