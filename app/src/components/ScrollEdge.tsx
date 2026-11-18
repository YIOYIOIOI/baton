import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/theme';

/**
 * 顶部的滚动边缘渐隐。
 *
 * 浮动栏里放的是**不可点的东西**（字标）时，不能靠玻璃解决可读性——玻璃在
 * 界面语言里意味着「这是个控件」，给一块纯展示的字标套玻璃，等于在说它能点。
 * owner 直接点名了这一条。
 *
 * 系统的做法是 scroll edge effect：内容滚到顶栏底下时那一带逐渐淡出页底色，
 * 于是字标下面永远是干净的，而下面仍然看得出「还有内容在往上走」。
 * 硬切一条不透明的横条也能挡住，但那就回到了 iOS 18 之前的实心导航栏，
 * 层次感全没了。
 *
 * 用 SVG 画渐变而不是引 expo-linear-gradient：react-native-svg 本来就在
 * （图标全靠它），为一条渐变再加一个原生依赖不划算，而且那还会多一样
 * Expo Go 里要对版本的东西。
 */
export function ScrollEdge({ height, color }: { height: number; color?: string }) {
  const t = useTheme();
  // 渐隐的目标色必须是**那一屏的页底**：分组列表那屏是灰的，用白去淡出
  // 会在顶栏下面留一条白带
  const to = color ?? t.c.bgTertiary;
  return (
    <View style={[styles.wrap, { height }]} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
            {/* 上面 60% 是实的：字标坐在这一段里，要完全干净。
                后 40% 淡出，让「底下还有内容」这件事仍然看得见。 */}
            <Stop offset="0" stopColor={to} stopOpacity="1" />
            <Stop offset="0.6" stopColor={to} stopOpacity="1" />
            <Stop offset="1" stopColor={to} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#edge)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // 层级要在浮动栏之下、内容之上。浮动栏自己是 z.floatBar，这里减 1。
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 19 },
});
