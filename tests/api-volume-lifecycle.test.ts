import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';
import { headlessApiMenuBoundary } from './helpers/api-headless-menu-boundary';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));

type Player = { getVolume(): number; isMuted(): boolean };

async function fixture({ ready = true, video = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-volume-test-'));
  const dom = new Window({ url: 'https://fixture.invalid/' });
  const renderer = new EventEmitter();
  let source: any;
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    ['window', 'document', 'CustomEvent', 'HTMLVideoElement'].map((key) => [
      key,
      globals[key],
    ]),
  );
  const rendererWindow = dom as unknown as Record<string, unknown>;
  rendererWindow.ipcRenderer = {
    on: (...args: any[]) => renderer.on(args[0], args[1]),
    emit: (...args: any[]) => renderer.emit(args[0], ...args.slice(1)),
    send: (event: string, ...args: unknown[]) => {
      source.fixtureState.received.push([event, ...args]);
      source.ipcMain.emit(event, {}, ...args);
    },
  };
  globals.window = dom;
  globals.document = dom.document;
  globals.CustomEvent = dom.CustomEvent;
  globals.HTMLVideoElement = dom.HTMLVideoElement;
  if (video) dom.document.body.innerHTML = '<video id="primary"></video>';
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `
export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};
export {setupVolumeChangedListener} from ${JSON.stringify(path.join(root, 'src/providers/song-info-front.ts'))};
export {ipcMain,fixtureWindow,fixtureState} from 'electron';
`,
  );
  const native = `
import {EventEmitter} from 'node:events';
export const ipcMain=new EventEmitter();export const app=new EventEmitter();export const fixtureState={sent:[],received:[]};
export const fixtureWindow={webContents:{send:(event,...args)=>{fixtureState.sent.push([event,...args]);window.ipcRenderer.emit(event,{},...args);},executeJavaScript:async()=>undefined}};
export const dialog={};export const nativeImage={};export const net={fetch:()=>{throw new Error('Fixture prohibits remote network');}};
`;
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const build = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      headlessApiMenuBoundary(root),
      {
        name: 'native-config-translation-boundaries',
        async resolveId(id: string) {
          if (id === 'electron') return '\0native';
          if (id === '@/config') return '\0config';
          if (id === '@/i18n') return '\0i18n';
          if (id.startsWith('@/')) {
            const target = path.join(root, 'src', id.slice(2));
            for (const suffix of ['.ts', '/index.ts', '.tsx']) {
              try {
                await access(target + suffix);
                return target + suffix;
              } catch {
                /* next source suffix */
              }
            }
          }
          if (
            !id.startsWith('.') &&
            !path.isAbsolute(id) &&
            !id.startsWith('\0')
          )
            return {
              id: id.startsWith('node:')
                ? id
                : requireRoot.resolve(id).replaceAll('\\', '/'),
              external: true,
            };
        },
        load(id: string) {
          if (id === '\0native') return native;
          if (id === '\0config')
            return 'export const get=()=>false;export const set=()=>{};';
          if (id === '\0i18n')
            return "export const APPLICATION_NAME='Fixture';export const t=(key)=>key;";
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await build.write({ file: output, format: 'cjs', codeSplitting: false });
  await build.close();
  source = requireRoot(output);
  const playerState = { volume: 37, muted: true, reads: 0 };
  const volumeReceivers: ((...args: unknown[]) => void)[] = [];
  let player: Player = {
    getVolume: () => {
      playerState.reads++;
      return playerState.volume;
    },
    isMuted: () => {
      playerState.reads++;
      return playerState.muted;
    },
  };
  let installed = false;
  const markReady = () => {
    if (!installed) {
      // The controlled IPC transport invokes the actual exported frontend
      // setup function; no copied cache, router or event-hook implementation.
      renderer.on('peard:setup-volume-changed-listener', () =>
        source.setupVolumeChangedListener(player),
      );
      installed = true;
    }
    source.ipcMain.emit('peard:player-api-loaded', {});
  };
  if (ready) markReady();
  const config = {
    enabled: true,
    hostname: '127.0.0.1',
    port: 0,
    authStrategy: 'NONE',
    secret: 'public-fixture',
    authorizedClients: [],
    useHttps: false,
    certPath: '',
    keyPath: '',
  };
  const ctx = {
    getConfig: async () => config,
    setConfig: async () => {},
    window: source.fixtureWindow,
    ipc: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'peard:volume-changed') volumeReceivers.push(listener);
        return source.ipcMain.on(event, (_: unknown, ...args: unknown[]) =>
          listener(...args),
        );
      },
      send: (...args: unknown[]) =>
        source.fixtureWindow.webContents.send(...args),
    },
  };
  const stop = async () => {
    const server = source.backend.server;
    const closed = server ? once(server, 'close') : undefined;
    source.backend.stop();
    if (closed) await closed;
  };
  const start = async () => {
    await source.backend.start(ctx);
    if (!source.backend.server.listening)
      await once(source.backend.server, 'listening');
  };
  return {
    source,
    dom,
    playerState,
    volumeReceivers,
    start,
    stop,
    markReady,
    snapshot: () =>
      source.fixtureWindow.webContents.send(
        'peard:setup-volume-changed-listener',
      ),
    useApi: (api: Player) => {
      player = api;
    },
    reports: () =>
      source.fixtureState.received.filter(
        (x: unknown[]) => x[0] === 'peard:volume-changed',
      ).length,
    event: (target: HTMLElement) =>
      target.dispatchEvent(new dom.Event('volumechange', { bubbles: false })),
    get: async () => {
      const response = await fetch(
        `http://127.0.0.1:${source.backend.server.address().port}/api/v1/volume`,
      );
      expect(response.status).toBe(200);
      return response.json();
    },
    close: async () => {
      await stop();
      delete requireRoot.cache[output];
      await dom.happyDOM.close();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of saved) globals[key] = value;
    },
  };
}

test('late API enable reports the ready player snapshot before any subsequent event', async () => {
  const f = await fixture();
  try {
    await f.start();
    expect(await f.get()).toEqual({ state: 37, isMuted: true });
    expect(
      f.source.fixtureState.sent
        .filter((x: unknown[]) => x[0]?.toString().startsWith('peard:setup-'))
        .map((x: unknown[]) => x[0]),
    ).toEqual([
      'peard:setup-repeat-changed-listener',
      'peard:setup-volume-changed-listener',
    ]);
  } finally {
    await f.close();
  }
});

test('early API start retains readiness fallback for the initial volume snapshot', async () => {
  const f = await fixture({ ready: false });
  try {
    await f.start();
    f.markReady();
    expect(await f.get()).toEqual({ state: 37, isMuted: true });
  } finally {
    await f.close();
  }
});

test('volume capture handles a video inserted after initial setup', async () => {
  const f = await fixture({ video: false });
  try {
    await f.start();
    f.markReady();
    domVideo(f.dom);
    f.playerState.volume = 73;
    f.playerState.muted = false;
    f.event(f.dom.document.querySelector('video')!);
    expect(await f.get()).toEqual({ state: 73, isMuted: false });
  } finally {
    await f.close();
  }
});

function domVideo(dom: Window) {
  dom.document.body.innerHTML = '<video id="primary"></video>';
}

test('replacement current video updates state while stale, extra and non-video events are ignored', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    const stale = f.dom.document.querySelector('video')!;
    domVideo(f.dom);
    const current = f.dom.document.querySelector('video')!;
    f.playerState.volume = 61;
    f.playerState.muted = false;
    f.event(current);
    expect(await f.get()).toEqual({ state: 61, isMuted: false });
    const extra = f.dom.document.createElement('video');
    const div = f.dom.document.createElement('div');
    f.dom.document.body.append(extra, div);
    const before = f.reports();
    f.playerState.volume = 99;
    f.playerState.muted = true;
    f.event(stale);
    f.event(extra);
    f.event(div);
    expect(f.reports() - before).toBe(0);
    expect(await f.get()).toEqual({ state: 61, isMuted: false });
  } finally {
    await f.close();
  }
});

test('repeat setup refreshes snapshots and retains exactly one non-bubbling event report', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    f.playerState.volume = 64;
    f.playerState.muted = false;
    f.snapshot();
    f.snapshot();
    expect(await f.get()).toEqual({ state: 64, isMuted: false });
    const before = f.reports();
    f.playerState.volume = 73;
    f.event(f.dom.document.querySelector('video')!);
    expect(f.reports() - before).toBe(1);
    expect(await f.get()).toEqual({ state: 73, isMuted: false });
  } finally {
    await f.close();
  }
});

test('repeat setup refreshes the player API reference and includes mute changes', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    const replacement = { volume: 82, muted: false };
    const oldReads = f.playerState.reads;
    f.useApi({
      getVolume: () => replacement.volume,
      isMuted: () => replacement.muted,
    });
    f.snapshot();
    expect(await f.get()).toEqual({ state: 82, isMuted: false });
    replacement.muted = true;
    f.event(f.dom.document.querySelector('video')!);
    expect(await f.get()).toEqual({ state: 82, isMuted: true });
    expect(f.playerState.reads - oldReads).toBe(0);
  } finally {
    await f.close();
  }
});

test('API stop/start refreshes current volume without duplicating frontend capture', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.markReady();
    await f.stop();
    f.playerState.volume = 29;
    f.playerState.muted = false;
    await f.start();
    expect(await f.get()).toEqual({ state: 29, isMuted: false });
    const before = f.reports();
    f.playerState.volume = 55;
    f.event(f.dom.document.querySelector('video')!);
    expect(f.reports() - before).toBe(1);
    expect(await f.get()).toEqual({ state: 55, isMuted: false });
  } finally {
    await f.close();
  }
});

test('stopped/old volume callbacks do not own the new context and readiness sends one volume setup', async () => {
  const f = await fixture();
  try {
    await f.start();
    const old = f.volumeReceivers.at(-1)!;
    await f.stop();
    const stoppedCache = f.source.backend.volumeState;
    old({ state: 91, isMuted: false });
    expect(f.source.backend.volumeState).toEqual(stoppedCache);
    f.playerState.volume = 48;
    f.playerState.muted = false;
    await f.start();
    old({ state: 99, isMuted: true });
    expect(await f.get()).toEqual({ state: 48, isMuted: false });
    const before = f.source.fixtureState.sent.filter(
      (x: unknown[]) => x[0] === 'peard:setup-volume-changed-listener',
    ).length;
    f.markReady();
    const after = f.source.fixtureState.sent.filter(
      (x: unknown[]) => x[0] === 'peard:setup-volume-changed-listener',
    ).length;
    expect(after - before).toBe(1);
    expect(await f.get()).toEqual({ state: 48, isMuted: false });
  } finally {
    await f.close();
  }
});
