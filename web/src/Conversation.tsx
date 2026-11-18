import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef} from 'react';
import { ApiError, api, type Agent, type Cut, type Ev, type PendingAsk, type Tick } from './api';
import { AskCard } from './Ask';
import { Link } from './router';
import { Icon, useMember } from './Shell';
import { Menu, copyText, keyLabel, openPalette, openShortcuts } from './ui';
import { whereLabel } from './sessions';
import { Ball } from './Ball';
import { Markdown } from './Markdown';
import { InputBox } from './InputBox';
import { FileBrowser } from './FileBrowser';
import { InfoPanel, useSessionInfo } from './InfoPanel';
import { GOAL_STATE, goalNeedsYou, goalRowTitle } from './goal';
import { useI18n } from './i18n';
import { setPrefs, usePrefs } from './prefs';
import { DraftAttachments, SentAttachments } from './Attachments';
import { attachmentSuffix, splitAttachments, isImageName, type Attachment } from './attach';
import { SessionConfig } from './SessionConfig';
import { pastedName, useFileDrop } from './useFileDrop';
import { useStickToBottom } from './useStickToBottom';
import { loadDraft, saveDraft } from './drafts';
import {
  asText, displayName, shapeInput, shapeOutput, type Section,
} from './tools';
import { beadOf, doingOf, group, kindOf, peekFor, summarize, type Step, type Tool } from './runs';
import './conversation.css';

/**
 * 会话视图。
 *
 * 事件的 kind / 字段 / 可空性实测自线上（22 个会话、1137 个事件）：
 *   tool_result 406 · tool_call 401 · text 217 · thinking 64 · turn_end 9
 *   role: agent 633 · system 415 · user 49
 *   **tool.name 有 342 个为 null**（tool_result 不带名字），渲染必须兜住
 */

/**
 * 放掉一张本地预览的 blob。
 *
 * `URL.createObjectURL` 造出来的地址会**把整份字节钉在内存里**，直到显式
 * revoke 或整个标签页关掉。发出去之后气泡走 `api.uploadUrl` 重新取图，
 * 本地这份就是死的了；撤掉的那张更是。SPA 不刷新页面，不放就是一直占着。
 */
function revokePreview(a?: { previewUri: string | null } | null) {
  if (a?.previewUri?.startsWith('blob:')) URL.revokeObjectURL(a.previewUri);
}

/*
 * 调用与结果怎么配对、一段活怎么分段、折叠行那句话怎么数——都在 runs.ts，
 * 那边是纯函数，有 test/web-runs.test.js 钉着。
 *
 * 原来这三样写在这个文件里，于是测不了；而它们恰恰是被真实数据打脸的那部分：
 * 2026-10-10 拿 transcript 对账，折叠行上的数字错了五处（见 runs.ts 抬头）。
 */

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

function cutNote(cut?: Cut): string | null {
  if (!cut) return null;
  const hidden = cut.totalChars - cut.keptHead - cut.keptTail;
  if (hidden <= 0) return null;
  return `中间省略 ${hidden.toLocaleString('zh-CN')} 字（共 ${cut.totalChars.toLocaleString('zh-CN')}）`;
}

const FULL_WINDOW = 24_000;

/**
 * 折叠块里的一份载荷（输入或输出），带截断提示与取全文。
 *
 * `shape` 由调用方给：输入那份知道工具叫什么名字（Bash 的「命令」和 Edit 的
 * 「删去/换成」是两回事），输出那份不需要。
 *
 * 取回全文之后**重新整形一次**，不是特例是同一条路径：全文是完整的
 * `JSON.stringify` 输出，能解析；而截断态是被切断的半截 JSON，解析失败自然
 * 退回原样显示。两种情况共用 `shape`，不需要各写一遍。
 */
function Payload({
  value, cut, shape, sessionKey, eventId, offset,
}: {
  value: unknown;
  cut?: Cut;
  shape: (v: unknown) => Section[];
  sessionKey: string;
  eventId: string;
  offset: number;
}) {
  const [full, setFull] = useState<{ text: string; to: number; total: number; more: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const note = cutNote(cut);

  // 整形不便宜（可能要 parse 一段几十 KB 的 JSON），而展开态每次重渲染都会走到
  const sections = useMemo(() => shape(full ? full.text : value), [shape, full, value]);

  async function load(from: number) {
    setLoading(true);
    setErr(null);
    try {
      const c = await api.eventFull(sessionKey, eventId, { offset, from, to: from + FULL_WINDOW });
      setFull((p) => ({ text: (p?.text ?? '') + c.text, to: c.to, total: c.totalChars, more: c.hasMore }));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setLoading(false);
    }
  }

  if (sections.length === 0 && !note) return null;

  return (
    <div className="payload">
      {sections.map((s, i) =>
        // 短标量与标题同一行，省掉一整个代码块的垂直开销
        s.kind === 'inline' ? (
          <p className="payload-inline" key={`${s.label}-${i}`}>
            <span className="payload-label">{s.label}</span>
            <code>{s.text}</code>
          </p>
        ) : (
          <div className={`seg-${s.kind}`} key={`${s.label}-${i}`}>
            <div className="payload-label">{s.label}</div>
            {s.kind === 'note' ? (
              <p className="payload-note">{s.text}</p>
            ) : (
              <pre className="payload-body">
                <code>{s.text}</code>
              </pre>
            )}
          </div>
        ),
      )}

      {/* 截断必须说出来，而且要给得出去的路：实测单条能省掉 34 万字 */}
      {note && !full && (
        <p className="payload-cut">
          {note}
          <button type="button" className="mini" onClick={() => load(0)} disabled={loading}>
            {loading ? '正在取…' : '看全文'}
          </button>
        </p>
      )}
      {full && (
        <p className="payload-cut">
          已显示 {full.to.toLocaleString('zh-CN')} / {full.total.toLocaleString('zh-CN')} 字
          {full.more && (
            <button type="button" className="mini" onClick={() => load(full.to)} disabled={loading}>
              {loading ? '正在取…' : '再来一段'}
            </button>
          )}
        </p>
      )}
      {err && (
        <p className="payload-cut is-err">
          {err.message} {err.fix}
        </p>
      )}
    </div>
  );
}

function ToolBlock({ item, sessionKey }: { item: Tool; sessionKey: string }) {
  const [open, setOpen] = useState(false);
  const { call, result } = item;
  // 实测 342/1137 的 tool.name 是 null
  const rawName = call.tool?.name;
  const input = call.tool?.input;
  const name = displayName(rawName);
  // 那一截和全路径都按 runs.ts 认：截断过的半截 JSON、补丁原文、exec 那段 JS 也说得出是哪个文件、哪条命令
  const { text: peek, path: fullPath } = peekFor(rawName, input);
  const outLen = asText(result?.tool?.output).length;

  // shape 要进 useMemo 的依赖，每次渲染新建一个函数会让整形白跑
  const shapeIn = useCallback((v: unknown) => shapeInput(rawName, v), [rawName]);

  return (
    <div className={`tool${open ? ' is-open' : ''}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {/* 珠子落在左边那条时间线上：一段活里的每一步，按发生的先后串起来 */}
        <Bead tool={item} live={!result} />
        <span className="tool-name">{name}</span>
        <span className="tool-peek" title={fullPath ?? undefined}>{peek}</span>
        {/*
          没有结果 = 这一步还在跑。成败**不猜**，只认服务端给的 tool.failed——那是 agent 自己
          记下的（Claude 的 is_error，Codex 结果开头的 Exit code / Script failed，
          docs/ops/agent-protocol.md §22）。原来这里写着「输出里没有可靠的成败标记」：
          标记其实一直在 transcript 里，只是服务端没传下来
        */}
        {!result ? (
          <span className="tool-state is-live">运行中</span>
        ) : result.tool?.failed ? (
          <span className="tool-state is-fail">失败</span>
        ) : outLen > 0 ? (
          <span className="tool-state">{outLen.toLocaleString('zh-CN')} 字</span>
        ) : null}
        <span className={`chev${open ? ' is-open' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="tool-detail">
          {/* 路径在折叠行上是缩写的，展开后给全的——复制粘贴要的是全路径 */}
          {fullPath && <p className="tool-path">{fullPath}</p>}
          <Payload
            value={input} cut={call.truncation?.input} shape={shapeIn}
            sessionKey={sessionKey} eventId={call.id} offset={call.offset}
          />
          {result && (
            <Payload
              value={result.tool?.output} cut={result.truncation?.output} shape={shapeOutput}
              sessionKey={sessionKey} eventId={result.id} offset={result.offset}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 一次工具调用的珠子。形状说是哪一类（读 / 改 / 命令 / 提问），
 * 还没结果的那颗是蓝的、在呼吸。样式与图例在 shared.css 的 `.bead`。
 *
 * 分类用 runs.ts 的 kindOf——和折叠行那句话**是同一套**。原来珠子看 tools.ts 的
 * family()、句子自己另列名单，于是 PowerShell 画成了命令的三角，句子里却没算成命令。
 */
function Bead({ tool, live }: { tool: Tool; live: boolean }) {
  const kind = beadOf(kindOf(tool.call.tool?.name, tool.call.tool?.input));
  return <i className={`bead is-${kind}${live ? ' is-live' : ''}`} aria-hidden="true" />;
}

/* ── 每条回复的收尾 ───────────────────────────────────────────────────────── */

/**
 * agent 每条回复底下：左边那颗球（署名）+ 右边的复制。照手机端的 `TurnFoot` 来。
 *
 * 那边的注释记了三条 owner 点名改过的事，两条在这里同样成立：
 *
 * **每条都有，不是整屏一个。** 原来手机端只在滚动区末尾挂一个，于是往回翻的时候
 * 每条回复底下都空着——而「复制上一条」恰恰是往回翻时才需要的动作。
 *
 * **不做「重发」。** 它到底该重跑哪一轮、会不会覆盖已有的回复，答不上来；
 * 一个答不上来的按钮不该留在界面上。
 *
 * 第三条（「只在轮次真的结束后才给」）在网页端不需要：手机端那版是流式渲染，
 * 正在写的那条复制到的是半截。这里的事件来自 transcript 的整行，`text` 事件
 * 到手时本身就是完整的一条，不存在半截。
 */
/**
 * 一轮的状态栏。**一轮只有一条，在整轮的最末尾。**
 *
 * owner 截图指出来的病：原来每条 agent 正文后面都挂一个 foot，于是那颗球夹在
 * 一轮对话的中间，而且和「复制」挤在同一行。他要的是——
 *
 *   球是**状态提示栏的开头标识**；跑着的时候这一行显示各种运行状态
 *   （开始、正在读写文件…），跑完了球静止下来、这一行才给出动作。
 *
 * 所以这是**同一条**在两种状态间切换，不是两个组件各画一次。
 * App 端 50f9ae7 已经这么改过，这边是把同一个设计补上。
 *
 * ## 它是这一页**唯一**的状态行
 *
 * owner 2026-10-10：「下面有三个状态显示，只要保留 bash 左边那个就行了」。原来输入区
 * 上方还有一行「运行中 2818s 停止」——和这里的 46:58 是同一个数，换个单位又说了一遍；
 * 配置条也挤在那儿。现在：停止并进发送键（见 InputBox），配置条挪到输入框底下，
 * 排队的条数并进这一行。Claude Code 桌面版也是这样：只有一行「2m 5s · Almost done thinking…」。
 */
function TurnBar({ text, running, elapsedMs, tickAt, doing, queued }: {
  /** 这一轮最后一条 agent 正文，给「复制」用。跑着的时候没有可复制的完整内容。 */
  text: string | null;
  running: boolean;
  /** 服务端最近一次报的已跑时长，以及收到它的那一刻（本地钟） */
  elapsedMs: number;
  tickAt: number;
  /** 「在干什么」，见 runs.ts 的 doingOf。没有就退回「正在跑」——不编一个动作出来。 */
  doing: string | null;
  /** 还排着几条没发。它没有自己的事件，搭 tick 捎来（src/http/handlers/sessions.js） */
  queued: number;
}) {
  const [said, setSaid] = useState<'已复制' | '复制不了' | null>(null);

  /*
    秒表本地每秒走一格，权威是服务端的 tick。

    tick 是搭心跳走的，**15 秒才来一次**（src/http/sse.js）。原来直接显示 tick 里的数，
    于是这一行 15 秒跳一格。sse.js 抬头写的本来就是「客户端本地 1 Hz 走秒」——补上。

    两个心跳都没等到 tick，说明这条流已经名存实亡：停在那儿、变灰，
    「而不是继续欢快地数下去骗人」（同一段注释）。
  */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const since = Math.max(0, now - tickAt);
  const stale = since > STALE_MS;
  const shown = elapsedMs + Math.min(since, STALE_MS);
  const line = queued > 0 ? ` · 还有 ${queued} 条排着` : '';

  /**
   * **等写入真的成功再说「已复制」。**
   *
   * 不等就报成功是在撒谎，而这条谎话特别贵：人以为复制到了，去别处粘贴，
   * 粘出来的是上一次剪贴板里的东西——而他不会怀疑是这里骗了他。
   *
   * 会失败的情形是实在的：非安全上下文、被 permissions policy 掐掉、
   * 或者浏览器压根没有 `navigator.clipboard`（旧内核、某些内嵌 WebView）。
   */
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(text ?? '');
      setSaid('已复制');
    } catch {
      setSaid('复制不了');
    }
    // 复制本身没有任何视觉结果，不给反馈人只能去别处粘一下才知道成没成
    setTimeout(() => setSaid(null), 1400);
  }

  /**
   * **两行，不是一行。**
   *
   * owner 说过两次，我上一轮才改对一半：「logo 是在更下面一点，并不是和复制
   * 同行」「logo 是放在复制行下面一行的」。
   *
   *   第一行   动作（复制）——它属于**上面那条回复**，是对内容的操作
   *   第二行   状态（球 + 在干什么）——它属于**这一轮**，是过程的收尾标识
   *
   * 两件事不同层，挤一行就分不清那颗球到底在说哪一条。跑着的时候没有完整内容
   * 可复制，所以只有第二行。
   */
  return (
    <div className="turnfoot">
      {!running && text !== null && (
        <div className="turnfoot-acts">
          <button
            type="button"
            className={`turnbar-copy${said === '复制不了' ? ' is-err' : ''}`}
            onClick={copy}
            title={said ?? '复制'}
            aria-label={said ?? '复制'}
          >
            <CopyIcon />
            {said && <span className="turnbar-said">{said}</span>}
          </button>
        </div>
      )}
      <div className={`turnbar${running ? ' is-live' : ''}`}>
        {/*
          跑着：转、速度线一道道闪（.ball-live）。停下：落地压扁再弹回（.ball-land）。
          落地那一下是纯 CSS 触发的——类名从 live 换成 land，动画名就换了，
          浏览器自己会重放，不需要在 effect 里记「上一刻是不是在跑」。
          进会话那一刻它也会落一次地：像是那颗球刚被放到这儿。
        */}
        <span className={`turnbar-ball${running ? ' ball-live' : ' ball-land'}`} aria-hidden="true">
          <Ball size={17} />
        </span>
        {running ? (
          <span className={`turnbar-what${stale ? ' is-stale' : ''}`}>
            <span className="turnbar-time">{clock(shown)}</span> · {doing ?? '正在跑'}{line}
          </span>
        ) : queued > 0 ? (
          <span className="turnbar-what">还有 {queued} 条排着</span>
        ) : null}
      </div>
    </div>
  );
}

/** 两个心跳（2 × 15 秒）再宽限 5 秒，还没等到 tick 就不再往前数 */
const STALE_MS = 35_000;

/** 两个叠着的圆角方块。照搬手机端 IconCopy 的路径，两端是同一个图形。 */
function CopyIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V5a2 2 0 012-2h8" />
    </svg>
  );
}

/** 46:58、1:02:03。一轮跑上一小时并不稀奇（截图里那条 46 分钟），「62:03」得心算 */
function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * 两段正文之间的那段活。**默认折起来，一行**。
 *
 * 展开后才是那一条条的 ToolBlock 和思考。这一层存在的理由只有一个：正文才是人来看的，
 * 工具活动是过程——过程应该能查，但不该默认占着屏幕。
 *
 * 同类产品是怎么折的（2026-10-10 查过源码与实物）：
 *
 *   Claude 桌面版   两段正文之间一行「Ran 2 commands, used 4 tools ›」，思考不单独占行
 *   Claude Code     把读 / 搜 / 列目录并成一行「Searched for 2 patterns, read 3 files」，
 *                   每段活动统计思考时长与调用次数
 *   Codex CLI       开源（codex-rs/tui）：连续的读 / 列 / 搜并成一个「Explored」块，
 *                   命令各自一个「Ran」块，输出掐头去尾留「… +N lines」
 *   Gemini CLI      开源：一轮的工具调用框在同一个圆角框里，紧凑模式下一个工具一行
 *
 * 这里取的是 Claude 桌面版那种（owner 拿它对照着看的），数法照 Claude Code 的。
 */
function RunBlock({ steps, sessionKey }: { steps: Step[]; sessionKey: string }) {
  const [open, setOpen] = useState(false);
  const { locale } = useI18n();
  const tools = steps.flatMap((s) => (s.t === 'tool' ? [s.tool] : []));
  return (
    <div className={`run${open ? ' is-open' : ''}`}>
      <button type="button" className="run-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {/*
          折起来时**只有一句话**，前面不摆珠子。

          上一版折起来时是一串珠子，一次调用一颗。owner 2026-10-10：「把折叠前面这些
          符号去掉，有的过程太长，这些堆叠起来很难看」——一段活动辄十几二十次调用，
          那串珠子比后面那句话还长，而它说的东西那句话已经说了。Claude 桌面版的
          折叠行也只有字：「Ran 2 commands, used 4 tools ›」。

          展开后每一行前面那一颗还在：它们一行一颗，是时间线上的刻度，不会堆在一起。
        */}
        <span className="run-sum">{summarize(tools, locale)}</span>
        <span className={`chev${open ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="run-body">
          {steps.map((s) =>
            s.t === 'tool'
              ? <ToolBlock key={s.tool.id} item={s.tool} sessionKey={sessionKey} />
              : <ThinkStep key={s.ev.id} text={s.ev.text} sessionKey={sessionKey} />,
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 时间线上的一段思考。标记是「∴」——Claude Code 的 TUI 里思考就是这个符号。
 *
 * 折起来时给出第一句，读者不用点开就知道它当时在想什么方向。
 */
function ThinkStep({ text, sessionKey }: { text: string; sessionKey: string }) {
  const first = text.replace(/\s+/g, ' ').trim();
  return (
    <details className="think think-step">
      <summary>
        <i className="bead is-think" aria-hidden="true">∴</i>
        <span className="think-label">思考</span>
        <span className="think-peek">{first}</span>
      </summary>
      <Markdown text={text} sessionKey={sessionKey} />
    </details>
  );
}

/* ── 单条事件 ─────────────────────────────────────────────────────────────── */

function EventRow({ ev, sessionKey }: { ev: Ev; sessionKey: string }) {
  switch (ev.kind) {
    case 'text': {
      /*
        正文末尾那段附件清单**是写给 agent 的，不该给人看**
        （owner：「不要带上那个"附件：已放在"那个是给 agent 看的不是给我看的」）。
        手机端一直是这么切的；网页端到 2026-09-24 之前没有这段逻辑，于是从手机
        发过来的每一条带附件的消息，在电脑上都会多出一坨
        `附件（已放在工作目录下）：\n- .baton-uploads/…（314 KB）` 的纯文本。

        只对用户那一侧切：agent 的正文里出现同样的行是它自己写的，不能动。
      */
      const { body, files } = ev.role === 'user'
        ? splitAttachments(ev.text)
        : { body: ev.text, files: [] };

      // 用户那句是气泡靠右；agent 的是整幅文档靠左——它常常是长文加代码，
      // 塞进气泡会被挤成一条细带
      return (
        <div className={`msg msg-${ev.role}`}>
          <div className="msg-body">
            {body.trim() && <Markdown text={body} sessionKey={sessionKey} />}
            <SentAttachments files={files} sessionKey={sessionKey} />
          </div>
        </div>
      );
    }

    case 'thinking':
      return (
        <details className="think">
          <summary>思考</summary>
          <Markdown text={ev.text} sessionKey={sessionKey} />
        </details>
      );

    case 'tool_result':
      // 配不上对的孤儿结果（tool.id 缺失时）也要能显示，不能吞掉。
      // 这里也走整形：Claude 的内容块数组不拆开的话，这一行就是一串 `[{"type":…`
      return (
        <div className="tool is-orphan">
          <div className="tool-head as-text">
            <span className="tool-name">结果</span>
            <span className="tool-peek">{shapeOutput(ev.tool?.output)[0]?.text.replace(/\s+/g, ' ').trim().slice(0, 160) ?? ''}</span>
          </div>
        </div>
      );

    case 'turn_end':
      // 正常结束不占行——它对读者没有信息。只有出错才说话。
      // error 是字符串（见 api.ts 里 turn_end 那段）；原来读的是 .message，永远是「未知原因」
      return ev.error ? (
        <p className="turn-err" role="alert">
          这一轮出错了：{ev.error}
        </p>
      ) : null;

    case 'interrupt':
      /*
        这一轮被人打断了。原来它是一个**用户气泡**，写着
        `[Request interrupted by user]`——CLI 写进 transcript 的标记，没有人打过这句话。
        现在是一行小字，和顶上「会话从这里开始」同一个分量：它是这段记录的一条边界，
        不是谁说的话。不上色——这套界面只有那颗球是蓝的，而「被打断」也不是故障。
      */
      return <p className="interrupt">{ev.text}</p>;

    case 'command_output':
      /*
        斜杠命令的回执。短的（「Goal set: …」「Set model to …」）一行小字；长的
        （/context 那张整表）折起来，点开是原文的 Markdown。都不是谁说的话，不做成气泡。
      */
      return ev.text.includes('\n') || ev.text.length > 160 ? (
        <details className="cmdout">
          <summary>{ev.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) ?? '命令输出'}</summary>
          <Markdown text={ev.text} sessionKey={sessionKey} />
        </details>
      ) : (
        <p className="cmdout is-line">{ev.text}</p>
      );

    case 'goal':
      // /goal 的进度。达成是个结论，用对勾；没达成是「被打回去接着干」，不是故障
      return (
        <div className={`goalrow${ev.goal.met ? ' is-met' : ''}`}>
          <span className="goalrow-mark" aria-hidden="true">{ev.goal.met ? '✓' : ev.goal.status === 'active' ? '◎' : '↻'}</span>
          <div className="goalrow-text">
            <strong>{goalRowTitle(ev.goal, ev.text)}</strong>
            {ev.text && <span className="goalrow-cond">{ev.text}</span>}
            {ev.goal.reason && <span className="goalrow-why">{ev.goal.reason}</span>}
          </div>
        </div>
      );

    default:
      return null;
  }
}

/* ── 头部 ─────────────────────────────────────────────────────────────────── */

function ConvHead({ sessionKey, onFiles, infoOpen, onToggleInfo }: {
  sessionKey: string; onFiles?: () => void; infoOpen?: boolean; onToggleInfo?: () => void;
}) {
  const m = useMember(sessionKey);
  const { t } = useI18n();
  const exportMarkdown = () => {
    const a = document.createElement('a');
    a.href = api.exportUrl(sessionKey);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <header className="conv-head">
      <Link to="/" className="conv-back" aria-label={t('conv.back')}>
        ←
      </Link>
      <div className="conv-id">
        <span className="conv-title">{m?.title ?? ' '}</span>
        {m && (
          <span className="conv-sub">
            <span className="conv-agent">{m.agent}</span>
            {m.cwd && <span>{whereLabel(m)}</span>}
          </span>
        )}
      </div>
      {onFiles && (
        <button type="button" className="conv-files" onClick={onFiles}>
          {t('conv.files')}
        </button>
      )}
      {onToggleInfo && (
        <button
          type="button"
          className={`conv-panel${infoOpen ? ' is-on' : ''}`}
          onClick={onToggleInfo}
          aria-pressed={infoOpen}
          aria-label={infoOpen ? t('conv.panelClose') : t('conv.panelOpen')}
          title={infoOpen ? t('conv.panelClose') : t('conv.panelTitle')}
        >
          <Icon name="panel" />
        </button>
      )}
      <Menu
        label={t('shell.sessionActions')}
        align="end"
        items={[
          { label: t('shell.copyLink'), onSelect: () => copyText(window.location.href, t('shell.copiedLink')) },
          { label: t('shell.openNewTab'), onSelect: () => window.open(window.location.href, '_blank', 'noopener') },
          { label: t('conv.exportMd'), onSelect: exportMarkdown },
          ...(onFiles ? [{ label: t('conv.files'), onSelect: onFiles }] : []),
          'sep',
          { label: `${t('palette.label')}…`, hint: keyLabel('mod+k'), onSelect: openPalette },
          { label: t('shell.shortcuts'), hint: keyLabel('mod+/'), onSelect: openShortcuts },
        ]}
        trigger={(p) => (
          <button type="button" {...p} className="conv-more" aria-label={t('shell.sessionActions')} title={t('shell.sessionActions')}>
            <Icon name="more" />
          </button>
        )}
      />
    </header>
  );
}

/* ── 传球 ─────────────────────────────────────────────────────────────────── */

/**
 * 发出去的那一下：一颗球从发送键抛出去，落在这一轮末尾那颗球上。
 *
 * 这是整页唯一一个「编排」的动作，而且**只回应人的动作**——发送成功之后才抛，
 * 不是按下就抛：只读模式下服务端会 403，那时候抛出去一颗球就是在撒谎。
 * 它要说的正是这个产品的名字：棒交出去了，现在轮到 agent。
 *
 * 轨迹是真的抛物线：二次贝塞尔的横坐标随 t 线性走、纵坐标随 t 二次变化，
 * 恰好就是匀速横移 + 匀加速下落。所以关键帧按 t 均匀取点、用 linear 串起来，
 * 不需要任何缓动曲线去「模仿」重力。
 *
 * 几种情况直接不抛：减少动效；落点不在视野里（人正往上翻着看历史）；
 * 这条会话还没有任何事件（状态栏还不存在）。都只是少一个动画，发送本身不受影响。
 */
function tossToTurn(conv: HTMLElement | null) {
  if (!conv || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = conv.querySelector('.composer .send');
  const to = conv.querySelector<HTMLElement>('.turnbar-ball');
  const view = conv.querySelector('.conv-scroll');
  if (!from || !to || !view) return;

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const h = conv.getBoundingClientRect();
  if (b.top < v.top || b.bottom > v.bottom) return;

  const x0 = a.left + a.width / 2 - h.left;
  const y0 = a.top + a.height / 2 - h.top;
  const x1 = b.left + b.width / 2 - h.left;
  const y1 = b.top + b.height / 2 - h.top;
  // 抛得越远弧越高，但封顶：再高就飞出纸面了
  const lift = Math.min(150, Math.max(60, Math.hypot(x1 - x0, y1 - y0) * 0.22));
  const cx = (x0 + x1) / 2;
  const cy = Math.min(y0, y1) - lift * 2;

  const frames: Keyframe[] = [];
  const N = 20;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const q = 1 - t;
    const x = q * q * x0 + 2 * q * t * cx + t * t * x1;
    const y = q * q * y0 + 2 * q * t * cy + t * t * y1;
    // 出手时小一点，空中是整颗，落地前一帧压扁——接住的那一下
    const s = t < 0.15 ? 0.55 + t * 3 : 1;
    frames.push({ transform: `translate(${x}px, ${y}px) scale(${s})`, opacity: 1 });
  }
  frames.push({ transform: `translate(${x1}px, ${y1 + 2}px) scale(1.3, 0.7)`, opacity: 0 });

  const dot = document.createElement('span');
  dot.className = 'toss-dot';
  dot.setAttribute('aria-hidden', 'true');
  conv.appendChild(dot);
  const flight = dot.animate(frames, { duration: 640, easing: 'linear', fill: 'forwards' });
  flight.onfinish = () => {
    dot.remove();
    // 接住：状态栏那颗球被砸得往下一沉、再弹回来
    to.animate(
      [
        { transform: 'none' },
        { transform: 'translateY(2px) scale(1.22, 0.8)', offset: 0.35 },
        { transform: 'translateY(-2px) scale(0.95, 1.05)', offset: 0.7 },
        { transform: 'none' },
      ],
      { duration: 420, easing: 'ease-out' },
    );
  };
  flight.oncancel = () => dot.remove();
}

/* ── 没跑成的轮次 ─────────────────────────────────────────────────────────── */

const DISMISSED_KEY = 'baton.dismissedFails';

function dismissedFails(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function dismissFail(turnId: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([turnId, ...dismissedFails()].slice(0, 50)));
  } catch {
    // 存不下就只在这一次里不显示
  }
}

/* ── 会话缓存 ─────────────────────────────────────────────────────────────── */

/**
 * 离开过的会话留在内存里，回来先原样摆出来。
 *
 * owner：「打开这个对话然后去看设置页又回来后好像要重新加载」。原因是 `<Conversation key={key}>`
 * 一离开就整个卸载，回来从空白开始：重拉最新 60 条、滚到底，往上翻过的历史也没了。
 *
 * 现在卸载时把事件、翻到哪了、运行状态、滚动位置记下来（只在这个标签页的内存里，最多 12 个会话），
 * 回来先摆缓存，再在后台拉最新一页接上（mergeLatest）。流（SSE）照常重连，它推来的按 id 去重。
 */
type Cached = {
  events: Ev[];
  before: number | null;
  tick: (Tick & { at: number }) | null;
  ask: PendingAsk | null;
  scrollTop: number;
  atBottom: boolean;
};
const CACHE = new Map<string, Cached>();
const CACHE_MAX = 12;

function remember(key: string, v: Cached) {
  CACHE.delete(key);
  CACHE.set(key, v);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
}

/**
 * 新拉到的最新一页并进缓存里的那段。
 *
 * 从这一页第一条在缓存里出现的位置接上：前面是缓存里更早的（包括往上翻出来的历史），后面换成
 * 这一页。找不到那一条，说明离开期间来了一整页以上，缓存和现在之间有一道缺口——回 null，
 * 由调用方整段换成新的（宁可丢掉往上翻过的，也不拼出一段中间少了东西的对话）。
 */
function mergeLatest(cached: Ev[], page: Ev[]): Ev[] | null {
  if (!page.length) return cached;
  const at = cached.findIndex((e) => e.id === page[0].id);
  if (at < 0) return null;
  // 流在这期间推来的、比这一页还新的，接在最后，别丢了
  const last = cached.findIndex((e) => e.id === page[page.length - 1].id);
  const newer = last >= 0 ? cached.slice(last + 1) : [];
  return [...cached.slice(0, at), ...page, ...newer];
}

/* ── 主体 ─────────────────────────────────────────────────────────────────── */

export function Conversation({ sessionKey }: { sessionKey: string }) {
  const { locale } = useI18n();
  const isEn = locale === 'en';
  // 只在挂载那一刻看一次缓存：之后的状态归这个实例自己管
  const [hit] = useState(() => CACHE.get(sessionKey) ?? null);
  const [events, setEvents] = useState<Ev[]>(hit?.events ?? []);
  const [before, setBefore] = useState<number | null>(hit?.before ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** 往前翻失败了：顶上那一行换成「点这里重试」，不再自己反复去取（见 loadOlder） */
  const [olderErr, setOlderErr] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ready, setReady] = useState(!!hit);
  // `at`：收到这一帧的本地时刻。状态栏的秒表从它往前走（见 TurnBar）
  const [tick, setTick] = useState<(Tick & { at: number }) | null>(hit?.tick ?? null);
  // 草稿按会话存在这个组件之外：切会话会整个重挂载它，存在这里就丢了（见 drafts.ts）
  const [draft, setDraftState] = useState(() => loadDraft(sessionKey));
  const setDraft = useCallback((v: string) => {
    setDraftState(v);
    saveDraft(sessionKey, v);
  }, [sessionKey]);
  const [sendErr, setSendErr] = useState<ApiError | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  /**
   * 已经传上去、等着随下一条消息发出的附件。
   *
   * 和手机端同一个模型：传完挂在输入框上方，路径在**发送那一刻**才拼到正文
   * 末尾。撤掉只是「不带上」——文件已经在那台电脑的 .baton-uploads/ 里了。
   */
  const [atts, setAtts] = useState<Attachment[]>([]);
  /** 文件浏览器开着没有。每次打开都从工作目录根重新拉，见 FileBrowser。 */
  const [files, setFiles] = useState(false);
  /**
   * 目标模式：输入框里写的那句发出去就是目标（2026-11-11）。照 Codex App / Claude Desktop：点「目标」进来，
   * 写下要达成的条件，发出去 agent 就一直干到满足为止。发出去或再点一下「目标」就退出
   */
  const [goalMode, setGoalMode] = useState(false);
  /*
    右侧「信息」窗格。宽屏是并排的一列，开没开记在偏好里（换会话、刷新都保持）；
    窄屏是盖住对话的抽屉，默认收着、也不记——不然一进会话就被它挡住
  */
  const prefs = usePrefs();
  const wide = useWide();
  const [narrowInfo, setNarrowInfo] = useState(false);
  const infoOpen = wide ? prefs.infoPanel : narrowInfo;
  const toggleInfo = () => (wide ? setPrefs({ infoPanel: !prefs.infoPanel }) : setNarrowInfo((v) => !v));

  /**
   * 状态栏要的两个派生值。都从已有的 events 里算，**不新增任何请求**。
   *
   * `doing` 是「它此刻在干什么」的一句人话（runs.ts 的 doingOf）；说不出来时留 null，
   * 由 TurnBar 退回「正在跑」——不编一个具体动作出来。
   */
  const lastAgentText = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.kind === 'text' && e.role === 'agent') return e.text;
    }
    return null;
  }, [events]);
  const doing = useMemo(() => doingOf(events), [events]);
  const items = useMemo(() => group(events), [events]);
  const [forked, setForked] = useState(false);
  // agent 正在等回答的那道选择题。挂着的时候那一轮是停住的，不是在跑
  const [ask, setAsk] = useState<PendingAsk | null>(hit?.ask ?? null);
  /** 最近一轮没跑成：原因，以及（如果是这个页面发的）那条消息的原文 */
  const [failed, setFailed] = useState<{ turnId: string; error: string; text: string | null; handoff?: boolean } | null>(null);
  const sentTurns = useRef(new Map<string, string>());
  /** 按下发送那一刻摆出来的那条，在服务端回话前用的临时编号 */
  const localSeq = useRef(0);
  /**
   * 刚发出去、agent 还没写进会话文件的那句话。
   *
   * owner 2026-11-10：「消息点击发送后，先出现正在思考的那个动画，但是我的消息并没有出现在
   * 消息会话窗口中，而是过了一会才显示，并且跳到那个动画上方」。消息要等 agent 进程起来、
   * 自己写进 transcript 才有，好几秒；`turn_start` 是当场到的。所以先把这句摆出来，
   * 等真的那条到了再撤掉——两者一模一样，换的那一下看不出来。
   *
   * 两个来源：服务端的 `turn_start` 带着原文（别的设备发的也有），以及这个页面自己发送的回包
   * （谁先到用谁）。「真的那条到了」怎么认：
   *   startedAt 有值   这一轮开始之后写下的用户消息。两个时间都是**电脑上**的钟（轮次开始时刻、
   *                    agent 写的时间戳），手机钟不准也不受影响；不比文字——斜杠命令会被改写
   *   startedAt 没有   发送那一刻已有的用户消息之外，多出来的那条
   */
  const [echo, setEcho] = useState<{
    turnId: string; text: string; startedAt: number | null; baseline: Set<string> | null;
  } | null>(null);
  const echoShown = useMemo(() => {
    if (!echo) return null;
    const landed = events.some((e) => e.kind === 'text' && e.role === 'user'
      && (!echo.baseline || !echo.baseline.has(e.id))
      && (echo.startedAt === null || (Date.parse(e.ts) || 0) >= echo.startedAt - 2000));
    return landed ? null : echo;
  }, [echo, events]);

  const { ref: scroller, onScroll: onStickScroll, scrollToBottom, restoreTo, showJump } = useStickToBottom<HTMLDivElement>();

  /*
    不在这里把 events / ready / err 清回初值：调用处是 `<Conversation key={key}>`，
    切会话就**整个重挂载**（main.tsx 那段注释），所以同一个实例里 sessionKey 永远
    不变，这三个 state 进来时本来就是初值。原来那三行只在挂载时跑一次、设的值和
    初值一模一样——是死代码，而且正是 set-state-in-effect 报的那条。
  */
  // 卸载时要用到的最新值。挂在 ref 上，卸载那一刻 state 已经读不到了
  const live = useRef<{ events: Ev[]; before: number | null; tick: Cached['tick']; ask: PendingAsk | null }>({
    events, before, tick, ask,
  });
  useEffect(() => {
    live.current = { events, before, tick, ask };
  });
  // 滚动位置在滚动时就记下：卸载时 scroller 的 ref 可能已经被摘掉了
  const lastScroll = useRef({ top: hit?.scrollTop ?? 0, atBottom: hit?.atBottom ?? true });
  useEffect(() => () => {
    const v = live.current;
    if (v.events.length) remember(sessionKey, { ...v, scrollTop: lastScroll.current.top, atBottom: lastScroll.current.atBottom });
  }, [sessionKey]);

  useEffect(() => {
    let alive = true;
    api
      .events(sessionKey, { limit: 60 })
      .then((page) => {
        if (!alive) return;
        // 有缓存：接上；接不上（中间有缺口）就整段换成这一页
        const merged = hit ? mergeLatest(live.current.events, page.events) : null;
        if (merged) {
          setEvents(merged);
        } else {
          setEvents(page.events);
          setBefore(page.nextBefore);
        }
        setReady(true);
      })
      .catch((e: ApiError) => {
        if (!alive) return;
        if (e.status === 401) window.location.href = '/pair';
        else setErr(e);
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [sessionKey, hit]);

  // 首帧就落到底部，不做平滑：进来时本来就该在最新处，
  // 让人看着页面自己往下爬一遍纯粹是等待。用 layout effect 避免先闪一下顶部。
  // 从缓存回来、而且上次不在底部：回到上次读到的地方，而不是一进来就被拽到最新处
  const restoring = useRef(hit && !hit.atBottom ? hit.scrollTop : null);
  useLayoutEffect(() => {
    if (!ready) return;
    const top = restoring.current;
    restoring.current = null;
    if (top !== null) {
      restoreTo(top);
      return;
    }
    scrollToBottom('auto');
  }, [ready, sessionKey, scrollToBottom, restoreTo]);

  useEffect(() => {
    const es = api.stream(sessionKey);

    es.addEventListener('events', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { events: Ev[] };
      setEvents((prev) => {
        // 按 id 去重：重连时服务端会把最近一段再推一遍
        const seen = new Set(prev.map((x) => x.id));
        const add = data.events.filter((x) => !seen.has(x.id));
        return add.length ? [...prev, ...add] : prev;
      });
    });

    es.addEventListener('tick', (e) => setTick({ ...(JSON.parse((e as MessageEvent).data) as Tick), at: Date.now() }));
    const onTurn = (e: Event) => {
      const t = JSON.parse((e as MessageEvent).data) as {
        turnId: string; status: string; startedAt: number; endedAt?: number | null; error?: string | null;
        prompt?: string;
      };
      // 这一轮发的那句话，先摆出来（见 echo）。一轮结束就撤：正常的话真的那条早到了；
      // 没跑成的话，失败提示条会把原文亮出来、能放回输入框
      if (t.status === 'running' && t.prompt) {
        setEcho({ turnId: t.turnId, text: t.prompt, startedAt: t.startedAt, baseline: null });
      } else if (t.status !== 'running') {
        setEcho((prev) => (prev?.turnId === t.turnId ? null : prev));
      }
      /*
        一轮没跑成，要在这里说出来。原来 turn_end 只拿来停秒表：agent 自己写进 transcript 的错误
        会出现在消息流里，可**进程压根没起来**的那种（2026-11-08 Codex App 占着会话的写入锁）
        transcript 里什么都没有——消息凭空消失，界面一片安静。
        建流时服务端会补推最近一轮；别人发的、很久以前的失败不该每次进来都弹，
        所以只认「这个页面发的」或者「半小时内结束的」，且关掉过的不再出现。
      */
      if (t.status === 'running') setFailed(null);
      else if ((t.status === 'failed' || t.status === 'anomaly' || t.status === 'handoff') && t.error
        && !dismissedFails().includes(t.turnId)) {
        const mine = sentTurns.current.get(t.turnId) ?? null;
        if (mine !== null || (t.endedAt && Date.now() - t.endedAt < 30 * 60_000)) {
          // handoff：Codex App 开着这个会话，消息交给了 App 排队（服务端 agent/codexQueue.js）——
          // 不是失败，用蓝色说一声，并把排进去的那条亮出来，让人知道它没丢
          setFailed({ turnId: t.turnId, error: t.error, text: mine, handoff: t.status === 'handoff' });
        }
      }
      setTick((prev) => ({
        turnId: t.turnId,
        running: t.status === 'running',
        elapsedMs: t.status === 'running' ? Date.now() - t.startedAt : 0,
        // 这两个事件不带队列。原来写死 0，于是一轮开始或结束时「还有 N 条排着」
        // 会消失，要等下一个 tick（最多 15 秒）才回来——沿用上一次的数
        queued: prev?.queued ?? 0,
        at: Date.now(),
      }));
    };
    es.addEventListener('turn_start', onTurn);
    es.addEventListener('turn_end', onTurn);

    /*
      agent 出了一道选择题，而且**正停在那儿等**。

      不用额外请求去问「现在有没有待答的题」：建流时服务端会补一帧
      （见 api.js 的 streamSession），所以断线重连后这张卡自己会回来。
    */
    es.addEventListener('ask', (e) => setAsk(JSON.parse((e as MessageEvent).data) as PendingAsk));
    es.addEventListener('ask_end', () => setAsk(null));

    return () => es.close();
  }, [sessionKey]);

  const onScroll = useCallback(() => {
    onStickScroll();
    const el = scroller.current;
    if (!el) return;
    lastScroll.current = { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 80 };
  }, [onStickScroll, scroller]);

  /**
   * 往前翻一页更早的。
   *
   * 原来挂在滚动事件上（scrollTop < 120 才去取），2026-11-07 实测两个毛病：
   *
   * 1. **卡住。** 第一页填不满屏幕时没有滚动条，滚轮滚不动，浏览器也就不发滚动事件——
   *    顶上写着「往上滚可以看更早的」，却怎么也翻不出来（1440×1500 实测：只发了首屏那一次请求，
   *    第 1–7 轮再也看不到）。工具调用多的会话折叠以后很矮，大屏上常见。人已经停在最顶上时同理。
   * 2. **跳。** 不是正好在顶上触发时，浏览器自带的滚动锚定已经把正在读的那一行留在原地，
   *    这里又手动补了一次增量，于是那一行被顶上去一整页（停在离顶 100px 处实测：-239 / -305 / -146px）。
   *    只有正好滚到 0 时浏览器不锚定，所以「一口气滚到顶」看着是好的。
   *
   * 现在谁来触发都走这里：顶上那一行进到视口附近（下面的观察器，不靠滚动事件），或者点它。
   * 位移只在前插那一次渲染里补一次（下面的 layout effect），滚动区关掉了浏览器的锚定（conversation.css）。
   */
  const prepend = useRef<number | null>(null); // 前插之前的 scrollHeight，等那次渲染落地后补差
  const loadOlder = useCallback(() => {
    if (before == null || loadingOlder) return;
    setLoadingOlder(true);
    setOlderErr(false);
    api
      .events(sessionKey, { before, limit: 60 })
      .then((page) => {
        // 游标没往前走就是服务端出了岔子：当失败处理，别让观察器在原地一遍遍翻
        if (page.nextBefore !== null && page.nextBefore >= before) throw new Error('翻页游标没有往前走');
        // 按 id 去重，和手机端一样：只把真没有的接到前面
        const seen = new Set(live.current.events.map((x) => x.id));
        const add = page.events.filter((x) => !seen.has(x.id));
        if (add.length) {
          prepend.current = scroller.current?.scrollHeight ?? null;
          setEvents((prev) => [...add, ...prev]);
        }
        setBefore(page.nextBefore);
      })
      .catch(() => setOlderErr(true))
      .finally(() => setLoadingOlder(false));
  }, [before, loadingOlder, sessionKey, scroller]);

  // 往前面插内容会把视口整体挤下去：在那次渲染落地、上屏之前补回增量，让正在读的那一行待在原地
  useLayoutEffect(() => {
    const h = prepend.current;
    prepend.current = null;
    const el = scroller.current;
    // instant：补位移不能带动画，带了就是看着它往下滑一截
    if (h !== null && el) el.scrollBy({ top: el.scrollHeight - h, behavior: 'instant' });
  }, [events, scroller]);

  /*
    顶上那一行（还有更早的时候才有）进到视口上方 600px 以内就去取，人还没滚到顶，更早的已经在了。

    用观察器而不是滚动事件：没有滚动条、或者已经停在最顶上时，浏览器不发滚动事件。
    每翻完一页这里会重新挂一次，挂上那一刻它会先报一次当前在不在视口里——
    所以第一页填不满屏幕时会一页页接着翻，直到填满或者翻到头；失败了停下，等人点重试。
  */
  const olderMark = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = scroller.current;
    const mark = olderMark.current;
    if (!root || !mark || !ready || before == null || loadingOlder || olderErr) return;
    if (typeof IntersectionObserver === 'undefined') return; // 没有它就只剩点那一行
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadOlder();
      },
      { root, rootMargin: '600px 0px 0px 0px' },
    );
    io.observe(mark);
    return () => io.disconnect();
  }, [ready, before, loadingOlder, olderErr, loadOlder, scroller]);

  /**
   * 发送。`fork` 为真时后端给 agent 加 `--fork-session` / `exec fork`，
   * 于是这条消息开出一条**新会话**，原来这条一个字不动。
   *
   * 分叉后**拿不到新会话的 key**——`sendMessage` 只回 `{turnId, queued}`，
   * 新会话要等 agent 把 transcript 写出来才存在。所以这里不跳转，只说清楚
   * 「它会出现在左边」，由侧栏的轮询把它捡回来。
   */
  /** `interrupt` = 插队：停下正在跑的这一轮，这条第一个发（服务端 when:'interrupt'） */
  async function submit(fork = false, interrupt = false) {
    const text = draft.trim();
    // 光有附件也能发——「看看这张图」那种情况正文本来就是空的
    if ((!text && !atts.length) || sending) return;
    /*
      **还有文件在传就先别发。** 附件是一个一个落进 atts 的，这时候发出去只会
      带上已经传完的那几个，剩下的随后冒出来、看着像是下一条消息的——而且一声
      不吭。按钮那边也一并禁掉（uploading > 0），这里是第二道。
    */
    if (uploading > 0) return;
    setSending(true);
    setSendErr(null);
    setForked(false);
    try {
      // 路径在**发送这一刻**才拼到正文末尾，不预先塞进输入框
      const full = text + attachmentSuffix(atts);
      /*
        **按下去那一刻就摆出来**，不等服务端回话（那要 0.3–1 秒，2026-11-10 在浏览器里量的）——
        Claude Desktop 也是这样。输入框同时清空；发不出去再撤回、把字放回去。
        分叉不摆：那条消息开的是另一条会话，不在这里。
      */
      localSeq.current += 1;
      const local = `local:${localSeq.current}`;
      // 目标模式：这句是目标。Claude 那边服务端会把它变成「/goal 这句」，对话里摆的也是那样
      const asGoal = goalMode && !fork && !!text;
      const shown = asGoal && (agent === 'claude' || agent === 'antigravity') ? `/goal ${full}` : full;
      /*
        跑着的时候发（排队或插队），这句先进队列、由排队那一栏显示，轮到它开跑时 turn_start 再把它摆出来。
        这里不摆：回显只有一格，摆了就把正在跑那一轮的那句顶掉了（2026-11-14 浏览器里实测）
      */
      const willQueue = running && !fork;
      if (!fork) {
        if (!willQueue) {
          const baseline = new Set(live.current.events.filter((x) => x.kind === 'text' && x.role === 'user').map((x) => x.id));
          setEcho({ turnId: local, text: shown, startedAt: null, baseline });
        }
        setDraft('');
        scrollToBottom();
      }
      let r: { turnId?: string; queued?: boolean } | null;
      try {
        r = asGoal
          ? await api.setGoal(sessionKey, full)
          : await api.send(sessionKey, full, fork, interrupt ? 'interrupt' : 'auto') as { turnId?: string; queued?: boolean } | null;
      } catch (e) {
        setEcho((prev) => (prev?.turnId === local ? null : prev));
        if (!fork) setDraft(draft);
        throw e;
      }
      if (r?.turnId) {
        const turnId = r.turnId;
        // 记下这一轮发的是什么：它要是没跑起来，失败提示上能把原文放回输入框
        sentTurns.current.set(turnId, shown);
        // turn_start 可能已经先到了（它带着电脑上的开始时刻，更准），那就不动；否则把本地那条认到这一轮名下
        setEcho((prev) => (prev?.turnId === local ? { ...prev, turnId } : prev));
      } else {
        // 排队了：这条还没开始，由排队那一栏显示，不摆在对话里。当场去取一次队列，不等心跳
        setEcho((prev) => (prev?.turnId === local ? null : prev));
        setQueueNonce((n) => n + 1);
      }
      // 送到了才抛，趁发送键还在原地。分叉不抛：那条消息开的是另一条会话
      if (!fork) tossToTurn(scroller.current?.closest('.conv') as HTMLElement | null);
      // 不分叉的已经在按下去时清过了；这时再清会把等回话那一下新打的字也抹掉
      if (fork) setDraft('');
      if (asGoal) {
        setGoalMode(false);
        setInfoNonce((n) => n + 1);
      }
      // 发出去之后气泡走 api.uploadUrl 重新取图，本地这份 blob 就是死的了
      atts.forEach(revokePreview);
      setAtts([]);
      if (fork) setForked(true);
      else scrollToBottom();
    } catch (e) {
      setSendErr(e as ApiError);
    } finally {
      setSending(false);
    }
  }

  /**
   * 传文件。传完**挂到输入框上方的缩略图条**，不再把路径贴进草稿。
   *
   * 原来那样做是替人决定了这一轮说什么——owner 在手机端明确否决过：
   * 「上传图片不要自动带上提示词」。他改完字还得绕开那行路径。
   * agent 确实只认路径，但那是**发送那一刻**的事（见 submit 里的
   * `attachmentSuffix`），不是人还在打字的时候。
   *
   * 服务端最终用的名字**不一定等于传上去的**（同名会加后缀），所以一律用返回的
   * `relative`，不要自己拼。缩略图用本地这份 File 现造 objectURL——文件刚从这台
   * 设备发出去，本地那份就是同一份，没必要绕服务器一圈。
   */
  const onFiles = useCallback(
    async (files: File[]) => {
      setUploading((n) => n + files.length);
      setSendErr(null);
      for (const f of files) {
        try {
          const name = f.name || pastedName(f);
          const r = await api.upload(sessionKey, name, f);
          const isImage = f.type.startsWith('image/') || isImageName(r.name);
          setAtts((prev) => [...prev, {
            name: r.name,
            bytes: r.bytes,
            relative: r.relative,
            previewUri: isImage ? URL.createObjectURL(f) : null,
            isImage,
          }]);
        } catch (e) {
          setSendErr(e as ApiError);
        } finally {
          setUploading((n) => n - 1);
        }
      }
    },
    [sessionKey],
  );

  /*
    离开这个会话时把还挂着的预览放掉。

    用 ref 取最新值——空依赖的那个 effect 的闭包里，`atts` 永远是第一次渲染的
    那份（空数组）。**但 ref 要在 effect 里写，不能在渲染期间写**：渲染期间
    改 ref 是 React 的反模式（oxlint 的 react(refs) 会报），因为并发渲染下
    这一次渲染未必会被提交。
  */
  const attsRef = useRef(atts);
  useEffect(() => { attsRef.current = atts; }, [atts]);
  useEffect(() => () => attsRef.current.forEach(revokePreview), []);

  const { dragging, dropProps } = useFileDrop(onFiles);

  const running = tick?.running ?? false;

  /*
    排着还没发的那几条（owner 2026-11-14：「还是不能自己选择插队还是排队啊」）。网页端原来只在状态栏写
    「还有 N 条排着」，看得见数量却什么都做不了。心跳只带条数，条数一变就去问一次是哪几条
  */
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([]);
  const queuedCount = tick?.queued ?? 0;
  const [queueNonce, setQueueNonce] = useState(0);
  /*
    条数变了、一轮开始或结束了（turnId 换了：可能正是队首被取走）、或者刚动过队列，就去问一次。
    不以「条数为 0」为由不问：心跳 15 秒一次，刚排进去的那条在它之前就得显示出来
  */
  useEffect(() => {
    let alive = true;
    api.state(sessionKey)
      .then((st) => { if (alive) setQueued(st.queued.map((q) => ({ id: q.id, text: q.text }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [sessionKey, queuedCount, tick?.turnId, queueNonce]);

  const shownQueue = queued;

  /** 排着的那条改成插队：从队列里拿出来，带 when:'interrupt' 再发（停下这一轮，它第一个发） */
  async function cutIn(q: { id: string; text: string }) {
    setSendErr(null);
    try {
      await api.cancelQueued(sessionKey, q.id);
      await api.send(sessionKey, q.text, false, 'interrupt');
    } catch (e) {
      setSendErr(e as ApiError);
    }
    setQueueNonce((n) => n + 1);
  }

  /** 撤回：已经发出去了服务端回 404，如实说 */
  async function withdraw(q: { id: string; text: string }) {
    setSendErr(null);
    try {
      await api.cancelQueued(sessionKey, q.id);
    } catch (e) {
      setSendErr(e as ApiError);
    }
    setQueueNonce((n) => n + 1);
  }
  // 新事件进来、一轮开始或结束、清了目标，信息就可能变了（Codex 清目标不产生事件，所以另记一笔）
  const [infoNonce, setInfoNonce] = useState(0);
  const { info, err: infoErr } = useSessionInfo(sessionKey, events.length * 2 + (running ? 1 : 0) + infoNonce * 100_000);
  const goal = info?.goal && !info.goal.met ? info.goal : null;

  /** 清除目标。Claude 那边是发一条 /goal clear（服务端 handlers/goal.js），要摆进对话 */
  async function clearGoal() {
    setSendErr(null);
    try {
      const r = await api.clearGoal(sessionKey);
      if (r?.turnId) {
        const turnId = r.turnId;
        sentTurns.current.set(turnId, '/goal clear');
        const baseline = new Set(live.current.events.filter((x) => x.kind === 'text' && x.role === 'user').map((x) => x.id));
        setEcho((prev) => (prev?.turnId === turnId ? prev : { turnId, text: '/goal clear', startedAt: null, baseline }));
        scrollToBottom();
      }
      setInfoNonce((n) => n + 1);
    } catch (e) {
      setSendErr(e as ApiError);
    }
  }

  /** 进目标模式，光标回到输入框 */
  function enterGoalMode() {
    setGoalMode(true);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.conv .composer-box textarea')?.focus());
  }
  // 会话列表还没回来时是 null。配置条据此先不渲染——见 Composer 里那条注释
  const member = useMember(sessionKey);
  const agent = member?.agent ?? null;

  return (
    <div className="conv-wrap">
    <div className="conv" {...dropProps}>
      <ConvHead
        sessionKey={sessionKey}
        onFiles={member && !member.cwd ? undefined : () => setFiles(true)}
        infoOpen={infoOpen}
        onToggleInfo={toggleInfo}
      />
      {files && (
        <FileBrowser
          sessionKey={sessionKey}
          onClose={() => setFiles(false)}
          // 预览里的「插入到输入框」：把相对路径接在草稿末尾，agent 认工作目录里的相对路径
          onInsert={(rel) => setDraft(`${draft ? `${draft.trimEnd()} ` : ''}${rel} `)}
        />
      )}

      {/* 整个对话区都是落点，不是只有输入框那一条——拖进来的人不会去瞄准 */}
      {dragging && (
        <div className="drop" aria-hidden="true">
          <span>松手上传到这个会话的工作目录</span>
        </div>
      )}

      <div className="conv-scroll" ref={scroller} onScroll={onScroll}>
        <div className="conv-inner">
          {!ready && (
            <p className="conv-loading">
              <span className="bounce" aria-hidden="true" />
              正在读这个会话…
            </p>
          )}

          {/*
            顶上这一行是这段记录的上边界。原来写的是「往上滚可以看更早的」——教人做他已经在做的事，
            而且没有滚动条时根本滚不动（见 loadOlder）。现在更早的会自己接上来，这一行只说状态：
            在读、读不出来（点一下重试）、或者已经到头了。平时那句「更早的对话」和手机端同一个词，点它也能翻。
          */}
          {before != null ? (
            <div className="older" ref={olderMark} aria-live="polite">
              {loadingOlder ? (
                <>
                  <span className="bounce" aria-hidden="true" />
                  {isEn ? 'Loading earlier messages…' : '正在读更早的…'}
                </>
              ) : (
                <button type="button" className="older-btn" onClick={loadOlder}>
                  {olderErr
                    ? (isEn ? 'Failed to load earlier messages — click to retry' : '更早的对话没读出来，点这里重试')
                    : (isEn ? 'Earlier messages' : '更早的对话')}
                </button>
              )}
            </div>
          ) : (
            ready && !err && events.length > 0 && <p className="older">{isEn ? 'Session starts here' : '会话从这里开始'}</p>
          )}

          {err && (
            <p className="conv-err" role="alert">
              <span>{err.message}</span>
              <span className="dim">{err.fix}</span>
            </p>
          )}

          {ready && !err && events.length === 0 && (
            <p className="older">{isEn ? 'No messages in this session yet.' : '这个会话还没有内容。'}</p>
          )}

          {items.map((it) =>
            it.t === 'run' ? (
              <RunBlock key={it.id} steps={it.steps} sessionKey={sessionKey} />
            ) : (
              <EventRow key={it.ev.id} ev={it.ev} sessionKey={sessionKey} />
            ),
          )}

          {/* 刚发出去的那句，摆在状态栏上面——和它真写进来以后的位置一样（见 echo） */}
          {echoShown && (
            <EventRow
              key={`echo:${echoShown.turnId}`}
              ev={{ id: `echo:${echoShown.turnId}`, kind: 'text', role: 'user', text: echoShown.text, offset: -1, ts: '' }}
              sessionKey={sessionKey}
            />
          )}

          {/*
            整轮的状态栏，**一轮只有一条、就在末尾**。跑着的时候球转、显示在
            干什么；跑完球停下、给出「复制」。见 TurnBar 抬头。
          */}
          {events.length > 0 && (
            <TurnBar
              text={running ? null : lastAgentText}
              running={running}
              elapsedMs={tick?.elapsedMs ?? 0}
              tickAt={tick?.at ?? 0}
              doing={doing}
              queued={tick?.queued ?? 0}
            />
          )}
        </div>
      </div>

      <Composer
        ask={ask && (
          // 换了一道题就是另一张卡：让 React 重建，上一道勾过的选项不会跟过来
          <AskCard key={ask.askId} ask={ask} sessionKey={sessionKey} onDone={() => setAsk(null)} />
        )}
        queue={shownQueue.length > 0 && (
          <div className="qlist" role="list" aria-label="排着的消息">
            {shownQueue.map((q, i) => (
              <div className="qrow" role="listitem" key={q.id}>
                <span className="qrow-tag">{i === 0 ? '下一条' : `第 ${i + 1} 条`}</span>
                <span className="qrow-text" title={q.text}>{q.text}</span>
                {/* 插队：停下正在跑的这一轮，这条第一个发。不在跑（在等电脑上那一轮）时就是「立刻发」 */}
                <button type="button" className="qrow-btn" onClick={() => { void cutIn(q); }}
                  title="停下正在跑的这一轮，马上发这条">
                  插队
                </button>
                <button type="button" className="qrow-btn is-quiet" onClick={() => { void withdraw(q); }}>撤回</button>
              </div>
            ))}
          </div>
        )}
        notice={failed && (
          <div className={`turnfail${failed.handoff ? ' is-info' : ''}`} role={failed.handoff ? 'status' : 'alert'}>
            <span className="turnfail-dot" aria-hidden="true" />
            <div className="turnfail-text">
              <strong>{failed.handoff ? '已交给 Codex App' : '这一轮没跑成'}</strong>
              <span>{failed.error}</span>
              {failed.handoff && failed.text && <span className="turnfail-quote">排进去的：{failed.text}</span>}
            </div>
            <div className="turnfail-acts">
              {failed.text !== null && !failed.handoff && (
                <button
                  type="button"
                  className="turnfail-btn is-primary"
                  onClick={() => {
                    // 草稿里已经有东西就接在后面，别把人正在写的覆盖掉
                    setDraft(draft.trim() ? `${draft.trimEnd()}\n${failed.text}` : (failed.text as string));
                    dismissFail(failed.turnId);
                    setFailed(null);
                  }}
                >
                  放回输入框
                </button>
              )}
              <button
                type="button"
                className="turnfail-btn"
                onClick={() => {
                  dismissFail(failed.turnId);
                  setFailed(null);
                }}
              >
                知道了
              </button>
            </div>
          </div>
        )}
        sessionKey={sessionKey} agent={agent}
        draft={draft} setDraft={setDraft} onSubmit={submit}
        onFiles={onFiles} uploading={uploading} forked={forked}
        atts={atts}
        onRemoveAtt={(i) => setAtts((prev) => {
          revokePreview(prev[i]);
          return prev.filter((_, j) => j !== i);
        })}
        sending={sending} running={running}
        onStop={() => tick?.turnId && api.stop(sessionKey, tick.turnId).catch(() => {})}
        err={sendErr}
        showJump={showJump}
        onJump={() => scrollToBottom()}
        goal={goal}
        goalMode={goalMode}
        // 设着目标：点它看进度（打开信息窗格）。没设：进 / 出目标模式
        onGoal={() => {
          if (goal) {
            if (!infoOpen) toggleInfo();
          } else if (goalMode) setGoalMode(false);
          else enterGoalMode();
        }}
      />
    </div>
    {infoOpen && (
      <InfoPanel
        sessionKey={sessionKey}
        info={info}
        err={infoErr}
        running={running}
        onClose={toggleInfo}
        onClearGoal={() => { void clearGoal(); }}
        onGoalMode={enterGoalMode}
      />
    )}
    </div>
  );
}

/** 宽屏（≥1100px）：信息窗格和对话并排；窄了就改成抽屉 */
function useWide(q = '(min-width: 1100px)'): boolean {
  const [w, setW] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setW(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return w;
}

/* ── 输入区 ───────────────────────────────────────────────────────────────── */

/**
 * 输入框本体在 InputBox 里，和新建页共用同一个——新建页照 Claude/ChatGPT 的做法
 * 是「一个还没开始的会话」，两边的输入框不一致的话这个说法当场就破了。
 *
 * 留在这里的是只有会话页才有的周边：选择题卡、附件条、回到最新、配置条、出错与分叉的提示。
 *
 * ## 2026-10-10：输入框上方不再有任何「一行字」
 *
 * owner 截图：输入框上面摞着三行——状态栏（球 + 46:58 · Bash(…)）、配置条、
 * 「运行中 2818s 停止」，后两行没有底色，正文从它们底下滚过去，字叠着字。
 *
 * 那两行当初放在上面，是为了让渐隐的消失线落到输入框上沿
 * （owner：「消失线要对齐到对话框的上面那个线那里」），内容就得从它们底下穿过去——
 * 这两个要求本来就互相打架。现在拆开：
 *
 *   状态        只剩一行，就是滚动区末尾那条状态栏（TurnBar），它是内容的一部分
 *   停止        并进发送键：跑着的时候、输入框空着，那颗键就是停止（InputBox）
 *   配置条      挪到输入框**底下**，Claude Code 桌面版就是这么摆的（owner 的截图里）
 *   上传中      进附件条，挂在要发的那几张旁边
 *
 * 于是输入框上方只剩真正的卡片（选择题、附件），它们都有不透明的底；消失线量的是
 * **整个输入区的上沿**——平时就是输入框那条线，挂着卡片时是卡片的上沿，
 * 无论哪种都不会有字叠在字上。
 */
function Composer({
  sessionKey, agent, ask, notice, queue,
  draft, setDraft, onSubmit, onFiles, uploading, forked, atts, onRemoveAtt,
  sending, running, onStop, err, showJump, onJump, goal, goalMode, onGoal,
}: {
  sessionKey: string;
  agent: Agent | null;
  /**
   * 选择题卡片。放进输入区而不是消息流里：它挂着的时候 agent 那一轮正停着等，
   * 滚上去看别的内容时它不该跟着滚走——那等于把「一轮正卡在这儿」藏起来。
   */
  ask: React.ReactNode;
  /** 上一轮没跑成的提示（见 Conversation 的 onTurn）。和选择题卡一样挂在输入区，不随消息滚走 */
  notice?: React.ReactNode;
  /** 排着还没发的那几条，一条一行，带「插队 / 撤回」。和选择题卡一样挂在输入区 */
  queue?: React.ReactNode;
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: (fork?: boolean, interrupt?: boolean) => void;
  onFiles: (files: File[]) => void;
  /** 传完等着随下一条消息发出的附件。路径在发送那一刻才拼到正文末尾 */
  atts: Attachment[];
  onRemoveAtt: (i: number) => void;
  uploading: number;
  forked: boolean;
  sending: boolean;
  running: boolean;
  onStop: () => void;
  err: ApiError | null;
  showJump: boolean;
  onJump: () => void;
  /** 设着的目标（没有或已达成是 null）。有就在配置条旁边亮一颗「目标」，写着它的状态 */
  goal?: { condition: string; status?: string } | null;
  /** 目标模式开着：输入框里这句发出去就是目标 */
  goalMode?: boolean;
  onGoal?: () => void;
}) {
  const { locale } = useI18n();
  const isEn = locale === 'en';
  /**
   * 把「输入区上沿到视口底边」这段距离实测出来，交给 CSS 当渐隐的消失线。
   *
   * 量的是整个 `.composer`（选择题卡、附件条、输入框、底下的配置条都在里面），
   * 不再是 `.composer-box`：上一版只量输入框，于是挂在它上面的那几行都落在
   * 「还看得见正文」的那一截里，叠成一团。
   *
   * 「回到最新」是绝对定位的，不占这个盒子的高度，所以量不到它——它本来就该
   * 浮在渐隐带里。
   */
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = box.current;
    const conv = host?.closest('.conv') as HTMLElement | null;
    if (!host || !conv) return undefined;
    const measure = () => {
      const base = conv.getBoundingClientRect().bottom - host.getBoundingClientRect().top;
      conv.style.setProperty('--fade-base', `${Math.max(0, Math.round(base))}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(conv);
    return () => ro.disconnect();
  });

  return (
    <div className="composer" ref={box}>
      {/* 回到底部：只在离开底部且内容确实溢出时出现，浮在输入区正上方的渐隐带里 */}
      {showJump && (
        <button type="button" className="jump" onClick={onJump} aria-label="回到最新" title="回到最新">
          <span className="jump-arrow" aria-hidden="true" />
        </button>
      )}

      {ask}
      {queue}
      {notice}

      {/* 缩略图条在输入框**上方**：人先看见自己要发什么，再决定配什么字。
          还在传的那几个也挂在这儿，而不是另起一行状态 */}
      <DraftAttachments items={atts} onRemove={onRemoveAtt} pending={uploading} />

      <InputBox
        value={draft}
        onChange={setDraft}
        onSubmit={() => onSubmit()}
        onInterrupt={() => onSubmit(false, true)}
        onFiles={onFiles}
        /* 还有文件在传就按不动：这时候发出去只会带上已经传完的那几个 */
        sending={sending || uploading > 0}
        /* 光有附件也能发——「看看这张图」那种情况正文本来就是空的 */
        hasAttachments={atts.length > 0}
        placeholder={goalMode
          ? (isEn ? 'Describe the goal and completion criteria — the agent will keep working until met' : '写下目标：要达成什么、怎样算完成。发出去后 agent 会一直干到满足为止')
          : (isEn ? 'Reply…' : '接着说…')}
        running={running}
        onStop={onStop}
        /*
          agent 要等会话列表回来才知道，而模型/权限的可选集按 agent 分——
          没有它就只能先渲染一份可能是错的，所以先不画
        */
        slashKey={agent ? sessionKey : undefined}
        slashAgent={agent ?? undefined}
        pills={agent && (
          <>
            <SessionConfig mode="session" sessionKey={sessionKey} agent={agent} running={running} />
            {/*
              目标。两个 agent 都有（Claude 是 /goal，Codex 是它自己的目标，服务端 handlers/goal.js）。
              设着目标时它亮着、写着状态，点它看进度；没设时点它进目标模式，再点一下退出
            */}
            {onGoal && (
              <button
                type="button"
                className={`goalpill${goalMode ? ' is-mode' : goal ? (goalNeedsYou(goal.status) ? ' is-warn' : ' is-on') : ''}`}
                onClick={onGoal}
                aria-pressed={goalMode}
                title={goal ? `目标：${goal.condition}` : goalMode ? '退出目标模式' : '设一个目标：agent 会一直干到满足为止'}
              >
                <Icon name="target" />
                <span>
                  {goalMode ? '目标模式' : goal ? `目标${GOAL_STATE[goal.status ?? 'active'] ?? '进行中'}` : '目标'}
                </span>
              </button>
            )}
          </>
        )}
        /*
          分叉**暂时藏起来**。owner：「暂不支持 baton 上开分叉，感觉会很乱」。

          只藏界面，后端那条路和 onSubmit(fork) 原样留着——分叉的语义（另开一条
          会话、当前这条一个字不动）没有问题，问题是它在这个界面里把「我在哪条
          会话上」搞糊涂了。等想清楚怎么呈现再放出来，比现在删掉再写一遍便宜。
        */
        extra={null}
      />

      {/* 分叉拿不到新会话的 key（后端只回 turnId），所以只能说清它会从哪冒出来 */}
      {forked && !err && (
        <p className="composer-note">已分叉。新会话稍后出现在左边列表里，当前这条不受影响。</p>
      )}

      {err && (
        <p className="composer-err" role="alert">
          <span>{err.message}</span>
          <span className="dim">{err.fix}</span>
        </p>
      )}
    </div>
  );
}
