const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

export function createSseStream(res, {
  pingMs = 15000, tick = null, maxBufferedBytes = MAX_SSE_BUFFER_BYTES,
} = {}) {
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      res.end();
    } catch {
      // 客户端可能已断开
    }
  };

  const writeChecked = (chunk) => {
    if (closed) return false;
    if ((res.writableLength ?? 0) > maxBufferedBytes) {
      close();
      try {
        res.destroy?.();
      } catch {
        // ignore
      }
      return false;
    }
    res.write(chunk);
    if ((res.writableLength ?? 0) > maxBufferedBytes) {
      close();
      try {
        res.destroy?.();
      } catch {
        // ignore
      }
      return false;
    }
    return true;
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 中间层若缓冲，事件会被攒住直到超时
    'X-Accel-Buffering': 'no',
    // 「我确实到达了源站」——与 server.js 的 ORIGIN_MARK 同一用途。
    // SSE 自己写响应头，不走 send()，漏了这里客户端就认不出这条流是 Baton 的。
    'X-Baton': '1',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });

  // 立刻发一行注释，让客户端与中间层都确认流已建立
  res.write(': open\n\n');

  // 心跳不是优化：Cloudflare 的 524 由「源站 100 秒无响应」触发。
  // agent 思考超过 100 秒时流会被切断，手机端看到的就是「永远 Thinking」。
  //
  // 带上 tick 之后它多了第二个职责：**秒表的活性证明**。客户端本地 1 Hz 走秒，
  // 但权威是服务器——连着两个心跳周期没收到 tick，说明这条流已经名存实亡，
  // 秒表该冻结变灰，而不是继续欢快地数下去骗人。
  // 具名事件同样重置 CF 的源站超时，所以防 524 的作用一点没丢。
  const timer = setInterval(() => {
    if (closed) return;
    let payload = null;
    try {
      payload = tick?.() ?? null;
    } catch {
      // tick 抛错不能让整个心跳停摆——那会直接触发 524
    }
    if (closed) return;
    if (payload) {
      writeChecked(`event: tick\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      writeChecked(': ping\n\n');
    }
  }, pingMs);
  timer.unref?.();

  res.on?.('close', close);

  return {
    /**
     * @param id 可选。发出去就是 SSE 的 `id:` 字段——**浏览器会记住它，并在
     *   断线自动重连时用 `Last-Event-ID` 头原样送回来**。这是协议自带的断点
     *   续传，网页端因此不用写一行重连补拉的代码。
     *
     *   值里不能有换行（那会把一个字段拆成两个），所以这里过一道。
     */
    send(event, data, id = null) {
      if (closed) return;
      const head = id === null || id === undefined
        ? ''
        : `id: ${String(id).replace(/[\r\n]/g, '')}\n`;
      writeChecked(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (closed) return;
      const body = String(text).split('\n').map((l) => `: ${l}`).join('\n');
      writeChecked(`${body}\n\n`);
    },
    close,
    get closed() {
      return closed;
    },
  };
}
