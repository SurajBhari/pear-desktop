import { test, expect } from '@playwright/test';
import { musicRendererFixture } from './helpers/api-music-renderer';

test('snapshot copies agreeing native getters in one capture with precise milliseconds', async () => {
  const f = await musicRendererFixture();
  try {
    const p = f.read(undefined, { operation: 'current' });
    await f.flush();
    expect(f.result(p)).toMatchObject({
      ok: true,
      value: {
        current: { id: 'current0001', title: 'Current title' },
        elapsedSeconds: 1.2345,
        elapsedMilliseconds: 1234.5,
        state: 'playing',
        volume: 77,
      },
    });
    expect(f.fetches).toHaveLength(0);
  } finally {
    f.close();
  }
});
test('disagreeing current native identity cannot join current clock to delayed metadata', async () => {
  const f = await musicRendererFixture();
  try {
    f.setVideo('current0002', 'current0001');
    const p = f.read(undefined, { operation: 'current' });
    await f.flush();
    expect(f.result(p)).toMatchObject({ ok: false, reason: 'unavailable' });
  } finally {
    f.close();
  }
});
test('typed search and browse call only verified native paths and return normalized DTOs', async () => {
  const f = await musicRendererFixture();
  try {
    const p = f.read(undefined, {
      operation: 'search',
      query: 'fixture',
      filter: 'songs',
    });
    expect(f.fetches[0]).toMatchObject({
      url: '/search',
      data: { query: 'fixture', params: 'EgWKAQIIAQ%3D%3D' },
    });
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(p).value.items[0].title).toBe('Fixture Track 0');
    expect(JSON.stringify(f.result(p))).not.toContain('tracking');
    const b = f.read(undefined, {
      operation: 'browse',
      browseId: 'UC' + 'a'.repeat(22),
    });
    expect(f.fetches[1].url).toBe('/browse');
    f.fetches[1].resolve(f.searchPage());
    await f.flush();
    expect(f.result(b).ok).toBe(true);
  } finally {
    f.close();
  }
});
test('explicit catalog survives unrelated raw current ABA while api app network replacement retires native results', async () => {
  for (const change of ['aba', 'api', 'app', 'network']) {
    const f = await musicRendererFixture();
    try {
      const p = f.read();
      if (change === 'aba') {
        f.setVideo('current0002');
        f.videoEvent();
        f.setVideo('current0001');
        f.videoEvent();
      } else if (change === 'api') f.replaceApi();
      else if (change === 'app')
        f.app.replaceWith(f.dom.document.createElement('ytmusic-app'));
      else f.app.networkManager = { fetch() {} };
      f.fetches[0].resolve(f.searchPage());
      await f.flush();
      expect(f.result(p)).toMatchObject(
        change === 'aba' ? { ok: true } : { ok: false, reason: 'retired' },
      );
    } finally {
      f.close();
    }
  }
});
test('canceled unabortable work retains four physical slots and settles only after native fetch', async () => {
  const f = await musicRendererFixture();
  try {
    const packets = Array.from({ length: 12 }, () => f.read());
    expect(f.fetches).toHaveLength(4);
    expect(f.controller.stats()).toEqual({ active: 4, queued: 8 });
    f.emit('peard:music-cancel', packets[0]);
    expect(f.result(packets[0])).toBeUndefined();
    expect(f.fetches).toHaveLength(4);
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(packets[0])).toMatchObject({
      ok: false,
      reason: 'retired',
    });
    expect(f.fetches).toHaveLength(5);
  } finally {
    f.close();
  }
});
test('pagehide stop and stale handshake preserve foreign channel listener ownership', async () => {
  const f = await musicRendererFixture();
  try {
    let foreign = 0;
    f.ipc.subscribe('peard:music-read', () => foreign++);
    const p = f.query();
    f.dom.dispatchEvent(new f.dom.Event('pagehide'));
    f.read(p);
    await f.flush();
    expect(f.fetches).toHaveLength(0);
    f.emit('peard:music-read', {});
    expect(foreign).toBe(2);
  } finally {
    f.close();
  }
});

// F2 plugin admission tests exercise the production renderer and controller.
// Only createRenderer's identity wrapper and public native/IPC boundaries differ.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Window } from 'happy-dom';

const admissionEnabled = { enabled: true, musicApiEnabled: true };
const admissionDisabled = { enabled: true, musicApiEnabled: false };
const holdAdmission = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((release) => {
    resolve = release;
  });
  return { promise, resolve };
};
async function admissionFixture(config = admissionEnabled) {
  const root = path.resolve(import.meta.dirname, '..');
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-api-admission-'));
  const oldWindow = (globalThis as any).window,
    oldDocument = (globalThis as any).document;
  const dom = new Window();
  dom.document.body.innerHTML =
    '<ytmusic-app><div id="movie_player"></div></ytmusic-app>';
  const app = dom.document.querySelector('ytmusic-app')! as any;
  let probes = 0;
  const network = { fetch: async () => ({}) };
  Object.defineProperty(app, 'networkManager', {
    get() {
      probes++;
      return network;
    },
  });
  const makeApi = () => {
    const hooks = new Map<string, Set<any>>();
    const api = {
      isConnected: true,
      addEventListener(name: string, callback: any) {
        const set = hooks.get(name) ?? new Set();
        set.add(callback);
        hooks.set(name, set);
      },
      removeEventListener(name: string, callback: any) {
        hooks.get(name)?.delete(callback);
      },
    };
    return { api, hooks };
  };
  const makeContext = (getConfig: () => any = () => config) => {
    const listeners = new Map<string, Set<any>>(),
      sent: any[] = [];
    const context = {
      getConfig,
      ipc: {
        subscribe(name: string, callback: any) {
          const set = listeners.get(name) ?? new Set();
          set.add(callback);
          listeners.set(name, set);
          return () => set.delete(callback);
        },
        send(name: string, packet: any) {
          sent.push({ name, packet });
        },
      },
    };
    let serial = 0;
    const query = () => {
      for (const fn of listeners.get('peard:music-owner-query') ?? [])
        fn({
          requestId: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
          nonce: 'a'.repeat(32),
        });
    };
    return { context, listeners, sent, query };
  };
  try {
    const entry = path.join(owned, 'entry.ts');
    await writeFile(
      entry,
      `export {renderer} from ${JSON.stringify(process.env.PEAR_API_ADMISSION_SOURCE ?? path.join(root, 'src/plugins/api-server/renderer.ts'))};`,
    );
    const wrapper = path.join(owned, 'wrapper.ts');
    await writeFile(wrapper, 'export const createRenderer = x => x;');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'identity-renderer-wrapper',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@/utils') return '\0admission-wrapper';
            return undefined;
          },
          load(id) {
            if (id === '\0admission-wrapper')
              return 'export const createRenderer = x => x;';
            return undefined;
          },
        },
      ],
      resolve: {
        alias: [
          { find: '@/utils', replacement: wrapper },
          { find: '@', replacement: path.join(root, 'src') },
        ],
      },
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    (globalThis as any).window = dom;
    (globalThis as any).document = dom.document;
    const { renderer } = await import(
      pathToFileURL(path.join(owned, 'source.mjs')).href
    );
    const first = makeContext(),
      player = makeApi();
    return {
      renderer,
      ...first,
      ...player,
      makeContext,
      makeApi,
      probes: () => probes,
      async close() {
        await renderer.stop(first.context);
        (globalThis as any).window = oldWindow;
        (globalThis as any).document = oldDocument;
        await dom.happyDOM.close();
        await rm(owned, { recursive: true, force: true });
      },
    };
  } catch (error) {
    (globalThis as any).window = oldWindow;
    (globalThis as any).document = oldDocument;
    await dom.happyDOM.close();
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
}
const admissionTick = () => new Promise((resolve) => setTimeout(resolve, 230));
for (const enabled of [false, true])
  for (const musicApiEnabled of [false, true])
    test(`plugin renderer admits subscriptions and idle polling only for both flags ${enabled}/${musicApiEnabled}`, async () => {
      const f = await admissionFixture({ enabled, musicApiEnabled });
      try {
        await f.renderer.start(f.context);
        await f.renderer.onPlayerApiReady(f.api, f.context);
        const before = f.probes();
        await admissionTick();
        f.query();
        if (enabled && musicApiEnabled) {
          expect(f.sent).toHaveLength(1);
          expect(f.sent[0].packet.type).toBe('ready');
          expect(f.probes()).toBeGreaterThan(before);
        } else {
          expect(f.sent).toHaveLength(0);
          expect(f.probes()).toBe(before);
        }
      } finally {
        await f.close();
      }
    });
test('plugin renderer disable immediately retires workload and reenable retains the ready API and IPC context', async () => {
  const f = await admissionFixture();
  try {
    await f.renderer.start(f.context);
    await f.renderer.onPlayerApiReady(f.api, f.context);
    f.query();
    expect(f.sent[0].packet.type).toBe('ready');
    const old = f.sent[0].packet.sourceId;
    f.sent.length = 0;
    await f.renderer.onConfigChange?.(admissionDisabled);
    expect(f.sent.map((value) => value.packet.type)).toEqual(['retire']);
    f.sent.length = 0;
    const before = f.probes();
    await admissionTick();
    f.query();
    expect(f.sent).toHaveLength(0);
    expect(f.probes()).toBe(before);
    await f.renderer.onConfigChange?.(admissionEnabled);
    f.query();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].packet.sourceId).not.toBe(old);
    await f.renderer.onConfigChange?.(admissionEnabled);
    f.sent.length = 0;
    f.query();
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('plugin renderer retains newer ready API/context received while the expanded flag is disabled', async () => {
  const f = await admissionFixture(admissionDisabled);
  try {
    await f.renderer.start(f.context);
    await f.renderer.onPlayerApiReady(f.api, f.context);
    const second = f.makeContext(() => admissionDisabled),
      player = f.makeApi();
    await f.renderer.onPlayerApiReady(player.api, second.context);
    await f.renderer.onConfigChange?.(admissionEnabled);
    f.query();
    second.query();
    expect(f.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
    expect(f.hooks.get('videodatachange')?.size ?? 0).toBe(0);
    expect(player.hooks.get('videodatachange')?.size).toBe(1);
  } finally {
    await f.close();
  }
});
test('plugin renderer newer disabled config fences held enabled startup and ready reads', async () => {
  const f = await admissionFixture(),
    held = holdAdmission();
  try {
    const ctx = f.makeContext(() => held.promise),
      start = f.renderer.start(ctx.context),
      ready = f.renderer.onPlayerApiReady(f.api, ctx.context);
    await f.renderer.onConfigChange?.(admissionDisabled);
    held.resolve(admissionEnabled);
    await Promise.all([start, ready]);
    const before = f.probes();
    await admissionTick();
    ctx.query();
    expect(ctx.sent).toHaveLength(0);
    expect(f.probes()).toBe(before);
  } finally {
    await f.close();
  }
});
test('plugin renderer newer enabled event survives old disabled ready config resolution', async () => {
  const f = await admissionFixture(),
    held = holdAdmission();
  try {
    await f.renderer.start(f.context);
    const ctx = f.makeContext(() => held.promise),
      ready = f.renderer.onPlayerApiReady(f.api, ctx.context);
    await f.renderer.onConfigChange?.(admissionEnabled);
    ctx.query();
    expect(ctx.sent).toHaveLength(1);
    ctx.sent.length = 0;
    held.resolve(admissionDisabled);
    await ready;
    ctx.query();
    expect(ctx.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('plugin renderer newest ready event fences old ready enabled resolution and retires foreign context capability', async () => {
  const f = await admissionFixture(),
    held = holdAdmission();
  try {
    await f.renderer.start(f.context);
    const old = f.makeContext(() => held.promise),
      ready = f.renderer.onPlayerApiReady(f.api, old.context);
    const current = f.makeContext(() => admissionDisabled),
      player = f.makeApi();
    await f.renderer.onPlayerApiReady(player.api, current.context);
    held.resolve(admissionEnabled);
    await ready;
    old.query();
    current.query();
    expect(old.sent).toHaveLength(0);
    expect(current.sent).toHaveLength(0);
    await f.renderer.onConfigChange?.(admissionEnabled);
    current.query();
    expect(current.sent).toHaveLength(1);
    old.query();
    expect(old.sent).toHaveLength(0);
    expect(f.hooks.get('videodatachange')?.size ?? 0).toBe(0);
    expect(player.hooks.get('videodatachange')?.size).toBe(1);
  } finally {
    await f.close();
  }
});
test('plugin renderer newest ready config fences older startup enabled resolution', async () => {
  const f = await admissionFixture(),
    held = holdAdmission();
  try {
    const old = f.makeContext(() => held.promise),
      start = f.renderer.start(old.context);
    const current = f.makeContext(() => admissionDisabled);
    await f.renderer.onPlayerApiReady(f.api, current.context);
    held.resolve(admissionEnabled);
    await start;
    current.query();
    expect(current.sent).toHaveLength(0);
    await f.renderer.onConfigChange?.(admissionEnabled);
    current.query();
    expect(current.sent).toHaveLength(1);
    old.query();
    expect(old.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});
for (const pending of ['start', 'ready'] as const)
  test(`plugin renderer stop fences a held ${pending} read and later ready/config notifications`, async () => {
    const f = await admissionFixture(),
      held = holdAdmission();
    try {
      await f.renderer.start(f.context);
      const ctx = f.makeContext(() => held.promise);
      const wait =
        pending === 'start'
          ? f.renderer.start(ctx.context)
          : f.renderer.onPlayerApiReady(f.api, ctx.context);
      await f.renderer.stop(f.context);
      await f.renderer.onConfigChange?.(admissionEnabled);
      await f.renderer.onPlayerApiReady(f.api, f.context);
      held.resolve(admissionEnabled);
      await wait;
      const before = f.probes();
      await admissionTick();
      f.query();
      ctx.query();
      expect(f.sent).toHaveLength(0);
      expect(ctx.sent).toHaveLength(0);
      expect(f.probes()).toBe(before);
    } finally {
      await f.close();
    }
  });
for (const pending of ['start', 'ready'] as const)
  test(`plugin renderer newer start fences a held old ${pending} config read`, async () => {
    const f = await admissionFixture(),
      held = holdAdmission();
    try {
      await f.renderer.start(f.context);
      const ctx = f.makeContext(() => held.promise),
        wait =
          pending === 'start'
            ? f.renderer.start(ctx.context)
            : f.renderer.onPlayerApiReady(f.api, ctx.context);
      const current = f.makeContext(() => admissionDisabled);
      await f.renderer.start(current.context);
      await f.renderer.onPlayerApiReady(f.api, current.context);
      held.resolve(admissionEnabled);
      await wait;
      current.query();
      ctx.query();
      expect(current.sent).toHaveLength(0);
      expect(ctx.sent).toHaveLength(0);
      await f.renderer.onConfigChange?.(admissionEnabled);
      current.query();
      expect(current.sent).toHaveLength(1);
      ctx.query();
      expect(ctx.sent).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
test('plugin renderer disabling the plugin flag retires current controller and its foreign listeners remain', async () => {
  const f = await admissionFixture();
  try {
    await f.renderer.start(f.context);
    await f.renderer.onPlayerApiReady(f.api, f.context);
    let foreign = 0;
    const set = f.listeners.get('peard:music-owner-query')!;
    const listener = () => foreign++;
    set.add(listener);
    await f.renderer.onConfigChange?.({
      enabled: false,
      musicApiEnabled: true,
    });
    expect(f.sent.map((value) => value.packet.type)).toEqual(['retire']);
    f.sent.length = 0;
    const before = f.probes();
    await admissionTick();
    f.query();
    expect(f.sent).toHaveLength(0);
    expect(f.probes()).toBe(before);
    expect(foreign).toBe(1);
    await f.renderer.stop(f.context);
    expect(set.has(listener)).toBe(true);
  } finally {
    await f.close();
  }
});

for (const action of ['ready', 'start'] as const)
  test(`plugin renderer synchronous retire during ${action} cannot overwrite newer ready API/context`, async () => {
    const f = await admissionFixture();
    try {
      await f.renderer.start(f.context);
      await f.renderer.onPlayerApiReady(f.api, f.context);
      const latest = f.makeContext(() =>
        action === 'start' ? admissionDisabled : admissionEnabled,
      );
      const middle = f.makeContext(),
        player = f.makeApi();
      const send = f.context.ipc.send;
      let latestWork: Promise<unknown>[] = [];
      f.context.ipc.send = (name: string, packet: any) => {
        send(name, packet);
        if (packet.type !== 'retire') return;
        if (action === 'start')
          latestWork.push(f.renderer.start(latest.context));
        latestWork.push(
          f.renderer.onPlayerApiReady(player.api, latest.context),
        );
      };
      if (action === 'start') await f.renderer.start(middle.context);
      else await f.renderer.onPlayerApiReady(f.api, middle.context);
      await Promise.all(latestWork);
      if (action === 'start') {
        latest.query();
        expect(latest.sent).toHaveLength(0);
        await f.renderer.onConfigChange?.(admissionEnabled);
      }
      middle.query();
      latest.query();
      expect(middle.sent).toHaveLength(0);
      expect(latest.sent).toHaveLength(1);
      expect(latest.sent[0].packet.type).toBe('ready');
      expect(player.hooks.get('videodatachange')?.size).toBe(1);
    } finally {
      await f.close();
    }
  });

test('renderer abandoned pre-ACK leases do not consume its twelve-handshake capacity', async () => {
  const f = await musicRendererFixture();
  try {
    const replies = [];
    for (let i = 0; i < 24; i++) {
      const packet = f.query();
      replies.push(Boolean(packet));
      if (packet)
        f.emit('peard:music-cancel', {
          requestId: packet.requestId,
          nonce: packet.nonce,
          phase: 'owner',
        });
    }
    expect(replies).toEqual(Array(24).fill(true));
    const healthy = f.read(undefined, { operation: 'current' });
    await f.flush();
    expect(f.result(healthy)).toMatchObject({
      ok: true,
      value: { elapsedMilliseconds: 1234.5 },
    });
    expect(f.fetches).toHaveLength(0);
  } finally {
    f.close();
  }
});
test('renderer owner cancellation requires nonce and owner phase without conflicting source fields', async () => {
  const f = await musicRendererFixture();
  try {
    const first = f.query();
    for (const invalid of [
      { requestId: first.requestId, nonce: 'b'.repeat(32), phase: 'owner' },
      { requestId: first.requestId, nonce: first.nonce },
      { requestId: first.requestId, nonce: first.nonce, phase: 'read' },
      { ...first, phase: 'owner' },
      {
        requestId: first.requestId,
        nonce: first.nonce,
        phase: 'owner',
        documentId: first.documentId,
      },
    ])
      f.emit('peard:music-cancel', invalid);
    for (let i = 0; i < 11; i++) expect(f.query()).toBeDefined();
    expect(f.query()).toBeUndefined();
    f.emit('peard:music-cancel', {
      requestId: first.requestId,
      nonce: first.nonce,
      phase: 'owner',
    });
    expect(f.query()).toBeDefined();
  } finally {
    f.close();
  }
});
test('late owner cancellation cannot retire a newer nonce lease with the same request ID', async () => {
  const f = await musicRendererFixture();
  try {
    const first = f.query(),
      abandoned = {
        requestId: first.requestId,
        nonce: first.nonce,
        phase: 'owner',
      };
    f.emit('peard:music-cancel', abandoned);
    const next = { requestId: first.requestId, nonce: 'b'.repeat(32) };
    f.emit('peard:music-owner-query', next);
    const ready = f.sent.find(
      (p) => p[1].type === 'ready' && p[1].nonce === next.nonce,
    )?.[1];
    expect(ready).toBeDefined();
    f.emit('peard:music-cancel', abandoned);
    f.read(ready, { operation: 'current' });
    await f.flush();
    expect(f.result(ready)).toMatchObject({
      ok: true,
      value: { elapsedMilliseconds: 1234.5 },
    });
  } finally {
    f.close();
  }
});
test('owner-phase cancellation cannot free or mark an already dispatched physical read', async () => {
  const f = await musicRendererFixture();
  try {
    const packet = f.read();
    f.emit('peard:music-cancel', {
      requestId: packet.requestId,
      nonce: packet.nonce,
      phase: 'owner',
    });
    expect(f.controller.stats()).toEqual({ active: 1, queued: 0 });
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(packet)).toMatchObject({ ok: true });
  } finally {
    f.close();
  }
});
