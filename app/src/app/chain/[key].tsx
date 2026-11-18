import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme, type Theme } from '@/theme';
import { FloatBar, ListMeta, Wordmark, useFloatBarHeight } from '@/components/ui';
import { useConnection } from '@/store/connection';
import type { Chain } from '@/api/types';

/**
 * 一条链。
 *
 * 「链」是同一段工作被 `--resume` 或分叉切成的几个会话文件。它们在列表里只占
 * 一行（最新的那个代表整条），这一屏是把这条链摊开。
 *
 * **起点可能已经不存在**：文件被删或改名后，子代仍然靠首记录的父指针归到这条链。
 * 那一行要显式画出来——不画的话，链上第一条看起来就像凭空出现的。
 */
export default function ChainScreen() {
  const t = useTheme();
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const client = useConnection((s) => s.client);
  const [chain, setChain] = useState<Chain | null>(null);

  useEffect(() => {
    client?.sessions()
      .then((r) => setChain(r.chains.find((c) => c.members.some((m) => m.key === key)) ?? null))
      .catch(() => {});
  }, [client, key]);

  const members = chain?.members ?? [];
  // 起点缺失的判据：链上第一条仍带着父指针，说明它的父亲不在我们手上
  const orphanRoot = !!members[0]?.parentId;
  const s = styles(t);
  const barH = useFloatBarHeight();

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={[s.scroll, { paddingTop: barH }]}>
        <Wordmark>一条链</Wordmark>
        <ListMeta>
          {members.length} 个会话{orphanRoot ? ' · 起点会话的文件已不存在' : ''}
        </ListMeta>

        {orphanRoot ? (
          <View style={s.row}>
            <View style={s.dotSlot}><View style={[s.dot, s.dotGhost]} /></View>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: t.c.txTertiary }]}>起点会话已不存在</Text>
              <Text style={s.sub}>文件被删或改名，子代仍归这条链</Text>
            </View>
          </View>
        ) : null}

        {members.map((m) => (
          <Pressable
            key={m.key}
            style={({ pressed }) => [s.row, pressed && { backgroundColor: t.c.bgSecondary }]}
            onPress={() => router.push({ pathname: '/session/[key]', params: { key: m.key } })}
            accessibilityRole="button"
          >
            <View style={s.dotSlot}>
              <View style={[s.dot, m.key === key ? { backgroundColor: t.c.coral } : s.dotIdle]} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[s.title, m.titleTier > 1 && { color: t.c.txTertiary }]}
                numberOfLines={1}
              >
                {m.title}
              </Text>
              <Text style={s.sub}>{when(m.lastTs)}{m.key === key ? ' · 当前' : ''}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>

      <FloatBar onBack={() => router.back()} />
    </View>
  );
}

function when(ts: string | null): string {
  if (!ts) return '';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    scroll: { paddingTop: 56, paddingBottom: 20 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: t.space.pad, paddingVertical: 10,
    },
    dotSlot: { width: 16, alignItems: 'flex-start', paddingLeft: 3, alignSelf: 'flex-start', paddingTop: 6 },
    dot: { width: 8, height: 8, borderRadius: t.radius.full },
    dotIdle: { borderWidth: 1.2, borderColor: t.c.txTertiary, opacity: 0.5 },
    dotGhost: { borderWidth: 1, borderColor: t.c.bdSecondary, opacity: 0.6 },
    title: { fontSize: t.size.md, lineHeight: 22, color: t.c.txPrimary, fontFamily: t.fonts.sans },
    sub: { fontSize: t.size.xs, color: t.c.txTertiary, marginTop: 2, fontFamily: t.fonts.sans },
  });
