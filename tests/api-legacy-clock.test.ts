import { test, expect } from '@playwright/test';

import { legacyClockNative } from './helpers/api-legacy-clock';
import { musicRequestFixture } from './helpers/api-music-request';

test('legacy aliases serialize fractional native precision without changing integer progress or metadata', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const window = new f.BrowserWindow({ show: false });
    const app = new f.source.OpenAPIHono();
    let info: any = {
      title: 'Owned clock',
      artist: 'Fixture',
      views: 0,
      songDuration: 30,
      videoId: 'current0001',
      mediaType: 'AUDIO',
      elapsedSeconds: 1,
      image: { private: true },
    };
    const original = info;
    f.source.registerControl(
      app,
      { window },
      () => info,
      () => undefined,
      () => undefined,
      () => undefined,
      async () => 1.2345 * 1000,
    );
    const replies = [];
    for (const alias of ['song', 'song-info']) {
      const response = await app.request('/api/v1/' + alias);
      replies.push({ status: response.status, body: await response.json() });
    }
    info = undefined;
    const missing = await app.request('/api/v1/song');
    return { replies, missing: missing.status, original };
  });
  for (const reply of result.replies) {
    expect(reply.status).toBe(200);
    expect(reply.body.elapsedSeconds).toBe(1);
    expect(reply.body.elapsedMilliseconds).toBe(1234.5);
    expect(reply.body.image).toBeUndefined();
  }
  expect(result.missing).toBe(204);
  expect(result.original.elapsedMilliseconds).toBeUndefined();
  expect(result.original.image).toEqual({ private: true });
});

test('private precise clock admission exists on the shared physical broker', async () => {
  const f = await musicRequestFixture();
  try {
    expect(typeof f.broker.readClock).toBe('function');
  } finally {
    f.broker.dispose();
  }
});

test('legacy DTO rechecks candidate ownership after awaiting capture and omits precision on callback failure', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const window = new f.BrowserWindow({ show: false });
    const info = {
      title: 'Owned',
      artist: 'Fixture',
      views: 0,
      songDuration: 30,
      videoId: 'current0001',
      mediaType: 'AUDIO',
      elapsedSeconds: 1,
    };
    const results = [];
    for (const callback of [
      async () => ({ elapsedMilliseconds: 1234.5, isCurrent: () => false }),
      async () => {
        throw Error('Unavailable owned clock');
      },
    ]) {
      const app = new f.source.OpenAPIHono();
      f.source.registerControl(
        app,
        { window },
        () => info,
        () => undefined,
        () => undefined,
        () => undefined,
        callback,
      );
      const response = await app.request('/api/v1/song-info');
      results.push({ status: response.status, body: await response.json() });
    }
    return results;
  });
  for (const reply of result) {
    expect(reply.status).toBe(200);
    expect(reply.body.elapsedMilliseconds).toBeUndefined();
    expect(reply.body.elapsedSeconds).toBe(1);
  }
});

test('catalog tombstones and precise clocks share strict FIFO four/two/eight budgets and exact cancellation', async () => {
  const f = await musicRequestFixture();
  const binding = {
    documentId: '1'.repeat(32),
    episodeId: '2'.repeat(32),
    videoId: 'current0001',
  };
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const queries = () =>
    f.sent
      .filter((p) => p[0] === 'peard:legacy-clock-owner-query')
      .map((p) => p[1]);
  const emit = (packet: any, sender = f.contents) =>
    f.ipcMain.emit(
      'peard:legacy-clock-reply',
      { sender, senderFrame: f.contents.mainFrame },
      packet,
    );
  const ready = (query: any) =>
    emit({
      ...query,
      type: 'ready',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
    });
  const settle = (query: any) =>
    emit({
      ...query,
      type: 'settled',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
      result: { ok: true, value: { ...binding, elapsedMilliseconds: 1234.5 } },
    });
  const calls: Promise<any>[] = [];
  try {
    for (let i = 0; i < 4; i++)
      calls.push(
        f.read(i < 2 ? 'a' : 'b', controllers[i].signal).catch((e) => e.code),
      );
    for (let i = 0; i < 4; i++) f.ready(f.challenge(i));
    controllers[0].abort();
    expect(await calls[0]).toBe('retired');
    for (let i = 0; i < 8; i++)
      calls.push(
        f.broker
          .readClock(
            f.broker.capture(),
            binding,
            i === 0 ? 'a' : 'clock-' + i,
            { signal: controllers[i + 4].signal },
          )
          .catch((e: any) => e.code),
      );
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 8 });
    await expect(
      f.broker.readClock(f.broker.capture(), binding, 'ninth'),
    ).rejects.toMatchObject({ code: 'busy' });
    f.settled(f.challenge(2));
    expect(queries()).toHaveLength(0); // Head principal a still owns two physical reads.
    f.settled(f.challenge(0));
    expect(queries()).toHaveLength(2);
    const abandoned = queries()[0];
    const before = f.sent.length;
    controllers[4].abort();
    expect(await calls[4]).toBe('retired');
    expect(f.sent[before]).toEqual([
      'peard:legacy-clock-cancel',
      {
        requestId: abandoned.requestId,
        nonce: abandoned.nonce,
        documentId: undefined,
        sourceId: undefined,
        phase: 'owner',
      },
    ]);
    expect(f.sent[before + 1][0]).toBe('peard:legacy-clock-owner-query');
    ready(abandoned);
    expect(
      f.sent.filter((p) => p[0] === 'peard:legacy-clock-read'),
    ).toHaveLength(0);
    const live = queries()[1];
    // The expanded reply channel cannot acknowledge a private clock challenge.
    f.emit({
      ...live,
      type: 'ready',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
    });
    expect(
      f.sent.filter((p) => p[0] === 'peard:legacy-clock-read'),
    ).toHaveLength(0);
    ready(live);
    controllers[5].abort();
    expect(await calls[5]).toBe('retired');
    const physical = f.broker.stats().dispatched;
    emit(
      {
        ...live,
        type: 'settled',
        documentId: binding.documentId,
        sourceId: binding.episodeId,
        result: { ok: true, value: { ...binding, elapsedMilliseconds: 0 } },
      },
      {},
    );
    expect(f.broker.stats().dispatched).toBe(physical);
    settle(live);
    expect(queries()).toHaveLength(4);
    expect(
      f.sent.filter((p) => p[0] === 'peard:legacy-clock-cancel').at(-1)[1],
    ).toMatchObject({
      requestId: live.requestId,
      nonce: live.nonce,
      phase: 'read',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
    });
  } finally {
    for (const controller of controllers) controller.abort();
    f.broker.dispose();
    await Promise.all(calls);
  }
});

test('precise clock deadline retires pre-ACK owner before next dispatch and rejects malformed scalar settlement', async () => {
  const f = await musicRequestFixture();
  const binding = {
    documentId: '1'.repeat(32),
    episodeId: '2'.repeat(32),
    videoId: 'current0001',
  };
  const emit = (packet: any) =>
    f.ipcMain.emit(
      'peard:legacy-clock-reply',
      { sender: f.contents, senderFrame: f.contents.mainFrame },
      packet,
    );
  try {
    const timed = f.broker
      .readClock(f.broker.capture(), binding, 'deadline', {
        deadline: Date.now() + 25,
      })
      .catch((e: any) => e.code);
    const query = f.sent.at(-1)[1];
    expect(await timed).toBe('timeout');
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    expect(f.sent.at(-1)).toEqual([
      'peard:legacy-clock-cancel',
      {
        requestId: query.requestId,
        nonce: query.nonce,
        documentId: undefined,
        sourceId: undefined,
        phase: 'owner',
      },
    ]);
    emit({
      ...query,
      type: 'ready',
      documentId: binding.documentId,
      sourceId: binding.episodeId,
    });
    expect(
      f.sent.filter((p) => p[0] === 'peard:legacy-clock-read'),
    ).toHaveLength(0);
    for (const value of [-1, Infinity, NaN, '1234.5', null]) {
      const p = f.broker
        .readClock(f.broker.capture(), binding, 'malformed')
        .catch((e: any) => e.code);
      const owned = f.sent.at(-1)[1];
      emit({
        ...owned,
        type: 'ready',
        documentId: binding.documentId,
        sourceId: binding.episodeId,
      });
      emit({
        ...owned,
        type: 'settled',
        documentId: binding.documentId,
        sourceId: binding.episodeId,
        result: { ok: true, value: { ...binding, elapsedMilliseconds: value } },
      });
      expect(await p).toBe('source');
    }
  } finally {
    f.broker.dispose();
  }
});
