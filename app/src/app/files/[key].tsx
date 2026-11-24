import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Animated, FlatList, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '@/theme';
import {
  IconArchive, IconClose, IconCode, IconDownload, IconFile, IconFolder, IconImage, IconLines, IconRefresh,
  IconRight, IconSearch, IconShare, IconSort, IconTick,
} from '@/icons';
import { FloatBar, PillGlass, Tappable, useFloatBarHeight, useHydrated } from '@/components/ui';
import { Glass, useGlassPath } from '@/components/Glass';
import { ScrollEdge } from '@/components/ScrollEdge';
import * as haptics from '@/feedback/haptics';
import { useReduceMotion } from '@/a11y/motion';
import { DUR, EASE_OUT } from '@/motion/curves';
import { useConnection } from '@/store/connection';
import { downloadSessionFile } from '@/store/download';
import {
  FLATTEN_CAP, SORT_LABEL, arrange, baseName, cachedListing, clearPick, crumbsOf, fetchListing, flattenPicked,
  fmtSize, fmtTime, invalidListing, joinRel, kindOf, setSelecting, togglePick, useFileAccess, useFilePick, type FileKind, type SortKey,
} from '@/store/files';
import { BatonError } from '@/api/client';
import type { FileEntry, FileListing } from '@/api/types';

/**
 * 这个会话工作目录里的文件浏览器。**每一层是一屏。**
 *
 * ## 2026-11-15 重做（owner：「手机的文件浏览器用着很难受」）
 *
 * 原来是一块底部面板，难受在这几处，逐条对着改：
 *
 *   面板里套一个限高 360 的滚动区     → 整屏列表，FlatList 虚拟化，上千条也不卡
 *   只显示当前这一层的名字            → 大标题 + 能点的面包屑，点哪一段回哪一层
 *   「上一级」是一颗 28pt 的小圆钮     → 每层一屏的栈：左上返回、原生边缘右滑、
 *                                        网页浏览器后退，都是「上一级」
 *   点文件 = 勾上它，想看内容只能下载  → 点文件 = 预览（文本带行号、Markdown 能渲染、
 *                                        图片直接看），预览页里再下载 / 复制路径 / 放进输入框
 *   勾选框 18pt、行没有时间            → 勾选是一个模式（右上「选择」或长按进入），
 *                                        整行都是命中区；每行第二行是大小和修改时间
 *   没有筛选和排序                    → 顶上一个筛选框，排序在名称 / 时间 / 大小之间切
 *
 * 形制照 iOS「文件」App：大标题、搜索框在列表顶上、长按进选择、底部浮着操作条。
 *
 * ## 范围还是服务端锁的
 *
 * 只看得到这个会话的工作目录（src/sessionfs.js 的 realpath 包含性校验）。这里不做
 * 任何路径检查——客户端的检查是假的。`.git`、`node_modules` 照列，见服务端抬头。
 */

const ROW_H = 60;

/** 预渲染那一份拿不到 ?path=，先出空壳，水合完再出内容（见 useHydrated） */
export default function FilesScreen() {
  const t = useTheme();
  const hydrated = useHydrated();
  const revision = useFileAccess((s) => s.revision);
  const route = useLocalSearchParams<{ key: string; path?: string }>();
  if (!hydrated) return <View style={{ flex: 1, backgroundColor: t.c.bgTertiary }} />;
  return <FilesBody key={JSON.stringify([revision, route.key, route.path])} />;
}

function FilesBody() {
  const t = useTheme();
  const s = styles(t);
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const barH = useFloatBarHeight();
  const reduceMotion = useReduceMotion();
  const { key, path: rawPath } = useLocalSearchParams<{ key: string; path?: string }>();
  const path = typeof rawPath === 'string' ? rawPath : '';
  const client = useConnection((c) => c.client);

  const [data, setData] = useState<FileListing | null>(() => cachedListing(key, path));
  const [err, setErr] = useState<string | null>(null);
  // 没有缓存时一进来就在问，所以初值跟着缓存走——不在 effect 里同步 set
  const [busy, setBusy] = useState(() => !cachedListing(key, path));
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [searchFocus, setSearchFocus] = useState(false);
  const [sort, setSort] = useState<SortKey>('name');
  const [now, setNow] = useState(() => Date.now());
  /** 正在下载第几个 / 共几个。null = 没在下载 */
  const [taking, setTaking] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const pick = useFilePick();
  const mine = pick.key === key;
  const selecting = mine && pick.selecting;
  const picked = useMemo(() => (mine ? pick.picked : {}), [mine, pick.picked]);
  const pickedN = Object.keys(picked).length;

  // 列表第一次到的时候淡入；有缓存时直接摆出来，不再演一遍
  const [fade] = useState(() => new Animated.Value(data ? 1 : 0));

  const load = useCallback(async (mode: 'first' | 'pull' | 'quiet') => {
    if (!client || !key) return;
    if (mode === 'pull') setRefreshing(true); else if (mode === 'first') setBusy(true);
    try {
      const d = await fetchListing(client, key, path);
      setData(d);
      setErr(null);
      setNow(Date.now());
    } catch (e) {
      if (e instanceof Error && e.message === 'stale_listing') return;
      if (invalidListing(e)) setData(null);
      setErr(e instanceof BatonError ? `${e.message}${e.fix ? `　${e.fix}` : ''}` : (e as Error).message);
    } finally {
      setBusy(false);
      setRefreshing(false);
    }
  }, [client, key, path]);

  // 有缓存就安静地后台刷新，没有就转圈。目录内容随时在变（agent 正在写），所以每次进来都问
  // 转圈与否由 busy 的初值决定，这里只管去问（quiet 不同步 set 任何状态）
  useEffect(() => { void load('quiet'); }, [load]);

  useEffect(() => {
    if (!data) return;
    Animated.timing(fade, { toValue: 1, duration: DUR.toggle, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [data, fade]);

  // 离开整个浏览器（根那一层卸载）时清掉勾选：下次进来是新的一轮挑选
  useEffect(() => (path === '' ? () => clearPick() : undefined), [path]);

  const rootName = data ? baseName(data.cwd) : '…';
  const title = path ? baseName(path) : rootName;
  const crumbs = useMemo(() => crumbsOf(path, rootName), [path, rootName]);
  const rows = useMemo(() => (data ? arrange(data.entries, sort, filter) : []), [data, sort, filter]);
  const counts = useMemo(() => {
    const dirs = data?.entries.filter((e) => e.dir).length ?? 0;
    return { dirs, files: (data?.entries.length ?? 0) - dirs };
  }, [data]);

  const open = useCallback((e: FileEntry) => {
    const rel = joinRel(path, e.name);
    if (selecting) { haptics.select(); togglePick(key, rel, e.dir); return; }
    if (e.dir) router.push({ pathname: '/files/[key]', params: { key, path: rel } });
    else router.push({ pathname: '/file/[key]', params: { key, path: rel, size: String(e.size ?? '') } });
  }, [key, path, router, selecting]);

  const longPress = useCallback((e: FileEntry) => {
    haptics.select();
    togglePick(key, joinRel(path, e.name), e.dir);
  }, [key, path]);

  /** 面包屑：回到栈上那一层；栈上没有（比如网页刷新后直接落在深层）就换成那一层 */
  const goCrumb = useCallback((to: string) => {
    if (to === path) return;
    router.dismissTo({ pathname: '/files/[key]', params: { key, path: to } });
  }, [key, path, router]);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/session/[key]', params: { key } });
  }, [key, router]);

  /**
   * 下载勾中的。**一个一个来**：原生上每一个都会拉起一次系统分享面板，并发等于把好几张
   * 面板叠在一起——iOS 会直接拒掉后面的（见 AttachMenu 抬头那个坑）。
   */
  const take = useCallback(async () => {
    if (!client || !pickedN) return;
    setNote(null);
    let files: string[];
    let truncated = false;
    try {
      ({ files, truncated } = await flattenPicked((p) => fetchListing(client, key, p), picked));
    } catch (x) {
      haptics.fail();
      setNote((x as Error).message);
      return;
    }
    if (!files.length) { haptics.warn(); setNote('勾中的目录里没有文件。'); return; }
    setTaking({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i += 1) {
        await downloadSessionFile(client, key, files[i], files[i].split('/').pop() || files[i]);
        setTaking({ done: i + 1, total: files.length });
      }
      haptics.success();
      setSelecting(key, false);
      if (truncated) setNote(`一次最多取 ${FLATTEN_CAP} 个文件，后面的没有取。`);
    } catch (x) {
      haptics.fail();
      setNote((x as Error).message);
    } finally {
      setTaking(null);
    }
  }, [client, key, picked, pickedN]);

  const listHeader = (
    <View>
      {/* 大标题 + 面包屑。面包屑只在不在根上时出现：根上它只有一段，和大标题重复 */}
      <Text style={s.title} numberOfLines={2}>{title}</Text>
      {path ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.crumbs}
          style={s.crumbsWrap}
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={c.path || '/'} style={s.crumbItem}>
                {i > 0 ? <IconRight size={11} color={t.c.txTertiary} strokeWidth={2.2} /> : null}
                <Tappable
                  onPress={() => goCrumb(c.path)}
                  disabled={last}
                  feedback="dim"
                  style={s.crumbHit}
                  accessibilityRole="link"
                  accessibilityLabel={i === 0 ? `回到工作目录 ${c.name}` : `回到 ${c.name}`}
                >
                  <Text style={[s.crumb, last && s.crumbLast]} numberOfLines={1}>{c.name}</Text>
                </Tappable>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <Text style={s.cwd} numberOfLines={1} ellipsizeMode="middle">{data?.cwd ?? ' '}</Text>
      )}

      <View style={s.tools}>
        <View style={[s.search, searchFocus && s.searchFocus]}>
          {/* 包一层不让它被挤：网页上 TextInput 自带固有宽度，flex 行里 svg 会被压成几个像素 */}
          <View style={s.searchIcon}><IconSearch size={15} color={searchFocus ? t.c.coral : t.c.txTertiary} /></View>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setSearchFocus(false)}
            placeholder={`在「${title}」里筛选`}
            placeholderTextColor={t.c.txTertiary}
            style={s.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
            accessibilityLabel="按名字筛选"
          />
          {filter ? (
            <Tappable onPress={() => setFilter('')} style={s.searchClear} accessibilityRole="button" accessibilityLabel="清空筛选">
              <IconClose size={13} color={t.c.txTertiary} strokeWidth={2.2} />
            </Tappable>
          ) : null}
        </View>
        <Tappable
          style={s.toolBtn}
          haptic={haptics.select}
          onPress={() => setSort((x) => (x === 'name' ? 'mtime' : x === 'mtime' ? 'size' : 'name'))}
          accessibilityRole="button"
          accessibilityLabel={`排序：${SORT_LABEL[sort]}，点一下换`}
        >
          <IconSort size={15} color={t.c.txSecondary} />
          <Text style={s.toolTx}>{SORT_LABEL[sort]}</Text>
        </Tappable>
        {/* 网页上没有下拉刷新，给一颗按钮；原生上下拉就行，不占位置 */}
        {Platform.OS === 'web' ? (
          <Tappable
            style={[s.toolBtn, s.toolIcon]}
            onPress={() => void load('pull')}
            disabled={busy || refreshing}
            accessibilityRole="button"
            accessibilityLabel="刷新"
          >
            {refreshing ? <ActivityIndicator size="small" color={t.c.txTertiary} /> : <IconRefresh size={15} color={t.c.txSecondary} />}
          </Tappable>
        ) : null}
      </View>

      {err ? (
        <View style={s.errBox}>
          <Text style={s.errTx}>{err}</Text>
          <Tappable style={s.retry} onPress={() => void load('first')} accessibilityRole="button">
            <Text style={s.retryTx}>重试</Text>
          </Tappable>
        </View>
      ) : null}
    </View>
  );

  const empty = busy ? (
    <View style={s.emptyBox}><ActivityIndicator color={t.c.txTertiary} /></View>
  ) : data && !err ? (
    <View style={s.emptyBox}>
      <IconFolder size={30} color={t.c.txTertiary} />
      <Text style={s.emptyTx}>{filter ? `没有名字里带「${filter}」的` : '这个目录是空的'}</Text>
    </View>
  ) : null;

  const footer = data && rows.length ? (
    <Text style={s.count}>
      {[counts.dirs ? `${counts.dirs} 个文件夹` : '', counts.files ? `${counts.files} 个文件` : ''].filter(Boolean).join('，')}
      {filter ? `　筛出 ${rows.length} 项` : ''}
    </Text>
  ) : null;

  const bottomPad = (selecting ? 86 : 24) + inset.bottom;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <Animated.View style={{ flex: 1, opacity: fade }}>
        <FlatList
          data={rows}
          keyExtractor={(e) => e.name}
          renderItem={({ item }) => (
            <Row
              t={t}
              e={item}
              now={now}
              selecting={selecting}
              on={joinRel(path, item.name) in picked}
              onPress={open}
              onLongPress={longPress}
            />
          )}
          getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          contentContainerStyle={[s.listContent, { paddingTop: barH, paddingBottom: bottomPad }]}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
          windowSize={11}
          removeClippedSubviews={Platform.OS !== 'web'}
          refreshControl={Platform.OS === 'web' ? undefined : (
            <RefreshControl refreshing={refreshing} onRefresh={() => void load('pull')} tintColor={t.c.txTertiary} />
          )}
        />
      </Animated.View>

      <ScrollEdge height={barH} />
      <FloatBar
        onBack={back}
        right={(
          <PillGlass
            label={selecting ? '完成' : '选择'}
            onPress={() => setSelecting(key, !selecting)}
          />
        )}
      />

      {selecting ? (
        <>
          <ScrollEdge edge="bottom" height={Math.max(12, inset.bottom) + 78} />
          <SelectBar
            t={t}
            n={pickedN}
            taking={taking}
            note={note}
            bottom={inset.bottom}
            reduceMotion={reduceMotion}
            onClearAll={() => useFilePick.setState({ picked: {} })}
            onTake={() => void take()}
          />
        </>
      ) : null}
    </View>
  );
}

// ── 一行 ────────────────────────────────────────

const KIND_ICON: Record<FileKind, (p: { size: number; color: string }) => React.ReactElement> = {
  dir: IconFolder, image: IconImage, code: IconCode, config: IconLines, doc: IconLines, archive: IconArchive, file: IconFile,
};

function Row({
  t, e, now, selecting, on, onPress, onLongPress,
}: {
  t: Theme; e: FileEntry; now: number; selecting: boolean; on: boolean;
  onPress: (e: FileEntry) => void; onLongPress: (e: FileEntry) => void;
}) {
  const s = styles(t);
  const kind = kindOf(e);
  const Icon = KIND_ICON[kind];
  const meta = e.dir
    ? fmtTime(e.mtime, now)
    : [fmtSize(e.size), fmtTime(e.mtime, now)].filter(Boolean).join(' · ');
  return (
    <Tappable
      style={[s.row, on && { backgroundColor: t.c.accentSoft }]}
      feedback="fill"
      onPress={() => onPress(e)}
      onLongPress={() => onLongPress(e)}
      delayLongPress={380}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: on } : undefined}
      accessibilityLabel={e.dir ? `文件夹 ${e.name}` : e.name}
      accessibilityHint={selecting ? undefined : '长按进入选择'}
    >
      {selecting ? (
        <View style={[s.check, on && s.checkOn]}>
          {on ? <IconTick size={12} color="#ffffff" strokeWidth={2.6} /> : null}
        </View>
      ) : null}
      <View style={[s.tile, kind === 'dir' && { backgroundColor: t.c.accentSoft }]}>
        <Icon size={18} color={kind === 'dir' ? t.c.coral : t.c.txSecondary} />
      </View>
      <View style={s.rowBody}>
        <Text style={s.name} numberOfLines={1} ellipsizeMode="middle">{e.name}</Text>
        {meta ? <Text style={s.meta} numberOfLines={1}>{meta}</Text> : null}
      </View>
      {e.dir && !selecting ? <IconRight size={14} color={t.c.txTertiary} /> : null}
    </Tappable>
  );
}

// ── 选择模式的底部条 ─────────────────────────────

function SelectBar({
  t, n, taking, note, bottom, reduceMotion, onClearAll, onTake,
}: {
  t: Theme; n: number; taking: { done: number; total: number } | null; note: string | null;
  bottom: number; reduceMotion: boolean;
  onClearAll: () => void; onTake: () => void;
}) {
  const s = styles(t);
  const glassPath = useGlassPath();
  // 从底下升上来一小段。减弱动效下只淡入
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: DUR.toggle, easing: EASE_OUT, useNativeDriver: true }).start();
  }, [v]);
  const web = Platform.OS === 'web';
  return (
    <Animated.View
      style={[
        s.selBar,
        { paddingBottom: Math.max(12, bottom), opacity: v },
        reduceMotion ? null : { transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
      ]}
      pointerEvents="box-none"
    >
      <Glass radius={26} style={[s.selInner, glassPath === 'opaque' && t.shadow]}>
        <View style={s.selText}>
          <Text style={s.selN} numberOfLines={1}>
            {taking ? `正在取 ${taking.done}/${taking.total}` : n ? `已选 ${n} 项` : '点行勾选，文件夹也能勾'}
          </Text>
          {note ? <Text style={s.selNote} numberOfLines={2}>{note}</Text> : null}
        </View>
        {n > 0 && !taking ? (
          <Tappable onPress={onClearAll} style={s.selClear} accessibilityRole="button">
            <Text style={s.selClearTx}>清空</Text>
          </Tappable>
        ) : null}
        <Tappable
          style={[s.selGo, (!n || taking) && { opacity: 0.4 }]}
          onPress={onTake}
          disabled={!n || taking !== null}
          haptic={haptics.tap}
          accessibilityRole="button"
          accessibilityLabel={web ? '下载勾中的' : '存储勾中的'}
        >
          {taking
            ? <ActivityIndicator size="small" color={t.c.txInverse} />
            : web ? <IconDownload size={16} color={t.c.txInverse} /> : <IconShare size={16} color={t.c.txInverse} />}
          <Text style={s.selGoTx}>{web ? '下载' : '存储'}</Text>
        </Tappable>
      </Glass>
    </Animated.View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.c.bgTertiary },
    listContent: {
      width: '100%',
      maxWidth: t.layout.contentMaxW,
      alignSelf: 'center',
    },

    title: {
      fontFamily: t.fonts.sans, fontSize: t.size.xl, fontWeight: t.weight.bold, letterSpacing: -0.4,
      color: t.c.txPrimary, paddingHorizontal: t.space.pad, paddingTop: 6,
    },
    cwd: {
      fontFamily: t.fonts.mono, fontSize: 12, color: t.c.txTertiary,
      paddingHorizontal: t.space.pad, paddingTop: 4,
    },
    crumbsWrap: { flexGrow: 0, marginTop: 2 },
    crumbs: { paddingHorizontal: t.space.pad - 6, alignItems: 'center' },
    crumbItem: { flexDirection: 'row', alignItems: 'center' },
    // 每一段都是 34pt 高的命中区：字只有 13pt，按原样点不准
    crumbHit: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 6 },
    crumb: { fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txInfo, maxWidth: 180 },
    crumbLast: { color: t.c.txTertiary },

    tools: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: t.space.pad, paddingTop: 12, paddingBottom: 10,
    },
    search: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7,
      height: 42, borderRadius: 13, paddingLeft: 12, paddingRight: 4,
      backgroundColor: t.c.bgSecondary,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
    },
    searchFocus: {
      borderColor: t.c.coral,
    },
    // 16pt 是 iOS Safari 不放大页面的下限——小一点，一点进去整页就被拉近
    searchIcon: { flexShrink: 0, width: 15, height: 15 },
    searchInput: {
      flex: 1, minWidth: 0, fontFamily: t.fonts.sans, fontSize: 16, color: t.c.txPrimary, paddingVertical: 0,
      ...(Platform.OS === 'web' ? { outlineStyle: 'none' as never } : null),
    },
    searchClear: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.full },
    toolBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      height: 42, paddingHorizontal: 12, borderRadius: 13, backgroundColor: t.c.bgSecondary,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
    },
    toolIcon: { width: 42, paddingHorizontal: 0, justifyContent: 'center' },
    toolTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: '500', color: t.c.txSecondary },

    errBox: {
      marginHorizontal: t.space.pad, marginTop: 4, marginBottom: 6, padding: 12, gap: 8,
      borderRadius: t.radius.lg, backgroundColor: t.c.bgDanger,
    },
    errTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 19, color: t.c.txDanger },
    retry: { alignSelf: 'flex-start', paddingVertical: 4 },
    retryTx: { fontFamily: t.fonts.sans, fontSize: t.size.xs, fontWeight: t.weight.bold, color: t.c.txDanger },

    row: {
      height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingHorizontal: t.space.pad,
    },
    check: {
      width: 22, height: 22, borderRadius: 11,
      borderWidth: 1.5, borderColor: t.c.bdSecondary,
      alignItems: 'center', justifyContent: 'center',
    },
    checkOn: { backgroundColor: t.c.coral, borderColor: t.c.coral },
    tile: {
      width: 38, height: 38, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.bgSecondary,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
    },
    // 分隔线画在文字区底下、从文字起始处开始——iOS 列表就是这样，图标那一列不切
    rowBody: {
      flex: 1, alignSelf: 'stretch', justifyContent: 'center', gap: 2,
      borderBottomWidth: t.hairline, borderBottomColor: t.c.bdTertiary,
    },
    name: { fontFamily: t.fonts.sans, fontSize: 15.5, color: t.c.txPrimary },
    meta: { fontFamily: t.fonts.sans, fontSize: 12.5, color: t.c.txTertiary, fontVariant: ['tabular-nums'] },

    emptyBox: { alignItems: 'center', gap: 10, paddingTop: 56 },
    emptyTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txTertiary },
    count: {
      fontFamily: t.fonts.sans, fontSize: 12.5, color: t.c.txTertiary,
      textAlign: 'center', paddingVertical: 18,
    },

    selBar: {
      position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, zIndex: t.z.dock,
      alignItems: 'center',
    },
    selInner: {
      width: '100%', maxWidth: t.layout.contentMaxW,
      flexDirection: 'row', alignItems: 'center', gap: 10,
      minHeight: 56, paddingLeft: 18, paddingRight: 7, paddingVertical: 7,
    },
    selText: { flex: 1, gap: 2 },
    selN: { fontFamily: t.fonts.sans, fontSize: t.size.sm, fontWeight: t.weight.bold, color: t.c.txPrimary },
    selNote: { fontFamily: t.fonts.sans, fontSize: 12, color: t.c.txDanger },
    selClear: { minHeight: t.space.tap, justifyContent: 'center', paddingHorizontal: 8 },
    selClearTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txSecondary },
    selGo: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      height: 42, paddingHorizontal: 16, borderRadius: 21, backgroundColor: t.c.bgInverse,
    },
    selGoTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, fontWeight: t.weight.bold, color: t.c.txInverse },
  });
