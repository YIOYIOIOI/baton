import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BATON_DIR } from '../config.js';

// 运行中发消息 = 排队，不是再起一轮。
//
// 这反转了 v1 §10「不检测占用」的成文决定，依据是两条与写原子性无关的确定后果：
//
//   1. 第二个 `--resume` 读到的上下文里**没有第一轮尚未写完的消息**，两轮基于分叉的
//      上下文各自作答。这是语义损坏——就算每次写入都是原子的，它依然成立。
//   2. sessionState 取 listTurns().at(-1)，第二轮会盖住第一轮，运行轴当场说谎。
//
// 实测过 `--input-format stream-json`：帧格式能用，但一个进程内连发两帧的输出顺序是
// assistant(第一轮) → result → system/init → assistant(第二轮)，**第一轮先跑完第二轮才开始**。
// 所以它相对落盘队列没有任何打断优势，反而要放弃「一轮一进程」这个已验证的架构。
// 结论：不改架构，用队列。
//
// 落盘而非内存：手机断连是常态不是异常，守护进程也会重启。排进去的话不能因为
// 谁挂了就人间蒸发——那比不让排队更糟，因为用户以为已经说出去了。
//
// 2026-10-09：**「在跑」现在也包括电脑上起的那一轮**。上面两条后果和「谁起的那一轮」
// 无关，而 Baton 原来只认自己起的轮次——桌面 App 或终端里正跑着的那一条，手机上
// 一发就是第二个进程压上去。认法见 runtime/live.js。
//
// **但只认 busy，不认 waiting**（电脑上开着个框）。那个框要人在电脑前点才会消失，
// 而人不在电脑前正是 Baton 存在的理由——挡它等于「离开电脑就再也发不出消息」。
// owner 当场否掉过这个行为，依据与五种 waiting 的来源见 agent-protocol §11.4。
//
// 代价是**排空的触发者多了一个**：Baton 自己那轮结束时会顺手排空，而电脑上那轮
// 结束时没人通知 Baton，所以 cli.js 里挂了一个定时看门狗（handlers/turns.js 的
// watchQueues）。没有它，这种排队要等到下次重启才发得出去。

const MAX_QUEUE_ITEMS = 50;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

export class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
  }
}

const queueDir = (dir) => path.join(dir, 'queue');
const queueFile = (dir, key) => path.join(queueDir(dir), `${encodeURIComponent(key)}.jsonl`);

function writeAll(dir, key, items) {
  const file = queueFile(dir, key);
  if (items.length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 本来就没有
    }
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

/**
 * `front: true` = 插队：放到最前面，这一轮停下后第一个发（2026-11-14，见 handlers/turns.js 的 when:'interrupt'）。
 */
export function enqueue(
  { key, text, fork = false, principalId = 'owner', front = false },
  { dir = BATON_DIR, now = Date.now(), maxItems = MAX_QUEUE_ITEMS, maxBytes = MAX_QUEUE_BYTES } = {},
) {
  const existing = listQueue(key, { dir });
  if (existing.length >= maxItems) {
    throw new QueueFullError(`排队消息数量已达上限（${maxItems} 条）。`);
  }
  const item = {
    id: crypto.randomUUID(), key, text, fork, principalId, queuedAt: now,
  };
  const line = `${JSON.stringify(item)}\n`;
  let existingBytes = 0;
  try {
    existingBytes = fs.statSync(queueFile(dir, key)).size;
  } catch {
    existingBytes = 0;
  }
  if (existingBytes + Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw new QueueFullError('排队消息总字节数已达上限，请等待当前消息发出或撤回部分排队消息。');
  }
  fs.mkdirSync(queueDir(dir), { recursive: true });
  if (front) writeAll(dir, key, [item, ...existing]);
  else fs.appendFileSync(queueFile(dir, key), line);
  return item;
}

export function listQueue(key, { dir = BATON_DIR } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(queueFile(dir, key), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      // 旧版写下的队列项没有 principalId。视为 owner——在此之前本机只有 owner 一个身份。
      out.push({ ...item, principalId: item.principalId ?? 'owner' });
    } catch {
      // 坏行跳过：宁可少发一条，也不要因为一行坏数据卡住整条队列
    }
  }
  return out;
}

// 取走队首。取走即消失——若随后发送失败，由调用方决定是丢弃还是回退，
// 不在这里重试，否则一条必然失败的消息会把队列永远堵死。
export function takeNext(key, { dir = BATON_DIR } = {}) {
  const items = listQueue(key, { dir });
  if (items.length === 0) return null;
  const [head, ...rest] = items;
  writeAll(dir, key, rest);
  return head;
}

/**
 * 按 id 拿掉排着的某一条——撤回。
 *
 * owner 2026-10-09：「排队的消息现在还不能撤回」。排队本来就是「等一会儿再发」，
 * 而人改主意是常事：打错了、想重说、或者干脆不想发了。没有撤回，这条消息就成了
 * 一列开出去就停不下来的车。
 *
 * **不改其余的顺序**，也不碰已经取走的那条（取走即消失，见 takeNext）。
 * 找不到就返回 null，由调用方决定怎么说——多半是「它已经发出去了」。
 *
 * @returns {{ id: string, text: string } | null}
 */
export function removeQueued(key, id, { dir = BATON_DIR } = {}) {
  const items = listQueue(key, { dir });
  const hit = items.find((i) => i.id === id);
  if (!hit) return null;
  writeAll(dir, key, items.filter((i) => i.id !== id));
  return { id: hit.id, text: hit.text };
}

export function dropQueue(key, { dir = BATON_DIR } = {}) {
  const n = listQueue(key, { dir }).length;
  writeAll(dir, key, []);
  return n;
}

// 有队列的所有会话。守护进程启动时要遍历它们收尾。
export function queuedKeys({ dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(queueDir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names.map((n) => decodeURIComponent(n.replace(/\.jsonl$/, '')));
}
