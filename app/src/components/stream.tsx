import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { useLocale } from '@/i18n';
import {
  IconClock, IconClose, IconCopy, IconDots, IconExpand, IconFile, IconGlobe, IconImage,
  IconRight, IconSearch, IconTerm,
} from '@/icons';
import { BallSpinner, Tappable } from './ui';
import * as haptics from '@/feedback/haptics';
import { Markdown } from './markdown';
import { splitAttachments } from '@/store/attach';
import { RemoteImage } from './RemoteImage';
import type { BatonEvent, TurnStatus } from '@/api/types';
import { argOf as stepArg, coerce, failedOf, kindOf, liveLabel, summarize, type Kind, type Step } from '@/api/runs';

/**
 * 会话流里的构件，逐个搬自原型。
 *
 * 贯穿全篇的一条：**thinking 和工具活动共用同一条折叠行**。它们都是「机器内部
 * 过程」，所以用同一种语言——这是 Claude App 的 "Thought for 1s ›" 那一行。
 */

/**
 * 图标按类别给，和折叠行那句话**用同一套分类**（api/runs.ts 的 kindOf）。
 * 旧版按名字查一张五个名字的表，查不到一律画终端：PowerShell 画成了终端、句子里却没算命令，
 * MCP 工具、子 agent 全画成终端，看着像在跑命令。
 */
const KIND_ICON: Record<Kind, (p: { size?: number; color: string }) => React.ReactElement> = {
  shell: IconTerm, read: IconFile, edit: IconFile, search: IconSearch, web: IconGlobe,
  agent: IconDots, ask: IconDots, other: IconDots,
};

const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const lines = (s: string) => s.split('\n').length;

// ── 用户消息 ────────────────────────────────────

/**
 * 右对齐的圆角块。真机上它内部很干净——没有标签、没有边框、没有阴影，
 * 横向留白很宽，文字是**无衬线**（正文才是衬线）。
 */
export function MsgUser({ text, fromPhone, sessionKey }: {
  text: string; fromPhone?: boolean;
  /** 取缩略图要用它拼地址。不传就退回文件片。 */
  sessionKey?: string;
}) {
  const t = useTheme();
  const s = st(t);
  /**
   * 末尾那段路径清单是**写给 agent 的**，不给人看（owner：「不要带上那个"附件：
   * 已放在"那个是给 agent 看的不是给我看的」）。发出去的内容一个字没改——
   * 两个 CLI 只认磁盘路径，删了它 agent 就读不到文件。只在这儿切一刀。
   */
  const { body, files } = splitAttachments(text);
  return (
    <>
      {/*
        附件在气泡**上方**，右对齐跟着气泡走——和 ChatGPT、Claude 一致。
        图片出真缩略图（从那台电脑取回来，见 RemoteImage），其余出文件片。
      */}
      {files.length ? (
        <View style={s.sentFiles}>
          {files.map((f) => (
            f.isImage && sessionKey ? (
              <RemoteImage
                key={f.relative}
                sessionKey={sessionKey}
                name={f.label}
                style={s.sentThumb}
              />
            ) : (
              <View key={f.relative} style={s.sentFile}>
                {f.isImage
                  ? <IconImage size={13} color={t.c.txTertiary} />
                  : <IconFile size={13} color={t.c.txTertiary} />}
                <Text style={s.sentFileTx} numberOfLines={1}>{f.label}</Text>
              </View>
            )
          ))}
        </View>
      ) : null}
      {body.trim() ? (
        <View style={s.msgUser}>
          <View style={s.bubble}><Text style={s.bubbleTx}>{body}</Text></View>
        </View>
      ) : null}
      {/* 来源标记在气泡外、右对齐的小灰字——塞进气泡里不是 Claude 的做法。
          只给「从手机发的」加：在电脑上打的才是常态，不必每条都标。 */}
      {fromPhone ? <Text style={s.msgFrom}>从手机发的</Text> : null}
    </>
  );
}

/**
 * 还没被服务器确认的那一条。**发出去的那一刻就画出来，不等往返。**
 *
 * owner：「就算是因为网络问题发不出去也应该页面上是让我的消息先弹到消息历史里面
 * 作为气泡，然后用状态条提示当前情况吧？」——对的，而且这条在这个 App 上格外重要：
 * 手机断连是常态不是异常（CLAUDE.md 第三条坑）。
 *
 * 旧做法是「等 `client.send` 回来了再靠刷新把它显示出来」，于是：
 *   网络慢  → 点完之后屏幕上什么都不动，人只会以为没点到，然后连点
 *   失败    → 错误被 catch 吞掉，草稿还在框里，看起来就是「没反应」
 *
 * 气泡本身和真消息**长得一模一样**（同一套 msgUser / bubble 样式），只在下面多一
 * 行状态。位置不变、只有状态变——这样从「发送中」到真消息落定的那一刻，屏幕上
 * 不该有任何跳动。
 */
export function PendingMsg({
  text, failed, error, status, onRetry, onDrop,
}: {
  text: string;
  failed?: boolean;
  status?: string;
  error?: string | null;
  onRetry?: () => void;
  onDrop: () => void;
}) {
  const t = useTheme();
  const s = st(t);
  // 和真气泡同一套处理：给 agent 看的那段路径清单不显示给人
  const { isEn } = useLocale();
  const { body, files } = splitAttachments(text);
  return (
    <>
      <View style={s.msgUser}>
        {/* 没落定之前压一点透明度：它和真消息的区别只有"还没数"，不该换个样子 */}
        <View style={[s.bubble, !failed && { opacity: 0.55 }]}>
          <Text style={s.bubbleTx}>{body || text}</Text>
          {body && files.map((f) => <Text key={f.relative} style={s.bubbleTx}>{f.label}</Text>)}
        </View>
      </View>
      <View style={s.pendRow}>
        {failed ? (
          <>
            <Text style={s.pendFail}>{error || (isEn ? 'Delivery failed' : '没发出去')}</Text>
            {onRetry && <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
              <Text style={s.pendAct}>{isEn ? 'Retry' : '重试'}</Text>
            </Pressable>}
            <Pressable onPress={onDrop} hitSlop={8} accessibilityRole="button">
              <Text style={s.pendDrop}>{isEn ? 'Dismiss' : '移除'}</Text>
            </Pressable>
          </>
        ) : (
          <Text style={s.pendTx} accessibilityLiveRegion="polite">{status ?? '发送中…'}</Text>
        )}
      </View>
    </>
  );
}

// ── agent 正文 ──────────────────────────────────

/** 衬线、全宽、无气泡。段落之间留空，`code` 用等宽。 */
export function MsgText({ text }: { text: string }) {
  const s = st(useTheme());
  // 交给 markdown.tsx。之前这里只切段落 + 认反引号，于是 **粗体**、## 标题、
  // - 列表、围栏代码块全以原文出现在手机上——而 agent 的回复几乎全是 markdown。
  return (
    <View style={s.msgText}>
      <Markdown text={text} />
    </View>
  );
}

// ── 折叠行 ──────────────────────────────────────

export function FoldLine({
  icon, label, arg, stat, open, fail, monoArg = true, onPress,
}: {
  icon: React.ReactNode; label?: string; arg?: string; stat?: React.ReactNode;
  open: boolean; fail?: boolean; monoArg?: boolean; onPress: () => void;
}) {
  const t = useTheme();
  const s = st(t);
  const color = fail ? t.c.txDanger : t.c.txTertiary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={s.fold}
    >
      <View style={s.foldIc}>{icon}</View>
      {label ? <Text style={[s.foldLabel, { color }]}>{label}</Text> : null}
      <Text
        style={[
          s.foldArg,
          { color, opacity: fail ? 0.8 : 1 },
          !monoArg && { fontFamily: t.fonts.sans, fontSize: t.size.sm },
        ]}
        numberOfLines={1}
      >
        {arg ?? ''}
      </Text>
      {stat}
      <View style={[s.chev, open && { transform: [{ rotate: '90deg' }] }]}>
        <IconRight size={13} color={color} />
      </View>
    </Pressable>
  );
}

// ── 工具输出 ────────────────────────────────────

/**
 * 窥视规则——**唯一一处刻意偏离桌面端**。
 *
 * 桌面端一律截头部，因为 ctrl+o 一按就展开；手机没有键盘，而手机上最想看的
 * 恰恰在末尾（测试失败行、`stream disconnected` 那句）。
 * 所以成功截头部（同桌面端），失败窗尾部。完全展开后两边一样。
 */
function peek(text: string, fail: boolean, full: boolean, cap = 5) {
  const all = lines(text);
  if (all <= cap || full) return { head: text, note: null as string | null, tail: null as string | null };
  const ls = text.split('\n');
  if (fail) {
    return { head: null as unknown as string, note: `… 前 ${num(all - cap)} 行`, tail: ls.slice(-cap).join('\n') };
  }
  return { head: ls.slice(0, cap).join('\n'), note: `… 还有 ${num(all - cap)} 行`, tail: null };
}

/** 原始终端文本：不重排，只在自己容器里横滚。diff 行上色。 */
export function Raw({ text }: { text: string }) {
  const t = useTheme();
  const s = st(t);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 12 }}>
      <Text style={s.raw} selectable>
        {text.split('\n').map((l, i) => (
          <Text key={i} style={tone(l, t)}>{l}{'\n'}</Text>
        ))}
      </Text>
    </ScrollView>
  );
}

function tone(l: string, t: Theme) {
  if (/^\s*\d+\s*\+/.test(l) || /^\+/.test(l)) return { color: t.c.txSuccess };
  if (/^\s*\d+\s*-/.test(l) || /^-/.test(l)) return { color: t.c.txDanger };
  if (/^\s*(npm warn|npm http|at )/.test(l)) return { color: t.c.txTertiary };
  return undefined;
}

export function OutBlock({
  text, fail, truncatedTotal, onFull,
}: { text: string; fail?: boolean; truncatedTotal?: number; onFull?: () => void }) {
  const t = useTheme();
  const s = st(t);
  const [full, setFull] = useState(false);
  const p = peek(text, !!fail, full);
  const n = lines(text);

  return (
    <View style={s.foldBody}>
      <View style={[s.out, fail && { backgroundColor: t.c.bgDanger }]}>
        {p.note && p.tail ? <Text style={s.outNote}>{p.note}</Text> : null}
        {p.head ? <Raw text={p.head} /> : null}
        {p.note && p.head ? <Text style={s.outNote}>{p.note}</Text> : null}
        {p.tail ? <Raw text={p.tail} /> : null}
      </View>

      {truncatedTotal ? (
        <Pressable style={s.outMore} onPress={onFull} accessibilityRole="button">
          <IconExpand size={14} color={t.c.txInfo} />
          <Text style={s.outMoreTx}>看全文（共 {num(truncatedTotal)} 字）</Text>
        </Pressable>
      ) : n > 5 && !full ? (
        <Pressable style={s.outMore} onPress={() => setFull(true)} accessibilityRole="button">
          <IconExpand size={14} color={t.c.txInfo} />
          <Text style={s.outMoreTx}>展开全部 {num(n)} 行</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── 单条工具调用 ────────────────────────────────

/**
 * 一次工具调用。**调用与它的结果是一条，不是两条**——调用是标题（工具名 + 参数），
 * 结果是展开后的内容。拆成两行会让流里一半的行都是没有信息量的「工具 ›」。
 * 二者按 tool_use_id 配对，见会话屏的 segment()。
 */
export function ToolCall({
  event, result, open, onToggle, onFull,
}: {
  event: BatonEvent; result?: BatonEvent; open: boolean;
  onToggle: () => void; onFull?: () => void;
}) {
  const t = useTheme();
  const name = event.tool?.name ?? '工具';
  const Ico = KIND_ICON[kindOf(event.tool?.name, event.tool?.input)];
  const arg = argOf(event);
  const carrier = result ?? event;
  const out = carrier.tool?.output ?? '';
  // 成败只认服务端给的标记。原来在输出末尾找 error、failed 这几个词，标红的十条里
  // 将近九条是冤枉的（api/runs.ts 的 failedOf）
  const fail = failedOf({ call: event, result });

  return (
    <>
      <FoldLine
        icon={<Ico size={15} color={fail ? t.c.txDanger : t.c.txTertiary} />}
        label={name}
        arg={arg}
        open={open}
        fail={fail}
        onPress={onToggle}
      />
      {open && out ? (
        <OutBlock
          text={out}
          fail={fail}
          truncatedTotal={carrier.truncation?.output?.totalChars}
          onFull={onFull}
        />
      ) : null}
    </>
  );
}

/**
 * 提问类工具。两个来源，形状不同，但折叠行上该显示的都是**问题本身**：
 *
 *   `AskUserQuestion`  Claude 交互式界面里那个选项框。本机 transcript 里 167 次。
 *                      Baton 自己跑的轮次拿不到它（`-p` 模式下不存在，见
 *                      src/ask/protocol.js），但**在电脑上继续同一条会话时会出现**，
 *                      而 Baton 读的是同一份 transcript。
 *                      入参 `{questions:[{question, options}]}`
 *   `mcp__baton__ask`  Baton 自己那个。入参 `{question, options}`
 *
 * 不认它的话，这 167 条每一条在折叠行上都是
 * `{"questions":[{"question":"梵净山要不要安排？","header"…` 这样的一截转义 JSON。
 */
function askArg(i: Record<string, unknown>): string | null {
  if (Array.isArray(i.questions)) {
    const qs = i.questions
      .map((q) => (q && typeof q === 'object' ? (q as { question?: unknown }).question : null))
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
    return qs.length ? qs.join(' / ') : null;
  }
  return typeof i.question === 'string' && i.question.trim() ? i.question : null;
}

/**
 * 工具名后面那一截。提问类在这里认（上面那段说的两种形状），其余交给 api/runs.ts 的 argOf：
 * 它按类别取命令、文件、搜什么、查什么，认得 Codex 的 JSON 串、截断过的半截 JSON、
 * 补丁原文和 exec 那段 JS——原来这几种在这一行上都是原样的一截 JSON 或代码。
 */
function argOf(e: BatonEvent): string {
  const name = e.tool?.name ?? '';
  if (name === 'AskUserQuestion' || name === 'mcp__baton__ask' || name === 'ask_question') {
    const i = coerce(e.tool?.input);
    const q = i && typeof i === 'object' && !Array.isArray(i) ? askArg(i as Record<string, unknown>) : null;
    if (q) return q.split('\n')[0];
  }
  return stepArg(e.tool?.name, e.tool?.input);
}

// ── thinking ────────────────────────────────────

/**
 * thinking 的真实行为：一次回复只在开头出现一次，而且要等回复完才出现；
 * Claude 还经常根本不返回推理内容（摘要自 v2.1.90 起已弃用，真实推理是加密的）。
 * 所以只保留一条、没内容就整条不渲染——**不花一行去解释「这里什么都没有」**。
 *
 * 真机上这一行是一句内容摘要（「定位官方申请渠道并考虑地理限制因素。 ›」），
 * 不是「思考了 N 秒」。
 */
export function Thinking({
  text, open, onToggle,
}: { text: string; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  const s = st(t);
  if (!text?.trim()) return null;
  const gist = `${text.split(/[。;；]/)[0]}。`;
  return (
    <>
      <FoldLine
        icon={<IconClock size={15} color={t.c.txTertiary} />}
        arg={gist}
        monoArg={false}
        open={open}
        onPress={onToggle}
      />
      {open ? (
        <View style={s.foldBody}><Text style={s.think} selectable>{text}</Text></View>
      ) : null}
    </>
  );
}

// ── 一段活并成一行 ──────────────────────────────

/**
 * Claude Code 的默认密度不是「一次调用一行」，而是把**一段活并成一行**：
 *   Edited 2 files, ran a command, used 4 tools  +24 −4  ›
 * 点开才展开成单条。这是 Normal 档的真实样子。
 *
 * 那句话怎么数、跑着时说什么，都在 api/runs.ts（有测试）。旧版在这里自己数，
 * 2026-10-10 对着 Claude 桌面版对账错了五处，见那边的抬头。
 */
export function TurnSummary({
  steps, live, open, onToggle, children,
}: {
  steps: Step[]; live: boolean; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  const t = useTheme();
  const s = st(t);

  if (live) {
    // 在跑的时候这一行是进行时——所以这行摘要本身也是活的
    return (
      <>
        <Pressable style={s.turnSum} onPress={onToggle} accessibilityRole="button">
          <Text style={s.turnSumTx} numberOfLines={1}>{liveLabel(steps)}</Text>
          <View style={[s.chev, open && { transform: [{ rotate: '90deg' }] }]}>
            <IconRight size={13} color={t.c.txSecondary} />
          </View>
        </Pressable>
        {open ? children : null}
      </>
    );
  }

  const pairs = steps.flatMap((x) => (x.t === 'call' ? [x.pair] : []));
  const failed = pairs.some(failedOf);

  return (
    <>
      <Pressable style={s.turnSum} onPress={onToggle} accessibilityRole="button">
        <Text style={s.turnSumTx} numberOfLines={1}>{summarize(pairs)}</Text>
        {/* 失败标记放在不参与截断的位置——它是最该跳出来的信息，
            塞进会省略的文本里等于第一个被吃掉 */}
        {failed ? <Text style={s.statFail}>有失败</Text> : null}
        <View style={[s.chev, open && { transform: [{ rotate: '90deg' }] }]}>
          <IconRight size={13} color={t.c.txSecondary} />
        </View>
      </Pressable>
      {open ? children : null}
    </>
  );
}

// ── 轮次结束 ────────────────────────────────────

/**
 * 失败 / 停止 / 异常**作为内容留在流里**，不是弹一下就没。
 * 成功则什么都不显示——每轮弹一个「✓」会把真正需要注意的失败淹掉。
 */
export function TurnEnd({
  status, error, onDismiss,
}: {
  status: TurnStatus;
  error: string | null;
  /**
   * 划掉它。
   *
   * 这条横幅的**语义**是「刚刚这一轮结束了」，一次性的；但它的**判据**是
   * 「最后一轮的状态」，那是个永久事实。两者对不上，于是失败一次之后每次
   * 进这间会话都要再红一遍（owner：「反复重进对话好几次，那个好像还在」）。
   * 给一个「我看过了」的出口，比偷偷设个过期时间诚实。
   */
  onDismiss?: () => void;
}) {
  const t = useTheme();
  const { trNew } = useLocale();
  const s = st(t);
  if (status === 'ok' || status === 'running') return null;

  // 原来这里有一条 `stopped`，和 `aborted` 一字不差——而且 TurnStatus 里
  // 根本没有 stopped 这个值，那一行永远进不来。
  const cfg = {
    failed: { bg: t.c.bgDanger, title: '失败', fix: '上下文还在，重发即可。' },
    aborted: { bg: t.c.bgSecondary, title: '已停止', fix: '改动已保留。' },
    // 「不算完成」这四个字不能省：异常结束最容易被当成做完了
    anomaly: { bg: t.c.bgWarning, title: '异常结束', fix: '不算完成，重发一次。' },
    unconfirmed: { bg: t.c.bgWarning, title: trNew('session.desktopUnconfirmed'), fix: trNew('session.desktopUnconfirmedHelp') },
    // 不是失败：消息排进了正开着这个会话的 Codex App，App 跑完手上那一轮就接着做
    handoff: { bg: t.c.bgSecondary, title: '已交给 Codex App', fix: '不用重发，回复会出现在这里。' },
  }[status] ?? { bg: t.c.bgSecondary, title: '已结束', fix: '' };

  return (
    <View style={[s.end, { backgroundColor: cfg.bg }]}>
      <Text style={s.endTitle}>{cfg.title}</Text>
      {error && status !== 'unconfirmed' ? <Text style={s.endWhy} selectable>{error}</Text> : null}
      <Text style={s.endFix}>{cfg.fix}</Text>
      {onDismiss ? (
        <Pressable
          style={s.endX}
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="知道了，不用再提示"
        >
          <IconClose size={11} color={t.c.txTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 每条 agent 回复的收尾：左下角那颗球 + 右边的复制。
 *
 * ## 改过三处，都是 owner 点名的
 *
 * **原来整屏只有一个**，挂在滚动区最末尾。于是往回翻的时候，每条回复底下什么
 * 都没有，只有最后一条有——而「复制上一条」恰恰是往回翻时才需要的动作。
 * 现在每条 agent 正文底下都有一个。
 *
 * **原来一直显示**，包括轮次还在跑的时候。正在写的那条底下挂个「复制」没有意义：
 * 内容还在长，复制到的是半截。所以只在轮次**真的结束**之后才给。
 *
 * **原来那两个按钮什么都不干**——`onCopy` / `onRetry` 从来没接过处理函数，
 * 点下去毫无反应。复制接上了；「重发」删掉了：它到底该重跑哪一轮、会不会把
 * 已有的回复覆盖掉，我答不上来，而一个答不上来的按钮不该留在界面上。
 */
export function TurnFoot({
  onCopy, running = false,
}: {
  onCopy?: () => void;
  /**
   * 这一轮还在跑。
   *
   * **位置不变、只有动静变**：跑着的时候球在转、右边不给动作；跑完球停下来、
   * 动作出现。owner：「agent 在运行的时候，底下那个 logo 可以出现在那个位置，
   * 但是他要有一个正在运行的动画让人区分，然后正好 agent 执行完毕后那个 logo
   * 就静止了」。
   *
   * 跑着的时候不给「复制」是原来就有的判断，没变：内容还在长，复制到的是半截。
   */
  running?: boolean;
}) {
  const t = useTheme();
  const s = st(t);
  const [done, setDone] = useState(false);

  return (
    <View style={s.turnFoot}>
      <BallSpinner size={17} color={t.c.coral} spinning={running} />
      {running ? null : (
      <View style={s.acts}>
        <Tappable
          style={s.act}
          feedback="none"
          haptic={haptics.tap}
          onPress={() => {
            onCopy?.();
            // 复制没有任何视觉结果——不给反馈的话，人只能靠去别处粘一下来确认
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          }}
          accessibilityRole="button"
          accessibilityLabel="复制"
        >
          {done
            ? <Text style={s.copied}>已复制</Text>
            : <IconCopy size={17} color={t.c.txTertiary} />}
        </Tappable>
      </View>
      )}
    </View>
  );
}

/** 重连后补上的那几条，用一条带横线的居中提示隔开。 */
/**
 * 一条边界：居中一句小字，两边细线。
 *
 * 「重连后补上 N 条」和「这一轮被打断」都是这个样子——它们标的是记录里的一条
 * 界线，不是谁说的话。所以不做成气泡、不上色：分量要比一条消息轻。
 */
function Boundary({ text }: { text: string }) {
  const t = useTheme();
  const s = st(t);
  return (
    <View style={s.caught}>
      <View style={s.caughtLine} />
      <Text style={s.caughtTx}>{text}</Text>
      <View style={s.caughtLine} />
    </View>
  );
}

export function Caught({ n }: { n: number }) {
  return <Boundary text={`重连后补上 ${n} 条`} />;
}

/**
 * 这一轮被人打断了。原来它是一个**用户气泡**，写着 `[Request interrupted by user]`
 * ——CLI 写进 transcript 的标记，没有人打过这句话。text 是服务端翻好的中文。
 */
export function Interrupted({ text }: { text: string }) {
  return <Boundary text={text} />;
}

/**
 * 斜杠命令的回执（「Goal set: …」「Set model to …」）。不是谁说的话，一行小字；
 * 很长的（/context 那张表）只给第一行，和网页端折起来时一样。
 */
export function CommandOutput({ text }: { text: string }) {
  const t = useTheme();
  const s = st(t);
  const first = text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? text;
  return <Text style={s.cmdOut} selectable numberOfLines={3}>{first}</Text>;
}

/** /goal 的进度：达成了，或者检查没过、agent 被打回去接着干 */
/** Codex 的目标还有这几种状态（服务端 src/codex.js，库里是蛇形）。措辞和网页端 web/src/goal.ts 一样 */
const GOAL_STATE: Record<string, string> = {
  paused: '已暂停', blocked: '卡住了', usage_limited: '额度用完，停下了', budget_limited: '到了预算上限',
};

export function GoalRow({ text, met, reason, status }: { text: string; met: boolean; reason: string | null; status?: string }) {
  const t = useTheme();
  const s = st(t);
  const head = met || status === 'complete'
    ? '✓ 目标达成'
    : status === 'active'
      ? (text ? '◎ 设定了目标' : '◎ 目标恢复了')
      : status
        ? `目标${GOAL_STATE[status] ?? status}`
        : '↻ 目标还没达成，接着干';
  return (
    <View style={s.goal}>
      <Text style={[s.goalHead, (met || status === 'complete') && { color: t.c.txSuccess }]}>{head}</Text>
      {text ? <Text style={s.goalCond} selectable>{text}</Text> : null}
      {reason ? <Text style={s.goalWhy} selectable numberOfLines={4}>{reason}</Text> : null}
    </View>
  );
}

/**
 * transcript 里记下的一轮出错（codex 的 task_complete 带 error）。
 *
 * 和底部那条 TurnEnd 不是一回事：TurnEnd 是 **Baton 自己跑的那一轮**的状态，
 * 能划掉；这个是**记录里写着的**，在哪一轮就画在哪一轮后面。措辞和网页端的
 * `.turn-err` 一字不差。
 */
export function TurnError({ text }: { text: string }) {
  const t = useTheme();
  const s = st(t);
  return (
    <View style={s.turnErr}>
      <Text style={s.turnErrTx} selectable>这一轮出错了：{text}</Text>
    </View>
  );
}

export const st = (t: Theme) =>
  StyleSheet.create({
    msgUser: {
      flexDirection: 'row', justifyContent: 'flex-end',
      paddingHorizontal: t.space.pad, paddingTop: 16, paddingBottom: 2,
    },
    bubble: {
      maxWidth: '79%', backgroundColor: t.c.bgSecondary, borderRadius: 22,
      paddingHorizontal: 18, paddingVertical: 13,
    },
    bubbleTx: { fontSize: t.size.md, lineHeight: 24, color: t.c.txPrimary, fontFamily: t.fonts.sans },
    msgFrom: {
      textAlign: 'right', paddingHorizontal: t.space.pad, paddingTop: 5,
      fontSize: 11.5, color: t.c.txTertiary, fontFamily: t.fonts.sans,
    },

    // 状态行跟着气泡右对齐，和「从手机发的」同一条基线上
    pendRow: {
      flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center',
      gap: 12, paddingHorizontal: t.space.pad, paddingTop: 5,
    },
    pendTx: { fontSize: 11.5, color: t.c.txTertiary, fontFamily: t.fonts.sans },
    pendFail: { fontSize: 11.5, color: t.c.txDanger, fontFamily: t.fonts.sans, flexShrink: 1 },
    // 重试是主动作，给它正文色；「不发了」是破坏性的，退到次要色，不上红——
    // 红色留给"出错了"，不该同时表示"这个按钮很危险"
    pendAct: { fontSize: 11.5, color: t.c.txPrimary, fontFamily: t.fonts.sans, fontWeight: t.weight.bold },
    pendDrop: { fontSize: 11.5, color: t.c.txTertiary, fontFamily: t.fonts.sans },

    msgText: { paddingHorizontal: t.space.pad, paddingTop: 2, paddingBottom: 10 },
    para: {
      fontFamily: t.fonts.serif, fontSize: 17, lineHeight: 27.5,
      color: t.c.txPrimary, marginBottom: 11,
    },

    fold: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      marginHorizontal: t.space.pad, marginVertical: 6,
      paddingVertical: 5, minHeight: 34,
    },
    foldIc: { width: 15, height: 15 },
    foldLabel: { fontSize: t.size.sm, fontFamily: t.fonts.sans },
    foldArg: { flex: 1, fontFamily: t.fonts.mono, fontSize: 12.5, minWidth: 0 },
    chev: { width: 13, height: 13, opacity: 0.7 },

    turnSum: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      marginHorizontal: t.space.pad, marginVertical: 8,
      paddingVertical: 5, minHeight: 36,
    },
    turnSumTx: { flex: 1, fontSize: t.size.sm, color: t.c.txSecondary, fontFamily: t.fonts.sans },
    statFail: { color: t.c.txDanger, fontWeight: t.weight.bold, fontSize: t.size.sm, fontFamily: t.fonts.sans },

    foldBody: { paddingHorizontal: t.space.pad, paddingBottom: 10 },
    think: {
      fontFamily: t.fonts.serif, fontSize: 15.5, lineHeight: 25,
      color: t.c.txTertiary, paddingLeft: 22, paddingTop: 2,
    },
    out: {
      marginLeft: 22, backgroundColor: t.c.bgSecondary, borderRadius: t.radius.lg,
      paddingVertical: 10, paddingLeft: 12, overflow: 'hidden',
    },
    raw: { fontFamily: t.fonts.mono, fontSize: 12.5, lineHeight: 19.4, color: t.c.txSecondary },
    outNote: { fontSize: 12, color: t.c.txTertiary, lineHeight: 18, marginBottom: 6, marginRight: 12, fontFamily: t.fonts.sans },
    outMore: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      marginLeft: 22, paddingTop: 8, minHeight: 34,
    },
    outMoreTx: { color: t.c.txInfo, fontSize: 12.5, fontFamily: t.fonts.sans },

    end: {
      marginHorizontal: t.space.pad, marginTop: 8, marginBottom: 12,
      borderRadius: t.radius.xl, paddingHorizontal: 15, paddingVertical: 13,
    },
    endTitle: { fontSize: t.size.sm, fontWeight: t.weight.bold, marginBottom: 4, color: t.c.txPrimary, fontFamily: t.fonts.sans },
    endWhy: { fontFamily: t.fonts.mono, fontSize: 12, color: t.c.txSecondary, lineHeight: 18 },
    endFix: { marginTop: 7, color: t.c.txSecondary, fontSize: t.size.xs, lineHeight: 19, fontFamily: t.fonts.sans },
    // 发出去的附件：气泡上方一排小片，右对齐跟着气泡走
    sentFiles: {
      flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end',
      gap: 6, marginHorizontal: t.space.pad, marginBottom: 6,
    },
    sentFile: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      maxWidth: 200, paddingHorizontal: 9, paddingVertical: 5,
      borderRadius: t.radius.full, backgroundColor: t.c.bgSecondary,
    },
    // 缩略图比文件片大得多：owner「预览图片大一点」。90 是两张并排仍留得下气泡宽度的上限
    sentThumb: { width: 90, height: 90, borderRadius: t.radius.lg },
    sentFileTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txSecondary, flexShrink: 1,
    },
    // 划掉那颗放右上角，压在横幅里面——它不是主要动作，不该和文字抢位置
    endX: { position: 'absolute', top: 10, right: 10, padding: 4 },

    copied: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs,
      color: t.c.txTertiary, paddingHorizontal: 2,
    },
    turnFoot: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: t.space.pad, paddingTop: 2, paddingBottom: 14,
    },
    acts: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto' },
    act: { width: 36, height: 36, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center' },

    caught: {
      flexDirection: 'row', alignItems: 'center', gap: 9,
      marginHorizontal: t.space.pad, marginTop: 16, marginBottom: 10,
    },
    caughtLine: { flex: 1, height: t.hairline, backgroundColor: t.c.bdTertiary },
    caughtTx: { color: t.c.txTertiary, fontSize: 12, fontFamily: t.fonts.sans },
    turnErr: {
      marginHorizontal: t.space.pad, marginBottom: 12, paddingVertical: 11, paddingHorizontal: 14,
      borderRadius: t.radius.lg, backgroundColor: t.c.bgDanger,
    },
    turnErrTx: { color: t.c.txDanger, fontSize: 14, lineHeight: 21, fontFamily: t.fonts.sans },
    cmdOut: {
      marginHorizontal: t.space.pad, marginBottom: 12,
      color: t.c.txTertiary, fontSize: 13, lineHeight: 19, fontFamily: t.fonts.sans,
    },
    goal: {
      marginHorizontal: t.space.pad, marginBottom: 14, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: t.radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: t.c.bdTertiary,
    },
    goalHead: { color: t.c.txSecondary, fontSize: 13, fontWeight: '600', fontFamily: t.fonts.sans },
    goalCond: { marginTop: 4, color: t.c.txPrimary, fontSize: 14, lineHeight: 20, fontFamily: t.fonts.sans },
    goalWhy: { marginTop: 4, color: t.c.txTertiary, fontSize: 12.5, lineHeight: 18, fontFamily: t.fonts.sans },
  });
