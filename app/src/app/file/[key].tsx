import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useTheme, type Theme } from '@/theme';
import { IconCopy, IconDownload, IconFile, IconPlus, IconShare } from '@/icons';
import { Chip, FloatBar, Tappable, useFloatBarHeight, useHydrated } from '@/components/ui';
import { Glass } from '@/components/Glass';
import { ScrollEdge } from '@/components/ScrollEdge';
import { Markdown } from '@/components/markdown';
import * as haptics from '@/feedback/haptics';
import { useConnection } from '@/store/connection';
import { downloadSessionFile } from '@/store/download';
import { draftText, setDraftText } from '@/store/drafts';
import {
  IMAGE_MAX, TEXT_MAX, baseName, extOf, fmtSize, isMarkdown, isTextName, kindOf,
} from '@/store/files';

/**
 * 文件预览。从文件浏览器里点一个文件进来。
 *
 * 原来手机上点文件只会把它勾上，想看一眼内容只能先下载、再去「文件」App 里打开——
 * 看一个 README 要绕三步。电脑端早就是「点文件 = 右边预览」，这里照做：
 *
 *   文本   带行号的等宽正文，FlatList 逐行虚拟化（1 MB 的日志也就几万行，整块
 *          塞进一个 Text 会让滚动卡死）
 *   Markdown 默认渲染，能切回源码
 *   图片   按原比例铺满宽度
 *   其它   图标 + 大小 + 下载
 *
 * 下面三颗按钮：下载（原生上是分享面板里的「存储到文件」）、复制路径、放进输入框。
 * 最后一颗是手机上最常用的那个动作——「你看一下这个文件」，路径不用手打。
 *
 * 取字节和下载是同一个端点（服务端 downloadSessionFile），范围同样锁在会话目录里。
 */

/** 不认识扩展名、但小到值得一试的：读回来看有没有 NUL，没有就当文本 */
const SNIFF_MAX = 256 * 1024;

type Body =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; uri: string; headers?: Record<string, string> }
  | { kind: 'none'; why: string }
  | { kind: 'error'; message: string };

/** 预渲染那一份拿不到 ?path=，先出空壳，水合完再出内容（见 useHydrated） */
export default function FileScreen() {
  const t = useTheme();
  const hydrated = useHydrated();
  if (!hydrated) return <View style={{ flex: 1, backgroundColor: t.c.bgTertiary }} />;
  return <FileBody />;
}

function FileBody() {
  const t = useTheme();
  const s = styles(t);
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const barH = useFloatBarHeight();
  const { key, path, size: rawSize } = useLocalSearchParams<{ key: string; path: string; size?: string }>();
  const client = useConnection((c) => c.client);
  const name = baseName(path ?? '');
  const size = rawSize ? Number(rawSize) : null;
  const kind = kindOf({ name, dir: false });
  const md = isMarkdown(name);

  const [body, setBody] = useState<Body>({ kind: 'loading' });
  const [rendered, setRendered] = useState(true);
  const [taking, setTaking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 「图片」只认位图：原生 <Image> 不认 SVG，SVG 在原生上当文本看
  const asImage = kind === 'image' && (extOf(name) !== 'svg' || Platform.OS === 'web') && extOf(name) !== 'heic';
  const asText = !asImage && (isTextName(name) || extOf(name) === 'svg' || (size !== null && size <= SNIFF_MAX));

  useEffect(() => {
    if (!client || !path) return undefined;
    let alive = true;
    let objectUrl: string | null = null;
    const src = client.fileSource(key, path);

    (async () => {
      if (asImage) {
        if (size !== null && size > IMAGE_MAX) { setBody({ kind: 'none', why: `图片有 ${fmtSize(size)}，太大了，下载后再看。` }); return; }
        // 原生的 <Image> 自己带头去取、自己缓存解码，字节不进 JS；网页 <img> 带不了头，先取成 blob
        if (Platform.OS !== 'web') { setBody({ kind: 'image', uri: src.uri, headers: src.headers }); return; }
        const res = await fetch(src.uri, { headers: src.headers });
        if (!res.ok) throw new Error(`取不到这个文件（HTTP ${res.status}）`);
        objectUrl = URL.createObjectURL(await res.blob());
        if (alive) setBody({ kind: 'image', uri: objectUrl });
        return;
      }
      if (!asText) { setBody({ kind: 'none', why: '这种文件没法在这里预览。' }); return; }
      if (size !== null && size > TEXT_MAX) {
        setBody({ kind: 'none', why: `文件有 ${fmtSize(size)}，超过 ${fmtSize(TEXT_MAX)} 的不在手机上预览，下载后再看。` });
        return;
      }
      const res = await fetch(src.uri, { headers: src.headers });
      if (!res.ok) throw new Error(`取不到这个文件（HTTP ${res.status}）`);
      const text = await res.text();
      if (!alive) return;
      // 扩展名是猜的，内容才作数：前 8 KB 里有 NUL 就是二进制
      if (text.slice(0, 8192).includes('\u0000')) { setBody({ kind: 'none', why: '这是个二进制文件，没法当文本看。' }); return; }
      const truncated = text.length > TEXT_MAX;
      setBody({ kind: 'text', text: truncated ? text.slice(0, TEXT_MAX) : text, truncated });
    })().catch((e: Error) => { if (alive) setBody({ kind: 'error', message: e.message }); });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // fileSource 每次给新对象，不进依赖；它只由 key / path 决定
  }, [client, key, path, size, asImage, asText]);

  // 那句提示自己消失。不弹系统 toast——网页上没有，原生上又太重
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const take = async () => {
    if (!client || !path || taking) return;
    setTaking(true);
    try {
      await downloadSessionFile(client, key, path, name);
      haptics.success();
    } catch (e) {
      haptics.fail();
      setToast((e as Error).message);
    } finally {
      setTaking(false);
    }
  };

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(path ?? '');
      setToast('路径已复制');
    } catch {
      setToast('复制失败');
    }
  };

  /** 放进这个会话的输入框，然后回到会话。草稿是按会话存的（store/drafts），回去就在 */
  const insert = () => {
    if (!path) return;
    const prev = draftText(key);
    const sep = prev && !/\s$/.test(prev) ? ' ' : '';
    setDraftText(key, `${prev}${sep}${path} `);
    router.dismissTo({ pathname: '/session/[key]', params: { key } });
  };

  const dir = path && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const web = Platform.OS === 'web';

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {body.kind === 'text' && !(md && rendered) ? (
        <Lines
          t={t}
          text={body.text}
          top={barH}
          bottom={inset.bottom + 96}
          header={<Head t={t} name={name} dir={dir} size={size} md={md} rendered={rendered} onRendered={setRendered} truncated={body.truncated} />}
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: barH, paddingBottom: inset.bottom + 96 }}>
          <Head
            t={t} name={name} dir={dir} size={size} md={md && body.kind === 'text'}
            rendered={rendered} onRendered={setRendered} truncated={body.kind === 'text' && body.truncated}
          />
          {body.kind === 'loading' ? <ActivityIndicator style={{ marginTop: 48 }} color={t.c.txTertiary} /> : null}
          {body.kind === 'text' ? <View style={s.md}><Markdown text={body.text} /></View> : null}
          {body.kind === 'image' ? <Picture uri={body.uri} headers={body.headers} /> : null}
          {body.kind === 'none' || body.kind === 'error' ? (
            <View style={s.none}>
              <View style={s.noneTile}><IconFile size={34} color={t.c.txTertiary} /></View>
              <Text style={[s.noneTx, body.kind === 'error' && { color: t.c.txDanger }]}>
                {body.kind === 'none' ? body.why : body.message}
              </Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      <ScrollEdge height={barH} />
      <FloatBar onBack={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/files/[key]', params: { key, path: dir } }))} />

      {/* 底部浮着的三颗。玻璃一整条，和选择模式那条同一个形制 */}
      <View style={[s.actions, { paddingBottom: Math.max(12, inset.bottom) }]} pointerEvents="box-none">
        {toast ? <Text style={s.toast}>{toast}</Text> : null}
        <Glass radius={26} style={[s.actInner, t.shadow]}>
          <Action t={t} label={web ? '下载' : '存储'} onPress={() => void take()} busy={taking}
            icon={web ? <IconDownload size={18} color={t.c.txPrimary} /> : <IconShare size={18} color={t.c.txPrimary} />} />
          <Action t={t} label="复制路径" onPress={() => void copy()} icon={<IconCopy size={18} color={t.c.txPrimary} />} />
          <Action t={t} label="放进输入框" onPress={insert} icon={<IconPlus size={18} color={t.c.txPrimary} />} />
        </Glass>
      </View>
    </View>
  );
}

function Head({
  t, name, dir, size, md, rendered, onRendered, truncated,
}: {
  t: Theme; name: string; dir: string; size: number | null; md: boolean;
  rendered: boolean; onRendered: (v: boolean) => void; truncated: boolean;
}) {
  const s = styles(t);
  return (
    <View style={s.head}>
      <Text style={s.title} selectable>{name}</Text>
      <Text style={s.meta} numberOfLines={1} ellipsizeMode="head">
        {[size !== null ? fmtSize(size) : '', dir ? `${dir}/` : '工作目录根'].filter(Boolean).join(' · ')}
      </Text>
      {md ? (
        <View style={s.chips}>
          <Chip label="渲染" on={rendered} onPress={() => onRendered(true)} />
          <Chip label="源码" on={!rendered} onPress={() => onRendered(false)} />
        </View>
      ) : null}
      {truncated ? <Text style={s.warn}>只显示了前 1 MB。</Text> : null}
    </View>
  );
}

/**
 * 带行号的正文，一行一项虚拟化。行号列宽按总行数定，免得 999 → 1000 时整列跳一下。
 * 长行折行而不是横向滚：手机上左右来回拖着读代码比折行难受得多。
 */
function Lines({
  t, text, top, bottom, header,
}: { t: Theme; text: string; top: number; bottom: number; header: React.ReactElement }) {
  const s = styles(t);
  const lines = useMemo(() => text.replace(/\r\n?/g, '\n').split('\n'), [text]);
  const gutter = Math.max(2, String(lines.length).length) * 8 + 10;
  return (
    <FlatList
      data={lines}
      keyExtractor={(_, i) => String(i)}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingTop: top, paddingBottom: bottom }}
      initialNumToRender={60}
      maxToRenderPerBatch={80}
      windowSize={15}
      renderItem={({ item, index }) => (
        <View style={s.line}>
          <Text style={[s.ln, { width: gutter }]}>{index + 1}</Text>
          <Text style={s.code} selectable>{item || ' '}</Text>
        </View>
      )}
    />
  );
}

/** 按原比例铺满宽度。比例要等图到了才知道，之前先给一块 4:3 的底 */
function Picture({ uri, headers }: { uri: string; headers?: Record<string, string> }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [ratio, setRatio] = useState(4 / 3);
  const [failed, setFailed] = useState(false);
  const w = width - t.space.pad * 2;
  if (failed) return <Text style={styles(t).noneTx}>图片解不出来。</Text>;
  return (
    <Image
      source={headers ? { uri, headers } : { uri }}
      style={{ width: w, height: Math.min(w / ratio, 1400), alignSelf: 'center', borderRadius: t.radius.lg, backgroundColor: t.c.bgSecondary }}
      resizeMode="contain"
      onLoad={(e) => {
        const src = e.nativeEvent.source as { width?: number; height?: number } | undefined;
        if (src?.width && src?.height) setRatio(src.width / src.height);
      }}
      onError={() => setFailed(true)}
      accessibilityIgnoresInvertColors
    />
  );
}

function Action({
  t, label, icon, onPress, busy,
}: { t: Theme; label: string; icon: React.ReactNode; onPress: () => void; busy?: boolean }) {
  const s = styles(t);
  return (
    <Tappable style={s.act} onPress={onPress} haptic={haptics.tap} disabled={busy} accessibilityRole="button" accessibilityLabel={label}>
      {busy ? <ActivityIndicator size="small" color={t.c.txPrimary} /> : icon}
      <Text style={s.actTx}>{label}</Text>
    </Tappable>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    head: { paddingHorizontal: t.space.pad, paddingTop: 6, paddingBottom: 14, gap: 4 },
    title: {
      fontFamily: t.fonts.sans, fontSize: t.size.lg, fontWeight: t.weight.bold, color: t.c.txPrimary,
    },
    meta: { fontFamily: t.fonts.mono, fontSize: 12, color: t.c.txTertiary },
    chips: { flexDirection: 'row', gap: 8, marginTop: 8 },
    warn: { fontFamily: t.fonts.sans, fontSize: 12, color: t.c.txWarning, marginTop: 4 },
    md: { paddingHorizontal: t.space.pad },

    line: { flexDirection: 'row', paddingRight: t.space.pad },
    ln: {
      fontFamily: t.fonts.mono, fontSize: 12, lineHeight: 19, color: t.c.txTertiary, opacity: 0.6,
      textAlign: 'right', paddingRight: 10,
    },
    code: { flex: 1, fontFamily: t.fonts.mono, fontSize: 12.5, lineHeight: 19, color: t.c.txPrimary },

    none: { alignItems: 'center', gap: 14, paddingTop: 48, paddingHorizontal: 36 },
    noneTile: {
      width: 72, height: 72, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
      backgroundColor: t.c.bgSecondary,
    },
    noneTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, lineHeight: 22, color: t.c.txTertiary, textAlign: 'center' },

    actions: {
      position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: t.z.dock,
      paddingHorizontal: 12, alignItems: 'stretch', gap: 8,
    },
    toast: {
      alignSelf: 'center', overflow: 'hidden',
      fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txInverse,
      backgroundColor: t.c.bgInverse, borderRadius: t.radius.full, paddingHorizontal: 14, paddingVertical: 7,
    },
    actInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', minHeight: 60, paddingVertical: 4 },
    act: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, minHeight: 52, borderRadius: 20 },
    actTx: { fontFamily: t.fonts.sans, fontSize: 11.5, color: t.c.txSecondary },
  });
