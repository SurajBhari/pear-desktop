import { test, expect } from '@playwright/test';
import { filterBundle } from './helpers/filter-bundle';

test('actual management menu adds, edits, removes and clears cloned latest values', async ({
  page,
}) => {
  await page.setContent('<div></div>');
  await page.addScriptTag({ content: await filterBundle() });
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist;
    let raw = {
      enabled: true,
      blockedArtists: [{ name: 'First', channelId: 'UCfirst' }],
    };
    let output: any = 'New Artist';
    const writes: any[] = [];
    w.promptBoundary = async () => output;
    const context = {
      window: { isDestroyed: () => false },
      getConfig: async () => raw,
      setConfig: async (v: any) => {
        writes.push(v);
        raw = { ...raw, ...v };
      },
      refresh() {},
    };
    let menu = (await p.menu?.(context)) ?? [];
    const add = menu.find(
      (x: any) => x.label === 'plugins.blocklist.menu.add.label',
    );
    const before = structuredClone(raw);
    raw = {
      ...raw,
      blockedArtists: [...raw.blockedArtists, { name: 'External' }],
    };
    await add?.click();
    menu = (await p.menu?.(context)) ?? [];
    const item = menu.find((x: any) => x.label === 'New Artist');
    output = 'Edited';
    await item?.submenu
      ?.find((x: any) => x.label === 'plugins.blocklist.menu.edit.label')
      ?.click();
    menu = (await p.menu?.(context)) ?? [];
    await menu
      .find((x: any) => x.label === 'Edited')
      ?.submenu?.find((x: any) => x.label === 'plugins.blocklist.menu.remove')
      ?.click();
    const afterRemove = structuredClone(raw.blockedArtists);
    await menu
      .find((x: any) => x.label === 'plugins.blocklist.menu.clear')
      ?.click();
    return { writes, before, afterRemove, final: raw.blockedArtists };
  });
  expect(result.writes).toHaveLength(4);
  expect(result.writes[0]).toEqual({
    blockedArtists: [
      { name: 'First', channelId: 'UCfirst' },
      { name: 'External' },
      { name: 'New Artist' },
    ],
  });
  expect(result.before.blockedArtists).toEqual([
    { name: 'First', channelId: 'UCfirst' },
  ]);
  expect(result.afterRemove).toEqual([
    { name: 'First', channelId: 'UCfirst' },
    { name: 'External' },
  ]);
  expect(result.final).toEqual([]);
});

test('artist popup has safe named keyboard buttons, correct multi-artist targets, and owned disposal', async ({
  page,
}) => {
  await page.setContent(
    '<video></video><ytmusic-player-bar><a class="yt-simple-endpoint" href="/channel/UCone">One</a><a class="yt-simple-endpoint" href="/browse/UCtwo">&lt;Two&gt;</a></ytmusic-player-bar><ytmusic-popup-container><ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer></ytmusic-popup-container>',
  );
  await page.addScriptTag({ content: await filterBundle() });
  const initial = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist;
    const menu = document.querySelector('tp-yt-paper-listbox')!;
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (menu.parentElement as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    w.metadata = { videoId: 'A', artist: 'Allowed', title: 'Song' };
    w.writes = [];
    w.api = {
      getVideoData: () => ({ video_id: 'A', author: 'Allowed', title: 'Song' }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: 'A', channelId: 'UCallowed' },
      }),
      addEventListener() {},
      removeEventListener() {},
      nextVideo() {},
    };
    await p.renderer.start({
      getConfig: async () => ({ enabled: true, blockedArtists: [] }),
      setConfig: async (v: any) => w.writes.push(v),
      ipc: { subscribe: () => () => {} },
    });
    p.renderer.onPlayerApiReady(w.api);
    await new Promise((r) => setTimeout(r, 0));
    return [...menu.querySelectorAll('button.blocklist-injected')].map((x) => ({
      text: x.textContent,
      html: x.innerHTML,
    }));
  });
  expect(initial.map((x) => x.text)).toEqual([
    'plugins.blocklist.templates.button: One',
    'plugins.blocklist.templates.button: <Two>',
  ]);
  expect(initial[1].html).not.toContain('<Two>');
  await page.locator('button.blocklist-injected').nth(1).focus();
  await page.keyboard.press('Enter');
  const result = await page.evaluate(async () => {
    const w = window as any;
    await new Promise((r) => setTimeout(r, 0));
    const writes = w.writes.slice();
    w.FilterFixture.blocklist.renderer.stop();
    document
      .querySelector('tp-yt-paper-listbox')!
      .append(document.createElement('span'));
    await new Promise((r) => setTimeout(r, 0));
    return {
      writes,
      count: document.querySelectorAll('.blocklist-injected').length,
    };
  });
  expect(result).toEqual({
    writes: [{ blockedArtists: [{ name: '<Two>', channelId: 'UCtwo' }] }],
    count: 0,
  });
});

test('unrelated row without artist identity never offers to block the current performer', async ({
  page,
}) => {
  await page.setContent(
    '<video></video><ytmusic-popup-container><ytmusic-menu-popup-renderer><tp-yt-paper-listbox><a id="navigation-endpoint"></a></tp-yt-paper-listbox></ytmusic-menu-popup-renderer></ytmusic-popup-container>',
  );
  await page.addScriptTag({ content: await filterBundle() });
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist;
    w.metadata = { videoId: 'A', artist: 'Current Artist', title: 'Song' };
    (document.querySelector('#navigation-endpoint') as any).data = {
      watchEndpoint: { videoId: 'Unrelated' },
    };
    await p.renderer.start({
      getConfig: async () => ({ enabled: true, blockedArtists: [] }),
      setConfig() {},
      ipc: { subscribe: () => () => {} },
    });
    p.renderer.onPlayerApiReady({
      getVideoData: () => ({ video_id: 'A' }),
      getPlayerResponse: () => ({ videoDetails: { videoId: 'A' } }),
      addEventListener() {},
      removeEventListener() {},
      nextVideo() {},
    });
    await new Promise((r) => setTimeout(r, 0));
    const count = document.querySelectorAll('.blocklist-injected').length;
    p.renderer.stop();
    return count;
  });
  expect(result).toBe(0);
});

test('an unsupported config watch cancels queued popup saves and preserves its raw payload', async ({
  page,
}) => {
  await page.setContent(
    '<video></video><ytmusic-player-bar><a class="yt-simple-endpoint" href="/channel/UCone">One</a></ytmusic-player-bar><ytmusic-popup-container><ytmusic-menu-popup-renderer><tp-yt-paper-listbox></tp-yt-paper-listbox></ytmusic-menu-popup-renderer></ytmusic-popup-container>',
  );
  await page.addScriptTag({ content: await filterBundle() });
  const result = await page.evaluate(async () => {
    const w = window as any,
      p = w.FilterFixture.blocklist,
      menu = document.querySelector('tp-yt-paper-listbox')!;
    const sink = document.createElement('ytmusic-menu-renderer');
    sink.className = 'ytmusic-player-bar';
    (menu.parentElement as any).ytEventForwardingBehavior = {
      forwarder_: { eventSink: sink },
    };
    w.metadata = { videoId: 'A', title: 'Ordinary', artist: 'Allowed' };
    const writes: any[] = [];
    await p.renderer.start({
      getConfig: async () => ({ enabled: true, blockedArtists: [] }),
      setConfig: async (v: any) => writes.push(v),
      ipc: { subscribe: () => () => {} },
    });
    (
      document.querySelector('.blocklist-injected') as HTMLButtonElement
    )?.click();
    const unsupported = {
      enabled: true,
      blockedArtists: 'unrecognized-data',
      privateUnknown: { preserve: true },
    };
    const before = JSON.stringify(unsupported);
    p.renderer.onConfigChange(unsupported);
    await new Promise((r) => setTimeout(r, 0));
    const result = {
      writes,
      buttons: document.querySelectorAll('.blocklist-injected').length,
      preserved: JSON.stringify(unsupported) === before,
    };
    p.renderer.stop();
    return result;
  });
  expect(result).toEqual({ writes: [], buttons: 0, preserved: true });
});
