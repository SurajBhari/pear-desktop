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

// N1: physical settlement is independent from logical caller completion.
test('N1 authenticated late ACK consumes settlement callback exactly once after physical cleanup', async () => {
  const f = await musicRequestFixture();
  const controller = new AbortController();
  const notices: any[] = [];
  try {
    const p = f.broker
      .read(
        f.broker.capture(),
        { operation: 'search', query: 'fixture' },
        'n1',
        {
          signal: controller.signal,
          onPhysicalSettled: (reason: string) =>
            notices.push({ reason, slots: f.broker.stats().dispatched }),
        } as any,
      )
      .catch((e: any) => e.code);
    const q = f.challenge();
    f.ready(q);
    controller.abort();
    expect(await p).toBe('retired');
    expect(notices).toEqual([]);
    for (const patch of [
      { nonce: 'f'.repeat(32) },
      { documentId: '3'.repeat(32) },
      { sourceId: '4'.repeat(32) },
    ])
      f.emit({
        ...q,
        type: 'settled',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
        ...patch,
      });
    f.emit(
      {
        ...q,
        type: 'settled',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
      },
      {},
      {},
    );
    expect(notices).toEqual([]);
    f.settled(q);
    f.settled(q);
    expect(notices).toEqual([{ reason: 'authenticated_ack', slots: 0 }]);
  } finally {
    f.contents.emit('render-process-gone');
    f.broker.dispose();
  }
});

for (const mode of [
  'deadline',
  'cancel',
  'revoke',
  'stop',
  'source-retire',
] as const)
  test(
    'N1 ' +
      mode +
      ' leaves read-phase physical settlement pending until authenticated ACK',
    async () => {
      const f = await musicRequestFixture(),
        controller = new AbortController();
      let live = true;
      const notices: string[] = [];
      try {
        const p = f.broker
          .read(
            f.broker.capture(),
            { operation: 'search', query: 'fixture' },
            'n1',
            {
              signal: controller.signal,
              deadline: mode === 'deadline' ? Date.now() + 20 : undefined,
              isCurrent: () => live,
              onPhysicalSettled: (reason: string) => notices.push(reason),
            } as any,
          )
          .catch((e: any) => e.code);
        const q = f.challenge();
        f.ready(q);
        if (mode === 'deadline') await new Promise((r) => setTimeout(r, 30));
        else if (mode === 'stop') f.broker.stop();
        else if (mode === 'source-retire')
          f.emit({
            type: 'retire',
            documentId: '1'.repeat(32),
            sourceId: '2'.repeat(32),
          });
        else {
          live = false;
          controller.abort();
        }
        expect(await p).toBe(mode === 'deadline' ? 'timeout' : 'retired');
        expect(f.broker.stats().dispatched).toBe(1);
        expect(notices).toEqual([]);
        f.settled(q);
        expect(notices).toEqual(['authenticated_ack']);
        expect(f.broker.stats().dispatched).toBe(0);
      } finally {
        f.contents.emit('render-process-gone');
        f.broker.dispose();
      }
    },
  );

test('N1 no Pending admission refusal and owner/queued releases notify definite non-admission once', async () => {
  const f = await musicRequestFixture();
  const notices: string[] = [];
  const controls = Array.from({ length: 12 }, () => new AbortController());
  const options = (index: number) => ({
    signal: controls[index].signal,
    onPhysicalSettled: (reason: string) => notices.push(index + ':' + reason),
  });
  try {
    const admission = f.broker.capture();
    const calls = controls.map((_, i) =>
      f.broker
        .read(
          admission,
          { operation: 'search', query: 'fixture' },
          'p' + i,
          options(i) as any,
        )
        .catch((e: any) => e.code),
    );
    let refused: string | undefined;
    await expect(
      f.broker.read(
        admission,
        { operation: 'search', query: 'fixture' },
        'overflow',
        {
          onPhysicalSettled: (r: string) => {
            refused = r;
          },
        } as any,
      ),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(refused).toBe('not_admitted');
    controls[4].abort();
    expect(await calls[4]).toBe('retired');
    expect(notices).toContain('4:not_admitted');
    controls[0].abort();
    expect(await calls[0]).toBe('retired');
    expect(notices).toContain('0:not_admitted');
    for (const c of controls) c.abort();
    await Promise.all(calls);
    expect(notices).toHaveLength(12);
    expect(new Set(notices).size).toBe(12);
    let expired: string | undefined;
    await expect(
      f.broker.read(
        admission,
        { operation: 'search', query: 'fixture' },
        'expired',
        {
          deadline: Date.now() - 1,
          onPhysicalSettled: (r: string) => {
            expired = r;
          },
        } as any,
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(expired).toBe('not_admitted');
  } finally {
    f.broker.dispose();
  }
});

for (const event of ['did-navigate', 'render-process-gone', 'closed'] as const)
  test(
    'N1 authoritative ' +
      event +
      ' cleanup consumes callback before throw and reentry',
    async () => {
      const f = await musicRequestFixture();
      let calls = 0,
        observed = -1,
        reported = '';
      const pending: any[] = [];
      try {
        pending.push(
          f.broker
            .read(
              f.broker.capture(),
              { operation: 'search', query: 'fixture' },
              'n1',
              {
                onPhysicalSettled: (reason: string) => {
                  reported = reason;
                  calls++;
                  observed = f.broker.stats().dispatched;
                  throw Error('Observer cannot block physical cleanup');
                },
              } as any,
            )
            .catch((e: any) => e.code),
        );
        const q = f.challenge();
        f.ready(q);
        f.contents.emit(
          'did-start-navigation',
          {},
          'file://owned',
          false,
          true,
        );
        expect(await pending[0]).toBe('retired');
        expect(calls).toBe(0);
        expect(f.broker.stats().dispatched).toBe(1);
        if (event === 'closed') f.window.emit(event);
        else f.contents.emit(event);
        expect(calls).toBe(1);
        expect(reported).toBe('authoritative_termination');
        expect(observed).toBe(0);
        f.settled(q);
        expect(calls).toBe(1);
      } finally {
        f.contents.emit('render-process-gone');
        f.broker.dispose();
      }
    },
  );

test('N1 physical callback reentry sees released capacity and cannot reuse a consumed notification', async () => {
  const f = await musicRequestFixture();
  let calls = 0,
    observed = -1;
  let second: Promise<any> | undefined;
  try {
    const p = f.broker.read(
      f.broker.capture(),
      { operation: 'search', query: 'fixture' },
      'n1',
      {
        onPhysicalSettled: () => {
          calls++;
          observed = f.broker.stats().dispatched;
          second = f.read('next');
        },
      } as any,
    );
    const q = f.challenge();
    f.ready(q);
    f.settled(q);
    await p;
    expect(calls).toBe(1);
    expect(observed).toBe(0);
    expect(f.broker.stats().dispatched).toBe(1);
    f.settled(q);
    expect(calls).toBe(1);
    const next = f.challenge();
    f.ready(next);
    f.settled(next);
    await second;
  } finally {
    f.contents.emit('render-process-gone');
    f.broker.dispose();
  }
});

test('N1 optional physical hook preserves exact legacy clock ABI and millisecond precision', async () => {
  const f = await musicRequestFixture();
  const notices: any[] = [];
  try {
    const binding = {
      documentId: '1'.repeat(32),
      episodeId: '2'.repeat(32),
      videoId: 'seedVideo01',
    };
    const p = f.broker.readClock(f.broker.capture(), binding, 'legacy-n1', {
      onPhysicalSettled: (reason: string) => notices.push(reason),
    } as any);
    const q = f.sent.find(
      (message: any) => message[0] === 'peard:legacy-clock-owner-query',
    )[1];
    const emit = (packet: any) =>
      f.ipcMain.emit(
        'peard:legacy-clock-reply',
        { sender: f.contents, senderFrame: f.contents.mainFrame },
        packet,
      );
    emit({
      ...q,
      type: 'ready',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
    });
    const read = f.sent.find(
      (message: any) => message[0] === 'peard:legacy-clock-read',
    )[1];
    expect(read.binding).toEqual(binding);
    expect(JSON.stringify(f.sent)).not.toContain('onPhysicalSettled');
    const packet = {
      ...q,
      type: 'settled',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
      result: { ok: true, value: { ...binding, elapsedMilliseconds: 1234.5 } },
    };
    emit(packet);
    emit(packet);
    expect(await p).toEqual({ ...binding, elapsedMilliseconds: 1234.5 });
    expect(notices).toEqual(['authenticated_ack']);
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    f.contents.emit('render-process-gone');
    f.broker.dispose();
  }
});
