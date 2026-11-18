import { Easing } from 'react-native';

/**
 * 缓动曲线。三条，够用，别再现配。
 *
 * ## 为什么不用 `Easing.out(Easing.cubic)` 这类内置的
 *
 * RN 内置的那几条和 CSS 的 `ease-out` 一样软——收尾拖沓，在小控件上看起来
 * 像是「慢慢停下」而不是「到位了」。下面这三条是苹果自己在用的贝塞尔控制点，
 * 起步更果断、收尾更贴。
 *
 * ## 为什么没有 ease-in
 *
 * **UI 上不用 ease-in。** 它起步慢，而起步那一刻正是用户盯着看的一刻——点下去
 * 之后先纹丝不动几十毫秒，读起来就是卡顿。哪怕是「离场」也用 ease-out：
 * 先动起来，再收尾。Sheet 的关闭动画原来配的就是 `Easing.in(Easing.cubic)`，
 * 按「进来用 out、出去用 in」想当然配的，是错的。
 *
 * 这里没有 EASE_IN 这个导出，就是不给现配的机会。
 */

/** 默认。入场、离场、以及一切没有手指按着的状态变化。 */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** 屏幕内的位移与形变——两头都要收住，中间快。 */
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);

/** iOS 系统面板那条：起步快、收尾慢，最后一段几乎是贴上去的。 */
export const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1);

/**
 * 时长。超过 300ms 的界面动画会开始让人等——**导航转场除外**，那个要跟平台走
 * （iOS 的推进是 350ms），自己压短反而突兀。
 */
export const DUR = {
  /** 按下反馈。再长就跟不上手指了 */
  press: 120,
  /** 开关、药丸、小状态变化 */
  toggle: 180,
  /** 面板、模态、抽屉 */
  sheet: 280,
} as const;
