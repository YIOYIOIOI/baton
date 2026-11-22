import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { eventually, startHost } from './host.mjs';
import { openBrowser } from './chromium.mjs';

// Keep the actual daemon and production clients on the wire. Drop just the first
// acknowledged send and, when requested, only the unpair request.
async function startRelay(t, host) {
  const observed = { sends: [], streams: [], latest: 0, renewals: 0, offlineUnpair: false, pausePair: false, cutPair: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, host.base);
    if (url.origin !== host.base) { res.writeHead(400).end(); return; }
    if (url.pathname === '/__test_blank') { res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Test observer</title>'); return; }
    if (url.pathname === '/api/unpair' && observed.offlineUnpair) { req.socket.destroy(); return; }
    if (url.pathname === '/api/health') observed.healthChecks = (observed.healthChecks ?? 0) + 1;
    if (url.pathname === '/api/health' && observed.hideOldIdentity) {
      res.writeHead(401, { 'content-type': 'application/json', 'x-baton': '1' }).end('{}'); return;
    }
    if (url.pathname === '/api/pair') observed.pairPosts = (observed.pairPosts ?? 0) + 1;
    if (url.pathname === '/api/push/latest') {
      observed.latest++;
      res.writeHead(200, { 'content-type': 'application/json', 'x-baton': '1' });
      res.end(JSON.stringify({ title: 'Private fixture notification', status: 'ok', key: host.key }));
      return;
    }
    if (url.pathname === '/api/push/key' || url.pathname === '/api/push/subscribe') observed.renewals++;
    const send = url.pathname.endsWith('/send');
    const chunks = [];
    const upstream = http.request(url, { method: req.method, headers: req.headers }, (reply) => {
      if (url.pathname === '/api/pair' && reply.statusCode === 400) observed.hideOldIdentity = false;
      if (url.pathname === '/api/pair' && observed.stripCookie && !observed.pausePair && reply.statusCode === 200) {
        const headers = { ...reply.headers };
        delete headers['set-cookie'];
        res.writeHead(200, headers);
        const body = [];
        reply.on('data', (chunk) => body.push(chunk));
        reply.once('end', () => { observed.strippedReceipt = JSON.parse(Buffer.concat(body)); });
        reply.pipe(res);
        return;
      }
      if (url.pathname === '/api/pair' && observed.pausePair && reply.statusCode === 200) {
        reply.resume();
        const headers = { ...reply.headers, 'content-length': 128 };
        if (observed.stripCookie) delete headers['set-cookie'];
        res.writeHead(200, headers);
        res.write('{', () => { observed.cutPair = () => res.destroy(); });
        return;
      }
      if (send) {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        observed.sends.push({ requestId: payload.requestId, message: payload.message, status: reply.statusCode });
        if (observed.sends.length === 1 && reply.statusCode === 202) {
          reply.resume();
          reply.once('end', () => {
            // A dropped idle socket makes Chromium retry a POST transparently.
            // A truncated HTTP body instead reaches the UI as a lost receipt.
            res.writeHead(202, { 'content-type': 'application/json', 'content-length': 128 });
            res.write('{', () => res.destroy());
          });
          return;
        }
      }
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    if (url.pathname.endsWith('/stream')) {
      const stream = { closed: false };
      observed.streams.push(stream);
      res.on('close', () => { stream.closed = true; });
    }
    res.on('close', () => upstream.destroy());
    upstream.on('error', () => res.destroy());
    if (send) req.on('data', (chunk) => chunks.push(chunk));
    req.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  t.after(() => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    return closed;
  });
  return { base: 'http://127.0.0.1:' + server.address().port, observed };
}

async function clickPair(browser, url) {
  await eventually(() => browser.evaluate(`(() => {
    const button = document.querySelector('.door-pair button[type=submit]');
    if (location.href !== ${JSON.stringify(url)} || !button || button.disabled) return false;
    button.click(); return true;
  })()`), 12000, 'desktop pair');
}

async function submitPair(host, base, browser, guest, mobile) {
  const url = base + '/pair?c=' + encodeURIComponent(await host.codeFor(guest));
  await browser.navigate(url);
  if (!mobile) await clickPair(browser, url);
}

async function pair(host, base, browser, guest, mobile) {
  await submitPair(host, base, browser, guest, mobile);
  await eventually(() => browser.evaluate("location.pathname !== '/pair' && location.protocol !== 'about:'"), 15000, 'navigation after pairing');
}

async function secondTab(browser, withoutWebLocks = false) {
  const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  if (withoutWebLocks) {
    await browser.command('Page.enable', {}, sessionId);
    await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'locks', {value: undefined})" }, sessionId);
  }
  return {
    navigate: (url) => browser.command('Page.navigate', { url }, sessionId),
    onNewDocument: (source) => browser.command('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId),
    close: () => browser.command('Target.closeTarget', { targetId }),
    async evaluate(expression) {
      const result = await browser.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

async function observeWorker(browser, base) {
  const find = async () => (await browser.command('Target.getTargets')).targetInfos
    .find((item) => item.type === 'service_worker' && item.url === base + '/sw.js');
  const target = await eventually(find, 10000, 'running production service worker');
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await browser.command('Runtime.enable', {}, sessionId);
  await browser.command('Runtime.addBinding', { name: '__batonObserveNotice' }, sessionId);
  // A headless shell has no operating-system notification tray. Observe the
  // actual native API arguments and still call the original browser method.
  const result = await browser.command('Runtime.evaluate', { expression: `(() => {
    const original = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
      self.__batonObserveNotice(JSON.stringify({title, body: options.body, data: options.data}));
      return original.call(this, title, options);
    }; return true;
  })()`, returnByValue: true }, sessionId);
  assert.equal(result.result.value, true);
  return { sessionId, targetId: target.targetId };
}

test('desktop retries a lost acceptance once and abandons the previous identity when another tab pairs', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('production desktop UI', async (sub) => {
    const browser = await openBrowser(sub, host.root, false);
    await pair(host, base, browser, 'owner', false);
    await browser.navigate(base + '/session/' + encodeURIComponent(host.key));
    await eventually(() => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'), 15000, 'first history render');
    const message = 'sent once despite a lost acceptance';
    await browser.evaluate(`(() => {
      const box = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(message)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const transfer = new DataTransfer();
      transfer.items.add(new File(['fixture'], 'receipt-fixture.txt', {type: 'text/plain'}));
      const picker = document.querySelector('input[type=file]');
      picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const attachment = () => browser.evaluate("Boolean(document.querySelector('.att-name[title=\"receipt-fixture.txt\"]'))");
    await eventually(attachment, 10000, 'uploaded attachment');
    const submit = () => browser.evaluate(`(() => {
      const b = document.querySelector('.composer-box button[aria-label="发送"],.composer-box button[aria-label^="排队"]');
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`);
    await eventually(submit, 10000, 'submit initial message');
    const restored = () => browser.evaluate('document.querySelector("textarea")?.value === ' + JSON.stringify(message));
    await eventually(() => observed.sends.length === 1 && restored(), 12000, 'recover message after lost acknowledgement')
      .catch(async (err) => { throw new Error(`${err.message}; HTTP ${observed.sends.map(s => s.status)}, draft restored: ${await restored()}`, { cause: err }); });
    await browser.command('Page.reload');
    await eventually(restored, 12000, 'restore unresolved message after reloading the session');
    await eventually(attachment, 10000, 'restore uploaded attachment after reload');
    const savedReceipt = await browser.evaluate(`(() => {
      const key = Object.keys(localStorage).find(k => k.includes('.send.'));
      return { key, value: JSON.parse(localStorage.getItem(key)) };
    })()`);
    await eventually(submit, 10000, 'retry restored message');
    await eventually(() => observed.sends.length === 2, 10000, 'second acknowledged request');
    assert.match(observed.sends[0].requestId, /^[a-z0-9._:-]+$/i);
    assert.equal(observed.sends[0].status, 202);
    assert.equal(observed.sends[1].status, 202);
    assert.deepEqual(observed.sends[1], observed.sends[0]);
    assert.ok(observed.sends[0].message.startsWith(message) && observed.sends[0].message.includes('receipt-fixture.txt'));
    await eventually(() => browser.evaluate("!Object.keys(localStorage).some(k=>k.includes('.send.'))"), 10000, 'clear acknowledged request');
    await eventually(async () => (await (await host.request('/api/sessions/' + encodeURIComponent(host.key) + '/state')).json()).latestTurn?.status === 'ok', 12000, 'completed fixture turn');
    const records = fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.filter((row) => row.message?.content === observed.sends[0].message).length, 1);
    const expired = { ...savedReceipt.value, startedAt: Date.now() - 25 * 3600000 };
    await browser.evaluate(`localStorage.setItem(${JSON.stringify(savedReceipt.key)}, ${JSON.stringify(JSON.stringify(expired))})`);
    await browser.command('Page.reload');
    await eventually(() => browser.evaluate("!!document.querySelector('.composer-err button')"), 12000, 'expired receipt stays available for inspection');
    await eventually(submit, 10000, 'try to submit the expired message');
    await browser.evaluate("document.querySelector('.composer-err button').click()");
    await eventually(() => browser.evaluate('!localStorage.getItem(' + JSON.stringify(savedReceipt.key) + ')'), 10000, 'explicitly discard the old receipt');
    assert.ok(await restored());
    assert.equal(observed.sends.length, 2);
    const previous = observed.streams.findLast((stream) => !stream.closed);
    assert.ok(previous);
    const privateDraft = 'synthetic owner-only draft';
    await browser.evaluate(`(() => {
      const box = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(privateDraft)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await eventually(() => browser.evaluate('Object.values(localStorage).some(v => v.includes(' + JSON.stringify(privateDraft) + '))'), 10000, 'owner draft persisted');
    const epoch = await browser.evaluate('performance.timeOrigin');
    observed.pausePair = true;
    const changed = pair(host, base, await secondTab(browser), 'reader', false);
    changed.catch(() => {});
    await eventually(() => observed.cutPair, 12000, 'new cookie headers before receipt');
    try {
      await eventually(() => previous.closed && browser.evaluate("!document.querySelector('.composer-box')"), 10000, 'previous UI and stream frozen before the receipt');
      assert.ok(await browser.evaluate("Boolean(localStorage.getItem('baton.pairing.lock'))"));
    } finally { observed.cutPair(); }
    await changed;
    await eventually(() => previous.closed && browser.evaluate('performance.timeOrigin !== ' + epoch), 12000, 'previous stream abandoned and page reloaded');
    await eventually(() => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'), 12000, 'reauthorized history');
    assert.equal(await browser.evaluate("fetch('/api/health').then(r => r.json()).then(h => h.principal.id)"), 'reader');
    assert.equal(await browser.evaluate("document.querySelector('textarea')?.value"), '');
  });
});

test('a complete pairing response without its new cookie keeps the old owner screen locked', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('verified browser device', async (sub) => {
    const browser = await openBrowser(sub, host.root, false);
    await pair(host, base, browser, 'owner', false);
    await browser.navigate(base + '/session/' + encodeURIComponent(host.key));
    await eventually(() => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'));
    const readIdentity = () => browser.evaluate("fetch('/api/health').then(r => r.json()).then(h=>({id:h.principal.id, device:h.deviceId}))");
    const before = await readIdentity();
    assert.equal(before.id, 'owner');
    const other = await secondTab(browser);
    observed.stripCookie = true;
    await submitPair(host, base, other, 'reader', false);
    await eventually(() => observed.strippedReceipt?.ok === true, 10000, 'complete 200 body relayed');
    await eventually(() => other.evaluate("/Pairing could not be verified|尚未确认配对结果/.test(document.body.innerText)"), 12000, 'pairing correctly remains unverified');
    assert.notEqual(observed.strippedReceipt.deviceId, before.device);
    assert.deepEqual(await readIdentity(), before);
    await browser.command('Page.reload');
    await eventually(() => browser.evaluate("localStorage.getItem('baton.pairing.lock') === 'pairing' && !document.querySelector('.composer-box')"));
    assert.equal(observed.sends.length, 0);
  });
});

test('browsers without Web Locks permit only one simultaneous pairing request across tabs', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('IndexedDB pairs a single tab and rejects concurrent redemption', async (sub) => {
    const browser = await openBrowser(sub, host.root, false);
    await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'locks', {value: undefined})" });
    await pair(host, base, browser, 'owner', false);
    assert.equal(await browser.evaluate('!!navigator.locks'), false);
    observed.pausePair = true;
    const first = await secondTab(browser, true);
    const completion = pair(host, base, first, 'reader', false);
    completion.catch(() => {});
    await eventually(() => observed.cutPair, 10000, 'first exchange waiting for its response');
    const count = observed.pairPosts;
    try {
      const other = await secondTab(browser, true);
      await submitPair(host, base, other, 'owner', false);
      await eventually(() => other.evaluate("/unfinished pairing request|另一个标签页的配对请求/.test(document.body.innerText)"), 10000, 'other tab safely defers')
        .catch(async (error) => { throw new Error(`${error.message}; posts ${observed.pairPosts - count}, ${await other.evaluate("JSON.stringify({page:location.pathname, coordinator:!!navigator.locks, alert:document.querySelector('[role=alert]')?.textContent})")}`); });
      assert.equal(observed.pairPosts, count);
    } finally { observed.cutPair(); }
    await completion;
    assert.equal(await first.evaluate("fetch('/api/health').then(r=>r.json()).then(h=>h.principal.id)"), 'reader');
  });
});

test('closing the pairing tab without Web Locks lets a new page verify the cookie and recover', { timeout: 90000 }, async (t) => {
  for (const stripCookie of [false, true]) {
    const host = await startHost(t);
    const { base, observed } = await startRelay(t, host);
    await t.test(stripCookie ? 'former device stays locked until a fresh pairing' : 'new device recovers without another code', async (sub) => {
      const browser = await openBrowser(sub, host.root, false);
      const holder = await secondTab(browser, true);
      await pair(host, base, holder, 'owner', false);
      const identity = "fetch('/api/health').then(r => r.json()).then(h => ({id: h.principal.id, device: h.deviceId}))";
      const before = await holder.evaluate(identity);
      assert.equal(before.id, 'owner');
      observed.pausePair = true;
      observed.stripCookie = stripCookie;
      await submitPair(host, base, holder, 'reader', false);
      await eventually(() => observed.cutPair, 10000, 'pairing response held open');
      await holder.close();
      observed.cutPair();
      observed.pausePair = false;
      observed.stripCookie = false;

      const previousChecks = observed.healthChecks;
      const fresh = await secondTab(browser, true);
      await fresh.navigate(base + '/session/' + encodeURIComponent(host.key));
      await eventually(() => observed.healthChecks > previousChecks, 10000, 'new page checks the interrupted pairing');
      if (stripCookie) {
        await eventually(() => fresh.evaluate("!!document.querySelector('.door-welcome a.cta')"));
        assert.deepEqual(await fresh.evaluate(identity), before);
        assert.equal(await fresh.evaluate("localStorage.getItem('baton.pairing.lock')"), 'pairing');
        assert.equal(await fresh.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'), false);
        const url = base + '/pair?c=' + encodeURIComponent(await host.codeFor('reader'));
        // Full Chrome can freeze this document for the back/forward cache.
        // Observe any lock request it starts while leaving for the pairing form.
        await fresh.evaluate(`(() => {
          const remove = indexedDB.deleteDatabase.bind(indexedDB);
          indexedDB.deleteDatabase = (name) => {
            if (name === 'baton-pairing' && document.hidden) sessionStorage.setItem('hiddenPairingRequest', '1');
            return remove(name);
          };
        })()`);
        // Hold the real response only in the new pairing document. The page's
        // automatic recovery is then still active when the user submits a code.
        await fresh.onNewDocument(`if (location.pathname === '/pair') {
          const original = window.fetch;
          window.fetch = async (...args) => {
            const response = await original(...args);
            if (new URL(response.url).pathname === '/api/health' && !window.releaseRecovery) {
              await new Promise(resolve => { window.releaseRecovery = resolve; });
            }
            return response;
          };
        }`);
        await fresh.navigate(url);
        await eventually(() => fresh.evaluate("location.pathname === '/pair' && !!document.querySelector('.door-pair')"));
        assert.equal(await fresh.evaluate("sessionStorage.getItem('hiddenPairingRequest')"), null, 'departing document started a pairing lock');
        await eventually(() => fresh.evaluate("typeof window.releaseRecovery === 'function'"), 10000, 'pair page verifying the former device');
        try { await clickPair(fresh, url); } finally { await fresh.evaluate('window.releaseRecovery()'); }
        await eventually(() => fresh.evaluate("location.pathname === '/'"), 10000, 'new pairing after the same page finishes verification')
          .catch(async (err) => { throw new Error(`${err.message}; submissions ${observed.pairPosts}, ${await fresh.evaluate("document.querySelector('[role=alert]')?.textContent ?? ''")}`, { cause: err }); });
        await fresh.navigate(base + '/session/' + encodeURIComponent(host.key));
      }
      await eventually(() => fresh.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'), 12000, 'verified reader history');
      const after = await fresh.evaluate(identity);
      assert.equal(after.id, 'reader');
      assert.notEqual(after.device, before.device);
      assert.equal(await fresh.evaluate("localStorage.getItem('baton.pairing.lock')"), null);
      assert.equal(observed.pairPosts, stripCookie ? 3 : 2);
    });
  }
});

test('a live legacy IndexedDB pairing excludes new tabs until its page closes', { timeout: 40000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('two deferred requests leave the next pairing intact', async (sub) => {
    const browser = await openBrowser(sub, host.root, false);
    const legacy = await secondTab(browser, true);
    await legacy.navigate(base + '/__test_blank');
    await eventually(() => legacy.evaluate("document.title === 'Test observer'"));
    // The shipped v1 client keeps this database connection while waiting for HTTP.
    await legacy.evaluate(`new Promise((resolve, reject) => {
      const open = indexedDB.open('baton-pairing', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('operations');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        window.legacyPairing = open.result;
        const tx = window.legacyPairing.transaction('operations', 'readwrite');
        tx.objectStore('operations').add(true, 'pairing');
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => reject(tx.error);
      };
    })`);
    const first = await secondTab(browser, true);
    const second = await secondTab(browser, true);
    const busy = "/unfinished pairing request|另一个标签页的配对请求/.test(document.body.innerText)";
    for (const tab of [first, second]) {
      await submitPair(host, base, tab, 'owner', false);
      await eventually(() => tab.evaluate(busy), 10000, 'live legacy holder excludes this request');
    }
    assert.equal(observed.pairPosts ?? 0, 0);
    await legacy.close();
    await pair(host, base, second, 'reader', false);
    assert.equal(await second.evaluate("fetch('/api/health').then(r => r.json()).then(h => h.principal.id)"), 'reader');
    assert.equal(observed.pairPosts, 1);
  });
});

test('an explicitly rejected pairing code cannot unlock a former device when its health recovers', { timeout: 40000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('old owner stays locked after focus', async (sub) => {
    const browser = await openBrowser(sub, host.root, false);
    await pair(host, base, browser, 'owner', false);
    const code = await host.codeFor('reader');
    assert.equal((await host.request('/api/pair', { bearer: null, body: { code } })).status, 200);
    const tab = await secondTab(browser);
    await tab.navigate(base + '/pair?c=' + encodeURIComponent(code));
    await eventually(() => tab.evaluate("!!document.querySelector('.door-pair button[type=submit]:enabled')"), 12000, 'consumed code ready to submit');
    observed.hideOldIdentity = true;
    await tab.evaluate("document.querySelector('.door-pair button[type=submit]').click()");
    await eventually(() => tab.evaluate("localStorage.getItem('baton.pairing.lock') === 'locked'"), 10000, 'pair rejection locked');
    assert.equal(await tab.evaluate("fetch('/api/health').then(r => r.json()).then(r => r.principal.id)"), 'owner');
    await tab.evaluate("window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'))");
    assert.equal(await tab.evaluate("localStorage.getItem('baton.pairing.before')"), null);
    assert.equal(await tab.evaluate("localStorage.getItem('baton.pairing.lock')"), 'locked');
  });
});

test('a closed, locally locked PWA receives only generic notices while its former HttpOnly cookie is still valid', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  const { base, observed } = await startRelay(t, host);
  await t.test('production service worker', async (sub) => {
    const browser = await openBrowser(sub, host.root, true);
    await browser.command('Browser.grantPermissions', { origin: base, permissions: ['notifications'] });
    let registration;
    let workerVersion;
    const notices = [];
    browser.onProtocol('Runtime.bindingCalled', ({ name, payload }) => {
      if (name === '__batonObserveNotice') notices.push(JSON.parse(payload));
    });
    browser.onProtocol('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      registration = registrations.find((r) => r.scopeURL === base + '/' && !r.isDeleted) ?? registration;
    });
    browser.onProtocol('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      workerVersion = versions.find((v) => v.scriptURL === base + '/sw.js') ?? workerVersion;
    });
    await browser.command('ServiceWorker.enable');
    await pair(host, base, browser, 'reader', true);
    const workerState = () => browser.evaluate(`(async () => ({
      page: location.pathname, active: (await navigator.serviceWorker.getRegistration('/'))?.active?.state,
      granted: Boolean(await caches.match('/.baton/push-access'))
    }))()`);
    await eventually(async () => {
      const state = await workerState();
      return registration && state.active === 'activated' && state.granted;
    }, 25000, 'active worker and verified grant').catch(async (err) => {
      throw new Error(`${err.message}; registration: ${Boolean(registration)}, ${JSON.stringify(await workerState())}`, { cause: err });
    });
    const active = await observeWorker(browser, base);
    const push = () => browser.command('ServiceWorker.deliverPushMessage', { origin: base, registrationId: registration.registrationId, data: '' });
    await push();
    await eventually(() => notices.some((n) => n.title === 'Private fixture notification' && n.data.key === host.key), 12000, 'unlocked private notification');
    assert.ok(observed.latest > 0);
    await browser.navigate(base + '/about');
    observed.offlineUnpair = true;
    await eventually(() => browser.evaluate(`(() => {
      let confirmed = false; window.confirm = () => { confirmed = true; return true; };
      const b = [...document.querySelectorAll('[role=button],button')].find((el) => ['Unpair','解除配对'].includes(el.textContent.trim()));
      if (!b) return false; b.click(); return confirmed;
    })()`), 12000, 'unpair control');
    await eventually(() => browser.evaluate("localStorage.getItem('baton.pairing.lock') === 'pending'"), 10000, 'offline local lock');
    await browser.navigate('about:blank');
    assert.equal(await browser.hasHttpOnlySession(base), true);
    await browser.command('Target.detachFromTarget', { sessionId: active.sessionId });
    await browser.command('ServiceWorker.stopWorker', { versionId: workerVersion.versionId });
    await eventually(async () => !(await browser.command('Target.getTargets')).targetInfos.some((v) => v.targetId === active.targetId), 12000, 'previous service worker stopped');
    await browser.command('ServiceWorker.startWorker', { scopeURL: base + '/' });
    const restarted = await observeWorker(browser, base);
    const before = observed.latest;
    const reported = notices.length;
    await push();
    await eventually(() => notices.length > reported, 12000, 'closed app generic notification');
    assert.equal(notices[reported].title, 'Baton');
    assert.ok(!notices[reported].body.includes(host.key));
    assert.deepEqual(notices[reported].data, {});
    assert.equal(observed.latest, before);
    const renewals = observed.renewals;
    const result = await browser.command('Runtime.evaluate', { expression: `(async () => {
      let settled; const event = new Event('pushsubscriptionchange');
      event.waitUntil = promise => { settled = promise; }; self.dispatchEvent(event);
      if (!settled) return false; await settled; return true;
    })()`, awaitPromise: true, returnByValue: true }, restarted.sessionId);
    assert.equal(result.result.value, true);
    assert.equal(observed.renewals, renewals);
    await browser.navigate(base + '/__test_blank');
    assert.equal(await browser.evaluate("fetch('/api/health').then(r => r.json()).then(h => h.principal.id)"), 'reader');
  });
});
