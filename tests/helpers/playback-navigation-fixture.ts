import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { Page } from '@playwright/test';
import { filterBundle } from './filter-bundle';

/** Actual filters, core owner, navigation and renderer listener; only provider data is controlled. */
export async function navigationFixture(
  page: Page,
  options: {
    live?: boolean;
    allow?: boolean;
    button?: boolean;
    sourceRoot?: string;
  } = {},
) {
  const renderer = await readFile(
    options.sourceRoot
      ? path.join(options.sourceRoot, 'src/renderer.ts')
      : new URL('../../src/renderer.ts', import.meta.url),
    'utf8',
  );
  const start = renderer.indexOf(
    "window.ipcRenderer.on('peard:previous-video'",
  );
  const end = renderer.indexOf(
    "window.ipcRenderer.on('peard:next-video'",
    start,
  );
  if (start < 0 || end < 0) throw Error('Actual Previous listener missing');
  const handler = stripTypeScriptTypes(renderer.slice(start, end));
  await page.setContent(
    `<div id="movie_player"></div><video></video><ytmusic-player-bar></ytmusic-player-bar><div id="queue"></div><ytmusic-popup-container></ytmusic-popup-container>${options.button === false ? '' : '<button class="previous-button ytmusic-player-bar">Previous</button>'}`,
  );
  await page.addScriptTag({ content: await filterBundle(options.sourceRoot) });
  await page.evaluate(
    async ({ handler, options }) => {
      const w = window as any,
        f = w.FilterFixture;
      w.mainConfig = {
        get: (key: string) =>
          key === 'plugins' ? { 'music-together': { enabled: false } } : false,
      };
      w.state = {
        index: 4,
        id: 'trackA00001',
        responseId: 'trackA00001',
        author: 'Blocked',
        title: options.live ? 'Song (Live)' : 'Song',
        skips: [] as any[],
        effects: 0,
        time: 0,
        nextIndex: 4,
      };
      w.handlers = new Map<string, Set<any>>();
      const ids = [
        'track000001',
        'track000002',
        'track000003',
        'track000004',
        'trackA00001',
        'trackB00001',
      ];
      w.rows = ids.map((videoId) => ({
        playlistPanelVideoRenderer: { videoId },
      }));
      w.queue = {
        items: w.rows,
        selectedItemIndex: 4,
        queueContextParams: 'queue-one',
      };
      w.storeState = { queue: w.queue, castStatus: {} };
      w.reads = { store: 0, bar: 0 };
      const store = {
        getState: () => {
          w.reads.store++;
          return w.storeState;
        },
      };
      const queue = document.querySelector('#queue') as any;
      queue.queue = { store: { store }, getItems: () => w.rows };
      (document.querySelector('ytmusic-player-bar') as any).getState = () => {
        w.reads.bar++;
        return w.storeState;
      };
      Object.defineProperty(document.querySelector('video'), 'readyState', {
        configurable: true,
        value: 1,
      });
      w.api = Object.assign(document.querySelector('#movie_player')!, {
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
            channelId: w.state.author === 'Blocked' ? 'UCblocked' : 'UCallowed',
          },
        }),
        getPlaylistIndex: () => w.state.index,
        getCurrentTime: () => w.state.time,
        nextVideo: () =>
          w.state.skips.push({ id: w.state.id, index: w.state.index }),
        previousVideo: () => {
          w.state.effects++;
          w.play(w.state.nextIndex);
        },
        addEventListener: (name: string, fn: any) => {
          if (!w.handlers.has(name)) w.handlers.set(name, new Set());
          w.handlers.get(name).add(fn);
        },
        removeEventListener: (name: string, fn: any) =>
          w.handlers.get(name)?.delete(fn),
      });
      w.announce = (name = 'dataloaded') => {
        const data = {
          videoId: w.state.id,
          title: w.state.title,
          author: w.state.author,
        };
        for (const fn of [...(w.handlers.get('videodatachange') ?? [])])
          fn(name, data);
        document.dispatchEvent(
          new CustomEvent('videodatachange', {
            detail: { name, videoData: data },
          }),
        );
      };
      w.play = (index: number, name = 'dataloaded') => {
        w.state.index = w.queue.selectedItemIndex = index;
        w.state.id = w.state.responseId =
          w.rows[index].playlistPanelVideoRenderer.videoId;
        w.state.author = index === 5 ? 'Allowed' : 'Blocked';
        w.state.title = options.live && index !== 5 ? 'Song (Live)' : 'Song';
        w.metadata = {
          videoId: w.state.id,
          title: w.state.title,
          artist: w.state.author,
        };
        w.announce(name);
      };
      f.adoptPlaybackOwner(w.api);
      w.disposeOwner = f.publishMusicActionsOwner(w.api, {
        getApi: () => w.api,
        repeatPreference: {},
        playlistQueue: {},
      });
      w.navigation = f.getMusicActionsOwner(w.api)?.navigation;
      w.metadata = {
        videoId: w.state.id,
        title: w.state.title,
        artist: w.state.author,
      };
      w.config = {
        enabled: true,
        blockedArtists: [{ name: 'Blocked', channelId: 'UCblocked' }],
        ...(options.allow === undefined
          ? {}
          : { allowIntentionalPrevious: options.allow }),
      };
      w.context = {
        getConfig: async () => w.config,
        setConfig: async () => {},
        ipc: { subscribe: () => () => {} },
      };
      await f.blocklist.renderer.start(w.context);
      f.blocklist.renderer.onPlayerApiReady(w.api);
      if (options.live) {
        await f.live.renderer.start({
          ...w.context,
          getConfig: async () => ({ enabled: true }),
        });
        f.live.renderer.onPlayerApiReady(w.api);
      }
      w.ipcRenderer = {
        on: (_: string, fn: any) => {
          w.previousCommand = fn;
        },
      };
      new Function(
        'window',
        'document',
        'api',
        'getMusicActionsOwner',
        handler,
      )(w, document, w.api, f.getMusicActionsOwner);
      document
        .querySelector('.previous-button')
        ?.addEventListener('click', () => w.api.previousVideo());
      w.play(5);
    },
    { handler, options },
  );
}
