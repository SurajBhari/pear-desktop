import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { musicModuleSource } from './helpers/api-music-source';

/** Producer/service share one bundle: broker WeakMaps and owner lifetimes are exact. */
async function musicRequestFixture() {
  const ipcMain = new EventEmitter(),
    contents = new EventEmitter() as any,
    window = new EventEmitter() as any;
  const sent: any[] = [];
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  contents.send = (...args: any[]) => sent.push(args);
  window.webContents = contents;
  window.isDestroyed = () => false;
  const m = await musicModuleSource(
    [
      'src/providers/music-request.ts',
      'src/plugins/api-server/backend/mcp-tools.ts',
      'src/plugins/api-server/backend/music-read-result.ts',
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain },
  );
  const broker = m.createMusicRequestBroker(window);
  const emit = (value: any) =>
    ipcMain.emit(
      'peard:music-reply',
      { sender: contents, senderFrame: contents.mainFrame },
      value,
    );
  const challenge = (index = 0) =>
    sent.filter((p) => p[0] === 'peard:music-owner-query')[index][1];
  return {
    m,
    broker,
    ipcMain,
    contents,
    window,
    sent,
    emit,
    challenge,
    ready: (packet: any) =>
      emit({
        ...packet,
        type: 'ready',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
      }),
    settled: (packet: any, result: any) =>
      emit({
        ...packet,
        type: 'settled',
        documentId: '1'.repeat(32),
        sourceId: '2'.repeat(32),
        result,
      }),
  };
}

const videoId = 'abcdefghijk';
const epoch = '1'.repeat(32) + ':' + '2'.repeat(32);
const scopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
];
const item = {
  kind: 'song',
  id: videoId,
  title: 'Owned 🌍',
  artists: [],
  durationSeconds: null,
};
const catalog = {
  version: 1,
  items: [item],
  shelves: [{ title: 'Owned', start: 0, count: 1 }],
  continuation: null,
  targetRecipes: [],
};
const snapshot = {
  version: 1,
  playbackEpoch: epoch,
  current: item,
  state: 'paused',
  elapsedSeconds: null,
  elapsedMilliseconds: null,
  durationSeconds: null,
  volume: null,
};
const cases = [
  ['music_now_playing', {}, snapshot, 'current'],
  [
    'music_get_queue',
    {},
    {
      version: 1,
      queueRevision: 'a'.repeat(32),
      selectedIndex: 0,
      items: [item, item],
    },
    'queue',
  ],
  ['music_search', { query: 'Owned' }, catalog, 'search'],
  [
    'music_browse',
    { target: { kind: 'playlist', id: 'PLowned' } },
    catalog,
    'browse',
  ],
  ['music_home', {}, catalog, 'home'],
  [
    'music_get_library_playlists',
    {},
    { ...catalog, items: [{ ...item, kind: 'playlist', id: 'PLowned' }] },
    'library',
  ],
  [
    'music_lyrics',
    { videoId },
    {
      version: 1,
      binding: { videoId, playbackEpoch: null },
      lyrics: {
        videoId,
        available: true,
        lyrics: 'Literal lyrics',
        source: null,
      },
    },
    'lyrics',
  ],
  [
    'music_related',
    { videoId },
    { version: 1, binding: { videoId, playbackEpoch: null }, source: catalog },
    'related',
  ],
  [
    'music_comments',
    { videoId },
    {
      version: 1,
      binding: { videoId, playbackEpoch: null },
      requests: 1,
      comments: {
        available: true,
        comments: [
          {
            id: 'c',
            author: null,
            text: 'Literal',
            publishedTime: null,
            likeCount: null,
            replyCount: null,
            pinned: false,
            verified: false,
            creator: false,
          },
        ],
        commentCount: null,
        continuation: null,
      },
    },
    'comments',
  ],
] as const;

// Dropping any descriptor or changing its service/action lane breaks a positive owned IPC witness.
for (const [name, args, value, operation] of cases) {
  test(`${name} returns useful actual-service data through the owned broker`, async () => {
    const f = await musicRequestFixture();
    const m = f.m;
    let contents: string | null = null;
    const store = new m.MusicGrantStore('/owned-virtual', Date.now, {
      read: async () => ({ contents, binding: 'owned' }),
      stage: async (_directory: string, next: string) => ({
        commit: async () => {
          contents = next;
          return 'owned';
        },
        close: async () => {},
      }),
    });
    const resource = 'http://127.0.0.1:26539/mcp';
    const grant = await store.issue(
      'Owned read',
      'mcp',
      resource,
      scopes,
      () => true,
    );
    const release = f.broker.retain();
    const owner = { identity: {}, current: () => true };
    const service = m.createMusicService({
      window: f.window,
      config: {
        enabled: true,
        musicApiEnabled: false,
        hostname: '127.0.0.1',
        port: 26538,
      },
      grants: store,
      broker: f.broker,
      resolveAccessOwner: () => owner,
    });
    const registry = m.createMcpReadToolRegistry(service);
    const invocation = {
      token: grant.token,
      transport: 'mcp',
      resource,
      signal: new AbortController().signal,
      session: { id: 'owned', current: () => true },
    };
    const pending = registry.call(name, args, invocation);
    void pending.catch(() => {});
    try {
      await expect
        .poll(
          () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
        )
        .toBe(1);
      const packet = f.challenge(0);
      f.ready(packet);
      f.settled(packet, { ok: true, value });
      const result = await pending;
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: 'Music result.' }]);
      expect(result.structuredContent).toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        262144,
      );
      const reads = f.sent.filter((p) => p[0] === 'peard:music-read');
      expect(reads).toHaveLength(1);
      expect(reads[0][1].input.operation).toBe(operation);
      const data = result.structuredContent;
      if (name === 'music_now_playing') expect(data).toEqual(snapshot);
      else if (name === 'music_lyrics') expect(data).toEqual(value.lyrics);
      else if (name === 'music_get_queue') {
        expect(data.items).toHaveLength(2);
        expect(data.items.map((row: any) => row.index)).toEqual([0, 1]);
        expect(data.queueRevision).toBe('a'.repeat(32));
      } else if (name === 'music_comments')
        expect(data.comments[0].text).toBe('Literal');
      else expect(data.items).toHaveLength(1);
      expect(
        JSON.stringify(m.decodeMusicReadResult(JSON.stringify(result))),
      ).toBe(JSON.stringify(result));
      if (name === 'music_now_playing' || name === 'music_home') {
        const encode = (data: any) => {
          f.emit({
            type: 'retire',
            documentId: '1'.repeat(32),
            sourceId: '2'.repeat(32),
          });
          return m.encodeMusicReadSuccess(data);
        };
        const retired =
          name === 'music_now_playing'
            ? service.currentFor(invocation, undefined, encode)
            : service.homeFor(invocation, {}, undefined, encode);
        retired.catch(() => {});
        await expect
          .poll(
            () =>
              f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
          )
          .toBe(2);
        const second = f.challenge(1);
        f.ready(second);
        f.settled(second, { ok: true, value });
        await expect(retired).rejects.toMatchObject({ code: 'retired' });
        expect(f.broker.isCurrent(f.broker.capture())).toBe(true);
      }
    } finally {
      service.stop();
      release();
      f.broker.dispose();
      await Promise.allSettled([pending]);
    }
  });
}

test('descriptor scopes never trigger service work and authority keys remain invalid', async () => {
  const m = await musicModuleSource([
    'src/plugins/api-server/backend/mcp-tools.ts',
    'src/plugins/api-server/backend/music-read-result.ts',
  ]);
  const service = new Proxy(
    {},
    {
      get() {
        throw Error('descriptor listing touched service');
      },
    },
  );
  const registry = m.createMcpReadToolRegistry(service);
  expect(registry.list(scopes)).toHaveLength(9);
  expect(registry.list([])).toEqual([]);
  expect(registry.list(['queue.write'])).toEqual([]);
  expect(registry.list(['library.read']).map((x: any) => x.name)).toEqual([
    'music_get_library_playlists',
  ]);
  const invalid = await registry.call('music_play', {}, {});
  expect(invalid.structuredContent.error.code).toBe('invalid');
});
