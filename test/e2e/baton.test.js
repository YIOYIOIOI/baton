import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { eventually, project, startHost } from './host.mjs';
import { openBrowser } from './chromium.mjs';

function reply(host, text) {
  return JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), sessionId: host.sessionId,
    timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

test('revoking a device during a JSON transfer prevents the pending write', { timeout: 25000 }, async (t) => {
  const host = await startHost(t);
  const paired = await host.request('/api/pair', { bearer: null, body: { code: await host.codeFor('owner'), want: 'bearer' } });
  assert.equal(paired.status, 200);
  const { bearer } = await paired.json();
  const device = await (await host.request('/api/health', { bearer })).json();
  assert.ok(device.deviceId);
  const body = JSON.stringify({ message: 'This pending request was revoked' });
  const req = http.request(host.base + '/api/sessions/' + encodeURIComponent(host.key) + '/send', { method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), expect: '100-continue' } });
  t.after(() => req.destroy());
  const response = once(req, 'response');
  const reading = once(req, 'continue');
  req.flushHeaders();
  await reading;
  const revoke = await host.request('/api/devices/revoke', { body: { deviceId: device.deviceId } });
  assert.equal(revoke.status, 200);
  req.end(body);
  const [denied] = await response;
  denied.resume();
  assert.equal(denied.statusCode, 401);
  assert.ok(!fs.readFileSync(host.transcript, 'utf8').includes('This pending request was revoked'));
});

test('CLI daemon, device authorization, process execution, and SSE replay', { timeout: 60000 }, async (t) => {
  const host = await startHost(t);
  const route = '/api/sessions/' + encodeURIComponent(host.key);
  const paired = await host.request('/api/pair', { bearer: null, body: { code: await host.codeFor('reader'), want: 'bearer' } });
  assert.equal(paired.status, 200);
  const { bearer } = await paired.json();
  assert.ok(bearer);
  assert.equal((await host.request(route + '/model', { bearer, body: { model: 'default' } })).status, 403);
  const bytes = Buffer.from('测试附件\n', 'utf8');
  const upload = route + '/upload?name=attachment.txt';
  assert.equal((await host.request(upload, { bearer, body: bytes })).status, 403);
  const saved = await host.request(upload, { body: bytes });
  assert.equal(saved.status, 201);
  const attachment = await saved.json();
  const downloads = [route + '/upload?name=' + encodeURIComponent(attachment.name),
    route + '/file?path=' + encodeURIComponent(attachment.relative)];
  for (const url of downloads) {
    // The Windows file verifier has its own 10 s deadline. Let its HTTP response reach the test.
    const file = await host.request(url, { bearer, signal: AbortSignal.timeout(15000) });
    assert.equal(file.status, 200, `GET ${url.split('?')[0]} returned HTTP ${file.status}`);
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  }
  const page = await (await host.request(route + '/events', { bearer })).json();
  assert.equal(page.events[0].text, host.greeting);
  assert.equal(page.endOffset, fs.statSync(host.transcript).size);

  // Finish one record, then leave its successor only partly written when the client subscribes.
  const second = reply(host, 'second complete record');
  const first = reply(host, 'replay after snapshot') + '\n';
  fs.appendFileSync(host.transcript, first + second.slice(0, 12));
  const deadline = AbortSignal.timeout(8000);
  const stream = await host.request(route + '/stream?from=' + page.endOffset, { bearer, signal: deadline });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let data = '';
  async function nextOffsets() {
    for (;;) {
      let end;
      while ((end = data.indexOf('\n\n')) >= 0) {
        const frame = data.slice(0, end);
        data = data.slice(end + 2);
        if (!frame.includes('event: events')) continue;
        const body = JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6));
        return { id: Number(/^id: (\d+)/m.exec(frame)?.[1]), texts: body.events.map((e) => e.text) };
      }
      const chunk = await reader.read().catch((cause) => { throw new Error('Reading the SSE replay frame failed', { cause }); });
      assert.equal(chunk.done, false, 'SSE closed before the expected record');
      data += decoder.decode(chunk.value, { stream: true });
    }
  }
  try {
    assert.deepEqual(await nextOffsets(), { id: page.endOffset + Buffer.byteLength(first), texts: ['replay after snapshot'] });
    fs.appendFileSync(host.transcript, second.slice(12) + '\n');
    assert.deepEqual(await nextOffsets(), { id: fs.statSync(host.transcript).size, texts: ['second complete record'] });
  } finally {
    await reader.cancel();
  }

  // A real child process reads the sent message and writes a transcript on disk.
  const body = { message: 'Execute this fixture once', requestId: crypto.randomUUID() };
  const accepted = await host.request(route + '/send', { body });
  assert.equal(accepted.status, 202);
  const turn = await accepted.json();
  assert.ok(turn.turnId);
  await eventually(async () => (await (await host.request(route + '/state')).json()).latestTurn?.status === 'ok',
    15000, 'fixture runner completion');
  const retry = await host.request(route + '/send', { body });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).turnId, turn.turnId);
  const records = fs.readFileSync(host.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.filter((row) => row.message?.content === body.message).length, 1);
  const devices = await (await host.request('/api/devices', { bearer })).json();
  const device = devices.devices.find((d) => d.current);
  assert.ok(device);
  const health = await (await host.request('/api/health', { bearer })).json();
  assert.equal(health.deviceId, device.id);
  assert.equal((await host.request('/api/devices/revoke', { body: { deviceId: device.id } })).status, 200);
  assert.equal((await host.request(route + '/events', { bearer })).status, 401);
  assert.equal((await host.request(downloads[0], { bearer })).status, 401);
});

test('built desktop and mobile clients pair, load a session, and render a live reply', { timeout: 120000 }, async (t) => {
  for (const dir of ['web', 'app']) {
    assert.ok(fs.existsSync(path.join(project, dir, 'dist', 'index.html')), 'Build both web clients before running this test.');
  }
  const host = await startHost(t);
  for (const mobile of [false, true]) {
    await t.test(mobile ? 'mobile PWA' : 'desktop browser', { timeout: 50000 }, async (subtest) => {
      const browser = await openBrowser(subtest, host.root, mobile);
      const code = await host.codeFor('reader');
      await browser.navigate(host.base + '/pair?c=' + encodeURIComponent(code));
      if (!mobile) {
        await eventually(() => browser.evaluate(`(() => {
          const button = document.querySelector('button[type=submit]');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()`), 12000, 'desktop pairing form');
      }
      await eventually(() => browser.hasHttpOnlySession(host.base), 15000, 'paired browser cookie');
      // The pairing pages finish their own navigation before opening the session.
      await eventually(() => browser.evaluate("location.pathname !== '/pair'"), 10000, 'paired home page');
      await browser.navigate(host.base + '/session/' + encodeURIComponent(host.key));
      const contains = (text) => browser.evaluate('document.body.innerText.includes(' + JSON.stringify(text) + ')');
      await eventually(() => contains(host.greeting), 15000, 'rendered history');
      const assets = await browser.evaluate('Array.from(document.scripts, s => s.src)');
      assert.ok(assets.some((src) => src.includes(mobile ? '/_expo/' : '/assets/')), 'Expected the matching production bundle.');
      assert.equal(await browser.evaluate("localStorage.getItem('baton.token')"), null);
      assert.equal(await browser.evaluate("Object.values(localStorage).some(s => /d[12]\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{43}/.test(s))"), false);
      const text = mobile ? 'Live on the mobile browser' : 'Live on the desktop browser';
      fs.appendFileSync(host.transcript, reply(host, text) + '\n');
      await eventually(() => contains(text), 10000, 'rendered live message');
    });
  }
});
