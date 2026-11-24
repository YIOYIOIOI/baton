import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { useSessionLive } from '../useSessionLive';
import { useConnection } from '../connection';
import type { Client } from '../../api/client';
import type { BatonEvent, EventPage, PendingAsk, SessionState, Turn } from '../../api/types';

jest.mock('../connection', () => {
  const { create } = jest.requireActual('zustand');
  return { useConnection: create(() => ({ client: null, lastHeardAt: 0 })) };
});

const event = (id: string): BatonEvent => ({ id, offset: 0, kind: 'text', role: 'user', ts: null, text: id });

test('a late state still supplies queue, model and host while preserving every newer SSE field', async () => {
  let show!: ReturnType<typeof useSessionLive>, view!: ReactTestRenderer;
  let finish!: (state: SessionState) => void;
  const state = jest.fn(() => new Promise<SessionState>((resolve) => { finish = resolve; }));
  const stream = jest.fn<ReturnType<Client['stream']>, Parameters<Client['stream']>>(() => jest.fn());
  useConnection.setState({ client: { events: async () => ({ events: [], endOffset: 0 }), state, stream } as unknown as Client });
  function Screen() { show = useSessionLive('late'); return null; }
  try {
    await act(async () => { view = create(<Screen />); });
    const frame = stream.mock.calls[0][1];
    const turn = { turnId: 'new-turn', status: 'running', startedAt: 1 } as Turn;
    const ask = { askId: 'live-question' } as PendingAsk;
    await act(async () => {
      frame({ type: 'turn_start', data: turn });
      frame({ type: 'ask', data: ask });
      frame({ type: 'tick', data: { turnId: turn.turnId, running: true, queued: 3, elapsedMs: 1 } });
      finish({ latestTurn: null, pendingAsk: null, queued: [{ id: 'queued', text: 'fixture', queuedAt: 1 }],
        model: 'model-a', effort: 'high', agent: 'claude', host: 'waiting' } as SessionState);
    });
    expect(show).toMatchObject({ turn, ask, queuedCount: 3, queued: [{ id: 'queued' }], model: 'model-a', effort: 'high', host: 'waiting' });
  } finally { if (view) await act(async () => { view.unmount(); }); }
});

test.each([0, 211])('snapshots before streaming, then resumes at the last complete frame (snapshot %i)', async (endOffset) => {
  jest.useFakeTimers();
  let show!: ReturnType<typeof useSessionLive>;
  let view!: ReactTestRenderer;
  let finish!: (page: EventPage) => void;
  const events = jest.fn(() => new Promise<EventPage>((resolve) => { finish = resolve; }));
  const state = jest.fn(async () => ({ latestTurn: null, queued: [] }));
  const stream = jest.fn<ReturnType<Client['stream']>, Parameters<Client['stream']>>(() => jest.fn());
  useConnection.setState({ client: { events, state, stream } as unknown as Client });
  function Screen() { show = useSessionLive('same'); return null; }
  try {
    await act(async () => { view = create(<Screen />); });
    expect(stream).not.toHaveBeenCalled();
    await act(async () => { finish({ endOffset, nextBefore: null, events: endOffset ? [event('old'), event('old')] : [] }); });
    expect(stream.mock.calls[0][3]?.lastEventId).toBe(String(endOffset));
    const [, frame, disconnect, cursor] = stream.mock.calls[0];
    await act(async () => {
      frame({ type: 'events', data: { events: [event('new'), event('new')] } });
      cursor?.onId?.('305');
      disconnect?.(new Error('offline') as never);
      jest.advanceTimersByTime(1000);
    });
    expect(stream.mock.calls[1][3]?.lastEventId).toBe('305');
    expect(state).toHaveBeenCalledTimes(2);
    await act(async () => { stream.mock.calls[1][1]({ type: 'events', data: { events: [event('new'), event('replayed')] } }); });
    expect(show.events.map((e) => e.id)).toEqual([...(endOffset ? ['old'] : []), 'new', 'replayed']);
  } finally {
    if (view) await act(async () => { view.unmount(); });
    jest.useRealTimers();
  }
});

test('a capped reconnect fills every missing page, preserves older history and resumes at the new snapshot', async () => {
  let show!: ReturnType<typeof useSessionLive>;
  let view!: ReactTestRenderer;
  const entry = (id: string, offset: number) => ({ ...event(id), offset });
  const events = jest.fn()
    .mockResolvedValueOnce({ events: [entry('first', 80)], endOffset: 100, nextBefore: 80 })
    .mockResolvedValueOnce({ events: [entry('fourth', 400)], endOffset: 500, nextBefore: 400 })
    .mockResolvedValueOnce({ events: [entry('second', 100), entry('third', 200)], endOffset: 400, nextBefore: 80 });
  const state = jest.fn(async () => ({ latestTurn: null, queued: [] }));
  const stream = jest.fn<ReturnType<Client['stream']>, Parameters<Client['stream']>>(() => jest.fn());
  useConnection.setState({ client: { events, state, stream } as unknown as Client });
  function Screen() { show = useSessionLive('capped'); return null; }
  try {
    await act(async () => { view = create(<Screen />); });
    await act(async () => {
      const frame = stream.mock.calls[0][1];
      frame({ type: 'gap', data: { from: 350, droppedBefore: 350 } });
      frame({ type: 'events', data: { events: [entry('stale connection', 450)] } });
    });
    expect(stream.mock.calls[1][3]?.lastEventId).toBe('500');
    expect(events.mock.calls[2][1].before).toBe(400);
    expect(show.events.map((e) => e.id)).toEqual(['first', 'second', 'third', 'fourth']);
  } finally { if (view) await act(async () => { view.unmount(); }); }
});
