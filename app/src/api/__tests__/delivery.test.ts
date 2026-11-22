import { createClient } from '../client';
import { deliverMessage } from '../delivery';
import { fetch as expoFetch } from 'expo/fetch';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const fetchMock = expoFetch as jest.Mock;
const client = createClient({ baseUrl: 'https://baton.example.test', token: null });
const accepted = () => ({
  ok: true, status: 202, headers: { get: () => '1' }, json: async () => ({ queued: true, queueId: 'queue-fixture' }),
});

test.each([null, {}, { queued: true }, { queued: false }, { queued: true, queueId: {} }, { queued: false, turnId: 12 }, { queued: false, turnId: '' }])('a 202 without an identifiable accepted operation preserves the pending send', async (body) => {
  fetchMock.mockResolvedValueOnce({ ...accepted(), json: async () => body });
  const confirmed = jest.fn();
  await expect(deliverMessage(client, 'session', 'fixture-id', 'body', jest.fn(), confirmed)).rejects.toThrow('send_unconfirmed');
  expect(confirmed).not.toHaveBeenCalled();
});
beforeEach(() => fetchMock.mockReset());

test('a lost response reuses the request ID and an accepted send survives a failed refresh', async () => {
  fetchMock.mockRejectedValueOnce(new Error('connection closed')).mockResolvedValueOnce(accepted());
  const refresh = jest.fn(async () => { throw new Error('offline'); });
  const onAccepted = jest.fn();
  const send = () => deliverMessage(client, 'example', 'message-one', 'synthetic text', refresh, onAccepted);
  await expect(send()).rejects.toThrow();
  await expect(send()).resolves.toEqual({ refreshed: false });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onAccepted).toHaveBeenCalledTimes(1);
  expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).requestId)).toEqual(['message-one', 'message-one']);
});

test('promoting a queued message sends only its ID in a single request', async () => {
  fetchMock.mockResolvedValueOnce(accepted());
  await client.promoteQueued('example', 'queued-one');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://baton.example.test/api/sessions/example/queue/promote');
  expect(JSON.parse(init.body)).toEqual({ id: 'queued-one' });
});
