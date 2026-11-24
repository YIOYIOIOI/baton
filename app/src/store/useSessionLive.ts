import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useConnection } from './connection';
import { isStopwatchStale, STALE_AFTER_MS } from '../api/classify';
import { runAxisOf, isLying } from '../api/axes';
import { doingOf } from '../api/runs';
import { historyAfter } from '../api/eventHistory';
import * as haptics from '../feedback/haptics';
import type {
  Agent, BatonEvent, Effort, PendingAsk, QueuedMessage, RunAxis, SessionState, Tick, Turn,
} from '../api/types';

/**
 * 一个会话的实时状态。
 *
 * 三条纪律，每条都对应一种"界面说谎"的方式：
 *
 * 1. **先拉 /state 再订 SSE。** 手机断连是常态不是异常——重连时必须先知道
 *    "现在到底在跑什么"，否则在下一次状态变化之前，界面是空的但看着像正常。
 * 2. **秒表的权威是服务器**，本地只负责每秒重绘。服务器 tick 同时是活性证明：
 *    连着两个心跳周期没听到，秒表冻住变灰——**宁可承认不知道，也不要接着数**。
 * 3. **断连时最后一屏留着**，不清空。清空等于把用户刚读到一半的东西抹掉，
 *    而这时候他最需要的恰恰是"刚才说到哪了"。
 */
export function useSessionLive(key: string) {
  const client = useConnection((s) => s.client);
  const lastHeardAt = useConnection((s) => s.lastHeardAt);

  const [events, setEvents] = useState<BatonEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // 条数与内容分开：条数由心跳驱动（权威、自我纠偏），内容只在需要展示时才拉。
  // 合成一个的话，「别处排了一条」这边要等到下一次 /state 才知道。
  const [queuedCount, setQueuedCount] = useState(0);
  // 模型与 agent 都由服务端说了算：模型选择记在那台电脑上，agent 是会话固有的。
  // 本地不预设一个值——null 表示「还没问过」和「跟默认」，界面上要区别对待。
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  /**
   * agent 出的选择题，正停着等回答。
   *
   * 不进 `events`：它不是 transcript 里的一条记录，而是一个**现在还悬着的状态**，
   * 答完就没了。混进事件流的话，滚上去看别的内容时它会跟着滚走——而那恰恰是
   * 最不该被藏起来的东西。
   */
  const [ask, setAsk] = useState<PendingAsk | null>(null);
  /**
   * 电脑上那一轮（'busy' / 'waiting' / null）。这时在手机上发消息会排队——
   * 服务端挡着，绝不起第二个进程写同一份 transcript。输入框据此先把话说在前头。
   */
  const [host, setHost] = useState<'busy' | 'waiting' | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 本地每秒重绘一次，好让秒表看起来在走；权威值仍来自 tick
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const lastEventAt = useRef<number | null>(null);
  /**
   * 服务端推到哪个字节了。重连时作为 `Last-Event-ID` 送回去，让它从那儿重放
   * 断开期间写进 transcript 的事件——不带的话 follower 从文件末尾开始跟，
   * 那一段谁都不会再发一遍。
   *
   * 用 ref 不用 state：它每来一批事件就变，进 state 会白白多一次渲染，
   * 而没有任何界面读它。
   */
  const resumeAt = useRef(0);
  /**
   * 已经显示过的事件 id。`append` 维护它，好让「这一批里有几条是新的」能**同步**
   * 算出来——`setEvents` 的更新函数是异步跑的，在那里面算完没法再 setState。
   */
  const eventIds = useRef<Set<string>>(new Set());
  /**
   * 重连那一下补回来几条。`Caught` 拿它画那条「重连后补上 N 条」的分界线——
   * 不说一声的话，人会以为自己一直在线、什么都没错过。
   */
  const [caughtUp, setCaughtUp] = useState(0);
  /** 补回来那批里**第一条**的事件 id。分界线画在它前面，不是画在列表末尾 */
  const [caughtUpFrom, setCaughtUpFrom] = useState<string | null>(null);
  /*
    「它在干什么」：照抄桌面端那一行的写法（● 19m 32s · 27.8k tokens · Running tools…），
    但说的是人话（「跑 npm test」「读 coupon.ts」「在想下一步」）。说不出来时为 null，
    由调用方退回到「正在跑」——不编一个具体的动作出来。

    **每次都从事件流倒推**，不是存一份：旧版只在有新调用进来时改它，之后再没人清，
    命令早跑完了、agent 已经在写正文，这一行还停在那条命令上。
  */
  const doing = useMemo(() => doingOf(events), [events]);

  const append = useCallback((incoming: BatonEvent[]) => {
    if (!incoming.length) return;
    lastEventAt.current = Date.now();
    const add = incoming.filter((e) => {
      if (eventIds.current.has(e.id)) return false;
      eventIds.current.add(e.id);
      return true;
    });
    if (!add.length) return;
    setEvents((prev) => [...prev, ...add]);
  }, []);

  /**
   * 一处消化 state 响应。
   *
   * 不在四个调用点各写一遍：那样每加一个字段就要记得改四处，迟早漏一处——
   * 而「漏一条路径」正是这个项目里已经出过两次的那类 bug 的成因本身。
   */
  const versions = useRef({ turn: 0, ask: 0, count: 0 });
  const scopeVersion = useRef(0);
  const nextRequest = useRef(0);
  const appliedRequest = useRef(0);
  const recoverAccess = useCallback(() => {
    const current = useConnection.getState();
    if (client && current.client === client && current.principalAccess === null) void current.probe();
  }, [client]);
  const refreshState = useCallback(async (refreshTurn = true) => {
    if (!client) return;
    if (refreshTurn) recoverAccess();
    const version = scopeVersion.current;
    const initial = { ...versions.current };
    const request = ++nextRequest.current;
    const st: SessionState = await client.state(key);
    if (version !== scopeVersion.current || request < appliedRequest.current) return;
    appliedRequest.current = request;
    if (refreshTurn && initial.turn === versions.current.turn) setTurn(st.latestTurn);
    setQueued(st.queued);
    if (initial.count === versions.current.count) setQueuedCount(st.queued.length);
    setModel(st.model ?? null);
    setEffort(st.effort ?? null);
    if (st.agent) setAgent(st.agent);
    // `?? null` 而不是「有才设」：这个字段的「没有」本身就是信息——
    // 那道题可能在断线期间已经超时了，卡片必须跟着消失。
    if (initial.ask === versions.current.ask) setAsk(st.pendingAsk ?? null);
    // 同理：电脑上那轮跑完了，这里要跟着落回 null
    setHost(st.host ?? null);
  }, [client, key, recoverAccess]);

  /**
   * 订阅实时流，**断了要自己接回来**。
   *
   * 手机上断流是常态不是异常：锁屏、切后台、地铁进隧道、Wi-Fi 切蜂窝，
   * 每一样都会掐掉这条连接。没有重连的话，界面会正确地冻住（秒表变灰、
   * 标成「已停止更新」）然后**永远停在那儿**——用户得退出会话再进来才活。
   * 那等于把一个本来能自愈的故障做成了需要人工干预的故障。
   *
   * 两条恢复路径，缺一不可：
   *   退避重连  1s → 2s → 4s … 封顶 30s。收到任何一帧就清零。
   *   回到前台  立刻接。光靠退避的话，睡了一夜回来还要再等 30 秒。
   *
   * 首屏页的 endOffset 和后续 SSE 帧的 id 都指向完整记录之间的边界，断线后从那里续传。
   */
  useEffect(() => {
    if (!client) return;

    let stopped = false;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let hasPage = false;
    let recoverSince: number | null = null;
    let generation = 0;
    resumeAt.current = 0;
    eventIds.current = new Set();
    setEvents([]);
    setNextBefore(null);
    setLoading(true);
    // 第一次连上之前不算「重连」——首屏那一批不是补回来的，别报「补上 N 条」
    let everConnected = false;

    /**
     * 重连时同步**状态**（轮次、队列、模型）。
     *
     * **事件不在这儿补了。** 原来这里拉最近 50 条当补救，但离线期间超过 50 个
     * 事件就有空洞——实测 27.5% 的轮次单轮就超过 50 个。现在事件由流自己按
     * `Last-Event-ID` 重放（见 connect），这里只管状态；状态是个快照，
     * 拉一次就是对的，没有「漏了一段」这回事。
     */

    const schedule = () => {
      if (stopped || timer) return;
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(() => { timer = null; void connect(); }, wait);
    };

    async function connect() {
      if (stopped) return;
      const version = ++generation;
      scopeVersion.current++;
      if (!hasPage) {
        try {
          const page = await client!.events(key, { limit: 50 });
          if (stopped || generation !== version) return;
          append(page.events);
          setNextBefore(page.nextBefore);
          resumeAt.current = page.endOffset ?? page.events[page.events.length - 1]?.offset ?? 0;
          hasPage = true;
          setLoading(false);
        } catch (e) {
          if (stopped || generation !== version) return;
          setErr((e as Error).message);
          setLoading(false);
          schedule();
          return;
        }
      }
      if (recoverSince !== null) {
        const active = () => !stopped && generation === version;
        try {
          const page = await historyAfter(recoverSince, (before) => client!.events(key, { before, limit: 200 }), active);
          if (!active()) return;
          append(page.events);
          resumeAt.current = page.endOffset;
          recoverSince = null;
        } catch (e) {
          if (active()) { setErr((e as Error).message); schedule(); }
          return;
        }
      }
      void refreshState().catch(() => {});
      // 这次连接是不是接着上一次断的地方——决定补回来的事件要不要报「补上 N 条」
      const resuming = everConnected;
      let backfilled = 0;

      stop = client!.stream(
        key,
        (f) => {
          if (stopped || generation !== version) return;
          if (f.type === 'ask' || f.type === 'ask_end') versions.current.ask++;
          if (f.type === 'turn_start' || f.type === 'turn_end' || f.type === 'turn_control') versions.current.turn++;
          if (f.type === 'tick') versions.current.count++;
          attempt = 0; // 听到服务器就说明这条路通了，退避清零
          setErr(null);
          everConnected = true;
          if (f.type === 'events') {
            /*
              重连之后头一批事件就是「断线期间攒下的」。数出来告诉人
              ——不说的话他会以为自己一直在线、什么都没错过。

              只在**续传**的这次连接上数，且只数第一批：之后的就是实时的了。
            */
            if (resuming && backfilled === 0) {
              const fresh = f.data.events.filter((e) => !eventIds.current.has(e.id));
              if (fresh.length) {
                backfilled = fresh.length;
                setCaughtUp(fresh.length);
                setCaughtUpFrom(fresh[0].id); // 分界线画在这一条前面
              }
            }
            append(f.data.events);
          } else if (f.type === 'gap') {
            recoverSince = resumeAt.current;
            stop?.();
            void connect();
          }
          else if (f.type === 'ask') {
            // 建流时服务端会补一帧，所以断线重连后这张卡自己会回来，
            // 不需要额外去问一次
            setAsk(f.data);
            // 屏幕多半已经黑了。这一下是「有人在等你点一下」——
            // 和轮次结束那两种震动分开，因为它要求的是**动作**不是查看。
            haptics.success();
          } else if (f.type === 'ask_end') setAsk(null);
          else if (f.type === 'tick') {
            setTick(f.data);
            setQueuedCount(f.data.queued ?? 0);
            // Only the heartbeat retries missing access on a healthy stream.
            recoverAccess();
          }
          else if (f.type === 'turn_start' || f.type === 'turn_control') setTurn(f.data);
          else if (f.type === 'turn_end') {
            setTurn(f.data);
            // 一轮跑完往往要等好几分钟，人早就不看屏幕了。这一下触感是
            // 「回来看看」的信号——正常结束和异常结束用**两种不同的**通知型
            // 震动，不睁眼也分得出哪种。
            // aborted 不给：那是用户自己按的停止，按下那一刻已经震过一次了，
            // 再补一下会让「我停的」感觉像「它崩了」。
            if (f.data.status === 'ok') haptics.success();
            else if (f.data.status === 'failed' || f.data.status === 'anomaly') haptics.fail();
            // 队列没有自己的事件通道，而它恰好在轮次结束后被排空——
            // 不在这里补一次查询，界面就会一直挂着「N 条排队中」，
            // 而那条消息其实早就发出去并回完了。实测踩过。
            void refreshState(false).catch(() => {});
          }
        },
        (e) => {
          if (stopped || generation !== version) return;
          setErr(e.message);
          schedule();
        },
        {
          // 从上次断的地方接着来，而不是从文件末尾
          lastEventId: String(resumeAt.current),
          onId: (id) => {
            if (stopped || generation !== version) return;
            const n = Number(id);
            if (Number.isSafeInteger(n) && n > resumeAt.current) resumeAt.current = n;
          },
        },
      );
    }

    const reconnectNow = () => {
      if (stopped) return;
      recoverAccess();
      if (timer) { clearTimeout(timer); timer = null; }
      attempt = 0;
      stop?.();
      void connect();
    };

    void connect();

    /**
     * 看门狗。**这是唯一靠得住的那条恢复路径。**
     *
     * 初版只挂了 AppState，实测不够：owner 在真机上锁屏再回来，新回复就是不出现，
     * 要退出会话重进才行。原因是这条路径有两处都可能不响——
     *   一、连接被系统掐掉时 `reader.read()` 未必抛错，可能就那么悬着，
     *       于是 onError 不触发，退避重连也就永远不排；
     *   二、iOS 主屏应用里 visibilitychange（AppState 的底层）什么时候发、
     *       发不发，不是我能担保的。
     *
     * 所以判据改成我们自己一直在维护的那个事实：**多久没听到服务器了**。
     * 服务器每 15 秒必发一个 tick，连着两个周期没动静就说明这条流已经名存实亡，
     * 不管它有没有报错、不管系统发没发事件，直接拆了重连。
     */
    const watchdog = setInterval(() => {
      if (stopped || timer) return; // 已经在退避重连里了就别插队
      const heard = useConnection.getState().lastHeardAt;
      if (heard > 0 && Date.now() - heard > STALE_AFTER_MS) reconnectNow();
    }, 5000);

    // 回到前台立刻接，省掉看门狗那几秒。**它只是加速，不是依赖**——
    // 上面那条不响的话，看门狗照样会把流接回来。
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') reconnectNow();
    });
    if (Platform.OS === 'web') window.addEventListener('online', recoverAccess);

    // 界面离开必须退订：后端按 key 记订阅者，漏掉就一直堆到守护进程重启
    return () => {
      stopped = true;
      scopeVersion.current++;
      if (timer) clearTimeout(timer);
      clearInterval(watchdog);
      sub.remove();
      if (Platform.OS === 'web') window.removeEventListener('online', recoverAccess);
      stop?.();
    };
  }, [client, key, append, refreshState, recoverAccess]);

  const loadOlder = useCallback(async () => {
    if (!client || nextBefore === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await client.events(key, { before: nextBefore, limit: 50 });
      const older = page.events.filter((e) => !eventIds.current.has(e.id));
      for (const e of older) eventIds.current.add(e.id);
      setEvents((prev) => (older.length ? [...older, ...prev] : prev));
      setNextBefore(page.nextBefore);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [client, key, nextBefore, loadingOlder]);

  const stale = lastHeardAt > 0 && isStopwatchStale(lastHeardAt, nowMs);
  const run: RunAxis | null = runAxisOf(turn, lastEventAt.current, nowMs);

  /**
   * 秒表显示值。
   * 冻住时保留最后一个服务器值——归零或继续走都是在编造，
   * 而这一刻恰恰是最不该编造的。
   */
  const elapsedMs = tick?.running
    ? (stale ? tick.elapsedMs : tick.elapsedMs + (nowMs - lastHeardAt))
    : (turn?.status === 'running' ? nowMs - turn.startedAt : 0);

  return {
    events, turn, tick, queued, queuedCount, loading, err, doing, model, effort, agent, host,
    /** 正等着人答的选择题。null = 没有 */
    ask,
    /** 答完之后立刻收掉卡片，不等 ask_end 那一帧绕回来 */
    clearAsk: () => { versions.current.ask++; setAsk(null); },
    loadOlder, loadingOlder, hasOlder: nextBefore !== null, refreshState,
    /** 上一次重连补回来几条。0 = 没有断过，或者提示已经被读过了 */
    caughtUp,
    caughtUpFrom,
    /** 人看到那条分界线之后就不必一直挂着——发下一条时清掉 */
    clearCaughtUp: () => { setCaughtUp(0); setCaughtUpFrom(null); },
    run,
    stopwatchStale: stale,
    lying: isLying(run, stale),
    elapsedMs: Math.max(0, elapsedMs),
    setQueued,
  };
}
