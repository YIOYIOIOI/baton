import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { IconRight, IconTick } from '@/icons';
import { Tappable } from './ui';
import * as haptics from '@/feedback/haptics';

/**
 * 分组卡片 + 每行一个选项 + 选中行打勾。
 *
 * ## 为什么会有这个组件
 *
 * 配置面板原来四节全是平铺的药丸按钮。owner：「哪有菜单是这样按钮直接摆出来的？
 * 你去看下别人怎么设计的」。
 *
 * 去看了，也拿到了他发的两张截图（Claude App 的 Select model、GPT App 的配置）。
 * 两个 App 的做法一致，而且和 iOS 的通行规矩一致：
 *
 *   2 个、短标签         分段控件
 *   2–5 个、短标签       分段控件
 *   5–12 个、或标签长    **行 + 打勾**（就是这个组件）
 *   多、有层级、要解释   行 + 下钻子页
 *
 * 平铺按钮的问题不是难看：一排药丸**放不下那句解释**。而这个面板里最要紧的
 * 两节——模型（要带一句它是什么）和权限（每档的后果差别很大）——恰恰都需要解释。
 *
 * ## 为什么打勾在右边、而不是把选中项染色
 *
 * 染色要靠颜色对比来传达「选中」，而这份配色在深色模式下对比会掉一档；
 * 打勾是形状，任何配色下都读得出来。两张截图里也都是右侧打勾。
 */

export type Option<T extends string> = {
  id: T;
  label: string;
  /** 副标题。没有就不占位——空行比没有行更难看。 */
  body?: string | null;
  /** 右侧的补充说明，和 body 不同，它跟标题同一行。 */
  note?: string | null;
  /** 不可选。必须同时给 why，否则就是个不解释自己的灰行。 */
  disabled?: boolean;
  why?: string | null;
  /** 破坏性的那一档，标题染红（权限里的「全部放行」）。 */
  danger?: boolean;
};

export function SelectList<T extends string>({
  options, value, onPick, disabled = false,
}: {
  options: readonly Option<T>[];
  value: T | null;
  onPick: (id: T) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  const s = styles(t);
  if (!options.length) return null;

  return (
    <View style={s.card}>
      {options.map((o, i) => {
        const on = o.id === value;
        const off = disabled || !!o.disabled;
        return (
          <Tappable
            key={o.id}
            style={[s.row, i > 0 && s.line, off && s.off]}
            feedback={off ? 'none' : 'fill'}
            disabled={off}
            // 选中即生效，没有「确定」——这是设置不是表单。破坏性的那一档由
            // 调用方再套一层确认，那是它的事，不是这个组件的事。
            haptic={o.danger ? haptics.thud : haptics.select}
            onPress={() => onPick(o.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: off }}
          >
            <View style={s.text}>
              <View style={s.titleRow}>
                <Text style={[s.title, o.danger && on && { color: t.c.txDanger }]}>{o.label}</Text>
                {o.note ? <Text style={s.note}>{o.note}</Text> : null}
              </View>
              {o.body ? <Text style={s.body}>{o.body}</Text> : null}
              {/* 禁用的行必须说出原因。一个不解释自己的灰行只会让人反复去点它 */}
              {o.disabled && o.why ? <Text style={s.why}>{o.why}</Text> : null}
            </View>
            {on ? <IconTick size={18} color={t.c.coral} /> : null}
          </Tappable>
        );
      })}
    </View>
  );
}

/**
 * 一行「标题 …… 当前值 ›」。点进去是子页面。
 *
 * 这是两张截图里都有的那种行（`Effort  Medium ›`、`速度  标准 ⌄`）。它的价值在于
 * **当前值一眼可见**——不用展开就知道现在是什么，而这正是平铺按钮做不到的：
 * 那排药丸横向滚动，第三颗之后默认在屏幕外。
 */
export function DetailRow({
  label, value, onPress, danger = false, first = true,
}: {
  label: string;
  value: string;
  onPress: () => void;
  danger?: boolean;
  /** 不是卡片里的第一行时，上面画一条分隔线。 */
  first?: boolean;
}) {
  const t = useTheme();
  const s = styles(t);
  return (
    <Tappable
      style={[s.row, !first && s.line]}
      feedback="fill"
      haptic={haptics.tap}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}：${value}`}
    >
      <Text style={[s.title, { flex: 1 }]}>{label}</Text>
      <Text style={[s.value, danger && { color: t.c.txDanger }]} numberOfLines={1}>{value}</Text>
      <IconRight size={16} color={t.c.txTertiary} />
    </Tappable>
  );
}

/** 卡片上方那个小标题。分组之间靠它分，不靠留白——留白说不出这一组是什么。 */
export function GroupH({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={styles(t).groupH}>{children}</Text>;
}

const styles = (t: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.c.bgSecondary,
      borderRadius: t.radius.xl,
      // 这里可以裁：卡片内没有会鼓出边界的东西（那是分段控件的事）
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 15,
      paddingVertical: 12,
      minHeight: t.space.tap,
    },
    // 分隔线从左边缩进，和 iOS 一致：它分的是行，不是整块卡片
    line: { borderTopWidth: t.hairline, borderTopColor: t.c.bdTertiary },
    off: { opacity: 0.5 },

    text: { flex: 1 },
    titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    title: { fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txPrimary },
    note: { fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txTertiary },
    body: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18,
      color: t.c.txTertiary, marginTop: 2,
    },
    why: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18,
      color: t.c.txWarning, marginTop: 2,
    },
    value: {
      fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txTertiary,
      maxWidth: 180, textAlign: 'right',
    },

    groupH: {
      fontFamily: t.fonts.sans, fontSize: 12, fontWeight: t.weight.bold,
      letterSpacing: 0.8, color: t.c.txTertiary,
      textTransform: 'uppercase', marginTop: 18, marginBottom: 8,
    },
  });
