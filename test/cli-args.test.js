import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, USAGE } from '../src/cli-args.js';

test('无参数默认等效于 baton start（兼容现网直接运行 node src/cli.js）', () => {
  assert.deepEqual(parseCliArgs([]), {
    ok: true,
    cmd: 'start',
    host: null,
    port: null,
    quickTunnel: false,
    readOnly: false,
  });
});

test('parseCliArgs 支持 start / pair / doctor / tunnel / help / version 及其标志', () => {
  assert.deepEqual(parseCliArgs(['start', '--port', '4000', '--host', '0.0.0.0', '--quick-tunnel', '--read-only']), {
    ok: true,
    cmd: 'start',
    host: '0.0.0.0',
    port: 4000,
    quickTunnel: true,
    readOnly: true,
  });
  assert.deepEqual(parseCliArgs(['--quick-tunnel']), {
    ok: true,
    cmd: 'start',
    host: null,
    port: null,
    quickTunnel: true,
    readOnly: false,
  });
  assert.deepEqual(parseCliArgs(['pair', '--for', 'friend']), {
    ok: true,
    cmd: 'pair',
    for: 'friend',
  });
  assert.deepEqual(parseCliArgs(['doctor', '--json']), {
    ok: true,
    cmd: 'doctor',
    json: true,
  });
  assert.deepEqual(parseCliArgs(['tunnel', '--port', '3005']), {
    ok: true,
    cmd: 'tunnel',
    port: 3005,
  });
  assert.equal(parseCliArgs(['--help']).cmd, 'help');
  assert.equal(parseCliArgs(['-h']).cmd, 'help');
  assert.equal(parseCliArgs(['--version']).cmd, 'version');
  assert.equal(parseCliArgs(['-v']).cmd, 'version');
  assert.match(USAGE, /quick-tunnel/);
});

test('未知子命令与非法端口快速失败并给出 fix 指引', () => {
  const badCmd = parseCliArgs(['deploy']);
  assert.equal(badCmd.ok, false);
  assert.ok(badCmd.fix);

  const badPort = parseCliArgs(['start', '--port', 'not-a-number']);
  assert.equal(badPort.ok, false);
  assert.match(badPort.error, /port/i);

  const badFlag = parseCliArgs(['doctor', '--unknown']);
  assert.equal(badFlag.ok, false);
});
