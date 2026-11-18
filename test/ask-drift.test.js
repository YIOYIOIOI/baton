import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_TOOL } from '../src/ask/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** 注释里提到的不算数——只看真代码。和 web-touch 那条同一个做法。 */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 工具名是**三个包之间的协议**，不是谁的实现细节。
 *
 * 服务端决定它叫什么（`mcp__baton__ask`，由 MCP 的命名规则 `mcp__<服务>__<工具>`
 * 推出来）；两个客户端要认得它，才能把历史记录里的那次调用渲染成一道题而不是
 * 一坨转义 JSON。app/ 与 web/ 是独立的包，没有共享模块的构建，所以各有一份名字。
 *
 * 漂移的后果是**静默降级**：没有报错，只是那些调用又变回 JSON 疙瘩。
 * 这条测试不测行为（各包自有单测），只钉「三边说的是同一个名字」。
 *
 * 一并钉住 `AskUserQuestion`：那是 Claude **交互式**界面里的那个工具。Baton 自己
 * 跑的轮次拿不到它（`-p` 模式下不存在，见 src/ask/protocol.js 抬头的三次实测），
 * 但 owner 在电脑上继续同一条会话时会产生它，而两端读的是同一份 transcript。
 * 本机 transcript 里有 167 次。
 */

const WEB = code('web/src/tools.ts');
const APP = code('app/src/components/stream.tsx');

test('两个客户端认的工具名与服务端定义的一致', () => {
  assert.equal(ASK_TOOL, 'mcp__baton__ask',
    '改这个名字要连同两个客户端一起改——MCP 的命名是 mcp__<服务名>__<工具名>');
  for (const [name, src] of [['web', WEB], ['app', APP]]) {
    assert.ok(src.includes(ASK_TOOL), `${name} 不认识 ${ASK_TOOL}，那次调用会渲染成一坨 JSON`);
    assert.ok(src.includes('AskUserQuestion'),
      `${name} 不认识 AskUserQuestion——电脑上问过的那 167 道题在手机上会是 JSON`);
  }
});

test('两个客户端都从 questions[] 与 question 两种形状里取问题', () => {
  // 两个来源的入参形状不同：交互式那个是 {questions:[{question,…}]}，
  // Baton 自己那个是 {question,…}。只认一种的那一边会有一半显示不出来。
  for (const [name, src] of [['web', WEB], ['app', APP]]) {
    assert.ok(/\bquestions\b/.test(src), `${name} 没处理 questions[] 形状（交互式那个）`);
    assert.ok(/\bquestion\b/.test(src), `${name} 没处理 question 形状（Baton 自己那个）`);
  }
});

test('答题端点在两个客户端里都接上了——它是这张卡唯一的出口', () => {
  const webApi = code('web/src/api.ts');
  const appApi = code('app/src/api/client.ts');
  for (const [name, src] of [['web', webApi], ['app', appApi]]) {
    assert.ok(src.includes('/answer'), `${name} 没有答题端点，卡片点了没有任何效果`);
    assert.ok(src.includes('askId'),
      `${name} 没带 askId——断线期间这轮可能已换了一道题，不带就会把答案安到别的问题上`);
  }
});
