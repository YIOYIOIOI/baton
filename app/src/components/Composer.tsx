import { createElement, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, ScrollView, StyleSheet, TextInput, useWindowDimensions, View,
  type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import { IconPlus, IconStop, IconUp } from '@/icons';
import { PillSelect, Tappable } from './ui';
import { Glass } from './Glass';
import * as haptics from '@/feedback/haptics';

/**
 * 去掉浏览器给聚焦输入框画的那圈蓝框。
 *
 * RN-Web 把 TextInput 渲染成真的表单元素，于是聚焦时带上系统 focus ring——
 * owner 在 iOS 网页端截图指出来的「多了这个蓝框」就是它，原生端没有。
 *
 * 去掉它在这儿不损失可达性：**整个输入区本身就是焦点的视觉标识**（键盘起来、
 * 光标在闪），而这是个触摸优先的聊天框，不存在「看不出焦点在哪个字段」的问题。
 *
 * 单独拆出来再收窄，是因为 `outlineStyle` 是 **RN-Web 独有**的，RN 的 TextStyle
 * 类型里没有它；原生端读不到这个键，写了也是空转。
 */
const NO_OUTLINE = { outlineStyle: 'none' } as unknown as TextStyle;

/**
 * 触摸目标的下限。**两个平台不是同一个数**。
 *
 * iOS 44pt、Android 48dp。上一版为了修「点加号却打中旁边的模型配置」把两边
 * 统一成了 44——在 Android 上那就是 44dp，仍然低于下限，而出问题的那台正是
 * 安卓平板。ui-ux-pro-max 那份清单把「一个数跨平台通用」直接列为反模式
 * （pro-rules.md §Icons & Visual Elements、§Interaction，两处都写了）。
 *
 * 只撑**盒子**，不动图标：这几颗按钮的视觉分量是调过的（发送重、传文件轻），
 * 真画大就把那个关系破坏了。
 */
const TOUCH_MIN = Platform.OS === 'android' ? 48 : 44;

/**
 * 输入区。**停止 ≠ 打断——两个动作都要**（桌面端的约定）：
 *
 *   点停止      放弃当前方向
 *   直接打字发  不停止地纠偏（排在这轮之后发出）
 *
 * 后者更常用，所以它占主位（深色圆键），停止退成灰色幽灵键。
 * 选择器是输入框里的浅色药丸——截图里的 "Sonnet 5 Medium" 就长这样。
 */
export function Composer({
  value, onChange, onSend, onStop, onAttach, onFiles, sending, running, disabled, attaching,
  placeholder, left, pills, above, hasAttachments, onCaret, selection,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** 不传就保持原来那颗灰着的加号（新建会话那屏还没有会话可传） */
  /**
   * 点了加号。参数是加号在**屏幕坐标**里的中心位置，给那张菜单卡片定位用——
   * 它要贴着加号弹出并从那儿"长"出来（照 ChatGPT）。量不到时给 null。
   */
  onAttach?: (anchor: { x: number; y: number } | null) => void;
  /**
   * **只在网页端用得上。** 加号底下那个真 `<input type="file">` 选完之后，
   * 文件直接从这儿交出来——不经过任何选择器（理由见加号那段注释）。
   * 不传就不画那个 input，加号退回纯原生行为。
   */
  onFiles?: (files: File[]) => void;
  sending?: boolean;
  running?: boolean;
  disabled?: boolean;
  attaching?: boolean;
  placeholder: string;
  left?: React.ReactNode;
  pills?: React.ReactNode;
  /** 输入框**上方**的附件缩略图条 */
  above?: React.ReactNode;
  /** 有附件时即使正文为空也能发——「看看这张图」正文本来就是空的 */
  hasAttachments?: boolean;
  /** 光标挪了（`/` 菜单看的是光标所在那个词）。2026-11-11 */
  onCaret?: (pos: number) => void;
  /** 要把光标放到哪儿（`/` 菜单插入之后）。用一次就由调用方清掉 */
  selection?: { start: number; end: number };
}) {
  const t = useTheme();
  const s = cp(t);
  // 底部避开 Home 指示条，否则最后一行按钮会被上滑手势区盖住
  const inset = useSafeAreaInsets();
  const [focused, setFocused] = useState(false);
  // 量加号的位置用。collapsable={false} 不能省：RN 会把没有样式的纯容器 View
  // 在原生层折叠掉，折叠掉的节点 measureInWindow 拿不到东西
  const plusRef = useRef<View>(null);

  /**
   * 输入框长到多高就开始内部滚动。
   *
   * 原来写死 88pt——按行高 23 算只有 **3.5 行**。owner 写一条七八点的清单时
   * 直接卡住了：「对话框那里滚不下去，我说的是对话框里面的」。3.5 行的窗口里
   * 既看不全上下文，挪动也全靠精确的小幅滑动，很容易让人以为是滚不动。
   *
   * 改成跟着屏高走，照 ChatGPT 量的——它的输入框能长到三分之一屏左右。
   * 仍然要有上限：占满整屏就把对话挤没了，而人需要看见自己在回复什么。
   */
  const inputMax = Math.max(88, Math.round(useWindowDimensions().height * 0.3));
  const canSend = (!!value.trim() || !!hasAttachments) && !sending && !disabled;

  const onKeyPress = Platform.OS === 'web'
    ? (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const ev = e.nativeEvent as TextInputKeyPressEventData & {
        metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean;
      };
      if (ev.isComposing || ev.keyCode === 229 || ev.repeat) return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        e.preventDefault();
        if (canSend) onSend();
      }
    }
    : undefined;

  return (
    // max 而不是加法：inset.bottom 本身就是「避开 Home 指示条所需的余量」，
    // 再加 10 是重复计算——真机上变成 44pt 的空档，看着就是底部一大片空白。
    // 没有指示条的机型 inset 为 0，这时才用 10 兜底。
    <View style={s.outer} pointerEvents="box-none">
    <Glass
      radius={26}
      style={[
        s.composer,
        focused && s.composerFocus,
        { marginBottom: Math.max(10, inset.bottom) },
      ]}
    >
      {above}
      <TextInput
        style={[s.input, NO_OUTLINE, { maxHeight: inputMax }, disabled && { color: t.c.txTertiary }]}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyPress={onKeyPress}
        onSelectionChange={onCaret ? (e) => onCaret(e.nativeEvent.selection.start) : undefined}
        selection={selection}
        placeholder={placeholder}
        placeholderTextColor={t.c.txTertiary}
        editable={!disabled}
        multiline
        // multiline 在 iOS 上默认就能内部滚动，这里写出来是**声明意图**：
        // 上面那个 maxHeight 是"到这儿就开始滚"，不是"到这儿就没了"
        scrollEnabled
        accessibilityLabel="消息输入框"
      />
      <View style={s.row}>
        {/*
          **没有地方可传就不画这颗加号，而不是画一颗永远按不动的灰加号。**

          新建会话那一屏两个回调都不传（还没有会话，文件没处落），于是这颗加号
          在那儿是死的。原来它照画不误、只是变灰——owner 的朋友第一次用就卡在
          这里：她是新访客，工作区是空的，**唯一能进的就是新建会话那一屏**，
          看到的就是一颗灰加号，点了当然没反应。owner 自己从来碰不到，因为他
          永远有会话可以打开。

          一个在这一屏上永远不可能变成可用的控件，不该出现在这一屏上。
          网页那套（web/dist）本来就是这么做的，这里跟它对齐。
        */}
        {onAttach || onFiles ? (
        <View ref={plusRef} collapsable={false} style={s.plusWrap}>
        <Tappable
          style={s.ghost}
          /**
           * 把加号在**屏幕坐标**里的位置量出来交上去：那张菜单卡片要贴着它弹出、
           * 并且从它那儿"长"出来（照 ChatGPT 的做法）。
           *
           * 量在按下这一刻，不提前量：输入框会随字数长高、附件出现时还会再长一截，
           * 提前量到的值到点开时早就过期了。
           */
          onPress={() => {
            /**
             * **web 上不要量、直接交出去。**
             *
             * 两个原因，第二个是硬的：
             *   1  网页端根本不弹我们那张卡片（系统自己会问，见调用方）
             *   2  `measureInWindow` 的回调是**异步**的，而 web 上打开选择器靠的是
             *      在用户手势里派发合成点击——绕一趟原生回调就出了激活窗口，
             *      选择器不会开，而它的 promise 也永远不 resolve
             */
            // web 上加号底下压着一个真 input（见下），按下这件事归它管
            if (Platform.OS === 'web') return;
            const node = plusRef.current;
            if (!node) { onAttach?.(null); return; }
            node.measureInWindow((x, y, w, h) => {
              onAttach?.({ x, y: y + h / 2 });
            });
          }}
          haptic={haptics.tap}
          disabled={!onAttach || disabled || attaching}
          accessibilityRole="button"
          accessibilityLabel="传个文件"
        >
          {attaching
            ? <ActivityIndicator size="small" color={t.c.txTertiary} />
            : <IconPlus size={19} color={onAttach && !disabled ? t.c.txSecondary : t.c.txTertiary} />}
        </Tappable>
        {/*
          **网页端：手指真正落到的是这个 input，不是上面那颗加号。**

          原来网页端走 expo 的选择器，而它的实现是「建一个 display:none 的 input，
          再 dispatchEvent(new MouseEvent('click'))」。那条路同时押注两件事：
          浏览器认合成点击、而且认一个**没渲染**的 input；还得赶在用户手势的
          激活窗口里。iOS 上已经因为最后一条咬过一次（绕一趟异步原生回调就出窗口，
          选择器不开、promise 也永远不 resolve，界面上就是「点了没反应」）。

          **要说清楚：这不是 owner 的朋友那次的原因。** 她在 /diag.html 上实测过，
          她那台华为平板（HuaweiBrowser / Chrome 114）对合成点击是认的。那次的
          真正原因是新建会话屏上这颗加号压根没接回调（见上面那段）。这里改成真
          input 是顺手把那三个押注一起去掉——它们迟早还会咬人，而且失败时是静默的。

          用 createElement 而不是 JSX：这个文件同时要被原生端编译，
          直接写 <input> 在 RN 的 JSX 类型里不成立。
        */}
        {Platform.OS === 'web' && onFiles ? createElement('input', {
          type: 'file',
          multiple: true,
          'aria-label': '传个文件',
          disabled: disabled || attaching,
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // opacity 而不是 display/visibility：后两者会让它退出命中测试，
            // 那就又回到了「手指点不到真控件」这个原点
            opacity: 0,
            // 压掉浏览器自带的「未选择文件」那行字，它会把盒子撑开
            fontSize: 0,
            cursor: disabled || attaching ? 'default' : 'pointer',
          },
          onChange: (e: { target: { files: FileList | null; value: string } }) => {
            const files = Array.from(e.target.files ?? []);
            // 先清空再交出去：不清的话连续选同一个文件第二次不触发 change
            e.target.value = '';
            if (files.length) onFiles(files);
          },
        }) : null}
        </View>
        ) : null}
        {left}
        {/*
          药丸横向滚动，而不是互相挤压。
          新会话那屏有三颗（agent / 模型 / 目录），402pt 宽下直接排会把目录那颗
          压到 35pt——实测过，完全读不出来。让它们各自保持自然宽度、超出就滑，
          比压扁任何一颗都强。会话屏只有一颗，这层包装不影响它。
        */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={s.pills}
          contentContainerStyle={s.pillsInner}
        >
          {pills}
        </ScrollView>

        {running && onStop ? (
          <>
            <Tappable
              style={[s.ghost, { marginLeft: 'auto' }]}
              onPress={onStop}
              // 比发送重一档：停止是在放弃已经跑了一半的东西，手感上要有分量
              haptic={haptics.thud}
              accessibilityRole="button"
              accessibilityLabel="停止这一轮"
            >
              <IconStop size={19} color={t.c.txSecondary} />
            </Tappable>
            <SendBtn on={canSend} sending={sending} onPress={onSend} />
          </>
        ) : (
          <View style={{ marginLeft: 'auto' }}>
            <SendBtn on={canSend} sending={sending} onPress={onSend} />
          </View>
        )}
      </View>
    </Glass>
    </View>
  );
}

function SendBtn({ on, sending, onPress }: { on: boolean; sending?: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = cp(t);
  return (
    // 原来是个静态样式数组：整个 App 最常按的一颗键，按下去屏幕上什么都不动。
    // 发送还要等网络，那段空白里人只会以为没点到，然后连点。
    /*
      命中盒和那颗圆是**两层**：外层透明、撑到平台下限，里层还是 36 的深色圆。
      发送键的分量是调过的，把圆真画大就把「发送重、传文件轻」那个关系破坏了；
      而 36 低于 iOS 44 / Android 48 两条线（见 TOUCH_MIN 抬头）。
    */
    <Tappable
      style={s.sendHit}
      onPress={onPress}
      haptic={haptics.tap}
      disabled={!on}
      accessibilityRole="button"
      accessibilityLabel="发送"
    >
      <View style={[s.dark, !on && { backgroundColor: t.c.bdTertiary }]} pointerEvents="none">
        {sending
          ? <ActivityIndicator size="small" color={on ? t.c.txInverse : t.c.txTertiary} />
          : <IconUp size={16} color={on ? t.c.txInverse : t.c.txTertiary} />}
      </View>
    </Tappable>
  );
}

export { PillSelect };

const cp = (t: Theme) =>
  StyleSheet.create({
    outer: {
      width: '100%',
      maxWidth: t.layout.contentMaxW,
      alignSelf: 'center',
    },
    // 底色交给 Glass；输入区浮在会话流之上，用玻璃才有层次
    composer: {
      marginHorizontal: 12, marginBottom: 10, borderRadius: 26,
      paddingHorizontal: 14, paddingTop: 12, paddingBottom: 9,
      ...(Platform.OS === 'web'
        ? ({
          transitionProperty: 'border-color, box-shadow',
          transitionDuration: '160ms',
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        } as unknown as ViewStyle)
        : null),
    },
    composerFocus: {
      borderColor: t.isDark ? 'rgba(92,130,255,0.48)' : 'rgba(36,85,255,0.32)',
      ...(Platform.OS === 'web'
        ? ({
          boxShadow: t.isDark
            ? '0 10px 30px -8px rgba(0,0,0,0.68), 0 0 0 3px rgba(92,130,255,0.16), inset 0 1px 0 rgba(255,255,255,0.12)'
            : '0 8px 26px -6px rgba(22,22,28,0.13), 0 0 0 3px rgba(36,85,255,0.10), inset 0 1px 0 rgba(255,255,255,0.95)',
        } as unknown as ViewStyle)
        : null),
    },
    input: {
      // maxHeight 在组件里按屏高算，见 inputMax
      width: '100%', paddingHorizontal: 2, paddingBottom: 8,
      fontSize: t.size.md, lineHeight: 23, color: t.c.txPrimary, fontFamily: t.fonts.sans,
    },
    /**
     * 12 而不是 8：加号右边紧挨着的是「配置」那颗药丸，而两者体量差得很远
     * （加号 44、药丸一百多宽）。手指落点一偏，命中修正就会挑中大的那个——
     * 表现出来是「点加号没反应，弹出来的是模型配置」。
     */
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    // flexShrink 让它把多余空间让给发送键，而不是把发送键挤出去
    pills: { flexGrow: 0, flexShrink: 1 },
    pillsInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    /**
     * 44 是 iOS/Android 两边都认的触摸下限，原来是 34。
     *
     * 背景是透明的、图标还是 19——**看上去一个像素都没变**，变大的只是那个
     * 吃手指的盒子。原生上本来可以用 hitSlop 来撑，但 react-native-web 的
     * Pressable **根本没实现 hitSlop**（只有老的 Touchable 有），网页端一写
     * 就是白写，所以只能把盒子本身做大。
     */
    // 网页端那个真 input 是 absolute 铺在这上面的，得有个定位上下文
    plusWrap: { position: 'relative' },
    ghost: {
      width: TOUCH_MIN, height: TOUCH_MIN, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    // 透明命中盒，只管吃手指；画出来的是里面那颗 dark 圆
    sendHit: {
      width: TOUCH_MIN, height: TOUCH_MIN, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center',
    },
    dark: {
      width: 36, height: 36, borderRadius: t.radius.full,
      backgroundColor: t.c.bgInverse, alignItems: 'center', justifyContent: 'center',
    },
  });
