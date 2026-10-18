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
  progress?: (phase: string) => void,
) {
  progress?.('broker-bundle:begin');
  const f = await musicRequestFixture();
  progress?.('broker-bundle:end');
  progress?.('service-bundle:begin');
  const m = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: f.ipcMain },
  );
  progress?.('service-bundle:end');
  const g = m;
  progress?.('grant-directory:begin');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-access-'));
  progress?.('grant-directory:end');
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
  progress?.('grant-issue:begin');
  const grant = await store.issue(
    'Owned MCP',
    'mcp',
    resource,
    [
      'catalog.read',
      'playback.read',
      'library.read',
      'playback.control',
      'queue.write',
    ],
    () => true,
  );
  progress?.('grant-issue:end');
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
    progress?.('finish-query:begin');
    await expect
      .poll(
        () => f.sent.filter((p) => p[0] === 'peard:music-owner-query').length,
      )
      .toBeGreaterThan(before);
    progress?.('finish-query:end');
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

const commands = [
  {
    method: 'navigateFor',
    command: { action: 'play_song', videoId: 'abcdefghijk' },
    value: { version: 1, phase: 'owned_dispatch' },
    meaning: 'owned_navigation_dispatch',
  },
  {
    method: 'controlFor',
    command: { action: 'pause' },
    value: { version: 1, phase: 'owned_control_dispatch' },
    meaning: 'owned_control_dispatch',
  },
  {
    method: 'mutateQueueFor',
    command: { action: 'enqueue_song', videoId: 'abcdefghijk' },
    value: { version: 1, phase: 'owned_queue_dispatch', count: 1 },
    meaning: 'owned_queue_dispatch',
  },
];
const queries = (f: any) =>
  f.sent.filter((p: any[]) => p[0] === 'peard:music-owner-query');
const outcome = (p: Promise<any>) =>
  p.then(
    (value) => ({ value, code: 'success' }),
    (e: any) => ({ code: e.code }),
  );
async function start(
  f: any,
  pending: Promise<any>,
  count = queries(f).length + 1,
) {
  await expect.poll(() => queries(f).length).toBe(count);
  f.ready(f.challenge(count - 1));
  await expect
    .poll(() => f.sent.filter((p: any[]) => p[0] === 'peard:music-read').length)
    .toBe(count);
  return { pending, packet: f.challenge(count - 1) };
}
async function healthy(
  f: any,
  session = { id: 'healthy', current: () => true },
) {
  return f.finish(f.service.currentFor(f.invocation({ session })), snapshot);
}
// Shared deadline tests keep actual IPC accounting while deferring its logical result.
async function deadlineReceipt(rest = false) {
  const f = await fixture(rest);
  const grant = rest
    ? await f.store.issue(
        'Deadline REST',
        'rest',
        f.service.resource,
        ['playback.control'],
        () => true,
      )
    : f.grant;
  const invocation = f.invocation({ token: grant.token });
  const command = { action: 'play_song', videoId: 'abcdefghijk' };
  const prepared = rest
    ? await f.service.prepare(grant.token, command)
    : await f.service.prepareFor(invocation, command);
  const input = { ...command, operationId: prepared.operationId };
  return {
    ...f,
    grant,
    prepared,
    input,
    execute: (deadline?: number, signal?: AbortSignal) =>
      rest
        ? f.service.navigate(grant.token, input, signal, deadline)
        : f.service.navigateFor(
            { ...invocation, ...(signal ? { signal } : {}) },
            input,
            deadline,
          ),
    status: () =>
      rest
        ? f.service.operation(grant.token, prepared.operationId)
        : f.service.operationFor(invocation, prepared.operationId),
  };
}

for (const rest of [false, true])
  for (const elapsed of [10000, 10001])
    test(`R1 deadline-only ${rest ? 'REST' : 'MCP'} lost ACK at ${elapsed} keeps uncertainty and physical accounting`, async () => {
      const f = await deadlineReceipt(rest);
      const read = f.broker.read.bind(f.broker);
      let rejectLogical!: (error: Error) => void,
        calls = 0;
      f.broker.read = (...args: any[]) => {
        calls++;
        read(...args).catch(() => {});
        return new Promise((_resolve, reject) => {
          rejectLogical = reject;
        });
      };
      try {
        const deadline = f.service.now() + 10000,
          pending = outcome(f.execute(deadline));
        const { packet } = await start(f, pending);
        const row = f.service.operations.rows.get(f.prepared.operationId);
        expect(f.broker.stats().dispatched).toBe(1);
        f.advance(elapsed);
        rejectLogical(Error('Logical ACK lost at the owned deadline'));
        expect((await pending).code).toBe('timeout');
        const receipt = {
          operationId: f.prepared.operationId,
          status: 'uncertain',
          error: 'outcome_unknown',
        };
        expect(row.physicalHold).toBe(true);
        expect(await f.status()).toEqual(receipt);
        expect(await f.execute()).toEqual(receipt);
        expect(calls).toBe(1);
        expect(f.broker.stats().dispatched).toBe(1);
        f.settled(packet, {
          ok: true,
          value: { version: 1, phase: 'owned_dispatch' },
        });
        expect(f.broker.stats().dispatched).toBe(0);
        expect(row.physicalHold).toBe(false);
        expect(await f.status()).toEqual(receipt);
        expect(await f.execute()).toEqual(receipt);
        expect(calls).toBe(1);
        expect(f.service.sessionLeases.size).toBe(0);
      } finally {
        f.broker.read = read;
        await f.close();
      }
    });

test('R1 deadline-only completed authorization cannot enter the broker', async () => {
  const f = await deadlineReceipt();
  const authorize = f.store.authorize.bind(f.store);
  try {
    f.store.authorize = async (...args: any[]) => {
      const principal = await authorize(...args);
      f.advance(10000);
      return principal;
    };
    expect((await outcome(f.execute(f.service.now() + 10000))).code).toBe(
      'timeout',
    );
    expect(queries(f)).toHaveLength(0);
    f.store.authorize = authorize;
    expect(await f.status()).toEqual(f.prepared);
    expect(f.service.sessionLeases.size).toBe(0);
  } finally {
    await f.close();
  }
});

for (const state of [
  'deadline-only',
  'expired-principal',
  'createdAt-rollback',
  'grant-timer-early',
  'equal-expiry',
  'native-signal',
  'session-tombstone',
])
  test(`R1 deadline final callback classifies ${state} without late probes`, async () => {
    const f = await fixture();
    const callbacks: (() => void)[] = [],
      original = globalThis.setTimeout;
    let pending: Promise<any> | undefined,
      late = false;
    const forbidden: string[] = [];
    try {
      if (state === 'expired-principal')
        f.advance(f.grant.record.expiresAt - f.service.now() - 10001);
      if (state === 'grant-timer-early')
        f.advance(f.grant.record.expiresAt - f.service.now() - 1000);
      if (state === 'equal-expiry')
        f.advance(f.grant.record.expiresAt - f.service.now() - 10000);
      const prepared = await f.service.prepareFor(f.invocation(), {
        action: 'pause',
      });
      const current = f.store.isCurrent.bind(f.store);
      f.store.isCurrent = (...args: any[]) => {
        if (late) forbidden.push('grant');
        return current(...args);
      };
      for (const [target, key, name] of [
        [f.broker, 'isCurrent', 'broker'],
        [f.service.runtime, 'resolveAccessOwner', 'resolver'],
        [f.owner, 'current', 'owner'],
        [f.session, 'current', 'session'],
      ] as any[]) {
        const originalGuard = target[key].bind(target);
        target[key] = (...args: any[]) => {
          if (late) forbidden.push(name);
          return originalGuard(...args);
        };
      }
      try {
        globalThis.setTimeout = ((callback: any, ...args: any[]) => {
          callbacks.push(callback);
          return (original as any)(callback, ...args);
        }) as any;
        pending = outcome(
          f.service.controlFor(
            f.invocation(),
            { action: 'pause', operationId: prepared.operationId },
            f.service.now() + 10000,
          ),
        );
        for (let turn = 0; turn < 100 && queries(f).length === 0; turn++)
          await Promise.resolve();
      } finally {
        globalThis.setTimeout = original;
      }
      expect(queries(f)).toHaveLength(1);
      expect(callbacks).toHaveLength(3); // admission, principal and existing broker lifetime
      f.ready();
      const packet = f.challenge();
      if (state === 'createdAt-rollback')
        f.advance(f.grant.record.createdAt - f.service.now() - 1);
      else if (state !== 'grant-timer-early')
        f.advance(state === 'expired-principal' ? 10001 : 10000);
      if (state === 'native-signal')
        f.contents.emit(
          'did-start-navigation',
          {},
          'https://music.youtube.com/',
          false,
          true,
        );
      if (state === 'session-tombstone') f.service.retireSession(f.session);
      late = true;
      callbacks[1]();
      expect((await pending).code).toBe(
        state === 'deadline-only' ? 'timeout' : 'retired',
      );
      expect(forbidden).toEqual([]);
      expect(f.broker.stats().dispatched).toBe(1);
      f.settled(packet, {
        ok: true,
        value: { version: 1, phase: 'owned_control_dispatch' },
      });
      expect(f.broker.stats().dispatched).toBe(0);
    } finally {
      globalThis.setTimeout = original;
      late = false;
      await f.close();
    }
  });

test('R1 deadline inner negative observation cannot become outer ABA success', async () => {
  const callbacks: string[] = [];
  let observed = false,
    armed = false;
  const f = await fixture(false, (kind) => {
    if (observed) callbacks.push(kind);
  });
  const read = f.broker.read.bind(f.broker),
    owner = f.owner.current.bind(f.owner);
  let settle: (() => void) | undefined;
  try {
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    f.owner.current = () => {
      if (armed) {
        armed = false;
        observed = true;
        return false;
      }
      return owner();
    };
    f.broker.read = (_a: any, _i: any, _p: any, options: any) => {
      armed = true;
      expect(options.isCurrent()).toBe(false);
      settle = () => options.onPhysicalSettled('authenticated_ack');
      return Promise.reject(Error('Inner owned guard rejected once'));
    };
    const result = await outcome(
      f.service.controlFor(f.invocation(), {
        action: 'pause',
        operationId: prepared.operationId,
      }),
    );
    expect(observed).toBe(true);
    expect(result.code).toBe('retired');
    expect(callbacks).toEqual([]);
    expect(
      f.service.operations.rows.get(prepared.operationId).receipt,
    ).toMatchObject({ status: 'uncertain', error: 'outcome_unknown' });
    expect(queries(f)).toHaveLength(0);
    settle!();
    observed = false;
    f.broker.read = read;
    f.owner.current = owner;
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    observed = false;
    f.broker.read = read;
    await f.close();
  }
});

for (const kind of ['native', 'resolver', 'owner', 'session', 'grant'])
  test(`R1 deadline observed negative ${kind} beats simultaneous clock crossing`, async () => {
    let observed = false,
      armed = false;
    const after: string[] = [];
    const f = await fixture(false, (call) => {
      if (observed) after.push(call);
    });
    const [target, key] =
      kind === 'native'
        ? [f.broker, 'isCurrent']
        : kind === 'resolver'
          ? [f.service.runtime, 'resolveAccessOwner']
          : kind === 'owner'
            ? [f.owner, 'current']
            : kind === 'session'
              ? [f.session, 'current']
              : [f.store, 'isCurrent'];
    const original = target[key].bind(target),
      read = f.broker.read.bind(f.broker);
    let settle: (() => void) | undefined;
    try {
      const prepared = await f.service.prepareFor(f.invocation(), {
        action: 'pause',
      });
      target[key] = (...args: any[]) => {
        if (armed) {
          armed = false;
          observed = true;
          f.advance(10000);
          return kind === 'resolver'
            ? { identity: {}, current: () => true }
            : false;
        }
        return original(...args);
      };
      f.broker.read = (_a: any, _i: any, _p: any, options: any) => {
        armed = true;
        expect(options.isCurrent()).toBe(false);
        settle = () => options.onPhysicalSettled('authenticated_ack');
        return Promise.reject(Error('Observed terminal negative at deadline'));
      };
      const result = await outcome(
        f.service.controlFor(f.invocation(), {
          action: 'pause',
          operationId: prepared.operationId,
        }),
      );
      expect(observed).toBe(true);
      expect(result.code).toBe('retired');
      expect(after).toEqual([]);
      expect(queries(f)).toHaveLength(0);
      expect(
        f.service.operations.rows.get(prepared.operationId).physicalHold,
      ).toBe(true);
      settle!();
      observed = false;
      target[key] = original;
      f.broker.read = read;
      expect(await healthy(f)).toEqual(snapshot);
    } finally {
      observed = false;
      target[key] = original;
      f.broker.read = read;
      await f.close();
    }
  });

for (const c of commands)
  test(`MCP REST-off ${c.method} keeps prepared ownership after request completion and replays exactly`, async () => {
    const f = await fixture();
    try {
      expect(typeof f.service.prepareFor).toBe('function');
      const controller = new AbortController();
      const prepared = await f.service.prepareFor(
        f.invocation({ signal: controller.signal }),
        c.command,
      );
      controller.abort();
      expect(prepared.status).toBe('pending');
      expect(
        await f.service.operationFor(f.invocation(), prepared.operationId),
      ).toEqual(prepared);
      const input = { ...c.command, operationId: prepared.operationId };
      const accepted = await f.finish(
        f.service[c.method](f.invocation(), input),
        c.value,
      );
      expect(accepted).toEqual({
        operationId: prepared.operationId,
        status: 'accepted',
        meaning: c.meaning,
      });
      const count = queries(f).length;
      expect(await f.service[c.method](f.invocation(), input)).toEqual(
        accepted,
      );
      expect(
        await f.service.operationFor(f.invocation(), prepared.operationId),
      ).toEqual(accepted);
      expect(queries(f)).toHaveLength(count);
      if (c.method === 'controlFor')
        await expect(
          f.service.controlFor(f.invocation(), { ...input, action: 'play' }),
        ).rejects.toMatchObject({ code: 'conflict' });
      expect(f.service.enabled).toBe(false);
      expect(f.m.getMusicService(f.window)).toBeUndefined();
      expect(f.service.captureNativeOwner().current()).toBe(false);
      for (const method of [
        'prepare',
        'navigate',
        'control',
        'mutateQueue',
        'operation',
      ]) {
        await expect(
          Promise.resolve().then(() =>
            f.service[method](
              f.grant.token,
              method === 'operation'
                ? prepared.operationId
                : method === 'prepare'
                  ? c.command
                  : input,
            ),
          ),
        ).rejects.toBeTruthy();
      }
      await expect(
        f.service.operationFor(
          f.invocation({ transport: 'rest', session: undefined }),
          prepared.operationId,
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(await healthy(f)).toEqual(snapshot);
      expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    } finally {
      await f.close();
    }
  });

test('receipt foreign session same-ID owner and audience cannot read execute or expire a row', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.prepareFor).toBe('function');
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    const row = f.service.operations.rows.get(prepared.operationId);
    const oldReceipt = row.receipt;
    for (const session of [
      { id: 'b', current: () => true },
      { ...f.session },
    ]) {
      await expect(
        f.service.operationFor(f.invocation({ session }), prepared.operationId),
      ).rejects.toMatchObject({ code: 'unknown_operation' });
      await expect(
        f.service.controlFor(f.invocation({ session }), {
          operationId: prepared.operationId,
          action: 'pause',
        }),
      ).rejects.toMatchObject({ code: 'unknown_operation' });
    }
    f.register({ identity: {}, current: () => true });
    await expect(
      f.service.operationFor(f.invocation(), prepared.operationId),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    f.register(f.owner);
    for (const overrides of [
      { resource: resource + '/wrong' },
      { transport: 'rest', session: undefined },
    ]) {
      await expect(
        f.service.operationFor(f.invocation(overrides), prepared.operationId),
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
    f.advance(120001);
    await expect(
      f.service.operationFor(
        f.invocation({ session: { ...f.session } }),
        prepared.operationId,
      ),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    expect(f.service.operations.rows.get(prepared.operationId)).toBe(row);
    expect(row.receipt).toBe(oldReceipt);
    expect(row.executing).toBe(false);
    expect(queries(f)).toHaveLength(0);
    await expect(
      f.service.operationFor(f.invocation(), prepared.operationId),
    ).rejects.toMatchObject({ code: 'expired_operation' });
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('queue receipt status authorizes queue.write and cannot borrow playback.control', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.prepareFor).toBe('function');
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'clear_queue',
      queueRevision: 'a'.repeat(32),
    });
    const original = f.store.authorize.bind(f.store);
    const scopes: string[] = [];
    f.store.authorize = (...args: any[]) => {
      scopes.push(args[3]);
      return original(...args);
    };
    expect(
      await f.service.operationFor(f.invocation(), prepared.operationId),
    ).toEqual(prepared);
    expect(scopes).toEqual(['queue.write']);
    const current = f.store.isCurrent.bind(f.store);
    f.store.isCurrent = (p: any, scope: string) =>
      scope === 'queue.write' ? false : current(p, scope);
    await expect(
      f.service.operationFor(f.invocation(), prepared.operationId),
    ).rejects.toMatchObject({ code: 'retired' });
    f.store.isCurrent = current;
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('retireSession immediately retires pending receipt without another read and same-ID cannot inherit it', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.prepareFor).toBe('function');
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    const row = f.service.operations.rows.get(prepared.operationId);
    f.service.retireSession(f.session);
    expect(row.receipt).toEqual({
      operationId: prepared.operationId,
      status: 'retired',
      error: 'retired',
    });
    expect(row.executing).toBe(false);
    await expect(
      f.service.operationFor(f.invocation(), prepared.operationId),
    ).rejects.toMatchObject({ code: 'retired' });
    await expect(
      f.service.operationFor(
        f.invocation({ session: { ...f.session } }),
        prepared.operationId,
      ),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('duplicate cancellation only retires its wait and original dispatch receipt remains useful', async () => {
  const f = await fixture();
  try {
    expect(typeof f.service.prepareFor).toBe('function');
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    const input = { operationId: prepared.operationId, action: 'pause' };
    const first = f.service.controlFor(f.invocation(), input);
    const work = await start(f, first, 1);
    const cancel = new AbortController();
    const duplicate = outcome(
      f.service.controlFor(f.invocation({ signal: cancel.signal }), input),
    );
    await expect
      .poll(() => f.service.sessionLeases.get(f.session)?.size)
      .toBe(2);
    cancel.abort();
    expect((await duplicate).code).toBe('retired');
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
    f.settled(work.packet, {
      ok: true,
      value: { version: 1, phase: 'owned_control_dispatch' },
    });
    const accepted = await first;
    expect(accepted.status).toBe('accepted');
    expect(await f.service.controlFor(f.invocation(), input)).toEqual(accepted);
    expect(queries(f)).toHaveLength(1);
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

for (const mode of ['session', 'grant', 'config', 'stop', 'owner'] as const)
  test(`MCP ${mode} retirement retains physical receipt hold until actual settlement and healthy recovery`, async () => {
    const f = await fixture();
    try {
      const prepared = await f.service.prepareFor(f.invocation(), {
        action: 'pause',
      });
      const row = f.service.operations.rows.get(prepared.operationId);
      const input = { operationId: prepared.operationId, action: 'pause' };
      const pending = outcome(f.service.controlFor(f.invocation(), input));
      const work = await start(f, pending, 1);
      if (mode === 'session') f.service.retireSession(f.session);
      if (mode === 'grant') await f.store.revoke(f.grant.record.id, () => true);
      if (mode === 'config') f.service.configure(f.config);
      if (mode === 'stop') f.service.stop();
      if (mode === 'owner') {
        f.ownerOff();
        f.service.retireSession(f.session);
      }
      expect((await pending).code).toBe('retired');
      expect(row.physicalHold).toBe(true);
      expect(row.receipt.status).toBe('uncertain');
      expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
      f.advance(120001);
      f.service.operations.purge();
      expect(f.service.operations.rows.get(prepared.operationId)).toBe(row);
      f.settled(work.packet, {
        ok: true,
        value: { version: 1, phase: 'owned_control_dispatch' },
      });
      expect(row.physicalHold).toBe(false);
      expect(f.service.operations.rows.has(prepared.operationId)).toBe(false);
      expect(row.receipt.status).toBe('uncertain');
      if (mode === 'stop') f.service = f.restart();
      if (mode === 'owner') f.ownerOn();
      if (mode === 'grant') {
        const next = await f.store.issue(
          'Recovery',
          'mcp',
          resource,
          ['playback.read', 'playback.control'],
          () => true,
        );
        const invocation = f.invocation;
        f.invocation = (overrides: any = {}) =>
          invocation({ ...overrides, token: next.token });
      }
      expect(await healthy(f)).toEqual(snapshot);
      const recovery = f.invocation({
        session: { id: 'recovery', current: () => true },
      });
      const next = await f.service.prepareFor(recovery, { action: 'pause' });
      const receipt = await f.finish(
        f.service.controlFor(recovery, {
          operationId: next.operationId,
          action: 'pause',
        }),
        { version: 1, phase: 'owned_control_dispatch' },
      );
      expect(receipt.status).toBe('accepted');
      expect(await f.service.operationFor(recovery, next.operationId)).toEqual(
        receipt,
      );
      expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    } finally {
      await f.close();
    }
  });

for (const phase of ['prepare', 'status', 'execute'] as const)
  for (const kind of ['owner', 'session', 'resolver'] as const)
    test(`receipt ${phase} reentrant ${kind} retirement cannot publish or dispatch and new session recovers`, async () => {
      let armed = false,
        triggered = false;
      let f: any;
      f = await fixture(false, (call) => {
        if (armed && call === kind) {
          armed = false;
          triggered = true;
          f.service.retireSession(f.session);
        }
      });
      try {
        const prepared =
          phase === 'prepare'
            ? undefined
            : await f.service.prepareFor(f.invocation(), { action: 'pause' });
        armed = true;
        const result = await outcome(
          phase === 'prepare'
            ? f.service.prepareFor(f.invocation(), { action: 'pause' })
            : phase === 'status'
              ? f.service.operationFor(f.invocation(), prepared.operationId)
              : f.service.controlFor(f.invocation(), {
                  operationId: prepared.operationId,
                  action: 'pause',
                }),
        );
        expect(triggered).toBe(true);
        expect(result.code).toBe('retired');
        expect(queries(f)).toHaveLength(0);
        if (phase === 'prepare') expect(f.service.operations.rows.size).toBe(0);
        expect(await healthy(f)).toEqual(snapshot);
        expect(f.service.sessionLeases.size).toBe(0);
      } finally {
        await f.close();
      }
    });

test('receipt persistent owner is frozen and separate factory retains no request signal invocation or lease', async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    const binding = f.service.operations.rows.get(prepared.operationId).binding;
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.admission)).toBe(true);
    expect(Object.keys(binding).sort()).toEqual([
      'access',
      'admission',
      'current',
      'principal',
      'resource',
      'revision',
      'service',
    ]);
    const source = await readFile(
      path.resolve('src/plugins/api-server/backend/music-service.ts'),
      'utf8',
    );
    const ast = ts.createSourceFile(
      'music-service.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations: any[] = [];
    const visit = (n: any) => {
      if (
        ts.isMethodDeclaration(n) &&
        n.name?.getText(ast) === 'receiptOwnerFor'
      )
        declarations.push(n);
      ts.forEachChild(n, visit);
    };
    visit(ast);
    expect(declarations).toHaveLength(1);
    const factory = declarations[0];
    expect(factory.parameters.map((p: any) => p.name.getText(ast))).toEqual([
      'principal',
      'access',
      'revision',
      'admission',
      'scope',
    ]);
    const identifiers: string[] = [];
    const scan = (n: any) => {
      if (ts.isIdentifier(n)) identifiers.push(n.text);
      ts.forEachChild(n, scan);
    };
    scan(factory.body);
    for (const forbidden of [
      'lease',
      'invocation',
      'signal',
      'controller',
      'token',
      'Pending',
      'response',
    ])
      expect(identifiers).not.toContain(forbidden);
  } finally {
    await f.close();
  }
});

test('one stable MCP grant across sessions stays at two slots while distinct local REST and MCP share global four and FIFO eight', async () => {
  const f = await fixture(true);
  const accepted = { version: 1, phase: 'owned_control_dispatch' };
  try {
    const rest = await f.store.issue(
      'Local REST',
      'rest',
      f.service.resource,
      ['playback.control'],
      () => true,
    );
    const invocations = Array.from({ length: 13 }, (_, i) =>
      i < 2 || (i >= 4 && i % 2 === 0)
        ? f.invocation({ session: { id: 'mcp-' + i, current: () => true } })
        : f.invocation({
            token: rest.token,
            transport: 'rest',
            resource: f.service.resource,
            session: undefined,
          }),
    );
    const inputs: any[] = [];
    for (let i = 0; i < invocations.length; i++) {
      const command = { action: 'set_volume', volume: i };
      const prepared = await f.service.prepareFor(invocations[i], command);
      inputs.push({ ...command, operationId: prepared.operationId });
    }
    const pending: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      pending.push(outcome(f.service.controlFor(invocations[i], inputs[i])));
      await start(f, pending[i], i + 1);
    }
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 0 });
    for (let i = 4; i < 12; i++)
      pending.push(outcome(f.service.controlFor(invocations[i], inputs[i])));
    await expect.poll(() => f.broker.stats().queued).toBe(8);
    expect(queries(f)).toHaveLength(4);
    await expect(f.service.currentFor(invocations[12])).rejects.toMatchObject({
      code: 'busy',
    });
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 8 });
    // Free only a REST slot. Strict head-of-line MCP is still at its grant cap.
    f.settled(f.challenge(2), { ok: true, value: accepted });
    expect((await pending[2]).value.status).toBe('accepted');
    expect(queries(f)).toHaveLength(4);
    expect(f.broker.stats()).toEqual({ dispatched: 3, queued: 8 });
    f.settled(f.challenge(0), { ok: true, value: accepted });
    await expect.poll(() => queries(f).length).toBe(6);
    f.ready(f.challenge(4));
    f.ready(f.challenge(5));
    const reads = () =>
      f.sent.filter((p: any[]) => p[0] === 'peard:music-read');
    expect(
      reads()
        .slice(4)
        .map((p: any[]) => p[1].input.command.volume),
    ).toEqual([4, 5]);
    // Retire one queued session. It cannot release any of the four physical holds.
    f.service.retireSession(invocations[6].session);
    expect((await pending[6]).code).toBe('retired');
    expect(f.broker.stats().dispatched).toBe(4);
    const settled = new Set([0, 2]);
    while (settled.size < queries(f).length || f.broker.stats().queued) {
      const index = Array.from({ length: queries(f).length }, (_, i) => i).find(
        (i) => !settled.has(i),
      );
      expect(index).toBeDefined();
      settled.add(index!);
      f.settled(f.challenge(index), { ok: true, value: accepted });
      for (let i = 0; i < queries(f).length; i++) {
        if (
          !reads().some(
            (p: any[]) => p[1].requestId === f.challenge(i).requestId,
          )
        )
          f.ready(f.challenge(i));
      }
      await Promise.resolve();
    }
    const results = await Promise.all(pending);
    expect(
      results.filter((r: any) => r.value?.status === 'accepted'),
    ).toHaveLength(11);
    expect(reads().map((p: any[]) => p[1].input.command.volume)).toEqual([
      0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11,
    ]);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    // Cross-audience tokens cannot acquire work.
    await expect(
      f.service.currentFor(f.invocation({ token: rest.token })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      f.service.currentFor(
        f.invocation({
          transport: 'rest',
          resource: f.service.resource,
          session: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

test('foreign queue receipt and nonexistent ID have identical scope denial before receipt inspection', async () => {
  const f = await fixture();
  try {
    const grant = await f.store.issue(
      'Queue only',
      'mcp',
      resource,
      ['queue.write'],
      () => true,
    );
    const own = f.invocation({ token: grant.token });
    const prepared = await f.service.prepareFor(own, {
      action: 'clear_queue',
      queueRevision: 'a'.repeat(32),
    });
    expect(await f.service.operationFor(own, prepared.operationId)).toEqual(
      prepared,
    );
    const foreign = { ...own, session: { ...f.session } };
    for (const id of [
      prepared.operationId,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      expect((await outcome(f.service.operationFor(foreign, id))).code).toBe(
        'forbidden',
      );
    }
    f.register({ identity: {}, current: () => true });
    for (const id of [
      prepared.operationId,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      expect((await outcome(f.service.operationFor(own, id))).code).toBe(
        'forbidden',
      );
    }
    f.register(f.owner);
    expect(await f.service.operationFor(own, prepared.operationId)).toEqual(
      prepared,
    );
    expect(queries(f)).toHaveLength(0);
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

for (const mode of ['configure-ABA', 'session', 'selected-owner'] as const)
  test(`durable receipt owner catches ${mode} reentry after normal prepare without a request signal`, async () => {
    let action: (() => void) | undefined;
    const f = await fixture(false, (kind) => {
      if (kind === 'owner' && action) {
        const run = action;
        action = undefined;
        run();
      }
    });
    try {
      const prepared = await f.service.prepareFor(f.invocation(), {
        action: 'pause',
      });
      const binding = f.service.operations.rows.get(
        prepared.operationId,
      ).binding;
      expect(binding.current()).toBe(true);
      action = () => {
        if (mode === 'configure-ABA') {
          f.service.configure({ ...f.config, port: 26537 });
          f.service.configure(f.config);
        }
        if (mode === 'session') f.service.retireSession(f.session);
        if (mode === 'selected-owner')
          f.register({ identity: {}, current: () => true });
      };
      expect(binding.current()).toBe(false);
      expect(queries(f)).toHaveLength(0);
      if (mode === 'selected-owner') f.register(f.owner);
      const nextSession = { ...f.session };
      const next = await f.service.prepareFor(
        f.invocation({ session: nextSession }),
        { action: 'pause' },
      );
      const accepted = await f.finish(
        f.service.controlFor(f.invocation({ session: nextSession }), {
          action: 'pause',
          operationId: next.operationId,
        }),
        { version: 1, phase: 'owned_control_dispatch' },
      );
      expect(accepted.status).toBe('accepted');
    } finally {
      await f.close();
    }
  });

test('absent retired wrong-resource and replaced receipt owners cannot inspect or execute, then exact owner remains useful', async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepareFor(f.invocation(), {
      action: 'pause',
    });
    const row = f.service.operations.rows.get(prepared.operationId);
    const receipt = row.receipt;
    for (const mode of ['absent', 'retired', 'resource', 'replaced', 'token']) {
      if (mode === 'absent') f.register(undefined);
      if (mode === 'retired') f.ownerOff();
      if (mode === 'replaced')
        f.register({ identity: {}, current: () => true });
      const invocation = f.invocation(
        mode === 'resource'
          ? { resource: resource + '/foreign' }
          : mode === 'token'
            ? { token: 'not-a-grant' }
            : {},
      );
      const code =
        mode === 'replaced'
          ? 'unknown_operation'
          : mode === 'token'
            ? 'unauthorized'
            : 'unavailable';
      await expect(
        f.service.operationFor(invocation, prepared.operationId),
      ).rejects.toMatchObject({ code });
      await expect(
        f.service.controlFor(invocation, {
          operationId: prepared.operationId,
          action: 'pause',
        }),
      ).rejects.toMatchObject({ code });
      expect(row.receipt).toBe(receipt);
      expect(row.executing).toBe(false);
      expect(queries(f)).toHaveLength(0);
      f.ownerOn();
      f.register(f.owner);
      expect(
        await f.service.operationFor(f.invocation(), prepared.operationId),
      ).toEqual(prepared);
    }
    const accepted = await f.finish(
      f.service.controlFor(f.invocation(), {
        operationId: prepared.operationId,
        action: 'pause',
      }),
      { version: 1, phase: 'owned_control_dispatch' },
    );
    expect(accepted.status).toBe('accepted');
    expect(queries(f)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('legacy mutation wrappers preserve synchronous prepare validation and promised unavailable local discovery', async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.service.prepare(f.grant.token, { action: 'invalid' }),
    ).toThrow('Invalid music request.');
    for (const method of ['prepare', 'navigate', 'control', 'mutateQueue']) {
      let promise: any;
      expect(() => {
        promise = f.service[method](f.grant.token, { action: 'pause' });
      }).not.toThrow();
      await expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(
      f.service.operation(f.grant.token, 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});

for (const limited of [false, true])
  test(`MCP cross-service exact origin stays retired409, foreign owner hides scope and preserves rows queueOnly=${limited}`, async () => {
    const f = await fixture();
    try {
      const grant = limited
        ? await f.store.issue(
            'Queue only',
            'mcp',
            resource,
            ['queue.write'],
            () => true,
          )
        : f.grant;
      const invocation = f.invocation({ token: grant.token });
      const command = { action: 'clear_queue', queueRevision: 'a'.repeat(32) };
      const prepared = await f.service.prepareFor(invocation, command);
      const row = f.service.operations.rows.get(prepared.operationId);
      const before = row.receipt;
      const second = f.restart();
      await expect(
        second.operationFor(invocation, prepared.operationId),
      ).rejects.toMatchObject({ code: 'retired' });
      await expect(
        second.mutateQueueFor(invocation, {
          ...command,
          operationId: prepared.operationId,
        }),
      ).rejects.toMatchObject({ code: 'retired' });
      expect(row.receipt).toBe(before);
      f.register({ identity: {}, current: () => true });
      for (const id of [
        prepared.operationId,
        '00000000-0000-4000-8000-000000000000',
      ]) {
        expect((await outcome(second.operationFor(invocation, id))).code).toBe(
          limited ? 'forbidden' : 'unknown_operation',
        );
      }
      await expect(
        second.mutateQueueFor(invocation, {
          ...command,
          operationId: prepared.operationId,
        }),
      ).rejects.toMatchObject({ code: 'unknown_operation' });
      expect(row.receipt).toBe(before);
      expect(row.executing).toBe(false);
      expect(queries(f)).toHaveLength(0);
      f.advance(120001);
      await expect(
        second.mutateQueueFor(invocation, {
          ...command,
          operationId: prepared.operationId,
        }),
      ).rejects.toMatchObject({ code: 'unknown_operation' });
      expect(f.service.operations.rows.get(prepared.operationId)).toBe(row);
      f.register(f.owner);
      // Own captured origin can perform normal expiry; current service can issue useful work.
      await expect(
        f.service.operationFor(invocation, prepared.operationId),
      ).rejects.toMatchObject({ code: 'expired_operation' });
      const next = await second.prepareFor(invocation, command);
      const receipt = await f.finish(
        second.mutateQueueFor(invocation, {
          ...command,
          operationId: next.operationId,
        }),
        { version: 1, phase: 'owned_queue_dispatch' },
      );
      expect(receipt).toEqual({
        operationId: next.operationId,
        status: 'accepted',
        meaning: 'owned_queue_dispatch',
      });
      expect(await second.operationFor(invocation, next.operationId)).toEqual(
        receipt,
      );
    } finally {
      await f.close();
    }
  });

for (const kind of ['owner', 'session', 'resolver', 'grant'] as const) {
  const shards = kind === 'owner' || kind === 'resolver' ? 8 : 1;
  for (let shard = 0; shard < shards; shard++)
    test(
      `every prepare ${kind} guard reentry fences receipt publication and preserves useful recovery${
        shards > 1 ? ` [shard ${shard + 1}/${shards}]` : ''
      }`,
      async () => {
        const startedAt = performance.now();
        let guardCount: number | undefined;
        const report = (phase: string, detail: object = {}) => {
          if (shards === 1) return;
          console.log(
            'MUSIC_MATRIX_PHASE ' +
              JSON.stringify({
                mode: 'prepare-guard',
                guard: kind,
                shard: shard + 1,
                shards,
                G: guardCount ?? null,
                phase,
                elapsedMs: performance.now() - startedAt,
                ...detail,
              }),
          );
        };
        async function run(at?: number) {
          let armed = false,
            calls = 0,
            triggered = false;
          let f: any;
          const trigger = () => {
            if (armed && ++calls === at) {
              triggered = true;
              f.service.retireSession(f.session);
            }
          };
          const progress = (phase: string) => report(phase, { at: at ?? null });
          progress('fixture:begin');
          f = await fixture(
            false,
            (call) => {
              if (call === kind) trigger();
            },
            progress,
          );
          progress('fixture:end');
          const original = f.store.isCurrent.bind(f.store);
          if (kind === 'grant')
            f.store.isCurrent = (...args: any[]) => {
              const value = original(...args);
              trigger();
              return value;
            };
          let bodyFailed = false,
            primary: unknown;
          try {
            armed = true;
            progress('prepare:begin');
            const result = await outcome(
              f.service.prepareFor(f.invocation(), { action: 'pause' }),
            );
            progress('prepare:end');
            armed = false;
            const count = calls;
            if (at === undefined) {
              expect(result.code).toBe('success');
              expect('value' in result ? result.value.status : undefined).toBe(
                'pending',
              );
            } else {
              expect(triggered).toBe(true);
              expect(result.code).toBe('retired');
              for (const row of f.service.operations.rows.values()) {
                expect(row.binding.access.session).toBe(f.session);
                expect(row.receipt.status).toBe('retired');
                expect(row.physicalHold).toBe(false);
              }
              expect(f.service.sessionLeases.size).toBe(0);
              expect(queries(f)).toHaveLength(0);
              const invocation = f.invocation({ session: { ...f.session } });
              progress('recovery-prepare:begin');
              const prepared = await f.service.prepareFor(invocation, {
                action: 'pause',
              });
              progress('recovery-prepare:end');
              progress('recovery-control:begin');
              const receipt = await f.finish(
                f.service.controlFor(invocation, {
                  action: 'pause',
                  operationId: prepared.operationId,
                }),
                { version: 1, phase: 'owned_control_dispatch' },
              );
              progress('recovery-control:end');
              expect(receipt.status).toBe('accepted');
              expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
            }
            return count;
          } catch (error) {
            bodyFailed = true;
            primary = error;
            progress('body:error');
            throw error;
          } finally {
            if (shards === 1) await f.close();
            else {
              progress('cleanup:begin');
              try {
                await f.close();
                progress('cleanup:end');
              } catch (cleanup) {
                progress('cleanup:error');
                if (bodyFailed)
                  throw new AggregateError(
                    [primary, cleanup],
                    'Prepare guard body and cleanup failed',
                    { cause: primary },
                  );
                throw cleanup;
              }
            }
          }
        }
        const count = await run();
        guardCount = count;
        console.log('receipt prepare retirement points', kind, count);
        expect(count).toBeGreaterThan(0);
        const indices: number[] = [];
        for (let at = shard + 1; at <= count; at += shards) indices.push(at);
        report('partition', { indices });
        for (const at of indices) await run(at);
        report('complete', { indices });
      },
    );
}

test('MCP receipt ACK and owned WEB completion retain independent physical holds on one stable grant and broker', async () => {
  const f = await fixture();
  try {
    const grant = await f.store.issue(
      'Mixed physical owner',
      'mcp',
      resource,
      ['comments.read', 'playback.control', 'playback.read'],
      () => true,
    );
    const sessionA = f.session,
      sessionB = { id: 'receipt', current: () => true },
      sessionC = { id: 'healthy', current: () => true };
    const invocation = (session: any) =>
      f.invocation({ token: grant.token, session });
    let release!: (value: any) => void;
    const webCalls: any[] = [];
    f.service.commentsWeb = {
      request: async (body: any, options: any) => {
        webCalls.push({ body, options });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const comments = outcome(
      f.service.commentsFor(invocation(sessionA), {
        videoId: 'abcdefghijk',
        allowPublicWebFallback: true,
      }),
    );
    const native = await start(f, comments, 1);
    f.settled(native.packet, {
      ok: true,
      value: {
        version: 1,
        binding: { videoId: 'abcdefghijk', playbackEpoch: null },
        requests: 1,
        comments: {
          available: false,
          comments: [],
          commentCount: null,
          continuation: null,
        },
      },
    });
    await expect.poll(() => webCalls.length).toBe(1);
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
    const prepared = await f.service.prepareFor(invocation(sessionB), {
      action: 'pause',
    });
    const row = f.service.operations.rows.get(prepared.operationId);
    const mutation = outcome(
      f.service.controlFor(invocation(sessionB), {
        action: 'pause',
        operationId: prepared.operationId,
      }),
    );
    const control = await start(f, mutation, 2);
    const current = f.service.currentFor(invocation(sessionC));
    await expect.poll(() => f.broker.stats().queued).toBe(1);
    expect(f.broker.stats().dispatched).toBe(2);
    f.service.retireSession(sessionA);
    f.service.retireSession(sessionB);
    expect((await comments).code).toBe('retired');
    expect((await mutation).code).toBe('retired');
    expect(webCalls[0].options.signal.aborted).toBe(true);
    expect(row.receipt.status).toBe('uncertain');
    expect(row.physicalHold).toBe(true);
    expect(f.broker.stats()).toEqual({ dispatched: 2, queued: 1 });
    f.settled(control.packet, {
      ok: true,
      value: { version: 1, phase: 'owned_control_dispatch' },
    });
    await expect.poll(() => queries(f).length).toBe(3);
    expect(row.physicalHold).toBe(false);
    f.ready(f.challenge(2));
    f.settled(f.challenge(2), { ok: true, value: snapshot });
    expect(await current).toEqual(snapshot);
    expect(f.broker.stats()).toEqual({ dispatched: 1, queued: 0 });
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
    expect(row.receipt.status).toBe('uncertain');
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
    const next = await f.service.prepareFor(invocation(sessionC), {
      action: 'pause',
    });
    const accepted = await f.finish(
      f.service.controlFor(invocation(sessionC), {
        action: 'pause',
        operationId: next.operationId,
      }),
      { version: 1, phase: 'owned_control_dispatch' },
    );
    expect(accepted.status).toBe('accepted');
    expect(
      await f.service.operationFor(invocation(sessionC), next.operationId),
    ).toEqual(accepted);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
  } finally {
    await f.close();
  }
});

test('R1-P3-MAIN-01 operation scope and authorization cannot select different access owners', async () => {
  const f = await fixture();
  try {
    const grant = await f.store.issue(
      'Queue only boundary',
      'mcp',
      resource,
      ['queue.write'],
      () => true,
    );
    const invocation = f.invocation({ token: grant.token });
    const command = { action: 'clear_queue', queueRevision: 'a'.repeat(32) };
    const prepared = await f.service.prepareFor(invocation, command);
    const row = f.service.operations.rows.get(prepared.operationId);
    const before = {
      receipt: row.receipt,
      expires: row.expires,
      binding: row.binding,
    };
    const original = f.service.runtime.resolveAccessOwner;
    const authorize = f.store.authorize.bind(f.store);
    const authorized: string[] = [];
    f.store.authorize = (...args: any[]) => {
      authorized.push(args[3]);
      return authorize(...args);
    };
    const next = { identity: {}, current: () => true };
    async function status(id: string) {
      let first = true;
      f.register(f.owner);
      f.service.runtime.resolveAccessOwner = (...args: any[]) => {
        if (first) {
          first = false;
          const captured = original(...args);
          f.register(next);
          return captured;
        }
        return original(...args);
      };
      const before = authorized.length;
      const result = await outcome(f.service.operationFor(invocation, id));
      return { code: result.code, authorized: authorized.slice(before) };
    }
    const existing = await status(prepared.operationId);
    const missing = await status('00000000-0000-4000-8000-000000000000');
    expect(existing).toEqual(missing);
    expect(existing).toEqual({ code: 'retired', authorized: [] });
    expect(row.receipt).toBe(before.receipt);
    expect(row.binding).toBe(before.binding);
    expect(row.expires).toBe(before.expires);
    expect(row.executing).toBe(false);
    expect(row.physicalHold).toBe(false);
    expect(queries(f)).toHaveLength(0);
    f.service.runtime.resolveAccessOwner = original;
    f.register(f.owner);
    const accepted = await f.finish(
      f.service.mutateQueueFor(invocation, {
        ...command,
        operationId: prepared.operationId,
      }),
      { version: 1, phase: 'owned_queue_dispatch' },
    );
    expect(accepted.status).toBe('accepted');
    expect(
      await f.service.operationFor(invocation, prepared.operationId),
    ).toEqual(accepted);
    f.register(next);
    await expect(
      f.service.mutateQueueFor(invocation, {
        ...command,
        operationId: prepared.operationId,
      }),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
    const preparedNext = await f.service.prepareFor(invocation, command);
    const acceptedNext = await f.finish(
      f.service.mutateQueueFor(invocation, {
        ...command,
        operationId: preparedNext.operationId,
      }),
      { version: 1, phase: 'owned_queue_dispatch' },
    );
    expect(acceptedNext.status).toBe('accepted');
    expect(
      await f.service.operationFor(invocation, preparedNext.operationId),
    ).toEqual(acceptedNext);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
  } finally {
    await f.close();
  }
});

for (const boundary of ['scope', 'authorization'] as const)
  for (const mode of ['owner', 'config', 'session', 'native'] as const)
    test(`R1-P3-MAIN-01 ${mode} retirement at ${boundary} boundary cannot admit replacement authority`, async () => {
      let scopeSeen = false,
        armed = false,
        triggered = false;
      let f: any;
      const next = { identity: {}, current: () => true };
      const retire = () => {
        triggered = true;
        armed = false;
        if (mode === 'owner') f.register(next);
        if (mode === 'config') {
          f.service.configure({ ...f.config, port: 26537 });
          f.service.configure(f.config);
        }
        if (mode === 'session') f.service.retireSession(f.session);
        if (mode === 'native')
          f.contents.emit(
            'did-start-navigation',
            {},
            'https://music.youtube.com/',
            false,
            true,
          );
      };
      f = await fixture(false, (kind) => {
        const chosen =
          mode === 'config'
            ? 'owner'
            : mode === 'session'
              ? 'session'
              : 'resolver';
        if (boundary === 'scope' && armed && scopeSeen && kind === chosen)
          retire();
      });
      try {
        const grant = await f.store.issue(
          'Queue only boundary',
          'mcp',
          resource,
          ['queue.write'],
          () => true,
        );
        const invocation = f.invocation({ token: grant.token });
        const command = {
          action: 'clear_queue',
          queueRevision: 'a'.repeat(32),
        };
        const prepared = await f.service.prepareFor(invocation, command);
        const row = f.service.operations.rows.get(prepared.operationId);
        const receipt = row.receipt;
        const scope = f.service.operations.requiredScope.bind(
          f.service.operations,
        );
        // Observe scope discovery only; reentry occurs through real owned guard/async seams.
        f.service.operations.requiredScope = (...args: any[]) => {
          const value = scope(...args);
          scopeSeen = true;
          return value;
        };
        const authorize = f.store.authorize.bind(f.store);
        const calls: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.store.authorize = async (...args: any[]) => {
          calls.push(args[3]);
          const principal = await authorize(...args);
          if (boundary === 'authorization' && armed) await gate;
          return principal;
        };
        armed = true;
        const pending = outcome(
          f.service.operationFor(invocation, prepared.operationId),
        );
        if (boundary === 'authorization') {
          await expect.poll(() => calls.length).toBe(1);
          retire();
          release();
        }
        expect((await pending).code).toBe('retired');
        expect(triggered).toBe(true);
        if (boundary === 'scope') expect(calls).toEqual([]);
        else expect(calls).toEqual(['queue.write']);
        expect(row.executing).toBe(false);
        expect(row.physicalHold).toBe(false);
        if (mode === 'owner') expect(row.receipt).toBe(receipt);
        else expect(row.receipt.status).toBe('retired');
        expect(queries(f)).toHaveLength(0);
        expect(f.service.sessionLeases.size).toBe(0);
        armed = false;
        if (mode === 'native')
          f.contents.emit(
            'did-navigate',
            {},
            'https://music.youtube.com/',
            200,
            'OK',
          );
        f.register(next);
        const recovery = f.invocation({
          token: grant.token,
          session: { ...f.session },
        });
        const healthyPrepared = await f.service.prepareFor(recovery, command);
        const accepted = await f.finish(
          f.service.mutateQueueFor(recovery, {
            ...command,
            operationId: healthyPrepared.operationId,
          }),
          { version: 1, phase: 'owned_queue_dispatch' },
        );
        expect(accepted.status).toBe('accepted');
        expect(
          await f.service.operationFor(recovery, healthyPrepared.operationId),
        ).toEqual(accepted);
        expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
      } finally {
        await f.close();
      }
    });

test('distinct local REST remote REST MCP grants share global4 perGrant2 FIFO8 without cross-audience authentication', async () => {
  const f = await fixture(true);
  const accepted = { version: 1, phase: 'owned_control_dispatch' };
  try {
    const rest = await f.store.issue(
      'Local REST',
      'rest',
      f.service.resource,
      ['playback.control'],
      () => true,
    );
    const remoteResource =
      'http://music-http.fixture.invalid:26538/api/v1/music';
    f.service.configure({
      ...f.config,
      musicApiRemoteEnabled: true,
      musicApiRemoteResource: remoteResource,
    });
    const remote = await f.store.issue(
      'Explicit remote REST',
      'rest',
      remoteResource,
      ['playback.control'],
      () => true,
    );
    const sequence = [
      'M',
      'M',
      'L',
      'R',
      'M',
      'R',
      'L',
      'R',
      'L',
      'M',
      'R',
      'L',
      'M',
    ];
    const invocations = sequence.map((audience, i) =>
      audience === 'M'
        ? f.invocation({
            session: { id: 'stable-mcp-' + i, current: () => true },
          })
        : f.invocation({
            token: audience === 'L' ? rest.token : remote.token,
            transport: 'rest',
            resource: audience === 'L' ? f.service.resource : remoteResource,
            session: undefined,
          }),
    );
    const inputs: any[] = [];
    for (let i = 0; i < invocations.length; i++) {
      const command = { action: 'set_volume', volume: i };
      const prepared = await f.service.prepareFor(invocations[i], command);
      inputs.push({ ...command, operationId: prepared.operationId });
    }
    const pending: Promise<any>[] = [];
    for (let i = 0; i < 4; i++) {
      pending.push(outcome(f.service.controlFor(invocations[i], inputs[i])));
      await start(f, pending[i], i + 1);
    }
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 0 });
    for (let i = 4; i < 12; i++)
      pending.push(outcome(f.service.controlFor(invocations[i], inputs[i])));
    await expect.poll(() => f.broker.stats().queued).toBe(8);
    expect(queries(f)).toHaveLength(4);
    await expect(f.service.currentFor(invocations[12])).rejects.toMatchObject({
      code: 'busy',
    });
    expect(f.broker.stats()).toEqual({ dispatched: 4, queued: 8 });
    // Free only a REST slot. Strict head-of-line MCP is still at its grant cap.
    f.settled(f.challenge(2), { ok: true, value: accepted });
    expect((await pending[2]).value.status).toBe('accepted');
    expect(queries(f)).toHaveLength(4);
    expect(f.broker.stats()).toEqual({ dispatched: 3, queued: 8 });
    f.settled(f.challenge(0), { ok: true, value: accepted });
    await expect.poll(() => queries(f).length).toBe(6);
    f.ready(f.challenge(4));
    f.ready(f.challenge(5));
    const reads = () =>
      f.sent.filter((p: any[]) => p[0] === 'peard:music-read');
    expect(
      reads()
        .slice(4)
        .map((p: any[]) => p[1].input.command.volume),
    ).toEqual([4, 5]);
    // Retire one queued session. It cannot release any of the four physical holds.
    f.service.retireSession(invocations[9].session);
    expect((await pending[9]).code).toBe('retired');
    expect(f.broker.stats().dispatched).toBe(4);
    const settled = new Set([0, 2]);
    while (settled.size < queries(f).length || f.broker.stats().queued) {
      const index = Array.from({ length: queries(f).length }, (_, i) => i).find(
        (i) => !settled.has(i),
      );
      expect(index).toBeDefined();
      settled.add(index!);
      f.settled(f.challenge(index), { ok: true, value: accepted });
      for (let i = 0; i < queries(f).length; i++) {
        if (
          !reads().some(
            (p: any[]) => p[1].requestId === f.challenge(i).requestId,
          )
        )
          f.ready(f.challenge(i));
      }
      await Promise.resolve();
    }
    const results = await Promise.all(pending);
    expect(
      results.filter((r: any) => r.value?.status === 'accepted'),
    ).toHaveLength(11);
    expect(reads().map((p: any[]) => p[1].input.command.volume)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11,
    ]);
    expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    // Cross-audience tokens cannot acquire work.
    await expect(
      f.service.currentFor(f.invocation({ token: rest.token })),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      f.service.currentFor(
        f.invocation({
          transport: 'rest',
          resource: f.service.resource,
          session: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    for (const [token, transport, audience] of [
      [rest.token, 'rest', remoteResource],
      [remote.token, 'rest', f.service.resource],
      [remote.token, 'mcp', resource],
      [f.grant.token, 'rest', remoteResource],
    ] as const) {
      await expect(
        f.service.currentFor(
          f.invocation({
            token,
            transport,
            resource: audience,
            session: transport === 'rest' ? undefined : f.session,
          }),
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.broker.stats()).toEqual({ dispatched: 0, queued: 0 });
    }
    for (const i of [2, 3]) {
      const command = { action: 'pause' };
      const prepared = await f.service.prepareFor(invocations[i], command);
      const result = await f.finish(
        f.service.controlFor(invocations[i], {
          ...command,
          operationId: prepared.operationId,
        }),
        accepted,
      );
      expect(result.status).toBe('accepted');
    }
    expect(await healthy(f)).toEqual(snapshot);
  } finally {
    await f.close();
  }
});
