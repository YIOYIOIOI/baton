import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 网页端会话页「往前翻更早的」的回归护栏（2026-11-07）。
 *
 * owner：「往上滚看更早这个文案改掉，同时这个功能也有 bug」。在浏览器里拿编的会话
 * （10 轮，每轮 1 句话 + 13 条命令 + 1 句收尾，共 280 条，按服务端的规矩一页 60 条）实测出三个：
 *
 *   1. **卡住。** 翻页挂在滚动事件上（scrollTop < 120 才去取）。工具调用折叠以后一页很矮，
 *      大屏上填不满就没有滚动条，滚轮滚不动、浏览器不发滚动事件——顶上写着「往上滚可以看更早的」，
 *      却永远翻不出来（1440×1500：只发了首屏那一次请求，第 1–7 轮看不到）。
 *   2. **跳。** 不是正好滚到 0 时触发，浏览器自带的滚动锚定已经把正在读的那一行留在原地，
 *      代码又手动补了一次增量——那一行被顶上去一整页（停在离顶 100px：-239 / -305 / -146px）。
 *   3. **失败没声音。** 翻历史失败被吞掉，指望「顶部还会再触发」——而卡住时根本不会再触发。
 *
 * 这些都是滚动和布局的行为，Node 里跑不出来，所以和 web-touch.test.js 同一条路子：
 * 钉住源码里修好它们的那几处结构。改到这里报红了，先回浏览器按上面的数重测一遍再动。
 */

const conv = read('web/src/Conversation.tsx');
const css = read('web/src/conversation.css');

test('往前翻不挂在滚动事件上：没有滚动条、已经停在最顶上时都翻得出来', () => {
  const onScroll = /const onScroll = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/.exec(conv);
  assert.ok(onScroll, 'Conversation.tsx 里找不到 onScroll');
  assert.doesNotMatch(onScroll[1], /api\s*\.\s*events|loadOlder/,
    '翻页又挂回滚动事件了：第一页填不满屏幕时浏览器不发滚动事件，会永远翻不出来');

  assert.match(conv, /new IntersectionObserver\(/, '顶上那一行要用观察器盯着，进到视口附近就翻');
  assert.match(conv, /rootMargin:\s*'\d+px 0px 0px 0px'/, '要提前一段去翻：人滚到顶时更早的最好已经在了');
});

test('前插只补一次位移：滚动区关掉浏览器自带的锚定，位移在那次渲染上屏前补', () => {
  const block = /\.conv-scroll\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'conversation.css 里找不到 .conv-scroll');
  assert.match(block[1], /overflow-anchor:\s*none/,
    '浏览器的锚定和代码里补的位移会叠加：正在读的那一行被顶上去一整页');

  // 补位移放在 layout effect 里：那次渲染落地、上屏之前补。原来放在 requestAnimationFrame 里，
  // 它和 React 提交谁先谁后没准——先跑了就量到旧高度、一点没补
  assert.match(conv, /useLayoutEffect\(\(\) => \{\s*const h = prepend\.current;/, '前插的位移要在 layout effect 里补');
});

test('顶上那一行只说状态：在读、读不出来能重试、到头了；不再教人「往上滚」', () => {
  assert.doesNotMatch(conv, /['"`]往上滚/, '「往上滚可以看更早的」教人做他已经在做的事，没有滚动条时还做不到');

  assert.match(conv, /正在读更早的…/);
  assert.match(conv, /'更早的对话'/, '平时那句和手机端同一个词（app 的会话页也写「更早的对话」）');
  assert.match(conv, /'更早的对话没读出来，点这里重试'/);
  assert.match(conv, /会话从这里开始/, '翻到头了要说一声，不然人不知道上面还有没有');

  // 失败要落进状态（才有重试那一行），不能再吞掉
  assert.match(conv, /\.catch\(\(\) => setOlderErr\(true\)\)/, '往前翻失败被吞掉了：顶上不会出现重试');
  // 和手机端一样按 id 去重，重叠的那几条不会出两遍
  assert.match(conv, /!seen\.has\(x\.id\)/, '往前翻要按 id 去重');
});
