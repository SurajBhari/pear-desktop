import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { test, expect } from '@playwright/test';

import { downloaderFixture } from './helpers/downloader-small-fixture';

for (const outcome of ['resolve', 'reject', 'dispose'] as const) {
  test(`actual Botguard overlay leaves prior accessor backing state unchanged (${outcome})`, async () => {
    const f = await downloaderFixture();
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const windowValue = { marker: 'old accessor window' };
    const documentValue = { marker: 'old accessor document' };
    let windowBacking: unknown = windowValue;
    let documentBacking: unknown = documentValue;
    let setterCalls = 0;
    const windowDescriptor = {
      configurable: true,
      enumerable: true,
      get: () => windowBacking,
      set: (value: unknown) => {
        setterCalls++;
        windowBacking = value;
      },
    };
    const documentDescriptor = {
      configurable: true,
      enumerable: false,
      get: () => documentBacking,
      set: (value: unknown) => {
        setterCalls++;
        documentBacking = value;
      },
    };
    let pending: Promise<void> | undefined;
    try {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
      Object.defineProperty(globalThis, 'document', documentDescriptor);
      f.state.visitor = true;
      f.state.tokenMode = outcome === 'dispose' ? 'defer' : outcome;
      const context = f.createContext('accessor-' + outcome);
      await f.source.downloader.onMainLoad(context);
      pending = f.source.downloader.downloadSongFromId('one');
      if (outcome === 'dispose') {
        await expect.poll(() => f.state.tokens.length).toBe(1);
        f.source.downloader.onMainStop?.(context);
        f.state.tokens[0].resolve();
      }
      await pending;
      expect(windowBacking === windowValue).toBe(true);
      expect(documentBacking === documentValue).toBe(true);
      expect(setterCalls).toBe(0);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(
        windowDescriptor,
      );
      expect(Object.getOwnPropertyDescriptor(globalThis, 'document')).toEqual(
        documentDescriptor,
      );
      if (outcome === 'resolve')
        expect(f.state.clients[0].session.po_token).toBe('fixture-token');
      else expect(f.state.clients[0].session.po_token).toBeUndefined();
    } finally {
      await f.close();
      await pending;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (oldDocument)
        Object.defineProperty(globalThis, 'document', oldDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'fixtureBotguard');
    }
  });
}

test('late old foreground dialog failure cannot replace a same-window rebound error', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('same-window');
    (context.window as unknown as { focused: boolean }).focused = true;
    f.state.dialogMode = 'defer';
    f.state.mediaError = 'Old deferred dialog sentinel';
    await f.source.downloader.onMainLoad(context);
    await f.source.downloader.downloadSongFromId('old-dialog');
    expect(f.state.pendingDialogs).toHaveLength(1);
    f.source.downloader.onMainStop?.(context);
    (context.window as unknown as { focused: boolean }).focused = false;
    await f.source.downloader.onMainLoad(context);
    f.state.mediaError = 'New current backend sentinel';
    await f.source.downloader.downloadSongFromId('new-dialog');
    const feedback = () =>
      f.state.feedback
        .filter((row) => row.name === 'downloader-feedback')
        .at(-1)?.args[0];
    const current = feedback();
    expect(current).toEqual(
      expect.stringContaining('New current backend sentinel'),
    );
    f.state.pendingDialogs[0].reject(new Error('Late old dialog rejected'));
    await f.flush();
    expect(feedback()).toBe(current);
  } finally {
    await f.close();
  }
});

test('immutable DOM globals skip optional token setup without changing either value', async () => {
  const f = await downloaderFixture();
  try {
    const script = `
const source=require(${JSON.stringify(f.output)});
(async()=>{await source.loadI18n();const windowValue={marker:'mutable-first'};const documentValue={marker:'immutable-second'};
let backing=windowValue;let setterCalls=0;Object.defineProperty(globalThis,'window',{get:()=>backing,set:(value)=>{setterCalls++;backing=value},configurable:true});
Object.defineProperty(globalThis,'document',{value:documentValue,writable:false,configurable:false});
source.state.visitor=true;const window=new source.FixtureWindow('immutable');
await source.downloader.onMainLoad({window,getConfig:()=>(${JSON.stringify(f.config)}),setConfig(){},ipc:{handle(){},on(){},removeHandler(){},send(){}}});
await source.downloader.downloadSongFromId('one');
console.log(JSON.stringify({windowUnchanged:globalThis.window===windowValue,documentUnchanged:globalThis.document===documentValue,setterCalls,token:source.state.clients[0].session.po_token??null}));
source.downloader.onMainStop({window});})().catch(e=>{console.error(e);process.exitCode=1});`;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['-e', script],
      { cwd: f.directory },
    );
    const result: unknown = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result).toEqual({
      windowUnchanged: true,
      documentUnchanged: true,
      setterCalls: 0,
      token: null,
    });
  } finally {
    await f.close();
  }
});

test('startup is offline and concurrent first downloads share one authenticated initialization', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('first');
    await f.source.downloader.onMainLoad(context);
    expect(f.state.creates).toHaveLength(0);
    f.state.initMode = 'defer';
    const first = f.source.downloader.downloadSongFromId('one');
    const second = f.source.downloader.downloadSongFromId('two');
    await f.flush();
    expect(f.state.creates).toHaveLength(1);
    expect(f.state.creates[0].cookie).toBe('SID=fixture-first');
    f.state.pending[0].resolve();
    await Promise.all([first, second]);
    expect(f.state.infoCalls.map((entry: { id: string }) => entry.id)).toEqual([
      'one',
      'two',
    ]);
    const client = f.state.clients[0];
    await client.options.fetch('https://fixture.test/native-proxy-path');
    expect(f.state.network.at(-1)?.init?.signal?.aborted).toBe(false);
  } finally {
    await f.close();
  }
});

test('a failed first initialization permits the next actual request to retry', async () => {
  const f = await downloaderFixture();
  try {
    await f.source.downloader.onMainLoad(f.createContext('retry'));
    f.state.initMode = 'reject';
    await f.source.downloader.downloadSongFromId('failed-init');
    f.state.initMode = 'resolve';
    await f.source.downloader.downloadSongFromId('next-request');
    expect(f.state.creates).toHaveLength(2);
    expect(f.state.infoCalls.map((entry: { id: string }) => entry.id)).toEqual([
      'next-request',
    ]);
  } finally {
    await f.close();
  }
});

for (const late of ['resolve', 'reject'] as const) {
  test(`late old initialization ${late} cannot replace or reset a rebound client`, async () => {
    const f = await downloaderFixture();
    try {
      const old = f.createContext('old');
      await f.source.downloader.onMainLoad(old);
      f.state.initMode = 'defer';
      const pending = f.source.downloader.downloadSongFromId('old-track');
      await f.flush();
      expect(f.state.pending).toHaveLength(1);
      const current = f.createContext('current');
      f.state.initMode = 'resolve';
      await f.source.downloader.onMainLoad(current);
      await f.source.downloader.downloadSongFromId('current-track');
      if (late === 'resolve') f.state.pending[0].resolve();
      else
        f.state.pending[0].reject(new Error('Late old initialization failure'));
      await pending;
      await f.source.downloader.downloadSongFromId('still-current');
      expect(f.state.creates).toHaveLength(2);
      expect(f.state.infoCalls).toEqual([
        { id: 'current-track', cookie: 'SID=fixture-current', index: 1 },
        { id: 'still-current', cookie: 'SID=fixture-current', index: 1 },
      ]);
    } finally {
      await f.close();
    }
  });
}

test('stop retires initialization, fetch ownership and playback subscriptions', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('stopped');
    await f.source.downloader.onMainLoad(context);
    expect(f.source.fixtureCallbacks.size).toBe(1);
    f.state.initMode = 'defer';
    const pending = f.source.downloader.downloadSongFromId('old-track');
    await f.flush();
    f.source.downloader.onMainStop?.(context);
    f.state.pending[0]?.resolve();
    await pending;
    await f.source.downloader.downloadSongFromId('after-stop');
    expect(f.state.infoCalls).toEqual([]);
    expect(f.source.fixtureCallbacks.size).toBe(0);
    expect(f.source.ipcMain.listenerCount('peard:player-api-loaded')).toBe(0);
  } finally {
    await f.close();
  }
});

test('empty download folder resolves to the owned OS Downloads directory', async () => {
  const f = await downloaderFixture();
  try {
    expect(f.source.getFolder('')).toBe(f.downloads);
  } finally {
    await f.close();
  }
});

test('window close retires the cached client and native fetch signals', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('closed');
    await f.source.downloader.onMainLoad(context);
    await f.source.downloader.downloadSongFromId('first');
    const fetch = f.state.clients[0].options.fetch;
    f.state.networkMode = 'defer';
    const pendingRequest = fetch('https://fixture.test/owned-native');
    const aborted = expect(pendingRequest).rejects.toMatchObject({
      name: 'AbortError',
    });
    const signal = f.state.network.at(-1)?.init?.signal;
    context.window.destroy();
    await aborted;
    expect(signal?.aborted).toBe(true);
    const count = f.state.network.length;
    await expect(fetch('https://fixture.test/retired-native')).rejects.toThrow(
      /no longer active/,
    );
    expect(f.state.network).toHaveLength(count);
    expect(f.source.fixtureCallbacks.size).toBe(0);
    expect(f.source.ipcMain.listenerCount('peard:video-src-changed')).toBe(0);
  } finally {
    await f.close();
  }
});

test('an old playlist completion cannot clear the new backend progress or badge', async () => {
  const f = await downloaderFixture();
  let old: Promise<void> | undefined;
  let current: Promise<void> | undefined;
  try {
    await f.source.downloader.onMainLoad(f.createContext('old-playlist'));
    f.state.infoMode = 'defer';
    old = f.source.downloader.downloadPlaylist(
      'https://fixture.test/watch?list=old',
    );
    await f.flush();
    expect(f.state.pendingInfo).toHaveLength(1);
    const context = f.createContext('new-playlist');
    f.config.downloadFolder = path.join(f.directory, 'new-output');
    await f.source.downloader.onMainLoad(context);
    current = f.source.downloader.downloadPlaylist(
      'https://fixture.test/watch?list=current',
    );
    await f.flush();
    expect(f.state.pendingInfo).toHaveLength(2);
    context.window.setProgressBar(0.6);
    f.source.app.setBadgeCount(4);
    f.state.pendingInfo[0].reject(new Error('Late old playlist response'));
    await old;
    expect(f.state.progress.at(-1)).toEqual({
      window: 'new-playlist',
      value: 0.6,
    });
    expect(f.state.badges.at(-1)).toBe(4);
  } finally {
    await f.close();
    await Promise.allSettled([old, current]);
  }
});

test('partial IPC registration failure removes only its successfully registered handlers', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('partial-registration');
    const registered = new Map<string, CallableFunction>();
    context.ipc.handle = (key, callback) => {
      if (key === 'download-playlist-request')
        throw new Error('Owned IPC registration failure');
      registered.set(key, callback);
    };
    context.ipc.removeHandler = (key) => {
      registered.delete(key);
    };
    await expect(f.source.downloader.onMainLoad(context)).rejects.toThrow(
      /registration failure/,
    );
    expect([...registered.keys()]).toEqual([]);
    expect(f.source.fixtureCallbacks.size).toBe(0);
    expect(f.source.ipcMain.listenerCount('peard:video-src-changed')).toBe(0);
  } finally {
    await f.close();
  }
});

test('signed-window format choice and caller abort signals stay on native fetch', async () => {
  const f = await downloaderFixture();
  try {
    const context = f.createContext('signed');
    (context.window as unknown as { signed: boolean }).signed = true;
    f.state.infoMode = 'resolve';
    await f.source.downloader.onMainLoad(context);
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.creates[0].cookie).toBe('SID=fixture-signed');
    expect(f.state.lastFormat?.type).toBe('audio');
    const controller = new AbortController();
    await f.state.clients[0].options.fetch(
      'https://fixture.test/native-caller-signal',
      { signal: controller.signal },
    );
    controller.abort();
    expect(f.state.network.at(-1)?.init?.signal?.aborted).toBe(true);
  } finally {
    await f.close();
  }
});

test('Botguard initializes the owned client and restores existing DOM globals', async () => {
  const f = await downloaderFixture();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const windowValue = { marker: 'owned-previous-window' };
  const documentValue = { marker: 'owned-previous-document' };
  try {
    Object.defineProperty(globalThis, 'window', {
      value: windowValue,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: documentValue,
      writable: true,
      configurable: true,
    });
    f.state.visitor = true;
    await f.source.downloader.onMainLoad(f.createContext('botguard'));
    await f.source.downloader.downloadSongFromId('one');
    expect(f.state.clients[0].session.po_token).toBe('fixture-token');
    expect(Object.getOwnPropertyDescriptor(globalThis, 'window')?.value).toBe(
      windowValue,
    );
    expect(Object.getOwnPropertyDescriptor(globalThis, 'document')?.value).toBe(
      documentValue,
    );
  } finally {
    await f.close();
    if (previousWindow)
      Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument)
      Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'fixtureBotguard');
  }
});

for (const preset of [
  'fixture-lossless',
  'Source',
  'Custom',
  'mp3 (256kbps)',
  'unknown-preset',
  '__proto__',
  'toString',
] as const) {
  test(`actual download resolves ${preset} preset`, async () => {
    const f = await downloaderFixture();
    try {
      // A valid registry record is input data; resolution remains real source.
      f.source.DefaultPresetList['fixture-lossless'] = {
        extension: 'flac',
        ffmpegArgs: ['-c:a', 'flac'],
      };
      f.config.selectedPreset = preset;
      f.state.infoMode = 'resolve';
      await f.source.downloader.onMainLoad(f.createContext('preset'));
      await f.source.downloader.downloadSongFromId('one');
      const args: string[] = f.state.runs[0];
      const defaultPreset = !['fixture-lossless', 'Source', 'Custom'].includes(
        preset,
      );
      const extension =
        preset === 'Source' ? 'm4a' : defaultPreset ? 'mp3' : 'flac';
      expect(args.slice(2, 4)).toEqual(
        preset === 'Source'
          ? ['-acodec', 'copy']
          : defaultPreset
            ? ['-b:a', '256k']
            : ['-c:a', 'flac'],
      );
      expect(
        (await readdir(f.downloads)).some((name) =>
          name.endsWith('.' + extension),
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
}

test('playlist cap bounds continuation and actual downloads', async () => {
  const f = await downloaderFixture();
  try {
    f.config.playlistMaxItems = 3;
    f.state.pages = [['one', 'two'], ['three', 'four'], ['five']];
    f.state.infoMode = 'resolve';
    await f.source.downloader.onMainLoad(f.createContext('playlist'));
    await f.source.downloader.downloadPlaylist(
      'https://fixture.test/watch?list=owned-playlist',
    );
    expect(f.state.continuations).toBe(1);
    expect(f.state.infoCalls.map((entry: { id: string }) => entry.id)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(
      await readdir(path.join(f.downloads, 'Fixture playlist')),
    ).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('an album capped to one keeps its playlist folder and first-track tag', async () => {
  const f = await downloaderFixture();
  try {
    f.config.playlistMaxItems = 1;
    f.config.selectedPreset = 'mp3 (256kbps)';
    f.config.downloadFolder = '';
    f.state.album = true;
    f.state.pages = [['one', 'two']];
    f.state.infoMode = 'resolve';
    await f.source.downloader.onMainLoad(f.createContext('album'));
    await f.source.downloader.downloadPlaylist(
      'https://fixture.test/watch?list=owned-album',
    );
    const album = path.join(f.downloads, 'Fixture album');
    const files = await readdir(album);
    expect(files).toHaveLength(1);
    const nodeId3 = await import('node-id3');
    const tags = nodeId3.default.read(
      await readFile(path.join(album, files[0])),
    );
    expect(tags.trackNumber).toBe('1');
    expect(f.state.infoCalls.map((entry: { id: string }) => entry.id)).toEqual([
      'one',
    ]);
  } finally {
    await f.close();
  }
});
