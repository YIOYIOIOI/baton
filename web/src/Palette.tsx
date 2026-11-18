import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Member } from './api';
import { resolveLocale, translate, useI18n, type MsgKey } from './i18n';
import { Modal } from './Modal';
import { getPrefs, setPrefs, usePrefs } from './prefs';
import { navigate } from './router';
import { ago, dirLabel } from './sessions';
import { copyText, keyLabel, openShortcuts, openUsage, toggleRail } from './ui';
import './palette.css';

export type Shortcut = { combo: string; labelKey: MsgKey; groupKey: 'palette.groupNav' | 'palette.groupInput' };

export const SHORTCUTS: Shortcut[] = [
  { combo: 'mod+k', labelKey: 'short.palette', groupKey: 'palette.groupNav' },
  { combo: 'mod+shift+o', labelKey: 'short.new', groupKey: 'palette.groupNav' },
  { combo: 'mod+b', labelKey: 'short.rail', groupKey: 'palette.groupNav' },
  { combo: 'alt+up', labelKey: 'short.prev', groupKey: 'palette.groupNav' },
  { combo: 'alt+down', labelKey: 'short.next', groupKey: 'palette.groupNav' },
  { combo: 'mod+shift+l', labelKey: 'short.last', groupKey: 'palette.groupNav' },
  { combo: 'mod+,', labelKey: 'short.settings', groupKey: 'palette.groupNav' },
  { combo: 'mod+/', labelKey: 'short.keys', groupKey: 'palette.groupNav' },
  { combo: 'enter', labelKey: 'short.send', groupKey: 'palette.groupInput' },
  { combo: 'shift+enter', labelKey: 'short.newline', groupKey: 'palette.groupInput' },
  { combo: 'esc', labelKey: 'short.stop', groupKey: 'palette.groupInput' },
];

const hint = (combo: string) => keyLabel(combo);

type Item =
  | { kind: 'cmd'; id: string; label: string; hint?: string; sub?: string; run: () => void }
  | { kind: 'session'; id: string; member: Member };

function commands(current: string | null, members: Member[] | null, isOwner: boolean, t: (k: MsgKey) => string): Item[] {
  const p = getPrefs();
  const activeLoc = resolveLocale(p.locale);
  const last = p.visited.find((k) => k !== current && members?.some((m) => m.key === k)) ?? null;
  const out: Item[] = [
    { kind: 'cmd', id: 'new', label: t('shell.newSession'), hint: hint('mod+shift+o'), run: () => navigate('/new') },
  ];
  if (last) {
    const m = members?.find((x) => x.key === last);
    out.push({
      kind: 'cmd', id: 'last', label: t('palette.cmdBackLast'), sub: m?.title, hint: hint('mod+shift+l'),
      run: () => navigate(`/session/${encodeURIComponent(last)}`),
    });
  }
  if (current) {
    out.push({
      kind: 'cmd', id: 'copy-link', label: t('palette.cmdCopyLink'),
      run: () => copyText(window.location.href, t('shell.copiedLink')),
    });
    out.push({
      kind: 'cmd', id: 'export-md', label: t('palette.cmdExportMd'),
      run: () => {
        const a = document.createElement('a');
        a.href = api.exportUrl(current);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    });
  }
  out.push(
    { kind: 'cmd', id: 'rail', label: t('short.rail'), hint: hint('mod+b'), run: toggleRail },
    { kind: 'cmd', id: 'settings', label: t('shell.settings'), hint: hint('mod+,'), run: () => navigate('/about') },
    { kind: 'cmd', id: 'keys', label: t('shell.shortcuts'), hint: hint('mod+/'), run: openShortcuts },
    ...(isOwner ? [{ kind: 'cmd' as const, id: 'usage', label: t('shell.usage'), run: openUsage }] : []),
    {
      kind: 'cmd', id: 'lang', label: t('palette.cmdLang'),
      run: () => setPrefs({ locale: activeLoc === 'zh' ? 'en' : 'zh' }),
    },
    { kind: 'cmd', id: 'theme-system', label: t('palette.cmdThemeSys'), sub: p.theme === 'system' ? t('palette.current') : undefined, run: () => setPrefs({ theme: 'system' }) },
    { kind: 'cmd', id: 'theme-light', label: t('palette.cmdThemeLight'), sub: p.theme === 'light' ? t('palette.current') : undefined, run: () => setPrefs({ theme: 'light' }) },
    { kind: 'cmd', id: 'theme-dark', label: t('palette.cmdThemeDark'), sub: p.theme === 'dark' ? t('palette.current') : undefined, run: () => setPrefs({ theme: 'dark' }) },
    {
      kind: 'cmd', id: 'list-mode', label: p.listMode === 'folders' ? t('palette.cmdListRecent') : t('palette.cmdListFolders'),
      run: () => setPrefs({ listMode: p.listMode === 'folders' ? 'recent' : 'folders' }),
    },
    {
      kind: 'cmd', id: 'archived', label: p.showArchived ? t('palette.cmdHideArch') : t('palette.cmdShowArch'),
      run: () => setPrefs({ showArchived: !p.showArchived }),
    },
    {
      kind: 'cmd', id: 'width', label: p.width === 'wide' ? t('palette.cmdWidthNorm') : t('palette.cmdWidthWide'),
      run: () => setPrefs({ width: p.width === 'wide' ? 'normal' : 'wide' }),
    },
  );
  return out;
}

/**
 * 每个词都要出现在「标题 + 目录 + agent」里才算命中（空格分词、不分大小写）。
 * 排序：标题里命中的排前面，其次在跑 / 等你的，最后按最近动过。
 */
function searchSessions(members: Member[], q: string): Member[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = members.filter((m) => {
    const hay = `${m.title} ${dirLabel(m.cwd)} ${m.project?.name ?? ''} ${m.agent}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const inTitle = (m: Member) => words.every((w) => m.title.toLowerCase().includes(w));
  return hits.sort((a, b) =>
    Number(inTitle(b)) - Number(inTitle(a))
    || Number(b.running || !!b.waiting) - Number(a.running || !!a.waiting)
    || b.mtimeMs - a.mtimeMs);
}

export function Palette({
  members, current, isOwner = true, onClose,
}: {
  members: Member[] | null;
  current: string | null;
  isOwner?: boolean;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const prefs = usePrefs();
  const [now] = useState(() => Date.now());

  // Restore focus cleanly on close and trap Tab inside the command palette dialog.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    return () => {
      if (back?.isConnected) back.focus();
    };
  }, []);

  const sections = useMemo(() => {
    const all = members ?? [];
    const tr = (k: MsgKey, vars?: Record<string, string | number>) => translate(locale, k, vars);
    const cmds = commands(current, members, isOwner, tr);
    const query = q.trim();
    if (!query) {
      const recent = prefs.visited
        .map((k) => all.find((m) => m.key === k))
        .filter((m): m is Member => !!m && m.key !== current)
        .slice(0, 6);
      const fresh = recent.length ? recent : [...all].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 6);
      return [
        { title: recent.length ? tr('palette.secRecentOpen') : tr('palette.secRecentMod'), items: fresh.map((m): Item => ({ kind: 'session', id: m.key, member: m })) },
        { title: tr('palette.secCmds'), items: cmds },
      ];
    }
    const lq = query.toLowerCase();
    return [
      { title: tr('palette.secSessions'), items: searchSessions(all, query).slice(0, 30).map((m): Item => ({ kind: 'session', id: m.key, member: m })) },
      { title: tr('palette.secCmds'), items: cmds.filter((c) => c.kind === 'cmd' && c.label.toLowerCase().includes(lq)) },
    ].filter((s) => s.items.length);
  }, [q, members, current, isOwner, prefs.visited, locale]);

  const flat = sections.flatMap((s) => s.items);

  // 选中项滚进视野
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    if (it.kind === 'session') navigate(`/session/${encodeURIComponent(it.member.key)}`);
    else it.run();
  };

  let idx = -1;
  return createPortal(
    <div
      className="dlg-scrim pal-scrim"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.label')}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && dialog.current) {
            const focusables = [...dialog.current.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
            if (focusables.length > 0) {
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }
          }
        }}
      >
        <div className="pal-top">
          <span className="pal-glass" aria-hidden="true" />
          <input
            ref={input}
            className="pal-input"
            value={q}
            autoFocus
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={flat[active] ? `pal-${active}` : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(flat.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run(flat[active]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" id="pal-list" ref={list} role="listbox">
          {flat.length === 0 && <p className="pal-empty">{t('palette.empty', { q: q.trim() })}</p>}
          {sections.map((s) => (
            <section key={s.title} className="pal-sec">
              <h3 className="pal-sec-title">{s.title}</h3>
              {s.items.map((it) => {
                idx += 1;
                const i = idx;
                return (
                  <button
                    key={`${it.kind}-${it.id}`}
                    id={`pal-${i}`}
                    data-idx={i}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`pal-item${i === active ? ' is-active' : ''}`}
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => run(it)}
                  >
                    {it.kind === 'session' ? (
                      <>
                        <span className={`pal-dot${it.member.waiting ? ' is-waiting' : it.member.running ? ' is-running' : ''}`} aria-hidden="true" />
                        <span className="pal-text">
                          <span className="pal-label">{it.member.title}</span>
                          <span className="pal-sub">
                            {it.member.agent} · {it.member.project?.name ?? dirLabel(it.member.cwd)} · {ago(it.member.mtimeMs, now)}
                            {it.member.isArchived ? ` · ${t('shell.archived')}` : ''}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="pal-cmd" aria-hidden="true">›</span>
                        <span className="pal-text">
                          <span className="pal-label">{it.label}</span>
                          {it.sub && <span className="pal-sub">{it.sub}</span>}
                        </span>
                        {it.hint && <kbd>{it.hint}</kbd>}
                      </>
                    )}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('palette.footSelect')}</span>
          <span><kbd>Enter</kbd> {t('palette.footOpen')}</span>
          <span><kbd>{keyLabel('mod+k')}</kbd> {t('palette.footInvoke')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 快捷键表。按组列，Mac 上自动显示 ⌘ ⇧ ⌥ */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const groups = ['palette.groupNav', 'palette.groupInput'] as const;
  return (
    <Modal title={t('palette.shortcutsTitle')} hint={t('palette.shortcutsHint')} className="keys-dlg" onClose={onClose}>
      <div className="keys">
        {groups.map((g) => (
          <section key={g} className="keys-sec">
            <h3 className="keys-title">{t(g)}</h3>
            {SHORTCUTS.filter((s) => s.groupKey === g).map((s) => (
              <div key={s.combo} className="keys-row">
                <span>{t(s.labelKey)}</span>
                <kbd>{keyLabel(s.combo)}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** 键盘事件是不是某个组合。mod = Ctrl 或 ⌘，两个都认 */
export function isCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const want = { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  if ((e.ctrlKey || e.metaKey) !== want.mod || e.shiftKey !== want.shift || e.altKey !== want.alt) return false;
  const k = e.key.toLowerCase();
  const map: Record<string, string[]> = {
    up: ['arrowup'], down: ['arrowdown'], esc: ['escape'], ',': [','], '/': ['/', '?'],
  };
  // 字母键用 code 判：按着 Shift 或者用了别的键盘布局时 e.key 会变
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}` || k === key;
  return (map[key] ?? [key]).includes(k);
}
