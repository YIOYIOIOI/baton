import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Switch, Text, View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import Svg, { Rect } from 'react-native-svg';
import { useTheme, type Theme } from '@/theme';
import { IconRight } from '@/icons';
import {
  BarTitle, Chip, FloatBar, Sheet, SheetP, Tappable, useFloatBarHeight,
} from '@/components/ui';
import * as haptics from '@/feedback/haptics';
import { useConnection } from '@/store/connection';
import { linkLabel } from '@/components/Notice';
import { ScrollEdge } from '@/components/ScrollEdge';
import { useDockHeight } from '@/components/PageDock';
import { PUSH_HINT, disablePush, enablePush, pushHint, pushState, type PushState } from '@/store/push';
import { useThemePref, type ThemePref } from '@/store/theme';
import { UsageRow, UsageSheet, useUsage } from '@/components/Usage';
import { useLocale } from '@/i18n';
import type { LocalePref } from '@/store/locale';
import { agoLabel } from '@/api/usage';
import type { DeviceItem, Health, PairQrResult } from '@/api/types';

/**
 * 版本号。成熟 App 的设置页都有这一行——报 bug 时第一件要问的就是它，
 * 没有的话只能让人去描述「我大概什么时候装的」。
 *
 * 取自 app.json，不另写一份常量：两份迟早对不上，而对不上的版本号
 * 比没有版本号更糟。
 */
/**
 * 三档而不是两档：**「跟随系统」必须是能选回去的一档**。只给明/暗开关的话，
 * 用户碰过一次就永远回不到跟随系统，而那才是大多数时候想要的。
 */
const THEMES: { k: ThemePref; label: string }[] = [
  { k: 'system', label: '跟随系统' },
  { k: 'light', label: '浅色' },
  { k: 'dark', label: '深色' },
];

const VERSION = [
  Constants.expoConfig?.version,
  Constants.expoConfig?.ios?.buildNumber,
].filter(Boolean).join(' · ') || '—';

/**
 * 设置。
 *
 * **这一页整个重写过一次。** 上一版是把设计笔记直接搬上屏：整页衬线散文，
 * 讲「两根轴为什么是分开的」「为什么中途打断做不到」，还把
 * 「localStorage（不安全，仅开发用）」摆给用户看。owner 的评价是
 * 「不像给用户读的，太 demo 了」——准确。那些内容是写给实现者的。
 *
 * 现在的结构对标成熟产品的设置页：**分组行 + 原生控件**，一屏能扫完。
 *   - 每行左边是名字、右边是值或开关，不写解释性长句
 *   - 解释退到「使用说明」那一屏里，并且重写成用户视角（不讲实现，讲现象）
 *   - 破坏性操作（解除配对）单独放在最后，红色，带二次确认
 *
 * 上一版那个「解除配对」按钮是淡粉底 + 淡粉字，在米色背景上几乎看不见——
 * 既读不出来也不像能点。破坏性动作要显眼，但显眼不等于危险地容易点到，
 * 所以配了确认。
 */
export default function AboutScreen() {
  const t = useTheme();
  const router = useRouter();
  const baseUrl = useConnection((s) => s.baseUrl);
  const link = useConnection((s) => s.link);
  const unpair = useConnection((s) => s.unpair);
  const client = useConnection((s) => s.client);

  const pref = useThemePref((p) => p.pref);
  const setPref = useThemePref((p) => p.set);
  const { pref: localePref, setPref: setLocalePref, locale, isEn, en, trNew } = useLocale();
  const [push, setPush] = useState<PushState>('unsupported');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [devErr, setDevErr] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [qr, setQr] = useState<PairQrResult | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrErr, setQrErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canManage = health?.canSetPermissionMode !== false;
  const usage = useUsage(canManage);
  const dockH = useDockHeight();
  // 权限状态只能在浏览器里读，所以挂载后才问——服务端预渲染时问不出来
  useEffect(() => { setPush(pushState()); }, []);

  useFocusEffect(useCallback(() => {
    let alive = true;
    if (!client) return () => { alive = false; };
    client.health().then((h) => { if (alive) setHealth(h); }).catch(() => {});
    setDevErr(null);
    client.devices()
      .then((r) => { if (alive) setDevices(r.devices); })
      .catch((e: Error) => { if (alive) setDevErr(e.message); });
    return () => { alive = false; };
  }, [client]));

  const parsedQr = useMemo(() => (qr ? parseQrSvg(qr.svg) : null), [qr]);

  // 「不支持」和「被拒过」都没法在这里改：前者没救，后者要去系统设置
  const canToggle = client !== null && (push === 'on' || push === 'off');

  async function togglePush() {
    if (!client || busy) return;
    setBusy(true);
    try {
      setPush(push === 'on' ? await disablePush(client) : await enablePush(client));
    } catch {
      setPush(pushState());
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke(dev: DeviceItem) {
    if (!client || revokingId) return;
    setRevokingId(dev.id);
    try {
      await client.revokeDevice(dev.id);
      if (dev.current) {
        await unpair();
        router.replace('/welcome');
        return;
      }
      setDevices((prev) => (prev ? prev.filter((x) => x.id !== dev.id) : prev));
    } catch (e) {
      setDevErr((e as Error).message);
    } finally {
      setRevokingId(null);
    }
  }

  function confirmRevoke(dev: DeviceItem) {
    if (dev.current) {
      const msg = trNew('about.revokeCurrent');
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert(trNew('about.revoke'), msg);
      return;
    }
    if (Platform.OS === 'web') {
      if (window.confirm(`${trNew('about.revokeAsk')}\n${trNew('about.revokeBody')}`)) void doRevoke(dev);
      return;
    }
    Alert.alert(
      trNew('about.revokeAsk'),
      trNew('about.revokeBody'),
      [
        { text: isEn ? en('about.cancel') : '取消', style: 'cancel' },
        { text: trNew('about.revoke'), style: 'destructive', onPress: () => { void doRevoke(dev); } },
      ],
    );
  }

  async function generateQr() {
    if (!client || qrBusy) return;
    setQrBusy(true);
    setQrErr(null);
    setCopied(false);
    try {
      const res = await client.mintPairQr();
      setQr(res);
    } catch (e) {
      setQrErr((e as Error).message || trNew('about.pairErr'));
    } finally {
      setQrBusy(false);
    }
  }

  async function copyQrUrl() {
    if (!qr?.pairUrl) return;
    await Clipboard.setStringAsync(qr.pairUrl);
    haptics.tap();
    setCopied(true);
  }

  // 两端同一句话。原来写了两遍、还差几个字——同一个确认在网页和原生上
  // 措辞不同，读起来像两件不同的事。
  const UNPAIR_ASK = isEn ? en('about.unpairAsk') : '要重新扫码才能再连上，地址会留着。';

  function confirmUnpair() {
    const go = async () => { await unpair(); router.replace('/welcome'); };
    // web 上没有原生 Alert，RN Web 的 Alert 是 no-op——用 confirm 兜住，
    // 否则网页端点了没有任何反应，看着像坏了
    if (Platform.OS === 'web') {
      if (window.confirm(UNPAIR_ASK)) go();
      return;
    }
    Alert.alert(
      isEn ? en('about.unpairTitle') : '解除配对？',
      UNPAIR_ASK,
      [
        { text: isEn ? en('about.cancel') : '取消', style: 'cancel' },
        { text: isEn ? en('about.confirmUnpair') : '解除', style: 'destructive', onPress: go },
      ],
    );
  }

  const s = styles(t);
  const barH = useFloatBarHeight();
  const themeItems = isEn
    ? [
      { k: 'system' as ThemePref, label: en('about.themeSystem') },
      { k: 'light' as ThemePref, label: en('about.themeLight') },
      { k: 'dark' as ThemePref, label: en('about.themeDark') },
    ]
    : THEMES;
  const langItems: { k: LocalePref; label: string }[] = [
    { k: 'auto', label: trNew('lang.auto') },
    { k: 'en', label: trNew('lang.en') },
    { k: 'zh', label: trNew('lang.zh') },
  ];

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={[s.scroll, { paddingTop: barH, paddingBottom: dockH + 24 }]}>

        {/*
          用量放最上面：看设置页最常见的理由就是「额度还剩多少」（owner 2026-11-15：
          「目前手机看不到额度用量」）。数直接摆在行上，点行看全部窗口。访客整组不显示。
        */}
        {!usage.hidden && (
          <Group t={t} label={isEn ? en('about.usageGroup') : '用量'}>
            <UsageRow agent="claude" u={usage.data?.claude ?? null} now={usage.now} error={usage.err?.message} onPress={() => setUsageOpen(true)} />
            <UsageRow
              agent="codex"
              u={usage.data?.codex ?? null}
              now={usage.now}
              error={usage.err?.message}
              onPress={() => setUsageOpen(true)}
              last={!usage.data?.antigravity}
            />
            {usage.data?.antigravity && (
              <UsageRow agent="antigravity" u={usage.data.antigravity} now={usage.now} error={usage.err?.message} onPress={() => setUsageOpen(true)} last />
            )}
          </Group>
        )}

        <Group t={t} label={isEn ? en('about.connectionGroup') : '连接'}>
          <Row t={t} k={isEn ? en('about.host') : '电脑'} v={baseUrl ? hostOf(baseUrl) : (isEn ? en('about.unpaired') : '未配对')} />
          <Row t={t} k={isEn ? en('about.status') : '状态'} v={linkLabel(link, locale)} accent={link === 'ok' ? undefined : t.c.txWarning} last />
        </Group>

        {/*
          外观放在最前面的分组之后、通知之前。
          **它属于这里，不属于输入框那颗「配置」药丸**——那颗管的是「这条消息
          怎么被执行」，而深浅色是全局偏好，跟某一条消息无关。一度放错地方，
          结果是列表页根本够不着（owner：「深浅模式开关哪去了」）。
        */}
        <Group t={t} label={isEn ? en('about.appearanceGroup') : '外观'}>
          <View style={s.row}>
            <Text style={[s.k, { flex: 1 }]}>{isEn ? en('about.theme') : '深浅色'}</Text>
          </View>
          <View style={[s.themeRow, s.rowLine]}>
            {themeItems.map((x) => (
              <Chip
                key={x.k}
                label={x.label}
                on={pref === x.k}
                onPress={() => setPref(x.k)}
              />
            ))}
          </View>
          <View style={s.row}>
            <Text style={[s.k, { flex: 1 }]}>{trNew('lang.label')}</Text>
          </View>
          <View style={s.themeRow}>
            {langItems.map((x) => (
              <Chip
                key={x.k}
                label={x.label}
                on={localePref === x.k}
                onPress={() => setLocalePref(x.k)}
              />
            ))}
          </View>
        </Group>

        {client && (
          <Group t={t} label={trNew('about.devices')}>
            {devErr ? (
              <View style={s.row}>
                <Text style={[s.hint, { color: t.c.txDanger, marginTop: 0 }]}>{trNew('about.devicesErr')}: {devErr}</Text>
              </View>
            ) : devices === null ? (
              <View style={s.row}>
                <Text style={[s.hint, { marginTop: 0 }]}>{trNew('about.devicesLoading')}</Text>
              </View>
            ) : devices.length === 0 ? (
              <View style={s.row}>
                <Text style={[s.hint, { marginTop: 0 }]}>{trNew('about.devicesEmpty')}</Text>
              </View>
            ) : (
              devices.map((d, i) => {
                const seen = d.lastSeenAt ? agoLabel(d.lastSeenAt, usage.now, locale) : null;
                const meta = [
                  d.platform,
                  d.browser,
                  d.lastIp,
                  seen ? trNew('about.lastSeen', { time: seen }) : null,
                ].filter(Boolean).join(' · ');
                const last = i === devices.length - 1;
                return (
                  <View key={d.id} style={[s.row, !last && s.rowLine]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={s.devHead}>
                        <Text style={s.k} numberOfLines={1}>{d.label || d.id.slice(0, 8)}</Text>
                        {d.principalId ? (
                          <View style={s.badge}>
                            <Text style={s.badgeTx}>{d.principalId}</Text>
                          </View>
                        ) : null}
                        {d.current ? (
                          <View style={[s.badge, { backgroundColor: t.c.accentSoft }]}>
                            <Text style={[s.badgeTx, { color: t.c.coral }]}>{trNew('about.currentDevice')}</Text>
                          </View>
                        ) : null}
                      </View>
                      {meta ? <Text style={s.hint} numberOfLines={2}>{meta}</Text> : null}
                    </View>
                    {!d.current ? (
                      <Tappable
                        style={s.revokeBtn}
                        onPress={() => confirmRevoke(d)}
                        disabled={revokingId === d.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${trNew('about.revoke')} ${d.label}`}
                      >
                        <Text style={s.revokeTx}>{revokingId === d.id ? '…' : trNew('about.revoke')}</Text>
                      </Tappable>
                    ) : null}
                  </View>
                );
              })
            )}
          </Group>
        )}

        {client && canManage && (
          <Group t={t} label={trNew('about.pairSection')}>
            <Tappable
              style={[s.row, qr ? s.rowLine : null]}
              feedback="fill"
              onPress={() => { void generateQr(); }}
              disabled={qrBusy}
              accessibilityRole="button"
            >
              <Text style={[s.k, { flex: 1, color: t.c.txInfo }]}>
                {qrBusy ? trNew('about.pairGenerating') : trNew(qr ? 'about.pairRefresh' : 'about.pairGenerate')}
              </Text>
              {qrBusy ? <ActivityIndicator size="small" color={t.c.txTertiary} /> : <IconRight size={15} color={t.c.txTertiary} />}
            </Tappable>
            {qrErr ? (
              <View style={s.row}>
                <Text style={[s.hint, { color: t.c.txDanger, marginTop: 0 }]}>{qrErr}</Text>
              </View>
            ) : null}
            {qr ? (
              <View style={s.qrBox}>
                {parsedQr ? (
                  <View style={s.qrFrame}>
                    <Svg width={176} height={176} viewBox={`0 0 ${parsedQr.size} ${parsedQr.size}`}>
                      <Rect x={0} y={0} width={parsedQr.size} height={parsedQr.size} fill="#ffffff" />
                      {parsedQr.rects.map((r, idx) => (
                        <Rect key={idx} x={r.x} y={r.y} width={r.w} height={r.h} fill="#111111" />
                      ))}
                    </Svg>
                  </View>
                ) : null}
                <Text style={s.qrMeta}>{trNew('about.pairCode')}</Text>
                <Text selectable style={s.qrCode}>{qr.code}</Text>
                <Text style={s.qrMeta}>{trNew('about.pairExpires', { sec: qr.expiresInSec })}</Text>
                <Tappable style={s.copyBtn} onPress={() => { void copyQrUrl(); }} accessibilityRole="button">
                  <Text style={s.copyTx}>{copied ? trNew('about.pairCopied') : trNew('about.pairCopy')}</Text>
                </Tappable>
              </View>
            ) : null}
          </Group>
        )}

        <Group t={t} label={isEn ? en('about.notificationsGroup') : '通知'}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.k}>{isEn ? en('about.notifyDone') : '跑完通知我'}</Text>
              <Text style={s.hint}>{isEn ? pushHint(push, 'en') : PUSH_HINT[push]}</Text>
            </View>
            <Switch
              value={push === 'on'}
              onValueChange={togglePush}
              disabled={busy || !canToggle}
              trackColor={{ true: t.c.coral, false: t.c.bdTertiary }}
              accessibilityLabel={isEn ? en('about.notifyDone') : '跑完通知我'}
            />
          </View>
        </Group>

        {/*
          「凭据存放在 Keychain」那行删了：存在哪儿是我们的实现，不是用户
          要做的决定，也不是他能改的。这正是上一版被点名「太 demo」的那类内容，
          重写时漏掉了这一行。
        */}
        <Group t={t} label={isEn ? en('about.aboutGroup') : '关于'}>
          {/*
            刷新页面（owner 2026-11-12：「增加一个刷新按钮触发浏览器刷新，放在手机的设置页中，pc 不用」）。
            手机浏览器加到主屏幕以后没有地址栏、也没有下拉刷新，电脑上换了新版本，这里是唯一拿到它的路。
            只在网页版里有：原生 App 没有「浏览器刷新」这回事
          */}
          {Platform.OS === 'web' && (
            <Tappable
              style={[s.row, s.rowLine]}
              feedback="fill"
              onPress={() => window.location.reload()}
              accessibilityRole="button"
            >
              <View style={{ flex: 1 }}>
                <Text style={[s.k, { color: t.c.txInfo }]}>{isEn ? en('about.reload') : '刷新页面'}</Text>
                <Text style={s.hint}>{isEn ? en('about.reloadHint') : '电脑上换了新版本、或者页面卡住时用'}</Text>
              </View>
            </Tappable>
          )}
          <NavRow t={t} k={isEn ? en('about.guide') : '使用说明'} onPress={() => setHelp(true)} />
          <Row t={t} k={isEn ? en('about.appVersion') : '版本'} v={VERSION} last={!health?.version} />
          {health?.version ? <Row t={t} k={trNew('about.daemonVersion')} v={health.version} last /> : null}
        </Group>

        <Tappable
          style={s.danger}
          onPress={confirmUnpair}
          // 比普通点击重一档。破坏性动作在手上就该有分量，这是 iOS 的惯例
          haptic={haptics.thud}
          accessibilityRole="button"
        >
          <Text style={s.dangerTx}>{isEn ? en('about.unpair') : '解除配对'}</Text>
        </Tappable>

        <Text style={s.disclaimer}>{trNew('about.disclaimer')}</Text>
      </ScrollView>

      {/*
        没有返回按钮了：设置现在是底部切换器上的一页，不是从列表推进来的一层。
        字标和列表页同一处、同一个形态——两页之间只有内容在换，框架不动。
      */}
      <ScrollEdge height={barH} color={t.c.bgGrouped} />
      <FloatBar left={<BarTitle>{isEn ? en('about.title') : '设置'}</BarTitle>} />

      {/*
        说明退到这里。重写的原则：**讲现象，不讲实现**。
        用户需要知道「秒表停了意味着什么」，不需要知道「为什么两个进程续写同一份
        记录会损坏上下文」——后者是我们的问题，不是他的。
      */}
      {/*
        每条一句话。原来每条是两到三句，其中一半在解释机制（「秒表由电脑的心跳
        驱动」「Claude App 只在启动时读一次会话列表」）——机制是我们的事，
        用户要的是「看到这个意味着什么、该做什么」。
      */}
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} state={usage} />

      <Sheet open={help} onClose={() => setHelp(false)} title={isEn ? en('about.guide') : '使用说明'}>
        <H t={t}>{isEn ? en('about.helpH1') : '秒表变灰'}</H>
        <SheetP>{isEn ? en('about.helpP1') : '和电脑断开了，屏幕上的进度不再可信。'}</SheetP>

        <H t={t}>{isEn ? en('about.helpH2') : '跑着的时候发消息'}</H>
        <SheetP>{isEn ? en('about.helpP2') : '会排队，这一轮结束后发出。要中断，用输入框左边的停止键。'}</SheetP>

        <H t={t}>{isEn ? en('about.helpH3') : '淡色的标题'}</H>
        <SheetP>{isEn ? en('about.helpP3') : '那是 Baton 猜的。正常字色的来自电脑，和那边看到的一致。'}</SheetP>

        <H t={t}>{isEn ? en('about.helpH4') : '传文件'}</H>
        <SheetP>{isEn ? en('about.helpP4') : '文件会传到这个会话的项目目录下，发送时把路径一并给 agent。'}</SheetP>

        <H t={t}>{isEn ? en('about.helpH5') : '电脑上看不到手机新建的会话'}</H>
        <SheetP>{isEn ? en('about.helpP5') : '已经建好了，重启电脑上的 App 就能看到。'}</SheetP>
      </Sheet>
    </View>
  );
}

// ── 构件 ────────────────────────────────────────

function Group({ t, label, children }: { t: Theme; label: string; children: React.ReactNode }) {
  const s = styles(t);
  return (
    <View style={s.group}>
      <Text style={s.groupLabel}>{label}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function Row({
  t, k, v, accent, last,
}: { t: Theme; k: string; v: string; accent?: string; last?: boolean }) {
  const s = styles(t);
  return (
    <View style={[s.row, !last && s.rowLine]}>
      <Text style={s.k}>{k}</Text>
      <Text style={[s.v, accent ? { color: accent } : null]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

function NavRow({ t, k, onPress, last }: { t: Theme; k: string; onPress: () => void; last?: boolean }) {
  const s = styles(t);
  return (
    // fill 而不是 dim：它躺在卡片里，整行缩放会让设置页在手指下抖
    <Tappable
      style={[s.row, !last && s.rowLine]}
      feedback="fill"
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[s.k, { flex: 1 }]}>{k}</Text>
      <IconRight size={15} color={t.c.txTertiary} />
    </Tappable>
  );
}

const H = ({ t, children }: { t: Theme; children: React.ReactNode }) => (
  <Text style={styles(t).helpH}>{children}</Text>
);

function parseQrSvg(svg: string): { size: number; rects: { x: number; y: number; w: number; h: number }[] } | null {
  const vb = /viewBox="0\s+0\s+(\d+)\s+(\d+)"/.exec(svg);
  if (!vb) return null;
  const size = Number(vb[1]);
  if (!Number.isFinite(size) || size <= 0) return null;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (const m of svg.matchAll(/<rect\b([^>]+)\/?>/g)) {
    const attrs = m[1];
    if (/fill\s*=\s*"#fff"/i.test(attrs) || /width\s*=\s*"100%"/i.test(attrs)) continue;
    const x = Number(/\bx="(\d+)"/.exec(attrs)?.[1]);
    const y = Number(/\by="(\d+)"/.exec(attrs)?.[1]);
    const w = Number(/\bwidth="(\d+)"/.exec(attrs)?.[1] ?? '1');
    const h = Number(/\bheight="(\d+)"/.exec(attrs)?.[1] ?? '1');
    if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) rects.push({ x, y, w, h });
  }
  return rects.length ? { size, rects } : null;
}

/** 地址给人看的形式：去掉协议和端口，留主机名。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const styles = (t: Theme) =>
  StyleSheet.create({
    // 三档挤在一行，卡片内缩进对齐上面那行文字
    themeRow: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 8,
      paddingHorizontal: 15, paddingBottom: 13,
    },
    devHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    badge: {
      backgroundColor: t.c.bgSecondary, borderRadius: t.radius.full,
      paddingHorizontal: 7, paddingVertical: 2,
    },
    badgeTx: { fontFamily: t.fonts.sans, fontSize: 11, fontWeight: t.weight.bold, color: t.c.txSecondary },
    revokeBtn: {
      paddingHorizontal: 13, paddingVertical: 7, minHeight: 36,
      borderRadius: t.radius.full, backgroundColor: t.c.bgDanger,
      justifyContent: 'center', alignItems: 'center',
    },
    revokeTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txDanger },
    qrBox: { alignItems: 'center', paddingVertical: 16, gap: 8 },
    qrFrame: { padding: 12, backgroundColor: '#ffffff', borderRadius: t.radius.lg },
    qrCode: { fontFamily: t.fonts.mono, fontSize: 18, letterSpacing: 2, color: t.c.txPrimary },
    qrMeta: { fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txTertiary },
    copyBtn: {
      marginTop: 4, paddingHorizontal: 14, paddingVertical: 8, minHeight: 36,
      borderRadius: t.radius.full, backgroundColor: t.c.bgSecondary, justifyContent: 'center',
    },
    copyTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txPrimary },
    disclaimer: {
      fontFamily: t.fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center',
      color: t.c.txTertiary, marginHorizontal: t.space.pad, marginTop: 18,
    },
    // 分组列表的页底。见 tokens 里 bgGrouped 的注释
    screen: { flex: 1, backgroundColor: t.c.bgGrouped },
    scroll: {
      paddingBottom: 40,
      width: '100%',
      maxWidth: t.layout.contentMaxW,
      alignSelf: 'center',
    },

    group: { paddingHorizontal: t.space.pad, paddingTop: 22 },
    groupLabel: {
      fontFamily: t.fonts.sans, fontSize: 12, fontWeight: t.weight.bold,
      letterSpacing: 0.7, color: t.c.txTertiary,
      paddingLeft: 4, paddingBottom: 8, textTransform: 'uppercase',
    },
    // 分组卡片：浅色靠极轻投影 + 明度差浮在灰底上，深色靠顶面极细边线界定轮廓
    card: {
      backgroundColor: t.c.bgPrimary, borderRadius: t.radius.xl,
      paddingHorizontal: 16, overflow: 'hidden',
      ...(t.isDark
        ? { borderWidth: t.hairline, borderColor: 'rgba(255,255,255,0.07)' }
        : Platform.OS === 'web'
          ? { boxShadow: '0 1px 3px rgba(22,22,28,0.04), 0 0 0 1px rgba(34,33,31,0.035)' } as never
          : null),
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      minHeight: t.space.tap + 6, paddingVertical: 10,
    },
    // 分隔线从文字起始处开始，不贯通到卡片边缘——iOS 设置页就是这个做法
    rowLine: { borderBottomWidth: t.hairline, borderBottomColor: t.c.bdTertiary },
    k: { fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txPrimary },
    v: { flex: 1, textAlign: 'right', fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txTertiary },
    hint: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18,
      color: t.c.txTertiary, marginTop: 3, paddingRight: 12,
    },

    // 破坏性动作在 iOS 上是**单独一张卡、红字居中**，不是一个描边按钮
    danger: {
      marginHorizontal: t.space.pad, marginTop: 28,
      minHeight: t.space.tap + 8, borderRadius: t.radius.xl,
      backgroundColor: t.c.bgPrimary,
      alignItems: 'center', justifyContent: 'center',
      ...(t.isDark
        ? { borderWidth: t.hairline, borderColor: 'rgba(242,131,111,0.22)' }
        : Platform.OS === 'web'
          ? { boxShadow: '0 1px 3px rgba(22,22,28,0.04), 0 0 0 1px rgba(179,38,30,0.08)' } as never
          : null),
    },
    dangerTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.md, fontWeight: t.weight.bold,
      color: t.c.txDanger,
    },
    helpH: {
      fontFamily: t.fonts.sans, fontSize: t.size.sm, fontWeight: t.weight.bold,
      color: t.c.txPrimary, marginTop: 16,
    },
  });
