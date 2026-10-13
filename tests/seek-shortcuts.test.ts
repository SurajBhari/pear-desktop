import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test, expect } from '@playwright/test';
import { transformWithOxc } from 'vite';

async function fixture() {
  const provider = await readFile(
    new URL('../src/providers/song-info.ts', import.meta.url),
    'utf8',
  );
  const enumCode = (
    await transformWithOxc(
      provider.match(/export enum MediaType \{[\s\S]*?\n\}/)![0],
      'media.ts',
    )
  ).code;
  const { MediaType } = await import(
    `data:text/javascript;base64,${Buffer.from(enumCode).toString('base64')}`
  );
  const sent: any[] = [];
  const global = new Map<string, () => void>();
  const local = new Map<string, () => void>();
  const songListeners = new Set<any>();
  const key = `seek_${crypto.randomUUID()}`;
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args: any[]) => sent.push(args) },
  };
  const state = {
    window,
    MediaType,
    current: { mediaType: MediaType.Audio },
    songListeners,
    global,
    local,
    sent,
  };
  (globalThis as any)[key] = state;
  const controls = stripTypeScriptTypes(
    await readFile(
      new URL('../src/providers/song-controls.ts', import.meta.url),
      'utf8',
    ),
  )
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '');
  const main = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/shortcuts/main.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `const state=globalThis[${JSON.stringify(key)}];const MediaType=state.MediaType;const is={linux:()=>false};const registerMPRIS=()=>{};const createBackend=x=>x;
const globalShortcut={isRegistered:key=>state.global.has(key),register:(key,fn)=>{if(state.global.has(key))return false;state.global.set(key,fn);return true},unregister:key=>state.global.delete(key)};
const registerElectronLocalShortcut=(win,key,fn)=>state.local.set(key,fn);const unregisterElectronLocalShortcut=(win,key)=>state.local.delete(key);const isRegisteredElectronLocalShortcut=(win,key)=>state.local.has(key);
const registerCallback=(fn,options)=>{state.songListeners.add(fn);if(options?.replayCurrent)fn(state.current);return()=>state.songListeners.delete(fn)};`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundary + controls + main).toString('base64')}`
  );
  const config = {
    enabled: true,
    overrideMediaKeys: false,
    global: {
      seekForward: 'Alt+Right',
      seekBackward: 'Alt+Left',
      next: 'Alt+Down',
    },
    local: { seekForward: 'Control+Right' },
    seekForwardSeconds: 7,
    seekBackwardSeconds: 9,
    podcastSeekForwardSeconds: 11,
    podcastSeekBackwardSeconds: 31,
  };
  const backend = source.backend;
  const ctx = { window, getConfig: async () => config };
  return {
    state,
    config,
    source,
    start: async (context = ctx) => {
      if (backend) await backend.start(context);
      else await source.onMainLoad(context);
    },
    stop: () => backend?.stop(),
    song: (type: string) => {
      state.current = { mediaType: type };
      for (const fn of songListeners) fn(state.current);
    },
    close: () => {
      backend?.stop();
      delete (globalThis as any)[key];
    },
  };
}

test('global and local seek bindings use configured music and podcast durations', async () => {
  const f = await fixture();
  try {
    await f.start();
    expect(f.state.global.has('Alt+Right')).toBe(true);
    f.state.global.get('Alt+Right')!();
    f.state.global.get('Alt+Left')!();
    f.state.local.get('Control+Right')!();
    expect(f.state.sent).toEqual([
      ['peard:seek-by', 7],
      ['peard:seek-by', -9],
      ['peard:seek-by', 7],
    ]);
    f.song(f.state.MediaType.PodcastEpisode);
    f.state.global.get('Alt+Right')!();
    f.state.global.get('Alt+Left')!();
    expect(f.state.sent.slice(-2)).toEqual([
      ['peard:seek-by', 11],
      ['peard:seek-by', -31],
    ]);
  } finally {
    f.close();
  }
});

test('late enable replays current podcast metadata and disposes bindings/listener on stop', async () => {
  const f = await fixture();
  try {
    f.state.current = { mediaType: f.state.MediaType.PodcastEpisode };
    await f.start();
    expect(f.state.global.has('Alt+Right')).toBe(true);
    f.state.global.get('Alt+Right')!();
    expect(f.state.sent.at(-1)).toEqual(['peard:seek-by', 11]);
    const retained = f.state.global.get('Alt+Right')!;
    f.stop();
    retained();
    expect(f.state.sent).toHaveLength(1);
    expect(f.state.global.size).toBe(0);
    expect(f.state.local.size).toBe(0);
    expect(f.state.songListeners.size).toBe(0);
  } finally {
    f.close();
  }
});

test('stopped config startup cannot register shortcuts after a newer session', async () => {
  const f = await fixture();
  try {
    let release: any;
    const pending = new Promise<any>((resolve) => (release = resolve));
    const old = f.start({ window: f.state.window, getConfig: () => pending });
    f.stop();
    await f.start();
    const count = f.state.global.size;
    release({ ...f.config, global: { ...f.config.global, next: 'Alt+Up' } });
    await old;
    expect(f.state.global.size).toBe(count);
    expect(f.state.songListeners.size).toBe(1);
  } finally {
    f.close();
  }
});

test('numeric seek arrays are parsed before renderer IPC', async () => {
  const f = await fixture();
  try {
    const raw = stripTypeScriptTypes(
      await readFile(
        new URL('../src/providers/song-controls.ts', import.meta.url),
        'utf8',
      ),
    ).replace(/^import[\s\S]*?;\n/gm, '');
    const source = await import(
      `data:text/javascript;base64,${Buffer.from(raw).toString('base64')}`
    );
    source.getSongControls(f.state.window).goForward(['12']);
    expect(f.state.sent).toEqual([['peard:seek-by', 12]]);
  } finally {
    f.close();
  }
});

test('invalid seek durations fall back safely and oversized values clamp', async () => {
  const f = await fixture();
  try {
    f.config.seekForwardSeconds = Infinity;
    f.config.seekBackwardSeconds = -2;
    await f.start();
    f.state.global.get('Alt+Right')!();
    f.state.global.get('Alt+Left')!();
    expect(f.state.sent).toEqual([
      ['peard:seek-by', 5],
      ['peard:seek-by', -5],
    ]);
    f.source.backend.onConfigChange({ ...f.config, seekForwardSeconds: 2000 });
    f.state.global.get('Alt+Right')!();
    expect(f.state.sent.at(-1)).toEqual(['peard:seek-by', 600]);
  } finally {
    f.close();
  }
});

test('reconfiguration fences old bindings and stop preserves foreign accelerators', async () => {
  const f = await fixture();
  try {
    let foreign = 0;
    f.state.global.set('Alt+Right', () => foreign++);
    await f.start();
    const old = f.state.local.get('Control+Right')!;
    f.source.backend.onConfigChange({
      ...f.config,
      local: { seekForward: 'Control+Up' },
    });
    old();
    expect(f.state.sent).toEqual([]);
    f.stop();
    f.state.global.get('Alt+Right')!();
    expect(foreign).toBe(1);
    expect(f.state.global.size).toBe(1);
  } finally {
    f.close();
  }
});

test('non-finite numeric protocol seeks are rejected instead of reaching renderer', async () => {
  const f = await fixture();
  try {
    const raw = stripTypeScriptTypes(
      await readFile(
        new URL('../src/providers/song-controls.ts', import.meta.url),
        'utf8',
      ),
    ).replace(/^import[\s\S]*?;\n/gm, '');
    const source = await import(
      `data:text/javascript;base64,${Buffer.from(raw).toString('base64')}`
    );
    const controls = source.getSongControls(f.state.window);
    for (const value of [NaN, Infinity, -Infinity, ['bad'], ['Infinity'], []]) {
      controls.goForward(value);
      controls.goBack(value);
      controls.seekTo(value);
    }
    expect(f.state.sent).toEqual([]);
  } finally {
    f.close();
  }
});
