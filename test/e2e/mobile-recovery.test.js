import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, startHost } from './host.mjs';
import { openBrowser } from './chromium.mjs';

async function openPairedMobileBrowser(t, host) {
  const browser = await openBrowser(t, host.root, true);
  await browser.navigate(host.base + '/pair?c=' + encodeURIComponent(await host.codeFor('owner')));
  await eventually(() => browser.hasHttpOnlySession(host.base));
  await eventually(() => browser.evaluate("location.pathname === '/'"));
  return browser;
}

async function openMobileSession(t, host) {
  const browser = await openPairedMobileBrowser(t, host);
  // A full navigation starts the PWA on the session route with only its persisted identity.
  await browser.navigate(host.base + '/session/' + encodeURIComponent(host.key));
  await eventually(() => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')'));
  return browser;
}

test('mobile PWA restores the original send after reload and requires a new decision for expired requests', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  await t.test('production mobile composer and retry controls', async (sub) => {
    const browser = await openMobileSession(sub, host);
    const sends = [];
    let dropNext = true;
    let networkError;
    const intercept = async (event) => {
      sends.push({ ...JSON.parse(event.request.postData), status: event.responseStatusCode });
      if (event.responseStatusCode === 202 && dropNext) {
        dropNext = false;
        // The real daemon has accepted the turn. Deliver only the start of its JSON receipt.
        await browser.command('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 202,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'x-baton', value: '1' }],
          body: Buffer.from('{').toString('base64') });
      } else await browser.command('Fetch.continueRequest', { requestId: event.requestId });
    };
    browser.onProtocol('Fetch.requestPaused', (event) => { void intercept(event).catch((e) => { networkError = e; }); });
    await browser.command('Fetch.enable', { patterns: [{ urlPattern: host.base + '/api/sessions/*/send', requestStage: 'Response' }] });
    const text = (value) => browser.evaluate(`(() => {
      const field = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    const send = () => browser.evaluate(`(() => {
      const b = document.querySelector('[aria-label="发送"]');
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      b.click(); return true;
    })()`);
    const action = (labels, click) => browser.evaluate(`(() => {
      const b = [...document.querySelectorAll('[role=button],button')].find(e => ${JSON.stringify(labels)}.includes(e.textContent.trim()));
      if (${click} && b) b.click(); return !!b;
    })()`);
    const scopeKey = "Object.keys(localStorage).find(k => k.includes('.send.mobile.'))";
    const message = 'fixture mobile response lost after execution';
    await text(message);
    await eventually(send, 10000, 'send through mobile composer');
    await eventually(() => sends.length === 1 && action(['Retry', '重试'], false), 10000, 'accepted send lost its acknowledgement');
    await browser.command('Page.reload');
    await eventually(() => action(['Retry', '重试'], true), 12000, 'retry original operation from restarted PWA');
    await eventually(() => sends.length === 2 && browser.evaluate('!(' + scopeKey + ')'), 12000, 'confirmed operation removed');
    assert.equal(networkError, undefined);
    assert.equal(sends[0].status, 202);
    assert.deepEqual(sends[0], sends[1]);
    await eventually(() => fs.readFileSync(host.transcript, 'utf8').includes(message));
    const records = fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.filter((entry) => entry.message?.content === message).length, 1);

    dropNext = true;
    const oldMessage = 'fixture old request';
    await text(oldMessage);
    await eventually(send);
    await eventually(() => sends.length === 3 && action(['Retry', '重试'], false));
    await browser.evaluate(`(() => { const k = ${scopeKey}; const r = JSON.parse(localStorage.getItem(k));
      r.startedAt = Date.now() - 86401000; localStorage.setItem(k, JSON.stringify(r)); })()`);
    await browser.command('Page.reload');
    await eventually(() => browser.evaluate("/no longer be retried safely|已无法安全重试/.test(document.body.innerText)"), 12000, 'expired operation retained');
    assert.equal(await action(['Retry', '重试'], false), false);
    await text(oldMessage);
    await eventually(send);
    assert.equal(sends.length, 3);
    await eventually(() => action(['Dismiss', '移除'], true));
    await eventually(() => browser.evaluate('!(' + scopeKey + ')'));
    await eventually(send);
    await eventually(() => sends.length === 4 && browser.evaluate('!(' + scopeKey + ')'));
    assert.notEqual(sends[2].requestId, sends[3].requestId);
    assert.equal(networkError, undefined);
  });
});

test('fast acceptance cannot revive the submitted draft or erase new typing after a storage failure', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  await t.test('PWA acknowledgement before the draft debounce', async (sub) => {
    const browser = await openMobileSession(sub, host);
    const ready = () => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(host.greeting) + ')');
    const typeText = (v) => browser.evaluate(`(() => {
      const box=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify(v)});
      box.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    const send = () => browser.evaluate(`(() => { const b=document.querySelector('[aria-label="发送"]');
      if(!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false; b.click(); return true; })()`);
    const retry = () => browser.evaluate(`(() => { const b=[...document.querySelectorAll('[role=button],button')].find(el => ['Retry','重试'].includes(el.textContent.trim()));
      if(!b) return false; b.click(); return true; })()`);
    const stored = () => browser.evaluate('JSON.parse(localStorage.getItem(localStorage.getItem("baton.drafts.active")) || "{}")[' + JSON.stringify(host.key) + '] ?? null');
    const pendingId = () => browser.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.includes('.send.mobile.'))) || 'null')?.id || null");
    const install = () => browser.evaluate(`(() => {
      const owner=localStorage.getItem('baton.drafts.active'); const set=Storage.prototype.setItem, del=Storage.prototype.removeItem;
      // Hold the ordinary 400 ms keystroke debounce until after the simulated reload.
      const timeout=window.setTimeout; window.setTimeout=(fn, ms, ...a)=>timeout(fn, ms === 400 ? 60000 : ms, ...a);
      Storage.prototype.setItem=function(k,v){ if(this===localStorage && k===owner && window.failFixtureDraft) throw new DOMException('Fixture storage failure'); return set.call(this,k,v); };
      Storage.prototype.removeItem=function(k){const result=del.call(this,k); if(this===localStorage && k.includes('.send.mobile.') && window.reloadOnFixtureAck){
        sessionStorage.setItem('fixture-ack', window.reloadOnFixtureAck); location.reload(); } return result;};
    })()`);
    const completedReload = async (tag) => {
      await eventually(() => browser.evaluate('sessionStorage.getItem("fixture-ack") === ' + JSON.stringify(tag) + ' && !window.reloadOnFixtureAck'), 12000, 'reload immediately on acknowledgement');
      await eventually(ready);
    };
    const sends=[];
    let pause=false, held, failure;
    browser.onProtocol('Fetch.requestPaused', (event) => {
      sends.push({ id: JSON.parse(event.request.postData).requestId, status: event.responseStatusCode });
      const resume=()=>browser.command('Fetch.continueRequest',{requestId:event.requestId});
      if(pause){ pause=false; held=resume; } else void resume().catch((e)=>{failure=e;});
    });
    await browser.command('Fetch.enable', {patterns:[{urlPattern:host.base + '/api/sessions/*/send',requestStage:'Response'}]});
    const first='fixture already saved draft';
    await typeText(first);
    await eventually(async () => await stored() === first);
    await install();
    await browser.evaluate("window.reloadOnFixtureAck='fast'");
    await eventually(send);
    await completedReload('fast');
    assert.equal(await stored(), null);
    assert.equal(await browser.evaluate("document.querySelector('textarea').value"), '');

    const second='fixture new text traces the same characters as the submitted message';
    await typeText(second);
    await eventually(async () => await stored() === second);
    await install();
    await browser.evaluate('window.failFixtureDraft=true');
    await eventually(send);
    const firstId=await eventually(pendingId);
    await eventually(() => browser.evaluate("/Could not save|无法保存/.test(document.body.innerText)"));
    assert.equal(sends.length, 1, 'disk failure prevented the second POST');
    assert.equal(await stored(), second);
    await browser.evaluate('window.failFixtureDraft=false');
    pause=true;
    await eventually(retry);
    await eventually(() => held, 10000, 'valid server acceptance held by fixture');
    assert.equal(await stored(), null);
    await typeText(second);
    await browser.evaluate('window.failFixtureDraft=true');
    await held();
    await eventually(() => browser.evaluate("/Could not save|无法保存/.test(document.body.innerText)"));
    assert.equal(await pendingId(), firstId, 'the accepted ID survived the failed write of newer input');
    await browser.evaluate("window.failFixtureDraft=false; window.reloadOnFixtureAck='new-draft'");
    await eventually(retry);
    await completedReload('new-draft');
    assert.equal(await stored(), second);
    assert.equal(await browser.evaluate("document.querySelector('textarea').value"), second);
    assert.equal(await pendingId(), null);
    assert.deepEqual(sends.slice(1), [{id:firstId,status:202},{id:firstId,status:202}]);
    assert.equal(failure, undefined);
  });
});

test('mobile PWA recovers cold-start access and retries only the previously submitted files', { timeout: 90000 }, async (t) => {
  const host = await startHost(t);
  await t.test('real file input and attachment chips after a draft write failure', async (sub) => {
    const browser = await openPairedMobileBrowser(sub, host);
    const api = '/api/sessions/' + encodeURIComponent(host.key);
    const uploadRequests = [];
    const sendRequests = [];
    const uploads = [];
    const sends = [];
    let receivedState = false;
    browser.onProtocol('Network.requestWillBeSent', ({ request }) => {
      const url = new URL(request.url);
      if (url.origin !== host.base) return;
      if (url.pathname === api + '/upload') uploadRequests.push(url.searchParams.get('name'));
      if (url.pathname === api + '/send') sendRequests.push(request.method);
    });
    browser.onProtocol('Network.responseReceived', ({ response }) => {
      const url = new URL(response.url);
      if (url.origin !== host.base) return;
      if (url.pathname === api + '/state' && response.status === 200) receivedState = true;
      if (url.pathname === api + '/upload') uploads.push([url.searchParams.get('name'), response.status]);
      if (url.pathname === api + '/send') sends.push(response.status);
    });
    const hasChip = (name) => browser.evaluate('!!document.querySelector(' + JSON.stringify('[aria-label="不带上 ' + name + '"]') + ')');
    const upload = async (name) => {
      const fixture = path.join(host.cwd, name);
      fs.writeFileSync(fixture, 'fixture ' + name);
      const { root } = await browser.command('DOM.getDocument');
      const { nodeId } = await browser.command('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
      assert.ok(nodeId, 'the PWA exposes its native browser file input');
      await browser.command('DOM.setFileInputFiles', { nodeId, files: [fixture] });
      await eventually(() => uploads.some(([file, status]) => file === name && status === 201), 12000, 'stored upload ' + name);
      await eventually(() => hasChip(name), 12000, 'attachment chip for ' + name);
    };

    let offline = true;
    let failedHealth = 0;
    let heldHealth = 0;
    let interceptionError;
    const stopCounting = browser.onProtocol('Fetch.requestPaused', ({ requestId }) => {
      if (offline) {
        void browser.command('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' })
          .then(() => { failedHealth++; }, (error) => { interceptionError = error; });
      } else heldHealth++;
    });
    await browser.command('Fetch.enable', { patterns: [{ urlPattern: host.base + '/api/health*', requestStage: 'Request' }] });
    let documentStart;
    try {
      await browser.navigate(host.base + '/session/' + encodeURIComponent(host.key));
      await eventually(() => failedHealth > 0 && receivedState && browser.evaluate('document.body.innerText.includes('
        + JSON.stringify(host.greeting) + ') && !!document.querySelector("input[type=file]")'),
        12000, 'live session rendered despite failed cold-start health');
      documentStart = await browser.evaluate('performance.timeOrigin');
      offline = false;
      await browser.evaluate("window.dispatchEvent(new Event('online'))");
      await eventually(() => heldHealth > 0, 8000, 'same open session rechecked health after coming online');
      await browser.evaluate(`(() => {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('online'));
        document.querySelector('textarea').focus();
        const input = document.querySelector('input[type=file]');
        const data = new DataTransfer();
        data.items.add(new File(['fixture'], 'before-identity.txt', { type: 'text/plain' }));
        input.files = data.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      await browser.command('Input.insertText', { text: 'before identity' });
      await browser.evaluate("document.querySelector('[aria-label=\"发送\"]').click()");
      assert.equal(await browser.evaluate("document.querySelector('textarea').readOnly"), true);
      assert.equal(await browser.evaluate("document.querySelector('textarea').value"), '');
      assert.equal(await browser.evaluate("document.querySelector('input[type=file]').disabled"), true);
      assert.equal(heldHealth, 1, 'concurrent recovery signals must share one health request');
      assert.deepEqual(sendRequests, [], 'the composer must stay disabled until verified');
      assert.deepEqual(uploadRequests, [], 'an early file selection must never start an upload');
    } finally {
      await browser.command('Fetch.disable');
      stopCounting();
    }
    await eventually(() => browser.evaluate("document.querySelector('input[type=file]')?.disabled === false"), 12000, 'file input enabled after health');
    assert.equal(await browser.evaluate('performance.timeOrigin'), documentStart, 'recovery must keep the original page');
    assert.equal(interceptionError, undefined);

    const original = 'original-fixture.txt';
    const newer = 'next-draft-fixture.txt';
    const message = 'fixture message with its original attachment';
    await browser.evaluate("document.querySelector('textarea').focus()");
    await browser.command('Input.insertText', { text: message });
    await eventually(() => browser.evaluate('JSON.parse(localStorage.getItem(localStorage.getItem("baton.drafts.active")) || "{}")['
      + JSON.stringify(host.key) + '] === ' + JSON.stringify(message)), 12000, 'persisted original draft');
    await upload(original);
    await browser.evaluate(`(() => {
      const scope = localStorage.getItem('baton.drafts.active');
      const set = Storage.prototype.setItem;
      window.failDraftWrite = true;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === scope && window.failDraftWrite) throw new DOMException('Fixture storage failure');
        return set.call(this, key, value);
      };
      document.querySelector('[aria-label="发送"]').click();
    })()`);
    await eventually(() => browser.evaluate('/Could not save|无法保存/.test(document.body.innerText)'), 12000, 'failed draft write');
    assert.deepEqual(sends, []);
    await upload(newer);
    assert.equal(await hasChip(original), true);
    await browser.evaluate(`(() => {
      window.failDraftWrite = false;
      [...document.querySelectorAll('[role=button],button')].find(el => ['Retry', '重试'].includes(el.textContent.trim())).click();
    })()`);
    await eventually(async () => sends.length && !(await hasChip(original)), 12000, 'accepted retry removed the original attachment');
    assert.equal(await hasChip(newer), true, 'the next draft keeps its own file');
    assert.deepEqual(uploadRequests, [original, newer]);
    assert.deepEqual(uploads, [[original, 201], [newer, 201]]);
    assert.deepEqual(sendRequests, ['POST']);
    assert.deepEqual(sends, [202]);
    await eventually(() => fs.readFileSync(host.transcript, 'utf8').includes(message), 12000, 'submitted turn in transcript');
    const records = fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const submitted = records.filter((entry) => entry.type === 'user' && entry.message.content.includes(message));
    assert.equal(submitted.length, 1);
    assert.ok(submitted[0].message.content.includes('.baton-uploads/' + original));
    assert.ok(!submitted[0].message.content.includes(newer));
  });
});
