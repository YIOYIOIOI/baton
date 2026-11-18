import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { BallSpinner } from './ui';
import type { RunAxis } from '@/api/types';

/**
 * 运行轴的活动行。紧凑单行格式：
 *
 *     ● 19m 32s · 27.8k tokens · Running tools…
 *
 * 珊瑚点 + 已耗时 + token + 在干什么。这一行**永远不换行**——换行会让它从
 * 「一条状态」变成「一个区块」，而它只该是一条状态。
 *
 * 秒表由服务器心跳驱动。本地时钟断网后会继续走，**那就是说谎**——
 * 也正是同类工具翻车的地方。
 */
export function Live({
  run, elapsedMs, tokens, doing, stale,
}: {
  run: RunAxis | null;
  elapsedMs: number;
  tokens: number | null;
  doing: string | null;
  stale: boolean;
}) {
  const t = useTheme();
  const s = lv(t);
  if (run !== 'streaming' && run !== 'silent') return null;

  const what = stale
    ? '不确定它在做什么'
    : run === 'streaming'
      ? (doing ?? '正在跑')
      : '等模型返回，还没有输出';

  return (
    <View style={s.live}>
      {/*
        **是 logo 那颗球，不是一个抽象的点。**

        原来这儿是一颗珊瑚色圆点在呼吸。owner：「那个蓝色的圆点换成我们现在这个
        真正的 logo 同时具备 logo 你之前设计的动效」——同一个东西在「正在做」和
        「做完了」两种状态下该是同一个形象，只有动静变，不该换一种图形。
        做完之后那颗静止的球出现在消息末尾（TurnFoot），这里是它转着的样子。

        传输死了就让它停下来：还在转 = 还在动，那时候界面就是在说谎。

        **只用动静区分，不用颜色**（owner 明确要求）。上一版传输死掉时还把球
        染成灰的——那是第三个说同一件事的渠道：球已经停了、右边还写着
        「已停止更新」。颜色留给别的意思，不参与这件事。
      */}
      <BallSpinner size={15} color={t.c.coral} spinning={!stale} />

      <Text style={[s.clock, stale && { color: t.c.txTertiary }]}>{mmss(elapsedMs)}</Text>

      {tokens ? (
        <>
          <Text style={s.sep}>·</Text>
          <Text style={s.meta}>{kilo(tokens)} tokens</Text>
        </>
      ) : null}

      <Text style={s.sep}>·</Text>
      <Text style={s.what} numberOfLines={1}>{what}</Text>

      {/* 界面会说谎的那一刻：运行中 × 传输已死。唯一允许小位置变响的地方。 */}
      {stale ? <Text style={s.frozen}>已停止更新</Text> : null}
    </View>
  );
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const lv = (t: Theme) =>
  StyleSheet.create({
    live: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      marginHorizontal: t.space.pad, marginBottom: 10, paddingVertical: 2,
    },
    dot: { width: 8, height: 8, borderRadius: t.radius.full },
    clock: {
      color: t.c.txSecondary, fontSize: t.size.xs,
      fontVariant: ['tabular-nums'], fontFamily: t.fonts.sans,
    },
    sep: { opacity: 0.5, color: t.c.txTertiary, fontSize: t.size.xs },
    meta: { color: t.c.txTertiary, fontSize: t.size.xs, fontFamily: t.fonts.sans },
    what: { flex: 1, color: t.c.txTertiary, fontSize: t.size.xs, fontFamily: t.fonts.sans },
    frozen: { color: t.c.txDanger, fontWeight: t.weight.bold, fontSize: t.size.xs, fontFamily: t.fonts.sans },
  });
