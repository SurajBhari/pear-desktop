import { EventEmitter } from 'node:events';
import { deepmergeCustom } from 'deepmerge-ts';
import { test, expect } from '@playwright/test';
import { scrobblerBundle } from './helpers/scrobbler-integration-bundle';
import { discordArtworkFixture } from './helpers/discord-artist-artwork';

const merge = deepmergeCustom({ mergeArrays: false });
const deferred = () => {
  let resolve!: (value?: any) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
};
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
export async function fixture() {
  const ipcMain = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send() {},
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  const calls: any[] = [],
    writes: any[] = [],
    surfaces: any[] = [],
    callbacks = new Set<any>(),
    timers = new Set<any>();
  const boundary: any = {
    ipcMain,
    BrowserWindow: class {},
    provenance: new WeakMap(),
    currentProvenance: null,
    fetcher: async (url: string, options: any) => {
      calls.push({ url, options });
      const method = new URL(url).searchParams.get('method');
      return new Response(
        method === 'auth.getToken'
          ? '{"token":"dummy-token"}'
          : method === 'auth.getSession'
            ? '{"session":{"key":"dummy-session"}}'
            : '{}',
      );
    },
    openSurface(url: string, signal: AbortSignal) {
      const closed = deferred();
      const s = {
        url,
        signal,
        ready: Promise.resolve(),
        closed: closed.promise,
        close() {
          closed.resolve();
        },
      };
      surfaces.push(s);
      return s;
    },
    registerCallback(callback: any) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    setTimeout(fn: any, delay: number, ...args: any[]) {
      const timer = { fn, delay, args };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: any) {
      timers.delete(timer);
    },
    prompt: async () => null,
  };
  const module = await scrobblerBundle(boundary);
  let config: any = merge({}, module.defaultConfig, {
    enabled: true,
    scrobblers: {
      lastfm: {
        enabled: true,
        apiKey: 'dummy-key',
        secret: 'dummy-secret',
        sessionKey: null,
      },
      listenbrainz: { enabled: false },
      librefm: { enabled: false },
    },
  });
  let current = true;
  const runtime: any = {
    window,
    readConfig: () => config,
    isCurrent: () => current,
    writeConfig: async (patch: any, guard: any) => {
      if (guard && !guard()) return false;
      writes.push(patch);
      config = merge(config, patch);
      return true;
    },
  };
  const dependencies: any = {
    fetcher: (...args: any[]) => boundary.fetcher(...args),
    openAuthSurface: (...args: any[]) => boundary.openSurface(...args),
    authTiming: { pollMs: 1, deadlineMs: 1000 },
  };
  return {
    module,
    boundary,
    window,
    contents,
    calls,
    writes,
    surfaces,
    callbacks,
    timers,
    runtime,
    dependencies,
    get config() {
      return config;
    },
    set config(value: any) {
      config = value;
    },
    setCurrent(value: boolean) {
      current = value;
    },
    flush,
    deferred,
    context: {
      window,
      getConfig: () => config,
      setConfig: async (patch: any) => {
        writes.push(patch);
        config = merge(config, patch);
      },
      ipc: { on() {}, send() {} },
    },
  };
}

test('Libre defaults are disabled public HTTPS app credentials with nullable clears', async () => {
  const f = await fixture();
  expect(f.module.defaultConfig.scrobblers.librefm).toMatchObject({
    enabled: false,
    apiRoot: 'https://libre.fm/2.0/',
    apiKey: 'ba02767a32bf0d4c5e048fab86065fe4',
    secret: 'baa68bbef1bc6a5f4514dc76b48bc0d5',
    sessionKey: null,
  });
  expect(
    merge({ sessionKey: 'old' }, { sessionKey: undefined }).sessionKey,
  ).toBe('old');
  expect(merge({ sessionKey: 'old' }, { sessionKey: null }).sessionKey).toBe(
    null,
  );
});
test('LastFM duplicate login shares actual core promise and writes only owned success leaves', async () => {
  const f = await fixture();
  expect(typeof f.module.createLastFmService).toBe('function');
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  const gate = deferred();
  f.boundary.fetcher = async (url: string, options: any) => {
    f.calls.push({ url, options });
    if (new URL(url).searchParams.get('method') === 'auth.getToken')
      return new Response('{"token":"dummy-token"}');
    await gate.promise;
    return new Response('{"session":{"key":"dummy-session"}}');
  };
  const first = service.createSession(),
    second = service.createSession();
  expect(second).toBe(first);
  await flush();
  expect(f.surfaces).toHaveLength(1);
  expect(f.writes).toEqual([]);
  gate.resolve();
  expect(await first).toBe(true);
  expect(f.writes).toEqual([
    { scrobblers: { lastfm: { sessionKey: 'dummy-session', token: null } } },
  ]);
  service.stop();
});
test('failed or canceled forced login preserves an existing session', async () => {
  const f = await fixture();
  expect(typeof f.module.createLastFmService).toBe('function');
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  f.boundary.openSurface = () => ({
    ready: Promise.reject(Error('synthetic failure')),
    closed: new Promise(() => {}),
    close() {},
  });
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  expect(await service.createSession(true)).toBe(false);
  expect(f.config.scrobblers.lastfm.sessionKey).toBe('existing-session');
  expect(f.writes).toEqual([]);
  service.stop();
});
test('both compatible services preserve alternative titles while preferring the actual artist', async () => {
  const f = await fixture();
  expect(typeof f.module.createLibreFmService).toBe('function');
  for (const [name, factory] of [
    ['lastfm', f.module.createLastFmService],
    ['librefm', f.module.createLibreFmService],
  ] as const) {
    f.config.scrobblers[name] = {
      ...f.config.scrobblers.lastfm,
      enabled: true,
      apiRoot: 'https://custom.invalid/' + name + '/',
      sessionKey: 'existing-session',
    };
    const service = factory(f.runtime, f.dependencies);
    expect(
      await service.setNowPlaying(
        {
          videoId: 'A',
          title: 'Primary',
          alternativeTitle: 'Alt',
          artist: 'Primary Artist',
          tags: ['Alt Artist'],
          album: 'Album',
          songDuration: 301,
          elapsedSeconds: 12,
          mediaType: 'AUDIO',
        },
        f.config,
        { signal: new AbortController().signal, isCurrent: () => true },
      ),
    ).toBe(true);
    const call = f.calls.at(-1);
    expect(call.url).toBe('https://custom.invalid/' + name + '/');
    const body = new URLSearchParams(call.options.body);
    expect(
      Object.fromEntries(
        ['track', 'artist', 'album', 'duration', 'sk'].map((k) => [
          k,
          body.get(k),
        ]),
      ),
    ).toEqual({
      track: 'Alt',
      artist: 'Primary Artist',
      album: 'Album',
      duration: '301',
      sk: 'existing-session',
    });
    service.stop();
  }
});
test('Rolling Girl uses its primary artist in every transport for new and existing defaults', async () => {
  const f = await fixture();
  const song = {
    title: 'Rolling Girl',
    artist: 'urei',
    tags: ['ローリンガール', 'VOCALOID'],
    songDuration: 200,
    elapsedSeconds: 100,
  };
  const discord = await discordArtworkFixture();
  try {
    discord.admit({ ...discord.song(), ...song });
    await discord.flush();
    expect(discord.state.activities.at(-1).state).toBe('urei');
  } finally {
    await discord.close();
  }
  for (const legacy of [undefined, true, false]) {
    const config = merge({}, f.config);
    if (legacy !== undefined) {
      delete config.artistSource;
      config.alternativeArtist = legacy;
    }
    for (const [name, factory] of [
      ['lastfm', f.module.createLastFmService],
      ['librefm', f.module.createLibreFmService],
      ['listenbrainz', f.module.createListenbrainzService],
    ] as const) {
      config.scrobblers[name] =
        name === 'listenbrainz'
          ? {
              enabled: true,
              token: 'dummy-token',
              apiRoot: 'https://listen.invalid/1/',
            }
          : {
              ...config.scrobblers.lastfm,
              enabled: true,
              sessionKey: 'existing-session',
            };
      f.config = config;
      const service = factory(f.runtime, f.dependencies);
      for (const action of ['setNowPlaying', 'addScrobble']) {
        expect(
          await service[action](song, config, {
            signal: new AbortController().signal,
            isCurrent: () => true,
          }),
        ).toBe(true);
        const call = f.calls.at(-1);
        const artist =
          name === 'listenbrainz'
            ? JSON.parse(call.options.body).payload[0].track_metadata
                .artist_name
            : new URLSearchParams(call.options.body).get('artist');
        expect(artist, `${name}/${action}/legacy=${legacy}`).toBe('urei');
      }
      service.stop();
    }
  }
});
test('artist source menu requires a fresh explicit legacy opt-in without changing account leaves', async () => {
  const f = await fixture();
  expect(f.module.defaultConfig.artistSource).toBe('primary');
  const accounts = merge({}, f.config.scrobblers);
  delete f.config.artistSource;
  f.config.alternativeArtist = true;
  let menu = await f.module.onMenu({ ...f.context, refresh() {} });
  expect(menu[2].checked).toBe(false);
  await menu[2].click({ checked: true });
  expect(f.writes).toEqual([{ artistSource: 'first-tag' }]);
  expect(f.config.alternativeArtist).toBe(true);
  expect(f.config.scrobblers).toEqual(accounts);
  menu = await f.module.onMenu({ ...f.context, refresh() {} });
  expect(menu[2].checked).toBe(true);
  await menu[2].click({ checked: false });
  expect(f.writes.at(-1)).toEqual({ artistSource: 'primary' });
  expect(f.config.scrobblers).toEqual(accounts);
});

for (const name of ['lastfm', 'librefm', 'listenbrainz']) {
  test(`${name} preserves explicit first-tag selection and rejects unsafe selected artists`, async () => {
    const f = await fixture();
    f.config.scrobblers[name] =
      name === 'listenbrainz'
        ? {
            enabled: true,
            token: 'dummy-token',
            apiRoot: 'https://listen.invalid/1/',
          }
        : {
            ...f.config.scrobblers.lastfm,
            enabled: true,
            sessionKey: 'existing-session',
          };
    const factory =
      name === 'lastfm'
        ? f.module.createLastFmService
        : name === 'librefm'
          ? f.module.createLibreFmService
          : f.module.createListenbrainzService;
    const service = factory(f.runtime, f.dependencies);
    const song = {
      title: 'Rolling Girl',
      artist: 'urei',
      tags: ['ローリンガール'],
      songDuration: 200,
      elapsedSeconds: 100,
    };
    const owner = {
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
    for (const [artistSource, artist, tags, expected] of [
      ['first-tag', 'urei', ['ローリンガール'], 'ローリンガール'],
      ['first-tag', 'urei', undefined, 'urei'],
      ['primary', '', ['Fallback tag'], 'Fallback tag'],
      ['primary', '  ', ['Fallback tag'], 'Fallback tag'],
      ['primary', undefined, ['Fallback tag'], 'Fallback tag'],
      ['unknown', 'urei', ['ローリンガール'], 'urei'],
    ]) {
      f.config.artistSource = artistSource;
      for (const action of ['setNowPlaying', 'addScrobble']) {
        expect(
          await service[action]({ ...song, artist, tags }, f.config, owner),
        ).toBe(true);
        const call = f.calls.at(-1);
        expect(
          name === 'listenbrainz'
            ? JSON.parse(call.options.body).payload[0].track_metadata
                .artist_name
            : new URLSearchParams(call.options.body).get('artist'),
        ).toBe(expected);
      }
    }
    for (const value of [
      '',
      '  ',
      null,
      {},
      42,
      '\u0000bad',
      'bad\r\nartist',
      'bad\u007fartist',
      'a'.repeat(4097),
    ]) {
      for (const artistSource of ['primary', 'first-tag']) {
        f.config.artistSource = artistSource;
        const info =
          artistSource === 'primary'
            ? { ...song, artist: value, tags: [] }
            : { ...song, tags: [value] };
        const before = f.calls.length;
        for (const action of ['setNowPlaying', 'addScrobble'])
          expect(
            await service[action](info, f.config, owner).catch(() => 'escaped'),
          ).toBe(false);
        expect(f.calls).toHaveLength(before);
      }
    }
    f.config.artistSource = 'primary';
    const before = f.calls.length;
    for (const artist of [null, {}, 'bad\nartist', 'a'.repeat(4097)])
      expect(
        await service.setNowPlaying({ ...song, artist }, f.config, owner),
      ).toBe(false);
    expect(f.calls).toHaveLength(before);
    service.stop();
  });
}
test('late error9 cannot clear a newer session; current decoded error9 clears nullable own leaves once', async () => {
  const f = await fixture();
  expect(typeof f.module.createLastFmService).toBe('function');
  f.config.scrobblers.lastfm.sessionKey = 'old-session';
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  const gate = deferred();
  f.boundary.fetcher = async () => {
    await gate.promise;
    return new Response('{"error":9,"message":"synthetic secret"}');
  };
  const song = {
    videoId: 'A',
    title: 'Song',
    artist: 'Artist',
    songDuration: 60,
    mediaType: 'AUDIO',
  };
  const pending = service.setNowPlaying(song, f.config, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  f.config.scrobblers.lastfm.sessionKey = 'newer-session';
  gate.resolve();
  expect(await pending).toBe(false);
  expect(f.writes).toEqual([]);
  expect(f.config.scrobblers.lastfm.sessionKey).toBe('newer-session');
  service.stop();
  const current = f.module.createLastFmService(f.runtime, f.dependencies);
  f.boundary.fetcher = async (url: string, options: any) =>
    options.method === 'POST'
      ? new Response('{"error":9}')
      : new Response('{"error":6}');
  expect(
    await current.setNowPlaying(song, f.config, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).toBe(false);
  await flush();
  expect(f.writes).toEqual([
    { scrobblers: { lastfm: { sessionKey: null, token: null } } },
  ]);
  current.stop();
});

test('menu preference edits are partial leaves and enabled Libre updates do not invoke lifecycle first', async () => {
  const f = await fixture();
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  await menu[0].click({ checked: false });
  expect(f.writes).toEqual([{ scrobbleOtherMedia: false }]);
  const libre = menu.find((item: any) => item.label === 'Libre.fm');
  expect(libre).toBeDefined();
  await libre.submenu[0].click({ checked: true });
  expect(f.writes.at(-1)).toEqual({
    scrobblers: { librefm: { enabled: true } },
  });
  expect(f.module.backend.enabledScrobblers.size).toBe(0);
});
test('deferred credential prompt edits one leaf and preserves newer session, independent service and preference writes', async () => {
  const f = await fixture(),
    gate = deferred();
  f.boundary.prompt = () => gate.promise;
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  const action = menu
    .find((item: any) => item.label === 'Last.fm')
    .submenu[1].click();
  await flush();
  f.config = merge(f.config, {
    alternativeArtist: false,
    scrobblers: {
      lastfm: { sessionKey: 'newer-session' },
      listenbrainz: { token: 'new-listen-token' },
    },
  });
  gate.resolve(['edited-key', 'dummy-secret']);
  await action;
  expect(f.writes).toEqual([
    { scrobblers: { lastfm: { apiKey: 'edited-key' } } },
  ]);
  expect(f.config.scrobblers.lastfm.sessionKey).toBe('newer-session');
  expect(f.config.scrobblers.listenbrainz.token).toBe('new-listen-token');
  expect(f.config.alternativeArtist).toBe(false);
});
test('explicit blank ListenBrainz token clears with null rather than skipped undefined', async () => {
  const f = await fixture();
  f.config.scrobblers.listenbrainz.token = 'existing-token';
  f.boundary.prompt = async () => '';
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  await menu
    .find((item: any) => item.label === 'ListenBrainz')
    .submenu[1].click();
  expect(f.writes).toEqual([{ scrobblers: { listenbrainz: { token: null } } }]);
  expect(f.config.scrobblers.listenbrainz.token).toBe(null);
});
test('deferred credential prompt cannot overwrite a replacement account tuple', async () => {
  const f = await fixture(),
    gate = deferred();
  f.boundary.prompt = () => gate.promise;
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  const action = menu
    .find((item: any) => item.label === 'Last.fm')
    .submenu[1].click();
  await flush();
  f.config = merge(f.config, {
    scrobblers: { lastfm: { apiKey: 'replacement-key' } },
  });
  gate.resolve(['stale-key', 'edited-secret']);
  await action;
  expect(f.writes).toEqual([]);
  expect(f.config.scrobblers.lastfm.apiKey).toBe('replacement-key');
});

test('ListenBrainz uses owned abortable requests and preserves its existing payload', async () => {
  const f = await fixture();
  expect(typeof f.module.createListenbrainzService).toBe('function');
  f.config.scrobblers.listenbrainz = {
    enabled: true,
    token: 'dummy-listen-token',
    apiRoot: 'https://listen.invalid/1/',
  };
  const service = f.module.createListenbrainzService(f.runtime, f.dependencies);
  const song = {
    videoId: 'A',
    title: 'Original',
    alternativeTitle: 'Alt',
    artist: 'Original Artist',
    tags: ['Alt Artist'],
    album: 'Album',
    url: 'https://music.youtube.com/watch?v=A',
    songDuration: 200,
    elapsedSeconds: 30,
    mediaType: 'AUDIO',
  };
  expect(
    await service.setNowPlaying(song, f.config, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).toBe(true);
  const call = f.calls.at(-1);
  expect(call.url).toBe('https://listen.invalid/1/submit-listens');
  expect(call.options.headers.Authorization).toBe('Token dummy-listen-token');
  expect(JSON.parse(call.options.body)).toMatchObject({
    listen_type: 'playing_now',
    payload: [
      {
        track_metadata: {
          artist_name: 'Original Artist',
          track_name: 'Alt',
          release_name: 'Album',
          additional_info: { origin_url: song.url, duration: 200 },
        },
      },
    ],
  });
  const held = deferred();
  f.boundary.fetcher = () => held.promise;
  const pending = service.addScrobble(song, f.config, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  service.stop();
  expect(await pending).toBe(false);
  held.resolve(new Response('{}'));
});

test('backend starts before interactive session completion and owns callback/timer disposal', async () => {
  const f = await fixture();
  expect(typeof f.module.createScrobblerManager).toBe('function');
  const held = deferred();
  f.boundary.fetcher = async (url: string, options: any) => {
    f.calls.push({ url, options });
    if (new URL(url).searchParams.get('method') === 'auth.getToken')
      return new Response('{"token":"dummy-token"}');
    return held.promise;
  };
  const manager = f.module.createScrobblerManager(f.context);
  expect(f.callbacks.size).toBe(1);
  await manager.start();
  await flush();
  expect(f.surfaces).toHaveLength(1);
  expect(f.writes).toEqual([]);
  manager.stop();
  expect(f.callbacks.size).toBe(0);
  expect(f.timers.size).toBe(0);
  held.resolve(new Response('{"session":{"key":"late-session"}}'));
  await flush();
  expect(f.writes).toEqual([]);
});
test('same fingerprint config keeps service/auth owner and native change fences older same-ID metadata', async () => {
  const f = await fixture();
  expect(typeof f.module.createScrobblerManager).toBe('function');
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const original = manager.services.get('lastfm');
  manager.configurationChanged(merge(f.config, { alternativeTitles: false }));
  expect(manager.services.get('lastfm')).toBe(original);
  const oldToken = {},
    newToken = {};
  const oldInfo = {
    videoId: 'A',
    title: 'Old',
    artist: 'Artist',
    songDuration: 120,
    elapsedSeconds: 0,
    mediaType: 'AUDIO',
    isPaused: false,
  };
  f.boundary.currentProvenance = oldToken;
  f.boundary.provenance.set(oldInfo, oldToken);
  for (const callback of f.callbacks)
    callback(oldInfo, 'peard:video-src-changed');
  await flush();
  expect(f.timers.size).toBe(1);
  const before = f.calls.length;
  f.boundary.currentProvenance = null;
  f.ipcMain?.emit?.('noop');
  f.boundary.ipcMain.emit(
    'peard:video-src-changed',
    { sender: f.contents, senderFrame: f.contents.mainFrame },
    { videoDetails: { videoId: 'A' } },
  );
  f.boundary.currentProvenance = newToken;
  for (const callback of f.callbacks)
    callback(oldInfo, 'peard:video-src-changed');
  expect(f.timers.size).toBe(0);
  await flush();
  expect(f.calls.length).toBe(before);
  manager.stop();
});
test('half-duration/four-minute timer uses mutable elapsed and rejects foreign raw sender/frame', async () => {
  const f = await fixture();
  expect(typeof f.module.createScrobblerManager).toBe('function');
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const token = {},
    info = {
      videoId: 'A',
      title: 'Song',
      artist: 'Artist',
      songDuration: 600,
      elapsedSeconds: 20,
      mediaType: 'AUDIO',
      isPaused: false,
    };
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const callback of f.callbacks) callback(info, 'peard:video-src-changed');
  await flush();
  const timer: any = [...f.timers][0];
  expect(timer.delay).toBe(220000);
  f.boundary.ipcMain.emit(
    'peard:video-src-changed',
    { sender: {}, senderFrame: f.contents.mainFrame },
    { videoDetails: { videoId: 'B' } },
  );
  f.boundary.ipcMain.emit(
    'peard:video-src-changed',
    { sender: f.contents, senderFrame: {} },
    { videoDetails: { videoId: 'B' } },
  );
  expect(f.timers.size).toBe(1);
  info.elapsedSeconds = 240;
  for (const callback of f.callbacks) callback(info, 'peard:time-changed');
  timer.fn(...timer.args);
  await flush();
  const call = f.calls.at(-1);
  const body = new URLSearchParams(call.options.body);
  expect(body.get('method')).toBe('track.scrobble');
  expect(Number(body.get('timestamp'))).toBeGreaterThanOrEqual(
    Math.trunc(Date.now() / 1000) - 241,
  );
  expect(Number(body.get('timestamp'))).toBeLessThanOrEqual(
    Math.trunc(Date.now() / 1000) - 240,
  );
  manager.stop();
});

test('hot replay with an existing key sends now-playing once, without an auth completion duplicate', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const token = {},
    info = {
      videoId: 'A',
      title: 'Song',
      artist: 'Artist',
      songDuration: 100,
      elapsedSeconds: 0,
      isPaused: false,
      mediaType: 'AUDIO',
    };
  f.boundary.provenance.set(info, token);
  f.boundary.currentProvenance = token;
  f.boundary.registerCallback = (callback: any) => {
    f.callbacks.add(callback);
    callback(info, 'peard:video-src-changed');
    return () => f.callbacks.delete(callback);
  };
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  await flush();
  expect(f.calls).toHaveLength(1);
  expect(new URLSearchParams(f.calls[0].options.body).get('method')).toBe(
    'track.updateNowPlaying',
  );
  manager.stop();
});
test('a valid config watch wins over rejection of an older pending startup read', async () => {
  const f = await fixture(),
    gate = deferred();
  const manager = f.module.createScrobblerManager({
    ...f.context,
    getConfig: () => gate.promise,
  });
  const starting = manager.start();
  const ready = merge(f.config, {
    scrobblers: { lastfm: { sessionKey: 'existing-session' } },
  });
  manager.configurationChanged(ready);
  gate.reject(Error('synthetic stale read'));
  await starting;
  expect(manager.services.size).toBe(1);
  expect(f.callbacks.size).toBe(1);
  manager.stop();
});
test('in-place mutation of a pending prompt account also retires its snapshot', async () => {
  const f = await fixture(),
    gate = deferred();
  f.boundary.prompt = () => gate.promise;
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  const action = menu
    .find((item: any) => item.label === 'Last.fm')
    .submenu[1].click();
  await flush();
  f.config.scrobblers.lastfm.apiKey = 'replacement-key';
  gate.resolve(['stale-key', 'edited-secret']);
  await action;
  expect(f.writes).toEqual([]);
});
test('service current-owner callback that stops reentrantly cannot admit a post', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  expect(
    await service.setNowPlaying(
      { videoId: 'A', title: 'Song', artist: 'Artist', songDuration: 100 },
      f.config,
      {
        signal: new AbortController().signal,
        isCurrent: () => {
          service.stop();
          return true;
        },
      },
    ),
  ).toBe(false);
  expect(f.calls).toEqual([]);
});
test('malformed tags and nonfinite elapsed cannot escape a boolean submission or reach transport', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  const owner = { signal: new AbortController().signal, isCurrent: () => true };
  const info = {
    videoId: 'A',
    title: 'Song',
    artist: 'Artist',
    songDuration: 100,
    tags: {},
    elapsedSeconds: 0,
  };
  expect(
    await service.addScrobble(info, f.config, owner).catch(() => 'escaped'),
  ).toBe(false);
  for (const elapsedSeconds of [NaN, Infinity, -1])
    expect(
      await service.addScrobble(
        { ...info, tags: undefined, elapsedSeconds },
        f.config,
        owner,
      ),
    ).toBe(false);
  expect(f.calls).toEqual([]);
  service.stop();
});

for (const retirement of ['stop', 'config', 'window', 'frame'])
  test(`a late accepted auth response cannot persist after ${retirement}`, async () => {
    const f = await fixture(),
      held = deferred();
    f.boundary.fetcher = async (url: string, options: any) => {
      f.calls.push({ url, options });
      if (new URL(url).searchParams.get('method') === 'auth.getToken')
        return new Response('{"token":"dummy-token"}');
      return held.promise;
    };
    const manager = f.module.createScrobblerManager(f.context);
    await manager.start();
    await flush();
    expect(f.surfaces).toHaveLength(1);
    if (retirement === 'stop') manager.stop();
    else if (retirement === 'config')
      manager.configurationChanged(
        merge(f.config, { scrobblers: { lastfm: { enabled: false } } }),
      );
    else if (retirement === 'window') f.window.emit('closed');
    else {
      f.contents.mainFrame = {};
      f.contents.emit(
        'did-start-navigation',
        {},
        'https://music.youtube.com',
        false,
        true,
      );
    }
    held.resolve(new Response('{"session":{"key":"late-session"}}'));
    await flush();
    expect(f.writes).toEqual([]);
    manager.stop();
  });
test('stop removes only owned callbacks/native listeners and retired timer closures cannot send', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  const foreign = () => {};
  f.boundary.ipcMain.on('peard:video-src-changed', foreign);
  f.window.on('closed', foreign);
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const token = {},
    info = {
      videoId: 'A',
      title: 'Song',
      artist: 'Artist',
      songDuration: 100,
      elapsedSeconds: 0,
      isPaused: false,
      mediaType: 'AUDIO',
    };
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const callback of f.callbacks) callback(info, 'peard:video-src-changed');
  await flush();
  const timer: any = [...f.timers][0],
    before = f.calls.length;
  manager.stop();
  timer.fn(...timer.args);
  await flush();
  expect(f.calls.length).toBe(before);
  expect(f.callbacks.size).toBe(0);
  expect(f.boundary.ipcMain.listeners('peard:video-src-changed')).toEqual([
    foreign,
  ]);
  expect(f.window.listeners('closed')).toEqual([foreign]);
});
test('other-media policy and pause/resume keep the half-duration timer contract', async () => {
  const f = await fixture();
  f.config = merge(f.config, {
    scrobbleOtherMedia: false,
    scrobblers: { lastfm: { sessionKey: 'existing-session' } },
  });
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const token = {},
    info = {
      videoId: 'A',
      title: 'Song',
      artist: 'Artist',
      songDuration: 121,
      elapsedSeconds: 10,
      isPaused: false,
      mediaType: 'PODCAST_EPISODE',
    };
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const callback of f.callbacks) callback(info, 'peard:video-src-changed');
  await flush();
  expect(f.calls).toEqual([]);
  expect(f.timers.size).toBe(0);
  info.mediaType = 'AUDIO';
  for (const callback of f.callbacks) callback(info, 'peard:video-src-changed');
  expect([...f.timers].map((timer: any) => timer.delay)).toEqual([51000]);
  info.isPaused = true;
  for (const callback of f.callbacks) callback(info, 'peard:play-or-paused');
  expect(f.timers.size).toBe(0);
  info.isPaused = false;
  info.elapsedSeconds = 20;
  for (const callback of f.callbacks) callback(info, 'peard:play-or-paused');
  expect([...f.timers].map((timer: any) => timer.delay)).toEqual([41000]);
  manager.stop();
});

test('concurrent decoded error9 replies claim one invalidation while its write is pending', async () => {
  const f = await fixture(),
    held = deferred();
  f.config.scrobblers.lastfm.sessionKey = 'old-session';
  f.runtime.writeConfig = async (patch: any, guard: any) => {
    if (!guard()) return false;
    f.writes.push(patch);
    await held.promise;
    if (!guard()) return false;
    f.config = merge(f.config, patch);
    return true;
  };
  f.boundary.fetcher = async (_url: string, options: any) =>
    new Response(options.method === 'POST' ? '{"error":9}' : '{"error":6}');
  const service = f.module.createLastFmService(f.runtime, f.dependencies),
    song = { title: 'Song', artist: 'Artist', songDuration: 60 },
    owner = { signal: new AbortController().signal, isCurrent: () => true };
  const first = service.setNowPlaying(song, f.config, owner),
    second = service.addScrobble(song, f.config, owner);
  await flush();
  expect(f.writes).toHaveLength(1);
  held.resolve();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  await flush();
  expect(f.writes).toEqual([
    { scrobblers: { lastfm: { sessionKey: null, token: null } } },
  ]);
  service.stop();
});

test('automatic error9 authentication is bounded after success and explicit authenticate renews the budget', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'old-session';
  let keys = 0;
  let service: any;
  const write = f.runtime.writeConfig;
  f.runtime.writeConfig = async (patch: any, guard: any) => {
    const result = await write(patch, guard);
    service.configurationChanged();
    return result;
  };
  f.boundary.fetcher = async (url: string, options: any) => {
    f.calls.push({ url, options });
    const method = new URL(url).searchParams.get('method');
    return new Response(
      options.method === 'POST'
        ? '{"error":9}'
        : method === 'auth.getToken'
          ? '{"token":"dummy-token"}'
          : JSON.stringify({ session: { key: 'auto-session-' + ++keys } }),
    );
  };
  service = f.module.createLastFmService(f.runtime, f.dependencies);
  const song = { title: 'Song', artist: 'Artist', songDuration: 60 },
    owner = { signal: new AbortController().signal, isCurrent: () => true };
  expect(await service.setNowPlaying(song, f.config, owner)).toBe(false);
  await flush();
  expect(f.surfaces).toHaveLength(1);
  expect(f.config.scrobblers.lastfm.sessionKey).toBe('auto-session-1');
  expect(await service.addScrobble(song, f.config, owner)).toBe(false);
  await flush();
  expect(f.surfaces).toHaveLength(1);
  expect(f.config.scrobblers.lastfm.sessionKey).toBeNull();
  expect(await service.createSession(true)).toBe(true);
  expect(f.surfaces).toHaveLength(2);
  expect(await service.addScrobble(song, f.config, owner)).toBe(false);
  await flush();
  expect(f.surfaces).toHaveLength(3);
  service.stop();
});

for (const retirement of ['stop', 'restart', 'closed', 'frame'])
  test(`pending menu prompts cannot write after ${retirement}`, async () => {
    const f = await fixture(),
      held = deferred();
    f.config.scrobblers.lastfm.sessionKey = 'existing-session';
    await f.module.backend.start(f.context);
    f.boundary.prompt = () => held.promise;
    const menu = await f.module.onMenu({ ...f.context, refresh() {} }),
      pending = menu
        .find((item: any) => item.label === 'Last.fm')
        .submenu[1].click();
    await flush();
    if (retirement === 'stop') f.module.backend.stop();
    else if (retirement === 'restart') await f.module.backend.start(f.context);
    else if (retirement === 'closed') f.window.isDestroyed = () => true;
    else f.contents.mainFrame = {};
    held.resolve(['new-key', 'new-secret']);
    await pending;
    expect(f.writes).toEqual([]);
    f.module.backend.stop();
  });
test('cancel and malformed prompt outputs preserve account credentials and pending getConfig is fenced', async () => {
  const f = await fixture();
  const menu = await f.module.onMenu({ ...f.context, refresh() {} }),
    settings = menu.find((item: any) => item.label === 'Last.fm').submenu[1];
  for (const output of [
    null,
    undefined,
    [],
    ['one'],
    ['a', 'b', 'c'],
    [123, 'secret'],
    { apiKey: 'object' },
  ]) {
    f.boundary.prompt = async () => output;
    await settings.click();
  }
  expect(f.writes).toEqual([]);
  const held = deferred();
  const pending = f.module.onMenu({
    ...f.context,
    getConfig: () => held.promise,
    refresh() {},
  });
  f.contents.mainFrame = {};
  held.resolve(f.config);
  expect(await pending).toEqual([]);
});
test('unrelated preferences retain the pending login and account replacement retires it', async () => {
  const f = await fixture(),
    held = deferred();
  f.boundary.fetcher = async (url: string) =>
    new URL(url).searchParams.get('method') === 'auth.getToken'
      ? new Response('{"token":"dummy-token"}')
      : held.promise;
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  await flush();
  const original = manager.services.get('lastfm'),
    login = original.createSession();
  manager.configurationChanged(merge(f.config, { alternativeArtist: false }));
  expect(manager.services.get('lastfm')).toBe(original);
  expect(original.createSession()).toBe(login);
  expect(f.surfaces).toHaveLength(1);
  manager.configurationChanged(
    merge(f.config, { scrobblers: { lastfm: { enabled: false } } }),
  );
  held.resolve(new Response('{"session":{"key":"late-key"}}'));
  expect(await login).toBe(false);
  await flush();
  expect(f.writes).toEqual([]);
  expect(manager.services.size).toBe(0);
  manager.stop();
});
test('malformed account tuples cannot start authentication or send any service request', async () => {
  const f = await fixture();
  const song = { title: 'Song', artist: 'Artist', songDuration: 60 },
    owner = { signal: new AbortController().signal, isCurrent: () => true };
  for (const patch of [
    { apiRoot: 'http://invalid.test/' },
    { apiRoot: 'https://user:pass@invalid.test/' },
    { apiRoot: 'https://invalid.test/?query=yes' },
    { apiKey: {} },
    { secret: [] },
    { sessionKey: {} },
    { token: 5 },
  ]) {
    f.config = merge(f.module.defaultConfig, {
      enabled: true,
      scrobblers: { lastfm: { enabled: true, sessionKey: 'old', ...patch } },
    });
    const service = f.module.createLastFmService(f.runtime, f.dependencies);
    expect(await service.createSession(true)).toBe(false);
    expect(await service.setNowPlaying(song, f.config, owner)).toBe(false);
    service.stop();
  }
  for (const patch of [
    { apiRoot: 'http://invalid.test/' },
    { apiRoot: 'https://user:pass@invalid.test/' },
    { token: 'bad\r\nheader' },
    { token: {} },
  ]) {
    f.config = merge(f.module.defaultConfig, {
      enabled: true,
      scrobblers: {
        listenbrainz: { enabled: true, token: 'dummy-token', ...patch },
      },
    });
    const service = f.module.createListenbrainzService(
      f.runtime,
      f.dependencies,
    );
    expect(await service.setNowPlaying(song, f.config, owner)).toBe(false);
    service.stop();
  }
  expect(f.calls).toEqual([]);
  expect(f.writes).toEqual([]);
});

test('an authenticate click from a retired menu cannot open a restarted account login', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'existing-session';
  await f.module.backend.start(f.context);
  const menu = await f.module.onMenu({ ...f.context, refresh() {} });
  const authenticate = menu.find((item: any) => item.label === 'Last.fm')
    .submenu[2];
  await f.module.backend.start(f.context);
  await authenticate.click();
  expect(f.surfaces).toHaveLength(0);
  expect(f.writes).toEqual([]);
  f.module.backend.stop();
});

test('a newer session config revision wins while an already admitted auth write completes', async () => {
  const f = await fixture(),
    held = deferred();
  const manager = f.module.createScrobblerManager({
    ...f.context,
    setConfig: async (patch: any) => {
      await f.context.setConfig(patch);
      await held.promise;
    },
  });
  await manager.start();
  await flush();
  expect(f.writes).toEqual([
    { scrobblers: { lastfm: { sessionKey: 'dummy-session', token: null } } },
  ]);
  f.config = merge(f.config, {
    scrobblers: { lastfm: { sessionKey: 'newer-session' } },
  });
  manager.configurationChanged(f.config);
  held.resolve();
  await flush();
  expect(f.config.scrobblers.lastfm.sessionKey).toBe('newer-session');
  expect(manager.services.get('lastfm').isSessionCreated()).toBe(true);
  expect(f.writes).toHaveLength(1);
  manager.stop();
});

test('initial document load restores owned background authentication before any song metadata', async () => {
  const f = await fixture(),
    held = deferred();
  f.boundary.fetcher = async (url: string) =>
    new URL(url).searchParams.get('method') === 'auth.getToken'
      ? new Response('{"token":"dummy-token"}')
      : held.promise;
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  await flush();
  const original = manager.services.get('lastfm');
  f.contents.emit(
    'did-start-navigation',
    {},
    'https://music.youtube.com/',
    false,
    true,
  );
  expect(manager.services.size).toBe(0);
  f.contents.mainFrame = {};
  f.contents.emit('did-finish-load');
  await flush();
  expect(manager.services.size).toBe(1);
  expect(manager.services.get('lastfm')).not.toBe(original);
  expect(f.surfaces).toHaveLength(2);
  expect(f.writes).toEqual([]);
  manager.stop();
  f.contents.emit('did-finish-load');
  expect(manager.services.size).toBe(0);
  held.resolve(new Response('{"session":{"key":"late-session"}}'));
  await flush();
  expect(f.writes).toEqual([]);
});

test('Electron navigation details in the first argument retire only full main document loads', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'owned-session';
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const original = manager.services.get('lastfm');
  f.contents.emit('did-start-navigation', {
    isMainFrame: false,
    isInPlace: false,
  });
  f.contents.emit('did-start-navigation', {
    isMainFrame: true,
    isInPlace: true,
  });
  expect(manager.services.get('lastfm')).toBe(original);
  f.contents.emit('did-start-navigation', {
    isMainFrame: true,
    isInPlace: false,
  });
  expect(manager.services.size).toBe(0);
  f.contents.emit('did-finish-load');
  expect(manager.services.size).toBe(1);
  expect(manager.services.get('lastfm')).not.toBe(original);
  manager.stop();
});

test('metadata is disabled by default and one frozen projection reaches all transports without changing SongInfo', async () => {
  const f = await fixture();
  expect(f.config.regexFiltersEnabled).toBe(false);
  expect(f.config.customRegexFilters).toEqual([]);
  expect(f.config.useMusicBrainz).toBe(false);
  expect(f.config.musicBrainzEmail).toBe('');
  for (const name of ['lastfm', 'librefm'])
    f.config.scrobblers[name] = {
      ...f.config.scrobblers.lastfm,
      enabled: true,
      sessionKey: 'session',
    };
  f.config.scrobblers.listenbrainz = {
    enabled: true,
    token: 'token',
    apiRoot: 'https://listen.invalid/',
  };
  f.config.regexFiltersEnabled = true;
  const gate = deferred();
  let preparations = 0;
  let aborted = false;
  const manager = f.module.createScrobblerManager(f.context, {
    metadata: {
      prepare: (_input: any, _config: any, signal: AbortSignal) => {
        preparations++;
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return gate.promise;
      },
      stop() {},
    },
  });
  await manager.start();
  const info = {
    videoId: 'A',
    title: 'Primary',
    alternativeTitle: 'Alternative',
    artist: 'Artist',
    tags: ['Tag'],
    album: 'Album',
    songDuration: 120,
    elapsedSeconds: 0,
    isPaused: false,
    mediaType: 'AUDIO',
  };
  const token = {};
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const cb of f.callbacks) cb(info, 'peard:video-src-changed');
  await flush();
  expect(preparations).toBe(1);
  expect(f.calls).toHaveLength(0);
  gate.resolve({
    title: 'Prepared',
    artist: 'Artist',
    album: 'Album',
    duration: 120,
  });
  await flush();
  expect(f.calls).toHaveLength(3);
  const timer: any = [...f.timers].find((t: any) => t.delay === 60000);
  expect(timer).toBeTruthy();
  info.elapsedSeconds = 60;
  timer.fn();
  await flush();
  expect(f.calls).toHaveLength(6);
  for (const call of f.calls) {
    if (call.url.includes('listen.invalid'))
      expect(
        (
          JSON.parse(call.options.body) as {
            payload: { track_metadata: { track_name: string } }[];
          }
        ).payload[0].track_metadata.track_name,
      ).toBe('Prepared');
    else
      expect(new URLSearchParams(call.options.body).get('track')).toBe(
        'Prepared',
      );
  }
  expect(info.title).toBe('Primary');
  expect(info.alternativeTitle).toBe('Alternative');
  expect(info.tags).toEqual(['Tag']);
  expect(f.boundary.provenance.get(info)).toBe(token);
  expect(aborted).toBe(true);
  manager.stop();
});

test('metadata preparation cannot delay the admitted timer, publish after retirement or change frozen fallback', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'session';
  f.config.regexFiltersEnabled = true;
  const pending: any[] = [];
  const manager = f.module.createScrobblerManager(f.context, {
    metadata: {
      prepare: (_i: any, _c: any, signal: AbortSignal) => {
        const gate = deferred();
        pending.push({ gate, signal });
        return gate.promise;
      },
      stop() {},
    },
  });
  await manager.start();
  const info = {
    videoId: 'A',
    title: 'Song',
    artist: 'Artist',
    songDuration: 120,
    elapsedSeconds: 59,
    isPaused: false,
    mediaType: 'AUDIO',
  };
  const token = {};
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const cb of f.callbacks) cb(info, 'peard:video-src-changed');
  await flush();
  const timer: any = [...f.timers].find((t: any) => t.delay === 1000);
  expect(timer).toBeTruthy();
  info.elapsedSeconds = 60;
  timer.fn();
  await flush();
  expect(f.calls).toHaveLength(2);
  expect(pending[0].signal.aborted).toBe(true);
  pending[0].gate.resolve({ title: 'Late', artist: 'Wrong', duration: 120 });
  await flush();
  for (const call of f.calls)
    expect(new URLSearchParams(call.options.body).get('track')).toBe('Song');
  const next = { ...info, elapsedSeconds: 0 };
  const nextToken = {};
  f.boundary.currentProvenance = nextToken;
  f.boundary.provenance.set(next, nextToken);
  for (const cb of f.callbacks) cb(next, 'peard:video-src-changed');
  await flush();
  manager.stop();
  expect(pending[1].signal.aborted).toBe(true);
  pending[1].gate.resolve({ title: 'Retired', artist: 'Wrong', duration: 120 });
  await flush();
  expect(f.calls).toHaveLength(2);
});

test('metadata menu requires explicit consent, writes leaves and fences stale contact prompts', async () => {
  const f = await fixture();
  let menu = await f.module.onMenu(f.context);
  const entry = (key: string) =>
    menu.find((item: any) => item.label === 'plugins.scrobbler.menu.' + key);
  f.boundary.prompt = async () => 'person@example.invalid';
  const item = { checked: true };
  expect(entry('use-musicbrainz')).toBeTruthy();
  await entry('use-musicbrainz').click(item);
  expect(f.writes).toEqual([
    { musicBrainzEmail: 'person@example.invalid', useMusicBrainz: true },
  ]);
  const gate = deferred();
  f.boundary.prompt = () => gate.promise;
  menu = await f.module.onMenu(f.context);
  const pending = entry('musicbrainz-email').click();
  await flush();
  f.config.musicBrainzEmail = 'newer@example.invalid';
  gate.resolve('stale@example.invalid');
  await pending;
  expect(f.config.musicBrainzEmail).toBe('newer@example.invalid');
  expect(f.writes).toHaveLength(1);
  f.boundary.prompt = async () => '';
  menu = await f.module.onMenu(f.context);
  await entry('musicbrainz-email').click();
  expect(f.writes.at(-1)).toEqual({
    musicBrainzEmail: '',
    useMusicBrainz: false,
  });
});

test('real isolated cleanup uses a preference snapshot and leaves provider metadata intact', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'session';
  f.config.regexFiltersEnabled = true;
  f.config.customRegexFilters = ['\\s\\(Official Video\\)$'];
  f.boundary.fetcher = async (url: string, options: any) => {
    f.calls.push({ url, options });
    return Response.json(
      url.startsWith('https://musicbrainz.org/') ? { recordings: [] } : {},
    );
  };
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const info = {
    videoId: 'A',
    title: 'Песня (Live) (Official Video)',
    artist: 'Artist feat. Guest',
    songDuration: 120,
    elapsedSeconds: 0,
    isPaused: false,
    mediaType: 'AUDIO',
  };
  const token = {};
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const cb of f.callbacks) cb(info, 'peard:video-src-changed');
  f.config.useMusicBrainz = true;
  f.config.musicBrainzEmail = 'changed@example.invalid';
  await expect
    .poll(
      () =>
        f.calls.filter((call: any) => !call.url.includes('musicbrainz.org'))
          .length,
    )
    .toBe(1);
  expect(
    f.calls.filter((call: any) => call.url.includes('musicbrainz.org')),
  ).toHaveLength(0);
  const body = new URLSearchParams(f.calls[0].options.body);
  expect(body.get('track')).toBe('Песня (Live)');
  expect(body.get('artist')).toBe('Artist feat. Guest');
  expect(info.title).toBe('Песня (Live) (Official Video)');
  manager.stop();
});

test('malformed prepared metadata fails closed without escaping the boolean transport contract', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'session';
  const service = f.module.createLastFmService(f.runtime, f.dependencies);
  await expect(
    service.setNowPlaying(
      { title: 'Song', artist: 'Artist', songDuration: 120 },
      f.config,
      {
        signal: new AbortController().signal,
        isCurrent: () => true,
        metadata: null,
      },
    ),
  ).resolves.toBe(false);
  expect(f.calls).toHaveLength(0);
  service.stop();
});

test('MusicBrainz split correction carries independent original duration through the real metadata layer', async () => {
  const f = await fixture();
  f.config.scrobblers.lastfm.sessionKey = 'session';
  f.config.useMusicBrainz = true;
  f.config.musicBrainzEmail = 'person@example.invalid';
  let lookups = 0;
  f.boundary.fetcher = async (url: string, options: any) => {
    f.calls.push({ url, options });
    if (url.startsWith('https://musicbrainz.org/'))
      return Response.json({
        recordings:
          ++lookups === 1
            ? []
            : [
                {
                  title: 'Песня (Live)',
                  score: 100,
                  length: 180000,
                  'artist-credit': [
                    { name: 'Artist', joinphrase: ' & ' },
                    { name: 'Guest' },
                  ],
                },
              ],
      });
    return Response.json({});
  };
  const manager = f.module.createScrobblerManager(f.context);
  await manager.start();
  const info = {
    videoId: 'A',
    title: 'Artist & Guest - Песня (Live)',
    artist: 'Upload Channel',
    album: 'Album',
    url: 'https://music.youtube.com/watch?v=A',
    songDuration: 180,
    elapsedSeconds: 0,
    isPaused: false,
    mediaType: 'AUDIO',
  };
  const token = {};
  f.boundary.currentProvenance = token;
  f.boundary.provenance.set(info, token);
  for (const cb of f.callbacks) cb(info, 'peard:video-src-changed');
  await expect
    .poll(
      () =>
        f.calls.filter((call: any) => !call.url.includes('musicbrainz.org'))
          .length,
    )
    .toBe(1);
  expect(lookups).toBe(2);
  const timer: any = [...f.timers].find((t: any) => t.delay === 90000);
  expect(timer).toBeTruthy();
  info.elapsedSeconds = 90;
  timer.fn();
  await flush();
  const sent = f.calls.filter(
    (call: any) => !call.url.includes('musicbrainz.org'),
  );
  expect(sent).toHaveLength(2);
  for (const call of sent) {
    const body = new URLSearchParams(call.options.body);
    expect(body.get('track')).toBe('Песня (Live)');
    expect(body.get('artist')).toBe('Artist & Guest');
    expect(body.get('duration')).toBe('180');
    expect(body.get('album')).toBe('Album');
  }
  expect(info.title).toBe('Artist & Guest - Песня (Live)');
  expect(info.artist).toBe('Upload Channel');
  expect(info.songDuration).toBe(180);
  expect(f.boundary.provenance.get(info)).toBe(token);
  manager.stop();
});
