import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Agent } from './api';
import { useSlash } from './SlashMenu';
import './inputbox.css';

/**
 * 输入框本体：自动长高的 textarea + 发送键，外加可选的一排药丸。
 *
 * **抽出来是因为新建页和会话页必须是同一个控件，不是两个长得像的。**
 * 新建页照 Claude / ChatGPT 的做法就是「一个还没开始的会话」——那么它的输入框
 * 和会话里那个不一致的话，这个说法当场就破了（自动长高的手感、中文输入法的
 * 回车、粘贴传文件，任何一处不同都看得出来）。
 *
 * 周边的东西**不**收进来：选择题、回到最新、分叉，那些只有会话页有；新建页有它
 * 自己的药丸。硬塞进一个组件只会得到一堆 optional prop。
 *
 * **停止收进来了**（2026-10-10）：它就是发送键的另一个样子。跑着的时候、输入框
 * 空着，那颗键是停止；一打字它又变回发送——Baton 允许边跑边说，打出来的那句会排队。
 * Claude Code 桌面版、ChatGPT、Claude.ai 都是这一颗键两用，没有第二颗。
 * 原来停止在输入框上方单独一行「运行中 2818s 停止」，和状态栏的 46:58 说的是同一件事。
 */

/** 输入框最高多少。超过就自己滚，不把上面的内容挤没。 */
const MAX_INPUT_H = 200;

export function InputBox({
  value, onChange, onSubmit, onFiles, disabled, sending, placeholder, pills, extra, hasAttachments,
  running, onStop, slashKey, slashAgent, onInterrupt,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** 不传就不接管粘贴——新建页还没有会话，没地方放文件 */
  onFiles?: (files: File[]) => void;
  disabled?: boolean;
  sending?: boolean;
  placeholder: string;
  /**
   * 输入框**底下**那排药丸。会话页放配置条，新建页放「配置」和「工作目录」。
   *
   * 原来在输入框上方。挪下来是因为上方那一截正文还看得见——没有底色的一行字
   * 摆在那儿，正文就从它底下滚过去，字叠着字（owner 2026-10-10 截图）。
   * Claude Code 桌面版的模型、强度、权限也都在输入框底下。
   */
  pills?: ReactNode;
  /** 圆角容器里、发送键左边的附加动作。会话页放「分叉」，新建页没有 */
  extra?: ReactNode;
  /** 有附件时即使正文为空也能发——「看看这张图」正文本来就是空的 */
  hasAttachments?: boolean;
  /** 这一轮正在跑。和 onStop 一起给了，发送键在没东西可发的时候就是停止 */
  running?: boolean;
  onStop?: () => void;
  /** 给了就在打 `/` 时弹这个会话能用的命令（SlashMenu.tsx）。新建页不给 */
  slashKey?: string;
  /** 这个会话的 agent：Codex 另认 `$`，插进去的也是 `$名字` */
  slashAgent?: Agent;
  /**
   * 插队：停下正在跑的这一轮，马上发这条（owner 2026-11-14：「还是不能自己选择插队还是排队啊」）。
   * 给了，跑着的时候框里有字就多一颗「插队」，Ctrl/⌘+Enter 也是它；回车照旧是排队
   */
  onInterrupt?: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const empty = !value.trim() && !hasAttachments;
  const stopping = Boolean(running && onStop && empty && !sending);
  const slash = useSlash({ value, onChange, sessionKey: slashKey, agent: slashAgent, taRef: ta });
  const canCut = Boolean(running && onInterrupt && !empty && !sending);

  // 跟着内容长高，封顶后自己滚。先置 auto 再读 scrollHeight——
  // 不重置的话高度只增不减，删字之后框子不会缩回去。
  //
  // overflow 必须在这里一起切，不能在 CSS 里写死 auto：全局的滚动条样式会让
  // Chromium 给 overflow:auto 的元素**常驻预留 10px 轨道**，于是空输入框右边
  // 也挂着一条灰线（offsetWidth 716 vs clientWidth 706，实测）。
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_INPUT_H);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_INPUT_H ? 'auto' : 'hidden';
  }, [value]);

  return (
    <>
      {/* 输入框与发送键在同一个圆角容器里：它们是一个动作的两半 */}
      <div className="composer-box">
        {slash.node}
        {/*
          加号：**点开系统文件框**。

          传文件本来就能用——拖拽和粘贴都接了（useFileDrop / onPaste）。但那两条
          都是「你得先知道可以这么干」的隐藏手势，界面上一个字都没有说。
          owner：「网页端（电脑）我看好像聊天框左侧没有加号？现在能不能上传文件？」
          ——能，只是没入口。这颗就是那个入口，三条路通向同一个 onFiles。

          这个入口就是一个铺在加号上的真 file input（见下），不是按钮。
          `onFiles` 没传就整个不画——新建页还没有会话，没地方放文件。
        */}
        {onFiles && (
          <span className="attach" title="传个文件（也可以直接拖进来或粘贴）">
            <span className="attach-plus" aria-hidden="true" />
            {/*
              **手指直接落在这个 input 上，不是落在一颗按钮上再由 JS 去点它。**

              原来是 `display:none` 的 input + `button.onClick` 里 `input.click()`。
              那条路在受限 WebView 里会整个失效：微信内置浏览器（以及 iOS 上的
              早期版本）只对**用户真的点到的、并且真的渲染出来的** file input
              弹选择器，对合成点击不弹——而且不报错，promise 也永远不 resolve，
              表现就是「点加号完全没反应」。owner 的朋友卡的就是这里。

              把 input 铺满整颗加号、opacity:0 摆在最上层之后，这一类问题整类消失：
              没有合成点击、没有用户手势激活窗口的问题、没有「没渲染」这回事。
              代价只是不能用 button 的样式——而它本来就只画了一个加号。

              加号本身交给下面那个 span，`aria-hidden` 防止读屏读两遍；
              无障碍名字挂在 input 上（它才是真正那个控件）。
            */}
            <input
              type="file"
              multiple
              className="attach-input"
              disabled={disabled}
              aria-label="传个文件"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) onFiles(files);
                // 清空，否则连续选同一个文件第二次不触发 change
                e.target.value = '';
              }}
            />
          </span>
        )}
        <textarea
          ref={ta}
          className="input"
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            slash.onCaret(e.target.selectionStart);
          }}
          // 光标挪到别处（点击、方向键）菜单要跟着：它看的是光标所在那个词
          onSelect={(e) => slash.onCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            if (!onFiles) return;
            // 截图直接粘进来是最常见的传图方式。**只在真有文件时接管**——
            // 粘贴普通文字的 clipboardData.files 是空的，拦了就把粘贴弄坏了
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return;
            e.preventDefault();
            onFiles(files);
          }}
          onKeyDown={(e) => {
            // 命令菜单开着时，方向键、回车、Tab、Esc 先归它
            if (slash.onKeyDown(e)) return;
            // 跑着的时候 Ctrl/⌘+Enter = 插队
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCut && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onInterrupt?.();
              return;
            }
            // Enter 发送、Shift+Enter 换行。isComposing 那条不能省：
            // 中文输入法回车是在选词，不是在发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
            // Esc 停掉正在跑的这一轮——Claude Code 自己就是这个键。只在真有一轮在跑、
            // 而且不是输入法在用 Esc 取消选词时才算
            if (e.key === 'Escape' && running && onStop && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onStop();
            }
          }}
        />
        {extra}
        {canCut && (
          <button
            className="send-cut"
            type="button"
            onClick={onInterrupt}
            title="插队：停下正在跑的这一轮，马上发这条（Ctrl+Enter）。回车是排队，等这一轮跑完再发"
          >
            插队
          </button>
        )}
        {stopping ? (
          // 墨色、方块：和那颗蓝色的发送一眼分得开。按下去是把这一轮掐掉，不是再交一棒
          <button className="send is-stop" type="button" onClick={onStop} aria-label="停止这一轮" title="停止这一轮">
            <span className="send-stop" />
          </button>
        ) : (
          <button
            className="send"
            type="button"
            onClick={onSubmit}
            disabled={disabled || empty || sending}
            aria-label={running ? '排队：这一轮跑完再发' : '发送'}
            title={running ? '排队：这一轮跑完再发（Enter）' : undefined}
          >
            {sending ? <span className="send-wait" /> : <span className="send-arrow" />}
          </button>
        )}
      </div>

      {pills && <div className="pills">{pills}</div>}
    </>
  );
}
