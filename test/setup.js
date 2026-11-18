// 测试前置：把 BATON_DIR 整体重定向到临时目录。
//
// 由 package.json 的 `node --test --import ./test/setup.js` 预加载，
// 在任何 src/ 模块（BATON_DIR 是模块级常量）被导入之前执行。
//
// 为什么需要它：审计日志、轮次、意图都默认写 BATON_DIR。逐个调用点注入
// 临时目录的做法漏了几处，测试数据写进了真实的 ~/.baton/audit.log——
// 而那是「Baton 替我发过什么」的安全凭据，掺进 claude:abc 这种合成 key
// 就不可信了。整体重定向让测试没有机会碰到真实目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  桌面 App 的注册表同理：它的根目录由 LOCALAPPDATA 推出来（src/titles.js 的模块级常量），
  新建会话的 defaultRegistrar 往里写 `local_*.json`，写进去 App 侧栏里就多一条会话。
  2026-09-30 三条用例漏注入 registrar，一晚上往 owner 的真实注册表里写了 40 个
  「你好」。所以测试进程里整体改道：读不到真实注册表，也写不进去。
*/
if (!process.env.BATON_NO_CLI_PROBES) {
  process.env.BATON_NO_CLI_PROBES = '1';
}

if (!process.env.BATON_TEST_REAL_LOCALAPPDATA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `baton-test-localappdata-${process.pid}-`));
  process.env.BATON_TEST_REAL_LOCALAPPDATA = process.env.LOCALAPPDATA ?? '';
  process.env.LOCALAPPDATA = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉就算了
    }
  });
}

/*
  家目录也改道。`~/.claude/...` 下面有好几样默认路径是模块级常量算出来的：
  transcript 根、Codex rollout 根、Codex 的状态文件，以及 CLI 的进程登记
  （runtime/live.js 读它判断「电脑上哪些会话在跑」）。

  测试几乎都显式注入自己的临时根，但**漏一个就是在读 owner 的真实数据**：
  真实目录里有什么由他此刻在干什么决定，于是测试会时绿时红。改道之后默认值
  一律指向一个空的临时家目录，漏注入会当场空手而归，而不是读到真东西。
*/
if (!process.env.BATON_TEST_REAL_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `baton-test-userhome-${process.pid}-`));
  process.env.BATON_TEST_REAL_HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
  process.env.USERPROFILE = dir; // win32 的 os.homedir() 认这个
  process.env.HOME = dir; // POSIX 认这个
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉就算了
    }
  });
}

if (!process.env.BATON_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `baton-test-home-${process.pid}-`));
  process.env.BATON_DIR = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删不掉就算了
    }
  });
}
