import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Animated, Dimensions, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type PressableProps, type StyleProp, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import { IconBack, IconBall, IconDots, IconMenu, IconRight } from '@/icons';
import { Glass, GlassGroup, glassCapsules, useNativeGlass } from './Glass';
import * as haptics from '@/feedback/haptics';
import { markOverlayTap, wantsOverlay } from '@/feedback/webHaptics';
import { DUR, EASE_IN_OUT, EASE_OUT, EASE_SHEET } from '@/motion/curves';
import { useReduceMotion } from '@/a11y/motion';

/**
 * 原型里的基础构件，逐个搬。
 *
 * 原型是 CSS，这里是 RN，差异集中在三处，每处都按"效果一致"而非"写法一致"来译：
 *   - CSS 动画 → `Animated`（`pulse` 是珊瑚点的呼吸，不能省，它是"在跑"的唯一表达）
 *   - `position: fixed/absolute` 的浮动顶栏 → 绝对定位覆盖在滚动区之上
 *   - `<pre>` 横向滚动 → 内嵌 horizontal ScrollView
 */

/**
 * 面板还没量出高度时，先按这个距离推到屏幕外。
 *
 * 读一次就够：面板最高只有屏幕的 86%，任何一次「整屏高度」都足以把它推出视野，
 * 而旋转屏幕这件事本 App 锁了竖屏（app.json 的 orientation: portrait）。
 */
const SCREEN_H = Dimensions.get('window').height;

// ── 可点元素 ────────────────────────────────────

/**
 * 网页上按下 / 松开的过渡。
 *
 * 原生上 Pressable 的按下态是瞬切，和 iOS 系统按钮一样（按下立刻变、松开立刻回），没问题；
 * 网页上同样的瞬切在 120Hz 屏上读起来是「闪了一下」。给 120ms 的 ease-out（DUR.press、
 * EASE_OUT 同一条线）：起步几乎是立刻的，收尾是贴上去的。
 *
 * 只动透明度、缩放、底色——都不触发重排。开了「减弱动效」由 +html.tsx 里那条全局媒体查询
 * 一并压成 0（内联样式盖不过它的 !important）。
 */
const WEB_PRESS = Platform.OS === 'web'
  ? ({
    transitionProperty: 'opacity, transform, background-color',
    transitionDuration: '120ms',
    transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
  } as unknown as ViewStyle)
  : null;
const noSubscribe = () => () => {};

/**
 * 这一帧是不是已经过了水合。
 *
 * 静态导出时每个动态路由只预渲染一份（`files/[key].html`），那时拿不到地址栏里的
 * ?path=。直接拿参数渲染，预渲染出来的是根目录、水合时是子目录，React 报 #418 并整页
 * 重画。先按服务端快照（false）出一个空壳，水合完再出真内容；原生上始终是 true。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/**
 * iOS 网页上的触感覆盖层。为什么要这一层、能做到什么做不到什么，见 feedback/webHaptics.ts。
 *
 * 一块透明 `<label>` 盖在按钮上，里面挂一个隐藏的 `<input switch>`：手指点下去，浏览器
 * 把这次**真点击**转给开关，系统震一下；点击本身照常冒泡到下面的 Pressable，动作不受影响。
 * 开关自己的那份 click 就地拦住，免得按钮收到两次。
 *
 * 只在 iOS 的浏览器里铺（Android 用 vibrate，桌面不震）。预渲染时没有 navigator，先按
 * 「不铺」出，水合之后 useSyncExternalStore 再读一次——直接在渲染里判 UA 会水合不一致。
 */
function HapticOverlay() {
  const want = useSyncExternalStore(noSubscribe, wantsOverlay, () => false);
  if (Platform.OS !== 'web' || !want) return null;
  return createElement(
    'label',
    {
      'aria-hidden': true,
      'data-haptic-trigger': '',
      onPointerDown: markOverlayTap,
      style: {
        position: 'absolute', inset: 0, touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent', cursor: 'inherit',
      },
    },
    createElement('input', {
      type: 'checkbox',
      switch: '',
      tabIndex: -1,
      // 开关绝不能在手指底下：WebKit 会把落在它上面的 touchstart 当成已处理，页面就滚不动了
      style: { position: 'absolute', width: 1, height: 1, margin: 0, visibility: 'hidden' },
      onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    }),
  );
}

/**
 * 带触感和按下反馈的可点元素。
 *
 * 改之前两件事都是散的：`PillDark` 有按下反馈，`SendBtn`、输入区的加号、
 * 选择药丸**一个都没有**——点下去屏幕上什么都不动，在触屏上会让人以为没点到，
 * 于是连点好几次。触感更是全 App 一处都没有。
 *
 * 两种反馈形态对应两类元素，不能混：
 *   dim   浮起来的东西（按钮、药丸、图标键）。整体变淡 + 极轻微缩小
 *   fill  躺在页面里的东西（列表行、设置行）。压一层底色，不动几何——
 *         整行缩放会让列表在手指下抖
 *
 * 触感**默认不给**。处处都震等于处处都不震，反而更吵；只在「这一下有后果」
 * 时显式传（发送、停止、选择变了、破坏性动作）。纯导航不给。
 */
export function Tappable({
  children, onPress, haptic, feedback = 'dim', style, disabled, ...rest
}: Omit<PressableProps, 'style'> & {
  children?: React.ReactNode;
  /** 触感类型，不传就没有触感 */
  haptic?: () => void;
  feedback?: 'dim' | 'fill' | 'none';
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      /**
       * 手指在按住期间漂出去一点不该算取消。
       *
       * 默认是 0——手指移出视图边界的那一刻按压态就撤了，动作也不发。而人按
       * 小按钮时手指本来就会滚动几个像素，尤其是在走路或坐车的时候。给 12pt
       * 的余量：按下之后即使漂出边界 12pt 仍然算数，漂回来也还能继续。
       *
       * 这和 hitSlop 是两回事：hitSlop 扩大的是**能不能按到**，这个管的是
       * **按住之后算不算数**。前者要逐个量了控件尺寸才能加（加宽了会让密集
       * 列表里相邻两行互相抢），后者对所有尺寸都是净收益。
       */
      pressRetentionOffset={12}
      onPress={(e) => {
        // 触感在动作**之前**发：动作可能是异步的（发消息要等网络），
        // 等它回来再震已经晚了半秒，手感上就对不上这次点击了
        if (!disabled) haptic?.();
        onPress?.(e);
      }}
      style={({ pressed }) => [
        style,
        WEB_PRESS,
        disabled && { opacity: 0.35 },
        pressed && !disabled && feedback === 'dim' && { opacity: 0.6, transform: [{ scale: 0.97 }] },
        pressed && !disabled && feedback === 'fill' && { backgroundColor: t.c.bgSecondary },
      ]}
    >
      {children}
      {/* 只给带触感的叶子按钮铺：覆盖层会盖住子节点，容器上铺了里面的东西就点不到了 */}
      {haptic && !disabled ? <HapticOverlay /> : null}
    </Pressable>
  );
}

// ── 呼吸圆点 ────────────────────────────────────

/**
 * `@keyframes pulse`：0/100% 满，50% 缩到 .68 且淡到 .3。周期 1.6s。
 *
 * **开了「减弱动效」就不跳。** 循环摆动是这条设置最直接针对的东西之一——
 * 一个永远在呼吸的点，对前庭敏感的人是持续的干扰，而它传达的信息（「在跑」）
 * 由这个点**存在**本身就说完了，不靠动。停在满的那一档，别停在淡的那档：
 * 那样看起来像是失效了。
 */
/**
 * 那颗球在转 —— 「正在做事」的标志。
 *
 * ## 为什么转的是这颗球
 *
 * 通用 spinner 谁家都长一样；这颗球是 Baton 自己的标记，而且它正好**能转**：
 * 核心是个实心圆，**圆是旋转对称的**，所以整体旋转时肉眼只看得见那几道不对称的
 * 放射笔画在扫，圆心纹丝不动。不用拆 SVG、不用单独动那个 `<G>`——转整块就够了。
 *
 * ## 两处用它，靠「转不转」区分状态
 *
 *   进会话时     内容还没到，中间放一颗大的在转
 *   agent 跑着时 就在**回复收尾那一排**的位置转；这一轮结束它就停下来变成静止的
 *                那颗（owner：「正好 agent 执行完毕后那个 logo 就静止了」）
 *
 * 位置不变、只有动静变，比「跑的时候放个别的东西、结束换成球」读起来干净。
 *
 * ## 转速
 *
 * 2.4 秒一圈，线性。慢是有意的：它表示「在做事」，不是进度条，转快了像在催。
 * 线性是因为**没有起止**——用带缓动的曲线会在每圈接缝处顿一下，看着像卡了。
 *
 * 用 RN 的 Animated + 原生驱动，不用 Reanimated：transform 的 rotate 本来就能
 * 原生驱动，跑在 UI 线程，而这个仓库当前没有任何文件在用 Reanimated，
 * 为一个旋转把它引回来不值当。
 */
export function BallSpinner({
  size = 17, color, spinning = true, style,
}: {
  size?: number;
  color?: string;
  /** false = 静止。位置不变，只是不转了。 */
  spinning?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (!spinning || reduceMotion) { v.setValue(0); return undefined; }
    const loop = Animated.loop(
      Animated.timing(v, {
        toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [v, spinning, reduceMotion]);

  return (
    <Animated.View
      style={[
        { transform: [{ rotate: v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] },
        style,
      ]}
      // 它是状态而不是内容：读屏念一句就够，不必逐帧报告
      accessibilityRole="progressbar"
      accessibilityLabel={spinning ? '正在处理' : undefined}
    >
      <IconBall size={size} color={color ?? t.c.coral} />
    </Animated.View>
  );
}

export function Pulse({ style }: { style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (reduceMotion) { v.setValue(0); return undefined; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 800, easing: EASE_IN_OUT, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 800, easing: EASE_IN_OUT, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, reduceMotion]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.68] }) }],
        },
      ]}
    />
  );
}

// ── 浮动顶栏 ────────────────────────────────────

/**
 * Claude App 的做法：白圆按钮 + 白药丸浮在内容之上，内容从底下滚过去。
 * 不是一条占位的 header——那会把本就不多的竖向空间再切掉一块。
 */
/**
 * 浮动顶栏占掉的高度 = 安全区 + 上下内边距 + 按钮直径。
 * 各屏的滚动区要按它留出顶部空间，否则第一条内容会被压在按钮底下。
 */
/** 浮动栏左右各留这么多。贴着它弹出的东西（SessionMenu）要对齐，所以导出。 */
export const FLOAT_BAR_X = 12;

export function useFloatBarHeight() {
  return useSafeAreaInsets().top + 8 + 40 + 8;
}

export function FloatBar({
  onBack, onMenu, left, right,
}: {
  onBack?: () => void; onMenu?: () => void;
  /** 左侧自定义内容。传了就不画返回/菜单那颗按钮——列表页在这儿放字标。 */
  left?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const t = useTheme();
  const s = ui(t);
  // **必须避开灵动岛/刘海**。owner 实测：顶栏贴在 top:0，右边那颗按钮正好
  // 落在灵动岛底下，点不到。iPhone 上这块的高度按机型从 20pt 到 59pt 不等，
  // 写死任何一个数都会在别的机型上错，只能问系统要。
  const inset = useSafeAreaInsets();
  return (
    <View style={[s.floatBar, { paddingTop: inset.top + 8 }]} pointerEvents="box-none">
      {left ?? (
        <Fab
          onPress={onBack ?? onMenu}
          label={onBack ? '返回' : '菜单'}
          icon={onBack
            ? <IconBack size={19} color={t.c.txSecondary} />
            : <IconMenu size={19} color={t.c.txSecondary} />}
        />
      )}
      <View style={{ flex: 1 }} pointerEvents="none" />
      {right}
    </View>
  );
}

export function Fab({
  onPress, label, icon,
}: { onPress?: () => void; label: string; icon: React.ReactNode }) {
  const t = useTheme();
  const s = ui(t);
  const native = useNativeGlass();
  return (
    // 玻璃在外、Pressable 在内：GlassView 的已知问题是父级 opacity 为 0 会让
    // 效果整个不渲染，而 Pressable 的按下反馈正是改 opacity——套反了就会闪。
    // interactive：让材质随手指形变，这是 iOS 26 上玻璃「是活的」的来源。
    // 阴影只在没有原生玻璃时补——Liquid Glass 自带景深，再叠一层是重复。
    <Glass radius={999} interactive style={[s.fab, !native && t.shadow]}>
      <Tappable
        onPress={onPress}
        haptic={haptics.tap}
        accessibilityRole="button"
        accessibilityLabel={label}
        // 有原生玻璃时按下反馈交给材质本身（isInteractive）——
        // 再叠一层 opacity 会让高光跳一下
        feedback={native ? 'none' : 'dim'}
        style={s.fabInner}
      >
        {icon}
      </Tappable>
    </Glass>
  );
}

/**
 * 右上角那组动作。
 *
 * **有原生玻璃时是几颗各自独立的胶囊**，靠近时由 GlassContainer 融合成一条，
 * 转场时再分开——Apple 自己的 iOS 26 工具栏就是这个形态。没有原生玻璃时
 * （网页、旧系统、开了降低透明度）退回一整颗药丸，也就是今天的样子，
 * 网页端观感不变。
 */
export function FabPill({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const s = ui(t);
  const native = useNativeGlass();

  if (native) {
    return <GlassGroup spacing={16} style={s.fabCluster}>{glassCapsules(children, s.fabCapsule)}</GlassGroup>;
  }
  // 玻璃而不是实心白：这条药丸浮在会话流之上，底下的字滚过去时透出来一点
  // 才像浮着；实心白像贴了一块纸片。
  return <Glass radius={999} style={[s.fabPill, t.shadow]}>{children}</Glass>;
}

export function FabPillButton({
  onPress, label, icon,
}: { onPress?: () => void; label: string; icon: React.ReactNode }) {
  const t = useTheme();
  const s = ui(t);
  const native = useNativeGlass();
  return (
    <Tappable
      onPress={onPress}
      haptic={haptics.tap}
      accessibilityRole="button"
      accessibilityLabel={label}
      // 融合模式下这颗按钮自己就是一块玻璃（由 FabPill 裹上），按下反馈来自材质；
      // 药丸模式下它是药丸里的一格，需要自己压一层底色
      feedback={native ? 'none' : 'fill'}
      style={native ? s.fabCapsuleInner : s.fabPillBtn}
    >
      {icon}
    </Tappable>
  );
}

export const DotsIcon = () => {
  const t = useTheme();
  return <IconDots size={18} color={t.c.txSecondary} />;
};

// ── 底部 sheet ──────────────────────────────────

/**
 * 从底部升起的面板。原型用 `.sheet-wrap[data-open]` + scrim，这里用 Modal——
 * RN 里非 Modal 的绝对定位盖不住原生栈导航的头部。
 *
 * 面板本体是**玻璃**：sheet 属于 HIG 说的功能层，和导航栏、底部附件同级。
 * 原来是一块不透明的 bgTertiary，浮在内容之上却看不出「浮」，层级关系丢了。
 */
export function Sheet({
  open, onClose, onClosed, title, children, footer = null, onBack,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * 面板**真的关完、Modal 已经卸载**之后才调。`onClose` 只是发起关闭动画。
   *
   * 要这个回调是因为一个会把功能彻底卡死的坑：iOS 上在一个 modal 还没 dismiss
   * 完时去 present 另一个（相机、相册、文件选择器都是），UIKit 会拒绝，而
   * expo-image-picker 那个 promise **永远不 resolve**——调用方的「正在上传」
   * 标志就永久卡在 true，之后点多少次都没反应（owner 实测：「闪退出相册页面
   * 并且一直卡住」）。
   *
   * 所以凡是「点一行 → 关面板 → 唤起系统选择器」的地方，都要把唤起挂在这儿，
   * 不能写成 `onClose(); launch();`——那两句在同一个 tick 里，面板还在。
   */
  onClosed?: () => void;
  title?: string;
  children: React.ReactNode;
  /**
   * 传了就在标题左边长出一个返回箭头，**子页面在同一块面板内切换**。
   *
   * 不嵌套第二个 Modal：RN 上叠 Modal 有已知的层级问题，而这块面板已经踩过
   * GlassView「父级 opacity 为 0 就整个不渲染」那个坑（见下面的注释），
   * 不该再往上叠一层材质。
   */
  onBack?: () => void;
  /**
   * 底部确认按钮，**默认没有**。
   *
   * 原来默认是一颗「好」。但这些面板全是非破坏性的、点外面或下滑就能关，
   * 那颗按钮不做任何事，只是把面板撑高一截、再要人多点一下。
   * 真需要「确认才生效」的场合再显式传。
   */
  footer?: string | null;
}) {
  const t = useTheme();
  const s = ui(t);
  const inset = useSafeAreaInsets();
  // 卸载要滞后于 open：否则关闭动画还没跑完组件就没了，面板会直接消失
  const [mounted, setMounted] = useState(open);
  const [height, setHeight] = useState(0);
  const v = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => { if (open) setMounted(true); }, [open]);

  /**
   * 卸载之后才通知。用 ref 存回调，免得调用方每次渲染给个新函数就把这个
   * effect 重跑一遍；用 `wasOpen` 保证首次挂载（从没打开过）不会误触发。
   */
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasOpen = useRef(false);
  useEffect(() => { if (open) wasOpen.current = true; }, [open]);
  useEffect(() => {
    if (mounted || !wasOpen.current) return;
    wasOpen.current = false;
    onClosedRef.current?.();
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return undefined;
    const anim = Animated.timing(v, {
      toValue: open ? 1 : 0,
      /**
       * 开了「减弱动效」就压到 120ms。
       *
       * 这里**不能**照搬「减弱动效就把位移换成淡入淡出」那条通则：这块面板
       * 靠位移把自己移出屏幕来隐藏，而它不能用 opacity——父级 opacity 为 0
       * 会让 GlassView 整个不渲染（owner 实测过「第一次拉起时面板没有底色」，
       * 就是这条）。位移在这儿是承重的，拆不掉。
       *
       * 能做的是让它**短到不构成一段可被眼睛跟随的运动**：120ms 之下，整屏
       * 高度的位移读起来是「出现了」而不是「滑上来了」，而遮罩那层的淡入照旧
       * 保留——按苹果的说法，解释「状态变了」的透明度变化恰恰是要留下的那部分。
       */
      duration: reduceMotion ? 120 : (open ? 280 : 200),
      /**
       * 两个方向都用 ease-out 那条线。
       *
       * 关闭原来是 `Easing.in(Easing.cubic)`——想当然按「进来用 out、出去用
       * in」配的。但 ease-in **起步慢**，而起步那一刻正是用户盯着看的一刻：
       * 点了关闭，面板先纹丝不动几十毫秒才开始走，读起来就是「卡了一下」。
       * 苹果自己的面板两个方向都是先动起来再收尾。
       */
      easing: open ? EASE_SHEET : EASE_OUT,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => anim.stop();
  }, [open, mounted, v, reduceMotion]);

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/*
        **遮罩淡入，面板才滑。**
        原来整个 Modal 用 animationType="slide"，于是遮罩和面板一起从下面推上来——
        屏幕上先看到一块黑色矩形往上爬，很难看（owner 实测）。系统 sheet 从来
        不是这样：遮罩是原地变暗的，只有面板在动。
      */}
      <Animated.View style={[s.scrim, { opacity: v }]}>
        <Pressable style={s.scrimHit} onPress={onClose} accessibilityLabel="关闭" />
      </Animated.View>

      {/*
        靠**位移**藏，不靠 opacity。

        原因原本是 GlassView 的一条毛病（父级 opacity 为 0 会让效果整个不渲染，
        owner 实测过「第一次拉起时面板没有底色」）。面板改成不透明之后那条约束
        已经不成立了，但位移这条路本身没毛病、而且更省——opacity 会让整块参与
        合成，位移只是挪一个已经画好的层。留着。

        量到高度之前按整屏高度推到屏幕外：位置在屏幕外就是看不见。
      */}
      <Animated.View
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          // 只在真的变了时才 set：onLayout 会重复触发，每次 set 都会重建
          // 插值节点、把动画从头接一次——那本身就是掉帧的来源
          setHeight((prev) => (prev === h ? prev : h));
        }}
        style={[
          s.sheetWrap,
          {
            transform: [{
              translateY: v.interpolate({
                inputRange: [0, 1],
                outputRange: [height || SCREEN_H, 0],
              }),
            }],
          },
        ]}
      >
        {/*
          **面板本体是不透明的，不是玻璃。** 这一条改回来过一次，记下依据：

          一度改成 regular 玻璃，理由是「sheet 属于 HIG 的功能层」。owner 实测
          否掉了：「所有从底下弹起的那种窗口，帧率都明显很低，并且颜色好像还
          不对」。两个症状同一个结构：

            帧率  位移动画挂在外层 Animated.View 上，而 GlassView 在它里面——
                  外层一动玻璃就跟着动，UIVisualEffectView 每帧都要重新采样背景
            颜色  玻璃底下压着一层 rgba(20,20,19,0.38) 的遮罩，糊的是**一张被
                  压暗 38% 的页面**，于是整块比主题色偏暗偏脏

          「浮在内容之上」这件事本来就由遮罩 + 上两角圆角 + 阴影表达了，不必再
          靠材质。而 HIG 自己的排序也是：大面积承载成段文字的表面，**可读性
          压过材质观感**。
        */}
        {/*
          底部留出 Home 指示条那条余量。原来是写死的 18——面板里最后一行就压在
          指示条上，读起来是「被屏幕底边切了一刀」（owner 2026-10-08：
          「弹起浮窗太下面了」说的既是位置也是这个）。
        */}
        <View style={[s.sheet, s.sheetFill, { paddingBottom: t.space.pad + inset.bottom }]}>
          <View style={s.grab} />
          <ScrollView contentContainerStyle={{ paddingBottom: 4 }}>
            {/*
              返回箭头和标题同一行。箭头单独一行的话，子页面的标题会比主页面
              低一截，来回切时整块内容上下跳。
            */}
            {onBack ? (
              <View style={s.sheetNav}>
                <Tappable
                  style={s.sheetBack}
                  feedback="dim"
                  haptic={haptics.tap}
                  onPress={onBack}
                  accessibilityRole="button"
                  accessibilityLabel="返回"
                >
                  <IconBack size={20} color={t.c.txSecondary} />
                </Tappable>
                {title ? <SheetH>{title}</SheetH> : null}
              </View>
            ) : (title ? <SheetH>{title}</SheetH> : null)}
            {children}
          </ScrollView>
          {footer ? <PillDark label={footer} onPress={onClose} style={{ marginTop: 18 }} /> : null}
        </View>
      </Animated.View>
    </Modal>
  );
}

export function SheetH({ children }: { children: React.ReactNode }) {
  return <Text style={ui(useTheme()).sheetH}>{children}</Text>;
}

export function SheetP({ children }: { children: React.ReactNode }) {
  return <Text style={ui(useTheme()).sheetP}>{children}</Text>;
}

// ── 按钮 ────────────────────────────────────────

export function PillDark({
  label, icon, onPress, disabled, style, haptic = haptics.tap,
}: {
  label: string; icon?: React.ReactNode; onPress?: () => void;
  disabled?: boolean; style?: StyleProp<ViewStyle>;
  /** 主按钮默认给一下轻点。传 undefined 可以关掉（纯导航用不着） */
  haptic?: () => void;
}) {
  const t = useTheme();
  const s = ui(t);
  return (
    <Tappable
      onPress={onPress}
      disabled={disabled}
      haptic={haptic}
      accessibilityRole="button"
      style={[s.pillDark, style]}
    >
      {icon}
      <Text style={s.pillDarkTx}>{label}</Text>
    </Tappable>
  );
}

/**
 * 悬浮在内容之上的主操作。
 *
 * 和 PillDark 的区别不是配色是**层级**：PillDark 躺在页面里，这个浮在内容
 * 之上、列表从它底下滚过去。Apple 设计馆对这类元素的说法是「浮动玻璃工具栏
 * 随滚动保持可见，把一个动作放在一点之遥」——它本来就该是玻璃，不是实色块。
 *
 * 用**常规玻璃**，不是深色玻璃。第一版做成了深色，owner 直接问「为什么是深色的？
 * 不应该是透明玻璃吗」——对的：系统里的浮动工具栏一律是常规玻璃，深色实心块是
 * 「躺在页面里的主按钮」那一套，两者混了就既不像浮的也不像玻璃。
 * 显眼靠的是位置和留白，不是把它涂黑。
 */
export function PillGlass({
  label, icon, onPress, style,
}: {
  label: string; icon?: React.ReactNode;
  onPress?: () => void; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = ui(t);
  const native = useNativeGlass();
  return (
    <Glass radius={999} interactive style={[s.pillGlass, !native && t.shadow, style]}>
      <Tappable
        onPress={onPress}
        haptic={haptics.tap}
        // 原生玻璃自己会随手指形变，再叠 opacity 会让高光跳一下
        feedback={native ? 'none' : 'dim'}
        accessibilityRole="button"
        style={s.pillGlassInner}
      >
        {icon}
        <Text style={s.pillGlassTx}>{label}</Text>
      </Tappable>
    </Glass>
  );
}

/** 输入框里的浅色选择药丸——截图里的 "Sonnet 5 Medium"。 */
export function PillSelect({
  label, dim, mono, onPress, style,
}: {
  label: string; dim?: string; mono?: boolean;
  onPress?: () => void; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = ui(t);
  return (
    // 原来完全没有按下反馈：点下去屏幕上什么都不动，而它打开的是一个面板，
    // 面板要等一帧才升起来——那一帧里人以为没点到
    <Tappable onPress={onPress} haptic={haptics.select} accessibilityRole="button" style={[s.pillSelect, style]}>
      <Text style={[s.pillSelectTx, mono && { fontFamily: t.fonts.mono, fontSize: 12 }]} numberOfLines={1}>
        {label}
      </Text>
      {dim ? <Text style={s.pillSelectDim}>{dim}</Text> : null}
      <IconDown12 />
    </Tappable>
  );
}

const IconDown12 = () => {
  const t = useTheme();
  return <IconRight size={12} color={t.c.txTertiary} strokeWidth={2.4} />;
};

export function Chip({
  label, on, onPress,
}: { label: string; on?: boolean; onPress?: () => void }) {
  const t = useTheme();
  const s = ui(t);
  return (
    // select 而不是 tap：这是「值变了」，iOS 上的分段控件、选择器都用那一下。
    // 用 tap 会让选择摸起来像按钮。
    <Tappable
      onPress={onPress}
      haptic={haptics.select}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      style={[s.chip, on && { backgroundColor: t.c.bgInverse, borderColor: 'transparent' }]}
    >
      <Text style={[s.chipTx, on && { color: t.c.txInverse, fontWeight: t.weight.bold }]}>{label}</Text>
    </Tappable>
  );
}

export const Chips = ({ children }: { children: React.ReactNode }) => (
  <View style={ui(useTheme()).chips}>{children}</View>
);

// ── 排版零件 ────────────────────────────────────

export const Wordmark = ({ children }: { children: React.ReactNode }) => (
  <Text style={ui(useTheme()).wordmark}>{children}</Text>
);

/**
 * 浮动栏左端那行字（列表页是「Baton」，设置页是「设置」）。
 *
 * **不给玻璃**：它不可点，而玻璃在这套界面语言里意味着「这是个控件」。
 * 可读性交给 ScrollEdge 那层渐隐——内容滚到它底下时会先淡进页底色。
 */
export const BarTitle = ({ children }: { children: React.ReactNode }) => (
  <Text style={ui(useTheme()).barTitle}>{children}</Text>
);

export const ListMeta = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => (
  <Text style={[ui(useTheme()).listMeta, style]}>{children}</Text>
);

/** 流里的分隔提示，居中小灰字。 */
export const Hist = ({ children }: { children: React.ReactNode }) => (
  <Text style={ui(useTheme()).hist}>{children}</Text>
);

/** 骨架屏。Claude 的规定：inline 内容用骨架，不用 spinner。 */
export function Skeleton({ rows = 6 }: { rows?: number }) {
  const t = useTheme();
  const s = ui(t);
  const reduceMotion = useReduceMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) {
      v.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, reduceMotion]);
  const op = reduceMotion ? 1 : v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] });

  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={s.skelRow}>
          <Animated.View style={[s.skelDot, { opacity: op }]} />
          <View style={{ flex: 1 }}>
            <Animated.View style={[s.skelA, { opacity: op }]} />
            <Animated.View style={[s.skelB, { opacity: op }]} />
          </View>
        </View>
      ))}
    </>
  );
}

/**
 * 展开 / 收起的那颗小箭头：收起朝右，展开朝下，**转过去**而不是瞬切。
 *
 * 原来是 `open && rotate: 90deg` 直接换样式——箭头在两个朝向之间闪，看不出「这一组被展开了」
 * 这个因果。转 180ms（DUR.toggle）就够眼睛跟上，又不拖。减弱动效下直接到位：旋转正是那条
 * 设置要砍的东西。
 */
export function Chevron({
  open, size = 12, color, style,
}: { open: boolean; size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [v] = useState(() => new Animated.Value(open ? 1 : 0));
  useEffect(() => {
    if (reduceMotion) { v.setValue(open ? 1 : 0); return undefined; }
    const anim = Animated.timing(v, {
      toValue: open ? 1 : 0, duration: DUR.toggle, easing: EASE_OUT, useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [open, reduceMotion, v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });
  return (
    <Animated.View style={[{ width: size, height: size }, style, { transform: [{ rotate }] }]}>
      <IconRight size={size} color={color ?? t.c.txTertiary} />
    </Animated.View>
  );
}

export const ui = (t: Theme) =>
  StyleSheet.create({
    floatBar: {
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: t.z.floatBar,
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: FLOAT_BAR_X, paddingBottom: 8,
    },
    // 阴影不写在这里：有原生玻璃时材质自带景深，由组件按 useNativeGlass() 决定加不加
    fab: {
      width: 40, height: 40, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    fabInner: {
      width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    },
    // 底色交给 Glass，这里只留几何
    /*
      药丸模式（没有原生玻璃时，Expo Go 和网页端都走这条）。

      原来是 34pt 的格子、gap 2、padding 3——两颗按钮挤成一整块 76×40 的东西，
      看不出是两颗，而且 34pt 低于 44pt 的最小点击目标。owner 2026-10-08：
      「感觉按钮的样式也很怪」。现在每格 40pt、中间留 4pt 的缝，和左边那颗
      返回按钮（40pt 圆形玻璃）是同一个尺寸。
    */
    fabPill: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderRadius: t.radius.full, padding: 3,
    },
    fabPillBtn: {
      width: 40, height: 40, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    // 融合模式：每颗按钮各自一块玻璃，间距由 GlassGroup 的 spacing 决定何时连起来。
    // gap 比 spacing 小，所以静止时它们本来就是连着的一条；分开发生在转场里。
    fabCluster: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    // 居中是必须的：裹进来的子元素比胶囊小时，不居中就会贴在左上角
    fabCapsule: {
      width: 40, height: 40, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    fabCapsuleInner: {
      width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    },

    scrim: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(20,20,19,0.38)',
    },
    scrimHit: { flex: 1 },
    // 位移挂在外层，玻璃面板自己不动——把 transform 加在 GlassView 上，
    // 材质的采样会跟着一起位移，边缘会糊
    sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '86%' },
    sheet: {
      borderTopLeftRadius: 24, borderTopRightRadius: 24,
      paddingHorizontal: t.space.pad, paddingTop: 8, paddingBottom: t.space.pad,
    },
    /**
     * 不透明底色。用 bgPrimary 而不是 bgTertiary：面板里的卡片是 bgSecondary，
     * 两者要有对比，卡片才读得出是「嵌在面板上的一块」——和 iOS 设置同一套关系。
     * bgTertiary 在浅色下和 bgPrimary 同色（都是 #ffffff），那样卡片就浮不起来。
     */
    sheetFill: { backgroundColor: t.c.bgPrimary },
    // 返回箭头与标题同一行。负的左外边距把箭头顶到卡片边缘，
    // 让标题保持在和主页面同一个水平位置上——否则来回切会看到标题左右跳
    sheetNav: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -8 },
    sheetBack: {
      width: 36, height: 36, alignItems: 'center', justifyContent: 'center',
    },
    grab: {
      width: 34, height: 4, borderRadius: t.radius.full,
      backgroundColor: t.c.bdTertiary, alignSelf: 'center', marginTop: 4, marginBottom: 12,
    },
    sheetH: {
      marginTop: 16, marginBottom: 4, fontSize: t.size.xs,
      fontWeight: t.weight.bold, color: t.c.txTertiary, fontFamily: t.fonts.sans,
    },
    sheetP: {
      marginTop: 4, fontSize: t.size.sm, lineHeight: 23,
      color: t.c.txSecondary, fontFamily: t.fonts.sans,
    },

    pillDark: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      backgroundColor: t.c.bgInverse, borderRadius: t.radius.full,
      paddingHorizontal: 20, paddingVertical: 13, minHeight: t.space.tap,
    },
    pillDarkTx: {
      color: t.c.txInverse, fontSize: t.size.md, fontWeight: t.weight.bold, fontFamily: t.fonts.sans,
    },
    // 底色交给 Glass，这里只留几何
    pillGlass: { borderRadius: t.radius.full },
    pillGlassInner: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      paddingHorizontal: 22, paddingVertical: 13, minHeight: t.space.tap,
    },
    // 常规玻璃上用正文色，不是反色——反色是给深色实心块准备的
    pillGlassTx: {
      color: t.c.txPrimary, fontSize: t.size.md, fontWeight: t.weight.bold, fontFamily: t.fonts.sans,
    },
    pillSelect: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: t.c.bgPrimary, borderRadius: t.radius.full,
      paddingHorizontal: 13, paddingVertical: 7, minHeight: 34, minWidth: 0,
    },
    pillSelectTx: { fontSize: t.size.xs, color: t.c.txPrimary, fontFamily: t.fonts.sans },
    pillSelectDim: { fontSize: t.size.xs, color: t.c.txTertiary, fontFamily: t.fonts.sans },

    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingTop: 6, paddingBottom: 2 },
    chip: {
      backgroundColor: t.c.bgPrimary, borderWidth: t.hairline, borderColor: t.c.bdTertiary,
      borderRadius: t.radius.full, paddingHorizontal: 15, paddingVertical: 9,
      minHeight: 38, justifyContent: 'center',
    },
    chipTx: { fontSize: t.size.xs, color: t.c.txPrimary, fontFamily: t.fonts.sans },

    wordmark: {
      fontFamily: t.fonts.serif, fontSize: 26, lineHeight: 30,
      letterSpacing: -0.3, paddingHorizontal: t.space.pad, paddingBottom: 3,
      color: t.c.txPrimary,
    },
    // lineHeight 对齐右边那颗 40pt 的按钮，两端才在一条视觉基线上
    barTitle: {
      fontFamily: t.fonts.serif, fontSize: 24, lineHeight: 40,
      letterSpacing: -0.3, color: t.c.txPrimary, paddingLeft: 6,
    },
    listMeta: {
      paddingHorizontal: t.space.pad, paddingBottom: 4,
      fontSize: t.size.xs, color: t.c.txTertiary, fontFamily: t.fonts.sans,
    },
    hist: {
      textAlign: 'center', color: t.c.txTertiary, fontSize: 12,
      paddingHorizontal: t.space.pad, paddingTop: 6, paddingBottom: 10,
      fontFamily: t.fonts.sans,
    },
    skelRow: { flexDirection: 'row', gap: 8, paddingHorizontal: t.space.pad, paddingVertical: 10 },
    skelDot: {
      width: 7, height: 7, borderRadius: t.radius.full,
      backgroundColor: t.c.bdTertiary, marginTop: 8, marginLeft: 4,
    },
    skelA: { height: 11, width: '64%', borderRadius: 4, backgroundColor: t.c.bdTertiary, marginBottom: 8 },
    skelB: { height: 9, width: '36%', borderRadius: 4, backgroundColor: t.c.bdTertiary },
  });
