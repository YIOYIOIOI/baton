import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { classifyProbe, probeOf } from './classify';
import { readFrames } from './sse';
import type { CreationStatus } from './creationStatus';
import type {
  Agent,
  ApiError, DeviceItem, DirCreated, DirListing, Effort, EventFull, EventPage, Health, LinkAxis,
  PairQrResult, Permission, PermissionMode, SendResult, SessionList, SessionState, StreamFrame,
  ModelList, ModelSet, Upload, FileListing, SlashList, Usage,
} from './types';

/**
 * 与 Baton 守护进程通信。
 *
 * 用 `expo/fetch` 而不是全局 fetch：它是 WinterCG 兼容实现，**`response.body`
 * 是真的 ReadableStream**，这是 SSE 能在 RN 上跑起来的前提（RN 自带的 fetch
 * 在 iOS/Android 上不给流式 body）。SDK 57 起它在原生端本来就是默认的全局
 * fetch，显式引入只是为了让这条依赖在代码里看得见。
 */

export class BatonError extends Error {
  code: string;
  fix: string;
  status: number;
  constructor(status: number, body: ApiError | null) {
    const e = body?.error;
    super(e?.message ?? `HTTP ${status}`);
    this.code = e?.code ?? 'http_error';
    // 修复指引一律用服务端给的。客户端自己编一句，很快就会和后端说的不一致——
    // 而「两处说法不同」比「没有指引」更让人不知所措。
    this.fix = e?.fix ?? '';
    this.status = status;
  }
}

/** 传输层故障。它带着判别结果，调用方直接拿去点亮传输轴。 */
export class LinkError extends Error {
  link: LinkAxis;
  constructor(link: LinkAxis, message: string) {
    super(message);
    this.link = link;
  }
}

export type ClientConfig = {
  baseUrl: string;
  token: string | null;
  isActive?: () => boolean;
  onHealth?: (health: Health) => void;
  /** 收到任何服务器响应时调用，用于刷新"最后一次听到服务器"——秒表活性靠它 */
  onHeard?: () => void;
  /** 传输轴变化时调用 */
  onLink?: (link: LinkAxis) => void;
};

export function createClient(cfg: ClientConfig) {
  const { baseUrl } = cfg;
  const token = Platform.OS === 'web' ? null : cfg.token;

  const headers = (extra?: Record<string, string>) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function raw(path: string, init?: RequestInit): Promise<Response> {
    if (cfg.isActive && !cfg.isActive()) throw new BatonError(401, null);
    let res: Response;
    try {
      res = (await expoFetch(`${baseUrl}${path}`, {
        credentials: token ? 'omit' : 'same-origin',
        redirect: 'error',
        ...init,
        headers: headers(init?.headers as Record<string, string> | undefined),
      })) as unknown as Response;
    } catch (err) {
      // 一个字节都没出去
      cfg.onLink?.('offline');
      throw new LinkError('offline', (err as Error)?.message ?? '网络不可达');
    }

    if (cfg.isActive && !cfg.isActive()) throw new BatonError(401, null);
    const link = classifyProbe(probeOf(res));
    cfg.onLink?.(link);
    cfg.onHeard?.();

    if (link !== 'ok') {
      throw new LinkError(link, `到不了 Baton（${link}，HTTP ${res.status}）`);
    }
    return res;
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await raw(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      throw new BatonError(res.status, body);
    }
    const result = await res.json() as T;
    if (cfg.isActive && !cfg.isActive()) throw new BatonError(401, null);
    return result;
  }

  const enc = encodeURIComponent;

  return {
    /**
     * 配对：拿一次性短码换长期凭据，返回可存进 Keychain 的 bearer。
     *
     * 必须传 `want: 'bearer'`。后端默认只下发 HttpOnly cookie——**RN 读不到它**
     * （iOS 的 NSURLSession 把 cookie 收进自己的存储，fetch 层看不见）。
     * 显式索取而不是无条件返回，是为了让 HttpOnly 对网页那条路径仍然作数。
     *
     * 配对码 12 位，字母表去掉了易混的 0O1I，所以这里可以放心 toUpperCase()。
     */
    async pairForBearer(code: string): Promise<string> {
      if (Platform.OS === 'web') throw new Error('Browser pairing requires a cookie');
      const res = await raw('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), want: 'bearer' }),
      });
      if (!res.ok) {
        throw new BatonError(res.status, (await res.json().catch(() => null)) as ApiError | null);
      }
      const body = (await res.json()) as { ok: boolean; bearer?: string };
      if (!body.bearer) {
        throw new Error('配对成功但服务端没给出凭据——Baton 版本可能过旧，请更新后重试。');
      }
      return body.bearer;
    },

    pairWithCookie: (code: string) => json<{ ok: true; deviceId?: string }>('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
    }),

    async health() {
      const health = await json<Health>('/api/health');
      cfg.onHealth?.(health);
      return health;
    },

    devices: () => json<{ devices: DeviceItem[] }>('/api/devices'),

    revokeDevice: (deviceId: string) =>
      json<{ ok: boolean; id: string }>('/api/devices/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      }),

    mintPairQr: (forId?: string, baseUrlOverride?: string) =>
      json<PairQrResult>('/api/pair/qr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(forId ? { for: forId } : {}),
          ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}),
        }),
      }),

    async exportMarkdown(key: string): Promise<{ filename: string; markdown: string }> {
      const res = await raw(`/api/sessions/${enc(key)}/export`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        throw new BatonError(res.status, body);
      }
      const cd = res.headers?.get?.('content-disposition') ?? '';
      let filename = `${key.replace(/[^a-zA-Z0-9._-]+/g, '-')}.md`;
      const utf8Match = /filename\*=UTF-8''([^;\s]+)/i.exec(cd);
      const asciiMatch = /filename="([^"]+)"/i.exec(cd);
      if (utf8Match?.[1]) {
        try { filename = decodeURIComponent(utf8Match[1]); } catch { /* fallback below */ }
      } else if (asciiMatch?.[1]) {
        filename = asciiMatch[1];
      }
      if (!filename.toLowerCase().endsWith('.md')) filename += '.md';
      const markdown = await res.text();
      return { filename, markdown };
    },

    /**
     * 权限档位。改档**只有 owner 能成功**，失败时服务端回 403 not_owner——
     * 客户端不预先判断自己是不是 owner，只把 canSet 当成一个能力位用来置灰。
     */
    permission: () => json<Permission>('/api/permission'),

    // agent 必传：两边的档位集合不同，不带的话服务端只能按 claude 兜底，
    // 于是在 Codex 上改权限会静默改到 Claude 头上
    setPermission: (agent: Agent, mode: PermissionMode) =>
      json<Permission>('/api/permission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, mode }),
      }),

    // ── 网页推送 ──
    pushKey: () => json<{ publicKey: string }>('/api/push/key'),

    pushSubscribe: (endpoint: string) =>
      json<{ ok: boolean }>('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }),

    pushUnsubscribe: (endpoint: string) =>
      json<{ ok: boolean }>('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }),

    sessions: () => json<SessionList>('/api/sessions'),

    /**
     * 浏览目录。不带 path 拿到的是**起点**——owner 得到盘符加他用过的目录，
     * 访客得到他的工作区根。
     *
     * 起点必须打这个接口，**不要自己拼盘符**：客户端拼不出访客该看到的那一组，
     * 而且拼出来的东西还得再判断一次身份——那正是这套接口要消灭的分支。
     */
    dirs: (path?: string | null) =>
      json<DirListing>(`/api/dirs${path ? `?path=${enc(path)}` : ''}`),

    /** 递归创建，可以一次传多层。归在 allowSend 之下——它往 owner 的磁盘上写东西。 */
    makeDir: (path: string) =>
      json<DirCreated>('/api/dirs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      }),

    /**
     * 两个 agent 的套餐额度（服务端 src/usage.js）。**owner 专属**：访客得 403 `not_owner`，
     * 调用方据此把整块藏起来。`refresh` 跳过服务端 60 秒缓存（界面上的「刷新」）。
     */
    usage: (refresh = false) => json<Usage>(`/api/usage${refresh ? '?refresh=1' : ''}`),

    /** 可选模型。列表是那台电脑现推的——不同机器、不同中转，结果就不同。 */
    models: (refresh = false) => json<ModelList>(`/api/models${refresh ? '?refresh=1' : ''}`),

    /** 传 null 表示清除选择、回到 agent 默认。Codex 会被服务端拒（它没有这个开关）。 */
    setEffort: (key: string, effort: Effort | null) =>
      json<{ effort: Effort | null }>(`/api/sessions/${enc(key)}/effort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort }),
      }),

    /** 传 null 表示清除选择、回到 agent 默认。 */
    setModel: (key: string, model: string | null) =>
      json<ModelSet>(`/api/sessions/${enc(key)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      }),

    /**
     * 传文件。发的是**原始字节**不是 multipart 也不是 base64：
     * base64 要多背 33% 的体积，而这条路上跑的是手机流量。
     *
     * 文件名走 query，因为它要过 URL 编码才能安全携带非 ASCII 名字。
     */
    upload: (key: string, name: string, data: Blob | ArrayBuffer | Uint8Array) =>
      json<Upload>(`/api/sessions/${enc(key)}/upload?name=${enc(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data as BodyInit,
      }),

    /**
     * 传到一个**工作目录**，而不是一个会话。
     *
     * 新建会话那一屏靠它：那一刻会话还不存在，没有 key；而附件路径必须出现在
     * 第一条消息里（agent 只认磁盘路径）。所以顺序是「先传到那个 cwd → 拿到
     * 相对路径 → 带着路径建会话」。
     *
     * 服务端那条端点的授权判据与「能不能在这个目录建会话」逐条相同，
     * 不多给任何权限——见 src/http/api.js 里 uploadToCwd 抬头那段。
     */
    uploadToCwd: (cwd: string, name: string, data: Blob | ArrayBuffer | Uint8Array) =>
      json<Upload>(`/api/uploads?cwd=${enc(cwd)}&name=${enc(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data as BodyInit,
      }),

    /**
     * 取回传上去的文件，用来出缩略图。
     *
     * 返回地址和请求头而不是字节：原生 `<Image>` 能直接吃
     * `{ uri, headers }`，由它自己去下载、缓存、按需解码——比我们把整张图读进
     * JS 内存再转 data URI 省得多（后者还要多背 33% 的 base64）。
     * 网页端 `<img>` 带不了自定义头，那条路由调用方自己取字节转 blob。
     */
    uploadSource: (key: string, name: string) => ({
      uri: `${baseUrl}/api/sessions/${enc(key)}/upload?name=${enc(name)}`,
      headers: headers() as Record<string, string>,
    }),

    /**
     * 列会话工作目录里的一层。`path` 相对工作目录，空串就是根。
     *
     * 范围由服务端锁死在该会话的 cwd 子树（见 src/sessionfs.js），客户端不做
     * 任何路径拼装上的自我约束——那种约束是假的，真正作数的只有服务端那一处。
     */
    files: (key: string, path = '') =>
      json<FileListing>(`/api/sessions/${enc(key)}/files?path=${enc(path)}`),

    /**
     * 输入框里打 `/` 弹出来的命令 / 技能表（服务端 src/agent/commands.js）。`probe` 为真时，
     * 记录里没有就让服务端去问 agent（Claude 约 4 秒，Codex 一两秒）
     */
    commands: (key: string, probe = false) =>
      json<SlashList>(`/api/sessions/${enc(key)}/commands${probe ? '?probe=1' : ''}`),

    /**
     * 下载工作目录里的一个文件：返回地址和请求头。
     *
     * 和 `uploadSource` 同样的理由——原生端交给系统去下载，别把整个文件读进
     * JS 内存。网页端拿不了自定义头，调用方自己 fetch 转 blob。
     */
    fileSource: (key: string, path: string) => ({
      uri: `${baseUrl}/api/sessions/${enc(key)}/file?path=${enc(path)}`,
      headers: headers() as Record<string, string>,
    }),

    events: (key: string, opts: { before?: number | null; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.before != null) q.set('before', String(opts.before));
      if (opts.limit != null) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return json<EventPage>(`/api/sessions/${enc(key)}/events${qs ? `?${qs}` : ''}`);
    },

    /**
     * 取被截断掉的全文。
     * `offset` 必须带上——不带后端会 400：没有它就得从头扫 transcript 找锚点，
     * 实测最大的一个 175 MB。事件 id 含 `#`，enc() 会把它变成 %23。
     */
    eventFull: (key: string, eventId: string, offset: number, range?: { from?: number; to?: number }) => {
      const q = new URLSearchParams({ offset: String(offset) });
      if (range?.from != null) q.set('from', String(range.from));
      if (range?.to != null) q.set('to', String(range.to));
      return json<EventFull>(`/api/sessions/${enc(key)}/events/${enc(eventId)}/full?${q}`);
    },

    state: (key: string) => json<SessionState>(`/api/sessions/${enc(key)}/state`),

    /**
     * `when: 'now'` = 人自己按了「立刻发送」，不要为「电脑上那轮在跑」排队。
     * 服务端只放行这一条；Baton 自己那一轮照样挡着（要插队得先停掉它）。
     */
    send: (key: string, message: string, fork = false, when: 'auto' | 'now' | 'interrupt' = 'auto', requestId?: string) =>
      json<SendResult>(`/api/sessions/${enc(key)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, fork, when, requestId }),
      }),

    promoteQueued: (key: string, id: string) =>
      json<SendResult>(`/api/sessions/${enc(key)}/queue/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }),

    /** 撤回排着还没发出去的那一条。已经发出去了会回 404，如实告诉人，别假装撤掉了。 */
    cancelQueued: (key: string, id: string) =>
      json<{ cancelled: true; id: string; text: string }>(`/api/sessions/${enc(key)}/queue/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }),

    /**
     * 答一道 agent 正在等的选择题。
     *
     * `askId` 必带：断线期间这一轮可能已经超时又开了新的题，手上那张卡未必是
     * 现在等的那道。服务端对不上就回 409，不会把答案安到另一个问题上。
     */
    answer: (
      key: string,
      input: { askId: string; picked: string[]; free: string | null },
    ) =>
      json<{ ok: true }>(`/api/sessions/${enc(key)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),

    stop: (key: string, turnId: string) =>
      json<{ turnId: string; stopped: boolean; stopping?: boolean; note?: string }>(`/api/sessions/${enc(key)}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId }),
      }),

    creationStatus: (url: string, signal: AbortSignal) => json<CreationStatus>(url, { signal }),
    createSession: (
      agent: Agent, cwd: string, message: string,
      model?: string | null, effort?: Effort | null,
    ) =>
      json<{ sessionId: string | null; key?: string | null; status?: 'unconfirmed'; turnId?: string; statusUrl?: string; agent: string; cwd: string; registered: boolean; note: string }>(
        '/api/sessions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // model 省略 = 跟 agent 自己的默认。传 null 也是同样效果。
          body: JSON.stringify({ agent, cwd, message, model: model ?? null, effort: effort ?? null }),
        },
      ),

    /**
     * 订阅一个会话的实时流。
     *
     * 返回一个 `stop()`。调用方**必须**在界面离开时调它，否则每次进出会话都会
     * 泄漏一条流——后端按 key 记订阅者，泄漏会一直堆到守护进程重启。
     */
    stream(
      key: string,
      onFrame: (f: StreamFrame) => void,
      onError?: (e: LinkError) => void,
      /**
       * 断线续传。
       *
       * `lastEventId` 是上次收到的最后一个 `id`（服务端放的是「推到哪个字节」）。
       * 带上它，服务端就从那儿开始重放断开期间写进 transcript 的事件，而不是
       * 从文件末尾接着跟——不带的话那段就永远没人发第二遍。
       *
       * 浏览器原生 EventSource 会自动做这件事；我们这条是自己拼的，得手动带。
       * `onId` 把新的位置交回调用方保存。
       */
      opts?: { lastEventId?: string | null; onId?: (id: string) => void },
    ): () => void {
      const ctrl = new AbortController();
      if (cfg.isActive && !cfg.isActive()) return () => {};

      (async () => {
        try {
          const from = opts?.lastEventId == null ? '' : `?from=${enc(opts.lastEventId)}`;
          const res = (await expoFetch(`${baseUrl}/api/sessions/${enc(key)}/stream${from}`, {
            credentials: token ? 'omit' : 'same-origin',
            redirect: 'error',
            headers: headers({
              Accept: 'text/event-stream',
              ...(opts?.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {}),
            }),
            signal: ctrl.signal,
          })) as unknown as Response;

          const link = classifyProbe(probeOf(res));
          cfg.onLink?.(link);
          if (link !== 'ok' || !res.body) {
            onError?.(new LinkError(link, `流建立失败（HTTP ${res.status}）`));
            return;
          }

          cfg.onHeard?.();
          for await (const f of readFrames(
            res.body as unknown as ReadableStream<Uint8Array>,
            cfg.onHeard,
            opts?.onId,
          )) {
            onFrame(f);
          }
          // 流自然结束（服务端关了）——按暂时故障处理，由调用方决定是否重连
          onError?.(new LinkError('retrying', '流已结束'));
        } catch (err) {
          if (ctrl.signal.aborted) return; // 是我们自己停的，不是故障
          const link = err instanceof LinkError ? err.link : 'offline';
          cfg.onLink?.(link);
          onError?.(new LinkError(link, (err as Error)?.message ?? '流中断'));
        }
      })();

      return () => ctrl.abort();
    },
  };
}

export type Client = ReturnType<typeof createClient>;
