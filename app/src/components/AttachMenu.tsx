import { useEffect, useRef, useState } from 'react';
import {
  Animated, Dimensions, Easing, Modal, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { IconCamera, IconFile, IconImage } from '@/icons';
import { Glass } from './Glass';
import { useReduceMotion } from '@/a11y/motion';
import * as haptics from '@/feedback/haptics';
import type { PickSource } from '@/store/attach';

/**
 * 加号点开的那张卡片。**照 ChatGPT 的实物做的**（owner 给了截图：「看 gpt 的
 * 界面怎么做你就怎么做」）。
 *
 * 量出来的形制，别随手改：
 *
 *   形状    紧凑卡片，宽度约半屏，**不是横贯整屏的底部面板**
 *   材质    玻璃。keyboard 在它背后是糊的，能看出层次
 *   圆角    30pt，连续曲率
 *   行      圆形浅色底 + 图标，右边一个标签；行高 55pt，行间**没有分隔线**
 *   位置    贴着加号往上弹，左边缘和加号对齐
 *   动效    从左下角缩放着出现
 *
 * ## 为什么不复用 `Sheet`
 *
 * `Sheet` 是横贯整屏的底部面板，而且 7e5261b 特意把它改成了**不透明**——理由是
 * 「帧率和颜色是同一个结构造成的」。那条结论是对整屏面板下的：整屏的模糊区域大，
 * 压在滚动内容上每帧都要重新采样。
 *
 * 这张卡片面积小一个量级，而且**弹出时底下的内容是静止的**（不滚动），所以玻璃
 * 在这儿的代价和那条结论不是一回事。不去动 `Sheet` 本身。
 *
 * ## 唤起系统选择器必须等这张卡片卸载完
 *
 * 和 `Sheet` 同一个坑，而且这次更要命：iOS 上在前一个 modal 还没 dismiss 完时
 * present 相机/相册，UIKit 会拒绝，而 expo-image-picker 那个 promise **永不
 * resolve**，调用方的「正在上传」标志就永久卡住（owner 实测「闪退出相册页面并且
 * 一直卡住」）。所以 `onPick` 在**卸载之后**才调，不在按下那一刻调。
 */

type Anchor = { x: number; y: number };

const ROWS: readonly (readonly [PickSource, string])[] = [
  ['camera', '相机'],
  ['library', '照片'],
  ['file', '文件'],
];

/** 卡片宽度。GPT 那张量出来约半屏，窄到一眼能看出「这是个菜单不是一页」。 */
const CARD_W = 208;
const ROW_H = 55;
const RADIUS = 30;
/** 卡片底边到加号中心的距离。留一点缝，不要压在按钮上。 */
const LIFT = 26;

export function AttachMenu({
  open, anchor, onClose, onPick,
}: {
  open: boolean;
  /** 加号在**屏幕坐标**里的位置。没量到就退回左下角。 */
  anchor: Anchor | null;
  onClose: () => void;
  /** 卡片**完全卸载之后**才会调，见抬头最后一节。 */
  onPick: (source: PickSource) => void;
}) {
  const t = useTheme();
  const s = am(t);
  const reduceMotion = useReduceMotion();

  // 卸载滞后于 open，否则关闭动画还没跑完组件就没了
  const [mounted, setMounted] = useState(open);
  const v = useRef(new Animated.Value(0)).current;
  /** 选了哪条但还没去拿——等卸载完再交给调用方。 */
  const pending = useRef<PickSource | null>(null);

  useEffect(() => { if (open) setMounted(true); }, [open]);

  useEffect(() => {
    if (!mounted) return undefined;
    const anim = Animated.timing(v, {
      toValue: open ? 1 : 0,
      duration: reduceMotion ? 120 : (open ? 220 : 160),
      // 两个方向都先动起来再收尾：ease-in 起步慢，而起步那一刻正是人盯着看的一刻
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => anim.stop();
  }, [open, mounted, v, reduceMotion]);

  // 卸载之后才把选择交出去
  useEffect(() => {
    if (mounted) return;
    const src = pending.current;
    if (!src) return;
    pending.current = null;
    onPick(src);
  }, [mounted, onPick]);

  if (!mounted) return null;

  const win = Dimensions.get('window');
  // 没量到加号就退回左下角——总比画在屏幕中间好
  const left = anchor ? Math.max(10, anchor.x - 14) : 14;
  const bottom = anchor ? Math.max(10, win.height - anchor.y + LIFT) : 96;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/*
        遮罩**不压暗**。GPT 那张卡片弹出来时背景是原样的，只是不可点——
        压暗会把一个轻量菜单说成一次模态决定。
      */}
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="关闭" />

      <Animated.View
        style={[
          s.card,
          { left, bottom },
          {
            opacity: v,
            transform: [
              { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) },
              // 缩放原点在左下角：卡片是从加号那儿"长"出来的。
              // RN 没有 transformOrigin，用一次配套的位移把原点挪过去。
              { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-CARD_W * 0.06, 0] }) },
              { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [ROW_H * 0.9, 0] }) },
            ],
          },
        ]}
      >
        <Glass radius={RADIUS} style={s.glass}>
          {ROWS.map(([src, label]) => (
            <Pressable
              key={src}
              style={({ pressed }) => [s.row, pressed && s.rowOn]}
              /**
               * **两个平台的要求正好相反，所以这里必须分叉。**
               *
               *   原生   iOS 不允许在前一个 modal 还没 dismiss 完时 present 另一个。
               *          硬来的话 UIKit 拒绝，而 expo-image-picker 的 promise
               *          **永不 resolve**，「正在上传」标志永久卡住。
               *          → 必须**等卸载完**再唤起（见 pending / 下面那个 effect）。
               *
               *   web    选择器是对一个隐藏 `<input type="file">` 派发**合成点击**
               *          （expo-image-picker 的 web 实现），浏览器只在**用户手势的
               *          激活窗口内**才认。等一段 160ms 的关闭动画再派发，Safari
               *          早就不认了——选择器不出现，而它的 promise 同样只在
               *          `change` 里 resolve，于是也永久卡住。
               *          → 必须在按下这一刻**同步**唤起。
               *
               * 两边的失败表现一模一样（一直转圈），但成因相反。owner 在 iOS 网页端
               * 实测到的就是后者：「点击加号选照片的时候，一直加载」。
               */
              onPress={() => {
                haptics.tap();
                if (Platform.OS === 'web') {
                  onClose();
                  onPick(src); // 必须在手势的同一个任务里，不能等动画
                  return;
                }
                pending.current = src;
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <View style={s.chip}>
                {src === 'camera' ? <IconCamera size={19} color={t.c.txPrimary} />
                  : src === 'library' ? <IconImage size={19} color={t.c.txPrimary} />
                    : <IconFile size={19} color={t.c.txPrimary} />}
              </View>
              <Text style={s.label}>{label}</Text>
            </Pressable>
          ))}
        </Glass>
      </Animated.View>
    </Modal>
  );
}

const am = (t: Theme) =>
  StyleSheet.create({
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    card: { position: 'absolute', width: CARD_W },
    // 不裁剪：玻璃自带的高光边和景深会溢出一点，裁掉就没有"浮起来"的感觉
    glass: { borderRadius: RADIUS, paddingVertical: 8, overflow: 'visible' },
    row: {
      height: ROW_H, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 14, gap: 14,
    },
    // 按下只给一层很淡的底，不做位移——菜单行不是按钮，位移会让整张卡片显得松动
    rowOn: { backgroundColor: t.c.bgSecondary, opacity: 0.6 },
    // 图标坐在一颗圆形浅色底上，这是 GPT 那张卡片最认得出的特征
    chip: {
      width: 34, height: 34, borderRadius: t.radius.full,
      backgroundColor: t.c.bgSecondary,
      alignItems: 'center', justifyContent: 'center',
    },
    label: { fontFamily: t.fonts.sans, fontSize: t.size.md, color: t.c.txPrimary },
  });
