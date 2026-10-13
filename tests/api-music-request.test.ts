import { test, expect } from '@playwright/test';
import { musicRequestFixture } from './helpers/api-music-request';

test('raw broker binds sender main frame challenge phase document and source before a native result', async () => {
  const f = await musicRequestFixture();
  try {
    const p = f.read();
    const query = f.challenge();
    f.emit(
      {
        ...query,
        type: 'ready',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
      },
      {},
    );
    f.emit(
      {
        ...query,
        type: 'ready',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
      },
      f.contents,
      {},
    );
    f.emit({
      ...query,
      nonce: 'wrong',
      type: 'ready',
      documentId: '1'.repeat(32),
      sourceId: '2'.repeat(32),
    });
    f.settled(query);
    expect(f.sent.filter((x) => x[0] === 'peard:music-read')).toHaveLength(0);
    f.ready(query);
    expect(f.sent.filter((x) => x[0] === 'peard:music-read')).toHaveLength(1);
    f.emit({
      ...query,
      type: 'settled',
      documentId: '3'.repeat(32),
      sourceId: '2'.repeat(32),
      result: { ok: true, value: {} },
    });
    f.settled(query);
    expect((await p).items).toEqual([]);
  } finally {
    f.broker.dispose();
  }
});
test('same frame navigation retires captured admissions and replayed ready cannot dispatch', async () => {
  const f = await musicRequestFixture();
  try {
    const capture = f.broker.capture(),
      p = f.read().catch((e: any) => e.code),
      query = f.challenge();
    f.contents.emit(
      'did-start-navigation',
      {},
      'https://music.youtube.com/',
      false,
      true,
    );
    expect(await p).toBe('retired');
    f.ready(query);
    expect(f.sent.filter((x) => x[0] === 'peard:music-read')).toHaveLength(0);
    await expect(
      f.broker.read(capture, { operation: 'current' }, 'a'),
    ).rejects.toMatchObject({ code: 'retired' });
  } finally {
    f.broker.dispose();
  }
});
test('four window slots two per principal eight FIFO waiters and canceled physical tombstones', async () => {
  const f = await musicRequestFixture();
  const signals = Array.from({ length: 12 }, () => new AbortController());
  try {
    const calls = Array.from({ length: 12 }, (_, i) =>
      f.read(`principal-${i % 2}`, signals[i].signal).catch((e: any) => e.code),
    );
    expect(
      f.sent.filter((x) => x[0] === 'peard:music-owner-query'),
    ).toHaveLength(4);
    await expect(f.read('third')).rejects.toMatchObject({ code: 'busy' });
    for (let i = 0; i < 4; i++) f.ready(f.challenge(i));
    signals[0].abort();
    expect(await calls[0]).toBe('retired');
    expect(
      f.sent.filter((x) => x[0] === 'peard:music-owner-query'),
    ).toHaveLength(4);
    f.settled(f.challenge(0));
    expect(
      f.sent.filter((x) => x[0] === 'peard:music-owner-query'),
    ).toHaveLength(5);
    expect(f.sent.filter((x) => x[0] === 'peard:music-read')).toHaveLength(4);
    for (const signal of signals) signal.abort();
  } finally {
    f.broker.dispose();
  }
});
test('document/source retirement settles caller but does not free an unabortable read', async () => {
  const f = await musicRequestFixture();
  try {
    const p = f.read().catch((e: any) => e.code),
      query = f.challenge();
    f.ready(query);
    f.emit({
      type: 'retire',
      documentId: '1'.repeat(32),
      sourceId: '2'.repeat(32),
    });
    expect(await p).toBe('retired');
    expect(f.broker.stats().dispatched).toBe(1);
    f.settled(query);
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    f.broker.dispose();
  }
});
test('dispose removes only owned listeners and rejects all pending callers', async () => {
  const f = await musicRequestFixture(),
    foreign = () => {};
  f.ipcMain.on('peard:music-reply', foreign);
  const p = f.read().catch((e: any) => e.code);
  f.broker.dispose();
  expect(await p).toBe('retired');
  expect(f.ipcMain.listeners('peard:music-reply')).toEqual([foreign]);
});

test('committed native navigation releases terminated document tombstones while start alone does not', async () => {
  const f = await musicRequestFixture();
  try {
    const p = f.read().catch((e: any) => e.code),
      old = f.challenge();
    f.ready(old);
    f.contents.emit(
      'did-start-navigation',
      {},
      'https://music.youtube.com/',
      false,
      true,
    );
    expect(await p).toBe('retired');
    expect(f.broker.stats().dispatched).toBe(1);
    f.contents.emit(
      'did-navigate',
      {},
      'https://music.youtube.com/',
      200,
      'OK',
    );
    expect(f.broker.stats().dispatched).toBe(0);
    const next = f.read(),
      challenge = f.challenge();
    f.ready(challenge);
    f.settled(old);
    expect(f.broker.stats().dispatched).toBe(1);
    f.settled(challenge);
    expect((await next).items).toEqual([]);
  } finally {
    f.broker.dispose();
  }
});
test('native render-process loss terminates old physical work and broker admits reloaded renderer', async () => {
  const f = await musicRequestFixture();
  try {
    const p = f.read().catch((e: any) => e.code);
    f.ready();
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(await p).toBe('retired');
    expect(f.broker.stats().dispatched).toBe(0);
    f.contents.emit(
      'did-navigate',
      {},
      'https://music.youtube.com/',
      200,
      'OK',
    );
    const next = f.read();
    f.ready();
    f.settled();
    expect((await next).items).toEqual([]);
  } finally {
    f.broker.dispose();
  }
});
test('private result owners retire on exact source event and unavailable handshake fails promptly', async () => {
  const f = await musicRequestFixture();
  try {
    const p = f.read();
    f.ready();
    f.settled();
    const result = await p,
      owner = f.broker.resultOwner(result);
    expect(owner.current()).toBe(true);
    f.emit({
      type: 'retire',
      documentId: '1'.repeat(32),
      sourceId: '2'.repeat(32),
    });
    expect(owner.current()).toBe(false);
    const unavailable = f.read();
    f.emit({ ...f.challenge(), type: 'unavailable' });
    await expect(unavailable).rejects.toMatchObject({ code: 'unavailable' });
  } finally {
    f.broker.dispose();
  }
});

test('last quiescent retained service removes only owned pool hooks and fresh acquisition attaches a new coordinator', async () => {
  const f = await musicRequestFixture(),
    foreign = () => {};
  f.ipcMain.on('peard:music-reply', foreign);
  const release = f.broker.retain();
  release();
  expect(f.ipcMain.listeners('peard:music-reply')).toEqual([foreign]);
  const next = f.again();
  expect(next).not.toBe(f.broker);
  const leave = next.retain();
  const p = next.read(
    next.capture(),
    { operation: 'search', query: 'fixture' },
    'new',
  );
  f.ready();
  f.settled();
  expect((await p).items).toEqual([]);
  leave();
  expect(f.ipcMain.listeners('peard:music-reply')).toEqual([foreign]);
  next.dispose();
});
test('stop and restart reuse the exact retained coordinator until four physical tombstones settle', async () => {
  const f = await musicRequestFixture(),
    signals = Array.from({ length: 4 }, () => new AbortController());
  const leave = f.broker.retain();
  const old = signals.map((signal, i) =>
    f.read('old-' + i, signal.signal).catch((e: any) => e.code),
  );
  for (let i = 0; i < 4; i++) f.ready(f.challenge(i));
  for (const signal of signals) signal.abort();
  expect(await Promise.all(old)).toEqual(Array(4).fill('retired'));
  leave();
  expect(f.broker.stats().dispatched).toBe(4);
  const next = f.again();
  expect(next).toBe(f.broker);
  const newLeave = next.retain();
  const pending = next.read(
    next.capture(),
    { operation: 'search', query: 'fixture' },
    'new',
  );
  expect(f.sent.filter((p) => p[0] === 'peard:music-owner-query')).toHaveLength(
    4,
  );
  f.settled(f.challenge(0));
  expect(f.sent.filter((p) => p[0] === 'peard:music-owner-query')).toHaveLength(
    5,
  );
  f.ready(f.challenge(4));
  f.settled(f.challenge(4));
  expect((await pending).items).toEqual([]);
  newLeave();
  for (let i = 1; i < 4; i++) f.settled(f.challenge(i));
  expect(f.ipcMain.listenerCount('peard:music-reply')).toBe(0);
});
test('queued owner guard retires stale config work before pumping even if its abort event has not arrived', async () => {
  const f = await musicRequestFixture();
  let current = true;
  try {
    const a = f.read('same'),
      b = f.read('same'),
      queued = f
        .read('same', undefined, () => current)
        .catch((e: any) => e.code);
    f.ready(f.challenge(0));
    f.ready(f.challenge(1));
    current = false;
    f.settled(f.challenge(0));
    expect(
      f.sent.filter((p) => p[0] === 'peard:music-owner-query'),
    ).toHaveLength(2);
    expect(await queued).toBe('retired');
    await a;
    f.settled(f.challenge(1));
    await b;
  } finally {
    f.broker.dispose();
  }
});

test('owner-phase abort sends exact abandoned-handshake cancellation before releasing admission and ignores late ACK', async () => {
  const f = await musicRequestFixture(),
    control = new AbortController();
  try {
    const pending = f.read('owner', control.signal).catch((e: any) => e.code),
      packet = f.challenge();
    control.abort();
    expect(await pending).toBe('retired');
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toEqual([
      [
        'peard:music-cancel',
        {
          requestId: packet.requestId,
          nonce: packet.nonce,
          documentId: undefined,
          sourceId: undefined,
          phase: 'owner',
        },
      ],
    ]);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    f.ready(packet);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    const healthy = f.read('new'),
      next = f.challenge();
    f.ready(next);
    f.settled(next);
    expect((await healthy).items).toEqual([]);
  } finally {
    f.broker.dispose();
  }
});
test('owner-phase deadline sends cancellation without waiting for ready acknowledgement', async () => {
  const f = await musicRequestFixture();
  try {
    const pending = f.broker
        .read(f.broker.capture(), { operation: 'current' }, 'deadline', {
          deadline: Date.now() + 20,
        })
        .catch((e: any) => e.code),
      packet = f.challenge();
    expect(await pending).toBe('timeout');
    expect(
      f.sent.filter((p) => p[0] === 'peard:music-cancel')[0]?.[1],
    ).toMatchObject({
      requestId: packet.requestId,
      nonce: packet.nonce,
      phase: 'owner',
    });
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
  } finally {
    f.broker.dispose();
  }
});
test('queued undispatched abort sends no renderer cancellation and preserves owner leases', async () => {
  const f = await musicRequestFixture(),
    a = new AbortController(),
    b = new AbortController(),
    queued = new AbortController();
  try {
    const calls = [
      f.read('same', a.signal).catch((e: any) => e.code),
      f.read('same', b.signal).catch((e: any) => e.code),
      f.read('same', queued.signal).catch((e: any) => e.code),
    ];
    queued.abort();
    expect(await calls[2]).toBe('retired');
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')).toHaveLength(0);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 0 });
    a.abort();
    b.abort();
    await Promise.all(calls);
  } finally {
    f.broker.dispose();
  }
});
test('read-phase abort preserves physical tombstone and binds cancellation to exact native source', async () => {
  const f = await musicRequestFixture(),
    control = new AbortController();
  try {
    const pending = f.read('read', control.signal).catch((e: any) => e.code),
      packet = f.challenge();
    f.ready(packet);
    control.abort();
    expect(await pending).toBe('retired');
    expect(f.sent.filter((p) => p[0] === 'peard:music-cancel')[0]?.[1]).toEqual(
      {
        requestId: packet.requestId,
        nonce: packet.nonce,
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
        phase: 'read',
      },
    );
    expect(f.broker.stats().dispatched).toBe(1);
    f.emit({
      ...packet,
      type: 'settled',
      documentId: '1'.repeat(32),
      sourceId: '3'.repeat(32),
      result: { ok: false, reason: 'retired' },
    });
    expect(f.broker.stats().dispatched).toBe(1);
    f.settled(packet);
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    f.broker.dispose();
  }
});
