// 把一条消息交给**正开着这个会话的 Codex App** 去跑：放进 codex 自己的会话队列。
//
// ## 为什么要它（2026-11-09）
//
// codex 0.164 给每个会话一把写入锁（agent-protocol §14）。Codex App 开着某个会话时锁一直在它手里——
// 不只是跑一轮的时候：App 会把打开过的会话一直加载着，离开很久之后才 teardown（logs_2.sqlite 里
// `clearing thread listener during thread-state teardown`）。于是 Baton 起的 `codex exec resume`
// 拿不到锁，当场退出。owner：「baton 的意义就是立马能接手，而不是还要我去手动关闭，我人都不在电脑
// 面前怎么手动关闭？」
//
// ## 为什么是队列（实测，agent-protocol §15）
//
// - App 的 app-server 跑在 stdio 上，没开控制 socket（`codex app-server proxy` 连不上它），
//   Baton 没法直接让它开一轮
// - 但 codex 有一个**落盘的、跨进程的**会话队列（~/.codex/queue_1.sqlite，按会话记 revision）。
//   自己起一个 `codex app-server`、对那个会话 `thread/queue/add` 一条：8 秒后 App 的 app-server
//   发出 `thread/queue/changed`，App 界面随即 `thread/queue/list`——它看见了这条
// - 队列里的消息由占着锁的那一方（App）在它这一轮结束后接着跑；回复写进同一个 rollout，
//   Baton 本来就在读它，于是照常出现在手机上
//
// 队列方法是 experimental 的：initialize 时要带 `capabilities.experimentalApi: true`。
// 参数形状来自 `codex app-server generate-json-schema --experimental`（ThreadQueueAddParams）。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killChildTree } from './spawn.js';
import { VERSION } from '../version.js';

/**
 * 往一个会话的 codex 队列里放一条文本消息。成功回 `{ id }`（队列项 id，撤回时用）。
 *
 * 和 agent/spawn.js 同一套启动方式（Windows 上 codex 是 .cmd，必须经 shell；POSIX 设
 * detached 并复用 killChildTree 以避免遗留 app-server 孤儿进程）。
 */
export function queueToCodexApp({
  threadId, text, command = 'codex', timeoutMs = 30_000, spawnFn = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, ['app-server'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    let buf = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // 已经关了
      }
      killChildTree(child);
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('codex 没在时限内回话')), timeoutMs);
    timer.unref?.();
    child.stdin?.on?.('error', (e) => finish(reject, e));
    const send = (o) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    child.on('error', (e) => finish(reject, e));
    child.on('exit', (code) => finish(reject, new Error(`codex app-server 提前退出了（${code}）`)));
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) {
        finish(reject, new Error('codex app-server 输出超过上限'));
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return finish(reject, new Error(m.error.message ?? 'initialize 出错'));
          send({ method: 'initialized' });
          send({
            id: 2,
            method: 'thread/queue/add',
            params: { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text, text_elements: [] }] },
          });
        } else if (m.id === 2) {
          if (m.error) return finish(reject, new Error(m.error.message ?? 'thread/queue/add 出错'));
          const id = m.result?.queuedSubmission?.id;
          return id ? finish(resolve, { id }) : finish(reject, new Error('codex 没回队列项 id'));
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'baton', title: 'Baton', version: VERSION }, capabilities: { experimentalApi: true } },
    });
  });
}

/** 这一轮交给 App 之后，告诉人发生了什么。手机横幅与网页提示条都显示它 */
export const HANDOFF_NOTE = '这个会话正在 Codex App 里开着（App 占着它的写入锁），'
  + '所以这条消息交给了 App：已经排进它的队列，App 当前这一轮跑完就会接着处理，回复会照常出现在这里。';
