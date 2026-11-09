import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';

import { expect, test } from '@playwright/test';
import { Window } from 'happy-dom';
import { headlessApiMenuBoundary } from './helpers/api-headless-menu-boundary';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));

async function registeredVolumeHandler() {
  const source = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
  const { parse } = requireVite('@babel/parser');
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const pending: any[] = [tree];
  const matches: { start: number; end: number }[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (
      node?.type === 'CallExpression' &&
      node.callee?.object?.object?.name === 'window' &&
      node.callee?.object?.property?.name === 'ipcRenderer' &&
      node.callee?.property?.name === 'on' &&
      node.arguments?.[0]?.value === 'peard:update-volume'
    )
      matches.push(node);
    for (const value of Object.values(node ?? {})) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  expect(matches).toHaveLength(1);
  // Execute the complete registration expression from current production
  // source; do not copy its setter, cancellation or slider implementation.
  return source.slice(matches[0].start, matches[0].end);
}

async function fixture({ bar = true, sliders = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-volume-write-'));
  const dom = new Window({ url: 'https://fixture.invalid/' });
  const renderer = new EventEmitter();
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    ['window', 'document', 'CustomEvent', 'HTMLVideoElement'].map((key) => [
      key,
      globals[key],
    ]),
  );
  let source: any;
  Object.assign(dom, {
    ipcRenderer: {
      on: (event: string, listener: (...args: any[]) => void) =>
        renderer.on(event, listener),
      emit: (event: string, ...args: any[]) => renderer.emit(event, ...args),
      send: (event: string, ...args: unknown[]) =>
        source.ipcMain.emit(event, {}, ...args),
    },
  });
  globals.window = dom;
  globals.document = dom.document;
  globals.CustomEvent = dom.CustomEvent;
  globals.HTMLVideoElement = dom.HTMLVideoElement;
  dom.document.body.innerHTML = `
    <video></video>
    ${bar ? '<ytmusic-player-bar></ytmusic-player-bar>' : ''}
    ${sliders ? '<input id="volume-slider" type="range" min="0" max="100" value="37"><input id="expand-volume-slider" type="range" min="0" max="100" value="37">' : ''}`;
  const native = `
import {EventEmitter} from 'node:events';
export const ipcMain=new EventEmitter(),app=new EventEmitter();
export const state={volume:37,muted:true,sceneActive:true,trace:[]};
const reportNativeChange=()=>document.querySelector('video').dispatchEvent(new window.Event('volumechange',{bubbles:false}));
export const fixtureAPI={getVolume:()=>state.volume,isMuted:()=>state.muted,setVolume(value){state.trace.push(['api-set',value,state.sceneActive]);state.volume=value;reportNativeChange();}};
export const fixtureWindow={webContents:{send:(event,...args)=>window.ipcRenderer.emit(event,{},...args),executeJavaScript:async()=>undefined}};
export const dialog={},nativeImage={};export const net={fetch(){throw Error('Remote fixture network prohibited');}};
`;
  const entry = path.join(directory, 'entry.ts');
  await writeFile(
    entry,
    `import {fixtureAPI as api} from 'electron';
export {backend} from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/main.ts'))};
export {setupVolumeChangedListener} from ${JSON.stringify(path.join(root, 'src/providers/song-info-front.ts'))};
export {getSongControls} from ${JSON.stringify(path.join(root, 'src/providers/song-controls.ts'))};
export {fixtureAPI,fixtureWindow,ipcMain,state} from 'electron';
${await registeredVolumeHandler()};`,
  );
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const bundle = await rolldown({
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
                /* try the next actual source suffix */
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
  await bundle.write({ file: output, format: 'cjs', codeSplitting: false });
  await bundle.close();
  source = requireRoot(output);
  Object.assign(dom, {
    blockerSceneGuard: {
      cancelFromUser: () => {
        source.state.trace.push(['cancel']);
        source.state.sceneActive = false;
      },
    },
  });
  const playerBar = dom.document.querySelector('ytmusic-player-bar');
  if (playerBar)
    Object.assign(playerBar, {
      updateVolume: () => {
        // Controlled non-percent native boundary matching the reported
        // POST60 -> GET29 symptom. It is not a copy of Music's transform.
        source.state.volume = 29;
        dom.document
          .querySelector('video')!
          .dispatchEvent(new dom.Event('volumechange', { bubbles: false }));
      },
    });
  renderer.on('peard:setup-volume-changed-listener', () =>
    source.setupVolumeChangedListener(source.fixtureAPI),
  );
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
  await source.backend.start({
    getConfig: async () => config,
    setConfig: async () => {},
    window: source.fixtureWindow,
    ipc: {
      on: (event: string, callback: (...args: unknown[]) => void) =>
        source.ipcMain.on(event, (_: unknown, ...args: unknown[]) =>
          callback(...args),
        ),
      send: (...args: unknown[]) =>
        source.fixtureWindow.webContents.send(...args),
    },
  });
  if (!source.backend.server.listening)
    await once(source.backend.server, 'listening');
  const url = `http://127.0.0.1:${source.backend.server.address().port}/api/v1/volume`;
  return {
    source,
    dom,
    get: async () => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      return response.json();
    },
    post: (volume: number) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ volume }),
      }),
    emit: (volume: number) =>
      source.fixtureWindow.webContents.send('peard:update-volume', volume),
    sliderValues: () =>
      Array.from(dom.document.querySelectorAll<HTMLInputElement>('input')).map(
        (slider) => slider.value,
      ),
    close: async () => {
      const server = source.backend.server;
      const closed = server ? once(server, 'close') : undefined;
      source.backend.stop();
      if (closed) await closed;
      delete requireRoot.cache[output];
      await dom.happyDOM.close();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of saved) globals[key] = value;
    },
  };
}

test('actual HTTP volume write roundtrips on the player API percentage scale and updates both sliders', async () => {
  const f = await fixture();
  try {
    expect(await f.get()).toEqual({ state: 37, isMuted: true });
    expect((await f.post(60)).status).toBe(204);
    expect(await f.get()).toEqual({ state: 60, isMuted: true });
    expect(f.sliderValues()).toEqual(['60', '60']);
    // A volume user action must cancel scene restoration before its native write.
    expect(f.source.state.trace).toEqual([['cancel'], ['api-set', 60, false]]);
  } finally {
    await f.close();
  }
});

test('native volume IPC keeps zero low and endpoint percentages and clamps out-of-range requests', async () => {
  const f = await fixture();
  try {
    for (const [input, expected] of [
      [0, 0],
      [1, 1],
      [12.5, 12.5],
      [37, 37],
      [100, 100],
      [-20, 0],
      [120, 100],
    ]) {
      f.emit(input);
      expect(await f.get()).toEqual({ state: expected, isMuted: true });
      expect(f.sliderValues()).toEqual([String(expected), String(expected)]);
    }
  } finally {
    await f.close();
  }
});

test('volume write works when the bar and optional sliders are not present', async () => {
  const f = await fixture({ bar: false, sliders: false });
  try {
    expect((await f.post(60)).status).toBe(204);
    expect(await f.get()).toEqual({ state: 60, isMuted: true });
    expect(f.source.state.trace).toEqual([['cancel'], ['api-set', 60, false]]);
  } finally {
    await f.close();
  }
});

test('nonfinite native volume requests cannot corrupt state or cancel an active scene', async () => {
  const f = await fixture();
  try {
    for (const input of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      f.emit(input);
    expect(await f.get()).toEqual({ state: 37, isMuted: true });
    expect(f.source.state.trace).toEqual([]);
    expect(f.source.state.sceneActive).toBe(true);
    expect(f.sliderValues()).toEqual(['37', '37']);
  } finally {
    await f.close();
  }
});

test('actual song controls preserve numeric and parsed string-array volume requests', async () => {
  const f = await fixture();
  try {
    const controls = f.source.getSongControls(f.source.fixtureWindow);
    controls.setVolume(12.5);
    expect(await f.get()).toEqual({ state: 12.5, isMuted: true });
    controls.setVolume(['60']);
    expect(await f.get()).toEqual({ state: 60, isMuted: true });
    expect(f.sliderValues()).toEqual(['60', '60']);
    expect(f.source.state.trace).toEqual([
      ['cancel'],
      ['api-set', 12.5, false],
      ['cancel'],
      ['api-set', 60, false],
    ]);
  } finally {
    await f.close();
  }
});

test('malformed or undefined song-control volume args cannot change state or cancel a scene', async () => {
  const f = await fixture();
  try {
    const controls = f.source.getSongControls(f.source.fixtureWindow);
    for (const input of [
      undefined,
      [],
      ['not-a-number'],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      controls.setVolume(input);
    // A scalar string is outside ArgsType<number>; the existing parser rejects
    // it. This does not claim or change the protocol-handler's spread behavior.
    controls.setVolume('60');
    expect(await f.get()).toEqual({ state: 37, isMuted: true });
    expect(f.source.state.trace).toEqual([]);
    expect(f.source.state.sceneActive).toBe(true);
  } finally {
    await f.close();
  }
});
