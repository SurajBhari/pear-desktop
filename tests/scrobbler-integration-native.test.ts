import { test, expect } from '@playwright/test';
import { scrobblerIntegrationNative } from './helpers/scrobbler-integration-native';

test('real provider IPC retires an old same-ID timer before delayed metadata and preserves live elapsed', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const wait = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw Error('Missing owned native observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const make = () =>
      new f.BrowserWindow({
        show: false,
        webPreferences: {
          preload: f.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: true,
        },
      });
    const main = make(),
      foreign = make();
    await main.loadFile(f.owned + '/main.html');
    await foreign.loadFile(f.owned + '/child.html');
    const posts: any[] = [],
      delivered: any[] = [];
    let release: (() => void) | undefined;
    const png = f.nativeImage
      .createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 })
      .toPNG();
    f.net.fetch = async (url: string, options: any = {}) => {
      if (url.includes('thumbnail.fixture.invalid')) {
        if (!release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      posts.push(Object.fromEntries(new URLSearchParams(options.body)));
      return new Response('{}');
    };
    const disposeProvider = f.source.setupSongInfo(main);
    const disposeObserver = f.source.registerCallback(
      (info: any, event: string) => delivered.push({ info, event }),
      { replayCurrent: false },
    );
    let config = {
      ...f.source.defaultConfig,
      enabled: true,
      alternativeTitles: false,
      alternativeArtist: false,
      scrobblers: {
        ...f.source.defaultConfig.scrobblers,
        lastfm: {
          ...f.source.defaultConfig.scrobblers.lastfm,
          enabled: true,
          sessionKey: 'owned-session',
        },
      },
    };
    const manager = f.source.createScrobblerManager({
      window: main,
      getConfig: () => config,
      setConfig() {
        throw Error('Unexpected native account mutation');
      },
      ipc: {},
    });
    await manager.start();
    const data = (title: string, art = false) => ({
      microformat: {
        microformatDataRenderer: {
          urlCanonical: 'https://music.youtube.com/watch?v=A',
          linkAlternates: [],
          tags: [],
        },
      },
      videoDetails: {
        videoId: 'A',
        title,
        author: 'Owned Artist',
        lengthSeconds: '4',
        viewCount: '1',
        elapsedSeconds: 0,
        isPaused: false,
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        ...(art
          ? {
              thumbnail: {
                thumbnails: [
                  { url: 'https://thumbnail.fixture.invalid/held.jpg' },
                ],
              },
            }
          : {}),
      },
    });
    const send = (win: any, channel: string, value: unknown) =>
      win.webContents.executeJavaScript(
        `window.scrobbleProof.send(${JSON.stringify(channel)},${JSON.stringify(value)})`,
      );
    await send(main, 'peard:video-src-changed', data('First'));
    await wait(() => posts.length === 1);
    await send(foreign, 'peard:video-src-changed', data('Foreign'));
    const child = main.webContents.mainFrame.frames[0];
    if (!child) throw Error('Missing owned subframe');
    await child.executeJavaScript(
      `window.scrobbleProof.send('peard:video-src-changed',${JSON.stringify(data('Subframe'))})`,
    );
    await send(main, 'peard:video-src-changed', data('Held old same-ID', true));
    await wait(() => !!release);
    await send(main, 'peard:video-src-changed', data('Newest same-ID'));
    release!();
    await wait(() => posts.some((post) => post.track === 'Newest same-ID'));
    await send(main, 'peard:time-changed', 2);
    await wait(() =>
      delivered.some(
        (value) =>
          value.event === 'peard:time-changed' &&
          value.info.elapsedSeconds === 2,
      ),
    );
    await wait(() => posts.some((post) => post.method === 'track.scrobble'));
    const now = Math.trunc(Date.now() / 1000),
      submitted = posts.filter((post) => post.method === 'track.scrobble');
    manager.stop();
    disposeObserver();
    disposeProvider();
    return {
      tracks: posts.map((post) => post.track),
      submitted: submitted.map((post) => ({
        track: post.track,
        age: now - Number(post.timestamp),
      })),
      retiredCallbacks: delivered.filter((value) =>
        ['Foreign', 'Subframe', 'Held old same-ID'].includes(value.info.title),
      ).length,
    };
  });
  expect(result.tracks).toEqual(['First', 'Newest same-ID', 'Newest same-ID']);
  expect(result.submitted).toHaveLength(1);
  expect(result.submitted[0].track).toBe('Newest same-ID');
  expect(result.submitted[0].age).toBeGreaterThanOrEqual(2);
  expect(result.submitted[0].age).toBeLessThanOrEqual(3);
  expect(result.retiredCallbacks).toBe(0);
});

test('real initial navigation restores background auth with actual secure native surface before any song', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const wait = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end)
          throw Error('Missing owned auth lifecycle observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const main = new f.BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    let tokens = 0,
      releaseFirstSession: (() => void) | undefined;
    const surfaces: any[] = [],
      writes: any[] = [];
    f.app.on('browser-window-created', (_event: unknown, win: any) => {
      if (win !== main) {
        const prefs = win.webContents.getLastWebPreferences();
        surfaces.push({
          secure:
            !!prefs.contextIsolation &&
            !!prefs.sandbox &&
            !prefs.nodeIntegration &&
            win.webContents.session !== main.webContents.session,
        });
      }
    });
    f.net.fetch = async (url: string) => {
      const request = new URL(url),
        method = request.searchParams.get('method');
      if (method === 'auth.getToken') {
        tokens++;
        return new Response(JSON.stringify({ token: 'owned-token-' + tokens }));
      }
      if (method === 'auth.getSession') {
        if (request.searchParams.get('token') === 'owned-token-1')
          await new Promise<void>((resolve) => {
            releaseFirstSession = resolve;
          });
        return new Response('{"session":{"key":"owned-auth-session"}}');
      }
      throw Error('Unexpected native integration request');
    };
    let config = {
      ...f.source.defaultConfig,
      enabled: true,
      scrobblers: {
        ...f.source.defaultConfig.scrobblers,
        lastfm: {
          ...f.source.defaultConfig.scrobblers.lastfm,
          enabled: true,
          sessionKey: null,
        },
      },
    };
    const manager = f.source.createScrobblerManager({
      window: main,
      getConfig: () => config,
      setConfig: (patch: any) => {
        writes.push(patch);
        config = {
          ...config,
          scrobblers: {
            ...config.scrobblers,
            lastfm: { ...config.scrobblers.lastfm, ...patch.scrobblers.lastfm },
          },
        };
      },
      ipc: {},
    });
    await manager.start();
    await wait(() => surfaces.length === 1);
    await main.loadFile(f.owned + '/main.html');
    await wait(() => writes.length === 1);
    const live = manager.services.size;
    const secure = surfaces.every((surface) => surface.secure);
    manager.stop();
    releaseFirstSession?.();
    return { tokens, surfaces: surfaces.length, writes, live, secure };
  });
  expect(result.tokens).toBeGreaterThanOrEqual(2);
  expect(result.surfaces).toBeGreaterThanOrEqual(2);
  expect(result.writes).toEqual([
    {
      scrobblers: { lastfm: { sessionKey: 'owned-auth-session', token: null } },
    },
  ]);
  expect(result.live).toBe(1);
  expect(result.secure).toBe(true);
});

test('regex native manager cleans one shared projection across three transports without changing provider metadata', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const wait = async (check: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        if (Date.now() >= deadline)
          throw Error('Missing owned regex transport observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const main = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await main.loadFile(f.owned + '/main.html');
    const roots = {
      lastfm: 'https://lastfm.fixture.invalid/2.0/',
      librefm: 'https://librefm.fixture.invalid/2.0/',
      listenbrainz: 'https://listen.fixture.invalid/1/',
    };
    const posts: any[] = [];
    let unexpected = 0,
      musicBrainz = 0;
    f.net.fetch = async (input: string, options: any = {}) => {
      const url = String(input);
      if (new URL(url).hostname === 'musicbrainz.org') musicBrainz++;
      for (const service of ['lastfm', 'librefm'] as const) {
        if (url !== roots[service]) continue;
        const body = Object.fromEntries(new URLSearchParams(options.body));
        if (!['track.updateNowPlaying', 'track.scrobble'].includes(body.method))
          break;
        posts.push({
          service,
          kind: body.method === 'track.scrobble' ? 'scrobble' : 'now',
          title: body.track,
          artist: body.artist,
          album: body.album,
          duration: Number(body.duration),
        });
        return Response.json({});
      }
      if (url === roots.listenbrainz + 'submit-listens') {
        const body = JSON.parse(options.body) as {
          listen_type: string;
          payload: {
            track_metadata: {
              track_name: string;
              artist_name: string;
              release_name: string;
              additional_info: { duration: number };
            };
          }[];
        };
        if (
          ['playing_now', 'single'].includes(body.listen_type) &&
          body.payload.length === 1
        ) {
          const info = body.payload[0].track_metadata;
          posts.push({
            service: 'listenbrainz',
            kind: body.listen_type === 'single' ? 'scrobble' : 'now',
            title: info.track_name,
            artist: info.artist_name,
            album: info.release_name,
            duration: info.additional_info.duration,
          });
          return Response.json({});
        }
      }
      unexpected++;
      throw Error('Unexpected owned regex fixture network request');
    };
    const disposeProvider = f.source.setupSongInfo(main);
    let first: any, latest: any;
    const disposeObserver = f.source.registerCallback(
      (info: any) => {
        first ??= info;
        latest = info;
      },
      { replayCurrent: false },
    );
    const config = {
      ...f.source.defaultConfig,
      enabled: true,
      alternativeTitles: false,
      artistSource: 'primary',
      regexFiltersEnabled: true,
      customRegexFilters: ['\\s\\[OwnedSuffix\\]$'],
      useMusicBrainz: false,
      musicBrainzEmail: '',
      scrobblers: {
        lastfm: {
          ...f.source.defaultConfig.scrobblers.lastfm,
          enabled: true,
          sessionKey: 'owned-last-session',
          apiRoot: roots.lastfm,
        },
        librefm: {
          ...f.source.defaultConfig.scrobblers.librefm,
          enabled: true,
          sessionKey: 'owned-libre-session',
          apiRoot: roots.librefm,
        },
        listenbrainz: {
          ...f.source.defaultConfig.scrobblers.listenbrainz,
          enabled: true,
          token: 'owned-listen-token',
          apiRoot: roots.listenbrainz,
        },
      },
    };
    const manager = f.source.createScrobblerManager({
      window: main,
      getConfig: () => config,
      setConfig() {
        throw Error('Unexpected regex fixture account write');
      },
      ipc: {},
    });
    try {
      await manager.start();
      const data = {
        microformat: {
          microformatDataRenderer: {
            urlCanonical: 'https://music.youtube.com/watch?v=regex-owned',
            linkAlternates: [],
            tags: [],
          },
        },
        videoDetails: {
          videoId: 'regex-owned',
          title: 'Song (Live) [OwnedSuffix]',
          author: 'Artist feat. Guest',
          album: 'Owned Album',
          lengthSeconds: '4',
          elapsedSeconds: 0,
          isPaused: false,
          viewCount: '1',
          musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        },
      };
      await main.webContents.executeJavaScript(
        `window.scrobbleProof.send('peard:video-src-changed',${JSON.stringify(data)})`,
      );
      await wait(() => posts.length === 3 && !!first);
      const token = f.source.getSongInfoProvenance(first);
      await main.webContents.executeJavaScript(
        "window.scrobbleProof.send('peard:time-changed',2)",
      );
      await wait(() => posts.length === 6);
      return {
        posts,
        unexpected,
        musicBrainz,
        original: {
          title: first.title,
          artist: first.artist,
          album: first.album,
          duration: first.songDuration,
          elapsed: first.elapsedSeconds,
        },
        sameObject: first === latest,
        sameProvenance:
          !!token &&
          token === f.source.getSongInfoProvenance(first) &&
          token === f.source.getCurrentSongInfoProvenance(main),
      };
    } finally {
      manager.stop();
      disposeObserver();
      disposeProvider();
    }
  });
  expect(result.posts).toHaveLength(6);
  for (const service of ['lastfm', 'librefm', 'listenbrainz']) {
    const sent = result.posts.filter((post: any) => post.service === service);
    expect(sent.map((post: any) => post.kind)).toEqual(['now', 'scrobble']);
    for (const post of sent)
      expect(post).toMatchObject({
        title: 'Song (Live)',
        artist: 'Artist feat. Guest',
        album: 'Owned Album',
        duration: 4,
      });
  }
  expect(result.original).toEqual({
    title: 'Song (Live) [OwnedSuffix]',
    artist: 'Artist feat. Guest',
    album: 'Owned Album',
    duration: 4,
    elapsed: 2,
  });
  expect(result.sameObject).toBe(true);
  expect(result.sameProvenance).toBe(true);
  expect(result.unexpected).toBe(0);
  expect(result.musicBrainz).toBe(0);
});

test('regex native worker timeout preserves main-loop heartbeat and observes actual owned worker exit', async () => {
  const result = await scrobblerIntegrationNative(async () => {
    const f = (globalThis as any).ScrobbleIntegrationProof;
    const { Worker } = require('node:worker_threads');
    const active = new Set<any>();
    const errors: string[] = [],
      limits: any[] = [];
    let beats = 0,
      online = 0,
      ready = 0,
      completedReplies = 0,
      exits = 0;
    const filters = new f.source.RegexFilters({
      createWorker(source: string) {
        const options = {
          eval: true,
          resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
        };
        const worker = new Worker(source, options);
        limits.push({
          configured: options.resourceLimits,
          observed: {
            maxOldGenerationSizeMb:
              worker.resourceLimits.maxOldGenerationSizeMb,
            stackSizeMb: worker.resourceLimits.stackSizeMb,
          },
        });
        active.add(worker);
        worker.once('online', () => online++);
        worker.on('message', (value: any) => {
          if (value?.ready === true) ready++;
          else completedReplies++;
        });
        worker.once('error', (error: Error) => errors.push(error.name));
        worker.once('exit', () => {
          active.delete(worker);
          exits++;
        });
        return worker;
      },
    });
    const timer = setInterval(() => beats++, 5);
    const original = { title: 'a'.repeat(128) + '!', artist: 'Owned Artist' };
    try {
      const fallback = await filters.apply(['(a+)+$'], original);
      const deadline = Date.now() + 3000;
      while (active.size) {
        if (Date.now() >= deadline)
          throw Error('Owned regex worker exit was not observed');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      filters.stop();
      const stopped = await filters.apply(['a'], original);
      return {
        fallback,
        stopped,
        beats,
        online,
        ready,
        completedReplies,
        exits,
        active: active.size,
        errors,
        limits,
        parentExecArgvFlags: process.execArgv.map(
          (value) => value.split('=')[0],
        ),
        observerInExecArgv: process.execArgv.some((value) =>
          value.includes('electron-startup-observer.cjs'),
        ),
        playwrightLoaderInExecArgv: process.execArgv.some((value) =>
          value.replaceAll('\\', '/').endsWith('/server/electron/loader.js'),
        ),
      };
    } finally {
      clearInterval(timer);
      filters.stop();
    }
  });
  console.log(
    'OWNED_REGEX_WORKER ' +
      JSON.stringify({
        parentExecArgvFlags: result.parentExecArgvFlags,
        observerInExecArgv: result.observerInExecArgv,
        playwrightLoaderInExecArgv: result.playwrightLoaderInExecArgv,
        online: result.online,
        ready: result.ready,
        completedReplies: result.completedReplies,
        exits: result.exits,
        errors: result.errors,
        limits: result.limits,
      }),
  );
  expect(result.fallback).toEqual({
    title: 'a'.repeat(128) + '!',
    artist: 'Owned Artist',
  });
  expect(result.stopped).toEqual(result.fallback);
  expect(result.beats).toBeGreaterThan(3);
  expect(result.online).toBe(1);
  expect(result.ready).toBe(1);
  expect(result.completedReplies).toBe(0);
  expect(result.exits).toBe(1);
  expect(result.active).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.limits).toEqual([
    {
      configured: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
      observed: { maxOldGenerationSizeMb: 16, stackSizeMb: 2 },
    },
  ]);
  expect(result.observerInExecArgv).toBe(false);
  expect(result.playwrightLoaderInExecArgv).toBe(false);
});
