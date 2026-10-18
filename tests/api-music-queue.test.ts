import { test, expect } from '@playwright/test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { musicModuleSource } from './helpers/api-music-source';
import { musicRendererFixture } from './helpers/api-music-renderer';

async function queueHttp() {
  const renderer = await musicRendererFixture();
  const queueElement = renderer.dom.document.createElement('div') as any;
  queueElement.id = 'queue';
  renderer.dom.document.body.append(queueElement);
  let items: any[] = Array.from({ length: 151 }, (_, index) => ({
    playlistPanelVideoRenderer: {
      videoId: index === 120 ? 'selected001' : 'duplicate01',
      title: { runs: [{ text: 'Owned ' + index }] },
      shortBylineText: {
        runs: [
          {
            text: 'Owned artist',
            navigationEndpoint: {
              browseEndpoint: { browseId: 'UC' + 'a'.repeat(22) },
            },
          },
        ],
      },
      lengthText: { simpleText: '3:35' },
      selected: index === 120,
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    },
  }));
  let selectedItemIndex: number | undefined = 120;
  const subscriptions = new Set<() => void>();
  const store = {
    getState: () => ({ queue: { items, selectedItemIndex } }),
    subscribe: (callback: () => void) => {
      subscriptions.add(callback);
      return () => subscriptions.delete(callback);
    },
  };
  const queue = { store: { store }, getItems: () => items };
  queueElement.queue = queue;
  const main = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: new EventEmitter() },
  );
  const grants = main;
  const routes = await musicModuleSource(
    'src/plugins/api-server/backend/routes/music.ts',
    { ipcMain: new EventEmitter() },
  );
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-queue-http-'));
  const ledger = new grants.MusicGrantStore(path.join(owned, 'grants'));
  let live = true,
    nativeReads = 0;
  const broker = {
    capture: () => ({ frame: {}, generation: 0 }),
    isCurrent: () => live && renderer.controller.isCurrent(),
    resultOwner: () => ({
      epoch: '1'.repeat(32) + ':' + '2'.repeat(32),
      current: () => live && renderer.controller.isCurrent(),
    }),
    read: async (_owner: unknown, input: unknown) => {
      nativeReads++;
      const packet = renderer.read(renderer.query(), input);
      await renderer.flush();
      const result = renderer.result(packet);
      if (!result?.ok)
        throw Object.assign(Error('Owned queue fixture failure'), {
          code: result?.reason ?? 'source',
        });
      return result.value;
    },
  };
  const config = {
    enabled: true,
    musicApiEnabled: true,
    hostname: '127.0.0.1',
    port: 26538,
    useHttps: false,
  };
  const service = main.createMusicService({
    window: {},
    config,
    grants: ledger,
    broker,
  });
  const app = new Hono();
  const httpLifetime = new AbortController();
  const httpSockets = new WeakSet<object>();
  let httpOwner: any;
  routes.registerMusicRoutes(
    app,
    () => service,
    () => httpOwner,
  );
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  server.on('connection', (socket: object) => httpSockets.add(socket));
  server.once('close', () => httpLifetime.abort());
  server.on('error', () => httpLifetime.abort());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as any).port;
  service.configure({ ...config, port });
  httpOwner = {
    identity: {},
    address: (server.address() as { address: string }).address,
    port,
    tls: false,
    resources: Object.freeze({ local: service.resource }),
    signal: httpLifetime.signal,
    current: () => live && !httpLifetime.signal.aborted && server.listening,
    ownsSocket: (socket: object) => httpSockets.has(socket),
  };
  const grant = await ledger.issue(
    'Queue reader',
    'rest',
    service.resource,
    ['playback.read'],
    () => true,
  );
  const http = (query = '', token = grant.token) =>
    new Promise<any>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/v1/music/queue' + query,
          headers: {
            host: '127.0.0.1:' + port,
            authorization: 'Bearer ' + token,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (part) => (text += part));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  return {
    renderer,
    service,
    ledger,
    grant,
    http,
    queue,
    store,
    subscriptions,
    get nativeReads() {
      return nativeReads;
    },
    notify: () => {
      for (const callback of [...subscriptions]) callback();
    },
    replaceItems(value: any[], index?: number) {
      items = value;
      selectedItemIndex = index;
      for (const callback of [...subscriptions]) callback();
    },
    items: () => items,
    retire: () => {
      live = false;
    },
    close: async () => {
      service.stop();
      renderer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned, { recursive: true, force: true });
    },
  };
}

test('queue151 preserves duplicate order and selected120 through literal100+51 without remote fetch', async () => {
  const f = await queueHttp();
  try {
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      version: 1,
      total: 151,
      selectedIndex: 120,
    });
    expect(first.body.items).toHaveLength(100);
    expect(first.body.items[0]).toMatchObject({
      index: 0,
      selected: false,
      item: { id: 'duplicate01', title: 'Owned 0', durationSeconds: 215 },
    });
    expect(first.body.items[99]).toMatchObject({
      index: 99,
      selected: false,
      item: { id: 'duplicate01', title: 'Owned 99' },
    });
    const second = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(51);
    expect(second.body.items[0].index).toBe(100);
    expect(second.body.items[20]).toMatchObject({
      index: 120,
      selected: true,
      item: { id: 'selected001', title: 'Owned 120' },
    });
    expect(second.body.items[50].index).toBe(150);
    expect(second.body.queueRevision).toBe(first.body.queueRevision);
    expect(second.body.nextCursor).toBeNull();
    const replay = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    expect(replay.body).toEqual(second.body);
    expect(f.renderer.fetches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const mutation of ['reorder', 'ABA', 'store'])
  test(`queue cursor rejects ${mutation} and a fresh admission remains useful`, async () => {
    const f = await queueHttp();
    try {
      const first = await f.http('?limit=100');
      expect(first.status).toBe(200);
      if (mutation === 'store') f.queue.store.store = { ...f.store };
      else {
        const original = f.items();
        f.replaceItems([...original].reverse(), 30);
        if (mutation === 'ABA') f.replaceItems(original, 120);
      }
      const stale = await f.http('?limit=100&cursor=' + first.body.nextCursor);
      expect(stale.status).toBe(409);
      const healthy = await f.http('?limit=100');
      expect(healthy.status).toBe(200);
      expect(healthy.body.total).toBe(151);
      expect(healthy.body.queueRevision).not.toBe(first.body.queueRevision);
      expect(f.renderer.fetches).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('verified empty queue is200 while missing native queue is503 and recovered queue remains useful', async () => {
  const f = await queueHttp();
  try {
    f.replaceItems([], -1);
    const empty = await f.http();
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      total: 0,
      selectedIndex: null,
      items: [],
      nextCursor: null,
    });
    const element = f.renderer.dom.document.querySelector('#queue') as any;
    element.queue = undefined;
    expect((await f.http()).status).toBe(503);
    element.queue = f.queue;
    expect((await f.http()).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('strict queue query validation and scope denial dispatch no native read', async () => {
  const f = await queueHttp();
  try {
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=01',
      '?limit=1.0',
      '?limit=1e2',
      '?limit=+1',
      '?limit=1&limit=1',
      '?cursor=nope',
      '?unknown=1',
      '?%6cimit=1',
    ]) {
      expect((await f.http(query)).status, query).toBe(400);
    }
    expect(f.nativeReads).toBe(0);
    const scoped = await f.ledger.issue(
      'Catalog only',
      'rest',
      f.service.resource,
      ['catalog.read'],
      () => true,
    );
    expect((await f.http('', scoped.token)).status).toBe(403);
    expect(f.nativeReads).toBe(0);
    expect((await f.http('?limit=1')).status).toBe(200);
  } finally {
    await f.close();
  }
});

for (const mutation of [
  'selection',
  'method',
  'DOM-removal',
  'missing-restored',
])
  test(`issued queue cursor retires after ${mutation} and healthy first-page reads remain possible`, async () => {
    const f = await queueHttp();
    try {
      const first = await f.http('?limit=100');
      expect(first.status).toBe(200);
      const element = f.renderer.dom.document.querySelector('#queue') as any;
      if (mutation === 'selection') f.replaceItems(f.items(), 20);
      if (mutation === 'method') f.queue.getItems = () => f.items();
      if (mutation === 'DOM-removal') {
        element.remove();
        expect((await f.http()).status).toBe(503);
        f.renderer.dom.document.body.append(element);
      }
      if (mutation === 'missing-restored') {
        element.queue = undefined;
        expect((await f.http()).status).toBe(503);
        element.queue = f.queue;
      }
      expect(
        (await f.http('?limit=100&cursor=' + first.body.nextCursor)).status,
      ).toBe(409);
      expect((await f.http('?limit=100')).status).toBe(200);
      expect(f.renderer.fetches).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('native queue bounds malformed recognized rows without presenting false empty success', async () => {
  const f = await queueHttp();
  try {
    const original = f.items();
    f.replaceItems(Array(2049).fill(original[0]), 0);
    expect((await f.http()).status).toBe(502);
    f.replaceItems(
      [
        {
          playlistPanelVideoRenderer: {
            ...original[0].playlistPanelVideoRenderer,
            videoId: 'bad',
          },
        },
      ],
      0,
    );
    expect((await f.http()).status).toBe(502);
    f.replaceItems(
      [
        {
          playlistPanelVideoRenderer: {
            ...original[0].playlistPanelVideoRenderer,
            ignored: 'x'.repeat(1024 * 1024),
          },
        },
      ],
      0,
    );
    expect((await f.http()).status).toBe(502);
    f.replaceItems(
      [{ playlistPanelVideoWrapperRenderer: { primaryRenderer: original[0] } }],
      0,
    );
    const restored = await f.http();
    expect(restored.status).toBe(200);
    expect(restored.body.items[0]).toMatchObject({
      index: 0,
      selected: true,
      item: { id: 'duplicate01' },
    });
    expect(f.renderer.fetches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('queue getter reentry retires the sampled owner and retains an independently useful read', async () => {
  const f = await queueHttp();
  try {
    const original = f.queue.getItems;
    let nested: any;
    f.queue.getItems = () => {
      f.queue.getItems = original;
      const packet = f.renderer.read(f.renderer.query(), {
        operation: 'queue',
      });
      nested = f.renderer.result(packet);
      return original();
    };
    const failed = await f.http();
    expect(failed.status).toBe(409);
    expect(nested).toMatchObject({ ok: false, reason: 'retired' });
    expect((await f.http()).status).toBe(200);
    expect(f.subscriptions.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('queue cursor is principal-bound and its quota is reclaimed on grant revocation', async () => {
  const f = await queueHttp();
  try {
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    const other = await f.ledger.issue(
      'Other queue reader',
      'rest',
      f.service.resource,
      ['playback.read'],
      () => true,
    );
    expect(
      (await f.http('?limit=100&cursor=' + first.body.nextCursor, other.token))
        .status,
    ).toBe(404);
    for (let i = 1; i < 32; i++)
      expect((await f.http('?limit=100')).status).toBe(200);
    expect(f.service.stats().cursors).toBe(32);
    expect((await f.http('?limit=100')).status).toBe(502);
    expect(f.service.stats().cursors).toBe(32);
    expect(f.service.stats().cacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    await f.ledger.revoke(f.grant.record.id, () => true);
    expect(f.service.stats().cursors).toBe(0);
    expect((await f.http('?limit=100', other.token)).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('native watch-endpoint music type is retained for wrapped song rows', async () => {
  const f = await queueHttp();
  try {
    const row = { ...f.items()[0].playlistPanelVideoRenderer };
    delete row.musicVideoType;
    row.navigationEndpoint = {
      watchEndpoint: {
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
        },
      },
    };
    f.replaceItems(
      [
        {
          playlistPanelVideoWrapperRenderer: {
            primaryRenderer: { playlistPanelVideoRenderer: row },
          },
        },
      ],
      0,
    );
    const response = await f.http();
    expect(response.status).toBe(200);
    expect(response.body.items[0].item.kind).toBe('song');
  } finally {
    await f.close();
  }
});

test('selection mutation during getItems never returns a mixed-time snapshot', async () => {
  const f = await queueHttp();
  try {
    const original = f.queue.getItems;
    f.queue.getItems = () => {
      f.replaceItems(f.items(), 30);
      return original();
    };
    expect((await f.http()).status).toBe(409);
    f.queue.getItems = original;
    expect((await f.http()).body.selectedIndex).toBe(30);
  } finally {
    await f.close();
  }
});

test('synchronous subscribe reentry retires its read and detaches exactly its subscription', async () => {
  const f = await queueHttp();
  try {
    const original = f.store.subscribe;
    f.store.subscribe = (callback: () => void) => {
      const release = original(callback);
      callback();
      return release;
    };
    expect((await f.http()).status).toBe(409);
    expect(f.subscriptions.size).toBe(0);
    f.store.subscribe = original;
    expect((await f.http()).status).toBe(200);
    expect(f.subscriptions.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('queue source accepts2048 literal rows and pages stay below256KiB without dropping remainder', async () => {
  const f = await queueHttp();
  try {
    const row = f.items()[0];
    f.replaceItems(Array(2048).fill(row), 2047);
    const bounded = await f.http('?limit=100');
    expect(bounded.status).toBe(200);
    expect(bounded.body).toMatchObject({ total: 2048, selectedIndex: 2047 });
    expect(bounded.body.items).toHaveLength(100);
    const rich = {
      ...row.playlistPanelVideoRenderer,
      shortBylineText: {
        runs: Array.from({ length: 8 }, (_, i) => ({
          text: 'A'.repeat(28),
          navigationEndpoint: {
            browseEndpoint: { browseId: 'UC' + String(i).repeat(22) },
          },
        })),
      },
      thumbnail: {
        thumbnails: [{ url: 'https://example.test/' + 'x'.repeat(1980) }],
      },
      title: { simpleText: 'T'.repeat(512) },
    };
    f.replaceItems(Array(100).fill({ playlistPanelVideoRenderer: rich }), 99);
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    expect(first.body.items.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(first.body.nextCursor).toMatch(/^mcur_/);
    const second = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    expect(second.status).toBe(200);
    expect(second.body.items[0].index).toBe(first.body.items.length);
    expect(first.body.items.length + second.body.items.length).toBe(100);
    expect(second.body.items.at(-1)).toMatchObject({
      index: 99,
      selected: true,
    });
  } finally {
    await f.close();
  }
});

test('silent native state selection drift during a getter retires mixed-time reads', async () => {
  const f = await queueHttp();
  try {
    let calls = 0;
    const original = f.store.getState;
    f.store.getState = () => ({
      queue: { items: f.items(), selectedItemIndex: ++calls === 1 ? 120 : 30 },
    });
    expect((await f.http()).status).toBe(409);
    f.store.getState = original;
    expect((await f.http()).body.selectedIndex).toBe(120);
  } finally {
    await f.close();
  }
});

for (const method of ['getItems', 'getState', 'subscribe', 'store'])
  test(`missing native ${method} returns503 and restored native queue returns200`, async () => {
    const f = await queueHttp();
    try {
      const holder: any =
        method === 'getItems'
          ? f.queue
          : method === 'store'
            ? f.queue.store
            : f.store;
      const original = holder[method];
      holder[method] = undefined;
      expect((await f.http()).status).toBe(503);
      holder[method] = original;
      expect((await f.http()).status).toBe(200);
      expect(f.renderer.fetches).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test('review final native queue binding getter replacement must retire HTTP snapshot', async () => {
  const f = await queueHttp();
  try {
    const element = f.renderer.dom.document.querySelector('#queue') as any,
      original = f.queue.getItems;
    let calls = 0,
      threshold = Infinity,
      triggered = false;
    Object.defineProperty(f.queue, 'getItems', {
      configurable: true,
      get() {
        calls++;
        if (calls === threshold) {
          triggered = true;
          element.queue = { getItems: original, store: f.queue.store };
        }
        return original;
      },
    });
    expect((await f.http()).status).toBe(200);
    calls = 0;
    expect((await f.http()).status).toBe(200);
    const baselineCalls = calls;
    const probes = [];
    for (let at = 1; at <= baselineCalls; at++) {
      threshold = Infinity;
      element.queue = f.queue;
      expect((await f.http()).status).toBe(200);
      calls = 0;
      triggered = false;
      threshold = at;
      const response = await f.http();
      threshold = Infinity;
      probes.push({
        at,
        calls,
        triggered,
        status: response.status,
        total: response.body.total,
      });
    }
    element.queue = f.queue;
    const recovery = await f.http();
    console.log(
      'QUEUE_FINAL_GETTER ' +
        JSON.stringify({
          baselineCalls,
          probes,
          recovery: recovery.status,
          fetches: f.renderer.fetches.length,
        }),
    );
    expect(recovery.status).toBe(200);
    expect(recovery.body.total).toBe(151);
    expect(f.renderer.fetches).toHaveLength(0);
    for (const p of probes)
      if (p.triggered) expect(p.status, 'callout ' + p.at).toBe(409);
  } finally {
    await f.close();
  }
});
test('review unrelated store notifications do not reread whole native queue', async () => {
  const f = await queueHttp();
  try {
    let reads = 0;
    const original = f.queue.getItems;
    f.queue.getItems = () => {
      reads++;
      return original();
    };
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    const initial = reads;
    for (let i = 0; i < 50; i++) f.notify();
    const idle = reads - initial;
    const second = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    const beforeABA = second.status;
    const rows = f.items();
    f.replaceItems([...rows].reverse(), 30);
    f.replaceItems(rows, 120);
    const retired = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    const recovery = await f.http();
    console.log(
      'QUEUE_BACKGROUND ' +
        JSON.stringify({
          idle,
          continuation: beforeABA,
          total: second.body.total,
          items: second.body.items.length,
          retired: retired.status,
          recovery: recovery.status,
        }),
    );
    expect(beforeABA).toBe(200);
    expect(second.body.items).toHaveLength(51);
    expect(retired.status).toBe(409);
    expect(recovery.status).toBe(200);
    expect(idle).toBe(0);
  } finally {
    await f.close();
  }
});
test('review getApi final recapture cannot return after exact queue owner disposal', async () => {
  const f = await queueHttp();
  const m = await musicModuleSource('src/providers/music-queue.ts');
  let owner: any,
    calls = 0,
    armed = Infinity,
    disposed = false;
  try {
    const getApi = () => {
      if (++calls === armed) {
        disposed = true;
        owner.dispose();
      }
      return f.renderer.originalApi;
    };
    owner = m.createMusicQueueOwner(
      f.renderer.originalApi,
      getApi,
      f.renderer.dom.document,
    );
    owner.snapshot();
    calls = 0;
    owner.snapshot();
    const n = calls;
    calls = 0;
    armed = n;
    let result: any, error: any;
    try {
      result = owner.snapshot();
    } catch (e) {
      error = (e as any).code;
    }
    console.log(
      'QUEUE_DISPOSE ' +
        JSON.stringify({
          n,
          calls,
          disposed,
          total: result?.items.length,
          error,
        }),
    );
    expect(disposed).toBe(true);
    expect(error).toBe('retired');
    expect(result).toBeUndefined();
  } finally {
    owner?.dispose();
    await f.close();
  }
});

import { Window } from 'happy-dom';
test('a getter that disposes the queue owner cannot publish an admitted snapshot', async () => {
  const source = await musicModuleSource('src/providers/music-queue.ts');
  const oldWindow = (globalThis as any).window;
  const leaked: number[] = [];
  try {
    for (let armedCall = 1; armedCall <= 32; armedCall++) {
      const dom = new Window();
      (globalThis as any).window = dom;
      const element = dom.document.createElement('div') as any;
      element.id = 'queue';
      dom.document.body.append(element);
      const items = [
        {
          playlistPanelVideoRenderer: {
            videoId: 'duplicate01',
            title: { simpleText: 'Owned positive' },
          },
        },
      ];
      const store = {
        getState: () => ({ queue: { items, selectedItemIndex: 0 } }),
        subscribe: () => () => {},
      };
      element.queue = { store: { store }, getItems: () => items };
      const api = { isConnected: true };
      let calls = 0,
        armed = false,
        disposed = false;
      let owner: any;
      owner = source.createMusicQueueOwner(
        api,
        () => {
          calls++;
          if (armed && calls === armedCall) {
            disposed = true;
            owner.dispose();
          }
          return api;
        },
        dom.document,
      );
      const healthy = owner.snapshot();
      expect(healthy.items).toHaveLength(1);
      calls = 0;
      armed = true;
      try {
        owner.snapshot();
        if (disposed) leaked.push(armedCall);
      } catch (error) {
        if (!disposed) throw error;
      }
      owner.dispose();
      await dom.happyDOM.close();
    }
    expect(
      leaked,
      'snapshot publication after synchronous owner disposal',
    ).toEqual([]);
  } finally {
    if (oldWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = oldWindow;
  }
});

test('notified in-place duplicate reorder ABA retires cursor without callerless getItems work', async () => {
  const f = await queueHttp();
  try {
    let reads = 0;
    const original = f.queue.getItems;
    f.queue.getItems = () => {
      reads++;
      return original();
    };
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    const before = reads,
      rows = f.items();
    [rows[0], rows[1]] = [rows[1], rows[0]];
    f.notify();
    [rows[0], rows[1]] = [rows[1], rows[0]];
    f.notify();
    expect(reads - before).toBe(0);
    expect(
      (await f.http('?limit=100&cursor=' + first.body.nextCursor)).status,
    ).toBe(409);
    const healthy = await f.http('?limit=100');
    expect(healthy.status).toBe(200);
    expect(healthy.body.items[0].item.title).toBe('Owned 0');
    expect(healthy.body.items[1].item.title).toBe('Owned 1');
    expect(healthy.body.selectedIndex).toBe(120);
  } finally {
    await f.close();
  }
});

test('ordinary Polymer accessor uses ref-equal inst data backing and retires final replacement', async () => {
  const f = await queueHttp();
  try {
    const element = f.renderer.dom.document.querySelector('#queue') as any;
    element.inst = { queue: f.queue };
    Object.defineProperty(element, 'queue', {
      configurable: true,
      get: () => element.inst.queue,
      set: (value) => (element.inst.queue = value),
    });
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    const second = await f.http('?limit=100&cursor=' + first.body.nextCursor);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(51);
    const original = f.queue.getItems;
    let calls = 0,
      threshold = Infinity,
      triggered = false;
    Object.defineProperty(f.queue, 'getItems', {
      configurable: true,
      get() {
        if (++calls === threshold) {
          triggered = true;
          element.inst.queue = { getItems: original, store: f.queue.store };
        }
        return original;
      },
    });
    expect((await f.http('?limit=100')).status).toBe(200);
    calls = 0;
    expect((await f.http('?limit=100')).status).toBe(200);
    threshold = calls;
    calls = 0;
    expect((await f.http('?limit=100')).status).toBe(409);
    expect(triggered).toBe(true);
    threshold = Infinity;
    element.inst.queue = f.queue;
    expect((await f.http('?limit=100')).status).toBe(200);
    expect(f.renderer.fetches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('final reflection trap that disposes the owner cannot publish and a clean owner remains useful', async () => {
  const f = await queueHttp(),
    source = await musicModuleSource('src/providers/music-queue.ts');
  let owner: any;
  try {
    const element = f.renderer.dom.document.querySelector('#queue') as any;
    let calls = 0,
      threshold = Infinity,
      disposed = false;
    element.queue = new Proxy(f.queue, {
      getOwnPropertyDescriptor(target, key) {
        if (++calls === threshold) {
          disposed = true;
          owner.dispose();
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    owner = source.createMusicQueueOwner(
      f.renderer.originalApi,
      () => f.renderer.originalApi,
      f.renderer.dom.document,
    );
    expect(owner.snapshot().items).toHaveLength(151);
    calls = 0;
    expect(owner.snapshot().items).toHaveLength(151);
    threshold = calls;
    calls = 0;
    expect(() => owner.snapshot()).toThrow('retired');
    expect(disposed).toBe(true);
    element.queue = f.queue;
    const healthy = source.createMusicQueueOwner(
      f.renderer.originalApi,
      () => f.renderer.originalApi,
      f.renderer.dom.document,
    );
    try {
      expect(healthy.snapshot().items).toHaveLength(151);
    } finally {
      healthy.dispose();
    }
  } finally {
    owner?.dispose();
    await f.close();
  }
});

test('ordinary1000 queue retains literal pages and selected999 after unrelated notifications', async () => {
  const f = await queueHttp();
  try {
    const row = f.items()[0].playlistPanelVideoRenderer;
    f.replaceItems(
      Array.from({ length: 1000 }, (_, index) => ({
        playlistPanelVideoRenderer: {
          ...row,
          title: { simpleText: 'Queue ' + index },
          selected: index === 999,
        },
      })),
      999,
    );
    const first = await f.http('?limit=100');
    expect(first.status).toBe(200);
    for (let i = 0; i < 50; i++) f.notify();
    const all = [...first.body.items];
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await f.http('?limit=100&cursor=' + cursor);
      expect(page.status).toBe(200);
      all.push(...page.body.items);
      cursor = page.body.nextCursor;
    }
    expect(all).toHaveLength(1000);
    expect(all[0].item.title).toBe('Queue 0');
    expect(all[999]).toMatchObject({
      index: 999,
      selected: true,
      item: { title: 'Queue 999', id: 'duplicate01' },
    });
    expect(f.renderer.fetches).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('last getter cannot publish after the native API node disconnects while queue remains connected', async () => {
  const f = await queueHttp(),
    source = await musicModuleSource('src/providers/music-queue.ts');
  let owner: any;
  try {
    const api = f.renderer.dom.document.createElement('div');
    f.renderer.dom.document.body.append(api);
    const original = f.queue.getItems;
    let calls = 0,
      threshold = Infinity,
      disconnected = false;
    Object.defineProperty(f.queue, 'getItems', {
      configurable: true,
      get() {
        if (++calls === threshold) {
          api.remove();
          disconnected = true;
        }
        return original;
      },
    });
    owner = source.createMusicQueueOwner(
      api,
      () => api,
      f.renderer.dom.document,
    );
    expect(owner.snapshot().items).toHaveLength(151);
    calls = 0;
    expect(owner.snapshot().items).toHaveLength(151);
    threshold = calls;
    calls = 0;
    expect(() => owner.snapshot()).toThrow('retired');
    expect(disconnected).toBe(true);
    expect(
      (f.renderer.dom.document.querySelector('#queue') as any).isConnected,
    ).toBe(true);
    threshold = Infinity;
    f.renderer.dom.document.body.append(api);
    expect(owner.snapshot().items).toHaveLength(151);
  } finally {
    owner?.dispose();
    await f.close();
  }
});
