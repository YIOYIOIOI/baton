// 读会话：列表、翻页、单条全文、SSE 实时流、运行态。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import fs from 'node:fs';
import { pageEvents } from '../../paginate.js';
import { createFollower } from '../../follow.js';
import { eventsForFull } from '../../wire.js';
import { previousLineEnd, readLineAt, parseLines } from '../../jsonl.js';
import { createSseStream } from '../sse.js';
import { getModel, getEffort } from '../../runtime/prefs.js';
import { listTurns, latestTurn, runningKeys } from '../../runtime/turns.js';
import { liveStates } from '../../runtime/live.js';
import { subscribeTurns } from '../../runtime/bus.js';
import { listQueue } from '../../runtime/queue.js';
import { pendingAsk } from '../../ask/store.js';
import { supportsLocalTerminal } from '../../agent/terminal.js';
import { errorBody } from '../errors.js';

// members 里含本机绝对路径，不能原样透给客户端
function publicMember(m) {
  const { file, ...rest } = m;
  return { ...rest, supportsTerminal: supportsLocalTerminal(m) };
}

function publicTurn(turn) {
  if (!turn) return null;
  const { request, ownerId, ownerPid, childPid, childStarted, childGroup, monitor, principalId, principalGeneration, ...visible } = turn;
  return visible;
}

export function listSessions(repo, { running = runningKeys(), principal = null, live = liveStates() } = {}) {
  // 可选工作目录的快捷列表。**纯加字段，不改旧结构**——客户端不接也不会坏。
  const cwds = [...visibleCwds(repo)];
  // 访客零会话时这里必须非空，否则他的新建选单是空的，压根开不了头
  for (const r of principal?.roots ?? []) if (!cwds.includes(r)) cwds.push(r);

  /*
    那一行左边的圆点，两个来源合起来：

      running  Baton 自己起的那一轮（内存集合）。取内存而不是逐个读轮次记录：
               后者是上百次 IO，而且守护进程中途挂掉时记录会永远停在 running，
               反而不如内存准（见 runtime/turns.js 里 running 那段）
      live     **电脑上**在跑的那些——桌面 App、终端里起的轮次。owner：
               「我刚刚下班，打开手机，就看不到哪些会话是还在工作的」。
               只有 Claude 有这个信号（见 runtime/live.js）

    `waiting` 是另一种状态，不是 running 的子集：会话卡在等人点确认
    （CLI 报 `waiting / input needed`）。它和「在跑」要分得开——一个是
    「等它」，一个是「等你」。两者同时成立时按在跑算。
  */
  return {
    chains: repo.listChains().map((c) => ({
      chainKey: c.chainKey,
      agent: c.agent,
      lastActivityMs: c.lastActivityMs,
      members: c.members.map((m) => {
        const here = live.get(m.providerId) ?? null;
        const isRunning = running.has(m.key) || here === 'busy';
        return {
          ...publicMember(m),
          running: isRunning,
          // 纯加字段：旧客户端不读它也不会坏
          waiting: !isRunning && here === 'waiting',
        };
      }),
    })),
    cwds: cwds.sort(),
  };
}

export async function getEvents(repo, key, { before, limit }) {
  const member = repo.getSession(key);
  if (!member) {
    return {
      status: 404,
      body: errorBody('unknown_session', `找不到会话 ${key}。`,
        '返回列表刷新一次——该会话文件可能已被删除或重命名。'),
    };
  }
  // 游标是字节偏移。给了就必须是非负整数：原来直接 Number()，`?before=abc`
  // 变成 NaN 一路传到 Buffer.alloc(NaN)，把守护进程整个打挂（2026-10-01 审查）
  const given = before !== undefined && before !== null && before !== '';
  const at = intOrNull(before);
  if (given && (at === null || at < 0)) {
    return {
      status: 400,
      body: errorBody('bad_cursor', `翻页游标 ${JSON.stringify(String(before))} 不是字节偏移。`,
        '把上一页返回的 before 原样传回来；不带它就是从最新的开始。'),
    };
  }
  const page = await pageEvents(member, {
    before: given ? at : null,
    limit: Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200),
  });
  return { status: 200, body: page };
}

// URLSearchParams.get() 对缺失的参数返回 **null**，而 `Number(null) === 0`——
// 直接 Number() 会把「没传」悄悄变成「传了 0」。实测踩过两次：?to= 缺失使全文
// 返回空串；?offset= 缺失本该报 400 却去读了文件开头。单测直接传 undefined
// （Number(undefined) 是 NaN）全绿，只有真实 HTTP 请求能暴露。
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// 取某个事件被截断掉的全文。
// 必须带 offset：不带就得从头扫 transcript 找 anchor，而实测最大的一个是 175 MB。
// offset 由事件自己携带（wire.js 附上），客户端原样回传即可。
/**
 * @param {{ getSession(key: string): any }} repo
 * @param {string} key
 * @param {string} eventId
 * @param {{ offset?: string | number | null, from?: string | number | null, to?: string | number | null }} [range]
 */
export function getEventFull(repo, key, eventId, { offset, from, to } = {}) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  const at = intOrNull(offset);
  if (at === null || at < 0) {
    return {
      status: 400,
      body: errorBody('missing_offset', '取全文需要该事件的字节偏移。',
        '把事件自带的 offset 字段原样作为 ?offset= 传回来。没有它就得全文件扫描，'
        + 'transcript 实测能到 175 MB。'),
    };
  }

  let size;
  try {
    size = fs.statSync(member.file).size;
  } catch {
    return {
      status: 404,
      body: errorBody('session_gone', '会话文件已不存在。', '返回列表刷新一次。'),
    };
  }
  if (at >= size) {
    return {
      status: 409,
      body: errorBody('offset_stale', '这个偏移已经超出文件末尾——会话可能被截断或替换过。',
        '重新拉一页事件，用新的 offset 再试。'),
    };
  }

  // 只读这一行：从 offset 起到下一个换行。给一个宽裕的上界兜住超长行。
  const line = readLineAt(member.file, at, 64 * 1024 * 1024);
  if (!line) {
    return { status: 404, body: errorBody('event_not_found', '该偏移处没有可解析的记录。', '重新拉一页事件再试。') };
  }

  const ev = eventsForFull(member, parseLines([line])).find((e) => e.id === eventId);
  if (!ev) {
    return {
      status: 404,
      body: errorBody('event_not_found', `偏移 ${at} 处没有 id 为 ${eventId} 的事件。`,
        '事件 id 形如 <记录锚点>#<块序号>，且必须与 offset 指向同一条记录。重新拉一页事件再试。'),
    };
  }

  const raw = ev.tool?.output ?? ev.tool?.input ?? ev.text ?? '';
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  // 支持按字符区间续取：一条 347 KB 的输出一次性推给手机同样不合适
  const a = Math.max(0, intOrNull(from) ?? 0);
  const b = Math.min(s.length, intOrNull(to) ?? s.length);
  return {
    status: 200,
    body: {
      id: ev.id, totalChars: s.length, from: a, to: b,
      text: s.slice(a, b),
      hasMore: b < s.length,
    },
  };
}

/**
 * 一次重放最多回放多少字节。
 *
 * 在这台机器的真实数据上量过（176 个会话、42554 轮）：**每轮字节数中位
 * 0.01 MB、P99 0.05 MB、最大 1.34 MB**。4 MB 覆盖观测到的最大单轮三倍还多，
 * 也够装下连续好几轮。
 *
 * 要有这个上限，是因为偏移由客户端给：离开一周再回来、或者一个坏客户端一直
 * 送 0，就会让服务端把整个 transcript（实测最大 175 MB）读进内存再推给手机。
 */
export const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

/**
 * 客户端说「我上次看到这儿」——把它解析成一个能用的起点。
 *
 * 两个来源：`Last-Event-ID` 头（浏览器原生 EventSource 断线重连时**自动**带上，
 * 所以网页端一行都不用改）和 `?from=` 查询（自己拼 SSE 的客户端用，或者调试）。
 * 头优先——它是协议自带的那条路。
 *
 * **看不懂就当没给**（返回 null = 从文件末尾开始跟）。绝不把解析失败当成 0：
 * 那会让一个手抖的参数变成「重放整个 transcript」。
 *
 * @returns {{ from: number|null, clamped: boolean }}
 */
export function resumeOffset({ header, query, size }) {
  const raw = (header ?? '') !== '' ? header : query;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { from: null, clamped: false };
  }
  // 只认十进制非负整数：Number() 会把 '0x10'、'1e3'、' 12 ' 都收下
  if (!/^\d+$/.test(String(raw).trim())) return { from: null, clamped: false };
  const n = Number(String(raw).trim());
  if (!Number.isSafeInteger(n)) return { from: null, clamped: false };

  // 超出文件末尾：会话被换过或截断过，这个偏移解释不了。重放会错位，
  // 不如当没给，从末尾开始——界面只是少了一段历史，而不是显示错的东西。
  if (n > size) return { from: null, clamped: false };

  if (size - n > MAX_REPLAY_BYTES) {
    return { from: size - MAX_REPLAY_BYTES, clamped: true };
  }
  return { from: n, clamped: false };
}

const MAX_STREAMS_PER_SESSION = 16;
const activeStreams = new Map();

/**
 * @param resume `{ header, query }`——客户端给的续传位置，见 `resumeOffset`。
 */
export function streamSession(repo, key, res, {
  now = () => Date.now(), resume = null, maxStreams = MAX_STREAMS_PER_SESSION,
  auth = null, deviceId = null, principalId = null, isLegacy = false,
} = {}) {
  const member = repo.getSession(key);
  if (!member) {
    return {
      status: 404,
      body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。'),
    };
  }

  const currentCount = activeStreams.get(key) ?? 0;
  if (currentCount >= maxStreams) {
    return {
      status: 429,
      body: errorBody('too_many_streams', '该会话的实时连接数已达到上限。', '关闭多余的标签页或客户端窗口后再试。'),
    };
  }
  activeStreams.set(key, currentCount + 1);
  let released = false;
  const releaseStream = () => {
    if (released) return;
    released = true;
    const n = (activeStreams.get(key) ?? 1) - 1;
    if (n <= 0) activeStreams.delete(key);
    else activeStreams.set(key, n);
  };

  // 当前轮次只在建流时读一次盘，之后全靠总线更新。
  // 不在每次心跳里读：latestTurn 走 listTurns，会把该会话所有轮次文件整个读一遍，
  // 跑过几十轮之后就是每 15 秒几十次 IO——为了一个秒表不值得。
  let current = latestTurn(key);
  let sse = null;
  let unsubscribe = () => {};
  let unsubRevoke = () => {};
  let follower = null;

  const terminateRevoked = () => {
    releaseStream();
    unsubRevoke();
    unsubscribe();
    follower?.stop();
    sse?.close();
    try {
      res.destroy?.();
    } catch {
      // ignore
    }
  };

  sse = createSseStream(res, {
    tick: () => {
      if (auth?.isSessionValid && !auth.isSessionValid({ deviceId, principalId, isLegacy })) {
        terminateRevoked();
        return null;
      }
      const running = current?.status === 'running';
      return {
        turnId: current?.turnId ?? null,
        running,
        elapsedMs: running ? now() - current.startedAt : 0,
        ...(running && current.canStop === false ? { canStop: false } : {}),
        ...(running && current.stopReason ? { stopping: true } : {}),
        // 队列没有自己的事件通道，而它是运行态的一部分：不捎上的话，
        // 「在另一台设备上排了一条」这边永远看不见，而「电脑上也能看到手机上
        // 新建的活」正是本项目的目标之一。搭已有的心跳走，零额外请求，
        // 且每 15 秒自我纠偏一次——某个 turn_end 漏了也能自动回正。
        queued: listQueue(key).length,
      };
    },
  });

  if (auth?.onRevoke) {
    unsubRevoke = auth.onRevoke((ev) => {
      const revokedThisDevice = deviceId && ev?.deviceId && ev.deviceId === deviceId;
      const revokedLegacy = isLegacy && !ev?.deviceId && ev?.principalId && ev.principalId === principalId;
      if (revokedThisDevice || revokedLegacy) terminateRevoked();
    });
  }

  /*
    断线重连时把空洞补上。

    客户端带着「我上次看到的字节偏移」回来（`Last-Event-ID` 头，浏览器自动带；
    自拼 SSE 的客户端显式带），follower 就从那儿开始重放，而不是从文件末尾。
    不这么做的话，断开期间写进 transcript 的事件谁都不会再发一遍——实测
    27.5% 的轮次单轮就超过 50 个事件，手机端那个「补拉最近 50 条」根本兜不住，
    而网页端压根没有补拉。

    **每帧带上 `id`**：值是这一帧最后一条记录的结束偏移，也就是下次要从哪儿接。
    浏览器原生 EventSource 会把它记下来并在重连时自动回传，所以网页端不用改。
  */
  let size = 0;
  try {
    size = fs.statSync(member.file).size;
  } catch {
    size = 0;
  }
  const resumeRequest = { header: resume?.header ?? null, query: resume?.query ?? null };
  function follow(at) {
    if (released || sse.closed) return;
    follower = createFollower(member, (events) => {
      const last = events[events.length - 1];
      sse.send('events', { events }, last?.offset === undefined ? null : follower.offset);
    }, { fromOffset: at.from, alignFirstRead: at.clamped });
    if (at.clamped) sse.send('gap', { from: at.from, droppedBefore: at.from });
    follower.start();
  }
  const at = resumeOffset({ ...resumeRequest, size });
  if (at.clamped) {
    // The byte budget counts complete records. A long unfinished record cannot be recovered from history.
    const requested = Number(resumeRequest.header || resumeRequest.query);
    void previousLineEnd(member.file, size, requested + MAX_REPLAY_BYTES, () => released)
      .then((end) => follow(resumeOffset({ ...resumeRequest, size: end })),
        () => follow({ from: null, clamped: false }));
  } else follow(at);

  // 运行轴只认这一路，不从 transcript 推——Claude 的 transcript 里压根没有终态记录。
  //
  // `ask` / `ask_end` 搭同一条总线走（bus 的载荷本来就是不透明的），但
  // **不能更新 `current`**：那是秒表和运行轴的锚，被一张问题卡覆盖掉的话，
  // 心跳里的 turnId 与 elapsedMs 会当场错乱。
  unsubscribe = subscribeTurns(key, ({ type, turn }) => {
    if (type === 'turn_start' || type === 'turn_end' || type === 'turn_control') {
      current = turn;
      sse.send(type, publicTurn(turn));
      if (type === 'turn_end' && runningKeys().has(key)) {
        current = latestTurn(key);
        if (current?.status === 'running') sse.send('turn_start', publicTurn(current));
      }
    } else sse.send(type, turn);
  });

  // 建流即补一帧当前轮次：手机断连是常态，重连后不能等到下一次状态变化
  // 才知道现在在跑什么——那期间秒表和运行轴都是空的。
  if (current) sse.send(current.status === 'running' ? 'turn_start' : 'turn_end', publicTurn(current));
  // 同理补一帧待答问题。断线期间 agent 正好问了一句的话，重连后这张卡必须自己回来
  const waiting = pendingAsk(key);
  if (waiting) sse.send('ask', waiting);

  res.on('close', () => {
    releaseStream();
    unsubRevoke();
    unsubscribe();
    follower?.stop();
    sse.close();
  });
  return null; // 响应已被 SSE 接管
}

/**
 * 可见会话用过的工作目录。
 *
 * **它不再是「允许的目录」**——那条规则已经换成 inScope（见 createSession）。
 * 现在它只有两个用途：列表接口的 cwds 字段，和 owner 目录浏览起点的快捷方式。
 * repo 已按调用者收窄，所以访客只会看到自己那些。
 */
export function visibleCwds(repo) {
  const set = new Set();
  for (const c of repo.listChains()) for (const m of c.members) if (m.cwd) set.add(m.cwd);
  return set;
}

// 客户端重连先拉这个，再订阅 SSE——手机断连是常态不是异常（spec §12）。
export function sessionState({
  repo, key, turns = (k) => listTurns(k), queue = listQueue,
  prefs = { get: getModel, effort: getEffort }, live = liveStates,
}) {
  const member = repo.getSession(key);
  if (!member) {
    return { status: 404, body: errorBody('unknown_session', `找不到会话 ${key}。`, '返回列表刷新一次。') };
  }
  const records = turns(key);
  const latestTurn = publicTurn(records.findLast((turn) => turn.status === 'running') ?? records.at(-1));
  // 排队中的消息也是运行态的一部分。不透出来，用户就会以为自己那条发丢了，
  // 然后再发一条——于是排了两条一样的。
  const queued = queue(key).map((i) => ({ id: i.id, text: i.text, queuedAt: i.queuedAt }));
  return {
    status: 200,
    body: {
      running: latestTurn?.status === 'running',
      /*
        **电脑上**那一轮。和 `running` 分开，不合并：`running` 还管着停止按钮，
        而电脑上那一轮 Baton 停不了（没有它的句柄），armed 一个按不动的按钮
        比没有按钮更糟。

        客户端拿它说一句话：这时发消息会排队（见 handlers/turns.js），
        先说清楚，总好过发完才发现它排着。
      */
      host: live().get(member.providerId) ?? null,
      latestTurn,
      queued,
      lastEventTs: member.lastTs ?? null,
      // null = 没选过，跟 agent 自己的默认走。不在这里替换成猜测值：
      // 「没选过」和「选了正好等于默认的那个」在 UI 上要显示得不一样。
      model: prefs.get(key),
      // 同上：null = 没选过。**纯加字段**，旧客户端不读它也不会坏。
      effort: prefs.effort?.(key) ?? null,
      agent: member.agent,
      /*
        现在有没有一道选择题在等人答。

        必须出现在**状态**里而不是只走事件流：问题挂起期间用户很可能正好切走、
        锁屏、换网（CLAUDE.md 第三条：手机断连是常态不是异常）。回来的时候
        客户端要能立刻知道「有人在等我」，而不是等下一次状态变化。
      */
      pendingAsk: pendingAsk(key),
    },
  };
}
