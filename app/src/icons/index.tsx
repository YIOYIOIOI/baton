import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import type { ReactNode } from 'react';

/**
 * 极简手绘单色描边 SVG 图标组件，零外部图标库依赖，保持安装包轻量且样式统一。
 */

type Props = { size?: number; color: string; strokeWidth?: number };

function Stroke({ size = 22, color, strokeWidth = 1.7, children }: Props & { children: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

export const IconCamera = (p: Props) => (
  <Stroke {...p}>
    <Path d="M3 8.5A2.5 2.5 0 015.5 6h1.7l1.1-2h5.4l1.1 2h1.7A2.5 2.5 0 0119 8.5v8A2.5 2.5 0 0116.5 19h-11A2.5 2.5 0 013 16.5z" />
    <Circle cx="11" cy="12.5" r="3.4" />
  </Stroke>
);

export const IconMenu = (p: Props) => (
  <Stroke {...p}>
    <Path d="M4 8h16M4 12h11M4 16h16" />
  </Stroke>
);

export const IconCopy = (p: Props) => (
  <Stroke {...p}>
    <Rect x="9" y="9" width="11" height="11" rx="2.5" />
    <Path d="M5 15V5a2 2 0 012-2h8" />
  </Stroke>
);

/** 相册。方框 + 里面一座小山和太阳——照片的通用画法，和相机那颗区分得开。 */
export const IconImage = (p: Props) => (
  <Stroke {...p}>
    <Rect x="3" y="4.5" width="18" height="15" rx="3" />
    <Circle cx="8.6" cy="10" r="1.7" />
    <Path d="M3.4 17.3l4.5-4.3a2 2 0 012.7 0l4.2 4M13.6 15.4l2-1.9a2 2 0 012.7 0l2.3 2.2" />
  </Stroke>
);

export const IconFile = (p: Props) => (
  <Stroke {...p}>
    <Path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
    <Path d="M14 3v5h5" />
  </Stroke>
);

/** 文件夹。文件浏览器里和 IconFile 成对出现，所以线宽、圆角要和它一致。 */
export const IconFolder = (p: Props) => (
  <Stroke {...p}>
    <Path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </Stroke>
);

/** 归档箱：一条盖子 + 一个箱体 + 中间的提手槽。列表末尾那个「已归档」入口用。 */
export const IconArchive = (p: Props) => (
  <Stroke {...p}>
    <Rect x="3" y="4" width="18" height="4" rx="1" />
    <Path d="M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
    <Path d="M10 12h4" />
  </Stroke>
);

/** 叉。撤掉附件、关闭用。 */
export const IconClose = (p: Props) => (
  <Stroke {...p}>
    <Path d="M5 5l14 14M19 5L5 19" />
  </Stroke>
);

export const IconGlobe = (p: Props) => (
  <Stroke {...p}>
    <Circle cx="12" cy="12" r="9" />
    <Path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 000 18 15 15 0 000-18" />
  </Stroke>
);

export const IconTick = (p: Props) => (
  <Stroke {...p} strokeWidth={p.strokeWidth ?? 2.2}>
    <Path d="M4 12.5l5 5L20 6" />
  </Stroke>
);

export const IconBack = (p: Props) => (
  <Stroke {...p} strokeWidth={p.strokeWidth ?? 2}>
    <Path d="M15 5l-7 7 7 7" />
  </Stroke>
);

export const IconRight = (p: Props) => (
  <Stroke {...p} strokeWidth={p.strokeWidth ?? 2}>
    <Path d="M9 5l7 7-7 7" />
  </Stroke>
);

export const IconPlus = (p: Props) => (
  <Stroke {...p} strokeWidth={p.strokeWidth ?? 2}>
    <Path d="M12 5v14M5 12h14" />
  </Stroke>
);

export const IconUp = (p: Props) => (
  <Stroke {...p} strokeWidth={p.strokeWidth ?? 2.2}>
    <Path d="M12 19V6M6 12l6-6 6 6" />
  </Stroke>
);

export const IconExpand = (p: Props) => (
  <Stroke {...p}>
    <Path d="M9 3H5a2 2 0 00-2 2v4M15 3h4a2 2 0 012 2v4M21 15v4a2 2 0 01-2 2h-4M3 15v4a2 2 0 002 2h4" />
  </Stroke>
);

export const IconTerm = (p: Props) => (
  <Stroke {...p}>
    <Path d="M5 7l4 4-4 4M12 15h7" />
  </Stroke>
);

export const IconSearch = (p: Props) => (
  <Stroke {...p}>
    <Circle cx="11" cy="11" r="6.5" />
    <Path d="M16 16l4.5 4.5" />
  </Stroke>
);

export const IconClock = (p: Props) => (
  <Stroke {...p}>
    <Path d="M3.3 10a9 9 0 113 8.2M3 5v5h5" />
    <Path d="M12 8v4.2l2.8 1.6" />
  </Stroke>
);

export const IconStop = ({ size = 22, color }: Props) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Rect x="7" y="7" width="10" height="10" rx="2.5" />
  </Svg>
);

export const IconDots = ({ size = 22, color }: Props) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Circle cx="5" cy="12" r="1.7" />
    <Circle cx="12" cy="12" r="1.7" />
    <Circle cx="19" cy="12" r="1.7" />
  </Svg>
);

/**
 * Baton 自己的标记：logo 里那颗蓝球。
 *
 * 会话里每轮回复左下角的署名用它，不再用 Claude 的 spike——那是别人的标识，
 * 放在我们自己的产品里既不对也容易让人误会。球是实心圆，logo 里就是这个形状。
 */
export const IconBall = ({ size = 22, color }: Props) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx="12" cy="12" r="5" fill={color} />
    {/*
      放射的短笔画，照 handoff.png 里那颗球描的：**左上两道、右侧三道**，
      长短不一、和球之间留空隙。不做成对称的八道——那是「太阳」的画法，
      而原图那种手绘式的不对称正是它的辨识度所在。

      圆头笔画。方头在 17px 上会糊成一个小方块，看不出是笔画。
    */}
    <G stroke={color} strokeWidth="1.5" strokeLinecap="round">
      <Path d="M5.4 9.6 L3.1 8.8" />
      <Path d="M5.4 14.4 L3.1 15.3" />
      <Path d="M18.6 9.6 L20.9 8.8" />
      <Path d="M18.9 13.2 L21.4 13.7" />
      <Path d="M17.4 16.5 L19.3 18.1" />
    </G>
  </Svg>
);

/** 分叉：一条线从主干上分出去。会话列表和菜单里都用它表示「同一条线上的别的会话」。 */
export const IconBranch = (p: Props) => (
  <Stroke {...p}>
    <Circle cx="7" cy="5.5" r="2.2" />
    <Circle cx="7" cy="18.5" r="2.2" />
    <Circle cx="17" cy="9.5" r="2.2" />
    <Path d="M7 7.7v8.6M9.2 6.2h3.3a4 4 0 014 4v.3" />
  </Stroke>
);

/** 详略：三条长短不一的线。 */
export const IconLines = (p: Props) => (
  <Stroke {...p}>
    <Path d="M4 7h16M4 12h12M4 17h8" />
  </Stroke>
);

/** 刷新：一圈带箭头。 */
export const IconRefresh = (p: Props) => (
  <Stroke {...p}>
    <Path d="M20 12a8 8 0 11-2.3-5.6M20 4v4h-4" />
  </Stroke>
);

/** iOS 的分享：一个开口的盒子 + 向上的箭头。原生上「下载」走的就是分享面板，图标照系统的画。 */
export const IconShare = (p: Props) => (
  <Stroke {...p}>
    <Path d="M12 3v12M8 7l4-4 4 4" />
    <Path d="M8 10H6.5A1.5 1.5 0 005 11.5v8A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5v-8a1.5 1.5 0 00-1.5-1.5H16" />
  </Stroke>
);

/** 下载：向下的箭头落进一道底线。网页端（真的有「下载」这回事）用它。 */
export const IconDownload = (p: Props) => (
  <Stroke {...p}>
    <Path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
  </Stroke>
);

/** 代码文件：一对尖括号。文件浏览器里按类型区分图标用。 */
export const IconCode = (p: Props) => (
  <Stroke {...p}>
    <Path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5" />
  </Stroke>
);

/** 排序：三道由长到短的横线。 */
export const IconSort = (p: Props) => (
  <Stroke {...p}>
    <Path d="M4 7h16M7 12h10M10 17h4" />
  </Stroke>
);
