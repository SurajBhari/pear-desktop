import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { test, expect, _electron as electron } from '@playwright/test';

test('the actual page subscribe bridge strips the native event and disposes only its exact listener', async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      path.resolve(import.meta.dirname, '../src/preload.ts'),
      'utf8',
    ),
  );
  const begin = source.indexOf('const pageIpcChannel =');
  const end = source.indexOf("contextBridge.exposeInMainWorld('reload'", begin);
  expect(begin).toBeGreaterThan(0);
  const native = new EventEmitter();
  let page: {
    subscribe: (
      channel: string,
      callback: (...args: unknown[]) => void,
    ) => () => void;
  };
  const context = vm.createContext({
    ipcRenderer: native,
    contextBridge: {
      exposeInMainWorld(_name: string, value: typeof page) {
        page = value;
      },
    },
  });
  vm.runInContext(source.slice(begin, end), context);
  expect(typeof page!.subscribe).toBe('function');
  const unrelated: unknown[] = [];
  const owned: unknown[] = [];
  native.on('peard:update-song-info', (...args) => unrelated.push(args));
  const dispose = page!.subscribe('peard:update-song-info', (...args) =>
    owned.push(args),
  );
  const event = { sender: 'privileged native handle' };
  native.emit('peard:update-song-info', event, { videoId: 'A' }, 7);
  expect(owned).toEqual([[{ videoId: 'A' }, 7]]);
  expect(unrelated).toEqual([[event, { videoId: 'A' }, 7]]);
  dispose();
  dispose();
  native.emit('peard:update-song-info', event, { videoId: 'B' });
  expect(owned).toHaveLength(1);
  expect(unrelated).toHaveLength(2);
  expect(native.listenerCount('peard:update-song-info')).toBe(1);
  expect(() => page!.subscribe('peard:blocker-scene-claim', () => {})).toThrow(
    /Reserved internal IPC channel/,
  );
  expect(native.listenerCount('peard:blocker-scene-claim')).toBe(0);
});

test('the actual isolated native bridge returns a working void disposer without exposing IPC handles', async () => {
  const source = stripTypeScriptTypes(
    await readFile(
      path.resolve(import.meta.dirname, '../src/preload.ts'),
      'utf8',
    ),
  );
  const begin = source.indexOf('const pageIpcChannel =');
  const end = source.indexOf("contextBridge.exposeInMainWorld('reload'", begin);
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-native-subscribe-'),
  );
  let app;
  try {
    const preload = path.join(directory, 'preload.cjs');
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron');let unrelated=0;ipcRenderer.on('peard:update-song-info',()=>unrelated++);${source.slice(begin, end)};contextBridge.exposeInMainWorld('fixtureCounts',()=>({native:ipcRenderer.listenerCount('peard:update-song-info'),unrelated}));`,
    );
    const entry = path.join(directory, 'main.cjs');
    await writeFile(
      entry,
      `const{app,BrowserWindow,ipcMain}=require('electron');ipcMain.handle('fixture:emit',(event,data)=>{event.sender.send('peard:update-song-info',data)});app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:false}});window.loadURL('data:text/html,<title>Owned IPC fixture</title>')});`,
    );
    app = await electron.launch({
      args: [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    });
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => typeof (window as any).fixtureCounts === 'function',
    );
    const observed = await page.evaluate(async () => {
      const page = window as any;
      const received: unknown[] = [];
      const dispose = page.ipcRenderer.subscribe(
        'peard:update-song-info',
        (...args: unknown[]) => received.push(args),
      );
      await page.ipcRenderer.invoke('fixture:emit', { videoId: 'A' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const returnValue = dispose();
      dispose();
      await page.ipcRenderer.invoke('fixture:emit', { videoId: 'B' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      let denial = '';
      try {
        page.ipcRenderer.subscribe('peard:blocker-scene-claim', () => {});
      } catch (error) {
        denial = String(error);
      }
      return {
        received,
        returnedUndefined: returnValue === undefined,
        counts: page.fixtureCounts(),
        denial,
      };
    });
    expect(observed.received).toEqual([[{ videoId: 'A' }]]);
    expect(observed.returnedUndefined).toBe(true);
    expect(observed.counts).toEqual({ native: 1, unrelated: 2 });
    expect(observed.denial).toContain('Reserved internal IPC channel');
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
