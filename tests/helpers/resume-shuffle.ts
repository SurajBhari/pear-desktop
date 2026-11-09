import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { Window, PropertySymbol } from 'happy-dom';

const root = path.resolve(import.meta.dirname, '../..');

export async function resumeShuffleSource() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-resume-shuffle-'));
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      `export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/resume-shuffle/index.ts'))}`,
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'resume-shuffle-app-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@/utils' || id === '@/i18n') return '\0' + id;
          },
          load(id) {
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0@/i18n') return 'export const t=key=>key;';
          },
        },
      ],
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry,
          formats: ['iife'],
          name: 'ResumeFixture',
          fileName: () => 'fixture.js',
        },
      },
    });
    return await readFile(path.join(directory, 'fixture.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function resumeShuffleFixture(
  source: string,
  options: {
    shuffled?: boolean;
    resume?: boolean;
    items?: unknown[];
    sync?: boolean;
    missingQueue?: boolean;
  } = {},
) {
  const dom = new Window({
    url: 'https://music.youtube.com/watch?v=trackAAAAAA',
  });
  dom.document.body.innerHTML =
    '<ytmusic-player-bar></ytmusic-player-bar><div id="queue"></div>';
  // Happy DOM stores mutation delivery callbacks weakly. Keep only callbacks
  // registered by this observer alive until their real disconnect.
  class Observer extends dom.MutationObserver {
    private callbacks = new Set<unknown>();
    observe(target: any, options: MutationObserverInit) {
      const previous = new Set(target[PropertySymbol.mutationListeners]);
      super.observe(target, options);
      for (const listener of target[PropertySymbol.mutationListeners]) {
        if (previous.has(listener)) continue;
        const callback = listener.callback.deref();
        if (callback) this.callbacks.add(callback);
      }
    }
    disconnect() {
      super.disconnect();
      this.callbacks.clear();
    }
  }
  const bar = dom.document.querySelector('ytmusic-player-bar')!;
  const queueElement = dom.document.querySelector('#queue')! as any;
  const subscriptions = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let calls = 0;
  let videoId = 'trackAAAAAA';
  const writes: any[] = [];
  let items = options.items ?? [];
  const store = {
    getState: () => ({ queue: { items } }),
    subscribe: (callback: () => void) => {
      subscriptions.add(callback);
      if (options.sync) callback();
      return () => subscriptions.delete(callback);
    },
  };
  const queue = {
    store: { store },
    shuffle: () => {
      calls++;
      bar.setAttribute('shuffle-on', '');
    },
  };
  if (!options.missingQueue) queueElement.queue = queue;
  (dom as any).mainConfig = { get: () => options.resume ?? true };
  const plugin = new Function(
    'window',
    'document',
    'MutationObserver',
    'location',
    'HTMLElement',
    'Element',
    'setTimeout',
    'clearTimeout',
    source + '\nreturn ResumeFixture.plugin;',
  )(
    dom,
    dom.document,
    Observer,
    dom.location,
    dom.HTMLElement,
    dom.Element,
    (callback: () => void) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    (id: number) => timers.delete(id),
  );
  const api = {
    getVideoData: () => ({ video_id: videoId }),
    getPlayerResponse: () => ({ videoDetails: { videoId } }),
  };
  const context = {
    getConfig: async () => ({
      enabled: true,
      shuffled: options.shuffled ?? true,
    }),
    setConfig: async (value: any) => {
      writes.push({ ...value });
    },
  };
  const settle = async () => {
    await dom.happyDOM.whenAsyncComplete();
    await Promise.resolve();
  };
  return {
    dom,
    bar,
    queue,
    queueElement,
    api,
    context,
    plugin,
    subscriptions,
    timers,
    writes,
    calls: () => calls,
    settle,
    populate: (
      newItems: unknown[] = [
        { playlistPanelVideoRenderer: { videoId, selected: true } },
      ],
    ) => {
      items = newItems;
      for (const callback of [...subscriptions]) callback();
    },
    change: (id: string) => {
      videoId = id;
      dom.document.dispatchEvent(
        new dom.CustomEvent('videodatachange', {
          detail: { name: 'dataloaded', videoData: { videoId: id } },
        }),
      );
    },
    expire: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    close: async () => {
      plugin.renderer.stop();
      await dom.happyDOM.cancelAsync();
      timers.clear();
    },
  };
}
