// 网页端站内跳转的 Link（web/src/router.tsx）。它是 .tsx、带 JSX，Node 直接 import 不了，所以看源码。
//
// 2026-11-11 owner：「现在我切换聊天的时候会整个页面刷新」。原来是 `onClick={onClick} {...rest}`：
// 侧栏会话行一传自己的 onClick（点击时收起悬停卡片），就把 Link 拦截点击、做站内跳转的那个处理器顶掉了。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../web/src/router.tsx', import.meta.url), 'utf8');

test('Link：站内跳转的 onClick 放在展开的属性后面，调用方传的 onClick 顶不掉它', () => {
  const a = /<a href=\{to\}([^>]*)>/.exec(src)?.[1] ?? '';
  assert.ok(a.indexOf('{...rest}') >= 0, '找不到 <a> 上展开的属性——结构变了就重写这条');
  assert.ok(a.indexOf('onClick={onClick}') > a.indexOf('{...rest}'), 'onClick 必须在 {...rest} 之后');
});

test('Link：调用方的 onClick 还会被调用（先它、后站内跳转）', () => {
  assert.match(src, /onClick:\s*onClickProp/);
  assert.match(src, /onClickProp\?\.\(e\)/);
});
