import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_KINDS } from '../src/events.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 注释里提到的不算数——只看真代码。和 ask-drift / web-touch 同一个做法。 */
const code = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * 事件 kind 是**服务端与三个客户端之间的协议**。
 *
 * 2026-09-29 那次修的三个毛病，根因是同一个：**客户端对不认识的 kind 没有明确的
 * 去处**，于是掉进了别的分支——
 *
 *   中断标记     服务端当成 user 的 text 发出去 → 三个客户端都画成用户气泡
 *   codex 结束   App 的会话屏「不是 user 就当 agent 正文」→ 每轮最终回答画两遍（310 次）
 *   codex 出错   网页端把 error 当对象读 .message → 31 次全显示「未知原因」
 *
 * 所以这里钉两条：每个 kind 在每个客户端的渲染代码里都有名有姓；App 的正文兜底
 * 分支前面必须先把非 text 的挡掉。将来再加一个 kind 而客户端没跟上，这里当场红。
 */

/*
  只看**渲染**那一处，不看类型文件：类型里写了这个名字，不等于渲染时有去处——
  第一版把类型文件也算进来，撤掉渲染改动之后这条照样过，等于没钉住。
*/
/*
  网页端是两个文件：runs.ts 决定每个事件往哪儿走（工具调用、结果、思考归进「一段活」，
  正文和中断各占一行），Conversation.tsx 再把它们画出来。2026-10-10 分段挪进
  runs.ts 是为了能测（test/web-runs.test.js）——它是分流的那一处，不是类型文件。
  App 同一天照做：分段在 app/src/api/runs.ts，会话屏只管画。
*/
const CLIENTS = {
  web: ['web/src/Conversation.tsx', 'web/src/runs.ts'],
  app: ['app/src/app/session/[key].tsx', 'app/src/api/runs.ts'],
  v1: ['src/web/app.js'],
};

test('每一种事件 kind，三个客户端都认得', () => {
  for (const kind of EVENT_KINDS) {
    for (const [name, files] of Object.entries(CLIENTS)) {
      const src = files.map(code).join('\n');
      assert.ok(src.includes(`'${kind}'`),
        `${name} 不认识 kind「${kind}」——它会掉进别的分支（${files.join('、')}）`);
    }
  }
});

test('App 会话屏：非 text 的事件进不了「不是 user 就当 agent 正文」那个分支', () => {
  const src = code('app/src/app/session/[key].tsx');
  // 锚在逐段渲染的那个分支里：同一个文件别处早就有一句 `e.kind !== 'text'`
  // （找首条用户消息的循环），第一版就是被它骗过去的
  const branch = src.indexOf('const e = seg.event;');
  const guard = src.indexOf("if (e.kind !== 'text')", branch);
  const fallback = src.indexOf('<MsgText text={e.text', branch);
  assert.ok(branch > 0, '找不到逐段渲染的分支——结构变了就重写这条');
  assert.ok(guard > branch, '逐段渲染的分支里没有 kind 守卫');
  assert.ok(fallback > guard, '守卫必须在 MsgText 兜底之前');
});

test('中断提示的措辞只在服务端写一份，客户端只显示 ev.text', () => {
  // 「for tool use = 拒绝了工具调用」是协议知识。客户端各写一份，迟早说成三种话
  const server = fs.readFileSync(path.join(ROOT, 'src/claude.js'), 'utf8');
  const says = [...server.matchAll(/'(这一轮[^']*|拒绝了[^']*)'/g)].map((m) => m[1]);
  assert.ok(says.length >= 2, '服务端应当有那几句话');
  for (const files of Object.values(CLIENTS)) {
    const src = files.map(code).join('\n');
    for (const s of says) assert.ok(!src.includes(s), `客户端里又写了一份「${s}」`);
  }
});

test('网页端把 turn_end 的 error 当字符串读——服务端给的就是字符串', () => {
  const src = code('web/src/Conversation.tsx');
  assert.ok(!/ev\.error\.message/.test(src), '读 .message 就永远是「未知原因」');
});
