import { Window } from 'happy-dom';
import { musicModuleSource } from './api-music-source';
import { searchPage } from './music-catalog-fixtures';
export async function musicRendererFixture() {
  const dom = new Window(),
    w = dom as any;
  dom.document.body.innerHTML = '<ytmusic-app></ytmusic-app>';
  const app = dom.document.querySelector('ytmusic-app') as any;
  const listeners = new Map<string, Set<any>>(),
    nativeListeners = new Map<string, Set<any>>();
  const sent: any[] = [],
    fetches: any[] = [];
  const ipc = {
    subscribe(channel: string, fn: any) {
      const set = listeners.get(channel) ?? new Set();
      set.add(fn);
      listeners.set(channel, set);
      return () => set.delete(fn);
    },
    send(...args: any[]) {
      sent.push(args);
    },
  };
  let video = 'current0001',
    responseVideo = video,
    api: any;
  const originalApi = {
    isConnected: true,
    getVideoData: () => ({
      video_id: video,
      title: 'Current title',
      author: 'Current artist',
    }),
    getPlayerResponse: () => ({
      videoDetails: {
        videoId: responseVideo,
        title: 'Current title',
        author: 'Current artist',
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      },
    }),
    getCurrentTime: () => 1.2345,
    getDuration: () => 215,
    getVolume: () => 77,
    getPlayerState: () => 1,
    addEventListener(name: string, fn: any) {
      const set = nativeListeners.get(name) ?? new Set();
      set.add(fn);
      nativeListeners.set(name, set);
    },
    removeEventListener(name: string, fn: any) {
      nativeListeners.get(name)?.delete(fn);
    },
  };
  api = originalApi;
  app.networkManager = {
    fetch: (url: string, data: any) =>
      new Promise((resolve, reject) =>
        fetches.push({ url, data, resolve, reject }),
      ),
  };
  const oldWindow = (globalThis as any).window,
    oldDocument = (globalThis as any).document;
  (globalThis as any).window = w;
  (globalThis as any).document = dom.document;
  const source = await musicModuleSource('src/providers/music-renderer.ts');
  if (!source.createMusicRendererController)
    throw new Error('Missing native music controller');
  const controller = source.createMusicRendererController(
    originalApi,
    () => api,
    ipc,
  );
  const emit = (channel: string, packet: any) => {
    for (const fn of [...(listeners.get(channel) ?? [])]) fn(packet);
  };
  let serial = 0;
  const query = () => {
    const p = {
      requestId: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
      nonce: 'a'.repeat(32),
    };
    emit('peard:music-owner-query', p);
    return sent.find((s) => s[1].requestId === p.requestId)?.[1];
  };
  const read = (
    packet = query(),
    input: any = { operation: 'search', query: 'fixture' },
  ) => {
    emit('peard:music-read', { ...packet, input });
    return packet;
  };
  const result = (packet: any) =>
    sent.find(
      (s) => s[1].requestId === packet.requestId && s[1].type === 'settled',
    )?.[1].result;
  return {
    controller,
    dom,
    app,
    originalApi,
    sent,
    fetches,
    listeners,
    ipc,
    emit,
    query,
    read,
    result,
    searchPage,
    setVideo(id: string, response = id) {
      video = id;
      responseVideo = response;
    },
    videoEvent() {
      for (const fn of [...(nativeListeners.get('videodatachange') ?? [])])
        fn('dataloaded', {});
    },
    replaceApi() {
      api = { ...originalApi };
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    close() {
      controller.dispose();
      (globalThis as any).window = oldWindow;
      (globalThis as any).document = oldDocument;
      dom.happyDOM.abort();
    },
  };
}
