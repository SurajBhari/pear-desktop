import { test, expect } from '@playwright/test';
import { startCrossfadeFixture } from './helpers/crossfade-native';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { createServer } from 'node:http';
import type { Page } from '@playwright/test';
import { installCrossfadeDiagnosticReporter } from './helpers/crossfade-diagnostic-reporter';

installCrossfadeDiagnosticReporter();

async function mediaFixture(page: Page, source: string, cors: boolean) {
  const main = createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url?.endsWith('.wav') ? 'audio/wav' : 'text/html',
    );
    response.end(
      request.url?.endsWith('.wav')
        ? wave(1000)
        : '<html><body><video></video></body></html>',
    );
  });
  const media = createServer((_request, response) => {
    response.setHeader('Content-Type', 'audio/wav');
    if (cors) response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(wave(500));
  });
  await Promise.all([
    new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve)),
  ]);
  const origin = `http://127.0.0.1:${(main.address() as any).port}`;
  const auxiliary = `http://127.0.0.1:${(media.address() as any).port}/aux.wav`;
  await page.goto(origin);
  await page.addScriptTag({ content: source });
  return {
    origin,
    auxiliary,
    close: async () => {
      main.closeAllConnections();
      media.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => main.close(() => resolve())),
        new Promise<void>((resolve) => media.close(() => resolve())),
      ]);
    },
  };
}

function wave(frequency = 1000) {
  const length = 48000 * 8;
  const bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++)
    bytes.writeInt16LE(
      Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * frequency * i) / 48000)),
      44 + i * 2,
    );
  return bytes;
}

async function admittedAuxiliaryCount(page: Page) {
  return page.evaluate(async () => {
    const graph = (window as any).crossfadeFixture.graph;
    const deadline = performance.now() + 5000;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const returned = graph.observeAuxiliaryMedia((count: number) => {
          if (settled || count !== 1) return;
          settled = true;
          if (performance.now() >= deadline)
            reject(new Error('Owned admission event arrived after deadline'));
          else resolve();
        });
        release = returned;
        // The public observer immediately publishes the current count.
        if (settled) {
          const owned = release;
          release = undefined;
          owned?.();
        } else {
          timer = setTimeout(
            () => reject(new Error('Owned auxiliary admission timed out')),
            Math.max(0, deadline - performance.now()),
          );
        }
      });
      // A prior event cannot satisfy ownership after its route has retired.
      return graph.auxiliaryMediaCount;
    } finally {
      clearTimeout(timer);
      const owned = release;
      release = undefined;
      owned?.();
    }
  });
}

test('actual crossfade renderer registers its outgoing media in the owned dry mix', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    diagnosticCase: 'ROUTING_REGISTER',
    startNearAdmission: true,
  });
  expect(await admittedAuxiliaryCount(page)).toBe(1);
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        requests: f.requests,
        count: f.aux.length,
        volume: f.main.volume,
      };
    }),
  ).toEqual({ requests: 1, count: 1, volume: 0.65 });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.diagnostic?.checkpoint('TERMINAL');
    f.renderer.stop();
    return f.context.close();
  });
});

export { wave };

type VolumeControl = 'REDUCE' | 'MUTE' | 'UNMUTE' | 'ZERO';

// Readiness is based only on delivered control events and rendered frames.
async function beginAudioFrameBoundary(page: Page, control?: VolumeControl) {
  return page.evaluate(async (control) => {
    const f = (window as any).crossfadeFixture;
    const context = f.context as AudioContext;
    const deadline = performance.now() + 5000;
    let origin = context.currentTime;
    if (control) {
      const main = f.main as HTMLMediaElement;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onVolume = () => {};
      try {
        origin = await new Promise<number>((resolve, reject) => {
          onVolume = () => resolve(context.currentTime);
          // Existing graph/TransitionAudio volume listeners run before this one.
          main.addEventListener('volumechange', onVolume, { once: true });
          timer = setTimeout(
            () => reject(new Error('Owned volume event timed out')),
            Math.max(0, deadline - performance.now()),
          );
          if (control === 'REDUCE') main.volume = 0.35;
          else if (control === 'MUTE') main.muted = true;
          else if (control === 'UNMUTE') main.muted = false;
          else if (control === 'ZERO') main.volume = 0;
        });
      } finally {
        main.removeEventListener('volumechange', onVolume);
        clearTimeout(timer);
      }
    }
    return {
      origin,
      deadline,
      sampleRate: context.sampleRate,
      minimumFrames: f.analyser.fftSize + 128,
    };
  }, control);
}

async function finishAudioFrameBoundary(
  page: Page,
  boundary: Awaited<ReturnType<typeof beginAudioFrameBoundary>>,
) {
  await page.evaluate(async (boundary) => {
    const context = (window as any).crossfadeFixture.context as AudioContext;
    for (let attempt = 0; attempt < 1001; attempt++) {
      if (context.state !== 'running')
        throw new Error('Owned render context is not running');
      if (performance.now() >= boundary.deadline)
        throw new Error('Owned audio frame boundary timed out');
      if (
        (context.currentTime - boundary.origin) * boundary.sampleRate >=
        boundary.minimumFrames
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Owned audio frame attempt cap reached');
  }, boundary);
}

test('deliberate main mute and volume zero silence outgoing audio during an actual fade', async ({
  page,
}) => {
  await startCrossfadeFixture(page, {
    diagnosticCase: 'ROUTING_VOLUME',
    config: {
      fadeInDuration: 2000,
      fadeOutDuration: 2000,
      secondsBeforeEnd: 2.5,
      fadeScaling: 'linear',
    },
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
      intervals: [20],
    })
    .toBe(1);
  const initial = await beginAudioFrameBoundary(page);
  await page.waitForTimeout(200);
  await finishAudioFrameBoundary(page, initial);
  const peak = (phase?: 'HEARD' | 'REDUCED') =>
    page.evaluate((phase) => {
      const f = (window as any).crossfadeFixture;
      const peak500 = f.power(500),
        peak1000 = f.power(1000);
      if (phase) f.diagnostic?.volumeSample(phase, peak500, peak1000);
      return Math.max(peak500, peak1000);
    }, phase);
  const heard = await peak('HEARD');
  expect(heard).toBeGreaterThan(0.001);
  const volume = await beginAudioFrameBoundary(page, 'REDUCE');
  await page.waitForTimeout(70);
  await finishAudioFrameBoundary(page, volume);
  const reduced = await peak('REDUCED');
  expect(reduced).toBeLessThan(heard * 0.85);
  expect(reduced).toBeGreaterThan(heard * 0.1);
  const muted = await beginAudioFrameBoundary(page, 'MUTE');
  await page.waitForTimeout(100);
  await finishAudioFrameBoundary(page, muted);
  expect(await peak()).toBeLessThan(0.000001);
  const unmuted = await beginAudioFrameBoundary(page, 'UNMUTE');
  await page.waitForTimeout(70);
  await finishAudioFrameBoundary(page, unmuted);
  expect(await peak()).toBeGreaterThan(0.001);
  expect(
    await page.evaluate(() => (window as any).crossfadeFixture.main.volume),
  ).toBe(0.35);
  const zero = await beginAudioFrameBoundary(page, 'ZERO');
  await page.waitForTimeout(100);
  await finishAudioFrameBoundary(page, zero);
  expect(await peak()).toBeLessThan(0.000001);
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.diagnostic?.checkpoint('TERMINAL');
    f.renderer.stop();
    return f.context.close();
  });
});

test('two real CORS media elements share preamp, context sink and owned disposal', async ({
  page,
}) => {
  const fixture = await mediaFixture(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {TransitionAudio} from '@/plugins/crossfade/transition-audio';",
    ),
    true,
  );
  try {
    const result = await page.evaluate(
      async ({ origin, auxiliary }) => {
        const fixture = (window as any).EqualizerFixture;
        const context = new AudioContext({ sampleRate: 48000 });
        const video = document.querySelector('video')!;
        video.src = `${origin}/main.wav`;
        let sourceCount = 0;
        const create = context.createMediaElementSource.bind(context);
        context.createMediaElementSource = (element) => {
          sourceCount++;
          return create(element);
        };
        const graph = fixture.initializeAudioGraph(
          context,
          context.createMediaElementSource(video),
        );
        let active = 0;
        const register = graph.registerMedia.bind(graph);
        graph.registerMedia = (media: HTMLMediaElement, gain?: GainNode) => {
          const detach = register(media, gain);
          active++;
          return () => {
            detach();
            active--;
          };
        };
        const audio = new fixture.TransitionAudio(auxiliary, graph);
        await audio.ready;
        audio.element.volume = 1;
        await context.resume();
        await video.play();
        await audio.play();
        const analyser = context.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0;
        const insert = graph.insertMaster.bind(graph);
        graph.insertMaster = (input: AudioNode, output: AudioNode) => {
          output.connect(analyser);
          const release = insert(input, output);
          return () => {
            output.disconnect(analyser);
            release();
          };
        };
        const config = {
          ...fixture.plugin.config,
          enabled: true,
          schemaVersion: 2,
          profile: { mode: 'custom', preamp: 0, bands: [] },
        };
        await fixture.plugin.renderer.start({
          getConfig: async () => config,
          setConfig: async () => {},
          ipc: { on() {}, removeAllListeners() {} },
        });
        const measure = () => {
          const values = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(values);
          return [500, 1000].map((hz) =>
            Math.max(
              ...values.slice(
                Math.round((hz * analyser.fftSize) / context.sampleRate) - 2,
                Math.round((hz * analyser.fftSize) / context.sampleRate) + 3,
              ),
            ),
          );
        };
        await new Promise((resolve) => setTimeout(resolve, 350));
        const before = measure();
        fixture.plugin.renderer.onConfigChange({
          ...config,
          profile: { ...config.profile, preamp: -12 },
        });
        await new Promise((resolve) => setTimeout(resolve, 450));
        const after = measure();
        let sink = 'unsupported';
        if ('setSinkId' in context) {
          await (context as any).setSinkId({ type: 'none' });
          sink = (context as any).sinkId.type;
        }
        audio.seek(0.1);
        audio.pause();
        await audio.play();
        audio.unload();
        audio.unload();
        fixture.plugin.renderer.stop();
        video.pause();
        await context.close();
        return { sourceCount, active, before, after, sink };
      },
      { origin: fixture.origin, auxiliary: fixture.auxiliary },
    );
    expect(result.sourceCount).toBe(2);
    expect(result.active).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(result.before[i]).toBeGreaterThan(-50);
      expect(result.after[i] - result.before[i]).toBeCloseTo(-12, 0);
    }
    expect(result.sink).toBe('none');
  } finally {
    await fixture.close();
  }
});

test('denied auxiliary CORS cannot silently play a dry bypass and unregisters on retirement', async ({
  page,
}) => {
  const fixture = await mediaFixture(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {TransitionAudio} from '@/plugins/crossfade/transition-audio';",
    ),
    false,
  );
  try {
    const result = await page.evaluate(async (auxiliary) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new AudioContext();
      const graph = fixture.initializeAudioGraph(
        context,
        context.createMediaElementSource(document.querySelector('video')),
      );
      let active = 0;
      const register = graph.registerMedia.bind(graph);
      graph.registerMedia = (media: HTMLMediaElement, gain?: GainNode) => {
        const detach = register(media, gain);
        active++;
        return () => {
          detach();
          active--;
        };
      };
      const audio = new fixture.TransitionAudio(auxiliary, graph);
      let rejected = false;
      try {
        await audio.ready;
      } catch {
        rejected = true;
      }
      audio.unload();
      await context.close();
      return {
        rejected,
        active,
        loaded: audio.state() === 'loaded',
        src: audio.element.getAttribute('src'),
      };
    }, fixture.auxiliary);
    expect(result).toEqual({
      rejected: true,
      active: 0,
      loaded: false,
      src: null,
    });
  } finally {
    await fixture.close();
  }
});

test('actual crossfade CORS failure preserves main volume and displays an explicit compatibility status', async ({
  page,
}) => {
  await startCrossfadeFixture(page, { denied: true });
  await expect(page.getByRole('status')).toHaveText(
    'plugins.crossfade.route-unavailable',
  );
  expect(
    await page.evaluate(() => {
      const f = (window as any).crossfadeFixture;
      return {
        volume: f.main.volume,
        aux: f.graph.auxiliaryMediaCount,
        nexts: f.nexts,
      };
    }),
  ).toEqual({ volume: 0.65, aux: 0, nexts: 0 });
  await page.evaluate(() => {
    const f = (window as any).crossfadeFixture;
    f.renderer.stop();
    return f.context.close();
  });
});
