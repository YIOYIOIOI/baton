import { StyleSheet } from 'react-native';

/**
 * 设计 token。
 *
 * **结构照旧，配色换新**（2026-09-12）。owner 的原话：视觉方案「仅供参考…
 * 主要还是以之前的布局为准…更准确地说只要参考配色」。所以：
 *   保留   三级底色 / 四级文字 / 三级描边这套层级，以及全部 token 名
 *          —— 布局代码全靠它们，换名字就等于又动了布局
 *   换掉   具体色值，改用方案那三个：底 #F5F2EB、墨 #22211F、强调 #2455FF
 *
 * 最大的一处：**强调色从珊瑚 #cc785c 换成电光蓝 #2455FF**。`coral` 这个名字
 * 留着不动（它在十几处被引用），但值已经是蓝的——名字现在指的是"强调色"这个角色，
 * 不是那个颜色本身。改名是布局改动，不在这次范围里。
 *
 * 层级关系是从原来那套等比推过来的，不是重新配的：原来 bgSecondary 比页底暗一档、
 * 同色相；这里照样比 #F5F2EB 暗一档、同色相。
 */

export type Palette = {
  bgPrimary: string; bgSecondary: string; bgTertiary: string; bgInverse: string;
  /**
   * 分组列表那一屏的页底。
   *
   * iOS 有两套列表惯例，页底和行的关系正好相反：
   *   plain     白页底 + 一条条分隔线，没有卡片（会话列表就是这种）
   *   grouped   **灰页底 + 白卡片**，卡片不描边，靠明度差分层（设置页是这种）
   *
   * 所以「页底一律白」在设置页上行不通——白页白卡等于没有卡片，只能补描边，
   * 而描边正是 grouped 不用的东西。给它一个自己的页底色，两套惯例各自成立。
   */
  bgGrouped: string;
  bgInfo: string; bgDanger: string; bgSuccess: string; bgWarning: string;
  txPrimary: string; txSecondary: string; txTertiary: string; txInverse: string;
  txInfo: string; txDanger: string; txSuccess: string; txWarning: string;
  bdPrimary: string; bdSecondary: string; bdTertiary: string; ring: string;
  coral: string; coralActive: string;
  /**
   * 强调色的浅底：套餐徽标、选中行的底。和电脑网页端 tokens.css 的 `--accent-soft` 同值
   * （那边是 color-mix(accent 8% / 13%, 页底)，这里把混出来的结果写死——RN 没有 color-mix）。
   */
  accentSoft: string;
  sb: string; sbHover: string;
};

/**
 * 浅色。
 *
 * **页底从暖米白 #F5F2EB 换成了纯白**（owner 点名要的）。连带要动的是层级关系：
 * 原来「卡片 #fff 比页底亮一档」，页底变白之后这一档没了，卡片只能靠描边站住；
 * 而「按下/填充」那一档原来是同色相的 #ece8dd，在白底上会显出米黄，改成中性灰。
 *
 * 墨色 #22211f 保持不动——它是 logo 里那个颜色，换掉就不是这个牌子了。
 */
export const light: Palette = {
  bgPrimary: '#ffffff',     // 卡片。和页底同色，靠 bdTertiary 那道描边分层
  bgSecondary: '#f0f0f2',   // 用户气泡、输入框、按下填充——中性灰，不带米黄
  bgTertiary: '#ffffff',    // 页底（plain 列表那一套）
  bgGrouped: '#f2f2f7',     // 分组列表的页底。取自 iOS 的 systemGroupedBackground
  bgInverse: '#22211f',     // 方案的墨色
  bgInfo: '#e2e8ff',        // 配 #2455FF 的浅蓝底
  bgDanger: '#fbe9e7',
  bgSuccess: '#e6f0e6',
  bgWarning: '#fbf0dc',

  txPrimary: '#22211f',
  txSecondary: '#4a4843',
  txTertiary: '#6e6b66',    // 方案的 muted
  txInverse: '#f7f7f8',     // 深色块上的字。比纯白退半档，避免在墨色上刺眼
  txInfo: '#2455ff',
  txDanger: '#b3261e',
  txSuccess: '#1f6b36',
  txWarning: '#855200',   // WCAG AA (>= 4.5:1 on light surface) aligned with web tokens.css

  bdPrimary: 'rgba(34, 33, 31, 0.40)',
  bdSecondary: 'rgba(34, 33, 31, 0.30)',
  bdTertiary: 'rgba(34, 33, 31, 0.15)',
  ring: 'rgba(34, 33, 31, 0.70)',

  // 名字留着，值换成方案的电光蓝——见文件抬头
  coral: '#2455ff',
  coralActive: '#1b40c4',
  accentSoft: '#ecf0ff',

  sb: 'rgba(34, 33, 31, 0.17)',
  sbHover: 'rgba(34, 33, 31, 0.34)',
};

export const dark: Palette = {
  bgPrimary: '#232327',
  bgSecondary: '#1f1f22',
  bgTertiary: '#17171a',
  // 深色下 grouped 反过来：页底比卡片**更暗**，卡片才浮得起来。
  // iOS 深色的 systemGroupedBackground 干脆是纯黑，这里跟着调色板压到近黑。
  bgGrouped: '#0e0e10',
  bgInverse: '#f2f0ea',
  bgInfo: '#20294a',
  bgDanger: '#3a201c',
  bgSuccess: '#1b3a24',
  bgWarning: '#332711',

  txPrimary: '#f2f0ea',
  txSecondary: '#c4c1b9',
  txTertiary: '#9a968e',
  txInverse: '#17171a',
  txInfo: '#7d9bff',       // #2455FF 在深底上偏闷，提亮
  txDanger: '#f2836f',
  txSuccess: '#7cc48f',
  txWarning: '#e0a94a',   // 同上，对齐网页端深色

  bdPrimary: 'rgba(242, 240, 234, 0.40)',
  bdSecondary: 'rgba(242, 240, 234, 0.30)',
  bdTertiary: 'rgba(242, 240, 234, 0.15)',
  ring: 'rgba(242, 240, 234, 0.70)',

  coral: '#5c82ff',
  coralActive: '#7d9bff',
  accentSoft: '#202538',

  sb: 'rgba(242, 240, 234, 0.17)',
  sbHover: 'rgba(242, 240, 234, 0.32)',
};

/**
 * 字体。
 *
 * RN 的 `fontFamily` **不支持 CSS 那样的 fallback 列表**——只能给一个名字。
 * 但 iOS 自己会对缺失的字形逐字回退，所以指定 'Georgia' 的实际效果是：
 * 拉丁字母走 Georgia 衬线，中日韩字符因 Georgia 没有这些字形而由系统回退到
 * PingFang——**恰好复刻原型要的「拉丁衬线 + 中文无衬线」**，不需要打包字体。
 *
 * 不加载外部字体是刻意的（原型 §7）：字体文件会显著拖长首屏，而这套排版
 * 依赖的是"系统上已经有的那几个"。
 */
export const fonts = {
  serif: 'Georgia',
  sans: 'System',
  mono: 'Menlo',
} as const;

export const size = {
  xs: 13, sm: 15, md: 16, lg: 20, xl: 28,
} as const;

export const weight = {
  normal: '400',
  bold: '600',
} as const;

export const radius = {
  md: 8, lg: 12, xl: 18, full: 9999,
} as const;

export const space = {
  pad: 18,
  tap: 44, // 最小可点区域，低于它在手机上点不准
} as const;

/**
 * 层级。
 *
 * iOS 26 起，**内容层和功能层是两个分开的平面**——这不是审美，是 HIG 的结构约定：
 * 玻璃属于功能层，内容从它底下滚过去。原来这几个数是散落在各文件里的魔数
 * （`zIndex: 3`、`zIndex: 30`），改一处要全局搜一遍，而且看不出它们之间的关系。
 *
 * 数字之间留着间隔，是为了将来往中间插东西时不必重排。
 */
export const z = {
  content: 0,   // 列表、会话流、卡片——一切滚动的东西
  dock: 10,     // 底部附件：输入区、主操作条
  floatBar: 20, // 浮动顶栏
  sheet: 30,    // 从底部升起的面板（Modal 自成一层，这个数只用于非 Modal 的遮罩）
} as const;

/**
 * `--bw: .5px`。RN 里用 hairlineWidth：它按设备像素密度算出"一个物理像素"，
 * 写死 0.5 在 3x 屏上会变成 1.5 个物理像素，线就粗了。
 */
export const hairline = StyleSheet.hairlineWidth;

/**
 * `--sh-float`。RN 的阴影在两个平台上是两套 API，且不支持多层阴影——
 * 原型那条是两层叠加，这里只能取视觉上更重的那层近似。
 * iOS 用 shadow*，Android 用 elevation。
 */
export type Shadow = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
};

export const floatShadow: { light: Shadow; dark: Shadow } = {
  light: {
    shadowColor: '#141413',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    elevation: 3,
  },
  dark: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 3,
  },
};
