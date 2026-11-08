/** Owned Chromium/WebAudio/local-WAV fixture, NOT production native or YouTube proof. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { equalizerBundle, fixturePage } from './equalizer-bundle';
import type { Page } from '@playwright/test';
import type { DiagnosticCase } from './crossfade-diagnostics';
export function timeCodedWave(outgoing = true, amplitude = 0.1) {
  const rate = 48000,
    seconds = 6,
    n = rate * seconds,
    bytes = Buffer.alloc(44 + n * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const frequency = outgoing ? (i / rate < 2 ? 750 : 500) : 1000;
    bytes.writeInt16LE(
      Math.round(
        amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / rate),
      ),
      44 + i * 2,
    );
  }
  return bytes;
}
export async function crossfadeSourceBundle(baseline = false, extra = '') {
  let directory: string | undefined;
  try {
    let entry = '@/plugins/crossfade';
    if (baseline) {
      directory = await mkdtemp(path.join(tmpdir(), 'pear-crossfade-m87-'));
      for (const name of ['index.ts', 'fader.ts', 'transition-audio.ts'])
        await writeFile(
          path.join(directory, name),
          execFileSync(
            'git',
            [
              'show',
              `2ba8827d8134ad9593d3c5c34bd0ee945078fa6b:src/plugins/crossfade/${name}`,
            ],
            { cwd: path.resolve(import.meta.dirname, '../..') },
          ),
        );
      entry = path.join(directory, 'index.ts');
    }
    return await equalizerBundle(
      `export {default as crossfade} from ${JSON.stringify(entry)};export * from '@/providers/renderer-audio';export * from '@/providers/playback-owner';export * from '@/plugins/crossfade/native-state';export * from '@/plugins/utils/renderer/playback-rate-owner';${extra}`,
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export async function startCrossfadeFixture(
  page: Page,
  options: {
    baseline?: boolean;
    requestDelay?: boolean;
    config?: Record<string, unknown>;
    denied?: boolean;
    manualDuringNext?: boolean;
    duplicateEpisodeDuringNext?: boolean;
    delayBMs?: number;
    delayAuxLoadMs?: number;
    holdAuxPlay?: boolean;
    sourceExports?: string;
    diagnosticCase?: DiagnosticCase;
    startNearAdmission?: boolean;
    waveAmplitude?: number;
    mainVolume?: number;
    beforeArmExport?: string;
    setupOptions?: Record<string, unknown>;
  } = {},
) {
  await page.addInitScript(() => {
    (window as any).ipcRenderer = { on: () => {}, send: () => {} };
  });
  await page.route('https://media.eq.fixture.invalid/**', async (route) => {
    if (options.delayAuxLoadMs && route.request().url().includes('/aux-a.wav'))
      await new Promise((r) => setTimeout(r, options.delayAuxLoadMs));
    if (options.denied && route.request().url().includes('/aux-a.wav'))
      return route.abort();
    const body = timeCodedWave(
      !route.request().url().endsWith('b.wav'),
      options.waveAmplitude ?? 0.1,
    );
    const range = route
      .request()
      .headers()
      ['range']?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0,
      end =
        range && range[2]
          ? Math.min(Number(range[2]), body.length - 1)
          : body.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range
          ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` }
          : {}),
      },
      body: body.subarray(start, end + 1),
    });
  });
  await fixturePage(
    page,
    await crossfadeSourceBundle(
      options.baseline,
      (options.sourceExports ?? '') +
        (options.diagnosticCase
          ? `export {createCrossfadeDiagnostic} from ${JSON.stringify(path.join(import.meta.dirname, 'crossfade-diagnostics.ts'))};`
          : ''),
    ),
  );
  await page.evaluate(async (options) => {
    const f = (window as any).EqualizerFixture,
      main = document.querySelector('video')!;
    const api = document.createElement('div');
    api.id = 'movie_player';
    main.replaceWith(api);
    api.append(main);
    const queue = document.createElement('div');
    queue.id = 'queue';
    document.body.append(queue);
    const bar = document.createElement('ytmusic-player-bar');
    document.body.append(bar);
    const next = document.createElement('button');
    next.className = 'next-button';
    document.body.append(next);
    let index = 0,
      revision = 0,
      requests = 0,
      nexts = 0;
    const ids = ['AAAAAAAAAAA', 'BBBBBBBBBBB'];
    const items = () =>
      ids.map((videoId, i) => ({
        playlistPanelVideoRenderer: { videoId, selected: i === index },
      }));
    const state = () => ({
      queue: {
        items: items(),
        selectedItemIndex: index,
        repeatMode: 'NONE',
        shuffleEnabled: false,
        queueContextParams: 'fixture-owned',
      },
      castStatus: {
        remoteWatchEndpoint: null,
        castConnectionData: { castConnectionState: 'DISCONNECTED' },
      },
    });
    (queue as any).queue = {
      getItems: items,
      store: { store: { getState: state } },
    };
    (bar as any).getState = state;
    (window as any).blockerSceneGuard = { userRevision: () => revision };
    (window as any).mainConfig = {
      get: (key: string) => (key === 'plugins' ? {} : false),
    };
    Object.assign(api, {
      getVideoData: () => ({
        video_id: ids[index],
        isLive: false,
        isPremiere: false,
      }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: ids[index], isLiveContent: false },
      }),
      getPlayerState: () => (main.paused ? 2 : 1),
      getPlaybackRate: () => main.playbackRate,
      getCurrentTime: () => main.currentTime,
      getPlaylistIndex: () => index,
      nextVideo: () => {
        nexts++;
        index = 1;
        if (options.manualDuringNext) revision++;
        api.dispatchEvent(new Event('videodatachange'));
        if (options.duplicateEpisodeDuringNext)
          api.dispatchEvent(new Event('videodatachange'));
        history.replaceState(null, '', `/watch?v=${ids[index]}`);
        const loadB = () => {
          main.src = 'https://media.eq.fixture.invalid/b.wav';
          main.load();
          void main.play();
        };
        if (options.delayBMs) setTimeout(loadB, options.delayBMs);
        else loadB();
      },
    });
    next.onclick = () => {
      (api as any).nextVideo();
    };
    const context = new AudioContext({ sinkId: { type: 'none' } } as any),
      graph = f.initializeAudioGraph(
        context,
        context.createMediaElementSource(main),
      );
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    graph.musicGate.connect(analyser);
    let releasePlay = () => {};
    let playPending = false;
    const aux: HTMLMediaElement[] = [];
    const register = graph.registerMedia.bind(graph);
    graph.registerMedia = (...args: any[]) => {
      aux.push(args[0]);
      if (options.holdAuxPlay) {
        const element = args[0] as HTMLMediaElement,
          play = element.play.bind(element);
        element.play = () =>
          play().then(() => {
            playPending = true;
            return new Promise<void>((resolve) => (releasePlay = resolve));
          });
      }
      return register(...args);
    };
    const events: { name: string; time: number; wall: number }[] = [];
    for (const name of [
      'play',
      'pause',
      'seeking',
      'seeked',
      'emptied',
      'loadstart',
      'loadedmetadata',
      'playing',
    ])
      main.addEventListener(name, () =>
        events.push({ name, time: main.currentTime, wall: performance.now() }),
      );
    // The existing aux array supplies a count only. No element is inferred by index.
    let diagnostic: any = null;
    if (options.diagnosticCase) {
      try {
        diagnostic = f.createCrossfadeDiagnostic(options.diagnosticCase, {
          main,
          context,
          analyser,
          graph,
          requests: () => requests,
          registered: () => aux.length,
        });
      } catch {
        /* Diagnostics cannot change the fixture's original assertions. */
      }
    }
    await context.resume();
    main.crossOrigin = 'anonymous';
    main.volume = options.mainVolume ?? 0.65;
    if (options.beforeArmExport)
      await f[options.beforeArmExport](
        { main, graph, context, analyser, aux },
        options.setupOptions ?? {},
      );
    main.src = 'https://media.eq.fixture.invalid/a.wav';
    await main.play();
    main.currentTime = options.startNearAdmission ? 4.4 : 3.1;
    await new Promise<void>((r) =>
      main.addEventListener('seeked', () => r(), { once: true }),
    );
    f.adoptPlaybackOwner(api); // Explicit fixture metadata owner setup, never production crossfade adoption.
    let resolve: ((value: unknown) => void) | undefined;
    const stream = {
      url: 'https://media.eq.fixture.invalid/aux-a.wav',
      mimeType: 'audio/wav',
      contentLength: 576044,
    };
    history.replaceState(null, '', `/watch?v=${ids[0]}`);
    const renderer = f.crossfade.renderer;
    await renderer.start({
      getConfig: async () => ({
        ...f.crossfade.config,
        enabled: true,
        fadeInDuration: 1000,
        fadeOutDuration: 1000,
        secondsBeforeEnd: 1.5,
        ...options.config,
      }),
      ipc: {
        invoke: () => {
          requests++;
          return options.requestDelay
            ? new Promise((r) => (resolve = r))
            : Promise.resolve(options.baseline ? stream.url : stream);
        },
        subscribe: (_name: string, handler: (...args: unknown[]) => void) => {
          (window as any).speed = handler;
          return () => {};
        },
      },
    });
    renderer.onPlayerApiReady(api);
    window.navigation.dispatchEvent(
      Object.assign(new Event('navigate'), {
        destination: { url: `https://eq.fixture.invalid/watch?v=${ids[0]}` },
      }),
    );
    main.dispatchEvent(new Event('timeupdate'));
    const power = (frequency: number) => {
      const data = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(data);
      const bin = Math.round(
        (frequency * analyser.fftSize) / context.sampleRate,
      );
      return 10 ** (Math.max(...data.slice(bin - 2, bin + 3)) / 20);
    };
    (window as any).crossfadeFixture = {
      main,
      api,
      graph,
      context,
      analyser,
      aux,
      events,
      renderer,
      power,
      diagnostic,
      get requests() {
        return requests;
      },
      get nexts() {
        return nexts;
      },
      get revision() {
        return revision;
      },
      setConfig: (config: Record<string, unknown>) =>
        renderer.onConfigChange({
          ...f.crossfade.config,
          enabled: true,
          ...config,
        }),
      manual: () => {
        revision++;
        main.dispatchEvent(new Event('timeupdate'));
      },
      resolve: () => resolve?.(options.baseline ? stream.url : stream),
      releasePlay: () => releasePlay(),
      get playPending() {
        return playPending;
      },
      state: () => f.readNativeCrossfadeState(api, main, graph),
    };
    diagnostic?.checkpoint('FIXTURE_READY');
  }, options);
}
