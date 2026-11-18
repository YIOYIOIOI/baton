import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConnectionFailure, tierMarker, renderEventText,
  composerState, statusLine, speakerLabel, dirName,
} from '../src/web/app.js';

// ── 连接四态判别（spec §13 ②）──────────────────────
// access_expired 已于 2026-09-12 改名 intercepted：Access 撤了，但公司网的
// 强制门户同样以 302 拦截，分支仍然必要，只是不能再声称知道拦截者是谁。

test('opaqueredirect 判为被中途拦截', () => {
  assert.equal(classifyConnectionFailure({ type: 'opaqueredirect' }), 'intercepted');
});

test('3xx 同样判为被中途拦截', () => {
  assert.equal(classifyConnectionFailure({ type: 'basic', status: 302 }), 'intercepted');
});

test('401 判为未配对，不是被拦截', () => {
  assert.equal(classifyConnectionFailure({ type: 'basic', status: 401 }), 'unpaired');
});

test('探测本身失败判为离线', () => {
  assert.equal(classifyConnectionFailure({ error: true }), 'offline');
});

test('200 判为网络抖动，走退避重连', () => {
  assert.equal(classifyConnectionFailure({ type: 'basic', status: 200, ok: true }), 'transient');
});

// ── 标题档位标注（spec §6）─────────────────────────

test('第 1 档标题无标注，其余给出可读说明', () => {
  assert.equal(tierMarker(1), '');
  assert.match(tierMarker(2), /不保证与桌面显示一致/);
  assert.match(tierMarker(3), /不保证与桌面显示一致/);
});

// ── 事件渲染 ───────────────────────────────────────

test('renderEventText 按 kind 产出展示文本', () => {
  assert.equal(renderEventText({ kind: 'text', text: '你好' }), '你好');
  assert.equal(renderEventText({ kind: 'thinking', text: '先看目录' }), '先看目录');
  assert.equal(renderEventText({ kind: 'tool_result', tool: { output: 'a.txt' } }), 'a.txt');
});

test('tool_call 只出输入，工具名单独渲染在 .tool-name 里', () => {
  const asString = renderEventText({ kind: 'tool_call', tool: { name: 'exec', input: 'ls -la' } });
  assert.equal(asString, 'ls -la');
  const asObject = renderEventText({ kind: 'tool_call', tool: { name: 'Bash', input: { command: 'ls' } } });
  assert.equal(asObject, '{"command":"ls"}');
});

test('turn_end 区分成功与失败', () => {
  assert.match(renderEventText({ kind: 'turn_end', error: '服务器过载' }), /服务器过载/);
  assert.match(renderEventText({ kind: 'turn_end' }), /完成/);
});

test('interrupt 原样显示服务端给的那句话', () => {
  // 服务端一定给 text（src/claude.js 的 interruptOf 自带兜底），客户端不再编第二份措辞
  assert.equal(renderEventText({ kind: 'interrupt', role: 'system', text: '这一轮被中途打断' }), '这一轮被中途打断');
});

// ── 说话人（跨设备信息）────────────────────────────

test('speakerLabel 标出远程发送的消息', () => {
  assert.equal(speakerLabel({ role: 'user', origin: 'sdk' }, 'claude'), '你 · 远程发送');
});

test('缺少 origin 时不臆断设备', () => {
  // origin 缺失只说明「没有该标记」，不能反证是在 App 里手打的
  assert.equal(speakerLabel({ role: 'user' }, 'claude'), '你');
  assert.equal(speakerLabel({ role: 'user', origin: 'desktop' }, 'claude'), '你');
});

test('agent 说话人用可读名', () => {
  assert.equal(speakerLabel({ role: 'agent' }, 'claude'), 'Claude');
  assert.equal(speakerLabel({ role: 'agent' }, 'codex'), 'Codex');
  assert.equal(speakerLabel({ role: 'system' }, 'claude'), '', '工具结果不需要说话人');
});

// ── 目录名 ─────────────────────────────────────────

test('dirName 兼容两种路径分隔符', () => {
  assert.equal(dirName('C:\\workspace\\example'), 'example');
  assert.equal(dirName('/home/u/proj/'), 'proj');
  assert.equal(dirName(null), '');
});

// ── composer 与运行态（Task 20 / 26 的纯函数）──────

test('allowSend 关闭时 composer 禁用且给出修复指引', () => {
  const s = composerState({ allowSend: false });
  assert.equal(s.disabled, true);
  assert.match(s.hint, /config\.json/);
  assert.match(s.hint, /allowSend/);
});

test('allowSend 打开时 composer 可用且无提示', () => {
  const s = composerState({ allowSend: true });
  assert.equal(s.disabled, false);
  assert.equal(s.hint, '');
});

test('statusLine 把运行态翻成人话', () => {
  assert.match(statusLine({ running: true }), /进行中/);
  assert.match(statusLine({ running: false, latestTurn: { status: 'failed', error: '服务器过载' } }), /服务器过载/);
  assert.match(statusLine({ running: false, latestTurn: { status: 'anomaly', error: '有 token 却没有消息' } }), /异常/);
  assert.match(statusLine({ running: false, latestTurn: { status: 'aborted' } }), /停止/);
  assert.equal(statusLine({ running: false, latestTurn: null }), '');
});

// ── 客户端无关性回归（spec §3 第 9 条）──────────────

test('纯函数不依赖任何浏览器全局，可在 node 下直接引入', () => {
  // 本文件能 import 成功本身就是断言：app.js 顶层不得触碰 document / window
  assert.equal(typeof classifyConnectionFailure, 'function');
  assert.equal(typeof renderEventText, 'function');
});

// ── 硬故障与暂时故障的区分（审核发现的真实事故）────

import { isClientFault } from '../src/web/app.js';

test('端点不存在是 Baton 自己的 bug，必须可见', () => {
  // /state 的路由曾因正则漏了分支而 404，而空 catch 把它伪装成了正常降级
  assert.equal(isClientFault({ code: 'not_found' }), true);
  assert.equal(isClientFault({ code: 'asset_missing' }), true);
});

test('会话没了、未配对、网络抖动属于暂时故障，静默降级', () => {
  assert.equal(isClientFault({ code: 'unknown_session' }), false);
  assert.equal(isClientFault({ code: 'unauthorized' }), false);
  assert.equal(isClientFault({}), false);
  assert.equal(isClientFault(null), false);
});
