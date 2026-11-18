import { Children, useEffect, useState } from 'react';
import {
  AccessibilityInfo, Platform, View,
  type StyleProp, type ViewProps, type ViewStyle,
} from 'react-native';
import { useTheme } from '@/theme';

/**
 * 毛玻璃。一个组件，三条实现路径。
 *
 * **为什么不能直接用 expo-glass-effect 了事**：它是 iOS 26+ 的原生 API，
 * 官方文档明写「will fallback to regular View on unsupported platforms」，
 * 而 Baton 的日常入口是 PWA（Safari 加到主屏）——在那儿它就是个普通 View，
 * 等于什么都没做。所以：
 *
 *   原生 + iOS 26+   用 Apple 官方的 GlassView（真正的 Liquid Glass：
 *                    折射、随背景流动、高光边缘。CSS 模仿不出来）
 *   网页            用 CSS backdrop-filter: blur + saturate。Safari 支持，
 *                    需要 -webkit- 前缀；观感接近但不是同一样东西
 *   其余            半透明底色兜底。**绝不留全透明**——底下是滚动内容，
 *                    没有底色的话文字会和内容糊在一起，那比没有玻璃糟得多
 *
 * 原生那条是动态 require：web 打包时不该把原生模块拖进 bundle。
 *
 * ## 按 Apple HIG 的三条硬规矩
 *
 * 1. **玻璃只属于功能层**：导航、工具栏、底部附件、浮动按钮、sheet。
 *    列表行、卡片、消息气泡、滚动内容一律不上玻璃——那是内容层。
 * 2. **不叠玻璃**。玻璃上的元素用实色填充/透明度表达，不能再套一层玻璃，
 *    否则每一层都在抢注意力。
 * 3. **不跟系统对着干**。Liquid Glass 自带高光边和景深，原生路径上再叠
 *    自绘 borderWidth + shadow 是错的；那两样只在网页/兜底路径上补。
 */

type GlassModule = {
  GlassView?: React.ComponentType<Record<string, unknown>>;
  GlassContainer?: React.ComponentType<Record<string, unknown>>;
  isLiquidGlassAvailable?: () => boolean;
  isGlassEffectAPIAvailable?: () => boolean;
};

/**
 * 能力判定分两层，缺一不可：
 *   isGlassEffectAPIAvailable()  运行时有没有这套 API（iOS 26+）
 *   isLiquidGlassAvailable()     这台设备上玻璃组件到底能不能用
 * 文档特别注明后者**在用户开了限制玻璃的无障碍设置时仍可能为 true**，
 * 所以它不能代替下面那个 Reduce Transparency 的运行时判断。
 */
let mod: GlassModule | null = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 懒加载：原生模块可能不存在
    const m = require('expo-glass-effect') as GlassModule;
    const api = m.isGlassEffectAPIAvailable?.() ?? false;
    const live = m.isLiquidGlassAvailable?.() ?? false;
    if (m.GlassView && api && live) mod = m;
  } catch {
    // 没装或跑在不支持的系统上——走下面的兜底
  }
}

export type GlassPath = 'native' | 'web' | 'opaque';

/**
 * 材质档位。和 expo-glass-effect 的 `GlassStyle` 一一对应，原生那边映射到
 * `UIGlassEffect.Style`（none → nil → 空效果）。照抄它的取值而不是自己定一套，
 * 是为了不在中间多一层需要维护的翻译。
 */
export type GlassVariant = 'clear' | 'regular' | 'none';

/**
 * 走哪条路。抽成纯函数是为了能测——三条分支的取舍都有代价，
 * 而其中两条（web 与兜底）在真机上根本走不到，只能靠单测把它们钉住。
 *
 * 顺序有讲究：**降低透明度优先于一切**。用户在系统里明确表达了「别给我半透明」，
 * 这时退到 web 的 backdrop-filter 也是违背——所以直接落到不透明那条。
 */
export function glassPath(
  { web, module: hasModule, reduceTransparency }:
  { web: boolean; module: boolean; reduceTransparency: boolean },
): GlassPath {
  if (reduceTransparency) return 'opaque';
  if (hasModule && !web) return 'native';
  return web ? 'web' : 'opaque';
}

/**
 * 「降低透明度」开着吗。
 *
 * 必须是订阅而不是一次性读取：用户可以在 App 跑着的时候去系统设置里拨这个开关，
 * 回来时界面要立刻跟上。HIG 把它列为必测项。
 */
function useReduceTransparency(): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      // 网页上的对应物是这条媒体查询（Safari 17+）。用户在系统里表达的是
      // 同一个意思，没道理只在原生端听。
      const mq = globalThis.matchMedia?.('(prefers-reduced-transparency: reduce)');
      if (!mq) return undefined;
      setOn(mq.matches);
      const onChange = (e: MediaQueryListEvent) => setOn(e.matches);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => { if (alive) setOn(v); })
      .catch(() => { /* 读不到就按没开处理，玻璃总比空白强 */ });
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setOn);
    return () => { alive = false; sub.remove(); };
  }, []);

  return on;
}

/** 此刻走哪条路。组件与调用方都问这一个，保证 glassPath() 不是一份影子逻辑。 */
export function useGlassPath(): GlassPath {
  const reduceTransparency = useReduceTransparency();
  return glassPath({ web: Platform.OS === 'web', module: mod !== null, reduceTransparency });
}

/**
 * 此刻**真的**在用原生液态玻璃吗。
 *
 * 调用方要据此决定结构，不只是配色：比如浮动按钮组在有玻璃时是几颗各自独立、
 * 靠近会融合的胶囊，没玻璃时退回一整颗药丸——两者的结构不同。
 */
export function useNativeGlass(): boolean {
  return useGlassPath() === 'native';
}

/**
 * 透传 ViewProps：玻璃常常就是布局容器本身（底部操作条要量高度、浮动栏要
 * pointerEvents），没有透传就得在外面再套一层 View，白白多一级。
 * GlassView 与 GlassContainer 官方都写明「Inherits all ViewProps」。
 */
type Props = ViewProps & {
  /**
   * 圆角要传进来——玻璃层自己要画，不能靠父级 overflow。
   *
   * **不传**表示「圆角完全由 style 决定」。这个区别不是洁癖：传 0 时会落下一句
   * `borderRadius: 0`，而 RN Web 把它编成 `border-radius: 0`（四角），排在
   * style 里的 `borderTopLeftRadius: 24` 之后，把上两角**盖掉**——sheet 的
   * 圆角就这么没的（浏览器实测）。
   */
  radius?: number;
  /** 深色玻璃（深色药丸、底部主按钮） */
  dark?: boolean;
  /**
   * 材质档位。**默认磨砂**，clear 是唯一一处的例外。
   *
   *   regular  **磨砂**：把背景糊掉，自适应保证前景永远读得清
   *   clear    **折射**：几乎不糊，透过去的东西被这块「透镜」压缩、推挤
   *
   * 上一版把默认设成了 clear，理由是 owner 说过「你用的是磨砂玻璃不是透明玻璃，
   * 背后的组件没有被缩小」。错在把一句关于**滑块**的反馈套到了每一块玻璃上。
   * 他拿真机截图指出来的：「框的部分是透明玻璃，胶囊是磨砂，你搞反了」——
   * 确实反了，而且轨道和滑块两处都反。
   *
   * 反过来之后规则很干净：
   *
   *   容器用 regular   顶栏、输入条、sheet、浮动按钮、分段控件的轨道。
   *                    它们浮在**任意内容**之上，磨砂是唯一能保证「不管底下是
   *                    什么都读得清、都看得出这儿有个控件」的档位。
   *   透镜用 clear     只有分段控件里那颗会动的滑块。它底下是**已经磨砂过的
   *                    轨道**——有一块确定的面可以折射，压缩推挤才看得出来。
   *
   * 反过来不成立：clear **在没东西可折射的地方等于隐形**。页底换成纯白之后这点被
   * 放大了，截图里那颗「+ 新会话」连胶囊都没有，只剩两个字浮在列表上。
   * HIG 的排序也是这个：regular 覆盖约 95% 的场景，clear 留给富媒体背景之上。
   *
   * `none` 是**没有材质**——原生那边映射到 `UIVisualEffect()`（空效果），
   * 也就是一块什么都不做的透明视图。它用来做「平时不是玻璃、交互时才是」，
   * 换档**不走系统动画**：见 Segmented 抬头「为什么不用 animate」。
   */
  variant?: GlassVariant;
  /**
   * 这块玻璃本身可点。开了之后 Apple 的材质会随触摸形变、高光跟着手指走——
   * 这是 iOS 26 上「玻璃是活的」那种手感的来源，静态玻璃没有。
   */
  interactive?: boolean;
  /**
   * 让这块玻璃**退后一点**：色调减到四成多。
   *
   * 色调是压在模糊之上的一层颜色，它越重这块就越像一块奶白的板子。owner 说
   * 分段控件的轨道「玻璃感要减弱」——指的正是那种板子感，不是要它变透明。
   * 减色调而不换档：换成 clear 会让轨道在内容上化掉，那是另一个被否过的方向。
   */
  subtle?: boolean;
  /**
   * 换档时让系统做「材质化／去材质化」那段动画，毫秒。不传 = 立刻换。
   *
   * 这是**唯一**能让玻璃淡入淡出的办法：给 UIVisualEffectView 加透明度不会让
   * 材质变淡，只会让它整个不渲染（苹果 WWDC25 284：always set the `effect`
   * property rather than `alpha`）。配合 `variant="none"` 用。
   */
  materializeMs?: number;
};

/**
 * 网页玻璃的底色。
 *
 * 四种组合，不是两种：`dark`（这块玻璃本身是深色药丸）与 `isDark`（整个 App
 * 在深色模式）互相独立。深色模式下的**浅色**玻璃仍然要偏暗——它是「亮一档的
 * 深色」，不是白色。
 *
 * 透明度取 0.62/0.72：再低会透出底下的字，再高就看不出是玻璃了。
 */
export function webTint(
  dark: boolean, isDark: boolean, variant: GlassVariant = 'regular',
): string {
  if (variant === 'none') return 'transparent';
  if (dark) return isDark ? 'rgba(242,240,234,0.80)' : 'rgba(34,33,31,0.72)';
  // clear 档退到 0.34：它要的是「透得过去」，遮得越少越接近折射那种观感
  if (variant === 'clear') return isDark ? 'rgba(46,46,51,0.38)' : 'rgba(255,255,255,0.34)';
  return isDark ? 'rgba(46,46,51,0.66)' : 'rgba(255,255,255,0.62)';
}

/** 网页端三档的模糊量。clear 只糊一点点，形状还认得出；none 就是不糊。 */
const WEB_FILTER = {
  none: 'none',
  clear: 'blur(6px) saturate(180%)',
  regular: 'blur(22px) saturate(180%)',
} as const;

/**
 * 原生玻璃的品牌色调。比网页那份淡得多——Liquid Glass 自己已经在做折射与自适应，
 * 这层只是把它往 Baton 的暖米白/墨色上拽一点，给多了会盖掉材质本身。
 */
export function nativeTint(dark: boolean, isDark: boolean): string {
  if (dark) return isDark ? 'rgba(242,240,234,0.45)' : 'rgba(34,33,31,0.55)';
  return isDark ? 'rgba(35,35,39,0.35)' : 'rgba(245,242,235,0.35)';
}

/** 把一个 rgba() 字符串的 alpha 乘上一个系数。其余通道原样留着。 */
function fade(rgba: string, k: number): string {
  const m = /^rgba\(([^)]+)\)$/.exec(rgba);
  if (!m) return rgba;
  const parts = m[1].split(',').map((x) => x.trim());
  if (parts.length !== 4) return rgba;
  parts[3] = String(Math.round(Number(parts[3]) * k * 100) / 100);
  return `rgba(${parts.join(',')})`;
}

/** subtle 档的系数。0.45——够让板子感退下去，又不至于把轨道整个抹平。 */
const SUBTLE = 0.45;

export function Glass({
  children, style, radius, dark = false, interactive = false,
  variant = 'regular', subtle = false, materializeMs, ...rest
}: Props) {
  const t = useTheme();
  const path = useGlassPath();

  if (path === 'native' && mod?.GlassView) {
    const GlassView = mod.GlassView;
    return (
      <GlassView
        {...rest}
        /**
         * 要让玻璃「出现／消失」，**只能换 effect，不能动 alpha**。
         *
         * 苹果在 WWDC25 284 里明说：always set the `effect` property rather than
         * `alpha`。给 UIVisualEffectView（或它的祖先）加透明度，材质不会跟着淡，
         * 而是**直接不渲染**——owner 实测「B4/B5 会直接消失，不是变成玻璃」就是
         * 这么来的。
         *
         * expo-glass-effect 的配置对象正好走的是那条路：它把换 effect 的动作包在
         * `UIView.animate` 里（GlassView.swift 的 applyGlassStyle），
         * `style: 'none'` 换成一个空的 UIVisualEffect。
         */
        glassEffectStyle={materializeMs === undefined
          ? variant
          : { style: variant, animate: true, animationDuration: materializeMs / 1000 }}
        isInteractive={interactive}
        // 跟着 App 自己的深浅走，不让系统猜：Baton 的调色板是暖米白，
        // 系统按环境光判断出来的冷色调会和它打架
        colorScheme={t.isDark ? 'dark' : 'light'}
        /**
         * **浅色玻璃一律不上色调。**
         *
         * 原来这里给 regular 档抹了一层 `nativeTint`（浅色下是
         * rgba(245,242,235,0.35) 的暖米白），想把材质往品牌色上拽一点。
         * owner 实测：「视觉上我看上去你的底栏和 iOS 原生的那种玻璃好像也有区别」
         * ——差别就是这层暖色。苹果的玻璃是**不上色**的。
         *
         * 这也和这个文件抬头第 3 条自相矛盾：「不跟系统对着干」。抹一层品牌色
         * 正是在跟它对着干，而 Liquid Glass 本来就在做自适应，多抹一层只会让它
         * 和系统控件（分段控件、tab bar）摆在一起时显得脏。
         *
         * **深色药丸是唯一例外**：它靠这层色调才压得住，否则在白底上整个没有。
         */
        tintColor={dark ? fade(nativeTint(dark, t.isDark), subtle ? SUBTLE : 1) : undefined}
        // 这里**没有** border、**没有** shadow、也**没有** overflow:hidden。
        //
        // 前两个是因为材质自带高光边与景深，再叠一层是 HIG 点名的「跟系统对着干」。
        // overflow:hidden 是 owner 实测抓到的：按住玻璃按钮拖拽时，形变「被一个框
        // 框住了」——interactive 的形变会**鼓出视图边界**，而 overflow:hidden
        // 正好把鼓出去的那部分裁掉。Apple 论坛有同一个问题（FB19801519），
        // 官方建议就是别在祖先上裁剪、并给玻璃周围留出余量。
        // iOS 的圆角是**连续曲率**（squircle）。默认那档在大半径上明显更「方」，
        // owner 说放大后的胶囊「太方了」，圆润有一半是它。
        // GlassView 会把自己的 layer.cornerCurve 同步成这一层的（setBorderCurve）
        style={[
          { borderCurve: 'continuous' as const },
          radius === undefined ? null : { borderRadius: radius },
          style,
        ]}
      >
        {children}
      </GlassView>
    );
  }

  if (path === 'web') {
    return (
      <View
        {...rest}
        style={[
          {
            borderRadius: radius,
            // saturate 是关键：只 blur 会得到一片灰糊，加饱和度才有「透过玻璃
            // 看到底下颜色」的感觉。这是 Apple 自己材质的一贯做法。
            //
            // 网页端做不出折射——CSS 没有这个能力。clear 档只能靠**少糊、少遮**
            // 去靠近：模糊从 22px 降到 6px、底色透明度降一档，透过去的东西
            // 还认得出形状。这是近似，不是同一样东西。
            backdropFilter: WEB_FILTER[variant],
            WebkitBackdropFilter: WEB_FILTER[variant],
            // 底色必须跟着深浅走。写死白的话，深色模式下这块玻璃是一片**亮**板
            // 压在暗页面上——浏览器实测过，底部操作条整条发白，完全不像浮着。
            backgroundColor: fade(webTint(dark, t.isDark, variant), subtle ? SUBTLE : 1),
          } as ViewStyle,
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  // 兜底：不透明度调高一点，因为没有模糊来分离前后景。
  // 「降低透明度」开着时也走这条——那正是用户要的：看得清，不要材质。
  const fill = variant === 'none'
    ? 'transparent'                       // 没有材质就是没有材质，兜底也不该凭空长出一块底
    : (dark ? t.c.bgInverse : t.c.bgPrimary);
  return (
    <View
      {...rest}
      style={[
        { borderRadius: radius, backgroundColor: fill },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * 把几块玻璃并成一组，靠近时它们会**流动着融合**成一块。
 *
 * 这是 Liquid Glass 最标志性的行为，也是「确实采用了 iOS 26」与「只是加了层模糊」
 * 的分水岭。Apple 自己的工具栏就是这么做的：每个按钮是一颗独立胶囊，彼此靠近时
 * 连成一条，转场时再分开。
 *
 * spacing 控制多近才融合。没有原生玻璃时退化成一个普通的布局容器——
 * 子元素各自的兜底底色会让它看起来就是今天这样，网页端观感不变。
 */
export function GlassGroup({
  children, spacing = 14, style,
}: { children: React.ReactNode; spacing?: number; style?: StyleProp<ViewStyle> }) {
  const native = useNativeGlass();
  if (native && mod?.GlassContainer) {
    const GlassContainer = mod.GlassContainer;
    return <GlassContainer spacing={spacing} style={style}>{children}</GlassContainer>;
  }
  return <View style={style}>{children}</View>;
}

/**
 * 把每个子元素各自裹成一颗玻璃胶囊，整体放进一个会融合的组里。
 *
 * 给「一排小按钮」用。没有原生玻璃时由调用方决定退回什么结构——
 * 这个函数只负责有玻璃的那条路。
 */
export function glassCapsules(
  children: React.ReactNode,
  style: StyleProp<ViewStyle>,
): React.ReactNode {
  return Children.map(children, (child) => (
    <Glass radius={999} interactive style={style}>{child}</Glass>
  ));
}

