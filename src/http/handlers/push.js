// 推送：一轮跑完（排着的也都发完）才敲门；订阅按人分区。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。

import {
  notify as pushNotify, setLatest as pushSetLatest, getLatest as pushGetLatest, publicKey as pushPublicKey, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe,
} from '../../push.js';
import { errorBody } from '../errors.js';

/**
 * 轮次跑完后敲一记门。
 *
 * 只有 Baton 自己发起的轮次会走到这里——在电脑前手打的那些 Baton 根本没有
 * 轮次记录，也就不会推。这是对的：人就在电脑前，不需要手机再响一次。
 *
 * 通知内容不随推送走（见 src/push.js 抬头），这里只把「刚结束的是哪一轮」
 * 记下来，供 service worker 醒来后取。
 */
export async function defaultPushSend({ key, member, turn, principalId = 'owner' }) {
  pushSetLatest(principalId, {
    key,
    title: member?.title ?? '一个会话',
    status: turn?.status ?? 'ok',
    agent: member?.agent ?? null,
  });
  return pushNotify({ principalId });
}

export function pushKey() {
  return { status: 200, body: { publicKey: pushPublicKey() } };
}

export function pushSubscribeHandler(body, principalId = 'owner') {
  try {
    // principalId 取自已认证的身份，不从 body 里读——读了访客就能自报 owner
    const n = pushSubscribe(body ?? {}, principalId);
    return { status: 200, body: { ok: true, subscriptions: n } };
  } catch (err) {
    return {
      status: 400,
      body: errorBody('bad_subscription', err.message,
        '把 PushManager.subscribe() 返回对象的 endpoint 原样发过来。'),
    };
  }
}

export function pushUnsubscribeHandler(body, principalId = 'owner') {
  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return { status: 400, body: errorBody('missing_endpoint', '要退订哪一个没说。', '带上 endpoint。') };
  }
  return { status: 200, body: { ok: true, subscriptions: pushUnsubscribe(endpoint, principalId) } };
}

/** service worker 醒来后问「刚才结束的是哪一轮」。 */
export function pushLatest(principalId = 'owner') {
  return {
    status: 200,
    body: pushGetLatest(principalId) ?? { title: null, status: null, key: null },
  };
}
