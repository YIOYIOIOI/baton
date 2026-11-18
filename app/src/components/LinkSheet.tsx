import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { Sheet } from './ui';
import { LINK_BODY, LINK_LABEL } from './Notice';
import { useConnection } from '@/store/connection';
import type { LinkAxis } from '@/api/types';

/**
 * 连接详情。
 *
 * 原来点那颗圆点只弹出一句话，等于把「圆点是什么颜色」用文字又说了一遍。
 * 连接出问题时人真正想知道的是**到底卡在哪一环**：手机有没有网、隧道通不通、
 * 那台电脑答不答话、心跳是什么时候的。一句话回答不了，得摊开。
 *
 * 这一屏只读，不放任何按钮——能做的动作在阻断条上（那儿才是出问题时第一眼
 * 看到的地方），这里是「我想再确认一下」。
 */

/**
 * 状态色。**「正常」也要有颜色**。
 *
 * 原来 ok 是灰色 + 0.45 透明度，owner 的原话是「一直都是无色的」——准确：
 * 一颗看不出颜色的点，等于没有告诉任何事，出问题时也分不出是「变了色」
 * 还是「本来就那样」。绿 / 琥珀 / 红三档，一眼分得开。
 */
export function linkColor(t: Theme, link: LinkAxis): string {
  if (link === 'ok') return t.c.txSuccess;
  if (link === 'offline' || link === 'origin') return t.c.txDanger;
  return t.c.txWarning;
}

/** 心跳过去多久。**不显示绝对时间**——「14:25:02」要人自己做减法。 */
function ago(ms: number, now: number): string {
  if (!ms) return '还没有';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

function hostOf(url: string | null): string {
  if (!url) return '未配对';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function LinkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = styles(t);
  const link = useConnection((x) => x.link);
  const baseUrl = useConnection((x) => x.baseUrl);
  const token = useConnection((x) => x.token);
  const lastHeardAt = useConnection((x) => x.lastHeardAt);

  // 打开那一刻算一次就够。这一屏不是秒表，没必要每秒重渲染——
  // 而「刚刚 / N 分钟前」这个粒度上，多算几次也看不出差别。
  const now = Date.now();

  return (
    <Sheet open={open} onClose={onClose} title="连接">
      <View style={s.card}>
        <Row t={t} k="状态">
          <View style={[s.chip, { backgroundColor: chipBg(t, link) }]}>
            <View style={[s.dot, { backgroundColor: linkColor(t, link) }]} />
            <Text style={[s.chipTx, { color: linkColor(t, link) }]}>{LINK_LABEL[link]}</Text>
          </View>
        </Row>
        <Row t={t} k="电脑"><Text style={s.v} numberOfLines={1}>{hostOf(baseUrl)}</Text></Row>
        <Row t={t} k="凭据"><Text style={s.v}>{token ? '已配对' : '未配对'}</Text></Row>
        <Row t={t} k="最近心跳" last><Text style={s.v}>{ago(lastHeardAt, now)}</Text></Row>
      </View>
      <Text style={s.note}>{LINK_BODY[link]}</Text>
    </Sheet>
  );
}

function Row({
  t, k, children, last,
}: { t: Theme; k: string; children: React.ReactNode; last?: boolean }) {
  const s = styles(t);
  return (
    <View style={[s.row, !last && s.rowLine]}>
      <Text style={s.k}>{k}</Text>
      <View style={s.val}>{children}</View>
    </View>
  );
}

/** 状态胶囊的底色：同一个色相，淡到能当底。 */
function chipBg(t: Theme, link: LinkAxis): string {
  if (link === 'ok') return t.c.bgSuccess;
  if (link === 'offline' || link === 'origin') return t.c.bgDanger;
  return t.c.bgWarning;
}

const styles = (t: Theme) =>
  StyleSheet.create({
    // 卡片是实色，不是玻璃：它躺在 sheet 这块玻璃**上面**，再叠一层就是
    // HIG 点名的玻璃叠玻璃
    card: {
      marginTop: 10, backgroundColor: t.c.bgPrimary, borderRadius: t.radius.xl,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary, paddingHorizontal: 15,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingVertical: 8 },
    rowLine: { borderBottomWidth: t.hairline, borderBottomColor: t.c.bdTertiary },
    k: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txSecondary },
    val: { flex: 1, alignItems: 'flex-end' },
    v: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txPrimary },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 10, paddingVertical: 5, borderRadius: t.radius.full,
    },
    dot: { width: 7, height: 7, borderRadius: t.radius.full },
    chipTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold },
    note: {
      marginTop: 12, fontFamily: t.fonts.sans, fontSize: t.size.xs,
      lineHeight: 20, color: t.c.txTertiary,
    },
  });
