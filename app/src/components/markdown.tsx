import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme, type Theme } from '@/theme';
import { IconCopy, IconTick } from '@/icons';
import { Tappable } from './ui';
import * as haptics from '@/feedback/haptics';
import { useLocale } from '@/i18n';

/**
 * Markdown 渲染。
 *
 * 之前只切段落 + 认一种「反引号」，于是 `**粗体**`、`## 标题`、`- 列表`、
 * 围栏代码块全都以原文出现在手机上——owner 实测发现的。agent 的回复几乎全是
 * markdown，不渲染等于把最主要的内容拿原始格式糊在屏幕上。
 *
 * **不引 markdown 库**，自己写一个够用的：
 *   - RN 没有 innerHTML，任何库最终也得把 AST 翻成 Text/View 树，省不掉
 *   - 常见库（react-native-markdown-display 之类）体积大、样式覆写困难，
 *     而这里要精确贴合已有的衬线排版
 *   - 需要支持的语法是可枚举的（见下），不是通用 markdown
 *
 * 支持：标题、粗体、斜体、**删除线**、行内代码、围栏代码块、无序/有序列表、
 *      **任务列表**、引用、分隔线、链接、**表格**、图片（退化成链接）。
 *
 * 表格、任务列表、删除线都是后补的。原来那句「agent 回复里极少」是错的，而且
 * 错得很容易验证：这个仓库里 agent 写的文档、聊天里的对照说明，几乎每篇都有
 * 表格；任务列表更是 agent 汇报进度的默认形式。owner 在手机上看到的就是一堆
 * `| --- | --- |` 和 `- [ ]` 的原文。
 *
 * **图片不真的加载**：agent 回复里的图片链接多半指向那台电脑上的本地文件，
 * 手机上取不到，渲染成一个碎图标不如给一条能点的链接诚实。
 */

// ── 块级 ────────────────────────────────────────

export type Align = 'left' | 'center' | 'right';

/** 列表项。`task` 为 null 表示这不是任务项；depth 是缩进层级（0 起）。 */
export type Item = { text: string; task: boolean | null; depth: number };

type Block =
  | { k: 'h'; level: number; text: string }
  | { k: 'p'; text: string }
  | { k: 'code'; lang: string; text: string }
  | { k: 'ul'; items: Item[] }
  | { k: 'ol'; items: Item[] }
  | { k: 'table'; head: string[]; rows: string[][]; align: Align[] }
  | { k: 'quote'; text: string }
  | { k: 'hr' };

/** `| a | b |` → ['a','b']。首尾的竖线是可选的，两种写法 agent 都会产出。 */
function cells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/** 分隔行长这样：`|---|:--:|---:|`。认出来才说明上一行是表头。 */
function alignOf(line: string): Align[] | null {
  if (!/\|/.test(line)) return null;
  const parts = cells(line);
  if (parts.length === 0) return null;
  const out: Align[] = [];
  for (const p of parts) {
    if (!/^:?-{1,}:?$/.test(p)) return null;
    const l = p.startsWith(':');
    const r = p.endsWith(':');
    out.push(l && r ? 'center' : r ? 'right' : 'left');
  }
  return out;
}

/** 任务记号：`- [ ]` / `- [x]`。返回 [是否勾选, 去掉记号后的正文]。 */
function taskOf(text: string): [boolean | null, string] {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return [null, text];
  return [m[1].toLowerCase() === 'x', m[2]];
}

export function parseBlocks(src: string): Block[] {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;

  const flushPara = (buf: string[]) => {
    const text = buf.join('\n').trim();
    if (text) out.push({ k: 'p', text });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块。**先于一切判断**：代码块里可能有 # - > 这些字符，
    // 它们在里面是内容不是语法。
    const fence = /^\s*```+\s*(\S*)/.exec(line);
    if (fence) {
      flushPara(para);
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾的围栏；没有收尾就正好停在末尾
      out.push({ k: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (/^\s*$/.test(line)) { flushPara(para); i += 1; continue; }

    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(para); out.push({ k: 'hr' }); i += 1; continue;
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(para);
      out.push({ k: 'h', level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    // 表格。判据是**下一行是分隔行**——只看本行有没有竖线会把
    // 「a | b 两种写法」这种普通句子误判成表格。
    const nextAlign = i + 1 < lines.length ? alignOf(lines[i + 1]) : null;
    if (nextAlign && /\|/.test(line)) {
      flushPara(para);
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        // 列数对不齐是常事（agent 手写的表格尤其）。补空、截长，
        // 不丢内容也不让某一行把整张表撑歪。
        const r = cells(lines[i]);
        while (r.length < head.length) r.push('');
        rows.push(r.slice(0, head.length));
        i += 1;
      }
      out.push({ k: 'table', head, rows, align: nextAlign.slice(0, head.length) });
      continue;
    }

    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      flushPara(para);
      const body = [q[1]];
      i += 1;
      while (i < lines.length && /^\s{0,3}>\s?(.*)$/.test(lines[i])) {
        body.push(/^\s{0,3}>\s?(.*)$/.exec(lines[i])![1]);
        i += 1;
      }
      out.push({ k: 'quote', text: body.join('\n').trim() });
      continue;
    }

    /**
     * 列表。无序和有序只差一条正则，所以合起来写。
     *
     * 缩进按**每 2 空格一级**算，封顶 3 级：再深的层级在手机这个宽度上
     * 已经没有意义，继续缩只会把正文挤成一条竖线。
     *
     * 续行（不带记号的缩进行）并进上一条——否则一条长条目会被切成两段，
     * 而 agent 写长条目时换行是常态。这一条要排在「更深一级的记号」之后判，
     * 否则嵌套项会被当成续行吞掉。
     */
    const LI = {
      ul: /^(\s*)[-*+]\s+(.*)$/,
      ol: /^(\s*)\d+[.)]\s+(.*)$/,
    };
    const kind = LI.ul.test(line) ? 'ul' : LI.ol.test(line) ? 'ol' : null;
    if (kind) {
      flushPara(para);
      const items: Item[] = [];
      const push = (indent: string, body: string) => {
        const [task, text] = taskOf(body);
        items.push({ text, task, depth: Math.min(3, Math.floor(indent.length / 2)) });
      };
      while (i < lines.length) {
        const m = LI.ul.exec(lines[i]) ?? LI.ol.exec(lines[i]);
        if (m) { push(m[1], m[2]); i += 1; continue; }
        const cont = /^\s{2,}(\S.*)$/.exec(lines[i]);
        if (cont && items.length) { items[items.length - 1].text += ` ${cont[1]}`; i += 1; continue; }
        break;
      }
      out.push({ k: kind, items });
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara(para);
  return out;
}

// ── 行内 ────────────────────────────────────────

type Span =
  | { k: 'text'; text: string }
  | { k: 'code'; text: string }
  | { k: 'strong'; text: string }
  | { k: 'em'; text: string }
  | { k: 'del'; text: string }
  | { k: 'link'; text: string; href: string };

/**
 * 行内切分。
 *
 * **行内代码优先**：`` `**x**` `` 里的星号是内容不是强调。做法是先把代码段
 * 整段切出来，剩下的文本再去认强调——而不是拿一条大正则同时匹配所有语法，
 * 那样必然在嵌套上出错。
 */
export function parseSpans(src: string): Span[] {
  const out: Span[] = [];
  const text = String(src ?? '');
  let i = 0;

  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.k === 'text') last.text += s;
    else out.push({ k: 'text', text: s });
  };

  while (i < text.length) {
    const rest = text.slice(i);

    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) { out.push({ k: 'code', text: code[1] }); i += code[0].length; continue; }

    /**
     * 图片**退化成链接**，排在链接之前判（`![]()` 前缀多一个叹号）。
     *
     * 不真的加载：agent 回复里的图片链接多半指向那台电脑上的本地文件，
     * 手机上取不到。渲染成一个碎图标不如给一条能点的链接诚实。
     */
    const img = /^!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (img) {
      out.push({ k: 'link', text: img[1] ? `图 ${img[1]}` : '图片', href: img[2] });
      i += img[0].length;
      continue;
    }

    const link = /^\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (link) { out.push({ k: 'link', text: link[1] || link[2], href: link[2] }); i += link[0].length; continue; }

    // 删除线。要排在强调之前——`~~x~~` 里的波浪号不该被别的规则拆开
    const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (del) { out.push({ k: 'del', text: del[1] }); i += del[0].length; continue; }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { out.push({ k: 'strong', text: strong[2] }); i += strong[0].length; continue; }

    // 斜体：单个 * 或 _。要求两侧非空白，避免把 a * b 里的乘号当语法
    const em = /^(\*|_)(?=\S)([^*_\n]*?\S)\1/.exec(rest);
    if (em) { out.push({ k: 'em', text: em[2] }); i += em[0].length; continue; }

    // 裸链接也认——agent 经常直接甩一个 URL
    const bare = /^https?:\/\/[^\s<>()]+/.exec(rest);
    if (bare) { out.push({ k: 'link', text: bare[0], href: bare[0] }); i += bare[0].length; continue; }

    pushText(text[i]);
    i += 1;
  }
  return out;
}

// ── 渲染 ────────────────────────────────────────

/**
 * 点了一个**指向本机文件**的链接时交给谁。
 *
 * ## agent 早就在发这种链接了
 *
 * 这不是我们发明的约定，是宿主自己的：Claude Code 的系统提示里明写
 * 「When referencing files in your responses, format them as markdown links…
 * Use the path relative to the working directory as the href」，例子就是
 * `[foo.ts](src/utils/foo.ts)`。在 owner 机器上的 transcript 里实测数到 12 处，
 * 连 `:行号` 后缀都有。
 *
 * 所以「让 agent 发的文件链接可点」这件事**不需要改 agent 一个字**，缺的一直是
 * 我们这边：上一版所有链接都走 `Linking.openURL`，而 `src/utils/foo.ts` 不是
 * URL——失败，而且那里是 `.catch(() => {})`，**静默**。
 *
 * 用 context 而不是逐层传 prop：`Inline` 在这个文件里有六个调用点，而这个回调
 * 一整屏只有一个、几乎不变。没有 provider 时退回原来的行为，markdown 组件
 * 在别处照用不误。
 */
const FileLinkCtx = createContext<((href: string) => void) | null>(null);

/** 包住一屏会话流，让里面所有相对路径链接都指向这个会话的文件。 */
export function FileLinks({
  onOpen, children,
}: { onOpen: (href: string) => void; children: ReactNode }) {
  return <FileLinkCtx.Provider value={onOpen}>{children}</FileLinkCtx.Provider>;
}

/**
 * 判这个链接能不能交给系统打开，还是当作这个会话工作目录里的文件，或直接禁用。
 *
 * 原来 `isExternal` 放行了所有 `scheme://`，导致 `javascript://%0aalert(1)`
 * 能绕过文件链接分支，且在没有 `<FileLinks>` 的页面里 `[x](javascript:...)` 或
 * `[x](tel:...)` 会直接丢给 `Linking.openURL`。这里严格限定只放行
 * `http://`、`https://`、`mailto:`，其余非 Windows 盘符协议与 `#` 一律禁用，
 * 剩余的（包括 `./x`、`../x`、`a/b.ts`、`a/b.ts:42`、`C:\...`）一律当作本机路径。
 */
export function classifyHref(href: string): 'external' | 'file' | 'blocked' {
  const h = String(href ?? '').trim();
  if (!h || h.startsWith('#')) return 'blocked';
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return 'external';
  if (!/^[a-z]:[\\/]/i.test(h) && /^[a-z][a-z0-9+.-]*:/i.test(h)) return 'blocked';
  return 'file';
}

function Inline({ text, style }: { text: string; style?: object }) {
  const t = useTheme();
  const s = md(t);
  const onFile = useContext(FileLinkCtx);
  return (
    <>
      {parseSpans(text).map((sp, i) => {
        if (sp.k === 'code') return <Text key={i} style={[s.code, style]}>{sp.text}</Text>;
        if (sp.k === 'strong') return <Text key={i} style={[s.strong, style]}>{sp.text}</Text>;
        if (sp.k === 'em') return <Text key={i} style={[s.em, style]}>{sp.text}</Text>;
        if (sp.k === 'del') return <Text key={i} style={[s.del, style]}>{sp.text}</Text>;
        if (sp.k === 'link') {
          const kind = classifyHref(sp.href);
          if (kind === 'blocked' || (kind === 'file' && !onFile)) {
            return <Text key={i} style={style}>{sp.text}</Text>;
          }
          return (
            <Text
              key={i}
              style={[s.link, style]}
              onPress={() => {
                if (kind === 'file' && onFile) { onFile(sp.href); return; }
                Linking.openURL(sp.href.trim()).catch(() => {});
              }}
            >
              {sp.text}
            </Text>
          );
        }
        return <Text key={i} style={style}>{sp.text}</Text>;
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const s = md(t);
  const { isEn } = useLocale();
  const blocks = parseBlocks(text);

  return (
    <View>
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        switch (b.k) {
          case 'h':
            return (
              <Text key={i} style={[s.h, b.level === 1 && s.h1, b.level >= 3 && s.h3]} selectable>
                <Inline text={b.text} />
              </Text>
            );
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case 'ul':
          case 'ol':
            return (
              <View key={i} style={s.list}>
                {b.items.map((it, j) => (
                  <View key={j} style={[s.li, it.depth > 0 && { paddingLeft: it.depth * 16 }]}>
                    {it.task !== null ? (
                      <View
                        style={[s.taskBox, it.task && s.taskBoxDone]}
                        accessible
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: it.task }}
                        accessibilityLabel={it.task ? (isEn ? 'Completed' : '已完成') : (isEn ? 'Not completed' : '未完成')}
                      >
                        {it.task ? <IconTick size={11} color="#ffffff" strokeWidth={2.6} /> : null}
                      </View>
                    ) : (
                      <Text style={s.bullet}>
                        {b.k === 'ol' ? `${countAt(b.items, j)}.` : '•'}
                      </Text>
                    )}
                    <Text style={[s.liTx, it.task && s.liDone]} selectable>
                      <Inline text={it.text} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'table':
            return <Table key={i} head={b.head} rows={b.rows} align={b.align} />;
          case 'quote':
            return (
              <View key={i} style={s.quote}>
                <Text style={s.quoteTx} selectable><Inline text={b.text} /></Text>
              </View>
            );
          case 'hr':
            return <View key={i} style={s.hr} />;
          default:
            return (
              <Text key={i} style={[s.p, last && { marginBottom: 0 }]} selectable>
                <Inline text={b.text} />
              </Text>
            );
        }
      })}
    </View>
  );
}

/**
 * 同层的第几个。嵌套列表里用全局下标会数出 `1. 2. 3.` 这种没有层次的编号——
 * 每进一层应该重新从 1 开始。
 */
function countAt(items: Item[], at: number): number {
  let n = 1;
  for (let j = at - 1; j >= 0; j -= 1) {
    if (items[j].depth < items[at].depth) break;
    if (items[j].depth === items[at].depth) n += 1;
  }
  return n;
}

/**
 * 表格。
 *
 * **横向滚动，不折行。** 手机宽度放不下三列以上的表，折行会把每个格子压成
 * 竖着的一串字，比截断还难读——代码块那边同理，已经是这个做法。
 *
 * 不画竖线：行与行之间一道浅分隔线就够了，竖线在这个宽度上只会把本来就窄的
 * 格子切得更碎。表头靠加粗和一条稍重的线区分。
 */
/** 粗略估算单元格文本视觉宽度（全角计 2，半角计 1），让表头与各行列宽对齐。 */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}

function Table({ head, rows, align }: { head: string[]; rows: string[][]; align: Align[] }) {
  const t = useTheme();
  const s = md(t);
  const colW = head.map((h, j) => {
    let max = visualLen(h);
    for (const r of rows) max = Math.max(max, visualLen(r[j] ?? ''));
    return Math.min(220, Math.max(76, Math.round(max * 7.8 + 26)));
  });
  const cell = (txt: string, j: number, strong?: boolean) => (
    <View key={j} style={[s.td, { width: colW[j], flexGrow: colW[j] }]}>
      <Text
        style={[s.tdTx, strong && s.thTx, { textAlign: align[j] ?? 'left' }]}
        selectable
      >
        <Inline text={txt} />
      </Text>
    </View>
  );
  return (
    <View style={s.table}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tableScroll}>
        <View style={s.tableInner}>
          <View style={[s.tr, s.thRow]}>{head.map((h, j) => cell(h, j, true))}</View>
          {rows.map((r, i) => (
            <View key={i} style={[s.tr, i > 0 && s.trLine]}>{head.map((_, j) => cell(r[j] ?? '', j))}</View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const t = useTheme();
  const s = md(t);
  const { isEn } = useLocale();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1400);
    } catch {
      // 剪贴板权限受限或非安全上下文时静默降级，不误报「已复制」
    }
  };

  return (
    <View style={s.block}>
      <View style={s.codeHead}>
        <Text style={s.codeLang} numberOfLines={1} ellipsizeMode="tail">{lang || 'code'}</Text>
        <Tappable
          style={s.codeCopy}
          haptic={haptics.tap}
          onPress={() => void onCopy()}
          accessibilityRole="button"
          accessibilityLabel={isEn ? 'Copy' : '复制'}
        >
          {copied
            ? <IconTick size={12} color={t.c.txSuccess} strokeWidth={2.4} />
            : <IconCopy size={12} color={t.c.txTertiary} />}
          <Text style={[s.codeCopyTx, copied && { color: t.c.txSuccess }]}>
            {copied ? (isEn ? 'Copied' : '已复制') : (isEn ? 'Copy' : '复制')}
          </Text>
        </Tappable>
      </View>
      {/* 代码块横向滚动，不折行——折行的代码读起来比截断还糟 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.blockScroll}>
        <Text style={s.blockTx} selectable>{text}</Text>
      </ScrollView>
    </View>
  );
}

const md = (t: Theme) =>
  StyleSheet.create({
    p: {
      fontFamily: t.fonts.serif, fontSize: 16, lineHeight: 26.8,
      color: t.c.txSecondary, marginBottom: 11,
    },
    strong: { fontWeight: t.weight.bold, color: t.c.txPrimary },
    em: { fontStyle: 'italic' },
    del: { textDecorationLine: 'line-through', color: t.c.txTertiary },
    code: {
      fontFamily: t.fonts.mono, fontSize: 13.5, color: t.c.txPrimary,
      backgroundColor: t.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(34,33,31,0.06)',
      borderRadius: 5,
      ...(Platform.OS === 'web' ? { paddingHorizontal: 5, paddingVertical: 1 } : null),
    },
    link: { color: t.c.txInfo, textDecorationLine: 'underline' },

    h: {
      fontFamily: t.fonts.serif, fontSize: 19, lineHeight: 27, letterSpacing: -0.25,
      color: t.c.txPrimary, fontWeight: t.weight.bold,
      marginTop: 18, marginBottom: 8,
    },
    h1: { fontSize: 22, lineHeight: 30, letterSpacing: -0.35 },
    h3: { fontSize: 17, lineHeight: 25 },

    block: {
      backgroundColor: t.c.bgSecondary, borderRadius: t.radius.lg,
      borderWidth: t.hairline, borderColor: t.c.bdTertiary,
      overflow: 'hidden', marginBottom: 13,
    },
    codeHead: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      paddingLeft: 13, paddingRight: 4, minHeight: 40,
      borderBottomWidth: t.hairline, borderBottomColor: t.c.bdTertiary,
      backgroundColor: t.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(34,33,31,0.025)',
    },
    codeLang: {
      flex: 1, minWidth: 0,
      fontFamily: t.fonts.mono, fontSize: 11, color: t.c.txTertiary,
      letterSpacing: 0.4, textTransform: 'lowercase',
    },
    codeCopy: {
      flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
      paddingHorizontal: 11, minHeight: 40, borderRadius: t.radius.md,
    },
    codeCopyTx: { fontFamily: t.fonts.sans, fontSize: 11.5, color: t.c.txTertiary, fontWeight: '500' },
    blockScroll: { paddingVertical: 11, paddingHorizontal: 13 },
    blockTx: {
      fontFamily: t.fonts.mono, fontSize: 12.5, lineHeight: 20, color: t.c.txPrimary,
    },

    list: { marginBottom: 11, gap: 6 },
    li: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
    bullet: {
      fontFamily: t.fonts.sans, fontSize: 15, lineHeight: 26.8,
      color: t.c.txTertiary, minWidth: 16,
    },
    taskBox: {
      width: 17, height: 17, marginTop: 5, borderRadius: 5,
      borderWidth: 1.5, borderColor: t.c.bdSecondary,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'transparent',
    },
    taskBoxDone: {
      backgroundColor: t.c.coral,
      borderColor: t.c.coral,
    },
    liTx: {
      flex: 1, fontFamily: t.fonts.serif, fontSize: 16, lineHeight: 26.8, color: t.c.txSecondary,
    },
    // 做完的条目压淡但**不划掉**：划掉的字在手机上很难读，而它仍然是内容
    liDone: { color: t.c.txTertiary },

    table: {
      marginBottom: 13,
      borderRadius: t.radius.lg,
      borderWidth: t.hairline,
      borderColor: t.c.bdTertiary,
      overflow: 'hidden',
      backgroundColor: t.c.bgPrimary,
    },
    tableScroll: { flexGrow: 1 },
    tableInner: { flexGrow: 1 },
    tr: { flexDirection: 'row' },
    thRow: {
      backgroundColor: t.c.bgSecondary,
      borderBottomWidth: t.hairline,
      borderBottomColor: t.c.bdTertiary,
    },
    trLine: { borderTopWidth: t.hairline, borderTopColor: t.c.bdTertiary },
    td: { paddingVertical: 8, paddingHorizontal: 12 },
    tdTx: {
      fontFamily: t.fonts.sans, fontSize: 13.5, lineHeight: 20, color: t.c.txSecondary,
    },
    thTx: { fontWeight: t.weight.bold, color: t.c.txPrimary, fontSize: 13 },

    quote: {
      borderLeftWidth: 3, borderLeftColor: t.c.bdSecondary,
      backgroundColor: t.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(34,33,31,0.025)',
      borderTopRightRadius: t.radius.md, borderBottomRightRadius: t.radius.md,
      paddingLeft: 13, paddingRight: 12, paddingVertical: 8, marginBottom: 12,
    },
    quoteTx: {
      fontFamily: t.fonts.serif, fontSize: 15.5, lineHeight: 25.5, color: t.c.txTertiary,
    },

    hr: { height: t.hairline, backgroundColor: t.c.bdTertiary, marginVertical: 16 },
  });
