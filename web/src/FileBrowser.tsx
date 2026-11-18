import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError, type FileEntry, type FileListing } from './api';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { copyText } from './ui';
import './filebrowser.css';

/**
 * 这个会话工作目录里的文件浏览器。
 *
 * ## 为什么是**每个会话一个**
 *
 * owner：「在会话里面打开文件浏览器的时候，还是只能显示该会话对应的目录范围，
 * 就是这个文件浏览器是一个存在于每个会话里面的功能」。
 *
 * 这是**界面上的取舍，不是安全边界**——owner 建会话时就能指定任意目录，给他一棵
 * 全盘文件树并不会让他多拿到什么。取舍的理由是「你在哪个会话里，就只看那个会话的
 * 东西」，和 agent 自己的视野一致。（对访客它顺带是真边界：cwd 被 roots 锁住。）
 *
 * 范围由**服务端**锁死（src/sessionfs.js 的 realpath 包含性校验），这里不做任何
 * 路径检查——客户端的检查是假的。
 *
 * ## 2026-11-08 重做
 *
 * owner：「这个 UI 也要去改下，现在看着不够专业直观」。原来是一列「勾选框 + 名字 + 大小」：
 * 看不出现在在哪一层（只有末段名）、不知道哪个是刚改过的、点文件只会勾上它、看文件内容
 * 只能先下载。现在照 Finder / VS Code 的文件面板：
 *
 * - 顶上一条能点的路径 + 上一级 + 筛选 + 刷新
 * - 列表是表格：名称（按类型的图标）/ 修改时间 / 大小，点表头排序，目录总在前面
 * - **点目录 = 进去；点文件 = 右边预览**（文本带行号、Markdown 可切渲染、图片直接看），
 *   预览上能下载、复制相对路径、插入到输入框
 * - 勾选只管「批量下载」，表头有全选
 *
 * ## 下载直接挂 `<a href>`，预览用 fetch
 *
 * 网页端凭据走 HttpOnly cookie，同源请求浏览器自己带上；服务端给的是
 * `Content-Disposition: attachment`，所以 `<a>` 点了就是下载、文件名也对。
 * 预览用 fetch 读同一个地址：那个头只管导航时怎么处理，fetch 拿到的就是字节。
 */

type Sort = { key: 'name' | 'mtime' | 'size'; dir: 1 | -1 };

/** 预览上限：文本 1 MB、图片 15 MB。再大的只给下载——读进来一个几十 MB 的日志，这页就卡死了 */
const TEXT_MAX = 1024 * 1024;
const IMAGE_MAX = 15 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
  'swift', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'lua', 'r', 'dart',
]);
const CONFIG_EXT = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'xml', 'conf', 'cfg']);
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'log', 'csv', 'tsv']);
const ARCHIVE_EXT = new Set(['zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'bz2', 'xz']);
/** 没有扩展名但一看就是文本的那些 */
const TEXT_NAMES = new Set(['license', 'makefile', 'dockerfile', 'readme', 'procfile', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env']);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

type Kind = 'dir' | 'image' | 'code' | 'config' | 'doc' | 'archive' | 'file';

function kindOf(e: FileEntry): Kind {
  if (e.dir) return 'dir';
  const x = extOf(e.name);
  if (IMAGE_EXT.has(x)) return 'image';
  if (CODE_EXT.has(x)) return 'code';
  if (CONFIG_EXT.has(x) || e.name.startsWith('.')) return 'config';
  if (DOC_EXT.has(x)) return 'doc';
  if (ARCHIVE_EXT.has(x)) return 'archive';
  return 'file';
}

function isTextName(name: string): boolean {
  const x = extOf(name);
  return CODE_EXT.has(x) || CONFIG_EXT.has(x) || DOC_EXT.has(x) || TEXT_NAMES.has(name.toLowerCase()) || name.startsWith('.');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

/** 「刚刚」「3 小时前」「昨天 14:02」「11/03 09:12」「2025/12/01」 */
function fmtTime(ms: number | null, now: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `今天 ${hm}`;
  if (ms >= today.getTime() - 86_400_000) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')} ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 绝对路径的最后一段。两种分隔符都认——服务端可能跑在任一平台上。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const join = (at: string, name: string) => (at ? `${at}/${name}` : name);

export function FileBrowser({
  sessionKey, onClose, onInsert,
}: {
  sessionKey: string;
  onClose: () => void;
  /** 把一个相对路径放进输入框（Conversation 传进来）。不传就不显示那个按钮 */
  onInsert?: (rel: string) => void;
}) {
  const [at, setAt] = useState('');
  const [data, setData] = useState<FileListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 1 });
  /** 右边正在预览的那个文件（相对工作目录的路径） */
  const [preview, setPreview] = useState<FileEntry | null>(null);
  /**
   * 勾上的东西，存**相对工作目录的完整路径**。
   *
   * owner：「要支持开文件夹，多选，勾选，取消勾选，勾选也可以勾选文件夹或者勾选
   * 文件都可以，然后点击确定才下载」。存全路径而不是当前这一层的名字：勾完一个目录
   * 再点进另一个目录时，前面勾的不能丢——人是一边翻一边挑的。
   *
   * 勾了目录：**展开成它下面的文件再逐个下载**。浏览器下载的单位是文件，而服务端
   * 没有打包端点（在 owner 机器上现压一个可能很大的包，那是另一笔账）。
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 正在下载第几个 / 共几个。null = 没在下载。 */
  const [taking, setTaking] = useState<{ done: number; total: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const load = useCallback((path: string) => {
    const n = ++seq.current;
    setBusy(true);
    setErr(null);
    api
      .files(sessionKey, path)
      .then((d) => {
        if (n !== seq.current) return;
        setData(d);
        setAt(path);
        setFilter('');
        setPreview(null);
        setNow(Date.now());
      })
      .catch((e: ApiError) => {
        if (n === seq.current) setErr(e.message ?? String(e));
      })
      .finally(() => {
        if (n === seq.current) setBusy(false);
      });
  }, [sessionKey]);

  // 每次打开都从根重新拉：上次停在哪儿不重要，而目录内容随时在变。
  // 不经 load：它开头那几句同步 setState 在 effect 里会多渲染一轮，而初值已经是「在读」
  useEffect(() => {
    let alive = true;
    api
      .files(sessionKey, '')
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: ApiError) => {
        if (alive) setErr(e.message ?? String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionKey]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (data?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
    const cmp = (a: FileEntry, b: FileEntry) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1; // 目录总在前面，不管怎么排
      let v = 0;
      if (sort.key === 'size') v = (a.size ?? 0) - (b.size ?? 0);
      else if (sort.key === 'mtime') v = (a.mtime ?? 0) - (b.mtime ?? 0);
      if (v === 0) v = a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return v * sort.dir;
    };
    return [...list].sort(cmp);
  }, [data, filter, sort]);

  const toggle = useCallback((rel: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel); else next.add(rel);
      return next;
    });
  }, []);

  const hereRels = rows.map((e) => join(at, e.name));
  const allHere = hereRels.length > 0 && hereRels.every((r) => picked.has(r));
  const someHere = hereRels.some((r) => picked.has(r));
  const toggleAll = () => setPicked((prev) => {
    const next = new Set(prev);
    if (allHere) hereRels.forEach((r) => next.delete(r));
    else hereRels.forEach((r) => next.add(r));
    return next;
  });

  /**
   * 把勾上的东西摊平成一串文件路径。目录递归展开。
   *
   * 逐层问服务端而不是一次要一棵树：服务端没有递归端点，而且加一个的话，
   * 一个 node_modules 就能让它列出几万条——那种接口迟早要限深度、限条数，
   * 变成一套自己的规矩。这里由界面按需展开，天然被"人勾了什么"限住。
   */
  const flatten = useCallback(async (): Promise<string[]> => {
    const out: string[] = [];
    const queue = [...picked];
    const seen = new Set<string>();
    while (queue.length) {
      const rel = queue.shift() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      // 是文件还是目录，问当前这层的缓存不可靠（可能是别的层勾的），直接试着列
      try {
        const sub = await api.files(sessionKey, rel);
        for (const e of sub.entries) queue.push(join(rel, e.name));
      } catch {
        // 列不了就当它是文件——服务端对「把文件当目录列」回的正是 400
        out.push(rel);
      }
    }
    return out;
  }, [picked, sessionKey]);

  const download = useCallback((rel: string) => {
    const a = document.createElement('a');
    a.href = api.fileUrl(sessionKey, rel);
    a.download = rel.split('/').pop() ?? rel;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [sessionKey]);

  const downloadPicked = useCallback(async () => {
    setErr(null);
    let list: string[];
    try {
      list = await flatten();
    } catch (e) {
      setErr((e as ApiError).message ?? String(e));
      return;
    }
    if (!list.length) { setErr('勾中的目录里没有文件。'); return; }

    setTaking({ done: 0, total: list.length });
    /**
     * **一个一个来，不并发。**
     *
     * 每个下载都是一次浏览器的「保存文件」动作，同时触发几十个会被浏览器
     * 当成滥用拦掉（Chrome 有「此网站试图下载多个文件」那道闸）。
     * 而且逐个来人还能看见进度。
     */
    for (let i = 0; i < list.length; i += 1) {
      download(list[i]);
      setTaking({ done: i + 1, total: list.length });
      // 给浏览器一拍去处理上一个，否则连着 click 会被合并/丢弃
      await new Promise((r) => { setTimeout(r, 180); });
    }
    setTaking(null);
    setPicked(new Set());
  }, [flatten, download]);

  const root = data ? baseName(data.cwd) : '…';
  const crumbs = at ? at.split('/') : [];
  const sortBy = (key: Sort['key']) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }));
  const arrow = (key: Sort['key']) => (sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  return (
    <Modal
      title="文件"
      hint={<>这个会话的工作目录 <b className="fb-root">{root}</b>，只看得到它里面的东西</>}
      className={`fb${preview ? ' has-preview' : ''}`}
      onClose={onClose}
      footer={(
        <>
          <span className="fb-note">
            {taking
              ? `正在下载 ${taking.done}/${taking.total}`
              : picked.size
                ? `已选 ${picked.size} 项（目录会展开成里面的文件）`
                : '点文件夹进去，点文件预览；勾选可以批量下载'}
          </span>
          {picked.size > 0 && !taking && (
            <button type="button" className="dlg-btn" onClick={() => setPicked(new Set())}>清空</button>
          )}
          <button
            type="button"
            className="dlg-ok"
            onClick={() => void downloadPicked()}
            disabled={picked.size === 0 || taking !== null}
          >
            {taking ? `${taking.done}/${taking.total}` : picked.size ? `下载所选（${picked.size}）` : '下载所选'}
          </button>
        </>
      )}
    >
      <div className="fb-bar">
        <button
          type="button"
          className="fb-tool"
          disabled={!data || data.parent === null || busy}
          onClick={() => data && load(data.parent ?? '')}
          aria-label="上一级"
          title="上一级"
        >
          ↑
        </button>
        {/* 能点的路径：根是工作目录的名字，后面每一段点了就回到那一层 */}
        <nav className="fb-crumbs" aria-label="当前位置">
          <button type="button" className={`fb-crumb${crumbs.length ? '' : ' is-here'}`} onClick={() => load('')}>
            <span className="fb-ic is-root" aria-hidden="true" />
            {root}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="fb-crumb-wrap">
              <span className="fb-sep" aria-hidden="true">›</span>
              <button
                type="button"
                className={`fb-crumb${i === crumbs.length - 1 ? ' is-here' : ''}`}
                onClick={() => load(crumbs.slice(0, i + 1).join('/'))}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
        <input
          className="fb-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选"
          aria-label="在当前目录里筛选"
        />
        <button
          type="button"
          className="fb-tool"
          onClick={() => load(at)}
          disabled={busy}
          aria-label="刷新"
          title="刷新"
        >
          ↻
        </button>
      </div>

      {err && <p className="fb-err" role="alert">{err}</p>}

      <div className="fb-panes">
        <div className="fb-table" role="grid" aria-label="文件列表" aria-busy={busy}>
          <div className="fb-thead" role="row">
            <label className="fb-check" title={allHere ? '取消全选' : '全选这一层'}>
              <input
                type="checkbox"
                checked={allHere}
                ref={(el) => {
                  if (el) el.indeterminate = !allHere && someHere;
                }}
                onChange={toggleAll}
                disabled={!rows.length}
                aria-label="全选这一层"
              />
            </label>
            <button type="button" className="fb-th is-name" onClick={() => sortBy('name')}>名称{arrow('name')}</button>
            <button type="button" className="fb-th is-time" onClick={() => sortBy('mtime')}>修改时间{arrow('mtime')}</button>
            <button type="button" className="fb-th is-size" onClick={() => sortBy('size')}>大小{arrow('size')}</button>
          </div>

          <div className="fb-tbody">
            {busy && !data && <p className="fb-empty">正在读…</p>}
            {data && !busy && data.entries.length === 0 && <p className="fb-empty">这个目录是空的。</p>}
            {data && data.entries.length > 0 && rows.length === 0 && (
              <p className="fb-empty">没有名字里带「{filter.trim()}」的。</p>
            )}
            {rows.map((e) => {
              const rel = join(at, e.name);
              const kind = kindOf(e);
              const on = preview?.name === e.name && !e.dir;
              return (
                <div
                  key={e.name}
                  role="row"
                  className={`fb-row${on ? ' is-on' : ''}${picked.has(rel) ? ' is-picked' : ''}${e.name.startsWith('.') ? ' is-hidden' : ''}`}
                >
                  {/*
                    勾选框和「打开」是**两个独立的动作**，所以是两个可点区域：
                    点方框 = 选中它（目录和文件都行），点名字 = 进去看看 / 预览。
                    合成一个的话，想勾一整个目录就必须先进去再退出来。
                  */}
                  <label className="fb-check">
                    <input
                      type="checkbox"
                      checked={picked.has(rel)}
                      onChange={() => toggle(rel)}
                      aria-label={`选中 ${e.name}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="fb-open"
                    onClick={() => (e.dir ? load(rel) : setPreview(e))}
                    title={e.dir ? `打开 ${e.name}` : `预览 ${e.name}`}
                  >
                    <span className={`fb-ic is-${kind}`} aria-hidden="true" />
                    <span className="fb-name">{e.name}</span>
                    <span className="fb-time">{fmtTime(e.mtime, now)}</span>
                    <span className="fb-size">{e.dir ? '—' : fmtBytes(e.size ?? 0)}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {preview && (
          <Preview
            key={join(at, preview.name)}
            sessionKey={sessionKey}
            rel={join(at, preview.name)}
            entry={preview}
            now={now}
            onClose={() => setPreview(null)}
            onDownload={() => download(join(at, preview.name))}
            onInsert={onInsert ? (rel) => { onInsert(rel); onClose(); } : undefined}
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * 右边的预览。文本带行号，Markdown 能切「渲染 / 源码」，图片直接看；
 * 太大或者看不了的类型只给下载。
 */
function Preview({
  sessionKey, rel, entry, now, onClose, onDownload, onInsert,
}: {
  sessionKey: string;
  rel: string;
  entry: FileEntry;
  now: number;
  onClose: () => void;
  onDownload: () => void;
  onInsert?: (rel: string) => void;
}) {
  const kind = kindOf(entry);
  const size = entry.size ?? 0;
  const isImage = kind === 'image' && size <= IMAGE_MAX;
  const isText = !isImage && isTextName(entry.name) && size <= TEXT_MAX;
  const isMd = ['md', 'markdown'].includes(extOf(entry.name));
  const [text, setText] = useState<string | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);

  useEffect(() => {
    if (!isImage && !isText) return;
    let alive = true;
    let url: string | null = null;
    fetch(api.fileUrl(sessionKey, rel), { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`读不到（HTTP ${r.status}）`);
        if (isImage) {
          url = URL.createObjectURL(await r.blob());
          if (alive) setImg(url);
        } else {
          const t = await r.text();
          // 扩展名像文本、内容却有 NUL：是二进制，别把乱码摊一屏
          if (t.includes('\u0000')) throw new Error('看起来是二进制文件');
          if (alive) setText(t);
        }
      })
      .catch((e: Error) => {
        if (alive) setFailed(e.message);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sessionKey, rel, isImage, isText]);

  const lines = useMemo(() => (text === null ? [] : text.replace(/\n$/, '').split('\n')), [text]);

  return (
    <aside className="fb-preview" aria-label={`预览 ${entry.name}`}>
      <header className="fb-pv-head">
        <span className={`fb-ic is-${kind}`} aria-hidden="true" />
        <div className="fb-pv-title">
          <span className="fb-pv-name">{entry.name}</span>
          <span className="fb-pv-meta">{fmtBytes(size)} · {fmtTime(entry.mtime, now)}</span>
        </div>
        <button type="button" className="fb-tool" onClick={onClose} aria-label="关闭预览" title="关闭预览">×</button>
      </header>
      <div className="fb-pv-acts">
        <button type="button" className="fb-act" onClick={onDownload}>下载</button>
        <button type="button" className="fb-act" onClick={() => copyText(rel, '已复制路径')}>复制路径</button>
        {onInsert && (
          <button type="button" className="fb-act is-primary" onClick={() => onInsert(rel)} title="把这个文件的路径加到输入框里，发给 agent">
            插入到输入框
          </button>
        )}
        {isMd && text !== null && (
          <span className="fb-seg" role="group" aria-label="Markdown 显示方式">
            <button type="button" className={rendered ? 'is-on' : ''} onClick={() => setRendered(true)}>渲染</button>
            <button type="button" className={rendered ? '' : 'is-on'} onClick={() => setRendered(false)}>源码</button>
          </span>
        )}
      </div>
      <div className="fb-pv-body">
        {failed && <p className="fb-pv-note">{failed}。可以下载下来看。</p>}
        {!failed && !isImage && !isText && (
          <p className="fb-pv-note">
            {size > TEXT_MAX && isTextName(entry.name)
              ? `文件有 ${fmtBytes(size)}，太大了不在这里预览。`
              : '这种文件没法在这里预览。'}
            可以下载下来看。
          </p>
        )}
        {!failed && (isImage || isText) && text === null && img === null && <p className="fb-pv-note">正在读…</p>}
        {img && (
          <div className="fb-pv-img">
            <img src={img} alt={entry.name} />
          </div>
        )}
        {text !== null && isMd && rendered && (
          <div className="fb-pv-md">
            <Markdown text={text} sessionKey={sessionKey} />
          </div>
        )}
        {text !== null && !(isMd && rendered) && (
          // 行号是一列独立的格子：选中复制代码时不会把行号一起带走
          <div className="fb-code">
            <pre className="fb-code-nums" aria-hidden="true">{lines.map((_, i) => i + 1).join('\n')}</pre>
            <pre className="fb-code-text">{lines.join('\n')}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}
