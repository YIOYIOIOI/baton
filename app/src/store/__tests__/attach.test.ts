import { attachmentSuffix, splitAttachments, type Attachment } from '../attach';

const file = (relative: string, bytes = 1024): Attachment => ({
  name: relative.split('/').pop() as string,
  bytes,
  relative,
  previewUri: null,
  isImage: /\.png$/.test(relative),
});

/**
 * 末尾那段附件清单是**写给 agent 的**，不该出现在用户自己的气泡里。
 *
 * owner 实测截图里，他发的那条消息下面原样贴着
 * 「附件（已放在工作目录下）：- .baton-uploads/IMG_1350-2.png（1016 KB）…」，
 * 原话：「不要带上那个"附件：已放在"那个是给 agent 看的不是给我看的」。
 *
 * 但**发送的内容一个字都不能改**：两个 CLI 都只认磁盘路径，没有附件通道
 * （见 docs/ops/agent-protocol.md），删了它 agent 就读不到文件。
 * 所以只能在渲染时切一刀——下面这组钉的就是那一刀切得准不准。
 */
describe('把正文和附件清单拆开', () => {
  test('拆出正文与文件，正文末尾不留空行', () => {
    const text = `看看这两张图${attachmentSuffix([file('.baton-uploads/a.png', 1016 * 1024), file('.baton-uploads/b.pdf', 2048)])}`;
    const { body, files } = splitAttachments(text);
    expect(body).toBe('看看这两张图');
    expect(files.map((f) => f.relative)).toEqual(['.baton-uploads/a.png', '.baton-uploads/b.pdf']);
  });

  /** 文件名只取最后一段：整条路径在气泡里又长又没用，人认的是文件名。 */
  test('标签用文件名，不是整条路径', () => {
    const { files } = splitAttachments(`x${attachmentSuffix([file('.baton-uploads/IMG_1350-2.png')])}`);
    expect(files[0].label).toBe('IMG_1350-2.png');
    expect(files[0].isImage).toBe(true);
  });

  test('没有附件时原样返回', () => {
    expect(splitAttachments('就是一句普通的话')).toEqual({ body: '就是一句普通的话', files: [] });
  });

  /**
   * **宁可多显示，也不要吞掉用户真写的字。**
   *
   * 用户正文里恰好写出同样一行标题的概率不为零。所以要求它出现在末尾、
   * 且后面每一行都长得像 `- 路径（大小）`；任一条不满足就整段当正文。
   */
  test('格式对不上就整段当正文，不吞字', () => {
    const fake = '我想说说 附件（已放在工作目录下）：\n这不是清单';
    expect(splitAttachments(fake).files).toEqual([]);
    expect(splitAttachments(fake).body).toBe(fake);

    const halfBad = `正文\n\n附件（已放在工作目录下）：\n- .baton-uploads/a.png（1 KB）\n随便写的一行`;
    expect(splitAttachments(halfBad).files).toEqual([]);
    expect(splitAttachments(halfBad).body).toBe(halfBad);
  });

  /**
   * 文件名里有空格照样要认出来。
   *
   * 服务端的 `safeName` **不删空格**（它删的是控制字符、Windows 保留字符、
   * 前导点、结尾的点和空格），所以 `我的 文件.txt` 是合法落盘名。
   * 路径那一段原来写的是 `(\S+)`，遇到空格整行匹配不上，于是**整段清单被当成
   * 正文显示给人看**——正好是这段逻辑要避免的那件事。
   */
  test('文件名带空格也能拆出来', () => {
    const text = `看看这个${attachmentSuffix([file('.baton-uploads/我的 文件.txt')])}`;
    const { body, files } = splitAttachments(text);
    expect(body).toBe('看看这个');
    expect(files).toHaveLength(1);
    expect(files[0].relative).toBe('.baton-uploads/我的 文件.txt');
    expect(files[0].label).toBe('我的 文件.txt');
  });

  /** 只有附件没有文字也能发（「看看这张图」那种情况正文本来就是空的）。 */
  test('正文为空时也能拆', () => {
    const { body, files } = splitAttachments(attachmentSuffix([file('.baton-uploads/a.png')]));
    expect(body).toBe('');
    expect(files).toHaveLength(1);
  });
});
