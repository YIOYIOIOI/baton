import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLE_MODEL, buildTitleArgs, cleanTitle, generateTitle } from '../src/agent/title.js';

/*
  手机上新建的会话，名字跟 Claude App 一样由模型起（owner 2026-10-08：
  「用 claude 原生新建对话不就可以做到和 claude 一样的让他自己去取标题了吗」）。

  实测过的两件事（见 docs/ops/agent-protocol.md §10）：
    - `claude -p` 自己不起名：sdk-cli 的 transcript 里没有 ai-title / agent-name 记录
    - 起一次名要 6–11 秒，所以它**不能挡在新建这条路上**，只能并着跑完再补
*/

test('参数：一次性、不留 transcript、用便宜模型', () => {
  const a = buildTitleArgs();
  assert.ok(a.includes('-p'));
  assert.ok(a.includes('--no-session-persistence'), '不能在 ~/.claude 里留一条探测会话');
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', TITLE_MODEL]);
  assert.ok(!a.includes('--session-id'));
  assert.ok(!a.includes('--resume'));
});

test('模型回什么都不会直接用：引号、句号、前后空白都去掉', () => {
  assert.equal(cleanTitle('「修登录按钮错位」'), '修登录按钮错位');
  assert.equal(cleanTitle('"Fix login button"'), 'Fix login button');
  assert.equal(cleanTitle('  修登录按钮错位。\n'), '修登录按钮错位');
  assert.equal(cleanTitle('标题：修登录按钮错位'), '修登录按钮错位');
});

test('不像标题的一律丢掉，宁可退回首句', () => {
  // 整段解释、带换行的、空的、长得离谱的——都不是标题
  assert.equal(cleanTitle('好的，我来帮你起一个标题\n修登录按钮错位'), null, '多行不要');
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle('这'.repeat(41)), null, '过长的不要');
  assert.equal(cleanTitle('Not logged in · Please run /login'), null, '报错不能当标题');
  assert.equal(cleanTitle('x'.repeat(40)), 'x'.repeat(40), '刚到上限的留着');
});

test('拿到干净标题就返回它', async () => {
  const seen = {};
  const title = await generateTitle({
    message: '修一下手机上发消息之后那个转圈一直不停的问题',
    run: async (o) => { Object.assign(seen, o); return { code: 0, lines: ['修发送转圈不停'], stderr: '' }; },
  });
  assert.equal(title, '修发送转圈不停');
  assert.equal(seen.command, 'claude');
  assert.match(seen.message, /修一下手机上发消息/, '原文走 stdin，不进 argv');
  assert.ok(seen.args.every((a) => !a.includes('修一下')), '一个字都不许进 argv');
  assert.ok(seen.timeoutMs > 0, '必须有时限：这是后台的锦上添花，不能挂住不放');
});

test('失败就是 null——起名失败不许影响建会话', async () => {
  const bad = [
    { code: 1, lines: [], stderr: 'Not logged in' },
    { code: 0, lines: [], stderr: '' },
    { code: 0, lines: ['好的，这是一个标题：', '修登录'], stderr: '' },
  ];
  for (const r of bad) {
    assert.equal(await generateTitle({ message: '随便什么', run: async () => r }), null, JSON.stringify(r));
  }
  assert.equal(await generateTitle({ message: '随便什么', run: async () => { throw new Error('起不来'); } }), null, '抛异常也只是没有标题');
  assert.equal(await generateTitle({ message: '   ', run: async () => { throw new Error('不该调'); } }), null, '空消息根本不调');
});

test('带附件清单的消息：清单不进提示词', async () => {
  let sent = '';
  await generateTitle({
    message: ['看看这个表', '', '附件（已放在工作目录下）：', '- .baton-uploads/report.xlsx（12 B）'].join('\n'),
    run: async (o) => { sent = o.message; return { code: 0, lines: ['查看报表'], stderr: '' }; },
  });
  assert.match(sent, /看看这个表/);
  assert.ok(!sent.includes('.baton-uploads'), '清单是给 agent 的路径，不是会话在说什么');
});

test('只发了文件、一个字没写：不花这次调用', async () => {
  const t = await generateTitle({
    message: ['', '附件（已放在工作目录下）：', '- .baton-uploads/report.xlsx（12 B）'].join('\n'),
    run: async () => { throw new Error('不该调'); },
  });
  assert.equal(t, null, '文件名本身就是标题，没有可总结的正文');
});
