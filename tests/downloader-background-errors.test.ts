import {
  access,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { Window } from 'happy-dom';

const root = path.resolve(import.meta.dirname, '..');
const requireRoot = createRequire(path.join(root, 'package.json'));
const requireVite = createRequire(requireRoot.resolve('vite'));
const url = 'https://music.youtube.com/watch?v=fixture-download';

function expectBadgeCleanup(badges: number[], platform = process.platform) {
  if (platform === 'darwin' || platform === 'linux')
    expect(badges.at(-1)).toBe(0);
  else expect(badges).toEqual([]);
}

async function fixture({
  badgePlatform,
}: { badgePlatform?: NodeJS.Platform } = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-download-error-test-'),
  );
  const entry = path.join(directory, 'entry.ts');
  const downloader = path.join(root, 'src/plugins/downloader/main/index.ts');
  await writeFile(
    entry,
    `
export {onMainLoad,onConfigChange,downloadSong,downloadSongFromId,downloadPlaylist,fixtureSendError} from ${JSON.stringify(downloader)};
export {setupSongInfo} from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))};
export {sendFeedback} from ${JSON.stringify(path.join(root, 'src/plugins/downloader/main/utils.ts'))};
export {fixtureState,fixtureWindow,ipcMain} from 'electron';
`,
  );
  const native = `
import {EventEmitter} from 'node:events';
export const fixtureState={focused:false,destroyed:false,dialogs:[],progress:[],badges:[],feedback:[],focus:[],deadCalls:[],logs:[],network:[],requests:[],notifications:[],dialogMode:'supported',notificationMode:'supported',infoMode:'reject',rejection:new Error('fixture media failed',{cause:new Error('fixture cause')}),errorHandled:undefined};
class FixtureWindow extends EventEmitter {
 webContents=Object.assign(new EventEmitter(),{isDestroyed:()=>fixtureState.destroyed,mainFrame:{},send:(name,...args)=>{if(fixtureState.destroyed){fixtureState.deadCalls.push('feedback');throw new Error('Object has been destroyed');}fixtureState.feedback.push({name,args});},executeJavaScript:async()=>undefined,session:{cookies:{get:async()=>[]}}});
 isDestroyed(){return fixtureState.destroyed;} isFocused(){if(fixtureState.destroyed){fixtureState.deadCalls.push('focus-read');throw new Error('Object has been destroyed');}return fixtureState.focused;}
 focus(){fixtureState.focus.push('focus');} show(){fixtureState.focus.push('show');} getSize(){return [800,600];}
 setProgressBar(value){if(fixtureState.destroyed){fixtureState.deadCalls.push('progress');throw new Error('Object has been destroyed');}fixtureState.progress.push(value);if(value===-1)queueMicrotask(()=>fixtureState.errorHandled?.());}
}
export const fixtureWindow=new FixtureWindow();export const ipcMain=new EventEmitter();
export const app={getPath:()=>'/tmp/pear-fixture-no-download-files',setBadgeCount:(n)=>fixtureState.badges.push(n)};
export const dialog={showMessageBox:async(parent,options)=>{fixtureState.dialogs.push({parented:parent===fixtureWindow,...options});if(fixtureState.dialogMode==='reject')throw new Error('fixture dialog rejected');return {response:0};}};
export class Notification extends EventEmitter {
 static isSupported(){return fixtureState.notificationMode!=='unsupported';}
 constructor(options){super();if(fixtureState.notificationMode==='constructor failure')throw new Error('fixture notification constructor failed');this.record={...options,showAttempts:0};fixtureState.notifications.push(this.record);}
 show(){this.record.showAttempts++;if(fixtureState.notificationMode==='show failure')throw new Error('fixture notification show failed');if(fixtureState.notificationMode==='async failure')queueMicrotask(()=>this.emit('failed',{},'fixture async notification failed'));} close(){}
}
export const nativeImage={createFromBuffer:()=>({isEmpty:()=>false})};
export const net={fetch:async(...args)=>{fixtureState.network.push(args);throw new Error('Remote fixture network prohibited');}};
`;
  const youtube = `
import {fixtureState} from 'electron';
export {FormatUtils} from 'owned-real-sdk';
export const Platform={shim:{}};export class UniversalCache{};export const Utils={};export const YTNodes={MusicResponsiveListItem:class{constructor(id){this.id=id;this.author={name:'fixture author'};this.title='fixture title';}}};
export const Innertube={create:async()=>({session:{context:{client:{}}},music:{getPlaylist:async()=>({header:{title:{text:'Owned fixture playlist'}},items:[new YTNodes.MusicResponsiveListItem('first'),new YTNodes.MusicResponsiveListItem('second')],has_continuation:false}),getInfo:(id)=>{fixtureState.requests.push(id);if(fixtureState.infoMode==='deferred'||(fixtureState.playlistMode&&id==='second'))return new Promise((resolve,reject)=>{fixtureState.resolveInfo=resolve;fixtureState.rejectInfo=reject;fixtureState.infoReady?.();});return Promise.reject(fixtureState.rejection);}}})};
`;
  const { rolldown } = await import(
    pathToFileURL(requireVite.resolve('rolldown')).href
  );
  const build = await rolldown({
    input: entry,
    platform: 'node',
    plugins: [
      {
        name: 'controlled-download-native-boundaries',
        async resolveId(id: string) {
          if (id === 'owned-real-sdk')
            return {
              id: requireRoot.resolve('youtubei.js').replaceAll('\\', '/'),
              external: true,
            };
          if (id === 'electron-is' && badgePlatform)
            return '\0fixture-platform';
          if (id === 'filenamify') return '\0fixture-filenamify';
          if (id === 'electron') return '\0fixture-native';
          if (id === 'youtubei.js') return '\0fixture-youtube';
          if (id === '@/config') return '\0fixture-config';
          if (id === '@/i18n') return '\0fixture-i18n';
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
          if (id === '\0fixture-platform')
            return `const platform=${JSON.stringify(badgePlatform)};export default {linux:()=>platform==='linux',macOS:()=>platform==='darwin'};`;
          if (
            id === downloader &&
            process.env.PEAR_DOWNLOADER_ERROR_BASELINE === '1'
          )
            return execFileSync(
              'git',
              ['show', '8dfaa5e4:src/plugins/downloader/main/index.ts'],
              { cwd: root, encoding: 'utf8' },
            );
          if (id === '\0fixture-filenamify')
            return `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(root, 'package.json'))});const value=require('filenamify');export default value.default??value;`;
          if (id === '\0fixture-native') return native;
          if (id === '\0fixture-youtube') return youtube;
          if (id === '\0fixture-config')
            return 'export const get=()=>false;export const set=()=>{};';
          if (id === '\0fixture-i18n') return 'export const t=(key)=>key;';
        },
        transform(code: string, id: string) {
          if (id !== downloader) return;
          // Export the actual private production function through the compiler;
          // its implementation and every download/callback wrapper remain intact.
          return {
            code: `import {fixtureState as __state} from 'electron';const console={error:(v)=>__state.logs.push(String(v)),trace:(v)=>__state.logs.push(String(v)),warn:(v)=>__state.logs.push(String(v)),log:(v)=>__state.logs.push(String(v))};\n${code}\nexport {sendError as fixtureSendError};`,
            map: null,
          };
        },
      },
    ],
  });
  const output = path.join(directory, 'actual-source.cjs');
  await build.write({ file: output, format: 'cjs' });
  await build.close();
  const source = requireRoot(output);
  const { fixtureState: state, fixtureWindow: window, ipcMain } = source;
  source.setupSongInfo(window);
  await source.onMainLoad({
    window,
    getConfig: async () => ({
      enabled: true,
      downloadOnFinish: {
        enabled: true,
        seconds: 20,
        percent: 10,
        mode: 'seconds',
      },
      selectedPreset: 'mp3 (256kbps)',
      customPresetSetting: { extension: 'mp3', ffmpegArgs: [] },
      skipExisting: false,
    }),
    ipc: {
      handle() {},
      on: (event: string, handler: (...args: unknown[]) => void) =>
        ipcMain.on(event, (_: unknown, ...args: unknown[]) => handler(...args)),
      send: (...args: unknown[]) => window.webContents.send(...args),
    },
  });
  return {
    source,
    state,
    window,
    directory,
    feedback: () =>
      state.feedback
        .filter((item: { name: string }) => item.name === 'downloader-feedback')
        .at(-1)?.args[0],
    emit: async (event: string, ...args: unknown[]) => {
      for (const listener of ipcMain.listeners(event))
        await listener(
          {
            sender: window.webContents,
            senderFrame: window.webContents.mainFrame,
          },
          ...args,
        );
    },
    close: async () => {
      delete requireRoot.cache[output];
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const data = (id: string) => ({
  microformat: {
    microformatDataRenderer: {
      urlCanonical: `https://music.youtube.com/watch?v=${id}`,
      linkAlternates: [],
    },
  },
  videoDetails: {
    title: 'fixture title',
    author: 'fixture artist',
    viewCount: '1',
    lengthSeconds: '100',
    elapsedSeconds: 0,
    isPaused: false,
    videoId: id,
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
  },
});

test('focused explicit failure retains detailed dialog and clears progress/badge', async () => {
  const f = await fixture();
  try {
    f.state.focused = true;
    await f.source.downloadSong(url);
    expect(f.state.dialogs).toHaveLength(1);
    expect(f.state.dialogs[0]).toMatchObject({
      parented: true,
      detail: `Error: fixture media failed\nin ${url}\n\nError: fixture cause`,
    });
    expect(f.state.notifications).toEqual([]);
    expect(f.state.progress.at(-1)).toBe(-1);
    expectBadgeCleanup(f.state.badges);
    expect(f.state.focus).toEqual([]);
  } finally {
    await f.close();
  }
});

test('actual automatic finish failure does not dispatch a modal while unfocused', async () => {
  const f = await fixture();
  try {
    await f.emit('peard:video-src-changed', data('fixture-auto-track'));
    await f.emit('peard:time-changed', 95);
    let timer: ReturnType<typeof setTimeout>;
    const handled = new Promise<void>((resolve, reject) => {
      f.state.errorHandled = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(
        () => reject(new Error('Error handler did not clear progress')),
        1500,
      );
    });
    await f.emit('peard:video-src-changed', data('fixture-next-track'));
    await handled;
    expect(f.state.requests).toEqual(['fixture-auto-track']);
    expect(f.state.dialogs).toEqual([]);
    expect(f.state.notifications).toHaveLength(1);
    expect(f.state.notifications[0]).toMatchObject({
      silent: true,
      showAttempts: 1,
    });
    expect(f.feedback()).toContain('fixture media failed');
    expect(f.state.focus).toEqual([]);
    expect(f.state.network).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const mode of [
  'unsupported',
  'constructor failure',
  'show failure',
  'async failure',
]) {
  test(`background ${mode} keeps error feedback without modal/focus fallback`, async () => {
    const f = await fixture();
    try {
      f.state.notificationMode = mode;
      await expect(f.source.downloadSong(url)).resolves.toBeUndefined();
      expect(f.state.dialogs).toEqual([]);
      expect(f.state.focus).toEqual([]);
      expect(f.feedback()).toContain('fixture media failed');
      expect(f.state.progress.at(-1)).toBe(-1);
      expectBadgeCleanup(f.state.badges);
      if (mode === 'unsupported') expect(f.state.notifications).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('failure after window destruction logs and cleans the global badge without dead-window calls', async () => {
  const f = await fixture();
  try {
    f.state.infoMode = 'deferred';
    const infoReady = new Promise<void>((resolve) => {
      f.state.infoReady = resolve;
    });
    const pending = f.source.downloadSong(url);
    await infoReady;
    expect(f.state.requests).toEqual(['fixture-download']);
    f.state.destroyed = true;
    f.state.rejectInfo(f.state.rejection);
    await expect(pending).resolves.toBeUndefined();
    expect(f.state.deadCalls).toEqual([]);
    expect(f.state.dialogs).toEqual([]);
    expect(f.state.notifications).toEqual([]);
    expectBadgeCleanup(f.state.badges);
    expect(f.state.logs.join('\n')).toContain('fixture cause');
  } finally {
    await f.close();
  }
});

test('blank/status cleanup preserves an error until the next deliberate operation starts', async () => {
  const f = await fixture();
  try {
    f.state.notificationMode = 'unsupported';
    await f.source.downloadSong(url);
    const error = f.feedback();
    expect(error).toContain('fixture media failed');
    f.source.sendFeedback(f.window);
    expect(f.feedback()).toBe(error);
    f.source.sendFeedback(f.window, 'late cleanup status');
    expect(f.feedback()).toBe(error);
    f.state.infoMode = 'deferred';
    const infoReady = new Promise<void>((resolve) => {
      f.state.infoReady = resolve;
    });
    const next = f.source.downloadSong(url);
    await infoReady;
    expect(f.feedback()).toBe(
      'plugins.downloader.backend.feedback.downloading',
    );
    f.state.rejectInfo(f.state.rejection);
    await next;
    expect(f.feedback()).toContain('fixture media failed');
  } finally {
    await f.close();
  }
});

test('background feedback is bounded and excludes stack while complete source/cause stay logged', async () => {
  const f = await fixture();
  try {
    const error = new Error('🚫'.repeat(400), {
      cause: new Error('full fixture cause ' + 'x'.repeat(800)),
    });
    error.stack = 'unbounded fixture stack ' + 's'.repeat(3000);
    f.source.fixtureSendError(error, url);
    expect(f.state.dialogs).toEqual([]);
    expect(typeof f.feedback()).toBe('string');
    expect([...f.feedback()].length).toBeLessThanOrEqual(200);
    expect(f.feedback()).not.toContain('unbounded fixture stack');
    expect(f.state.notifications[0].body).toBe(f.feedback());
    expect(f.state.logs.join('\n')).toContain(url);
    expect(f.state.logs.join('\n')).toContain(
      'full fixture cause ' + 'x'.repeat(800),
    );
  } finally {
    await f.close();
  }
});

test('actual download button renders error markup as plain text', async () => {
  const f = await fixture();
  const window = new Window();
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-download-text-test-'),
  );
  try {
    f.state.notificationMode = 'unsupported';
    f.source.fixtureSendError(new Error('<b>fixture markup</b>'), url);
    const text = f.feedback();
    expect(text).toContain('<b>fixture markup</b>');
    const requireSolid = createRequire(
      requireRoot.resolve('vite-plugin-solid'),
    );
    const babel = requireSolid('@babel/core');
    const template = path.join(
      root,
      'src/plugins/downloader/templates/download.tsx',
    );
    const compiled = await babel.transformAsync(
      await readFile(template, 'utf8'),
      {
        filename: template,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ['typescript', 'jsx'] },
        presets: [
          [requireSolid.resolve('babel-preset-solid'), { generate: 'ssr' }],
        ],
      },
    );
    const transformed = path.join(directory, 'button.ts');
    await writeFile(transformed, stripTypeScriptTypes(compiled.code));
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      `export {DownloadButton} from './button.ts';export {renderToString} from 'solid-js/web';`,
    );
    const { rolldown } = await import(
      pathToFileURL(requireVite.resolve('rolldown')).href
    );
    const build = await rolldown({
      input: entry,
      platform: 'node',
      plugins: [
        {
          name: 'actual-solid-runtime',
          resolveId(id: string) {
            if (!id.startsWith('.') && !path.isAbsolute(id))
              return {
                id: requireRoot.resolve(id).replaceAll('\\', '/'),
                external: true,
              };
          },
        },
      ],
    });
    const output = path.join(directory, 'button.cjs');
    await build.write({ file: output, format: 'cjs' });
    await build.close();
    const { DownloadButton, renderToString } = requireRoot(output);
    window.document.body.innerHTML = renderToString(() =>
      DownloadButton({ text, onClick() {} }),
    );
    expect(
      window.document.querySelector('#ytmcustom-download')?.textContent,
    ).toBe(text);
    expect(window.document.querySelector('#ytmcustom-download b')).toBeNull();
    delete requireRoot.cache[output];
  } finally {
    await f.close();
    await window.happyDOM.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('foreground dialog rejection retains readable fallback without another modal or focus request', async () => {
  const f = await fixture();
  try {
    f.state.focused = true;
    f.state.dialogMode = 'reject';
    await f.source.downloadSong(url);
    await Promise.resolve();
    expect(f.feedback()).toContain('fixture media failed');
    expect(f.state.dialogs).toHaveLength(1);
    expect(f.state.notifications).toEqual([]);
    expect(f.state.focus).toEqual([]);
    expect(f.state.progress.at(-1)).toBe(-1);
    expectBadgeCleanup(f.state.badges);
  } finally {
    await f.close();
  }
});

for (const rejection of ['fixture scalar failure', null]) {
  test(`non-Error rejection ${String(rejection)} still gets safe cleanup and readable background feedback`, async () => {
    const f = await fixture();
    try {
      f.state.notificationMode = 'unsupported';
      f.state.rejection = rejection;
      await expect(f.source.downloadSong(url)).resolves.toBeUndefined();
      expect(f.feedback()).toContain(String(rejection));
      expect(f.state.progress.at(-1)).toBe(-1);
      expectBadgeCleanup(f.state.badges);
      expect(f.state.dialogs).toEqual([]);
      expect(f.state.focus).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test('a mixed playlist retains its first error through a later successful track and final cleanup', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, 'downloads');
    const playlistFolder = path.join(folder, 'Owned fixture playlist');
    await mkdir(playlistFolder, { recursive: true });
    // The second track succeeds by the real skip-existing path: no media bytes
    // or codec are downloaded. The file is an owned synthetic placeholder.
    await writeFile(
      path.join(playlistFolder, 'fixture author - fixture title.mp3'),
      'owned fixture placeholder',
    );
    f.source.onConfigChange({
      enabled: true,
      downloadFolder: folder,
      selectedPreset: 'mp3 (256kbps)',
      customPresetSetting: { extension: 'mp3', ffmpegArgs: [] },
      skipExisting: true,
    });
    f.state.notificationMode = 'unsupported';
    f.state.playlistMode = true;
    const pending = f.source.downloadPlaylist(
      'https://music.youtube.com/playlist?list=PLfixture',
    );
    await expect.poll(() => f.state.requests.length).toBe(2);
    const duringSecond = f.feedback();
    f.state.resolveInfo({
      basic_info: {
        id: 'second',
        title: 'fixture title',
        author: 'fixture author',
        view_count: 1,
        duration: 100,
      },
      playability_status: { status: 'OK' },
      streaming_data: {
        formats: [],
        adaptive_formats: [
          {
            itag: 140,
            mime_type: 'audio/mp4; codecs="mp4a.40.2"',
            has_audio: true,
            has_video: false,
            is_original: true,
            content_length: 3,
          },
        ],
      },
    });
    await pending;
    expect(f.state.requests).toEqual(['first', 'second']);
    expect(duringSecond).toContain('fixture media failed');
    expect(f.feedback()).toContain('fixture media failed');
    expect(
      f.state.logs.filter((message: string) =>
        message.includes('Error: fixture media failed'),
      ),
    ).toHaveLength(2);
    expect(f.state.network).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a new standalone ID download clears a previous operation error', async () => {
  const f = await fixture();
  try {
    f.state.notificationMode = 'unsupported';
    f.source.fixtureSendError(new Error('previous operation failed'), url);
    f.state.infoMode = 'deferred';
    const infoReady = new Promise<void>((resolve) => {
      f.state.infoReady = resolve;
    });
    const pending = f.source.downloadSongFromId('new-operation');
    await infoReady;
    expect(f.feedback()).toBe(
      'plugins.downloader.backend.feedback.downloading',
    );
    expect(f.state.requests).toEqual(['new-operation']);
    f.state.rejectInfo(new Error('new operation failure'));
    await pending;
    expect(f.feedback()).toContain('new operation failure');
    expect(f.feedback()).not.toContain('previous operation failed');
  } finally {
    await f.close();
  }
});

test('badge cleanup follows macOS, Linux and Windows platform support', async () => {
  for (const badgePlatform of ['darwin', 'linux', 'win32'] as const) {
    const f = await fixture({ badgePlatform });
    try {
      await f.source.downloadSong(url);
      expectBadgeCleanup(f.state.badges, badgePlatform);
      expect(f.state.progress.at(-1)).toBe(-1);
      expect(f.state.dialogs).toEqual([]);
      expect(f.state.focus).toEqual([]);
      expect(f.feedback()).toContain('fixture media failed');
    } finally {
      await f.close();
    }
  }
});
