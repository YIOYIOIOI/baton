import { usePermission } from '../permission';

/**
 * 客户端必须扛得住**比自己旧的服务端**。
 *
 * 这不是防御性洁癖：Baton 的全部意义就是手机连别人的电脑，两端版本必然会错开。
 * 手机上的 App 更新了、那台电脑上的守护进程还是上周的，是常态不是异常。
 *
 * owner 实测到的「点击新建会话后现在会直接出错」就是这条：`/api/permission`
 * 的响应加了 `agents` 字段，而客户端直接 `set({ agents: p.agents })`——
 * 旧服务端没这个字段，agents 变成 undefined，下一次渲染 `perm.agents[agent]`
 * 当场抛异常。
 */

const FRESH = {
  canSet: true,
  codexSandbox: 'missing',
  agents: {
    claude: {
      mode: 'plan',
      options: [
        { id: 'default', label: '默认', body: 'x', danger: false, available: true, unavailable: null },
        { id: 'plan', label: '只出方案', body: 'y', danger: false, available: true, unavailable: null },
      ],
    },
    codex: {
      mode: 'bypass',
      options: [
        { id: 'read', label: '只读', body: 'z', danger: false, available: false, unavailable: '沙箱没装好' },
        { id: 'bypass', label: '全部放行', body: 'w', danger: true, available: true, unavailable: null },
      ],
    },
  },
};

/** 升级之前的形状：三档两边共用，没有 agents、没有 codexSandbox。 */
const LEGACY = { mode: 'edits', canSet: true, modes: ['default', 'edits', 'bypass'] };

const clientWith = (body: unknown) => ({ permission: async () => body } as never);

beforeEach(() => {
  usePermission.setState({
    agents: {
      claude: { mode: 'default', options: [] },
      codex: { mode: 'default', options: [] },
      antigravity: { mode: 'default', options: [] },
    },
    canSet: false, codexSandbox: 'unknown', known: false, busy: false, err: null,
  });
});

describe('权限 store 对服务端版本的容忍', () => {
  test('新服务端：原样采用两边的档位与可用性', async () => {
    await usePermission.getState().refresh(clientWith(FRESH));
    const s = usePermission.getState();
    expect(s.agents.claude.mode).toBe('plan');
    expect(s.agents.codex.mode).toBe('bypass');
    expect(s.codexSandbox).toBe('missing');
    expect(s.agents.codex.options.find((o) => o.id === 'read')?.available).toBe(false);
    expect(s.known).toBe(true);
  });

  /**
   * 旧服务端**不能崩**，而且要还原出一个能用的界面。
   *
   * 退回空表也不行——那样权限那一页一行都没有，用户既改不了也不知道为什么。
   * 文案确实没有（旧服务端不给 body），那就没有，但档位名和当前选中是对的。
   */
  test('旧服务端：不崩，并从遗留字段还原出可用的档位', async () => {
    await usePermission.getState().refresh(clientWith(LEGACY));
    const s = usePermission.getState();

    // 这一行是崩溃的现场：agents 必须始终是个对象，两边都在
    expect(s.agents).toBeTruthy();
    expect(s.agents.claude).toBeTruthy();
    expect(s.agents.codex).toBeTruthy();

    expect(s.agents.claude.mode).toBe('edits');
    expect(s.agents.codex.mode).toBe('edits');   // 旧的是共用一档，两边同值
    expect(s.agents.claude.options.map((o) => o.id)).toEqual(['default', 'edits', 'bypass']);
    // 拿不准的一律 unknown，不要谎报 ready——那会让该灰的档位变成可点
    expect(s.codexSandbox).toBe('unknown');
    // bypass 仍然要认出是破坏性的，否则它不会标红、也不会二次确认
    expect(s.agents.claude.options.find((o) => o.id === 'bypass')?.danger).toBe(true);
  });

  test('缺胳膊少腿的响应也不崩', async () => {
    for (const bad of [{}, { canSet: true }, { agents: null }, { agents: { claude: null } }]) {
      await usePermission.getState().refresh(clientWith(bad));
      const s = usePermission.getState();
      expect(s.agents.claude).toBeTruthy();
      expect(s.agents.codex).toBeTruthy();
      expect(Array.isArray(s.agents.claude.options)).toBe(true);
    }
  });

  /**
   * 读不到就**当没问过**。
   *
   * 不要退回 default 并且标成已知——那会让一台正开着 bypass 的电脑在断线时
   * 把药丸变回常态色，而断线恰恰是最不该让人以为「那边是安全的」的时候。
   */
  test('请求失败时不动已有状态', async () => {
    await usePermission.getState().refresh(clientWith(FRESH));
    const before = usePermission.getState().agents;

    const failing = { permission: async () => { throw new Error('断线'); } } as never;
    await usePermission.getState().refresh(failing);

    expect(usePermission.getState().agents).toEqual(before);
    expect(usePermission.getState().known).toBe(true);
  });
});
