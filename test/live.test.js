import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { liveStates, pidAlive } from '../src/runtime/live.js';
import { tmpDir } from './helpers.js';

/*
  电脑上在跑的会话，手机上要看得见。owner 2026-10-08：「我刚刚下班，打开手机，
  就看不到哪些会话是还在工作的」——Baton 原来只认自己起的那一轮。

  信号是 CLI 自己的 `~/.claude/sessions/<pid>.json`，每个活着的进程一个文件
  （实测见 docs/ops/agent-protocol.md §11）。这里只做一件事：把那个目录读成
  「会话 id → 在跑 / 等你」。
*/

/** 造一个进程文件。pid 用来对 alive 开关，不必真实存在。 */
function proc(dir, pid, over = {}) {
  const o = {
    pid,
    sessionId: `11111111-0000-4000-8000-${String(pid).padStart(12, '0')}`,
    cwd: 'C:\\proj',
    status: 'busy',
    statusUpdatedAt: 1791455481577,
    entrypoint: 'claude-desktop-3p',
    ...over,
  };
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(o));
  return o;
}

const ALL_ALIVE = () => true;

test('busy / waiting 读出来，idle 不出现', () => {
  const dir = tmpDir();
  const a = proc(dir, 101, { status: 'busy' });
  const b = proc(dir, 102, { status: 'waiting', waitingFor: 'input needed' });
  const c = proc(dir, 103, { status: 'idle' });
  const m = liveStates({ dir, alive: ALL_ALIVE });
  assert.equal(m.get(a.sessionId), 'busy');
  assert.equal(m.get(b.sessionId), 'waiting');
  assert.equal(m.has(c.sessionId), false, 'idle 就是闲着，不该出现在这张表里');
});

test('进程已经没了的文件一律不算——崩溃退出会把文件留在盘上', () => {
  const dir = tmpDir();
  const live = proc(dir, 201);
  const dead = proc(dir, 202);
  const m = liveStates({ dir, alive: (pid) => pid === 201 });
  assert.equal(m.get(live.sessionId), 'busy');
  assert.equal(m.has(dead.sessionId), false);
});

test('一个会话好几个进程：busy 压过 waiting，waiting 压过没有', () => {
  // 实测就是这样：宿主那个 CLI 报 idle，真正干活的子进程报 busy，
  // 两个文件的 sessionId 是同一个。照「最后读到的那个」写就会把 busy 盖掉。
  const dir = tmpDir();
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  proc(dir, 301, { sessionId: id, status: 'idle' });
  proc(dir, 302, { sessionId: id, status: 'waiting' });
  assert.equal(liveStates({ dir, alive: ALL_ALIVE }).get(id), 'waiting');
  proc(dir, 303, { sessionId: id, status: 'busy' });
  assert.equal(liveStates({ dir, alive: ALL_ALIVE }).get(id), 'busy');
});

test('hostSessionId 也认：压缩换过 id 之后，列表上那条用的是注册项那个 id', () => {
  // 实测：某个会话的文件里 sessionId=33351f35（当前这段），
  // hostSessionId=local_99726bc5（注册项，也就是 Baton 列表上那条的身份）。
  const dir = tmpDir();
  proc(dir, 401, {
    sessionId: '33351f35-1320-42dd-be15-3b8e27a75f51',
    hostSessionId: 'local_99726bc5-67bc-476b-a189-cf67a26891b3',
    status: 'busy',
  });
  const m = liveStates({ dir, alive: ALL_ALIVE });
  assert.equal(m.get('33351f35-1320-42dd-be15-3b8e27a75f51'), 'busy');
  assert.equal(m.get('99726bc5-67bc-476b-a189-cf67a26891b3'), 'busy', 'local_ 前缀要剥掉');
});

test('目录不在、文件是半截的、字段缺斤少两——都不抛，跳过就是', () => {
  assert.equal(liveStates({ dir: path.join(tmpDir(), 'nope'), alive: ALL_ALIVE }).size, 0);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '501.json'), '{"pid":501,"sessio');
  fs.writeFileSync(path.join(dir, '502.json'), JSON.stringify({ pid: 502, status: 'busy' }));
  fs.writeFileSync(path.join(dir, '503.key'), 'x'.repeat(64));
  fs.writeFileSync(path.join(dir, '504.json'), JSON.stringify({ sessionId: 'x', status: 'busy' }));
  const ok = proc(dir, 505);
  const m = liveStates({ dir, alive: ALL_ALIVE });
  assert.deepEqual([...m.keys()], [ok.sessionId]);
});

test('pidAlive：当前进程算活着，离谱的 pid 不算', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(2 ** 30), false, '这个 pid 不可能存在');
});
