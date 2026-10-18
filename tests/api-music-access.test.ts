import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { ts } from 'ts-morph';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { musicModuleSource } from './helpers/api-music-source';
import { musicRequestFixture } from './helpers/api-music-request';

const resource = 'http://127.0.0.1:26539/mcp';
const source = {
  version: 1,
  items: Array.from({ length: 151 }, (_, i) => ({
    kind: i === 0 ? 'category' : 'song',
    id: i === 0 ? 'genres' : 'v' + String(i).padStart(10, '0'),
    title: `Owned ${i}`,
    artists: [],
    durationSeconds: null,
  })),
  shelves: [],
  continuation: null,
  targetRecipes: [
    {
      itemIndex: 0,
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'owned-recipe',
    },
  ],
};
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

async function fixture(
  rest = false,
  guard?: (kind: 'owner' | 'session' | 'resolver') => void,
) {
  const f = await musicRequestFixture();
  const m = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: f.ipcMain },
  );
  const g = m;
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-access-'));
  let now = Date.now(),
    ownerLive = true;
  const owner = {
    identity: {},
    current: () => {
      guard?.('owner');
      return ownerLive;
    },
  };
  const config = {
    enabled: true,
    musicApiEnabled: rest,
    hostname: rest ? '127.0.0.1' : '192.0.2.1',
    port: 26538,
    useHttps: false,
  };
  const store = new g.MusicGrantStore(path.join(folder, 'owned'), () => now);
  const grant = await store.issue(
    'Owned MCP',
    'mcp',
    resource,
    ['catalog.read', 'playback.read', 'library.read'],
    () => true,
  );
  let registered: any = owner;
  const releaseFixture = f.broker.retain();
  const runtime = {
    window: f.window,
    config,
    grants: store,
    broker: f.broker,
    now: () => now,
    resolveAccessOwner: (transport: string, audience: string) => {
      guard?.('resolver');
      return transport === 'mcp' && audience === resource
        ? registered
        : undefined;
    },
  };
  const service = m.createMusicService(runtime);
  const services = [service];
  const session = {
    id: 'session-a',
    current: () => {
      guard?.('session');
      return true;
    },
  };
  const invocation = (overrides: any = {}) => ({
    token: grant.token,
    transport: 'mcp',
    resource,
    signal: new AbortController().signal,
    session,
    ...overrides,
  });
  async function finish(pending: Promise<any>, value: any = source) {
    const before = f.sent.filter(
      (p) => p[0] === 'peard:music-owner-query',
    ).length;
    await expect
      .poll(
        () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
      )
      .toBeGreaterThan(before);
    f.ready();
    f.settled(undefined, { ok: true, value });
    return pending;
  }
  return {
    ...f,
    m,
    store,
    grant,
    service,
    config,
    owner,
    session,
    invocation,
    finish,
    ownerOff: () => {
      ownerLive = false;
    },
    ownerOn: () => {
      ownerLive = true;
    },
    register: (value: any) => {
      registered = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    restart() {
      const next = m.createMusicService(runtime);
      services.push(next);
      return next;
    },
    async close() {
      for (const owned of services) owned.stop();
      releaseFixture();
      f.broker.dispose();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test('access snapshots isolate transport resource owner and session identity without retaining invocation secrets', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-access.ts',
  );
  expect(typeof m.captureMusicAccess).toBe('function');
  const owner = { identity: {}, current: () => true },
    session = { id: 'same', current: () => true };
  const invocation = {
    token: 'private-token',
    transport: 'mcp',
    resource,
    signal: new AbortController().signal,
    session,
  };
  const a = m.captureMusicAccess(invocation, owner),
    b = m.captureMusicAccess(invocation, owner);
  expect(m.sameMusicAccess(a, b)).toBe(true);
  expect(
    m.sameMusicAccess(
      a,
      m.captureMusicAccess({ ...invocation, session: { ...session } }, owner),
    ),
  ).toBe(false);
  expect(
    m.sameMusicAccess(
      a,
      m.captureMusicAccess(invocation, { ...owner, identity: {} }),
    ),
  ).toBe(false);
  expect(
    m.sameMusicAccess(
      a,
      m.captureMusicAccess(
        { ...invocation, transport: 'rest', session: undefined },
        owner,
      ),
    ),
  ).toBe(false);
  expect(
    m.sameMusicAccess(
      a,
      m.captureMusicAccess(
        { ...invocation, resource: resource + '/other' },
        owner,
      ),
    ),
  ).toBe(false);
  expect(Object.isFrozen(a)).toBe(true);
  expect(Object.keys(a).sort()).toEqual([
    'owner',
    'resource',
    'session',
    'transport',
  ]);
  expect(JSON.stringify(a)).not.toContain('private-token');
});

test('same physical broker admits useful MCP current and 151 search with REST entirely unavailable', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.currentFor).toBe('function');
    const current = await f.finish(
      f.service.currentFor(f.invocation()),
      snapshot,
    );
    expect(current).toEqual(snapshot);
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
    );
    expect(first.items).toHaveLength(100);
    expect(first.items[0].reference).toMatch(/^mref_/);
    const second = await f.service.searchFor(f.invocation(), {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.items).toHaveLength(51);
    expect(second.nextCursor).toBeNull();
    expect(
      await f.service.searchFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).toEqual(second);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(2);
    expect(f.service.enabled).toBe(false);
    expect(f.m.getMusicService(f.window)).toBeUndefined();
    expect(f.service.captureNativeOwner().current()).toBe(false);
    for (const request of [
      () => f.service.current(f.grant.token),
      () => f.service.search(f.grant.token, { query: 'owned' }),
      () =>
        f.service.currentFor(
          f.invocation({ transport: 'rest', session: undefined }),
        ),
      () =>
        f.service.currentFor(
          f.invocation({
            transport: 'rest',
            resource: 'http://127.0.0.1:26538/api/v1/music',
            session: undefined,
          }),
        ),
    ]) {
      await expect(Promise.resolve().then(request)).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(2);
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    await f.close();
  }
});

test('foreign sessions and same-ID replacement cannot consume cursor or replay; issuer remains useful', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.searchFor).toBe('function');
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
    );
    for (const session of [
      { id: 'b', current: () => true },
      { ...f.session },
    ]) {
      await expect(
        f.service.searchFor(f.invocation({ session }), {
          cursor: first.nextCursor,
          limit: 100,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    const page = await f.service.searchFor(f.invocation(), {
      cursor: first.nextCursor,
      limit: 100,
    });
    await expect(
      f.service.searchFor(f.invocation({ session: { ...f.session } }), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await f.service.searchFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).toEqual(page);
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('unregistered retired and wrong owners resources transport or token acquire no broker work, then healthy owner succeeds', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.currentFor).toBe('function');
    for (const registered of [
      undefined,
      { identity: {}, current: () => false },
    ]) {
      f.register(registered);
      await expect(f.service.currentFor(f.invocation())).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
    f.register(f.owner);
    for (const overrides of [
      { resource: resource + '/wrong' },
      { transport: 'rest' },
      { token: 'legacy-id' },
    ]) {
      await expect(
        f.service.currentFor(f.invocation(overrides)),
      ).rejects.toHaveProperty('code');
    }
    expect(f.sent).toHaveLength(0);
    expect(
      await f.finish(f.service.currentFor(f.invocation()), snapshot),
    ).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('local wrappers and equivalent For invocation stay useful with REST enabled', async () => {
  const f = await fixture(true);
  try {
    const local = 'http://127.0.0.1:26538/api/v1/music';
    const grant = await f.store.issue(
      'Local',
      'rest',
      local,
      ['playback.read'],
      () => true,
    );
    expect(await f.finish(f.service.current(grant.token), snapshot)).toEqual(
      snapshot,
    );
    expect(typeof f.service.currentFor).toBe('function');
    expect(
      await f.finish(
        f.service.currentFor(
          f.invocation({
            token: grant.token,
            transport: 'rest',
            resource: local,
            session: undefined,
          }),
        ),
        snapshot,
      ),
    ).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('every shared reference lookup rejects foreign sessions before native work and preserves issuer use', async () => {
  const f = await fixture();
  try {
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
    );
    // Phase 1 deliberately keeps browseFor private; exercise the shared parsed catalog path.
    const input = {
      operation: 'browse',
      target: { kind: 'reference', id: first.items[0].reference },
      limit: 100,
    };
    for (const session of [
      { id: 'b', current: () => true },
      { ...f.session },
    ]) {
      await expect(
        f.service.catalogFor(f.invocation({ session }), input),
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(1);
    const page = await f.finish(f.service.catalogFor(f.invocation(), input));
    expect(page.items).toHaveLength(100);
    const sent = f.sent.filter((p) => p[0] === 'peard:music-read');
    expect(sent[1][1].input).toEqual({
      operation: 'browse',
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'owned-recipe',
    });
  } finally {
    await f.close();
  }
});

test('authorization waits fence stop configuration ABA frame expiry revoke and owner or session retirement before dispatch', async () => {
  for (const step of [1, 2]) {
    for (const retirement of [
      'stop',
      'config',
      'frame',
      'expiry',
      'revoke',
      'owner',
      'session',
    ]) {
      const f = await fixture();
      try {
        let release!: () => void,
          count = 0,
          waiting = false,
          sessionLive = true;
        const authorize = f.store.authorize.bind(f.store);
        f.store.authorize = async (...args: any[]) => {
          const value = await authorize(...args);
          if (++count === step)
            await new Promise<void>((r) => {
              release = r;
              waiting = true;
            });
          return value;
        };
        const pending = f.service
          .catalogFor(
            f.invocation({
              session: { id: 'auth', current: () => sessionLive },
            }),
            {
              operation: 'browse',
              target: { kind: 'playlist', id: 'WL' },
              limit: 100,
            },
          )
          .catch((e: any) => e.code);
        await expect.poll(() => waiting).toBe(true);
        if (retirement === 'stop') f.service.stop();
        if (retirement === 'config') {
          f.service.configure({ ...f.config, port: 26540 });
          f.service.configure(f.config);
        }
        if (retirement === 'frame') {
          f.contents.emit(
            'did-start-navigation',
            {},
            'https://music.youtube.com/',
            false,
            true,
          );
          f.contents.emit('did-navigate', {}, 'https://music.youtube.com/');
        }
        if (retirement === 'expiry') f.advance(24 * 60 * 60 * 1000 + 1);
        if (retirement === 'revoke')
          await f.store.revoke(f.grant.record.id, () => true);
        if (retirement === 'owner') f.ownerOff();
        if (retirement === 'session') sessionLive = false;
        release();
        expect(await pending).toBe('retired');
        expect(
          f.sent.filter((p) => p[0] === 'peard:music-owner-query'),
        ).toHaveLength(0);
        f.ownerOn();
        const healthy = retirement === 'stop' ? f.restart() : f.service;
        const grant = ['expiry', 'revoke'].includes(retirement)
          ? await f.store.issue(
              'Recovery',
              'mcp',
              resource,
              ['playback.read'],
              () => true,
            )
          : f.grant;
        expect(
          await f.finish(
            healthy.currentFor(f.invocation({ token: grant.token })),
            snapshot,
          ),
        ).toEqual(snapshot);
      } finally {
        await f.close();
      }
    }
  }
});

test('guard reentry and configuration ABA cannot authenticate old authority; healthy current owner recovers', async () => {
  const f = await fixture();
  try {
    let fired = false;
    const session = {
      id: 'reentrant',
      current: () => {
        if (!fired) {
          fired = true;
          f.service.configure({ ...f.config, port: 26540 });
          f.service.configure(f.config);
        }
        return true;
      },
    };
    await expect(
      f.service.currentFor(f.invocation({ session })),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.sent).toHaveLength(0);
    expect(
      await f.finish(f.service.currentFor(f.invocation()), snapshot),
    ).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('grant current guard reentry cannot publish an old invocation', async () => {
  const f = await fixture();
  try {
    let fired = false;
    const current = f.store.isCurrent.bind(f.store);
    f.store.isCurrent = (...args: any[]) => {
      const result = current(...args);
      if (!fired) {
        fired = true;
        f.service.configure(f.config);
      }
      return result;
    };
    await expect(f.service.currentFor(f.invocation())).rejects.toMatchObject({
      code: 'retired',
    });
    expect(f.sent).toHaveLength(0);
    expect(
      await f.finish(f.service.currentFor(f.invocation()), snapshot),
    ).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('captured owner identity cannot be rewritten by later owner-object mutation', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/music-access.ts',
  );
  const owner = { identity: {}, current: () => true };
  const invocation = {
    token: 'private-token',
    transport: 'mcp',
    resource,
    signal: new AbortController().signal,
  };
  const first = m.captureMusicAccess(invocation, owner);
  owner.identity = {};
  expect(
    m.sameMusicAccess(first, m.captureMusicAccess(invocation, owner)),
  ).toBe(false);
});

test('registered resource-owner replacement cannot inherit an existing cursor or replay', async () => {
  const f = await fixture();
  try {
    const first = await f.finish(
      f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
    );
    f.register({ identity: {}, current: () => true });
    await expect(
      f.service.searchFor(f.invocation(), {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(1);
    expect(
      (
        await f.finish(
          f.service.searchFor(f.invocation(), { query: 'owned', limit: 100 }),
        )
      ).items,
    ).toHaveLength(100);
  } finally {
    await f.close();
  }
});

test('reentrant session retirement before native acknowledgement prevents delivery and permits healthy follow-up', async () => {
  const f = await fixture();
  try {
    let armed = false;
    const session = {
      id: 'reentry',
      current: () => {
        if (armed) {
          armed = false;
          f.service.configure(f.config);
        }
        return true;
      },
    };
    const pending = f.service
      .currentFor(f.invocation({ session }))
      .catch((e: any) => e.code);
    await expect.poll(() => f.sent.length).toBe(1);
    armed = true;
    f.ready();
    expect(await pending).toBe('retired');
    expect(f.sent.filter((p) => p[0] === 'peard:music-read')).toHaveLength(0);
    expect(
      await f.finish(f.service.currentFor(f.invocation()), snapshot),
    ).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('retained access binding creates no closure in the invocation-bearing factory', async () => {
  const source = await readFile(
    path.resolve(
      import.meta.dirname,
      '../src/plugins/api-server/backend/music-access.ts',
    ),
    'utf8',
  );
  const file = ts.createSourceFile(
    'music-access.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const capture = file.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'captureMusicAccess',
  );
  expect(capture).toBeDefined();
  const closures: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    )
      closures.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild((capture as ts.FunctionDeclaration).body!, visit);
  expect(closures).toEqual([]);
});

for (const kind of ['owner', 'session'] as const) {
  test(`final ${kind} guards cannot replace the selected resource authority and publish old work`, async () => {
    const counts = { owner: 0, session: 0, resolver: 0 };
    const healthy = await fixture(false, (seen) => {
      counts[seen]++;
    });
    try {
      expect(
        await healthy.finish(
          healthy.service.currentFor(healthy.invocation()),
          snapshot,
        ),
      ).toEqual(snapshot);
    } finally {
      await healthy.close();
    }
    // Derive the final call positions from a real healthy public read, rather than
    // fixing a guard count that a valid fence refactor may change.
    expect(counts[kind]).toBeGreaterThan(2);
    for (let swapAt = counts[kind] - 2; swapAt <= counts[kind]; swapAt++) {
      let f: Awaited<ReturnType<typeof fixture>>,
        calls = 0,
        swapped = false;
      const replacement = { identity: {}, current: () => true };
      f = await fixture(false, (seen) => {
        if (seen === kind && ++calls === swapAt) {
          f.register(replacement);
          swapped = true;
        }
      });
      try {
        const pending = f.service.currentFor(f.invocation()).then(
          (value: unknown) => ({ value, code: 'success' }),
          (error: any) => ({ code: error.code }),
        );
        const result = await f.finish(pending, snapshot);
        expect(swapped).toBe(true);
        expect(result).toEqual({ code: 'retired' });
        expect(
          f.sent.filter((packet) => packet[0] === 'peard:music-read'),
        ).toHaveLength(1);
        expect(
          await f.finish(f.service.currentFor(f.invocation()), snapshot),
        ).toEqual(snapshot);
        expect(
          f.sent.filter((packet) => packet[0] === 'peard:music-read'),
        ).toHaveLength(2);
      } finally {
        await f.close();
      }
    }
  });
}

test('terminal resolver callout cannot bypass config frame stop or deadline retirement', async () => {
  let healthyCalls = 0;
  const healthy = await fixture(false, (kind) => {
    if (kind === 'resolver') healthyCalls++;
  });
  try {
    expect(
      await healthy.finish(
        healthy.service.currentFor(healthy.invocation()),
        snapshot,
      ),
    ).toEqual(snapshot);
  } finally {
    await healthy.close();
  }
  expect(healthyCalls).toBeGreaterThan(1);
  for (const retirement of ['config', 'frame', 'stop', 'deadline']) {
    let f: Awaited<ReturnType<typeof fixture>>,
      count = 0,
      fired = false;
    f = await fixture(false, (kind) => {
      if (kind !== 'resolver' || ++count !== healthyCalls) return;
      fired = true;
      if (retirement === 'config') {
        f.service.configure({ ...f.config, port: 26540 });
        f.service.configure(f.config);
      }
      if (retirement === 'frame') {
        f.contents.emit(
          'did-start-navigation',
          {},
          'https://music.youtube.com/',
          false,
          true,
        );
        f.contents.emit('did-navigate', {}, 'https://music.youtube.com/');
      }
      if (retirement === 'stop') f.service.stop();
      if (retirement === 'deadline') f.advance(5001);
    });
    try {
      const pending = f.service.currentFor(f.invocation()).then(
        (value: unknown) => ({ value, code: 'success' }),
        (error: any) => ({ code: error.code }),
      );
      expect(await f.finish(pending, snapshot)).toEqual({
        code: retirement === 'deadline' ? 'timeout' : 'retired',
      });
      expect(fired).toBe(true);
      f.register({ identity: {}, current: () => true });
      const service = retirement === 'stop' ? f.restart() : f.service;
      expect(
        await f.finish(service.currentFor(f.invocation()), snapshot),
      ).toEqual(snapshot);
      expect(
        f.sent.filter((packet) => packet[0] === 'peard:music-read'),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  }
});

for (const state of ['deadline-only', 'session-tombstone', 'configuration'])
  test(`R1 deadline initial callback ${state} does not re-enter authority`, async () => {
    let late = false;
    const unexpected: string[] = [];
    const f = await fixture(false, (kind) => {
      if (late) unexpected.push(kind);
    });
    const authorize = f.store.authorize.bind(f.store),
      original = globalThis.setTimeout;
    const callbacks: (() => void)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.store.authorize = async (...args: any[]) => {
      await gate;
      return authorize(...args);
    };
    try {
      let pending: Promise<any>;
      try {
        globalThis.setTimeout = ((callback: any, ...args: any[]) => {
          callbacks.push(callback);
          return (original as any)(callback, ...args);
        }) as any;
        pending = f.service
          .currentFor(f.invocation())
          .catch((error: any) => error.code);
      } finally {
        globalThis.setTimeout = original;
      }
      expect(callbacks).toHaveLength(1);
      f.advance(5000);
      if (state === 'session-tombstone') f.service.retireSession(f.session);
      if (state === 'configuration') f.service.configure(f.config);
      late = true;
      callbacks[0]();
      expect(await pending).toBe(
        state === 'deadline-only' ? 'timeout' : 'retired',
      );
      expect(unexpected).toEqual([]);
      expect(f.sent).toHaveLength(0);
      expect(f.service.sessionLeases.size).toBe(0);
    } finally {
      globalThis.setTimeout = original;
      late = false;
      release();
      await f.close();
    }
  });

for (const change of ['hidden-owner-replacement', 'committed-grant-revocation'])
  test(`R1 deadline ${change} preserves observed retirement without late probes`, async () => {
    let late = false;
    const unexpected: string[] = [];
    const f = await fixture(false, (kind) => {
      if (late) unexpected.push(kind);
    });
    const original = globalThis.setTimeout,
      callbacks: (() => void)[] = [];
    const current = f.store.isCurrent.bind(f.store),
      native = f.broker.isCurrent.bind(f.broker);
    f.store.isCurrent = (...args: any[]) => {
      if (late) unexpected.push('grant');
      return current(...args);
    };
    f.broker.isCurrent = (...args: any[]) => {
      if (late) unexpected.push('native');
      return native(...args);
    };
    try {
      let pending: Promise<any>;
      try {
        globalThis.setTimeout = ((callback: any, ...args: any[]) => {
          callbacks.push(callback);
          return (original as any)(callback, ...args);
        }) as any;
        pending = f.service
          .currentFor(f.invocation())
          .catch((error: any) => error.code);
        for (let turn = 0; turn < 100 && f.sent.length === 0; turn++)
          await Promise.resolve();
      } finally {
        globalThis.setTimeout = original;
      }
      expect(callbacks).toHaveLength(3);
      f.ready();
      const packet = f.challenge();
      f.advance(5000);
      late = true;
      if (change === 'hidden-owner-replacement')
        f.register({ identity: {}, current: () => true });
      if (change === 'committed-grant-revocation')
        await f.store.revoke(f.grant.record.id, () => true);
      callbacks[1]();
      expect(await pending).toBe(
        change === 'committed-grant-revocation' ? 'retired' : 'timeout',
      );
      expect(unexpected).toEqual([]);
      expect(f.broker.stats().dispatched).toBe(1);
      f.settled(packet, { ok: true, value: snapshot });
      expect(f.broker.stats().dispatched).toBe(0);
      late = false;
      f.register(f.owner);
      const next = await f.store.issue(
        'Fresh recovery',
        'mcp',
        resource,
        ['playback.read'],
        () => true,
      );
      expect(
        await f.finish(
          f.service.currentFor(f.invocation({ token: next.token })),
          snapshot,
        ),
      ).toEqual(snapshot);
    } finally {
      globalThis.setTimeout = original;
      late = false;
      await f.close();
    }
  });

for (const typed of ['timeout', 'retired'])
  test(`R1 deadline typed ${typed} abort wins over subsequent state change`, async () => {
    const f = await fixture();
    try {
      const canceled = new AbortController();
      canceled.abort();
      const reason = await f.service
        .currentFor(
          f.invocation(typed === 'retired' ? { signal: canceled.signal } : {}),
          typed === 'timeout' ? f.service.now() : undefined,
        )
        .catch((error: any) => error);
      expect(reason.code).toBe(typed);
      const controller = new AbortController(),
        pending = f.service
          .currentFor(f.invocation({ signal: controller.signal }))
          .catch((error: any) => error.code);
      await expect.poll(() => f.sent.length).toBe(1);
      f.ready();
      const packet = f.challenge();
      controller.abort(reason);
      if (typed === 'timeout') f.service.retireSession(f.session);
      else f.advance(5001);
      expect(await pending).toBe(typed);
      f.settled(packet, { ok: true, value: snapshot });
      expect(f.broker.stats().dispatched).toBe(0);
      const session = { id: 'typed-recovery', current: () => true };
      expect(
        await f.finish(
          f.service.currentFor(f.invocation({ session })),
          snapshot,
        ),
      ).toEqual(snapshot);
    } finally {
      await f.close();
    }
  });

test('R1 deadline captured REST listener abort retires without a late listener query', async () => {
  const f = await fixture(true);
  const controller = new AbortController();
  let late = false,
    queries = 0;
  const audience = f.service.resource;
  const listener = {
    identity: {},
    address: '127.0.0.1',
    port: 26538,
    tls: false,
    resources: { local: audience },
    signal: controller.signal,
    ownsSocket: () => true,
    current: () => true,
  };
  f.service.runtime.restListenerOwner = () => {
    if (late) queries++;
    return listener;
  };
  try {
    const grant = await f.store.issue(
      'REST listener',
      'rest',
      audience,
      ['playback.read'],
      () => true,
    );
    const pending = f.service
      .current(grant.token)
      .catch((error: any) => error.code);
    await expect.poll(() => f.sent.length).toBe(1);
    f.ready();
    const packet = f.challenge();
    f.advance(5000);
    late = true;
    controller.abort();
    expect(await pending).toBe('retired');
    expect(queries).toBe(0);
    f.settled(packet, { ok: true, value: snapshot });
    expect(f.broker.stats().dispatched).toBe(0);
  } finally {
    late = false;
    await f.close();
  }
});
