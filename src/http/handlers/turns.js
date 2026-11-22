// 一轮的生命周期：起进程、发消息（在跑就排队）、排空队列、停止。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import crypto from 'node:crypto';
import { buildClaudeArgs, buildCodexArgs } from '../../agent/args.js';
import { getModel, getEffort, getDefaultEffort, effectiveEffort } from '../../runtime/prefs.js';
import { getMode } from '../../permission.js';
import { runProcess } from '../../agent/spawn.js';
import { runAntigravityTurn } from '../../agent/antigravityRun.js';
import { summarizeTurn } from '../../agent/adapt.js';
import { queueToCodexApp, HANDOFF_NOTE } from '../../agent/codexQueue.js';
import { readCodexGoal } from '../../agent/codexGoal.js';
import { missingCredentials, CREDENTIAL_FIX } from '../../agent/preflight.js';
import { appendAudit } from '../../audit.js';
import { startTurn, updateTurnControl, registerTurnHandle, liveTurns, endTurn, listTurns, latestTurn } from '../../runtime/turns.js';
import { beginExecution, finishExecution, isShuttingDown } from '../../runtime/instance.js';
import { findReceipt } from '../../runtime/receipts.js';
import { rememberInit } from '../../agent/commands.js';
import { liveStates } from '../../runtime/live.js';
import { writeIntent } from '../../runtime/intents.js';
import {
  enqueue, takeNext, listQueue, queuedKeys, dropQueue, removeQueued, promoteQueueItem, restoreQueueItem, QueueFullError,
} from '../../runtime/queue.js';
import { scopedPath, scopeRepo, under } from '../../scope.js';
import { cancelAsk, pendingAsk } from '../../ask/store.js';
import { prepareAsk, loopbackUrl } from '../../ask/setup.js';
import { errorBody } from '../errors.js';
import { defaultPushSend } from './push.js';

const MAX_MESSAGE = 100000;

export { liveTurns };
const MONITOR_ONLY_NOTE = 'Baton 正在跟踪 Antigravity 桌面会话。请在桌面端查看进度或停止本轮。';

function receiptProblem(error) {
  const status = error.code === 'request_history_full' ? 429 : error.code === 'receipt_store_unavailable' ? 503 : null;
  return status ? { status, body: errorBody(error.code, error.message, '保留同一个发送标识，稍后重试。') } : null;
}

/**
 * 起一轮 agent 的选项。
 *
 * @typedef {object} RunnerOptions
 * @property {any} member 那个会话（新建时是一个只有 agent/providerId/cwd 的临时对象）
 * @property {string} message
 * @property {boolean} [fork]
 * @property {string[]} [args] 给了就原样用（新建会话自己拼好了参数）
 * @property {string | null} [model]
 * @property {string | null} [effort] 新建首轮已选好的强度；已有会话在启动时取最新偏好
 * @property {(h: { kill?: () => void, canStop?: boolean, monitor?: object, creation?: { delivery: string } }) => void} [onStart]
 * @property {(line: string) => void} [onLine]
 * @property {string} [turnId]
 * @property {any} [config]
 * @property {boolean} [isNew]
 * @property {(match: any) => boolean} [mayClaimCreation]
 * @property {(o: any) => Promise<any>} [run] 起进程（测试替换）。默认 agent/spawn.js 的 runProcess
 * @property {(o: { threadId: string, text: string }) => Promise<{ id: string }>} [toApp]
 *   交给 Codex App 排队（测试替换）。默认 agent/codexQueue.js 的 queueToCodexApp
 * @property {boolean} [handoff] 撞上 App 的锁时交不交给 App 排队。目标续跑那一轮是 false
 */

/**
 * 发消息 / 排空队列共用的依赖。都可选：生产用默认实现，测试按字段替换。
 *
 * @typedef {object} TurnDeps
 * @property {(o: RunnerOptions) => Promise<any>} [runner]
 * @property {(entry: object) => void} [audit]
 * @property {Record<string, string | undefined>} [env]
 * @property {object} [turns]
 * @property {object} [queue]
 * @property {object} [push]
 * @property {object} [prefs]
 * @property {((id: string, queuedGeneration?: string | null) => any) | null} [principalOf]
 * @property {() => Map<string, string>} [live] 电脑上哪些会话在跑（runtime/live.js）
 */

/** @param {RunnerOptions} opts */
export async function defaultRunner({
  member, message, fork, args, model, effort: initialEffort, isNew = false, onStart, onLine, turnId, config, mayClaimCreation,
  run = runProcess, toApp = queueToCodexApp,
  // 目标续跑那种 Baton 自己起的轮次是 false：撞上 App 的锁时不把那句续跑指令塞进 App 的队列，
  // App 开着这个会话就由 App 自己续（见 continueGoal）
  handoff = true,
}) {
  const permissionMode = getMode(member.agent);
  // 档位与思考强度均在起进程这一刻读：排队很久才跑的那一轮要按最新设置走
  const effort = initialEffort !== undefined ? initialEffort : effectiveEffort({
    model, effort: getEffort(member.key), fallback: getDefaultEffort(member.agent),
  });
  if (member.agent === 'antigravity') {
    return runAntigravityTurn({
      member, message, model, effort, permissionMode, args, isNew, onStart, onLine, run, mayClaimCreation,
    });
  }
  const command = member.agent === 'claude' ? 'claude' : 'codex';
  /*
    提问通道。**只给 claude**：codex 的 MCP 服务器配在 ~/.codex/config.toml 里，
    没有等价的「只给这一轮加一个服务器」的命令行参数，而去改用户的全局配置
    不在 Baton 该做的事情之内。codex 会话仍然只能在正文里问，这是已知差距。

    baseUrl 为空（测试注入的 config 里没有 host/port）时 prepareAsk 返回 null，
    于是一个参数都不加——老测试因此一行不用改。
  */
  const ask = member.agent === 'claude' && config?.port
    ? prepareAsk({
      key: member.key, turnId, baseUrl: loopbackUrl({ host: config.host, port: config.port }),
    })
    : null;
  const finalArgs = args ?? (member.agent === 'claude'
    ? buildClaudeArgs({ sessionId: member.providerId, fork, model, permissionMode, effort, ask })
    : buildCodexArgs({ threadId: member.providerId, fork, model, permissionMode, effort }));
  try {
    /*
      claude 每一轮开头的 system/init 里带着这个目录下能用的斜杠命令。顺手记下，
      输入框的 `/` 菜单就不必为它另起探针（agent/commands.js）。先做字符串判断再解析：
      一轮几百行，只有第一条是它
    */
    const watch = member.agent === 'claude' && member.cwd
      ? (/** @type {string} */ line) => {
        if (line.includes('"subtype":"init"')) {
          try {
            const o = JSON.parse(line);
            if (o.type === 'system' && o.subtype === 'init') rememberInit(member.cwd, o);
          } catch {
            // 不是完整的一行 JSON，跳过
          }
        }
        onLine?.(line);
      }
      : onLine;
    const r = await run({
      command, args: finalArgs, cwd: member.cwd ?? process.cwd(), message, onStart, onLine: watch,
    });
    const summary = summarizeTurn(member.agent, r.lines, r.stderr);
    /*
      Codex App 正开着这个会话、占着写入锁：不报失败，把消息**交给 App**——放进 codex 自己的
      会话队列，App 这一轮跑完就接着处理，回复写进同一个 rollout（见 agent/codexQueue.js）。
      owner：「baton 的意义就是立马能接手，而不是还要我去手动关闭」。
      分叉不走这条：分叉是开一个新会话，新会话没有锁的问题。
    */
    if (member.agent === 'codex' && !fork && summary.lockHeld) {
      // 桌面队列只能传正文。它不支持 Baton 为本轮选的沙箱、模型和思考强度。
      if (permissionMode !== 'default' || model || effort || getMode('codex') !== 'default') {
        const error = 'Codex App 正占用这个会话，桌面队列无法应用本轮选定的权限、模型或思考强度。'
          + '请先在 Codex App 中释放会话，再从 Baton 重发。';
        return { ...r, summary: { ...summary, error } };
      }
      if (!handoff) {
        return {
          ...r,
          summary: { status: 'handoff', sessionId: member.providerId, tokens: null, eventCount: 0, error: GOAL_IN_APP_NOTE },
        };
      }
      try {
        const q = await toApp({ threadId: member.providerId, text: message });
        return {
          ...r,
          summary: { status: 'handoff', sessionId: member.providerId, tokens: null, eventCount: 0, error: HANDOFF_NOTE, queuedId: q.id },
        };
      } catch (e) {
        return { ...r, summary: { ...summary, error: `${summary.error}（试着交给 App 排队，也没成：${e.message}）` } };
      }
    }
    return { ...r, summary };
  } finally {
    // 进程没了，挂着的问题就没人会答了。不撤的话那张卡会一直留在手机上，
    // 点下去却再也回不到任何 agent——比没有这个功能更糟。
    if (ask) {
      cancelAsk(member.key);
      ask.cleanup();
    }
  }
}

/**
 * @param {{ repo: any, config: any, principal?: any, key: string, message: string,
 *   fork?: boolean, when?: 'auto' | 'now' | 'interrupt', internal?: boolean, requestId?: string, queuedItem?: any, selectedId?: string,
 *   goalOf?: (threadId: string) => Promise<{ status: string } | null> } & TurnDeps} opts
 */
export async function sendMessage({
  repo, config, principal, principalOf = null, key, message, fork = false, when = 'auto', requestId, queuedItem = null, selectedId = null,
  runner = defaultRunner, audit = appendAudit, env = process.env,
  live = liveStates,
  turns: turnsIn, queue: queueIn, push: pushIn, prefs: prefsIn,
  // Baton 自己起的目标续跑（continueGoal）。不当成人说的话：轮次记录不带原文（客户端就不会先把它
  // 摆成一个用户气泡），撞上 App 的锁也不交给 App 排队
  internal = false,
  goalOf = readCodexGoal,
}) {
  // 人说话了，连续自动续了几轮的计数清零
  if (isShuttingDown()) return { status: 503, body: errorBody('shutting_down', 'Baton 正在关闭。', '重新连接后再试。') };
  if (!internal) goalRuns.delete(key);
  // 按字段兜底，不整对象替换：测试只想替 start/end 时不该被迫连 latest 一起给，
  // 否则每加一个内部依赖就要回头改所有注入点，最后没人愿意加依赖也没人愿意写测试。
  const turns = { start: startTurn, end: endTurn, latest: latestTurn, list: listTurns, ...turnsIn };
  const queue = { enqueue, takeNext, list: listQueue, remove: removeQueued, restore: restoreQueueItem, ...queueIn };
  const push = { send: defaultPushSend, ...pushIn };
  const prefs = { get: getModel, ...prefsIn };
  // 谁发的。审计要它答「这条是我发的还是他发的」，推送要它答「该敲谁的门」，
  // 队列要它跨重启——三处都不能是 undefined。
  const who = principal?.id ?? 'owner';
  const principalGeneration = principal?.generation ?? null;
  if (principal && principalOf) {
    const current = principalOf(who);
    if (!current || current.id !== who || (current.generation ?? null) !== principalGeneration || current.allowSend === false) {
      return { status: 403, body: errorBody('send_disabled', '当前身份已无法发送。', '请重新连接并检查发送权限。') };
    }
    principal = current;
    repo = scopeRepo(repo, current);
  }

  if (config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '发送已禁用（当前配置为只读）。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  const text = String(message ?? '');
  if (!text.trim()) {
    return { status: 400, body: errorBody('empty_message', '消息为空。', '输入内容后再发送。') };
  }
  if (text.length > MAX_MESSAGE) {
    return {
      status: 400,
      body: errorBody('message_too_long', `消息过长（${text.length} 字符，上限 ${MAX_MESSAGE}）。`,
        '拆成多条发送，或先把长内容写进项目文件再让 agent 去读。'),
    };
  }
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }

  let request = queuedItem?.request ?? null;
  if (requestId !== undefined) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
      return { status: 400, body: errorBody('bad_request_id', '发送标识格式无效。', '使用新的有效请求标识。') };
    }
    const signature = crypto.createHash('sha256').update(JSON.stringify([text, fork, when])).digest('hex');
    request = { id: requestId, signature };
    const sameRequest = (record) => record.request?.id === requestId && record.principalId === who
      && (record.principalGeneration ?? null) === principalGeneration;
    const previous = queue.list(key).find(sameRequest) ?? turns.list(key).find(sameRequest)
      ?? findReceipt({ key, principalId: who, principalGeneration, request });
    if (previous) {
      if (previous.request.signature !== signature) {
        return { status: 409, body: errorBody('request_id_conflict', '这条发送标识已经用于不同的消息。', '新消息请使用新的请求标识。') };
      }
      const queueId = previous.queueId ?? previous.id;
      return { status: 202, body: queueId ? { queued: true, queueId, replayed: true }
        : { queued: false, turnId: previous.turnId, replayed: true } };
    }
  }

  // 缺凭据时每一轮都会以 "Not logged in" 失败，在这里挡住并说清怎么修
  const missing = missingCredentials(member.agent, env);
  if (missing) {
    return {
      status: 503,
      body: errorBody('missing_credentials', `缺少环境变量 ${missing}，${member.agent} 无法认证。`,
        CREDENTIAL_FIX),
    };
  }

  /*
    已有轮次在跑就排队，绝不起第二个进程。两个 --resume 同时续写同一个 transcript
    会造成语义损坏（第二轮读不到第一轮未写完的消息，两轮基于分叉上下文各自作答），
    且 sessionState 取最后一轮，运行轴会当场说谎。详见 runtime/queue.js 抬头。

    **「在跑」包括电脑上起的那一轮**（2026-10-09）。这条纪律原来只防得住 Baton
    自己起的轮次：桌面 App 或终端里正跑着的那一轮它根本不知道，手机上一发就是
    第二个进程压上去。现在 runtime/live.js 认得出来了。

    **只挡 busy，不挡 waiting。** waiting 是电脑上开着一个框（实测五种来源，
    其中一种只是「某个本地命令的界面开着、什么都没在跑」，见 agent-protocol §11.4）。
    挡它的代价是致命的：owner 一旦离开电脑，那个框没人点，**手机上就再也发不出
    消息**——而「在手机上继续电脑上的活」正是这个项目存在的理由。
    owner 2026-10-09 原话：「那我不是离开电脑就永远发不了消息了吗」。

    busy 不一样：那一轮自己会跑完，排着的消息几分钟内就发出去了，和 Baton 自己
    那一轮在跑时的行为一致。
  */
  /*
    `when: 'now'` = 人自己要求现在就发（owner 2026-10-09：「应该要可以自己决定要不要
    直接发送吧」）。它只放行**电脑上**那一轮这一条：

      - 会话在桌面 App 里开着时，这么做是安全的：实测 `-p --resume` 会把消息交给
        那个活着的会话（它自己排队，transcript 仍是一条直线，见 agent-protocol §11.5）
      - 会话没开在任何地方时，两个 resume 会把对话树劈叉——这时「立刻发」就是
        人自己选的代价，服务端照办但如实记一笔

    **Baton 自己那一轮不放行**：那一轮我们有句柄，要插队就该先停掉它（stopTurn），
    绕过去只会变成两个我们自己起的进程同时写。
  */
  const active = turns.latest(key);
  /*
    插队（owner 2026-11-14：「还是不能自己选择插队还是排队啊」）。

    Baton 自己那一轮在跑：这条放到队列**最前面**，再把那一轮停下——停下以后的收尾（settle → drainQueue）
    第一个取的就是它。和在 Claude Code 里按 Esc 再打字是同一个效果：做过的都在，agent 接着按新的话干。
    不另开进程：两个自己起的进程同时写同一个会话，正是排队要防的事。

    往正在跑的这一轮里「塞一句、不打断」（Codex 的 turn/steer、Claude 的 queued_command）要求进程开着
    stdin / 在 app-server 里跑，Baton 现在一轮一进程做不到——见 agent-protocol §21。

    电脑上那一轮在跑（不在 Baton 手上）：照 'now' 走，交给那个开着的会话自己排（§11.5）。
  */
  if (when === 'interrupt' && active?.status === 'running') {
    if (active.canStop === false || liveTurns.get(active.turnId)?.canStop === false) {
      return { status: 409, body: errorBody('stop_unavailable', MONITOR_ONLY_NOTE, '可以选择普通排队，等这轮结束后发送。') };
    }
    let item;
    try {
      item = queue.enqueue({ key, text, fork, principalId: who, principalGeneration, request, front: true });
    } catch (err) {
      const problem = receiptProblem(err);
      if (problem) return problem;
      if (err instanceof QueueFullError || err?.code === 'QUEUE_FULL') {
        return {
          status: 429,
          body: errorBody('queue_full', err.message, '请先等待当前队列发出或撤回多余排队消息。'),
        };
      }
      throw err;
    }
    audit({ key, agent: member.agent, message: text, turnId: active.turnId, status: 'queued:interrupt', principal: who });
    const stopped = stopTurn({
      repo, config, key, turnId: active.turnId, turns: turnsIn,
      reason: '插队：停下这一轮，先发新的那条。',
    });
    return {
      status: 202,
      body: {
        queued: true,
        queueId: item.id,
        interrupting: stopped.body?.stopping === true,
        queueLength: queue.list(key).length,
        note: stopped.body?.stopping
          ? '正在停下这一轮，停下后马上发这条。'
          : '这一轮不在 Baton 手上、停不下来。这条排在最前面，那一轮一结束就发。',
      },
    };
  }
  const host = active?.status === 'running' || when === 'now' || when === 'interrupt'
    ? null
    : (live().get(member.providerId) === 'busy' ? 'busy' : null);
  const needsConfirmation = active?.status === 'unconfirmed' && when !== 'now' && when !== 'interrupt';
  if (active?.status === 'running' || host || needsConfirmation) {
    if (queuedItem) return { status: 202, body: { queued: true, queueId: queuedItem.id } };
    let item;
    try {
      item = queue.enqueue({ key, text, fork, principalId: who, principalGeneration, request });
    } catch (err) {
      const problem = receiptProblem(err);
      if (problem) return problem;
      if (err instanceof QueueFullError || err?.code === 'QUEUE_FULL') {
        return {
          status: 429,
          body: errorBody('queue_full', err.message, '请先等待当前队列发出或撤回多余排队消息。'),
        };
      }
      throw err;
    }
    audit({
      key,
      agent: member.agent,
      message: text,
      turnId: active?.turnId ?? `host:${host}`,
      status: 'queued',
      principal: who,
    });
    return {
      status: 202,
      body: {
        queued: true,
        queueId: item.id,
        afterTurnId: active?.turnId ?? null,
        queueLength: queue.list(key).length,
        /*
          文案必须说准「何时发出」。「不停止地纠偏」容易被读成中途打断，
          而那在队列和 stream-json 两种实现下都做不到。

          电脑上那一轮要单独说：人看到「这轮还在跑」会去手机上找哪儿在跑，
          而其实是他自己电脑上开着的那条——不说清楚，这条消息就像卡住了。
        */
        note: needsConfirmation ? '上一轮的桌面结果待确认。这条消息已保留，核对后可手动立即发送。' : host
          ? '这个会话正在电脑上跑，不会被打断。这条消息已排队，等那边跑完后发出。'
          : '当前这轮还在跑，不会被打断。这条消息已排队，等这轮结束后发出。',
      },
    };
  }

  const turnId = crypto.randomUUID();
  let position = 0;
  if (queuedItem) {
    position = queue.list(key).findIndex((item) => item.id === queuedItem.id);
    if (position < 0 || (!selectedId && position !== 0)) return { status: 409, body: errorBody('queue_changed', '队列已经变化。', '刷新队列再试。') };
  }
  let committed = false;
  const commit = () => {
    if (queuedItem) {
      const removed = selectedId ? queue.remove(key, selectedId, { remember: false }) : queue.takeNext(key, { remember: false });
      if (removed?.id !== queuedItem.id) throw new Error('排队消息未能取出。');
    }
    try { audit({ key, agent: member.agent, message: text, turnId, status: 'started', principal: who }); } catch (error) {
      if (queuedItem) queue.restore(queuedItem, { position });
      throw error;
    }
    committed = true;
  };
  // 先把接收方轮次写盘，再移除队首和发布 turn_start。进程意外退出时，两处至少有一处记录。
  try {
    turns.start({ key, turnId, agent: member.agent, ...(internal ? {} : { prompt: text }),
      request, principalId: who, principalGeneration, queueId: queuedItem?.id }, { beforePublish: commit });
  } catch (error) {
    const problem = receiptProblem(error);
    if (problem) return problem;
    throw error;
  }
  if (!committed) commit(); // 注入的内存轮次存储可以只实现 start(record)。

  const settle = async () => {
    if (isShuttingDown()) return;
    // 这一轮结束了，队列里排着的该出发了。放在 finally 语义的位置：
    // 失败的一轮同样要放行后面的，否则一次失败就把队列永远堵死。
    try {
      await drainQueue({ repo, config, key, principalOf, runner, audit, env, turns, queue });
    } catch {
      // 排空失败不能污染本轮的终态记录
    }

    // 队列空了、目标还没达成：再起一轮接着干（只有 Codex 需要，见 continueGoal）。
    // 起了就不推送——下一轮结束时再说
    try {
      const again = await continueGoal({
        repo, config, principal, principalOf, key, goalOf,
        deps: { principalOf, runner, audit, env, live, turns: turnsIn, queue: queueIn, push: pushIn, prefs: prefsIn },
      });
      if (again) return;
    } catch {
      // 续不上不影响这一轮的记录，人发下一条就接着干了
    }

    // 队列排空后才推。中间那几轮结束时推，用户会收到一串「好了」，
    // 而其实后面还排着——真正该通知的是「全都跑完了」这一刻。
    try {
      if (queue.list(key).length === 0 && turns.latest(key)?.status !== 'running') {
        await push.send({ key, member, turn: turns.latest(key), principalId: who, principal });
      }
    } catch {
      // 推送失败绝不能影响这一轮的记录。通知没到，用户打开看就是了；
      // 而记录坏了是不可恢复的。
    }
  };

  // 不等待：agent 输出通过 tail-follow 推给客户端，这里只负责发起
  // 模型取落盘的会话偏好，不取请求体：同一个会话在两台设备上必须是同一个模型。
  // 没选过就是 null——不传 --model，交给 agent 自己的默认。
  beginExecution(turnId);
  (async () => runner({
    member, message: text, fork, model: prefs.get(key), turnId, config,
    onStart: (h) => registerTurnHandle(key, turnId, h),
    handoff: !internal,
  }))()
    .then((r) => {
      liveTurns.delete(turnId);
      const s = r.summary ?? {};
      // 每一轮都有终态记录（spec §12）——包括「有 token 却零消息」这种异常
      const rec = turns.end({
        key, turnId, status: s.status, error: s.error, tokens: s.tokens, eventCount: s.eventCount,
      });
      audit({ key, agent: member.agent, message: '', turnId, status: rec.status, principal: who });
    })
    .catch((err) => {
      liveTurns.delete(turnId);
      const rec = turns.end({ key, turnId, status: 'failed', error: err.message, tokens: null, eventCount: 0 });
      audit({
        key, agent: member.agent, message: '', turnId,
        status: rec?.status === 'aborted' ? 'aborted' : `error:${err.message}`, principal: who,
      });
    })
    .finally(() => finishExecution(turnId))
    .then(settle);

  return { status: 202, body: { turnId, queued: false } };
}

/**
 * Codex 目标的「接着干」（2026-11-11，实测见 agent-protocol §20）。
 *
 * Codex 自己只在开着这个会话的那个进程里自动续（App 里 30 轮 `turn_trigger: goal`）。Baton 用的
 * `codex exec resume` 遇到 active 的目标会把这一轮当成目标续跑、干完了模型自己标 complete，
 * 但跑完一轮就退出、不会自己起下一轮——owner 人不在电脑前，这一步只能 Baton 来做。
 *
 * 只在这些都成立时续：
 *   - 刚结束的那一轮是 ok（被人停了、失败了、交给了 App，都不续）
 *   - 没有人排着的消息（人的话优先，它发出去那一轮本来就是目标续跑）
 *   - 库里这个会话的目标还是 active（达成、暂停、卡住、额度或预算用完都由 Codex 自己改状态，就停）
 *   - 连续自动续了不到 MAX_GOAL_RUNS 轮——保险丝；人发一条就清零。Codex 自己也有「连续三轮没进展就标
 *     blocked」的规矩，这一条只防万一
 * Codex App 正开着这个会话时，续跑那一轮会撞上它的锁：那就交给 App 自己续（defaultRunner 的 handoff=false）。
 *
 * 续跑那一轮发的是 GOAL_CONTINUE：exec 必须有一句话；以标签开头，Codex 的解析把它当前言滤掉
 * （src/codex.js 的 OPEN_TAG），对话里不会冒出一个你没说过的「继续」。
 *
 * @returns {Promise<boolean>} 起了没有
 */
/**
 * @param {{ repo: any, config: any, principal?: any, principalOf?: ((id: string) => any) | null, key: string,
 *   goalOf?: (threadId: string) => Promise<{ status: string } | null>, deps?: TurnDeps & { live?: any, prefs?: any } }} o
 */
export async function continueGoal({ repo, config, principal, principalOf = null, key, goalOf = readCodexGoal, deps = {} }) {
  const turns = { latest: latestTurn, ...deps.turns };
  const queue = { list: listQueue, ...deps.queue };
  const previous = turns.latest(key);
  if (previous?.status !== 'ok' || queue.list(key).length) return false;
  const member = repo.getSession(key);
  if (member?.agent !== 'codex') return false;
  const goal = await goalOf(member.providerId);
  if (goal?.status !== 'active') {
    goalRuns.delete(key);
    return false;
  }
  const resolver = principalOf ?? deps.principalOf ?? null;
  if (principal?.id && principal.id !== 'owner' && !resolver) return false;
  const latest = turns.latest(key);
  if (latest?.status !== 'ok' || latest.turnId !== previous.turnId || queue.list(key).length) return false;
  const n = goalRuns.get(key) ?? 0;
  if (n >= MAX_GOAL_RUNS) return false;
  goalRuns.set(key, n + 1);
  const r = await sendMessage({
    repo, config, principal, key, message: GOAL_CONTINUE, internal: true, goalOf, ...deps,
    principalOf: resolver,
  });
  return r.status === 202 && r.body?.queued !== true;
}

/** 按会话数连续自动续了几轮。人发一条就清零。保险丝：守护进程重启后没有在跑的轮次，也就不会再续 */
const goalRuns = new Map();
export const MAX_GOAL_RUNS = 30;
export const GOAL_CONTINUE = '<baton_goal_continue>继续推进目标</baton_goal_continue>';
export const GOAL_IN_APP_NOTE = 'Codex App 正开着这个会话，目标由它接着推进。';

// 一轮结束后取队首发出。只取一条——它自己结束时会再触发一次，
// 从而串行排空。一次全取会把「一轮一进程」的纪律又破坏掉。
function sameQueueGeneration(item, principal) {
  if (item.principalGeneration) return item.principalGeneration === principal?.generation;
  return (item.principalId ?? 'owner') === 'owner' || !principal?.generation || principal.acceptLegacy === true;
}

/** @param {{ repo: any, config: any, key: string, selectedId?: string } & TurnDeps} opts */
export async function drainQueue({
  repo, config, key, principalOf = null, selectedId = null,
  runner = defaultRunner, audit = appendAudit, env = process.env,
  live = liveStates,
  turns: turnsIn, queue: queueIn,
}) {
  const turns = { start: startTurn, end: endTurn, latest: latestTurn, ...turnsIn };
  const queue = { enqueue, takeNext, list: listQueue, ...queueIn };

  const latest = turns.latest(key);
  if (isShuttingDown() || !config?.allowSend || latest?.status === 'running'
      || (latest?.status === 'unconfirmed' && !selectedId)) return null;
  /*
    电脑上那一轮还在跑时**不要把队首取出来**。取出来 sendMessage 也只会原样塞回去
    （那边同样挡着），但队首会换一个 id、排到队尾去——定时排空每隔几秒跑一次，
    多条消息的顺序就会被搅乱。先问清楚再取。

    先看有没有人在跑再去 getSession：后者要 stat + 读文件头，而绝大多数时候
    这张表是空的。
  */
  const hosts = selectedId ? new Map() : live();
  if (hosts.size) {
    const member = repo.getSession(key);
    // 只认 busy。waiting（电脑上开着个框）不挡——挡了的话 owner 离开电脑就
    // 再也发不出消息，而排着的这条更要紧：它正等着出去
    if (member && hosts.get(member.providerId) === 'busy') return null;
  }
  const items = queue.list(key);
  const item = selectedId ? items.find((q) => q.id === selectedId) : items[0];
  if (!item) return null;

  const who = item.principalId ?? 'owner';
  if (who !== 'owner' && !principalOf) return null;
  const resolvedPrincipal = principalOf ? principalOf(who, item.principalGeneration ?? null) : { id: 'owner', roots: null, allowSend: null };
  if (resolvedPrincipal === undefined) return null;
  const member = repo.getSession(key);
  if (!member) return null;
  const scopedRepo = resolvedPrincipal ? scopeRepo(repo, resolvedPrincipal) : null;
  let denied = null;
  if (!resolvedPrincipal || !sameQueueGeneration(item, resolvedPrincipal)) denied = 'unknown_principal';
  else if (resolvedPrincipal.allowSend === false) denied = 'send_disabled';
  else if (resolvedPrincipal.roots && !scopedPath(member.cwd, resolvedPrincipal)) {
    // A missing cwd or temporarily unreadable in-scope path is not evidence of revocation.
    if (!member.cwd || resolvedPrincipal.roots.some((root, i) => under(member.cwd, root) || under(member.cwd, resolvedPrincipal.realRoots?.[i]))) return null;
    denied = 'unknown_session';
  }
  if (denied) {
    if (selectedId) return { status: 403, body: errorBody('queue_access_changed', '原发送者已无法执行这条消息。', '检查当前发送权限。') };
    queue.takeNext(key);
    audit({
      key, agent: null, message: item.text, turnId: item.id,
      status: `queued_dropped:${denied}`,
      principal: who,
    });
    return null;
  }
  const r = await sendMessage({
    repo: scopedRepo, config, principal: resolvedPrincipal, principalOf,
    key, message: item.text, fork: item.fork, when: selectedId ? 'now' : 'auto', queuedItem: item, selectedId,
    runner, audit, env, live, turns, queue,
  });

  // 预检未通过或执行资源暂不可用时，sendMessage 仍保留原队首与 ID。
  return r;
}

// 守护进程启动时调用：上次留下的排队消息不能变孤儿。
// 与 intents 的 reconcileOrphans 对等——没有它，队列就成了「写了盘却没人读」，
// 比不落盘更糟，因为用户以为已经说出去了。
/** @param {{ repo: any, config: any, principalOf?: ((id: string) => any) | null, live?: () => Map<string, string> } & TurnDeps} opts */
export async function reconcileQueues({
  repo, config, principalOf = null, runner = defaultRunner, audit = appendAudit, env = process.env,
  live = liveStates,
  turns: turnsIn, queue: queueIn,
}) {
  const turns = { start: startTurn, end: endTurn, latest: latestTurn, ...turnsIn };
  const queue = {
    enqueue, takeNext, list: listQueue, keys: queuedKeys, drop: dropQueue, ...queueIn,
  };

  const resumed = [];
  for (const key of queue.keys()) {
    const lookup = repo.getSessionForRecovery?.(key);
    if (lookup?.status === 'missing') {
      const n = queue.drop(key);
      if (n) resumed.push({ key, dropped: n });
      continue;
    }
    if (lookup ? lookup.status !== 'present' : !repo.getSession(key)) continue;
    const r = await drainQueue({ repo, config, key, principalOf, runner, audit, env, live, turns, queue });
    if (r?.status === 202 && r.body?.queued === false) resumed.push({ key, sent: 1 });
  }
  return resumed;
}

/**
 * 撤回排着的某一条。
 *
 * owner 2026-10-09：「排队的消息现在还不能撤回」。
 *
 * 撤不到就如实说**它已经发出去了**，不要回一个假的成功——那比没有撤回更糟：
 * 人以为撤掉了，结果 agent 照着那条干了活。
 *
 * 身份校验靠 `repo`：它已经被 scopeRepo 按调用者收窄过了，看不见的会话就是 404
 * （和其余端点同一条路子，不在这里另写一套判断）。
 *
 * @param {{ repo: any, config?: any, key: string, id: string, queue?: { remove: Function } }} opts
 */
export function cancelQueued({ repo, config = null, key, id, queue: queueIn }) {
  if (config && config.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '撤回排队消息需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  const queue = { remove: removeQueued, ...queueIn };
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  let gone;
  try { gone = queue.remove(key, id); } catch (error) {
    const problem = receiptProblem(error);
    if (problem) return problem;
    throw error;
  }
  if (!gone) {
    return {
      status: 404,
      body: errorBody('not_queued', '这条消息已经发出去了，撤不回来。',
        '它已经在跑或已经跑完——到会话里看一眼。'),
    };
  }
  return { status: 200, body: { cancelled: true, id: gone.id, text: gone.text } };
}

/** @param {{ repo: any, config: any, principal?: any, key: string, id: string } & TurnDeps} opts */
export async function promoteQueued({ repo, config, principal, principalOf = null, key, id, ...deps }) {
  if (config?.allowSend !== true) return { status: 403, body: errorBody('send_disabled', '当前为只读模式。', '请确认写入权限。') };
  const member = repo.getSession(key);
  if (!member) return { status: 404, body: errorBody('unknown_session', '找不到这个会话。', '刷新会话列表。') };
  if (!id || typeof id !== 'string') return { status: 400, body: errorBody('missing_queue_id', '缺少排队消息的标识。', '刷新队列。') };
  const turns = { list: listTurns, latest: latestTurn, ...deps.turns };
  const queue = { list: listQueue, promote: promoteQueueItem, ...deps.queue };
  const items = queue.list(key);
  const position = items.findIndex((q) => q.id === id);
  const item = items[position];
  if (!item) {
    const started = turns.list(key).find((r) => r.queueId === id);
    if (started) return { status: 202, body: { queued: false, queueId: id, turnId: started.turnId, note: '这条消息已经开始执行。' } };
    return { status: 404, body: errorBody('unknown_queue_item', '这条消息已不在队列。', '刷新队列获取当前状态。') };
  }
  const who = item.principalId ?? 'owner';
  const requester = principal?.id ?? 'owner';
  const original = principalOf ? principalOf(who) : requester === who ? (principal ?? { id: 'owner' }) : null;
  if (!original || original.allowSend === false || !sameQueueGeneration(item, original) || !scopeRepo(repo, original).getSession(key)) {
    return { status: 403, body: errorBody('queue_access_changed', '原发送者已无法执行这条消息。', '检查该身份当前的会话与发送权限。') };
  }
  const active = turns.latest(key);
  if (active?.status === 'running') {
    const handle = liveTurns.get(active.turnId);
    if (active.canStop === false || handle?.canStop === false || typeof handle?.kill !== 'function') {
      return { status: 409, body: errorBody('stop_unavailable', active.canStop === false || handle?.canStop === false
        ? MONITOR_ONLY_NOTE : '当前轮次没有可用的停止句柄。', '保留原有队列，等待本轮结束。') };
    }
    if (active.stopReason && position !== 0) {
      return { status: 409, body: errorBody('stop_pending', '另一条停止请求正在等待确认。', '请等待当前轮次结束。') };
    }
    queue.promote(key, id);
    let stopped;
    try {
      stopped = stopTurn({ repo, config, key, turnId: active.turnId, turns, reason: '插队：停下这一轮，先发队首消息。' });
    } catch (error) {
      if (position) queue.promote(key, id, { position });
      throw error;
    }
    if (stopped.status !== 202) {
      if (position) queue.promote(key, id, { position });
      return stopped;
    }
    return { status: 202, body: { queued: true, queueId: id, interrupting: !!stopped.body?.stopping, note: '消息已在队首，当前轮次结束后发出。' } };
  }
  const missing = missingCredentials(member.agent, deps.env ?? process.env);
  if (missing) return { status: 503, body: errorBody('missing_credentials', `缺少 ${missing}，队列已保留。`, CREDENTIAL_FIX) };
  const r = await drainQueue({ repo, config, key, principalOf: principalOf ?? (() => original), ...deps, selectedId: id, turns, queue });
  if (!r) return { status: 409, body: errorBody('queue_changed', '消息的运行状态已经变化。', '刷新后查看队列。') };
  return r.status === 202 ? { status: 202, body: { ...r.body, queueId: id, note: '正在处理这条排队消息。' } } : r;
}

/** 看门狗的节拍。消息已经排上了，晚几秒发出去无所谓；但别让它等到下次开机。 */
const QUEUE_TICK_MS = 5000;

/**
 * 定时把排着的消息放出去。
 *
 * **为什么需要它**：Baton 自己那一轮结束时会顺手排空（sendMessage 里的 settle）。
 * 但现在还会为「电脑上正在跑」而排队，而那一轮结束时没有人通知 Baton——
 * 不定时看一眼，那条消息就要等到下次重启（reconcileQueues）才发得出去。
 *
 * 队列空着时这一拍只是一次 readdir（runtime/queue.js 的 queuedKeys），
 * 所以可以一直开着。上一拍还没跑完就跳过这一拍：排空里会真的起进程，
 * 重入会把「一轮一进程」的纪律又破坏掉。
 *
 * @param {{ repo: any, config: any, principalOf?: ((id: string) => any) | null, everyMs?: number, reconcile?: Function, log?: Function }} opts
 * @returns {() => void} 停掉它
 */
export function watchQueues({
  repo, config, principalOf = null, everyMs = QUEUE_TICK_MS, reconcile = reconcileQueues, log = () => {},
}) {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => reconcile({ repo, config, principalOf }))
      .then((resumed) => {
        if (Array.isArray(resumed) && resumed.length) log(resumed);
      })
      // 排空失败不能把看门狗带走：下一拍照常再试
      .catch(() => {})
      .then(() => { inFlight = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * @param {{ repo: any, config: any, key: string, turnId: string, reason?: string, intents?: object,
 *   live?: Map<string, { kill?: () => void, canStop?: boolean }>, turns?: object, asks?: object }} opts
 */
export function stopTurn({
  repo, config, key, turnId,
  // 记进这一轮终态里的那句话。插队停下的写明是插队，不说成「用户停止了」
  reason = '用户在手机上停止了这一轮。',
  intents = { write: writeIntent },
  live = liveTurns,
  turns: turnsIn,
  asks = { pending: pendingAsk, cancel: cancelAsk },
}) {
  const turns = { control: updateTurnControl, list: listTurns, ...turnsIn };
  // 停止会杀进程，和发消息一样是写操作。原来没有这道闸：只读的人也能停掉别人的轮次
  if (config?.allowSend !== true) {
    return {
      status: 403,
      body: errorBody('send_disabled', '停止轮次需要写入权限，当前为只读模式。',
        '在 ~/.baton/config.json 中设 "allowSend": true，然后重启 Baton 守护进程。'),
    };
  }
  if (!repo.getSession(key)) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  if (typeof turnId !== 'string' || !turnId) {
    return { status: 400, body: errorBody('missing_turn_id', '没有指定要停止哪一轮。', '带上 turnId 再试。') };
  }
  /*
    这一轮必须是**这个会话的**。原来只认 turnId：传一个别的会话的 turnId，就会杀掉
    那个会话的进程、把 aborted 记到这个会话下、再把这个会话从「在跑」里摘掉
    （2026-10-01 审查）。turnId 是 uuid，在这个会话的轮次记录里查得到，才是它的。
  */
  const turn = turns.list(key).find((t) => t.turnId === turnId);
  if (!turn) {
    return {
      status: 404,
      body: errorBody('unknown_turn', `这个会话里没有 ${turnId} 这一轮。`, '刷新一下会话，拿到当前那一轮的 turnId 再停。'),
    };
  }
  if (turn.status !== 'running') {
    return { status: 200, body: { turnId, stopped: false, note: '这一轮已经结束了，不用再停。' } };
  }

  const handle = live.get(turnId);
  if (turn.canStop === false || handle?.canStop === false) {
    return { status: 200, body: { turnId, stopped: false, stopping: false, note: MONITOR_ONLY_NOTE } };
  }
  if (handle) {
    if (!turn.stopReason) {
      turns.control(key, turnId, { stopReason: reason });
      if (asks.pending(key)?.turnId === turnId) asks.cancel(key);
      handle.kill();
    }
    return {
      status: 202,
      body: { turnId, stopped: false, stopping: true, note: '已请求停止，正在等待执行进程退出。' },
    };
  }

  // 没有句柄：可能是别的进程在跑，或进程已退出。意图留在盘上等人消费。
  intents.write({ key, type: 'stop', turnId });
  return {
    status: 202,
    body: {
      turnId,
      stopped: false,
      note: '停止意图已记录。本进程没有该轮的执行句柄——若进程已退出，'
        + 'Baton 下次启动时会把它标记为已停止。',
    },
  };
}
