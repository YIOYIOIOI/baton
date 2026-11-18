import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairArgs } from '../src/pairargs.js';

/**
 * 配对码是谁的，必须**问出来**，不能猜。
 *
 * 2026-09-20：owner 想给朋友取一个访客码，朋友兑换后看到的却是 owner 的全部
 * 工作区。根因不在隔离逻辑（scope.js 是对的），在取码这一步：
 *
 *     npm run pair --for friend      ← 只有一个 --
 *
 * npm 把 `--for` 当成自己的配置吃掉了，脚本收到的 argv 是 `["friend"]`——
 * 身份 id 明明就在那儿，却因为找不到 `--for` 而被丢掉，然后**静默退回给 owner
 * 铸码**。owner 把这个码发给朋友，朋友兑换，拿到的是 owner 身份。
 *
 * 这是一条在安全边界上 fail-open 的路：**敲错一个标志 = 把全部工作区交出去**，
 * 而屏幕上只差一行容易略过的字。
 *
 * 所以规则改成：**凡是看不懂的参数一律拒绝铸码**。只有两种情况放行——
 * 什么都不带（owner 自己的设备），或者规规矩矩写了 `--for <id>`。
 */

test('什么都不带 = owner 自己的设备', () => {
  assert.deepEqual(parsePairArgs([]), { ok: true, for: null });
});

test('规规矩矩写 --for，两种写法都认', () => {
  assert.deepEqual(parsePairArgs(['--for', 'friend']), { ok: true, for: 'friend' });
  assert.deepEqual(parsePairArgs(['--for=friend']), { ok: true, for: 'friend' });
});

test('npm 把 --for 吃掉之后只剩下一个裸 id —— 必须拒绝，而不是退回 owner', () => {
  const r = parsePairArgs(['friend']);
  assert.equal(r.ok, false, '这正是那次事故：裸 id 被丢掉，然后铸了个 owner 的码');
  // 报错得**指着那个少写的 --** 说话，否则人会照着原样再敲一遍
  assert.match(r.fix, /--\s+--for|两个/, `提示里没说清要写两个 --：${r.fix}`);
  assert.match(r.fix, /friend/, '提示里该把他本来想写的 id 原样带上');
});

test('两个 -- 且 --for 被空格拆开 —— 拒绝，并说中那个空格', () => {
  // owner 第二次就是这么敲的：npm run pair -- -- for friend
  // 老代码同样找不到 '--for'，于是又铸了一个 owner 的码发给了朋友
  const r = parsePairArgs(['--', 'for', 'friend']);
  assert.equal(r.ok, false);
  assert.match(r.fix, /--for/, '提示里得给出连写的正确形式');
  assert.match(r.fix, /空格/, `提示里没点破是空格的问题：${r.fix}`);
  assert.match(r.fix, /friend/, '提示里该把他本来想写的 id 原样带上');
});

test('多写的 -- 本身不算错 —— 它就是「后面别当选项解析」的老约定', () => {
  assert.deepEqual(parsePairArgs(['--', '--for', 'friend']), { ok: true, for: 'friend' });
  assert.deepEqual(parsePairArgs(['--']), { ok: true, for: null });
});

test('记错成 --guest / --as / --user —— 拒绝，并说清正确的是 --for', () => {
  for (const wrong of ['--guest', '--as', '--user']) {
    const r = parsePairArgs([wrong, 'friend']);
    assert.equal(r.ok, false, `${wrong} 被当成了没带参数，于是铸 owner 的码`);
    assert.match(r.fix, /--for/, `提示里没告诉他正确的是 --for：${r.fix}`);
  }
});

test('--for 后面什么都没有 —— 拒绝', () => {
  for (const args of [['--for'], ['--for', '--verbose'], ['--for=']]) {
    assert.equal(parsePairArgs(args).ok, false, `${JSON.stringify(args)} 不该放行`);
  }
});

test('任何看不懂的参数都拒绝，绝不退回 owner', () => {
  for (const args of [['--wat'], ['--for', 'friend', 'extra'], ['-f', 'friend']]) {
    assert.equal(parsePairArgs(args).ok, false, `${JSON.stringify(args)} 不该放行`);
  }
});

test('id 的形状和 principals.json 那边一致，脏东西不往下传', () => {
  for (const bad of ['Friend', 'a/b', '../x', '', 'x'.repeat(33)]) {
    assert.equal(parsePairArgs(['--for', bad]).ok, false, `id ${JSON.stringify(bad)} 不该放行`);
  }
});
