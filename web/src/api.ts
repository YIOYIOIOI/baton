/**
 * 后端 API 客户端。
 *
 * 契约的真源是 `src/http/routes.js` 与 `src/http/server.js`，不是任何一个客户端。
 * 这里只写浏览器端用得到的那几个端点，用到了再加。
 *
 * 凭据走 HttpOnly cookie，JS 读不到也不需要读——同源请求浏览器自己带上。
 * 原生客户端那条 bearer 路径（`want: 'bearer'`）网页端**不要用**：
 * 不索取就拿不到，HttpOnly 对这条路径才仍然作数。
 */

/** 后端的统一错误体：`{ error: { code, message, fix } }`。`fix` 是给人看的下一步。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 「该怎么办」。后端每个错误都带，显示时不要丢掉——丢了就只剩一句「失败了」。 */
  readonly fix: string;

  constructor(status: number, code: string, message: string, fix: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    // fetch 只在网络层失败时抛，HTTP 错误码不抛。这里是连不上守护进程。
    throw new ApiError(0, 'offline', '连不上这台电脑。', '确认电脑开着、Baton 在跑，然后重试。');
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/pair') && typeof window !== 'undefined') {
      const cur = window.location.pathname;
      if (cur !== '/welcome' && cur !== '/pair') {
        window.location.assign('/welcome');
      }
    }
    const e = body?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'unknown',
      e?.message ?? `请求失败（${res.status}）。`,
      e?.fix ?? '稍后重试；一直这样就去电脑上看 Baton 的输出。',
    );
  }

  return body as T;
}

/** 配对码的字母表：去掉了易混的 0 O 1 I（见 src/http/auth.js）。 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 12;

export const api = {
  /** 配对。成功后服务端下发 HttpOnly cookie，之后的请求自动带上。 */
  pair: (code: string) =>
    request<{ ok: true }>('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /**
   * 解除配对。**必须走服务端**：浏览器里真正起作用的是 HttpOnly cookie，
   * 只清本地存储的话看着像退出了，一刷新又自动登回去。
   */
  unpair: () => request<{ ok: true }>('/api/unpair', { method: 'POST' }),

  sessions: () => request<SessionList>('/api/sessions'),

  /**
   * `allowSend` 是**调用者自己的有效值**（服务端按身份合成），
   * 用来决定「新建文件夹」这类写磁盘的动作要不要禁用。
   */
  health: () => request<Health>('/api/health'),

  /** Connected devices visible to the caller. */
  devices: () => request<{ devices: DeviceItem[] }>('/api/devices'),

  /** Revoke a connected device immediately. */
  revokeDevice: (deviceId: string) =>
    request<{ ok: true; revoked: true; self: boolean }>('/api/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),

  /** Mint a one-time pairing code and QR SVG (owner only). */
  mintPairQr: (forId?: string) =>
    request<PairQrResult>('/api/pair/qr', {
      method: 'POST',
      body: JSON.stringify(forId ? { for: forId } : {}),
    }),

  /** Downloadable Markdown session transcript URL. */
  exportUrl: (key: string) => `/api/sessions/${enc(key)}/export`,

  /**
   * 浏览目录。**不传 path 时返回起点**——owner 拿到盘符 + 用过的目录，
   * 访客拿到自己的工作区根。起点页面直接打这个，**不要自己拼盘符**。
   */
  dirs: (path?: string | null) =>
    request<DirPage>(`/api/dirs${path ? `?path=${enc(path)}` : ''}`),

  /** 递归建目录。归在 allowSend 之下——它往 owner 的磁盘上写东西。 */
  mkdir: (path: string) =>
    request<{ path: string; created: boolean }>('/api/dirs', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /**
   * 一页事件。**一页之内按 offset 升序（旧→新）**，`nextBefore` 指向更早的一页，
   * 所以首屏拿到的就是最新的一段，往上滚才翻旧的——正是聊天视图要的语义（实测）。
   */
  events: (key: string, opts: { before?: number | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before != null) q.set('before', String(opts.before));
    q.set('limit', String(opts.limit ?? 60));
    return request<EventPage>(`/api/sessions/${enc(key)}/events?${q}`);
  },

  state: (key: string) => request<SessionState>(`/api/sessions/${enc(key)}/state`),

  /**
   * 被截断内容的全文，按 [from, to) 分段取。
   *
   * `offset` 必须原样回传事件自带的那个字段——没有它服务端就得全文件扫描，
   * 而 transcript 实测能到 175 MB（后端的错误提示原话）。
   *
   * 事件 id 形如 `<锚点>#<块序号>`，`#` 在 URL 里是片段分隔符，
   * 必须编码成 %23——encodeURIComponent 已经做了。
   */
  eventFull: (key: string, eventId: string, o: { offset: number; from?: number; to?: number }) => {
    const q = new URLSearchParams({ offset: String(o.offset) });
    if (o.from != null) q.set('from', String(o.from));
    if (o.to != null) q.set('to', String(o.to));
    return request<FullChunk>(`/api/sessions/${enc(key)}/events/${enc(eventId)}/full?${q}`);
  },

  /**
   * 送信。后端要求 config.allowSend === true，否则 403 send_disabled。
   * `when`：'auto' 正在跑就排队；'interrupt' 插队——停下正在跑的这一轮，这条第一个发（handlers/turns.js）
   */
  send: (key: string, message: string, fork = false, when: 'auto' | 'interrupt' = 'auto') =>
    request<unknown>(`/api/sessions/${enc(key)}/send`, {
      method: 'POST',
      body: JSON.stringify({ message, fork, when }),
    }),

  /** 撤回排着还没发出去的那一条。已经发出去了会回 404，如实说 */
  cancelQueued: (key: string, id: string) =>
    request<{ cancelled: true; id: string; text: string }>(`/api/sessions/${enc(key)}/queue/cancel`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  /**
   * 传文件。**body 是原始字节，不是 JSON 也不是 multipart**——base64 进 JSON 要多背
   * 33% 的体积，而这条路上跑的是手机流量（后端 routes.js 的原话）。文件名走 query。
   *
   * 上限 20 MB。同名会自动加后缀，不会覆盖别人的文件。
   *
   * **agent 认的是路径，不是附件。** 传完要把返回的 `relative` 写进消息里，
   * 否则文件躺在磁盘上没人会去读它。
   */
  /**
   * 输入框里打 `/` 弹出来的命令表（服务端 src/agent/commands.js）。`probe` 为真时，
   * 记录里没有就让服务端起一次探针（约 4 秒）；不带就只回记录里的
   */
  commands: (key: string, probe = false) =>
    request<SlashList>(`/api/sessions/${enc(key)}/commands${probe ? '?probe=1' : ''}`),

  /**
   * 设目标 / 清目标（服务端 handlers/goal.js）。Claude 变成一条 /goal 消息；Codex 走它自己的目标，
   * 设完立刻开工。返回和 send 一样的 { turnId, queued }
   */
  setGoal: (key: string, objective: string) =>
    request<{ turnId?: string; queued?: boolean }>(`/api/sessions/${enc(key)}/goal`, { method: 'POST', body: JSON.stringify({ objective }) }),
  clearGoal: (key: string) =>
    request<{ turnId?: string; cleared?: boolean }>(`/api/sessions/${enc(key)}/goal`, { method: 'POST', body: JSON.stringify({ clear: true }) }),

  /** 会话页右侧「信息」窗格（服务端 src/sessioninfo.js） */
  info: (key: string) => request<SessionInfo>(`/api/sessions/${enc(key)}/info`),
  /** 某个文件在这个会话里的每一次改动 */
  fileEdits: (key: string, file: string) =>
    request<{ file: string; edits: FileEdit[] }>(`/api/sessions/${enc(key)}/info?file=${enc(file)}`),

  /** 列会话工作目录里的一层。`path` 相对工作目录，空串就是根。 */
  files: (key: string, path = '') =>
    request<FileListing>(`/api/sessions/${enc(key)}/files?path=${enc(path)}`),

  /**
   * 下载地址。**直接挂到 `<a href>` 上就行**——网页端凭据走 HttpOnly cookie，
   * 同源请求浏览器自己带上；服务端又给了 `Content-Disposition: attachment`，
   * 所以点了就是下载、文件名也对。不用先 fetch 成 blob（那是手机端才需要的，
   * 因为它带的是 Bearer 头而 `<a>` 不带自定义头）。
   */
  fileUrl: (key: string, path: string) =>
    `/api/sessions/${enc(key)}/file?path=${enc(path)}`,

  /**
   * 传上去的文件读回来的地址，**给 `<img src>` 用**。
   *
   * 和 `fileUrl` 是两条：那条是文件浏览器的下载口，带
   * `Content-Disposition: attachment`；这条是上传的读回口，带
   * `Cache-Control: immutable`，正合缩略图。
   *
   * 网页端凭据走 HttpOnly cookie，同源请求浏览器自己带上，所以直接丢进
   * `src` 就行——不像手机端要拿 Bearer 头、得先 fetch 成 blob。
   *
   * 只吃**叶子名**（服务端 `readUpload` 走的是 safeName，不认目录），
   * 所以调用方要把 `.baton-uploads/x.png` 里的 `x.png` 取出来再传进来。
   */
  uploadUrl: (key: string, name: string) =>
    `/api/sessions/${enc(key)}/upload?name=${enc(name)}`,

  /**
   * 传到一个**工作目录**而不是一个会话。新建页靠它：那一刻会话还不存在。
   * 服务端那条端点的授权判据与「能不能在这个目录建会话」逐条相同。
   */
  uploadToCwd: (cwd: string, name: string, data: Blob) =>
    request<Upload>(`/api/uploads?cwd=${enc(cwd)}&name=${enc(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    }),

  upload: (key: string, name: string, data: Blob) =>
    request<Upload>(`/api/sessions/${enc(key)}/upload?name=${enc(name)}`, {
      method: 'POST',
      body: data,
      // 覆盖掉 request() 默认给 body 加的 application/json——这条路上是裸字节
      headers: { 'content-type': 'application/octet-stream' },
    }),

  stop: (key: string, turnId: string) =>
    request<unknown>(`/api/sessions/${enc(key)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ turnId }),
    }),

  models: () => request<Models>('/api/models'),

  /** 权限档位。**一次返回两个 agent**——切 agent 时不该闪一帧旧值（见后端抬头）。 */
  permission: () => request<Permission>('/api/permission'),

  /** 两个 agent 的套餐额度（服务端 src/usage.js）。owner 专属；refresh 跳过服务端 60 秒缓存 */
  usage: (refresh = false) => request<Usage>(`/api/usage${refresh ? '?refresh=1' : ''}`),

  /** 改权限档位。owner 专属，访客得 403 `not_owner`。 */
  setPermission: (agent: Agent, mode: string) =>
    request<Permission>('/api/permission', {
      method: 'POST',
      body: JSON.stringify({ agent, mode }),
    }),

  /**
   * 换模型。落在**会话**上而不是设备上：两台设备必须看到同一个选择。
   * 正在跑的那一轮改不了（进程起来时就定死了），响应的 `appliesTo` 会说明。
   */
  setModel: (key: string, model: string | null) =>
    request<{ model: string | null; appliesTo: 'now' | 'next'; note: string | null }>(
      `/api/sessions/${enc(key)}/model`,
      { method: 'POST', body: JSON.stringify({ model }) },
    ),

  /** 思考强度。与模型并列、同样落在会话上，但**独立端点**——合并会误清另一个。 */
  setEffort: (key: string, effort: string | null) =>
    request<{ effort: string | null }>(`/api/sessions/${enc(key)}/effort`, {
      method: 'POST',
      body: JSON.stringify({ effort }),
    }),

  /**
   * 建会话。**服务端要求 message 非空**（`empty_message` 400），所以「先开一个空
   * 会话、进去再说」这件事客户端做不到。
   *
   * `effort` 后端一直收（routes.js 把 `body.effort` 传给 createSession），
   * 只是这里原来没写进类型，于是新建时选的强度悄悄丢掉了。
   */
  createSession: (input: {
    agent: Agent; cwd: string; message: string;
    model?: string | null; effort?: string | null;
  }) =>
    request<Created>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * 答一道 agent 正在等的选择题。
   *
   * `askId` 必带：断线期间这一轮可能已经超时又开了新的题，手上那张卡未必是
   * 现在等的那道。服务端对不上就回 409，不会把答案安到另一个问题上。
   */
  answer: (key: string, input: { askId: string; picked: string[]; free: string | null }) =>
    request<{ ok: true }>(`/api/sessions/${enc(key)}/answer`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** SSE。浏览器原生 EventSource 够用——同源、cookie 自动带上、断线自动重连。 */
  stream: (key: string) => new EventSource(`/api/sessions/${enc(key)}/stream`),
};

const enc = encodeURIComponent;

// —— 事件。kind / 字段 / 可空性全部实测自线上（22 个会话、1137 个事件）——

/**
 * 会话工作目录里的一条。
 *
 * 和「选工作目录」那套（跨盘、只有目录、绝对路径）是两回事，别合并：这个锁在一棵
 * 子树里、目录和文件都有、给的是相对路径。
 */
export type FileEntry = {
  name: string;
  dir: boolean;
  /** 目录为 null。 */
  size: number | null;
  mtime: number | null;
};

export type FileListing = {
  /** 工作目录绝对路径，只用来显示"你在哪棵树上"。 */
  cwd: string;
  /** 当前位置，相对工作目录；空串就是根。 */
  path: string;
  /** **null 表示到顶了**——工作目录就是这个会话的天花板。 */
  parent: string | null;
  entries: FileEntry[];
};

export type Role = 'user' | 'agent' | 'system';

/** `{ totalChars, keptHead, keptTail }`：内容被截断了，全文要走 /events/:id/full */
export type Cut = { totalChars: number; keptHead: number; keptTail: number };

export type Tool = {
  id: string;
  /** **1137 个事件里 342 个为 null**——tool_result 不带名字，渲染时必须兜住 */
  name: string | null;
  input?: unknown;
  output?: unknown;
  /**
   * 只在工具结果上、且 agent 自己记下了失败时才有，值恒为 true（服务端 src/claude.js、
   * src/codex.js；依据见 docs/ops/agent-protocol.md §22）。**没有这个字段不等于成功**：
   * 老服务端不发，有些工具也根本不报成败。
   */
  failed?: true;
};

type Base = { id: string; kind: string; offset: number; role: Role; ts: string };

export type Ev =
  | (Base & { kind: 'text'; text: string; origin?: string; tokens?: number })
  | (Base & { kind: 'thinking'; text: string; tokens?: number })
  | (Base & { kind: 'tool_call'; tool: Tool; truncation?: { input?: Cut; output?: Cut }; tokens?: number })
  | (Base & { kind: 'tool_result'; tool: Tool; truncation?: { input?: Cut; output?: Cut } })
  /*
    error 是**字符串**。这里原来写成 `{ message?: string }`，于是界面上读
    `ev.error.message`——而服务端（src/codex.js）给的一直是 `p.error?.message`
    本身。2026-09-29 实测：codex 出错的 31 轮，网页端全部显示成「未知原因」，
    真正的原因（例如 Selected model is at capacity）一个字都没出来。
    App 那边的类型一直是对的（app/src/api/types.ts）。
  */
  | (Base & { kind: 'turn_end'; text?: string; error?: string | null })
  /** 这一轮被人打断了。text 是服务端翻好的一句话（src/claude.js 的 interruptOf） */
  | (Base & { kind: 'interrupt'; text: string })
  /** 斜杠命令的回执（「Goal set: …」「Set model to …」、/context 的用量表）。text 是原文 */
  | (Base & { kind: 'command_output'; text: string })
  /** /goal 的进度。text 是目标条件；met = 达成了，否则是检查没过、agent 被打回去接着干 */
  | (Base & { kind: 'goal'; text: string; goal: { met: boolean; reason: string | null; status?: string } });

export type EventPage = { events: Ev[]; nextBefore: number | null };

/** 全文的一段。实测单条能到 17 万字，所以一定要分段，不能整块塞进 DOM。 */
export type FullChunk = {
  id: string;
  totalChars: number;
  from: number;
  to: number;
  text: string;
  hasMore: boolean;
};

export type Turn = { turnId: string; status: 'running' | string; startedAt: number };

export type SessionState = {
  running: boolean;
  latestTurn: Turn | null;
  queued: { id: string; text: string; queuedAt: number }[];
  lastEventTs: string | null;
  /**
   * **null = 没选过，跟 agent 自己的默认走。**「没选过」和「选了正好等于默认的
   * 那一个」在界面上必须显示得不一样——后端注释专门交代了这条，别在客户端
   * 替它填一个猜测值。
   */
  model: string | null;
  /** 同上，null = 没选过 */
  effort: string | null;
  agent: Agent;
  /**
   * agent 现在正等着人答的那道选择题。null = 没有。
   *
   * 它必须出现在**状态**里而不是只走事件流：问题挂起期间用户很可能正好切走、
   * 锁屏、换网。回来的时候要立刻知道「有人在等我」，而不是等下一次状态变化。
   */
  pendingAsk: PendingAsk | null;
};

/** 一道待答的选择题。形状与服务端 src/ask/store.js 的 openAsk 一致。 */
export type PendingAsk = {
  askId: string;
  key: string;
  turnId: string;
  question: string;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
  /** 四个字以内的抬头，做卡片标题。没有就退回一句通用的 */
  header: string | null;
  openedAt: number;
  /** 超过这个时刻 agent 就不等了，界面上是倒计时 */
  expiresAt: number;
};

/** SSE 心跳。既防 Cloudflare 524，又是秒表的活性证明——连着两拍没来就该冻结。 */
export type Tick = { turnId: string | null; running: boolean; elapsedMs: number; queued: number };

/**
 * 一个可选模型。形状**实测自 `/api/models`**——旧的类型只写了 `{id, seen}`，
 * 于是新建页把 `claude-opus-5` 这样的裸 id 显示给人看，而后端一直给着 `Opus 5`。
 */
export type ModelOption = {
  id: string;
  /** 给人看的名字。没有就退回 id */
  name: string | null;
  desc: string | null;
  /** true = 这台机器的 transcript 里真跑过。false 的失败时该怀疑中转，不是 Baton */
  seen: boolean;
  /** 供应商目录里标了不常用的。默认收起来，别让选单一屏放不下 */
  hidden: boolean;
  /**
   * **这个模型支持的思考强度，不是全局并集。** 界面上该给哪几档只看这里。
   * `listed` 为 true 时空表 = 这个模型不能调（Haiku 4.5）；否则空表 = 不知道。
   */
  efforts: string[];
  defaultEffort: string | null;
  /**
   * agent 自己的模型目录里列着它：Claude 是 Claude Code `/model` 那份，Codex 是
   * `codex debug models`。为 true 时名字、说明、强度表都来自目录，是权威的。
   * 旧服务端不给这个字段。
   */
  listed?: boolean;
};

/**
 * 这台电脑上已经配好的东西。`defaultModel` = 一个模型都不选时实际跑的那个，
 * 连同它默认拿到的强度（Claude 的默认强度按模型定，所以挂在它身上）。
 * 旧服务端不给这个字段。形状与手机端 `AgentConfig` 相同。
 */
export type AgentConfig = {
  /** 配置里写死、对哪个模型都生效的强度（只有 Codex 有） */
  effort: string | null;
  contextWindow: number | null;
  defaultModel?: {
    id: string;
    name: string;
    /** 默认额外带的那档窗口（Claude 默认是 1M）。null = 没有那一档，不是不知道 */
    contextWindow: number | null;
    effort: string | null;
  } | null;
};

export type Models = Record<Agent, ModelOption[]> & {
  note?: string;
  config?: Record<Agent, AgentConfig>;
};

/** 一个权限档位。`available`/`unavailable` 是**服务端算好的**，客户端别自己判。 */
export type PermissionOption = {
  id: string;
  label: string;
  /** 一句话说明这一档能干什么。直接显示，不要自己另写一套文案 */
  body: string;
  danger: boolean;
  needsSandbox: boolean;
  /** false = 这台机器上用不了，选了会挂住。**必须不可点** */
  available: boolean;
  /** available 为 false 时的原因，直接显示给用户 */
  unavailable: string | null;
};

/**
 * 权限档位。**一次给两个 agent**，所以切 agent 时不会闪一帧旧值。
 *
 * `canSet` 为 false = 访客。此时整块只读——后端也会 403，客户端先禁用只是
 * 为了别让人点了才报错。
 */
export type UsageWindow = {
  id: string;
  /** 「5 小时内」「本周 · 全部模型」…服务端已经翻好 */
  label: string;
  /** **已用**百分比，0–100（服务端照接口原样给）。界面上显示的是剩余 = 100 - percent */
  percent: number;
  /** 什么时候重置（毫秒时间戳）。拿不到为 null */
  resetsAt: number | null;
};

export type AgentUsage =
  | {
    available: true;
    /** 套餐：pro / max / plus … */
    plan: string | null;
    windows: UsageWindow[];
    /** 这份数是什么时候的。Claude 是刚问的；Codex 是上一轮跑完时记下的 */
    asOf: number | null;
    extraUsage?: boolean;
    reached?: string | null;
    /** live = 刚现问的；rollout = 问不到，退回了上一轮跑完时记下的（Codex 才会有） */
    source?: 'live' | 'rollout';
    /** 退回 rollout 时，现问失败的原因 */
    liveError?: string;
  }
  | { available: false; reason: string; plan?: string | null };

export type Usage = { claude: AgentUsage; codex: AgentUsage; antigravity?: AgentUsage };

export type SlashCommand = {
  name: string; desc: string | null; group: 'builtin' | 'skill' | 'plugin'; common?: boolean;
  /** 能不能写在句子中间（技能、插件命令能；Claude 的内置命令只在消息开头才执行） */
  inline?: boolean;
};
/** mention：选中后插进去的记号。Claude 认 /名字，Codex 认 $名字 */
export type SlashList = { agent: Agent; mention?: '/' | '$'; commands: SlashCommand[]; at: number | null; stale: boolean };

export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };
export type FileStat = { path: string; edits: number; added: number; removed: number; lastTs: string | null; created: boolean };
export type FileEdit = { ts: string | null; kind: 'edit' | 'write'; before: string; after: string };
export type SessionInfo = {
  agent: Agent;
  cwd: string | null;
  branch: string | null;
  model: { id: string; name: string } | null;
  /** used = 最近一次请求带进去的 token；window = 这个模型的上下文窗口 */
  context: { used: number; window: number | null; ts: string | null } | null;
  /**
   * 目标。met = 达成了。status：Claude 只有 active / complete；Codex 还有 paused / blocked /
   * usage_limited / budget_limited，外加它自己记的已用 token、时长、预算
   */
  goal: {
    condition: string; met: boolean; reason: string | null; setAt: string | null; status?: string;
    tokensUsed?: number; timeUsedSeconds?: number; tokenBudget?: number | null;
  } | null;
  /** 计划（Claude Desktop 的 update_plan、或老的 TodoWrite、Codex 的 update_plan） */
  plan: PlanItem[] | null;
  /** 最近一次收尾总结（Claude Desktop 的 wrap_up） */
  recap: { text: string; ts: string | null } | null;
  files: FileStat[];
  fileCount: number;
  /** false = 这个 agent 改文件的方式统计不出来（Codex 走 exec） */
  filesTracked: boolean;
};

export type Permission = {
  canSet: boolean;
  agents: Record<Agent, { mode: string; options: PermissionOption[] }>;
  /** 'missing' = Codex 的沙箱没预置，几档会挂住 */
  codexSandbox: string;
};

// —— 返回体形状。取自 src/http/api.js 的 listSessions/publicMember ——

export type Agent = 'claude' | 'codex' | 'antigravity';

/**
 * 字段与可空性**实测自线上 `/api/sessions`**（179 个会话），不是照代码猜的。
 * 猜的那一版把 `lastActivityMs` 写在了 member 上，实际它只在 chain 上。
 */
export type Member = {
  key: string;
  agent: Agent;
  title: string;
  /** 标题来源的档次，见 src/titles.js */
  titleTier: number;
  /** 179 个里有 2 个为 null */
  cwd: string | null;
  /**
   * 列表里归哪一组——和 App 侧栏归在同一个地方（见 src/titles.js 的 resolveProject）。
   * worktree 会话归原仓库，Codex 的独立聊天归一组。`key` 只用来归组和记折叠状态，
   * `name` 是组头上的字。没有目录时为 null；老服务端没有这个字段。
   */
  /** dir：这一组的目录本身（原样大小写），「在这里开新会话」用；Codex 独立聊天没有 */
  project?: { key: string; name: string; dir?: string } | null;
  firstTs: string;
  /**
   * **179 个里有 38 个是 null（21%）。** 直接拿去 new Date() 会得到 Invalid Date，
   * 列表里五分之一的行就废了。排序与显示一律用 mtimeMs，这个只作锦上添花。
   */
  lastTs: string | null;
  /** 永远有值，是可靠的时间基准 */
  mtimeMs: number;
  size: number;
  isArchived: boolean;
  parentId: string | null;
  providerId: string;
  rolloutId: string | null;
  /**
   * 在跑。**包括电脑上起的那些**——桌面 App、终端里跑着的轮次也算
   * （服务端 src/runtime/live.js）。
   */
  running: boolean;
  /**
   * 卡在等人点确认（CLI 报的 `waiting / input needed`）。和 running 互斥：
   * 一个是等它干完，一个是它在等你。老服务端没有这个字段。
   */
  waiting?: boolean;
};

export type Chain = {
  chainKey: string;
  agent: Agent;
  lastActivityMs: number;
  members: Member[];
};

export type SessionList = {
  chains: Chain[];
  /**
   * 这个调用者可选的工作目录快捷列表，已排序去重。
   *
   * **不要再自己遍历 `chains[].members[].cwd` 去凑。** 那对 owner 恰好等价，
   * 但访客零会话时会得到一个空选单，压根开不了头（契约文档 §1）。
   */
  cwds: string[];
};

/**
 * 建会话的返回。**没有 `key`**——这里原来写的是 `{ key: string }`，纯属想当然，
 * 于是建完会跳到 `/session/undefined`（实测）。网页端从此没成功建过一次会话，
 * 设计文档 §5b 那句「送信的成功路径没有验过」说的就是它。
 *
 * 服务端给的是 `sessionId`，也就是 provider 那边的 id（claude 的 cliSessionId /
 * codex 的 threadId）。而 Baton 的 `key` 是由**文件相对路径**编码来的，建之前
 * 拿不到——服务端自己也要在建完之后重扫一遍仓库、按 `providerId` 找回它
 * （见 api.js 里 `landed` 那段）。客户端只能照做。
 */
export type Created = {
  /** provider 的会话 id。拿它去 `/api/sessions` 里按 `providerId` 反查 `key` */
  sessionId: string;
  agent: Agent;
  /** 归一化之后的工作目录，不一定与请求里的原文逐字相同 */
  cwd: string;
  /** claude 才写桌面 App 注册项；codex 恒为 false */
  registered: boolean;
  /** 给人看的下一步。claude 那条会说「要重启桌面 App 才看得到」 */
  note: string;
};

/** 一次上传的结果。`relative` 是要贴进消息里的那个路径。 */
export type Upload = {
  /** 服务端最终用的名字。同名时会加后缀，**不一定等于你传上去的那个** */
  name: string;
  bytes: number;
  path: string;
  /** 相对工作目录的路径，形如 `.baton-uploads/foo.png` */
  relative: string;
  note: string;
};

export type DirEntry = {
  name: string;
  path: string;
  /** false = 点进去会失败。**必须显示为不可点**，别让人点了才报错。 */
  readable: boolean;
};

export type DirPage = {
  /** 起点时为 null——那是一组入口，不是某个目录的内容 */
  path: string | null;
  /** null 表示不能再往上：访客站在工作区根、owner 站在盘符根都是这样 */
  parent: string | null;
  dirs: DirEntry[];
};

export type Health = {
  ok?: boolean;
  version?: string;
  allowSend: boolean;
  canSetPermissionMode?: boolean;
  principal?: { id: string; isOwner: boolean };
};

export type DeviceItem = {
  id: string;
  principalId: string;
  label: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  current?: boolean;
};

export type PairQrResult = {
  code: string;
  for: string;
  pairUrl: string | null;
  svg: string;
  expiresInSec: number;
  network: { publicUrl: string | null; lan: string | null; tailscale: string | null };
};
