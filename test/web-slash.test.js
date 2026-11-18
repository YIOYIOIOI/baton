// 输入框里「光标所在那个词」是不是在点名命令 / 技能（web/src/slash.ts，纯函数，Node 24 直接 import .ts）。
//
// owner 2026-11-11：「你的 / 命令只能在刚开头用，我用 claude desktop 或者 codex 的时候随时输入 / 都
// 支持，只要 / 前面带个空格区分」。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as web from '../web/src/slash.ts';
import * as app from '../app/src/api/slash.ts';

// 网页端和手机端各一份，逻辑必须一样：同一组用例两边各跑一遍
for (const [side, { tokenAt, replaceToken }] of Object.entries({ web, app })) {

test(`${side}：句首的 / 是命令`, () => {
  assert.deepEqual(tokenAt('/go', 3, '/'), { start: 0, end: 3, query: 'go', atStart: true });
  assert.deepEqual(tokenAt('/', 1, '/'), { start: 0, end: 1, query: '', atStart: true });
  assert.deepEqual(tokenAt('  /co', 5, '/'), { start: 2, end: 5, query: 'co', atStart: true }, '前面只有空白也算句首');
});

test(`${side}：句中：/ 前面是空格或换行就算，光标在哪个词就看哪个词`, () => {
  assert.deepEqual(tokenAt('帮我用 /qq', 7, '/'), { start: 4, end: 7, query: 'qq', atStart: false });
  assert.deepEqual(tokenAt('第一行\n/de', 7, '/'), { start: 4, end: 7, query: 'de', atStart: false });
  // 光标停在中间那个词上，后面还有字
  const v = '先 /sim 再说';
  assert.equal(tokenAt(v, 6, '/')?.query, 'sim');
  assert.equal(tokenAt(v, v.length, '/'), null, '光标在「说」后面：那个词不是命令');
});

test(`${side}：前面不是空白的 / 不算：路径、网址、分数`, () => {
  assert.equal(tokenAt('看 src/agent', 12, '/'), null);
  assert.equal(tokenAt('打开 http://x', 13, '/'), null);
  assert.equal(tokenAt('3/4', 3, '/'), null);
  assert.equal(tokenAt('看 /a/b', 6, '/'), null, '/a/b 是路径');
});

test(`${side}：Codex 另认 $；Claude 不认`, () => {
  assert.equal(tokenAt('用 $pdf', 6, '/$')?.query, 'pdf');
  assert.equal(tokenAt('用 $pdf', 6, '/'), null);
  assert.equal(tokenAt('价格 $5', 5, '/$')?.query, '5', '$5 也会弹，但没有叫 5 的技能，菜单里就是「没有对得上的」');
});

test(`${side}：replaceToken：换掉那个词、补一个空格，光标落在空格后面`, () => {
  const v = '帮我用 /ma 发邮件';
  const t = tokenAt(v, 7, '/');
  assert.deepEqual(replaceToken(v, t, '/mail-helper'), { value: '帮我用 /mail-helper 发邮件', caret: 17 });
  const w = '用 $p';
  assert.deepEqual(replaceToken(w, tokenAt(w, 4, '/$'), '$pdf:pdf'), { value: '用 $pdf:pdf ', caret: 11 });
});
}
