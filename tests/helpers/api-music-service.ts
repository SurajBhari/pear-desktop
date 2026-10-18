import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { musicModuleSource } from './api-music-source';
import {
  home151,
  searchPage,
  continuationPage,
} from './music-catalog-fixtures';
export async function musicServiceFixture() {
  const m = await musicModuleSource(
    [
      'src/plugins/api-server/backend/music-service.ts',
      'src/plugins/api-server/backend/music-grant-store.ts',
    ],
    { ipcMain: new EventEmitter() },
  );
  if (!m.createMusicService) throw Error('Missing typed music service');
  const g = m,
    c = await musicModuleSource('src/providers/music-catalog.ts');
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-music-service-'));
  let now = Date.now(),
    live = true,
    sourceLive = true,
    hold = false,
    authHeld = false,
    releaseAuth: (() => void) | undefined;
  const config: any = {
    enabled: true,
    musicApiEnabled: true,
    hostname: '127.0.0.1',
    port: 26538,
    useHttps: false,
  };
  const store = new g.MusicGrantStore(path.join(folder, 'owned'), () => now),
    resource = 'http://127.0.0.1:26538/api/v1/music';
  const grant = await store.issue(
      'Fixture',
      'rest',
      resource,
      ['catalog.read', 'playback.read'],
      () => true,
    ),
    other = await store.issue(
      'Other',
      'rest',
      resource,
      ['catalog.read'],
      () => true,
    );
  const originalAuth = store.authorize.bind(store);
  store.authorize = async (...args: any[]) => {
    if (authHeld) await new Promise<void>((r) => (releaseAuth = r));
    return originalAuth(...args);
  };
  const calls: any[] = [];
  const retirementObservers = new Set<() => void>();
  const broker = {
    capture: () => ({ frame: {}, generation: 0 }),
    isCurrent: () => live,
    subscribeRetirement: (observer: () => void) => {
      retirementObservers.add(observer);
      return () => retirementObservers.delete(observer);
    },
    resultOwner: () => ({
      epoch: '1'.repeat(32) + ':' + '2'.repeat(32),
      current: () => live && sourceLive,
    }),
    read: async (_owner: any, input: any, _principal: any, options: any) => {
      const call: any = { input, options };
      calls.push(call);
      if (hold) return new Promise((resolve) => (call.resolve = resolve));
      return c.normalizeMusicSource(
        input.operation === 'continuation' ? continuationPage() : home151(),
        input.operation === 'continuation' ? input.endpoint : 'browse',
      );
    },
  };
  const service = m.createMusicService({
    window: {},
    config,
    grants: store,
    broker,
    now: () => now,
  });
  return {
    service,
    store,
    config,
    grant,
    other,
    calls,
    resource,
    c,
    searchPage,
    continuationPage,
    setHold: (v = true) => (hold = v),
    authHold: () => (authHeld = true),
    authRelease: () => {
      authHeld = false;
      releaseAuth?.();
    },
    retire: () => (live = false),
    retireObserved: () => {
      live = false;
      for (const observer of retirementObservers) observer();
    },
    retireSource: () => (sourceLive = false),
    advance: (ms: number) => (now += ms),
    async close() {
      service.stop();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
