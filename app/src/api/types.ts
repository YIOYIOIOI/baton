/**
 * 与后端的契约。字段名与形状**照实际响应抄**，不是照设计文档写的——
 * 2026-09-12 用真实运行中的 Baton 逐个打出来核对过。
 *
 * 客户端与后端同仓就是为了这个：契约变更必须能在一个提交里看见。
 */

export type Agent = 'claude' | 'codex' | 'antigravity';

/** 输入框 `/` 菜单里的一项（2026-11-11）。inline：能不能写在句子中间 */
export type SlashCommand = {
  name: string; desc: string | null; group: 'builtin' | 'skill' | 'plugin'; common?: boolean; inline?: boolean;
};
/** mention：选中后插进去的记号。Claude 认 /名字，Codex 认 $名字（agent-protocol §19） */
export type SlashList = { agent: Agent; mention?: '/' | '$'; commands: SlashCommand[]; at: number | null; stale: boolean };

// ── 会话 ────────────────────────────────────────

export type Member = {
  key: string;              // 形如 `claude:<base64url 相对路径>`，是会话的**身份**
  agent: Agent;
  providerId: string;
  rolloutId: string | null; // Codex 才有
  size: number;
  mtimeMs: number;
  parentId: string | null;  // 分叉链的父指针
  cwd: string | null;
  /**
   * 列表里归哪一组——和 App 侧栏归在同一个地方（服务端 src/titles.js 的 resolveProject）：
   * worktree 会话归原仓库，Codex 的独立聊天归一组。`key` 只用来归组和记折叠状态，
   * `name` 是组头上的字。没有目录时为 null；老服务端没有这个字段。
   */
  project?: { key: string; name: string } | null;
  firstTs: string | null;   // ISO 字符串，不是毫秒数
  lastTs: string | null;
  title: string;
  /**
   * 1 = App 里确实就叫这个名字：Claude 桌面 App 的注册表 / CLI 自己记的名字
   *     （agent-name、custom-title、ai-title）/ Codex 的线程名
   * 2 = transcript 首句推导
   * 3 = 目录名 + 日期兜底
   * 只有 1 能保证与 Claude App / Codex 里看到的一致，其余必须如实标注——
   * 「标题一致」是 owner 提的硬需求，蒙混过去等于骗人。
   */
  titleTier: 1 | 2 | 3;
  isArchived: boolean;
  /**
   * 此刻有没有轮次在跑。列表里那颗圆点靠它。
   *
   * **包括电脑上起的轮次**：桌面 App、终端里跑着的也算（服务端 src/runtime/live.js）。
   * 原来只认 Baton 自己发出去的那一轮，于是下班回家打开手机，电脑上正忙的会话
   * 看着和闲着一模一样。
   */
  running: boolean;
  /**
   * 卡在等人点确认（CLI 报的 `waiting / input needed`）。和 `running` 互斥：
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
   * 这个调用者可选的工作目录，已排序去重。
   *
   * 以前两端都是自己遍历 `chains[].members[].cwd` 凑这份列表。对 owner 恰好
   * 等价，但**访客零会话时会凑出一个空选单，压根开不了头**——而他本来就有一个
   * 工作区根目录可用。所以这份名单改由服务端按调用者给。
   *
   * 客户端据此**不需要**判断自己是 owner 还是访客：服务端已经收窄过了。
   */
  cwds: string[];
};

// ── 目录浏览 ────────────────────────────────────

export type DirEntry = {
  name: string;
  path: string;
  /**
   * false = 点进去必然失败（系统目录之类）。
   * **必须显示成不可点**——让人点了才报错是把服务端已经知道的事瞒到最后一刻。
   */
  readable: boolean;
};

export type DirListing = {
  /** 当前所在目录。**起点为 null**：那是一组入口，不是某个目录的内容。 */
  path: string | null;
  /** 上一级。**null 表示不能再往上**，UI 据此禁用「上一级」。 */
  parent: string | null;
  /** 只有目录，没有文件——这是选工作目录，不是文件浏览器。隐藏目录不过滤。 */
  dirs: DirEntry[];
};

/** `created: false` = 本来就存在且是目录。**不是错误**，照常往下走。 */
export type DirCreated = { path: string; created: boolean };

// ── 会话自己的文件树 ────────────────────────────

/**
 * 工作目录里的一条。
 *
 * 和上面 `DirEntry` 是两回事，别合并：那个是**选工作目录**用的（跨盘、只有目录、
 * 给绝对路径）；这个是**看某个会话里有什么**（锁在一棵子树里、目录和文件都有、
 * 给相对路径）。两者的边界、范围、用途都不同，合成一个类型只会让两边都别扭。
 */
export type FileEntry = {
  name: string;
  dir: boolean;
  /** 目录为 null。 */
  size: number | null;
  /** 毫秒时间戳；取不到为 null。 */
  mtime: number | null;
};

export type FileListing = {
  /** 这个会话的工作目录绝对路径，只用来显示"你在哪棵树上"。 */
  cwd: string;
  /** 当前位置，**相对工作目录**。空串就是工作目录本身。 */
  path: string;
  /** 上一级；**null 表示到顶了**——工作目录就是这个会话能看到的天花板。 */
  parent: string | null;
  /** 目录在前、文件在后，各自按名字排。点开头的不过滤。 */
  entries: FileEntry[];
};

// ── 权限档位 ────────────────────────────────────

/**
 * 权限档位的 id。**不是联合字面量**——值域由服务端给。
 *
 * 两个 harness 的档位集合根本不同（claude 有 plan，codex 有 read），而且以后还会
 * 随实测结论增减。在客户端写死一份联合类型，就是在两处维护同一个事实，
 * 而它们迟早对不上——对不上的那一天，用户会看到一个点了没反应的选项。
 */
export type PermissionMode = string;

/** 一档权限。文案与可用性全部由服务端给，客户端只负责显示。 */
export type PermissionOption = {
  id: PermissionMode;
  label: string;
  /** 讲**后果**的一句话。权限是唯一一处点错了会真损失东西的设置，不能只给名字。 */
  body: string;
  /** 破坏性的那一档，界面上要标红并二次确认。 */
  danger: boolean;
  /**
   * 这台电脑上能不能用。false 时必有 `unavailable` 说明原因。
   *
   * 目前唯一的原因是 Codex 的沙箱没做提权预置——实测那几档会**挂住**，
   * 在手机上点下去这一轮永远不会回来。所以宁可灰掉也不能让人点。
   */
  available: boolean;
  unavailable: string | null;
};

export type AgentPermission = {
  mode: PermissionMode;
  options: PermissionOption[];
};

export type Permission = {
  /**
   * 能不能改。**owner 专属**——访客一旦能开 bypass，工作区隔离当场失效
   * （一个不问就能跑 shell 的 agent，走出工作区只需要一条 cd）。
   *
   * 客户端据此把整块做成只读，但**不据此判断自己是谁**：这是服务端给的一个
   * 能力位，不是身份。别拿它去分支别的功能。
   */
  canSet: boolean;
  /** 两个 agent 各自的档位与可选集。一次给全，切 agent 时不会闪一帧旧值。 */
  agents: Record<Agent, AgentPermission>;
  /** 'ready' | 'missing' | 'unknown'。missing 时那几档是灰的，要能说清怎么修。 */
  codexSandbox: string;
};

/** `/api/health` 的响应。permissionMode 捎在这里，好让横幅和页面同时出现。 */
export type Health = {
  ok: boolean;
  deviceId?: string | null;
  principal?: { id: string; generation?: string };
  version?: string;
  allowSend: boolean;
  /** 两边各自的档位。横幅要判「有没有哪一边开着全部放行」。 */
  permissionModes: Record<Agent, PermissionMode>;
  /** 旧字段，等于 permissionModes.claude。留着是为了不逼客户端一次性全换。 */
  permissionMode: PermissionMode;
  canSetPermissionMode: boolean;
};

export type DeviceItem = {
  id: string;
  principalId: string;
  label: string;
  platform: string;
  browser: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string | null;
  current: boolean;
};

export type PairQrResult = {
  code: string;
  for: string;
  pairUrl: string;
  svg: string;
  expiresInSec: number;
  network?: { lan?: string | null; tailscale?: string | null };
};

// ── 事件 ────────────────────────────────────────

/**
 * `interrupt` —— 这一轮被人打断了。role 恒为 'system'，text 是服务端翻好的一句话
 * （src/claude.js 的 interruptOf）。**渲染时必须按 kind 分支**：会话屏原来是
 * 「不是 user 就当 agent 正文」，新 kind 掉进去就成了 agent 说的话。
 */
export type EventKind = 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'turn_end' | 'interrupt'
  /** 斜杠命令的回执（「Goal set: …」）。role 恒为 'system'，text 是原文（2026-11-10） */
  | 'command_output'
  /** /goal 的进度。text 是目标条件，goal 里是 { met, reason }（2026-11-10） */
  | 'goal';

export type ToolPayload = {
  name: string | null;
  id: string | null;
  input?: unknown;
  output?: string;
  /**
   * 只在工具结果上、且 agent 自己记下了失败时才有，值恒为 true（服务端 src/claude.js、
   * src/codex.js；依据见 docs/ops/agent-protocol.md §22）。**没有这个字段不等于成功**：
   * 老服务端不发，有些工具也根本不报成败。
   */
  failed?: true;
};

/** 出网时被截断的载荷的元数据。没有这个字段就表示没截。 */
export type Truncation = {
  output?: { totalChars: number; keptHead: number; keptTail: number };
  input?: { totalChars: number; keptHead: number; keptTail: number };
};

export type BatonEvent = {
  id: string;               // `<记录锚点>#<块序号>`，取全文时要 URL 编码（`#` → `%23`）
  ts: string | null;
  role: 'user' | 'agent' | 'system';
  kind: EventKind;
  text?: string;
  tool?: ToolPayload;
  tokens?: Record<string, number>;
  error?: string | null;
  origin?: 'sdk';           // 'sdk' 能正面证明「由程序发送」；缺失**不能**反证是手打的
  offset: number;           // transcript 里的字节偏移，取全文必须原样回传
  truncation?: Truncation;
  goal?: { met: boolean; reason: string | null; status?: string };
};

export type EventPage = {
  events: BatonEvent[];
  endOffset: number;
  nextBefore: number | null; // null = 已到最早
};

export type EventFull = {
  id: string;
  totalChars: number;
  from: number;
  to: number;
  text: string;
  hasMore: boolean;
};

// ── 轮次 ────────────────────────────────────────

/**
 * `anomaly` 不是凑数的：它是「有 token 产出却一条消息都没有」——
 * agent 被中途杀掉、输出 schema 变了、或写 transcript 失败。
 * 把它并进 failed 就等于丢掉了唯一能说清「刚才到底发生了什么」的信息。
 */
/** handoff：Codex App 开着这个会话、占着写入锁，消息交给了 App 排队（服务端 agent/codexQueue.js） */
export type TurnStatus = 'running' | 'ok' | 'failed' | 'anomaly' | 'aborted' | 'handoff' | 'unconfirmed';

export type Turn = {
  key: string;
  turnId: string;
  agent: Agent | null;
  status: TurnStatus;
  canStop?: boolean;
  stopReason?: string;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  tokens: Record<string, number> | null;
  eventCount: number;
  /** 这一轮发出去的那句话（2026-11-10 起服务端带上）。agent 写进记录之前先拿它摆出来 */
  prompt?: string;
};

export type QueuedMessage = { id: string; text: string; queuedAt: number };

/**
 * 思考强度。**两边都有。**
 *
 * 上一版这里写的是「只有 Claude 有」，那是错的——实测确认 Codex 走
 * `-c model_reasoning_effort=<级别>`（服务端 `agent/args.js` 有三条证据）。
 *
 * 可取值**逐模型不同**：gpt-6-astra 能到 ultra，gpt-5.5 封顶 xhigh，默认值也
 * 不一样。所以界面上该给哪几档来自 `ModelOption.efforts`，不是这个并集。
 * null = 没选过，跟模型自己的默认走。
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type SessionState = {
  running: boolean;
  /**
   * **电脑上**那一轮：`'busy'` 在跑 / `'waiting'` 卡在一个待确认的框 / null 没有。
   *
   * 和 `running` 分开：`running` 还管着停止按钮，而电脑上那一轮 Baton 停不了。
   * 这时发消息会排队（服务端挡着，绝不起第二个进程写同一份 transcript），
   * 所以输入框要先把话说在前头。老服务端没有这个字段。
   */
  host?: 'busy' | 'waiting' | null;
  latestTurn: Turn | null;
  queued: QueuedMessage[];
  lastEventTs: string | null;
  /** null = 没选过，跟 agent 自己的默认走。不要在客户端替它猜一个值填上。 */
  model: string | null;
  /** 同上。**两边都有**——上一版这里写「Codex 恒为 null」，那是错的。 */
  effort: Effort | null;
  agent: Agent;
  /**
   * agent 现在正等着人答的那道选择题。null = 没有。
   *
   * 必须在**状态**里而不是只走事件流：问题挂起期间用户很可能正好切走、锁屏、
   * 换网（这正是 Baton 的常态）。回来的时候要立刻知道「有人在等我」。
   */
  pendingAsk: PendingAsk | null;
};

/**
 * 一道待答的选择题。形状与服务端 src/ask/store.js 的 openAsk 一致。
 *
 * 它挂着的时候 **agent 那一轮正停在工具调用上等它**——不是「有条通知」，
 * 是「一轮卡在这儿」。界面上的分量要按这个来。
 */
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
  /** 超过这个时刻 agent 就不等了。界面上是倒计时 */
  expiresAt: number;
};

// ── 模型 ────────────────────────────────────────

/**
 * 一个可选模型。
 *
 * `id` 是进命令行的那个名字，`name` 是给人看的（`gpt-6-astra` → 「6 Astra」）。
 * 两个 App 的截图里显示的都是后者。
 */
export type ModelOption = {
  id: string;
  /** 显示名。Codex 来自目录，Claude 由 id 推导。 */
  name: string;
  /** 副标题，可能没有。 */
  desc: string | null;
  /**
   * 这台电脑的 transcript 里真跑过。**只用来排序**——常用的排前面。
   *
   * 一度拿它在界面上标「没跑过」，owner 否掉了：那预设了「用户的配置可能
   * 不对」，而配置对不对不归我们判断。我们的职责到「读对」为止。
   */
  seen: boolean;
  /** 长尾，收进「更多模型」。跑过的一律不会被藏。 */
  hidden: boolean;
  /**
   * 这个模型支持哪几档思考强度。`listed` 为 true 时空数组 = 这个模型不能调
   * （Haiku 4.5）；否则空数组 = 不知道。
   */
  efforts: Effort[];
  /** 没选过强度时实际生效的那一档，可能不知道。 */
  defaultEffort: Effort | null;
  /**
   * agent 自己的模型目录里列着它（Claude 是 Claude Code `/model` 那份，2026-11-10 起；
   * Codex 是 `codex debug models`）。为 true 时强度表是权威的。旧服务端不给。
   */
  listed?: boolean;
};

/**
 * 这台电脑上**已经配好**的东西，从 agent 自己会读的那份配置里取。
 *
 * owner 划的边界：「我们产品是直接复用用户的配置…我们只要保证正确读取用户的
 * 模型配置、思考强度、上下文窗口这些就可以了」。所以这里是**如实转述**，
 * 不做校验也不做判断。
 *
 * null = 没配。界面上「没配」和「配了正好等于默认」要显示得不一样：
 * 前者说「跟默认走」，后者要把那个值报出来。
 */
export type AgentConfig = {
  /** 配置里写死的强度，对哪个模型都生效（只有 Codex 有）。 */
  effort: Effort | null;
  /** 上下文窗口，token 数。Claude 侧没有对应的配置项，恒为 null。 */
  contextWindow: number | null;
  /**
   * 一个模型都不选时实际跑的那个。旧服务端不给这个字段，所以是可选的。
   *
   * owner：「默认模型也要显示到底是什么模型以及推理强度」。光写「默认」两个字，
   * 等于让人自己去电脑上翻——而这台电脑上翻也翻不出来：Claude 的默认
   * （Opus 5.5 · 1M 上下文 · 中）哪个配置文件里都没写，是服务端问 CLI 问出来的。
   */
  defaultModel?: DefaultModel | null;
};

export type DefaultModel = {
  id: string;
  name: string;
  /**
   * 这个默认额外带的上下文窗口，比如 Claude 默认那档是 1M。
   * null 是「没有额外那一档」，不是「不知道多大」——不报一个猜的数。
   */
  contextWindow: number | null;
  /** 它默认拿到的强度。Claude 的默认强度按模型定，换个模型就不一定是这个了。 */
  effort: Effort | null;
};

export type ModelList = {
  claude: ModelOption[];
  codex: ModelOption[];
  antigravity?: ModelOption[];
  note: string;
  config: Record<Agent, AgentConfig>;
};

export type ModelSet = {
  model: string | null;
  appliesTo: 'now' | 'next';
  note: string | null;
};

// ── 传文件 ──────────────────────────────────────

export type Upload = {
  name: string;
  bytes: number;
  path: string;
  /** 相对工作目录的路径。贴进消息里 agent 才找得到——它认路径，不认附件。 */
  relative: string;
  note: string;
};

// ── 发送 ────────────────────────────────────────

export type SendAccepted = { turnId: string; queued: false };

export type SendQueued = {
  queued: true;
  queueId: string;
  afterTurnId: string;
  queueLength: number;
  note: string;
};

export type SendResult = SendAccepted | SendQueued;

export function isSendAccepted(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  const id = receipt.queued === true ? receipt.queueId : receipt.queued === false ? receipt.turnId : null;
  return typeof id === 'string' && id.trim().length > 0;
}

// ── SSE ────────────────────────────────────────

/** 心跳。queued 捎在这里：队列没有自己的事件通道，且每 15 秒自我纠偏一次。 */
export type Tick = {
  turnId: string | null;
  running: boolean;
  elapsedMs: number;
  queued: number;
  canStop?: boolean;
  stopping?: boolean;
};

export type StreamFrame =
  | { type: 'events'; data: { events: BatonEvent[] } }
  | { type: 'turn_start'; data: Turn }
  | { type: 'turn_control'; data: Turn }
  | { type: 'turn_end'; data: Turn }
  | { type: 'tick'; data: Tick }
  /**
   * 断线太久，服务端只补回了上限之内的那一段，**中间还缺一块**。
   * 闷着补一半、装作补全了，比少补更糟——所以它会明说。
   */
  | { type: 'gap'; data: { from: number; droppedBefore: number } }
  /** agent 出了一道选择题，而且正停在那儿等回答 */
  | { type: 'ask'; data: PendingAsk }
  /** 那道题结束了：答了、超时了、或这一轮被停了 */
  | { type: 'ask_end'; data: { askId: string; key: string; reason: string } };

// ── 错误 ────────────────────────────────────────

/** 后端的错误体一律是这个形状，`fix` 是**可照做的**修复指引，直接渲染，不要自己编。 */
export type ApiError = {
  error: { code: string; message: string; fix: string };
};

// ── 两根正交的轴（原型的核心洞察）────────────────

/** agent 在不在跑 */
export type RunAxis = 'streaming' | 'silent' | 'ok' | 'fail' | 'stopped' | 'anomaly' | 'unconfirmed';

/**
 * 我还连着没。
 *
 * `offline` 与 `origin` 必须分开：手机没网（到不了 Cloudflare）与电脑睡了
 * （到得了 Cloudflare、源站不应答）对用户的意义完全不同——前者等一下就好，
 * 后者得去把电脑叫醒。
 *
 * `intercepted` 原名 `relogin`（Cloudflare Access 过期）。Access 已于 2026-09-12
 * 撤除，但这一态不能删：公司网的强制门户同样以 302 拦截，行为一模一样。
 * 改名是因为现在能确定的只是「有东西在中间拦了」，确定不了是谁。
 */
export type LinkAxis = 'ok' | 'retrying' | 'offline' | 'origin' | 'intercepted';

// ── 套餐额度（用量） ────────────────────────────

/**
 * 一个额度窗口。形状照服务端 src/usage.js 抄，和电脑网页端 web/src/api.ts 里同名类型一致。
 * `percent` 是**已用**百分比（服务端照接口原样给）；界面上显示的是剩余 = 100 - percent。
 */
export type UsageWindow = {
  id: string;
  /** 「5 小时内」「本周 · 全部模型」…服务端已经翻好 */
  label: string;
  percent: number;
  /** 什么时候重置（毫秒时间戳）。拿不到为 null */
  resetsAt: number | null;
};

export type AgentUsage =
  | {
    available: true;
    plan: string | null;
    windows: UsageWindow[];
    /** 这份数是什么时候的 */
    asOf: number | null;
    extraUsage?: boolean;
    reached?: string | null;
    /** live = 刚现问的；rollout = 问不到，退回了上一轮跑完时记下的（Codex 才会有） */
    source?: 'live' | 'rollout';
    liveError?: string;
  }
  | { available: false; reason: string; plan?: string | null };

export type Usage = { claude: AgentUsage; codex: AgentUsage; antigravity?: AgentUsage };
