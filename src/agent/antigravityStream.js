import fs from 'node:fs';
import { setImmediate as yieldIO } from 'node:timers/promises';

const CHUNK = 64 * 1024;
const BATCH = 1024 * 1024;
const CHECKPOINT = 64;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Each side of ACP has its own request IDs. Only a response can settle our pending call. */
export function acpResponse(line, send, onUpdate = null) {
  let msg;
  try { msg = JSON.parse(line); } catch { return null; }
  if (msg?.jsonrpc !== '2.0') return null;
  if (Object.hasOwn(msg, 'method')) {
    if (typeof msg.method !== 'string') return null;
    if (Object.hasOwn(msg, 'id')) {
      const reply = msg.method === 'session/request_permission'
        ? { result: { outcome: { outcome: 'cancelled' } } }
        : { error: { code: -32601, message: 'Method not found' } };
      send({ jsonrpc: '2.0', id: msg.id, ...reply });
    } else if (msg.method === 'session/update') {
      onUpdate?.(msg.params?.update);
    }
    return null;
  }
  return msg.id != null && Object.hasOwn(msg, 'result') !== Object.hasOwn(msg, 'error') ? msg : null;
}

/** Frame bytes before decoding: a multibyte character or a newline may land in the next read. */
export class ByteLines {
  constructor(limit = MAX_LINE_BYTES) {
    this.limit = limit;
    this.reset();
  }

  reset() {
    this.buffer = Buffer.alloc(0);
    this.size = 0;
    this.skipping = false;
  }

  push(bytes, onLine, onOverflow = () => {}) {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const length = this.size + end - start;
      if (!this.skipping && length > this.limit) {
        this.reset();
        this.skipping = true;
        onOverflow();
      }
      if (!this.skipping) {
        if (length > this.buffer.length) {
          const grown = Buffer.allocUnsafe(Math.min(this.limit, Math.max(length, 256, this.buffer.length * 2)));
          this.buffer.copy(grown, 0, 0, this.size);
          this.buffer = grown;
        }
        bytes.copy(this.buffer, this.size, start, end);
        this.size = length;
        if (newline >= 0) onLine(this.text());
      }
      if (newline < 0) return;
      if (this.skipping) onLine('');
      this.size = 0;
      this.skipping = false;
      if (this.buffer.length > CHUNK) this.buffer = Buffer.alloc(0);
      start = newline + 1;
    }
  }

  text() {
    return this.buffer.toString('utf8', 0, this.size);
  }

  mayBeComplete() {
    let i = this.size - 1;
    while (i >= 0 && this.buffer[i] <= 32) i--;
    return this.buffer[i] === 125;
  }
}

function recordFrom(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readAt(fd, start, length) {
  const bytes = Buffer.allocUnsafe(length);
  const count = fs.readSync(fd, bytes, 0, length, start);
  return bytes.subarray(0, count);
}

// Read the last usable baseline row backwards. A long row is discarded through
// its delimiter without ever materializing the line or reloading the entire file.
async function baseline(fd, size, framer) {
  let end = size;
  let parts = [];
  let bytes = 0;
  let atEof = true;
  while (end > 0) {
    const start = Math.max(0, end - CHUNK);
    const chunk = readAt(fd, start, end - start);
    let right = chunk.length;
    for (;;) {
      const newline = right ? chunk.lastIndexOf(10, right - 1) : -1;
      const part = chunk.subarray(newline + 1, right);
      bytes += part.length;
      if (bytes <= framer.limit && part.length) parts.push(part);
      else if (bytes > framer.limit) parts = [];
      if (newline < 0 && start > 0) break;
      if (atEof && bytes > 0) {
        if (bytes <= framer.limit) framer.push(Buffer.concat(parts.reverse(), bytes), () => {});
        else framer.skipping = true;
      } else if (!atEof && bytes && bytes <= framer.limit) {
        const record = recordFrom(Buffer.concat(parts.reverse(), bytes).toString('utf8'));
        if (record) return record;
      }
      parts = [];
      bytes = 0;
      atEof = false;
      if (newline < 0) break;
      right = newline;
    }
    end = start;
    if (end && (size - end) % BATCH === 0) await yieldIO();
  }
  return null;
}

function openTranscript(file) {
  if (!file) return null;
  try { return fs.openSync(file, 'r'); } catch { return null; }
}

/** A poll consumes one bounded batch. Rows copied by a rotation keep their conversation step IDs. */
export class TranscriptCursor {
  constructor({ maxLineBytes = MAX_LINE_BYTES, batchBytes = BATCH } = {}) {
    this.framer = new ByteLines(maxLineBytes);
    this.batch = batchBytes;
    this.offset = 0;
    this.identity = null;
    this.modified = 0;
    this.checkpoint = Buffer.alloc(0);
    this.highest = -1;
    this.ordinal = 0;
    this.skipPartial = false;
  }

  async skipExisting(file) {
    const fd = openTranscript(file);
    if (fd === null) return;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return;
      this.identity = stat.dev + '/' + stat.ino;
      this.offset = stat.size;
      this.modified = stat.mtimeMs;
      this.checkpoint = readAt(fd, Math.max(0, stat.size - CHECKPOINT), Math.min(stat.size, CHECKPOINT));
      const last = await baseline(fd, stat.size, this.framer);
      this.skipPartial = this.framer.size > 0 || this.framer.skipping;
      if (last && Number.isInteger(last.step_index)) {
        this.highest = last.step_index;
        this.ordinal = this.highest + 1;
      } else if (last) {
        // Older exports without step IDs use the record ordinal. Count them once in bounded chunks.
        const rows = new ByteLines(this.framer.limit);
        for (let at = 0; at < stat.size;) {
          const chunk = readAt(fd, at, Math.min(CHUNK, stat.size - at));
          if (!chunk.length) break;
          rows.push(chunk, (line) => { if (recordFrom(line)) this.ordinal++; });
          at += chunk.length;
          if (at % BATCH === 0) await yieldIO();
        }
        this.highest = this.ordinal - 1;
      }
      const final = recordFrom(this.framer.text());
      if (final) this.highest = Math.max(this.highest, final.step_index ?? this.ordinal);
    } finally {
      fs.closeSync(fd);
    }
  }

  read(file, onRecord) {
    const fd = openTranscript(file);
    if (fd === null) return true;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return true;
      const identity = stat.dev + '/' + stat.ino;
      if (identity === this.identity && stat.size === this.offset && stat.mtimeMs === this.modified) return true;
      if (this.offset && (stat.size < this.offset
          || !this.checkpoint.equals(readAt(fd, this.offset - this.checkpoint.length, this.checkpoint.length)))) {
        this.offset = 0;
        this.ordinal = 0;
        this.skipPartial = false;
        this.checkpoint = Buffer.alloc(0);
        this.framer.reset();
      }
      this.identity = identity;
      this.modified = stat.mtimeMs;
      const end = Math.min(stat.size, this.offset + this.batch);
      const receive = (line) => {
        const record = recordFrom(line);
        if (record) {
          const step = Number.isInteger(record.step_index) ? record.step_index : this.ordinal;
          this.ordinal++;
          if (step > this.highest) {
            this.highest = step;
            if (!this.skipPartial) onRecord(record, line);
          }
        }
        this.skipPartial = false;
      };
      while (this.offset < end) {
        const chunk = readAt(fd, this.offset, Math.min(CHUNK, end - this.offset));
        if (!chunk.length) break;
        this.offset += chunk.length;
        const tail = chunk.subarray(Math.max(0, chunk.length - CHECKPOINT));
        this.checkpoint = Buffer.from(Buffer.concat([this.checkpoint, tail]).subarray(-CHECKPOINT));
        this.framer.push(chunk, receive);
      }
      // Hosts can close a file after a complete JSON object without writing a final LF.
      if (this.offset === stat.size && this.framer.mayBeComplete() && !this.skipPartial) {
        const line = this.framer.text();
        if (recordFrom(line)) {
          receive(line);
          this.ordinal--;
          this.skipPartial = true;
        }
      }
      return this.offset >= stat.size;
    } finally {
      fs.closeSync(fd);
    }
  }
}
