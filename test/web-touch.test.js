import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMobileUA } from '../src/http/static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 平板上「点加号没反应，反而弹出模型配置」这个 bug 的回归护栏。
 *
 * ## 根因不在加号的代码里，在「谁拿到哪一套界面」
 *
 * iPad 默认自称是 Mac（`Macintosh; Intel Mac OS X`，不带 `Mobile`），于是
 * `isMobileUA` 判它不是手机，服务端就把 **web/dist——那套按鼠标做的桌面界面**
 * 发给了它。owner 自己用电脑和 iPhone 都没事：电脑是鼠标，iPhone 拿到的是
 * app/dist。唯一会拿到「鼠标界面 + 手指」这个组合的就是 iPad。
 *
 * 而那套界面里，加号是 34×34 的命中盒，正上方 20px 就是 140px 宽的模型配置条。
 * 34 低于 44 这条触摸下限，手指落点一偏，浏览器在做触摸命中修正时就会挑中
 * 旁边那个大得多的目标——于是加号像是死的，弹出来的是模型配置。
 *
 * 所以这里钉三件事：
 *   1. iPad 拿桌面版这件事是**有意的**，不是漏了个设备名（改它要先想清楚 13 寸
 *      iPad 是不是真想要手机界面）——既然有意，那套界面就必须自己扛得住手指
 *   2. 触摸屏上加号的命中区被撑到 ≥44
 *   3. 模型配置那条和输入框之间，触摸屏上要留出手指宽度
 */

/** 抠出 `@media (pointer: coarse) { … }` 那一段，按花括号配平找结尾。 */
function coarseBlock(css) {
  const at = css.indexOf('@media (pointer: coarse)');
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

test('iPad 拿到的是桌面那一套——这是有意的，别当成漏了设备名去"修"', () => {
  // iPadOS Safari 的默认 UA。没有 Mobile 标记，机型写的是 Macintosh
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  assert.equal(isMobileUA(ipad), false, 'iPad 被判成了手机——那 web/dist 的触摸问题就被绕过去了，不是修好了');

  // 对照：iPhone 和 Android 平板都该走手机那一套
  assert.equal(isMobileUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'), true);
  assert.equal(isMobileUA('Mozilla/5.0 (Linux; Android 13; SM-X700) Chrome/120.0.0.0 Safari/537.36'), true);
});

test('触摸屏上，加号和发送的命中区被撑到 44', () => {
  const css = read('web/src/inputbox.css');
  const coarse = coarseBlock(css);
  assert.ok(coarse, 'inputbox.css 里没有 @media (pointer: coarse) 这一段');

  // 加号：命中区就是那个真 input 自己，靠负 inset 撑出圈外
  const plus = /\.attach-input[^{}]*\{[^}]*inset:\s*(-?[\d.]+)px/s.exec(coarse);
  assert.ok(plus, '加号那个 input 没有撑开命中区');
  const grown = 34 + Math.abs(parseFloat(plus[1])) * 2;
  assert.ok(grown >= 44, `加号的命中区只有 ${grown}px，低于 44 这条触摸下限`);

  // 发送键没有真控件可以撑，只能拿伪元素代劳
  const send = /\.send::after[^{}]*\{[^}]*inset:\s*(-?[\d.]+)px/s.exec(coarse);
  assert.ok(send, '发送键没有撑开命中区的伪元素');
  assert.ok(34 + Math.abs(parseFloat(send[1])) * 2 >= 44, '发送键的命中区低于 44');
});

test('加号是一个真 file input，不是「按钮 + JS 去点一个藏起来的 input」', () => {
  // 注释里会**讲到**旧做法（那段历史值得留着），所以先把注释剥掉再查代码，
  // 否则测试会被自己的解释文字匹配到——这个假阳性在这个仓库里已经踩过一次
  const tsx = read('web/src/InputBox.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const css = read('web/src/inputbox.css').replace(/\/\*[\s\S]*?\*\//g, '');

  // 受限 WebView（微信内置浏览器、早期 iOS）只对用户真的点到、且真的渲染出来的
  // file input 弹选择器。合成点击不弹，而且不报错——表现就是「点了完全没反应」。
  assert.ok(!/\.click\(\)/.test(tsx), 'InputBox 里又出现了 input.click()——那条路在受限 WebView 里不弹选择器');
  assert.ok(!/display:\s*none/.test(/\.attach-input\s*\{[^}]*\}/s.exec(css)?.[0] ?? ''),
    '.attach-input 又被 display:none 藏起来了——藏起来就退出命中测试，手指点不到它');
  assert.match(css, /\.attach-input[^{}]*\{[^}]*opacity:\s*0/s, '.attach-input 该是 opacity:0 铺在加号上，而不是被隐藏');
});

test('触摸屏上，模型配置那条和输入框之间留出手指宽度', () => {
  // 2026-10-10 起配置条挂在输入框**底下**（InputBox 的 pills，两页共用），不再是会话页
  // 输入框上方的 .composer-cfg——上方那一截正文还看得见，没底色的一行字摆在那儿就叠字。
  // 挨着加号的方向从上面换成了下面，要守的还是同一件事：两个目标之间得有手指宽度。
  const coarse = coarseBlock(read('web/src/inputbox.css'));
  assert.ok(coarse, 'inputbox.css 里没有 @media (pointer: coarse) 这一段');
  const m = /\.pills[^{}]*\{[^}]*margin-top:\s*([\d.]+)px/s.exec(coarse);
  assert.ok(m, '配置条在触摸屏上没有拉开和输入框的距离');
  const gap = parseFloat(m[1]);
  // 鼠标下是 6px。手指落点的抖动量就有十几个 px，6px 等于两个目标贴在一起
  assert.ok(gap >= 14, `配置条离输入框只有 ${gap}px，手指点加号会被修正到配置条上`);

  // 配置条自己也得够手指点：它只有 25px 高
  const cfg = coarseBlock(read('web/src/sessionconfig.css'));
  assert.ok(cfg, 'sessionconfig.css 里没有 @media (pointer: coarse) 这一段');
  assert.match(cfg, /\.cfg-bar[^{}]*\{[^}]*min-height:\s*44px/s, '配置条在触摸屏上没有撑到 44');
});
