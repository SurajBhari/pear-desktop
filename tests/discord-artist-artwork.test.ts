import { test, expect } from '@playwright/test';
import { discordArtworkFixture } from './helpers/discord-artist-artwork';

test('replacement services share bounded public work while old cleanup cannot cancel the newer owner', async () => {
  const f = await discordArtworkFixture();
  let replacement: any, third: any;
  try {
    f.hold = true;
    const config = { ...f.config, showArtistImage: true };
    f.service.onConfigChange(config);
    const song = f.song();
    f.admit(song);
    await f.flush();
    replacement = new f.module.DiscordService(f.state.window, config);
    replacement.rpc.emit('ready');
    replacement.updateActivity(song);
    await f.flush();
    const immediateRequests = f.requests.length;
    f.state.now += 1000;
    replacement.updateActivity(song);
    await f.flush();
    const beforeOld = f.state.activities.length;
    f.requests[0].resolve();
    await f.flush();
    const oldPublished = f.state.activities.length !== beforeOld;
    f.service.cleanup();
    const newerAborted = f.requests[1].options.signal.aborted;
    f.requests[1].resolve();
    await f.flush();
    const currentAvatar = !!f.state.activities.at(-1).smallImageKey;
    third = new f.module.DiscordService(f.state.window, config);
    third.rpc.emit('ready');
    third.updateActivity(song);
    await f.flush();
    const cachedRequests = f.requests.length;
    expect({
      immediateRequests,
      oldPublished,
      newerAborted,
      currentAvatar,
      cachedRequests,
    }).toEqual({
      immediateRequests: 1,
      oldPublished: false,
      newerAborted: false,
      currentAvatar: true,
      cachedRequests: 2,
    });
  } finally {
    third?.cleanup();
    replacement?.cleanup();
    await f.close();
  }
});

test('a reentrant RPC user getter retiring native metadata cannot publish completed artist work', async () => {
  const f = await discordArtworkFixture();
  try {
    f.hold = true;
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song());
    await f.flush();
    const user = f.service.rpc.user;
    Object.defineProperty(f.service.rpc, 'user', {
      configurable: true,
      get() {
        f.state.current = null;
        return user;
      },
    });
    const count = f.state.activities.length;
    f.requests[0].resolve();
    await f.flush();
    expect(f.state.activities).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('rejected status or content type still closes its public response body', async () => {
  for (const mode of ['status', 'type'] as const) {
    const f = await discordArtworkFixture();
    try {
      let canceled = false;
      f.responseFactory = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel() {
              canceled = true;
            },
          }),
          {
            status: mode === 'status' ? 503 : 200,
            headers: {
              'content-type':
                mode === 'type' ? 'application/json' : 'text/html',
            },
          },
        );
      f.service.onConfigChange({ ...f.config, showArtistImage: true });
      f.admit(f.song());
      await f.flush();
      expect(canceled).toBe(true);
      expect(f.state.activities).toHaveLength(1);
      expect('smallImageKey' in f.state.activities[0]).toBe(false);
    } finally {
      await f.close();
    }
  }
});

test('deadline aborts late public work, keeps negative cache and permits expiry recovery', async () => {
  const f = await discordArtworkFixture();
  try {
    f.hold = true;
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    const song = f.song();
    f.admit(song);
    await f.flush();
    expect(f.requests).toHaveLength(1);
    await expect
      .poll(() => f.requests[0].options.signal.aborted, { timeout: 6500 })
      .toBe(true);
    f.requests[0].resolve();
    await f.flush();
    expect(f.state.activities).toHaveLength(1);
    expect('smallImageKey' in f.state.activities[0]).toBe(false);
    f.state.now += 6001;
    f.service.updateActivity(song);
    await f.flush();
    expect(f.requests).toHaveLength(1);
    f.hold = false;
    f.state.now += 60001;
    f.service.updateActivity(song);
    await f.flush();
    expect(f.requests).toHaveLength(2);
    expect(f.state.activities.at(-1).smallImageKey).toBeTruthy();
  } finally {
    await f.close();
  }
});

test('one-character artist names retain existing Hangul padding and current avatar', async () => {
  const f = await discordArtworkFixture();
  try {
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song({ artist: '가' }));
    await f.flush();
    expect(f.state.activities.at(-1)).toMatchObject({
      state: '가ㅤ',
      smallImageText: '가ㅤ',
      smallImageKey: 'https://yt3.googleusercontent.com/artist-avatar',
    });
  } finally {
    await f.close();
  }
});

for (const retirement of ['invalid-raw', 'null-document'] as const)
  test(`actual metadata provider ${retirement} admission retires a pending avatar without a new callback`, async () => {
    const f = await discordArtworkFixture({ actualProvider: true });
    let dispose = () => {},
      unsubscribe = () => {};
    try {
      f.hold = true;
      f.service.onConfigChange({ ...f.config, showArtistImage: true });
      dispose = f.module.setupSongInfo(f.state.window);
      let callbacks = 0;
      unsubscribe = f.module.registerCallback((info: any) => {
        callbacks++;
        f.service.updateActivity(info);
      });
      const event = {
        sender: f.state.window.webContents,
        senderFrame: f.state.window.webContents.mainFrame,
      };
      const data = {
        microformat: {
          microformatDataRenderer: {
            urlCanonical: 'https://music.youtube.com/watch?v=AAAAAAAAAAA',
            linkAlternates: [],
            pageOwnerDetails: { externalChannelId: 'UC' + 'a'.repeat(22) },
            tags: [],
          },
        },
        videoDetails: {
          videoId: 'AAAAAAAAAAA',
          title: 'Owned track',
          author: 'Owned artist',
          viewCount: '1',
          lengthSeconds: '100',
          elapsedSeconds: 10,
          isPaused: false,
          musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
          thumbnail: { thumbnails: [] },
        },
      };
      f.state.ipc.emit(f.module.SongInfoEvent.VideoSrcChanged, event, data);
      await f.flush();
      expect(f.requests).toHaveLength(1);
      expect(callbacks).toBe(1);
      const old = f.module.getCurrentSongInfoProvenance(f.state.window);
      if (retirement === 'invalid-raw')
        f.state.ipc.emit(f.module.SongInfoEvent.VideoSrcChanged, event, {
          videoDetails: { videoId: '' },
        });
      else f.state.window.webContents.emit('did-navigate');
      expect(f.module.getCurrentSongInfoProvenance(f.state.window)).not.toBe(
        old,
      );
      if (retirement === 'null-document')
        expect(
          f.module.getCurrentSongInfoProvenance(f.state.window),
        ).toBeNull();
      const count = f.state.activities.length;
      f.requests[0].resolve();
      await f.flush();
      expect(callbacks).toBe(1);
      expect(f.state.activities).toHaveLength(count);
      expect(f.state.activities.every((p: any) => !p.smallImageKey)).toBe(true);
    } finally {
      unsubscribe();
      dispose();
      await f.close();
    }
  });

test('the native menu option defaults off and stores only the artist option', async () => {
  const f = await discordArtworkFixture();
  try {
    const writes: any[] = [];
    const menu = await f.module.onMenu({
      window: f.state.window,
      getConfig: async () => f.config,
      setConfig: (v: any) => writes.push(v),
      refresh() {},
    });
    const item = menu.find(
      (v: any) => v.label === 'plugins.discord.menu.show-artist-image',
    );
    expect(item).toMatchObject({ type: 'checkbox', checked: false });
    item.click({ checked: true });
    expect(writes).toEqual([{ showArtistImage: true }]);
  } finally {
    await f.close();
  }
});

test('only strict public UC channel identities can cause artist lookups', async () => {
  const f = await discordArtworkFixture();
  try {
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    for (const artistUrl of [
      'http://music.youtube.com/channel/UC' + 'a'.repeat(22),
      'https://music.youtube.com.evil/channel/UC' + 'a'.repeat(22),
      'https://user:password@music.youtube.com/channel/UC' + 'a'.repeat(22),
      'https://music.youtube.com:123/channel/UC' + 'a'.repeat(22),
      'https://music.youtube.com/channel/UCshort',
      'https://music.youtube.com/channel/UC' + 'a'.repeat(22) + '?account=1',
      'https://music.youtube.com/channel/UC' + 'a'.repeat(22) + '#profile',
    ]) {
      f.state.now += 1000;
      f.admit(f.song({ artistUrl }));
      await f.flush();
    }
    expect(f.requests).toHaveLength(0);
    expect(f.state.activities.every((v: any) => !v.smallImageKey)).toBe(true);
  } finally {
    await f.close();
  }
});

test('decoded public og-image metadata accepts reordered attributes and safe HTML entities', async () => {
  const f = await discordArtworkFixture();
  try {
    f.html =
      "<head><meta CONTENT='https://yt3.ggpht.com/artist?a=1&amp;b=2' PROPERTY='og:image'></head>";
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song());
    await f.flush();
    expect(f.state.activities.at(-1).smallImageKey).toBe(
      'https://yt3.ggpht.com/artist?a=1&b=2',
    );
  } finally {
    await f.close();
  }
});

for (const image of [
  'http://yt3.ggpht.com/artist',
  'https://127.0.0.1/private',
  'https://yt3.ggpht.com.evil/artist',
  'https://name:password@yt3.ggpht.com/artist',
  'data:image/png,secret',
  'https://yt3.ggpht.com:123/artist',
  'https://yt3.ggpht.com/' + 'a'.repeat(2050),
  'https://yt3.ggpht.com/' + '가'.repeat(1000),
])
  test(`unsafe or oversized avatar metadata ${image.slice(0, 45)} falls back`, async () => {
    const f = await discordArtworkFixture();
    try {
      f.html =
        '<head><meta property="og:image" content="' + image + '"></head>';
      f.service.onConfigChange({ ...f.config, showArtistImage: true });
      f.admit(f.song());
      await f.flush();
      expect(f.requests).toHaveLength(1);
      expect(f.state.activities).toHaveLength(1);
      expect('smallImageKey' in f.state.activities[0]).toBe(false);
    } finally {
      await f.close();
    }
  });

for (const failure of [
  'network',
  'status',
  'missing',
  'script',
  'oversized',
  'utf8',
  'content-type',
] as const)
  test(`public ${failure} metadata failure leaves standard presence usable`, async () => {
    const f = await discordArtworkFixture();
    try {
      if (failure === 'network') f.failure = true;
      if (failure === 'status') f.status = 503;
      if (failure === 'missing')
        f.html = '<head><title>No avatar</title></head>';
      if (failure === 'script')
        f.html =
          '<head><script>const hidden="<meta property=\"og:image\" content=\"https://yt3.ggpht.com/private\">"</script></head>';
      if (failure === 'oversized')
        f.html =
          ' '.repeat(256 * 1024) +
          '<meta property="og:image" content="https://yt3.ggpht.com/beyond-budget">';
      if (failure === 'utf8')
        f.responseFactory = () =>
          new Response(new Uint8Array([255, 254]), {
            headers: { 'content-type': 'text/html' },
          });
      if (failure === 'content-type')
        f.responseFactory = () =>
          new Response('private JSON', {
            headers: { 'content-type': 'application/json' },
          });
      f.service.onConfigChange({ ...f.config, showArtistImage: true });
      f.admit(f.song());
      await f.flush();
      expect(f.requests).toHaveLength(1);
      expect(f.state.activities).toHaveLength(1);
      expect(f.state.activities[0]).toMatchObject({
        state: 'Owned artist',
        largeImageKey: 'https://i.ytimg.com/cover',
      });
      expect('smallImageKey' in f.state.activities[0]).toBe(false);
    } finally {
      await f.close();
    }
  });

test('negative cache stops progress storms and permits later public lookup recovery', async () => {
  const f = await discordArtworkFixture();
  try {
    f.failure = true;
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    const song = f.song();
    f.admit(song);
    await f.flush();
    for (let i = 0; i < 10; i++) {
      f.service.updateActivity(song);
      await f.flush();
    }
    expect(f.requests).toHaveLength(1);
    f.failure = false;
    f.state.now += 60001;
    f.service.updateActivity(song);
    await f.flush();
    expect(f.requests).toHaveLength(2);
    expect(f.state.activities.at(-1).smallImageKey).toBe(
      'https://yt3.googleusercontent.com/artist-avatar',
    );
  } finally {
    await f.close();
  }
});

test('artist cache is bounded to64, keeps recently used entries and expires positive artwork', async () => {
  const f = await discordArtworkFixture();
  try {
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    const artistUrl = (i: number) =>
      'https://music.youtube.com/channel/UC' + i.toString(16).padStart(22, '0');
    for (let i = 0; i < 67; i++) {
      f.state.now += 1000;
      f.admit(f.song({ artistUrl: artistUrl(i) }));
      await f.flush();
    }
    expect(f.requests).toHaveLength(67);
    f.admit(f.song({ artistUrl: artistUrl(66) }));
    await f.flush();
    expect(f.requests).toHaveLength(67);
    f.state.now += 1000;
    f.admit(f.song({ artistUrl: artistUrl(0) }));
    await f.flush();
    expect(f.requests).toHaveLength(68);
    f.state.now += 6 * 60 * 60 * 1000 + 1;
    f.admit(f.song({ artistUrl: artistUrl(66) }));
    await f.flush();
    expect(f.requests).toHaveLength(69);
  } finally {
    await f.close();
  }
});

test('coalesced progress and retired unabortable requests cannot fork physical capacity', async () => {
  const f = await discordArtworkFixture();
  try {
    f.hold = true;
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    const first = f.song();
    f.admit(first);
    await f.flush();
    for (let i = 0; i < 10; i++) f.service.updateActivity(first);
    await f.flush();
    expect(f.requests).toHaveLength(1);
    f.state.now += 1000;
    f.admit(
      f.song({
        artistUrl: 'https://music.youtube.com/channel/UC' + 'b'.repeat(22),
      }),
    );
    await f.flush();
    const third = f.song({
      artistUrl: 'https://music.youtube.com/channel/UC' + 'c'.repeat(22),
    });
    f.state.now += 1000;
    f.admit(third);
    await f.flush();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].options.signal.aborted).toBe(true);
    expect(f.requests[1].options.signal.aborted).toBe(true);
    f.requests[0].resolve();
    await f.flush();
    f.service.updateActivity(third);
    await f.flush();
    expect(f.requests).toHaveLength(3);
    f.requests[2].resolve();
    await f.flush();
    expect(f.state.activities.at(-1).smallImageKey).toBe(
      'https://yt3.googleusercontent.com/artist-avatar',
    );
  } finally {
    await f.close();
  }
});

test('public response stream is canceled immediately after valid head metadata', async () => {
  const f = await discordArtworkFixture();
  try {
    let pulls = 0,
      canceled = false;
    f.responseFactory = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(
              new TextEncoder().encode(
                pulls === 1
                  ? '<head><meta property="og:image" content="https://yt3.ggpht.com/stream">'
                  : 'x'.repeat(256 * 1024),
              ),
            );
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { 'content-type': 'text/html' } },
      );
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song());
    await f.flush();
    expect(f.state.activities.at(-1).smallImageKey).toBe(
      'https://yt3.ggpht.com/stream',
    );
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  } finally {
    await f.close();
  }
});

test('turning artwork off immediately restores the unchanged current cover and activity fields', async () => {
  const f = await discordArtworkFixture();
  try {
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song());
    await f.flush();
    const artist = f.state.activities.at(-1);
    expect(artist.smallImageKey).toBeTruthy();
    f.service.onConfigChange({ ...f.config, showArtistImage: false });
    await f.flush();
    const standard = f.state.activities.at(-1);
    const { smallImageKey, smallImageText, ...original } = artist;
    expect(standard).toEqual(original);
  } finally {
    await f.close();
  }
});

test('artist artwork is opt-in and the default standard activity stays identical', async () => {
  const f = await discordArtworkFixture();
  try {
    expect(f.module.plugin.config.showArtistImage).toBe(false);
    f.admit(f.song({ tags: ['Wrong tag'] }));
    await f.flush();
    expect(f.requests).toHaveLength(0);
    expect(f.state.activities).toHaveLength(1);
    expect(f.state.activities[0]).toMatchObject({
      details: 'Owned track',
      state: 'Owned artist',
      largeImageKey: 'https://i.ytimg.com/cover',
      largeImageText: 'Owned album',
      startTimestamp: 90,
      endTimestamp: 190,
    });
    expect('smallImageKey' in f.state.activities[0]).toBe(false);
  } finally {
    await f.close();
  }
});
test('enabled artwork uses one anonymous canonical public lookup and only adds current small artwork', async () => {
  const f = await discordArtworkFixture();
  try {
    f.service.onConfigChange({ ...f.config, showArtistImage: true });
    f.admit(f.song());
    await f.flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].url).toBe(
      'https://www.youtube.com/channel/UC' + 'a'.repeat(22) + '?ucbcb=1',
    );
    expect(f.requests[0].options).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    });
    const headers = new Headers(f.requests[0].options.headers);
    expect(headers.get('accept')).toBe('text/html');
    expect(headers.get('user-agent')).toBe(
      'Mozilla/5.0 (compatible; Discordbot/2.0; Pear Desktop public artist metadata)',
    );
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    expect(f.state.activities.at(-1)).toMatchObject({
      state: 'Owned artist',
      largeImageKey: 'https://i.ytimg.com/cover',
      smallImageKey: 'https://yt3.googleusercontent.com/artist-avatar',
      smallImageText: 'Owned artist',
    });
  } finally {
    await f.close();
  }
});
for (const retirement of [
  'raw-null',
  'same-id',
  'same-fields',
  'config',
  'disabled',
  'client',
  'window',
] as const)
  test(`late public artist lookup cannot publish after ${retirement} ownership retirement`, async () => {
    const f = await discordArtworkFixture();
    try {
      f.hold = true;
      f.service.onConfigChange({ ...f.config, showArtistImage: true });
      f.admit(f.song());
      await f.flush();
      expect(f.requests).toHaveLength(1);
      if (retirement === 'raw-null') f.state.current = null;
      if (retirement === 'same-id')
        f.admit(
          f.song({
            title: 'New metadata',
            artistUrl: 'https://music.youtube.com/channel/UC' + 'b'.repeat(22),
          }),
        );
      if (retirement === 'same-fields')
        f.admit(f.song({ title: 'New admission, same artist and video' }));
      if (retirement === 'config')
        f.service.onConfigChange({ ...f.config, showArtistImage: false });
      if (retirement === 'disabled')
        f.service.onConfigChange({
          ...f.config,
          showArtistImage: true,
          enabled: false,
        });
      if (retirement === 'client') f.service.disconnect();
      if (retirement === 'window') {
        f.state.window.destroyed = true;
        f.state.window.emit('closed');
      }
      const count = f.state.activities.length;
      f.requests[0].resolve();
      await f.flush();
      expect(f.state.activities).toHaveLength(count);
      expect(f.state.activities.every((a: any) => !a.smallImageKey)).toBe(true);
    } finally {
      await f.close();
    }
  });
