import { StyleSheet, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { Pulse, Tappable } from './ui';
import { LINK_LABEL } from './Notice';
import { linkColor } from './LinkSheet';
import * as haptics from '@/feedback/haptics';
import { useConnection } from '@/store/connection';

/**
 * 传输轴的「小位置」：浮动栏右上角那一颗，**每屏同一处**。
 *
 * 为什么是一颗点而不是一块状态区：传输状态绝大多数时候是「好着呢」，
 * 给它一块大位置等于常年展示一条没有信息量的内容；但它出问题时又必须立刻
 * 看得见。所以是一个总在那儿、平时安静的点。
 *
 * 它与运行轴**互不相干**——压成一个指示器的话，「运行中但沉默」和
 * 「连接已死」就必然长得一模一样。
 *
 * **安静不等于没有颜色。** 上一版 ok 是灰色 + 0.45 透明度，owner 的原话是
 * 「一直都是无色的」——一颗看不出颜色的点等于什么都没说，出问题时也分不清是
 * 变了色还是本来就那样。现在绿 / 琥珀 / 红三档（见 linkColor），
 * 安静靠的是尺寸只有 8pt，不是靠把颜色抽掉。
 */
export function LinkDot({ onPress }: { onPress?: () => void }) {
  const t = useTheme();
  const s = ld(t);
  const link = useConnection((x) => x.link);
  const color = linkColor(t, link);

  return (
    <Tappable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`连接状态：${LINK_LABEL[link]}`}
      /*
        点下去要有反应。原来是 none——一颗 8pt 的点，按下去屏幕上什么都不动，
        面板又从最底下升起来，读起来就是「没点到」。owner 2026-10-08：
        「并且没有点击效果」。dim 会把整颗点连同它的颜色一起压暗，正好。
      */
      feedback="dim"
      haptic={haptics.tap}
      style={s.slot}
    >
      {/* 重连中是唯一会动的状态：它意味着「正在自愈，等一下」，
          静止的点表达不了「正在」 */}
      {link === 'retrying'
        ? <Pulse style={[s.dot, { backgroundColor: color }]} />
        : <View style={[s.dot, { backgroundColor: color }]} />}
    </Tappable>
  );
}

// 说法只有一份，在 Notice.tsx。这里再导出一次是为了不改一堆 import——
// 但值必须是同一个，否则同一个状态在不同屏上会叫不同名字。
export { LINK_LABEL };

const ld = (t: Theme) =>
  StyleSheet.create({
    // 40pt：和返回键、「…」一样大，也满足最小点击目标
    slot: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    dot: { width: 8, height: 8, borderRadius: t.radius.full },
  });
