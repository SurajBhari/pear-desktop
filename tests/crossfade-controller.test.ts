import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

const extra =
  "export * from '@/providers/renderer-audio'; export {TransitionAudio} from '@/plugins/crossfade/transition-audio';";
test('deferred preparation makes no graph admission; auxiliary rate and pitch are verified before a silent route', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(extra));
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture,
      context = new AudioContext(),
      main = document.querySelector('video')!;
    const graph = f.initializeAudioGraph(
      context,
      context.createMediaElementSource(main),
    );
    const audio = new f.TransitionAudio(
      'https://media.invalid/not-requested',
      graph,
      { deferAdmission: true },
    );
    const before = graph.auxiliaryMediaCount;
    const copied = audio.setPlaybackSnapshot({
      rate: 2,
      flags: [{ key: 'preservesPitch', value: false }],
    });
    const admitted = audio.admit(),
      during = graph.auxiliaryMediaCount;
    const values = [
      audio.element.playbackRate,
      audio.element.preservesPitch,
      audio.envelope.value,
      audio.element.volume,
    ];
    audio.unload();
    audio.unload();
    void context.close();
    return {
      before,
      copied,
      admitted,
      during,
      values,
      after: graph.auxiliaryMediaCount,
    };
  });
  expect(result).toEqual({
    before: 0,
    copied: true,
    admitted: true,
    during: 1,
    values: [2, false, 0, 1],
    after: 0,
  });
});
test('early registration disposer prevents observer stop from connecting after disposal', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(extra));
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture,
      c = new AudioContext(),
      main = document.querySelector('video')!,
      graph = f.initializeAudioGraph(c, c.createMediaElementSource(main));
    const gain = c.createGain(),
      audio = document.createElement('audio');
    let dispose = () => {};
    let dryConnections = 0;
    const original = gain.connect.bind(gain);
    gain.connect = ((...args: any[]) => {
      dryConnections++;
      return (original as any)(...args);
    }) as any;
    const release = graph.observeAuxiliaryMedia((count: number) => {
      if (count) dispose();
    });
    const returned = graph.registerMedia(audio, gain, gain, {
      publishDispose: (value: () => void) => {
        dispose = value;
      },
      isCurrent: () => true,
    });
    returned();
    release();
    void c.close();
    return { count: graph.auxiliaryMediaCount, dryConnections };
  });
  expect(result).toEqual({ count: 0, dryConnections: 0 });
});
test('retirement attempts both graph disconnections and retires count after an edge throws', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(extra));
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture,
      c = new AudioContext(),
      main = document.querySelector('video')!,
      graph = f.initializeAudioGraph(c, c.createMediaElementSource(main));
    const input = c.createGain(),
      output = c.createGain(),
      audio = document.createElement('audio');
    input.connect(output);
    const source = c.createMediaElementSource.bind(c);
    let attempts = 0;
    c.createMediaElementSource = ((el: HTMLMediaElement) => {
      const node = source(el);
      node.disconnect = (() => {
        throw Error('owned test edge fault');
      }) as any;
      return node;
    }) as any;
    const original = output.disconnect.bind(output);
    output.disconnect = ((...args: any[]) => {
      attempts++;
      return (original as any)(...args);
    }) as any;
    const dispose = graph.registerMedia(audio, input, output);
    try {
      dispose();
    } catch {}
    void c.close();
    return { attempts, count: graph.auxiliaryMediaCount };
  });
  expect(result).toEqual({ attempts: 1, count: 0 });
});

test('one underlying audio request remains quarantined across cancellation and replacement until actual settlement', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).ipcRenderer = { on: () => {} };
  });
  await fixturePage(
    page,
    await equalizerBundle(
      "export {requestCrossfadeAudio} from '@/plugins/crossfade/controller';",
    ),
  );
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    let calls = 0,
      resolve: (v: unknown) => void = () => {};
    const invoke = () => {
      calls++;
      return new Promise((r) => (resolve = r));
    };
    const a = f.requestCrossfadeAudio('AAAAAAAAAAA', invoke);
    const b = f.requestCrossfadeAudio('BBBBBBBBBBB', invoke);
    resolve(null);
    await a.result;
    const c = f.requestCrossfadeAudio('CCCCCCCCCCC', invoke);
    resolve(null);
    await c.result;
    return { a: a.kind, b: b.kind, c: c.kind, calls };
  });
  expect(result).toEqual({ a: 'started', b: 'busy', c: 'started', calls: 2 });
});

test('actual native adapter rejects malformed/default-override and unsafe playback evidence without changing controls', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  await startCrossfadeFixture(page, { requestDelay: true });
  const result = await page.evaluate(() => {
    const f = (window as any).crossfadeFixture,
      w = window as any,
      valid = !!f.state(),
      original = w.mainConfig;
    const configCases = [
      [],
      null,
      { 'skip-disliked-songs': { enabled: true } },
      { 'music-together': { enabled: true } },
      { 'skip-disliked-songs': [] },
      { 'skip-disliked-songs': { enabled: 'false' } },
    ];
    const configResults = configCases.map((plugins) => {
      w.mainConfig = { get: () => plugins };
      return f.state() === null;
    });
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'skip-disliked-songs', {
      get: () => {
        getterCalls++;
        return { enabled: false };
      },
    });
    w.mainConfig = { get: () => accessor };
    const accessorRejected = f.state() === null;
    w.mainConfig = original;
    const initial = f.main.preservesPitch;
    f.main.preservesPitch = !initial;
    const observedPitch = f
      .state()
      ?.playback.flags.find((v: any) => v.key === 'preservesPitch')?.value;
    f.main.preservesPitch = initial;
    w.EqualizerFixture.beginAdSpeedupOverride(f.main, 1);
    const adRejected = f.state() === null;
    w.EqualizerFixture.endAdSpeedupOverride(f.main);
    f.renderer.stop();
    void f.context.close();
    return {
      valid,
      configResults,
      accessorRejected,
      getterCalls,
      observedPitch,
      initial,
      adRejected,
      volume: f.main.volume,
    };
  });
  expect(result.valid).toBe(true);
  expect(result.configResults.every(Boolean)).toBe(true);
  expect(result.accessorRejected).toBe(true);
  expect(result.getterCalls).toBe(0);
  expect(result.observedPitch).toBe(!result.initial);
  expect(result.adRejected).toBe(true);
  expect(result.volume).toBe(0.65);
});
test('replacement cannot start a second physical IPC while retired first IPC is unresolved', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  await startCrossfadeFixture(page, { requestDelay: true });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.requests))
    .toBe(1);
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.onPlayerApiReady(f.api);
    f.main.dispatchEvent(new Event('timeupdate'));
    f.resolve();
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return { requests: f.requests, aux: f.aux.length, next: f.nexts };
    }),
  ).toEqual({ requests: 1, aux: 0, next: 0 });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.onPlayerApiReady(f.api);
    f.main.dispatchEvent(new Event('timeupdate'));
    f.resolve();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.requests))
    .toBe(2);
});
for (const change of [
  'same-id-episode',
  'queue-order',
  'repeat',
  'shuffle',
  'revision',
  'main-replacement',
  'pitch',
])
  test(`preparation cancels on ${change} without native next or control mutation`, async ({
    page,
  }) => {
    const { startCrossfadeFixture } =
      await import('./helpers/crossfade-native');
    await startCrossfadeFixture(page, { requestDelay: true });
    await page.evaluate((change) => {
      const f = (window as any).crossfadeFixture,
        queue = document.querySelector('#queue') as any,
        bar = document.querySelector('ytmusic-player-bar') as any;
      if (change === 'same-id-episode')
        f.api.dispatchEvent(new Event('videodatachange'));
      else if (change === 'revision') f.manual();
      else if (change === 'main-replacement')
        f.main.replaceWith(document.createElement('video'));
      else if (change === 'pitch')
        f.main.preservesPitch = !f.main.preservesPitch;
      else {
        const old = queue.queue.store.store.getState;
        queue.queue.store.store.getState = () => {
          const value = old();
          if (change === 'repeat') value.queue.repeatMode = 'ALL';
          else if (change === 'shuffle') value.queue.shuffleEnabled = true;
          else value.queue.items.reverse();
          return value;
        };
        bar.getState = queue.queue.store.store.getState;
      }
      f.main.dispatchEvent(new Event('timeupdate'));
      f.resolve();
    }, change);
    await page.waitForTimeout(50);
    expect(
      await page.evaluate(() => {
        const f = (window as any).crossfadeFixture;
        return { aux: f.aux.length, next: f.nexts, volume: f.main.volume };
      }),
    ).toEqual({ aux: 0, next: 0, volume: 0.65 });
  });

test('observer-triggered retirement cannot admit a successor until the exact crossfade transaction settles', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(extra));
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture,
      c = new AudioContext(),
      main = document.querySelector('video')!,
      graph = f.initializeAudioGraph(c, c.createMediaElementSource(main));
    const old = new f.TransitionAudio('https://media.invalid/old', graph, {
      deferAdmission: true,
    });
    let successor: any,
      busy: any,
      observed = false;
    const release = graph.observeAuxiliaryMedia((count: number) => {
      if (count && !observed) {
        observed = true;
        old.unload();
        successor = new f.TransitionAudio('https://media.invalid/new', graph, {
          deferAdmission: true,
        });
        busy = successor.admit();
      }
    });
    const first = old.admit(),
      afterOld = graph.auxiliaryMediaCount;
    release();
    const later = successor.admit(),
      afterNew = graph.auxiliaryMediaCount;
    successor.unload();
    void c.close();
    return {
      first,
      busy,
      afterOld,
      later,
      afterNew,
      final: graph.auxiliaryMediaCount,
    };
  });
  expect(result).toEqual({
    first: false,
    busy: false,
    afterOld: 0,
    later: true,
    afterNew: 1,
    final: 0,
  });
});
test('wrong-context output is rejected before an auxiliary can enter the graph', async ({
  page,
}) => {
  await fixturePage(page, await equalizerBundle(extra));
  expect(
    await page.evaluate(() => {
      const f = (window as any).EqualizerFixture,
        c = new AudioContext(),
        main = document.querySelector('video')!,
        graph = f.initializeAudioGraph(c, c.createMediaElementSource(main));
      let rejected = false;
      try {
        graph.registerMedia(document.createElement('audio'), c.createGain(), {
          context: {},
        });
      } catch {
        rejected = true;
      }
      void c.close();
      return { rejected, count: graph.auxiliaryMediaCount };
    }),
  ).toEqual({ rejected: true, count: 0 });
});

test('shared next reservation rolls back only unconsumed crossfade intent and preserves a filter-owned committed skip', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).ipcRenderer = { on: () => {} };
  });
  await fixturePage(
    page,
    await equalizerBundle(
      "export {claimCrossfadeNext,createPlaybackFilter} from '@/plugins/utils/renderer/playback-filter';",
    ),
  );
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture,
      bar = document.createElement('ytmusic-player-bar');
    document.body.append(bar);
    (bar as any).getState = () => ({
      queue: {
        selectedItemIndex: 0,
        items: [{ playlistPanelVideoRenderer: { videoId: 'AAAAAAAAAAA' } }],
      },
    });
    const api = {
      getVideoData: () => ({ video_id: 'AAAAAAAAAAA' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'AAAAAAAAAAA' } }),
      getPlaylistIndex: () => 0,
      addEventListener: () => {},
      removeEventListener: () => {},
      nextVideo: () => {},
    };
    const filter = f.createPlaybackFilter(
      { ipc: { subscribe: () => () => {} } },
      () => false,
    );
    filter.attach(api);
    const first = f.claimCrossfadeNext(api, 'AAAAAAAAAAA', 0),
      blocked = f.claimCrossfadeNext(api, 'AAAAAAAAAAA', 0);
    first.release();
    const second = f.claimCrossfadeNext(api, 'AAAAAAAAAAA', 0);
    second.commit();
    second.release();
    const preserved = f.claimCrossfadeNext(api, 'AAAAAAAAAAA', 0);
    filter.stop();
    const after = f.claimCrossfadeNext(api, 'AAAAAAAAAAA', 0);
    after.release();
    return {
      first: !!first,
      blocked: blocked === null,
      second: !!second,
      preserved: preserved === null,
      after: !!after,
    };
  });
  expect(result).toEqual({
    first: true,
    blocked: true,
    second: true,
    preserved: true,
    after: true,
  });
});

test('buffered silent A preparation remains unregistered until the near-end arm', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  await startCrossfadeFixture(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.requests))
    .toBe(1);
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        count: f.graph.auxiliaryMediaCount,
        registered: f.aux.length,
        nexts: f.nexts,
      };
    }),
  ).toEqual({ count: 0, registered: 0, nexts: 0 });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      timeout: 7000,
      intervals: [20],
    })
    .toBe(1);
  expect(
    await page.evaluate(
      () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
    ),
  ).toBe(1);
});

test('late real auxiliary metadata after stop cannot admit or revive status', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  await startCrossfadeFixture(page, { delayAuxLoadMs: 350 });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.requests))
    .toBe(1);
  await page.evaluate(() => (window as any).crossfadeFixture.renderer.stop());
  await page.waitForTimeout(450);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        count: f.graph.auxiliaryMediaCount,
        registered: f.aux.length,
        next: f.nexts,
        status: document.querySelector('[role=status]')?.textContent ?? null,
      };
    }),
  ).toEqual({ count: 0, registered: 0, next: 0, status: null });
});
test('late owned play completion after stop cannot invoke native next or revive an insert', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  await startCrossfadeFixture(page, { holdAuxPlay: true });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
        ),
      { timeout: 7000, intervals: [20] },
    )
    .toBe(1);
  await expect
    .poll(
      () => page.evaluate(() => (window as any).crossfadeFixture.playPending),
      { intervals: [20] },
    )
    .toBe(true);
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.stop();
    f.releasePlay();
  });
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        count: f.graph.auxiliaryMediaCount,
        next: f.nexts,
        status: document.querySelector('[role=status]')?.textContent ?? null,
      };
    }),
  ).toEqual({ count: 0, next: 0, status: null });
});

test('a trailing codec callout that replaces readiness cannot allocate stale outgoing media', async ({
  page,
}) => {
  const { startCrossfadeFixture } = await import('./helpers/crossfade-native');
  let auxiliaryRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/aux-a.wav')) auxiliaryRequests++;
  });
  await startCrossfadeFixture(page, { requestDelay: true });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.main.canPlayType = () => {
      f.setConfig({ enabled: false });
      f.renderer.onPlayerApiReady(f.api);
      return 'probably';
    };
    f.resolve();
  });
  await page.waitForTimeout(100);
  expect(auxiliaryRequests).toBe(0);
  expect(
    await page.evaluate(
      () => (window as any).crossfadeFixture.graph.auxiliaryMediaCount,
    ),
  ).toBe(0);
});
