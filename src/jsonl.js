import fs from 'node:fs';

const CHUNK = 1 << 20; // 流式扫描的固定缓冲，保证 O(1) 内存

function readBytes(file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function readHead(file, maxBytes = 65536) {
  const size = fs.statSync(file).size;
  const want = Math.min(maxBytes, size);
  const text = readBytes(file, 0, want).toString('utf8');
  const truncated = size > want;
  const parts = text.split('\n');
  // 末段要么是被截断的行，要么是结尾空串，两种情况都该丢
  parts.pop();
  return { lines: parts.filter((l) => l.trim()), truncated };
}

export function readTail(file, maxBytes = 65536) {
  const size = fs.statSync(file).size;
  const want = Math.min(maxBytes, size);
  const start = size - want;
  const text = readBytes(file, start, want).toString('utf8');
  if (start === 0) {
    return { lines: text.split('\n').filter((l) => l.trim()), startOffset: 0 };
  }
  const nl = text.indexOf('\n');
  if (nl < 0) return { lines: [], startOffset: size };
  const kept = text.slice(nl + 1);
  return {
    lines: kept.split('\n').filter((l) => l.trim()),
    startOffset: start + Buffer.byteLength(text.slice(0, nl + 1), 'utf8'),
  };
}

export function readRange(file, start, end) {
  const size = fs.statSync(file).size;
  const from = Math.max(0, start);
  const text = readBytes(file, from, Math.max(0, Math.min(end, size) - from)).toString('utf8');
  let body = text;
  let firstLineOffset = from;
  if (from > 0) {
    const nl = text.indexOf('\n');
    if (nl < 0) return { lines: [], firstLineOffset: from };
    body = text.slice(nl + 1);
    firstLineOffset = from + Buffer.byteLength(text.slice(0, nl + 1), 'utf8');
  }
  const parts = body.split('\n');
  if (Math.min(end, size) < size) parts.pop(); // 右端可能被截断
  return { lines: parts.filter((l) => l.trim()), firstLineOffset };
}

export function scanForward(file, predicate, capBytes = 4 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  const limit = Math.min(size, capBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let off = 0;
    let carry = '';
    while (off < limit) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, limit - off), off);
      if (n <= 0) break;
      const chunk = carry + buf.subarray(0, n).toString('utf8');
      const parts = chunk.split('\n');
      carry = parts.pop();
      for (const line of parts) {
        if (line.trim() && predicate(line)) return line;
      }
      off += n;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// 与 readRange 的区别：为每一行带上它在文件里的起始字节偏移，
// 分页游标要靠它才能精确（行号需要整读文件才能确定）。
//
// trimPartialFirstLine：向后分页时 start 是任意位置，左边缘可能切断一行，必须丢掉首行。
// 但 tail-follow 的 start 是上次推送结束的精确行边界，丢首行会把新追加的内容吃掉——
// 那种调用方须显式传 false。
export function readRangeWithOffsets(file, start, end, { trimPartialFirstLine = true } = {}) {
  const size = fs.statSync(file).size;
  const from = Math.max(0, start);
  const to = Math.min(end, size);
  const buf = readBytes(file, from, Math.max(0, to - from));
  const hitStart = from === 0;
  let pos = 0;
  if (!hitStart && trimPartialFirstLine) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { entries: [], hitStart };
    pos = nl + 1;
  }
  const entries = [];
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) {
      // Right edge cut before EOF: drop incomplete trailing fragment just like split/pop did.
      if (to === size) {
        const line = buf.subarray(pos).toString('utf8');
        if (line.trim()) entries.push({ line, offset: from + pos });
      }
      break;
    }
    const line = buf.subarray(pos, nl).toString('utf8');
    if (line.trim()) entries.push({ line, offset: from + pos });
    pos = nl + 1;
  }
  return { entries, hitStart };
}

export function parseLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // 半行或坏行，跳过
    }
  }
  return out;
}
