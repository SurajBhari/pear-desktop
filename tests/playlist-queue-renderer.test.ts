import { test, expect } from '@playwright/test';
import { playlistRendererFixture } from './helpers/playlist-renderer-fixture';

const playlistId = 'PLABCDEFGHIJKLMN';
const rows = (...ids: string[]) =>
  ids.map((videoId) => ({
    content: { playlistPanelVideoRenderer: { videoId, selected: true } },
  }));
const ownerFor = (f: any) => {
  const owner = f.owner();
  expect(typeof owner).toBe('string');
  expect(owner).toMatch(/^[0-9a-f]{32}$/);
  return owner;
};
const enqueue = (f: any, ownerId: string, args: any = {}) => {
  const requestId = f.nextId();
  f.emit('peard:add-playlist-to-queue', {
    requestId,
    ownerId,
    playlistId,
    insertPosition: 'INSERT_AT_END',
    ...args,
  });
  return requestId;
};
const resultFor = (f: any, id: string) =>
  f.packets.find(
    (p: any) => p[1]?.requestId === id && p[1]?.type === 'result',
  )?.[1]?.result;

test('playlist IPC slices validated rows and commits after current without moving selection', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f),
      id = enqueue(f, owner, {
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
      });
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0].data).toEqual({
      queueContextParams: 'owned-context',
      playlistId,
    });
    f.fetches[0].resolve({
      queueDatas: rows('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'),
    });
    await f.flush();
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0].payload.index).toBe(1);
    expect(
      f.dispatches[0].payload.items.map(
        (x: any) => x.playlistPanelVideoRenderer.videoId,
      ),
    ).toEqual(['bbbbbbbbbbb', 'ccccccccccc']);
    expect(
      f.dispatches[0].payload.items.every(
        (x: any) => x.playlistPanelVideoRenderer.selected === false,
      ),
    ).toBe(true);
    expect(f.intents()).toBe(1);
    expect(resultFor(f, id)).toEqual({ ok: true, count: 2 });
  } finally {
    await f.close();
  }
});

test('single and playlist requests share one physical FIFO and preserve client dispatch order', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f);
    f.emit('peard:add-to-queue', 'aaaaaaaaaaa', 'INSERT_AT_END');
    const id = enqueue(f, owner);
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0].data.videoIds).toEqual(['aaaaaaaaaaa']);
    f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
    await f.flush();
    expect(f.fetches).toHaveLength(2);
    f.fetches[1].resolve({ queueDatas: rows('bbbbbbbbbbb', 'ccccccccccc') });
    await f.flush();
    expect(
      f.dispatches.map((x) =>
        x.payload.items.map((i: any) => i.playlistPanelVideoRenderer.videoId),
      ),
    ).toEqual([['aaaaaaaaaaa'], ['bbbbbbbbbbb', 'ccccccccccc']]);
    expect(f.dispatches.map((x) => x.payload.index)).toEqual([2, 3]);
    expect(resultFor(f, id)).toEqual({ ok: true, count: 2 });
  } finally {
    await f.close();
  }
});

for (const reason of [
  'clear',
  'store clear',
  'store context',
  'queue replacement',
  'app replacement',
  'API replacement',
  'pagehide',
] as const)
  test(`retires active and queued callbacks on ${reason}`, async () => {
    const f = await playlistRendererFixture();
    try {
      const owner = ownerFor(f),
        a = enqueue(f, owner),
        b = enqueue(f, owner);
      if (reason === 'clear') f.emit('peard:clear-queue');
      if (reason === 'store clear')
        f.setState({ queue: { ...f.state().queue, items: [] } });
      if (reason === 'store context')
        f.setState({
          queue: { ...f.state().queue, queueContextParams: 'new-context' },
        });
      if (reason === 'queue replacement')
        f.queue.replaceWith(f.dom.document.createElement('div'));
      if (reason === 'app replacement')
        f.app.replaceWith(f.dom.document.createElement('ytmusic-app'));
      if (reason === 'API replacement') f.replaceApi();
      if (reason === 'pagehide')
        f.dom.dispatchEvent(new f.dom.Event('pagehide'));
      f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
      await f.flush();
      expect(f.dispatches).toEqual([]);
      expect(f.fetches).toHaveLength(1);
      expect(resultFor(f, a)).toEqual({ ok: false, reason: 'retired' });
      expect(resultFor(f, b)).toEqual({ ok: false, reason: 'retired' });
    } finally {
      await f.close();
    }
  });

test('cancelled physical fetch cannot commit, and cancelled queued jobs are removed before drain', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f),
      a = enqueue(f, owner),
      b = enqueue(f, owner);
    f.emit('peard:cancel-playlist-queue', { requestId: b, ownerId: owner });
    f.emit('peard:cancel-playlist-queue', { requestId: a, ownerId: owner });
    expect(resultFor(f, a)).toEqual({ ok: false, reason: 'retired' });
    expect(resultFor(f, b)).toEqual({ ok: false, reason: 'retired' });
    f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
    await f.flush();
    expect(f.fetches).toHaveLength(1);
    expect(f.dispatches).toEqual([]);
  } finally {
    await f.close();
  }
});

test('malformed, oversize and continued responses never partially mutate the queue', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f);
    for (const response of [
      { queueDatas: [...rows('aaaaaaaaaaa'), {}] },
      {
        queueDatas: Array.from({ length: 1001 }, () => rows('aaaaaaaaaaa')[0]),
      },
      { queueDatas: rows('aaaaaaaaaaa'), continuation: 'owned-next' },
    ]) {
      const id = enqueue(f, owner);
      f.fetches.at(-1)!.resolve(response);
      await f.flush();
      expect(resultFor(f, id)).toEqual({ ok: false, reason: 'service' });
    }
    expect(f.dispatches).toEqual([]);
  } finally {
    await f.close();
  }
});

test('owner nonce, validation and a bounded pending queue reject unsafe packets without fetching', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f),
      wrong = enqueue(f, 'f'.repeat(32));
    expect(resultFor(f, wrong)).toEqual({ ok: false, reason: 'retired' });
    const invalid = enqueue(f, owner, {
      playlistId: 'https://invalid.example/list',
    });
    expect(resultFor(f, invalid)).toEqual({ ok: false, reason: 'invalid' });
    expect(f.fetches).toEqual([]);
    for (let i = 0; i < 32; i++) enqueue(f, owner);
    const excess = enqueue(f, owner);
    expect(resultFor(f, excess)).toEqual({ ok: false, reason: 'busy' });
    expect(f.fetches).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('disposal removes only owned listeners and store subscription, fencing retained closures', async () => {
  const f = await playlistRendererFixture();
  try {
    const owner = ownerFor(f);
    const foreign = () => {};
    f.callbacks.get('peard:add-to-queue')!.add(foreign);
    const retained = [...f.callbacks.get('peard:add-playlist-to-queue')!];
    const id = enqueue(f, owner);
    f.controller.dispose();
    for (const fn of retained)
      fn({
        requestId: f.nextId(),
        ownerId: owner,
        playlistId,
        insertPosition: 'INSERT_AT_END',
      });
    expect(f.callbacks.get('peard:add-to-queue')!.size).toBe(1);
    expect(f.callbacks.get('peard:add-to-queue')!.has(foreign)).toBe(true);
    expect(f.subscribers.size).toBe(0);
    f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
    await f.flush();
    expect(f.dispatches).toEqual([]);
    expect(resultFor(f, id)).toEqual({ ok: false, reason: 'retired' });
  } finally {
    await f.close();
  }
});

for (const phase of ['capture', 'after capture'])
  test(`unavailable store during ${phase} retires without an uncaught callback or mutation`, async () => {
    const f = await playlistRendererFixture();
    try {
      const owner = ownerFor(f);
      const original = f.store.getState;
      let calls = 0;
      f.store.getState = () => {
        calls++;
        if (phase === 'capture' || calls === 3)
          throw new Error('owned store retired');
        return original();
      };
      const id = f.nextId();
      expect(() =>
        f.emit('peard:add-playlist-to-queue', {
          requestId: id,
          ownerId: owner,
          playlistId,
          insertPosition: 'INSERT_AT_END',
        }),
      ).not.toThrow();
      await f.flush();
      expect(resultFor(f, id)).toEqual({ ok: false, reason: 'retired' });
      expect(f.dispatches).toEqual([]);
      expect(f.fetches).toEqual([]);
    } finally {
      await f.close();
    }
  });
