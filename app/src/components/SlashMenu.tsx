import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { useConnection } from '@/store/connection';
import type { Agent, SlashCommand, SlashList } from '@/api/types';
import { replaceToken, tokenAt } from '@/api/slash';
import * as haptics from '@/feedback/haptics';
import { Tappable } from './ui';

/**
 * 手机端输入框的 `/` 菜单（2026-11-11），和网页端 web/src/SlashMenu.tsx 同一套规矩：
 *
 * - 光标所在那个词以 `/` 开头、前面是行首或空格时弹（Codex 另认 `$`）——owner：「随时输入 / 都
 *   支持，只要 / 前面带个空格区分」
 * - 列这个会话的 agent 在这个目录下真能用的；Claude 句首给全部，句中只给技能和插件命令
 * - 点一行就把那个词换成 agent 真认的写法：Claude `/名字`，Codex `$名字`
 *
 * 手机上没有方向键，所以只做「点」；菜单浮在输入框上方，最多半屏高。
 */

const memo = new Map<string, SlashList>();
const GROUP: Record<SlashCommand['group'], string> = { builtin: '命令', skill: '技能', plugin: '插件' };
const headOf = (c: SlashCommand) => (c.common ? '常用' : GROUP[c.group]);

export function useSlashMenu({ sessionKey, agent, value, caret, onPick }: {
  sessionKey: string;
  agent: Agent | null;
  value: string;
  caret: number;
  /** 选中了：新的文字和光标位置 */
  onPick: (value: string, caret: number) => void;
}): React.ReactNode {
  const t = useTheme();
  const s = st(t);
  const client = useConnection((x) => x.client);
  const token = agent ? tokenAt(value, caret, agent === 'codex' ? '/$' : '/') : null;
  const [list, setList] = useState<SlashList | null>(() => memo.get(sessionKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const tokenKey = token ? `${token.start}:${value}` : null;
  const open = token !== null && dismissed !== tokenKey;

  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !client || asked.current === sessionKey) return;
    asked.current = sessionKey;
    let alive = true;
    const put = (r: SlashList) => {
      memo.set(sessionKey, r);
      if (alive) setList(r);
    };
    (async () => {
      try {
        const cached = memo.get(sessionKey);
        const r = cached && !cached.stale ? cached : await client.commands(sessionKey);
        put(r);
        if (r.stale) {
          if (alive) setLoading(true);
          put(await client.commands(sessionKey, true));
        }
      } catch {
        // 取不到就当没有可列的，输入照常
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, client, sessionKey]);

  const query = token?.query ?? '';
  const items = useMemo(() => {
    if (!open || !list || !token) return [];
    const scored: Array<[number, number, SlashCommand]> = [];
    list.commands.forEach((c, i) => {
      if (!token.atStart && c.inline === false) return;
      const n = c.name.toLowerCase();
      let sc = -1;
      if (!query) sc = 0;
      else if (n.startsWith(query)) sc = 3;
      else if (n.includes(query)) sc = 2;
      else if ((c.desc ?? '').toLowerCase().includes(query)) sc = 1;
      if (sc >= 0) scored.push([sc, i, c]);
    });
    return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 60).map((x) => x[2]);
  }, [open, list, token, query]);

  if (!open || !token) return null;
  const mention = list?.mention ?? (agent === 'codex' ? '$' : '/');
  const pick = (c: SlashCommand) => {
    haptics.tap();
    const r = replaceToken(value, token, `${mention}${c.name}`);
    onPick(r.value, r.caret);
  };

  return (
    <View style={s.menu}>
      <View style={s.head}>
        <Text style={s.headTx}>{agent === 'codex' ? 'Codex 技能（插入 $名字）' : '命令与技能'}</Text>
        <Tappable onPress={() => setDismissed(tokenKey)} hitSlop={10} accessibilityLabel="收起">
          <Text style={s.close}>收起</Text>
        </Tappable>
      </View>
      {!list || (loading && !list.commands.length) ? (
        <Text style={s.empty}>正在读这台电脑上能用的{agent === 'codex' ? '技能' : '命令'}…</Text>
      ) : !items.length ? (
        <Text style={s.empty}>
          {list.commands.length
            ? (!token.atStart && (agent === 'claude' || agent === 'antigravity') && !query ? '句子中间只能点名技能，这个会话没有可用的技能' : '没有对得上的')
            : `这个会话没有可列的${agent === 'codex' ? '技能' : '斜杠命令'}`}
        </Text>
      ) : (
        <ScrollView style={s.list} keyboardShouldPersistTaps="always">
          {items.map((c, i) => (
            <View key={c.name}>
              {!query && (i === 0 || headOf(items[i - 1]) !== headOf(c)) && <Text style={s.group}>{headOf(c)}</Text>}
              <Tappable style={s.row} feedback="fill" onPress={() => pick(c)} accessibilityRole="button" accessibilityLabel={`${mention}${c.name}`}>
                <Text style={s.name}>{mention}{c.name}</Text>
                {c.desc ? <Text style={s.desc} numberOfLines={1}>{c.desc}</Text> : null}
              </Tappable>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const st = (t: Theme) =>
  StyleSheet.create({
    menu: {
      marginHorizontal: 6, marginBottom: 6, paddingBottom: 4,
      borderRadius: 16, backgroundColor: t.c.bgPrimary,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.c.bdTertiary,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4,
    },
    headTx: { color: t.c.txTertiary, fontSize: 12, fontWeight: '600', fontFamily: t.fonts.sans },
    close: { color: t.c.txTertiary, fontSize: 13, fontFamily: t.fonts.sans },
    list: { maxHeight: 260 },
    group: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 2, color: t.c.txTertiary, fontSize: 11, fontWeight: '600', fontFamily: t.fonts.sans },
    row: { paddingHorizontal: 14, paddingVertical: 8 },
    name: { color: t.c.txPrimary, fontSize: 14, fontFamily: t.fonts.mono },
    desc: { marginTop: 2, color: t.c.txTertiary, fontSize: 12.5, fontFamily: t.fonts.sans },
    empty: { paddingHorizontal: 14, paddingVertical: 12, color: t.c.txTertiary, fontSize: 13, fontFamily: t.fonts.sans },
  });
