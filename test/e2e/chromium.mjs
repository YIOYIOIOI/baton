import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { eventually } from './host.mjs';

function browserBinary() {
  const configured = process.env.BATON_E2E_BROWSER;
  const candidates = configured !== undefined ? [configured] : [
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const binary = candidates.find((p) => path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  if (!binary) throw new Error('Set BATON_E2E_BROWSER to the absolute path of a Chromium executable.');
  return binary;
}

// A fresh browser profile per client. The DevTools endpoint is local to this
// process and Chrome chooses the port; this test never attaches to an existing browser.
export async function openBrowser(t, root, mobile) {
  const profile = fs.mkdtempSync(path.join(root, 'browser-'));
  const child = spawn(browserBinary(), [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-breakpad', '--no-default-browser-check', '--no-first-run',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    // Chromium fetches worker scripts outside the inspected page's CDP target.
    ...(mobile ? ['--user-agent=Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'] : []),
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let announcedPort = null;
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
    const endpoint = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(diagnostics);
    if (endpoint) announcedPort = Number(endpoint[1]);
  });
  let socket;
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Test browser command timed out: ' + method));
      }, 12000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  t.after(async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
    } else if (child.exitCode === null && child.signalCode === null) child.kill();
    const timer = setTimeout(() => child.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); socket?.close(); }
  });
  await once(child, 'spawn');
  const url = await eventually(async () => {
    const port = announcedPort ?? Number((await fs.promises.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    if (!Number.isInteger(port) || port < 1 || port === 3002) throw new Error('Invalid test browser port.');
    const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });
    return (await res.json()).find((tab) => tab.type === 'page')?.webSocketDebuggerUrl;
  }, 20000, 'test browser').catch((cause) => {
    const status = child.signalCode ?? child.exitCode ?? 'still running';
    throw new Error(`Chromium did not expose a page (${status}). ${diagnostics.trim()}`, { cause });
  });
  socket = new WebSocket(url);
  await once(socket, 'open');
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    clearTimeout(wait.timer);
    if (message.error) wait.reject(new Error(message.error.message));
    else wait.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Test browser closed.'));
    }
    pending.clear();
  });
  await command('Page.enable');
  await command('Network.enable');
  if (mobile) {
    await command('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 1, mobile: true });
  }
  return {
    command,
    onProtocol(method, listener) {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    navigate: (url) => command('Page.navigate', { url }),
    async evaluate(expression) {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    async hasHttpOnlySession(base) {
      const { cookies } = await command('Network.getCookies', { urls: [base] });
      return cookies.some((item) => item.httpOnly && item.name === 'baton_session');
    },
  };
}
