import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BATON_DIR } from '../config.js';
import { endTurn, listTurns } from './turns.js';

// 控制指令作用于持久目标，不是内存句柄（spec §12 原则 5）。
// 「停止」= 写一条落盘的意图，执行侧消费并回写——守护进程重启也不会丢。

const intentsDir = (dir) => path.join(dir, 'intents');

export function writeIntent({ key, type, turnId }, { dir = BATON_DIR, now = Date.now() } = {}) {
  const d = intentsDir(dir);
  fs.mkdirSync(d, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(d, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, key, type, turnId, createdAt: now }));
  return file;
}

export function pendingIntents({ dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(intentsDir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(intentsDir(dir), n), 'utf8')));
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function consumeIntent(intent, { dir = BATON_DIR } = {}) {
  try {
    fs.unlinkSync(path.join(intentsDir(dir), `${intent.id}.json`));
  } catch {
    // 已被清掉
  }
}

// 守护进程启动时调用：停止意图指向的进程若已不在，该轮就判 aborted，
// 否则它会以 running 状态永远挂着——那正是「永远 Thinking」的另一种成因。
/** @param {{ dir?: string, isAlive: (turnId: string, turn?: any) => boolean, now?: number }} opts */
export function reconcileOrphans({ dir = BATON_DIR, isAlive, now = Date.now() }) {
  const fixed = [];
  for (const intent of pendingIntents({ dir })) {
    if (intent.type !== 'stop') continue;
    let turn;
    try { turn = listTurns(intent.key, { dir }).find((t) => t.turnId === intent.turnId); } catch { continue; }
    if (isAlive(intent.turnId, turn)) continue;
    if (turn && turn.status === 'running') {
      fixed.push(endTurn({
        key: intent.key,
        turnId: intent.turnId,
        status: 'aborted',
        error: '本轮被用户请求停止，且执行进程已不存在（守护进程重启或进程已退出）。',
        tokens: turn.tokens,
        eventCount: turn.eventCount,
      }, { dir, now }));
    }
    consumeIntent(intent, { dir });
  }
  return fixed;
}
