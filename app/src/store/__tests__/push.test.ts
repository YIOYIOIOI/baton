import { Platform } from 'react-native';
import { rebindExistingPush } from '../push';
import type { Client } from '../../api/client';

test('the authenticated browser rebinds only its existing subscription and observes a lock acquired during registration', async () => {
  const properties = ['navigator', 'Notification', 'PushManager'] as const;
  const previous = new Map(properties.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const platform = jest.replaceProperty(Platform, 'OS', 'web');
  const getSubscription = jest.fn();
  const register = jest.fn(async () => ({ pushManager: { getSubscription } }));
  const requestPermission = jest.fn();
  const pushSubscribe = jest.fn(async () => {});
  const client = { pushSubscribe } as unknown as Client;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { register } } });
    Object.defineProperty(globalThis, 'PushManager', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission } });
    const endpoint = 'https://push.example/existing';
    getSubscription.mockResolvedValue({ endpoint });
    await rebindExistingPush(client, () => true);
    expect(pushSubscribe).toHaveBeenCalledWith(endpoint);
    let unlocked = true;
    getSubscription.mockImplementationOnce(() => { unlocked = false; return Promise.resolve({ endpoint }); });
    await rebindExistingPush(client, () => unlocked);
    getSubscription.mockResolvedValue(null);
    await rebindExistingPush(client, () => true);
    expect(pushSubscribe).toHaveBeenCalledTimes(1);
    expect(requestPermission).not.toHaveBeenCalled();
  } finally {
    for (const key of properties) {
      const old = previous.get(key);
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    }
    platform.restore();
  }
});
