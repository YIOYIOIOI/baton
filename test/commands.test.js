import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  commandsFromInit, descriptionOf, claudeCommands, rememberInit, clearCommandCache, codexSkillsFrom, codexCommands,
  listCodexSkills, keyOf,
} from '../src/agent/commands.js';
import { normPath } from '../src/scope.js';
import { listCommands } from '../src/http/handlers/commands.js';

/*
  2026-11-10：输入框打 `/` 的命令菜单。表取自 claude 自己的 system/init（2.1.322 实测的形状），
  下面的夹具字段照抄，值删到够用。
*/

function homeWith(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-cmd-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return home;
}

test('descriptionOf：单行、引号、折叠块都认；没有 frontmatter 返回 null', () => {
  assert.equal(descriptionOf('---\nname: x\ndescription: 做一件事\n---\n正文'), '做一件事');
  assert.equal(descriptionOf('---\ndescription: "带引号的"\n---'), '带引号的');
  assert.equal(descriptionOf('---\ndescription: >\n  第一行\n  第二行\nname: x\n---'), '第一行 第二行');
  assert.equal(descriptionOf('没有 frontmatter'), null);
});

test('commandsFromInit：内置 / 技能 / 插件分组，常用的排前，终端专用与内部的不列', () => {
  const home = homeWith({
    [path.join('.claude', 'skills', 'mail-helper', 'SKILL.md')]: '---\ndescription: Send and read mail\n---',
    [path.join('plugins', 'sp', 'skills', 'brainstorming', 'SKILL.md')]: '---\ndescription: Use before creative work\n---',
  });
  const init = {
    cwd: path.join(home, 'proj'),
    slash_commands: ['mail-helper', 'superpowers:brainstorming', 'zeta', 'compact', 'goal', 'doctor', '__remote-workflow', 'extra-usage', 'context'],
    skills: ['mail-helper', 'superpowers:brainstorming'],
    terminal_slash_commands: ['doctor'],
    plugins: [{ name: 'superpowers', path: path.join(home, 'plugins', 'sp') }],
  };
  const list = commandsFromInit(init, { home });
  assert.deepEqual(list.map((c) => c.name), [
    'goal', 'compact', 'context', // 常用的照 FIRST 的次序
    'zeta', // 其余内置
    'mail-helper', // 技能
    'superpowers:brainstorming', // 插件
  ]);
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(by.goal.desc, '定一个目标，达成之前 agent 不会停下');
  assert.equal(by['mail-helper'].group, 'skill');
  assert.equal(by['mail-helper'].desc, 'Send and read mail', '技能的说明读它自己的 SKILL.md');
  assert.equal(by['superpowers:brainstorming'].group, 'plugin');
  assert.equal(by['superpowers:brainstorming'].desc, 'Use before creative work');
  assert.equal(by.zeta.desc, null, '认不得的不编说明');
  fs.rmSync(home, { recursive: true, force: true });
});

test('claudeCommands：不带 probe 只看记录；带 probe 才探，探一次之后走记录', async () => {
  clearCommandCache();
  let runs = 0;
  const run = async () => { runs += 1; return { slash_commands: ['goal', 'compact'], skills: [] }; };
  const cold = await claudeCommands({ cwd: 'C:/proj', run });
  assert.deepEqual(cold, { commands: [], at: null, stale: true });
  assert.equal(runs, 0, '不带 probe 绝不起进程（路由表的可达性测试也靠这一条）');
  const warm = await claudeCommands({ cwd: 'C:/proj', run, probe: true });
  assert.deepEqual(warm.commands.map((c) => c.name), ['goal', 'compact']);
  await claudeCommands({ cwd: 'C:/proj', run, probe: true });
  assert.equal(runs, 1, '同一个目录缓存有效期内只探一次');
  if (process.platform === 'win32') {
    await claudeCommands({ cwd: 'c:\\PROJ', run, probe: true });
    assert.equal(runs, 1, '同一个目录（Windows 不分大小写与斜杠）只探一次');
  }
  clearCommandCache();
});

test('claudeCommands：同时来两个请求只起一个探针', async () => {
  clearCommandCache();
  let runs = 0;
  let release;
  const run = () => { runs += 1; return new Promise((r) => { release = r; }); };
  const a = claudeCommands({ cwd: 'C:/p2', run, probe: true });
  const b = claudeCommands({ cwd: 'C:/p2', run, probe: true });
  release({ slash_commands: ['goal'] });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(runs, 1);
  assert.deepEqual(ra.commands.map((c) => c.name), ['goal']);
  assert.deepEqual(rb.commands.map((c) => c.name), ['goal']);
  clearCommandCache();
});

test('rememberInit：真跑的那一轮经过的 init 记下来，菜单直接用', async () => {
  clearCommandCache();
  rememberInit('C:/p3', { slash_commands: ['context'] }, { now: 1000 });
  const r = await claudeCommands({ cwd: 'C:/p3', now: 2000, run: async () => { throw new Error('不该探'); } });
  assert.deepEqual(r.commands.map((c) => c.name), ['context']);
  assert.equal(r.stale, false);
  clearCommandCache();
});

test('listCommands：会话不存在回 404', async () => {
  const missing = await listCommands({ repo: { getSession: () => null }, key: 'x', query: new URLSearchParams() });
  assert.equal(missing.status, 404);
});

/*
  Codex 会话的表来自 app-server 的 skills/list。
  插进去的是 `$名字`：codex exec 收到文字里的 `$mail-helper` / `$pdf:pdf` 会注入整份 SKILL.md，`/mail-helper` 不会。
*/
test('codexSkillsFrom：同名只留第一个启用着的，插件技能（带冒号）单独一组，都能写在句中', () => {
  const list = codexSkillsFrom([
    { name: 'mail-helper', enabled: true, description: 'Use when…', interface: { shortDescription: 'Send and read mail' } },
    { name: 'mail-helper', enabled: true, description: '另一份' },
    { name: 'pdf:pdf', enabled: true, description: 'Read, create PDF' },
    { name: 'off', enabled: false, description: '关着的' },
    { name: 'astropy', enabled: true, description: 'Astronomy' },
  ]);
  assert.deepEqual(list.map((c) => [c.name, c.group, c.inline]), [
    ['astropy', 'skill', true], ['mail-helper', 'skill', true], ['pdf:pdf', 'plugin', true],
  ]);
  assert.equal(list[1].desc, 'Send and read mail', '有短说明就用短的');
});

test('codexCommands：不带 probe 不起 app-server；带了才问', async () => {
  clearCommandCache();
  let runs = 0;
  const run = async () => { runs += 1; return [{ name: 'pdf:pdf', enabled: true, description: 'PDF' }]; };
  assert.deepEqual((await codexCommands({ cwd: 'C:/c1', run })).commands, []);
  assert.equal(runs, 0);
  const r = await codexCommands({ cwd: 'C:/c1', run, probe: true });
  assert.deepEqual(r.commands.map((c) => c.name), ['pdf:pdf']);
  clearCommandCache();
});

test('listCommands：Codex 会话走 Codex 的表，记号是 $；Claude 是 /', async () => {
  const codexRepo = { getSession: () => ({ agent: 'codex', cwd: 'C:/x' }) };
  const r = await listCommands({
    repo: codexRepo, key: 'codex:k', query: new URLSearchParams('probe=1'),
    commands: async () => { throw new Error('Codex 会话不该问 claude'); },
    codex: async ({ probe }) => ({ commands: [{ name: 'pdf:pdf' }], at: 1, stale: !probe }),
  });
  assert.equal(r.body.mention, '$');
  assert.deepEqual(r.body.commands, [{ name: 'pdf:pdf' }]);
  const c = await listCommands({
    repo: { getSession: () => ({ agent: 'claude', cwd: 'C:/x' }) }, key: 'claude:k', query: new URLSearchParams(),
    commands: async () => ({ commands: [], at: null, stale: true }),
  });
  assert.equal(c.body.mention, '/');
});

test('commandsFromInit：内置命令不能写在句中，技能能', () => {
  const list = commandsFromInit({ slash_commands: ['compact', 'mail-helper'], skills: ['mail-helper'] }, { home: os.tmpdir() });
  assert.deepEqual(Object.fromEntries(list.map((c) => [c.name, c.inline])), { compact: false, 'mail-helper': true });
});

test('keyOf 复用 normPath 按当前平台语义折叠路径', () => {
  const sample = path.join(os.tmpdir(), 'MixedCase', 'Repo');
  assert.equal(keyOf(sample), normPath(sample));
});

test('listCodexSkills 按平台传 detached 并调用 killTreeFn 回收进程树', async () => {
  let seenOpts = null;
  let killedPid = null;
  const spawnFn = (_cmd, _args, opts) => {
    seenOpts = opts;
    const child = new EventEmitter();
    child.pid = 31337;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    let buf = '';
    child.stdin.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
        } else if (msg.id === 2) {
          child.stdout.write(`${JSON.stringify({ id: 2, result: { data: [{ skills: [{ name: 'demo', enabled: true }] }] } })}\n`);
        }
      }
    });
    return child;
  };

  const skills = await listCodexSkills('C:\\proj', {
    spawnFn,
    killTreeFn: (pid) => { killedPid = pid; },
  });
  assert.deepEqual(skills, [{ name: 'demo', enabled: true }]);
  assert.equal(killedPid, 31337);
  assert.equal(Boolean(seenOpts.detached), process.platform !== 'win32');
});
