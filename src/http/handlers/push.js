// 推送：一轮跑完（排着的也都发完）才敲门；订阅按人分区。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import {
  notify as pushNotify, setLatest as pushSetLatest, getLatest as pushGetLatest, publicKey as pushPublicKey, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe,
} from '../../push.js';
import { errorBody } from '../errors.js';
import { isCurrentPrincipal } from '../../principals.js';

/**
 * 轮次跑完后敲一记门。
 *
 * 只有 Baton 自己发起的轮次会走到这里——在电脑前手打的那些 Baton 根本没有
 * 轮次记录，也就不会推。这是对的：人就在电脑前，不需要手机再响一次。
 *
 * 通知内容不随推送走（见 src/push.js 抬头），这里只把「刚结束的是哪一轮」
 * 记下来，供 service worker 醒来后取。
 */
export async function defaultPushSend({ key, member, turn, principalId = 'owner', principal = null }) {
  if (!isCurrentPrincipal(principal)) return { sent: 0, dropped: 0 };
  const generation = principal?.generation ?? null;
  pushSetLatest(principalId, {
    key,
    generation,
    title: member?.title ?? '一个会话',
    status: turn?.status ?? 'ok',
    agent: member?.agent ?? null,
  });
  return pushNotify({ principalId, generation, principal });
}

export function pushKey() {
  return { status: 200, body: { publicKey: pushPublicKey() } };
}

export function pushSubscribeHandler(body, principal, deviceId, valid = undefined) {
  if (!deviceId) return deviceRequired();
  try {
    const n = pushSubscribe(body ?? {}, principal.id, deviceId, principal.generation ?? null, valid);
    return { status: 200, body: { ok: true, subscriptions: n } };
  } catch (err) {
    if (err.code === 'paired_device_required') return deviceRequired();
    if (err.code === 'push_subscription_limit') return { status: 429, body: errorBody(err.code, err.message, '请先移除不用的推送订阅。') };
    if (err.code || err instanceof SyntaxError) throw err;
    return { status: 400, body: errorBody('bad_subscription', err.message, '请使用当前设备 PushManager 提供的 endpoint。') };
  }
}

function deviceRequired() {
  return { status: 403, body: errorBody('paired_device_required', '推送订阅需要独立的已配对设备。', '请在这台设备上重新配对。') };
}

export function pushUnsubscribeHandler(body, principal, deviceId) {
  if (!deviceId) return deviceRequired();
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return { status: 400, body: errorBody('missing_endpoint', '要退订哪一个没说。', '带上 endpoint。') };
  }
  return { status: 200, body: { ok: true, subscriptions: pushUnsubscribe(endpoint, principal.id, deviceId) } };
}

/** service worker 醒来后问「刚才结束的是哪一轮」。 */
export function pushLatest(principal, repo) {
  const latest = pushGetLatest(principal.id);
  if (latest?.key && (latest.generation ? latest.generation === principal.generation : !principal.generation || principal.acceptLegacy)
    && repo.getSession(latest.key)) {
    const { generation: _generation, ...body } = latest;
    return { status: 200, body };
  }
  return { status: 200, body: { title: null, status: null, key: null } };
}
