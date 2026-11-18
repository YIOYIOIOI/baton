import { VIBRATE, __setEnvForTest, backendFor, fireWeb, isIOS, markOverlayTap, type WebEnv } from '../webHaptics';

/**
 * 网页端触感选路。三种设备三条路，选错的代价：桌面上整台电脑震、iPhone 上去调一个不存在的
 * vibrate、Android 上该震的不震。为什么是这三条见 webHaptics.ts 抬头。
 */

const env = (p: Partial<WebEnv>): WebEnv => ({
  ua: '', platform: '', maxTouchPoints: 0, coarse: false, vibrate: null, ...p,
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36';

test('iPhone 与冒充 Mac 的 iPad 都认作 iOS', () => {
  expect(isIOS(env({ ua: IPHONE }))).toBe(true);
  expect(isIOS(env({ ua: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }))).toBe(true);
  expect(isIOS(env({ ua: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }))).toBe(false);
});

test('选路：iOS 走 switch，Android 触屏走 vibrate，桌面不震', () => {
  const vib = () => true;
  expect(backendFor(env({ ua: IPHONE, coarse: true }))).toBe('ios-switch');
  expect(backendFor(env({ ua: ANDROID, coarse: true, vibrate: vib }))).toBe('vibrate');
  // 笔记本 Chrome 也有 vibrate，但不是触屏
  expect(backendFor(env({ ua: 'Windows Chrome', coarse: false, vibrate: vib }))).toBe('none');
  expect(backendFor(null)).toBe('none');
});

test('Android 上按语义震不同的时长', () => {
  const vibrate = jest.fn(() => true);
  __setEnvForTest(env({ ua: ANDROID, coarse: true, vibrate }));
  fireWeb('tap');
  fireWeb('fail');
  expect(vibrate.mock.calls).toEqual([[VIBRATE.tap], [VIBRATE.fail]]);
});

test('桌面上什么都不做，也不抛', () => {
  const vibrate = jest.fn(() => true);
  __setEnvForTest(env({ ua: 'Windows Chrome', vibrate }));
  expect(() => fireWeb('thud')).not.toThrow();
  expect(vibrate).not.toHaveBeenCalled();
});

test('vibrate 抛了也不往上冒', () => {
  __setEnvForTest(env({ ua: ANDROID, coarse: true, vibrate: () => { throw new Error('blocked'); } }));
  expect(() => fireWeb('tap')).not.toThrow();
});

test('iOS 上不碰 vibrate；拨开关失败（没有 DOM、被拒）也不抛', () => {
  const vibrate = jest.fn(() => true);
  __setEnvForTest(env({ ua: IPHONE, vibrate }));
  markOverlayTap();
  expect(() => fireWeb('tap')).not.toThrow();
  expect(() => fireWeb('success')).not.toThrow();
  expect(vibrate).not.toHaveBeenCalled();
});
