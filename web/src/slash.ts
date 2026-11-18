/**
 * 输入框里「光标所在那个词」是不是在点名命令 / 技能（2026-11-11）。纯函数，测试见 test/web-slash.test.js。
 *
 * owner：「你的 / 命令只能在刚开头用，我用 claude desktop 或者 codex 的时候随时输入 / 都支持，
 * 只要 / 前面带个空格区分」。所以认的是：光标前面那个词以记号开头，记号前面是行首或空白。
 * `a/b`、`http://x` 这种记号前面不是空白的不算。
 *
 * 记号：Claude 只有 `/`；Codex 认 `/`（打开菜单）和 `$`（它自己点名技能的写法）——选中之后插进去的
 * 一律是 agent 真认的那个（Claude `/名字`，Codex `$名字`，实测见 agent-protocol §19）。
 */
export type Token = {
  /** 记号在整段文字里的位置 */
  start: number;
  /** 光标位置（词的末尾） */
  end: number;
  /** 记号后面已经打了的那段，小写 */
  query: string;
  /** 这个词前面没有别的字——在整条消息开头 */
  atStart: boolean;
};

export function tokenAt(value: string, caret: number, marks: string): Token | null {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  let i = before.length;
  // 往回找到这个词的开头：空白处停下
  while (i > 0 && !/\s/.test(before[i - 1])) i -= 1;
  const word = before.slice(i);
  if (!word || !marks.includes(word[0])) return null;
  // 词里不能再有记号（`/a/b` 是路径，不是命令）
  if ([...word.slice(1)].some((ch) => marks.includes(ch))) return null;
  return {
    start: i,
    end: before.length,
    query: word.slice(1).toLowerCase(),
    atStart: before.slice(0, i).trim() === '',
  };
}

/** 把那个词换成选中的命令，后面补一个空格。返回新文字和新的光标位置 */
export function replaceToken(value: string, t: Token, insert: string): { value: string; caret: number } {
  const after = value.slice(t.end);
  // 后面已经有空格就借它，不再多补一个；光标都落在空格后面，接着打字
  const text = `${insert}${after.startsWith(' ') ? '' : ' '}`;
  const next = value.slice(0, t.start) + text + after;
  return { value: next, caret: t.start + insert.length + 1 };
}
