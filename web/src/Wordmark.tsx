/**
 * 字标：小写 baton，「o」是那颗球。样式在 shared.css 的 `.wm`。
 *
 * 画出来的那几个字母对读屏是 `aria-hidden` 的——「bat●n」念出来会是
 * 「bat n」。真名字放在旁边那个只给读屏的 span 里。
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className ? `wm ${className}` : 'wm'}>
      <span aria-hidden="true">
        bat<i className="wm-o" />n
      </span>
      <span className="sr-only">Baton</span>
    </span>
  );
}
