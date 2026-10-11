import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Window } from 'happy-dom';
import { test, expect } from '@playwright/test';
import { playlistProviderSource } from './helpers/playlist-provider-source';

async function fixture(mode = 'ALL') {
  const dom = new Window();
  dom.document.body.innerHTML =
    '<ytmusic-player-bar><div id="right-controls"><button class="repeat">Repeat</button></div></ytmusic-player-bar><video></video>';
  const bar = dom.document.querySelector('ytmusic-player-bar')! as any;
  const state = {
    mode,
    id: 'A',
    clicks: 0,
    handlers: new Map(),
    timers: new Map<number, { fn: () => void; delay: number }>(),
  };
  bar.getState = () => ({ queue: { repeatMode: state.mode } });
  bar.onRepeatButtonClick = () => {
    state.clicks++;
    state.mode = ['NONE', 'ALL', 'ONE'][
      (['NONE', 'ALL', 'ONE'].indexOf(state.mode) + 1) % 3
    ];
  };
  bar
    .querySelector('.repeat')
    .addEventListener('click', bar.onRepeatButtonClick);
  let serial = 0;
  const w = dom as any;
  w.electronIs = {
    osx: () => false,
    windows: () => false,
    linux: () => true,
    dev: () => false,
  };
  w.mainConfig = { get: () => undefined };
  w.ipcRenderer = {
    subscribe: (id: string, fn: (...args: unknown[]) => void) => {
      const handler = (_: unknown, ...args: unknown[]) => fn(...args);
      state.handlers.set(id, handler);
      return () => {
        if (state.handlers.get(id) === handler) state.handlers.delete(id);
      };
    },
    on: (id: string, fn: any) => state.handlers.set(id, fn),
    send() {},
  };
  w.setTimeout = (fn: () => void, delay: number) => {
    state.timers.set(++serial, { fn, delay });
    return serial;
  };
  w.clearTimeout = (id: number) => state.timers.delete(id);
  const key = `repeat_${crypto.randomUUID()}`;
  (globalThis as any)[key] = { dom, state };
  let helper = '';
  try {
    helper = stripTypeScriptTypes(
      await readFile(
        new URL('../src/providers/repeat-preference.ts', import.meta.url),
        'utf8',
      ),
    )
      .replace(/^import[\s\S]*?;\n/gm, '')
      .replace(/export /g, '');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const raw = await readFile(
    new URL('../src/renderer.ts', import.meta.url),
    'utf8',
  );
  const actual = stripTypeScriptTypes(raw)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(
      'initObserver().then(preload).then(main);',
      'export {onApiLoaded};',
    );
  const audioProvider = stripTypeScriptTypes(
    await readFile(
      new URL('../src/providers/renderer-audio.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^export /gm, '');
  const boundaries = `const fixture=globalThis[${JSON.stringify(key)}];const window=fixture.dom;const document=window.document;const Element=window.Element;const HTMLElement=window.HTMLElement;const Event=window.Event;const CustomEvent=window.CustomEvent;const setTheme=()=>{};const registerWindowDefaultTrustedTypePolicy=()=>{};const LoggerPrefix='fixture';const i18t=x=>x;const getAllLoadedRendererPlugins=()=>({});const startingPages={};class AudioContext extends window.EventTarget{destination={};createGain(){return {gain:{value:1},connect(){},disconnect(){}}}createMediaElementSource(element){return{mediaElement:element,connect(){},disconnect(){}}}};`;
  const source = await import(
    `data:text/javascript;base64,${Buffer.from(boundaries + audioProvider + helper + (await playlistProviderSource()) + actual).toString('base64')}`
  );
  await source.onApiLoaded();
  return {
    state,
    source,
    bar,
    announce: () =>
      dom.document.dispatchEvent(
        new dom.CustomEvent('videodatachange', {
          detail: { name: 'dataloaded', value: { videoId: state.id } },
        }),
      ),
    click: () => bar.querySelector('.repeat').click(),
    tick: (delay: number) => {
      for (const [id, timer] of [...state.timers])
        if (timer.delay === delay) {
          state.timers.delete(id);
          timer.fn();
        }
    },
    close: async () => {
      dom.dispatchEvent(new dom.Event('pagehide'));
      delete (globalThis as any)[key];
      await dom.happyDOM.close();
    },
  };
}

test('native track reset restores the chosen ALL mode', async () => {
  const f = await fixture();
  try {
    f.state.mode = 'NONE';
    f.announce();
    f.tick(350);
    expect(f.state.mode).toBe('ALL');
    expect(f.state.clicks).toBe(1);
  } finally {
    await f.close();
  }
});

test('a deliberate NONE choice cancels a pending restoration', async () => {
  const f = await fixture('ONE');
  try {
    f.state.mode = 'NONE';
    f.announce();
    f.state.mode = 'ONE';
    f.click();
    f.tick(0);
    f.state.mode = 'NONE';
    f.tick(350);
    expect(f.state.mode).toBe('NONE');
    expect(f.state.clicks).toBe(1);
  } finally {
    await f.close();
  }
});

test('IPC repeat changes become the preference without altering blocker user-intent calls', async () => {
  const f = await fixture('NONE');
  try {
    let userIntents = 0;
    (f.bar.ownerDocument.defaultView as any).blockerSceneGuard = {
      cancelFromUser: () => userIntents++,
    };
    f.state.handlers.get('peard:switch-repeat')({}, 2);
    f.tick(0);
    expect(f.state.mode).toBe('ONE');
    f.state.mode = 'NONE';
    f.announce();
    f.tick(350);
    expect(f.state.mode).toBe('ONE');
    expect(userIntents).toBe(1);
  } finally {
    await f.close();
  }
});

test('rapid track changes and page disposal cannot apply retained restoration timers', async () => {
  const f = await fixture();
  try {
    f.state.mode = 'NONE';
    f.announce();
    expect(f.state.timers.size).toBeGreaterThan(0);
    const old = [...f.state.timers.values()][0].fn;
    f.state.id = 'B';
    f.announce();
    old();
    expect(f.state.clicks).toBe(0);
    await f.close();
    f.tick(350);
    expect(f.state.clicks).toBe(0);
  } finally {
    await f.close();
  }
});

for (const action of ['ui', 'ipc'] as const) {
  test(`chosen ONE survives reset before a deferred remember (${action})`, async () => {
    const f = await fixture('NONE');
    try {
      if (action === 'ui') {
        f.click();
        f.click();
      } else f.state.handlers.get('peard:switch-repeat')({}, 2);
      expect(f.state.mode).toBe('ONE');
      f.state.mode = 'NONE';
      f.announce();
      f.tick(0);
      f.tick(350);
      expect(f.state.mode).toBe('ONE');
    } finally {
      await f.close();
    }
  });
}
