import type { StreamFrame } from './types';

/**
 * SSE 帧解析。
 *
 * RN 没有原生 `EventSource`，所以这一段必须自己写。做成**纯函数 + 显式状态**，
 * 不是因为好看，是因为它是整个客户端唯一一处"字节流拼装"逻辑——出错的方式
 * 又多又安静（半个帧、跨 chunk 的多字节字符、只有注释的心跳），只有能单测
 * 才可能验对。
 *
 * 三个必须处理的现实：
 *
 * 1. **一个 chunk 里可能有 0 个、半个、或好几个帧。** 网络不按帧边界切。
 * 2. **UTF-8 字符会跨 chunk 断开。** 中文一个字 3 字节，断在中间就变乱码——
 *    所以解码必须用 `TextDecoder` 的 `{ stream: true }`，不能每个 chunk 各自解码。
 * 3. **注释行（`: ping`）不是事件**，但它是防 Cloudflare 524 的关键，不能当垃圾丢掉
 *    ——要用它刷新"最后一次听到服务器"的时刻。
 */

export type ParseResult = {
  frames: StreamFrame[];
  /** 本批里有没有收到任何东西（含注释心跳）。用于判活，不判内容。 */
  heardFromServer: boolean;
  /** 没解析完的尾巴，下次调用要原样传回来 */
  rest: string;
  /**
   * 本批里最后一个 `id:` 的值。断线重连时要把它作为 `Last-Event-ID` 送回去，
   * 服务端据此从那儿开始重放断开期间的事件。没有就是 null。
   */
  lastId: string | null;
};

/**
 * 一帧可以带 `id:`，**而且它在 `event:` 前面**。
 *
 * 这一行是 2026-09-24 加的断点续传：服务端把「这一帧结束时的字节偏移」放进
 * `id`，浏览器原生 EventSource 会自动记住并在重连时回传。我们自己拼的这个
 * 解析器必须跟上——原来的正则是 `^event:` 开头，加了 id 行之后**一帧都匹配
 * 不上**，而 `if (!m) continue` 会把它们静默丢掉：界面看着在线、心跳也正常，
 * 就是永远不再出新消息。差一点就这么发出去了。
 */
const FRAME = /^(?:id: ([^\n]*)\n)?event: ([a-z_]+)\ndata: ([\s\S]*)$/;

export function parseChunk(buffered: string): ParseResult {
  const frames: StreamFrame[] = [];
  let heard = false;
  let lastId: string | null = null;
  let buf = buffered;

  for (;;) {
    const i = buf.indexOf('\n\n');
    if (i < 0) break;
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!raw) continue;
    heard = true;

    // 注释行：只用来判活，不产生事件
    if (raw.startsWith(':')) continue;

    const m = FRAME.exec(raw);
    if (!m) continue; // 认不出的帧直接跳过，绝不因此中断整条流

    // id 即使这一帧的 data 解析失败也要记下：它是「服务端推到哪儿了」，
    // 和这一帧的内容能不能用是两回事
    if (m[1]) lastId = m[1];

    try {
      frames.push({ type: m[2], data: JSON.parse(m[3]) } as StreamFrame);
    } catch {
      // data 不是合法 JSON——跳过这一帧，流继续。
      // 宁可少一个事件，也不要让整个会话界面因为一帧坏数据卡死。
    }
  }

  return { frames, heardFromServer: heard, rest: buf, lastId };
}

/**
 * 把一条 SSE 流读成 frame 的异步迭代。
 *
 * 用 `getReader()` 的 while 循环而不是 `for await`：SDK 57 的文档只保证前者
 * （`expo/fetch` 的示例就是这么写的），`for await` 在 RN 的 ReadableStream 上
 * 不保证可用。
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  onHeartbeat?: () => void,
  /** 每收到一个 `id:` 就报一次。调用方记住它，重连时作为 Last-Event-ID 送回去 */
  onId?: (id: string) => void,
): AsyncGenerator<StreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // stream: true 是必须的——中文一个字 3 字节，断在 chunk 边界上会变乱码
      buf += decoder.decode(value, { stream: true });
      const r = parseChunk(buf);
      buf = r.rest;
      if (r.heardFromServer) onHeartbeat?.();
      for (const f of r.frames) yield f;
      if (r.lastId) onId?.(r.lastId);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流可能已被 abort
    }
  }
}
