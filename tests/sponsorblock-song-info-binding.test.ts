import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { test, expect } from '@playwright/test';
import { sortSegments } from '../src/plugins/sponsorblock/segments';

const root = path.resolve(import.meta.dirname, '..');
const requireFromProject = createRequire(path.join(root, 'package.json'));
const videoId = 'AAAAAAAAAAA';
const data = {
  videoDetails: {
    videoId,
    title: 'Fixture',
    author: 'Artist',
    viewCount: '0',
    lengthSeconds: '120',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
  },
};

function loadSource(file: string, overrides: Record<string, unknown>) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const transformed = stripTypeScriptTypes(source, { mode: 'transform' });
  const exported = [
    ...transformed.matchAll(
      /export (?:async )?(?:function|const|class|let|var) (\w+)/g,
    ),
  ].map((match) => match[1]);
  const code = transformed
    .replace(
      /import ([\s\S]*?) from ['"]([^'"]+)['"];?/g,
      (_, bindings, id) =>
        `const ${bindings.startsWith('* as ') ? bindings.slice(5) : bindings.replace(/\bas\b/g, ':')} = require(${JSON.stringify(id)});`,
    )
    .replace(/export default /g, 'module.exports.default = ')
    .replace(/export (?=(?:async )?(?:function|const|class|let|var))/g, '')
    .concat(`\nObject.assign(module.exports, {${exported.join(',')}});`);
  const module = { exports: {} as Record<string, any> };
  const localRequire = (id: string) =>
    Object.hasOwn(overrides, id) ? overrides[id] : requireFromProject(id);
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, {
    filename: file,
  })(localRequire, module, module.exports);
  return module.exports;
}

test('SponsorBlock ready seed leaves the current song-info playback binding intact', async () => {
  const dom = new Window();
  const priorGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLVideoElement: globalThis.HTMLVideoElement,
  };
  dom.document.body.innerHTML = '<video></video>';
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    HTMLVideoElement: dom.HTMLVideoElement,
  });
  const ipcMain = new EventEmitter();
  const contents = new EventEmitter() as any;
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  contents.send = () => {};
  const win = new EventEmitter() as any;
  win.webContents = contents;
  win.isDestroyed = () => false;
  const electron = { ipcMain };
  const queue = loadSource('src/providers/queue-playlist.ts', {});
  const playback = loadSource('src/providers/playback-owner.ts', {
    './queue-playlist': queue,
  });
  const provider = loadSource('src/providers/song-info.ts', {
    electron,
    '@/config': { get: () => false, set: () => {} },
    './playback-owner': playback,
    './queue-playlist': queue,
  });
  const dispose = provider.setupSongInfo(win);
  let current: any;
  const unsubscribe = provider.registerCallback((info: any) => {
    current = info;
  });
  const playbackBinding = {
    documentId: 'a'.repeat(32),
    episodeId: 'b'.repeat(32),
    videoId,
  };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const metadataJob = Promise.all(
    ipcMain
      .listeners('peard:video-src-changed')
      .map((listener: any) => listener(event, data, playbackBinding)),
  );
  const segments = { sortSegments };
  const sponsor = loadSource('src/plugins/sponsorblock/index.ts', {
    electron,
    'electron-is': { dev: () => false },
    '@/i18n': { t: (key: string) => key },
    '@/utils': { createPlugin: (value: unknown) => value },
    './segments': segments,
  }).default;
  const rendererIpc = {
    subscribe: () => () => {},
    send: (channel: string, ...args: unknown[]) =>
      ipcMain.emit(channel, event, ...args),
  };
  try {
    await metadataJob;
    const before = provider.getSongInfoPlaybackBinding(current);
    expect(before).toEqual(playbackBinding);
    sponsor.renderer.start({ ipc: rendererIpc });
    const api = {
      getVideoData: () => ({ video_id: videoId }),
      getPlayerResponse: () => data,
    };
    sponsor.renderer.onPlayerApiReady(api, { ipc: rendererIpc });
    expect(provider.getSongInfoPlaybackBinding(current)).toEqual(before);
    expect(ipcMain.listenerCount('peard:video-src-changed')).toBe(1);
    expect(ipcMain.listenerCount('sponsorblock-seed')).toBe(0);
  } finally {
    sponsor.renderer.stop();
    unsubscribe();
    dispose();
    await dom.happyDOM.close();
    Object.assign(globalThis, priorGlobals);
  }
});
