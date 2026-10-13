import { test, expect } from '@playwright/test';
import { playlistRequestFixture } from './helpers/playlist-request-fixture';

test('new playlist completion uses a unique owner handshake and raw sender/frame correlation', async () => {
  const f = await playlistRequestFixture();
  try {
    const promise = f.request();
    const query = f.query();
    expect(typeof query?.requestId).toBe('string');
    let settled = false;
    void promise.then(() => (settled = true));
    f.emit(
      { requestId: query.requestId, ownerId: f.owner, type: 'owner' },
      {},
      f.contents.mainFrame,
    );
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    f.emit(
      { requestId: query.requestId, ownerId: f.owner, type: 'owner' },
      f.contents,
      {},
    );
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    f.ready(query.requestId);
    expect(f.sent[1]).toEqual([
      'peard:add-playlist-to-queue',
      { requestId: query.requestId, ownerId: f.owner, ...f.input },
    ]);
    f.emit({
      requestId: query.requestId,
      ownerId: '2'.repeat(32),
      type: 'result',
      result: { ok: true, count: 2 },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.ack(query.requestId);
    expect(await promise).toEqual({ ok: true, count: 2 });
    expect(f.ipc.listenerCount('peard:playlist-queue-reply')).toBe(0);
    expect(f.timers.size).toBe(0);
  } finally {
    f.close();
  }
});

test('timeout removes owned state and late replies cannot satisfy a newer request', async () => {
  const f = await playlistRequestFixture();
  try {
    const old = f.request();
    const oldId = f.query()?.requestId;
    expect(typeof oldId).toBe('string');
    f.ready(oldId);
    f.tick();
    expect(await old).toEqual({ ok: false, reason: 'timeout' });
    expect(f.ipc.listenerCount('peard:playlist-queue-reply')).toBe(0);
    expect(f.sent.at(-1)).toEqual([
      'peard:cancel-playlist-queue',
      { requestId: oldId, ownerId: f.owner },
    ]);
    const next = f.request();
    const id = f.query()?.requestId;
    expect(id).not.toBe(oldId);
    let settled = false;
    void next.then(() => (settled = true));
    f.ack(oldId);
    f.ready(oldId);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.ready(id);
    f.ack(id);
    expect(await next).toEqual({ ok: true, count: 2 });
  } finally {
    f.close();
  }
});

for (const kind of [
  'abort',
  'closed window',
  'navigation',
  'destroyed contents',
  'renderer gone',
] as const)
  test(`retires requests on ${kind} and disposes listener/timer ownership`, async () => {
    const f = await playlistRequestFixture();
    try {
      const signal = new AbortController();
      const promise = f.request(f.input, signal.signal);
      const id = f.query()?.requestId;
      expect(typeof id).toBe('string');
      f.ready(id);
      if (kind === 'abort') signal.abort();
      if (kind === 'closed window') f.close();
      if (kind === 'navigation')
        f.contents.emit(
          'did-start-navigation',
          {},
          'https://owned.invalid',
          false,
          true,
        );
      if (kind === 'destroyed contents') {
        f.contents.dead = true;
        f.contents.emit('destroyed');
      }
      if (kind === 'renderer gone')
        f.contents.emit('render-process-gone', {}, {});
      expect(await promise).toEqual({ ok: false, reason: 'retired' });
      expect(f.ipc.listenerCount('peard:playlist-queue-reply')).toBe(0);
      expect(f.timers.size).toBe(0);
      f.ack(id);
      expect(f.window.listenerCount('closed')).toBe(0);
      expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
    } finally {
      f.close();
    }
  });

test('subframe/in-place navigation does not retire an owned request but a changed mainFrame cannot ACK it', async () => {
  const f = await playlistRequestFixture();
  try {
    const promise = f.request();
    const id = f.query()?.requestId;
    expect(typeof id).toBe('string');
    f.ready(id);
    f.contents.emit(
      'did-start-navigation',
      {},
      'https://owned.invalid',
      false,
      false,
    );
    f.contents.emit(
      'did-start-navigation',
      {},
      'https://owned.invalid',
      true,
      true,
    );
    let settled = false;
    void promise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    f.contents.mainFrame = {};
    f.ack(id);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.close();
    expect(await promise).toEqual({ ok: false, reason: 'retired' });
  } finally {
    f.close();
  }
});

test('invalid inputs, aborted scopes, dead windows and bounded pending requests do not emit unauthorized work', async () => {
  const f = await playlistRequestFixture();
  try {
    expect(
      await f.request({ ...f.input, playlistId: 'https://invalid.example' }),
    ).toEqual({ ok: false, reason: 'invalid' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await f.request(f.input, aborted.signal)).toEqual({
      ok: false,
      reason: 'retired',
    });
    expect(f.sent).toEqual([]);
    const pending = Array.from({ length: 32 }, () => f.request());
    expect(await f.request()).toEqual({ ok: false, reason: 'busy' });
    expect(f.sent).toHaveLength(32);
    f.close();
    expect(
      (await Promise.all(pending)).every(
        (result) => !result.ok && result.reason === 'retired',
      ),
    ).toBe(true);
    expect(f.ipc.listenerCount('peard:playlist-queue-reply')).toBe(0);
    expect(await f.request()).toEqual({ ok: false, reason: 'retired' });
  } finally {
    f.close();
  }
});

for (const mode of ['throws', 'missing'])
  test(`unavailable mainFrame ${mode} retires without leaking listeners`, async () => {
    const f = await playlistRequestFixture();
    try {
      Object.defineProperty(f.contents, 'mainFrame', {
        get() {
          if (mode === 'throws') throw new Error('owned frame retired');
          return undefined;
        },
      });
      const promise = f.request();
      if (mode === 'missing') f.close();
      expect(await promise).toEqual({ ok: false, reason: 'retired' });
      expect(f.sent).toEqual([]);
      expect(f.ipc.listenerCount('peard:playlist-queue-reply')).toBe(0);
      expect(f.timers.size).toBe(0);
    } finally {
      f.close();
    }
  });

test('raw ACK result shape cannot coerce a boxed reason or accept nonfinite counts', async () => {
  const f = await playlistRequestFixture();
  try {
    const promise = f.request();
    const id = f.query()?.requestId;
    expect(typeof id).toBe('string');
    f.ready(id);
    let settled = false;
    void promise.then(() => (settled = true));
    f.ack(id, { ok: false, reason: new String('retired') });
    f.ack(id, { ok: true, count: Infinity });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.ack(id);
    expect(await promise).toEqual({ ok: true, count: 2 });
  } finally {
    f.close();
  }
});
