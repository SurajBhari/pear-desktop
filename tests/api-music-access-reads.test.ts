import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { musicModuleSource } from './helpers/api-music-source';
import { musicRequestFixture } from './helpers/api-music-request';

const resource = 'http://127.0.0.1:26539/mcp';
const videoId = 'abcdefghijk';
const epoch = '1'.repeat(32) + ':' + '2'.repeat(32);
const scopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
  'playback.control',
  'queue.write',
];
const song = (i: number) => ({
  kind: 'song',
  id: 'v' + String(i).padStart(10, '0'),
  title: 'Literal ' + i,
  artists: [],
  durationSeconds: null,
});
const catalog = (kind = 'song', continuation: string | null = null) => ({
  version: 1,
  items: Array.from({ length: 151 }, (_, i) =>
    kind === 'playlist' ? { ...song(i), kind, id: 'PLowned' + i } : song(i),
  ),
  shelves: [
    { title: 'Shelf α', start: 0, count: 37 },
    { title: 'Shelf β', start: 37, count: 114 },
  ],
  continuation: continuation
    ? { endpoint: 'browse', token: continuation }
    : null,
  targetRecipes: [],
});
const queue = {
  version: 1,
  queueRevision: 'a'.repeat(32),
  selectedIndex: 120,
  items: catalog().items,
};
const snapshot = {
  version: 1,
  playbackEpoch: epoch,
  current: null,
  state: 'stopped',
  elapsedSeconds: null,
  elapsedMilliseconds: null,
  durationSeconds: null,
  volume: null,
};
const binding = (current = false) => ({
  videoId,
  playbackEpoch: current ? epoch : null,
});
const comment = (i: number) => ({
  id: 'c-' + i,
  author: '作者',
  text: 'Literal 🌍 ' + i,
  publishedTime: null,
  likeCount: null,
  replyCount: null,
  pinned: false,
  verified: false,
  creator: false,
});
const commentsValue = (
  count = 151,
  continuation: string | null = null,
  current = false,
) => ({
  version: 1,
  binding: binding(current),
  requests: 1,
  comments: {
    available: count > 0,
    comments: Array.from({ length: count }, (_, i) => comment(i)),
    commentCount: count ? String(count) : null,
    continuation,
  },
});
const webPage = (id: string, next?: string) => ({
  onResponseReceivedEndpoints: [
    {
      reloadContinuationItemsCommand: {
        targetId: 'comments-section',
        continuationItems: [
          {
            commentThreadRenderer: {
              comment: {
                commentRenderer: {
                  commentId: id,
                  authorText: { simpleText: 'Web author' },
                  contentText: { runs: [{ text: 'Web literal' }] },
                },
              },
            },
          },
          ...(next
            ? [
                {
                  continuationItemRenderer: {
                    continuationEndpoint: {
                      continuationCommand: { token: next },
                    },
                  },
                },
              ]
            : []),
        ],
      },
    },
  ],
});

async function fixture(rest = false) {
  const f = await musicRequestFixture();
  const m = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: f.ipcMain },
  );
  const g = m;
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-access-reads-'));
  const now = Date.now;
  const config = {
    enabled: true,
    musicApiEnabled: rest,
    hostname: rest ? '127.0.0.1' : '192.0.2.1',
    port: 26538,
    useHttps: false,
  };
  const store = new g.MusicGrantStore(path.join(folder, 'owned'), now);
  const grant = await store.issue(
    'Owned MCP',
    'mcp',
    resource,
    scopes,
    () => true,
  );
  const owner = { identity: {}, current: () => true };
  let registered: any = owner;
  const webCalls: any[] = [],
    webResponses: any[] = [];
  const release = f.broker.retain();
  const runtime = {
    window: f.window,
    config,
    grants: store,
    broker: f.broker,
    now,
    resolveAccessOwner: (transport: string, audience: string) =>
      transport === 'mcp' && audience === resource ? registered : undefined,
    commentsWeb: {
      request: async (body: any, options: any) => {
        webCalls.push({ body, options });
        const next = webResponses.shift();
        if (next instanceof Error) throw next;
        if (!next) throw Error('No owned WEB response');
        return next;
      },
    },
  };
  const service = m.createMusicService(runtime),
    services = [service];
  const session = { id: 'session-a', current: () => true };
  const invocation = (overrides: any = {}) => ({
    token: grant.token,
    transport: 'mcp',
    resource,
    signal: new AbortController().signal,
    session,
    ...overrides,
  });
  let queryIndex = 0;
  async function step(value: any, error?: string) {
    const index = queryIndex++;
    await expect
      .poll(
        () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
      )
      .toBeGreaterThan(index);
    const packet = f.challenge(index);
    f.ready(packet);
    f.settled(packet, error ? { ok: false, error } : { ok: true, value });
    return packet;
  }
  const owned = new Set<Promise<unknown>>();
  function own<T>(pending: Promise<T>): Promise<T> {
    owned.add(pending);
    const release = () => {
      owned.delete(pending);
    };
    void pending.then(release, release);
    return pending;
  }
  async function finish(pending: Promise<any>, value: any) {
    own(pending);
    await step(value);
    return pending;
  }
  return {
    ...f,
    m,
    config,
    store,
    grant,
    owner,
    service,
    session,
    invocation,
    step,
    own,
    finish,
    webCalls,
    webResponses,
    register: (value: any) => {
      registered = value;
    },
    restart() {
      const next = m.createMusicService(runtime);
      services.push(next);
      return next;
    },
    async close() {
      for (const s of services) s.stop();
      release();
      f.broker.dispose();
      await Promise.allSettled([...owned]);
      await rm(folder, { recursive: true, force: true });
    },
  };
}
const reads = (f: any) =>
  f.sent.filter((p: any) => p[0] === 'peard:music-read');

// A missing delegate, REST-only admission, changed source/continuation or eager fetch breaks these controls.
for (const method of ['browse', 'home', 'library']) {
  test(`${method}For preserves useful shelves 100+51 replay and explicit continuation with REST off`, async () => {
    const f = await fixture();
    try {
      expect(typeof f.service[method + 'For']).toBe('function');
      const call = (input: any, overrides: any = {}) =>
        f.service[method + 'For'](f.invocation(overrides), input);
      const initial =
        method === 'browse'
          ? { target: { kind: 'category', id: 'genres' }, limit: 100 }
          : { limit: 100 };
      const first = await f.finish(
        call(initial),
        catalog(
          method === 'library' ? 'playlist' : 'song',
          'private-' + method,
        ),
      );
      expect(first.items).toHaveLength(100);
      expect(first.shelves).toEqual([
        { title: 'Shelf α', start: 0, count: 37 },
        { title: 'Shelf β', start: 37, count: 63 },
      ]);
      const second = await call({ cursor: first.nextCursor, limit: 100 });
      expect(second.items).toHaveLength(51);
      expect(second.items[0].title).toBe('Literal 100');
      expect(second.shelves).toEqual([
        { title: 'Shelf β', start: 0, count: 51 },
      ]);
      expect(await call({ cursor: first.nextCursor, limit: 100 })).toEqual(
        second,
      );
      expect(reads(f)).toHaveLength(1);
      const lastSource = {
        ...catalog(method === 'library' ? 'playlist' : 'song'),
        items:
          method === 'library'
            ? [{ ...song(152), kind: 'playlist', id: 'PLowned152' }]
            : [song(152)],
        shelves: [],
      };
      const last = await f.finish(
        call({ cursor: second.nextCursor, limit: 100 }),
        lastSource,
      );
      expect(last.items.map((i: any) => i.title)).toEqual(['Literal 152']);
      expect(reads(f)[1][1].input).toEqual({
        operation: 'continuation',
        endpoint: 'browse',
        token: 'private-' + method,
      });
      expect(f.service.enabled).toBe(false);
      expect(f.m.getMusicService(f.window)).toBeUndefined();
      await expect(
        Promise.resolve().then(() => f.service[method](f.grant.token, initial)),
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await f.close();
    }
  });
}

test('queueFor preserves queue order selection revision and exact replay on the same REST-off broker', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.queueFor).toBe('function');
    const first = await f.finish(
      f.service.queueFor(f.invocation(), { limit: 100 }),
      queue,
    );
    const second = await f.finish(
      f.service.queueFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      }),
      queue,
    );
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(51);
    expect(second).toMatchObject({
      queueRevision: 'a'.repeat(32),
      selectedIndex: 120,
      total: 151,
      nextCursor: null,
    });
    expect(second.items[0]).toEqual({
      index: 100,
      selected: false,
      item: song(100),
    });
    expect(second.items[20]).toEqual({
      index: 120,
      selected: true,
      item: song(120),
    });
    expect(
      await f.finish(
        f.service.queueFor(f.invocation(), {
          cursor: first.nextCursor,
          limit: 100,
        }),
        queue,
      ),
    ).toEqual(second);
    expect(reads(f)).toHaveLength(3); // Existing queue revalidation remains mandatory even for replay.
    const changed = { ...queue, queueRevision: 'b'.repeat(32) };
    const pending = f.service.queueFor(f.invocation(), {
      cursor: first.nextCursor,
      limit: 100,
    });
    await f.step(changed);
    await expect(pending).rejects.toMatchObject({ code: 'retired' });
  } finally {
    await f.close();
  }
});

for (const current of [false, true]) {
  test(`lyricsFor and relatedFor preserve ${current ? 'current epoch' : 'explicit video'} binding and useful content`, async () => {
    const f = await fixture();
    try {
      expect(typeof f.service.lyricsFor).toBe('function');
      expect(typeof f.service.relatedFor).toBe('function');
      const target = current ? { current: true } : { videoId };
      const lyrics = {
        videoId,
        available: true,
        lyrics: 'Grüezi 🌍\n歌詞',
        source: 'Literal source',
      };
      expect(
        await f.finish(f.service.lyricsFor(f.invocation(), target), {
          version: 1,
          binding: binding(current),
          lyrics,
        }),
      ).toEqual(lyrics);
      const first = await f.finish(
        f.service.relatedFor(f.invocation(), { ...target, limit: 100 }),
        {
          version: 1,
          binding: binding(current),
          source: catalog('song', 'related-private'),
        },
      );
      const pending = f.service.relatedFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      });
      const second = current
        ? await f.finish(pending, { version: 1, binding: binding(true) })
        : await pending;
      expect(second.items).toHaveLength(51);
      const replay = f.service.relatedFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      });
      expect(
        current
          ? await f.finish(replay, { version: 1, binding: binding(true) })
          : await replay,
      ).toEqual(second);
      const more = f.service.relatedFor(f.invocation(), {
        cursor: second.nextCursor,
        limit: 100,
      });
      if (current) await f.step({ version: 1, binding: binding(true) });
      await f.step({
        version: 1,
        binding: binding(current),
        source: { ...catalog(), items: [song(152)], shelves: [] },
      });
      expect((await more).items[0].title).toBe('Literal 152');
      expect(reads(f).at(-1)[1].input).toMatchObject({
        operation: 'related-continuation',
        token: 'related-private',
        binding: binding(current),
      });
    } finally {
      await f.close();
    }
  });
}

test('commentsFor retains native 100+51 replay and strict native continuation without WEB prefetch', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.commentsFor).toBe('function');
    const first = await f.finish(
      f.service.commentsFor(f.invocation(), { videoId, limit: 100 }),
      commentsValue(151, 'native-private'),
    );
    expect(first).toMatchObject({ source: 'music', available: true });
    const second = await f.service.commentsFor(f.invocation(), {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.comments.map((c: any) => c.id)).toEqual(
      Array.from({ length: 51 }, (_, i) => 'c-' + (100 + i)),
    );
    expect(
      await f.service.commentsFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).toEqual(second);
    expect(reads(f)).toHaveLength(1);
    expect(f.webCalls).toHaveLength(0);
    const last = await f.finish(
      f.service.commentsFor(f.invocation(), {
        cursor: second.nextCursor,
        limit: 100,
      }),
      commentsValue(1),
    );
    expect(last.comments[0].text).toBe('Literal 🌍 0');
    expect(reads(f)[1][1].input).toMatchObject({
      operation: 'comments-continuation',
      token: 'native-private',
      binding: binding(),
      sort: 'top',
    });
    expect(f.webCalls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('commentsFor switches only on consented supported absence and keeps continuation source-bound', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.commentsFor).toBe('function');
    const absent = commentsValue(0);
    expect(
      await f.finish(
        f.service.commentsFor(f.invocation(), { videoId }),
        absent,
      ),
    ).toMatchObject({ source: 'music', available: false });
    expect(f.webCalls).toHaveLength(0);
    f.webResponses.push(
      {
        contents: {
          itemSectionRenderer: {
            sectionIdentifier: 'comment-item-section',
            contents: [
              {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    continuationCommand: { token: 'web-start' },
                  },
                },
              },
            ],
          },
        },
      },
      webPage('web-first', 'web-private'),
      webPage('web-second'),
    );
    const first = await f.finish(
      f.service.commentsFor(f.invocation(), {
        videoId,
        allowPublicWebFallback: true,
      }),
      absent,
    );
    expect(first).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-first', text: 'Web literal' }],
    });
    expect(f.webCalls).toHaveLength(2);
    const second = await f.service.commentsFor(f.invocation(), {
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-second' }],
      nextCursor: null,
    });
    expect(f.webCalls[2].body.continuation).toBe('web-private');
    expect(
      await f.service.commentsFor(f.invocation(), { cursor: first.nextCursor }),
    ).toEqual(second);
    expect(f.webCalls).toHaveLength(3);
    expect(reads(f)).toHaveLength(2);
    const error = f.service.commentsFor(f.invocation(), {
      videoId,
      allowPublicWebFallback: true,
    });
    await f.step(undefined, 'source');
    await expect(error).rejects.toMatchObject({ code: 'source' });
    expect(f.webCalls).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('retireSession immediately drops only exact-session caches and tombstones the object without another read', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.retireSession).toBe('function');
    const src = {
      ...catalog(),
      items: [
        { ...song(0), kind: 'category', id: 'genres' },
        ...catalog().items.slice(1),
      ],
      targetRecipes: [
        {
          itemIndex: 0,
          browseId: 'FEmusic_moods_and_genres_category',
          params: 'private-recipe',
        },
      ],
    };
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
      src,
    );
    const healthySession = { ...f.session };
    await f.finish(
      f.service.searchFor(f.invocation({ session: healthySession }), {
        query: 'healthy',
        limit: 100,
      }),
      src,
    );
    const before = f.service.stats();
    f.service.retireSession(f.session);
    const after = f.service.stats();
    expect(after.cursors).toBe(1);
    expect(after.references).toBe(1);
    expect(after.cacheBytes).toBeGreaterThan(0);
    expect(after.cacheBytes).toBeLessThan(before.cacheBytes);
    await expect(
      f.service.searchFor(f.invocation(), { query: 'retired' }),
    ).rejects.toMatchObject({ code: 'retired' });
    await expect(
      f.service.searchFor(f.invocation({ session: healthySession }), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    f.service.retireSession(healthySession);
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
    expect(
      await f.finish(
        f.service.currentFor(f.invocation({ session: { ...f.session } })),
        snapshot,
      ),
    ).toEqual(snapshot);
    expect(reads(f)).toHaveLength(3);
  } finally {
    await f.close();
  }
});

for (const stage of ['auth', 'predispatch', 'physical']) {
  test(`retireSession promptly retires ${stage} work while preserving physical holds and healthy session admission`, async () => {
    const f = await fixture();
    try {
      expect(typeof f.service.retireSession).toBe('function');
      let releaseAuth!: () => void,
        held = false;
      const authorize = f.store.authorize.bind(f.store);
      if (stage === 'auth')
        f.store.authorize = async (...args: any[]) => {
          const grant = await authorize(...args);
          if (!held) {
            held = true;
            await new Promise<void>((resolve) => {
              releaseAuth = resolve;
            });
          }
          return grant;
        };
      const pending = f.service.currentFor(f.invocation()).then(
        () => 'success',
        (e: any) => e.code,
      );
      let packet: any;
      if (stage === 'auth') await expect.poll(() => held).toBe(true);
      else {
        await expect
          .poll(
            () =>
              f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
          )
          .toBe(1);
        packet = f.challenge();
        if (stage === 'physical') f.ready(packet);
      }
      expect(reads(f)).toHaveLength(stage === 'physical' ? 1 : 0);
      f.service.retireSession(f.session);
      expect(await pending).toBe('retired');
      expect(f.service.sessionLeases.size).toBe(0);
      expect(f.broker.stats().dispatched).toBe(stage === 'physical' ? 1 : 0);
      if (stage === 'auth') {
        releaseAuth();
        await Promise.resolve();
      }
      // A new object with the same ID is independent, on the same grant/pool.
      const healthy = f.service.currentFor(
        f.invocation({ session: { ...f.session } }),
      );
      const index = stage === 'auth' ? 0 : 1;
      await expect
        .poll(
          () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
        )
        .toBe(index + 1);
      const healthyPacket = f.challenge(index);
      f.ready(healthyPacket);
      f.settled(healthyPacket, { ok: true, value: snapshot });
      expect(await healthy).toEqual(snapshot);
      if (stage === 'physical') {
        expect(f.broker.stats().dispatched).toBe(1);
        f.settled(packet, { ok: true, value: snapshot });
      }
      expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
      expect(f.service.sessionLeases.size).toBe(0);
    } finally {
      await f.close();
    }
  });
}

for (const method of [
  'search',
  'browse',
  'home',
  'library',
  'related',
  'comments',
  'queue',
]) {
  test(`${method} cursor foreign session owner and grant checks precede busy replay expiry and physical work`, async () => {
    const f = await fixture();
    try {
      const call = (input: any, overrides: any = {}) =>
        f.service[method + 'For'](f.invocation(overrides), input);
      const initial =
        method === 'search'
          ? { query: 'owned', limit: 100 }
          : method === 'browse'
            ? { target: { kind: 'category', id: 'genres' }, limit: 100 }
            : ['related', 'comments'].includes(method)
              ? { videoId, limit: 100 }
              : { limit: 100 };
      const value =
        method === 'queue'
          ? queue
          : method === 'comments'
            ? commentsValue()
            : method === 'related'
              ? { version: 1, binding: binding(), source: catalog() }
              : catalog(method === 'library' ? 'playlist' : 'song');
      const first = await f.finish(call(initial), value);
      const input = { cursor: first.nextCursor, limit: 100 };
      const cursor = f.service.cursors.get(first.nextCursor);
      const other = await f.store.issue(
        'Other MCP',
        'mcp',
        resource,
        scopes,
        () => true,
      );
      cursor.busy = true;
      const before = f.service.stats();
      for (const overrides of [
        { session: { id: 'session-b', current: () => true } },
        { session: { ...f.session } },
        { token: other.token },
      ]) {
        await expect(call(input, overrides)).rejects.toMatchObject({
          code: 'not_found',
        });
        expect(f.service.stats()).toEqual(before);
      }
      f.register({ identity: {}, current: () => true });
      await expect(call(input)).rejects.toMatchObject({ code: 'not_found' });
      f.register(f.owner);
      await expect(call(input)).rejects.toMatchObject({ code: 'busy' });
      cursor.busy = false;
      const page =
        method === 'queue'
          ? await f.finish(call(input), queue)
          : await call(input);
      expect(
        method === 'comments' ? page.comments.length : page.items.length,
      ).toBe(51);
      for (const overrides of [
        { session: { ...f.session } },
        { token: other.token },
      ])
        await expect(call(input, overrides)).rejects.toMatchObject({
          code: 'not_found',
        });
      const replay =
        method === 'queue'
          ? await f.finish(call(input), queue)
          : await call(input);
      expect(replay).toEqual(page);
      const count = reads(f).length;
      cursor.expires = 0;
      await expect(
        call(input, { session: { ...f.session } }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(f.service.cursors.get(first.nextCursor)).toBe(cursor);
      expect(reads(f)).toHaveLength(count);
    } finally {
      await f.close();
    }
  });
}

test('browseFor target references reject foreign sessions grant and resource owner before busy; issuer still dispatches exact recipe', async () => {
  const f = await fixture();
  try {
    const src = {
      ...catalog(),
      items: [
        { ...song(0), kind: 'category', id: 'genres' },
        ...catalog().items.slice(1),
      ],
      targetRecipes: [
        {
          itemIndex: 0,
          browseId: 'FEmusic_moods_and_genres_category',
          params: 'private-recipe',
        },
      ],
    };
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
      src,
    );
    const reference = f.service.references.get(first.items[0].reference);
    const input = {
      target: { kind: 'reference', id: reference.id },
      limit: 100,
    };
    const other = await f.store.issue(
      'Other',
      'mcp',
      resource,
      scopes,
      () => true,
    );
    reference.busy = true;
    for (const overrides of [
      { session: { ...f.session } },
      { session: { id: 'b', current: () => true } },
      { token: other.token },
    ])
      await expect(
        f.service.browseFor(f.invocation(overrides), input),
      ).rejects.toMatchObject({ code: 'not_found' });
    f.register({ identity: {}, current: () => true });
    await expect(
      f.service.browseFor(f.invocation(), input),
    ).rejects.toMatchObject({ code: 'not_found' });
    f.register(f.owner);
    await expect(
      f.service.browseFor(f.invocation(), input),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(reads(f)).toHaveLength(1);
    reference.busy = false;
    expect(
      (await f.finish(f.service.browseFor(f.invocation(), input), catalog()))
        .items,
    ).toHaveLength(100);
    expect(reads(f)[1][1].input).toEqual({
      operation: 'browse',
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'private-recipe',
    });
  } finally {
    await f.close();
  }
});

test('scope-specific read For admission retains all seven scopes without cross-read joins', async () => {
  const f = await fixture();
  try {
    const table = [
      ['current', undefined, 'playback.read', snapshot],
      ['queue', { limit: 100 }, 'playback.read', queue],
      ['search', { query: 'owned' }, 'catalog.read', catalog()],
      [
        'browse',
        { target: { kind: 'category', id: 'genres' } },
        'catalog.read',
        catalog(),
      ],
      ['home', {}, 'personalized.read', catalog()],
      ['library', {}, 'library.read', catalog('playlist')],
      [
        'lyrics',
        { videoId },
        'catalog.read',
        {
          version: 1,
          binding: binding(),
          lyrics: { videoId, available: false, lyrics: null, source: null },
        },
      ],
      [
        'related',
        { videoId },
        'catalog.read',
        { version: 1, binding: binding(), source: catalog() },
      ],
      ['comments', { videoId }, 'comments.read', commentsValue()],
    ];
    for (const scope of scopes) {
      const grant = await f.store.issue(
        'Only ' + scope,
        'mcp',
        resource,
        [scope],
        () => true,
      );
      for (const [method, input, required, value] of table as any[]) {
        const pending = f.service[method + 'For'](
          f.invocation({ token: grant.token }),
          input,
        );
        if (scope === required) await f.finish(pending, value);
        else await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
      }
    }
    const onlyCatalog = await f.store.issue(
      'Catalog',
      'mcp',
      resource,
      ['catalog.read'],
      () => true,
    );
    await expect(
      f.service.browseFor(f.invocation({ token: onlyCatalog.token }), {
        target: { kind: 'playlist', id: 'WL' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const both = await f.store.issue(
      'Personal browse',
      'mcp',
      resource,
      ['catalog.read', 'library.read'],
      () => true,
    );
    expect(
      (
        await f.finish(
          f.service.browseFor(f.invocation({ token: both.token }), {
            target: { kind: 'playlist', id: 'WL' },
            limit: 100,
          }),
          catalog(),
        )
      ).items,
    ).toHaveLength(100);
    expect(reads(f).at(-1)[1].input).toEqual({
      operation: 'browse',
      browseId: 'VLWL',
    });
    expect(f.service.sessionLeases.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('reentrant session retirement during cache sweep cannot republish private payload', async () => {
  async function run(retireAt?: number) {
    const f = await fixture();
    try {
      await f.finish(
        f.service.searchFor(f.invocation(), { query: 'first', limit: 100 }),
        catalog(),
      );
      const check = f.store.isCurrent.bind(f.store);
      let count = 0,
        armed = false;
      f.store.isCurrent = (...args: any[]) => {
        const result = check(...args);
        if (armed && ++count === retireAt) f.service.retireSession(f.session);
        return result;
      };
      const pending = f.service
        .searchFor(f.invocation(), { query: 'second', limit: 100 })
        .then(
          () => 'success',
          (e: any) => e.code,
        );
      await expect
        .poll(
          () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
        )
        .toBe(2);
      const packet = f.challenge(1);
      f.ready(packet);
      armed = true;
      await f.step(catalog());
      const result = await pending;
      if (retireAt !== undefined) {
        expect(result).toBe('retired');
        expect(f.service.stats()).toEqual({
          cursors: 0,
          references: 0,
          cacheBytes: 0,
        });
        expect(f.service.sessionLeases.size).toBe(0);
        expect(
          await f.finish(
            f.service.currentFor(f.invocation({ session: { ...f.session } })),
            snapshot,
          ),
        ).toEqual(snapshot);
      } else expect(result).toBe('success');
      return count;
    } finally {
      await f.close();
    }
  }
  const count = await run();
  expect(count).toBeGreaterThan(1);
  for (let at = 1; at <= count; at++) await run(at);
});

test('read wrappers and For methods preserve equivalent useful local REST results', async () => {
  const f = await fixture(true);
  try {
    const local = 'http://127.0.0.1:26538/api/v1/music';
    const grant = await f.store.issue(
      'REST read parity',
      'rest',
      local,
      scopes,
      () => true,
    );
    const invocation = f.invocation({
      token: grant.token,
      transport: 'rest',
      resource: local,
      session: undefined,
    });
    const table: any[] = [
      [
        'browse',
        { target: { kind: 'category', id: 'genres' }, limit: 100 },
        catalog(),
      ],
      ['home', { limit: 100 }, catalog()],
      ['library', { limit: 100 }, catalog('playlist')],
      ['queue', { limit: 100 }, queue],
      [
        'lyrics',
        { videoId },
        {
          version: 1,
          binding: binding(),
          lyrics: {
            videoId,
            available: true,
            lyrics: 'Literal lyrics',
            source: null,
          },
        },
      ],
      [
        'related',
        { videoId, limit: 100 },
        { version: 1, binding: binding(), source: catalog() },
      ],
      ['comments', { videoId, limit: 100 }, commentsValue()],
    ];
    for (const [method, input, value] of table) {
      const old = await f.finish(f.service[method](grant.token, input), value);
      const direct = await f.finish(
        f.service[method + 'For'](invocation, input),
        value,
      );
      expect({ ...old, nextCursor: null }).toEqual({
        ...direct,
        nextCursor: null,
      });
      expect(f.service.sessionLeases.size).toBe(0);
    }
    expect(reads(f)).toHaveLength(14);
  } finally {
    await f.close();
  }
});

test('multiple MCP sessions keep the same grant two-slot limit and FIFO queue after logical retirement', async () => {
  const f = await fixture();
  try {
    const a = f.service.currentFor(f.invocation()).then(
      () => 'success',
      (e: any) => e.code,
    );
    const b = f.service.currentFor(
      f.invocation({ session: { id: 'b', current: () => true } }),
    );
    const c = f.service.currentFor(
      f.invocation({ session: { id: 'c', current: () => true } }),
    );
    await expect
      .poll(
        () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
      )
      .toBe(2);
    const pa = f.challenge(0),
      pb = f.challenge(1);
    f.ready(pa);
    f.ready(pb);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 1 });
    f.service.retireSession(f.session);
    expect(await a).toBe('retired');
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 1 });
    expect(reads(f)).toHaveLength(2);
    f.settled(pb, { ok: true, value: snapshot });
    expect(await b).toEqual(snapshot);
    await expect
      .poll(
        () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
      )
      .toBe(3);
    const pc = f.challenge(2);
    f.ready(pc);
    f.settled(pc, { ok: true, value: snapshot });
    expect(await c).toEqual(snapshot);
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
    f.settled(pa, { ok: true, value: snapshot });
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    expect(f.service.sessionLeases.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('retireSession aborts WEB logical work promptly but holds its unabortable physical slot until settlement', async () => {
  const f = await fixture();
  try {
    let release!: (value: any) => void;
    f.webResponses.push(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.service
      .commentsFor(f.invocation(), { videoId, allowPublicWebFallback: true })
      .then(
        () => 'success',
        (e: any) => e.code,
      );
    await f.step(commentsValue(0));
    await expect.poll(() => f.webCalls.length).toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
    f.service.retireSession(f.session);
    expect(await pending).toBe('retired');
    expect(f.webCalls[0].options.signal.aborted).toBe(true);
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
    expect(f.service.sessionLeases.size).toBe(0);
    expect(
      await f.finish(
        f.service.currentFor(f.invocation({ session: { ...f.session } })),
        snapshot,
      ),
    ).toEqual(snapshot);
    expect(f.broker.stats().dispatched).toBe(1);
    release({
      contents: {
        twoColumnWatchNextResults: {
          results: {
            results: { contents: [{ videoPrimaryInfoRenderer: {} }] },
          },
        },
      },
    });
    await expect.poll(() => f.broker.stats().dispatched).toBe(0);
    expect(f.webCalls).toHaveLength(1);
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
  } finally {
    await f.close();
  }
});

test('current comments A-B-A retires old epoch cursor and cannot join a related read', async () => {
  const f = await fixture();
  try {
    const first = await f.finish(
      f.service.commentsFor(f.invocation(), { current: true, limit: 100 }),
      commentsValue(151, null, true),
    );
    const oldCursor = first.nextCursor;
    await expect(
      f.service.relatedFor(f.invocation(), { cursor: oldCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(reads(f)).toHaveLength(1);
    const more = f.service.commentsFor(f.invocation(), {
      cursor: oldCursor,
      limit: 100,
    });
    await f.step({
      version: 1,
      binding: {
        videoId: 'zyxwvutsrqp',
        playbackEpoch: '1'.repeat(32) + ':' + '3'.repeat(32),
      },
    });
    await expect(more).rejects.toMatchObject({ code: 'retired' });
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
    const back = {
      ...commentsValue(151, null, true),
      binding: {
        videoId,
        playbackEpoch: '1'.repeat(32) + ':' + '4'.repeat(32),
      },
    };
    const fresh = await f.finish(
      f.service.commentsFor(f.invocation(), { current: true, limit: 100 }),
      back,
    );
    expect(fresh.comments).toHaveLength(100);
    await expect(
      f.service.commentsFor(f.invocation(), { cursor: oldCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const last = await f.finish(
      f.service.commentsFor(f.invocation(), {
        cursor: fresh.nextCursor,
        limit: 100,
      }),
      { version: 1, binding: back.binding },
    );
    expect(last.comments).toHaveLength(51);
  } finally {
    await f.close();
  }
});

test('current WEB comments retain epoch probes around source-bound continuation and replay', async () => {
  const f = await fixture();
  try {
    f.webResponses.push(
      {
        contents: {
          itemSectionRenderer: {
            sectionIdentifier: 'comment-item-section',
            contents: [
              {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    continuationCommand: { token: 'web-start' },
                  },
                },
              },
            ],
          },
        },
      },
      webPage('web-first', 'web-private'),
      webPage('web-second'),
    );
    const firstPending = f.service.commentsFor(f.invocation(), {
      current: true,
      allowPublicWebFallback: true,
    });
    await f.step(commentsValue(0, null, true));
    await f.step({ version: 1, binding: binding(true) });
    await f.step({ version: 1, binding: binding(true) });
    const first = await firstPending;
    expect(first).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-first' }],
    });
    expect(f.webCalls).toHaveLength(2);
    const more = f.service.commentsFor(f.invocation(), {
      cursor: first.nextCursor,
    });
    for (let i = 0; i < 3; i++)
      await f.step({ version: 1, binding: binding(true) });
    const second = await more;
    expect(second).toMatchObject({
      source: 'public-web',
      comments: [{ id: 'web-second' }],
    });
    const replay = f.service.commentsFor(f.invocation(), {
      cursor: first.nextCursor,
    });
    await f.step({ version: 1, binding: binding(true) });
    expect(await replay).toEqual(second);
    expect(f.webCalls).toHaveLength(3);
    expect(f.webCalls[2].body.continuation).toBe('web-private');
    expect(reads(f).map((p: any) => p[1].input.operation)).toEqual([
      'comments',
      ...Array(6).fill('metadata-current'),
    ]);
  } finally {
    await f.close();
  }
});

const issuerScopeShards = 8;
for (const mode of ['remainder', 'continuation']) {
  for (let shard = 0; shard < issuerScopeShards; shard++) {
    test(`issuer-scope ${mode} composition cannot republish after any grant guard retires its session shard ${shard + 1}/${issuerScopeShards}`, async () => {
      const started = Date.now();
      async function run(at?: number) {
        const iterationStarted = Date.now();
        console.info(
          'ISSUER_SCOPE_ITERATION_START',
          JSON.stringify({
            mode,
            shard,
            shards: issuerScopeShards,
            at: at ?? null,
            phase: 'fixture',
            elapsedMs: Date.now() - iterationStarted,
          }),
        );
        const f = await fixture();
        let phase = 'fixture',
          calls = 0,
          triggered = false,
          primaryFailed = false;
        let primary: unknown;
        const enter = (next: string) => {
          phase = next;
          console.info(
            'ISSUER_SCOPE_PHASE',
            JSON.stringify({
              mode,
              shard,
              shards: issuerScopeShards,
              at: at ?? null,
              phase,
              elapsedMs: Date.now() - iterationStarted,
            }),
          );
        };
        try {
          enter('home');
          const source = {
            ...catalog('song', 'issuer-private-next'),
            items: [
              { ...song(0), kind: 'category', id: 'genres' },
              ...catalog().items.slice(1),
            ],
            targetRecipes: [
              {
                itemIndex: 0,
                browseId: 'FEmusic_moods_and_genres_category',
                params: 'issuer-private-recipe',
              },
            ],
          };
          // The reference originates under personalized.read; browsing and its cursor
          // require catalog.read plus the retained issuer scope on the same grant.
          const home = await f.finish(
            f.service.homeFor(f.invocation(), { limit: 100 }),
            source,
          );
          enter('browse-reference');
          const browse = await f.finish(
            f.service.browseFor(f.invocation(), {
              target: { kind: 'reference', id: home.items[0].reference },
              limit: 100,
            }),
            source,
          );
          expect(reads(f)[1][1].input).toEqual({
            operation: 'browse',
            browseId: 'FEmusic_moods_and_genres_category',
            params: 'issuer-private-recipe',
          });
          let cursor = browse.nextCursor;
          if (mode === 'continuation') {
            enter('cached-remainder');
            const remainder = await f.service.browseFor(f.invocation(), {
              cursor,
              limit: 100,
            });
            expect(remainder.items).toHaveLength(51);
            expect(
              await f.service.browseFor(f.invocation(), { cursor, limit: 100 }),
            ).toEqual(remainder);
            cursor = remainder.nextCursor;
          }
          const original = f.store.isCurrent.bind(f.store);
          let armed = mode === 'remainder';
          f.store.isCurrent = (...args: any[]) => {
            const result = original(...args);
            if (armed && ++calls === at) {
              triggered = true;
              f.service.retireSession(f.session);
            }
            return result;
          };
          enter('issuer-read');
          const pending = f.own(
            f.service
              .browseFor(f.invocation(), { cursor, limit: 100 })
              .then(
                (page: any) => ({ code: 'success', page }),
                (e: any) => ({ code: e.code }),
              ),
          );
          if (mode === 'continuation') {
            enter('continuation-query');
            await expect
              .poll(
                () =>
                  f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
              )
              .toBe(3);
            f.ready(f.challenge(2));
            armed = true;
            enter('continuation-settlement');
            await f.step(source);
          }
          enter('issuer-result');
          const result = await pending;
          const guardCount = calls;
          if (at !== undefined) {
            expect(triggered).toBe(true);
            expect(result.code).toBe('retired');
            expect(f.service.stats()).toEqual({
              cursors: 0,
              references: 0,
              cacheBytes: 0,
            });
            expect(f.service.sessionLeases.size).toBe(0);
            enter('recovery-current');
            expect(
              await f.finish(
                f.service.currentFor(f.invocation({ session: { ...f.session } })),
                snapshot,
              ),
            ).toEqual(snapshot);
            enter('recovery-assertions');
            expect(f.service.stats()).toEqual({
              cursors: 0,
              references: 0,
              cacheBytes: 0,
            });
            expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
          } else {
            enter('baseline-result');
            expect(result.code).toBe('success');
            expect(result.page.items).toHaveLength(
              mode === 'remainder' ? 51 : 100,
            );
            enter('baseline-replay');
            const replay = await f.service.browseFor(f.invocation(), {
              cursor,
              limit: 100,
            });
            expect(replay).toEqual(result.page);
            expect(reads(f)).toHaveLength(mode === 'remainder' ? 2 : 3);
          }
          return guardCount;
        } catch (error) {
          primaryFailed = true;
          primary = error;
          console.error(
            'ISSUER_SCOPE_FAILURE',
            JSON.stringify({
              mode,
              shard,
              shards: issuerScopeShards,
              at: at ?? null,
              phase,
              calls,
              triggered,
              elapsedMs: Date.now() - iterationStarted,
            }),
          );
          throw error;
        } finally {
          let cleanupFailed = false;
          enter('cleanup');
          try {
            await f.close();
          } catch (error) {
            cleanupFailed = true;
            console.error(
              'ISSUER_SCOPE_CLEANUP_FAILURE',
              JSON.stringify({
                mode,
                shard,
                shards: issuerScopeShards,
                at: at ?? null,
                phase,
                primaryFailed,
              }),
            );
            if (primaryFailed)
              throw new AggregateError(
                [primary, error],
                'Issuer-scope primary and cleanup failures',
              );
            throw error;
          } finally {
            console.info(
              'ISSUER_SCOPE_ITERATION',
              JSON.stringify({
                mode,
                shard,
                shards: issuerScopeShards,
                at: at ?? null,
                phase,
                elapsedMs: Date.now() - iterationStarted,
                primaryFailed,
                cleanupFailed,
              }),
            );
          }
        }
      }
      const count = await run();
      expect(count).toBeGreaterThan(1);
      const indices: number[] = [];
      for (let at = shard + 1; at <= count; at += issuerScopeShards) {
        indices.push(at);
        await run(at);
      }
      console.info(
        'ISSUER_SCOPE_SHARD',
        JSON.stringify({
          mode,
          shard,
          shards: issuerScopeShards,
          guardCount: count,
          indices,
          phase: 'complete',
          elapsedMs: Date.now() - started,
        }),
      );
    });
  }
}
