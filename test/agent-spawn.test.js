import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/agent/spawn.js';
import { tmpDir } from './helpers.js';

// 用 node 自己扮演 agent，避免单测里真的调用 CLI 花钱
const ECHO = [
  '-e',
  '"let s=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>s+=d);' +
  'process.stdin.on(\'end\',()=>{console.log(JSON.stringify({type:\'assistant\',text:s}));' +
  'console.log(JSON.stringify({type:\'result\',is_error:false}));process.exit(0)})"',
];

test('默认不给整轮设时长上限（原来 600 秒一到就杀，杀的是正常干活的轮次）', async () => {
  const delays = [];
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return orig(fn, ms, ...rest);
  };
  try {
    await runProcess({
      command: process.execPath, args: ['-e', '"process.exit(0)"'], cwd: tmpDir(), message: '',
    });
  } finally {
    globalThis.setTimeout = orig;
  }
  // 只看分钟级的计时器：node 内部自己也会挂几个短的
  assert.deepEqual(delays.filter((ms) => ms >= 60_000), []);
});

test('路径含空格的命令能正常启动（shell:true 会原样拼接，须加引号）', async () => {
  // 实测踩过：C:\Program Files\nodejs\node.exe 被 shell 在空格处切断
  // → 'C:\Program' 不是内部或外部命令。裸名 claude/codex 不受影响，
  // 但配置里可以给绝对路径，故 runProcess 防御性加引号。
  const r = await runProcess({
    command: process.execPath, args: ['-e', '"process.exit(0)"'], cwd: tmpDir(), message: '',
  });
  assert.equal(r.code, 0, `启动失败：${r.stderr}`);
  if (!/\s/.test(process.execPath)) {
    console.log('  提示：本机 node 路径不含空格，这条回归的覆盖力被削弱了');
  }
});

test('消息经 stdin 送入，stdout 逐行回调', async () => {
  const lines = [];
  const r = await runProcess({
    command: process.execPath, args: ECHO, cwd: tmpDir(),
    message: '你好 Baton', onLine: (l) => lines.push(l),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, '你好 Baton');
});

test('中文经 stdin 往返不乱码', async () => {
  const lines = [];
  await runProcess({
    command: process.execPath, args: ECHO, cwd: tmpDir(),
    message: '接力棒已就位', onLine: (l) => lines.push(l),
  });
  assert.equal(JSON.parse(lines[0]).text, '接力棒已就位');
});

test('含 shell 元字符的消息不被解释', async () => {
  const lines = [];
  await runProcess({
    command: process.execPath, args: ECHO, cwd: tmpDir(),
    message: '& calc.exe && echo pwned | rm -rf /', onLine: (l) => lines.push(l),
  });
  assert.equal(JSON.parse(lines[0]).text, '& calc.exe && echo pwned | rm -rf /',
    '消息走 stdin，shell 无从解释它');
});

test('非零退出码被如实返回', async () => {
  const r = await runProcess({
    command: process.execPath, args: ['-e', '"process.exit(3)"'], cwd: tmpDir(), message: 'x',
  });
  assert.equal(r.code, 3);
});

test('超时会杀掉进程并标记 timedOut', async () => {
  const r = await runProcess({
    command: process.execPath, args: ['-e', '"setTimeout(()=>{},60000)"'],
    cwd: tmpDir(), message: 'x', timeoutMs: 300,
  });
  assert.equal(r.timedOut, true);
});

test('kill 要杀掉整棵进程树，不只是 shell 那一层', async () => {
  // 实测踩过的 bug：shell:true 下 child 是 cmd.exe，child.kill() 只杀那一层，
  // 真正的 agent 照跑到底；stdout 管道不关 → promise 永不 resolve →
  // 轮次永远挂在 running。stop 于是回报 stopped:true 却什么都没停下。
  //
  // 这里用一个活 60 秒的孙进程：kill 若只杀 shell，promise 不会在超时前 resolve。
  let handle = null;
  const t0 = Date.now();
  const p = runProcess({
    command: process.execPath,
    args: ['-e', '"setTimeout(()=>{},60000)"'],
    cwd: tmpDir(),
    message: '',
    timeoutMs: 30000,
    onStart: (h) => { handle = h; },
  });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(handle, 'onStart 必须交出停止句柄');
  handle.kill();
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 15000, `kill 之后进程应当很快退出，实际等了 ${elapsed}ms——整棵树没被杀掉`);
  assert.equal(r.killed, true);
  assert.equal(r.timedOut, false, '应当是被 kill 而不是超时');
});

test('timeoutMs 也要能杀掉整棵树（同一个根因的第二处受害）', async () => {
  // 退回 child.kill() 时实测：30 秒超时对一个活 60 秒的进程毫无作用，
  // 整整等了 60112ms。挂死的 agent 根本超不出去。
  const t0 = Date.now();
  const r = await runProcess({
    command: process.execPath,
    args: ['-e', '"setTimeout(()=>{},60000)"'],
    cwd: tmpDir(), message: '', timeoutMs: 1200,
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 15000, `超时后进程应当很快退出，实际等了 ${elapsed}ms`);
});
