import fs from 'node:fs';
import path from 'node:path';
import { Platform } from 'react-native';

// jest 只允许 mock 工厂引用 `mock` 开头的外部变量
const mockImpact = jest.fn(async (_style: unknown) => {});
const mockNotify = jest.fn(async (_type: unknown) => {});
const mockSelect = jest.fn(async () => {});

jest.mock('expo-haptics', () => ({
  impactAsync: (style: unknown) => mockImpact(style),
  notificationAsync: (type: unknown) => mockNotify(type),
  selectionAsync: () => mockSelect(),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- 要在 mock 之后才加载
const haptics = require('../haptics') as typeof import('../haptics');

beforeEach(() => {
  mockImpact.mockClear();
  mockNotify.mockClear();
  mockSelect.mockClear();
});

/**
 * 触感的价值全在「哪一下配哪种震动」上。震错了比不震更糟：
 * 选择用了按钮的那一下，分段控件摸起来就像在按按钮。
 */
describe('语义对应到不同的系统震动', () => {
  test('选择走 selectionAsync，不是冲击', () => {
    haptics.select();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockImpact).not.toHaveBeenCalled();
  });

  test('轻点与重击是两档冲击，不是同一个', () => {
    haptics.tap();
    haptics.thud();
    expect(mockImpact.mock.calls.map((c) => c[0])).toEqual(['Light', 'Medium']);
  });

  test('成败走通知型，三种各不相同', () => {
    haptics.success();
    haptics.warn();
    haptics.fail();
    expect(mockNotify.mock.calls.map((c) => c[0])).toEqual(['Success', 'Warning', 'Error']);
  });
});

describe('失败不能影响这次点击', () => {
  test('底层抛了也不往上冒', () => {
    // 模拟器、低电量模式、被系统限流时 expo-haptics 都可能抛。
    // 触感是旁路，任何一次失败都不该让一次点击失败。
    mockImpact.mockImplementationOnce(() => Promise.reject(new Error('限流')));
    expect(() => haptics.tap()).not.toThrow();
  });

  test('不返回 Promise——调用点不该为旁路多等一个微任务', () => {
    expect(haptics.tap()).toBeUndefined();
  });
});

describe('网页一律不走', () => {
  test('测试环境本身不是 web（否则上面几条测的是空壳）', () => {
    // 这条是给上面那些断言兜底的：如果哪天 jest 的 Platform 变成 web，
    // 模块会整个不加载，mock 一次都不会被调用，而测试仍然「通过」。
    expect(Platform.OS).not.toBe('web');
  });

  test('源码里有 web 的短路，且在 require 之前', () => {
    // expo-haptics 在 web 上会去调 Vibration API：iOS Safari 不支持
    // （Baton 的日常入口正是加到主屏的 PWA），桌面浏览器上让整台机器震更是错的。
    const code = fs.readFileSync(path.join(__dirname, '..', 'haptics.ts'), 'utf8');
    const guard = code.indexOf("Platform.OS !== 'web'");
    const load = code.indexOf("require('expo-haptics')");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(load);
  });
});
