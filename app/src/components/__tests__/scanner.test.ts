import { parseScanned } from '../Scanner';

/**
 * 扫到的东西什么都可能是——别的应用的二维码、被加工过的 URL、裸码。
 * 认错了会拿一个无效码去配对（而配对码是一次性的，失败就废了一个）；
 * 认少了会「扫了没反应」，且用户完全不知道为什么。
 */

test('完整链接：取出码与主机', () => {
  expect(parseScanned('https://baton.example.com/pair?c=ABCD2345EFGH')).toEqual({
    code: 'ABCD2345EFGH',
    origin: 'https://baton.example.com',
  });
});

test('局域网地址带端口时，端口要留住', () => {
  // 丢了端口就会去连 80，那儿什么都没有
  expect(parseScanned('http://192.168.1.23:3002/pair?c=ZZ99ZZ99ZZ99')).toEqual({
    code: 'ZZ99ZZ99ZZ99',
    origin: 'http://192.168.1.23:3002',
  });
});

test('裸配对码也认', () => {
  // 万一码是别的途径生成的。多认一种的成本是三行
  expect(parseScanned('ABCD2345EFGH')).toEqual({ code: 'ABCD2345EFGH', origin: null });
});

test('前后空白不影响——相机有时会带上', () => {
  expect(parseScanned('  ABCD2345EFGH  ')?.code).toBe('ABCD2345EFGH');
});

test('别人的二维码一律不认，继续扫', () => {
  // 认了的话会拿一个无效码去配对，白白废掉用户手上那个真码
  expect(parseScanned('https://example.com/')).toBeNull();
  expect(parseScanned('WIFI:S:MyNet;T:WPA;P:secret;;')).toBeNull();
  expect(parseScanned('tel:+8613800138000')).toBeNull();
  expect(parseScanned('')).toBeNull();
});

test('码长度不对就不认', () => {
  expect(parseScanned('https://a.b/pair?c=SHORT')).toBeNull();
  expect(parseScanned('https://a.b/pair?c=WAYTOOLONGCODE12345')).toBeNull();
  expect(parseScanned('SHORTCODE')).toBeNull();
});

test('码里混进字母表外的字符就不认——不要「清洗」成一个像样但错的码', () => {
  // 清洗后凑巧够 12 位的话，会拿一个根本不是用户手上那个的码去配对
  expect(parseScanned('ABCD-2345-EFGH')).toBeNull();
  expect(parseScanned('abcd2345efgh!!!')).toBeNull();
});

test('小写链接参数会被转成大写——字母表去掉了 0O1I，不会有歧义', () => {
  expect(parseScanned('https://a.b/pair?c=abcd2345efgh')?.code).toBe('ABCD2345EFGH');
});

test('参数名不是 c 的不认', () => {
  expect(parseScanned('https://a.b/pair?code=ABCD2345EFGH')).toBeNull();
});
