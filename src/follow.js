import fs from 'node:fs';
import { readRangeWithOffsets, parseLines } from './jsonl.js';
import { eventsFor } from './wire.js';

const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_LINE_BYTES = 32 * 1024 * 1024;

/**
 * @param alignFirstRead 第一次读时丢掉半行。
 *
 * **只在起点是我们自己夹出来的时候传 true。** 客户端给的续传偏移是精确行边界
 * （我们随每帧发出去的 `id` 就是上一帧结束的位置），对它裁首行会把一条真事件
 * 吃掉；而空洞太大被夹到上限时，起点落在哪儿全凭字节数，多半在行中间。
 * 对齐只作用于第一次读——之后 offset 又回到精确边界了。
 */
export function createFollower(
  member,
  onEvents,
  {
    intervalMs = 500,
    fromOffset = null,
    alignFirstRead = false,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxSingleLineBytes = MAX_SINGLE_LINE_BYTES,
  } = {},
) {
  let timer = null;
  let align = alignFirstRead;
  let pendingSize = null;

  function safeSize() {
    try {
      return fs.statSync(member.file).size;
    } catch {
      return 0;
    }
  }

  // 默认从当前末尾开始：历史走分页，这里只推新内容
  let offset = fromOffset ?? safeSize();

  function tick() {
    let size;
    try {
      size = fs.statSync(member.file).size;
    } catch {
      return; // File temporarily missing or unreadable; wait for next poll cycle.
    }
    if (size < offset) {
      offset = size; // 被截断或替换：重新锚定，不尝试解释旧偏移
      pendingSize = null;
      align = false;
      return;
    }
    if (size === offset || size === pendingSize) return;
    pendingSize = null;

    try {
      for (let pass = 0; pass < 8 && offset < size; pass += 1) {
        let chunkEnd = Math.min(size, offset + maxChunkBytes);
        const options = { trimPartialFirstLine: align, completeOnly: true };
        let batch = readRangeWithOffsets(member.file, offset, chunkEnd, options);
        while (batch.endOffset === null && !align && chunkEnd < size && chunkEnd - offset < maxSingleLineBytes) {
          const nextEnd = Math.min(size, offset + Math.min(maxSingleLineBytes, (chunkEnd - offset) * 2));
          if (nextEnd === chunkEnd) break;
          chunkEnd = nextEnd;
          batch = readRangeWithOffsets(member.file, offset, chunkEnd, options);
        }
        if (batch.endOffset === null) {
          if (align || chunkEnd - offset >= maxSingleLineBytes) {
            // Discard this oversized record in bounded chunks, even across polls.
            offset = chunkEnd;
            align = true;
            continue;
          }
          pendingSize = size;
          return;
        }
        align = false;
        offset = batch.endOffset;
        const events = [];
        for (const e of batch.entries) {
          events.push(...eventsFor(member, parseLines([e.line]), { offset: e.offset }));
        }
        if (events.length) {
          onEvents(events);
          return;
        }
      }
    } catch {
      // Non-fatal transient I/O or parse failure during live file rotation.
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    get offset() {
      return offset;
    },
  };
}
