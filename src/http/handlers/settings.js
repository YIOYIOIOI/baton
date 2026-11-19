// 会话级的模型与思考强度、按 agent 的权限档位、可选模型列表。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import { assertModel, isEffort, EFFORTS } from '../../agent/args.js';
import { discoverModels, antigravityModels } from '../../models.js';
import { claudeDefaults } from '../../agent/defaults.js';
import { antigravityCatalog } from '../../agent/catalog.js';
import { getModel, setModel, setEffort, getDefaultEffort } from '../../runtime/prefs.js';
import { getModes, setMode, isMode, listModes, needsSandbox } from '../../permission.js';
import { codexSandboxState } from '../../agent/sandbox.js';
import { latestTurn } from '../../runtime/turns.js';
import { errorBody } from '../errors.js';

/**
 * 读 / 改权限档位。
 *
 * ## 为什么只有 owner 能改
 *
 * bypass 的含义是「agent 在这台机器上什么都不问就干」。访客的工作区隔离**挡不住它**：
 * 隔离是 Baton 在自己这一层按 cwd 过滤，而 bypass 放开的是 agent 自己的工具闸门——
 * 一个不问就能跑 shell 的 agent，想走出工作区只需要一条 `cd`。
 *
 * 所以这不是「访客权限小一点」，是**访客一旦能开这个开关，工作区隔离整个失效**。
 * 判据用 `roots === null`，和 scope.js 里那条边界值同一个，不另立标志位。
 *
 * 连「读」也对访客收窄：只告诉他当前档位（他需要知道自己的操作会不会被拒），
 * 但 canSet 恒为 false，界面据此把整块做成只读。
 */
/**
 * 会话的思考强度。
 *
 * 独立端点而不是塞进 `/model`：那条已经在用（网页端客户端也在调），把两件事
 * 并进一个请求体会让「只改其中一个」变成一次可能误清另一个的写。
 */
export function setSessionEffort({ repo, key, effort }) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  // null / '' = 清掉选择，回到 agent 自己的默认
  if (effort !== null && effort !== undefined && effort !== '' && !isEffort(effort)) {
    return {
      status: 400,
      body: errorBody('bad_effort', `未知的思考强度：${JSON.stringify(effort)}`,
        `只接受 ${EFFORTS.join(' / ')}。`),
    };
  }
  const saved = setEffort(key, effort || null);
  return { status: 200, body: { effort: saved } };
}

/**
 * 两个 agent 各自的档位与可选集。
 *
 * **一次返回两边**，不按请求参数只给一个：客户端那颗配置药丸上要能立刻显示
 * 「切到 Codex 之后权限是哪一档」，分两次请求的话切换那一下必然闪一帧旧值。
 *
 * `available: false` 的档位是**这台机器上用不了**的，带 `unavailable` 说明原因。
 * 目前只有一种原因：Codex 的沙箱要一次提权预置，没做的话那几档会**挂住**——
 * 实测 `--sandbox workspace-write` 150 秒没有任何回应。让人在手机上点下去然后
 * 等一个永远不回来的回复，比直接说「这台电脑上还用不了」糟得多。
 */
export async function readPermission({ principal, sandbox = codexSandboxState }) {
  const state = await sandbox();
  const canSet = (principal?.roots ?? null) === null;
  const modes = getModes();
  const agents = {};
  for (const [agent, mode] of Object.entries(modes)) {
    agents[agent] = {
      mode,
      options: listModes(agent).map((o) => ({
        ...o,
        available: !(o.needsSandbox && state === 'missing'),
        unavailable: o.needsSandbox && state === 'missing'
          ? 'Codex 的沙箱在这台电脑上还没装好，选了会一直等不到回复。'
          : null,
      })),
    };
  }
  return {
    status: 200,
    body: {
      canSet,
      agents,
      // 沙箱状态单独给一份：界面上要能把「去电脑上跑一下预置」这句话说清楚，
      // 而不是只让某几行变灰
      codexSandbox: state,
      // 旧客户端只认这两个字段。留着，值取 claude 那边——它是默认 agent，
      // 而且它的档位 id 与旧的三档同名，语义没变
      mode: modes.claude,
      modes: listModes('claude').map((o) => o.id),
    },
  };
}

export async function writePermission({ principal, agent, mode, sandbox = codexSandboxState }) {
  if ((principal?.roots ?? null) !== null) {
    return {
      status: 403,
      body: errorBody('not_owner', '只有这台电脑的主人能改权限档位。',
        '找 owner 在他自己的设备上改，或者请他给你的工作区单独放行。'),
    };
  }
  // 不传 agent 按 claude 算：旧客户端不知道有这个字段，而它们面对的一直是
  // claude 那套三档
  const a = typeof agent === 'string' && agent ? agent : 'claude';
  if (!isMode(a, mode)) {
    const ids = listModes(a).map((o) => o.id);
    return {
      status: 400,
      body: errorBody('bad_mode', `未知的权限档位：${JSON.stringify(mode)}`,
        ids.length ? `${a} 只接受 ${ids.join(' / ')}。` : `未知的 agent：${JSON.stringify(agent)}。`),
    };
  }
  // 会挂住的档位**不让选**。这不是啰嗦——它是在拦一个已知会让整轮失联的操作。
  if (needsSandbox(a, mode) && await sandbox() === 'missing') {
    return {
      status: 409,
      body: errorBody('sandbox_missing',
        'Codex 的沙箱在这台电脑上还没装好，这一档选了会一直等不到回复。',
        '在那台电脑上用管理员身份跑一次 Codex，让它完成沙箱预置；`codex doctor` 能看到状态。'),
    };
  }
  setMode(a, mode);
  // 回的是**重新读出来的值**，不是入参：写盘失败或被别的进程改掉时，
  // 回显入参就等于告诉用户一件没发生的事
  return readPermission({ principal, sandbox });
}

/**
 * 两边可选的模型。列表是从这台机器现推的，不是写死的——理由见 models.js 抬头。
 *
 * `seen: true` = 这台机器的 transcript 里真跑过。UI 要把它和「配置里写着但
 * 没跑过」区别开：后者选中后失败时，人才知道该去怀疑中转而不是怀疑 Baton。
 */
export async function listModels({
  discover = discoverModels, claude = claudeDefaults, agCatalog = antigravityCatalog, waitMs = 12_000, force = false,
} = {}) {
  let m;
  try {
    m = await discover({ force });
  } catch {
    // 扫盘失败不是致命的：返回空表，UI 退回手输，功能仍然可用
    m = { claude: [], codex: [], antigravity: [] };
  }
  /*
    Claude 的「默认」与 Antigravity 的权威模型目录（ACP / agy models）都在守护进程启动时后台预热；
    这里并行竞速 waitMs，拿到就拼进结果，超时照常返回，不让整张模型表卡死。
  */
  const [probed, agCat] = await Promise.all([
    Promise.race([
      claude({ effort: getDefaultEffort('claude') }).catch(() => null),
      new Promise((r) => { setTimeout(() => r(null), waitMs).unref?.(); }),
    ]),
    Promise.race([
      agCatalog().catch(() => null),
      new Promise((r) => { setTimeout(() => r(null), waitMs).unref?.(); }),
    ]),
  ]);
  const config = m.config ?? {};
  const agList = agCat?.models?.length ? antigravityModels({ catalog: agCat }) : (m.antigravity ?? []);
  const agCfg = {
    effort: agCat?.effort ?? config.antigravity?.effort ?? null,
    contextWindow: agCat?.contextWindow ?? config.antigravity?.contextWindow ?? null,
    defaultModel: agCat?.defaultModel ?? config.antigravity?.defaultModel ?? null,
  };
  return {
    status: 200,
    body: {
      ...m,
      antigravity: agList,
      config: {
        ...config,
        claude: { effort: null, contextWindow: null, ...config.claude, defaultModel: probed ?? null },
        antigravity: agCfg,
      },
      // 空表时 UI 要显示得体一点，而不是干瞪一个空下拉框
      note: '列表来自本地模型目录、历史用过记录与配置文件。没有想要的模型可直接输入。',
    },
  };
}

/** 设置（或清除）某个会话用哪个模型。传空字符串/null = 回到 agent 默认。 */
export function setSessionModel({ repo, key, model, prefs = { set: setModel, get: getModel } }) {
  if (!repo.getSession(key)) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  let picked;
  try {
    picked = assertModel(model);
  } catch (err) {
    return {
      status: 400,
      body: errorBody('bad_model', err.message, '从模型列表里选一个，或只填字母数字点横线。'),
    };
  }
  // 只改下一轮。正在跑的那一轮已经起了进程，模型是启动时定死的——
  // 谎称「已切换」会让人以为当前这轮的回答来自新模型。
  const running = latestTurn(key)?.status === 'running';
  prefs.set(key, picked);
  return {
    status: 200,
    body: {
      model: picked,
      appliesTo: running ? 'next' : 'now',
      note: running ? '当前这轮仍用原模型，下一条消息起生效。' : null,
    },
  };
}
