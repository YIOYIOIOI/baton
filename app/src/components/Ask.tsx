import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { Tappable } from './ui';
import * as haptics from '@/feedback/haptics';
import type { PendingAsk } from '@/api/types';

/**
 * agent 出的选择题。
 *
 * ## 它和一条普通通知不是一回事
 *
 * 这张卡挂着的时候，**agent 那一轮正停在工具调用上等它**（实测：MCP 工具调用
 * 阻塞整轮，让 MCP 服务器睡 75 秒，那一轮就跑了 81 秒）。不答不是「稍后再说」，
 * 是一轮白等到超时。所以：
 *
 *   · 钉在输入框正上方，不随对话滚走
 *   · 带倒计时。不是装饰——它说明「再不答这一轮就废了」
 *   · 单选点一下就答掉，不要再点一次「确定」：多那一步的代价是 agent 多等几秒
 *
 * ## 为什么还留一个「自己写」
 *
 * 实测 Claude 那个 AskUserQuestion 的 165 条真实回答里，用户**经常不选给定项**，
 * 而是写一段话。只给按钮等于逼人把话说错，而说错的代价是 agent 照错的往下做。
 */

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

export function AskCard({ ask, onAnswer, onDone }: {
  ask: PendingAsk;
  /** 送出答案。抛错交给调用方处理——这里只负责显示 */
  onAnswer: (input: { askId: string; picked: string[]; free: string | null }) => Promise<unknown>;
  onDone: () => void;
}) {
  const t = useTheme();
  const s = styles(t);
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /*
    换了一道题要把上一道的选择清掉，否则上一题勾过的会跟着过来。
    **靠调用处的 `key={ask.askId}` 让 React 整个重建这张卡**，不在 effect 里
    逐个 setState——后者是官方文档点名的反模式（会多跑一轮渲染），而且每加一个
    state 就要记得在那儿补一行，迟早漏。
  */

  const left = Math.max(0, Math.round((ask.expiresAt - now) / 1000));

  async function submit(one?: string) {
    if (busy) return;
    const body = one
      ? { askId: ask.askId, picked: [one], free: null }
      : { askId: ask.askId, picked, free: free.trim() || null };
    if (!body.picked.length && !body.free) return;
    setBusy(true);
    setErr(null);
    try {
      await onAnswer(body);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(label: string) {
    if (!ask.multiSelect) {
      void submit(label);
      return;
    }
    setPicked((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  }

  const canSend = (picked.length > 0 || free.trim().length > 0) && !busy;

  return (
    <View style={s.card} accessibilityLabel="agent 在等你选一个">
      <View style={s.head}>
        <Text style={s.chip}>{ask.header || '等你选'}</Text>
        <Text style={s.left}>{left > 0 ? fmt(left) : '就要超时了'}</Text>
      </View>

      <Text style={s.question}>{ask.question}</Text>

      {ask.options.map((o) => {
        const on = picked.includes(o.label);
        return (
          <Tappable
            key={o.label}
            style={[s.opt, on && s.optOn]}
            onPress={() => toggle(o.label)}
            disabled={busy}
            haptic={haptics.select}
            feedback="fill"
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: busy }}
          >
            <Text style={s.optLabel}>{o.label}</Text>
            {o.description ? <Text style={s.optDesc}>{o.description}</Text> : null}
          </Tappable>
        );
      })}

      {writing ? (
        <TextInput
          style={s.input}
          value={free}
          onChangeText={setFree}
          placeholder="给定的选项都不对，就在这儿说"
          placeholderTextColor={t.c.txTertiary}
          multiline
          autoFocus
        />
      ) : (
        <Tappable style={s.write} onPress={() => setWriting(true)} haptic={haptics.select}>
          <Text style={s.writeText}>都不对，我自己写</Text>
        </Tappable>
      )}

      {/* 单选且没在写字时，点选项即提交，这一行就不出现——少一个没用的按钮 */}
      {(ask.multiSelect || writing) && (
        <Tappable
          style={[s.send, !canSend && s.sendOff]}
          onPress={() => submit()}
          disabled={!canSend}
          haptic={haptics.select}
        >
          <Text style={s.sendText}>{busy ? '正在送出…' : '发给 agent'}</Text>
        </Tappable>
      )}

      {err ? <Text style={s.err}>{err}</Text> : null}
    </View>
  );
}

const styles = (t: Theme) => StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    // 用强调色的细边而不是警示色：它不是故障，是一次正常的交互，
    // 但要比一条普通消息**重**——那一轮正停着等它
    borderColor: t.c.txInfo,
    backgroundColor: t.c.bgInfo,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  chip: { fontSize: 12, fontWeight: '600', color: t.c.txInfo },
  left: { fontSize: 12, color: t.c.txTertiary, fontVariant: ['tabular-nums'] },
  question: { fontSize: 15, lineHeight: 22, color: t.c.txPrimary, marginBottom: 10 },
  opt: {
    minHeight: t.space.tap,
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.c.bdTertiary,
    backgroundColor: t.c.bgPrimary,
  },
  optOn: { borderColor: t.c.txInfo, borderWidth: 2 },
  optLabel: { fontSize: 15, fontWeight: '600', color: t.c.txPrimary },
  optDesc: { fontSize: 13, lineHeight: 19, color: t.c.txSecondary, marginTop: 3 },
  write: { minHeight: t.space.tap, justifyContent: 'center' },
  writeText: { fontSize: 13, color: t.c.txTertiary, textDecorationLine: 'underline' },
  input: {
    minHeight: 76,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.c.bdTertiary,
    backgroundColor: t.c.bgPrimary,
    color: t.c.txPrimary,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  send: {
    minHeight: t.space.tap,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: t.c.txInfo,
  },
  sendOff: { opacity: 0.4 },
  sendText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  err: { marginTop: 8, fontSize: 13, lineHeight: 19, color: t.c.txDanger },
});
