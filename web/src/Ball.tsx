/**
 * Baton 自己的标记：logo 里那颗蓝球。
 *
 * **逐笔照搬手机端的 `IconBall`**（`app/src/icons/index.tsx`），路径、粗细、
 * viewBox 一个数都没动。两端是同一个产品，这颗球是它唯一的标识——各画各的
 * 必然会漂。那边的注释说明了为什么是这个形状：
 *
 *   放射的短笔画照 handoff.png 描的：**左上两道、右侧三道**，长短不一、
 *   和球之间留空隙。不做成对称的八道——那是「太阳」的画法，而原图那种
 *   手绘式的不对称正是它的辨识度所在。圆头笔画：方头在小尺寸上会糊成方块。
 *
 * 我上一版在新建页画的是个光秃秃的实心圆，把辨识度那部分整个丢了。
 *
 * 颜色用 `currentColor`，由用它的地方给。手机端传的 `t.c.coral` 实际值是
 * `#2455ff` / `#5c82ff`（那个名字是改强调色前留下的），和网页端的 `--accent`
 * 逐字相同。
 */
export function Ball({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="5" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M5.4 9.6 L3.1 8.8" />
        <path d="M5.4 14.4 L3.1 15.3" />
        <path d="M18.6 9.6 L20.9 8.8" />
        <path d="M18.9 13.2 L21.4 13.7" />
        <path d="M17.4 16.5 L19.3 18.1" />
      </g>
    </svg>
  );
}
