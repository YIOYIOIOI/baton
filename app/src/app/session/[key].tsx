import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { keyboardStickyOffset, useKeyboardInset } from '@/layout/keyboard';
import { useTheme, type Theme } from '@/theme';
import { AttachMenu } from '@/components/AttachMenu';
import { SessionMenu, type View3 } from '@/components/SessionMenu';
import { FileLinks } from '@/components/markdown';
import { downloadSessionFile, exportSessionMarkdown } from '@/store/download';
import { useLocale } from '@/i18n';
import {
  BallSpinner, DotsIcon, FabPill, FabPillButton, FloatBar, Hist, Tappable, useFloatBarHeight,
} from '@/components/ui';
import { ScrollEdge } from '@/components/ScrollEdge';
import * as haptics from '@/feedback/haptics';
import { LinkDot } from '@/components/LinkDot';
import { Blocked, Notice } from '@/components/Notice';
import { LinkSheet } from '@/components/LinkSheet';
import * as Clipboard from 'expo-clipboard';
import { Composer } from '@/components/Composer';
import { useSlashMenu } from '@/components/SlashMenu';
import { useModels } from '@/store/useModels';
import { Live } from '@/components/Live';
import {
  pickAndUpload, uploadPicked, pickedFromFiles, attachmentSuffix, splitAttachments,
  type Attachment, type PickSource, type UploadBatch,
} from '@/store/attach';
import { Attachments } from '@/components/Attachments';
import { AskCard } from '@/components/Ask';
import {
  Caught, CommandOutput, GoalRow, Interrupted, MsgText, MsgUser, PendingMsg, Thinking, ToolCall, TurnEnd, TurnError, TurnFoot,
  TurnSummary,
} from '@/components/stream';
import { canSendFor, useConnection } from '@/store/connection';
import { SetupPill } from '@/components/Setup';
import { useSessionLive } from '@/store/useSessionLive';
import { getSecret, setSecret } from '@/store/secure';
import { commitSubmittedDraft, persistNextDraft, useDraft, useDraftAttachments, useDraftScope } from '@/store/drafts';
import { beginMobileSend, clearMobileSend, readMobileSends } from '@/store/mobilePending';
import { canRetrySend } from '@/api/sendWindow';
import { deliverMessage } from '@/api/delivery';
import { BatonError } from '@/api/client';
import { segment } from '@/api/runs';
import type { BatonEvent, Effort, QueuedMessage } from '@/api/types';

/**
 * 已经被划掉的「轮次结束」横幅，按 turnId 记。
 *
 * **必须放在模块级**：这一屏退出去再进来会重新挂载，组件状态留不住，而服务端
 * 仍然把最后一轮报成 failed——所以横幅会一次次重新出现。owner 实测：「额度不够
 * 弹了个红色错误提示，反复重进对话好几次，那个好像还在」。
 *
 * 那条横幅本来的语义是「这一轮刚刚结束了，结果是失败」，是一次性的通知；
 * 但它的判据是「最后一轮的状态」，那是个**永久事实**。两者对不上，所以需要
 * 一个「我看过了」的记号。
 *
 * 这是内存里那一份；**落盘的那份见下面**——只有模块级 Set 的话，网页端刷新一次
 * 就白划一次。
 */
const dismissedEnds = new Set<string>();

/**
 * 把划掉记录**落盘**，否则网页端每次刷新都白划一次。
 *
 * 上一版只有上面那个模块级 Set。原生端还行（App 常驻），但**网页端刷新一次就是
 * 一次新的模块加载**，Set 清零——owner 实测：「我刚刚进来的时候发现昨天的错误
 * 提示又跳出来了，又是我手动关掉的」。
 *
 * 用 secure.ts 那层（原生 SecureStore / 网页 localStorage）。存的是 turnId 列表，
 * 不是内容，没有敏感信息。**只留最近 50 条**：这是个纯粹的「看过了」标记，
 * 让它无限长下去没有意义，而一个只增不减的键迟早会撑爆 localStorage 的配额。
 */
const DISMISSED_KEY = 'baton.dismissedTurnEnds';
const DISMISSED_CAP = 50;

async function loadDismissed() {
  try {
    const raw = await getSecret(DISMISSED_KEY);
    for (const id of JSON.parse(raw ?? '[]') as string[]) dismissedEnds.add(id);
  } catch {
    // 读不出来就当没划过——多提醒一次，比把这一屏搞崩强
  }
}

function saveDismissed() {
  const keep = [...dismissedEnds].slice(-DISMISSED_CAP);
  dismissedEnds.clear();
  for (const id of keep) dismissedEnds.add(id);
  void setSecret(DISMISSED_KEY, JSON.stringify(keep)).catch(() => {});
}

/** 已经点了发送、还没在服务器记录里出现的一条。 */
/**
 * `before`：发送那一刻已经在记录里的用户消息 id。对账只认**这之后**冒出来的——
 * 2026-11-10 之前是「记录里有同样一句就算到了」，于是又发一遍「继续」时，上一回那句「继续」
 * 当场把这条顶掉：先看到思考动画，消息过几秒才冒出来（owner 报的就是这个）。
 */
type Pending = {
  id: string; text: string; failed: boolean; error: string | null; before?: Set<string>;
  accepted?: boolean; queueId?: string; syncPending?: boolean; retryDisabled?: boolean;
};

/**
 * 三档视图，和 Claude Code 桌面端一致（那边叫 Summary / Normal / Verbose，
 * 用 Ctrl+O 循环）：
 *   简洁  只留最终回复和改动
 *   标准  把过程折成一行（默认）
 *   完整  每一行输出都在
 *
 * 名字和那三句解释在 SessionMenu 里（菜单里直接选，不再另弹一块面板）。
 * 界面上**不写英文档位名**：一个中文界面里夹三个英文词，读起来就是没翻完。
 */

export default function SessionScreen() {
  const t = useTheme();
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const client = useConnection((s) => s.client);
  const link = useConnection((s) => s.link);
  const live = useSessionLive(key);
  const models = useModels();
  const { isEn, en, trNew } = useLocale();

  const [view, setView] = useState<View3>('normal');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [stopReply, setStopReply] = useState<{ turnId: string; note: string; stopping?: boolean } | null>(null);
  // 待发送的附件。不塞进草稿——发送那一刻才把路径拼到正文末尾。
  // 和草稿一样按会话存在这一屏之外，返回再进来还在（见 store/drafts.ts）
  const [attachments, setAttachments] = useDraftAttachments(key);
  const [linkSheet, setLinkSheet] = useState(false);
  /** 右上角「…」点开的那张菜单。贴着按钮弹，不是从底下升起来（见 SessionMenu）。 */
  const [menu, setMenu] = useState(false);
  /** 输入区的实测高度，给滚动区当底部留白。见 ScrollView 的 contentContainerStyle。 */
  const [composerH, setComposerH] = useState(0);
  /** 下拉同步中。只驱动那个转圈，不参与任何别的判断。 */
  const [syncing, setSyncing] = useState(false);
  /**
   * 加号点开后先选来源。
   *
   * owner：「那个加号那里，点开后应该再弹出选框，选拍照还是照片还是附件」。
   * 原来点加号直接开文件选择器——想发一张刚拍的照片，得先去相机 app 拍完、
   * 再回来在文件里翻出来。ChatGPT 和 Claude 的加号都是先给这三个。
   */
  const [attachSheet, setAttachSheet] = useState(false);
  /** 加号在屏幕坐标里的位置，菜单卡片贴着它弹出。按下那一刻量的，见 Composer。 */
  const [attachAnchor, setAttachAnchor] = useState<{ x: number; y: number } | null>(null);
  const [chainSize, setChainSize] = useState(1);
  /**
   * 草稿按会话存在这一屏之外。原来是这里的 useState，owner：「我打完字如果返回
   * 好像在回来的时候字会消失」——返回就卸载，字跟着没了。见 store/drafts.ts。
   */
  const [draft, setDraft] = useDraft(key);
  const draftOwner = useDraftScope();
  const allowSend = useConnection((s) =>
    s.principalAccess && s.principalAccess.scope === draftOwner ? s.principalAccess.allowSend : null);
  /** 输入框里的光标（`/` 菜单看的是光标所在那个词）和插入之后要放回的位置 */
  const [caret, setCaret] = useState(0);
  const [forceSel, setForceSel] = useState<{ start: number; end: number } | undefined>(undefined);
  /**
   * 已经点了发送、但还没在服务器的记录里出现的那些。
   *
   * 它们画在流的末尾，样子和真气泡一样，下面多一行状态。落定之后由下面那段
   * 「对账」把它们撤掉——不靠计时器，也不靠 send 成功就立刻删：那两种做法在
   * 「请求成功但记录还没落盘」的那一小段里会让消息**闪一下消失**。
   */
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => {
    if (!draftOwner) { setPending([]); return; }
    try {
      setPending(readMobileSends(draftOwner, key).map((entry) => {
        const expired = !canRetrySend(entry.startedAt);
        return { id: entry.id, text: entry.text, failed: true, retryDisabled: expired, error: trNew(expired ? 'session.expiredSend' : 'session.unconfirmedSend') };
      }));
    } catch { setPending([{ id: 'storage-error', text: '', failed: true, retryDisabled: true, error: trNew('session.pendingStorage') }]); }
    // Rehydrate only on entering a session or changing identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftOwner, key]);
  const scRef = useRef<ScrollView>(null);
  const initialScrollDone = useRef(false);
  const nearBottom = useRef(true);
  const prevComposerH = useRef(0);
  const barH = useFloatBarHeight();
  const inset = useSafeAreaInsets();
  const kbInset = useKeyboardInset(inset.bottom);

  useEffect(() => {
    void client?.health().catch(() => {});
    // 这条会话属于哪条链、链上有几个。列表行按设计不许出现任何文字，
    // 所以「有分叉」这件事只能在这里露出来。
    client?.sessions()
      .then((r) => setChainSize(
        r.chains.find((c) => c.members.some((m) => m.key === key))?.members.length ?? 1,
      ))
      .catch(() => {});
  }, [client, key]);

  /**
   * 回到这一屏时把「正在上传」清掉。
   *
   * 这是**兜底**，不是主修——主修是别在面板没关完时去 present（见 pendingSource）。
   * 但这个标志一旦卡住，加号就永久点不动，代价太大，所以留一条恢复路径：
   * 退出去再进来就好了，而这正好是 owner 遇到问题时本来就会做的动作。
   *
   * 不怕误清：离开这一屏就意味着那次选择已经作废了。
   */
  useFocusEffect(useCallback(() => { setAttaching(false); }, []));

  // 划掉横幅之后要重画一次：dismissedEnds 在模块级，改它不会触发渲染。
  // 声明必须在下面那个 effect **之前**：运行时本来不会错（effect 在渲染完才跑），
  // 但 React Compiler 按源码顺序判「先用后声明」，会因此放弃优化整个会话屏
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // 落盘的「已划掉」读回内存。读完 bump 一次让横幅当场消失，别等下一次渲染
  useEffect(() => { void loadDismissed().then(() => bump()); }, []);

  const toggle = useCallback((k: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }, []);

  // Verbose 档默认全开，另两档默认全关——所以「开」的含义要跟着档位反过来
  const isOpen = useCallback(
    (k: string) => (view === 'verbose' ? !open.has(k) : open.has(k)),
    [view, open],
  );

  const running = live.turn?.status === 'running';
  const currentTick = live.tick?.turnId === live.turn?.turnId ? live.tick : null;
  const reply = running && stopReply?.turnId === live.turn?.turnId ? stopReply : null;
  const monitorOnly = live.turn?.canStop === false || currentTick?.canStop === false || reply?.stopping === false;
  const stopping = live.turn?.stopReason || currentTick?.stopping || reply?.stopping;
  const canInterrupt = !running || (!monitorOnly && !stopping);
  const stopNote = running && (monitorOnly
    ? trNew('session.stopOnDesktop')
    : stopping ? trNew('session.stopping') : reply?.note);

  /**
   * 一轮**在眼前**跑完时震一下：成功一下轻的、失败一下错误型。haptics.ts 抬头早就把
   * 「一轮跑完」列进了该震的场合，但一直没接上——人盯着屏幕等结果时，手上的那一下
   * 比看到球停转更早被注意到。
   *
   * 只认「同一轮从 running 变成结束」：进来时那一轮早就结束了不震，换了一轮也不震。
   * 被人自己点停（aborted）不震——那是他刚做的动作，不是新消息。网页上这一下发生在
   * 异步回来之后，iOS Safari 不会震（见 webHaptics.ts），这是那条路的已知代价。
   */
  const lastTurn = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const cur = live.turn ? { id: live.turn.turnId, status: live.turn.status } : null;
    const prev = lastTurn.current;
    lastTurn.current = cur;
    if (!prev || !cur || prev.id !== cur.id || prev.status !== 'running' || cur.status === 'running') return;
    if (cur.status === 'ok') haptics.success();
    else if (cur.status === 'failed' || cur.status === 'anomaly') haptics.fail();
  }, [live.turn]);

  // 会话详情默认落在最新一条消息，而不是把用户丢在历史开头。
  // 等底部浮层（composerH）量出真实高度后再滚到底，免得首帧被输入区和排队卡盖住半截；
  // 标志放在 RAF 回调内再置 true，避免首帧前布局/事件更新取消 RAF 后永久丢失初始滚动。
  useEffect(() => {
    if (live.loading || !live.events.length || composerH <= 0 || initialScrollDone.current) return;
    const frame = requestAnimationFrame(() => {
      initialScrollDone.current = true;
      prevComposerH.current = composerH;
      scRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [live.loading, live.events.length, composerH]);

  // 底部浮层长高时（排队卡/选择题出现、输入区换行），若用户本就在底部附近，
  // 顺手补滚到底部，避免最新一条消息和运行指示被新长出来的浮层遮住。
  useEffect(() => {
    const prev = prevComposerH.current;
    prevComposerH.current = composerH;
    if (!initialScrollDone.current || composerH <= prev || !nearBottom.current) return;
    const frame = requestAnimationFrame(() => {
      scRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [composerH]);

  /**
   * 真正往外送。**失败不抛，落在那条 pending 上**——界面要看得见。
   *
   * 旧版这里的 catch 只认 `send_disabled`，其余（网络失败、超时、500）全部吞掉：
   * 屏幕上一个字都不显示、草稿还留在框里，owner 实测就是「点击发送没有响应」。
   */
  const deliver = useCallback(async (id: string, full: string, source?: { draft: string; attachments: typeof attachments }) => {
    if (!client || !draftOwner || !canSendFor(client, draftOwner)) return;
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, failed: false, error: null } : p)));
    try {
      const entry = readMobileSends(draftOwner, key).find((r) => r.id === id);
      if (!entry || entry.text !== full) throw new Error(trNew('session.pendingStorage'));
      if (!canRetrySend(entry.startedAt)) {
        setPending((prev) => prev.map((p) => p.id === id ? { ...p, failed: true, retryDisabled: true, error: trNew('session.expiredSend') } : p));
        return;
      }
      try {
        commitSubmittedDraft(entry, source?.draft ?? entry.sourceDraft ?? splitAttachments(full).body, !!source);
        if (source) setAttachments((files) => files.filter((f) => !source.attachments.includes(f)));
        else if (!entry.draftConsumed) {
          const sent = new Set(splitAttachments(full).files.map((f) => f.relative));
          if (sent.size) setAttachments((files) => files.filter((f) => !sent.has(f.relative)));
        }
      } catch { throw new Error(trNew('session.pendingStorage')); }
      const { refreshed } = await deliverMessage(client, key, entry.id, entry.text, live.refreshState, (result) => {
        try { persistNextDraft(draftOwner, key); } catch { throw new Error(trNew('session.pendingStorage')); }
        clearMobileSend(draftOwner, key, entry.id);
        setPending((prev) => prev.map((p) => p.id === id
          ? { ...p, accepted: true, queueId: result.queued ? result.queueId : undefined } : p));
      }, entry.fork, entry.when);
      if (!refreshed) setPending((prev) => prev.map((p) => p.id === id ? { ...p, syncPending: true } : p));
    } catch (e) {
      const msg = e instanceof Error && e.message === 'send_unconfirmed' ? trNew('session.unconfirmedSend') : (e as Error).message;
      if (e instanceof BatonError && e.code === 'send_disabled') {
        useConnection.setState((s) => s.client === client && s.principalAccess?.scope === draftOwner
          ? { principalAccess: { scope: draftOwner, allowSend: false } } : s);
      }
      setPending((prev) => prev.map((p) => (p.id === id ? { ...p, failed: true, error: msg } : p)));
    }
  }, [client, draftOwner, key, live, setAttachments, trNew]);

  /**
   * 发送。**同步的**——点下去立刻成为气泡、立刻清空输入框，不等网络往返。
   *
   * owner：「就算是因为网络问题发不出去也应该页面上是让我的消息先弹到消息历史里面
   * 作为气泡，然后用状态条提示当前情况吧？」。这条在这个 App 上格外要紧：
   * 手机断连是常态不是异常（CLAUDE.md 第三条坑）。
   */
  const send = useCallback(() => {
    const text = draft.trim();
    // 只有附件没有文字也允许发——「看看这张图」这种情况下正文本来就是空的
    if (!text && !attachments.length) return;
    // 自己又说话了，「你离线时补上这些」那条界线就过期了
    live.clearCaughtUp();
    /**
     * **没配对时也要看得见。**
     *
     * 旧版这里是 `|| !client` 直接 return——而 `client` 为 null 正是「还没配对
     * 或配对丢了」的样子。于是点发送**一点反应都没有**，输入框还原样留着，
     * 人完全不知道发生了什么。而配对丢失并不罕见：换开发服务器、清了网站数据
     * 都会让它没。
     */
    if (!client) {
      setPending((prev) => [...prev, {
        id: `p${Date.now()}`,
        text: text + attachmentSuffix(attachments),
        failed: true,
        error: '还没和电脑配对。到「关于」里重新扫一次配对码。',
      }]);
      return;
    }
    if (!canSendFor(client, draftOwner)) return;
    // 路径在发送这一刻才拼上去。agent 只认磁盘路径，不给它路径就看不见文件。
    const full = text + attachmentSuffix(attachments);
    let id: string;
    try {
      const entry = beginMobileSend(draftOwner, key, full, false, 'auto', draft);
      id = entry.id;
      if (!canRetrySend(entry.startedAt)) {
        setPending((prev) => [...prev.filter((p) => p.id !== id), { id, text: full, failed: true, retryDisabled: true, error: trNew('session.expiredSend') }]);
        return;
      }
    }
    catch {
      setPending((prev) => [...prev.filter((p) => p.id !== 'storage-error'), { id: 'storage-error', text: full, failed: true, retryDisabled: true, error: trNew('session.pendingStorage') }]);
      return;
    }
    const before = new Set(live.events.filter((e) => e.kind === 'text' && e.role === 'user').map((e) => e.id));
    setPending((prev) => [...prev.filter((p) => p.id !== id), { id, text: full, failed: false, error: null, before }]);
    void deliver(id, full, { draft, attachments });
  }, [draft, attachments, client, deliver, draftOwner, key, live, trNew]);

  const stop = useCallback(async () => {
    if (!client || !live.turn) return;
    const { turnId } = live.turn;
    try {
      const r = await client.stop(key, turnId);
      if (r.note) setStopReply({ turnId, note: r.note, stopping: r.stopping });
    } catch (e) {
      setAttachErr((e as Error).message);
    }
  }, [client, key, live.turn]);

  /**
   * 撤回排着的某一条。
   *
   * 先在本地去掉那一行再刷状态：不这么做的话，从按下到服务端回话之间那一行还在，
   * 人会以为没点着、再点一次。真撤不掉（它已经发出去了）时把它放回去并说清楚——
   * **绝不假装撤掉了**：人以为撤了，结果 agent 照着那条干了活，比没有撤回更糟。
   */
  const cancelQueued = useCallback(async (item: QueuedMessage) => {
    if (!client) return;
    live.setQueued((prev) => prev.filter((q) => q.id !== item.id));
    try {
      await client.cancelQueued(key, item.id);
    } catch (e) {
      live.refreshState().catch(() => {});
      setAttachErr(e instanceof BatonError ? e.message : '撤回失败，刷新看看它是不是已经发出去了。');
    }
  }, [client, key, live]);

  /**
   * 提升服务端已有的队列项，失败时保留原来的队列消息。
   */
  const sendNow = useCallback(async (item: QueuedMessage) => {
    if (!client) return;
    try {
      await client.promoteQueued(key, item.id);
    } catch (e) {
      setAttachErr(e instanceof BatonError ? e.message : trNew('session.promoteFailed'));
    }
    void live.refreshState().catch(() => {});
  }, [client, key, live, trNew]);

  /**
   * 传文件。传完**不自动发送、也不动输入框里的字**——只在输入框上方多一个缩略图。
   *
   * 上一版会往草稿里塞一句「我传了一个文件到 …，你读一下」。owner 直接点名要去掉：
   * 那等于替他决定了这一轮说什么，而且他想改写这句话还得先绕开它。
   * 路径改在**发送那一刻**拼到正文末尾（见 send）——文件落在工作目录下的
   * .baton-uploads/，两个 CLI 在非交互模式下都只从磁盘按路径读文件，
   * 没有附件通道，所以路径仍然得给，只是不该占着他的输入框。
   */
  /**
   * 「拿到文件之后」这一半：转圈、收附件、报错。
   *
   * 抽出来是因为现在有**两条**拿文件的路，而这一半两条完全一样：
   *   - 原生：加号弹我们那张卡片，再走 expo 的选择器（pickAndUpload）
   *   - 网页：加号底下压着一个真 `<input type="file">`，浏览器直接把文件交过来
   *     （uploadPicked，不经过选择器——理由见 Composer.tsx 里加号那段）
   */
  const runUpload = useCallback(async (
    run: (onPicking: (n: number) => void) => Promise<UploadBatch>,
  ) => {
    if (!client || attaching || !canSendFor(client, draftOwner)) return;
    /**
     * **转圈不在这儿开。**
     *
     * 原来一进来就 `setAttaching(true)`——那时候人才刚看到相册，还在翻，
     * 而加号已经在转了（owner：「我还没上传图片那个加号就开始转圈」）。
     * 那个转圈的含义是「正在上传」，就该等真的开始传再亮，由 `onPicking` 触发。
     */
    setAttachErr(null);

    /**
     * **绝不允许"永久转圈"这种状态存在。**
     *
     * 选择器的 promise 在两个平台上都可能**永远不 resolve**，而且成因相反：
     * 原生是在前一个 modal 没关完时 present 被 UIKit 拒了；web 是合成点击掉出了
     * 用户手势的激活窗口、选择器压根没开（两者都只在 change/回调里 resolve）。
     * 两条都已经分别修掉了，但这类问题的代价太大——一旦卡住，加号就再也点不动。
     *
     * 所以留一个计时器：到点只把**界面**解开，不取消那次选择。用户要是真的在
     * 相册里翻了两分钟，promise 后面照样 resolve，附件照样加进来。
     */
    const relief = setTimeout(() => {
      setAttaching(false);
      setAttachErr('选择器好像没打开。再点一次加号试试。');
    }, 60_000);

    try {
      const batch = await run(() => {
        // 选完了、开始传——这一刻才该转圈
        clearTimeout(relief);
        setAttaching(true);
      });
      setAttachErr(null); // 真回来了就把上面那句提示撤掉
      if (batch.ok.length) setAttachments((prev) => [...prev, ...batch.ok]);
      // 部分失败：成功的已经收下，剩下的如实说一句，不把整批丢掉
      if (batch.failed) {
        setAttachErr(batch.ok.length
          ? `${batch.failed} 个没传上去（${batch.error}），其余已收下。`
          : (batch.error ?? '没传上去。'));
      }
    } catch (e) {
      setAttachErr(e instanceof BatonError ? e.message : (e as Error).message);
    } finally {
      clearTimeout(relief);
      setAttaching(false);
    }
  }, [client, attaching, draftOwner, setAttachments]);

  /** 原生那条：弹卡片 → expo 选择器。 */
  const attach = useCallback((source: PickSource) => {
    if (!client) return;
    void runUpload((onPicking) => pickAndUpload(client, key, source, onPicking));
  }, [client, key, runUpload]);

  /** 网页那条：文件已经在手上了，直接传。 */
  const attachFiles = useCallback((files: File[]) => {
    if (!client) return;
    void runUpload((onPicking) => uploadPicked(client, key, pickedFromFiles(files), onPicking));
  }, [client, key, runUpload]);

  const pickModel = useCallback(async (m: string | null) => {
    if (!client) return;
    try {
      await client.setModel(key, m);
      await live.refreshState();
    } catch {
      // 失败时不动本地显示：显示一个没生效的新值，比显示旧值更糟
    }
  }, [client, key, live]);

  const pickEffort = useCallback(async (e: Effort | null) => {
    if (!client) return;
    try {
      await client.setEffort(key, e);
      await live.refreshState();
    } catch {
      // 同上：失败时不动本地显示。Codex 会被服务端拒，而界面上那一节本来
      // 就已经说了它没有这个开关，不必再弹一次错。
    }
  }, [client, key, live]);

  /**
   * 对账：服务器记录里已经出现的，对应那条待发就该撤掉。
   *
   * **逐条消费而不是用 Set**：同一句话连发两遍时，一条真消息只顶掉一条待发，
   * 否则第二条会在真正到达之前凭空消失。
   *
   * 失败的那些一直留着——它们等的是人的决定（重试还是不发了），不是服务器。
   */
  /** 输入框的 `/` 菜单（SlashMenu.tsx）。点一行：换掉光标所在那个词，光标放到插入的后面 */
  const slashMenu = useSlashMenu({
    sessionKey: key,
    agent: live.agent,
    value: draft,
    caret,
    onPick: (v, pos) => {
      setDraft(v);
      setCaret(pos);
      setForceSel({ start: pos, end: pos });
    },
  });

  const unsettled = useMemo(() => {
    const used = new Set<string>();
    return pending.filter((p) => {
      if (p.queueId && live.queued.some((q) => q.id === p.queueId)) return false;
      if (!p.accepted) return true;
      const hit = live.events.find((e) => e.kind === 'text' && e.role === 'user'
        && !used.has(e.id) && !p.before?.has(e.id) && (e.text ?? '') === p.text);
      if (!hit) return true;
      used.add(hit.id);
      return false;
    });
  }, [pending, live.events, live.queued]);

  /**
   * 别的设备（或电脑网页）发的、agent 还没写进记录的那一句。服务端的轮次带着原文（turn.prompt），
   * 在这轮开始之后写下的用户消息出现前先摆出来。两个时间都是电脑上的钟，手机钟不准不影响。
   * 这台手机自己发的那条已经是 pending 了，不重复。
   */
  const turnEcho = useMemo(() => {
    const t = live.turn;
    if (!t || t.status !== 'running' || !t.prompt) return null;
    if (unsettled.some((p) => p.text === t.prompt)) return null;
    const landed = live.events.some((e) => e.kind === 'text' && e.role === 'user'
      && (Date.parse(e.ts ?? '') || 0) >= t.startedAt - 2000);
    return landed ? null : t.prompt;
  }, [live.turn, live.events, unsettled]);

  // 对完账就把状态里那些也清掉，否则 pending 只增不减
  useEffect(() => {
    if (unsettled.length !== pending.length) setPending(unsettled);
  }, [unsettled, pending.length]);

  /**
   * agent 在正文里写的文件链接被点了。
   *
   * 这些链接**不是我们要求的**，是 Claude Code 自己的系统提示要求模型这么写的
   * （`[foo.ts](src/utils/foo.ts)`，相对工作目录）。所以这儿不用改 agent 一个字，
   * 只需要把它们接到下载端点上——那正是「复用官方逻辑」。
   *
   * `:42` 这种行号后缀要先剥掉：宿主那边用它跳到某一行，而我们这儿是要取整个
   * 文件，带着它服务端只会找不到。
   */
  const openLinkedFile = useCallback(async (href: string) => {
    if (!client) return;
    const rel = href.replace(/:\d+(:\d+)?$/, '');
    const name = rel.split('/').pop() || rel;
    setAttachErr(null);
    try {
      await downloadSessionFile(client, key, rel, name);
    } catch (e) {
      setAttachErr(`${name}：${(e as Error).message}`);
    }
  }, [client, key]);

  const segs = useMemo(() => segment(live.events), [live.events]);
  const s = styles(t);

  /**
   * 这条 agent 正文底下该不该给收尾那一排。
   *
   * **正在写的那条也给**，只是那颗球在转、右边不给动作——位置不变、只有动静变
   * （owner：「agent 在运行的时候，底下那个 logo 可以出现在那个位置，但是他要有
   * 一个正在运行的动画让人区分，然后正好 agent 执行完毕后那个 logo 就静止了」）。
   *
   * 「跑着的时候不给复制」这条判断没变：内容还在长，复制到的是半截。
   * 判据用 `live.run`——它是运行轴，比「有没有新事件进来」可靠。
   *
   * `last` 是这一屏最后一条 agent 正文。只有它可能还在写，前面的都写完了，
   * 所以往回翻时每一条都该有。
   */
  const foot = (e: BatonEvent, last: boolean) => {
    /**
     * **还在写的那条不给收尾行**——那颗转着的球由流末尾的 `Live` 负责。
     *
     * 原来两处都画：这条消息底下一颗在转的球，滚动区末尾又一条带呼吸点的状态行。
     * owner：「底部状态栏和模型的消息里面的状态感觉重复了」。确实是同一件事说了
     * 两遍，而且两个形象还不一样。
     *
     * 现在只有一处：**跑着的时候在流末尾**（Live：转着的 logo + 计时 + 在干什么），
     * **跑完之后在消息末尾**（这里：静止的 logo + 复制）。位置顺势下移，形象不变，
     * 只有动静变——这正是 owner 一开始描述的那个设计。
     */
    if (last && live.run === 'streaming') return null;
    return (
      <TurnFoot
        key={`f${e.id}`}
        onCopy={() => Clipboard.setStringAsync(e.text ?? '')}
      />
    );
  };

  /** 这一屏最后一条 agent 正文的 id。只有它可能还没写完。 */
  const lastAgentId = [...live.events].reverse()
    .find((e) => e.kind === 'text' && e.role !== 'user')?.id ?? null;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {link !== 'ok' ? (
        <View style={[s.col, { paddingTop: barH + 4 }]}><Notice link={link} onAction={live.refreshState} /></View>
      ) : null}

      <ScrollView
        ref={scRef}
        style={s.scrollView}
        /**
         * 下拉同步。iOS 上「重新取一次」的标准手势，不占任何界面位置。
         *
         * owner 遇到过「手机上看不到消息、电脑上刷新却有」——那种时候界面在说谎，
         * 而人手上没有任何能自证的动作。这条给的就是那个动作。
         * 「更多」里还有一条一样的，给不知道这个手势的人。
         */
        refreshControl={(
          <RefreshControl
            refreshing={syncing}
            onRefresh={() => {
              setSyncing(true);
              void live.refreshState().finally(() => setSyncing(false));
            }}
            tintColor={t.c.txTertiary}
          />
        )}
        /**
         * 内容**一直铺到屏幕底**，从输入区底下穿过去——照 ChatGPT（owner：「我看了
         * gpt，他根本没设下边界，文字是到底的，学它的设计」）。
         *
         * 所以输入区改成绝对定位浮在上面，滚动区自己留出等高的底部空白：
         *
         *   composerH   输入区的**实测**高度。不写死——它会随字数、附件、错误横幅长高
         *   kbInset     键盘抬起多少就再多留多少，否则最后几条被抬起来的输入区盖住
         *
         * 这样既没有「文字停在一条看不见的界线上被切半个字」（上一版加固定留白
         * 只是把界线挪了个位置，没去掉它），又能把每一条都滚出来。
         */
        contentContainerStyle={[
          s.scroll,
          { paddingTop: link === 'ok' ? barH + 4 : 4, paddingBottom: composerH + kbInset + 20 },
        ]}
        scrollEventThrottle={120}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          nearBottom.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) <= 96;
        }}
        onContentSizeChange={() => {
          // 断连时不自动滚：那会把用户正在读的位置抢走，而这时候他最需要的
          // 恰恰是「刚才说到哪了」
          if (running && !live.stopwatchStale) scRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {/*
          **进会话时的加载态。** 内容还没到之前中间放一颗大的球在转
          （owner：「进入已有的对话的时候，在加载消息的时候要用动画，
          可以是我们的那个 logo 球进行某种动画」）。

          判据是 `loading && 一条都还没有`：只要已经有内容了就不该再挡着——
          上拉加载更早的那条走的是 `loadingOlder`，它自己有「载入中…」那行字。

          不用骨架屏：这一页的内容是**长短不一的对话**，骨架屏得先编一个假的
          形状出来，而编出来的形状十有八九和真内容对不上，反而像加载错了。
        */}
        {live.loading && live.events.length === 0 ? (
          <View style={s.booting}>
            <BallSpinner size={44} />
          </View>
        ) : null}

        {live.hasOlder ? (
          <Pressable
            style={({ pressed }) => [s.older, pressed && { backgroundColor: t.c.bgSecondary }]}
            onPress={() => { void live.loadOlder(); }}
            disabled={live.loadingOlder}
            accessibilityRole="button"
            accessibilityState={{ busy: live.loadingOlder, disabled: live.loadingOlder }}
          >
            <Hist>{live.loadingOlder ? '载入中…' : '更早的对话'}</Hist>
          </Pressable>
        ) : (
          <Hist>对话开头</Hist>
        )}

        <FileLinks onOpen={(h) => void openLinkedFile(h)}>
        {view === 'summary' ? (
          <>
            {/*
              文案按「用户视角」写，不报内部计数。
              原来这里是「这一屏 N 个事件，其中 M 个是工具活动，Summary 档全部隐去」——
              「事件」「档」都是我们的词，用户只需要知道：过程被收起来了，怎么打开。
            */}
            <Hist>
              {hiddenCount(live.events) > 0
                ? `已隐去 ${hiddenCount(live.events)} 步操作过程，只看结果`
                : '只看结果'}
            </Hist>
            {/*
              「只看结果」也要带上「这一轮被打断」和「这一轮出错了」：那一轮**没有**结果，
              而这两句正是原因。只留正文的话，那一轮在这个视图里就凭空消失了。
            */}
            {live.events.filter((e) => e.kind === 'text' || e.kind === 'interrupt' || (e.kind === 'turn_end' && e.error)
              || (e.kind === 'goal' && e.goal?.met)).map((e) => {
              if (e.kind === 'interrupt') return <Interrupted key={e.id} text={e.text ?? ''} />;
              if (e.kind === 'goal') return <GoalRow key={e.id} text={e.text ?? ''} met reason={e.goal?.reason ?? null} />;
              if (e.kind === 'turn_end') return <TurnError key={e.id} text={e.error ?? ''} />;
              return e.role === 'user'
                ? <MsgUser key={e.id} text={e.text ?? ''} fromPhone={e.origin === 'sdk'} sessionKey={key} />
                : (
                  <View key={e.id}>
                    <MsgText text={e.text ?? ''} />
                    {foot(e, e.id === lastAgentId)}
                  </View>
                );
            })}
          </>
        ) : (
          segs.map((seg, i) => {
            /*
              「重连后补上 N 条」。画在**补回来那批的第一条前面**，不是列表末尾
              ——它标的是「以下是你离线时发生的」这条界线。

              手机断连是常态（设计文档原话），补回来却不说一声的话，人会以为
              自己一直在线、什么都没错过。这个组件 09-12 就画好了，一直没接上。

              那一条落在一段活中间时，线画在这段活前面：折起来的一行没法从中间切开。
              原来只拿每段的第一条去比，落在中间就一条线都没有。
            */
            const boundary = live.caughtUpFrom !== null && seg.ids.includes(live.caughtUpFrom)
              ? <Caught key="caught" n={live.caughtUp} />
              : null;

            if (seg.kind === 'calls') {
              const k = `seg${seg.ids[0]}`;
              /*
                思考也在这段活里，按原来的先后夹在调用之间——原来每条思考都切一刀，
                两段正文之间本来是一段活，被切成好几行「改了 1 个文件」「跑了 2 条命令」。
              */
              const body = seg.steps.map((st) => {
                if (st.t === 'think') {
                  const th = st.event;
                  return <Thinking key={th.id} text={th.text ?? ''} open={isOpen(th.id)} onToggle={() => toggle(th.id)} />;
                }
                const p = st.pair;
                const carrier = p.result ?? p.call;
                return (
                  <ToolCall
                    key={p.call.id}
                    event={p.call}
                    result={p.result}
                    open={isOpen(p.call.id)}
                    onToggle={() => toggle(p.call.id)}
                    onFull={() => router.push({
                      pathname: '/full/[key]',
                      params: { key, eventId: carrier.id, offset: String(carrier.offset) },
                    })}
                  />
                );
              });
              if (view === 'verbose') return <View key={k}>{boundary}{body}</View>;
              return (
                <View key={k}>
                {boundary}
                <TurnSummary
                  steps={seg.steps}
                  live={!!running && i === segs.length - 1}
                  open={open.has(k)}
                  onToggle={() => toggle(k)}
                >
                  {body}
                </TurnSummary>
                </View>
              );
            }
            const e = seg.event;
            if (e.kind === 'thinking') {
              return (
                <View key={e.id}>
                  {boundary}
                  <Thinking text={e.text ?? ''} open={isOpen(e.id)} onToggle={() => toggle(e.id)} />
                </View>
              );
            }
            if (e.kind === 'interrupt') {
              return <View key={e.id}>{boundary}<Interrupted text={e.text ?? ''} /></View>;
            }
            if (e.kind === 'command_output') {
              return <View key={e.id}>{boundary}<CommandOutput text={e.text ?? ''} /></View>;
            }
            if (e.kind === 'goal') {
              return (
                <View key={e.id}>
                  {boundary}
                  <GoalRow text={e.text ?? ''} met={e.goal?.met === true} reason={e.goal?.reason ?? null} status={e.goal?.status} />
                </View>
              );
            }
            /*
              下面那个分支是「不是 user 就当 agent 正文」，所以**只有 text 能走进去**。

              原来什么都往里掉。codex 的 turn_end 带着 `text: last_agent_message`，
              于是每一轮的最终回答被它**再画一遍**——2026-09-29 实测 43 个 codex 会话、
              310 次，和上一条 agent 正文逐字相同；而真正出错的那几轮（31 次），
              错误原因反而一个字都不显示。和网页端对齐：正常结束不占行，出错才说话。

              不认识的 kind 同理不画成正文——宁可少一行，也不要编一句 agent 说的话。
              但补上的那条分界线（boundary）要留着：它可能正好挂在这一条上。
            */
            if (e.kind === 'turn_end' && e.error) {
              return <View key={e.id}>{boundary}<TurnError text={e.error} /></View>;
            }
            if (e.kind !== 'text') return boundary ? <View key={e.id}>{boundary}</View> : null;
            return (
              <View key={e.id}>
                {boundary}
                {e.role === 'user'
                  ? <MsgUser text={e.text ?? ''} fromPhone={e.origin === 'sdk'} sessionKey={key} />
                  : (
                    <>
                      <MsgText text={e.text ?? ''} />
                      {foot(e, e.id === lastAgentId)}
                    </>
                  )}
              </View>
            );
          })
        )}

        {/*
          还没落定的那几条，接在真消息后面。样子和真气泡一样，只多一行状态——
          落定时屏幕上不该有任何跳动，见 PendingMsg 抬头。
        */}
        {turnEcho !== null && <MsgUser text={turnEcho} fromPhone={false} sessionKey={key} />}
        {unsettled.map((p) => (
          <PendingMsg
            status={p.syncPending ? trNew('session.sentSyncPending') : p.accepted ? trNew('session.accepted') : undefined}
            key={p.id}
            text={p.text}
            failed={p.failed}
            error={p.error}
            onRetry={p.retryDisabled || allowSend !== true ? undefined : () => deliver(p.id, p.text)}
            onDrop={() => {
              if (draftOwner) clearMobileSend(draftOwner, key, p.id);
              setPending((prev) => prev.filter((x) => x.id !== p.id));
            }}
          />
        ))}

        {/*
          运行指示跟在**对话末尾**，不再是压在输入框上方的固定状态栏。

          owner：「agent 思考的那个 logo 动效是要跟在 agent 对话的下方，不是对话框
          的上方」。两家的做法也是这个——「正在想」是这一轮对话的一部分，读起来该
          接在最后一条后面；做成常驻横条会变成一个和对话无关的仪表盘。
          聊天本来就吸在底部，跑着的时候它自然就在视线里。
        */}
        <Live
          run={live.run}
          elapsedMs={live.elapsedMs}
          tokens={tokenTotal(live.turn?.tokens)}
          doing={live.doing}
          stale={live.stopwatchStale}
        />

        </FileLinks>

        {live.turn && !dismissedEnds.has(live.turn.turnId) ? (
          <TurnEnd
            status={live.turn.status}
            error={live.turn.error}
            onDismiss={() => { dismissedEnds.add(live.turn!.turnId); saveDismissed(); bump(); }}
          />
        ) : null}
      </ScrollView>

      {/*
        输入区整块跟着键盘抬起。**位移跑在 UI 线程**——`KeyboardStickyView` 跟的是
        键盘的实际位置，不是复刻一条参数相同的动画，所以不会「起来得比键盘慢」。
        前两版为什么不行，见 layout/keyboard.ts 抬头那三条。

        `offset` 由 `keyboardStickyOffset()` 算：**先往下抵掉输入框本来预留的底部
        安全区**（键盘上来之后那块被盖住了，不抵掉就是凭空多出 34pt 的空档——
        owner 第一版实测「现在又太远了」），再往上留出那道窄缝。
        传进去的外边距必须和 Composer 里实际用的那个式子一致。
      */}
      {composerH > 0 ? <ScrollEdge edge="bottom" height={Math.min(composerH + 22, 260)} /> : null}
      <KeyboardStickyView
        // 浮在滚动内容之上，不再占用布局空间——内容要能从它底下穿过去（见 ScrollView）
        style={s.dock}
        offset={keyboardStickyOffset(Math.max(10, inset.bottom))}
        pointerEvents="box-none"
      >
      <View
        style={s.dockInner}
        // 高度实测给滚动区当底部留白用。只在真的变了时才 set：onLayout 会重复触发
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setComposerH((prev) => (prev === h ? prev : h));
        }}
        pointerEvents="box-none"
      >
      {/*
        agent 出的选择题。放在输入区里、不放进滚动的对话流里：它挂着的时候
        **那一轮正停着等它**，滚上去看别的内容时它不该跟着滚走——那等于把
        「一轮正卡在这儿」藏起来。见 components/Ask.tsx 抬头。
      */}
      {live.ask && client ? (
        <AskCard
          // 换了一道题就是另一张卡：让 React 重建，上一道勾过的选项不会跟过来
          key={live.ask.askId}
          ask={live.ask}
          onAnswer={(input) => client.answer(key, input)}
          onDone={live.clearAsk}
        />
      ) : null}

      {/*
        排着的消息**要能撤回**（owner 2026-10-09：「排队的消息现在还不能撤回」）。
        排队本来就是「等一会儿再发」，而人改主意是常事——打错了、想重说、不想发了。
        没有撤回，它就是一列开出去就停不下来的车。

        「插队」一直给（2026-11-14）：Baton 自己那轮在跑时，服务端会先停下它、再第一个发这条；
        在等电脑上那轮时就是立刻交给电脑上那个会话。原来这颗只在等电脑那轮时出现，叫「立刻发」。
      */}
      {live.queued.length > 0 ? (
        <View style={s.queuedBox}>
          {live.queued.map((q) => (
            <View key={q.id} style={s.queuedRow}>
              <Text style={s.queuedTx} numberOfLines={1}>{q.text}</Text>
              {canInterrupt && (running || live.host === 'busy') ? (
                <Tappable
                  style={s.queuedBtn}
                  onPress={() => sendNow(q)}
                  haptic={haptics.tap}
                  accessibilityRole="button"
                  accessibilityLabel={`插队：${q.text.slice(0, 20)}`}
                >
                  <Text style={s.queuedBtnTx}>插队</Text>
                </Tappable>
              ) : null}
              <Tappable
                style={s.queuedBtn}
                onPress={() => cancelQueued(q)}
                haptic={haptics.tap}
                accessibilityRole="button"
                accessibilityLabel={`撤回：${q.text.slice(0, 20)}`}
              >
                <Text style={s.queuedBtnTx}>撤回</Text>
              </Tappable>
            </View>
          ))}
          <Text style={s.queuedWhy}>
            {running ? (canInterrupt ? '这轮结束后依次发出。点「插队」可先停止本轮' : '这轮结束后依次发出')
              : live.host === 'busy' ? '等电脑上那轮跑完后依次发出'
                : '马上就发出去'}
          </Text>
        </View>
      ) : null}

      {allowSend === false ? (
        // 路径不能省：这是唯一能修它的地方，去掉就只剩「关着的」这个事实，
        // 人不知道去哪开
        <Blocked title="发送已关闭" fix="在电脑的 ~/.baton/config.json 里开启后重启。" />
      ) : live.stopwatchStale ? (
        <Blocked title="离线" fix="打好的字会留着，接上后一并发出。" />
      ) : null}

      {attachErr ? <Text style={s.attachErr}>{attachErr}</Text> : null}
      {stopNote ? <Text style={s.queuedWhy}>{stopNote}</Text> : null}

      <Composer
        above={(
          <>
            {slashMenu}
            <Attachments
              items={attachments}
              onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
            />
          </>
        )}
        value={draft}
        onChange={(v) => {
          // 打字时光标就在刚改的那处后面。onSelectionChange 在有的平台上比 onChangeText 晚到、
          // 有的根本不为打字发，所以这里先按「改动落在哪」算一个，它来了再以它为准
          setCaret(caretAfterEdit(draft, v));
          setDraft(v);
        }}
        onCaret={(pos) => { setCaret(pos); setForceSel(undefined); }}
        selection={forceSel}
        onSend={send}
        hasAttachments={attachments.length > 0}
        onStop={canInterrupt ? stop : undefined}
        /**
         * **网页端不弹我们那张卡片——系统自己会问。**
         *
         * owner 拿两张截图指出来的：点加号先出我们的「相机 / 照片 / 文件」，
         * 点完一行 iOS Safari 又出它自己的「照片图库 / 拍照或录像 / 选取文件」。
         * 两层菜单、同样三个选项，我们那层纯属多余。
         *
         * 原生端相反：**那边没有系统选单**——`launchImageLibraryAsync` 直接进相册、
         * `launchCameraAsync` 直接开相机、DocumentPicker 直接进文件，三选一这一步
         * 不自己做就不存在。所以卡片留给原生，网页端直接去开那个通用选择器。
         *
         * 现在网页端连 expo 的选择器都不走了：加号底下压着一个真的
         * `<input type="file">`，文件经 onFiles 直接交过来（见 Composer 里那段）。
         * 不限类型，所以系统给的仍是「照片图库 / 拍照 / 选取文件」那三条。
         */
        onFiles={attachFiles}
        onAttach={(a) => {
          // web 上不会走到这儿——那边按下加号就是按在 input 上
          setAttachAnchor(a);
          setAttachSheet(true);
        }}
        attaching={attaching}
        // 不再传 sending：发送已经是同步的了，按钮上那个转圈没有对应的等待——
        // 「在路上」这件事现在由流里那条待发气泡说
        running={!!running}
        disabled={allowSend !== true}
        /*
          发之前就把话说清楚。电脑上那轮在跑时，这条消息会排队——服务端挡着，
          绝不起第二个进程写同一份 transcript（两个 --resume 同时写会把上下文
          撕成两半）。不说的话，人点完发送只看到一条「排队中」，不知道在等谁。

          **只有在跑（busy）才这么说。** 电脑上开着个框（waiting）照发不误：
          那个框要人在电脑前点，拿它挡发送等于 owner 一离开电脑就发不出消息
          （2026-10-09 他当场否掉过这个行为）。
        */
        placeholder={allowSend === null
          ? (isEn ? 'Checking identity and send access…' : '正在确认身份与发送权限…')
          : allowSend === false
            ? (isEn ? 'Sending disabled' : '发送被关闭')
            : running
              ? (isEn ? 'Queue follow-up for next turn…' : '插一句，这轮结束后发出')
              : live.host === 'busy'
                ? (isEn ? 'Running on desktop — message will queue' : '电脑上这轮还在跑，发出去会排队')
                : (isEn ? 'Message…' : '发一条')}
        // owner 原话：「那个位置是一个无意义的切换看多细节 改掉」。
        // 一天里改模型的次数远多于改详略，而这颗药丸是发送前唯一一眼看得见的控件。
        // 看多细没删，退到「更多」里去了。
        pills={
          /*
            一颗，不是两颗。模型、思考强度、权限、外观全并进「配置」——
            它们是同一件事的几个方面，拆成几颗只会把后面的挤出屏幕外。
            agent 这一屏不给换：会话已经建在某个 agent 上了，换不了。
          */
          <SetupPill
            readOnlyPreferences={allowSend !== true}
            agent={live.agent ?? 'claude'}
            model={live.model}
            modelOptions={models.for(live.agent ?? 'claude')}
            onOpenModels={models.refresh}
            config={models.config(live.agent ?? 'claude')}
            onModel={pickModel}
            effort={live.effort}
            onEffort={pickEffort}
          />
        }
      />
      </View>
      </KeyboardStickyView>

      <ScrollEdge height={barH + 6} />
      <FloatBar
        onBack={() => router.back()}
        right={
          <FabPill>
            <LinkDot onPress={() => setLinkSheet(true)} />
            <FabPillButton label={isEn ? en('menu.more') : '更多'} icon={<DotsIcon />} onPress={() => setMenu(true)} />
          </FabPill>
        }
      />

      {/*
        照 ChatGPT 的实物做的紧凑玻璃卡片，贴着加号弹出——不是横贯整屏的底部面板。
        形制和为什么不复用 Sheet，见 AttachMenu 抬头。
      */}
      <AttachMenu
        open={attachSheet}
        anchor={attachAnchor}
        onClose={() => setAttachSheet(false)}
        onPick={attach}
      />

      {/*
        右上角那张菜单。四条：

          相关会话   同一条线上的别的会话（分叉）。只有一条时不显示
          详细程度   原来叫「看多细」，在菜单里直接选，不再另弹一块面板
          文件       这个会话目录里有什么。不是发消息这条主路上的动作，所以在这儿
          刷新       兜底：正常情况下事件流是推过来的。owner 遇到过「手机上看不到、
                     电脑上刷新却有」——那种时候界面在说谎，而人手上得有个能点的东西。
                     下拉刷新走的是同一个函数，这条是给不知道那个手势的人
      */}
      <SessionMenu
        open={menu}
        onClose={() => setMenu(false)}
        related={chainSize}
        onRelated={() => router.push({ pathname: '/chain/[key]', params: { key } })}
        view={view}
        onView={setView}
        // 文件浏览器是推进来的一叠屏（每层一屏），不再是一块底部面板——见 app/files/[key].tsx
        onFiles={() => router.push({ pathname: '/files/[key]', params: { key } })}
        onExport={client ? () => {
          void exportSessionMarkdown(client, key).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : trNew('session.exportFail');
            if (Platform.OS === 'web') window.alert(msg);
            else Alert.alert(trNew('session.exportFail'), msg);
          });
        } : undefined}
        onSync={() => { void live.refreshState(); }}
      />

      {/* 和列表页同一块面板，不再各写一份——同一个状态在两屏上说的话必须一样 */}
      <LinkSheet open={linkSheet} onClose={() => setLinkSheet(false)} />
    </View>
  );
}

/** Summary 档隐去了多少步操作。工具调用与它的结果算一步，不算两步。 */
function hiddenCount(events: BatonEvent[]): number {
  return events.filter((e) => e.kind === 'tool_call').length;
}

function tokenTotal(tokens: Record<string, number> | null | undefined): number | null {
  if (!tokens) return null;
  const n = (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0)
    + (tokens.cache_read_input_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0);
  return n || null;
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    col: { width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center' },
    scrollView: { flex: 1 },
    older: { borderRadius: t.radius.md },
    // 选来源那三行：图标和字一组，右边的箭头由 moreRow 的 space-between 顶开
    attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    // 进会话时那颗球。留足高度，免得内容一到就整块往下跳一大截
    booting: { alignItems: 'center', justifyContent: 'center', paddingVertical: 72 },
    // 底部留白由输入区的实测高度决定，见下面 composerH——这里不写死
    scroll: {
      paddingTop: 56,
      width: '100%',
      maxWidth: t.layout.contentMaxW,
      alignSelf: 'center',
    },
    // 输入区浮在内容之上。内容铺到屏幕底，从它底下穿过去（照 ChatGPT）
    dock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: t.z.dock },
    dockInner: { width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center' },
    attachErr: {
      marginHorizontal: t.space.pad, marginBottom: 8,
      fontSize: t.size.xs, color: t.c.txDanger, fontFamily: t.fonts.sans,
    },
    queued: {
      marginHorizontal: t.space.pad, marginBottom: 8,
      fontSize: t.size.xs, color: t.c.txInfo, fontFamily: t.fonts.sans,
    },
    // 排着的那几条：浮在输入区上方的轻卡片，有边框与投影，不和对话正文混成一片
    queuedBox: {
      marginHorizontal: 14, marginBottom: 8,
      borderRadius: 18, backgroundColor: t.c.bgPrimary,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
      paddingHorizontal: 13, paddingVertical: 10,
      ...t.shadow,
    },
    queuedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
    queuedTx: { flex: 1, fontSize: 14, color: t.c.txPrimary, fontFamily: t.fonts.sans },
    queuedBtn: {
      paddingHorizontal: 11, paddingVertical: 6, minHeight: 32,
      borderRadius: t.radius.full, backgroundColor: t.c.bgSecondary,
      justifyContent: 'center', alignItems: 'center',
    },
    queuedBtnTx: { fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txInfo, fontFamily: t.fonts.sans },
    queuedWhy: { marginTop: 4, fontSize: 12, color: t.c.txTertiary, fontFamily: t.fonts.sans },
  });

/**
 * 一次改动之后光标该在哪：新旧两段文字，前后各自相同的部分去掉，中间新插进来的那段的末尾。
 * 打字、粘贴、删字都对；整段换掉（比如选了一个命令）时落在末尾。
 */
function caretAfterEdit(prev: string, next: string): number {
  let a = 0;
  const max = Math.min(prev.length, next.length);
  while (a < max && prev[a] === next[a]) a += 1;
  let b = 0;
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b += 1;
  return next.length - b;
}
