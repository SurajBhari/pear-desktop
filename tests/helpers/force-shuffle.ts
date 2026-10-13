import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { Window } from 'happy-dom';

const root = path.resolve(import.meta.dirname, '../..');

/** Absent exports are null only to measure the selected pre-feature baseline. */
export async function forceShuffleSource() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-force-source-'));
  const present = async (file: string) => {
    try {
      await access(path.join(root, file));
      return true;
    } catch {
      return false;
    }
  };
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      [
        `export {default as resume} from ${JSON.stringify(path.join(root, 'src/plugins/resume-shuffle/index.ts'))};`,
        (await present('src/plugins/force-shuffle/index.ts'))
          ? `export {default as force} from ${JSON.stringify(path.join(root, 'src/plugins/force-shuffle/index.ts'))};`
          : 'export const force=null;',
        (await present('src/utils/shuffle-action-owner.ts'))
          ? `export * as actionOwner from ${JSON.stringify(path.join(root, 'src/utils/shuffle-action-owner.ts'))};`
          : 'export const actionOwner=null;',
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'owned-shuffle-app-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@/utils' || id === '@/i18n') return '\0' + id;
            return undefined;
          },
          load(id) {
            if (id === '\0@/utils')
              return 'export const createPlugin=value=>value;';
            if (id === '\0@/i18n') return 'export const t=key=>key;';
            return undefined;
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
          name: 'ShuffleFixture',
          fileName: () => 'fixture.js',
        },
      },
    });
    return await readFile(path.join(directory, 'fixture.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function forceShuffleFixture(
  source: string,
  options: {
    mode?: 'always' | 'preserve';
    shuffled?: boolean;
    resumeSaved?: boolean;
    items?: unknown[];
    missingQueue?: boolean;
    synchronousSubscribe?: boolean;
  } = {},
) {
  const dom = new Window({ url: 'https://fixture.invalid/watch' });
  dom.document.body.innerHTML =
    '<ytmusic-player-bar><button class="shuffle"></button></ytmusic-player-bar><div id="queue"></div>';
  const bar = dom.document.querySelector('ytmusic-player-bar')!;
  const queueElement = dom.document.querySelector('#queue')! as any;
  if (options.shuffled) bar.setAttribute('shuffle-on', '');
  const timers = new Map<
    number,
    { callback: () => void; at: number; ms: number }
  >();
  const subscriptions = new Set<() => void>();
  const observers = new Set<unknown>();
  const calls: { at: number; selected: unknown }[] = [];
  const writes: unknown[] = [];
  let now = 0;
  let timerSerial = 0;
  let id = 'trackAAAAAA';
  let responseId = id;
  let items = options.items ?? [
    { playlistPanelVideoRenderer: { videoId: id, selected: true } },
  ];
  let selectedItemIndex: number | undefined = 0;
  let onShuffle: (() => void) | undefined;
  class Observer extends dom.MutationObserver {
    observe(target: any, settings: any) {
      super.observe(target, settings);
      observers.add(this);
    }
    disconnect() {
      super.disconnect();
      observers.delete(this);
    }
  }
  const store = {
    getState: () => ({ queue: { items, selectedItemIndex } }),
    subscribe(callback: () => void): unknown {
      subscriptions.add(callback);
      if (options.synchronousSubscribe) callback();
      return () => subscriptions.delete(callback);
    },
  };
  const queue = {
    store: { store },
    shuffle() {
      calls.push({ at: now, selected: items[selectedItemIndex ?? 0] });
      bar.setAttribute('shuffle-on', '');
      onShuffle?.();
    },
    dispatch() {
      throw new Error('MOVE_ITEM/dispatch is outside native shuffle policy');
    },
  };
  if (!options.missingQueue) queueElement.queue = queue;
  (dom as any).mainConfig = { get: () => true };
  const sourceApi = new Function(
    'window',
    'document',
    'MutationObserver',
    'location',
    'Element',
    'HTMLElement',
    'setTimeout',
    'clearTimeout',
    'Date',
    source + '\nreturn ShuffleFixture;',
  )(
    dom,
    dom.document,
    Observer,
    dom.location,
    dom.Element,
    dom.HTMLElement,
    (callback: () => void, ms: number) => {
      const serial = ++timerSerial;
      timers.set(serial, { callback, at: now + ms, ms });
      return serial;
    },
    (serial: number) => timers.delete(serial),
    { now: () => now },
  );
  const api = {
    getVideoData: () => ({ video_id: id }),
    getPlayerResponse: () => ({ videoDetails: { videoId: responseId } }),
  };
  const forceConfig = { enabled: true, mode: options.mode ?? 'always' };
  const forceContext = {
    getConfig: async () => forceConfig,
    setConfig: async () => {},
  };
  const resumeContext = {
    getConfig: async () => ({
      enabled: true,
      shuffled: options.resumeSaved ?? true,
    }),
    setConfig: async (patch: unknown) => {
      writes.push(patch);
    },
  };
  const button = bar.querySelector('button')!;
  button.addEventListener('click', () => bar.toggleAttribute('shuffle-on'));
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await dom.happyDOM.whenAsyncComplete();
  };
  return {
    dom,
    bar,
    queueElement,
    queue,
    store,
    source: sourceApi,
    force: sourceApi.force,
    resume: sourceApi.resume,
    api,
    forceConfig,
    forceContext,
    resumeContext,
    timers,
    subscriptions,
    observers,
    calls,
    writes,
    get now() {
      return now;
    },
    set onShuffle(callback: (() => void) | undefined) {
      onShuffle = callback;
    },
    startForce: async () => {
      if (sourceApi.force)
        await sourceApi.force.renderer.onPlayerApiReady(api, forceContext);
    },
    startResume: async () =>
      sourceApi.resume.renderer.onPlayerApiReady(api, resumeContext),
    admit(value = id, name = 'dataloaded') {
      dom.document.dispatchEvent(
        new dom.CustomEvent('videodatachange', {
          detail: { name, videoData: { videoId: value } },
        }),
      );
    },
    identity(value: string, response = value) {
      id = value;
      responseId = response;
    },
    populate(
      value: unknown[] = [
        { playlistPanelVideoRenderer: { videoId: id, selected: true } },
      ],
      index: number | undefined = 0,
    ) {
      items = value;
      selectedItemIndex = index;
      for (const callback of [...subscriptions]) callback();
    },
    selectIndex(index: number | undefined) {
      selectedItemIndex = index;
      for (const callback of [...subscriptions]) callback();
    },
    reset() {
      bar.removeAttribute('shuffle-on');
    },
    click() {
      button.click();
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    settle,
    close: async () => {
      sourceApi.force?.renderer.stop();
      sourceApi.resume.renderer.stop();
      await settle();
      timers.clear();
      await dom.happyDOM.close();
    },
  };
}
