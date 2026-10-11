import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';
import { build } from 'vite';

async function fixture() {
  // Keep the actual NetEase bridge in this composed backend witness.
  const bridge = await build({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    ssr: { noExternal: true },
    resolve: {
      alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
    },
    build: {
      ssr: fileURLToPath(
        new URL(
          '../src/plugins/synced-lyrics/providers/netease-backend.ts',
          import.meta.url,
        ),
      ),
      write: false,
      minify: false,
      rollupOptions: { output: { format: 'es' } },
    },
  });
  const output = Array.isArray(bridge) ? bridge[0] : bridge;
  const code = output.output.find((item: any) => item.type === 'chunk')!.code;
  const bridgeUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const bridgeBoundary = `import {startNetEaseProvider,stopNetEaseProvider} from '${bridgeUrl}';`;
  const key = `lyricsExport_${crypto.randomUUID()}`;
  const state: any = {
    handlers: new Map(),
    nativeListeners: new Map(),
    nativeHandlers: new Map(),
    dialogs: [],
    writes: [],
    destroyed: false,
    song: 'A',
    dispose: 0,
    wait: undefined,
  };
  (globalThis as any)[key] = state;
  const utils = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/tools.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const timing = stripTypeScriptTypes(
    await readFile(
      new URL(
        '../src/plugins/synced-lyrics/renderer/word-timing.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(timing + utils).toString('base64')}`;
  const raw = stripTypeScriptTypes(
    await readFile(
      new URL('../src/plugins/synced-lyrics/backend.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const boundary = `import {serializeLyricsExport} from '${utilsUrl}'; const state=globalThis[${JSON.stringify(key)}]; const net={fetch:()=>{}};const ipcMain={handle:(name,fn)=>state.nativeHandlers.set(name,fn),on:(name,fn)=>state.nativeListeners.set(name,fn),removeListener:(name,fn)=>{if(state.nativeListeners.get(name)===fn)state.nativeListeners.delete(name)}};const t=x=>x; const createBackend=x=>x; const writeFile=async(...args)=>state.writes.push(args); const dialog={showSaveDialog:async(...args)=>{state.dialogs.push(args);if(state.wait)await state.wait;return {canceled:false,filePath:'/owned/chosen.lrc'}}};const registerCallback=(callback)=>{state.callback=callback; callback({videoId:state.song});return ()=>{state.dispose++}};`;
  const m = await import(
    `data:text/javascript;base64,${Buffer.from(bridgeBoundary + boundary + raw).toString('base64')}`
  );
  const ctx: any = {
    window: Object.assign(new EventEmitter(), {
      isDestroyed: () => state.destroyed,
      webContents: {
        isDestroyed: () => state.destroyed,
        session: {
          fetch: async () => {
            throw Error('Unexpected NetEase network request in export witness');
          },
        },
      },
    }),
    ipc: {
      handle: (name: string, fn: any) => state.handlers.set(name, fn),
      removeHandler: (name: string) => {
        state.handlers.delete(name);
        state.nativeHandlers.delete(name);
      },
    },
  };
  await m.backend.start(ctx);
  const request = {
    videoId: 'A',
    result: {
      title: 'Song',
      artists: ['Artist'],
      lines: [{ timeInMs: 1000, text: 'Hello' }],
    },
    offsetMs: 250,
  };
  return {
    state,
    ctx,
    backend: m.backend,
    request,
    export: () => {
      const native = state.nativeHandlers.get('synced-lyrics:export');
      return native
        ? native(
            { sender: state.requestSender ?? ctx.window.webContents },
            request,
          )
        : state.handlers.get('synced-lyrics:export')(request);
    },
    close: () => {
      m.backend.stop(ctx);
      delete (globalThis as any)[key];
    },
  };
}

test('native save exports validated current lyrics solely to selected path', async () => {
  const f = await fixture();
  try {
    expect(await f.export()).toBe('saved');
    expect(f.state.writes).toEqual([
      ['/owned/chosen.lrc', expect.stringContaining('[00:01.25]Hello'), 'utf8'],
    ]);
    expect(f.state.dialogs[0][0]).toBe(f.ctx.window);
  } finally {
    f.close();
  }
});
for (const cause of ['stop', 'destroy', 'track roundtrip'])
  test(`native save cannot publish after ${cause} while dialog awaits`, async () => {
    const f = await fixture();
    try {
      let release!: () => void;
      f.state.wait = new Promise<void>((r) => {
        release = r;
      });
      const pending = f.export();
      while (!f.state.dialogs.length) await Promise.resolve();
      if (cause === 'stop') f.backend.stop(f.ctx);
      else if (cause === 'destroy') f.state.destroyed = true;
      else {
        f.state.callback({ videoId: 'B' });
        f.state.callback({ videoId: 'A' });
      }
      release();
      expect(await pending).toBe('cancelled');
      expect(f.state.writes).toEqual([]);
    } finally {
      f.close();
    }
  });
test('invalid payload and stale track never open a dialog; retained stopped handler is inert', async () => {
  const f = await fixture();
  try {
    const native = f.state.nativeHandlers.get('synced-lyrics:export');
    const handle = native
      ? (request: any) => native({ sender: f.ctx.window.webContents }, request)
      : f.state.handlers.get('synced-lyrics:export');
    expect(await handle({ ...f.request, result: null })).toBe('invalid');
    expect(await handle({ ...f.request, videoId: 'B' })).toBe('cancelled');
    expect(f.state.dialogs).toEqual([]);
    f.backend.stop(f.ctx);
    expect(await handle(f.request)).toBe('cancelled');
    expect(f.state.dispose).toBe(1);
  } finally {
    f.close();
  }
});
test('only one save dialog can be outstanding in a session', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.wait = new Promise<void>((r) => {
      release = r;
    });
    const pending = f.export();
    while (!f.state.dialogs.length) await Promise.resolve();
    expect(await f.export()).toBe('cancelled');
    expect(f.state.dialogs).toHaveLength(1);
    release();
    expect(await pending).toBe('saved');
  } finally {
    f.close();
  }
});

test('actual loader fresh stop context retires the original dialog and subscription', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.wait = new Promise<void>((r) => {
      release = r;
    });
    const pending = f.export();
    while (!f.state.dialogs.length) await Promise.resolve();
    f.backend.stop({ ...f.ctx, ipc: { ...f.ctx.ipc } });
    release();
    expect(await pending).toBe('cancelled');
    expect(f.state.writes).toEqual([]);
    expect(f.state.dispose).toBe(1);
  } finally {
    f.close();
  }
});

for (const native of ['B', null, 'roundtrip'])
  test(`raw native ${native} retires export before slow song metadata completes`, async () => {
    const f = await fixture();
    try {
      let release!: () => void;
      f.state.wait = new Promise<void>((r) => {
        release = r;
      });
      const pending = f.export();
      while (!f.state.dialogs.length) await Promise.resolve();
      const observe = f.state.nativeListeners.get('peard:video-src-changed');
      expect(observe).toBeTruthy();
      observe(
        { sender: f.ctx.window.webContents },
        native === null ? null : { videoDetails: { videoId: 'B' } },
      );
      if (native === 'roundtrip')
        observe(
          { sender: f.ctx.window.webContents },
          { videoDetails: { videoId: 'A' } },
        );
      // The old metadata cache has not observed B yet and can emit another time update.
      f.state.callback({ videoId: 'A' });
      release();
      expect(await pending).toBe('cancelled');
      expect(f.state.writes).toEqual([]);
      f.backend.stop({ ...f.ctx });
      expect(f.state.nativeListeners.size).toBe(0);
    } finally {
      f.close();
    }
  });
test('foreign WebContents native events cannot cancel the owned export', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.wait = new Promise<void>((r) => {
      release = r;
    });
    const pending = f.export();
    while (!f.state.dialogs.length) await Promise.resolve();
    const observe = f.state.nativeListeners.get('peard:video-src-changed');
    expect(observe).toBeTruthy();
    observe({ sender: {} }, { videoDetails: { videoId: 'B' } });
    release();
    expect(await pending).toBe('saved');
    expect(f.state.writes).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('foreign renderer export invocation cannot open a save dialog or write', async () => {
  const f = await fixture();
  try {
    f.state.requestSender = {};
    expect(await f.export()).toBe('cancelled');
    expect(f.state.dialogs).toEqual([]);
    expect(f.state.writes).toEqual([]);
  } finally {
    f.close();
  }
});
test('one pending native dialog remains owned across fresh stop and restart contexts', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.state.wait = new Promise<void>((r) => {
      release = r;
    });
    const pending = f.export();
    while (!f.state.dialogs.length) await Promise.resolve();
    f.backend.stop({ ...f.ctx });
    await f.backend.start({ ...f.ctx, ipc: { ...f.ctx.ipc } });
    const later = f.export();
    await Promise.resolve();
    expect(f.state.dialogs).toHaveLength(1);
    expect(await later).toBe('cancelled');
    release();
    expect(await pending).toBe('cancelled');
    expect(f.state.writes).toEqual([]);
    f.state.wait = undefined;
    expect(await f.export()).toBe('saved');
  } finally {
    f.close();
  }
});
