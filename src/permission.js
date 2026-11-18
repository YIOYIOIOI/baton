import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from './config.js';

/**
 * 权限档位，**按 agent 分开**。
 *
 * ## 为什么不能共用一套
 *
 * 原来是共用的三档（default / edits / bypass），映射到两边各自的开关上。owner
 * 的原话：「权限难道不应该根据 harness 的不同也不一样吗？claude 和 codex 的权限
 * 是不同的啊」。他是对的——两边的模型根本不是一回事：
 *
 *   claude  **一个六档枚举** `--permission-mode <acceptEdits|auto|bypassPermissions
 *           |manual|dontAsk|plan>`，外加 `--dangerously-skip-permissions`
 *   codex   **两根正交的轴** `-s/--sandbox <read-only|workspace-write|
 *           danger-full-access>` 与审批开关
 *
 * 压成同一套三档的代价是：Codex 的「只读」和 Claude 的「只出方案」这两样各自
 * 独有、而且真的有用的能力，一个都表达不出来。
 *
 * ## 这些档位是实测出来的，不是照 --help 抄的
 *
 * 判据是**磁盘副作用**，不是 agent 自己的说辞——问它「跑了没有」，它可以直接
 * 把预期输出写在回答里。第一版探针就是这么骗过自己的：提示词让它 echo 一个串
 * 再复述，结果六档全「通过」，连不加任何参数的那档都「通过」。
 * 改成「建一个文件 / 读一个预置的随机串 / git init 之后看 .git 在不在」才作数。
 *
 * Claude（2026-09-15 实测，每档一次真实调用）：
 *
 *   档位          读   写   跑命令   备注
 *   default       ✓    ✗    ✗       「permission to create ... blocked」
 *   plan          ✓    ✗    ✗       「Plan mode is active」，只出方案
 *   acceptEdits   ✓    ✓    ✗       「git init needs your approval — denied」
 *   auto          ✓    ✓    ✗✗      分类器**三次全被限流**，见下
 *   dontAsk       ✓    ✗    —       「both write paths are blocked」
 *   manual        ✓    ✗    —       「needs your approval」
 *
 * 由此定下放哪几档：
 *
 *   **不放 dontAsk / manual**——它们和 default 在非交互下**行为完全一样**
 *   （能读、不能写）。放三个做同一件事的选项只是噪音。
 *
 *   **不放 auto**——它依赖一个独立的权限分类器服务，而这台机器走第三方中转，
 *   实测三次全部返回「the permission classifier is rate-limited」。给一个稳定
 *   失败的档位比不给更糟。中转换了之后可以重测再加回来。
 *
 * 另外**没有一档会挂住**——原先担心的「需要人批的档位会卡死一轮」不成立，
 * 它们都是快速失败并说明原因。这条也是实测的。
 *
 * ## Codex 这边有个前置条件，而且现在没满足
 *
 * 同一套判据测 Codex（2026-09-15）：
 *
 *   不加参数                 失败  ShellExecuteExW failed to launch setup helper: 1223
 *   --sandbox read-only      失败  同上（1223 = 操作被取消，即提权弹窗没人应答）
 *   --sandbox workspace-write **挂住 150 秒**
 *   --approve-for-me         **挂住 150 秒**
 *   --dangerously-bypass-... 成功
 *
 * `codex doctor` 直接给了根因：**elevated Windows sandbox provisioning is
 * incomplete or outdated**。凡是要用沙箱的档位都得先在这台电脑上做一次提权预置。
 *
 * 所以每一档带 `needsSandbox`。服务端会去问 doctor，没装好时这些档位是**禁用**
 * 的并写明原因——而不是让人在手机上点下去然后等一个永远不会回来的回复。
 * 这也修掉了一个现成的 bug：原来 `edits` 档在 codex 上正是 `--sandbox
 * workspace-write`。
 *
 * `--approve-for-me` 不放：它同样挂住，而且它的「自动评审」和 Claude 的 auto
 * 是同一类外部依赖，没把握之前不给。
 *
 * ## 不透传 CLI 参数
 *
 * 这条纪律没变：表写死在这里，`modeFlags` 是**查表**，表里没有的键返回该 agent
 * 的 default。这比「校验一个外来字符串再拼进 argv」更强——前者是闭集，
 * 后者是「我相信我的正则写对了」。
 *
 * ## 为什么不放 config 快照里
 *
 * `createServer({ config })` 启动时把配置快照下来，改 config.json 要重启才生效——
 * 而这个档位的全部意义就是**在手机上改**，手机上没法重启守护进程。所以每次用的
 * 时候从盘上读，不缓存。
 */

/** 每档的 `flags` 是**追加到 argv 的完整片段**，不是模板；没有任何外来字符串参与拼接。 */
const PERMS = {
  claude: [
    {
      id: 'default',
      label: '默认',
      body: '能读代码、能回答，但改文件和跑命令都会被拒绝。',
      flags: [],
    },
    {
      id: 'plan',
      label: '只出方案',
      body: '只给方案，一个字都不改。适合在手机上先问「该怎么做」。',
      flags: ['--permission-mode', 'plan'],
    },
    {
      id: 'edits',
      label: '放行改文件',
      body: '改文件不再询问。跑命令仍然会被拒绝。',
      flags: ['--permission-mode', 'acceptEdits'],
    },
    {
      id: 'bypass',
      label: '全部放行',
      body: '不再询问任何操作，包括跑命令、删文件、联网。',
      flags: ['--dangerously-skip-permissions'],
      danger: true,
    },
  ],
  codex: [
    {
      id: 'default',
      label: '默认',
      body: '跟这台电脑上 Codex 自己的设置走。要用到沙箱。',
      flags: [],
      needsSandbox: true,
    },
    {
      id: 'read',
      label: '只读',
      body: '能看不能动。写盘和联网都被沙箱挡住——Claude 那边没有对应的一档。',
      flags: ['--sandbox', 'read-only'],
      needsSandbox: true,
    },
    {
      id: 'edits',
      label: '只能写工作区',
      body: '可以改文件、跑命令，但写入被锁在工作目录里，出不去。',
      flags: ['--sandbox', 'workspace-write'],
      needsSandbox: true,
    },
    {
      id: 'bypass',
      label: '全部放行',
      body: '不再询问任何操作，也不沙箱化。包括跑命令、删文件、联网。',
      flags: ['--dangerously-bypass-approvals-and-sandbox'],
      danger: true,
    },
  ],
  antigravity: [
    {
      id: 'default',
      label: '默认',
      body: '跟随 Antigravity 当前工作区的默认审批策略。',
      flags: [],
    },
    {
      id: 'plan',
      label: '只出方案',
      body: '只分析代码并给出方案，不直接改写工作区文件。',
      flags: ['--mode', 'plan'],
    },
    {
      id: 'edits',
      label: '放行改文件',
      body: '直接修改工作区文件，高风险终端命令仍受审批策略约束。',
      flags: ['--mode', 'accept-edits'],
    },
    {
      id: 'auto',
      label: '自动执行',
      body: '自动放行改文件与常规安全命令，仅在高风险操作前询问。',
      flags: ['--mode', 'auto'],
    },
    {
      id: 'bypass',
      label: '全部放行',
      body: '跳过所有工具与终端命令审批，请谨慎开启。',
      flags: ['--dangerously-skip-permissions'],
      danger: true,
    },
  ],
};

export const AGENTS = Object.keys(PERMS);

/** 某个 agent 的全部档位。给 API 用，`flags` 不外传——那是服务端的实现细节。 */
export function listModes(agent) {
  return (PERMS[agent] ?? []).map(({ id, label, body, danger, needsSandbox }) => ({
    id, label, body, danger: !!danger, needsSandbox: !!needsSandbox,
  }));
}

export function isMode(agent, v) {
  return typeof v === 'string' && (PERMS[agent] ?? []).some((m) => m.id === v);
}

function readFile(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 这个 agent 当前的档位。非法值一律当 default，不抛：盘上的文件可能被人手改坏，
 * 读配置不该让整个进程挂掉。
 *
 * **兼容旧的标量写法。** 以前 `permissionMode` 是一个字符串（三档共用），
 * 现在是 `{ claude, codex }`。读到字符串时按「两边都用它」解释——旧值只可能是
 * default / edits / bypass，而这三个 id 在新表里两边都还在，语义也没变。
 */
export function getMode(agent, { dir = BATON_DIR } = {}) {
  const v = readFile(dir).permissionMode;
  const raw = typeof v === 'string' ? v : v?.[agent];
  return isMode(agent, raw) ? raw : 'default';
}

/** 两边当前的档位，一次读盘。API 要同时返回两边时用它。 */
export function getModes({ dir = BATON_DIR } = {}) {
  const v = readFile(dir).permissionMode;
  const out = {};
  for (const agent of AGENTS) {
    const raw = typeof v === 'string' ? v : v?.[agent];
    out[agent] = isMode(agent, raw) ? raw : 'default';
  }
  return out;
}

/**
 * 只改一个 agent 的档位，**保留文件里其余的键**、也保留另一个 agent 的档位。
 *
 * 整份覆盖会把 owner 手写的 publicUrl、workspacesRoot 这些一并抹掉——
 * 那是拿一个开关去毁掉整份配置。
 */
export function setMode(agent, mode, { dir = BATON_DIR, rename = fs.renameSync } = {}) {
  if (!isMode(agent, mode)) {
    throw new Error(`未知的权限档位：${JSON.stringify(mode)}（agent=${agent}）`);
  }
  const file = path.join(dir, 'config.json');
  const current = readFile(dir);
  // 旧的标量要先摊开成两边，否则改了 claude 会把 codex 的档位一起丢掉
  const before = typeof current.permissionMode === 'string'
    ? Object.fromEntries(AGENTS.map((a) => [a, isMode(a, current.permissionMode) ? current.permissionMode : 'default']))
    : { ...current.permissionMode };

  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `config.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({
    ...current,
    permissionMode: { ...before, [agent]: mode },
  }, null, 2)}\n`);
  rename(tmp, file);
  return mode;
}

/** 某一档在某个 agent 上要追加的参数。表里没有就退回该 agent 的 default。 */
export function modeFlags(agent, mode) {
  const table = PERMS[agent] ?? [];
  const hit = table.find((m) => m.id === mode) ?? table.find((m) => m.id === 'default');
  return hit?.flags ?? [];
}

/** 这一档要不要沙箱。服务端据此决定它在这台机器上是否可选。 */
export function needsSandbox(agent, mode) {
  return !!(PERMS[agent] ?? []).find((m) => m.id === mode)?.needsSandbox;
}
