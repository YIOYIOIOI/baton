/**
 * Baton 的 service worker。
 *
 * 两件事：
 *   1. 被推醒后显示通知（推送不带载荷，内容自己来取）
 *   2. 点通知时把那个会话打开——已经开着就聚焦，不要再开一个
 *
 * **不做离线缓存。** 会话内容是实时的，缓存一份旧的给用户看，就是这个项目
 * 最该消灭的那种说谎。离线时正确的表现是界面明说「你离线了」，
 * 而那已经由传输轴负责了。
 */

const VERSION = 'baton-sw-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const STATUS_TEXT = {
  ok: '跑完了',
  failed: '这一轮失败了',
  anomaly: '这一轮异常结束',
  aborted: '这一轮被停止了',
};

self.addEventListener('push', (event) => {
  // iOS 的规矩：收到推送**必须**显示一条通知，否则会被收回推送权限。
  // 所以这里不管取没取到内容，最后一定 showNotification。
  event.waitUntil((async () => {
    let title = 'Baton';
    let body = '那台电脑上有动静了';
    let data = {};

    try {
      // 同源，浏览器会自动带上配对 cookie
      const res = await fetch('/api/push/latest', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        const latest = await res.json();
        if (latest?.title) {
          title = latest.title.length > 40 ? `${latest.title.slice(0, 40)}…` : latest.title;
          body = STATUS_TEXT[latest.status] ?? '有更新';
          data = { key: latest.key };
        }
      }
    } catch {
      // 取不到就用兜底文案。宁可说得笼统，也不能不显示——
      // 不显示的代价是整个推送权限被系统收回。
    }

    await self.registration.showNotification(title, {
      body,
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      // 同一个 tag 的通知会互相替换：连着跑完三轮，通知栏里应该只留最新那条，
      // 而不是堆三条
      tag: 'baton-turn',
      renotify: true,
      data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const key = event.notification.data?.key;
  const target = key ? `/session/${encodeURIComponent(key)}` : '/';

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已经开着就聚焦并导航过去——再开一个窗口，用户会有两份同样的界面
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if ('navigate' in w) await w.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// 订阅被推送服务换掉时（浏览器有时会主动轮换）重新报备，否则推送会静默失效
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const key = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.publicKey,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch {
      // 换订阅失败只能等用户下次打开 app 时再订一次
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source?.postMessage(VERSION);
});
