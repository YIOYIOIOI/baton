import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { api, type Agent, type SlashCommand, type SlashList } from './api';
import { replaceToken, tokenAt } from './slash';
import './slash.css';

/**
 * 输入框里打 `/` 弹出来的命令菜单（2026-11-10；11-11 改成光标处、加上 Codex）。
 *
 * owner：「相比 claude desktop 还是少了很多内容，比如目标模式，以及输入 / 的命令」，第二天：
 * 「codex 的适配去哪了？/ 命令呢？而且你的 / 命令只能在刚开头用，我用 claude desktop 或者 codex
 * 的时候随时输入 / 都支持，只要 / 前面带个空格区分」。
 *
 * - 哪里弹：光标所在那个词以 `/` 开头、前面是行首或空格（Codex 另认 `$`）。见 slash.ts
 * - 列什么：这个会话的 agent 在这个目录下真能用的（服务端 src/agent/commands.js）。
 *   Claude 在句首给全部；句中只给技能和插件命令——内置命令（/compact 这类）只在整条消息开头才执行。
 *   Codex 给它的技能（它的内置命令只在它自己的界面里，exec 不认）
 * - 插什么：agent 真认的写法——Claude `/名字`，Codex `$名字`
 */

const memo = new Map<string, SlashList>();
const GROUP: Record<SlashCommand['group'], string> = { builtin: '命令', skill: '技能', plugin: '插件' };
const headOf = (c: SlashCommand) => (c.common ? '常用' : GROUP[c.group]);

export function useSlash({ value, onChange, sessionKey, agent, taRef }: {
  value: string;
  onChange: (v: string) => void;
  /** 不给就不弹（新建页还没有会话，不知道在哪个目录） */
  sessionKey?: string;
  agent?: Agent;
  taRef: RefObject<HTMLTextAreaElement | null>;
}): {
  node: ReactNode;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 光标挪了（打字、点击、方向键）。InputBox 在 onSelect / onChange 里调 */
  onCaret: (pos: number) => void;
} {
  const [caret, setCaret] = useState(value.length);
  const marks = agent === 'codex' ? '/$' : '/';
  const token = sessionKey && agent ? tokenAt(value, caret, marks) : null;
  const [list, setList] = useState<SlashList | null>(() => (sessionKey ? memo.get(sessionKey) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // Esc 收起后，同一个位置、同一段输入不再弹；改一个字就又弹
  const [dismissed, setDismissed] = useState<string | null>(null);
  const tokenKey = token ? `${token.start}:${value}` : null;
  const open = token !== null && dismissed !== tokenKey;

  // 头一次弹的时候去取：先拿记录里的（当场回），过期或没有再让服务端去问 agent
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !sessionKey || asked.current === sessionKey) return;
    asked.current = sessionKey;
    let alive = true;
    const put = (r: SlashList) => {
      memo.set(sessionKey, r);
      if (alive) setList(r);
    };
    (async () => {
      try {
        const cached = memo.get(sessionKey);
        const r = cached && !cached.stale ? cached : await api.commands(sessionKey);
        put(r);
        if (r.stale) {
          if (alive) setLoading(true);
          put(await api.commands(sessionKey, true));
        }
      } catch {
        // 取不到就当没有命令可列，输入照常
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, sessionKey]);

  const query = token?.query ?? '';
  const items = useMemo(() => {
    if (!open || !list || !token) return [];
    const scored: Array<[number, number, SlashCommand]> = [];
    list.commands.forEach((c, i) => {
      // 句中只给能写在句中的（技能、插件命令）；句首全给
      if (!token.atStart && c.inline === false) return;
      const n = c.name.toLowerCase();
      let s = -1;
      if (!query) s = 0;
      else if (n.startsWith(query)) s = 3;
      else if (n.includes(query)) s = 2;
      else if ((c.desc ?? '').toLowerCase().includes(query)) s = 1;
      if (s >= 0) scored.push([s, i, c]);
    });
    return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 80).map((x) => x[2]);
  }, [open, list, token, query]);

  const at = Math.min(active, Math.max(0, items.length - 1));
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    rows.current[at]?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const mention = list?.mention ?? (agent === 'codex' ? '$' : '/');
  const pick = (c: SlashCommand) => {
    if (!token) return;
    const r = replaceToken(value, token, `${mention}${c.name}`);
    onChange(r.value);
    setCaret(r.caret);
    setActive(0);
    // 等这次输入框的值落地再把光标放回插入点后面
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(tokenKey);
      return true;
    }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((at + d + items.length) % items.length);
      return true;
    }
    const c = items[at];
    // 句首已经打全了一个内置命令名，回车就是发出去（/compact、/context 这种不带参数的）。
    // /goal 例外：光一个 /goal 没有条件，回车替它补个空格，等人写条件
    if (e.key === 'Enter' && !e.shiftKey && c && token?.atStart && c.group === 'builtin'
      && query === c.name.toLowerCase() && c.name !== 'goal') return false;
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      if (c) pick(c);
      return true;
    }
    return false;
  };

  // `/goal ` 之后还没写条件：说一句它是干什么的
  const goalHint = (agent === 'claude' || agent === 'antigravity') && /^\/goal\s*$/.test(value) && value.endsWith(' ');

  let node: ReactNode = null;
  if (open) {
    node = (
      <div className="slash" role="listbox" aria-label={agent === 'codex' ? 'Codex 技能' : '斜杠命令'}>
        {!list || (loading && !list.commands.length) ? (
          <p className="slash-empty">正在读这台电脑上能用的{agent === 'codex' ? '技能' : '命令'}…</p>
        ) : !items.length ? (
          <p className="slash-empty">
            {list.commands.length
              ? (token && !token.atStart && (agent === 'claude' || agent === 'antigravity') && !query
                ? '句子中间只能点名技能，这个会话没有可用的技能'
                : '没有对得上的')
              : `这个会话没有可列的${agent === 'codex' ? '技能' : '斜杠命令'}`}
          </p>
        ) : (
          <div className="slash-list">
            {items.map((c, i) => (
              <div key={c.name}>
                {/* 没在筛的时候分组：常用的在最前，其余按内置 / 技能 / 插件；在筛的时候按相关度排，不分组 */}
                {!query && (i === 0 || headOf(items[i - 1]) !== headOf(c)) && <div className="slash-group">{headOf(c)}</div>}
                <button
                  type="button"
                  ref={(el) => { rows.current[i] = el; }}
                  role="option"
                  aria-selected={i === at}
                  className={`slash-row${i === at ? ' is-active' : ''}`}
                  // 按下就选，不让输入框先失焦
                  onMouseDown={(ev) => { ev.preventDefault(); pick(c); }}
                  onMouseMove={() => { if (i !== at) setActive(i); }}
                >
                  <span className="slash-name">{mention}{c.name}</span>
                  {c.desc && <span className="slash-desc">{c.desc}</span>}
                </button>
              </div>
            ))}
          </div>
        )}
        {agent === 'codex' && list && list.commands.length > 0 && (
          <p className="slash-foot">选中后插入 <code>$名字</code>——Codex 认的是这个写法，写在哪儿都会加载那个技能</p>
        )}
        {loading && list && list.commands.length > 0 && <p className="slash-foot">正在更新…</p>}
      </div>
    );
  } else if (goalHint) {
    node = (
      <div className="slash is-hint">
        <p className="slash-empty">写下要满足的条件，agent 会一直干到满足为止才停。发 <code>/goal clear</code> 清除。</p>
      </div>
    );
  }
  return { node, onKeyDown, onCaret: setCaret };
}
