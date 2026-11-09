import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

// Real media decoding and a real MediaElementAudioSourceNode establish which side
// of the Web Audio graph owns HTMLMediaElement.volume (no gain-node simulation).
test('native media source already contains media volume and mute', async ({
  page,
}) => {
  await fixturePage(page, 'void 0;');
  const result = await page.evaluate(async () => {
    const rate = 48000;
    const wav = new ArrayBuffer(44 + rate * 2);
    const view = new DataView(wav);
    const text = (at: number, value: string) =>
      [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, wav.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, rate * 2, true);
    for (let i = 0; i < rate; i++)
      view.setInt16(
        44 + i * 2,
        Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / rate)),
        true,
      );
    const media = new Audio(
      URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })),
    );
    media.loop = true;
    const context = new AudioContext({ sampleRate: rate });
    const source = context.createMediaElementSource(media);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(analyser);
    analyser.connect(silence);
    silence.connect(context.destination);
    await context.resume();
    await media.play();
    const read = async (volume: number, muted = false) => {
      media.volume = volume;
      media.muted = muted;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.sqrt(
        values.reduce((sum, x) => sum + x * x, 0) / values.length,
      );
    };
    const full = await read(1),
      quarter = await read(0.25),
      zero = await read(0),
      muted = await read(1, true);
    media.pause();
    URL.revokeObjectURL(media.src);
    await context.close();
    return { full, quarter, zero, muted };
  });
  expect(result.full).toBeCloseTo(0.5 / Math.sqrt(2), 2);
  expect(result.quarter / result.full).toBeCloseTo(0.25, 2);
  expect(result.zero).toBe(0);
  expect(result.muted).toBe(0);
});

test('auto uses existing media headroom and synchronously protects every fading chain on volume increases', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const media = document.createElement('audio');
    media.volume = 0.1;
    let aux = 0,
      observer: ((count: number) => void) | null = null,
      notices = 0;
    const graph = {
      audioContext: context,
      audioSource: { mediaElement: media },
      insertMaster: () => () => {},
      get auxiliaryMediaCount() {
        return aux;
      },
      observeAuxiliaryMedia(callback: (count: number) => void) {
        observer = callback;
        callback(aux);
        return () => {
          observer = null;
        };
      },
    };
    const controller = new EqualizerController(graph, () => notices++);
    const profile = (gain: number) => ({
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain, Q: 1 }],
    });
    controller.apply(profile(12), false, true);
    const low = controller.getResponse().effectivePreampDb;
    controller.apply(profile(18), false, true);
    const lowAgain = controller.getResponse().effectivePreampDb;
    const old = [...controller.chains];
    const writes = new Map<any, { gain: number; time: number }>();
    const observe = (chain: any) => {
      const set = chain.preamp.gain.setValueAtTime.bind(chain.preamp.gain);
      chain.preamp.gain.setValueAtTime = (gain: number, time: number) => {
        writes.set(chain, { gain, time });
        return set(gain, time);
      };
    };
    old.forEach(observe);
    media.volume = 1;
    media.dispatchEvent(new Event('volumechange'));
    const high = controller.getResponse().effectivePreampDb;
    const protectedImmediately = old.map((chain: any) => ({
      peak: chain.bands[0].gain,
      gain: writes.get(chain)?.gain ?? Infinity,
      time: writes.get(chain)?.time,
    }));
    const changes = (volume: number, muted = false) => {
      media.volume = volume;
      media.muted = muted;
      media.dispatchEvent(new Event('volumechange'));
      return controller.getResponse().effectivePreampDb;
    };
    const quarter = changes(0.25),
      zero = changes(0),
      muted = changes(1, true);
    changes(0.1);
    [...controller.chains]
      .filter((chain: any) => !old.includes(chain))
      .forEach(observe);
    aux = 1;
    observer?.(aux);
    const auxiliary = controller.getResponse().effectivePreampDb;
    const auxProtected = [...controller.chains].every(
      (chain: any) =>
        (writes.get(chain)?.gain ?? Infinity) <=
        10 ** ((-chain.bands[0].gain - 0.09) / 20),
    );
    aux = 0;
    observer?.(aux);
    const restored = controller.getResponse().effectivePreampDb;
    controller.stop();
    const beforeStopEvent = notices;
    media.volume = 1;
    media.dispatchEvent(new Event('volumechange'));
    return {
      low,
      lowAgain,
      high,
      protectedImmediately,
      quarter,
      zero,
      muted,
      auxiliary,
      auxProtected,
      restored,
      stopped: observer === null,
      notices,
      beforeStopEvent,
    };
  });
  expect(result.low).toBe(0);
  expect(result.lowAgain).toBe(0);
  expect(result.high).toBeCloseTo(-18.1, 1);
  for (const old of result.protectedImmediately) {
    expect(20 * Math.log10(old.gain) + old.peak).toBeLessThanOrEqual(-0.09);
    expect(old.time).toBe(0);
  }
  expect(result.quarter).toBeCloseTo(-18 - 20 * Math.log10(0.25) - 0.1, 1);
  expect(result.zero).toBe(0);
  expect(result.muted).toBe(0);
  expect(result.auxiliary).toBeCloseTo(-18.1, 1);
  expect(result.auxProtected).toBe(true);
  expect(result.restored).toBe(0);
  expect(result.stopped).toBe(true);
  expect(result.notices).toBeGreaterThan(0);
  expect(result.notices).toBe(result.beforeStopEvent);
});

for (const oldAutomatic of [true, false])
  test(`native rendered volume increase protects a fading ${oldAutomatic ? 'automatic' : 'manual'} chain`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle(
        "export {EqualizerController} from '@/plugins/equalizer/controller';",
      ),
    );
    const result = await page.evaluate(async (oldAutomatic) => {
      const { EqualizerController } = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, 14400, 48000);
      const tone = context.createOscillator();
      tone.frequency.value = 1000;
      const amplitude = context.createGain();
      amplitude.gain.value = 0.9;
      // The decoding test above proves the native media-volume relationship.
      // Offline gain gives this fixture sample-exact control of the same input step.
      const volume = context.createGain();
      volume.gain.value = 0.1;
      tone.connect(amplitude);
      amplitude.connect(volume);
      const media = document.createElement('audio');
      media.volume = 0.1;
      const controller = new EqualizerController({
        audioContext: context,
        audioSource: { mediaElement: media },
        insertMaster(input: AudioNode, output: AudioNode) {
          volume.connect(input);
          output.connect(context.destination);
          return () => {
            volume.disconnect(input);
            output.disconnect();
          };
        },
      });
      const profile = (gain: number) => ({
        mode: 'custom',
        preamp: 0,
        bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain, Q: 1 }],
      });
      controller.apply(profile(12), false, oldAutomatic);
      tone.start();
      const paused = context.suspend(0.1);
      const rendering = context.startRendering();
      await paused;
      controller.apply(profile(18), false, true);
      const old = [...controller.chains].find(
        (chain: any) => chain.bands[0].gain === 12,
      );
      const audibleBefore = controller.levelAt(old, context.currentTime);
      volume.gain.setValueAtTime(1, context.currentTime);
      media.volume = 1;
      media.dispatchEvent(new Event('volumechange'));
      const at = context.currentTime;
      await context.resume();
      const rendered = await rendering;
      const samples = rendered.getChannelData(0);
      let maximum = 0;
      for (const sample of samples.slice(
        Math.ceil(at * 48000),
        Math.ceil((at + 0.02) * 48000),
      ))
        maximum = Math.max(maximum, Math.abs(sample));
      const tail = samples.slice(9600, 12000);
      const rms = Math.sqrt(
        tail.reduce((sum, x) => sum + x * x, 0) / tail.length,
      );
      controller.stop();
      return { audibleBefore, maximum, rms };
    }, oldAutomatic);
    expect(result.audibleBefore).toBe(1);
    expect(result.maximum).toBeLessThan(0.96);
    expect(result.rms).toBeGreaterThan(0.5);
    expect(result.rms).toBeLessThan(0.65);
  });

test('renderer response follows volume and auxiliary changes and graph replacement releases its subscriptions', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';", true),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const makeGraph = (volume: number) => {
      const context = new AudioContext();
      const media = document.createElement('audio');
      media.volume = volume;
      let listeners = 0,
        observers = 0;
      const add = media.addEventListener.bind(media),
        remove = media.removeEventListener.bind(media);
      media.addEventListener = ((name: string, ...args: any[]) => {
        if (name === 'volumechange') listeners++;
        return (add as any)(name, ...args);
      }) as any;
      media.removeEventListener = ((name: string, ...args: any[]) => {
        if (name === 'volumechange') listeners--;
        return (remove as any)(name, ...args);
      }) as any;
      const source = context.createMediaElementSource(media);
      const graph = fixture.initializeAudioGraph(context, source);
      const observe = graph.observeAuxiliaryMedia.bind(graph);
      graph.observeAuxiliaryMedia = (callback: (count: number) => void) => {
        observers++;
        const release = observe(callback);
        return () => {
          observers--;
          release();
        };
      };
      return {
        context,
        media,
        source,
        graph,
        counts: () => [listeners, observers],
      };
    };
    const first = makeGraph(0.1);
    await fixture.plugin.renderer.start({
      getConfig: async () => ({
        ...fixture.plugin.config,
        enabled: true,
        schemaVersion: 3,
        autoPreamp: true,
        profile: {
          mode: 'custom',
          preamp: 0,
          bands: [
            { id: 'a', type: 'peaking', frequency: 1000, gain: 12, Q: 1 },
          ],
        },
      }),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
    const read = () =>
      document.querySelector('.eq-response output')?.textContent;
    const low = read(),
      firstLive = first.counts();
    first.media.volume = 1;
    first.media.dispatchEvent(new Event('volumechange'));
    const high = read();
    const second = makeGraph(0.1);
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: second.context,
          audioSource: second.source,
          audioGraph: second.graph,
        },
      }),
    );
    const replaced = read(),
      firstRetired = first.counts();
    first.media.volume = 0.25;
    first.media.dispatchEvent(new Event('volumechange'));
    const staleIgnored = read();
    const releaseAux = second.graph.registerMedia(
      document.createElement('audio'),
    );
    const auxiliary = read();
    releaseAux();
    const restored = read();
    fixture.plugin.renderer.stop();
    const secondRetired = second.counts();
    await first.context.close();
    await second.context.close();
    return {
      low,
      high,
      replaced,
      staleIgnored,
      auxiliary,
      restored,
      firstLive,
      firstRetired,
      secondRetired,
    };
  });
  expect(result.low).toContain('0.0');
  expect(result.high).toContain('-12.1');
  expect(result.replaced).toContain('0.0');
  expect(result.staleIgnored).toBe(result.replaced);
  expect(result.auxiliary).toContain('-12.1');
  expect(result.restored).toContain('0.0');
  expect(result.firstLive).toEqual([2, 1]);
  expect(result.firstRetired).toEqual([1, 0]);
  expect(result.secondRetired).toEqual([1, 0]);
});

test('unknown media falls back conservatively and invalid oversized profiles survive volume refresh unchanged', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {EqualizerController} from '@/plugins/equalizer/controller'; export {MAX_BANDS} from '@/plugins/equalizer/config';",
    ),
  );
  const result = await page.evaluate(() => {
    const { EqualizerController, MAX_BANDS } = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const media = document.createElement('audio');
    media.volume = 0.1;
    const controller = new EqualizerController({
      audioContext: context,
      audioSource: { mediaElement: media },
      insertMaster: () => () => {},
    });
    const profile = {
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain: 12, Q: 1 }],
    };
    controller.apply(profile, false, true);
    const before = controller.getResponse();
    let rejected = 0;
    for (const invalid of [
      {
        ...profile,
        bands: Array.from({ length: MAX_BANDS + 1 }, (_, i) => ({
          ...profile.bands[0],
          id: String(i),
        })),
      },
      {
        ...profile,
        bands: Array.from({ length: MAX_BANDS }, (_, i) => ({
          ...profile.bands[0],
          id: String(i),
          gain: 48,
        })),
      },
      { ...profile, preamp: NaN },
    ]) {
      try {
        controller.apply(invalid, false, true);
      } catch {
        rejected++;
      }
    }
    const retained = before === controller.getResponse();
    media.volume = 1;
    media.dispatchEvent(new Event('volumechange'));
    const refreshed = controller.getResponse();
    Object.defineProperty(media, 'volume', { value: NaN });
    media.dispatchEvent(new Event('volumechange'));
    const unknown = controller.getResponse();
    controller.stop();
    return {
      rejected,
      retained,
      before: before.effectivePreampDb,
      after: refreshed.effectivePreampDb,
      unknown: unknown.effectivePreampDb,
      finite: unknown.gainsDb.every(Number.isFinite),
      original: profile.bands.length,
    };
  });
  expect(result.rejected).toBe(3);
  expect(result.retained).toBe(true);
  expect(result.before).toBe(0);
  expect(result.after).toBeCloseTo(-12.1, 1);
  expect(result.unknown).toBeCloseTo(-12.1, 1);
  expect(result.finite).toBe(true);
  expect(result.original).toBe(1);
});
