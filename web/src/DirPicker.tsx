import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type DirEntry, type DirPage } from './api';
import { Modal } from './Modal';
import { crumbsOf, dirName, join, samePath, topRoots, type Crumb } from './paths';
import './dirpicker.css';

/**
 * 选工作目录的浮窗。
 *
 * ## 2026-11-04 为什么重做
 *
 * owner：「文件夹选择的窗口请制作的更加清楚便捷，目前很难看出文件路径结构」。
 * 上一版是药丸下面的一块 420×420 下拉，三处看不清：
 *
 * 1. **快捷列表只有末段名**。这台机器上 34 条，好几个叫 `baton` / `app` 的，
 *    分不出谁是谁
 * 2. **轨迹是点出来的，不是算出来的**。从快捷列表跳过去时轨迹只剩一个名字，
 *    再按「上一级」就和实际位置对不上了；轨迹本身也不能点
 * 3. **点一下 = 选中 + 进入**，于是「我现在选的是哪个」只能看药丸，浮层里没有
 *
 * 现在的形状照桌面系统的文件夹对话框：左边是入口（最近用过 / 位置），右边是当前
 * 目录的内容，顶上一条能点的路径，底部一直写着「将在 … 开始」。
 *
 * ## 操作
 *
 * - **单击 = 选中**，底部那行立刻换成它的完整位置；点「选这个目录」才算数
 * - **双击或点行尾的 ›** = 进入。进入的那个目录同时成为选中
 * - 「最近用过」单击选中并在右边定位到它所在的目录，双击直接选定
 * - 当前目录可以筛选；目录多的时候（起点实测 35 条）比滚着找快
 *
 * ## 界面里一处绝对路径都不渲染
 *
 * **服务端给的是绝对路径**（`/api/dirs` 每条都带 `path: "C:\\BatonWorkspaces\\friend"`），
 * 而那是宿主的目录结构——访客没道理看到它。所以显示的是**从这个调用者看得见的顶
 * 开始的目录名**（paths.ts 的 crumbsOf）：owner 看到 `C: › workspace › baton`，
 * 访客看到 `friend › proj`，同一套规则，没有「我是不是访客」的分支。title 属性
 * 同样看得见，也不放路径。
 */
export function DirPicker({
  quick, picked, canWrite, resetTo, onReset, onPick, onClose,
}: {
  quick: string[] | null;
  picked: string;
  canWrite: boolean;
  /** 非 null = 当前选的不是默认，给一条回去的路。`name` 是那个会被新建的目录名 */
  resetTo: { dir: string; name: string } | null;
  onReset: () => void;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  /** 起点页那组入口。用来把绝对路径换成「从顶开始的目录名」，以及左栏的「位置」 */
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [page, setPage] = useState<DirPage | null>(null);
  /** 选中的那个。null = 还没选（站在起点页上时可能如此） */
  const [sel, setSel] = useState<string | null>(picked || null);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  // 连点几下时只认最后一次的结果，不然慢的那个回来会把页面翻回去
  const seq = useRef(0);
  const crumbBar = useRef<HTMLDivElement>(null);

  /** 去某个目录（null = 起点页）。`select` 不给就选中这个目录本身。 */
  function go(path: string | null, select?: string | null) {
    const n = ++seq.current;
    setLoading(true);
    setErr(null);
    setNaming(false);
    setFilter('');
    api
      .dirs(path)
      .then((p) => {
        if (n !== seq.current) return;
        setPage(p);
        setSel(select === undefined ? p.path : select);
      })
      .catch((e: ApiError) => {
        if (n === seq.current) setErr(e);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }

  /** 去 `path` 所在的那一层，并选中它——「它在哪儿」一眼看得见。 */
  function reveal(path: string) {
    const n = ++seq.current;
    setLoading(true);
    setErr(null);
    api
      .dirs(path)
      .then((p) => {
        if (n !== seq.current) return;
        // 它就是顶（parent 为 null）：没有「上一层」可站，就站在它里面
        if (p.parent) go(p.parent, path);
        else {
          setPage(p);
          setSel(path);
          setLoading(false);
        }
      })
      .catch(() => {
        // 读不了（被删了、越界了）就从起点开始，别卡在一个报错上
        if (n === seq.current) go(null, null);
      });
  }

  /*
    打开时就站在当前选中的那个旁边（它所在的那一层，它自己高亮），而不是每次都从
    盘符起点往下点。只在打开时跑一次，所以起点取打开那一刻的值。
  */
  const first = useRef(picked);
  useEffect(() => {
    const n = ++seq.current;
    const land = (p: DirPage, select: string | null) => {
      if (n !== seq.current) return;
      setPage(p);
      setSel(select);
      setLoading(false);
    };
    const fail = (e: ApiError) => {
      if (n !== seq.current) return;
      setErr(e);
      setLoading(false);
    };
    const at = first.current;
    api
      .dirs(null)
      .then((p) => {
        setRoots(p.dirs);
        if (!at) land(p, null);
      })
      .catch((e: ApiError) => {
        setRoots([]);
        if (!at) fail(e);
      });
    if (at) {
      api
        .dirs(at)
        // 它就是顶（parent 为 null）：没有「上一层」可站，就站在它里面
        .then((p) => (p.parent ? api.dirs(p.parent).then((up) => land(up, at)) : land(p, at)))
        // 读不了（被删了、越界了）就从起点开始，别卡在一个报错上
        .catch(() => api.dirs(null).then((p) => land(p, null)))
        .catch(fail);
    }
  }, []);

  // 路径长了往左滚，保住末尾那几段——那才是有信息量的一头
  useEffect(() => {
    const el = crumbBar.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [page?.path, roots]);

  const used = (p: string) => (quick ?? []).some((q) => samePath(q, p));
  const here: Crumb[] = page?.path ? crumbsOf(page.path, roots) : [];
  const q = filter.trim().toLowerCase();
  const shown = (page?.dirs ?? []).filter((d) => !q || d.name.toLowerCase().includes(q));
  const tops = roots ? topRoots(roots) : [];

  async function makeDir() {
    const n = name.trim();
    if (!n || !page?.path) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.mkdir(join(page.path, n));
      // 200 且 created:false 表示已经存在——契约说了这不是错误，照常往下走。
      // **直接选定新建的那个**：建它就是为了在里面开工，停在这里还要再点一次。
      // 服务端归一化过的 r.path 才是准的，不要拿自己拼的那个。
      onPick(r.path);
      onClose();
    } catch (e) {
      setErr(e as ApiError);
      setLoading(false);
    }
  }

  const choose = (p: string) => {
    onPick(p);
    onClose();
  };

  return (
    <Modal
      title="选择工作目录"
      hint="agent 会在这个目录里开工，也只在这里读写"
      className="dp"
      onClose={onClose}
      footer={(
        <>
          <div className="dp-target">
            <span className="dp-target-k">将在</span>
            {sel
              ? <Path crumbs={crumbsOf(sel, roots)} />
              : <span className="dp-target-none">还没选——在右边点一个目录</span>}
            {sel && <span className="dp-target-k">开始</span>}
          </div>
          <button type="button" className="dlg-btn" onClick={onClose}>取消</button>
          <button type="button" className="dlg-ok" disabled={!sel} onClick={() => sel && choose(sel)}>
            选这个目录
          </button>
        </>
      )}
    >
      <div className="dp-cols">
        <aside className="dp-side">
          {/* 选了具体目录之后的反悔出口。放最上面：它是「算了，还用默认的」，
              而默认在这一页的语义里排在所有具体选择之前 */}
          {resetTo && (
            <section className="dp-sec">
              <button type="button" className="dp-item is-reset" onClick={onReset}>
                <span className="dp-ic is-plus" aria-hidden="true" />
                <span className="dp-item-text">
                  <span className="dp-item-name">新建 {resetTo.name}</span>
                  <span className="dp-item-sub">在 {dirName(resetTo.dir)} 下，自动起名</span>
                </span>
              </button>
            </section>
          )}

          {!!quick?.length && (
            <section className="dp-sec">
              <h3 className="dp-sec-title">最近用过</h3>
              {quick.map((d) => {
                // 名字下面写它在哪：好几个都叫 baton / app，只看名字分不出来
                const where = crumbsOf(d, roots).slice(0, -1);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`dp-item${sel && samePath(d, sel) ? ' is-on' : ''}`}
                    onClick={() => reveal(d)}
                    onDoubleClick={() => choose(d)}
                  >
                    <span className="dp-ic" aria-hidden="true" />
                    <span className="dp-item-text">
                      <span className="dp-item-name">{dirName(d)}</span>
                      {where.length > 0 && <Where crumbs={where} />}
                    </span>
                  </button>
                );
              })}
            </section>
          )}

          {tops.length > 0 && (
            <section className="dp-sec">
              <h3 className="dp-sec-title">位置</h3>
              {tops.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  className={`dp-item${page?.path && samePath(page.path, r.path) ? ' is-here' : ''}`}
                  disabled={!r.readable}
                  onClick={() => go(r.path)}
                >
                  <span className="dp-ic is-drive" aria-hidden="true" />
                  <span className="dp-item-text">
                    <span className="dp-item-name">{r.name}</span>
                  </span>
                </button>
              ))}
            </section>
          )}
        </aside>

        <div className="dp-main">
          <div className="dp-bar">
            <button
              type="button"
              className="dp-up"
              // parent 为 null = 这个调用者不能再往上。禁用而不是隐藏：
              // 位置稳定，人才知道自己到顶了而不是按钮跑了
              disabled={!page?.path || loading}
              onClick={() => page && go(page.parent)}
              aria-label="上一级"
            >
              ↑
            </button>
            {/* 能点的路径。每一段都是一个按钮，跳过去就选中那一层 */}
            <div className="dp-crumbs" ref={crumbBar}>
              <button
                type="button"
                className={`dp-crumb${page && !page.path ? ' is-here' : ''}`}
                onClick={() => go(null, null)}
              >
                起点
              </button>
              {here.map((c, i) => (
                <span key={c.path} className="dp-crumb-wrap">
                  <span className="dp-crumb-sep" aria-hidden="true">›</span>
                  <button
                    type="button"
                    className={`dp-crumb${i === here.length - 1 ? ' is-here' : ''}`}
                    onClick={() => go(c.path)}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="dp-tools">
            <input
              className="dp-filter"
              value={filter}
              placeholder={page?.path ? `在 ${dirName(page.path)} 里筛选` : '筛选'}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // 筛到只剩一个时回车直接进去，键盘用户一路敲到底
                if (e.key === 'Enter' && shown.length === 1 && shown[0].readable) {
                  e.preventDefault();
                  go(shown[0].path);
                }
              }}
            />
            {/* 建目录要写 owner 的磁盘，归在 allowSend 之下。起点页不是一个目录，建不了 */}
            <button
              type="button"
              className="dlg-btn dp-mk"
              disabled={!canWrite || !page?.path || loading}
              title={canWrite ? undefined : '当前为只读模式'}
              onClick={() => setNaming((v) => !v)}
            >
              ＋ 新建文件夹
            </button>
          </div>

          {naming && (
            <div className="dp-new">
              <input
                className="dp-filter"
                value={name}
                placeholder={`在 ${page?.path ? dirName(page.path) : ''} 下新建，回车确定`}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    makeDir();
                  }
                  if (e.key === 'Escape') {
                    // 只收起输入框，不关整个浮窗
                    e.stopPropagation();
                    setNaming(false);
                  }
                }}
              />
              <button type="button" className="dlg-ok" onClick={makeDir} disabled={!name.trim() || loading}>
                建并选定
              </button>
            </div>
          )}

          {err && (
            <p className="dp-err" role="alert">
              <span>{err.message}</span>
              {/* outside_workspace 的 fix 里写着这个人的工作区在哪，直接显示给他 */}
              <span className="dim">{err.fix}</span>
            </p>
          )}

          <ul className="dp-list" aria-busy={loading}>
            {loading && <li className="dp-hint">正在读…</li>}
            {!loading && page?.dirs.length === 0 && <li className="dp-hint">这里没有子目录。可以直接选这一层。</li>}
            {!loading && page && page.dirs.length > 0 && shown.length === 0 && (
              <li className="dp-hint">没有名字里带「{filter.trim()}」的目录。</li>
            )}
            {!loading && shown.map((d) => {
              const on = !!sel && samePath(d.path, sel);
              // 起点页上的条目来自各处（盘符、用过的目录），只看名字不知道在哪，补一行位置
              const where = !page?.path ? crumbsOf(d.path, roots).slice(0, -1) : [];
              return (
                <li key={d.path} className={`dp-row${on ? ' is-on' : ''}`}>
                  <button
                    type="button"
                    className="dp-pick"
                    // readable:false 必须不可点，不能让人点了才报错
                    disabled={!d.readable}
                    aria-pressed={on}
                    onClick={() => setSel(d.path)}
                    onDoubleClick={() => go(d.path)}
                  >
                    <span className="dp-ic" aria-hidden="true" />
                    <span className="dp-item-text">
                      <span className="dp-item-name">{d.name}</span>
                      {where.length > 0 && <Where crumbs={where} />}
                    </span>
                    {used(d.path) && <span className="dp-tag">用过</span>}
                    {!d.readable && <span className="dp-tag is-no">读不了</span>}
                  </button>
                  <button
                    type="button"
                    className="dp-enter"
                    disabled={!d.readable}
                    aria-label={`进入 ${d.name}`}
                    onClick={() => go(d.path)}
                  >
                    ›
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 名字下面那行「在哪」。外层 rtl 是为了长了先丢开头；里面那层必须隔离成 ltr，
 * 否则只有一段时 `C:` 会被排成 `:C`（实测）。
 */
function Where({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <span className="dp-item-sub">
      <span>{crumbs.map((c) => c.name).join(' › ')}</span>
    </span>
  );
}

/** 一串目录名，末段加粗——那是人认的「哪个项目」，前面是它在哪。 */
function Path({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <span className="dp-path">
      {/* 整串放进**一个** ltr 隔离层。逐段隔离的话，外层的 rtl 会把段的先后倒过来（实测） */}
      <span className="dp-path-in">
        {crumbs.map((c, i) => (
          <span key={c.path} className={i === crumbs.length - 1 ? 'is-last' : undefined}>
            {i > 0 && <span className="dp-crumb-sep" aria-hidden="true">›</span>}
            {c.name}
          </span>
        ))}
      </span>
    </span>
  );
}
