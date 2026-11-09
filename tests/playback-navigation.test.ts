import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { navigationFixture } from './helpers/playback-navigation-fixture';

for (const [channel, next] of [
  ['play', 'pause'],
  ['pause', 'toggle-play'],
  ['toggle-play', 'seek-to'],
]) {
  test(`actual app ${channel} interrupts pending Previous without donating permission`, async ({
    page,
  }) => {
    const source = await readFile(
      new URL('../src/renderer.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf(`window.ipcRenderer.on('peard:${channel}'`),
      end = source.indexOf(`window.ipcRenderer.on('peard:${next}'`, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = stripTypeScriptTypes(source.slice(start, end));
    await navigationFixture(page, { button: false });
    const skips = await page.evaluate((handler) => {
      const w = window as any;
      w.api.previousVideo = () => {};
      w.previousCommand();
      w.api.playVideo = () => {};
      w.api.pauseVideo = () => {};
      w.api.getPlayerState = () => 1;
      w.ipcRenderer.on = (_: string, fn: any) => (w.otherCommand = fn);
      new Function(
        'window',
        'document',
        'api',
        'getMusicActionsOwner',
        handler,
      )(w, document, w.api, w.FilterFixture.getMusicActionsOwner);
      w.otherCommand();
      w.play(4);
      return w.state.skips.length;
    }, handler);
    expect(skips).toBe(2);
  });
}

for (const stopped of [false, true]) {
  test(`idle navigation performs no queue reads with artist policy ${stopped ? 'stopped' : 'enabled'}`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((stopped) => {
      const w = window as any;
      if (stopped) w.FilterFixture.blocklist.renderer.stop();
      w.reads = { store: 0, bar: 0 };
      for (let i = 0; i < 25; i++) {
        w.announce('dataupdated');
        document.querySelector('video')!.dispatchEvent(new Event('timeupdate'));
      }
      const withNavigation = { ...w.reads };
      w.navigation.dispose();
      w.reads = { store: 0, bar: 0 };
      for (let i = 0; i < 25; i++) w.announce('dataupdated');
      const withoutNavigation = { ...w.reads };
      w.reads = { store: 0, bar: 0 };
      for (let i = 0; i < 25; i++)
        document.querySelector('video')!.dispatchEvent(new Event('timeupdate'));
      return { withNavigation, withoutNavigation, timeOnly: w.reads };
    }, stopped);
    expect(result.withNavigation).toEqual(result.withoutNavigation);
    expect(result.withNavigation.store).toBe(0);
    expect(result.timeOnly).toEqual({ store: 0, bar: 0 });
    if (stopped) expect(result.withNavigation).toEqual({ store: 0, bar: 0 });
  });
}

test('reentrant core publication cannot overwrite or leak the newer verified owner', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any,
      f = w.FilterFixture,
      original = w.api.addEventListener;
    let nested: any;
    let entered = false;
    w.api.addEventListener = (name: string, fn: any) => {
      original(name, fn);
      if (!entered) {
        entered = true;
        f.publishMusicActionsOwner(w.api, {
          getApi: () => w.api,
          repeatPreference: {},
          playlistQueue: {},
        });
        nested = f.getMusicActionsOwner(w.api);
      }
    };
    const retire = f.publishMusicActionsOwner(w.api, {
      getApi: () => w.api,
      repeatPreference: {},
      playlistQueue: {},
    });
    retire();
    const current = f.getMusicActionsOwner(w.api);
    w.previousCommand();
    return {
      newer: current === nested,
      alive: !!current?.current(),
      listeners: w.handlers.get('videodatachange').size,
      skips: w.state.skips.length,
    };
  });
  expect(result).toEqual({ newer: true, alive: true, listeners: 3, skips: 1 });
});

for (const binding of ['advertised', 'unknown', 'editable'] as const) {
  test(`trusted site Previous keyboard ${binding} binding requires corresponding native effect`, async ({
    page,
  }) => {
    await navigationFixture(page);
    await page.evaluate((binding) => {
      const w = window as any;
      if (binding !== 'unknown')
        document
          .querySelector('.previous-button')!
          .setAttribute('aria-keyshortcuts', 'Control+ArrowLeft');
      if (binding === 'editable') {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
      }
      document.addEventListener('keydown', (event) => {
        if (
          (event.ctrlKey && event.key === 'ArrowLeft') ||
          (event.shiftKey && event.key === 'Q')
        )
          w.api.previousVideo();
      });
    }, binding);
    await page.keyboard.press(
      binding === 'unknown' ? 'Shift+Q' : 'Control+ArrowLeft',
    );
    expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(
      binding === 'advertised' ? 1 : 2,
    );
  });
}

test('trusted nested artist link is not an earlier queue selection gesture', async ({
  page,
}) => {
  await navigationFixture(page);
  await page.evaluate(() => {
    const w = window as any,
      row = document.createElement(
        'ytmusic-playlist-panel-video-renderer',
      ) as any;
    row.data = w.rows[2].playlistPanelVideoRenderer;
    row.innerHTML = '<a href="#artist">Artist</a>';
    row.addEventListener('click', () => w.play(2));
    document.querySelector('#queue')!.append(row);
  });
  await page.locator('ytmusic-playlist-panel-video-renderer a').click();
  expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(2);
});

test('queue parser captures bounded array length without invoking provider get traps', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    let reads = 0;
    w.rows = new Proxy(w.rows, {
      get(target, key, receiver) {
        if (key === 'length') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    w.queue.items = w.rows;
    w.previousCommand();
    return { reads, skips: w.state.skips.length };
  });
  expect(result).toEqual({ reads: 0, skips: 1 });
});

test('later native getter replacing store state retires prepared source facts', async ({
  page,
}) => {
  await navigationFixture(page);
  const prepared = await page.evaluate(() => {
    const w = window as any;
    w.api.getPlaylistIndex = () => {
      w.storeState = {
        ...w.storeState,
        queue: { ...w.queue, selectedItemIndex: 2 },
      };
      return w.state.index;
    };
    return !!w.navigation.preparePrevious();
  });
  expect(prepared).toBe(false);
});

for (const button of [true, false]) {
  test(`actual app Previous ${button ? 'button' : 'API fallback'} allows one confirmed artist occurrence`, async ({
    page,
  }) => {
    await navigationFixture(page, { button });
    const result = await page.evaluate(() => {
      const w = window as any;
      w.previousCommand();
      w.announce('dataupdated');
      w.announce('dataloaded');
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      const allowed = [...w.state.skips];
      w.play(5);
      w.play(4);
      return { allowed, final: w.state.skips, effects: w.state.effects };
    });
    expect(result).toEqual({
      allowed: [{ id: 'trackA00001', index: 4 }],
      final: [
        { id: 'trackA00001', index: 4 },
        { id: 'trackA00001', index: 4 },
      ],
      effects: 1,
    });
  });
}

test('Previous accepts a coherent higher-index shuffle/history target without a skip record', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    w.rows.push({ playlistPanelVideoRenderer: { videoId: 'trackC00001' } });
    w.state.nextIndex = 6;
    // Establish the new order before preparing; target C has never been played/skipped.
    w.announce('dataupdated');
    w.previousCommand();
    return w.state.skips;
  });
  expect(result).toEqual([{ id: 'trackA00001', index: 4 }]);
});

test('actual fenced broker Previous grants and dispatches once', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    let entered = 0;
    const reply = w.FilterFixture.dispatchMusicControl(
      w.api,
      { action: 'previous' },
      {
        valid: () => true,
        current: () => true,
        probe: () => ({ videoId: w.state.id, playbackEpoch: 'one' }),
        enter: () => entered++,
      },
    );
    return { skips: w.state.skips, effects: w.state.effects, entered, reply };
  });
  expect(result).toEqual({
    skips: [{ id: 'trackA00001', index: 4 }],
    effects: 1,
    entered: 1,
    reply: { version: 1, phase: 'owned_control_dispatch' },
  });
});

for (const synthetic of [false, true]) {
  test(`${synthetic ? 'synthetic' : 'trusted'} native Previous click ${synthetic ? 'does not donate' : 'grants'} permission`, async ({
    page,
  }) => {
    await navigationFixture(page);
    if (synthetic)
      await page
        .locator('.previous-button')
        .evaluate((el: HTMLElement) => el.click());
    else await page.locator('.previous-button').click();
    expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(
      synthetic ? 2 : 1,
    );
  });
  test(`${synthetic ? 'synthetic' : 'trusted'} earlier unvisited queue row ${synthetic ? 'is blocked' : 'plays once'}`, async ({
    page,
  }) => {
    await navigationFixture(page);
    await page.evaluate(() => {
      const w = window as any,
        row = document.createElement(
          'ytmusic-playlist-panel-video-renderer',
        ) as any;
      row.data = w.rows[2].playlistPanelVideoRenderer;
      row.textContent = 'Earlier target';
      row.addEventListener('click', () => w.play(2));
      document.querySelector('#queue')!.append(row);
    });
    const row = page.locator('ytmusic-playlist-panel-video-renderer');
    if (synthetic) await row.evaluate((el: HTMLElement) => el.click());
    else await row.click();
    expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(
      synthetic ? 2 : 1,
    );
  });
}

test('Previous restart of current song cannot donate a later permission', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    document
      .querySelector('.previous-button')!
      .replaceWith(document.createElement('span'));
    w.api.previousVideo = () => {
      w.state.effects++;
      w.announce('dataloaded');
    };
    w.previousCommand();
    w.play(4);
    return w.state.skips.length;
  });
  expect(result).toBe(2);
});

test('pending media reload of current song is not a backward arrival', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    document
      .querySelector('.previous-button')!
      .replaceWith(document.createElement('span'));
    w.api.previousVideo = () => {
      const v = document.querySelector('video')!;
      v.dispatchEvent(new Event('emptied'));
      v.dispatchEvent(new Event('loadedmetadata'));
    };
    w.previousCommand();
    w.play(4);
    return w.state.skips.length;
  });
  expect(result).toBe(2);
});

test('default option and actual menu preserve explicit false', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const writes: any[] = [];
    const menu = await w.FilterFixture.blocklist.menu({
      window: { isDestroyed: () => false },
      getConfig: async () => w.config,
      setConfig: async (v: any) => writes.push(v),
      refresh() {},
    });
    const option = menu.find(
      (entry: any) =>
        entry.label === 'plugins.blocklist.menu.allow-intentional-previous',
    );
    if (option) await option.click({ checked: false });
    return {
      default: w.FilterFixture.blocklist.config.allowIntentionalPrevious,
      checked: option?.checked,
      writes,
    };
  });
  expect(result).toEqual({
    default: true,
    checked: true,
    writes: [{ allowIntentionalPrevious: false }],
  });
});

test('bounded source parser never invokes an array-row accessor', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any,
      saved = w.rows[0];
    let reads = 0;
    Object.defineProperty(w.rows, '0', {
      configurable: true,
      get() {
        reads++;
        return saved;
      },
    });
    w.previousCommand();
    return { reads, skips: w.state.skips.length, effects: w.state.effects };
  });
  expect(result).toEqual({ reads: 0, skips: 2, effects: 1 });
});

for (const scenario of [
  'false',
  'config',
  'stop',
  'owner',
  'ad',
  'cast',
  'shared',
  'unknown-local',
  'ended',
  'reorder',
  'duplicate-slot',
  'throw',
  'reentrant',
  'replacement',
  'new-next',
] as const) {
  test(`artist reprieve rejects ${scenario} without donating permission`, async ({
    page,
  }) => {
    await navigationFixture(page, {
      allow: scenario === 'false' ? false : undefined,
    });
    const result = await page.evaluate((scenario) => {
      const w = window as any;
      const f = w.FilterFixture;
      // Hold the real command at its native boundary; exercise its later effect explicitly.
      document
        .querySelector('.previous-button')!
        .replaceWith(document.createElement('span'));
      w.api.previousVideo = () => {
        w.state.effects++;
      };
      if (scenario === 'ad') w.api.className = 'ad-showing';
      if (scenario === 'cast') w.storeState.castStatus.remoteWatchEndpoint = {};
      if (scenario === 'shared') w.mainConfig.get = () => true;
      if (scenario === 'unknown-local') w.mainConfig.get = () => undefined;
      if (scenario === 'reentrant') {
        const original = w.api.getVideoData;
        w.api.getVideoData = () => {
          w.navigation.cancel();
          return original();
        };
      }
      if (scenario === 'throw')
        w.api.previousVideo = () => {
          throw Error('native previous failed');
        };
      try {
        w.previousCommand();
      } catch {}
      if (scenario === 'config')
        f.blocklist.renderer.onConfigChange({
          ...w.config,
          blockedArtists: [...w.config.blockedArtists],
        });
      if (scenario === 'stop') {
        f.blocklist.renderer.stop();
      }
      if (scenario === 'owner') w.disposeOwner();
      if (scenario === 'ended')
        document.querySelector('video')!.dispatchEvent(new Event('ended'));
      if (scenario === 'reorder')
        [w.rows[0], w.rows[1]] = [w.rows[1], w.rows[0]];
      if (scenario === 'duplicate-slot') {
        w.rows[3] = {
          playlistPanelVideoRenderer: {
            videoId: w.rows[4].playlistPanelVideoRenderer.videoId,
          },
        };
      }
      if (scenario === 'replacement') {
        const v = document.createElement('video');
        Object.defineProperty(v, 'readyState', { value: 1 });
        document.querySelector('video')!.replaceWith(v);
        v.dispatchEvent(new Event('loadedmetadata'));
      }
      if (scenario === 'new-next') w.navigation.cancel();
      // Returning to a same-ID second slot cannot use stale source/order facts.
      w.play(scenario === 'duplicate-slot' ? 3 : 4);
      if (scenario === 'stop') {
        return {
          skips: w.state.skips.length,
          effects: w.state.effects,
          stopped: true,
        };
      }
      return { skips: w.state.skips.length, effects: w.state.effects };
    }, scenario);
    if (scenario === 'stop')
      expect(result).toEqual({ skips: 1, effects: 1, stopped: true });
    else expect(result.skips).toBe(2);
  });
}

test('artist permission never bypasses live filtering or double advances', async ({
  page,
}) => {
  await navigationFixture(page, { live: true });
  const result = await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    w.announce('dataupdated');
    return w.state.skips;
  });
  expect(result).toEqual([
    { id: 'trackA00001', index: 4 },
    { id: 'trackA00001', index: 4 },
  ]);
});

test('pending command expires without borrowing a later arrival', async ({
  page,
}) => {
  await page.clock.install();
  await navigationFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    document
      .querySelector('.previous-button')!
      .replaceWith(document.createElement('span'));
    w.api.previousVideo = () => {};
    w.previousCommand();
  });
  await page.clock.fastForward(2001);
  expect(
    await page.evaluate(() => {
      const w = window as any;
      w.play(4);
      return w.state.skips.length;
    }),
  ).toBe(2);
});

test('broker samples before its final provider fence and refences a replaced target', async ({
  page,
}) => {
  await navigationFixture(page, { button: false });
  const result = await page.evaluate(() => {
    const w = window as any;
    let effects = 0,
      entered = 0;
    const old = w.api.previousVideo;
    w.api.previousVideo = () => {
      effects++;
      old();
    };
    w.mainConfig.get = () => {
      w.api.previousVideo = () => (effects += 100);
      return false;
    };
    let reason = '';
    try {
      w.FilterFixture.dispatchMusicControl(
        w.api,
        { action: 'previous' },
        {
          valid: () => true,
          current: () => true,
          probe: () => ({ videoId: w.state.id, playbackEpoch: 'one' }),
          enter: () => entered++,
        },
      );
    } catch (error) {
      reason = (error as any).message;
    }
    return { effects, entered, reason };
  });
  expect(result.effects).toBe(0);
  expect(result.entered).toBe(0);
  expect(result.reason).toContain('retired');
});

test('broker has no navigation getter after final probe and preserves entered on target throw', async ({
  page,
}) => {
  await navigationFixture(page, { button: false });
  const result = await page.evaluate(() => {
    const w = window as any,
      events: string[] = [];
    const old = w.api.getVideoData;
    w.api.getVideoData = () => {
      events.push('getter');
      return old();
    };
    w.api.previousVideo = () => {
      events.push('effect');
      throw Error('target failed');
    };
    try {
      w.FilterFixture.dispatchMusicControl(
        w.api,
        { action: 'previous' },
        {
          valid: () => true,
          current: () => true,
          probe: () => {
            events.push('probe');
            return { videoId: w.state.id, playbackEpoch: 'one' };
          },
          enter: () => events.push('entered'),
        },
      );
    } catch {}
    const after = events.slice(events.lastIndexOf('probe') + 1);
    w.play(4);
    return { after, skips: w.state.skips.length };
  });
  expect(result).toEqual({ after: ['entered', 'effect'], skips: 2 });
});

test('confirmed media replay ends an active one-occurrence permission', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    const v = document.querySelector('video')!;
    v.dispatchEvent(new Event('emptied'));
    w.announce();
    v.dispatchEvent(new Event('loadedmetadata'));
    return w.state.skips.length;
  });
  expect(result).toBe(2);
});

test('non-navigation volume gesture does not shorten the allowed occurrence', async ({
  page,
}) => {
  await navigationFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    const button = document.createElement('button');
    button.id = 'volume';
    button.textContent = 'Volume';
    document.body.append(button);
  });
  await page.locator('#volume').click();
  expect(
    await page.evaluate(() => {
      const w = window as any;
      w.announce('dataupdated');
      return w.state.skips.length;
    }),
  ).toBe(1);
});

test('exact duplicate-ID slot may be revisited but another slot is a new occurrence', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    w.rows[3] = { playlistPanelVideoRenderer: { videoId: 'trackA00001' } };
    w.announce('dataupdated');
    w.state.nextIndex = 3;
    w.previousCommand();
    const before = w.state.skips.length;
    w.play(4);
    return { before, after: w.state.skips.length };
  });
  expect(result).toEqual({ before: 1, after: 2 });
});

for (const wrong of [false, true]) {
  test(`trusted earlier-row nested menu ${wrong ? 'with wrong target' : 'does not grant'}`, async ({
    page,
  }) => {
    await navigationFixture(page);
    await page.evaluate((wrong) => {
      const w = window as any,
        row = document.createElement(
          'ytmusic-playlist-panel-video-renderer',
        ) as any;
      row.data = w.rows[2].playlistPanelVideoRenderer;
      row.innerHTML = wrong ? 'Wrong effect' : '<button>Menu</button>';
      row.addEventListener('click', () => w.play(wrong ? 4 : 2));
      document.querySelector('#queue')!.append(row);
    }, wrong);
    await page
      .locator(
        wrong
          ? 'ytmusic-playlist-panel-video-renderer'
          : 'ytmusic-playlist-panel-video-renderer button',
      )
      .click();
    expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(
      2,
    );
  });
}

test('trusted keyboard activation of the Previous button shares its confirmed effect', async ({
  page,
}) => {
  await navigationFixture(page);
  await page.locator('.previous-button').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(1);
});

test('actual owner publication reuses no stale navigation listeners after replacement', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any,
      counts: number[] = [];
    counts.push(w.handlers.get('videodatachange').size);
    const retired = w.navigation;
    w.disposeOwner = w.FilterFixture.publishMusicActionsOwner(w.api, {
      getApi: () => w.api,
      repeatPreference: {},
      playlistQueue: {},
    });
    counts.push(w.handlers.get('videodatachange').size);
    retired.preparePrevious()?.arm();
    w.play(4);
    w.disposeOwner();
    counts.push(w.handlers.get('videodatachange').size);
    return { counts, skips: w.state.skips.length };
  });
  expect(result).toEqual({ counts: [3, 3, 2], skips: 2 });
});

test('absent Previous target cannot arm a ticket for unrelated playback', async ({
  page,
}) => {
  await navigationFixture(page, { button: false });
  const result = await page.evaluate(() => {
    const w = window as any;
    w.api.previousVideo = undefined;
    w.previousCommand();
    w.play(4);
    return w.state.skips.length;
  });
  expect(result).toBe(2);
});

test('partial native listener registration is rolled back without disabling controls', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any,
      original = w.api.addEventListener;
    w.api.addEventListener = (name: string, fn: any) => {
      original(name, fn);
      throw Error('native registration failed');
    };
    let threw = false;
    try {
      w.disposeOwner = w.FilterFixture.publishMusicActionsOwner(w.api, {
        getApi: () => w.api,
        repeatPreference: {},
        playlistQueue: {},
      });
    } catch {
      threw = true;
    }
    return {
      threw,
      listeners: w.handlers.get('videodatachange').size,
      owned: !!w.FilterFixture.getMusicActionsOwner(w.api),
    };
  });
  expect(result).toEqual({ threw: false, listeners: 2, owned: true });
});

test('stopping a live filter cannot retire the artist policy permission', async ({
  page,
}) => {
  await navigationFixture(page, { live: true });
  const result = await page.evaluate(() => {
    const w = window as any;
    w.FilterFixture.live.renderer.onConfigChange({ enabled: false });
    w.previousCommand();
    w.FilterFixture.live.renderer.stop();
    w.announce('dataupdated');
    return w.state.skips.length;
  });
  expect(result).toBe(1);
});

test('actual empty plugin configuration resolves the verified disabled shared-playback default', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(() => {
    const w = window as any;
    w.mainConfig.get = (key: string) => (key === 'plugins' ? {} : undefined);
    w.previousCommand();
    return w.state.skips.length;
  });
  expect(result).toBe(1);
});

test('fresh artist enable cannot inherit an intent made while its policy was stopped', async ({
  page,
}) => {
  await navigationFixture(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    w.FilterFixture.blocklist.renderer.stop();
    w.previousCommand();
    await w.FilterFixture.blocklist.renderer.start(w.context);
    w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
    return w.state.skips.length;
  });
  expect(result).toBe(2);
});

test('actual optimistic artist-menu list mutation retires the current permission', async ({
  page,
}) => {
  await navigationFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    document
      .querySelector('ytmusic-player-bar')!
      .insertAdjacentHTML(
        'beforeend',
        '<a class="yt-simple-endpoint" href="/channel/UCcollab">Collaborator</a>',
      );
    document.querySelector('ytmusic-popup-container')!.innerHTML =
      '<ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer>';
    const menu = document.querySelector('tp-yt-paper-listbox')!;
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (menu.parentElement as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
  });
  await page.locator('button.blocklist-injected').first().click();
  expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(2);
});
