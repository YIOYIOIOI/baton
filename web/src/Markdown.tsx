import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { useI18n } from './i18n';
import { copyText } from './ui';

/**
 * Markdown 渲染。
 *
 * 之前是手写的：按 ``` 切代码块 + 行内粗体/代码/链接。够用，但列表、表格、
 * 标题、引用全都塌成纯文本，而 agent 的输出里这些天天出现。换成 react-markdown
 * ——`assistant-ui` 的 `@assistant-ui/react-markdown` 用的也是它。
 *
 * **安全性**：react-markdown 默认**不渲染裸 HTML**（要 rehype-raw 才会），
 * 所以 agent 输出里的 `<script>` 只会被当字面量显示。这里不装 rehype-raw。
 * 链接再加一道：只放行 http(s)，`javascript:` 一类降级成纯文本。
 *
 * remark-gfm 带来表格、删除线、任务列表、自动链接——GitHub 风格是 agent
 * 输出事实上的方言。
 *
 * 行内代码与块级代码**用 CSS 区分**（`.md pre code` vs `.md code`），
 * 不在 JS 里判断：react-markdown v10 已经不再传 `inline` 了，靠猜容易出错。
 */

/** 只有 http(s) 能点出去。其余降级成纯文本——agent 输出里的 javascript: 不该是可点目标。 */
function safeHref(href?: string): string | null {
  if (!href) return null;
  return /^https?:\/\//i.test(href) ? href : null;
}

/**
 * 这条链接是不是**指向这个会话工作目录里的一个文件**。
 *
 * agent 本来就在发这种链接——那是 Claude Code 系统提示自己要求的写法
 * （"format them as markdown links… Use the path relative to the working
 * directory as the href"，例子 `[foo.ts](src/utils/foo.ts)`）。上一版这里
 * 把它们一律降级成 `<span>`，于是 owner 看到的是一段不能点的灰字。
 *
 * 排除掉协议、锚点和绝对 URL 之后剩下的就当相对路径。宁可把一个怪地址当文件
 * （点了服务端回 404），也不要把真的文件路径变成不可点的死字。
 *
 * `:42` 这种行号后缀要剥掉：宿主那边用它跳行，我们这儿要取整个文件。
 */
function filePath(href?: string): string | null {
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
  return href.replace(/:\d+(:\d+)?$/, '') || null;
}

/** 代码块里的纯文本。react-markdown 给的是一棵 React 节点，逐层把字符串拼出来 */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function langOf(node: ReactNode): string | null {
  // <pre> 的孩子是 <code className="language-xxx">
  const child = Array.isArray(node) ? node[0] : node;
  const cls =
    child && typeof child === 'object' && 'props' in child
      ? ((child as { props?: { className?: string } }).props?.className ?? '')
      : '';
  const m = /language-([\w+-]+)/.exec(cls);
  return m ? m[1] : null;
}

export const Markdown = memo(function Markdown({
  text, sessionKey,
}: {
  text: string;
  /** 传了才把相对路径链接接到下载端点上。没有会话上下文的地方（比如新建页）不传。 */
  sessionKey?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const safe = safeHref(href);
            if (safe) {
              return (
                <a href={safe} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }
            // 工作目录里的文件：点了就下载。凭据走 HttpOnly cookie，
            // 所以直接挂地址就行，不用先 fetch 成 blob
            const rel = sessionKey ? filePath(href) : null;
            if (rel) {
              return (
                <a className="md-file" href={api.fileUrl(sessionKey as string, rel)} download>
                  {children}
                </a>
              );
            }
            return <span>{children}</span>;
          },

          img({ src, alt }) {
            const ext = safeHref(src);
            if (ext) {
              let host = 'link';
              try {
                host = new URL(ext).host;
              } catch {
                // fallback
              }
              return (
                <a className="md-extimg" href={ext} target="_blank" rel="noopener noreferrer">
                  [{t('conv.extImg', { host })}]
                </a>
              );
            }
            const rel = sessionKey ? filePath(src) : null;
            if (rel) {
              return <img className="md-img" src={api.fileUrl(sessionKey as string, rel)} alt={alt || rel} loading="lazy" />;
            }
            return <span>{alt || '[image]'}</span>;
          },

          /*
            代码块右上角：语言 + 复制。复制是 Claude 每个代码块上都有的那一下——agent 给的命令、
            片段，十有八九是要拿去贴的。放在 <pre> 外面那层上：<pre> 自己会横向滚，
            按钮挂在里面会跟着滚走。
          */
          pre({ children }) {
            const lang = langOf(children);
            return (
              <div className="md-code">
                <pre className="md-pre">{children}</pre>
                <span className="md-code-bar">
                  {lang && <span className="md-lang">{lang}</span>}
                  <button
                    type="button"
                    className="md-copy"
                    onClick={() => copyText(textOf(children).replace(/\n$/, ''), t('conv.copiedCode'))}
                    aria-label={t('conv.copyCode')}
                    title={t('conv.copyCode')}
                  >
                    {t('conv.copyLabel')}
                  </button>
                </span>
              </div>
            );
          },

          // 宽表格自己横向滚，不许把整条消息顶宽
          table({ children }) {
            return (
              <div className="md-tablewrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
