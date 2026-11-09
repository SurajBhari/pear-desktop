import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(root, 'src/config/adblocker-migration.ts');

test('migration preserves the exact legacy mode and independent tracker preferences', async () => {
  const legacy = {
    enabled: false,
    blocker: 'Ad speedup',
    cache: false,
    additionalBlockLists: ['https://example.com/list'],
    disableDefaultLists: true,
  };
  const tracker = { enabled: true, blocker: 'With blocklists' };
  const values = new Map<string, unknown>([
    ['plugins.adblocker', legacy],
    ['plugins.do-not-track', tracker],
  ]);
  const store = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
    delete: (key: string) => values.delete(key),
  };
  const { restoreAdblockerConfig } =
    await import('../src/config/adblocker-migration');
  restoreAdblockerConfig(store);
  restoreAdblockerConfig(store);
  expect(values.get('plugins.adblocker')).toEqual(legacy);
  expect(values.get('plugins.do-not-track')).toEqual(tracker);
});

test('already migrated profiles recover a copy without changing tracker choices or inventing lost speedup', async () => {
  expect(existsSync(migrationPath)).toBe(true);
  const { restoreAdblockerConfig } =
    await import('../src/config/adblocker-migration');
  const tracker = {
    enabled: false,
    blocker: 'With blocklists',
    additionalBlockLists: ['https://example.com/list'],
  };
  const values = new Map<string, unknown>([['plugins.do-not-track', tracker]]);
  restoreAdblockerConfig({
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  });
  expect(values.get('plugins.adblocker')).toEqual(tracker);
  expect(values.get('plugins.adblocker')).not.toBe(tracker);
  expect(values.get('plugins.do-not-track')).toBe(tracker);
});

test('speedup restores original playback state and stops observing after disable', async () => {
  const path = resolve(root, 'src/plugins/adblocker/ad-speedup.ts');
  expect(existsSync(path)).toBe(true);
  const { createAdSpeedup } =
    await import('../src/plugins/adblocker/ad-speedup');
  const window = new Window();
  window.document.body.innerHTML =
    '<div id="movie_player" class="ad-showing"><video></video></div>';
  const video = window.document.querySelector('video')!;
  video.playbackRate = 1.75;
  video.muted = false;
  const speedup = createAdSpeedup(window.document as unknown as Document);
  speedup.start();
  speedup.start();
  expect(video.playbackRate).toBe(16);
  expect(video.muted).toBe(true);
  speedup.stop();
  expect(video.playbackRate).toBe(1.75);
  expect(video.muted).toBe(false);
  window.document.querySelector('#movie_player')!.className = '';
  await window.happyDOM.whenAsyncComplete();
  expect(video.playbackRate).toBe(1.75);
  await window.happyDOM.close();
});

test('shared page pruning survives one owner stopping and restores original hooks at last stop', async () => {
  const path = resolve(root, 'src/providers/blocker-player.ts');
  expect(existsSync(path)).toBe(true);
  const { setPlayerAdBlocking } =
    await import('../src/providers/blocker-player');
  const window = new Window();
  const originalParse = window.JSON.parse;
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', true)`);
  window.eval(`(${setPlayerAdBlocking.toString()})('do-not-track', true)`);
  const response =
    '{"playerResponse":{"adSlots":[1],"videoDetails":{"title":"keep"}},"other":{"adSlots":[2]}}';
  expect(window.JSON.parse(response)).toEqual({
    playerResponse: { videoDetails: { title: 'keep' } },
    other: { adSlots: [2] },
  });
  expect(window.JSON.parse('null')).toBe(null);
  expect(window.JSON.parse('42')).toBe(42);
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', false)`);
  expect(window.JSON.parse('{"playerAds":[1]}')).toEqual({});
  window.eval(`(${setPlayerAdBlocking.toString()})('do-not-track', false)`);
  expect(window.JSON.parse).toBe(originalParse);
  expect(window.JSON.parse('{"playerAds":[1]}')).toEqual({ playerAds: [1] });
  await window.happyDOM.close();
});

test('session owners merge blocklists and a stopped async build cannot activate stale blocking', async () => {
  const path = resolve(root, 'src/providers/blocker-ownership.ts');
  expect(existsSync(path)).toBe(true);
  const { createOwnedBlocker } =
    await import('../src/providers/blocker-ownership');
  const active = new Set<string>();
  let release: (() => void) | undefined;
  const controller = createOwnedBlocker(async (lists) => {
    if (lists.includes('slow'))
      await new Promise<void>((r) => {
        release = r;
      });
    return {
      enable: () => lists.forEach((x) => active.add(x)),
      disable: () => active.clear(),
    };
  });
  await controller.set('tracker', ['tracker']);
  await controller.set('ads', ['ads']);
  expect([...active].sort()).toEqual(['ads', 'tracker']);
  await controller.set('ads', null);
  expect([...active]).toEqual(['tracker']);
  const pending = controller.set('ads', ['slow']);
  await Promise.resolve();
  const stop = controller.set('ads', null);
  release!();
  await Promise.all([pending, stop]);
  expect([...active]).toEqual(['tracker']);
  await controller.set('tracker', null);
  expect(active.size).toBe(0);
});

test('removing one owner fails safely if rebuilding the remaining owner fails', async () => {
  const { createOwnedBlocker } =
    await import('../src/providers/blocker-ownership');
  const active = new Set<string>();
  let offline = false;
  const controller = createOwnedBlocker(async (lists) => {
    if (offline) throw new Error('offline');
    return {
      enable: () => lists.forEach((x) => active.add(x)),
      disable: () => active.clear(),
    };
  });
  await controller.set('tracker', ['tracker']);
  await controller.set('ads', ['ads']);
  offline = true;
  await expect(controller.set('ads', null)).rejects.toThrow('offline');
  expect([...active]).not.toContain('ads');
  offline = false;
  await controller.set('tracker', ['tracker']);
  expect([...active]).toEqual(['tracker']);
});

test('an external wrapper retained after disabling no longer applies our pruning', async () => {
  const { setPlayerAdBlocking } =
    await import('../src/providers/blocker-player');
  const window = new Window();
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', true)`);
  const ours = window.JSON.parse;
  const external = (...args: Parameters<typeof JSON.parse>) => ours(...args);
  window.JSON.parse = external;
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', false)`);
  expect(window.JSON.parse).toBe(external);
  expect(window.JSON.parse('{"playerAds":[1]}')).toEqual({ playerAds: [1] });
  await window.happyDOM.close();
});

test('a delayed renderer start cannot speed up a player after stopping', async () => {
  expect(existsSync(resolve(root, 'src/plugins/adblocker/renderer.ts'))).toBe(
    true,
  );
  const { createAdblockerRenderer } =
    await import('../src/plugins/adblocker/renderer');
  const window = new Window();
  window.document.body.innerHTML =
    '<div id="movie_player" class="ad-showing"><video></video></div>';
  const config = {
    enabled: true,
    blocker: 'Ad speedup' as const,
    cache: false,
    additionalBlockLists: [],
    disableDefaultLists: false,
  };
  let finish: ((config: typeof config) => void) | undefined;
  const renderer = createAdblockerRenderer(
    window.document as unknown as Document,
  );
  const pending = renderer.start({
    getConfig: () =>
      new Promise<typeof config>((r) => {
        finish = r;
      }),
  });
  renderer.stop();
  finish!(config);
  await pending;
  expect(window.document.querySelector('video')!.playbackRate).toBe(1);
  await window.happyDOM.close();
});

test('page bootstrap assignments are pruned and remain readable after final stop', async () => {
  const { setPlayerAdBlocking } =
    await import('../src/providers/blocker-player');
  const window = new Window();
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', true)`);
  window.eval(
    'window.ytInitialPlayerResponse = { playerAds: [1], videoDetails: { title: "keep" } }',
  );
  expect(window.eval('window.ytInitialPlayerResponse')).toEqual({
    videoDetails: { title: 'keep' },
  });
  const response = new window.Response(
    '{"adPlacements":[1],"videoDetails":{"title":"keep"}}',
  );
  expect(await response.json()).toEqual({ videoDetails: { title: 'keep' } });
  window.eval(`(${setPlayerAdBlocking.toString()})('adblocker', false)`);
  expect(window.eval('window.ytInitialPlayerResponse')).toEqual({
    videoDetails: { title: 'keep' },
  });
  window.eval('window.ytInitialPlayerResponse = { playerAds: [2] }');
  expect(window.eval('window.ytInitialPlayerResponse')).toEqual({
    playerAds: [2],
  });
  await window.happyDOM.close();
});

test('stopping aborts an in-flight list fetch', async () => {
  const { createOwnedBlocker } =
    await import('../src/providers/blocker-ownership');
  let aborted = false;
  let signalSeen: AbortSignal | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const controller = createOwnedBlocker(async (lists, signal) => {
    if (lists.includes('slow')) {
      signalSeen = signal;
      started!();
      await new Promise<void>((r) => {
        if (!signal) {
          r();
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            r();
          },
          { once: true },
        );
      });
    }
    return { enable: () => {}, disable: () => {} };
  });
  const pending = controller.set('ads', ['slow']);
  await ready;
  const stop = controller.set('ads', null);
  expect(signalSeen?.aborted).toBe(true);
  await Promise.all([pending, stop]);
  expect(aborted).toBe(true);
});

test('changing cache preference rebuilds even when the list URLs are unchanged', async () => {
  const { createOwnedBlocker } =
    await import('../src/providers/blocker-ownership');
  let builds = 0;
  const controller = createOwnedBlocker(async () => {
    builds++;
    return { enable: () => {}, disable: () => {} };
  });
  await controller.set('ads', ['ads'], 'cached');
  await controller.set('ads', ['ads'], 'uncached');
  expect(builds).toBe(2);
});
