import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme, type Theme } from '@/theme';
import { IconRefresh, IconRight } from '@/icons';
import { Sheet, SheetP, Tappable } from './ui';
import { useConnection } from '@/store/connection';
import { useReduceMotion } from '@/a11y/motion';
import { DUR, EASE_OUT } from '@/motion/curves';
import * as haptics from '@/feedback/haptics';
import { BatonError } from '@/api/client';
import { useLocale } from '@/i18n';
import {
  PLAN, agoLabel, isStale, leftOf, levelOf, resetLabel, tightest, type Level,
} from '@/api/usage';
import type { AgentUsage, Usage, UsageWindow } from '@/api/types';

/**
 * 套餐额度（用量）。
 *
 * owner 2026-11-15：「目前手机看不到额度用量」。电脑网页端早就有（web/src/Usage.tsx，
 * 设置页一节 + 侧栏底部一颗按钮），手机上一处都没有。
 *
 * ## 放在哪
 *
 * **设置页最上面一组，数直接摆在行上**，不藏在「用量 >」后面再点一下。看额度的
 * 场景几乎都是「我还能不能接着用」——一眼要看到的是那个数，不是一个入口。
 * 每个 agent 一行，只摆**最紧的那个窗口**（剩余最少的），点行展开全部窗口和重置时间。
 *
 * ## 口径和电脑端一致
 *
 * 显示的是**剩余**，条也是剩余的长度，和手机电量一个读法；颜色按剩余分三档。
 * 换算与文案都在 api/usage.ts，和网页端逐字对齐。
 *
 * ## 访客看不到
 *
 * 服务端对访客回 403 `not_owner`（那是电脑主人账号的额度）。这里收到就把整组藏掉，
 * 不摆一行「无权查看」——访客不需要知道这里本来有个东西。
 */

/**
 * 上一次问到的数，模块级。
 *
 * 设置页是 tab，切走再切回来会重新挂载；每次都从「正在问…」开始，那一行就会在
 * 两种高度之间跳。先摆上次的数、后台再问，跳的就只有数字本身。
 */
let cached: { data: Usage; at: number } | null = null;

type UsageState = {
  data: Usage | null;
  err: BatonError | Error | null;
  busy: boolean;
  /** 访客：整块藏起来 */
  hidden: boolean;
  now: number;
  load: (refresh: boolean) => void;
};

export function useUsage(enabled = true): UsageState {
  const client = useConnection((s) => s.client);
  const [data, setData] = useState<Usage | null>(cached?.data ?? null);
  const [err, setErr] = useState<BatonError | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const load = useCallback((refresh: boolean) => {
    if (!client || !enabled) return;
    setBusy(true);
    client.usage(refresh)
      .then((d) => {
        cached = { data: d, at: Date.now() };
        if (!alive.current) return;
        setData(d);
        setErr(null);
        setNow(Date.now());
      })
      .catch((e: Error) => {
        if (!alive.current) return;
        if (e instanceof BatonError && e.code === 'not_owner') setHidden(true);
        else setErr(e);
      })
      .finally(() => { if (alive.current) setBusy(false); });
  }, [client, enabled]);

  useEffect(() => {
    alive.current = true;
    // 「几分钟后重置」要跟着走，不然开着不动它就一直说同一个数
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  /**
   * 每次**切到**这一页都问一次，不是只在挂载时问：tab 切走并不卸载页面，只在挂载时问的话，
   * 一上午前看过一次，下午回来看到的还是那个数。服务端自己有 60 秒缓存，不会打到上游。
   */
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    setNow(Date.now());
    load(false);
  }, [load, enabled]));

  return { data, err, busy, hidden: hidden || !enabled, now, load };
}

function levelColor(t: Theme, l: Level): string {
  if (l === 'high') return t.c.txDanger;
  if (l === 'mid') return t.c.txWarning;
  return t.c.coral;
}

/**
 * 剩余条。满格 = 额度还多，越用越短。
 *
 * 首次出现时从 0 长到位：一条突然就在那儿的条读不出「这是个量」，长出来的那
 * 280ms 让眼睛顺着它读到终点。用 scaleX + 左端为原点，走原生驱动，不动布局。
 * 减弱动效下直接到位——这正是那条设置要砍的位移。
 */
export function UsageBar({ left, height = 6 }: { left: number; height?: number }) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  // 0 → 1 只长一次。之后刷新时数变了，宽度直接到位——每刷一次就重新长一遍会很吵
  // useState 的惰性初值而不是 useRef(...).current：值只建一次，渲染期也不读 ref
  const [grow] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduceMotion) { grow.setValue(1); return undefined; }
    const anim = Animated.timing(grow, {
      toValue: 1, duration: DUR.sheet, easing: EASE_OUT, useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [reduceMotion, grow]);

  // 剩 0 就是空条；剩一点点也要看得见一小截，否则和 0 分不开
  const shown = left === 0 ? 0 : Math.max(left, 1.5);
  return (
    <View
      style={[
        bar.track,
        {
          height,
          borderRadius: height / 2,
          backgroundColor: t.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(34,33,31,0.08)',
        },
      ]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: left }}
    >
      {/* 宽度定终点、scaleX 只管「长出来」那一下：终点精确，动画仍在原生线程上 */}
      <Animated.View
        style={[
          bar.fill,
          {
            width: `${shown}%`,
            borderRadius: height / 2,
            backgroundColor: levelColor(t, levelOf(left)),
            transformOrigin: 'left',
            transform: [{ scaleX: grow }],
          },
        ]}
      />
    </View>
  );
}

const bar = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
  fill: { height: '100%' },
});

const NAMES: Record<keyof Usage, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

/**
 * 设置页那一组里的一行：名字 + 套餐 + 最紧那个窗口的剩余，底下一条细条。
 * 点开是完整面板。
 */
export function UsageRow({
  agent, u, now, onPress, last, error,
}: {
  agent: keyof Usage; u: AgentUsage | null; now: number; onPress: () => void; last?: boolean;
  /** 一次都没问到、而且出错了：行上说「问不到」，不要一直挂着「正在问…」 */
  error?: string | null;
}) {
  const t = useTheme();
  const s = st(t);
  const { locale, isEn, en } = useLocale();
  const w = u ? tightest(u) : null;
  const left = w ? leftOf(w) : null;
  const plan = u?.plan ? PLAN[u.plan] ?? u.plan : null;

  let sub: string;
  if (!u) sub = error ? (isEn ? en('usage.unavailableErr', { err: error }) : `问不到：${error}`) : (isEn ? en('usage.asking') : '正在问…');
  else if (!u.available) sub = u.reason;
  else if (!w) sub = isEn ? en('usage.noWindows') : '账号没有返回额度窗口';
  else sub = [w.label, resetLabel(w.resetsAt, now, locale)].filter(Boolean).join(' · ');

  return (
    <Tappable
      style={[s.row, !last && s.rowLine]}
      feedback="fill"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={isEn
        ? `${NAMES[agent]} usage${left !== null ? `, ${left}% remaining` : ''}`
        : `${NAMES[agent]} 用量${left !== null ? `，剩余 ${left}%` : ''}`}
    >
      <View style={s.rowTop}>
        <Text style={s.name}>{NAMES[agent]}</Text>
        {plan ? <Text style={s.plan}>{plan}</Text> : null}
        <View style={{ flex: 1 }} />
        {left !== null ? (
          <Text style={[s.pct, { color: levelOf(left) === 'ok' ? t.c.txPrimary : levelColor(t, levelOf(left)) }]}>
            <Text style={s.pctK}>{isEn ? '' : '剩余 '}</Text>{left}%{isEn ? <Text style={s.pctK}>{en('usage.left')}</Text> : null}
          </Text>
        ) : null}
        <IconRight size={14} color={t.c.txTertiary} />
      </View>
      {left !== null ? <View style={s.rowBar}><UsageBar left={left} height={4} /></View> : null}
      <Text style={[s.sub, u && isStale(u) ? { color: t.c.txWarning } : null]} numberOfLines={2}>
        {u && isStale(u) ? (isEn ? en('usage.stalePrefix', { sub }) : `旧数 · ${sub}`) : sub}
      </Text>
    </Tappable>
  );
}

function WindowBlock({ w, now }: { w: UsageWindow; now: number }) {
  const t = useTheme();
  const s = st(t);
  const { locale, isEn, en } = useLocale();
  const left = leftOf(w);
  const l = levelOf(left);
  return (
    <View style={s.win}>
      <View style={s.winTop}>
        <Text style={s.winLabel}>{w.label}</Text>
        <Text style={[s.pct, { color: l === 'ok' ? t.c.txPrimary : levelColor(t, l) }]}>
          <Text style={s.pctK}>{isEn ? '' : '剩余 '}</Text>{left}%{isEn ? <Text style={s.pctK}>{en('usage.left')}</Text> : null}
        </Text>
      </View>
      <UsageBar left={left} />
      <Text style={s.winReset}>{resetLabel(w.resetsAt, now, locale) ?? (isEn ? en('usage.resetUnknown') : '重置时间未知')}</Text>
    </View>
  );
}

function AgentCard({ agent, u, now }: { agent: keyof Usage; u: AgentUsage; now: number }) {
  const t = useTheme();
  const s = st(t);
  const { locale, isEn, en } = useLocale();
  const plan = u.plan ? PLAN[u.plan] ?? u.plan : null;
  const stale = isStale(u);
  const ago = u.available ? (agoLabel(u.asOf, now, locale) ?? '') : '';
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Text style={s.name}>{NAMES[agent]}</Text>
        {plan ? <Text style={s.plan}>{plan}</Text> : null}
        <View style={{ flex: 1 }} />
        {u.available && u.asOf ? (
          <Text style={[s.asOf, stale && { color: t.c.txWarning }]}>
            {stale
              ? (isEn ? en('usage.asOfStale', { ago }) : `上一轮记下的 · ${ago}`)
              : (isEn ? en('usage.asOfFresh', { ago }) : `更新于 ${ago}`)}
          </Text>
        ) : null}
      </View>
      {u.available ? (
        u.windows.length
          ? u.windows.map((w) => <WindowBlock key={w.id} w={w} now={now} />)
          : <Text style={s.note}>{isEn ? en('usage.noWindows') : '账号没有返回额度窗口。'}</Text>
      ) : (
        <Text style={s.note}>{u.reason}</Text>
      )}
      {u.available && stale ? (
        <Text style={s.note}>
          {isEn
            ? en('usage.staleNote', { err: u.liveError ? ` (${u.liveError})` : '' })
            : `这是电脑上一轮 Codex 跑完时记下的，之后在别处用掉的不算在内——实时的问不到${u.liveError ? `（${u.liveError}）` : ''}。`}
        </Text>
      ) : null}
      {u.available && u.extraUsage ? <Text style={s.note}>{isEn ? en('usage.extraUsage') : '额度用完后会按量计费（超额用量已开启）。'}</Text> : null}
    </View>
  );
}

/** 点开之后的完整面板：每个窗口一条、重置时间、刷新。 */
export function UsageSheet({
  open, onClose, state,
}: { open: boolean; onClose: () => void; state: UsageState }) {
  const t = useTheme();
  const s = st(t);
  const { isEn, en } = useLocale();
  const { data, err, busy, now, load } = state;
  return (
    <Sheet open={open} onClose={onClose} title={isEn ? en('about.usageGroup') : '用量'}>
      <SheetP>{isEn ? en('usage.sheetDesc') : '电脑上各 agent 的套餐额度。显示的是还剩多少，用到 0 就要等重置。'}</SheetP>
      {err ? <Text style={s.err}>{err.message}{err instanceof BatonError && err.fix ? `　${err.fix}` : ''}</Text> : null}
      {data ? (
        <View style={s.cards}>
          <AgentCard agent="claude" u={data.claude} now={now} />
          <AgentCard agent="codex" u={data.codex} now={now} />
          {data.antigravity ? <AgentCard agent="antigravity" u={data.antigravity} now={now} /> : null}
        </View>
      ) : !err ? <ActivityIndicator style={{ marginVertical: 24 }} color={t.c.txTertiary} /> : null}
      <Tappable
        style={s.refresh}
        onPress={() => load(true)}
        haptic={haptics.tap}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={isEn ? en('usage.refreshA11y') : '刷新用量'}
      >
        {busy ? <ActivityIndicator size="small" color={t.c.txSecondary} /> : <IconRefresh size={15} color={t.c.txSecondary} />}
        <Text style={s.refreshTx}>{busy ? (isEn ? en('usage.refreshing') : '正在刷新…') : (isEn ? en('usage.refresh') : '刷新')}</Text>
      </Tappable>
    </Sheet>
  );
}

const st = (t: Theme) =>
  StyleSheet.create({
    row: { paddingVertical: 12, gap: 7 },
    rowLine: { borderBottomWidth: t.hairline, borderBottomColor: t.c.bdTertiary },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
    rowBar: { paddingRight: 22 },
    name: { fontFamily: t.fonts.sans, fontSize: t.size.md, fontWeight: t.weight.bold, color: t.c.txPrimary },
    plan: {
      fontFamily: t.fonts.sans, fontSize: 11, fontWeight: t.weight.bold, color: t.c.coral,
      backgroundColor: t.c.accentSoft, borderRadius: t.radius.full, overflow: 'hidden',
      paddingHorizontal: 7, lineHeight: 18,
    },
    // 等宽数字：刷新时数字变了，整行不该跟着左右挪
    pct: {
      fontFamily: t.fonts.sans, fontSize: t.size.md, fontWeight: t.weight.bold,
      fontVariant: ['tabular-nums'],
    },
    pctK: { fontSize: 12, fontWeight: t.weight.normal, color: t.c.txTertiary },
    sub: { fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18, color: t.c.txTertiary, paddingRight: 22 },

    cards: { gap: 12, marginTop: 6 },
    card: { backgroundColor: t.c.bgSecondary, borderRadius: t.radius.lg, padding: 14, gap: 12 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    asOf: { fontFamily: t.fonts.sans, fontSize: 12, color: t.c.txTertiary },
    win: { gap: 6 },
    winTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
    winLabel: { fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txSecondary },
    winReset: { fontFamily: t.fonts.sans, fontSize: 12, color: t.c.txTertiary },
    note: { fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 19, color: t.c.txTertiary },
    err: { fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 19, color: t.c.txDanger, marginTop: 8 },
    refresh: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      alignSelf: 'center', marginTop: 16, minHeight: t.space.tap, paddingHorizontal: 20,
      borderRadius: t.radius.full, backgroundColor: t.c.bgSecondary,
    },
    refreshTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txSecondary },
  });
