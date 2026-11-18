import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme';
import * as haptics from '@/feedback/haptics';

/**
 * 分段控件。**内部就是系统那颗 `UISegmentedControl`。**
 *
 * ## 为什么最后是这样
 *
 * 之前这里是七百多行自己写的东西：手势、指数衰减投射、橡皮筋阻尼、攥住放大、
 * 移动中换成 clear 玻璃透镜，外加四段 SkSL 着色器去仿折射和色散。整套的目标
 * 只有一个——把 iOS 26 那颗「液态玻璃滑块」做出来。
 *
 * 做不出来。owner 一轮轮指出的差距（中间的字要清晰、轨道在玻璃底下要缩窄、
 * 边缘要有那圈描边、拖动时的回弹形变、字跟着轨道一起放大）逐条追下去，最后
 * 查到的事实是：
 *
 *   - 公开的 `UIGlassEffect` 一共只有三个旋钮：材质档、tintColor、isInteractive。
 *     折射强度、厚度、色散、「底下内容缩多少」**没有 API**。
 *   - tab bar 里那颗是**私有类** `_UILiquidLensView`，由 `_UIPortalView` +
 *     `CABackdropLayer` + 私有 `CAFilter`（含 `displacementMap`）组成。碰它有
 *     下架风险，而且点版本一升就断。
 *   - **那颗透镜不对任意视图开放，只有 tab bar 和分段控件有。**
 *
 * 最后那一条就是出路：用**真的分段控件**，效果是系统给的，不是仿的。
 * owner 在验证页上对完的原话：「我操，完全一样」。
 *
 * ## 三端都覆盖，不用我们自己兜底
 *
 * 这个包在 iOS 上走原生 `RNCSegmentedControl`；其它平台走它自带的 JS 实现
 * （那个文件的头注释写着 "iOS 13 Style UISegmentedControl Component for
 * Android and Web"，只依赖 Animated/View/StyleSheet，RN-Web 能跑）。
 * Baton 的日常入口是 PWA，这一条不能少。
 *
 * 它也在 Expo Go 自带的原生模块列表里（bundledNativeModules 锁 2.5.7），
 * 所以扫码就能看，不需要 development build。
 *
 * ## 一件它做不到的事：按住任意一格，滑块跑过来
 *
 * owner 对着 App Store 的底栏说：「我只要按住选项，那个玻璃胶囊就会自己唤起跑到
 * 我按下的地方」。我们这颗**做不到**，而且不是配置问题——是两种控件的手势模型
 * 本来就不同：
 *
 *   tab bar     按在条上任意位置，玻璃指示器被**吸到手指那儿**，滑动一路跟随。
 *               这就是俗称的 blob 行为，**来自私有 API**，第三方拿不到。
 *   分段控件    手势**锚在滑块本身**上：按住当前那颗可以拖着走，点别的格子
 *               只是一次离散的选择。
 *
 * 排查过程（别再重走一遍）：
 *   - 包装层无关 —— 顶栏那颗既没套我们的 Glass、也没有 transparent，一样不会
 *   - 原生桥无关 —— RNCSegmentedControl 就是 UISegmentedControl 的子类，
 *     只挂了一个 valueChanged，没有任何东西拦触摸
 *   - 受控组件那条已经修掉了（见下面 optimistic），修完顺手，但不是这一条的原因
 *
 * 要拿到那个行为只有一条路：用**真的 UITabBar**（react-native-bottom-tabs 之类）。
 * 代价是 **Expo Go 里没有任何原生 tab bar 包**，得改用 development build——
 * 现在扫码就能看的便利没了，每次动原生都要重装。这笔账由 owner 决定，别自作主张。
 *
 * ## 别再往这里加动画
 *
 * 位移、回弹、形变、玻璃全部由系统负责。这里再叠一层只会和它打架——
 * 这正是上一版失败的方式。`motion.test.ts` 里有一条把这件事钉住了。
 */

type Props<T extends string> = {
  items: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  /**
   * 轨道内宽，由调用方给。
   *
   * 不用 onLayout 自己量：那要先渲染一次拿到 0、再渲染一次拿到真值。
   * 而这个数本来就是确定的——App 锁竖屏（app.json 的 orientation: portrait），
   * 屏宽不变，两处调用方各自知道自己的边距，直接算即可。
   */
  width: number;
  /**
   * 控件高度。不传就用系统的固有高度。
   *
   * 底部那条要「大个」的观感（owner 对着 App Store 和 Telegram 的底栏说的），
   * 而系统分段控件的固有高度是照「设置页里的一行」定的，放在浮动 dock 上偏小。
   */
  height?: number;
  /**
   * 去掉控件自带的轨道底，让它坐在**外面那层玻璃**上。
   *
   * 底部那条要做成「一整条玻璃轨道 + 右边一颗按钮，靠近时粘连」（App Store 和
   * Telegram 都是这个样子）。粘连靠的是 `UIGlassContainerEffect`，而**它只合并
   * 玻璃元素**——系统分段控件不是玻璃，容器眼里只有一块东西，自然合不起来。
   * 所以轨道改由我们自己的 Glass 提供，控件本身让位。
   *
   * ⚠️ 代价未知：把底去掉之后，系统那颗滑块的玻璃还在不在，只能真机看。
   */
  transparent?: boolean;
};

export function Segmented<T extends string>({
  items, value, onChange, width, height, transparent,
}: Props<T>) {
  const t = useTheme();
  const index = Math.max(0, items.findIndex(([v]) => v === value));

  /**
   * **乐观地先动，再等外面回填。**
   *
   * 这颗控件按下的那一刻，系统自己就会把滑块送到手指底下——那是它内建的行为
   * （owner 对着 App Store 的底栏说的：「我只要按住选项，那个玻璃胶囊就会自己
   * 跑到我按下的地方」）。
   *
   * 但我们把它写成了**受控**组件：`selectedIndex` 来自外面的 state。底部那条
   * 更要命——它得先 `navigate`、等导航状态变了、重渲染才回填。这一圈跑完之前，
   * React 会拿**旧的** index 再渲染一次，把系统刚送过去的滑块按回原位，
   * 于是看起来就是「不跟手」。
   *
   * 所以这里自己记一份：按下立刻更新，外面回填后再对齐。外面若拒绝了这次切换
   * （比如 PageDock 里 `next === page` 直接 return），下面那个 effect 会把它拉回去。
   */
  const [optimistic, setOptimistic] = useState(index);
  useEffect(() => setOptimistic(index), [index]);

  return (
    <View style={[styles.wrap, { width }, height === undefined ? null : { height }]}>
      <SegmentedControl
        values={items.map(([, label]) => label)}
        selectedIndex={optimistic}
        onChange={(e) => {
          const i = e.nativeEvent.selectedSegmentIndex;
          setOptimistic(i);
          const next = items[i];
          // 「值变了」是 selection 触感的典型场合；点回当前那一段不震
          if (next && next[0] !== value) { haptics.select(); onChange(next[0]); }
        }}
        // 跟着 App 自己的深浅走，不让系统按环境光猜——Baton 的调色板是暖米白，
        // 系统判断出来的冷色调会和它打架（和 Glass 那边同一个理由）
        appearance={t.isDark ? 'dark' : 'light'}
        {...(transparent ? { backgroundColor: 'transparent' } : {})}
        fontStyle={{ color: t.c.txSecondary, fontFamily: t.fonts.sans }}
        activeFontStyle={{
          color: t.c.txPrimary,
          fontFamily: t.fonts.sans,
          fontWeight: t.weight.bold,
        }}
        style={height === undefined ? undefined : { height }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // 不裁剪：选中那颗在拖动时会**鼓出控件边界**（这是系统行为，见抬头）。
  // 祖先上任何 overflow:hidden 都会把鼓出去的那部分切掉。
  wrap: { overflow: 'visible' },
});
