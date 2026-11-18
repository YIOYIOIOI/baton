/**
 * 附件清单的格式——**两端之间的一个协议**。
 *
 * 发消息时，附件路径以固定格式拼在正文末尾：agent 只认磁盘路径，不给它路径
 * 它就看不见文件（见 `docs/ops/agent-protocol.md`）。但那段清单**不该给人看**
 * ——owner 原话：「不要带上那个"附件：已放在"那个是给 agent 看的不是给我看的」。
 *
 * ## 为什么这里是一份副本，而不是 import 手机端那份
 *
 * app/ 与 web/ 是两个独立的包，没有共享模块的构建。仓库里已有的先例
 * （FileBrowser、fmtBytes、baseName）也都是各写各的。
 *
 * **但这一份不一样：它是协议，不是工具函数。** 两边一旦漂移，从手机发的消息
 * 在电脑上就会把那段清单原样显示成正文（这正是 2026-09-24 之前的状况——
 * 网页端压根没有这段逻辑）。所以另加了一条跨包测试钉住格式：
 * `test/attach-format.test.js` 会同时读两个文件，比对 heading 与拼接格式。
 */

export const ATTACH_HEADING = '附件（已放在工作目录下）：';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg)$/i;

/** 一个已经传上去、要随这条消息发出的附件。 */
export type Attachment = {
  name: string;
  bytes: number;
  /** 相对工作目录的路径，发消息时带给 agent */
  relative: string;
  /** 本地预览地址（blob:），只在这次页面生命周期内有效 */
  previewUri: string | null;
  isImage: boolean;
};

export function attachmentSuffix(list: { relative: string; bytes: number }[]): string {
  if (!list.length) return '';
  const lines = list.map((a) => `- ${a.relative}（${fmtBytes(a.bytes)}）`);
  return `\n\n${ATTACH_HEADING}\n${lines.join('\n')}`;
}

/** 从一条消息里摘出来的一个附件。`label` 是文件名，不含目录。 */
export type SentFile = { relative: string; label: string; isImage: boolean };

/**
 * 把消息正文和末尾那段附件清单拆开。
 *
 * 认的是 `attachmentSuffix()` 自己写出去的那个格式，不做通用解析：用户正文里
 * 恰好出现同样一行的概率不为零，所以要求它**出现在末尾**、且后面每一行都是
 * `- 路径（大小）`。任一条不满足就整段当正文——宁可多显示，也不要吞掉用户
 * 真写的字。
 *
 * 路径那一段用 `(.+?)` 而不是 `(\S+)`：服务端的 `safeName` 不删空格，
 * `我的 文件.txt` 是合法落盘名。用 `\S+` 会让这一行解析失败，于是整段清单
 * 被当成正文显示给人看——正是这段逻辑要避免的那件事。
 */
export function splitAttachments(text: string): { body: string; files: SentFile[] } {
  const marker = `\n\n${ATTACH_HEADING}\n`;
  const head = `${ATTACH_HEADING}\n`;

  /*
    两种形状都要认：
      正文 + "\n\n" + 抬头 + 清单   —— 有正文的时候
      抬头 + 清单                   —— **只发文件、一个字没写**

    后一种是发送方 `suffix.trimStart()` 出来的。只认前一种的话，纯附件消息
    的清单会原样显示给人看——而「第一条消息可以只是几个文件」正是刚加的能力。
  */
  const at = text.lastIndexOf(marker);
  const from = at >= 0 ? at + marker.length : (text.startsWith(head) ? head.length : -1);
  if (from < 0) return { body: text, files: [] };
  const bodyEnd = at >= 0 ? at : 0;

  const lines = text.slice(from).split('\n').filter((l) => l.trim());
  const files: SentFile[] = [];
  for (const line of lines) {
    const m = /^-\s+(.+?)（[^）]*）$/.exec(line.trim());
    if (!m) return { body: text, files: [] }; // 有一行不认识就整段当正文
    const relative = m[1];
    const label = relative.split(/[\\/]/).pop() || relative;
    files.push({ relative, label, isImage: IMAGE_EXT.test(relative) });
  }
  if (!files.length) return { body: text, files: [] };
  return { body: text.slice(0, bodyEnd), files };
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
