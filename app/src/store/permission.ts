import { create } from 'zustand';
import { BatonError, type Client } from '@/api/client';
import type { Agent, AgentPermission, Permission, PermissionMode } from '@/api/types';

/**
 * 权限档位，**按 agent 存**。
 *
 * ## 为什么要个 store 而不是各屏各自 fetch
 *
 * 两处要用同一份：会话页从 health 里顺手更新档位，配置面板要拿完整的选项表。
 * 各自请求的话，两者之间会有一段不一致的窗口，而这一栏恰恰是最不能显示错的。
 *
 * owner 定过：bypass **不做显眼横幅**（「不要做这种这么明显提示」）。所以它的
 * 唯一出口是输入框那颗药丸变红 + 面板里那一档标红，别再往首页上加提示。
 *
 * ## 为什么两边一起存
 *
 * 配置面板里换 agent 是就地切换，权限那一行要**立刻**跟着换。分两次请求的话，
 * 切过去那一瞬间显示的还是上一个 agent 的档位——而这一栏恰恰是最不能显示错的。
 *
 * ## 不要拿 canSet 去判断「我是不是 owner」
 *
 * 它是服务端给的**一个能力位**，含义只有「这个开关你能不能动」。
 * 拿它去分支别的功能，就等于在客户端重建了一套身份判断——而服务端已经按
 * 调用者收窄过了，客户端再判一次只会和它对不上。
 * 工作区隔离那一轮的契约点名过这条坑。
 */

const EMPTY: AgentPermission = { mode: 'default', options: [] };

/**
 * 把服务端的响应收成客户端要的形状，**容忍旧服务端**。
 *
 * 这不是防御性洁癖：Baton 的全部意义就是手机连**别人的电脑**，两端必然会有
 * 版本差。上一版这里写的是 `set({ agents: p.agents })`——旧服务端没有这个字段，
 * 于是 agents 变成 undefined，下一次渲染 `perm.agents[agent]` 当场抛异常。
 * owner 实测到的「点击新建会话后现在会直接出错」就是这条。
 *
 * 旧响应长这样：`{ mode, canSet, modes: string[] }`，三档两边共用。能从它还原出
 * 一个**能用**的界面，就不要退回空表——空表意味着权限那一页一行都没有，
 * 用户既改不了也不知道为什么。文案确实没有（旧服务端不给 body），那就没有，
 * 但至少档位名和当前选中是对的。
 */
function normalize(p: Partial<Permission> & { mode?: string; modes?: string[] }): {
  agents: Record<Agent, AgentPermission>;
  canSet: boolean;
  codexSandbox: string;
} {
  const canSet = !!p.canSet;
  if (p.agents && p.agents.claude && p.agents.codex) {
    return {
      agents: {
        claude: p.agents.claude,
        codex: p.agents.codex,
        antigravity: p.agents.antigravity ?? EMPTY,
      },
      canSet,
      codexSandbox: p.codexSandbox ?? 'unknown',
    };
  }
  // 旧服务端。用它的三档给两边各造一份，标注来源是遗留字段
  const legacy: AgentPermission = {
    mode: p.mode ?? 'default',
    options: (p.modes ?? []).map((id: string) => ({
      id,
      label: id,
      body: '',
      danger: id === 'bypass',
      available: true,
      unavailable: null,
    })),
  };
  return { agents: { claude: legacy, codex: legacy, antigravity: legacy }, canSet, codexSandbox: 'unknown' };
}

type State = {
  agents: Record<Agent, AgentPermission>;
  canSet: boolean;
  /** 'ready' | 'missing' | 'unknown'——missing 时 Codex 那几档是灰的。 */
  codexSandbox: string;
  /** 还没问过服务端。药丸在这之前显示「…」——宁可晚一拍，不能凭默认值瞎报。 */
  known: boolean;
  busy: boolean;
  /** 改档失败时的说明，直接来自服务端的 fix，不自己编。 */
  err: { msg: string; fix: string } | null;

  refresh: (client: Client | null) => Promise<void>;
  /**
   * 从已有的 `/api/health` 响应里取。
   *
   * health 已经捎上了档位，会话页本来就会打它——再单开一次 /api/permission
   * 就是同一件事问两遍，而且两次之间还可能不一致。
   *
   * 但 health **只带档位不带选项表**，所以这条路只更新 mode：面板要展开时
   * 仍然要 refresh 一次拿 options。
   */
  fromHealth: (h: {
    permissionModes?: Partial<Record<Agent, PermissionMode>>;
    permissionMode: PermissionMode;
    canSetPermissionMode: boolean;
  }) => void;
  set: (client: Client | null, agent: Agent, mode: PermissionMode) => Promise<void>;
  clearErr: () => void;
};

export const usePermission = create<State>((set, get) => ({
  agents: { claude: EMPTY, codex: EMPTY, antigravity: EMPTY },
  canSet: false,
  codexSandbox: 'unknown',
  known: false,
  busy: false,
  err: null,

  async refresh(client) {
    if (!client) return;
    try {
      const p = await client.permission();
      set({ ...normalize(p), known: true });
    } catch {
      // 读不到就当没问过：**不要退回 default 并且标成已知**——
      // 那会让一台正开着 bypass 的电脑在断线时把药丸变回常态色，
      // 而断线恰恰是最不该让人以为「那边是安全的」的时候
    }
  },

  async set(client, agent, mode) {
    if (!client) return;
    set({ busy: true, err: null });
    try {
      const p = await client.setPermission(agent, mode);
      set({ ...normalize(p), known: true });
    } catch (e) {
      if (e instanceof BatonError) set({ err: { msg: e.message, fix: e.fix } });
      else set({ err: { msg: (e as Error).message, fix: '' } });
    } finally {
      set({ busy: false });
    }
  },

  fromHealth: (h) => {
    const cur = get().agents;
    // health 带了两边就用两边；旧服务端只有标量，那就只能更新 claude——
    // 而不是拿它去覆盖 codex，那会显示一个从来没设过的值
    const next = h.permissionModes ?? { claude: h.permissionMode, codex: cur.codex.mode, antigravity: cur.antigravity.mode };
    set({
      agents: {
        claude: { ...cur.claude, mode: next.claude ?? cur.claude.mode },
        codex: { ...cur.codex, mode: next.codex ?? cur.codex.mode },
        antigravity: { ...cur.antigravity, mode: next.antigravity ?? cur.antigravity.mode },
      },
      canSet: h.canSetPermissionMode,
      known: true,
    });
  },

  clearErr: () => set({ err: null }),
}));
