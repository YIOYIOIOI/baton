import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/theme';

/**
 * 顶部或底部的滚动边缘渐隐。
 *
 * 浮动栏里放的是**不可点的东西**（字标）或内容滚入浮动输入区下方时，
 * 系统的做法是 scroll edge effect：内容滚到浮动层底下时那一带按缓出曲线
 * 逐渐淡出页底色，既不留生硬横线，又保持浮动控件与正文清晰分层。
 *
 * 用 `useId()` 生成唯一渐变 id：同一屏同时挂顶部和底部两条渐隐时，
 * 固定 `id="edge"` 会让两条 SVG 互相引用错方向的渐变。
 */
export function ScrollEdge({
  height, color, edge = 'top', zIndex,
}: {
  height: number; color?: string; edge?: 'top' | 'bottom'; zIndex?: number;
}) {
  const t = useTheme();
  const rawId = useId();
  const id = `edge-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const to = color ?? t.c.bgTertiary;
  const bottom = edge === 'bottom';
  return (
    <View
      style={[
        styles.wrap,
        bottom ? styles.bottom : styles.top,
        { height, zIndex: zIndex ?? (bottom ? t.z.dock - 1 : t.z.floatBar - 1) },
      ]}
      pointerEvents="none"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1={bottom ? '1' : '0'} x2="0" y2={bottom ? '0' : '1'}>
            <Stop offset="0" stopColor={to} stopOpacity="1" />
            <Stop offset="0.48" stopColor={to} stopOpacity="0.96" />
            <Stop offset="0.72" stopColor={to} stopOpacity="0.62" />
            <Stop offset="0.9" stopColor={to} stopOpacity="0.18" />
            <Stop offset="1" stopColor={to} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
