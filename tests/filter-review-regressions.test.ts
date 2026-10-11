// Actual-source regression witnesses adapted from the independent F1-F5/P3 review.
import { test, expect } from '@playwright/test';
import { filterBundle } from './helpers/filter-bundle';

async function fixture(page: any) {
  await page.setContent(
    '<video></video><ytmusic-player-bar></ytmusic-player-bar><ytmusic-popup-container></ytmusic-popup-container>',
  );
  await page.addScriptTag({ content: await filterBundle() });
  await page.evaluate(() => {
    const w = window as any;
    w.state = {
      id: 'A',
      responseId: 'A',
      title: 'Studio',
      author: 'Twin',
      channelId: undefined,
      index: 0,
      skips: [],
    };
    w.metadata = { videoId: 'A', title: 'Studio', artist: 'Twin' };
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
      addEventListener: (_: string, f: any) => w.handlers.add(f),
      removeEventListener: (_: string, f: any) => w.handlers.delete(f),
      nextVideo: () => w.state.skips.push([w.state.id, w.state.index]),
    };
    w.context = (config: any) => ({
      getConfig: async () => config,
      setConfig: async (v: any) => w.writes.push(v),
      ipc: {
        subscribe: (_: string, f: any) => {
          w.subscribers.add(f);
          return () => w.subscribers.delete(f);
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
      for (const f of [...w.handlers]) f(name, data);
    };
  });
}

for (const wrapped of [false, true])
  test(`identified same-name keyed queue artist never falls back to blocked name (wrapped=${wrapped})`, async ({
    page,
  }) => {
    await fixture(page);
    const skips = await page.evaluate(async (wrapped) => {
      const w = window as any;
      const item = {
        videoId: 'A',
        longBylineText: {
          runs: [
            {
              text: 'Twin',
              navigationEndpoint: {
                browseEndpoint: { browseId: 'UCbbbbbbbbbbbbbbbbbbbbbb' },
              },
            },
          ],
        },
      };
      (document.querySelector('ytmusic-player-bar') as any).getState = () => ({
        queue: {
          selectedItemIndex: 0,
          items: [
            wrapped
              ? {
                  playlistPanelVideoWrapperRenderer: {
                    primaryRenderer: { playlistPanelVideoRenderer: item },
                  },
                }
              : { playlistPanelVideoRenderer: item },
          ],
        },
      });
      const p = w.FilterFixture.blocklist;
      await p.renderer.start(
        w.context({
          enabled: true,
          blockedArtists: [
            { name: 'Twin', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' },
          ],
        }),
      );
      p.renderer.onPlayerApiReady(w.api);
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, wrapped);
    expect(skips).toEqual([]);
  });
for (const artistUrl of [
  'https://unrelated.invalid/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
  'https://music.youtube.com/watch?v=A&next=/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
])
  test(`nonartist URI cannot replace native identity (${artistUrl})`, async ({
    page,
  }) => {
    await fixture(page);
    const skips = await page.evaluate(async (artistUrl) => {
      const w = window as any;
      w.state.author = 'Allowed';
      w.state.channelId = 'UCbbbbbbbbbbbbbbbbbbbbbb';
      w.metadata = {
        videoId: 'A',
        artist: 'Allowed',
        title: 'Studio',
        artistUrl,
      };
      const p = w.FilterFixture.blocklist;
      await p.renderer.start(
        w.context({
          enabled: true,
          blockedArtists: [
            { name: 'Blocked', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' },
          ],
        }),
      );
      p.renderer.onPlayerApiReady(w.api);
      const result = w.state.skips.slice();
      p.renderer.stop();
      return result;
    }, artistUrl);
    expect(skips).toEqual([]);
  });
test('a watch URL carrying channel-like query text never creates an artist popup action', async ({
  page,
}) => {
  await fixture(page);
  const count = await page.evaluate(async () => {
    const w = window as any;
    document.querySelector('ytmusic-player-bar')!.innerHTML =
      '<a href="/channel/UCaaaaaaaaaaaaaaaaaaaaaa">Blocked</a>';
    document.querySelector('ytmusic-popup-container')!.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox><a id="navigation-endpoint" href="/watch?v=Other&next=/channel/UCaaaaaaaaaaaaaaaaaaaaaa">Watch other song</a></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const endpoint = document.querySelector('#navigation-endpoint') as any;
    endpoint.data = { watchEndpoint: { videoId: 'Other' } };
    const p = w.FilterFixture.blocklist;
    await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
    p.renderer.onPlayerApiReady(w.api);
    await Promise.resolve();
    const count = document.querySelectorAll('.blocklist-injected').length;
    p.renderer.stop();
    return count;
  });
  expect(count).toBe(0);
});
test('shared claims rearm for another native playback of the same video at the next queue position', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    w.state.title = 'Song (Live)';
    w.state.author = 'Blocked';
    w.state.channelId = 'UCaaaaaaaaaaaaaaaaaaaaaa';
    w.metadata = {
      videoId: 'A',
      title: w.state.title,
      artist: 'Blocked',
      artistUrl: '/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    };
    const item = {
      videoId: 'A',
      longBylineText: {
        runs: [
          {
            text: 'Blocked',
            navigationEndpoint: {
              browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' },
            },
          },
        ],
      },
    };
    (document.querySelector('ytmusic-player-bar') as any).getState = () => ({
      queue: {
        selectedItemIndex: w.state.index,
        items: [
          { playlistPanelVideoRenderer: item },
          { playlistPanelVideoRenderer: item },
        ],
      },
    });
    const a = w.FilterFixture.blocklist,
      b = w.FilterFixture.live;
    await a.renderer.start(
      w.context({
        enabled: true,
        blockedArtists: [
          { name: 'Blocked', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' },
        ],
      }),
    );
    a.renderer.onPlayerApiReady(w.api);
    await b.renderer.start(w.context({ enabled: true }));
    b.renderer.onPlayerApiReady(w.api);
    const first = w.state.skips.slice();
    w.announce('dataupdated');
    const duplicate = w.state.skips.slice();
    const video = document.querySelector('video')!;
    video.dispatchEvent(new Event('emptied', { bubbles: true }));
    w.state.index = 1;
    document.dispatchEvent(
      new CustomEvent('videodatachange', { detail: { name: 'dataloaded' } }),
    );
    w.announce('dataloaded');
    video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }));
    const replay = w.state.skips.slice();
    a.renderer.stop();
    b.renderer.stop();
    return { first, duplicate, replay };
  });
  expect(result.first).toEqual([['A', 0]]);
  expect(result.duplicate).toEqual([['A', 0]]);
  expect(result.replay).toEqual([
    ['A', 0],
    ['A', 1],
  ]);
});
test('unsafe artist label stays text and owned keyboard click persists the real identity', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const w = window as any;
    const bar = document.querySelector('ytmusic-player-bar')!;
    const link = document.createElement('a');
    link.className = 'yt-simple-endpoint';
    link.href = '/channel/UCbbbbbbbbbbbbbbbbbbbbbb';
    link.textContent =
      '<img src=x onerror="window.polluted=true"> & <script>bad</script>';
    bar.append(link);
    const popup = document.querySelector('ytmusic-popup-container')!;
    popup.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (popup.firstElementChild as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    const p = w.FilterFixture.blocklist;
    await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
    p.renderer.onPlayerApiReady(w.api);
  });
  const button = page.locator('.blocklist-injected');
  await expect(button).toHaveCount(1);
  await button.focus();
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => ({
      polluted: (window as any).polluted,
      images: document.querySelectorAll('.blocklist-injected img').length,
      writes: (window as any).writes,
    })),
  ).toEqual({
    polluted: undefined,
    images: 0,
    writes: [
      {
        blockedArtists: [
          {
            name: '<img src=x onerror="window.polluted=true"> & <script>bad</script>',
            channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb',
          },
        ],
      },
    ],
  });
  await page.evaluate(() =>
    (window as any).FilterFixture.blocklist.renderer.stop(),
  );
});

test('a disabled config watch cancels popup writes still queued before admission', async ({
  page,
}) => {
  await fixture(page);
  const writes = await page.evaluate(async () => {
    const w = window as any;
    w.state.author = 'Allowed';
    w.state.channelId = 'UCbbbbbbbbbbbbbbbbbbbbbb';
    w.metadata = {
      videoId: 'A',
      artist: 'Allowed',
      title: 'Studio',
      artistUrl: '/channel/UCbbbbbbbbbbbbbbbbbbbbbb',
    };
    document.querySelector('ytmusic-player-bar')!.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCbbbbbbbbbbbbbbbbbbbbbb">Allowed</a>';
    const popup = document.querySelector('ytmusic-popup-container')!;
    popup.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (popup.firstElementChild as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    const p = w.FilterFixture.blocklist;
    await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
    p.renderer.onPlayerApiReady(w.api);
    (
      document.querySelector('.blocklist-injected') as HTMLButtonElement
    ).click();
    p.renderer.onConfigChange({ enabled: false, blockedArtists: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = w.writes.slice();
    p.renderer.stop();
    return result;
  });
  expect(writes).toEqual([]);
});

test('an old popup save completion cannot close a replacement unrelated popup', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    w.state.author = 'Allowed';
    w.state.channelId = 'UCbbbbbbbbbbbbbbbbbbbbbb';
    w.metadata = {
      videoId: 'A',
      artist: 'Allowed',
      title: 'Studio',
      artistUrl: '/channel/UCbbbbbbbbbbbbbbbbbbbbbb',
    };
    document.querySelector('ytmusic-player-bar')!.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCbbbbbbbbbbbbbbbbbbbbbb">Allowed</a>';
    const first = document.querySelector('ytmusic-popup-container')!;
    first.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (first.firstElementChild as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    let release!: () => void;
    let admitted = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const context = w.context({ enabled: true, blockedArtists: [] });
    context.setConfig = async (value: any) => {
      w.writes.push(value);
      admitted = true;
      await gate;
    };
    const p = w.FilterFixture.blocklist;
    await p.renderer.start(context);
    p.renderer.onPlayerApiReady(w.api);
    const oldButton = document.querySelector(
      '.blocklist-injected',
    ) as HTMLButtonElement;
    oldButton.click();
    while (!admitted) await Promise.resolve();
    first.remove();
    const next = document.createElement('ytmusic-popup-container');
    next.innerHTML =
      '<tp-yt-iron-dropdown><ytmusic-menu-popup-renderer><tp-yt-paper-listbox><a id="navigation-endpoint" href="/watch?v=Other">Other song</a></tp-yt-paper-listbox></ytmusic-menu-popup-renderer></tp-yt-iron-dropdown>';
    document.body.append(next);
    let closed = 0;
    (next.querySelector('tp-yt-iron-dropdown') as any).close = () => closed++;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oldConnected = oldButton.isConnected;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = { closed, oldConnected, writes: w.writes.length };
    p.renderer.stop();
    return result;
  });
  expect(result.oldConnected).toBe(false);
  expect(result.writes).toBe(1);
  expect(result.closed).toBe(0);
});

test('malformed array title data never becomes a live marker over a confirmed studio native title', async ({
  page,
}) => {
  await fixture(page);
  const skips = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.live;
    await p.renderer.start(w.context({ enabled: true }));
    p.renderer.onPlayerApiReady(w.api);
    w.announce('dataupdated', { videoId: 'A', title: ['Song (Live)'] });
    const result = w.state.skips.slice();
    p.renderer.stop();
    return result;
  });
  expect(skips).toEqual([]);
});

for (const artist of [['Allowed'], '   '])
  test(`fallback popup never persists an unsupported artist label ${JSON.stringify(artist)}`, async ({
    page,
  }) => {
    await fixture(page);
    const writes = await page.evaluate(async (artist) => {
      const w = window as any;
      w.state.author = 'Allowed';
      w.state.channelId = 'UCbbbbbbbbbbbbbbbbbbbbbb';
      w.metadata = {
        videoId: 'A',
        artist,
        title: 'Studio',
        artistUrl: '/channel/UCbbbbbbbbbbbbbbbbbbbbbb',
      };
      const popup = document.querySelector('ytmusic-popup-container')!;
      popup.innerHTML =
        '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
      const sink = document.createElement('ytmusic-menu-renderer');
      sink.className = 'ytmusic-player-bar';
      (popup.firstElementChild as any).ytEventForwardingBehavior = {
        forwarder_: { eventSink: sink },
      };
      const p = w.FilterFixture.blocklist;
      await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
      p.renderer.onPlayerApiReady(w.api);
      (
        document.querySelector(
          '.blocklist-injected',
        ) as HTMLButtonElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = w.writes.slice();
      p.renderer.stop();
      return result;
    }, artist);
    expect(
      writes.every((patch: any) =>
        patch.blockedArtists.every(
          (record: any) =>
            typeof record.name === 'string' && record.name.trim().length > 0,
        ),
      ),
    ).toBe(true);
  });

for (const failure of ['native index', 'queue identity', 'duplicate begin'])
  test(`shared replay epoch requires agreement: ${failure}`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (failure) => {
      const w = window as any;
      w.state.title = 'Song (Live)';
      w.state.author = 'Blocked';
      w.state.channelId = 'UCblocked';
      w.metadata = { videoId: 'A', title: w.state.title, artist: 'Blocked' };
      w.nativeIndex = 0;
      w.queueVideo = 'A';
      w.api.getPlaylistIndex = () => w.nativeIndex;
      (document.querySelector('ytmusic-player-bar') as any).getState = () => ({
        queue: {
          selectedItemIndex: w.state.index,
          items: [0, 1].map(() => ({
            playlistPanelVideoRenderer: { videoId: w.queueVideo },
          })),
        },
      });
      const a = w.FilterFixture.blocklist,
        b = w.FilterFixture.live;
      for (const p of [a, b]) {
        await p.renderer.start(
          w.context({
            enabled: true,
            blockedArtists: [{ name: 'Blocked', channelId: 'UCblocked' }],
          }),
        );
        p.renderer.onPlayerApiReady(w.api);
      }
      const video = document.querySelector('video')!;
      if (failure !== 'duplicate begin') {
        video.dispatchEvent(new Event('emptied'));
        w.state.index = 1;
        w.nativeIndex = failure === 'native index' ? 0 : 1;
        w.queueVideo = failure === 'queue identity' ? 'Other' : 'A';
      }
      w.announce('dataloaded');
      video.dispatchEvent(new Event('loadedmetadata'));
      w.announce('dataloaded');
      w.announce('dataupdated');
      a.renderer.onPlayerApiReady(w.api);
      b.renderer.onPlayerApiReady(w.api);
      const invalid = w.state.skips.slice();
      if (failure !== 'duplicate begin') {
        w.nativeIndex = 1;
        w.queueVideo = 'A';
        w.announce('dataloaded');
        w.announce('dataupdated');
        video.dispatchEvent(new Event('loadedmetadata'));
      }
      const confirmed = w.state.skips.slice();
      a.renderer.stop();
      b.renderer.stop();
      return { invalid, confirmed };
    }, failure);
    expect(result.invalid).toEqual([['A', 0]]);
    expect(result.confirmed).toEqual(
      failure === 'duplicate begin'
        ? [['A', 0]]
        : [
            ['A', 0],
            ['A', 1],
          ],
    );
  });

test('a confirmed new media playback at the same keyed queue item rearms once', async ({
  page,
}) => {
  await fixture(page);
  const skips = await page.evaluate(async () => {
    const w = window as any;
    w.state.title = 'Song (Live)';
    w.metadata = { videoId: 'A', artist: 'Twin', title: w.state.title };
    (document.querySelector('ytmusic-player-bar') as any).getState = () => ({
      queue: {
        selectedItemIndex: 0,
        items: [{ playlistPanelVideoRenderer: { videoId: 'A' } }],
      },
    });
    const p = w.FilterFixture.live;
    await p.renderer.start(w.context({ enabled: true }));
    p.renderer.onPlayerApiReady(w.api);
    const v = document.querySelector('video')!;
    v.dispatchEvent(new Event('emptied'));
    w.announce('dataloaded');
    v.dispatchEvent(new Event('loadedmetadata'));
    v.dispatchEvent(new Event('loadedmetadata'));
    w.announce('dataloaded');
    const result = w.state.skips.slice();
    p.renderer.stop();
    return result;
  });
  expect(skips).toEqual([
    ['A', 0],
    ['A', 0],
  ]);
});

for (const retirement of ['restart', 'popup', 'item'])
  test(`queued popup addition is canceled on ${retirement} before write admission`, async ({
    page,
  }) => {
    await fixture(page);
    const writes = await page.evaluate(async (retirement) => {
      const w = window as any;
      document.querySelector('ytmusic-player-bar')!.innerHTML =
        '<a class="yt-simple-endpoint" href="/channel/UCallowed">Allowed</a>';
      const popup = document.querySelector('ytmusic-popup-container')!;
      popup.innerHTML =
        '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
      const sink = document.createElement('ytmusic-menu-renderer');
      sink.className = 'ytmusic-player-bar';
      (popup.firstElementChild as any).ytEventForwardingBehavior = {
        forwarder_: { eventSink: sink },
      };
      const p = w.FilterFixture.blocklist;
      await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
      p.renderer.onPlayerApiReady(w.api);
      (
        document.querySelector('.blocklist-injected') as HTMLButtonElement
      ).click();
      if (retirement === 'restart') {
        p.renderer.stop();
        await p.renderer.start(
          w.context({ enabled: true, blockedArtists: [] }),
        );
        p.renderer.onPlayerApiReady(w.api);
      } else if (retirement === 'popup') popup.remove();
      else w.state.id = w.state.responseId = 'B';
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = w.writes.slice();
      p.renderer.stop();
      return result;
    }, retirement);
    expect(writes).toEqual([]);
  });

test('canceling all queued popup additions restores the persisted list before the next popup', async ({
  page,
}) => {
  await fixture(page);
  const writes = await page.evaluate(async () => {
    const w = window as any,
      bar = document.querySelector('ytmusic-player-bar')!,
      p = w.FilterFixture.blocklist;
    const open = () => {
      const popup = document.createElement('ytmusic-popup-container');
      popup.innerHTML =
        '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
      const sink = document.createElement('ytmusic-menu-renderer');
      sink.className = 'ytmusic-player-bar';
      (popup.firstElementChild as any).ytEventForwardingBehavior = {
        forwarder_: { eventSink: sink },
      };
      document.body.append(popup);
      return popup;
    };
    document.querySelector('ytmusic-popup-container')!.remove();
    bar.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCfirst">First</a><a class="yt-simple-endpoint" href="/channel/UCsecond">Second</a>';
    const old = open();
    await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
    p.renderer.onPlayerApiReady(w.api);
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '.blocklist-injected',
    ))
      button.click();
    old.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    bar.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCthird">Third</a>';
    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (
      document.querySelector('.blocklist-injected') as HTMLButtonElement
    ).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = w.writes.slice();
    p.renderer.stop();
    return result;
  });
  expect(writes).toEqual([
    { blockedArtists: [{ name: 'Third', channelId: 'UCthird' }] },
  ]);
});

// F6: independent mixed admission/cancellation witness and its all-valid control.
for (const canceled of [false, true])
  test(`mixed admitted/queued additions exclude retired popup prefix (cancel=${canceled})`, async ({
    page,
  }) => {
    await fixture(page);
    const result = await page.evaluate(async (canceled) => {
      const w = window as any,
        p = w.FilterFixture.blocklist,
        bar = document.querySelector('ytmusic-player-bar')!;
      const open = (entries: { name: string; id: string }[]) => {
        document.querySelector('ytmusic-popup-container')?.remove();
        bar.innerHTML = '';
        for (const item of entries) {
          const a = document.createElement('a');
          a.className = 'yt-simple-endpoint';
          a.href = '/channel/' + item.id;
          a.textContent = item.name;
          bar.append(a);
        }
        const popup = document.createElement('ytmusic-popup-container');
        popup.innerHTML =
          '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
        const sink = document.createElement('ytmusic-menu-renderer');
        sink.className = 'ytmusic-player-bar';
        (popup.firstElementChild as any).ytEventForwardingBehavior = {
          forwarder_: { eventSink: sink },
        };
        document.body.append(popup);
        return popup;
      };
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let admitted = false;
      const ctx = w.context({ enabled: true, blockedArtists: [] });
      ctx.setConfig = async (value: any) => {
        w.writes.push(value);
        if (w.writes.length === 1) {
          admitted = true;
          await gate;
        }
      };
      open([
        { name: 'Persisted', id: 'UCpersisted' },
        { name: 'Retired', id: 'UCretired' },
        { name: 'Current', id: 'UCcurrent' },
      ]);
      await p.renderer.start(ctx);
      p.renderer.onPlayerApiReady(w.api);
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.blocklist-injected'),
      );
      buttons[0].click();
      while (!admitted) await Promise.resolve();
      buttons[1].click();
      if (canceled) {
        open([{ name: 'Current', id: 'UCcurrent' }]);
        await new Promise((done) => setTimeout(done, 0));
        (
          document.querySelector('.blocklist-injected') as HTMLButtonElement
        ).click();
      } else buttons[2].click();
      release();
      await new Promise((done) => setTimeout(done, 0));
      await new Promise((done) => setTimeout(done, 0));
      const result = w.writes.slice();
      p.renderer.stop();
      return result;
    }, canceled);
    console.log(JSON.stringify({ canceled, result }));
    const persisted = { name: 'Persisted', channelId: 'UCpersisted' },
      retired = { name: 'Retired', channelId: 'UCretired' },
      current = { name: 'Current', channelId: 'UCcurrent' };
    expect(result).toEqual(
      canceled
        ? [
            { blockedArtists: [persisted] },
            { blockedArtists: [persisted, current] },
          ]
        : [
            { blockedArtists: [persisted] },
            { blockedArtists: [persisted, retired] },
            { blockedArtists: [persisted, retired, current] },
          ],
    );
  });

test('cascading canceled popup additions never contaminate two newer valid jobs', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist,
      bar = document.querySelector('ytmusic-player-bar')!;
    const open = (names: string[]) => {
      document.querySelector('ytmusic-popup-container')?.remove();
      bar.innerHTML = '';
      for (const name of names) {
        const a = document.createElement('a');
        a.className = 'yt-simple-endpoint';
        a.href = '/channel/UC' + name;
        a.textContent = name;
        bar.append(a);
      }
      const popup = document.createElement('ytmusic-popup-container');
      popup.innerHTML =
        '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
      const sink = document.createElement('ytmusic-menu-renderer');
      sink.className = 'ytmusic-player-bar';
      (popup.firstElementChild as any).ytEventForwardingBehavior = {
        forwarder_: { eventSink: sink },
      };
      document.body.append(popup);
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let admitted = false;
    const ctx = w.context({ enabled: true, blockedArtists: [] });
    ctx.setConfig = async (value: any) => {
      w.writes.push(value);
      if (w.writes.length === 1) {
        admitted = true;
        await gate;
      }
    };
    open(['Persisted', 'RetiredOne']);
    await p.renderer.start(ctx);
    p.renderer.onPlayerApiReady(w.api);
    const first = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.blocklist-injected'),
    );
    first[0].click();
    while (!admitted) await Promise.resolve();
    first[1].click();
    open(['RetiredTwo']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (
      document.querySelector('.blocklist-injected') as HTMLButtonElement
    ).click();
    open(['CurrentOne', 'CurrentTwo']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '.blocklist-injected',
    ))
      button.click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = w.writes.slice();
    p.renderer.stop();
    return result;
  });
  const persisted = { name: 'Persisted', channelId: 'UCPersisted' },
    one = { name: 'CurrentOne', channelId: 'UCCurrentOne' },
    two = { name: 'CurrentTwo', channelId: 'UCCurrentTwo' };
  expect(result).toEqual([
    { blockedArtists: [persisted] },
    { blockedArtists: [persisted, one] },
    { blockedArtists: [persisted, one, two] },
  ]);
});

test('a newer authoritative config list survives an older admitted save completion', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist,
      bar = document.querySelector('ytmusic-player-bar')!;
    bar.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCpersisted">Persisted</a><a class="yt-simple-endpoint" href="/channel/UCcurrent">Current</a>';
    const popup = document.querySelector('ytmusic-popup-container')!;
    popup.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (popup.firstElementChild as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let admitted = false;
    const ctx = w.context({ enabled: true, blockedArtists: [] });
    ctx.setConfig = async (value: any) => {
      w.writes.push(value);
      if (w.writes.length === 1) {
        admitted = true;
        await gate;
      }
    };
    await p.renderer.start(ctx);
    p.renderer.onPlayerApiReady(w.api);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.blocklist-injected'),
    );
    buttons[0].click();
    while (!admitted) await Promise.resolve();
    buttons[1].click();
    p.renderer.onConfigChange({
      enabled: true,
      blockedArtists: [
        { name: 'Persisted', channelId: 'UCpersisted' },
        { name: 'Independent', channelId: 'UCindependent' },
      ],
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = w.writes.slice();
    p.renderer.stop();
    return result;
  });
  expect(result).toEqual([
    { blockedArtists: [{ name: 'Persisted', channelId: 'UCpersisted' }] },
    {
      blockedArtists: [
        { name: 'Persisted', channelId: 'UCpersisted' },
        { name: 'Independent', channelId: 'UCindependent' },
        { name: 'Current', channelId: 'UCcurrent' },
      ],
    },
  ]);
});

test('a failed admitted addition does not leak into a later valid queued write', async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist;
    document.querySelector('ytmusic-player-bar')!.innerHTML =
      '<a class="yt-simple-endpoint" href="/channel/UCfailed">Failed</a><a class="yt-simple-endpoint" href="/channel/UCcurrent">Current</a>';
    const popup = document.querySelector('ytmusic-popup-container')!;
    popup.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (popup.firstElementChild as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_, no) => (reject = no));
    let admitted = false;
    const ctx = w.context({ enabled: true, blockedArtists: [] });
    ctx.setConfig = async (value: any) => {
      w.writes.push(value);
      if (w.writes.length === 1) {
        admitted = true;
        await gate;
      }
    };
    await p.renderer.start(ctx);
    p.renderer.onPlayerApiReady(w.api);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.blocklist-injected'),
    );
    buttons[0].click();
    while (!admitted) await Promise.resolve();
    buttons[1].click();
    reject(new Error('synthetic config write failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = w.writes.slice();
    p.renderer.stop();
    return result;
  });
  expect(result).toEqual([
    { blockedArtists: [{ name: 'Failed', channelId: 'UCfailed' }] },
    { blockedArtists: [{ name: 'Current', channelId: 'UCcurrent' }] },
  ]);
});

// F7: supported retirement delivered reentrantly by an owned native getter.
async function f7Popup(page: any) {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.open = (names: string[]) => {
      document.querySelector('ytmusic-popup-container')?.remove();
      const bar = document.querySelector('ytmusic-player-bar')!;
      bar.innerHTML = '';
      for (const name of names) {
        const a = document.createElement('a');
        a.className = 'yt-simple-endpoint';
        a.href = '/channel/UC' + name;
        a.textContent = name;
        bar.append(a);
      }
      const menu = document.createElement('ytmusic-popup-container');
      menu.innerHTML =
        '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
      const sink = document.createElement('ytmusic-menu-renderer');
      sink.className = 'ytmusic-player-bar';
      (menu.firstElementChild as any).ytEventForwardingBehavior = {
        forwarder_: { eventSink: sink },
      };
      document.body.append(menu);
    };
  });
}
for (const disableInsideGetter of [false, true])
  test(`native ownership getter cannot admit after synchronous disable=${disableInsideGetter}`, async ({
    page,
  }) => {
    await f7Popup(page);
    const result = await page.evaluate(async (disableInsideGetter) => {
      const w = window as any,
        p = w.FilterFixture.blocklist;
      w.open(['Current']);
      await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
      p.renderer.onPlayerApiReady(w.api);
      let armed = false,
        transitions = 0;
      const native = w.api.getVideoData;
      w.api.getVideoData = () => {
        if (armed && disableInsideGetter) {
          armed = false;
          transitions++;
          p.renderer.onConfigChange({ enabled: false, blockedArtists: [] });
        }
        return native();
      };
      (
        document.querySelector('.blocklist-injected') as HTMLButtonElement
      ).click();
      armed = true;
      await new Promise((r) => setTimeout(r, 0));
      const result = { writes: w.writes.slice(), transitions };
      p.renderer.stop();
      return result;
    }, disableInsideGetter);
    expect(result).toEqual(
      disableInsideGetter
        ? { writes: [], transitions: 1 }
        : {
            writes: [
              { blockedArtists: [{ name: 'Current', channelId: 'UCCurrent' }] },
            ],
            transitions: 0,
          },
    );
  });

for (const retirement of ['stop', 'popup'])
  test(`native ownership getter cannot admit after synchronous ${retirement}`, async ({
    page,
  }) => {
    await f7Popup(page);
    const result = await page.evaluate(async (retirement) => {
      const w = window as any,
        p = w.FilterFixture.blocklist;
      w.open(['Current']);
      await p.renderer.start(w.context({ enabled: true, blockedArtists: [] }));
      p.renderer.onPlayerApiReady(w.api);
      let armed = false,
        transitions = 0;
      const native = w.api.getVideoData;
      w.api.getVideoData = () => {
        if (armed) {
          armed = false;
          transitions++;
          if (retirement === 'stop') p.renderer.stop();
          else document.querySelector('ytmusic-popup-container')!.remove();
        }
        return native();
      };
      (
        document.querySelector('.blocklist-injected') as HTMLButtonElement
      ).click();
      armed = true;
      await new Promise((r) => setTimeout(r, 0));
      const result = { writes: w.writes.slice(), transitions };
      p.renderer.stop();
      return result;
    }, retirement);
    expect(result).toEqual({ writes: [], transitions: 1 });
  });
