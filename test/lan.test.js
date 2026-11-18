import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLanIp, pickNetworkAddresses } from '../src/lan.js';

/**
 * 这一组守的是「印出去的链接必须真能打开」。
 * 挑错地址的后果很隐蔽：二维码照样生成、照样能扫，扫出来打不开，
 * 而用户只会觉得是配对坏了。
 */

const iface = (address, extra = {}) => ({ family: 'IPv4', internal: false, address, ...extra });

test('挑私有网段的地址', () => {
  assert.equal(pickLanIp({ eth: [iface('192.168.1.23')] }), '192.168.1.23');
  assert.equal(pickLanIp({ eth: [iface('10.0.0.7')] }), '10.0.0.7');
  assert.equal(pickLanIp({ eth: [iface('172.20.3.4')] }), '172.20.3.4');
});

test('链路本地（169.254）一律跳过——实测它就排在最前面，直接把二维码做废', () => {
  assert.equal(
    pickLanIp({ a: [iface('169.254.83.107')], b: [iface('192.168.1.5')] }),
    '192.168.1.5',
  );
  assert.equal(pickLanIp({ a: [iface('169.254.83.107')] }), null);
});

test('回环与 internal 不算', () => {
  assert.equal(pickLanIp({ lo: [iface('127.0.0.1', { internal: true })] }), null);
});

test('非私有网段不往二维码里放——那意味着 Baton 正暴露在公网', () => {
  assert.equal(pickLanIp({ eth: [iface('203.0.113.9')] }), null);
});

test('IPv6 跳过', () => {
  assert.equal(pickLanIp({ eth: [{ family: 'IPv6', internal: false, address: 'fe80::1' }] }), null);
});

test('family 是数字 4 也要认（node 的返回值两种都出现过）', () => {
  assert.equal(pickLanIp({ eth: [{ family: 4, internal: false, address: '192.168.9.9' }] }), '192.168.9.9');
});

test('多个候选时 192.168 优先于 10.x', () => {
  // 家用路由器那个通常才是手机真连着的网
  assert.equal(
    pickLanIp({ a: [iface('10.8.0.2')], b: [iface('192.168.1.5')] }),
    '192.168.1.5',
  );
});

test('一个都没有时返回 null，宁可不印链接', () => {
  assert.equal(pickLanIp({}), null);
  assert.equal(pickLanIp(null), null);
});

test('172.15 和 172.32 不在私有段里', () => {
  assert.equal(pickLanIp({ eth: [iface('172.15.0.1')] }), null);
  assert.equal(pickLanIp({ eth: [iface('172.32.0.1')] }), null);
  assert.equal(pickLanIp({ eth: [iface('172.16.0.1')] }), '172.16.0.1');
  assert.equal(pickLanIp({ eth: [iface('172.31.0.1')] }), '172.31.0.1');
});

test('pickNetworkAddresses 识别 Tailscale CGNAT (100.64.0.0/10) 并与局域网地址分开', () => {
  const res = pickNetworkAddresses({
    tailscale0: [iface('100.64.12.34')],
    eth0: [iface('192.168.1.50')],
  });
  assert.deepEqual(res, { lan: '192.168.1.50', tailscale: '100.64.12.34' });
  assert.equal(pickLanIp({ tailscale0: [iface('100.64.12.34')], eth0: [iface('192.168.1.50')] }), '192.168.1.50');
  assert.equal(pickLanIp({ tailscale0: [iface('100.127.255.1')] }), '100.127.255.1');
  // 100.63.x.x 和 100.128.x.x 不在 100.64/10 内
  assert.deepEqual(pickNetworkAddresses({ eth: [iface('100.63.1.1'), iface('100.128.0.1')] }), {
    lan: null,
    tailscale: null,
  });
});
