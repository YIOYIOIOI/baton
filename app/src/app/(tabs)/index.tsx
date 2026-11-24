import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, AppState, LayoutAnimation, Platform, RefreshControl, ScrollView, StyleSheet, Text,
  useWindowDimensions, View,
} from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';

import { useTheme, type Theme } from '@/theme';
import { space } from '@/theme/tokens';
import { IconArchive, IconBall } from '@/icons';
import {
  BarTitle, Chevron, FabPill, FloatBar, ListMeta,
  Pulse, Skeleton, Tappable, useFloatBarHeight,
} from '@/components/ui';
import * as haptics from '@/feedback/haptics';
import { ScrollEdge } from '@/components/ScrollEdge';
import { useDockHeight } from '@/components/PageDock';
import { Segmented } from '@/components/Segmented';
import { DUR, EASE_OUT } from '@/motion/curves';
import { useReduceMotion } from '@/a11y/motion';
import { LinkDot } from '@/components/LinkDot';
import { LinkSheet } from '@/components/LinkSheet';
import { Notice } from '@/components/Notice';
import { useConnection } from '@/store/connection';
import { BatonError } from '@/api/client';
import type { Agent, Chain, Member } from '@/api/types';
import { dotKind, groupChains } from '@/api/groups';
import { useLocale } from '@/i18n';

/**
 * 会话列表。
 *
 * 一行就是**圆点 + 标题**，没有任何别的文字：
 *   · 状态       → 圆点的颜色（珊瑚呼吸=在跑、红=失败、琥珀=异常、空心=闲着）
 *   · 工作目录   → 分组头
 *   · agent      → 顶部切换条
 *   · 标题可信度 → 推导的标题用更淡的字色，**不加「推导」二字**
 *
 * 代价是分叉数和最后活动时间在列表里不再可见。时间靠排序隐含（按新旧排），
 * 分叉只能进会话看。这是刻意的取舍：一行里塞四种信息，结果是四种都读不清。
 */
/**
 * 换筛选时内容横移多少。
 *
 * 28pt 而不是整屏宽：这是同一页里的筛选，不是换页。整屏位移暗示「去了另一个
 * 地方」，而这三档是同一批会话的三个视角。它只需要够让眼睛看出方向。
 */
const SLIDE_PX = 28;

/** 提到组件外：每次渲染新建一个数组会让 Segmented 白白重渲染。 */
const AGENT_TABS_ZH = [['all', '全部'], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'AGY']] as const;
const AGENT_TABS_EN = [['all', 'All'], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'AGY']] as const;

/**
 * 折叠 / 展开一组时，下面的行**滑开**而不是瞬间跳到新位置。
 *
 * 只在原生上做：LayoutAnimation 在 react-native-web 上是空操作，网页上维持瞬切。
 * 只动透明度 + 位置、200ms，和系统列表展开分组的观感一致；减弱动效下不做——
 * 整块内容的位移正是那条设置要砍的。
 */
function foldMotion(reduceMotion: boolean) {
  if (Platform.OS === 'web' || reduceMotion) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
}

export default function ListScreen() {
  const t = useTheme();
  const router = useRouter();
  const ready = useConnection((s) => s.ready);
  const client = useConnection((s) => s.client);
  const probe = useConnection((s) => s.probe);
  const link = useConnection((s) => s.link);

  const [chains, setChains] = useState<Chain[] | null>(null);
  const [agent, setAgent] = useState<Agent | 'all'>('all');
  /**
   * 换筛选时的横移与淡入。
   *
   * 两个值都走原生驱动，跑在 UI 线程上——这一段发生在用户刚抬手的那一刻，
   * JS 线程那会儿正忙着重算过滤后的列表，挂在 JS 上必然卡。
   */
  const slide = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const prevAgent = useRef<Agent | 'all'>('all');
  const reduceMotion = useReduceMotion();
  const { isEn, en } = useLocale();
  const tabs = isEn ? AGENT_TABS_EN : AGENT_TABS_ZH;

  /**
   * 方向跟着胶囊走：往右选就从右边进来，往左选就从左边。
   * 方向搞反的话，观感会变成「内容和胶囊在对着跑」，比不做动画更糟。
   */
  useEffect(() => {
    const order = AGENT_TABS_ZH.map(([v]) => v) as (Agent | 'all')[];
    const from = order.indexOf(prevAgent.current);
    const to = order.indexOf(agent);
    prevAgent.current = agent;
    if (from === to || from < 0 || to < 0) return;
    // 减弱动效下只留淡入：位移是这条设置要砍的，而淡入正是它要留的
    if (!reduceMotion) slide.setValue(to > from ? SLIDE_PX : -SLIDE_PX);
    fade.setValue(0.3);
    Animated.parallel([
      /**
       * 用 DUR.sheet（280ms）不是 DUR.toggle（180ms）。
       *
       * owner：「会话界面左右切换的动画太快了，apple 设计原则有说要这么快吗？」
       * ——没有，是我挑错了档位。Apple 那张表里 150–200ms 是**开关、药丸这种
       * 小状态变化**，而换筛选是整批内容在变，属于面板那一档。总则是不超过
       * 300ms，280 正好在里面。
       */
      Animated.timing(slide, {
        toValue: 0, duration: DUR.sheet, easing: EASE_OUT, useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1, duration: DUR.sheet, easing: EASE_OUT, useNativeDriver: true,
      }),
    ]).start();
  }, [agent, slide, fade, reduceMotion]);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // 已归档的默认不显示——桌面 App 里它们本来就是隐藏的，而「手机上看到的和
  // 电脑上一致」是硬需求。混在一起会让列表凭空多出六十多条你以为删掉了的东西。
  const [showArchived, setShowArchived] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dockHeight = useDockHeight();
  // null = 还没问过服务端。「配没配对」以服务端认不认为准，不看本地存储——
  // 网页端同源时浏览器会自动带 cookie，那条 cookie 可能是更早的客户端留下的。
  const [authed, setAuthed] = useState<boolean | null>(null);
  const barH = useFloatBarHeight();
  const { width: winW } = useWindowDimensions();
  const trackW = Math.max(220, Math.min(winW || 390, t.layout.contentMaxW) - space.pad * 2);


  const load = useCallback(async () => {
    // 凭据还没从存储里读回来。这时候 client 必然是 null，但那**不代表没配对**——
    // 在这儿判 false，每次冷启动都会先弹一下配对页再跳回来（浏览器实测：
    // /api/sessions 明明 200，页面却重定向到了 /pair）。
    // 这一条和下一条是一对，方向相反，缺哪一条都是 bug。
    if (!ready) return;
    // 读完了仍然没有 client = 真的没有地址可连（原生端首次启动就是这样）。
    // 直接判未配对去配对页。**不能只是 return**——那会让 authed 永远停在 null，
    // 屏幕白着不动，正是 Baton 立项要消灭的那种失败，不能自己先犯一遍。
    if (!client) { setAuthed(false); return; }
    try {
      setChains((await client.sessions()).chains);
      setAuthed(true);
    } catch (e) {
      // 401 = 没配对，要跳配对页；其余（网络抖动、源站没应答）不跳——
      // 把「连不上」当成「没配对」会让人白白重配一次，而问题根本不在那儿。
      if (e instanceof BatonError && e.status === 401) setAuthed(false);
      else if (authed === null) setAuthed(await probe());
    }
  }, [ready, client, probe, authed]);

  // ready 必须在依赖里：凭据读回来那一刻要重新判一次，否则永远停在「还没问过」
  useEffect(() => { load(); }, [client, ready]); // eslint-disable-line react-hooks/exhaustive-deps



  // 回到前台就刷一次。锁屏一小时再打开，看到的不该还是一小时前那一屏——
  // 而「电脑上新建的活手机上看得到」正是本项目的目标之一。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') load(); });
    return () => sub.remove();
  }, [load]);

  const groups = useMemo(
    () => groupChains(chains ?? [], agent, showArchived),
    [chains, agent, showArchived],
  );
  // 都按**会话**数，不按链数：列表现在一个会话一行，两个数对不上就会出现
  // 「已归档 3 条」点开只多出 1 行这种事
  const all = useMemo(() => (chains ?? []).flatMap((c) => c.members), [chains]);
  const total = all.length;
  const archived = all.filter((m) => m.isArchived).length;


  if (!ready || authed === null) return <View style={{ flex: 1, backgroundColor: t.c.bgTertiary }} />;
  // 去首屏而不是直接去配对页：首屏是 owner 点名要复刻的那一屏，它下面就是「连接电脑」
  if (!authed) return <Redirect href="/welcome" />;

  const s = styles(t);
  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* 传输轴出问题时，阻断条顶在浮动按钮下方，滚动区就不再自己留顶部空间 */}
      {link !== 'ok' ? (
        <View style={{ paddingTop: barH + 4, width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center' }}>
          <Notice link={link} onAction={load} />
        </View>
      ) : null}

      <ScrollView
        style={s.scrollView}
        contentContainerStyle={[s.scroll, { paddingTop: link === 'ok' ? barH : 4, paddingBottom: dockHeight + 8 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            tintColor={t.c.txTertiary}
          />
        }
      >
        {/* 字标搬到浮动栏里去了，和右边的连接状态同一行——见下面的 FloatBar */}
        {chains === null ? (
          // 骨架屏本身就在说「正在载入」，不必再写一行字复述它
          <Skeleton />
        ) : total === 0 ? (
          <View style={s.empty}>
            <IconBall size={22} color={t.c.coral} />
            <Text style={s.emptyB}>{isEn ? en('list.emptyTitle') : '还没有会话'}</Text>
            <Text style={s.emptyP}>{isEn ? en('list.emptyBody') : '在电脑上开一个，或在下面新建'}</Text>
          </View>
        ) : (
          <>
            {/*
              原来这里有一行「N 条 · 另有 M 条已归档」。删掉：条数是个自己数一眼
              就知道的东西，而归档那半句已经由列表末尾那个入口说了——它还带着
              动作，比这行字有用。
            */}
            <View style={s.tabsWrap}>
              <Segmented width={trackW} items={tabs} value={agent} onChange={setAgent} />
            </View>

            {/*
              换筛选时内容**跟着胶囊的方向横移一下**。
              owner：「点击不同的选项的时候，页面也要是左右跟着滑动的切换，
              现在是直接闪现」。

              位移量只有 SLIDE_PX，不是整屏：这是同一页里的**筛选**，不是换页。
              整屏位移会暗示「去了另一个地方」，而且在竖向 ScrollView 里横移整屏
              会撑出横向溢出。配合淡入，读起来是「这批内容是从那边来的」。
            */}
            <Animated.View style={[s.pager, { transform: [{ translateX: slide }], opacity: fade }]}>
            {groups.map((g, gi) => {
              const open = !folded.has(g.key);
              return (
                <View key={g.key}>
                  {gi > 0 ? <View style={s.groupDivider} /> : null}
                  <Tappable
                    style={s.groupHead}
                    onPress={() => {
                      foldMotion(reduceMotion);
                      setFolded((f) => {
                      const n = new Set(f);
                        if (n.has(g.key)) n.delete(g.key); else n.add(g.key);
                        return n;
                      });
                    }}
                    haptic={haptics.select}
                    feedback="fill"
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                  >
                    <Chevron open={open} style={s.chev} />
                    <Text style={s.groupName} numberOfLines={1}>{g.name}</Text>
                    <View style={[s.groupCountPill, g.running > 0 && { backgroundColor: t.c.accentSoft }]}>
                      <Text style={[s.groupN, g.running > 0 && { color: t.c.coral, fontWeight: t.weight.bold }]}>
                        {g.rows.length}
                      </Text>
                    </View>
                  </Tappable>
                  {open ? g.rows.map(({ member, fork }) => (
                    <Row
                      key={member.key}
                      member={member}
                      fork={fork}
                      onPress={() => router.push({
                        pathname: '/session/[key]',
                        params: { key: member.key },
                      })}
                    />
                  )) : null}
                </View>
              );
            })}

            {groups.length === 0 ? (
              <ListMeta style={{ paddingTop: 24 }}>{isEn ? en('list.emptyFiltered') : '没有会话'}</ListMeta>
            ) : null}

            {/*
              归档的入口放在**列表末尾**，不放在筛选面板里。
              理由是它本来就是「列表之后还有一批」——放在末尾，滚到底自然遇到，
              不必先知道有个筛选面板、再知道里面有个开关。happier 也是这么放的。
              archived 为 0 时整个不出现：一个永远写着「0 条」的入口只是噪音。
            */}
            {archived > 0 ? (
              <Tappable
                style={s.archive}
                onPress={() => { foldMotion(reduceMotion); setShowArchived((x) => !x); }}
                haptic={haptics.select}
                feedback="fill"
                accessibilityRole="button"
                accessibilityState={{ selected: showArchived }}
              >
                <IconArchive size={17} color={t.c.txTertiary} />
                <Text style={s.archiveTx}>{isEn ? en('list.archived', { n: archived }) : `已归档 ${archived} 条`}</Text>
                <Chevron open={showArchived} size={13} style={s.chev} />
              </Tappable>
            ) : null}
            </Animated.View>
          </>
        )}
      </ScrollView>

      {/*
        底部主操作。原来是一整条横贯屏幕的玻璃条，里面装一颗实色药丸——
        那读起来是「页面的一部分」。改成**一颗悬浮的玻璃胶囊**：列表直接从它
        两侧和底下滚过去，才是 Apple 说的那种「浮动工具栏随滚动保持可见」。

        外层 box-none：胶囊两侧是空的，那儿的滑动要能落到列表上，不能被一块
        透明的全宽 View 吃掉。
        max 而不是加法——理由见 Composer.tsx 同一处。
      */}

      {/*
        字标和连接状态在同一行。左上角原来那颗设置按钮下移之后，这一行空出来了，
        字标就不必再占滚动区顶部一整行——省下来的高度直接给列表。
      */}
      {/*
        字标是**纯展示、不可点**，所以不给玻璃——玻璃在这套界面语言里意味着
        「这是个控件」，套上去等于在说它能按。可读性交给上面那条滚动边缘渐隐。
      */}
      <ScrollEdge height={barH} />
      <FloatBar
        left={<BarTitle>Baton</BarTitle>}
        right={<FabPill><LinkDot onPress={() => setLinkOpen(true)} /></FabPill>}
      />

      {/*
        原来这里还有一个「更多筛选」面板，里面只剩一个归档开关——而归档已经
        搬到列表末尾去了，那个面板就整个空了，删掉。少一层入口。
      */}
      <LinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} />
    </View>
  );
}

// ── 一行 ────────────────────────────────────────

function Row({ member: m, fork, onPress }: { member: Member; fork: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = styles(t);
  const { isEn, en } = useLocale();
  const link = useConnection((x) => x.link);
  const kind = dotKind(m, link);
  // 「标题一致」是硬需求。只有第 1 档是 App 里确实存在的那个名字；
  // 其余是 Baton 推的，用更淡的字色如实标注——但不加「推导」二字。
  const dim = m.titleTier > 1;
  const statusLabel = kind === 'running'
    ? (isEn ? en('list.statusRunning') : '运行中')
    : kind === 'waiting'
      ? (isEn ? en('list.statusWaiting') : '等待确认')
      : (isEn ? en('list.statusIdle') : '空闲');

  return (
    // 不给触感：这只是一次导航，没有后果。处处都震等于处处都不震。
    <Tappable
      style={s.row}
      onPress={onPress}
      feedback="fill"
      accessibilityRole="button"
      accessibilityLabel={`${m.title}, ${statusLabel}`}
    >
      <View style={s.rowDotSlot}>
        {/* 圆点是这一行**唯一**的状态表达：珊瑚色呼吸 = 在跑（电脑上起的也算），
            琥珀色实心不动 = 卡在等你点确认，空心 = 闲着。判定在 api/groups.ts。 */}
        {kind === 'running'
          ? <Pulse style={[s.rowDot, { backgroundColor: t.c.coral }]} />
          : kind === 'waiting'
            ? (
              <View style={s.rowDotWaitRing}>
                <View style={[s.rowDot, { backgroundColor: t.c.txWarning }]} />
              </View>
            )
            : <View style={[s.rowDot, s.rowDotIdle]} />}
      </View>
      <Text style={[s.rowTitle, dim && { color: t.c.txTertiary }]} numberOfLines={1}>
        {m.title}
      </Text>
      {/* 分叉是从别的会话分出来的一条。标在右边、很淡——它是出身，不是状态 */}
      {fork ? (
        <View style={s.rowForkPill}>
          <Text style={s.rowFork}>{isEn ? en('list.fork') : '分叉'}</Text>
        </View>
      ) : null}
    </Tappable>
  );
}

/** 在跑的那一行，圆点是珊瑚色呼吸——它是「在跑」的唯一表达，不能省。 */


const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    scrollView: { flex: 1 },
    // paddingTop 由组件按浮动栏实际高度行内给，这里给了也会被盖掉
    scroll: {
      paddingBottom: 16,
      width: '100%',
      maxWidth: t.layout.contentMaxW,
      alignSelf: 'center',
    },

    /**
     * 换筛选时横移的那一层。**必须裁**——不裁的话横移会撑出横向溢出，
     * 网页上直接多一条横向滚动条。
     *
     * 裁在这里是安全的：分段控件在 tabsWrap 里，是这一层的**兄弟**不是子元素，
     * 所以胶囊胀大时鼓出来的那圈不会被这层切掉（那条规矩见 Segmented 抬头）。
     */
    pager: { overflow: 'hidden', paddingTop: 4 },

    // 轨道、滑块、文字的样式都在 Segmented 里，这儿只管它占多大位置
    tabsWrap: { paddingHorizontal: t.space.pad, paddingTop: 8, paddingBottom: 8 },

    groupDivider: {
      height: t.hairline,
      backgroundColor: t.c.bdTertiary,
      marginHorizontal: t.space.pad,
      marginTop: 10,
      marginBottom: 4,
    },
    groupHead: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      marginHorizontal: 8, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6,
      minHeight: 40, borderRadius: t.radius.lg,
    },
    chev: { width: 12, height: 12, opacity: 0.6 },
    groupName: {
      flex: 1, fontFamily: t.fonts.mono, fontSize: 12, fontWeight: '500',
      letterSpacing: 0.2, color: t.c.txTertiary,
    },
    groupCountPill: {
      minWidth: 22, height: 20, paddingHorizontal: 7, borderRadius: t.radius.full,
      backgroundColor: t.c.bgSecondary, alignItems: 'center', justifyContent: 'center',
    },
    groupN: {
      fontFamily: t.fonts.sans, fontSize: 11.5, color: t.c.txTertiary,
      fontVariant: ['tabular-nums'],
    },

    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      marginHorizontal: 8, paddingHorizontal: 10, paddingVertical: 11,
      minHeight: 48, borderRadius: t.radius.lg,
    },
    rowDotSlot: { width: 18, alignItems: 'center', justifyContent: 'center' },
    rowDot: { width: 8, height: 8, borderRadius: t.radius.full },
    rowDotWaitRing: {
      width: 16, height: 16, borderRadius: t.radius.full,
      backgroundColor: t.c.bgWarning, alignItems: 'center', justifyContent: 'center',
    },
    rowDotIdle: {
      borderWidth: 1.4, borderColor: t.c.txTertiary, opacity: 0.45, backgroundColor: 'transparent',
    },
    rowTitle: {
      flex: 1, fontSize: 15.5, lineHeight: 22, letterSpacing: -0.1,
      color: t.c.txPrimary, fontFamily: t.fonts.sans,
    },
    // 很淡、很小：它是出身不是状态，不能和在跑的那颗点抢眼
    rowForkPill: {
      paddingHorizontal: 7, paddingVertical: 2, borderRadius: t.radius.full,
      backgroundColor: t.c.bgSecondary,
    },
    rowFork: { fontSize: 11, color: t.c.txTertiary, fontFamily: t.fonts.sans, fontWeight: '500' },

    archive: {
      flexDirection: 'row', alignItems: 'center', gap: 9,
      marginHorizontal: 8, paddingHorizontal: 10, paddingVertical: 13,
      marginTop: 14, minHeight: 46, borderRadius: t.radius.lg,
    },
    archiveTx: { flex: 1, color: t.c.txSecondary, fontSize: t.size.sm, fontFamily: t.fonts.sans },

    empty: { paddingTop: 88, paddingHorizontal: t.space.pad, alignItems: 'center', gap: 6 },
    emptyB: { fontFamily: t.fonts.serif, fontSize: 22, marginTop: 10, color: t.c.txPrimary },
    emptyP: { color: t.c.txTertiary, fontSize: t.size.sm, lineHeight: 24, marginBottom: 20, textAlign: 'center', fontFamily: t.fonts.sans },
  });
