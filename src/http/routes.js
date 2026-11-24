import {
  listSessions, getEvents, streamSession, sessionState, getEventFull,
} from './handlers/sessions.js';
import { sendMessage, stopTurn, cancelQueued, promoteQueued } from './handlers/turns.js';
import { createSession, creationStatus } from './handlers/create.js';
import {
  pushKey, pushSubscribeHandler, pushUnsubscribeHandler, pushLatest,
} from './handlers/push.js';
import {
  listModels, setSessionModel, setSessionEffort, readPermission, writePermission,
} from './handlers/settings.js';
import {
  uploadFile, uploadToCwd, sessionUploadDestination, cwdUploadDestination, downloadUpload, listSessionFiles, downloadSessionFile,
} from './handlers/files.js';
import { errorBody } from './errors.js';
import { browseDirs, makeDir } from './handlers/dirs.js';
import { answerAsk } from './handlers/ask.js';
import { OWNER_ID } from '../principals.js';
import { getModes } from '../permission.js';
import { readUsage } from '../usage.js';
import { listCommands } from './handlers/commands.js';
import { getSessionInfo } from './handlers/info.js';
import { setGoal } from './handlers/goal.js';
import { listDevices, revokeDevice, mintPairQr } from './handlers/devices.js';
import { exportSession } from './handlers/export.js';
import { openTerminal } from './handlers/terminal.js';
import { isLocalRequest } from './auth.js';
import { VERSION } from '../version.js';

// 路由的唯一真源。server.js 按这张表分发，test/routes.test.js 按同一张表
// 逐条发真实请求断言可达——「写了 handler 却没接上路由」在结构上不再可能。
//
// 这张表的存在是为了修一个真实事故：/state 的正则漏了 state 分支、/stop
// 整条路由没加，而两者都有通过的单元测试。handler 单测测不到可达性。

function sessionSub(pathname, verb) {
  const m = new RegExp(`^/api/sessions/(.+?)/${verb}$`).exec(pathname);
  return m ? m[1] : null;
}

// 每条路由：
//   name       —— 与 handlers/ 下导出的 handler 同名，供结构性测试对账
//   method     —— HTTP 方法
//   match      —— (pathname) => 匹配值（会话 key）或 true；不匹配返回 null
//   needsBody  —— 是否要先读 JSON body
//   probe      —— (sampleKey) => 一条具体路径，供测试构造真实请求
//   run        —— ({ match, body, query, res }) => { status, body } 或 null（已接管响应）
/**
 * @typedef {object} Route
 * @property {string} name 与 handlers/ 下导出的 handler 同名
 * @property {string} method
 * @property {(pathname: string) => any} match 命中返回捕获（可能是 key），不命中返回 null
 * @property {boolean} [needsBody]
 * @property {boolean} [rawBody]
 * @property {(ctx: any) => {status?: number, body?: object, cwd?: string}} [preflight]
 * @property {(key: string) => string} [probe]
 * @property {(ctx: any) => Promise<{ status: number, body: unknown } | null>} run
 */

/** @returns {Route[]} */
export function buildRoutes({ auth, terminalLauncher = null }) {
  return [
    {
      name: 'health',
      method: 'GET',
      match: (p) => (p === '/api/health' ? true : null),
      probe: () => '/api/health',
      // config 是已按调用者合成过有效 allowSend 的那一份（见 server.js）
      //
      // permissionMode 一并捎上：界面上那条「全部放行」的横幅要在**每一屏**都挂着，
      // 而 health 是唯一一个各屏都会打的轻端点。单开一次请求只为了问这个，
      // 等于让横幅比页面本身晚一拍出现。
      run: async ({ req, config, principal, deviceId }) => {
        const isOwner = (principal?.roots ?? null) === null && (principal?.id ?? OWNER_ID) === OWNER_ID;
        const isLocal = isLocalRequest(req);
        return {
          status: 200,
          body: {
            ok: true,
            version: VERSION,
            deviceId: deviceId ?? null,
            allowSend: config.allowSend,
            isLocal,
            canOpenTerminal: isLocal && isOwner,
            // 两边各自的档位。横幅要判「有没有哪一边开着全部放行」，
            // 而共用一个标量的时候这个判断必然漏掉另一边。
            permissionModes: getModes(),
            // 旧客户端只认这个标量。留着，值取 claude 那边
            permissionMode: getModes().claude,
            canSetPermissionMode: (principal?.roots ?? null) === null,
            principal: {
              id: principal?.id ?? OWNER_ID,
              ...(principal?.generation ? { generation: principal.generation } : {}),
              isOwner: (principal?.roots ?? null) === null,
            },
          },
        };
      },
    },
    {
      name: 'listDevices',
      method: 'GET',
      match: (p) => (p === '/api/devices' ? true : null),
      probe: () => '/api/devices',
      run: async ({ principal, deviceId }) => listDevices({ auth, principal, deviceId }),
    },
    {
      name: 'revokeDevice',
      method: 'POST',
      match: (p) => (p === '/api/devices/revoke' ? true : null),
      needsBody: true,
      probe: () => '/api/devices/revoke',
      run: async ({ principal, body, deviceId }) => revokeDevice({ auth, principal, body, deviceId }),
    },
    {
      name: 'mintPairQr',
      method: 'POST',
      match: (p) => (p === '/api/pair/qr' ? true : null),
      needsBody: true,
      probe: () => '/api/pair/qr',
      run: async ({ principal, config, req, body, interfaces }) => mintPairQr({ auth, principal, config, req, body, interfaces }),
    },
    {
      // 铸配对码。两道闸：
      //   1. 必须已持有凭据（authorize 挡在前面）。加固前是「任何匿名请求打到 /
      //      就铸一个」——撤掉 Cloudflare Access 后那是远程可触发的铸码入口，
      //      稳态同时有效码从 0 变成约 20 个。权威改为文件权限。
      //   2. **必须是 owner**。只有第 1 道闸时，任何已认证者铸出来的都是 owner 的码，
      //      于是访客铸一个、自己兑一下就成了 owner——工作区隔离当场归零。
      name: 'mintPairingCode',
      method: 'POST',
      match: (p) => (p === '/api/pair/new' ? true : null),
      needsBody: true,
      probe: () => '/api/pair/new',
      run: async ({ body, principal }) => {
        if (principal.id !== OWNER_ID) {
          return {
            status: 403,
            body: errorBody('owner_only', '只有 owner 能生成配对码。',
              '请 owner 在跑着 Baton 的那台电脑上执行 npm run pair 取一个码给你。'),
          };
        }
        const want = body?.for ?? OWNER_ID;
        const ids = auth.principalIds();
        if (!ids.includes(want)) {
          return {
            status: 400,
            body: errorBody('unknown_principal', `没有这个身份：${want}`,
              `可用的身份：${ids.join('、')}。要新增一个人，改 ~/.baton/principals.json 再重启 Baton。`),
          };
        }
        return { status: 200, body: { code: auth.newPairingCode(want), for: want } };
      },
    },
    {
      // 推送的公钥。客户端订阅时必须把它传给 PushManager.subscribe()。
      // 不是秘密——它就是用来让推送服务认出「这是谁在推」的。
      name: 'pushKey',
      method: 'GET',
      match: (p) => (p === '/api/push/key' ? true : null),
      probe: () => '/api/push/key',
      run: async () => pushKey(),
    },
    {
      name: 'pushSubscribeHandler',
      method: 'POST',
      match: (p) => (p === '/api/push/subscribe' ? true : null),
      needsBody: true,
      probe: () => '/api/push/subscribe',
      // 身份取自已认证的 principal，不从 body 里读——读了访客就能自报 owner，
      // 于是收到 owner 的全部通知
      run: async ({ body, principal, deviceId }) => pushSubscribeHandler(body, principal, deviceId,
        (id) => auth.isSessionValid({ deviceId: id, principalId: principal.id })),
    },
    {
      name: 'pushUnsubscribeHandler',
      method: 'POST',
      match: (p) => (p === '/api/push/unsubscribe' ? true : null),
      needsBody: true,
      probe: () => '/api/push/unsubscribe',
      run: async ({ body, principal, deviceId }) => pushUnsubscribeHandler(body, principal, deviceId),
    },
    {
      // service worker 被推醒之后来问「刚才结束的是哪一轮」。
      // 推送不带载荷，所以通知内容是这一步取的——也因此永远是此刻的真实状态。
      name: 'pushLatest',
      method: 'GET',
      match: (p) => (p === '/api/push/latest' ? true : null),
      probe: () => '/api/push/latest',
      run: async ({ principal, repo }) => pushLatest(principal, repo),
    },
    {
      // 可选模型。列表现推，不写死——这台机器两边都走第三方中转，
      // 模型名（claude-opus-5 / gpt-6-astra）都不在官方表上。
      name: 'listModels',
      method: 'GET',
      match: (p) => (p === '/api/models' ? true : null),
      probe: () => '/api/models',
      run: async ({ query }) => listModels({ force: query.get('refresh') === '1' }),
    },
    {
      // 两个 agent 的套餐额度（src/usage.js）。**owner 专属**：那是 owner 账号的额度。
      // ?refresh=1 跳过 60 秒缓存（界面上的「刷新」）
      name: 'getUsage',
      method: 'GET',
      match: (p) => (p === '/api/usage' ? true : null),
      probe: () => '/api/usage',
      run: async ({ principal, query }) => {
        if ((principal?.roots ?? null) !== null) {
          return {
            status: 403,
            body: errorBody('not_owner', '额度只有这台电脑的主人能看。', '它是电脑主人账号的套餐额度，和你的工作区无关。'),
          };
        }
        return { status: 200, body: await readUsage({ force: query.get('refresh') === '1' }) };
      },
    },
    {
      // 浏览目录，给客户端做工作目录选择器。只列目录不列文件——
      // 文件树是 v1 §18 明确不做的。
      name: 'browseDirs',
      method: 'GET',
      match: (p) => (p === '/api/dirs' ? true : null),
      probe: () => '/api/dirs',
      run: async ({ repo, principal, query }) => browseDirs({
        repo, principal, path: query.get('path'),
      }),
    },
    {
      // 权限档位。**owner 专属**——见 handlers/settings.js 里 writePermission 的抬头：
      // 访客一旦能开 bypass，工作区隔离当场失效（一个不问就能跑 shell 的 agent，
      // 走出工作区只需要一条 cd）。和铸码那条是同一类闸。
      name: 'readPermission',
      method: 'GET',
      match: (p) => (p === '/api/permission' ? true : null),
      probe: () => '/api/permission',
      run: async ({ principal }) => readPermission({ principal }),
    },
    {
      name: 'writePermission',
      method: 'POST',
      match: (p) => (p === '/api/permission' ? true : null),
      needsBody: true,
      probe: () => '/api/permission',
      run: async ({ principal, body }) => writePermission({ principal, agent: body.agent, mode: body.mode }),
    },
    {
      // 新建目录。归在 allowSend 之下——它往 owner 的磁盘上写东西，
      // 与上传文件是同一条纪律。
      name: 'makeDir',
      method: 'POST',
      match: (p) => (p === '/api/dirs' ? true : null),
      needsBody: true,
      probe: () => '/api/dirs',
      run: async ({ config, principal, body }) => makeDir({
        config, principal, path: body.path,
      }),
    },
    {
      name: 'listSessions',
      method: 'GET',
      match: (p) => (p === '/api/sessions' ? true : null),
      probe: () => '/api/sessions',
      run: async ({ repo, principal }) => ({ status: 200, body: listSessions(repo, { principal }) }),
    },
    {
      name: 'createSession',
      method: 'POST',
      match: (p) => (p === '/api/sessions' ? true : null),
      needsBody: true,
      probe: () => '/api/sessions',
      // principal 现在就传下去，尽管 createSession 要到工作目录规则改完才用得上：
      // 多传一个被忽略的具名参数无害，而这样那一步就不必再回头改路由表。
      run: async ({ repo, config, principal, body }) => createSession({
        repo, config, principal, principalOf: auth?.principalOf ?? null,
        agent: body.agent, cwd: body.cwd, message: body.message, model: body.model,
        effort: body.effort,
      }),
    },
    {
      name: 'creationStatus', method: 'GET',
      match: (p) => /^\/api\/session-creations\/([0-9a-f-]{36})$/.exec(p)?.[1] ?? null,
      probe: () => '/api/session-creations/00000000-0000-0000-0000-000000000000',
      run: async ({ match, principal, repo }) => creationStatus({ turnId: match, principal, repo }),
    },
    {
      // 切模型。落在会话上而不是设备上——两台设备必须看到同一个选择。
      name: 'setSessionModel',
      method: 'POST',
      match: (p) => sessionSub(p, 'model'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/model`,
      run: async ({ repo, config, match, body }) => setSessionModel({ repo, config, key: match, model: body.model }),
    },
    {
      // 思考强度。和模型并列、同样落在会话上，但**独立端点**——
      // 并进 /model 的话「只改其中一个」就变成一次可能误清另一个的写。
      name: 'setSessionEffort',
      method: 'POST',
      match: (p) => sessionSub(p, 'effort'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/effort`,
      run: async ({ repo, config, match, body }) => setSessionEffort({ repo, config, key: match, effort: body.effort }),
    },
    {
      name: 'getEvents',
      method: 'GET',
      match: (p) => sessionSub(p, 'events'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/events?limit=3`,
      run: async ({ repo, match, query }) => getEvents(repo, match, {
        before: query.get('before'), limit: query.get('limit'),
      }),
    },
    {
      // 取被截断掉的全文。事件 id 形如 <记录锚点>#<块序号>，`#` 在 URL 里是片段
      // 分隔符，客户端必须发 %23——server.js 会 decodeURIComponent 后再匹配。
      name: 'getEventFull',
      method: 'GET',
      match: (p) => {
        const m = /^\/api\/sessions\/(.+?)\/events\/(.+?)\/full$/.exec(p);
        return m ? { key: m[1], eventId: m[2] } : null;
      },
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/events/${encodeURIComponent('x#0')}/full?offset=0`,
      run: async ({ repo, match, query }) => getEventFull(repo, match.key, match.eventId, {
        offset: query.get('offset'), from: query.get('from'), to: query.get('to'),
      }),
    },
    {
      name: 'sessionState',
      method: 'GET',
      match: (p) => sessionSub(p, 'state'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/state`,
      run: async ({ repo, match }) => sessionState({ repo, key: match }),
    },
    {
      name: 'streamSession',
      method: 'GET',
      match: (p) => sessionSub(p, 'stream'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/stream`,
      /*
        续传位置有两个来源，头优先：
          Last-Event-ID  浏览器原生 EventSource 断线重连时**自动**带上
          ?from=         自己拼 SSE 的客户端（手机端）显式带，或者调试用
        见 handlers/sessions.js 的 resumeOffset。
      */
      run: async ({ repo, match, res, req, query, principal, deviceId, isLegacy }) => streamSession(repo, match, res, {
        resume: { header: req.headers['last-event-id'] ?? null, query: query.get('from') },
        auth,
        deviceId,
        principalId: principal?.id ?? null,
        isLegacy,
      }),
    },
    {
      name: 'sendMessage',
      method: 'POST',
      match: (p) => sessionSub(p, 'send'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/send`,
      run: async ({ repo, config, principal, match, body }) => sendMessage({
        repo,
        config,
        principal,
        principalOf: auth?.principalOf ?? null,
        key: match,
        message: body.message,
        requestId: body.requestId,
        fork: body.fork === true,
        // 'now' = 人自己按了「立刻发送」。只放行「电脑上那一轮」这一条，
        // 不放行 Baton 自己那一轮（见 sendMessage 里那段）。
        // 'interrupt' = 插队：Baton 自己那一轮在跑就先停下它，这条第一个发
        when: body.when === 'now' || body.when === 'interrupt' ? body.when : 'auto',
      }),
    },
    {
      /*
        撤回排着的某一条。owner 2026-10-09：「排队的消息现在还不能撤回」。

        用 POST 不用 DELETE：这条路上的客户端（手机、网页、v1 老界面）发的都是
        POST + JSON，加一个只在这儿用的动词，三端都要各写一套分支。
      */
      name: 'cancelQueued',
      method: 'POST',
      match: (p) => sessionSub(p, 'queue/cancel'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/queue/cancel`,
      run: async ({ repo, config, match, body }) => cancelQueued({ repo, config, key: match, id: body.id }),
    },
    {
      name: 'promoteQueued', method: 'POST', match: (p) => sessionSub(p, 'queue/promote'), needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/queue/promote`,
      run: async ({ repo, config, principal, match, body }) => promoteQueued({
        repo, config, principal, principalOf: auth?.principalOf ?? null, key: match, id: body.id,
      }),
    },
    {
      // 传文件。body 是原始字节不是 JSON——base64 进 JSON 要多背 33% 的体积，
      // 而这条路上跑的是手机流量。文件名走 query。
      name: 'uploadFile',
      method: 'POST',
      match: (p) => sessionSub(p, 'upload'),
      rawBody: true,
      preflight: ({ repo, config, principal, match }) => sessionUploadDestination({ repo, config, principal, key: match }),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/upload?name=probe.txt`,
      run: async ({ repo, config, principal, match, raw, query }) => uploadFile({
        repo, config, principal, key: match, name: query.get('name'), bytes: raw,
      }),
    },
    {
      /*
        传文件到一个**工作目录**，而不是一个会话。
        新建会话那一屏靠它：附件路径必须出现在第一条消息里，而那一刻还没有
        session key。授权判据与「能不能在这个目录建会话」逐条相同，
        因此不多给任何权限——详见 handlers/files.js 里 uploadToCwd 抬头那段。

        cwd 与 name 都走 query，body 是原始字节：和按 key 那条保持一致
        （base64 进 JSON 要多背 33% 体积，而这条路上跑的是手机流量）。
      */
      name: 'uploadToCwd',
      method: 'POST',
      match: (p) => (p === '/api/uploads' ? true : null),
      rawBody: true,
      preflight: ({ config, principal, query }) => cwdUploadDestination({ config, principal, cwd: query.get('cwd') }),
      probe: () => '/api/uploads?cwd=/tmp&name=probe.txt',
      run: async ({ config, principal, raw, query }) => uploadToCwd({
        config, principal, cwd: query.get('cwd'), name: query.get('name'), bytes: raw,
      }),
    },
    {
      // 把传上去的文件读回来出缩略图。只读它自己写出去过的东西——
      // 校验和写入那条完全一样（见 src/upload.js 的 readUpload）。
      // 响应是原始字节，由 handler 自己接管 res，所以返回 null。
      name: 'downloadUpload',
      method: 'GET',
      match: (p) => sessionSub(p, 'upload'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/upload?name=probe.txt`,
      run: async ({ repo, principal, match, query, res }) => downloadUpload({
        repo, principal, key: match, name: query.get('name'), res,
      }),
    },
    {
      // 输入框里打 `/` 弹出来的命令表。?probe=1 才会在没有记录时起探针，见 handlers/commands.js
      name: 'listCommands',
      method: 'GET',
      match: (p) => sessionSub(p, 'commands'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/commands`,
      run: async ({ repo, match, query }) => listCommands({ repo, key: match, query }),
    },
    {
      // 会话页右侧「信息」窗格：模型、上下文、目标、计划、改过的文件。?file= 看某个文件的改动
      name: 'getSessionInfo',
      method: 'GET',
      match: (p) => sessionSub(p, 'info'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/info`,
      run: async ({ repo, match, query }) => getSessionInfo({ repo, key: match, query }),
    },
    {
      // 设 / 清目标。{ objective } 设，{ clear: true } 清。两个 agent 各怎么做见 handlers/goal.js
      name: 'setGoal',
      method: 'POST',
      match: (p) => sessionSub(p, 'goal'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/goal`,
      run: async ({ repo, config, principal, match, body }) => setGoal({
        repo, config, principal, principalOf: auth?.principalOf ?? null, key: match,
        objective: body?.objective, clear: body?.clear === true,
      }),
    },
    {
      // 列会话工作目录里的一层。范围锁在该会话的 cwd 子树，见 src/sessionfs.js。
      name: 'listSessionFiles',
      method: 'GET',
      match: (p) => sessionSub(p, 'files'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/files`,
      run: async ({ repo, principal, match, query }) => listSessionFiles({
        repo, principal, key: match, path: query.get('path'),
      }),
    },
    {
      // 下载工作目录里的一个文件。自己接管 res 吐原始字节，所以返回 null。
      name: 'downloadSessionFile',
      method: 'GET',
      match: (p) => sessionSub(p, 'file'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/file?path=probe.txt`,
      run: async ({ repo, principal, match, query, res }) => downloadSessionFile({
        repo, principal, key: match, path: query.get('path'), res,
      }),
    },
    {
      /*
        答一道 agent 正在等的选择题。

        走会话路径而不是一个全局端点：这样 scopeRepo 那层自动生效——
        访客答不了 owner 会话里的题，而 answerAsk 里一个字都不用写。
        （handler 自己再核一次 askId，防的是另一种情况：断线期间这轮已经
        超时又开了新的题，手上那张卡已经不是现在等的那道。）
      */
      name: 'answerAsk',
      method: 'POST',
      match: (p) => sessionSub(p, 'answer'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/answer`,
      run: async ({ repo, config, match, body }) => {
        if (!repo.getSession(match)) {
          return {
            status: 404,
            body: errorBody('unknown_session', `找不到会话 ${match}。`, '返回列表刷新一次。'),
          };
        }
        return answerAsk({
          config, key: match, askId: body.askId, picked: body.picked, free: body.free,
        });
      },
    },
    {
      name: 'exportSession',
      method: 'GET',
      match: (p) => sessionSub(p, 'export'),
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/export`,
      run: async ({ repo, match, res }) => exportSession({ repo, key: match, res }),
    },
    {
      name: 'openTerminal',
      method: 'POST',
      match: (p) => sessionSub(p, 'terminal'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/terminal`,
      run: async ({ repo, principal, req, match }) => openTerminal({
        repo,
        principal,
        req,
        key: match,
        ...(terminalLauncher ? { launcher: terminalLauncher } : {}),
      }),
    },
    {
      name: 'stopTurn',
      method: 'POST',
      match: (p) => sessionSub(p, 'stop'),
      needsBody: true,
      probe: (key) => `/api/sessions/${encodeURIComponent(key)}/stop`,
      run: async ({ repo, config, match, body }) => stopTurn({ repo, config, key: match, turnId: body.turnId }),
    },
  ];
}

// 所有需要可达路由的 handler。结构性测试断言这个集合与路由表一一对应——
// 新增 handler 忘了登记，测试就红。
export const ROUTED_HANDLERS = [
  'health', 'mintPairingCode', 'mintPairQr', 'listDevices', 'revokeDevice',
  'listSessions', 'createSession', 'creationStatus', 'getEvents',
  'sessionState', 'streamSession', 'exportSession', 'openTerminal', 'sendMessage', 'cancelQueued', 'promoteQueued', 'stopTurn', 'getEventFull',
  'pushKey', 'pushSubscribeHandler', 'pushUnsubscribeHandler', 'pushLatest',
  'listModels', 'setSessionModel', 'uploadFile', 'uploadToCwd', 'downloadUpload', 'browseDirs', 'makeDir',
  'listSessionFiles', 'downloadSessionFile',
  'readPermission', 'writePermission', 'setSessionEffort', 'answerAsk', 'getUsage', 'listCommands', 'getSessionInfo', 'setGoal',
];
