import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

/**
 * 几样到处都要用的小零件：提示条、下拉菜单、以及唤起全局浮层的那几个事件。
 *
 * 命令面板、快捷键表挂在外壳上，但唤起它们的地方散在各处（侧栏按钮、会话页的「…」、
 * 键盘）。用 window 上的事件而不是 Context：调用方不必关心自己在不在外壳里面。
 */

// ── 全局浮层 ──────────────────────────────────────────────────────────────

export const openPalette = () => window.dispatchEvent(new Event('baton:palette'));
export const openShortcuts = () => window.dispatchEvent(new Event('baton:shortcuts'));
export const toggleRail = () => window.dispatchEvent(new Event('baton:rail'));
export const openUsage = () => window.dispatchEvent(new Event('baton:usage'));

// ── 提示条 ────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string };
let toasts: Toast[] = [];
let seq = 0;
const toastSubs = new Set<() => void>();
const emit = () => toastSubs.forEach((f) => f());

/** 底部中间一条，默认 2.4 秒后自己走；错误回执可传更长停留时间。 */
export function toast(text: string, durationMs = 2400) {
  const id = ++seq;
  toasts = [...toasts, { id, text }].slice(-3);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, durationMs);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (f) => {
      toastSubs.add(f);
      return () => toastSubs.delete(f);
    },
    () => toasts,
  );
  if (!list.length) return null;
  return createPortal(
    // role=status：读屏软件会念出来，但不打断正在念的东西
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
    </div>,
    document.body,
  );
}

/** 写剪贴板。失败（非安全上下文、旧内核）时给一句能看懂的话，不静默 */
export async function copyText(text: string, done = '已复制') {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('复制不了：浏览器没给剪贴板权限');
  }
}

// ── 下拉菜单 ──────────────────────────────────────────────────────────────

export type MenuItem =
  | {
    label: string;
    onSelect: () => void;
    hint?: string;
    /** 勾选项（单选组或开关）。undefined = 不是勾选项 */
    checked?: boolean;
    danger?: boolean;
    disabled?: boolean;
  }
  | { section: string }
  | 'sep';

/**
 * 点按钮弹出的菜单。挂到 body 上按按钮的位置摆：侧栏列表、页头都有 overflow，
 * 挂在原地会被裁掉一半。
 *
 * 位置每次打开时算一次：先往下开，下面放不下就往上；左右夹在视口里。
 * 键盘：↑↓ 移动、Enter 选、Esc 关并把焦点还给按钮。
 */
export function Menu({
  trigger, items, label, align = 'start', className,
}: {
  /** 渲染触发按钮。拿到的 props 必须原样挂到那个 <button> 上 */
  trigger: (p: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
  }) => ReactNode;
  items: MenuItem[];
  label: string;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(-1);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) btn.current?.focus();
  }, []);

  // 量完菜单自己的尺寸再定位，所以用 layout effect：先摆好再画，不闪一下
  useLayoutEffect(() => {
    if (!open || !btn.current || !box.current) return;
    const b = btn.current.getBoundingClientRect();
    const m = box.current.getBoundingClientRect();
    const gap = 6;
    let top = b.bottom + gap;
    if (top + m.height > window.innerHeight - 8 && b.top - gap - m.height > 8) top = b.top - gap - m.height;
    let left = align === 'end' ? b.right - m.width : b.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      // 菜单自己滚不算；别的地方滚了，菜单就和按钮对不上了
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    // 焦点不一定在菜单里（比如刚点开、或者鼠标用户点了别处又回来）：Esc 照样要能关
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const picks = items.map((it, i) => (typeof it === 'object' && 'onSelect' in it && !it.disabled ? i : -1)).filter((i) => i >= 0);

  // 等位置量好、菜单真的可见了再把焦点挪进去：第一帧它是 visibility:hidden，
  // 那时 focus() 会静默失败，焦点留在按钮上，键盘就操作不了菜单（实测）
  useEffect(() => {
    if (open && pos) box.current?.focus();
  }, [open, pos]);

  const run = (i: number) => {
    const it = items[i];
    if (typeof it !== 'object' || !('onSelect' in it) || it.disabled) return;
    close();
    it.onSelect();
  };

  return (
    <>
      {trigger({
        ref: btn,
        onClick: () => (open ? close() : (setActive(-1), setOpen(true))),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      })}
      {open && createPortal(
        <div
          ref={box}
          className={`menu${className ? ` ${className}` : ''}`}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          // 第一帧还没量好位置：先藏着，免得在左上角闪一下
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const at = picks.indexOf(active);
              const next = e.key === 'ArrowDown' ? picks[(at + 1) % picks.length] : picks[(at - 1 + picks.length) % picks.length];
              setActive(next ?? -1);
            } else if (e.key === 'Enter' && active >= 0) {
              e.preventDefault();
              run(active);
            } else if (e.key === 'Tab') {
              close(false);
            }
          }}
        >
          {items.map((it, i) => {
            if (it === 'sep') return <div key={i} className="menu-sep" role="separator" />;
            if ('section' in it) return <div key={i} className="menu-section">{it.section}</div>;
            return (
              <button
                key={i}
                type="button"
                role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={it.checked}
                className={`menu-item${i === active ? ' is-active' : ''}${it.danger ? ' is-danger' : ''}`}
                disabled={it.disabled}
                tabIndex={-1}
                onPointerEnter={() => setActive(i)}
                onClick={() => run(i)}
              >
                <span className="menu-check" aria-hidden="true">{it.checked ? '✓' : ''}</span>
                <span className="menu-label">{it.label}</span>
                {it.hint && <kbd className="menu-hint">{it.hint}</kbd>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── 快捷键的写法 ──────────────────────────────────────────────────────────

/** Mac 上显示 ⌘，别处显示 Ctrl。只影响显示，判断按键时两个都认 */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** 'mod+shift+o' → 'Ctrl Shift O' / '⌘ ⇧ O' */
export function keyLabel(combo: string): string {
  const mac = MOD === '⌘';
  return combo
    .split('+')
    .map((k) => ({
      mod: MOD,
      shift: mac ? '⇧' : 'Shift',
      alt: mac ? '⌥' : 'Alt',
      up: '↑',
      down: '↓',
      esc: 'Esc',
      enter: 'Enter',
    })[k] ?? k.toUpperCase())
    .join(mac ? '' : '+');
}
