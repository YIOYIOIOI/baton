import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './modal.css';

/**
 * 居中浮窗：一层遮罩 + 一块卡片。模型配置和工作目录选择共用它。
 *
 * ## 为什么不再是贴着药丸的下拉
 *
 * owner：「模型选择和文件夹选择……改成弹出浮窗而不是目前的下拉窗口」。下拉的
 * 几何是被输入框位置牵着走的：新建页居中、会话页贴底，两边方向相反，高度只能封到
 * 半屏（45vh），目录树和模型列表都挤在一块 420 宽的小盒子里。浮窗不跟任何按钮
 * 绑定，宽高都按视口给，两页长得一样。
 *
 * ## 挂到 body 上（portal）
 *
 * 药丸所在的那几层带入场动画，`transform` 会让 `position: fixed` 改认它当包含块，
 * 浮窗就被关进输入框那一小块里了。挂到 body 上，谁的样式都管不着它。
 *
 * ## 关法
 *
 * Esc、点遮罩、右上角的 ×，三个都要：键盘、鼠标、找按钮的人各走各的。点遮罩认
 * pointerdown **且**起点就在遮罩上——在卡片里按下、拖到外面松手（选文字常这样）
 * 不算点了外面。
 *
 * 焦点：打开时落进卡片，Tab 在卡片里转圈，关掉后还给打开它的那个按钮。
 */
export function Modal({
  title, hint, onClose, footer, className, children,
}: {
  title: string;
  hint?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** 卡片上的附加类，用来给各自的宽度与内部布局 */
  className?: string;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  // 最新的 onClose 存在 ref 里：调用方每次渲染都给一个新函数，
  // 不这样的话下面那个 effect 每次渲染都要重挂一遍键盘监听
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    // 里面有 autoFocus 的输入框就让它拿着，否则落在卡片本身
    if (!card.current?.contains(document.activeElement)) card.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !card.current) return;
      const els = [...card.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // 按钮可能已经随页面卸掉了，那就算了
      if (back?.isConnected) back.focus();
    };
  }, []);

  return createPortal(
    <div
      className="dlg-scrim"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={card}
        className={`dlg${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="dlg-head">
          <div className="dlg-titles">
            <h2 className="dlg-title">{title}</h2>
            {hint && <p className="dlg-hint">{hint}</p>}
          </div>
          <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="dlg-body">{children}</div>
        {footer && <footer className="dlg-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
