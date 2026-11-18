// 新建会话（M3）：第一轮登记成它普通的一轮，会话一落地就返回；Claude 的写进桌面 App 注册表。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inScope } from '../../scope.js';
import {
  buildClaudeNewArgs, buildCodexNewArgs, buildAntigravityNewArgs, assertModel, isEffort,
} from '../../agent/args.js';
import { setModel, setEffort, getDefaultEffort, effectiveEffort } from '../../runtime/prefs.js';
import { getMode } from '../../permission.js';
import { stripAttachmentList } from '../../upload.js';
import {
  pickRegistryDir, loadTemplate, buildRegistryEntry, writeRegistryEntry, retitleRegistryEntry,
} from '../../agent/registry.js';
import { generateTitle } from '../../agent/title.js';
import { missingCredentials, CREDENTIAL_FIX } from '../../agent/preflight.js';
import { appendAudit } from '../../audit.js';
import { startTurn, endTurn, latestTurn } from '../../runtime/turns.js';
import { enqueue, takeNext, listQueue } from '../../runtime/queue.js';
import { errorBody } from '../errors.js';
import { liveTurns, defaultRunner, drainQueue } from './turns.js';
import { defaultPushSend } from './push.js';

export function defaultRegistrar({ cliSessionId, cwd, title }) {
  const picked = pickRegistryDir();
  if (!picked) return null;
  const template = loadTemplate(picked);
  const entry = buildRegistryEntry({ template, cliSessionId, cwd, title });
  if (!entry) return null;
  return writeRegistryEntry(entry, { dir: picked.dir });
}

/**
 * `titler` / `retitle`：起名字那一步，**测试里一定要换成假的**——真的会起一个
 * `claude -p` 进程、真的发一次请求。registrar 漏注入那次（2026-09-30）往
 * owner 的桌面 App 注册表里写了 40 条，这两个漏注入只是白花钱，但一样别漏。
 *
 * @param {{ repo: any, config: any, principal?: any, agent: string, cwd: string, message: string,
 *   model?: string | null, effort?: string | null, registrar?: (o: object) => unknown,
 *   titler?: (o: object) => Promise<string | null>, retitle?: (file: string, title: string) => boolean,
 *   landWaitMs?: number, pollMs?: number, landPollMaxMs?: number }
 *   & import('./turns.js').TurnDeps} opts
 */
export async function createSession({
  repo, config, principal, principalOf = null, agent, cwd, message, model, effort,
  runner = defaultRunner, registrar = defaultRegistrar, audit = appendAudit, env = process.env,
  titler = generateTitle, retitle = retitleRegistryEntry,
  turns: turnsIn, queue: queueIn, push: pushIn, prefs = { set: setModel },
  landWaitMs = 30_000, pollMs = 300, landPollMaxMs = 10 * 60_000,
}) {
  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '新建会话需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'antigravity') {
    return { status: 400, body: errorBody('bad_agent', `不支持的 agent：${agent}`, '只能是 claude、codex 或 antigravity。') };
  }
  const text = String(message ?? '');
  if (!text.trim()) {
    return { status: 400, body: errorBody('empty_message', '新建会话需要第一句话。', '写点内容再提交。') };
  }

  // 工作目录规则：绝对路径 ∧ 目录已存在 ∧ 在调用者的 roots 之下。
  //
  // 这**替换**了原来的「只能选已有会话出现过的目录」。依据是 owner 明确要求能选
  // 任意文件夹、且他的工作摊在至少四棵顶层树上；对访客而言新规则比旧规则更严。
  //
  // 注意这条约束的是「在哪里起 agent」，**不约束 agent 起来之后能碰什么**——
  // Baton 不传任何权限/沙箱参数，两个 CLI 的默认行为未实测。
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    return {
      status: 400,
      body: errorBody('bad_cwd', `工作目录必须是绝对路径（收到 ${JSON.stringify(cwd)}）。`,
        '例如 C:\\workspace\\myproj（Windows）或 /home/user/myproj（POSIX）。可用 GET /api/dirs 浏览可选目录。'),
    };
  }
  const dir = path.resolve(cwd);
  if (!inScope(dir, principal?.roots ?? null)) {
    return {
      status: 403,
      body: errorBody('cwd_not_allowed', `工作目录不在你的工作区里：${dir}`,
        `你的工作区是 ${principal.roots.join('、')}，只能在它下面新建会话。`),
    };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      status: 400,
      body: errorBody('cwd_not_found', `目录不存在：${dir}`,
        '先用 POST /api/dirs 把它建出来，再新建会话。'),
    };
  }

  const missing = missingCredentials(agent, env);
  if (missing) {
    return {
      status: 503,
      body: errorBody('missing_credentials', `缺少环境变量 ${missing}，${agent} 无法认证。`, CREDENTIAL_FIX),
    };
  }

  // 模型名非法就当场拒绝并说清原因。放过去让它进 argv 是不行的（见 agent/args.js
  // 抬头那段 DEP0190），而静默丢弃更糟——用户以为切了模型，其实跑的是别的。
  let picked;
  try {
    picked = assertModel(model);
  } catch (err) {
    return {
      status: 400,
      body: errorBody('bad_model', err.message, '从模型列表里选一个，或只填字母数字点横线。'),
    };
  }

  const sessionId = crypto.randomUUID();
  // 一律用归一化过的 dir，不用请求里的原文——那个才是 agent 真正会跑在其中的路径
  const member = { agent, providerId: sessionId, cwd: dir };
  const permissionMode = getMode(agent);
  // 思考强度要在**第一轮就生效**。只在建完之后 setEffort 的话，第一轮已经按
  // 默认跑完了——而新建会话时选的强度，多半就是为了第一轮那个任务选的。
  //
  // 两边都给：上一版这里写死了 `agent === 'claude'`，依据是当时以为 codex 没有
  // 思考强度——那条依据是错的（见 agent/args.js 抬头）。
  const pickedEffort = isEffort(effort) ? effort : null;
  // 第一轮实际带的强度。都没选时用整台电脑的默认——但**不记成这个会话的选择**
  // （下面 setEffort 只认 pickedEffort）：默认改了，没选过的会话应当跟着变。
  const runEffort = effectiveEffort({
    model: picked, effort: pickedEffort, fallback: (prefs.defaultEffort ?? getDefaultEffort)(agent),
  });
  const args = agent === 'claude'
    ? buildClaudeNewArgs({ sessionId, model: picked, permissionMode, effort: runEffort })
    : agent === 'antigravity'
      ? buildAntigravityNewArgs({ model: picked, permissionMode, effort: runEffort })
      : buildCodexNewArgs({ model: picked, permissionMode, effort: runEffort });
  /*
    写进桌面 App 注册表的标题。**先切掉末尾那段附件清单**——它是写给 agent 的。

    不切的话，「只回复两个字：收到 + 三个附件」那条会话在侧栏和页头上显示成
      只回复两个字：收到 附件（已放在工作目录下）： - .baton-uploads/report.xlsx（12 B） - …
    而且**这一份是落盘的**：注册表的 title 在 resolveTitle 里是第 1 档，
    优先于从 transcript 现算的那份，所以光修 titles.js 治不了已经建好的会话。

    只发文件、一个字没写时（现在允许了），切完正文是空的——用文件名兜底，
    和 titles.js 里 clip() 的规则保持一致。
  */
  const { body: titleBody, files: titleFiles } = stripAttachmentList(text);
  const titleOne = titleBody.replace(/\s+/g, ' ').trim()
    || (titleFiles.length === 1 ? titleFiles[0] : `${titleFiles[0] ?? ''} 等 ${titleFiles.length} 个文件`);
  const title = titleOne.slice(0, 60);

  /*
    让模型起个短名字，**和 Claude App 做的是同一件事**（owner 2026-10-08）。

    现在就发车，不等它：起一次名实测 6–11 秒，而新建这一屏等的是第一轮。
    它和第一轮并着跑，回来时会话多半已经落地，改一下注册项的标题就行
    （agent/title.js 有为什么只能这么做的实测依据）。

    拿不到名字、注册项没写成、人已经在 App 里改过名——都当没这回事，
    标题留着上面那份首句。**起名失败绝不许影响建会话。**
  */
  // 这里就把失败吞掉：会话没落地（第一轮起不来）时下面那条 .catch 根本接不上，
  // 没人接的 rejection 会被 guards.js 记成一条噪声日志
  const titleSoon = agent === 'claude'
    ? Promise.resolve().then(() => titler({ message: text, cwd: dir, env })).catch(() => null)
    : null;

  /*
    第一轮**不在这个请求里等它跑完**。

    原来整轮跑完才返回（2026-10-01 审查）：这一轮没有停止句柄、也没有「在跑」的记录，
    所以停不下来；这时在同一个会话里再发一条，会起第二个 --resume 去写同一份
    transcript；而请求超过 100 秒，Cloudflare 先回 524，客户端以为失败了。撤掉整轮
    时限之后，它还可能一直跑下去。

    现在：会话文件一落地（按 providerId 在仓库里查到它），这一轮就登记成它普通的一轮
    ——有 `running` 记录、有停止句柄、跑完照 sendMessage 那样收尾（排着的消息接着发、
    全跑完才推送）——然后立刻返回。落地之前 agent 就退出了，才算没建起来，
    把它的报错如实回给客户端，不再回一个 202 让人以为建好了。
  */
  const startedAt = Date.now();
  const turnId = crypto.randomUUID();
  const who = principal?.id ?? 'owner';
  const turns = { start: startTurn, end: endTurn, latest: latestTurn, ...turnsIn };
  const queue = { enqueue, takeNext, list: listQueue, ...queueIn };
  const push = { send: defaultPushSend, ...pushIn };
  audit({ key: `${agent}:new`, agent, message: text, turnId, status: 'started', principal: who });

  // claude 的会话 id 是我们用 --session-id 给的；codex 的要等 stdout 里的 thread.started
  let providerId = agent === 'claude' ? sessionId : null;
  let handle = null;
  let key = null;
  let finished = false;
  let registered = false;
  let note = agent === 'antigravity'
    ? 'Antigravity 会话已创建，在桌面端侧栏即可看到。'
    : 'Codex 会话无需注册，电脑上刷新即可看到。';
  let onLanded;
  const landed = new Promise((resolve) => { onLanded = resolve; });

  const land = () => {
    if (key || !providerId) return;
    const m = repo.listChains().flatMap((c) => c.members).find((x) => x.providerId === providerId);
    if (!m) return;
    key = m.key;
    // 选的模型和强度**现在**就记到会话上：第一轮还在跑时排进来的消息，发出去要用同一套
    if (picked) {
      try {
        prefs.set(key, picked);
      } catch {
        // 偏好没存上不该让「会话已建好」这件事失败
      }
    }
    if (pickedEffort) {
      try {
        setEffort(key, pickedEffort);
      } catch {
        // 同上
      }
    }
    turns.start({ key, turnId, agent, prompt: text }, { now: startedAt });
    if (handle && !finished) liveTurns.set(turnId, handle);
    if (agent === 'claude') {
      try {
        const regFile = registrar({ cliSessionId: providerId, cwd: dir, title });
        if (regFile === null) {
          note = 'Claude 会话已创建（未检测到 Claude Desktop 注册表模板，仅在 Baton 内直接可用）。';
        } else {
          registered = true;
          note = '已写入桌面 App 注册项——它只在启动时加载注册表，所以要重启 Claude App 才会看到这条会话。';
          // 名字起回来了就换上。**这一步绝不能让建会话这条路失败**：
          // 它在另一条时间线上，而且已经返回给客户端了
          if (titleSoon && typeof regFile === 'string') {
            void titleSoon
              .then((t) => (t ? retitle(regFile, t) : false))
              .catch(() => false);
          }
        }
      } catch (err) {
        note = `会话已创建，但写注册项失败：${err.message}。该会话在 Baton 里可见，在桌面 App 里暂时看不到。`;
      }
    }
    onLanded();
  };

  // 落地通常在一两秒内；一直没落地（卡在启动上）也不无限轮询下去
  const poll = setInterval(land, pollMs);
  poll.unref?.();
  const pollCap = setTimeout(() => clearInterval(poll), landPollMaxMs);
  pollCap.unref?.();

  const settled = Promise.resolve()
    .then(() => runner({
      member, message: text, args, isNew: true,
      onStart: (h) => {
        handle = h;
        if (key && !finished) liveTurns.set(turnId, h);
      },
      onLine: (line) => {
        if (providerId) return;
        try {
          const j = JSON.parse(line);
          if ((j.type === 'thread.started' && j.thread_id)
            || (j.type === 'conversation.started' && j.conversation_id)
            || (j.event === 'init' && j.conversation_id)) {
            providerId = j.thread_id ?? j.conversation_id;
            land();
          }
        } catch {
          // 不是 JSON 的噪声行（技能加载报错之类），见 agent-protocol.md §3
        }
      },
    }))
    .then((r) => ({ r, err: null }), (err) => ({ r: null, err }))
    .then(async ({ r, err }) => {
      finished = true;
      clearInterval(poll);
      clearTimeout(pollCap);
      liveTurns.delete(turnId);
      providerId ??= r?.summary?.sessionId ?? null;
      land(); // 最后查一次：可能正好落在两次轮询之间
      const s = err ? { status: 'failed', error: err.message } : (r.summary ?? {});
      audit({ key: key ?? `${agent}:new`, agent, message: '', turnId, status: s.status ?? 'unknown', principal: who });
      if (!key) return { r, s };
      turns.end({ key, turnId, status: s.status, error: s.error, tokens: s.tokens, eventCount: s.eventCount });
      // 和 sendMessage 一样收尾：排着的发出去；全都跑完了才推送
      try {
        await drainQueue({ repo, config, key, principalOf, runner, audit, env, turns, queue });
      } catch {
        // 排空失败不能污染本轮的终态记录
      }
      try {
        if (queue.list(key).length === 0 && turns.latest(key)?.status !== 'running') {
          await push.send({ key, member: repo.getSession(key) ?? member, turn: turns.latest(key), principalId: who });
        }
      } catch {
        // 推送失败绝不能影响这一轮的记录
      }
      return { r, s };
    });

  const outcome = await Promise.race([
    landed.then(() => 'landed'),
    settled.then(() => 'finished'),
    new Promise((resolve) => { setTimeout(() => resolve('waiting'), landWaitMs).unref?.(); }),
  ]);

  if (key) {
    return {
      status: 202,
      body: { sessionId: providerId, key, turnId, agent, cwd: dir, registered, note, running: !finished },
      settled,
    };
  }
  if (outcome === 'finished') {
    const { r, s } = await settled;
    return {
      status: 502,
      body: errorBody('create_failed',
        `会话没建起来：${s.error ?? `${agent} 退出了（退出码 ${r?.code ?? '未知'}）`}`,
        `在那台电脑上直接运行一次 ${agent}，确认它能正常对话；报错原文见上。`),
      settled,
    };
  }
  // 一直没落地、进程还在跑：不把请求挂着，落地之后后台照常登记
  return {
    status: 202,
    body: {
      sessionId: providerId ?? sessionId, key: null, turnId, agent, cwd: dir, registered: false,
      note: '会话还在创建，过一会儿会出现在列表里。', running: true,
    },
    settled,
  };
}
