import { EventEmitter } from 'node:events';
import { test, expect } from '@playwright/test';
import { musicHttpFixture } from './helpers/api-music-http';

const queueCommands = [
  { action: 'enqueue_song', videoId: 'abcdefghijk' },
  { action: 'enqueue_playlist', playlistId: 'PL1234567890123456' },
  {
    action: 'remove_from_queue',
    queueRevision: '1'.repeat(32),
    index: 0,
    expectedVideoId: 'abcdefghijk',
  },
  { action: 'clear_queue', queueRevision: '1'.repeat(32) },
];

for (const command of queueCommands) {
  test(`Q4 queue.write alone prepares and reads ${command.action} without native work`, async () => {
    const f = await musicHttpFixture();
    try {
      const grant = await f.store.issue(
        'Q4',
        'rest',
        f.service.resource,
        ['queue.write'],
        () => true,
      );
      const frame = {};
      (f.service as any).broker.capture = () => ({ frame, generation: 0 });
      const headers = { authorization: 'Bearer ' + grant.token };
      const prepared = await f.http(
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify(command),
        headers,
      );
      expect(prepared.status).toBe(200);
      expect(prepared.body).toEqual({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'pending',
      });
      const status = await f.http(
        '/api/v1/music/operations/' + prepared.body.operationId,
        'GET',
        undefined,
        headers,
      );
      expect(status.status).toBe(200);
      expect(status.body).toEqual(prepared.body);
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}

import { playlistRendererFixture } from './helpers/playlist-renderer-fixture';
import { musicModuleSource } from './helpers/api-music-source';

const queueRows = (...ids: string[]) =>
  ids.map((videoId) => ({
    content: { playlistPanelVideoRenderer: { videoId } },
  }));
const ownership = (f: any) => ({
  current: () => true,
  scalarCurrent: () => true,
  nativeCurrent: () => true,
  enter() {},
  beforeEffect() {
    f.dom.blockerSceneGuard.cancelFromUser();
  },
});

test('Q4 owned enqueue shares real legacy FIFO and cancellation keeps physical fetch held', async () => {
  const f = await playlistRendererFixture();
  try {
    expect(typeof f.controller.enqueueOwned).toBe('function');
    const first = f.controller.enqueueOwned(
      { videoId: 'abcdefghijk', insertPosition: 'INSERT_AT_END' },
      ownership(f),
    );
    const second = f.controller.enqueueOwned(
      {
        playlistId: 'PL1234567890123456',
        insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
      },
      ownership(f),
    );
    f.emit('peard:add-to-queue', 'bbbbbbbbbbb', 'INSERT_AT_END');
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0].data).toEqual({
      queueContextParams: 'owned-context',
      videoIds: ['abcdefghijk'],
      queueInsertPosition: 'INSERT_AT_END',
    });
    let physicallySettled = false;
    first.physicalSettled.then(() => (physicallySettled = true));
    first.cancel();
    await expect(first.result).rejects.toThrow('Queue outcome unknown');
    await f.flush();
    expect(physicallySettled).toBe(false);
    expect(f.fetches).toHaveLength(1);
    f.fetches[0].resolve({ queueDatas: queueRows('abcdefghijk') });
    await first.physicalSettled;
    await f.flush();
    expect(f.dispatches).toHaveLength(0);
    expect(f.fetches).toHaveLength(2);
    f.fetches[1].resolve({
      queueDatas: queueRows('ccccccccccc', 'ccccccccccc'),
    });
    expect(await second.result).toEqual({
      version: 1,
      phase: 'owned_queue_dispatch',
      count: 2,
    });
    await second.physicalSettled;
    await f.flush();
    expect(f.dispatches[0].payload.index).toBe(1);
    expect(f.intents()).toBe(3);
    expect(f.fetches).toHaveLength(3);
    f.fetches[2].resolve({ queueDatas: [] });
    await f.flush();
  } finally {
    await f.close();
  }
});

test('Q4 owner issues one-use same-revision removal authority for the exact duplicate', async () => {
  const f = await playlistRendererFixture();
  try {
    f.setState({
      queue: {
        ...f.state().queue,
        items: [0, 1, 2].map(() => ({
          playlistPanelVideoRenderer: {
            videoId: 'abcdefghijk',
            title: { simpleText: 'Duplicate' },
          },
        })),
      },
    });
    const source = await musicModuleSource('src/providers/music-queue.ts');
    const api = { isConnected: true };
    const owner = source.createMusicQueueOwner(api, () => api, f.dom.document);
    try {
      const snapshot = owner.snapshot();
      expect(typeof owner.prepareMutation).toBe('function');
      const fence = owner.prepareMutation({
        queueRevision: snapshot.queueRevision,
        index: 1,
        expectedVideoId: 'abcdefghijk',
      });
      fence.commit('remove', () => {});
      expect(f.dispatches).toEqual([{ type: 'REMOVE_ITEM', payload: 1 }]);
      expect(() => fence.commit('remove', () => {})).toThrow();
      expect(() =>
        owner.prepareMutation({
          queueRevision: '0'.repeat(32),
          index: 0,
          expectedVideoId: 'abcdefghijk',
        }),
      ).toThrow();
      expect(f.dispatches).toHaveLength(1);
    } finally {
      owner.dispose();
    }
  } finally {
    await f.close();
  }
});

for (const [command, route, method] of [
  [{ action: 'enqueue_song', videoId: 'abcdefghijk' }, '/queue/song', 'POST'],
  [
    { action: 'enqueue_playlist', playlistId: 'PL1234567890123456' },
    '/queue/playlist',
    'POST',
  ],
  [queueCommands[2], '/queue/0', 'DELETE'],
  [queueCommands[3], '/queue', 'DELETE'],
] as const)
  test(`Q4 HTTP ${command.action} uses one scoped actor job and replays receipt`, async () => {
    const f = await musicHttpFixture();
    try {
      const grant = await f.store.issue(
        'Q4 executor',
        'rest',
        f.service.resource,
        ['queue.write'],
        () => true,
      );
      const frame = {};
      (f.service as any).broker.capture = () => ({ frame, generation: 0 });
      f.setHold();
      const headers = { authorization: 'Bearer ' + grant.token };
      const prepared = await f.http(
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify(command),
        headers,
      );
      expect(prepared.status).toBe(200);
      const { action, ...args } = command;
      const body = JSON.stringify({
        ...args,
        operationId: prepared.body.operationId,
      });
      const executionHeaders = {
        ...headers,
        'content-length': String(Buffer.byteLength(body)),
      };
      const running = f.http(
        '/api/v1/music' + route,
        method,
        body,
        executionHeaders,
      );
      await expect.poll(() => f.calls.length).toBe(1);
      expect(f.calls[0].input).toEqual({
        operation: 'mutate-queue',
        command: {
          ...command,
          ...('videoId' in command || 'playlistId' in command
            ? { insertPosition: 'INSERT_AT_END' }
            : {}),
        },
        deadlineAt: expect.any(Number),
      });
      f.calls[0].options.onPhysicalSettled('settled');
      f.calls[0].resolve({
        version: 1,
        phase: 'owned_queue_dispatch',
        ...(['enqueue_song', 'enqueue_playlist'].includes(action)
          ? { count: 1 }
          : {}),
      });
      const result = await running;
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        operationId: prepared.body.operationId,
        status: 'accepted',
        meaning: 'owned_queue_dispatch',
      });
      expect(
        (await f.http('/api/v1/music' + route, method, body, executionHeaders))
          .body,
      ).toEqual(result.body);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

import { Window } from 'happy-dom';
import { build } from 'vite';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let actual: any;
test.beforeAll(async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-q4-actor-'));
  try {
    const core = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
    const init = core.slice(
      core.indexOf('async function onApiLoaded() {') +
        'async function onApiLoaded() {'.length,
      core.indexOf('  // Workaround for macOS traffic lights'),
    );
    const entry = path.join(owned, 'entry.ts');
    await writeFile(
      entry,
      [
        `export * from ${JSON.stringify(path.join(root, 'src/providers/music-renderer.ts'))};`,
        `export * from ${JSON.stringify(path.join(root, 'src/providers/music-actions.ts'))};`,
        `import {publishMusicActionsOwner} from ${JSON.stringify(path.join(root, 'src/providers/music-actions.ts'))};`,
        `import {createRepeatPreference} from ${JSON.stringify(path.join(root, 'src/providers/repeat-preference.ts'))};`,
        `import {createPlaylistQueueController} from ${JSON.stringify(path.join(root, 'src/providers/queue-playlist-renderer.ts'))};`,
        `let api,repeatPreference,playlistQueue,disposeMusicActionsOwner; export function initializeCore(next){api=next;${init};return{repeatPreference,playlistQueue,disposeMusicActionsOwner};}`,
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: { alias: { '@': path.join(root, 'src') } },
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'actual.mjs' } },
      },
    });
    actual = await import(pathToFileURL(path.join(owned, 'actual.mjs')).href);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
function actorFixture() {
  const dom = new Window(),
    w = dom as any,
    doc = dom.document;
  const saved = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
  };
  (globalThis as any).window = w;
  (globalThis as any).document = doc;
  doc.body.innerHTML =
    '<ytmusic-app></ytmusic-app><ytmusic-player-bar></ytmusic-player-bar><div id="queue"></div><div id="movie_player"></div>';
  const app = doc.querySelector('ytmusic-app') as any,
    queue = doc.querySelector('#queue') as any,
    api = doc.querySelector('#movie_player') as any;
  let items = [0, 1, 2].map(() => ({
    playlistPanelVideoRenderer: {
      videoId: 'abcdefghijk',
      title: { simpleText: 'Duplicate' },
    },
  }));
  const subscriptions = new Set<() => void>(),
    legacy = new Map<string, any>(),
    listeners = new Map<string, any>();
  const packets: any[] = [],
    dispatches: any[] = [],
    fetches: any[] = [],
    effects: string[] = [];
  const store = {
    getState: () => ({
      queue: {
        items,
        selectedItemIndex: 0,
        nextQueueItemId: 3,
        queueContextParams: 'context',
      },
    }),
    subscribe: (fn: () => void) => {
      subscriptions.add(fn);
      return () => subscriptions.delete(fn);
    },
    dispatch(action: any) {
      effects.push(action.type);
      dispatches.push({ receiver: this, action });
      for (const fn of subscriptions) fn();
    },
  };
  queue.queue = { store: { store }, getItems: () => items };
  queue.dispatch = function (action: any) {
    effects.push(action.type);
    dispatches.push({ receiver: this, action });
    if (action.type === 'CLEAR') items = [];
    if (action.type === 'REMOVE_ITEM') items.splice(action.payload, 1);
    if (action.type === 'ADD_ITEMS')
      items.splice(action.payload.index, 0, ...action.payload.items);
    for (const fn of subscriptions) fn();
  };
  api.getVideoData = () => ({ video_id: 'abcdefghijk' });
  api.getPlayerResponse = () => ({ videoDetails: { videoId: 'abcdefghijk' } });
  app.networkManager = {
    fetch: (url: string, data: any) =>
      new Promise((resolve, reject) =>
        fetches.push({ url, data, resolve, reject }),
      ),
  };
  w.ipcRenderer = {
    send() {},
    subscribe: (channel: string, fn: any) => {
      legacy.set(channel, fn);
      return () => legacy.delete(channel);
    },
  };
  w.blockerSceneGuard = {
    cancelFromUser() {
      effects.push('guard');
    },
  };
  const core = actual.initializeCore(api);
  const controller = actual.createMusicRendererController(api, () => api, {
    send: (_: string, p: any) => packets.push(p),
    subscribe: (name: string, fn: any) => {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
  });
  let serial = 0;
  const read = (input: any) => {
    const request = {
      requestId:
        '00000000-0000-4000-8000-' + String(++serial).padStart(12, '0'),
      nonce: 'a'.repeat(32),
    };
    listeners.get('peard:music-owner-query')(request);
    const ready = packets.find((p) => p.requestId === request.requestId);
    listeners.get('peard:music-read')({ ...ready, input });
    return {
      ready,
      result: () =>
        packets.find(
          (p) => p.requestId === request.requestId && p.type === 'settled',
        )?.result,
    };
  };
  return {
    dom,
    w,
    doc,
    api,
    queue,
    store,
    core,
    controller,
    read,
    fetches,
    dispatches,
    effects,
    packets,
    legacy,
    listeners,
    async flush() {
      for (let i = 0; i < 16; i++) await Promise.resolve();
    },
    close() {
      controller.dispose();
      core.playlistQueue.dispose();
      core.repeatPreference.dispose();
      core.disposeMusicActionsOwner();
      Object.assign(globalThis, saved);
      dom.happyDOM.abort();
    },
  };
}
const actionInput = (command: any) => ({
  operation: 'mutate-queue',
  command,
  deadlineAt: Date.now() + 10000,
});

test('Q4 real actor uses published core insertion instance and exact native ADD_ITEMS', async () => {
  const f = actorFixture();
  try {
    const job = f.read(
      actionInput({
        action: 'enqueue_playlist',
        playlistId: 'PL1234567890123456',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
      }),
    );
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0].url).toBe('/music/get_queue');
    expect(f.fetches[0].data).toEqual({
      queueContextParams: 'context',
      playlistId: 'PL1234567890123456',
    });
    f.fetches[0].resolve({
      queueDatas: queueRows('aaaaaaaaaaa', 'bbbbbbbbbbb', 'bbbbbbbbbbb'),
    });
    await f.flush();
    expect(job.result()).toEqual({
      ok: true,
      value: { version: 1, phase: 'owned_queue_dispatch', count: 2 },
    });
    expect(f.effects).toEqual(['guard', 'ADD_ITEMS']);
    expect(f.dispatches[0].receiver).toBe(f.queue);
    expect(f.dispatches[0].action.payload.index).toBe(1);
    expect(
      f.dispatches[0].action.payload.items.map(
        (r: any) => r.playlistPanelVideoRenderer.videoId,
      ),
    ).toEqual(['bbbbbbbbbbb', 'bbbbbbbbbbb']);
  } finally {
    f.close();
  }
});

test('Q4 real actor clear retires active canonical insertion before ordered native writes', async () => {
  const f = actorFixture();
  try {
    const read = f.read({ operation: 'queue' });
    await f.flush();
    const queueRevision = read.result().value.queueRevision;
    const insert = f.read(
      actionInput({
        action: 'enqueue_song',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AT_END',
      }),
    );
    expect(f.fetches).toHaveLength(1);
    const clear = f.read(actionInput({ action: 'clear_queue', queueRevision }));
    await f.flush();
    expect(clear.result()).toEqual({
      ok: true,
      value: { version: 1, phase: 'owned_queue_dispatch' },
    });
    expect(f.effects).toEqual([
      'guard',
      'guard',
      'SET_PLAYER_PAGE_INFO',
      'CLEAR',
    ]);
    expect(f.dispatches.map((p) => p.receiver)).toEqual([f.store, f.queue]);
    expect(insert.result()).toBeUndefined();
    f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
    await f.flush();
    expect(insert.result()?.ok).toBe(false);
    expect(f.effects).toEqual([
      'guard',
      'guard',
      'SET_PLAYER_PAGE_INFO',
      'CLEAR',
    ]);
  } finally {
    f.close();
  }
});

test('Q4 insertion payload getter cannot replace native queue after its final fence', async () => {
  const f = actorFixture();
  try {
    const getState = f.store.getState;
    f.store.getState = () => {
      const state = getState();
      Object.defineProperty(state.queue, 'nextQueueItemId', {
        get() {
          f.queue.queue = { store: { store: f.store }, getItems: () => [] };
          return 3;
        },
      });
      return state;
    };
    const job = f.read(
      actionInput({
        action: 'enqueue_song',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AT_END',
      }),
    );
    expect(f.fetches).toHaveLength(1);
    f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
    await f.flush();
    expect(f.dispatches).toHaveLength(0);
    expect(job.result()?.ok).toBe(false);
  } finally {
    f.close();
  }
});

for (const failure of [
  'guard retires',
  'guard throws',
  'store throws',
] as const)
  test(`Q4 clear ${failure} preserves partial effect uncertainty`, async () => {
    const f = actorFixture();
    try {
      const read = f.read({ operation: 'queue' });
      await f.flush();
      const queueRevision = read.result().value.queueRevision;
      if (failure === 'guard retires')
        f.w.blockerSceneGuard.cancelFromUser = () => {
          f.effects.push('guard');
          f.core.disposeMusicActionsOwner();
        };
      if (failure === 'guard throws')
        f.w.blockerSceneGuard.cancelFromUser = () => {
          f.effects.push('guard');
          throw Error('private error');
        };
      if (failure === 'store throws')
        f.store.dispatch = () => {
          f.effects.push('SET_PLAYER_PAGE_INFO');
          throw Error('private error');
        };
      const clear = f.read(
        actionInput({ action: 'clear_queue', queueRevision }),
      );
      await f.flush();
      expect(clear.result()?.ok).toBe(false);
      expect(f.effects).toEqual(
        failure === 'store throws'
          ? ['guard', 'SET_PLAYER_PAGE_INFO']
          : ['guard'],
      );
      expect(f.fetches).toHaveLength(0);
      expect(JSON.stringify(clear.result())).not.toContain('private error');
    } finally {
      f.close();
    }
  });

for (const phase of ['pending', 'accepted', 'failed', 'uncertain'] as const)
  test(`Q4 ${phase} status authenticates original queue scope and preserves foreign history`, async () => {
    const f = await musicHttpFixture();
    try {
      const grant = await f.store.issue(
        'Q4 original',
        'rest',
        f.service.resource,
        ['queue.write'],
        () => true,
      );
      const frame = {};
      (f.service as any).broker.capture = () => ({ frame, generation: 0 });
      const prepared = await f.service.prepare(grant.token, queueCommands[0]);
      const ledger = (f.service as any).operations,
        row = ledger.rows.get(prepared.operationId);
      if (phase !== 'pending')
        row.receipt = {
          operationId: row.id,
          status: phase,
          ...(phase === 'accepted'
            ? { meaning: 'owned_queue_dispatch' }
            : {
                error:
                  phase === 'uncertain' ? 'outcome_unknown' : 'unavailable',
              }),
        };
      const before = {
        receipt: { ...row.receipt },
        expires: row.expires,
        size: ledger.rows.size,
        scope: row.requiredScope,
        hold: row.physicalHold,
      };
      const own = await f.service.operation(grant.token, row.id);
      expect(own).toEqual(before.receipt);
      expect(row.requiredScope).toBe('queue.write');
      for (const scopes of [['queue.write'], ['playback.control']] as const) {
        const foreign = await f.store.issue(
          'Foreign',
          'rest',
          f.service.resource,
          [...scopes],
          () => true,
        );
        const headers = { authorization: 'Bearer ' + foreign.token };
        const denied = await f.http(
          '/api/v1/music/operations/' + row.id,
          'GET',
          undefined,
          headers,
        );
        const unknown = await f.http(
          '/api/v1/music/operations/00000000-0000-4000-8000-000000000099',
          'GET',
          undefined,
          headers,
        );
        expect(denied).toMatchObject({
          status: unknown.status,
          body: unknown.body,
        });
      }
      for (const token of ['', 'jwt.invalid', 'NONE']) {
        expect(
          (
            await f.http(
              '/api/v1/music/operations/' + row.id,
              'GET',
              undefined,
              { authorization: token },
            )
          ).status,
        ).toBe(401);
      }
      expect({
        receipt: row.receipt,
        expires: row.expires,
        size: ledger.rows.size,
        scope: row.requiredScope,
        hold: row.physicalHold,
      }).toEqual(before);
      await f.store.revoke(grant.record.id, () => true);
      await expect(
        f.service.operation(grant.token, row.id),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(ledger.rows.get(row.id)).toBe(row);
      expect(row.receipt).toEqual(before.receipt);
    } finally {
      await f.close();
    }
  });

for (const change of ['frame', 'generation', 'service', 'grant'] as const)
  test(`Q4 delayed original-scope authentication rejects ${change} retirement before row lookup`, async () => {
    const f = await musicHttpFixture();
    try {
      const grant = await f.store.issue(
        'Q4 delayed',
        'rest',
        f.service.resource,
        ['queue.write'],
        () => true,
      );
      const frame = {};
      let live = { frame, generation: 0 };
      (f.service as any).broker.capture = () => live;
      (f.service as any).broker.isCurrent = (admission: any) =>
        admission.frame === live.frame &&
        admission.generation === live.generation;
      const prepared = await f.service.prepare(grant.token, queueCommands[3]);
      const ledger = (f.service as any).operations,
        row = ledger.rows.get(prepared.operationId);
      const before = JSON.stringify({
        receipt: row.receipt,
        expires: row.expires,
        hold: row.physicalHold,
      });
      const original = f.store.authorize.bind(f.store);
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>((yes) => (release = yes)),
        entry = new Promise<void>((yes) => (entered = yes));
      f.store.authorize = async (...args: any[]) => {
        const principal = await original(...args);
        expect(args[3]).toBe('queue.write');
        entered();
        await barrier;
        return principal;
      };
      const running = f.service.operation(grant.token, row.id);
      await entry;
      if (change === 'frame') live = { frame: {}, generation: 0 };
      if (change === 'generation') live = { frame, generation: 1 };
      if (change === 'service')
        f.service.configure({ ...f.config, port: f.port });
      if (change === 'grant') await f.store.revoke(grant.record.id, () => true);
      const expected = expect(running).rejects.toMatchObject({
        code: 'retired',
      });
      release();
      await expected;
      // Configure intentionally retires pending rows; invocation itself must preserve that authoritative receipt.
      expect(row.expires).toBe(JSON.parse(before).expires);
      expect(row.physicalHold).toBe(false);
      expect(row.receipt).toEqual(
        change === 'service'
          ? { operationId: row.id, status: 'retired', error: 'retired' }
          : JSON.parse(before).receipt,
      );
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('Q4 real actor removes exact duplicate once and stale revision cannot rebase', async () => {
  const f = actorFixture();
  try {
    const read = f.read({ operation: 'queue' });
    await f.flush();
    const queueRevision = read.result().value.queueRevision;
    const command = {
      action: 'remove_from_queue',
      queueRevision,
      index: 1,
      expectedVideoId: 'abcdefghijk',
    };
    const remove = f.read(actionInput(command));
    await f.flush();
    expect(remove.result()).toEqual({
      ok: true,
      value: { version: 1, phase: 'owned_queue_dispatch' },
    });
    const stale = f.read(actionInput(command));
    await f.flush();
    expect(stale.result()).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(f.effects).toEqual(['guard', 'REMOVE_ITEM']);
    expect(f.dispatches[0]).toEqual({
      receiver: f.queue,
      action: { type: 'REMOVE_ITEM', payload: 1 },
    });
    expect(f.fetches).toHaveLength(0);
  } finally {
    f.close();
  }
});

for (const response of ['empty', 'absent start'] as const)
  test(`Q4 canonical ${response} preserves existing start slicing semantics`, async () => {
    const f = actorFixture();
    try {
      const job = f.read(
        actionInput({
          action: 'enqueue_playlist',
          playlistId: 'PL1234567890123456',
          ...(response === 'absent start' ? { videoId: 'ddddddddddd' } : {}),
          insertPosition: 'INSERT_AT_END',
        }),
      );
      f.fetches[0].resolve({
        queueDatas: response === 'empty' ? [] : queueRows('bbbbbbbbbbb'),
      });
      await f.flush();
      expect(job.result()).toEqual({
        ok: true,
        value:
          response === 'empty'
            ? { version: 1, phase: 'owned_queue_noop', count: 0 }
            : { version: 1, phase: 'owned_queue_dispatch', count: 1 },
      });
      expect(f.effects).toEqual(
        response === 'empty' ? ['guard'] : ['guard', 'ADD_ITEMS'],
      );
      expect(f.dispatches).toHaveLength(response === 'empty' ? 0 : 1);
      if (response === 'absent start')
        expect(
          f.dispatches[0].action.payload.items.map(
            (r: any) => r.playlistPanelVideoRenderer.videoId,
          ),
        ).toEqual(['bbbbbbbbbbb']);
    } finally {
      f.close();
    }
  });

test('Q4 canceled actor retains four physical music slots until real canonical fetch finally', async () => {
  const f = actorFixture();
  try {
    const jobs = Array.from({ length: 4 }, () =>
      f.read(
        actionInput({
          action: 'enqueue_song',
          videoId: 'bbbbbbbbbbb',
          insertPosition: 'INSERT_AT_END',
        }),
      ),
    );
    const queued = f.read({ operation: 'queue' });
    f.listeners.get('peard:music-cancel')({ ...jobs[0].ready, phase: 'read' });
    await f.flush();
    expect(jobs[0].result()).toBeUndefined();
    expect(queued.result()).toBeUndefined();
    expect(f.fetches).toHaveLength(1);
    f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
    await f.flush();
    expect(jobs[0].result()?.ok).toBe(false);
    expect(queued.result()?.ok).toBe(true);
    expect(f.fetches).toHaveLength(2);
    expect(f.dispatches).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('Q4 native grant editor independently selects queue.write', async () => {
  const source = await musicModuleSource(
    'src/plugins/api-server/music-menu.ts',
  );
  const resource = 'http://127.0.0.1:26538/api/v1/music';
  const dialogs: any[] = [],
    issued: any[] = [],
    selections = [7, 2, 0];
  const service = {
    resource,
    captureNativeOwner: () => ({ current: () => true }),
    grants: {
      issue: async (...args: any[]) => {
        issued.push(args);
        return { token: 'synthetic', record: { id: 'owned' } };
      },
      revoke: async () => {},
    },
  };
  const menu = await source.createMusicGrantMenu(
    {
      getConfig: async () => ({ enabled: true, musicApiEnabled: true }),
      setConfig: async () => {},
    },
    () => service,
    {
      prompt: async () => 'Queue client',
      show: async (options: any) => {
        dialogs.push(options);
        return { response: selections.shift() };
      },
      copy() {},
    },
  );
  await menu.find((item: any) => item.label === 'Create client grant…').click();
  expect(issued[0].slice(0, 4)).toEqual([
    'Queue client',
    'rest',
    resource,
    ['queue.write'],
  ]);
  expect(dialogs[0].buttons[7]).toBe('Add queue write');
  expect(dialogs[1].buttons[7]).toBe('Remove queue write');
});

test('Q4 strict schemas reject getters, coercion, extra fields and route disagreement before native work', async () => {
  const parser = await musicModuleSource(
    'src/plugins/api-server/backend/scheme/music.ts',
  );
  let getterCalls = 0;
  const accessor = { action: 'enqueue_song' };
  Object.defineProperty(accessor, 'videoId', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'abcdefghijk';
    },
  });
  for (const input of [
    accessor,
    { ...queueCommands[0], url: 'https://invalid.test' },
    { ...queueCommands[2], index: '0' },
    { ...queueCommands[2], index: -1 },
    { ...queueCommands[2], index: 2048 },
    { ...queueCommands[3], queueRevision: 'stale' },
    { ...queueCommands[1], insertPosition: 'END' },
    { ...queueCommands[1], videoId: null },
    {
      ...queueCommands[0],
      operationId: '00000000-0000-4000-8000-000000000001',
    },
  ])
    expect(() => parser.parseMusicOperationPrepareInput(input)).toThrow();
  expect(getterCalls).toBe(0);
  const f = await musicHttpFixture();
  try {
    const grant = await f.store.issue(
        'Q4 strict',
        'rest',
        f.service.resource,
        ['queue.write'],
        () => true,
      ),
      headers = { authorization: 'Bearer ' + grant.token };
    const frame = {};
    (f.service as any).broker.capture = () => ({ frame, generation: 0 });
    const p = await f.service.prepare(grant.token, queueCommands[2]);
    for (const [route, method, input] of [
      [
        '/queue/1',
        'DELETE',
        { ...queueCommands[2], operationId: p.operationId },
      ],
      [
        '/queue/1',
        'DELETE',
        {
          queueRevision: '1'.repeat(32),
          expectedVideoId: 'abcdefghijk',
          index: 0,
          operationId: p.operationId,
        },
      ],
      [
        '/queue?force=true',
        'DELETE',
        { queueRevision: '1'.repeat(32), operationId: p.operationId },
      ],
      [
        '/queue/song',
        'POST',
        {
          action: 'enqueue_song',
          videoId: 'abcdefghijk',
          operationId: p.operationId,
        },
      ],
    ] as const) {
      const body = JSON.stringify(input);
      expect(
        (
          await f.http('/api/v1/music' + route, method, body, {
            ...headers,
            'content-length': String(Buffer.byteLength(body)),
          })
        ).status,
      ).toBe(400);
    }
    expect((await f.service.operation(grant.token, p.operationId)).status).toBe(
      'pending',
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const detach of [false, true])
  test(`Q4 MR1 native API lifetime survives stable isConnected shadow detach=${detach}`, async () => {
    const f = actorFixture();
    try {
      Object.defineProperty(f.api, 'isConnected', {
        value: true,
        configurable: true,
      });
      const job = f.read(
        actionInput({
          action: 'enqueue_song',
          videoId: 'bbbbbbbbbbb',
          insertPosition: 'INSERT_AT_END',
        }),
      );
      expect(f.fetches).toHaveLength(1);
      if (detach) f.api.remove();
      expect(f.api.isConnected).toBe(true);
      f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
      await f.flush();
      if (detach) {
        expect(f.dispatches).toHaveLength(0);
        expect(job.result()).toEqual({ ok: false, reason: 'source' });
      } else {
        expect(f.dispatches).toHaveLength(1);
        expect(f.dispatches[0].receiver).toBe(f.queue);
        expect(job.result()).toEqual({
          ok: true,
          value: { version: 1, phase: 'owned_queue_dispatch', count: 1 },
        });
      }
    } finally {
      f.close();
    }
  });

test('Q4 MR2 process context read retirement prevents captured fetch and ADD_ITEMS', async () => {
  const f = actorFixture();
  try {
    let reads = 0;
    const original = f.store.getState;
    f.store.getState = () => {
      const state = original();
      if (++reads === 3) f.queue.remove();
      return state;
    };
    const job = f.read(
      actionInput({
        action: 'enqueue_song',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AT_END',
      }),
    );
    await f.flush();
    expect(reads).toBe(3);
    expect(f.queue.isConnected).toBe(false);
    expect(f.fetches).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(f.effects).toEqual(['guard']);
    expect(job.result()).toEqual({ ok: false, reason: 'source' });
  } finally {
    f.close();
  }
});

import { stripTypeScriptTypes } from 'node:module';
async function nativeQueueOracle() {
  const source = await readFile(
    path.join(import.meta.dirname, 'api-music-queue-actions-native.test.ts'),
    'utf8',
  );
  const assertions = source
    .slice(source.indexOf('export function assertQueueNativeProof'))
    .replace('export function', 'function');
  return new Function(
    'expect',
    stripTypeScriptTypes(assertions) + ';return assertQueueNativeProof;',
  )(expect);
}
test('Q4 MR3 exact native oracle rejects the unchanged review corrupted proof', async () => {
  const assertProof = await nativeQueueOracle();
  const proof = {
    receipts: Array.from({ length: 4 }, () => ({
      status: 200,
      body: { status: 'accepted', meaning: 'owned_queue_dispatch' },
    })),
    canceled: { body: { status: 'uncertain' } },
    renderer: {
      sameCore: true,
      items: 0,
      effects: [
        { type: 'ADD_ITEMS', receiver: true, payload: { items: [] } },
        { type: 'ADD_ITEMS', receiver: true, payload: { items: [] } },
        { type: 'guard', receiver: true },
        { type: 'SET_PLAYER_PAGE_INFO', receiver: true },
        { type: 'CLEAR', receiver: true },
      ],
      fetches: Array.from({ length: 3 }, () => ({
        url: '/music/get_queue',
        data: { wrong: true },
      })),
    },
  };
  expect(() => assertProof(proof)).toThrow();
});
function literalNativeProof() {
  const row = (videoId: string) => ({
    playlistPanelVideoRenderer: {
      videoId,
      title: { simpleText: 'Synthetic row' },
      selected: false,
    },
  });
  return {
    receipts: Array.from({ length: 4 }, () => ({
      status: 200,
      body: { status: 'accepted', meaning: 'owned_queue_dispatch' },
    })),
    canceled: { body: { status: 'uncertain' } },
    beforeRemove: {
      ids: [
        'abcdefghijk',
        'ccccccccccc',
        'ccccccccccc',
        'abcdefghijk',
        'abcdefghijk',
        'bbbbbbbbbbb',
        'ccccccccccc',
        'ccccccccccc',
      ],
      originalMarkers: ['duplicate-A', 'duplicate-B', 'duplicate-C'],
    },
    afterRemove: {
      ids: [
        'abcdefghijk',
        'ccccccccccc',
        'abcdefghijk',
        'abcdefghijk',
        'bbbbbbbbbbb',
        'ccccccccccc',
        'ccccccccccc',
      ],
      retainedReferenceIndices: [0, 2, 3, 4, 5, 6, 7],
      removedReferenceAbsent: true,
      originalMarkers: ['duplicate-A', 'duplicate-B', 'duplicate-C'],
    },
    restBeforeRemove: [
      'abcdefghijk',
      'ccccccccccc',
      'ccccccccccc',
      'abcdefghijk',
      'abcdefghijk',
      'bbbbbbbbbbb',
      'ccccccccccc',
      'ccccccccccc',
    ],
    restAfterRemove: [
      'abcdefghijk',
      'ccccccccccc',
      'abcdefghijk',
      'abcdefghijk',
      'bbbbbbbbbbb',
      'ccccccccccc',
      'ccccccccccc',
    ],
    renderer: {
      sameCore: true,
      items: 0,
      fetches: [
        {
          url: '/music/get_queue',
          data: {
            queueContextParams: 'owned-context',
            videoIds: ['bbbbbbbbbbb'],
            queueInsertPosition: 'INSERT_AT_END',
          },
        },
        {
          url: '/music/get_queue',
          data: {
            queueContextParams: 'owned-context',
            playlistId: 'PL1234567890123456',
          },
        },
        {
          url: '/music/get_queue',
          data: {
            queueContextParams: 'owned-context',
            videoIds: ['ddddddddddd'],
            queueInsertPosition: 'INSERT_AT_END',
          },
        },
      ],
      effects: [
        { type: 'guard', receiver: true },
        {
          type: 'ADD_ITEMS',
          receiver: true,
          payload: {
            nextQueueItemId: 10,
            index: 3,
            items: [row('bbbbbbbbbbb'), row('ccccccccccc'), row('ccccccccccc')],
            shuffleEnabled: false,
            shouldAssignIds: true,
          },
        },
        { type: 'guard', receiver: true },
        {
          type: 'ADD_ITEMS',
          receiver: true,
          payload: {
            nextQueueItemId: 10,
            index: 1,
            items: [row('ccccccccccc'), row('ccccccccccc')],
            shuffleEnabled: false,
            shouldAssignIds: true,
          },
        },
        { type: 'guard', receiver: true },
        { type: 'REMOVE_ITEM', receiver: true, payload: 1 },
        { type: 'guard', receiver: true },
        { type: 'guard', receiver: true },
        {
          type: 'SET_PLAYER_PAGE_INFO',
          receiver: true,
          payload: { open: false },
        },
        { type: 'CLEAR', receiver: true },
      ],
    },
  };
}
test('Q4 MR3 independent literal positive proof satisfies actual native oracle', async () => {
  const assertProof = await nativeQueueOracle();
  expect(() => assertProof(literalNativeProof())).not.toThrow();
});
for (const defect of [
  'wrong fetch',
  'empty ADD',
  'missing REMOVE',
  'wrong index',
  'wrong retained duplicate',
  'missing intermediate',
])
  test(`Q4 MR3 oracle rejects ${defect}`, async () => {
    const assertProof = await nativeQueueOracle(),
      proof = literalNativeProof();
    if (defect === 'wrong fetch')
      (proof.renderer.fetches[0] as any).data = { wrong: true };
    if (defect === 'empty ADD')
      (proof.renderer.effects[1] as any).payload.items = [];
    if (defect === 'missing REMOVE') proof.renderer.effects.splice(5, 1);
    if (defect === 'wrong index')
      (proof.renderer.effects[5] as any).payload = 0;
    if (defect === 'wrong retained duplicate')
      proof.afterRemove.retainedReferenceIndices = [0, 1, 3, 4, 5, 6, 7];
    if (defect === 'missing intermediate') proof.restAfterRemove = [];
    expect(() => assertProof(proof)).toThrow();
  });

test('Q4 MR1 terminal descriptor callout cannot detach shadowed API before fetch', async () => {
  const f = actorFixture();
  try {
    Object.defineProperty(f.api, 'isConnected', {
      value: true,
      configurable: true,
    });
    let reads = 0,
      afterContext = false;
    const getState = f.store.getState;
    f.store.getState = () => {
      const state = getState();
      if (++reads === 3) afterContext = true;
      return state;
    };
    const app = f.doc.querySelector('ytmusic-app') as any;
    app.networkManager = new Proxy(app.networkManager, {
      getOwnPropertyDescriptor(target, key) {
        if (afterContext && key === 'fetch') f.api.remove();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const job = f.read(
      actionInput({
        action: 'enqueue_song',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AT_END',
      }),
    );
    await f.flush();
    expect(f.api.isConnected).toBe(true);
    expect(f.fetches).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(job.result()).toEqual({ ok: false, reason: 'source' });
  } finally {
    f.close();
  }
});

async function nativeCleanupContract(
  fileName = 'api-music-queue-actions-native.test.ts',
) {
  const source = await readFile(
    path.join(import.meta.dirname, fileName),
    'utf8',
  );
  const functions = source
    .slice(
      source.indexOf('export async function cleanupOwnedNativeChild'),
      source.indexOf('/** Actual broker/controller'),
    )
    .replaceAll('export ', '');
  return new Function(
    stripTypeScriptTypes(functions) +
      ';return {cleanupOwnedNativeChild,assertNativeCleanupComplete,retireOwnedWindowsFixture,ownedWindowsCohortAbsent,planOwnedQuery,createOwnedQueryScope,ownedNativeTimingReceipt};',
  )();
}
function cleanupClock(
  options: {
    kill?: 'false' | 'throw';
    closed?: boolean;
    tree?: 'unknown' | 'throw' | 'never';
    removeThrows?: boolean;
  } = {},
) {
  let now = 0,
    closed = !!options.closed,
    serial = 0,
    close!: (value: boolean) => void;
  const waiting = new Promise<boolean>((yes) => (close = yes)),
    timers = new Map<number, { at: number; callback: () => void }>(),
    events: string[] = [];
  const child = {
    kill() {
      events.push('kill');
      if (options.kill === 'throw') throw Error('kill failed');
      return options.kill !== 'false';
    },
  };
  const ports = {
    now: () => now,
    timer(callback: () => void, ms: number) {
      const id = ++serial;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clear(id: number) {
      timers.delete(id);
    },
    closed: () => closed,
    waitClose: () => waiting,
    queriesClosed: () => true,
    treeEmpty: async () => {
      events.push('tree');
      if (options.tree === 'throw') throw Error('query failed');
      if (options.tree === 'never') return new Promise<boolean>(() => {});
      return options.tree !== 'unknown';
    },
    remove: async () => {
      events.push('remove');
      if (options.removeThrows) throw Error('rm failed');
    },
    record: () => {
      events.push('record');
    },
    release: () => {
      events.push('release');
    },
  };
  return {
    child,
    ports,
    events,
    close() {
      closed = true;
      events.push('close');
      close(true);
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      for (let i = 0; i < 16; i++) await Promise.resolve();
    },
    pendingTimers: () => timers.size,
  };
}
test('Q4 MR4 unknown child close never deletes the profile', async () => {
  const { cleanupOwnedNativeChild } = await nativeCleanupContract(),
    clock = cleanupClock({ kill: 'false' });
  const running = cleanupOwnedNativeChild(clock.child, clock.ports);
  await clock.advance(2000);
  const result = await running;
  expect(result).toMatchObject({
    complete: false,
    closed: false,
    killRequested: false,
    treeEmpty: false,
    removed: false,
  });
  expect(clock.events).toEqual(['kill', 'record', 'release']);
  expect(clock.pendingTimers()).toBe(0);
});
for (const tree of ['unknown', 'throw', 'never'] as const)
  test(`Q4 MR4 main close with ${tree} tree witness retains profile and releases owned handles`, async () => {
    const { cleanupOwnedNativeChild } = await nativeCleanupContract(),
      clock = cleanupClock({ closed: true, tree });
    const running = cleanupOwnedNativeChild(clock.child, clock.ports);
    await clock.advance(tree === 'never' ? 2000 : 0);
    const result = await running;
    expect(result).toMatchObject({
      complete: false,
      closed: true,
      treeEmpty: false,
      removed: false,
    });
    expect(clock.events).toEqual(['tree', 'record', 'release']);
    expect(clock.pendingTimers()).toBe(0);
  });
test('Q4 MR4 profile deletion follows actual close and independent tree-empty witness', async () => {
  const { cleanupOwnedNativeChild } = await nativeCleanupContract(),
    clock = cleanupClock();
  const running = cleanupOwnedNativeChild(clock.child, clock.ports);
  await clock.advance(1000);
  expect(clock.events).toEqual(['kill']);
  clock.close();
  await clock.advance(0);
  expect(await running).toMatchObject({
    complete: true,
    closed: true,
    treeEmpty: true,
    removed: true,
  });
  expect(clock.events).toEqual(['kill', 'close', 'tree', 'remove', 'record']);
  expect(clock.pendingTimers()).toBe(0);
});
for (const fault of ['kill', 'query', 'remove'] as const)
  test(`Q4 MR4 ${fault} failure preserves original native error`, async () => {
    const { cleanupOwnedNativeChild, assertNativeCleanupComplete } =
      await nativeCleanupContract();
    const clock = cleanupClock(
      fault === 'kill'
        ? { kill: 'throw' }
        : fault === 'query'
          ? { closed: true, tree: 'throw' }
          : { closed: true, removeThrows: true },
    );
    const original = Error('original native timeout');
    const running = (async () => {
      try {
        throw original;
      } finally {
        const result = await cleanupOwnedNativeChild(clock.child, clock.ports);
        assertNativeCleanupComplete(result, original, '/owned');
      }
    })();
    const check = expect(running).rejects.toBe(original);
    await clock.advance(fault === 'kill' ? 2000 : 0);
    await check;
    expect(clock.events).toContain('record');
    expect(clock.events).toContain('release');
    expect(clock.pendingTimers()).toBe(0);
  });
test('Q4 MR4 incomplete cleanup cannot turn a successful task into positive native evidence', async () => {
  const { assertNativeCleanupComplete } = await nativeCleanupContract();
  expect(() =>
    assertNativeCleanupComplete({ complete: false }, undefined, '/owned'),
  ).toThrow('cleanup incomplete');
});
test('Q4 MR4 new fixture canonicalizes tmp alias once before deriving owned paths', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, 'api-music-queue-actions-native.test.ts'),
    'utf8',
  );
  const declaration = source.slice(
    source.indexOf('  const owned ='),
    source.indexOf('  const evidence ='),
  );
  let canonicalizations = 0;
  const run = new Function(
    'prepared',
    'mkdtemp',
    'path',
    'tmpdir',
    'realpathSync',
    'return (async()=>{' + declaration + ';return owned;})()',
  );
  const owned = await run(
    undefined,
    async () => '/var/owned-fixture',
    path,
    () => '/var',
    (value: string) => {
      canonicalizations++;
      expect(value).toBe('/var/owned-fixture');
      return '/private/var/owned-fixture';
    },
  );
  expect(canonicalizations).toBe(1);
  expect(owned).toBe('/private/var/owned-fixture');
  expect(path.join(owned, 'profile')).toBe(
    path.join('/private/var/owned-fixture', 'profile'),
  );
});

test('Q4 MR4 qualified Windows fixture retirement checks live leader twice before fixed tree tool', async () => {
  const { retireOwnedWindowsFixture, ownedWindowsCohortAbsent } =
    await nativeCleanupContract();
  const cohort = [
      { pid: 101, parent: 10, creation: 'leader-one' },
      { pid: 102, parent: 101, creation: 'child-one' },
    ],
    events: string[] = [];
  const result = await retireOwnedWindowsFixture(
    { pid: 101 },
    { pid: 101, parent: 10 },
    {
      live: () => true,
      cohort: async () => {
        events.push('cohort');
        return cohort;
      },
      leader: async () => {
        events.push('leader');
        return [cohort[0]];
      },
      terminate: async () => {
        events.push('fixed tree tool');
      },
    },
  );
  expect(events).toEqual(['cohort', 'leader', 'fixed tree tool']);
  expect(result).toEqual({ cohort, forcedFixtureRetirement: true });
  expect(ownedWindowsCohortAbsent(cohort, [])).toBe(true);
  expect(
    ownedWindowsCohortAbsent(cohort, [{ pid: 102, creation: 'child-one' }]),
  ).toBe(false);
  expect(
    ownedWindowsCohortAbsent(cohort, [
      { pid: 102, creation: 'reused-pid-new-process' },
    ]),
  ).toBe(true);
  expect(ownedWindowsCohortAbsent([], [])).toBe(false);
  expect(
    ownedWindowsCohortAbsent(cohort, [
      { pid: 'unknown', creation: 'child-one' },
    ]),
  ).toBe(false);
});
for (const fault of [
  'closed',
  'wrong parent',
  'reused leader',
  'exit during query',
  'query error',
  'tree tool error',
] as const)
  test(`Q4 MR4 Windows ${fault} cannot authorize unsafe tree deletion`, async () => {
    const { retireOwnedWindowsFixture } = await nativeCleanupContract();
    const leader = {
      pid: 101,
      parent: fault === 'wrong parent' ? 99 : 10,
      creation: 'leader-one',
    };
    let live = fault !== 'closed',
      calls = 0;
    const run = retireOwnedWindowsFixture(
      { pid: 101 },
      { pid: 101, parent: 10 },
      {
        live: () => live,
        cohort: async () => {
          if (fault === 'query error') throw Error('query failed');
          return [leader];
        },
        leader: async () => {
          if (fault === 'exit during query') live = false;
          return [
            {
              ...leader,
              creation:
                fault === 'reused leader'
                  ? 'different-creation'
                  : leader.creation,
            },
          ];
        },
        terminate: async () => {
          calls++;
          if (fault === 'tree tool error') throw Error('fixed tool failed');
        },
      },
    );
    await expect(run).rejects.toThrow();
    expect(calls).toBe(fault === 'tree tool error' ? 1 : 0);
  });

test('Q4 MR2 terminal descriptor callout cannot disconnect captured queue before fetch', async () => {
  const f = actorFixture();
  try {
    let reads = 0,
      afterContext = false;
    const getState = f.store.getState;
    f.store.getState = () => {
      const state = getState();
      if (++reads === 3) afterContext = true;
      return state;
    };
    const app = f.doc.querySelector('ytmusic-app') as any;
    app.networkManager = new Proxy(app.networkManager, {
      getOwnPropertyDescriptor(target, key) {
        if (afterContext && key === 'fetch') f.queue.remove();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const job = f.read(
      actionInput({
        action: 'enqueue_song',
        videoId: 'bbbbbbbbbbb',
        insertPosition: 'INSERT_AT_END',
      }),
    );
    await f.flush();
    expect(f.fetches).toHaveLength(0);
    expect(f.dispatches).toHaveLength(0);
    expect(job.result()).toEqual({ ok: false, reason: 'source' });
  } finally {
    f.close();
  }
});

for (const fileName of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
])
  test(`${fileName} clears work timer after supplied unlaunched failure`, async () => {
    const source = await readFile(
      path.join(import.meta.dirname, fileName),
      'utf8',
    );
    const guard = source.lastIndexOf(
      '    if (!keepFixture',
      source.indexOf("test('"),
    );
    const start =
      source.lastIndexOf('  } finally {', guard) + '  } finally {'.length;
    const block = source.slice(start, source.indexOf('\n  }\n}', guard));
    let cleared = 0,
      cleanups = 0;
    const run = new Function(
      'workTimer',
      'clearTimeout',
      'nativeTiming',
      'keepFixture',
      'prepared',
      'child',
      'queryScope',
      'cleanupOwnedNativeChild',
      'treeEmpty',
      'assertNativeCleanupComplete',
      'originalFailure',
      'owned',
      'return(async()=>{' + stripTypeScriptTypes(block) + '})()',
    );
    await run(
      1,
      () => {
        cleared++;
      },
      { nativeStartedAtMono: null },
      false,
      '/owned/old-unlaunched',
      undefined,
      {},
      () => {
        cleanups++;
      },
      () => false,
      () => {},
      Error('binding mismatch'),
      '/owned/old-unlaunched',
    );
    expect(cleared).toBe(1);
    expect(cleanups).toBe(0);
  });

for (const fileName of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
])
  test(`${fileName} shares monotonic cleanup deadline with query admission`, async () => {
    const source = await readFile(
      path.join(import.meta.dirname, fileName),
      'utf8',
    );
    const guard = source.lastIndexOf(
      '    if (!keepFixture',
      source.indexOf("test('"),
    );
    const start =
      source.lastIndexOf('  } finally {', guard) + '  } finally {'.length;
    const block = source.slice(start, source.indexOf('\n  }\n}', guard));
    const api = await nativeCleanupContract(fileName);
    let observedDeadline = 0;
    const nativeTiming = {
      nativeStartedAtMono: 1000,
      subjectClosedAtMono: 3900,
      nativeWorkEndedAtMono: null,
      cleanupStartedAtMono: null,
      cleanupEndedAtMono: null,
    };
    const bindings = {
      nativeTiming,
      workTimer: undefined,
      clearTimeout: () => {},
      setTimeout: () => 1,
      performance: { now: () => 4000 },
      Date: { now: () => 1700000000000 },
      keepFixture: false,
      prepared: undefined,
      child: undefined,
      queryScope: {
        active: () => false,
        enterCleanup: () => true,
        queriesClosed: () => true,
        complete: () => {},
      },
      cleanupOwnedNativeChild: api.cleanupOwnedNativeChild,
      treeEmpty: async (deadline: number) => {
        observedDeadline = deadline;
        return true;
      },
      assertNativeCleanupComplete: api.assertNativeCleanupComplete,
      originalFailure: undefined,
      owned: '/owned/monotonic',
      suppliedEvidence: undefined,
      rm: async () => {},
    };
    const run = new Function(
      ...Object.keys(bindings),
      'return(async()=>{' + stripTypeScriptTypes(block) + '})()',
    );
    await run(...Object.values(bindings));
    expect(observedDeadline).toBe(6000);
    expect(nativeTiming).toMatchObject({
      nativeWorkEndedAtMono: 4000,
      cleanupStartedAtMono: 4000,
      cleanupEndedAtMono: 4000,
    });
    const plan = api.planOwnedQuery('absence', {
      now: 5249,
      nativeDeadline: 25000,
      caseDeadline: 30000,
      cleanupDeadline: observedDeadline,
    });
    expect(plan.admitted).toBe(true);
    expect(plan.timeoutMs).toBe(1);
    expect(
      api.planOwnedQuery('absence', {
        now: 5250,
        nativeDeadline: 25000,
        caseDeadline: 30000,
        cleanupDeadline: observedDeadline,
      }).admitted,
    ).toBe(false);
  });

test('Q4 MR4 rejected supplied unlaunched fixture is preserved before child ownership exists', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, 'api-music-queue-actions-native.test.ts'),
    'utf8',
  );
  const start = source.lastIndexOf(
    '    if (!keepFixture',
    source.indexOf("test('Q4 actual REST"),
  );
  const block = source.slice(start, source.indexOf('\n  }\n}', start));
  let cleanups = 0;
  const run = new Function(
    'keepFixture',
    'prepared',
    'child',
    'cleanupOwnedNativeChild',
    'treeEmpty',
    'assertNativeCleanupComplete',
    'originalFailure',
    'owned',
    'return(async()=>{' + stripTypeScriptTypes(block) + '})()',
  );
  await run(
    false,
    '/owned/old-unlaunched',
    undefined,
    async () => {
      cleanups++;
      return { complete: true };
    },
    async () => false,
    () => {},
    Error('binding mismatch'),
    '/owned/old-unlaunched',
  );
  expect(cleanups).toBe(0);
});

for (const legacy of [false, true])
  test(`Q4 CM1 accepted modern clear retires terminal insertion legacy=${legacy}`, async () => {
    const f = actorFixture();
    try {
      let queueRevision: string,
        cleared: any,
        armed = false,
        clearOnce = false;
      const app = f.doc.querySelector('ytmusic-app')!;
      Object.defineProperty(app, 'isConnected', {
        configurable: true,
        get() {
          if (armed) {
            armed = false;
            cleared = f.read(
              actionInput({ action: 'clear_queue', queueRevision }),
            );
          }
          return true;
        },
      });
      const original = f.store.getState;
      f.store.getState = () => {
        const state = original();
        Object.defineProperty(state.queue, 'nextQueueItemId', {
          get() {
            if (legacy && !clearOnce) {
              clearOnce = true;
              cleared = f.read(
                actionInput({ action: 'clear_queue', queueRevision }),
              );
            } else if (!legacy) armed = true;
            return 3;
          },
        });
        return state;
      };
      const snapshot = f.read({ operation: 'queue' });
      await f.flush();
      queueRevision = snapshot.result().value.queueRevision;
      const insert = legacy
        ? (f.legacy.get('peard:add-to-queue')('bbbbbbbbbbb', 'INSERT_AT_END'),
          undefined)
        : f.read(
            actionInput({
              action: 'enqueue_song',
              videoId: 'bbbbbbbbbbb',
              insertPosition: 'INSERT_AT_END',
            }),
          );
      expect(f.fetches).toHaveLength(1);
      f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
      await f.flush();
      expect(cleared.result()).toEqual({
        ok: true,
        value: { version: 1, phase: 'owned_queue_dispatch' },
      });
      expect(f.dispatches.map((p) => p.action)).toEqual([
        { type: 'SET_PLAYER_PAGE_INFO', payload: { open: false } },
        { type: 'CLEAR' },
      ]);
      expect(f.dispatches.map((p) => p.receiver)).toEqual([f.store, f.queue]);
      expect(f.effects).toEqual([
        'guard',
        'guard',
        'SET_PLAYER_PAGE_INFO',
        'CLEAR',
      ]);
      if (insert)
        expect(insert.result()).toEqual({ ok: false, reason: 'source' });
      expect(f.fetches).toHaveLength(1);
    } finally {
      f.close();
    }
  });

for (const legacy of [false, true])
  for (const retirement of ['retire', 'dispose'] as const)
    test(`Q4 CM1 context ${retirement} fences canonical fetch legacy=${legacy}`, async () => {
      const f = actorFixture();
      try {
        let reads = 0;
        const original = f.store.getState;
        f.store.getState = () => {
          const state = original();
          if (++reads === 3) {
            if (retirement === 'retire') f.core.playlistQueue.retireOwned();
            else f.core.playlistQueue.dispose();
          }
          return state;
        };
        const insert = legacy
          ? (f.legacy.get('peard:add-to-queue')('bbbbbbbbbbb', 'INSERT_AT_END'),
            undefined)
          : f.read(
              actionInput({
                action: 'enqueue_song',
                videoId: 'bbbbbbbbbbb',
                insertPosition: 'INSERT_AT_END',
              }),
            );
        await f.flush();
        expect(reads).toBe(3);
        expect(f.queue.isConnected).toBe(true);
        expect(f.fetches).toHaveLength(0);
        expect(f.dispatches).toHaveLength(0);
        if (insert)
          expect(insert.result()).toEqual({ ok: false, reason: 'source' });
      } finally {
        f.close();
      }
    });

for (const legacy of [false, true])
  test(`Q4 CM1 connected canonical insertion retains captured receiver and arguments legacy=${legacy}`, async () => {
    const f = actorFixture();
    try {
      const insert = legacy
        ? (f.legacy.get('peard:add-to-queue')('bbbbbbbbbbb', 'INSERT_AT_END'),
          undefined)
        : f.read(
            actionInput({
              action: 'enqueue_song',
              videoId: 'bbbbbbbbbbb',
              insertPosition: 'INSERT_AT_END',
            }),
          );
      expect(f.fetches).toHaveLength(1);
      expect(f.fetches[0]).toMatchObject({
        url: '/music/get_queue',
        data: {
          queueContextParams: 'context',
          videoIds: ['bbbbbbbbbbb'],
          queueInsertPosition: 'INSERT_AT_END',
        },
      });
      f.fetches[0].resolve({
        queueDatas: queueRows('bbbbbbbbbbb', 'ccccccccccc'),
      });
      await f.flush();
      expect(f.dispatches).toHaveLength(1);
      expect(f.dispatches[0].receiver).toBe(f.queue);
      expect(f.dispatches[0].action).toEqual({
        type: 'ADD_ITEMS',
        payload: {
          nextQueueItemId: 3,
          index: 3,
          items: ['bbbbbbbbbbb', 'ccccccccccc'].map((videoId) => ({
            playlistPanelVideoRenderer: { videoId, selected: false },
          })),
          shuffleEnabled: false,
          shouldAssignIds: true,
        },
      });
      expect(f.effects).toEqual(['guard', 'ADD_ITEMS']);
      if (insert)
        expect(insert.result()).toEqual({
          ok: true,
          value: { version: 1, phase: 'owned_queue_dispatch', count: 2 },
        });
    } finally {
      f.close();
    }
  });

for (const method of ['fetch', 'dispatch'] as const)
  test(`Q4 CM1 legacy ${method} getter retirement precedes final private effect fence`, async () => {
    const f = actorFixture();
    try {
      const target =
        method === 'fetch'
          ? (f.doc.querySelector('ytmusic-app') as any).networkManager
          : f.queue;
      const original = target[method];
      Object.defineProperty(target, method, {
        configurable: true,
        get() {
          f.core.playlistQueue.retireOwned();
          return original;
        },
      });
      f.legacy.get('peard:add-to-queue')('bbbbbbbbbbb', 'INSERT_AT_END');
      if (method === 'dispatch') {
        expect(f.fetches).toHaveLength(1);
        f.fetches[0].resolve({ queueDatas: queueRows('bbbbbbbbbbb') });
      }
      await f.flush();
      expect(f.dispatches).toHaveLength(0);
      if (method === 'fetch') expect(f.fetches).toHaveLength(0);
    } finally {
      f.close();
    }
  });

function ownedQueryClock(
  api: any,
  options: {
    spawnError?: Error;
    recordThrows?: boolean;
    kill?: 'false' | 'throw';
    nowSequence?: number[];
  } = {},
) {
  let now = 0,
    serial = 0;
  const timers = new Map<number, { at: number; callback(): void }>(),
    handles: any[] = [],
    receipts: any[] = [],
    retained = new Set<any>();
  const scope = api.createOwnedQueryScope({
    execFile(command: string, args: string[], settings: any, callback: any) {
      if (options.spawnError) throw options.spawnError;
      const child: any = new EventEmitter();
      Object.assign(child, {
        pid: 3000 + handles.length,
        exitCode: null,
        signalCode: null,
        killed: false,
        kills: 0,
        command,
        args,
        settings,
        callback,
      });
      child.kill = () => {
        child.kills++;
        if (options.kill === 'throw') throw Error('kill unavailable');
        child.killed = options.kill !== 'false';
        return options.kill !== 'false';
      };
      handles.push(child);
      return child;
    },
    now: () => {
      const next = options.nowSequence?.shift();
      if (next !== undefined) now = next;
      return now;
    },
    timer(callback: () => void, ms: number) {
      const id = ++serial;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clear: (id: number) => {
      timers.delete(id);
    },
    record(value: any) {
      if (options.recordThrows) throw Error('sink unavailable');
      receipts.push(JSON.parse(JSON.stringify(value)));
    },
    retain: (owner: any) => {
      retained.add(owner);
    },
    release: (owner: any) => {
      retained.delete(owner);
    },
    onFailure() {},
  });
  const flush = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  return {
    scope,
    handles,
    receipts,
    retained,
    run(
      phase = 'cohort',
      context: any = { nativeDeadline: 25000, caseDeadline: 30000 },
      admitted?: () => void,
    ) {
      let result: any;
      const promise = scope.run(
        'powershell.exe',
        ['owned-only'],
        'owned-cim-cohort',
        phase,
        context,
        admitted,
      );
      promise.then(
        (value: string) => {
          result = { value };
        },
        (error: unknown) => {
          result = { error };
        },
      );
      return { promise, result: () => result };
    },
    reply(index = 0, error: any = null, stdout = '[]', stderr = '') {
      handles[index].callback(error, stdout, stderr);
    },
    close(index = 0) {
      handles[index].exitCode = 0;
      handles[index].emit('close', 0, null);
    },
    setNow(value: number) {
      now = value;
    },
    flush,
    async advance(value: number) {
      if (value < now) throw Error('Nonmonotonic virtual clock');
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.at <= value)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await flush();
      }
      now = value;
      await flush();
    },
    pendingTimers: () => timers.size,
  };
}
for (const adapter of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
]) {
  test(`CIM budget ${adapter} caps, reserves and positive boundary admission`, async () => {
    const { planOwnedQuery } = await nativeCleanupContract(adapter);
    const phases: Record<
      string,
      { cap: number; after: number; cleanup: boolean }
    > = {
      cohort: { cap: 5000, after: 8000, cleanup: false },
      leader: { cap: 5000, after: 2500, cleanup: false },
      taskkill: { cap: 1000, after: 1000, cleanup: false },
      absence: { cap: 1000, after: 250, cleanup: true },
      'posix-identity': { cap: 1000, after: 1000, cleanup: false },
      'posix-group-list': { cap: 1000, after: 250, cleanup: true },
    };
    for (const [phase, c] of Object.entries(phases))
      for (const caseDeadline of [12000, 30000, 60000])
        for (const nativeDeadline of [10000, 25000])
          for (const now of [
            -0.5, 0, 1000, 1749, 1750, 2499, 2500, 7499, 7500, 8499, 8500,
            11499, 11500, 13499, 13500, 20000, 24999, 25000, 30000,
          ]) {
            const result = planOwnedQuery(phase, {
              now,
              nativeDeadline,
              caseDeadline,
              cleanupDeadline: 2000,
            });
            const end = c.cleanup
              ? Math.min(2000, caseDeadline - 1000)
              : Math.min(nativeDeadline, caseDeadline - 3000);
            if (result.admitted) {
              expect(result.timeoutMs).toBeGreaterThan(0);
              expect(Number.isSafeInteger(result.timeoutMs)).toBe(true);
              expect(result.timeoutMs).toBeLessThanOrEqual(c.cap);
              expect(result.terminalAt + c.after).toBeLessThanOrEqual(end);
            } else expect(result.reason).toBe('budget-exhausted');
          }
    expect(
      planOwnedQuery('cohort', {
        now: 11500,
        nativeDeadline: 25000,
        caseDeadline: 100000,
      }).timeoutMs,
    ).toBe(5000);
    expect(
      planOwnedQuery('cohort', {
        now: 16499,
        nativeDeadline: 25000,
        caseDeadline: 100000,
      }).timeoutMs,
    ).toBe(1);
    expect(
      planOwnedQuery('cohort', {
        now: 16500,
        nativeDeadline: 25000,
        caseDeadline: 100000,
      }).admitted,
    ).toBe(false);
    expect(
      planOwnedQuery('absence', {
        now: 1249,
        nativeDeadline: 25000,
        caseDeadline: 30000,
        cleanupDeadline: 2000,
      }).timeoutMs,
    ).toBe(1);
    expect(
      planOwnedQuery('absence', {
        now: 1250,
        nativeDeadline: 25000,
        caseDeadline: 30000,
        cleanupDeadline: 2000,
      }).admitted,
    ).toBe(false);
    expect(
      planOwnedQuery('cohort', {
        now: 0,
        nativeDeadline: 25000,
        caseDeadline: 30000,
        terminal: true,
      }).admitted,
    ).toBe(false);
    expect(
      planOwnedQuery('cohort', {
        now: 0,
        nativeDeadline: 25000,
        caseDeadline: 30000,
        active: true,
      }).admitted,
    ).toBe(false);
  });
  for (const order of ['callback-first', 'close-first', 'exit-not-close'])
    test(`CIM budget ${adapter} observes callback AND actual close ${order}`, async () => {
      const f = ownedQueryClock(await nativeCleanupContract(adapter)),
        run = f.run();
      if (order === 'close-first') f.close();
      else f.reply(0, null, 'PRIVATE_PAYLOAD');
      if (order === 'exit-not-close') {
        f.handles[0].exitCode = 0;
        f.handles[0].emit('exit', 0, null);
      }
      await f.flush();
      expect(run.result()).toBeUndefined();
      expect(f.scope.active()).toBe(true);
      if (order === 'close-first') f.reply();
      else {
        expect(f.scope.queriesClosed()).toBe(false);
        f.close();
      }
      await f.flush();
      expect(run.result().error).toBeUndefined();
      expect(f.scope.queriesClosed()).toBe(true);
      expect(f.retained.size).toBe(0);
      expect(f.pendingTimers()).toBe(0);
      expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE_PAYLOAD');
    });
  for (const missing of ['callback', 'close'])
    test(`CIM budget ${adapter} terminal missing ${missing} remains sticky after late event`, async () => {
      const f = ownedQueryClock(await nativeCleanupContract(adapter)),
        run = f.run();
      if (missing === 'callback') f.close();
      else f.reply();
      await f.advance(5500);
      expect(run.result().error).toBeTruthy();
      expect(f.scope.isTerminal()).toBe(true);
      expect(f.retained.size).toBe(missing === 'close' ? 1 : 0);
      if (missing === 'callback') f.reply();
      else f.close();
      await f.flush();
      expect(f.scope.isTerminal()).toBe(true);
      expect(f.retained.size).toBe(0);
      await expect(f.run('leader').promise).rejects.toBe(run.result().error);
      expect(f.handles).toHaveLength(1);
    });
  test(`CIM budget ${adapter} exact terminal equality rejects even when close precedes timer delivery`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter)),
      run = f.run();
    f.reply();
    f.setNow(5500);
    f.close();
    await f.flush();
    expect(run.result().error).toBeTruthy();
    expect(f.retained.size).toBe(0);
    expect(f.scope.isTerminal()).toBe(true);
  });
  for (const closes of [true, false])
    test(`CIM budget ${adapter} cancellation bounded drain closes=${closes}`, async () => {
      const f = ownedQueryClock(await nativeCleanupContract(adapter)),
        run = f.run(),
        original = Error('original native failure');
      const drain = f.scope.cancel('native-test-cancel', original);
      await f.flush();
      expect(run.result()).toBeUndefined();
      expect(f.handles[0].kills).toBe(1);
      if (closes) {
        f.close();
        await f.flush();
      } else {
        await f.advance(499);
        expect(run.result()).toBeUndefined();
        await f.advance(500);
      }
      await drain;
      expect(run.result().error).toBe(original);
      expect(f.retained.size).toBe(closes ? 0 : 1);
      expect(f.scope.enterCleanup()).toBe(false);
      if (!closes) {
        f.reply();
        f.close();
        await f.flush();
      }
      await expect(f.run('taskkill').promise).rejects.toBe(original);
      expect(f.handles).toHaveLength(1);
      expect(f.scope.isTerminal()).toBe(true);
    });
  for (const kill of ['false', 'throw'] as const)
    test(`CIM budget ${adapter} kill ${kill} never proves close`, async () => {
      const f = ownedQueryClock(await nativeCleanupContract(adapter), { kill }),
        run = f.run();
      void f.scope.cancel('cancel');
      await f.advance(500);
      expect(run.result().error).toBeTruthy();
      expect(f.scope.queriesClosed()).toBe(false);
      expect(f.retained.size).toBe(1);
      expect(f.scope.snapshot()[0].physicalClosed).toBe(false);
      f.close();
      await f.flush();
    });
  test(`CIM budget ${adapter} internal timeout with physical close preserves original error`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter)),
      run = f.run(),
      error = Object.assign(Error('PRIVATE_ERROR'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
      });
    f.setNow(5400);
    f.reply(0, error, 'PRIVATE_STDOUT', 'PRIVATE_STDERR');
    f.close();
    await f.flush();
    expect(run.result().error).toBe(error);
    expect(f.retained.size).toBe(0);
    expect(f.scope.snapshot()[0]).toMatchObject({
      physicalClosed: true,
      timeout: true,
      killRequested: false,
    });
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE');
  });
  test(`CIM budget ${adapter} reentry cancels owned first query without another spawn`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter)),
      first = f.run(),
      second = f.run('leader');
    await f.advance(500);
    expect(second.result().error).toBeTruthy();
    expect(first.result().error).toBe(second.result().error);
    expect(f.handles).toHaveLength(1);
    f.close();
    await f.flush();
  });
  test(`CIM budget ${adapter} exhausted admission never spawns or calls admitted hook`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter));
    f.setNow(16500);
    let admitted = false;
    const run = f.run(
      'cohort',
      { nativeDeadline: 25000, caseDeadline: 100000 },
      () => {
        admitted = true;
      },
    );
    await f.flush();
    expect(run.result().error).toBeTruthy();
    expect(f.handles).toHaveLength(0);
    expect(admitted).toBe(false);
  });
  test(`CIM budget ${adapter} synchronous spawn failure preserves error and no tool admission`, async () => {
    const original = Error('spawn unavailable'),
      f = ownedQueryClock(await nativeCleanupContract(adapter), {
        spawnError: original,
      });
    let admitted = false;
    const run = f.run(
      'taskkill',
      { nativeDeadline: 25000, caseDeadline: 30000 },
      () => {
        admitted = true;
      },
    );
    await f.flush();
    expect(run.result().error).toBe(original);
    expect(admitted).toBe(false);
    expect(f.retained.size).toBe(0);
    expect(f.pendingTimers()).toBe(0);
  });
  for (const failedQuery of [true, false])
    test(`CIM budget ${adapter} receipt failure blocks success without masking error=${failedQuery}`, async () => {
      const original = Error('original query error'),
        f = ownedQueryClock(await nativeCleanupContract(adapter), {
          recordThrows: true,
        }),
        run = f.run();
      f.reply(0, failedQuery ? original : null);
      f.close();
      await f.flush();
      expect(run.result().error).toBeTruthy();
      if (failedQuery) expect(run.result().error).toBe(original);
      expect(f.scope.isTerminal()).toBe(true);
      expect(f.retained.size).toBe(0);
    });
  test(`CIM budget ${adapter} cleanup uses same deadline and ignores late success after terminal`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter));
    expect(f.scope.enterCleanup()).toBe(true);
    const run = f.run('absence', {
      nativeDeadline: 25000,
      caseDeadline: 30000,
      cleanupDeadline: 2000,
    });
    expect(f.handles[0].settings.timeout).toBe(1000);
    await f.advance(1500);
    expect(run.result().error).toBeTruthy();
    expect(f.retained.size).toBe(1);
    f.reply();
    f.close();
    await f.flush();
    expect(f.scope.isTerminal()).toBe(true);
    expect(f.scope.snapshot()[0].logicalSettled).toBe(true);
  });
  for (const queryState of ['unknown', 'throw'])
    test(`CIM budget ${adapter} cleanup ${queryState} queries never removes and preserves original`, async () => {
      const api = await nativeCleanupContract(adapter),
        events: string[] = [],
        original = Error('original native failure');
      const result = await api.cleanupOwnedNativeChild(undefined, {
        now: () => 0,
        timer: () => 1,
        clear() {},
        closed: () => true,
        waitClose: async () => true,
        queriesClosed: () => {
          if (queryState === 'throw') throw Error('unknown');
          return false;
        },
        treeEmpty: async () => {
          events.push('absence');
          return true;
        },
        remove: async () => {
          events.push('remove');
        },
        record() {},
        release() {},
      });
      expect(result).toMatchObject({
        complete: false,
        queriesClosed: false,
        removed: false,
      });
      expect(events).toEqual([]);
      expect(() =>
        api.assertNativeCleanupComplete(result, original, '/owned'),
      ).not.toThrow();
      expect(() =>
        api.assertNativeCleanupComplete(result, undefined, '/owned'),
      ).toThrow('cleanup incomplete');
    });
  test(`CIM budget ${adapter} removal start and late completion are distinguished`, async () => {
    const api = await nativeCleanupContract(adapter);
    let now = 0,
      release!: () => void;
    const timers = new Map<number, () => void>();
    let removed = false;
    const pending = api.cleanupOwnedNativeChild(undefined, {
      now: () => now,
      timer: (fn: () => void) => {
        timers.set(1, fn);
        return 1;
      },
      clear: (id: number) => {
        timers.delete(id);
      },
      closed: () => true,
      waitClose: async () => true,
      queriesClosed: () => true,
      treeEmpty: async () => true,
      remove: () =>
        new Promise<void>((resolve) => {
          release = () => {
            removed = true;
            resolve();
          };
        }),
      record() {},
      release() {},
    });
    for (let n = 0; n < 20; n++) await Promise.resolve();
    now = 2000;
    for (const fn of [...timers.values()]) fn();
    const result = await pending;
    expect(result).toMatchObject({
      complete: false,
      removed: false,
      removalRequested: true,
    });
    expect(removed).toBe(false);
    release();
    await Promise.resolve();
    expect(removed).toBe(true);
    expect(result.complete).toBe(false);
  });
}
for (const adapter of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
]) {
  test(`CIM budget ${adapter} invalid finite admission poisons scope before spawn`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter));
    const run = f.run('cohort', { nativeDeadline: NaN, caseDeadline: 30000 });
    await f.flush();
    expect(run.result().error).toBeTruthy();
    expect(f.handles).toHaveLength(0);
    expect(f.scope.isTerminal()).toBe(true);
  });
  test(`CIM budget ${adapter} rechecks budget after synchronous admission work`, async () => {
    const f = ownedQueryClock(await nativeCleanupContract(adapter), {
      nowSequence: [0, 20000, 20000],
    });
    const run = f.run();
    await f.flush();
    expect(run.result().error).toBeTruthy();
    expect(f.handles).toHaveLength(0);
    expect(f.scope.isTerminal()).toBe(true);
    expect(f.pendingTimers()).toBe(0);
  });
}

for (const adapter of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
]) {
  test(`native timing ${adapter} rejects missing, inconsistent and exhausted receipts`, async () => {
    const { ownedNativeTimingReceipt } = await nativeCleanupContract(adapter);
    const timing = {
      caseStartedAtMono: 100,
      nativeStartedAtMono: 1100,
      subjectClosedAtMono: 4000,
      nativeWorkEndedAtMono: 4100,
      cleanupStartedAtMono: 4200,
      cleanupEndedAtMono: 5000,
    };
    expect(ownedNativeTimingReceipt(timing, 5500)).toMatchObject({
      complete: true,
      clock: 'host-performance.now',
      caseElapsedMs: 5400,
      nativeElapsedMs: 3000,
      cleanupElapsedMs: 800,
      postElapsedMs: 500,
      remainingCaseAtCleanupEndMs: 25100,
    });
    expect(ownedNativeTimingReceipt(undefined, 5500).complete).toBe(false);
    for (const changes of [
      { nativeStartedAtMono: null },
      { nativeWorkEndedAtMono: NaN },
      { subjectClosedAtMono: null },
      { subjectClosedAtMono: 4200 },
      { cleanupStartedAtMono: 4000 },
      { cleanupEndedAtMono: 6201 },
      {
        nativeWorkEndedAtMono: 27001,
        cleanupStartedAtMono: 27001,
        cleanupEndedAtMono: 27100,
      },
      {
        nativeStartedAtMono: 100,
        nativeWorkEndedAtMono: 25101,
        cleanupStartedAtMono: 25101,
        cleanupEndedAtMono: 25200,
      },
      {
        nativeStartedAtMono: 26000,
        subjectClosedAtMono: 27000,
        nativeWorkEndedAtMono: 27050,
        cleanupStartedAtMono: 28100,
        cleanupEndedAtMono: 29101,
      },
    ])
      expect(
        ownedNativeTimingReceipt(
          { ...timing, ...changes },
          Math.max(5500, changes.cleanupEndedAtMono ?? 5000) + 100,
        ).complete,
      ).toBe(false);
    expect(ownedNativeTimingReceipt(timing, 6001).complete).toBe(false);
    expect(ownedNativeTimingReceipt(timing, 4900).complete).toBe(false);
  });
  test(`native timing ${adapter} actual assertion tail requires a complete bounded receipt`, async () => {
    const source = await readFile(
      path.join(import.meta.dirname, adapter),
      'utf8',
    );
    const start = source.indexOf(
      '  const timingReceipt = ownedNativeTimingReceipt(',
    );
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n});', start));
    const { ownedNativeTimingReceipt } = await nativeCleanupContract(adapter);
    const run = new Function(
      'proof',
      'performance',
      'process',
      'ownedNativeTimingReceipt',
      stripTypeScriptTypes(body),
    );
    const receipts: string[] = [];
    const processPort = {
      stdout: { write: (line: string) => receipts.push(line) },
    };
    const timing = {
      caseStartedAtMono: 0,
      nativeStartedAtMono: 1000,
      subjectClosedAtMono: 2000,
      nativeWorkEndedAtMono: 2100,
      cleanupStartedAtMono: 2200,
      cleanupEndedAtMono: 3000,
    };
    run(
      { ownedTiming: timing },
      { now: () => 3500 },
      processPort,
      ownedNativeTimingReceipt,
    );
    expect(receipts).toHaveLength(1);
    const prefix = adapter.includes('comments')
      ? 'COM_OWNED_TIMING '
      : 'Q4_OWNED_TIMING ';
    expect(receipts[0].startsWith(prefix)).toBe(true);
    const parsedReceipt = JSON.parse(receipts[0].slice(prefix.length)) as {
      complete: boolean;
    };
    expect(parsedReceipt.complete).toBe(true);
    for (const proof of [
      {},
      { ownedTiming: { ...timing, cleanupEndedAtMono: 29500 } },
    ])
      expect(() =>
        run(proof, { now: () => 3500 }, processPort, ownedNativeTimingReceipt),
      ).toThrow('Owned native timing evidence incomplete');
  });
}

for (const adapter of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
])
  test(`native subject close ${adapter} poisons inspection between queries but permits admitted retirement`, async () => {
    const source = await readFile(
      path.join(import.meta.dirname, adapter),
      'utf8',
    );
    const start = source.indexOf("    child.once('close', () => {");
    const body = source.slice(start, source.indexOf('\n    let stdout', start));
    let listener: (() => void) | undefined,
      cancellations = 0,
      observedClose = false;
    const run = new Function(
      'child',
      'nativeTiming',
      'performance',
      'childClosed',
      'onChildClose',
      'process',
      'retirementRequested',
      'queryScope',
      stripTypeScriptTypes(body),
    );
    const child = {
      once: (_name: string, callback: () => void) => {
        listener = callback;
      },
    };
    const scope = {
      active: () => false,
      cancel: async () => {
        cancellations++;
      },
    };
    for (const retirementRequested of [false, true]) {
      const nativeTiming = { subjectClosedAtMono: null };
      run(
        child,
        nativeTiming,
        { now: () => 4500 },
        false,
        (value: boolean) => {
          observedClose = value;
        },
        { platform: 'win32' },
        retirementRequested,
        scope,
      );
      listener!();
      expect(observedClose).toBe(true);
      expect(nativeTiming.subjectClosedAtMono).toBe(4500);
      expect(cancellations).toBe(1);
    }
  });

for (const adapter of [
  'api-music-comments-native.test.ts',
  'api-music-queue-actions-native.test.ts',
]) {
  for (const finishedAt of [1999, 2000, 2001])
    test(`F2 cleanup ${adapter} observed removal at ${finishedAt} rejects delayed-timer overrun`, async () => {
      const api = await nativeCleanupContract(adapter);
      let now = 0,
        serial = 0,
        releases = 0;
      const timers = new Map<number, () => void>();
      const result = await api.cleanupOwnedNativeChild(undefined, {
        now: () => now,
        timer: (callback: () => void) => {
          timers.set(++serial, callback);
          return serial;
        },
        clear: (id: number) => {
          timers.delete(id);
        },
        closed: () => true,
        waitClose: async () => true,
        queriesClosed: () => true,
        treeEmpty: async () => true,
        remove: async () => {
          now = finishedAt;
        },
        record() {},
        release: () => {
          releases++;
        },
      });
      expect(result).toMatchObject({
        complete: finishedAt < 2000,
        removed: true,
        removalRequested: true,
        deadlineExpired: finishedAt >= 2000,
        endedAtMono: finishedAt,
        errors: [],
      });
      expect(releases).toBe(finishedAt < 2000 ? 0 : 1);
      expect(timers.size).toBe(0);
      const original = Error('original failure');
      expect(() =>
        api.assertNativeCleanupComplete(result, original, '/owned'),
      ).not.toThrow();
      if (finishedAt >= 2000)
        expect(() =>
          api.assertNativeCleanupComplete(result, undefined, '/owned'),
        ).toThrow('cleanup incomplete');
    });
  for (const stage of ['close', 'absence'])
    test(`F2 cleanup ${adapter} delayed ${stage} completion cannot authorize removal`, async () => {
      const api = await nativeCleanupContract(adapter);
      let now = 0,
        absenceCalls = 0,
        removalCalls = 0;
      const result = await api.cleanupOwnedNativeChild(
        stage === 'close' ? { kill: () => true } : undefined,
        {
          now: () => now,
          timer: () => 1,
          clear() {},
          closed: () => stage !== 'close',
          waitClose: async () => {
            now = 2001;
            return true;
          },
          queriesClosed: () => true,
          treeEmpty: async () => {
            absenceCalls++;
            now = 2001;
            return true;
          },
          remove: async () => {
            removalCalls++;
          },
          record() {},
          release() {},
        },
      );
      expect(result).toMatchObject({
        complete: false,
        deadlineExpired: true,
        removalRequested: false,
        removed: false,
      });
      expect(absenceCalls).toBe(stage === 'close' ? 0 : 1);
      expect(removalCalls).toBe(0);
    });
}
