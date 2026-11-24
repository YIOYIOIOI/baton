import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, project, startHost } from './host.mjs';
import { openBrowser } from './chromium.mjs';

function writeRecorderScript(file, logFile) {
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));`,
    '',
  ].join('\n'));
}

test('local owner dashboard opens session terminal while guest and proxied clients are blocked', { timeout: 90000 }, async (t) => {
  assert.ok(fs.existsSync(path.join(project, 'web', 'dist', 'index.html')), 'Build web/dist before running this test.');

  let logFile = '';
  const host = await startHost(t, {
    extraEnv: process.platform === 'linux' ? { DISPLAY: ':99' } : null,
    setupBin({ bin, root }) {
      logFile = path.join(root, 'terminal-launch.json');
      const recorder = path.join(root, 'record-terminal.mjs');
      writeRecorderScript(recorder, logFile);
      if (process.platform === 'win32') {
        fs.writeFileSync(
          path.join(bin, 'claude.cmd'),
          `@echo off\r\n@"${process.execPath}" "${recorder}" %*\r\n`,
        );
      } else if (process.platform === 'darwin') {
        fs.writeFileSync(
          path.join(bin, 'osascript'),
          `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
          { mode: 0o755 },
        );
      } else {
        fs.writeFileSync(
          path.join(bin, 'ghostty'),
          `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
          { mode: 0o755 },
        );
      }
    },
  });

  // 1. Proxied / tunnelled requests to localhost are denied by backend even with owner token.
  const proxiedHealth = await (await host.request('/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.42' },
  })).json();
  assert.equal(proxiedHealth.isLocal, false);
  assert.equal(proxiedHealth.canOpenTerminal, false);

  const proxiedOpen = await host.request(`/api/sessions/${encodeURIComponent(host.key)}/terminal`, {
    headers: { 'cf-connecting-ip': '203.0.113.42' },
    body: {},
  });
  assert.equal(proxiedOpen.status, 403);
  assert.equal((await proxiedOpen.json()).error.code, 'local_only');

  // 2. Guest paired in local desktop browser does NOT see the terminal button and cannot invoke the endpoint.
  await t.test('guest hides local terminal button', { timeout: 35000 }, async (subtest) => {
    const browser = await openBrowser(subtest, host.root, false);
    const code = await host.codeFor('reader');
    await browser.navigate(`${host.base}/pair?c=${encodeURIComponent(code)}`);
    await eventually(() => browser.evaluate(`(() => {
      const btn = document.querySelector('button[type=submit]');
      if (!btn || btn.disabled) return false;
      btn.click(); return true;
    })()`), 12000, 'guest pairing submit');
    await eventually(() => browser.hasHttpOnlySession(host.base), 15000, 'guest session cookie');
    await eventually(() => browser.evaluate("location.pathname !== '/pair'"), 10000, 'guest home');
    await browser.navigate(`${host.base}/session/${encodeURIComponent(host.key)}`);
    await eventually(
      () => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(host.greeting)})`),
      15000,
      'guest rendered session',
    );
    assert.equal(await browser.evaluate("Boolean(document.querySelector('.conv-term'))"), false);
    const denied = await browser.evaluate(`fetch(${JSON.stringify(`/api/sessions/${encodeURIComponent(host.key)}/terminal`)}, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(async (r) => ({ status: r.status, code: (await r.json()).error?.code }))`);
    assert.deepEqual(denied, { status: 403, code: 'owner_only' });
  });

  // 3. Owner configures Baton permission/model/effort, opens local dashboard, clicks button, and verifies CLI flags.
  await t.test('owner clicks local terminal button and launches session resume with Baton settings', { timeout: 35000 }, async (subtest) => {
    assert.equal((await host.request('/api/permission', { body: { agent: 'claude', mode: 'bypass' } })).status, 200);
    assert.equal((await host.request(`/api/sessions/${encodeURIComponent(host.key)}/model`, { body: { model: 'claude-sonnet-4-6' } })).status, 200);
    assert.equal((await host.request(`/api/sessions/${encodeURIComponent(host.key)}/effort`, { body: { effort: 'high' } })).status, 200);

    const browser = await openBrowser(subtest, host.root, false);
    const code = await host.codeFor('owner');
    await browser.navigate(`${host.base}/pair?c=${encodeURIComponent(code)}`);
    await eventually(() => browser.evaluate(`(() => {
      const btn = document.querySelector('button[type=submit]');
      if (!btn || btn.disabled) return false;
      btn.click(); return true;
    })()`), 12000, 'owner pairing submit');
    await eventually(() => browser.hasHttpOnlySession(host.base), 15000, 'owner session cookie');
    await eventually(() => browser.evaluate("location.pathname !== '/pair'"), 10000, 'owner home');
    await browser.navigate(`${host.base}/session/${encodeURIComponent(host.key)}`);
    await eventually(
      () => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(host.greeting)})`),
      15000,
      'owner rendered session',
    );
    await eventually(
      () => browser.evaluate("Boolean(document.querySelector('.conv-term'))"),
      10000,
      'local terminal button visible',
    );
    const clicked = await browser.evaluate(`(() => {
      const btn = document.querySelector('.conv-term');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    assert.equal(clicked, true);

    await eventually(() => fs.existsSync(logFile), 15000, 'terminal launch marker file');
    const recorded = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const expectedFlags = [
      '--resume', host.sessionId,
      '--model', 'claude-sonnet-4-6',
      '--dangerously-skip-permissions',
      '--effort', 'high',
    ];
    if (process.platform === 'win32') {
      assert.equal(fs.realpathSync.native(recorded.cwd).toLowerCase(), fs.realpathSync.native(host.cwd).toLowerCase());
      assert.deepEqual(recorded.argv, expectedFlags);
    } else if (process.platform === 'darwin') {
      const cmd = recorded.argv.at(-1);
      for (const flag of expectedFlags) {
        assert.ok(cmd.includes(flag), `expected ${flag} in osascript payload: ${cmd}`);
      }
    } else {
      assert.equal(fs.realpathSync.native(recorded.cwd), fs.realpathSync.native(host.cwd));
      for (const flag of expectedFlags) {
        assert.ok(recorded.argv.includes(flag), `expected ${flag} in linux terminal argv: ${JSON.stringify(recorded.argv)}`);
      }
    }

    await eventually(
      () => browser.evaluate("Boolean(document.querySelector('.toast'))"),
      10000,
      'terminal opened toast',
    );

    const auditPath = path.join(host.state, 'audit.log');
    await eventually(() => {
      if (!fs.existsSync(auditPath)) return false;
      const raw = fs.readFileSync(auditPath, 'utf8');
      return raw.includes('"open_terminal"')
        && raw.includes('"permissionMode":"bypass"')
        && raw.includes('"model":"claude-sonnet-4-6"')
        && raw.includes('"effort":"high"');
    }, 5000, 'open_terminal audit record with settings');
  });
});
