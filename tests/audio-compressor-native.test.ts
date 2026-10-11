import { test, expect } from '@playwright/test';
import { equalizerBundle } from './helpers/equalizer-bundle';
import { compressorNative } from './helpers/compressor-native';

let bundle: string;
// Observe only methods on the fixture's owned native node; never drive its clock/gain.
const timingFixture = `
export const observeGainTiming = node => {
  let target = NaN, end = 0;
  const set = node.gain.setValueAtTime.bind(node.gain);
  const ramp = node.gain.linearRampToValueAtTime.bind(node.gain);
  node.gain.setValueAtTime = (value, time) => {
    target = value; end = time; return set(value, time);
  };
  node.gain.linearRampToValueAtTime = (value, time) => {
    target = value; end = time; return ramp(value, time);
  };
  return { wait: async expected => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const audioTime = node.context.currentTime;
      const quantum = 128 / node.context.sampleRate;
      if (target === expected && node.context.state === 'running' && audioTime >= end + quantum)
        return {target, end, audioTime, value: node.gain.value};
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Owned gain did not reach its scheduled audio-clock end: ' + JSON.stringify({expected,target,end,audioTime:node.context.currentTime,state:node.context.state}));
  }};
};`;
test.beforeAll(async () => {
  bundle = await equalizerBundle(
    "export * from '@/providers/renderer-audio';export {default as compressor} from '@/plugins/audio-compressor';" +
      timingFixture,
  );
});

test('Electron native identity events, response lag, late enable and teardown fence stale makeup', async () => {
  const result = await compressorNative(bundle, async () => {
    const f = (window as any).EqualizerFixture;
    const context = new AudioContext({
      sinkId: { type: 'none' },
    } as AudioContextOptions);
    if ((context as any).sinkId?.type !== 'none')
      throw Error('Silent sink required; no hardware probe permitted');
    await context.resume();
    const video = document.querySelector('video')!;
    const graph = f.initializeAudioGraph(
      context,
      context.createMediaElementSource(video),
    );
    let gain: GainNode;
    let timing: ReturnType<typeof f.observeGainTiming>;
    const rendered: any[] = [];
    let anchor = 1,
      anchors = 0;
    const create = context.createGain.bind(context);
    context.createGain = () => {
      gain = create();
      timing = f.observeGainTiming(gain);
      const set = gain.gain.setValueAtTime.bind(gain.gain);
      gain.gain.setValueAtTime = (value, time) => {
        anchor = value;
        anchors++;
        return set(value, time);
      };
      return gain;
    };
    const events = new EventTarget();
    let native = 'A',
      response = 'A',
      db = -6,
      throws = false,
      listeners = 0;
    const api = {
      getVideoData: () => {
        if (throws) throw Error('native loss');
        return { video_id: native };
      },
      getPlayerResponse: () => ({
        videoDetails: { videoId: response },
        playerConfig: { audioConfig: { loudnessDb: db } },
      }),
      addEventListener: (...args: any[]) => {
        listeners++;
        (events.addEventListener as any)(...args);
      },
      removeEventListener: (...args: any[]) => {
        listeners--;
        (events.removeEventListener as any)(...args);
      },
    };
    const settings = { enabled: true, autoTrackGain: false, maxTrackGainDb: 6 };
    await f.compressor.renderer.start({ getConfig: () => settings });
    f.compressor.renderer.onPlayerApiReady(api);
    const read = () => gain?.gain.value ?? 1;
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const off = read();
    f.compressor.renderer.onConfigChange?.({
      ...settings,
      autoTrackGain: true,
    });
    rendered.push(await timing.wait(10 ** (6 / 20)));
    const enabled = read();
    native = 'B';
    events.dispatchEvent(new Event('videodatachange'));
    const stale = anchor;
    await wait(20);
    const staleRendered = read();
    response = 'B';
    rendered.push(await timing.wait(10 ** (6 / 20)));
    const retry = read();
    native = '';
    events.dispatchEvent(new Event('videodatachange'));
    const lost = anchor;
    await wait(450);
    const stillLost = read();
    native = 'C';
    response = 'C';
    db = -3;
    events.dispatchEvent(new Event('videodatachange'));
    rendered.push(await timing.wait(10 ** (3 / 20)));
    const next = read();
    throws = true;
    events.dispatchEvent(new Event('videodatachange'));
    const apiFailure = anchor;
    throws = false;
    f.compressor.renderer.stop();
    const retiredAnchors = anchors;
    native = 'D';
    response = 'D';
    db = -12;
    events.dispatchEvent(new Event('videodatachange'));
    await wait(450);
    const stopped = anchor;
    const retiredWrites = anchors - retiredAnchors;
    await context.close();
    return {
      off,
      enabled,
      stale,
      staleRendered,
      retry,
      lost,
      stillLost,
      next,
      apiFailure,
      stopped,
      retiredWrites,
      listeners,
      count: graph.auxiliaryMediaCount,
      rendered,
    };
  });
  console.log(JSON.stringify(result));
  expect(result.off).toBe(1);
  expect(result.enabled).toBeCloseTo(10 ** (6 / 20), 4);
  expect(result.stale).toBe(1);
  expect(result.staleRendered).toBe(1);
  expect(result.retry).toBeCloseTo(10 ** (6 / 20), 4);
  expect(result.lost).toBe(1);
  expect(result.stillLost).toBe(1);
  expect(result.next).toBeCloseTo(10 ** (3 / 20), 4);
  expect(result.apiFailure).toBe(1);
  expect(result.stopped).toBe(1);
  expect(result.retiredWrites).toBe(0);
  expect(result.listeners).toBe(0);
  expect(result.rendered.map((item: any) => item.target)).toEqual([
    10 ** (6 / 20),
    10 ** (6 / 20),
    10 ** (3 / 20),
  ]);
  expect(result.rendered.every((item: any) => item.audioTime >= item.end)).toBe(
    true,
  );
});

test('Electron auxiliary notifications precede dry connection, retire after disconnection and survive observer/failure adversity', async () => {
  const result = await compressorNative(bundle, async () => {
    const f = (window as any).EqualizerFixture;
    const context = new AudioContext({
      sinkId: { type: 'none' },
    } as AudioContextOptions);
    if ((context as any).sinkId?.type !== 'none')
      throw Error('Silent sink required');
    await context.resume();
    const graph = f.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')!),
    );
    if (!graph.observeAuxiliaryMedia) return { available: false };
    let trackGain: GainNode;
    let timing: ReturnType<typeof f.observeGainTiming>;
    const rendered: any[] = [];
    let anchor = 1;
    const create = context.createGain.bind(context);
    context.createGain = () => {
      trackGain = create();
      timing = f.observeGainTiming(trackGain);
      const set = trackGain.gain.setValueAtTime.bind(trackGain.gain);
      trackGain.gain.setValueAtTime = (value, time) => {
        anchor = value;
        return set(value, time);
      };
      return trackGain;
    };
    const events = new EventTarget();
    const api = {
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'A' },
        playerConfig: { audioConfig: { loudnessDb: -6 } },
      }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
    await f.compressor.renderer.start({
      getConfig: () => ({
        enabled: true,
        autoTrackGain: true,
        maxTrackGainDb: 6,
      }),
    });
    f.compressor.renderer.onPlayerApiReady(api);
    rendered.push(await timing.wait(10 ** (6 / 20)));
    const boost = trackGain!.gain.value;
    const gain = create();
    let connected = false;
    const connect = gain.connect.bind(gain),
      disconnect = gain.disconnect.bind(gain);
    gain.connect = ((target: AudioNode) => {
      if (target === graph.dryInput) connected = true;
      return connect(target);
    }) as typeof gain.connect;
    gain.disconnect = ((target: AudioNode) => {
      const result = disconnect(target);
      if (target === graph.dryInput) connected = false;
      return result;
    }) as typeof gain.disconnect;
    const observations: any[] = [];
    const bad = graph.observeAuxiliaryMedia(() => {
      throw Error('owned observer fixture');
    });
    const good = graph.observeAuxiliaryMedia((count: number) =>
      observations.push({ count, connected, gain: anchor }),
    );
    const aux = document.createElement('audio');
    const release = graph.registerMedia(aux, gain);
    const during = anchor;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const duringRendered = trackGain!.gain.value;
    let duplicateRejected = false;
    try {
      graph.registerMedia(aux, gain);
    } catch {
      duplicateRejected = true;
    }
    release();
    release();
    rendered.push(await timing.wait(10 ** (6 / 20)));
    const recovered = trackGain!.gain.value;
    const failGain = create();
    const retryAux = document.createElement('audio');
    const nativeFailConnect = failGain.connect.bind(failGain);
    failGain.connect = (() => {
      throw Error('dry connection failure');
    }) as typeof failGain.connect;
    let failureRejected = false;
    try {
      graph.registerMedia(retryAux, failGain);
    } catch {
      failureRejected = true;
    }
    const afterFailure = graph.auxiliaryMediaCount;
    failGain.connect = nativeFailConnect;
    const retryRelease = graph.registerMedia(retryAux, failGain);
    retryRelease();
    const firstOverlap = graph.registerMedia(
      document.createElement('audio'),
      create(),
    );
    const secondOverlap = graph.registerMedia(
      document.createElement('audio'),
      create(),
    );
    firstOverlap();
    const retainedCount = graph.auxiliaryMediaCount;
    const retainedGain = anchor;
    secondOverlap();
    const observed = observations.length;
    bad();
    good();
    const final = graph.registerMedia(
      document.createElement('audio'),
      create(),
    );
    final();
    const ownerSafe = observations.length === observed;
    f.compressor.renderer.stop();
    await context.close();
    return {
      available: true,
      boost,
      during,
      duringRendered,
      recovered,
      observations,
      duplicateRejected,
      failureRejected,
      afterFailure,
      retainedCount,
      retainedGain,
      ownerSafe,
      rendered,
    };
  });
  console.log(JSON.stringify(result));
  expect(result.available).toBe(true);
  expect(result.boost).toBeCloseTo(10 ** (6 / 20), 4);
  expect(result.during).toBe(1);
  expect(result.duringRendered).toBe(1);
  expect(result.recovered).toBeCloseTo(10 ** (6 / 20), 4);
  expect(result.observations!.map((item) => item.count)).toEqual([
    0, 1, 0, 1, 0, 1, 0, 1, 2, 1, 0,
  ]);
  expect(result.observations![1]).toMatchObject({
    count: 1,
    connected: false,
    gain: 1,
  });
  expect(result.observations![2]).toMatchObject({ count: 0, connected: false });
  expect(result.duplicateRejected).toBe(true);
  expect(result.failureRejected).toBe(true);
  expect(result.afterFailure).toBe(0);
  expect(result.retainedCount).toBe(1);
  expect(result.retainedGain).toBe(1);
  expect(result.ownerSafe).toBe(true);
  expect(result.rendered.map((item: any) => item.target)).toEqual([
    10 ** (6 / 20),
    10 ** (6 / 20),
  ]);
  expect(result.rendered.every((item: any) => item.audioTime >= item.end)).toBe(
    true,
  );
});

test('Electron graph/API replacement retires old listeners and preserves HTML volume/mute ownership', async () => {
  const result = await compressorNative(bundle, async () => {
    const f = (window as any).EqualizerFixture;
    const contexts: AudioContext[] = [];
    const graphs: any[] = [],
      gains: GainNode[] = [];
    const timings: any[] = [];
    for (let i = 0; i < 2; i++) {
      const context = new AudioContext({
        sinkId: { type: 'none' },
      } as AudioContextOptions);
      if ((context as any).sinkId?.type !== 'none')
        throw Error('Silent sink required');
      await context.resume();
      contexts.push(context);
      const video = document.createElement('video');
      document.body.append(video);
      graphs.push(
        f.initializeAudioGraph(
          context,
          context.createMediaElementSource(video),
        ),
      );
      const create = context.createGain.bind(context);
      context.createGain = () => {
        const node = create();
        gains.push(node);
        timings.push(f.observeGainTiming(node));
        return node;
      };
    }
    const firstEvents = new EventTarget(),
      secondEvents = new EventTarget();
    let firstListeners = 0,
      secondListeners = 0;
    const api = (
      events: EventTarget,
      db: number,
      update: (change: number) => void,
    ) => ({
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'A' },
        playerConfig: { audioConfig: { loudnessDb: db } },
      }),
      addEventListener: (...args: any[]) => {
        update(1);
        (events.addEventListener as any)(...args);
      },
      removeEventListener: (...args: any[]) => {
        update(-1);
        (events.removeEventListener as any)(...args);
      },
    });
    const first = api(firstEvents, -6, (n) => (firstListeners += n)),
      second = api(secondEvents, -3, (n) => (secondListeners += n));
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: { audioGraph: graphs[0] },
      }),
    );
    await f.compressor.renderer.start({
      getConfig: () => ({
        enabled: true,
        autoTrackGain: true,
        maxTrackGainDb: 6,
      }),
    });
    f.compressor.renderer.onPlayerApiReady(first);
    const video = graphs[1].audioSource.mediaElement;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'volume',
    )!;
    let volumeWrites = 0;
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value) {
        volumeWrites++;
        descriptor.set!.call(this, value);
      },
    });
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: { audioGraph: graphs[1] },
      }),
    );
    f.compressor.renderer.onPlayerApiReady(second);
    firstEvents.dispatchEvent(new Event('videodatachange'));
    const rendered = await timings.at(-1).wait(10 ** (3 / 20));
    const gain = gains.at(-1)!.gain.value;
    const pluginWrites = volumeWrites;
    video.muted = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const muted = graphs[1].musicGate.gain.value;
    video.muted = false;
    video.volume = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const zero = graphs[1].musicGate.gain.value;
    video.volume = 0.4;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restored = graphs[1].musicGate.gain.value;
    const preserved = video.volume;
    const closedEvent = new Promise<void>((resolve) => {
      const closed = () => {
        if (contexts[1].state !== 'closed') return;
        contexts[1].removeEventListener('statechange', closed);
        resolve();
      };
      contexts[1].addEventListener('statechange', closed);
    });
    await contexts[1].close();
    await closedEvent;
    const closedListeners = secondListeners;
    f.compressor.renderer.stop();
    for (const context of contexts)
      if (context.state !== 'closed') await context.close();
    return {
      firstListeners,
      secondListeners,
      gain,
      pluginWrites,
      muted,
      zero,
      restored,
      preserved,
      closedListeners,
      rendered,
    };
  });
  expect(result.firstListeners).toBe(0);
  expect(result.secondListeners).toBe(0);
  expect(result.gain).toBeCloseTo(10 ** (3 / 20), 4);
  expect(result.pluginWrites).toBe(0);
  expect(result.muted).toBe(0);
  expect(result.zero).toBe(0);
  expect(result.restored).toBe(1);
  expect(result.preserved).toBe(0.4);
  expect(result.closedListeners).toBe(0);
  expect(result.rendered.target).toBe(10 ** (3 / 20));
  expect(result.rendered.audioTime).toBeGreaterThanOrEqual(result.rendered.end);
});
