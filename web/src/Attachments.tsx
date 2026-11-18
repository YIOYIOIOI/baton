import { useState } from 'react';
import { api } from './api';
import { fmtBytes, type SentFile } from './attach';
import './attachments.css';

/**
 * 附件的两种样子：**要发出去的**（可撤掉）和**已经发出去的**（可点开）。
 *
 * 两者长得一样是刻意的——人在输入框上方看到的那几张图，发出去之后应该还是
 * 那几张图，位置和形状都不变。手机端早就是这样（Attachments.tsx），
 * 网页端到 2026-09-24 之前**完全没有**：传完直接把路径塞进草稿框，
 * 而那正是 owner 在手机端明确否决过的做法（「上传图片不要自动带上提示词」）。
 */

/** 缩略图条只需要这些。已传的和还在缓存里的都满足它。 */
export type Thumb = {
  name: string;
  bytes: number;
  /** 本地预览地址（blob:）。没有就走文件片 */
  previewUri: string | null;
  isImage: boolean;
};

/* ── 要发出去的：输入框上方那一条 ─────────────────────────────────────────── */

export function DraftAttachments({
  items, onRemove, pending = 0,
}: {
  items: Thumb[];
  onRemove: (i: number) => void;
  /**
   * 还在传的个数。挂在这一条的末尾，而不是另起一行「正在传 N 个文件…」——
   * 传完它就变成旁边那样的一张，人的视线不用挪。
   */
  pending?: number;
}) {
  if (!items.length && !pending) return null;
  return (
    <div className="atts" role="list" aria-label="这条消息要带的附件">
      {items.map((a, i) => (
        <div className="att" role="listitem" key={`${a.name}-${i}`}>
          {a.isImage && a.previewUri
            ? <img className="att-img" src={a.previewUri} alt={a.name} />
            : (
              <div className="att-file">
                <span className="att-name" title={a.name}>{a.name}</span>
                <span className="att-size">{fmtBytes(a.bytes)}</span>
              </div>
            )}
          {/*
            叉号的文案是「不带上」不是「删除」：文件已经在那台电脑的
            .baton-uploads/ 里了，这里删不掉它，也不该假装删得掉。
          */}
          <button
            type="button"
            className="att-x"
            onClick={() => onRemove(i)}
            aria-label={`不带上 ${a.name}`}
            title="不带上这个"
          >
            ×
          </button>
        </div>
      ))}
      {pending > 0 && (
        <div className="att att-pending" role="listitem">
          <span className="bounce" aria-hidden="true" />
          <span>正在传 {pending} 个</span>
        </div>
      )}
    </div>
  );
}

/* ── 已经发出去的：气泡下面那一排 ─────────────────────────────────────────── */

/**
 * 一条消息里带的附件。正文里那段清单是**写给 agent 的**，人不该看见
 * （owner：「不要带上那个"附件：已放在"那个是给 agent 看的不是给我看的」），
 * 所以调用方先用 `splitAttachments` 切开，正文照常渲染，清单换成这些片。
 *
 * 图片直接 `<img src>` 指向上传读回口：网页端凭据是 HttpOnly cookie，
 * 同源请求浏览器自己带上。取不到（文件被挪走/删了）就退回文件片，
 * 不留一个破图。
 */
export function SentAttachments({
  files, sessionKey,
}: {
  files: SentFile[];
  sessionKey: string;
}) {
  if (!files.length) return null;
  return (
    <div className="atts atts-sent" role="list">
      {files.map((f) => (
        <SentOne key={f.relative} file={f} sessionKey={sessionKey} />
      ))}
    </div>
  );
}

function SentOne({ file, sessionKey }: { file: SentFile; sessionKey: string }) {
  /*
    取不到图就退回文件片，别留一个破图。

    **不需要在 effect 里重置它**：上面按 `key={f.relative}` 渲染，换了文件就是
    换了组件实例，state 自然是新的；换会话更是整棵重挂。原来那个
    `useEffect(() => setBroken(false), [...])` 是多余的，还会触发
    set-state-in-effect 那条 lint。
  */
  const [broken, setBroken] = useState(false);
  const href = api.fileUrl(sessionKey, file.relative);
  const leaf = file.relative.split(/[\\/]/).pop() || file.relative;

  return (
    <a
      className="att att-sent"
      role="listitem"
      href={href}
      download={leaf}
      title={`下载 ${leaf}`}
    >
      {file.isImage && !broken
        ? (
          <img
            className="att-img"
            src={api.uploadUrl(sessionKey, leaf)}
            alt={leaf}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        )
        : (
          <div className="att-file">
            <span className="att-name">{file.label}</span>
          </div>
        )}
    </a>
  );
}
