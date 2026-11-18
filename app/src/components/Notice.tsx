import { Linking, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { Tappable } from './ui';
import * as haptics from '@/feedback/haptics';
import type { LinkAxis } from '@/api/types';
import { en, type AppLocale, useLocale } from '@/i18n';

/**
 * 阻断说明。
 *
 * 四种传输故障在屏幕上长得很像，但该做的事完全不同。只说「连不上」，
 * 用户就只能瞎试。
 *
 * 原来的做法是每种配一段解释性长句（「你的网是通的，是隧道那头没回。电脑可能
 * 睡了或 Baton 退出了——这个要回去处理。」）。现在按系统 App 的结构改：
 * **短标题 + 一句话 + 一个直接能修的按钮**，具体性由按钮承担而不是由句子承担。
 *
 * 这不是把信息删掉换成简洁——是把「该怎么办」从一句话变成一次点击：
 *
 *   offline      没得修，恢复了自己会接上 → 干脆不给按钮
 *   origin       电脑那头的事 → 给「重试」
 *   intercepted  要去浏览器过登录页 → **直接给「打开浏览器」**，不是让人自己想
 *   retrying     正在自愈 → 什么都不用做
 *
 * 少一个按钮和多一个按钮同样是信息：没有按钮就是「你做不了什么」。
 */

/** 门户探测地址。iOS 自己就是拿它判有没有被拦，用它最容易把登录页勾出来。 */
const PORTAL_PROBE = 'http://captive.apple.com/hotspot-detect.html';

export type LinkFix = 'retry' | 'portal' | null;

export const LINK_INFO: Record<Exclude<LinkAxis, 'ok'>, {
  tone: 'warning' | 'danger'; title: string; body: string; fix: LinkFix;
}> = {
  retrying: { tone: 'warning', title: '重新连接中', body: '显示的是断开前的内容', fix: null },
  offline: { tone: 'danger', title: '无网络连接', body: '恢复后自动重连', fix: null },
  origin: { tone: 'danger', title: '电脑未响应', body: '可能已休眠', fix: 'retry' },
  intercepted: { tone: 'warning', title: '需要网络登录', body: '登录后返回', fix: 'portal' },
};

/**
 * 连接状态的说法**只有这一份**。
 *
 * 原来有三份：Notice 的 title、LinkDot 的 LABEL、LinkPill 的 LINK_LABEL，
 * 三处措辞各不相同（「那台电脑没应答」/「电脑未响应」/……）。同一个状态在
 * 不同地方叫不同名字，用户会以为是不同的问题。
 */
export const LINK_LABEL: Record<LinkAxis, string> = {
  ok: '已连接',
  retrying: LINK_INFO.retrying.title,
  offline: LINK_INFO.offline.title,
  origin: LINK_INFO.origin.title,
  intercepted: LINK_INFO.intercepted.title,
};

/**
 * 点那颗连接圆点时面板里的一句话。同样只有这一份——原来列表页和会话页
 * 各写了一句，只差「上面/下面」两个字。
 *
 * 'ok' 那句原来是「心跳每 15 秒一次，最近一次刚到。下面显示的就是那台电脑上的
 * 当前状态。」——心跳间隔是我们的实现细节，用户要知道的只有后半句。
 */
export const LINK_BODY: Record<LinkAxis, string> = {
  ok: '显示的是电脑上的当前状态。',
  retrying: LINK_INFO.retrying.body,
  offline: LINK_INFO.offline.body,
  origin: LINK_INFO.origin.body,
  intercepted: LINK_INFO.intercepted.body,
};

const FIX_LABEL: Record<Exclude<LinkFix, null>, string> = {
  retry: '重试',
  portal: '打开浏览器',
};

export function linkInfo(link: Exclude<LinkAxis, 'ok'>, locale: AppLocale) {
  const base = LINK_INFO[link];
  if (locale !== 'en') return base;
  const titleKey = `link.${link}Title` as const;
  const bodyKey = `link.${link}Body` as const;
  return { ...base, title: en(titleKey), body: en(bodyKey) };
}

export function linkLabel(link: LinkAxis, locale: AppLocale): string {
  if (locale !== 'en') return LINK_LABEL[link];
  if (link === 'ok') return en('link.ok');
  return en(`link.${link}Title` as const);
}

export function Notice({ link, onAction }: { link: LinkAxis; onAction?: () => void }) {
  const t = useTheme();
  const s = nt(t);
  const { locale, isEn } = useLocale();
  if (link === 'ok') return null;
  const info = linkInfo(link, locale);

  const run = () => {
    if (info.fix === 'portal') {
      // 用系统浏览器而不是应用内浏览器：登录页要拿到系统的网络会话才认
      Linking.openURL(PORTAL_PROBE).catch(() => { /* 打不开就算了，人还能自己去 */ });
      return;
    }
    onAction?.();
  };

  return (
    <View style={[s.notice, info.tone === 'danger' && { backgroundColor: t.c.bgDanger }]}>
      <View style={s.body}>
        <Text style={s.title}>{info.title}</Text>
        {info.body ? <Text style={s.fix}>{info.body}</Text> : null}
      </View>
      {info.fix ? (
        <Tappable style={s.btn} onPress={run} haptic={haptics.tap} accessibilityRole="button">
          <Text style={s.btnTx}>{isEn ? en(`link.${info.fix}`) : FIX_LABEL[info.fix]}</Text>
        </Tappable>
      ) : null}
    </View>
  );
}

/** 发送被挡住时的说明块，和 Notice 同一种语言。 */
export function Blocked({
  title, fix, action,
}: {
  title: string;
  fix: string;
  /**
   * 就地补救的按钮，**默认没有**。
   *
   * 只给「照着 fix 做一下就能过」的错用。典型的是新建会话时目录不存在——
   * 那一步 Baton 自己就能建，让人退出去手动建一遍是白绕一圈。
   * 反过来，越界那类给按钮是骗人：点了也过不去。
   */
  action?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  const s = nt(t);
  return (
    <View style={s.notice}>
      <View style={s.body}>
        <Text style={s.title}>{title}</Text>
        <Text style={s.fix}>{fix}</Text>
      </View>
      {action ? (
        <Tappable style={s.btn} onPress={action.onPress} accessibilityRole="button">
          <Text style={s.btnTx}>{action.label}</Text>
        </Tappable>
      ) : null}
    </View>
  );
}

const nt = (t: Theme) =>
  StyleSheet.create({
    notice: {
      marginHorizontal: t.space.pad, marginBottom: 8,
      paddingHorizontal: 15, paddingVertical: 12, borderRadius: t.radius.xl,
      backgroundColor: t.c.bgWarning,
      flexDirection: 'row', gap: 12, alignItems: 'center',
    },
    body: { flex: 1, minWidth: 0 },
    title: {
      fontSize: t.size.sm, fontWeight: t.weight.bold,
      color: t.c.txPrimary, fontFamily: t.fonts.sans,
    },
    fix: { color: t.c.txSecondary, fontSize: t.size.xs, lineHeight: 19, marginTop: 2, fontFamily: t.fonts.sans },
    btn: {
      backgroundColor: t.c.bgPrimary, borderRadius: t.radius.full,
      paddingHorizontal: 14, paddingVertical: 8, minHeight: 36, justifyContent: 'center',
    },
    btnTx: { fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txPrimary, fontFamily: t.fonts.sans },
  });
