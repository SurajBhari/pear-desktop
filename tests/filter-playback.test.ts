import { test, expect, type Page } from '@playwright/test';
import { filterBundle } from './helpers/filter-bundle';

async function fixture(page: Page) {
  await page.setContent(
    '<video></video><ytmusic-player-bar></ytmusic-player-bar><ytmusic-popup-container></ytmusic-popup-container>',
  );
  await page.addScriptTag({ content: await filterBundle() });
  await page.evaluate(() => {
    const w = window as any;
    w.state = {
      id: 'A',
      responseId: 'A',
      title: 'Song (Live)',
      author: 'Blocked - Topic',
      channelId: 'UCblocked',
      index: 0,
      skips: [],
    };
    w.metadata = {
      videoId: 'A',
      title: w.state.title,
      artist: w.state.author,
      artistUrl: 'https://music.youtube.com/channel/UCblocked',
    };
    w.handlers = new Set();
    w.subscribers = new Set();
    w.writes = [];
    w.api = {
      getVideoData: () => ({
        video_id: w.state.id,
        title: w.state.title,
        author: w.state.author,
      }),
      getPlayerResponse: () => ({
        videoDetails: {
          videoId: w.state.responseId,
          title: w.state.title,
          author: w.state.author,
          channelId: w.state.channelId,
        },
      }),
      getPlaylistIndex: () => w.state.index,
      addEventListener: (_: string, fn: any) => w.handlers.add(fn),
      removeEventListener: (_: string, fn: any) => w.handlers.delete(fn),
      nextVideo: () => w.state.skips.push(w.state.id),
    };
    w.context = (config: any) => ({
      getConfig: async () => config,
      setConfig: async (value: any) => w.writes.push(value),
      ipc: {
        subscribe: (_: string, fn: any) => {
          w.subscribers.add(fn);
          return () => w.subscribers.delete(fn);
        },
      },
    });
    w.announce = (
      name = 'dataloaded',
      data = {
        videoId: w.state.id,
        title: w.state.title,
        author: w.state.author,
      },
    ) => {
      for (const fn of [...w.handlers]) fn(name, data);
    };
    w.publish = (data = w.metadata) => {
      w.metadata = data;
      for (const fn of [...w.subscribers]) fn(data);
    };
  });
}

for (const plugin of ['blocklist', 'live']) {
  test(`${plugin} skips current eligible playback once, rearming after another track`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      await p.renderer.start(
        w.context({
          enabled: true,
          blockedArtists: [{ name: 'blocked', channelId: 'UCblocked' }],
        }),
      );
      p.renderer.onPlayerApiReady(w.api);
      w.announce();
      w.announce('dataupdated');
      w.publish();
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Ordinary Song';
      w.state.author = 'Allowed';
      w.state.channelId = 'UCallowed';
      w.announce();
      w.state.id = w.state.responseId = 'A';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked - Topic';
      w.state.channelId = 'UCblocked';
      w.announce();
      p.renderer.stop();
      return w.state.skips;
    }, plugin);
    expect(result).toEqual(['A', 'A']);
  });
  test(`${plugin} pending native identity cannot skip stale or getter-lag playback`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.state.channelId = 'UCallowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      w.announce('dataloaded', {
        videoId: 'B',
        title: 'Song (Live)',
        author: 'Blocked',
      });
      w.publish({ videoId: 'A', title: 'Song (Live)', artist: 'Blocked' });
      const before = w.state.skips.length;
      w.state.id = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.publish({ videoId: 'B', title: 'Song (Live)', artist: 'Blocked' });
      const oneGetter = w.state.skips.length;
      w.state.responseId = 'B';
      document
        .querySelector('video')!
        .dispatchEvent(new Event('loadedmetadata'));
      const after = w.state.skips.slice();
      p.renderer.stop();
      return { before, oneGetter, after };
    }, plugin);
    expect(result).toEqual({ before: 0, oneGetter: 0, after: ['B'] });
  });
  test(`${plugin} stop removes owned listeners and fences retained callbacks and late startup`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      const retained = [...w.handlers, ...w.subscribers];
      p.renderer.stop();
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      for (const fn of retained)
        fn('dataloaded', {
          videoId: 'A',
          title: 'Song (Live)',
          author: 'Blocked',
        });
      let release: any;
      const config = new Promise((r) => (release = r));
      const start = p.renderer.start({
        ...w.context({}),
        getConfig: () => config,
      });
      p.renderer.stop();
      release({ enabled: true, blockedArtists: [{ name: 'Blocked' }] });
      await start;
      p.renderer.onPlayerApiReady(w.api);
      const result = {
        skips: w.state.skips,
        listeners: w.handlers.size + w.subscribers.size,
      };
      p.renderer.stop();
      return result;
    }, plugin);
    expect(result).toEqual({ skips: [], listeners: 0 });
  });
}

test('live filtering excludes ordinary city, radio, demo, acoustic and Live song titles', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.live;
    await p.renderer.start(w.context({ enabled: true }));
    w.state.title = 'Live Forever';
    w.metadata = { videoId: 'A', title: w.state.title, artist: 'Allowed' };
    p.renderer.onPlayerApiReady(w.api);
    for (const title of [
      'Paris',
      'Radio',
      'Demo',
      'Acoustic',
      'Live and Let Die',
      'Live in the Moment',
    ]) {
      w.state.id = w.state.responseId = title;
      w.state.title = title;
      w.announce();
    }
    for (const title of [
      'Song [Live]',
      'Song - Live',
      'Song (Live at Wembley)',
      'Песня (концертная запись)',
    ]) {
      w.state.id = w.state.responseId = title;
      w.state.title = title;
      w.announce();
    }
    p.renderer.stop();
    return w.state.skips;
  });
  expect(result).toEqual([
    'Song [Live]',
    'Song - Live',
    'Song (Live at Wembley)',
    'Песня (концертная запись)',
  ]);
});

test('both filters claim one native skip rather than advancing twice', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    for (const p of [w.FilterFixture.blocklist, w.FilterFixture.live]) {
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
    }
    w.announce();
    w.publish();
    const result = w.state.skips.slice();
    for (const p of [w.FilterFixture.blocklist, w.FilterFixture.live])
      p.renderer.stop();
    return result;
  });
  expect(result).toEqual(['A']);
});

test('known channel identity avoids same-name collisions and malformed lists stay inactive', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist;
    await p.renderer.start(
      w.context({
        enabled: true,
        blockedArtists: [
          null,
          { name: 123 },
          { name: 'Blocked', channelId: 'UCother' },
        ],
      }),
    );
    p.renderer.onPlayerApiReady(w.api);
    const before = w.state.skips.length;
    p.renderer.onConfigChange({
      enabled: true,
      blockedArtists: [{ name: 'Alias', channelId: 'UCblocked' }],
    });
    p.renderer.stop();
    return { before, after: w.state.skips };
  });
  expect(result).toEqual({ before: 0, after: ['A'] });
});

for (const name of ['blocklist', 'live']) {
  test(`${name} replacement media waits for the new element's native readiness`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.state.channelId = 'UCallowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      document
        .querySelector('video')!
        .replaceWith(document.createElement('video'));
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.publish({ videoId: 'A', title: 'Song (Live)', artist: 'Blocked' });
      const before = w.state.skips.length;
      document
        .querySelector('video')!
        .dispatchEvent(new Event('loadedmetadata'));
      const after = w.state.skips.slice();
      p.renderer.stop();
      return { before, after };
    }, name);
    expect(result).toEqual({ before: 0, after: ['A'] });
  });
  test(`${name} a disabled config stops eligibility before lifecycle teardown`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      p.renderer.onConfigChange?.({
        enabled: false,
        blockedArtists: [{ name: 'Blocked' }],
      });
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.announce();
      p.renderer.stop();
      return w.state.skips;
    }, name);
    expect(result).toEqual([]);
  });
}

for (const queueId of ['A', 'Stale']) {
  test(`structured collaborator identity only applies to its keyed queue item (${queueId})`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (queueId) => {
      const w = window as any,
        p = w.FilterFixture.blocklist;
      w.state.title = 'Studio';
      w.state.author = 'First';
      w.state.channelId = 'UCfirst';
      w.metadata = {
        videoId: 'A',
        title: 'Studio',
        artist: 'First',
        artistUrl: '/channel/UCfirst',
      };
      (document.querySelector('ytmusic-player-bar') as any).getState = () => ({
        queue: {
          selectedItemIndex: 0,
          items: [
            {
              playlistPanelVideoRenderer: {
                videoId: queueId,
                longBylineText: {
                  runs: [
                    {
                      text: 'First',
                      navigationEndpoint: {
                        browseEndpoint: { browseId: 'UCfirst' },
                      },
                    },
                    { text: ' & ' },
                    {
                      text: 'Second',
                      navigationEndpoint: {
                        browseEndpoint: { browseId: 'UCsecond' },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      await p.renderer.start(
        w.context({
          enabled: true,
          blockedArtists: [{ name: 'Second', channelId: 'UCsecond' }],
        }),
      );
      p.renderer.onPlayerApiReady(w.api);
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, queueId);
    expect(result).toEqual(queueId === 'A' ? ['A'] : []);
  });
}

for (const name of ['blocklist', 'live']) {
  test(`${name} current config watch wins over an older pending startup read`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      let release: any;
      const gate = new Promise((r) => (release = r));
      const start = p.renderer.start({
        ...w.context({}),
        getConfig: () => gate,
      });
      p.renderer.onConfigChange?.({
        enabled: true,
        blockedArtists: [{ name: 'Blocked' }],
      });
      release({ enabled: false, blockedArtists: [] });
      await start;
      p.renderer.onPlayerApiReady(w.api);
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual(['A']);
  });
}

for (const name of ['blocklist', 'live']) {
  test(`${name} unknown begin fences old metadata even while both getters lag`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      w.announce('dataloaded', {});
      w.publish({
        videoId: 'A',
        title: 'Song (Live)',
        alternativeTitle: 'Song (Live)',
        artist: 'Blocked',
      });
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual([]);
  });
  test(`${name} repeated ready hook retains an authoritative pending new identity`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      w.announce('dataloaded', {
        videoId: 'B',
        title: 'Song (Live)',
        author: 'Blocked',
      });
      p.renderer.onPlayerApiReady(w.api);
      w.publish({
        videoId: 'A',
        title: 'Song (Live)',
        alternativeTitle: 'Song (Live)',
        artist: 'Blocked',
      });
      const before = w.state.skips.length;
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      document
        .querySelector('video')!
        .dispatchEvent(new Event('loadedmetadata'));
      const result = { before, after: w.state.skips.slice() };
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual({ before: 0, after: ['B'] });
  });
  test(`${name} config wait observes the owned document begin before late API ready`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      let release: any;
      const gate = new Promise((r) => (release = r));
      const start = p.renderer.start({
        ...w.context({}),
        getConfig: () => gate,
      });
      document.dispatchEvent(
        new CustomEvent('videodatachange', {
          detail: {
            name: 'dataloaded',
            videoData: {
              videoId: 'B',
              title: 'Song (Live)',
              author: 'Blocked',
            },
          },
        }),
      );
      release({ enabled: true, blockedArtists: [{ name: 'Blocked' }] });
      await start;
      p.renderer.onPlayerApiReady(w.api);
      w.publish({
        videoId: 'A',
        title: 'Song (Live)',
        alternativeTitle: 'Song (Live)',
        artist: 'Blocked',
      });
      const before = w.state.skips.length;
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      document
        .querySelector('video')!
        .dispatchEvent(new Event('loadedmetadata'));
      const result = { before, after: w.state.skips.slice() };
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual({ before: 0, after: ['B'] });
  });
}

for (const name of ['blocklist', 'live']) {
  test(`${name} same-player ready does not rearm emptied media`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
      document.querySelector('video')!.dispatchEvent(new Event('emptied'));
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.announce();
      p.renderer.onPlayerApiReady(w.api);
      const before = w.state.skips.length;
      document
        .querySelector('video')!
        .dispatchEvent(new Event('loadedmetadata'));
      const result = { before, after: w.state.skips.slice() };
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual({ before: 0, after: ['B'] });
  });
  test(`${name} retained old API callback cannot replace the new owner's current identity`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      w.state.title = 'Ordinary';
      w.state.author = 'Allowed';
      w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
      await p.renderer.start(w.context({ enabled: false, blockedArtists: [] }));
      p.renderer.onPlayerApiReady(w.api);
      w.announce();
      const old = [...w.handlers][0];
      const current = new Set();
      const next = {
        ...w.api,
        addEventListener: (_: string, fn: any) => current.add(fn),
        removeEventListener: (_: string, fn: any) => current.delete(fn),
      };
      w.state.id = w.state.responseId = 'B';
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.metadata = { videoId: 'B', title: 'Song (Live)', artist: 'Blocked' };
      p.renderer.onPlayerApiReady(next);
      old('dataloaded', { videoId: 'A', title: 'Ordinary', author: 'Allowed' });
      p.renderer.onConfigChange({
        enabled: true,
        blockedArtists: [{ name: 'Blocked' }],
      });
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual(['B']);
  });
}

for (const name of ['blocklist', 'live']) {
  test(`${name} fresh hot enable owns a new playback claim after its last owner stops`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (name) => {
      const w = window as any,
        p = w.FilterFixture[name];
      const context = w.context({
        enabled: true,
        blockedArtists: [{ name: 'Blocked' }],
      });
      await p.renderer.start(context);
      p.renderer.onPlayerApiReady(w.api);
      p.renderer.stop();
      await p.renderer.start(context);
      p.renderer.onPlayerApiReady(w.api);
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, name);
    expect(result).toEqual(['A', 'A']);
  });
}

test('stopping one of two filters retains the remaining owner claim', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      block = w.FilterFixture.blocklist,
      live = w.FilterFixture.live;
    for (const p of [block, live]) {
      await p.renderer.start(
        w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
      );
      p.renderer.onPlayerApiReady(w.api);
    }
    block.renderer.stop();
    w.publish();
    live.renderer.onPlayerApiReady(w.api);
    const before = w.state.skips.length;
    live.renderer.stop();
    await block.renderer.start(
      w.context({ enabled: true, blockedArtists: [{ name: 'Blocked' }] }),
    );
    block.renderer.onPlayerApiReady(w.api);
    const after = w.state.skips.slice();
    block.renderer.stop();
    return { before, after };
  });
  expect(result).toEqual({ before: 1, after: ['A', 'A'] });
});
