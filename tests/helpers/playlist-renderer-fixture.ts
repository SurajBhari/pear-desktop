import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Window } from 'happy-dom';

export async function playlistRendererFixture() {
  const dom = new Window();
  dom.document.body.innerHTML =
    '<ytmusic-app></ytmusic-app><div id="queue"></div>';
  const app = dom.document.querySelector('ytmusic-app')! as any;
  const queue = dom.document.querySelector('#queue')! as any;
  const callbacks = new Map<string, Set<any>>();
  const subscribers = new Set<() => void>();
  const packets: any[] = [],
    dispatches: any[] = [],
    fetches: any[] = [];
  let currentApi: any = {};
  let intents = 0;
  let state: any = {
    queue: {
      items: [
        {
          playlistPanelVideoRenderer: {
            videoId: 'current0001',
            selected: true,
          },
        },
        { playlistPanelVideoRenderer: { videoId: 'current0002' } },
      ],
      selectedItemIndex: 0,
      nextQueueItemId: 2,
      queueContextParams: 'owned-context',
    },
  };
  const store = {
    getState: () => state,
    subscribe: (fn: () => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
  queue.queue = { store: { store }, getItems: () => state.queue.items };
  queue.dispatch = (action: any) => {
    dispatches.push(action);
    if (action.type === 'ADD_ITEMS') {
      const q = state.queue;
      state = {
        queue: {
          ...q,
          items: [
            ...q.items.slice(0, action.payload.index),
            ...action.payload.items,
            ...q.items.slice(action.payload.index),
          ],
          nextQueueItemId: q.nextQueueItemId + action.payload.items.length,
        },
      };
    }
    for (const fn of subscribers) fn();
  };
  app.networkManager = {
    fetch: (url: string, data: any) =>
      new Promise((resolve, reject) =>
        fetches.push({ url, data, resolve, reject }),
      ),
  };
  const w = dom as any;
  w.blockerSceneGuard = { cancelFromUser: () => intents++ };
  w.ipcRenderer = {
    subscribe: (channel: string, fn: any) => {
      const handlers = callbacks.get(channel) ?? new Set();
      callbacks.set(channel, handlers);
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    send: (...args: any[]) => packets.push(args),
  };
  const pureUrl = new URL(
    '../../src/providers/queue-playlist.ts',
    import.meta.url,
  );
  const rendererUrl = new URL(
    '../../src/providers/queue-playlist-renderer.ts',
    import.meta.url,
  );
  let make: any = () => ({ dispose() {} });
  if (existsSync(rendererUrl)) {
    const strip = (s: string) =>
      stripTypeScriptTypes(s)
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/^export /gm, '');
    const pure = strip(await readFile(pureUrl, 'utf8')),
      renderer = strip(await readFile(rendererUrl, 'utf8'));
    make = new Function(
      'window',
      'document',
      pure + '\n' + renderer + '\nreturn createPlaylistQueueController;',
    )(dom, dom.document);
  }
  const controller = make(currentApi, () => currentApi);
  const emit = (channel: string, ...args: any[]) => {
    for (const fn of [...(callbacks.get(channel) ?? [])]) fn(...args);
  };
  let serial = 0;
  const nextId = () =>
    `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const owner = () => {
    const id = nextId();
    emit('peard:playlist-queue-owner-query', { requestId: id });
    return packets.find((p) => p[1]?.requestId === id)?.[1]?.ownerId;
  };
  return {
    dom,
    app,
    queue,
    store,
    controller,
    make,
    packets,
    dispatches,
    fetches,
    callbacks,
    subscribers,
    emit,
    nextId,
    owner,
    intents: () => intents,
    state: () => state,
    setState: (next: any) => {
      state = next;
      for (const fn of subscribers) fn();
    },
    replaceApi: () => (currentApi = {}),
    flush: async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    close: async () => {
      controller.dispose();
      await dom.happyDOM.close();
    },
  };
}
