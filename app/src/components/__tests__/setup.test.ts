import fs from 'node:fs';
import path from 'node:path';

/**
 * 配置面板的几条不变量。
 *
 * 全是**跨文件**的约束：单看任何一个文件都挑不出毛病，只有把客户端和它对服务端
 * 的假设放在一起看才成立。而这类错误不会报错、不会崩——只会让人在手机上看到一个
 * 点了没反应的选项，或者一个设了不生效的强度。
 */

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r/g, '');
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('配置面板', () => {
  /**
   * 版式：分组列表 + 打勾，**不是平铺按钮**。
   *
   * owner：「哪有菜单是这样按钮直接摆出来的？你去看下别人怎么设计的」。
   * 去看了，也拿到了他发的 Claude App 与 GPT App 两张截图——两个都是分组卡片
   * 加每行打勾。平铺药丸的硬伤不是难看：**一排药丸放不下那句解释**，
   * 而这里最要紧的两节（模型的说明、权限的后果）恰恰都要解释。
   */
  test('选项用 SelectList 呈现，不再用平铺的 Chip', () => {
    const code = strip(read('components/Setup.tsx'));
    expect(code).toMatch(/<SelectList/);
    expect(code).not.toMatch(/<Chips>/);
    expect(code).not.toMatch(/<Chip\b/);
  });

  /** 选项多、标签长的那两节走下钻子页；一眼要能看到当前值。 */
  test('思考强度与权限是「行 + 当前值 + 下钻」', () => {
    const code = strip(read('components/Setup.tsx'));
    expect(code).toMatch(/<DetailRow[\s\S]{0,200}label="思考强度"/);
    expect(code).toMatch(/<DetailRow[\s\S]{0,200}label="权限"/);
  });

  /**
   * 子页面在**同一块面板内**切，不嵌套 Modal。
   *
   * RN 上叠 Modal 有已知的层级问题，而这块面板已经踩过 GlassView
   * 「父级 opacity 为 0 就整个不渲染」那个坑，不该再往上叠一层材质。
   */
  test('子页面靠 Sheet 的 onBack 切，不新开 Modal', () => {
    const code = strip(read('components/Setup.tsx'));
    expect(code).toMatch(/onBack=/);
    // 只有二次确认那一处是独立 Sheet（它是并列的确认，不是子页）
    expect(code.match(/<Sheet\b/g)?.length).toBe(2);
    expect(strip(read('components/ui.tsx'))).toMatch(/onBack\?: \(\) => void/);
  });

  /**
   * 权限档位的值域**由服务端给**，客户端一个都不写死。
   *
   * 两个 harness 的档位集合根本不同（claude 有 plan，codex 有 read），而且会随
   * 实测结论增减。在客户端再写一份，就是在两处维护同一个事实——对不上的那天，
   * 用户会看到一个点了没反应的选项。
   */
  test('客户端不写死任何权限档位 id', () => {
    const code = strip(read('components/Setup.tsx'));
    for (const id of ['acceptEdits', 'bypassPermissions', 'workspace-write', 'read-only', 'dontAsk']) {
      expect(code).not.toMatch(new RegExp(`['"]${id}['"]`));
    }
    // 档位来自 store，而 store 来自服务端
    expect(code).toMatch(/perm\.agents\[agent\]/);
    expect(strip(read('api/types.ts'))).toMatch(/export type PermissionMode = string/);
  });

  /**
   * 改权限必须带 agent。
   *
   * 不带的话服务端只能按 claude 兜底——于是在 Codex 上改权限会**静默改到
   * Claude 头上**，而界面看起来一切正常。
   */
  test('setPermission 带 agent', () => {
    expect(strip(read('api/client.ts'))).toMatch(/setPermission: \(agent: Agent, mode: PermissionMode\)/);
    expect(strip(read('store/permission.ts'))).toMatch(/setPermission\(agent, mode\)/);
  });

  /**
   * 思考强度的可选档由**模型**决定，不是一张全局常量表。
   *
   * 实测：gpt-6-astra 能到 ultra，gpt-5.5 封顶 xhigh，默认值也不一样。
   * 给一个模型不支持的档位，CLI 不会报错，只会**静默不生效**——
   * 而「设了却没生效」比「设不了」糟得多。
   */
  test('强度可选档来自 ModelOption.efforts', () => {
    const code = strip(read('components/Setup.tsx'));
    expect(code).toMatch(/picked\?\.efforts/);
    expect(strip(read('api/types.ts'))).toMatch(/efforts: Effort\[\]/);
  });

  /**
   * 禁用的行必须说出原因。
   *
   * 唯一的禁用来源是 Codex 的沙箱没做提权预置——实测那几档会**挂住 150 秒**
   * 没有任何回应。一个不解释自己的灰行，只会让人反复去点它。
   */
  test('不可用的档位带原因，且 SelectList 会把它显示出来', () => {
    expect(strip(read('components/SelectList.tsx'))).toMatch(/o\.disabled && o\.why/);
    expect(strip(read('api/types.ts'))).toMatch(/unavailable: string \| null/);
  });

  /**
   * 模型显示的是**显示名**不是 id。
   *
   * 两张截图里两个 App 显示的都是「Opus 5」「6 Astra」，不是 claude-opus-5 /
   * gpt-6-astra。id 只进命令行。
   */
  test('模型行显示 name，不显示 id', () => {
    const code = strip(read('components/Setup.tsx'));
    expect(code).toMatch(/label: m\.name/);
    expect(code).not.toMatch(/label: m\.id/);
  });
});
