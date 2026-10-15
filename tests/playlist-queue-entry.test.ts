import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { playlistRendererFixture } from './helpers/playlist-renderer-fixture';

async function entry() {
  const f = await playlistRendererFixture();
  f.controller.dispose();
  f.packets.length = 0;
  const w = f.dom as any;
  const api = f.dom.document.createElement('div') as any;
  api.id = 'movie_player';
  f.dom.document.body.append(api, f.dom.document.createElement('video'));
  const bar = f.dom.document.createElement('ytmusic-player-bar') as any;
  f.dom.document.body.append(bar);
  let mode = 'NONE';
  bar.getState = () => ({ queue: { repeatMode: mode } });
  bar.onRepeatButtonClick = () => {
    mode = ['NONE', 'ALL', 'ONE'][
      (['NONE', 'ALL', 'ONE'].indexOf(mode) + 1) % 3
    ];
  };
  const volumes: number[] = [],
    seeks: number[] = [];
  api.setVolume = (v: number) => volumes.push(v);
  api.getCurrentTime = () => 20;
  api.seekTo = (v: number) => seeks.push(v);
  api.seekBy = (v: number) => seeks.push(v);
  w.electronIs = {
    osx: () => false,
    windows: () => false,
    linux: () => true,
    dev: () => false,
  };
  w.mainConfig = { get: () => undefined };
  w.ipcRenderer.on = (channel: string, fn: any) =>
    w.ipcRenderer.subscribe(channel, (...args: unknown[]) => fn({}, ...args));
  const strip = (source: string) =>
    stripTypeScriptTypes(source)
      .replace(/^import[\s\S]*?;\n/gm, '')
      .replace(/^export /gm, '');
  const repeat = strip(
    await readFile(
      new URL('../src/providers/repeat-preference.ts', import.meta.url),
      'utf8',
    ),
  );
  const actions = strip(
    await readFile(
      new URL('../src/providers/music-actions.ts', import.meta.url),
      'utf8',
    ),
  );
  const audio = strip(
    await readFile(
      new URL('../src/providers/renderer-audio.ts', import.meta.url),
      'utf8',
    ),
  );
  const raw = stripTypeScriptTypes(
    await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8'),
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(
      /initObserver\(\)\s*\.then\(preload\)[\s\S]*?;\s*$/,
      'export {listenForApiLoad,onApiLoaded,getCurrentAudioGraph};',
    );
  const key = 'queueEntry_' + crypto.randomUUID();
  (globalThis as any)[key] = { dom: f.dom, make: f.make };
  const boundary = `const fixture=globalThis[${JSON.stringify(key)}];const window=fixture.dom;const document=window.document;const {Element,HTMLElement,Event,CustomEvent}=window;const createPlaylistQueueController=fixture.make;const setTheme=()=>{};const registerWindowDefaultTrustedTypePolicy=()=>{};const LoggerPrefix='fixture';const retireLanguageRequests=()=>{};const i18t=x=>x;const getAllLoadedRendererPlugins=()=>({});const startingPages={};class AudioContext extends window.EventTarget{destination={};createGain(){return{gain:{value:1},connect(){},disconnect(){}}}createMediaElementSource(element){return{mediaElement:element,connect(){},disconnect(){}}}};`;
  const source = await import(
    'data:text/javascript;base64,' +
      Buffer.from(boundary + actions + repeat + audio + raw).toString('base64')
  );
  await source.listenForApiLoad();
  return {
    ...f,
    source,
    volumes,
    seeks,
    mode: () => mode,
    close: async () => {
      f.dom.dispatchEvent(new f.dom.Event('pagehide'));
      delete (globalThis as any)[key];
      await f.close();
    },
  };
}
const rows = (...ids: string[]) =>
  ids.map((videoId) => ({
    content: { playlistPanelVideoRenderer: { videoId } },
  }));

test('actual renderer entry installs new playlist IPC and preserves one legacy single-add handler', async () => {
  const f = await entry();
  try {
    const owner = f.owner();
    expect(typeof owner).toBe('string');
    const id = f.nextId();
    f.emit('peard:add-playlist-to-queue', {
      requestId: id,
      ownerId: owner,
      playlistId: 'PLABCDEFGHIJKLMN',
      insertPosition: 'INSERT_AT_END',
    });
    expect(f.fetches).toHaveLength(1);
    f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
    await f.flush();
    f.emit('peard:add-to-queue', 'bbbbbbbbbbb', 'INSERT_AT_END');
    expect(f.fetches).toHaveLength(2);
    f.fetches[1].resolve({ queueDatas: rows('bbbbbbbbbbb') });
    await f.flush();
    expect(f.dispatches).toHaveLength(2);
    expect(f.intents()).toBe(2);
    expect(f.callbacks.get('peard:add-to-queue')?.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('actual renderer replacement retires old scope and retains only one owned queue subscription', async () => {
  const f = await entry();
  try {
    const old = f.owner();
    expect(typeof old).toBe('string');
    const id = f.nextId();
    f.emit('peard:add-playlist-to-queue', {
      requestId: id,
      ownerId: old,
      playlistId: 'PLABCDEFGHIJKLMN',
      insertPosition: 'INSERT_AT_END',
    });
    await f.source.onApiLoaded();
    const fresh = f.owner();
    expect(typeof fresh).toBe('string');
    expect(fresh).not.toBe(old);
    expect(f.callbacks.get('peard:add-to-queue')?.size).toBe(1);
    f.fetches[0].resolve({ queueDatas: rows('aaaaaaaaaaa') });
    await f.flush();
    expect(f.dispatches).toEqual([]);
  } finally {
    await f.close();
  }
});

test('actual entry retains parent repeat, relative seek, volume clamp and audio graph initialization', async () => {
  const f = await entry();
  try {
    f.emit('peard:switch-repeat', 2);
    expect(f.mode()).toBe('ONE');
    f.emit('peard:seek-by', 7);
    expect(f.seeks).toEqual([7]);
    f.emit('peard:update-volume', 140);
    expect(f.volumes).toEqual([100]);
    expect(
      f.source.getCurrentAudioGraph()?.audioSource.mediaElement.tagName,
    ).toBe('VIDEO');
  } finally {
    await f.close();
  }
});
