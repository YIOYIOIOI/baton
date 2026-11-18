import { useKeyboardState } from 'react-native-keyboard-controller';

/**
 * 键盘高度，给**布局**用。
 *
 * ## 跟着键盘走这件事，换了三次做法
 *
 *   1  `KeyboardAvoidingView behavior="padding"`
 *      —— padding 是布局属性，走不了原生驱动，每帧回 JS 算布局再过桥。
 *      owner：「键盘出现得比输入框快，并且输入框浮上来的帧率很低」。
 *
 *   2  自己听 `keyboardWillShow`，抄事件里的 duration / easing，用 `Animated`
 *      的 transform（原生驱动）复刻一条同样的动画。
 *      —— 比 1 好，但**它只是复刻**：动画的起点要等 JS 线程收到事件才开始，
 *      JS 一忙就晚。owner 再次实测「起来的速度还是比键盘慢」「帧率还是很低」。
 *
 *   3  **现在这版：`react-native-keyboard-controller`。**
 *      它不复刻，它在 **UI 线程直接跟住键盘的实际位置**，JS 全程不参与。
 *
 * 换它的依据不是我挑的：Reanimated 自己的 `useAnimatedKeyboard` 已经标了
 * `@deprecated`，注释里写着 "Please use `react-native-keyboard-controller`
 * instead"。而它**就在 Expo Go 自带的原生模块清单里**（bundledNativeModules
 * 锁 1.21.9），所以不用 development build。
 *
 * ## 位移不在这儿做了
 *
 * 输入框的抬升交给 `<KeyboardStickyView>`——那是它自带的组件，位移跑在 UI 线程，
 * 还能用 `offset` 指定「键盘打开时额外再抬多少」，正好用来留出输入框和键盘之间
 * 那道缝（owner：「他和键盘是贴在一起的，他们中间应该要有些间隔」）。
 *
 * 这里只剩一个数：**滚动区要靠它加出底部留白**，否则最后几条消息会被抬起来的
 * 输入框盖住。留白跳变是对的——聊天界面本来就吸在底部，内容跟着一起上移才自然。
 *
 * ## 根部要挂 `<KeyboardProvider>`
 *
 * 见 `app/_layout.tsx`。没有它这个 hook 永远返回 0，而且**不会报错**——
 * 表现成「输入框完全不动」，很容易查错方向。
 */

/**
 * @param safeBottom 底部安全区。**必须减掉**：键盘高度本身已经含了 Home 指示条
 *   那一段，而输入框的外边距里也留了同一段，不减就会在键盘上方多出一条空档
 *   （约 34pt，真机上很明显）。
 */
export function useKeyboardInset(safeBottom = 0): number {
  const height = useKeyboardState((s) => s.height);
  return height > 0 ? Math.max(0, height - safeBottom) : 0;
}

/**
 * 输入框和键盘之间**想要的视觉缝隙**，点。
 *
 * 10 是主流聊天输入区的紧凑间距规范：输入框紧贴键盘，
 * 只留一道很窄的缝。
 *
 * ## 别直接把它当 offset 传
 *
 * `KeyboardStickyView` 抬的是**整个键盘高度**，而输入框本来就预留了底部安全区
 * （Home 指示条那 34pt，见 Composer 的 `marginBottom: Math.max(10, inset.bottom)`）。
 * 键盘一上来那块被键盘盖住了，就变成凭空多出来的空档（未扣除安全区时会多出 34pt）。
 *
 * 所以 offset 要**先往下抵掉那块预留**，再往上留出这道缝：
 *
 *     opened = 输入框的底部外边距 − KEYBOARD_GAP
 *
 * 用 `keyboardStickyOffset()` 算，别手写。
 */
export const KEYBOARD_GAP = 10;

/**
 * 算 `<KeyboardStickyView offset={{ opened }}>` 该给多少。
 *
 * @param bottomMargin 被抬起那块**本来就有的底部外边距**。必须和它实际用的那个
 *   数一致——Composer 用的是 `Math.max(10, inset.bottom)`，所以这里也传同一个式子。
 */
export function keyboardStickyOffset(bottomMargin: number): { closed: number; opened: number } {
  // 正数 = 往下。先抵掉预留的那块，再往上留出 KEYBOARD_GAP
  return { closed: 0, opened: Math.max(0, bottomMargin - KEYBOARD_GAP) };
}
