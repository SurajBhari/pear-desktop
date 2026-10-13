import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import * as dbus from '@jellybrick/dbus-next';

const root = path.resolve(import.meta.dirname, '../..');
export async function taskbarFixture() {
  const callbacks = new Set<any>(),
    tokens = new WeakMap<object, object>();
  const provenance = new WeakMap<object, object>(),
    ipcMain = new EventEmitter();
  const sends: any[] = [],
    buses: any[] = [];
  const native = {
    ipcMain,
    callbacks,
    tokens,
    provenance,
    current: undefined as any,
    Message: dbus.Message,
    Variant: dbus.Variant,
    sessionBus() {
      const bus = new EventEmitter() as any;
      bus.signals = [];
      bus.send = (value: any) => bus.signals.push(value);
      bus.disconnect = () => {
        bus.disconnected = true;
      };
      buses.push(bus);
      return bus;
    },
  };
  (globalThis as any).__taskbarNative = native;
  const folder = await mkdtemp(path.join(tmpdir(), 'pear-taskbar-'));
  let source: any = {};
  if (existsSync(path.join(root, 'src/plugins/taskbar-progress/main.ts'))) {
    const files: Record<string, string> = {
      'entry.ts': `export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/taskbar-progress/main.ts'))};export {default as plugin} from ${JSON.stringify(path.join(root, 'src/plugins/taskbar-progress/index.ts'))};${existsSync(path.join(root, 'src/plugins/taskbar-progress/linux.ts')) ? `export {createLinuxProgress} from ${JSON.stringify(path.join(root, 'src/plugins/taskbar-progress/linux.ts'))};` : ''}`,
      'utils.ts':
        'export const createBackend=x=>x;export const createPlugin=x=>x;',
      'i18n.ts': 'export const t=x=>x;',
      'electron.ts': 'export const ipcMain=globalThis.__taskbarNative.ipcMain;',
      'song-info.ts': `const f=globalThis.__taskbarNative;export const getSongInfoProvenance=x=>f.provenance.get(x);export const getCurrentSongInfoProvenance=w=>f.tokens.get(w);export const registerCallback=(fn,options)=>{f.callbacks.add(fn);if(options?.replayCurrent&&f.current)fn(f.current,'metadata');return()=>f.callbacks.delete(fn);};`,
      'dbus.ts':
        'const f=globalThis.__taskbarNative;export const Message=f.Message;export const Variant=f.Variant;export const sessionBus=()=>f.sessionBus();',
    };
    for (const [name, body] of Object.entries(files))
      await writeFile(path.join(folder, name), body);
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: {
        alias: [
          { find: '@/utils', replacement: path.join(folder, 'utils.ts') },
          { find: '@/i18n', replacement: path.join(folder, 'i18n.ts') },
          {
            find: '@/providers/song-info',
            replacement: path.join(folder, 'song-info.ts'),
          },
          { find: 'electron', replacement: path.join(folder, 'electron.ts') },
          {
            find: '@jellybrick/dbus-next',
            replacement: path.join(folder, 'dbus.ts'),
          },
          { find: '@', replacement: path.join(root, 'src') },
        ],
      },
      build: {
        ssr: path.join(folder, 'entry.ts'),
        outDir: folder,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    source = await import(pathToFileURL(path.join(folder, 'source.mjs')).href);
  }
  const windows: any[] = [];
  function windowFixture() {
    const window = new EventEmitter() as any;
    window.destroyed = false;
    window.isDestroyed = () => window.destroyed;
    const contents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      isDestroyed: () => window.destroyed,
    });
    window.webContents = contents;
    window.effects = [];
    window.setProgressBar = (...args: any[]) => {
      window.effects.push(args);
      window.sideEffect?.();
    };
    tokens.set(window, {});
    windows.push(window);
    const context = {
      window,
      ipc: { send: (...args: any[]) => sends.push({ window, args }) },
    };
    return { window, context };
  }
  function song(window: any, values: any = {}) {
    const value = {
      title: 'Fixture',
      videoId: 'current0001',
      elapsedSeconds: 25,
      songDuration: 100,
      isPaused: false,
      ...values,
    };
    provenance.set(value, tokens.get(window)!);
    return value;
  }
  return {
    source,
    native,
    sends,
    buses,
    windowFixture,
    song,
    emit(info: any) {
      for (const fn of [...callbacks]) fn(info, 'time');
    },
    async close() {
      for (const window of windows) source.backend?.stop({ window });
      delete (globalThis as any).__taskbarNative;
      await rm(folder, { recursive: true, force: true });
    },
  };
}
