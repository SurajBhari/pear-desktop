import { test, expect } from '@playwright/test';
import { forceShuffleSource } from './helpers/force-shuffle';
import { forceShuffleNative } from './helpers/force-shuffle-native';

let source: string;
test.beforeAll(async () => {
  source = await forceShuffleSource();
});

test('native DOM and clock enforce the delay, preserve off beyond cooldown and keep selected queue identity', async () => {
  const result = await forceShuffleNative(source, async () => {
    document.body.innerHTML =
      '<ytmusic-player-bar><button class="shuffle"></button></ytmusic-player-bar><div id="queue"></div>';
    const source = (window as any).ShuffleFixture;
    const bar = document.querySelector('ytmusic-player-bar')!;
    const element = document.querySelector('#queue')! as any;
    let id = 'trackAAAAAA';
    const item = {
      playlistPanelVideoRenderer: { videoId: id, selected: true },
    };
    const subscriptions = new Set<() => void>();
    const calls: { at: number; selected: string; receiver: boolean }[] = [];
    let finish!: () => void;
    const queue = {
      store: {
        store: {
          getState: () => ({ queue: { items: [item], selectedItemIndex: 0 } }),
          subscribe: (callback: () => void) => {
            subscriptions.add(callback);
            return () => subscriptions.delete(callback);
          },
        },
      },
      shuffle() {
        calls.push({
          at: Date.now(),
          selected: item.playlistPanelVideoRenderer.videoId,
          receiver: this === queue,
        });
        bar.setAttribute('shuffle-on', '');
        finish();
      },
      dispatch() {
        throw Error('No MOVE_ITEM admitted');
      },
    };
    element.queue = queue;
    const api = {
      getVideoData: () => ({ video_id: id }),
      getPlayerResponse: () => ({ videoDetails: { videoId: id } }),
    };
    await source.force.renderer.onPlayerApiReady(api, {
      getConfig: async () => ({ enabled: true, mode: 'always' }),
    });
    bar
      .querySelector('button')!
      .addEventListener('click', () => bar.toggleAttribute('shuffle-on'));
    const admit = () =>
      document.dispatchEvent(
        new CustomEvent('videodatachange', {
          detail: { name: 'dataloaded', videoData: { videoId: id } },
        }),
      );
    const action = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error('Native action positive control missing')),
        4000,
      );
      finish = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    const admittedAt = Date.now();
    admit();
    admit();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const early = calls.length;
    await action;
    const delay = calls[0].at - admittedAt;
    bar.querySelector<HTMLButtonElement>('button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 3100));
    admit();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const off = !bar.hasAttribute('shuffle-on');
    source.force.renderer.stop();
    return {
      early,
      delay,
      calls: calls.length,
      off,
      selected: item.playlistPanelVideoRenderer.videoId,
      api: api.getVideoData().video_id,
      receiver: calls[0].receiver,
      subscriptions: subscriptions.size,
    };
  });
  expect(result.early).toBe(0);
  expect(result.delay).toBeGreaterThanOrEqual(1500);
  expect({ ...result, delay: undefined }).toEqual({
    early: 0,
    delay: undefined,
    calls: 1,
    off: true,
    selected: 'trackAAAAAA',
    api: 'trackAAAAAA',
    receiver: true,
    subscriptions: 0,
  });
});

test('native MutationObserver records preserve a positive shuffle before a batched reset admission', async () => {
  const result = await forceShuffleNative(source, async () => {
    document.body.innerHTML =
      '<ytmusic-player-bar><button class="shuffle"></button></ytmusic-player-bar><div id="queue"></div>';
    const source = (window as any).ShuffleFixture;
    const bar = document.querySelector('ytmusic-player-bar')!;
    const element = document.querySelector('#queue')! as any;
    const item = {
      playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
    };
    let calls = 0;
    let finish!: () => void;
    const queue = {
      store: {
        store: {
          getState: () => ({ queue: { items: [item], selectedItemIndex: 0 } }),
          subscribe: () => () => {},
        },
      },
      shuffle() {
        calls++;
        bar.setAttribute('shuffle-on', '');
        finish();
      },
    };
    element.queue = queue;
    const api = {
      getVideoData: () => ({ video_id: 'trackAAAAAA' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'trackAAAAAA' } }),
    };
    await source.force.renderer.onPlayerApiReady(api, {
      getConfig: async () => ({ enabled: true, mode: 'preserve' }),
    });
    const probe = new MutationObserver(() => {});
    probe.observe(bar, { attributes: true, attributeOldValue: true });
    bar.setAttribute('shuffle-on', '');
    bar.removeAttribute('shuffle-on');
    const oldValues = probe.takeRecords().map((record) => record.oldValue);
    probe.disconnect();
    const action = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error('Batched native intent was lost')),
        4000,
      );
      finish = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    document.dispatchEvent(
      new CustomEvent('videodatachange', {
        detail: { name: 'dataloaded', videoData: { videoId: 'trackAAAAAA' } },
      }),
    );
    await action;
    source.force.renderer.stop();
    return { oldValues, calls, on: bar.hasAttribute('shuffle-on') };
  });
  expect(result).toEqual({ oldValues: [null, ''], calls: 1, on: true });
});

test('both actual plugins with late native queue and synchronous keeper perform one reserved action', async () => {
  const result = await forceShuffleNative(source, async () => {
    document.body.innerHTML =
      '<ytmusic-player-bar><button class="shuffle"></button></ytmusic-player-bar><div id="queue"></div>';
    const source = (window as any).ShuffleFixture;
    (window as any).mainConfig = { get: () => true };
    const bar = document.querySelector('ytmusic-player-bar')!;
    const element = document.querySelector('#queue')! as any;
    let items: unknown[] = [];
    const subscriptions = new Set<() => void>();
    let calls = 0,
      releases = 0;
    let reserved: boolean | undefined;
    const queue = {
      store: {
        store: {
          getState: () => ({ queue: { items, selectedItemIndex: 0 } }),
          subscribe: (callback: () => void) => {
            subscriptions.add(callback);
            callback();
            return () => {
              releases++;
              subscriptions.delete(callback);
            };
          },
        },
      },
      shuffle() {
        calls++;
        bar.setAttribute('shuffle-on', '');
        const control = source.actionOwner.createShuffleActionOwner(
          document,
          'restore',
        );
        reserved = control.begin(Date.now());
        control.release();
      },
      dispatch() {
        throw Error('No manual queue reordering');
      },
    };
    const api = {
      getVideoData: () => ({ video_id: 'trackAAAAAA' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'trackAAAAAA' } }),
    };
    await source.resume.renderer.onPlayerApiReady(api, {
      getConfig: async () => ({ enabled: true, shuffled: true }),
      setConfig: async () => {},
    });
    await source.force.renderer.onPlayerApiReady(api, {
      getConfig: async () => ({ enabled: true, mode: 'always' }),
    });
    document.dispatchEvent(
      new CustomEvent('videodatachange', {
        detail: { name: 'dataloaded', videoData: { videoId: 'trackAAAAAA' } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    element.queue = queue;
    document.body.append(document.createElement('span'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    items = [
      {
        playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
      },
    ];
    for (const callback of [...subscriptions]) callback();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const selected = (items[0] as any).playlistPanelVideoRenderer.videoId;
    source.force.renderer.stop();
    source.resume.renderer.stop();
    return {
      calls,
      reserved,
      releases,
      subscriptions: subscriptions.size,
      selected,
      on: bar.hasAttribute('shuffle-on'),
      pathname: location.pathname,
    };
  });
  expect(result.calls).toBe(1);
  expect(result.reserved).toBe(false);
  expect(result.releases).toBeGreaterThanOrEqual(2);
  expect(result.subscriptions).toBe(0);
  expect(result.selected).toBe('trackAAAAAA');
  expect(result.on).toBe(true);
  expect(result.pathname).toBe('/watch');
});

test('native getter reentrant stop and new generation cannot let an obsolete check act', async () => {
  const result = await forceShuffleNative(source, async () => {
    document.body.innerHTML =
      '<ytmusic-player-bar><button class="shuffle"></button></ytmusic-player-bar><div id="queue"></div>';
    const source = (window as any).ShuffleFixture;
    const bar = document.querySelector('ytmusic-player-bar')!;
    const element = document.querySelector('#queue')! as any;
    const subscriptions = new Set<() => void>();
    let armed = false,
      calls = 0;
    let restarted: Promise<void> | undefined;
    const api = {
      getVideoData: () => ({ video_id: 'trackAAAAAA' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'trackAAAAAA' } }),
    };
    const context = {
      getConfig: async () => ({ enabled: true, mode: 'always' }),
    };
    const queue = {
      store: {
        store: {
          getState() {
            if (armed) {
              armed = false;
              source.force.renderer.stop();
              restarted = source.force.renderer.onPlayerApiReady(api, context);
            }
            return {
              queue: {
                items: [
                  {
                    playlistPanelVideoRenderer: {
                      videoId: 'trackAAAAAA',
                      selected: true,
                    },
                  },
                ],
                selectedItemIndex: 0,
              },
            };
          },
          subscribe(callback: () => void) {
            subscriptions.add(callback);
            return () => subscriptions.delete(callback);
          },
        },
      },
      shuffle() {
        calls++;
        bar.setAttribute('shuffle-on', '');
      },
    };
    element.queue = queue;
    await source.force.renderer.onPlayerApiReady(api, context);
    const admit = () =>
      document.dispatchEvent(
        new CustomEvent('videodatachange', {
          detail: { name: 'dataloaded', videoData: { videoId: 'trackAAAAAA' } },
        }),
      );
    admit();
    armed = true;
    await new Promise((resolve) => setTimeout(resolve, 1750));
    await restarted;
    const obsolete = calls;
    admit();
    await new Promise((resolve) => setTimeout(resolve, 1750));
    source.force.renderer.stop();
    return {
      obsolete,
      calls,
      subscriptions: subscriptions.size,
      on: bar.hasAttribute('shuffle-on'),
    };
  });
  expect(result).toEqual({ obsolete: 0, calls: 1, subscriptions: 0, on: true });
});
