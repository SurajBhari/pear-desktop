import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';

const paths = [
  'src/plugins/api-server/music-types.ts',
  'src/plugins/api-server/backend/music-service.ts',
  'src/plugins/api-server/backend/music-grant-store.ts',
  'src/plugins/api-server/backend/music-read-result.ts',
  'src/plugins/api-server/backend/mcp-tools.ts',
];
const videoId = 'abcdefghijk';
const snapshot = {
  version: 1,
  playbackEpoch: '1'.repeat(32) + ':' + '2'.repeat(32),
  current: null,
  state: 'stopped',
  elapsedSeconds: null,
  elapsedMilliseconds: null,
  durationSeconds: null,
  volume: null,
};
async function fixture() {
  const m = await musicModuleSource(paths);
  const owner = {
    identity: {},
    signal: new AbortController().signal,
    current: () => true,
  };
  const sourceController = new AbortController();
  const source = {
    epoch: '1'.repeat(32),
    retirementSignal: sourceController.signal,
    current: () => !sourceController.signal.aborted,
  };
  const admission = {};
  const responses: any[] = [],
    reads: any[] = [];
  const owners = new WeakMap<object, any>();
  const broker = {
    retain: () => () => {},
    subscribeRetirement: () => () => {},
    capture: () => admission,
    isCurrent: (value: unknown) => value === admission,
    read: async (_a: unknown, input: unknown) => {
      reads.push(input);
      const value = responses.shift();
      if (!value) throw Error('unscripted source');
      if (!owners.has(value)) owners.set(value, source);
      return value;
    },
    resultOwner: (value: object) => owners.get(value),
  };
  let contents: string | null = null;
  const store = new m.MusicGrantStore('/owned-virtual', Date.now, {
    read: async () => ({ contents, binding: 'owned' }),
    stage: async (_d: string, next: string) => ({
      commit: async () => {
        contents = next;
        return 'owned';
      },
      close: async () => {},
    }),
  });
  const resource = 'http://127.0.0.1:26539/mcp';
  const grant = await store.issue(
    'Owned budget',
    'mcp',
    resource,
    [
      'playback.read',
      'catalog.read',
      'personalized.read',
      'library.read',
      'comments.read',
    ],
    () => true,
  );
  const service = m.createMusicService({
    window: {},
    config: {
      enabled: true,
      musicApiEnabled: false,
      hostname: '127.0.0.1',
      port: 26538,
    },
    grants: store,
    broker,
    resolveAccessOwner: () => owner,
  });
  const session = {
    id: 'owned',
    signal: new AbortController().signal,
    current: () => true,
  };
  const controller = new AbortController();
  const invocation = {
    token: grant.token,
    transport: 'mcp',
    resource,
    signal: controller.signal,
    session,
  };
  return {
    m,
    service,
    store,
    grant,
    source,
    sourceController,
    owners,
    owner,
    session,
    controller,
    invocation,
    responses,
    reads,
    close: () => service.stop(),
  };
}

test('required synchronous encoder transforms inside the actual service lease', async () => {
  const f = await fixture();
  try {
    f.responses.push(snapshot);
    expect(
      await f.service.currentFor(f.invocation, undefined, () => 'owned'),
    ).toBe('owned');
  } finally {
    f.close();
  }
});

test('bad thenable encoders are rejected without any then access or assimilation', async () => {
  const f = await fixture();
  let thenReads = 0;
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      thenReads++;
      throw Error('then accessed');
    },
  });
  try {
    for (const bad of [
      () => Promise.resolve('owned'),
      () => thenable,
      () => new String('owned'),
    ]) {
      f.responses.push(snapshot);
      await expect(
        f.service.currentFor(f.invocation, undefined, bad),
      ).rejects.toMatchObject({ code: 'source' });
    }
    expect(thenReads).toBe(0);
  } finally {
    f.close();
  }
});

test('first typed abort wins over encode failure and synchronous session retirement', async () => {
  for (const mode of ['throw', 'nonstring', 'budget', 'session']) {
    const f = await fixture();
    try {
      f.responses.push(snapshot);
      const first = new f.m.MusicServiceError('timeout');
      await expect(
        f.service.currentFor(f.invocation, undefined, () => {
          if (mode === 'session') {
            f.service.retireSession(f.session);
            return 'owned';
          }
          f.controller.abort(first);
          if (mode === 'throw') throw new Error('private');
          return mode === 'budget' ? 'x'.repeat(262145) : {};
        }),
      ).rejects.toMatchObject({
        code: mode === 'session' ? 'retired' : 'timeout',
      });
    } finally {
      f.close();
    }
  }
});

test('valid escaped lyrics overflow logical bytes while ordinary current stays parser bounded', async () => {
  const f = await fixture();
  try {
    f.responses.push({
      version: 1,
      binding: { videoId, playbackEpoch: null },
      lyrics: {
        videoId,
        available: true,
        lyrics: '\u0001'.repeat(65536),
        source: null,
      },
    });
    await expect(
      f.service.lyricsFor(
        f.invocation,
        { videoId },
        undefined,
        f.m.encodeMusicReadSuccess,
      ),
    ).rejects.toMatchObject({ code: 'budget' });
    f.responses.push(snapshot);
    expect(await f.service.currentFor(f.invocation)).toEqual(snapshot);
  } finally {
    f.close();
  }
});

test('fixed codec measures full escaped and multibyte envelope and rejects unsafe decode', async () => {
  const m = await musicModuleSource(paths);
  for (const text of ['quote"\\\n', '界🌍e\u0301', null]) {
    const value = {
      videoId,
      available: text !== null,
      lyrics: text,
      source: null,
    };
    const encoded = m.encodeMusicReadSuccess(value);
    const decoded = m.decodeMusicReadResult(encoded);
    expect(decoded.structuredContent).toEqual(value);
    expect(JSON.stringify(decoded)).toBe(encoded);
    expect(Buffer.byteLength(encoded)).toBe(
      Buffer.byteLength(JSON.stringify(value)) + 73,
    );
  }
  for (const invalid of [
    '{"structuredContent":{},"content":[{"type":"text","text":"Music result."}]}',
    '{}',
    ' {"content":[]}',
    '{"content":[],"structuredContent":[]}',
  ])
    expect(m.decodeMusicReadResult(invalid).structuredContent.error.code).toBe(
      'source',
    );
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error('private');
      },
    },
  );
  expect(m.musicReadFailure(hostile).structuredContent.error.code).toBe(
    'source',
  );
  expect(
    m.musicReadFailure(
      Object.assign(new Error('private'), { code: 'forbidden' }),
    ).structuredContent.error.code,
  ).toBe('source');
});

// Boundary data stays within existing item/comment parser limits; all output
// growth comes from valid fields plus final owned references/cursors.
function calibratedPage(kind: string) {
  const item = (i: number) => ({
    kind: kind === 'catalog' ? 'category' : 'song',
    id: kind === 'catalog' ? 'explore' : 'v' + String(i).padStart(10, '0'),
    title: 'T'.repeat(250),
    artists: Array.from({ length: 8 }, () => ({ name: 'A'.repeat(256) })),
    durationSeconds: null,
  });
  const items = Array.from({ length: 100 }, (_, i) => item(i));
  const comments = Array.from({ length: 100 }, (_, i) => ({
    id: 'c' + i,
    author: null,
    text: 'T'.repeat(2000),
    publishedTime: null,
    likeCount: null,
    replyCount: null,
    pinned: false,
    verified: false,
    creator: false,
  }));
  const binding = { videoId, playbackEpoch: null };
  const source =
    kind === 'comments'
      ? {
          version: 1,
          binding,
          requests: 1,
          comments: {
            available: true,
            comments,
            commentCount: null,
            continuation: null,
          },
        }
      : kind === 'queue'
        ? { version: 1, queueRevision: 'a'.repeat(32), selectedIndex: 5, items }
        : {
            version: 1,
            items,
            shelves: [],
            continuation: null,
            targetRecipes: items.map((_, itemIndex) => ({
              itemIndex,
              browseId: 'FEmusic_explore',
            })),
          };
  const candidate = () =>
    kind === 'comments'
      ? {
          version: 1,
          videoId,
          sort: 'top',
          source: 'music',
          available: true,
          comments,
          commentCount: null,
          nextCursor: null,
        }
      : kind === 'queue'
        ? {
            version: 1,
            queueRevision: 'a'.repeat(32),
            total: 100,
            selectedIndex: 5,
            items: items.map((value, index) => ({
              index,
              selected: index === 5,
              item: value,
            })),
            nextCursor: null,
          }
        : {
            version: 1,
            availability: 'supported',
            items: items.map((value) => ({
              ...value,
              reference: 'mref_' + 'x'.repeat(43),
            })),
            shelves: [],
            nextCursor: null,
          };
  let remaining = 262100 - Buffer.byteLength(JSON.stringify(candidate()));
  expect(remaining).toBeGreaterThanOrEqual(0);
  for (const row of kind === 'comments' ? comments : items) {
    if ('text' in row) {
      const take = Math.min(remaining, 4096 - row.text.length);
      row.text += 'P'.repeat(take);
      remaining -= take;
    } else {
      const take = Math.min(remaining, 512 - row.title.length);
      row.title += 'P'.repeat(take);
      remaining -= take;
    }
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(candidate()))).toBe(262100);
  return source;
}
for (const kind of ['catalog', 'queue', 'comments']) {
  test(`${kind} reserves final logical wrapper and retains remainder/replay freshness`, async () => {
    const f = await fixture();
    try {
      const source = calibratedPage(kind);
      const call = (args: unknown) =>
        kind === 'catalog'
          ? f.service.homeFor(
              f.invocation,
              args,
              undefined,
              f.m.encodeMusicReadSuccess,
            )
          : kind === 'queue'
            ? f.service.queueFor(
                f.invocation,
                args,
                undefined,
                f.m.encodeMusicReadSuccess,
              )
            : f.service.commentsFor(
                f.invocation,
                args,
                undefined,
                f.m.encodeMusicReadSuccess,
              );
      f.responses.push(source);
      const first = f.m.decodeMusicReadResult(
        await call(
          kind === 'comments' ? { videoId, limit: 100 } : { limit: 100 },
        ),
      );
      const data = first.structuredContent;
      const rows = kind === 'comments' ? data.comments : data.items;
      expect(rows.length).toBeLessThan(100);
      expect(data.nextCursor).toBeTruthy();
      const args = { cursor: data.nextCursor, limit: 100 };
      const before = f.reads.length;
      if (kind === 'queue') f.responses.push(source);
      const second = await call(args);
      if (kind === 'queue') f.responses.push(source);
      expect(await call(args)).toBe(second);
      const next = f.m.decodeMusicReadResult(second).structuredContent;
      expect(
        rows.length + (kind === 'comments' ? next.comments : next.items).length,
      ).toBe(100);
      expect(next.nextCursor).toBeNull();
      expect(f.reads.length - before).toBe(kind === 'queue' ? 2 : 0);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
        262144,
      );
      if (kind === 'queue') {
        f.responses.push({ ...source, queueRevision: 'b'.repeat(32) });
        await expect(call(args)).rejects.toMatchObject({ code: 'retired' });
      }
    } finally {
      f.close();
    }
  });
}

test('current-bound comment replay retains its required metadata probes', async () => {
  const f = await fixture();
  const binding = { videoId, playbackEpoch: snapshot.playbackEpoch };
  const comment = (id: string) => ({
    id,
    author: null,
    text: 'Literal',
    publishedTime: null,
    likeCount: null,
    replyCount: null,
    pinned: false,
    verified: false,
    creator: false,
  });
  try {
    f.responses.push({
      version: 1,
      binding,
      requests: 1,
      comments: {
        available: true,
        comments: [comment('a'), comment('b')],
        commentCount: null,
        continuation: null,
      },
    });
    const first = await f.service.commentsFor(f.invocation, {
      current: true,
      limit: 1,
    });
    f.responses.push({ version: 1, binding });
    const second = await f.service.commentsFor(f.invocation, {
      cursor: first.nextCursor,
      limit: 1,
    });
    f.responses.push({ version: 1, binding });
    expect(
      await f.service.commentsFor(f.invocation, {
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).toEqual(second);
    expect(
      f.reads.filter((read) => read.operation === 'metadata-current'),
    ).toHaveLength(2);
    expect(
      f.reads.filter((read) => read.operation === 'comments-continuation'),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('encoded cached and fresh source signals retire before publication', async () => {
  for (const method of ['currentFor', 'homeFor']) {
    const f = await fixture();
    try {
      const value =
        method === 'currentFor'
          ? snapshot
          : {
              version: 1,
              items: [],
              shelves: [],
              continuation: null,
              targetRecipes: [],
            };
      f.responses.push(value);
      const encode = (data: any) => {
        f.sourceController.abort();
        return f.m.encodeMusicReadSuccess(data);
      };
      const pending =
        method === 'currentFor'
          ? f.service.currentFor(f.invocation, undefined, encode)
          : f.service.homeFor(f.invocation, {}, undefined, encode);
      await expect(pending).rejects.toMatchObject({ code: 'retired' });
    } finally {
      f.close();
    }
  }
});

for (const kind of ['catalog', 'queue', 'comments'])
  for (const replay of [false, true]) {
    test(`${kind} ${replay ? 'replay' : 'remainder'} retains captured source signal through encoding`, async () => {
      const f = await fixture();
      const item = {
        kind: 'song',
        id: videoId,
        title: 'Owned',
        artists: [],
        durationSeconds: null,
      };
      const comment = (id: string) => ({
        id,
        author: null,
        text: 'Owned',
        publishedTime: null,
        likeCount: null,
        replyCount: null,
        pinned: false,
        verified: false,
        creator: false,
      });
      const value =
        kind === 'queue'
          ? {
              version: 1,
              queueRevision: 'a'.repeat(32),
              selectedIndex: 0,
              items: [item, item],
            }
          : kind === 'comments'
            ? {
                version: 1,
                binding: { videoId, playbackEpoch: null },
                requests: 1,
                comments: {
                  available: true,
                  comments: [comment('a'), comment('b')],
                  commentCount: null,
                  continuation: null,
                },
              }
            : {
                version: 1,
                items: [item, item],
                shelves: [],
                continuation: null,
                targetRecipes: [],
              };
      const read = (args: unknown) =>
        kind === 'queue'
          ? f.service.queueFor(f.invocation, args)
          : kind === 'comments'
            ? f.service.commentsFor(f.invocation, args)
            : f.service.homeFor(f.invocation, args);
      try {
        f.responses.push(value);
        const first = await read(
          kind === 'comments' ? { videoId, limit: 1 } : { limit: 1 },
        );
        const args = { cursor: first.nextCursor, limit: 1 };
        if (replay) {
          if (kind === 'queue') f.responses.push(value);
          await read(args);
        }
        const before = f.reads.length;
        if (kind === 'queue') f.responses.push(value);
        const encode = (data: any) => {
          f.sourceController.abort();
          return f.m.encodeMusicReadSuccess(data);
        };
        const pending =
          kind === 'queue'
            ? f.service.queueFor(f.invocation, args, undefined, encode)
            : kind === 'comments'
              ? f.service.commentsFor(f.invocation, args, undefined, encode)
              : f.service.homeFor(f.invocation, args, undefined, encode);
        await expect(pending).rejects.toMatchObject({ code: 'retired' });
        expect(f.reads.length - before).toBe(kind === 'queue' ? 1 : 0);
      } finally {
        f.close();
      }
    });
  }

for (const retireOrigin of [true, false])
  test(`reference origin and fresh source both survive to final encoded fence: ${retireOrigin}`, async () => {
    const f = await fixture();
    const freshController = new AbortController();
    const freshOwner = {
      epoch: '1'.repeat(32) + ':' + '3'.repeat(32),
      retirementSignal: freshController.signal,
      current: () => !freshController.signal.aborted,
    };
    try {
      f.responses.push({
        version: 1,
        items: [
          {
            kind: 'category',
            id: 'explore',
            title: 'Owned',
            artists: [],
            durationSeconds: null,
          },
        ],
        shelves: [],
        continuation: null,
        targetRecipes: [{ itemIndex: 0, browseId: 'FEmusic_explore' }],
      });
      const page = await f.service.homeFor(f.invocation, {});
      const value = {
        version: 1,
        items: [],
        shelves: [],
        continuation: null,
        targetRecipes: [],
      };
      f.owners.set(value, freshOwner);
      f.responses.push(value);
      const encode = (data: any) => {
        (retireOrigin ? f.sourceController : freshController).abort();
        return f.m.encodeMusicReadSuccess(data);
      };
      await expect(
        f.service.browseFor(
          f.invocation,
          { target: { kind: 'reference', id: page.items[0].reference } },
          undefined,
          encode,
        ),
      ).rejects.toMatchObject({ code: 'retired' });
    } finally {
      f.close();
    }
  });

test('source retirement during error inspection or throwing final access guard denies encoded data', async () => {
  for (const mode of ['inspection', 'final']) {
    const f = await fixture();
    let armed = false;
    try {
      if (mode === 'final')
        f.owner.current = () => {
          if (armed) {
            f.sourceController.abort();
            throw Error('owned guard');
          }
          return true;
        };
      f.responses.push(snapshot);
      await expect(
        f.service.currentFor(f.invocation, undefined, () => {
          if (mode === 'inspection')
            throw new Proxy(
              {},
              {
                getPrototypeOf() {
                  f.sourceController.abort();
                  throw Error('owned inspection');
                },
              },
            );
          armed = true;
          return 'owned';
        }),
      ).rejects.toMatchObject({ code: 'retired' });
    } finally {
      f.close();
    }
  }
});

test('owned read delivery keeps original source and grant lifetimes after the service lease ends', async () => {
  const f = await fixture();
  f.responses.push(snapshot);
  let witness: any;
  const result = await f.m
    .createMcpReadToolRegistry(f.service)
    .callOwned('music_now_playing', {}, f.invocation, {
      capture(value: unknown) {
        witness = value;
        return true;
      },
    });
  expect(result.isError).toBeUndefined();
  expect(witness.ready()).toBe(true);
  expect(witness.current()).toBe(true);
  f.sourceController.abort();
  expect(witness.current()).toBe(false);
  f.service.stop();
});

test('owned read delivery retires on committed revoke and refuses asynchronous capture', async () => {
  for (const asynchronous of [false, true]) {
    const f = await fixture();
    f.responses.push(snapshot);
    let witness: any;
    const result = await f.m
      .createMcpReadToolRegistry(f.service)
      .callOwned('music_now_playing', {}, f.invocation, {
        capture(value: unknown) {
          witness = value;
          return asynchronous ? Promise.resolve(true) : true;
        },
      });
    if (asynchronous) expect(result.isError).toBe(true);
    else {
      expect(result.isError).toBeUndefined();
      await f.store.revoke(f.grant.record.id, () => true);
      expect(witness.current()).toBe(false);
    }
    f.service.stop();
  }
});
