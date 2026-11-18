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
function findNewlineFrom(file, fromPos, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const step = 64 * 1024;
    const buf = Buffer.alloc(step);
    let pos = fromPos;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(step, size - pos), pos);
      if (n <= 0) break;
      const idx = buf.subarray(0, n).indexOf(0x0a);
      if (idx >= 0) return pos + idx;
      pos += n;
    }
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

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
      return;
    }
    if (size === offset) return;

    try {
      for (let pass = 0; pass < 8 && offset < size; pass += 1) {
        let chunkEnd = Math.min(size, offset + maxChunkBytes);
        let { entries } = readRangeWithOffsets(member.file, offset, chunkEnd, {
          trimPartialFirstLine: align,
        });
        // If a single appended JSONL line exceeds maxChunkBytes, expand up to maxSingleLineBytes
        // so tailing does not stall on a large line.
        while (!entries.length && chunkEnd < size && chunkEnd - offset < maxSingleLineBytes) {
          const nextEnd = Math.min(size, offset + Math.min(maxSingleLineBytes, (chunkEnd - offset) * 2));
          if (nextEnd === chunkEnd) break;
          chunkEnd = nextEnd;
          ({ entries } = readRangeWithOffsets(member.file, offset, chunkEnd, {
            trimPartialFirstLine: align,
          }));
        }
        if (!entries.length) {
          if (align) {
            offset = chunkEnd;
            align = false;
            return;
          }
          if (chunkEnd - offset >= maxSingleLineBytes) {
            const nlAt = findNewlineFrom(member.file, chunkEnd, size);
            if (nlAt >= 0) {
              offset = nlAt + 1;
              align = false;
              continue; // Immediately read valid trailing events after the oversized line.
            }
            offset = size;
            align = true; // Trim remainder of oversized partial line on subsequent poll.
          }
          return;
        }
        align = false; // 只作用于第一次读

        const last = entries.at(-1);
        const lastEnd = last.offset + Buffer.byteLength(last.line, 'utf8') + 1;
        if (lastEnd > size) return; // 末行还没写完换行，等下一轮

        const events = [];
        for (const e of entries) {
          events.push(...eventsFor(member, parseLines([e.line]), { offset: e.offset }));
        }
        offset = lastEnd;
        if (events.length) onEvents(events);
        return;
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
