import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, normalizePath } from 'vite';

const root = normalizePath(path.resolve(import.meta.dirname, '../..'));
export async function ratingFeedbackSource(
  options: { interactive?: boolean; manualTimers?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rating-source-'));
  const key = 'rating_' + crypto.randomUUID();
  const callbacks = new Set<any>(),
    shown: any[] = [],
    closed: any[] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: (...args: any[]) => state.sent.push(args),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  const state: any = {
    callbacks,
    shown,
    closed,
    sent: [],
    contents,
    window,
    ipcMain: new EventEmitter(),
    app: new EventEmitter(),
    current: null,
    hook: undefined,
    provenance: {},
    binding: {
      documentId: 'a'.repeat(32),
      episodeId: 'b'.repeat(32),
      videoId: 'seeded00001',
    },
    trays: [],
    effects: [],
    windows: false,
    constructed: [],
    scheduled: [],
    schedule: (fn: any, delay: number) => {
      const timer = { fn, delay, canceled: false };
      state.scheduled.push(timer);
      return timer;
    },
    cancel: (timer: any) => {
      if (timer) timer.canceled = true;
    },
  };
  (globalThis as any)[key] = state;
  await writeFile(
    path.join(directory, 'entry.ts'),
    `export * from ${JSON.stringify(root + '/src/plugins/notifications/main.ts')};export * from ${JSON.stringify(root + '/src/providers/protocol-handler.ts')};export * from ${JSON.stringify(root + '/src/tray.ts')};`,
  );
  try {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'rating-source-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === './providers/song-info')
              return '\0rating:@/providers/song-info';
            if (id === './providers/app-controls')
              return '\0rating:@/providers/app-controls';
            if (id === './providers/song-controls')
              return '\0rating:@/providers/song-controls';
            if (id === './song-controls')
              return '\0rating:@/providers/song-controls';
            if (id === './config' && importer === root + '/src/tray.ts')
              return '\0rating:config';
            if (id.includes('?asset')) return '\0rating:asset';
            if (id === './interactive' && options.interactive) return undefined;
            if (
              [
                'electron',
                'electron-is',
                '@/providers/song-info',
                '@/i18n',
                './utils',
                './interactive',
                '@/config',
                '@/providers/song-controls',
                '@/providers/app-controls',
              ].includes(id)
            )
              return '\0rating:' + id;
            if (id.startsWith('@/'))
              return root + '/src/' + id.slice(2) + '.ts';
          },
          load(id) {
            const b = `const b=globalThis[${JSON.stringify(key)}];`;
            if (id === '\0rating:electron')
              return (
                'import {EventEmitter} from "node:events";' +
                b +
                `export const ipcMain=b.ipcMain,app=b.app,Menu={buildFromTemplate:v=>v},screen={getPrimaryDisplay:()=>({scaleFactor:1})},nativeImage={createFromPath:()=>({resize(){return this}})};export class Tray extends EventEmitter {constructor(){super();b.trays.push(this)}setToolTip(){}setIgnoreDoubleClickEvents(){}setContextMenu(){}setImage(){}};export class Notification extends EventEmitter {constructor(options){super();b.constructed.push(this);b.hook?.('constructor');this.options=options} show(){b.hook?.('show');b.shown.push(this.options)} close(){b.closed.push(this);this.emit('close')}}`
              );
            if (id === '\0rating:electron-is')
              return (
                b + 'export default {windows:()=>b.windows,macOS:()=>false};'
              );
            if (id === '\0rating:asset') return 'export default "source-asset"';
            if (id === '\0rating:config' || id === '\0rating:@/config')
              return 'export const get=()=>true;';
            if (id === '\0rating:@/providers/app-controls')
              return 'export const restart=()=>{};';
            if (id === '\0rating:@/providers/song-controls')
              return (
                b +
                'export const getSongControls=()=>({play:()=>b.effects.push("play"),playPause:()=>b.effects.push("playPause"),next:()=>b.effects.push("next"),previous:()=>b.effects.push("previous")});'
              );
            if (id === '\0rating:./utils')
              return (
                b +
                `export const ToastStyles={logo:1,legacy:7},secondsToMinutes=s=>String(s),notificationImage=()=>{b.hook?.('image');return 'source-only icon'};`
              );
            if (id === '\0rating:./interactive')
              return 'export default ()=>{throw Error("normal source fixture used interactive")};';
            if (id === '\0rating:@/i18n')
              return 'export const APPLICATION_NAME="Pear",t=k=>k;';
            if (id === '\0rating:@/providers/song-info')
              return (
                b +
                `export const SongInfoEvent={VideoSrcChanged:'peard:video-src-changed',PlayOrPaused:'peard:play-or-paused',TimeChanged:'peard:time-changed'};export const registerCallback=(fn,o)=>{b.callbacks.add(fn);if(o?.replayCurrent&&b.current)fn(b.current,'peard:video-src-changed');return()=>b.callbacks.delete(fn)};export const getSongInfoProvenance=i=>i===b.current?b.provenance:null;export const getSongInfoPlaybackBinding=i=>i===b.current?b.binding:null;export const isSongInfoCurrent=(i,w)=>i===b.current&&w===b.window;`
              );
          },
          transform(code, id) {
            if (
              options.manualTimers &&
              normalizePath(id).includes('/src/plugins/notifications/')
            )
              return code
                .replaceAll(
                  'setTimeout(',
                  `globalThis[${JSON.stringify(key)}].schedule(`,
                )
                .replaceAll(
                  'clearTimeout(',
                  `globalThis[${JSON.stringify(key)}].cancel(`,
                );
          },
        },
      ],
      build: {
        ssr: path.join(directory, 'entry.ts'),
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    const source = await import(
      pathToFileURL(path.join(directory, 'source.mjs')).href
    );
    const config = {
      enabled: true,
      interactive: false,
      unpauseNotification: true,
      notifyOnLikeChange: false,
      urgency: 'normal',
    };
    const info = {
      title: 'Owned title',
      artist: 'Artist',
      url: 'https://fixture.invalid/watch?v=seeded00001',
      videoId: 'seeded00001',
      isPaused: false,
    };
    const context: any = {
      window,
      getConfig: () => config,
      ipc: { send: contents.send },
    };
    return {
      source,
      state,
      config,
      info,
      context,
      emit(event = 'peard:video-src-changed') {
        state.current = info;
        for (const callback of [...callbacks]) callback(info, event);
      },
      drain: () => new Promise((r) => setTimeout(r, 25)),
      async close() {
        source.onMainStop?.();
        delete (globalThis as any)[key];
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    delete (globalThis as any)[key];
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
