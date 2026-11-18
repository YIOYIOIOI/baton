import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseTunnelUrl, startQuickTunnel } from '../src/tunnel.js';

test('parseTunnelUrl 从 cloudflared 日志提取 trycloudflare URL', () => {
  const log = [
    '2026-11-17T10:00:00Z INF +------------------------------------------------------------+',
    '2026-11-17T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at:          |',
    '2026-11-17T10:00:00Z INF |  https://quick-orange-fox.trycloudflare.com                |',
  ].join('\n');
  assert.equal(parseTunnelUrl(log), 'https://quick-orange-fox.trycloudflare.com');
  assert.equal(parseTunnelUrl('no url here'), null);
});

test('startQuickTunnel 启动并在解析到 URL 后返回 stop 句柄', async () => {
  let killed = false;
  let seenArgs = null;
  let seenOpts = null;
  const fakeSpawn = (_cmd, args, opts) => {
    seenArgs = args;
    seenOpts = opts;
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('INF https://cool-baton-demo.trycloudflare.com\n'));
    }, 10);
    return child;
  };
  const t = await startQuickTunnel({ targetUrl: 'http://127.0.0.1:3002', spawnFn: fakeSpawn, timeoutMs: 2000 });
  assert.equal(t.url, 'https://cool-baton-demo.trycloudflare.com');
  assert.equal(seenOpts.shell, false);
  assert.deepEqual(seenArgs, ['tunnel', '--url', 'http://127.0.0.1:3002', '--no-autoupdate']);
  t.stop();
  assert.equal(killed, true);
});

test('startQuickTunnel 缺 cloudflared 时给出可执行安装提示', async () => {
  const missingSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      const err = new Error('spawn cloudflared ENOENT');
      // @ts-ignore
      err.code = 'ENOENT';
      child.emit('error', err);
    });
    return child;
  };
  await assert.rejects(
    () => startQuickTunnel({ targetUrl: 'http://127.0.0.1:3002', spawnFn: missingSpawn, timeoutMs: 2000 }),
    /cloudflared/i,
  );
});
