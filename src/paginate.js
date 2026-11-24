import fs from 'node:fs';
import { readRangeWithOffsets, parseLines, previousLineEnd } from './jsonl.js';
import { eventsFor } from './wire.js';

const FIRST_WINDOW = 256 * 1024;
const MAX_WINDOW = 8 * 1024 * 1024;

export async function pageEvents(member, { before = null, limit = 50 } = {}) {
  const size = fs.statSync(member.file).size;
  const end = before === null ? size : Math.min(before, size);

  let win = FIRST_WINDOW;
  for (;;) {
    const start = Math.max(0, end - win);
    const { entries, hitStart, endOffset } = readRangeWithOffsets(member.file, start, end, { completeOnly: true });

    // 逐行归一化，保留每个事件对应的行偏移，游标才能精确。
    // 归一化函数对单行数组是纯函数：Claude 的 tool_call 与 tool_result 分属不同记录行，
    // Codex 的每条 payload 亦自成一行，不存在跨行状态。
    const withOffsets = [];
    for (const e of entries) {
      const records = parseLines([e.line]);
      for (const ev of eventsFor(member, records, { offset: e.offset })) {
        withOffsets.push({ ev, offset: e.offset });
      }
    }

    const enough = withOffsets.length >= limit;
    if (enough || hitStart || win >= MAX_WINDOW) {
      let from = Math.max(0, withOffsets.length - limit);
      // 一行可能拆出好几条事件（一次回复先说一句再并排调几个工具、几个工具结果一起回来）。
      // 页界切在一行中间时往前补齐这一行：游标是**行首**偏移，下一页只读它之前的行，
      // 切开的前半截哪一页都不会给——往上翻历史时悄悄少几条（2026-11-07）。宁可这一页多几条
      while (from > 0 && withOffsets[from - 1].offset === withOffsets[from].offset) from -= 1;
      const slice = withOffsets.slice(from);
      // 读到了文件头、而且这一页从第一条就开始了：前面没有了。原来只看「够不够一页」，
      // 恰好剩一整页时还给一个游标，客户端会多翻一次、拿回一页空的
      const nextBefore = hitStart && from === 0 ? null : (slice[0]?.offset ?? start);
      return {
        events: slice.map((x) => x.ev), nextBefore,
        endOffset: endOffset ?? (hitStart ? 0 : await previousLineEnd(member.file, start)),
      };
    }
    win = Math.min(win * 2, MAX_WINDOW);
  }
}
