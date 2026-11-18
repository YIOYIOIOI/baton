import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { IconBranch, IconFile, IconLines, IconRefresh, IconTick } from '@/icons';
import { Glass, useNativeGlass } from './Glass';
import { Tappable, useFloatBarHeight, FLOAT_BAR_X } from './ui';
import { useReduceMotion } from '@/a11y/motion';
import * as haptics from '@/feedback/haptics';
import { useLocale } from '@/i18n';

/**
 * 右上角「…」点开的那张菜单。
 *
 * ## 为什么不是底部面板
 *
 * 原来它是一张横贯整屏的 `Sheet`。owner 2026-10-08：「右上角点开后的弹起浮窗
 * 太下面了，并且没有点击效果」——按钮在屏幕最上面，面板从最下面升起来，中间
 * 隔着整块内容；而四条短短的菜单项躺在离手指最远的地方。
 *
 * 菜单就该贴着唤起它的那颗按钮长出来。这张卡片的形制照 AttachMenu（加号那张，
 * 照 ChatGPT 实物做的）：紧凑玻璃卡、不压暗背景、从锚点那个角缩放着出现。
 * 区别只是锚在右上角。
 *
 * ## 位置不靠量，靠和浮动栏同一套数
 *
 * `useFloatBarHeight()` 就是浮动栏的下沿（安全区 + 8 + 按钮 40 + 8），
 * 横向用浮动栏自己的 `FLOAT_BAR_X`。`measureInWindow` 是异步的，点开那一刻还要
 * 等一拍回调；而这颗按钮的位置是**固定**的，没有可量的必要。
 *
 * ## 「详细程度」在卡片里换页，不再弹第二块面板
 *
 * 三档加一句解释就够，没必要为此升起一整块底部面板——那正是上面那条抱怨。
 */

export type View3 = 'summary' | 'normal' | 'verbose';

/** 三档的名字和一句话解释。桌面端叫 Summary / Normal / Verbose，一一对应。 */
export const VIEW_NAME: Record<View3, string> = { summary: '简洁', normal: '标准', verbose: '完整' };
const VIEW_DESC: Record<View3, string> = {
  summary: '只看最终回复',
  normal: '过程折成一行',
  verbose: '每一步都展开',
};

const CARD_W = 232;
const RADIUS = 22;

export function SessionMenu({
  open, onClose, related, onRelated, view, onView, onFiles, onSync, onExport,
}: {
  open: boolean;
  onClose: () => void;
  /** 同一条线上一共几个会话。1 就不显示那一行——没有可去的地方 */
  related: number;
  onRelated: () => void;
  view: View3;
  onView: (v: View3) => void;
  onFiles: () => void;
  onSync: () => void;
  onExport?: () => void;
}) {
  const t = useTheme();
  const s = sm(t);
  const { isEn, en, trNew } = useLocale();
  const top = useFloatBarHeight();
  const native = useNativeGlass();
  const reduceMotion = useReduceMotion();
  const viewNames: Record<View3, string> = isEn
    ? { summary: en('view.summary'), normal: en('view.normal'), verbose: en('view.verbose') }
    : VIEW_NAME;
  const viewDescs: Record<View3, string> = isEn
    ? { summary: en('view.summaryDesc'), normal: en('view.normalDesc'), verbose: en('view.verboseDesc') }
    : VIEW_DESC;

  // 卸载滞后于 open，否则关闭动画还没跑完组件就没了
  const [mounted, setMounted] = useState(open);
  const [page, setPage] = useState<'main' | 'view'>('main');
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => { if (open) setMounted(true); }, [open]);
  // 每次重新打开都回到主页：停在上次那个子页上，等于让人先退一步
  useEffect(() => { if (open) setPage('main'); }, [open]);

  useEffect(() => {
    if (!mounted) return undefined;
    const anim = Animated.timing(v, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 120 : (open ? 200 : 150),
      // 两个方向都先动起来再收尾：ease-in 起步慢，而起步那一刻正是人盯着看的一刻
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => anim.stop();
  }, [open, mounted, v, reduceMotion]);

  if (!mounted) return null;

  const pick = (fn: () => void) => () => { onClose(); fn(); };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* 遮罩不压暗：这是一个轻量菜单，不是一次模态决定（和 AttachMenu 同一条） */}
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel={isEn ? en('menu.close') : '关闭'} />

      <Animated.View
        style={[
          s.card,
          { top, right: FLOAT_BAR_X },
          {
            opacity: v,
            transform: [
              { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
              // 缩放原点挪到右上角：卡片是从那颗「…」长出来的。RN 没有 transformOrigin
              { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [CARD_W * 0.05, 0] }) },
              { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-22, 0] }) },
            ],
          },
        ]}
      >
        {/* 阴影只在没有原生玻璃时补：Liquid Glass 自带景深，再叠一层是重复。
            不补的话这张卡片压在白底内容上几乎看不出边（和 Fab 同一条规矩）。 */}
        <Glass radius={RADIUS} style={[s.glass, !native && t.shadow]}>
          {page === 'main' ? (
            <>
              {related > 1 ? (
                <Item
                  t={t}
                  icon={<IconBranch size={18} color={t.c.txSecondary} />}
                  label={isEn ? en('menu.related') : '相关会话'}
                  value={String(related)}
                  onPress={pick(onRelated)}
                />
              ) : null}
              <Item
                t={t}
                icon={<IconLines size={18} color={t.c.txSecondary} />}
                label={isEn ? en('menu.detail') : '详细程度'}
                value={viewNames[view]}
                onPress={() => setPage('view')}
              />
              <Item
                t={t}
                icon={<IconFile size={18} color={t.c.txSecondary} />}
                label={isEn ? en('menu.files') : '文件'}
                onPress={pick(onFiles)}
              />
              {onExport ? (
                <Item
                  t={t}
                  icon={<IconFile size={18} color={t.c.txSecondary} />}
                  label={trNew('menu.exportMd')}
                  onPress={pick(onExport)}
                />
              ) : null}
              <Item
                t={t}
                icon={<IconRefresh size={18} color={t.c.txSecondary} />}
                label={isEn ? en('menu.sync') : '刷新'}
                onPress={pick(onSync)}
              />
            </>
          ) : (
            (['summary', 'normal', 'verbose'] as const).map((k) => (
              <Item
                key={k}
                t={t}
                icon={k === view
                  ? <IconTick size={18} color={t.c.txPrimary} />
                  : <View style={s.tickSlot} />}
                label={viewNames[k]}
                desc={viewDescs[k]}
                onPress={pick(() => onView(k))}
              />
            ))
          )}
        </Glass>
      </Animated.View>
    </Modal>
  );
}

function Item({
  t, icon, label, value, desc, onPress,
}: {
  t: Theme; icon: React.ReactNode; label: string;
  value?: string; desc?: string; onPress: () => void;
}) {
  const s = sm(t);
  return (
    <Tappable
      style={[s.row, desc ? s.rowTall : null]}
      // 按下要看得见——owner 点名的「没有点击效果」就是这一条
      feedback="fill"
      haptic={haptics.select}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={desc ? `${label} · ${desc}` : label}
    >
      <View style={s.icon}>{icon}</View>
      <View style={s.mid}>
        <Text style={s.label}>{label}</Text>
        {desc ? <Text style={s.desc}>{desc}</Text> : null}
      </View>
      {value ? <Text style={s.value}>{value}</Text> : null}
    </Tappable>
  );
}

const sm = (t: Theme) =>
  StyleSheet.create({
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    card: { position: 'absolute', width: CARD_W },
    // 不裁剪：玻璃自带的高光边和景深会溢出一点，裁掉就没有"浮起来"的感觉
    glass: { borderRadius: RADIUS, paddingVertical: 6, overflow: 'visible' },
    row: {
      minHeight: 44, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 14, gap: 12,
    },
    rowTall: { minHeight: 52 },
    icon: { width: 20, alignItems: 'center' },
    tickSlot: { width: 18, height: 18 },
    mid: { flex: 1 },
    label: { fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txPrimary },
    desc: { fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txTertiary, marginTop: 1 },
    value: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txTertiary },
  });
