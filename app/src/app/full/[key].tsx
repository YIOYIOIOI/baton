import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme, type Theme } from '@/theme';
import { FloatBar, Tappable, useFloatBarHeight } from '@/components/ui';
import { ScrollEdge } from '@/components/ScrollEdge';
import { Raw } from '@/components/stream';
import { useConnection } from '@/store/connection';
import type { EventFull } from '@/api/types';

/**
 * 超长输出的全文。
 *
 * 分段取：实测单条最长 347,481 字，整条推给手机既拖死滚动，也把断连补帧的
 * 滚动锚定弄坏。这一屏明确告诉用户「渲染了多少、还剩多少」——
 * 悄悄截断而不说，用户会以为输出就这么长。
 */
const CHUNK = 40_000;

export default function FullScreen() {
  const t = useTheme();
  const router = useRouter();
  const { key, eventId, offset } = useLocalSearchParams<{
    key: string; eventId: string; offset: string;
  }>();
  const client = useConnection((s) => s.client);

  const [text, setText] = useState('');
  const [meta, setMeta] = useState<EventFull | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const loadFrom = useCallback(async (from: number) => {
    if (!client) return;
    setBusy(true);
    try {
      // offset 必须原样回传：没有它后端要从头扫 transcript 找锚点，实测最大 175 MB
      const r = await client.eventFull(key, eventId, Number(offset), { from, to: from + CHUNK });
      setMeta(r);
      setText((prev) => (from === 0 ? r.text : prev + r.text));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, key, eventId, offset]);

  useEffect(() => { loadFrom(0); }, [loadFrom]);

  const s = styles(t);
  const barH = useFloatBarHeight();
  const left = meta ? meta.totalChars - text.length : 0;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[s.meta, { paddingTop: barH + 4 }]}>
        <Text style={s.n}>{num(meta?.totalChars ?? 0)}</Text>
        <Text style={s.unit}>字</Text>
        <Text style={s.cmd} numberOfLines={1}>{eventId}</Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
        {err ? <Text style={s.err}>{err}</Text> : null}
        <View style={s.pre}><Raw text={text} /></View>

        <Text style={s.note}>
          这一屏渲染了前 {num(text.length)} 字
          {left > 0 ? `，还有 ${num(left)} 字。` : '，已是全部。'}
        </Text>

        {left > 0 ? (
          <Tappable style={s.more} onPress={() => loadFrom(text.length)} disabled={busy} accessibilityRole="button">
            {busy
              ? <ActivityIndicator color={t.c.txTertiary} />
              : <Text style={s.moreTx}>再载入 {num(Math.min(CHUNK, left))} 字</Text>}
          </Tappable>
        ) : null}

        {busy && !text ? <ActivityIndicator color={t.c.txTertiary} style={{ marginTop: 30 }} /> : null}
      </ScrollView>

      <ScrollEdge height={barH} />
      <FloatBar onBack={() => router.back()} />
    </View>
  );
}

const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    meta: {
      flexDirection: 'row', alignItems: 'baseline', gap: 8,
      paddingTop: 52, paddingHorizontal: t.space.pad, paddingBottom: 10,
      width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center',
    },
    n: {
      fontWeight: t.weight.bold, color: t.c.txPrimary, fontSize: t.size.xs,
      fontVariant: ['tabular-nums'], fontFamily: t.fonts.sans,
    },
    unit: { fontSize: t.size.xs, color: t.c.txTertiary, fontFamily: t.fonts.sans },
    cmd: { flex: 1, fontFamily: t.fonts.mono, fontSize: t.size.xs, color: t.c.txTertiary },
    body: { flex: 1, backgroundColor: t.c.bgSecondary },
    bodyContent: {
      paddingBottom: 32,
      width: '100%', maxWidth: t.layout.contentMaxW, alignSelf: 'center',
    },
    pre: { paddingHorizontal: t.space.pad, paddingTop: 14 },
    note: {
      paddingHorizontal: t.space.pad, paddingTop: 12,
      fontSize: 12, color: t.c.txTertiary, lineHeight: 18, fontFamily: t.fonts.sans,
    },
    more: {
      alignSelf: 'center', marginTop: 14,
      paddingHorizontal: 20, paddingVertical: 12,
      borderRadius: t.radius.full, backgroundColor: t.c.bgPrimary,
    },
    moreTx: { fontSize: t.size.xs, color: t.c.txSecondary, fontFamily: t.fonts.sans },
    err: {
      margin: t.space.pad, padding: 12, borderRadius: t.radius.md,
      backgroundColor: t.c.bgDanger, color: t.c.txDanger, fontSize: t.size.xs, fontFamily: t.fonts.sans,
    },
  });
