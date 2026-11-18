import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme, type Theme } from '@/theme';
import { IconPlus, IconRight, IconTick } from '@/icons';
import { Chip, Sheet, SheetP, Tappable } from './ui';
import { BatonError, type Client } from '@/api/client';
import type { DirListing } from '@/api/types';
import * as haptics from '@/feedback/haptics';

/**
 * 选工作目录。
 *
 * 两段：**快捷**是服务端给的那份 `cwds`（最常用，一步到位）；**浏览**是真的走
 * 目录树，走到哪一层都能就地选它，也能新建文件夹。
 *
 * ## 这里没有、也不该有任何「我是不是访客」的分支
 *
 * 服务端按调用者收窄过了：owner 的起点是盘符加他用过的目录，访客的起点是他自己的
 * 工作区根；`parent` 为 null 的位置两种人不同，但 UI 只管「null 就禁用上一级」。
 * 加身份判断不但多余，而且会错——客户端并不知道服务端按什么规则收的窄。
 *
 * ## 起点为什么要打接口而不是自己拼盘符
 *
 * 拼出来的东西对访客是错的，而且拼完还得再判一次身份。起点 `path` 为 `null`，
 * 表示「这是一组入口，不是某个目录的内容」——所以那一屏没有「用这个目录」。
 *
 * ## readable:false 必须是不可点的
 *
 * 服务端已经知道点进去会失败，让人点了才报错等于把已知的事瞒到最后一刻。
 */

export function DirSheet({
  open, onClose, client, quick, current, onPick,
}: {
  open: boolean;
  onClose: () => void;
  client: Client | null;
  /** `GET /api/sessions` 给的 `cwds`。 */
  quick: string[];
  current: string | null;
  onPick: (dir: string) => void;
}) {
  const t = useTheme();
  const s = styles(t);

  const [browsing, setBrowsing] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; fix: string } | null>(null);
  /**
   * 「新建文件夹」能不能用。归在 allowSend 之下——它往 owner 的磁盘上写东西，
   * 和传文件同一条纪律。`/api/health` 返回的是**调用者自己的**有效值。
   */
  const [allowSend, setAllowSend] = useState<boolean | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const load = useCallback(async (path: string | null) => {
    if (!client) return;
    setBusy(true);
    setErr(null);
    try {
      setListing(await client.dirs(path));
    } catch (e) {
      // fix 一律用服务端给的：越界那条里写着访客自己的工作区在哪，
      // 客户端编不出来，编了也会和后端说的不一致。
      if (e instanceof BatonError) setErr({ msg: e.message, fix: e.fix });
      else setErr({ msg: (e as Error).message, fix: '' });
    } finally {
      setBusy(false);
    }
  }, [client]);

  // 关上再打开时回到快捷那一段：上次翻到哪儿了不是需要被记住的东西，
  // 而停在深处会让人以为选中的就是那一层。
  useEffect(() => {
    if (!open) { setBrowsing(false); setNaming(false); setErr(null); }
  }, [open]);

  useEffect(() => {
    if (!open || !browsing) return;
    load(null);
    client?.health().then((h) => setAllowSend(h.allowSend)).catch(() => setAllowSend(null));
  }, [open, browsing, load, client]);

  async function create() {
    const n = name.trim();
    if (!client || !listing?.path || !n || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // created:false（本来就存在）也是成功，照常刷新——不当错误报
      const made = await client.makeDir(joinPath(listing.path, n));
      haptics.success();
      setNaming(false);
      setName('');
      // 服务端返回的是**归一化之后**的路径，进这一层用它的，不用我拼的那个
      await load(made.path);
    } catch (e) {
      haptics.fail();
      if (e instanceof BatonError) setErr({ msg: e.message, fix: e.fix });
      else setErr({ msg: (e as Error).message, fix: '' });
      setBusy(false);
    }
  }

  const at = listing?.path ?? null;

  return (
    <Sheet open={open} onClose={onClose} title={browsing ? '浏览目录' : '在哪个目录'}>
      {browsing ? (
        <>
          <View style={s.bar}>
            <Tappable
              style={[s.up, !listing?.parent && s.off]}
              disabled={!listing?.parent || busy}
              onPress={() => load(listing?.parent ?? null)}
              accessibilityRole="button"
              accessibilityLabel="上一级"
            >
              <View style={s.back}><IconRight size={13} color={t.c.txPrimary} /></View>
            </Tappable>
            <Text style={s.at} numberOfLines={1} ellipsizeMode="head">{at ?? '起点'}</Text>
          </View>

          {err ? <Warn t={t} msg={err.msg} fix={err.fix} /> : null}

          <ScrollView style={s.list} contentContainerStyle={s.listBody}>
            {listing?.dirs.length === 0 && !busy ? (
              <Text style={s.empty}>这一层没有子目录。</Text>
            ) : null}
            {listing?.dirs.map((d, i) => (
              <Tappable
                key={d.path}
                style={[s.row, i > 0 && s.line, !d.readable && s.off]}
                feedback={d.readable ? 'fill' : 'none'}
                // readable:false 不是「点了会报错」，是**点不了**
                disabled={!d.readable || busy}
                onPress={() => load(d.path)}
                accessibilityRole="button"
                accessibilityState={{ disabled: !d.readable }}
              >
                <Text style={s.rowTx} numberOfLines={1}>{d.name}</Text>
                {d.readable ? <IconRight size={13} color={t.c.txTertiary} /> : null}
              </Tappable>
            ))}
          </ScrollView>

          {naming ? (
            <View style={s.nameRow}>
              <TextInput
                style={s.input}
                value={name}
                onChangeText={setName}
                onSubmitEditing={create}
                placeholder="文件夹名"
                placeholderTextColor={t.c.txTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                accessibilityLabel="新文件夹的名字"
              />
              <Chip label="建" onPress={create} />
              <Chip label="取消" onPress={() => { setNaming(false); setName(''); }} />
            </View>
          ) : (
            <View style={s.acts}>
              {/* 起点没有「用这个目录」：那一屏不是某个目录的内容 */}
              {at ? (
                <Tappable
                  style={s.use}
                  haptic={haptics.select}
                  onPress={() => { onPick(at); onClose(); }}
                  accessibilityRole="button"
                >
                  <Text style={s.useTx}>用这个目录</Text>
                </Tappable>
              ) : null}
              {at && allowSend !== false ? (
                <Tappable
                  style={s.new}
                  onPress={() => setNaming(true)}
                  accessibilityRole="button"
                >
                  <IconPlus size={13} color={t.c.txPrimary} />
                  <Text style={s.newTx}>新建文件夹</Text>
                </Tappable>
              ) : null}
            </View>
          )}

          {at && allowSend === false ? (
            <SheetP>这台电脑是只读模式，建不了文件夹。已有的目录照样能选。</SheetP>
          ) : null}
        </>
      ) : (
        <>
          <View style={s.list}>
            {quick.length === 0 ? (
              <Text style={s.empty}>还没有可用的快捷目录，去浏览里挑一个。</Text>
            ) : null}
            {quick.map((d, i) => (
              <Tappable
                key={d}
                style={[s.row, i > 0 && s.line]}
                feedback="fill"
                haptic={haptics.select}
                onPress={() => { onPick(d); onClose(); }}
                accessibilityRole="button"
                accessibilityState={{ selected: d === current }}
              >
                <Text style={[s.path, d === current && { fontWeight: t.weight.bold }]} numberOfLines={1}>
                  {d}
                </Text>
                {d === current ? <IconTick size={15} color={t.c.txPrimary} /> : null}
              </Tappable>
            ))}
          </View>

          <View style={s.acts}>
            <Tappable style={s.use} onPress={() => setBrowsing(true)} accessibilityRole="button">
              <Text style={s.useTx}>浏览其它目录</Text>
            </Tappable>
          </View>
        </>
      )}
    </Sheet>
  );
}

/** 面板里的报错。用服务端的 fix 原文——越界那条里写着工作区在哪。 */
function Warn({ t, msg, fix }: { t: Theme; msg: string; fix: string }) {
  const s = styles(t);
  return (
    <View style={s.warn}>
      <Text style={s.warnTx}>{msg}</Text>
      {fix ? <Text style={s.warnFix}>{fix}</Text> : null}
    </View>
  );
}

/**
 * 拼路径。分隔符**照 base 里已有的那个**来，不按平台猜——这条路径来自服务端，
 * 那台电脑是 Windows 还是 POSIX 由它说了算，手机这边无从判断。
 * 盘符根（`C:\`）本身就以分隔符结尾，再加一个会拼出 `C:\\x`。
 */
export function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

const styles = (t: Theme) =>
  StyleSheet.create({
    bar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    up: {
      width: 34, height: 34, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.bgSecondary,
    },
    // 图标库里只有向右的箭头，转 180° 当返回用，不为这一处再描一个
    back: { transform: [{ rotate: '180deg' }] },
    at: { flex: 1, fontFamily: t.fonts.mono, fontSize: t.size.xs, color: t.c.txSecondary },
    off: { opacity: 0.35 },

    list: {
      backgroundColor: t.c.bgSecondary, borderRadius: t.radius.xl,
      overflow: 'hidden', maxHeight: 260,
    },
    listBody: { paddingBottom: 0 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 15, paddingVertical: 12, minHeight: t.space.tap,
    },
    line: { borderTopWidth: t.hairline, borderTopColor: t.c.bdTertiary },
    rowTx: { flex: 1, fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txPrimary },
    path: { flex: 1, fontFamily: t.fonts.mono, fontSize: t.size.xs, color: t.c.txPrimary },
    empty: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, color: t.c.txTertiary,
      paddingHorizontal: 15, paddingVertical: 14,
    },

    acts: { flexDirection: 'row', gap: 8, marginTop: 12 },
    use: {
      flex: 1, minHeight: t.space.tap, borderRadius: t.radius.full,
      alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.bgInverse,
    },
    useTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.sm,
      fontWeight: t.weight.bold, color: t.c.txInverse,
    },
    new: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 16, minHeight: t.space.tap, borderRadius: t.radius.full,
      justifyContent: 'center', backgroundColor: t.c.bgSecondary,
    },
    newTx: { fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txPrimary },

    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
    input: {
      flex: 1, minHeight: t.space.tap, paddingHorizontal: 14,
      borderRadius: t.radius.full, backgroundColor: t.c.bgSecondary,
      fontFamily: t.fonts.sans, fontSize: t.size.sm, color: t.c.txPrimary,
    },

    warn: {
      marginTop: 10, paddingHorizontal: 14, paddingVertical: 10,
      borderRadius: t.radius.lg, backgroundColor: t.c.bgWarning,
    },
    warnTx: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs,
      fontWeight: t.weight.bold, color: t.c.txPrimary,
    },
    warnFix: {
      fontFamily: t.fonts.sans, fontSize: t.size.xs, lineHeight: 18,
      color: t.c.txSecondary, marginTop: 2,
    },
  });
