import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, type Chain, type Member } from './api';
import { translate, useI18n, type MsgKey } from './i18n';
import { Palette, ShortcutsDialog, isCombo } from './Palette';
import { getPrefs, noteVisit, setPrefs, togglePin, usePrefs, type Theme } from './prefs';
import { Link, navigate } from './router';
import { ago, dirLabel, dotKind, group, groupOf, type Group } from './sessions';
import { Menu, Toasts, copyText, keyLabel, openPalette, openShortcuts, openUsage } from './ui';
import { UsageDialog } from './Usage';
import { Wordmark } from './Wordmark';
import { DraftScope } from './drafts';
import { CanOpenTerminalCtx, openSessionTerminal } from './terminal';
import { draftScope, rememberBrowserScope } from '../../app/src/store/browserSession';
import './workspace.css';

/**
 * 两栏外壳：左侧常驻会话列表，右侧当前会话。
 *
 * 侧栏在路由**外面**，切会话时不重挂载——滚动位置、展开的分组、筛选全都留着。
 * 这正是 Happy 的 SidebarNavigator 与 Bluesky 的 shell/desktop 的结构。
 * 窄屏没有"两栏"这回事：列表和会话是前后两个页面，由 hasContent 决定露哪个。
 *
 * 列表规则来自线上实测（179 个会话）：
 *   63/179 已归档（35%）      → 默认收起来
 *   35 个目录，最大一组 106    → 分组 + 可折叠
 *   `C:\` 与 `c:\` 并存        → 分组键大小写不敏感
 *   lastTs 有 21% 是 null     → 时间一律取 mtimeMs
 *
 * ## 2026-11-06 侧栏与导航重排
 *
 * 参考现代桌面 AI 客户端交互惯例布局：
 *
 * | Claude Desktop | 这里 |
 * |---|---|
 * | 侧栏顶上「新建会话」是一行，不是一块黑按钮 | 同 |
 * | 「搜索…」是一行，点开是命令面板 | 原来的筛选框换成它（Ctrl/⌘ K） |
 * | 「等待您处理的会话」 | 列表最上面单独一组：卡在等人点确认的 |
 * | 「置顶文件夹」 | 分组头上的图钉，置顶的排最前 |
 * | 「上一个 / 下一个会话」「上次会话」 | Alt+↑/↓、Ctrl+Shift+L |
 * | 「隐藏侧边栏」Ctrl+B、「键盘快捷键」Ctrl+/、「设置」Ctrl+, | 同 |
 *
 * 首页不再是「在跑 / 最近」两张表（原 Landing.tsx），而是直接一个输入框——Claude 的首页就是
 * 新建。那两张表的信息挪进了侧栏：「等你处理」一组 + 「按时间」视图（跨目录的「最近」）。
 * 不常用的筛选（agent、已归档、排法）收进列表头上的一个菜单，顶上只留「新建」和「搜索」。
 */

const MembersCtx = createContext<Member[] | null>(null);

export function useMember(key: string | null): Member | null {
  const all = useContext(MembersCtx);
  if (!key || !all) return null;
  return all.find((m) => m.key === key) ?? null;
}

const RAIL_MIN = 240;
const RAIL_MAX = 520;
const RAIL_DEFAULT = 300;

/** localStorage 随时可能抛（隐私模式、站点数据被禁），每一处读写都要兜住。 */
function readStored<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就算了——这只是个使用偏好，丢了不影响功能 */
  }
}

function dayBucket(ms: number, now: number, t: (k: MsgKey) => string): string {
  const d0 = new Date(now);
  d0.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ms >= d0.getTime()) return t('shell.dayToday');
  if (ms >= d0.getTime() - day) return t('shell.dayYesterday');
  if (ms >= d0.getTime() - 6 * day) return t('shell.day7');
  if (ms >= d0.getTime() - 29 * day) return t('shell.day30');
  return t('shell.dayOlder');
}

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_KEY: Record<Theme, MsgKey> = { system: 'shell.themeSystem', light: 'shell.themeLight', dark: 'shell.themeDark' };

export function Shell({
  selectedKey = null,
  home = false,
  children,
}: {
  selectedKey?: string | null;
  /** 首页：宽屏上显示 children（新建输入框），窄屏上仍然先给列表——手机端进来要先找会话 */
  home?: boolean;
  children?: ReactNode;
}) {
  const prefs = usePrefs();
  const { locale, t } = useI18n();
  const [chains, setChains] = useState<Chain[] | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canOpenTerminal, setCanOpenTerminal] = useState(false);
  const [scope, setScope] = useState<string | null | undefined>(undefined);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [usage, setUsage] = useState(false);

  useEffect(() => {
    let active = true;
    const identify = () => api.health().then((h) => {
      if (!active) return;
      if (!h.principal?.id) { setScope(null); return; }
      const next = draftScope(window.location.origin, h.principal.id, h.principal.generation);
      rememberBrowserScope(next);
      setIsOwner(h.principal.isOwner);
      setCanOpenTerminal(Boolean(h.canOpenTerminal));
      setScope(next);
    }).catch(() => { if (active) setScope((previous) => previous ?? null); });
    void identify();
    window.addEventListener('online', identify);
    return () => { active = false; window.removeEventListener('online', identify); };
  }, []);

  // 收放与宽度都记住：每次进来重新调一遍是纯粹的重复劳动
  const [collapsed, setCollapsed] = useState(() => readStored('baton.rail.collapsed', false, (r) => r === '1'));
  const [width, setWidth] = useState(() =>
    readStored('baton.rail.width', RAIL_DEFAULT, (r) => {
      const n = Number(r);
      return Number.isFinite(n) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, n)) : RAIL_DEFAULT;
    }),
  );

  useEffect(() => writeStored('baton.rail.collapsed', collapsed ? '1' : '0'), [collapsed]);
  useEffect(() => writeStored('baton.rail.width', String(width)), [width]);

  // 记下打开过哪些会话：命令面板的「最近打开」与 Ctrl+Shift+L「回到上次」都靠它
  useEffect(() => {
    if (selectedKey) noteVisit(selectedKey);
  }, [selectedKey]);

  /**
   * 拉会话列表。
   *
   * **原来只在挂载时拉一次，之后永不刷新**——于是「电脑上看得到手机上新建的会话」
   * 这条（项目目标之二）在网页端不成立，除非手动刷屏。会话列表没有 SSE 通道，
   * 只能轮询。
   *
   * 实测 `/api/sessions` 约 50ms / 98 KB（184 个会话）。据此：
   *
   * - **只在标签页可见时轮**。后台标签页照轮等于让一个没人看的页面一直占着隧道
   * - 回到标签页立刻拉一次。这是最值钱的那个时机——人转回来就是想看有没有新的
   * - 一次没回来就不发下一次，别在慢网络上排队堆积
   */
  const inflight = useRef(false);
  const refresh = useCallback(() => {
    if (inflight.current || document.hidden) return;
    inflight.current = true;
    api
      .sessions()
      .then((d) => {
        setChains(d.chains);
        setErr(null);
      })
      .catch((e: ApiError) => {
        if (e.status === 401) window.location.href = '/welcome';
        else setErr(e);
      })
      .finally(() => {
        inflight.current = false;
      });
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // 刚建完会话的那一下不能等 30 秒——页头的标题和目录都从这份列表取
    window.addEventListener('baton:sessions', refresh);
    const t = setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('baton:sessions', refresh);
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const members = useMemo(() => (chains ? chains.flatMap((c) => c.members) : null), [chains]);

  /** 置顶的组排最前（按置顶的先后），其余保持原来的「最近动过的组在前」 */
  const groups = useMemo(() => {
    if (!chains) return [];
    const gs = group(chains, prefs.filter, prefs.showArchived, '');
    const rank = (g: Group) => {
      const i = prefs.pinned.indexOf(g.key);
      return i < 0 ? Infinity : i;
    };
    return [...gs].sort((a, b) => rank(a) - rank(b));
  }, [chains, prefs.filter, prefs.showArchived, prefs.pinned]);

  const visible = useMemo(() => groups.flatMap((g) => g.threads.flat()), [groups]);
  const total = visible.length;
  // 等你点确认的。单独一组放最上面——Claude Desktop 叫它「等待您处理的会话」
  const waiting = useMemo(() => visible.filter((m) => m.waiting), [visible]);

  /** 「按时间」视图：跨目录、新的在前，按日历日分段 */
  const byDay = useMemo(() => {
    const out: { label: string; items: Member[] }[] = [];
    const tr = (k: MsgKey) => translate(locale, k);
    for (const m of [...visible].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      const label = dayBucket(m.mtimeMs, now, tr);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [visible, now, locale]);

  /** 键盘上下翻会话时的顺序 = 侧栏上从上到下看到的顺序 */
  const order = useMemo(
    () => (prefs.listMode === 'recent' ? byDay.flatMap((s) => s.items) : visible).map((m) => m.key),
    [prefs.listMode, byDay, visible],
  );

  // 选中的会话若落在折叠的分组里，展开它——否则点进来左边看不到自己在哪
  useEffect(() => {
    if (!selectedKey || !members) return;
    const m = members.find((x) => x.key === selectedKey);
    if (!m) return;
    const k = groupOf(m).key;
    setClosed((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }, [selectedKey, members]);

  // 再滚进视野。block:'nearest' 是刻意的：已经看得见就别动，
  // 否则每次切会话整个列表都要跳一下
  useEffect(() => {
    if (!selectedKey || !chains || collapsed) return;
    const el = document.querySelector<HTMLElement>(`.rail-list [data-row-key="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, chains, closed, prefs.filter, prefs.showArchived, prefs.listMode, collapsed]);

  /* ── 全局浮层与快捷键 ── */

  useEffect(() => {
    const onPalette = () => setPalette((v) => !v);
    const onKeys = () => setKeys(true);
    const onRail = () => setCollapsed((v) => !v);
    const onUsage = () => setUsage(true);
    window.addEventListener('baton:usage', onUsage);
    window.addEventListener('baton:palette', onPalette);
    window.addEventListener('baton:shortcuts', onKeys);
    window.addEventListener('baton:rail', onRail);
    return () => {
      window.removeEventListener('baton:palette', onPalette);
      window.removeEventListener('baton:shortcuts', onKeys);
      window.removeEventListener('baton:rail', onRail);
      window.removeEventListener('baton:usage', onUsage);
    };
  }, []);

  useEffect(() => {
    const go = (key: string | undefined) => key && navigate(`/session/${encodeURIComponent(key)}`);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // 命令面板开着时再按一次就关——和打开是同一个键
      if (isCombo(e, 'mod+k')) {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      // 有浮窗开着时，其余的全局键都让给浮窗（Esc、方向键在里面另有用处）
      if (document.querySelector('.dlg-scrim, .menu')) return;
      const hit = (combo: string) => {
        if (!isCombo(e, combo)) return false;
        e.preventDefault();
        return true;
      };
      if (hit('mod+shift+o')) navigate('/new');
      else if (hit('mod+b')) setCollapsed((v) => !v);
      else if (hit('mod+/')) setKeys(true);
      else if (hit('mod+,')) navigate('/about');
      else if (hit('mod+shift+l')) go(getPrefs().visited.find((k) => k !== selectedKey && members?.some((m) => m.key === k)));
      else if (hit('alt+up') || hit('alt+down')) {
        if (!order.length) return;
        const at = selectedKey ? order.indexOf(selectedKey) : -1;
        const down = e.key === 'ArrowDown';
        const next = at < 0 ? (down ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + (down ? 1 : -1)));
        go(order[next]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, selectedKey, members]);

  /* 拖拽改宽。用 pointer capture 而不是在 window 上挂 mousemove：
     指针移出窗口、或中途松手，浏览器会自己把事件还回来，不会卡在"一直在拖"。 */
  const dragging = useRef(false);
  const onHandleDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
  }, []);

  const onHandleMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, e.clientX)));
  }, []);

  const onHandleUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('is-resizing');
  }, []);

  const toggleGroup = (k: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const filtered = prefs.filter !== 'all' || prefs.showArchived || prefs.listMode !== 'folders';

  return (
    <div
      className="ws"
      data-content={home ? 'home' : children ? 'yes' : 'no'}
      data-rail={collapsed ? 'off' : 'on'}
      style={{ ['--rail-w' as string]: `${width}px` }}
    >
      {collapsed && (
        <button
          type="button"
          className="rail-peek"
          onClick={() => setCollapsed(false)}
          aria-label={t('shell.showRail')}
          title={`${t('shell.showRail')} (${keyLabel('mod+b')})`}
        >
          <Icon name="sidebar" />
        </button>
      )}

      <aside className="rail" inert={collapsed}>
        <div className="rail-top">
          <div className="rail-line">
            <Link to="/" className="rail-brand" aria-label={t('shell.homeLabel')}>
              <Wordmark />
            </Link>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setCollapsed(true)}
              aria-label={t('shell.hideRail')}
              title={`${t('shell.hideRail')} (${keyLabel('mod+b')})`}
            >
              <Icon name="sidebar" />
            </button>
          </div>

          <Link className="rail-act" to="/new">
            <Icon name="plus" />
            <span className="rail-act-label">{t('shell.newSession')}</span>
            <kbd>{keyLabel('mod+shift+o')}</kbd>
          </Link>
          <button type="button" className="rail-act" onClick={openPalette}>
            <Icon name="search" />
            <span className="rail-act-label">{t('shell.search')}</span>
            <kbd>{keyLabel('mod+k')}</kbd>
          </button>
        </div>

        <div className="rail-head">
          <span className="rail-head-title">
            {prefs.listMode === 'recent' ? t('shell.recent') : t('shell.sessions')}
            {prefs.filter !== 'all' && <span className="rail-head-tag">{prefs.filter}</span>}
            {prefs.showArchived && <span className="rail-head-tag">{t('shell.includingArchived')}</span>}
          </span>
          <Menu
            label={t('shell.listSettings')}
            align="end"
            items={[
              { section: t('shell.sortSection') },
              { label: t('shell.sortFolders'), checked: prefs.listMode === 'folders', onSelect: () => setPrefs({ listMode: 'folders' }) },
              { label: t('shell.sortRecent'), checked: prefs.listMode === 'recent', onSelect: () => setPrefs({ listMode: 'recent' }) },
              'sep',
              { section: 'Agent' },
              { label: t('shell.agentAll'), checked: prefs.filter === 'all', onSelect: () => setPrefs({ filter: 'all' }) },
              { label: 'Claude', checked: prefs.filter === 'claude', onSelect: () => setPrefs({ filter: 'claude' }) },
              { label: 'Codex', checked: prefs.filter === 'codex', onSelect: () => setPrefs({ filter: 'codex' }) },
              { label: 'Antigravity', checked: prefs.filter === 'antigravity', onSelect: () => setPrefs({ filter: 'antigravity' }) },
              'sep',
              { label: t('shell.showArchived'), checked: prefs.showArchived, onSelect: () => setPrefs({ showArchived: !prefs.showArchived }) },
              ...(prefs.listMode === 'folders' && groups.length
                ? ['sep' as const, { label: t('shell.collapseAll'), onSelect: () => setClosed(new Set(groups.map((g) => g.key))) }, { label: t('shell.expandAll'), onSelect: () => setClosed(new Set()) }]
                : []),
            ]}
            trigger={(p) => (
              <button
                type="button"
                {...p}
                className={`icon-btn rail-filter${filtered ? ' is-on' : ''}`}
                title={t('shell.filterTitle')}
                aria-label={t('shell.filterTitle')}
              >
                <Icon name="filter" />
              </button>
            )}
          />
        </div>

        <div className="rail-list">
          {err && (
            <p className="rail-error" role="alert">
              <span>{err.message}</span>
              <span className="dim">{err.fix}</span>
            </p>
          )}
          {!chains && !err && (
            <p className="rail-hint">
              <span className="bounce" aria-hidden="true" />
              {t('shell.loadingSessions')}
            </p>
          )}
          {chains && total === 0 && (
            <p className="rail-hint">
              {prefs.filter === 'all' ? t('shell.emptyAll') : t('shell.emptyFiltered', { agent: prefs.filter })}
            </p>
          )}

          {waiting.length > 0 && (
            <section className="grp is-waiting">
              <div className="grp-head-row">
                <span className="grp-head is-static">
                  <span className="grp-name">{t('shell.waitingGroup')}</span>
                  <span className="grp-count">{waiting.length}</span>
                </span>
              </div>
              <ul className="rows">
                {waiting.map((m) => (
                  <Row key={m.key} m={m} selected={m.key === selectedKey} now={now} showDir dup canOpenTerminal={canOpenTerminal} />
                ))}
              </ul>
            </section>
          )}

          {prefs.listMode === 'recent'
            ? byDay.map((s) => (
              <section className="grp" key={s.label}>
                <div className="grp-head-row">
                  <span className="grp-head is-static">
                    <span className="grp-name">{s.label}</span>
                  </span>
                </div>
                <ul className="rows">
                  {s.items.map((m) => <Row key={m.key} m={m} selected={m.key === selectedKey} now={now} showDir canOpenTerminal={canOpenTerminal} />)}
                </ul>
              </section>
            ))
            : groups.map((g) => {
              const open = !closed.has(g.key);
              const pinned = prefs.pinned.includes(g.key);
              return (
                <section className={`grp${pinned ? ' is-pinned' : ''}`} key={g.key}>
                  <div className="grp-head-row">
                    <button
                      type="button"
                      className="grp-head"
                      aria-expanded={open}
                      onClick={() => toggleGroup(g.key)}
                    >
                      <span className={`chev${open ? ' is-open' : ''}`} aria-hidden="true" />
                      <span className="grp-name">{g.label}</span>
                      {pinned && <Icon name="pin" className="grp-pinned" />}
                      <span className="grp-count">{g.count}</span>
                    </button>
                    <button
                      type="button"
                      className={`grp-pin${pinned ? ' is-on' : ''}`}
                      onClick={() => togglePin(g.key)}
                      aria-label={`${pinned ? t('shell.unpin') : t('shell.pinDir')} ${g.label}`}
                      title={pinned ? t('shell.unpin') : t('shell.pinDir')}
                    >
                      <Icon name="pin" />
                    </button>
                    {g.newDir && (
                      <button
                        type="button"
                        className="grp-new"
                        onClick={() => navigate(`/new?cwd=${encodeURIComponent(g.newDir as string)}&agent=${g.newAgent}`)}
                        aria-label={t('shell.newInDir', { dir: g.label })}
                        title={t('shell.newInDir', { dir: g.label })}
                      >
                        <Icon name="plus" />
                      </button>
                    )}
                  </div>

                  {open && (
                    <ul className="rows">
                      {g.threads.map((thread) =>
                        thread.map((m, i) => (
                          <Row
                            key={m.key}
                            m={m}
                            selected={m.key === selectedKey}
                            now={now}
                            thread={thread.length > 1 ? { head: i === 0, tail: i === thread.length - 1 } : null}
                            forkLabel={!!m.parentId && thread.length === 1}
                            canOpenTerminal={canOpenTerminal}
                          />
                        )),
                      )}
                    </ul>
                  )}
                </section>
              );
            })}
        </div>

        <div className="rail-foot">
          <Link to="/about" className="rail-settings" title={`${t('shell.settings')} (${keyLabel('mod+,')})`}>
            <Icon name="gear" />
            {t('shell.settings')}
          </Link>
          <span className="rail-foot-tools">
            {isOwner && (
              <button
                type="button"
                className="icon-btn"
                onClick={openUsage}
                aria-label={t('shell.usage')}
                title={t('shell.usage')}
              >
                <Icon name="gauge" />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPrefs({ theme: THEME_NEXT[prefs.theme] })}
              aria-label={t('shell.themePrefix', { theme: t(THEME_KEY[prefs.theme]) })}
              title={t('shell.themePrefix', { theme: t(THEME_KEY[prefs.theme]) })}
            >
              <Icon name={prefs.theme === 'dark' ? 'moon' : prefs.theme === 'light' ? 'sun' : 'auto'} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={openShortcuts}
              aria-label={t('shell.shortcuts')}
              title={`${t('shell.shortcuts')} (${keyLabel('mod+/')})`}
            >
              <Icon name="keyboard" />
            </button>
          </span>
        </div>

        <div
          className="rail-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('shell.dragWidth')}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={() => setWidth(RAIL_DEFAULT)}
          title={t('shell.dragWidth')}
        />
      </aside>

      <main className="stage">
        {children && scope !== undefined ? (
          <DraftScope.Provider value={scope} key={scope}>
            <CanOpenTerminalCtx.Provider value={canOpenTerminal}>
              <MembersCtx.Provider value={members}>{children}</MembersCtx.Provider>
            </CanOpenTerminalCtx.Provider>
          </DraftScope.Provider>
        ) : (
          <div className="stage-empty">
            <p className="stage-line">
              <span className="bounce" aria-hidden="true" />
              {t('shell.loadingSessions')}
            </p>
          </div>
        )}
      </main>

      {palette && <Palette members={members} current={selectedKey} isOwner={isOwner} canOpenTerminal={canOpenTerminal} onClose={() => setPalette(false)} />}
      {keys && <ShortcutsDialog onClose={() => setKeys(false)} />}
      {usage && isOwner && <UsageDialog onClose={() => setUsage(false)} />}
      <Toasts />
    </div>
  );
}

/**
 * 列表里的一行。悬停时右边出一个「…」：新标签页打开、复制链接、置顶所在目录。
 *
 * `dup`：同一条会话在「等你处理」里又出现一次。那一份不挂 data-row-key——
 * 「选中项滚进视野」找的是它在正文列表里的那一行。
 */
function Row({
  m, selected, now, showDir = false, thread = null, forkLabel = false, dup = false, canOpenTerminal = false,
}: {
  m: Member;
  selected: boolean;
  now: number;
  showDir?: boolean;
  thread?: { head: boolean; tail: boolean } | null;
  forkLabel?: boolean;
  dup?: boolean;
  canOpenTerminal?: boolean;
}) {
  const href = `/session/${encodeURIComponent(m.key)}`;
  const gk = groupOf(m).key;
  const pinned = usePrefs().pinned.includes(gk);
  /*
    一行只放标题（owner 2026-11-11：「每个对话都用单行显示，codex 和 claude 的标注以及时间显示放在
    鼠标移动上去后的悬浮窗」）。原来那行小字里的东西一样不少，挪进悬停 0.35 秒后浮出来的卡片：
    完整标题（这一行放不下时会被截）、agent、多久前、在哪个目录（「最近」视图里各组混在一起时才需要）、
    状态。读屏器从链接的 aria-label 拿到同样这些
  */
  const { t } = useI18n();
  const facts = [
    m.agent,
    ago(m.mtimeMs, now),
    ...(showDir ? [m.project?.name ?? dirLabel(m.cwd)] : []),
    ...(m.running ? [t('shell.statusRunning')] : m.waiting ? [t('shell.statusWaiting')] : []),
    ...(m.isArchived ? [t('shell.archived')] : []),
    // 原件被「隐藏已归档」滤掉时，这条分叉会单独出现——不标一下就成了一条来历不明的会话
    ...(forkLabel ? [t('shell.fork')] : []),
  ];
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTip(null);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // 侧栏一滚，卡片就该跟着走——简单起见直接收起
  useEffect(() => {
    if (!tip) return;
    const off = () => setTip(null);
    window.addEventListener('scroll', off, true);
    return () => window.removeEventListener('scroll', off, true);
  }, [tip]);
  return (
    <li
      // 多成员的链才连线。一条链只剩一个成员时画根线只是噪音
      className={`row-li${thread ? ` in-thread${thread.head ? ' is-head' : ''}${thread.tail ? ' is-tail' : ''}` : ''}`}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const r = el.getBoundingClientRect();
          setTip({ top: r.top + r.height / 2, left: r.right + 8 });
        }, 350);
      }}
      onMouseLeave={hide}
      // 按下这一行里的任何东西（点开、点「…」菜单）卡片都让开
      onMouseDown={hide}
    >
      <Link
        to={href}
        className={`row${selected ? ' is-on' : ''}`}
        aria-current={selected ? 'page' : undefined}
        aria-label={`${m.title}，${facts.join('，')}`}
        data-row-key={dup ? undefined : m.key}
        onClick={hide}
      >
        {/* 在跑的那颗在拍球；等人点确认的那颗实心但不动——
            一个是等它，一个是等你，不能长一样 */}
        <span className={`rdot${dotKind(m)}`} aria-hidden="true" />
        <span className="row-title">{m.title}</span>
      </Link>
      {tip && createPortal(
        <div className="row-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          <span className="row-tip-title">{m.title}</span>
          <span className="row-tip-meta">
            <span className="row-agent">{m.agent}</span>
            {facts.slice(1).map((f) => <span key={f}>{f}</span>)}
          </span>
        </div>,
        document.body,
      )}
      <Menu
        label={t('shell.sessionActions')}
        align="end"
        items={[
          ...(canOpenTerminal && m.supportsTerminal
            ? [{ label: t('shell.openTerminal'), onSelect: () => { void openSessionTerminal(m.key); } }]
            : []),
          { label: t('shell.openNewTab'), onSelect: () => window.open(href, '_blank', 'noopener') },
          { label: t('shell.copyLink'), onSelect: () => copyText(new URL(href, window.location.origin).href, t('shell.copiedLink')) },
          { label: pinned ? t('shell.unpin') : t('shell.pinDir'), onSelect: () => togglePin(gk) },
        ]}
        trigger={(p) => (
          <button type="button" {...p} className="row-more" aria-label={m.title} title={t('shell.moreActions')}>
            <Icon name="more" />
          </button>
        )}
      />
    </li>
  );
}

/**
 * 侧栏用到的几个线条图标。画出来比拉一个图标库便宜，而且线宽、端点和别处的图形一致。
 * 全部 16×16、currentColor。
 */
export function Icon({ name, className }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    sidebar: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M6.5 3v10" />
      </>
    ),
    plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
    // 右侧窗格开关：和侧栏那颗左右对称
    panel: (
      <>
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M9.5 3v10" />
      </>
    ),
    // /goal 的目标
    target: (
      <>
        <circle cx="8" cy="8" r="5.6" />
        <circle cx="8" cy="8" r="2.6" />
        <circle cx="8" cy="8" r="0.5" fill="currentColor" />
      </>
    ),
    search: (
      <>
        <circle cx="7" cy="7" r="4.4" />
        <path d="m10.3 10.3 3.2 3.2" />
      </>
    ),
    filter: <path d="M2.8 4.2h10.4M4.8 8h6.4M6.8 11.8h2.4" />,
    pin: <path d="M9.6 2.6 13.4 6.4 11 7.6 8.9 10.4 9.1 12.4 3.6 6.9 5.6 7.1 8.4 5 9.6 2.6ZM6.2 9.8 2.8 13.2" />,
    more: (
      <g fill="currentColor" stroke="none">
        <circle cx="3.6" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="12.4" cy="8" r="1.25" />
      </g>
    ),
    gear: (
      <>
        <circle cx="8" cy="8" r="2.1" />
        <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
      </>
    ),
    keyboard: (
      <>
        <rect x="1.8" y="4" width="12.4" height="8" rx="1.8" />
        <path d="M4.4 6.6h.01M6.8 6.6h.01M9.2 6.6h.01M11.6 6.6h.01M5.2 9.4h5.6" />
      </>
    ),
    terminal: (
      <>
        <rect x="1.8" y="3" width="12.4" height="10" rx="2" />
        <path d="m4.8 6.2 2.2 1.8-2.2 1.8M8.4 9.8h2.8" />
      </>
    ),
    sun: (
      <>
        <circle cx="8" cy="8" r="2.8" />
        <path d="M8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" />
      </>
    ),
    moon: <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6Z" />,
    gauge: (
      <>
        <path d="M2.6 11.6a5.6 5.6 0 1 1 10.8 0" />
        <path d="M8 9.6 10.6 6" />
        <circle cx="8" cy="9.8" r="0.9" fill="currentColor" />
      </>
    ),
    auto: (
      <>
        <circle cx="8" cy="8" r="5.6" />
        <path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4Z" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg
      className={`ico${className ? ` ${className}` : ''}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
