import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { createServer } from 'node:http';
import type { Page } from '@playwright/test';

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

test('actual crossfade renderer registers its outgoing media in the owned dry mix', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {default as crossfade} from '@/plugins/crossfade';",
    ),
  );
  await page.route('https://media.eq.fixture.invalid/**', (route) =>
    route.fulfill({
      contentType: 'audio/wav',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: wave(),
    }),
  );
  await page.evaluate(async () => {
    history.replaceState(null, '', '/watch?v=A');
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    const graph = fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    (window as any).registrations = 0;
    const register = graph.registerMedia.bind(graph);
    graph.registerMedia = (element: HTMLMediaElement, gain?: GainNode) => {
      (window as any).registrations++;
      return register(element, gain);
    };
    await fixture.crossfade.renderer.start({
      getConfig: async () => fixture.crossfade.config,
      ipc: { invoke: async () => 'https://media.eq.fixture.invalid/tone.wav' },
    });
    fixture.crossfade.renderer.onPlayerApiReady();
    window.navigation.dispatchEvent(
      Object.assign(new Event('navigate'), {
        destination: { url: 'https://eq.fixture.invalid/watch?v=B' },
      }),
    );
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).registrations), {
      timeout: 2000,
    })
    .toBe(1);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.crossfade.renderer.stop(),
  );
});

export { wave };

test('deliberate main mute and volume zero silence outgoing audio during an actual fade', async ({
  page,
}) => {
  const fixture = await mediaFixture(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {default as crossfade} from '@/plugins/crossfade';",
    ),
    true,
  );
  try {
    await page.evaluate(
      async ({ origin, auxiliary }) => {
        history.replaceState(null, '', '/watch?v=A');
        const fixture = (window as any).EqualizerFixture;
        const context = new AudioContext();
        const video = document.querySelector('video')!;
        video.src = `${origin}/main.wav`;
        video.volume = 0.7;
        const graph = fixture.initializeAudioGraph(
          context,
          context.createMediaElementSource(video),
        );
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        const insert = graph.insertMaster.bind(graph);
        const output = context.createGain();
        insert(output, output);
        output.connect(analyser);
        const peak = () => {
          const data = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(data);
          return Math.max(...data.map(Math.abs));
        };
        (window as any).fadeProbe = { context, peak, video };
        const register = graph.registerMedia.bind(graph);
        graph.registerMedia = (media: HTMLMediaElement, gain?: GainNode) => {
          (window as any).auxMedia = media;
          return register(media, gain);
        };
        await context.resume();
        await video.play();
        await fixture.crossfade.renderer.start({
          getConfig: async () => ({
            ...fixture.crossfade.config,
            fadeOutDuration: 1500,
          }),
          ipc: { invoke: async () => auxiliary },
        });
        fixture.crossfade.renderer.onPlayerApiReady();
        window.navigation.dispatchEvent(
          Object.assign(new Event('navigate'), {
            destination: { url: `${origin}/watch?v=B` },
          }),
        );
      },
      { origin: fixture.origin, auxiliary: fixture.auxiliary },
    );
    await page.waitForTimeout(250);
    // replaceState itself emits the native Navigation event; do not dispatch it twice.
    await page.evaluate(() => history.replaceState(null, '', '/watch?v=B'));
    await page.waitForTimeout(100);
    const heard = await page.evaluate(() => (window as any).fadeProbe.peak());
    expect(heard).toBeGreaterThan(0.001);
    await page.evaluate(() => (document.querySelector('video')!.volume = 0.35));
    await page.waitForTimeout(100);
    const reduced = await page.evaluate(() => (window as any).fadeProbe.peak());
    expect(reduced).toBeLessThan(heard * 0.75);
    expect(reduced).toBeGreaterThan(heard * 0.1);
    await page.evaluate(() => (document.querySelector('video')!.muted = true));
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => (window as any).fadeProbe.peak()),
    ).toBeLessThan(0.000001);
    await page.evaluate(() => (document.querySelector('video')!.muted = false));
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => (window as any).fadeProbe.peak()),
    ).toBeGreaterThan(0.001);
    expect(
      await page.evaluate(() => document.querySelector('video')!.volume),
    ).toBe(0.35);
    await page.evaluate(() => (document.querySelector('video')!.volume = 0));
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => (window as any).fadeProbe.peak()),
    ).toBeLessThan(0.000001);
    await page.evaluate(async () => {
      (window as any).EqualizerFixture.crossfade.renderer.stop();
      await (window as any).fadeProbe.context.close();
    });
    expect(
      await page.evaluate(() => ({
        volume: document.querySelector('video')!.volume,
        muted: document.querySelector('video')!.muted,
      })),
    ).toEqual({ volume: 0, muted: false });
  } finally {
    await fixture.close();
  }
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
  const fixture = await mediaFixture(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {default as crossfade} from '@/plugins/crossfade';",
    ),
    false,
  );
  try {
    await page.evaluate(
      async ({ origin, auxiliary }) => {
        history.replaceState(null, '', '/watch?v=A');
        const fixture = (window as any).EqualizerFixture;
        const context = new AudioContext();
        const video = document.querySelector('video')!;
        video.volume = 0.73;
        const graph = fixture.initializeAudioGraph(
          context,
          context.createMediaElementSource(video),
        );
        (window as any).activeAux = 0;
        const register = graph.registerMedia.bind(graph);
        graph.registerMedia = (media: HTMLMediaElement, gain?: GainNode) => {
          const detach = register(media, gain);
          (window as any).activeAux++;
          return () => {
            detach();
            (window as any).activeAux--;
          };
        };
        await fixture.crossfade.renderer.start({
          getConfig: async () => fixture.crossfade.config,
          ipc: { invoke: async () => auxiliary },
        });
        fixture.crossfade.renderer.onPlayerApiReady();
        window.navigation.dispatchEvent(
          Object.assign(new Event('navigate'), {
            destination: { url: `${origin}/watch?v=B` },
          }),
        );
      },
      { origin: fixture.origin, auxiliary: fixture.auxiliary },
    );
    await expect(page.getByRole('status')).toHaveText(
      'plugins.crossfade.route-unavailable',
    );
    expect(
      await page.evaluate(() => ({
        volume: document.querySelector('video')!.volume,
        active: (window as any).activeAux,
      })),
    ).toEqual({ volume: 0.73, active: 0 });
    await page.evaluate(() =>
      (window as any).EqualizerFixture.crossfade.renderer.stop(),
    );
    await expect(page.getByRole('status')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
