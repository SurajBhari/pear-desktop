import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build, normalizePath, transformWithOxc } from 'vite';
const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));
/** Genuine providers and raw Electron IPC; only native inputs and OS toasts are seeded. */
export async function ratingFeedbackNative<T>(
  task: () => Promise<T>,
  options: { windows?: boolean; exhausted?: boolean; stage?: string } = {},
): Promise<T> {
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-rating-native-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const rendererText = await readFile(
      path.join(root, 'src/renderer.ts'),
      'utf8',
    );
    const likeStart = rendererText.indexOf(
      "  window.ipcRenderer.on(\n    'peard:update-like'",
    );
    const likeEnd = rendererText.indexOf(
      "  window.ipcRenderer.on('peard:switch-repeat'",
      likeStart,
    );
    if (likeStart < 0 || likeEnd < 0)
      throw Error('Actual native rating control listener missing');
    const controlListener = (
      await transformWithOxc(
        rendererText.slice(likeStart, likeEnd),
        'rating-control.ts',
      )
    ).code;
    const entry = (p: string) =>
      JSON.stringify(normalizePath(path.join(root, p)));
    const mainEntry = path.join(owned, 'main-source.ts'),
      rendererEntry = path.join(owned, 'renderer-source.ts');
    await writeFile(
      mainEntry,
      `export * from ${entry('src/providers/song-info.ts')};export * from ${entry('src/plugins/notifications/main.ts')};export * from ${entry('src/providers/song-controls.ts')};export * from ${entry('src/tray.ts')};export * from ${entry('src/providers/protocol-handler.ts')};export {Tray,app} from 'electron';export {state} from '@/config';`,
    );
    await writeFile(
      rendererEntry,
      `export {setupSongInfo as setupFront} from ${entry('src/providers/song-info-front.ts')};export * from ${entry('src/providers/playback-owner.ts')};${existsSync(path.join(root, 'src/plugins/notifications/rating-feedback-renderer.ts')) ? `export * from ${entry('src/plugins/notifications/rating-feedback-renderer.ts')};` : ''}`,
    );
    const common = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [
        {
          name: 'rating-native-boundaries',
          enforce: 'pre' as const,
          resolveId(id: string, importer?: string) {
            if (
              id === 'electron-is' &&
              options.windows &&
              importer?.includes('/src/plugins/notifications/')
            )
              return '\0rating-platform';
            if (id === 'electron')
              return importer?.includes('/src/plugins/notifications/')
                ? '\0rating-electron'
                : { id: 'electron', external: true };
            if (
              id === './config' &&
              importer === normalizePath(path.join(root, 'src/tray.ts'))
            )
              return '\0rating:@/config';
            if (['@/utils', '@/i18n', '@/config'].includes(id))
              return '\0rating:' + id;
            if (id.includes('?asset')) return '\0rating-asset:' + id;
            if (id.startsWith('@/')) {
              const p = path.join(root, 'src', id.slice(2));
              const file = [p, p + '.ts', path.join(p, 'index.ts')].find(
                (f) => existsSync(f) && statSync(f).isFile(),
              );
              return file && normalizePath(file);
            }
          },
          load(id: string) {
            if (id === '\0rating-platform')
              return 'export default {windows:()=>true,linux:()=>false};';
            if (id === '\0rating-electron')
              return `export {app,ipcMain} from 'electron';export class Notification {constructor(options){const s=globalThis.RatingNativeProof;s.hook?.('constructor');this.options=options;this.handlers=new Map();s.constructed.push(this)}get on(){globalThis.RatingNativeProof.hook?.('on-get');return (k,f)=>{this.handlers.set(k,f);return this}}removeListener(k,f){if(this.handlers.get(k)===f)this.handlers.delete(k);return this}get show(){globalThis.RatingNativeProof.hook?.('show-get');return ()=>globalThis.RatingNativeProof.shown.push(this.options)}close(){globalThis.RatingNativeProof.closed.push(this);this.handlers.get('close')?.()}}`;
            if (id.startsWith('\0rating-asset:'))
              return (
                'export default ' + JSON.stringify(path.join(owned, 'tray.png'))
              );
            if (id === '\0rating:@/utils')
              return 'export const createPlugin=v=>v,createRenderer=v=>v,LoggerPrefix="owned rating";';
            if (id === '\0rating:@/i18n')
              return 'export const APPLICATION_NAME="Pear";export const t=k=>(globalThis.RatingNativeProof?.locale??"en")+":"+k;';
            if (id === '\0rating:@/config')
              return 'export const state={writes:[],values:{}};export const get=k=>state.values[k]??false;export const set=(key,value)=>state.writes.push({key,value});';
          },
          transform(code: string, id: string) {
            if (
              options.exhausted &&
              normalizePath(id).endsWith(
                '/src/plugins/notifications/rating-feedback-renderer.ts',
              )
            )
              return code.replace(
                /let sourceGeneration\s*=\s*0/,
                'let sourceGeneration=Number.MAX_SAFE_INTEGER',
              );
          },
        },
      ],
    };
    const guard = (relative: string) => ({
      name: 'rating-singleton-' + relative,
      generateBundle(this: any) {
        const expected = normalizePath(path.join(root, relative));
        const ids = [...this.getModuleIds()].filter(
          (id: any) => id.replaceAll('\\', '/').split('?')[0] === expected,
        );
        if (ids.length !== 1 || ids[0] !== expected)
          this.error(
            'Noncanonical singleton ' + relative + JSON.stringify(ids),
          );
      },
    });
    await build({
      ...common,
      plugins: [...common.plugins, guard('src/providers/song-info.ts')],
      ssr: { noExternal: true },
      build: {
        ssr: normalizePath(mainEntry),
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    await build({
      ...common,
      plugins: [...common.plugins, guard('src/providers/playback-owner.ts')],
      build: {
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: normalizePath(rendererEntry),
          name: 'RatingNativeSource',
          formats: ['iife'],
          fileName: () => 'renderer.js',
        },
      },
    });
    await writeFile(
      path.join(owned, 'preload.cjs'),
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('ratingProof',{send:(channel,...args)=>ipcRenderer.send(channel,...args),subscribe:(channel,fn)=>{const h=(_e,...a)=>fn(...a);ipcRenderer.on(channel,h);return()=>ipcRenderer.off(channel,h)},on:(channel,fn)=>{const h=(_e,...a)=>fn({},...a);ipcRenderer.on(channel,h)}});`,
    );
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body><ytmusic-app><video></video><ytmusic-player-bar></ytmusic-player-bar><div id="like-button-renderer" like-status="INDIFFERENT"></div></ytmusic-app><iframe src="child.html"></iframe></body></html>',
    );
    await writeFile(
      path.join(owned, 'child.html'),
      '<html><body>Owned child</body></html>',
    );
    await writeFile(
      path.join(owned, 'entry.cjs'),
      `const {app,BrowserWindow,ipcMain,session,net,nativeImage}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned profile');app.setPath(key,target)}app.on('window-all-closed',()=>{});(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file://')}));net.fetch=async()=>{throw Error('Unexpected native remote request')};const protocolRegistrations=[];app.setAsDefaultProtocolClient=(...args)=>{protocolRegistrations.push(args);return true};fs.writeFileSync(path.join(owned,'tray.png'),nativeImage.createFromBitmap(Buffer.from([0,0,0,255]),{width:1,height:1}).toPNG());globalThis.RatingNativeProof={protocolRegistrations,settings:${JSON.stringify(options)},owned,preload:path.join(owned,'preload.cjs'),BrowserWindow,ipcMain,nativeImage,shown:[],constructed:[],closed:[],controlListener:${JSON.stringify(controlListener)},source:require('./source.cjs'),bundle:fs.readFileSync(path.join(owned,'renderer.js'),'utf8')};const result=await (${task.toString()})();console.log('RATING_NATIVE '+JSON.stringify(result));for(const w of BrowserWindow.getAllWindows())w.destroy();app.quit()})().catch(error=>{console.error(String(error?.stack??error));app.exit(1)});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      requireRoot('electron') as string,
      [
        path.join(owned, 'entry.cjs'),
        `--user-data-dir=${path.join(owned, 'profile')}`,
        '--no-sandbox',
      ],
      {
        cwd: owned,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout!.on(
      'data',
      (chunk) => (stdout = (stdout + chunk).slice(-16000)),
    );
    child.stderr!.on(
      'data',
      (chunk) => (stderr = (stderr + chunk).slice(-16000)),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Error(
              `Owned native rating witness timed out; stdout: ${stdout}; stderr: ${stderr}`,
            ),
          ),
        25000,
      );
      child!.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child!.on('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              Error(
                `Owned native witness exit ${code}; stdout: ${stdout}; stderr: ${stderr}`,
              ),
            );
      });
    });
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('RATING_NATIVE '));
    if (!line) throw Error('Missing native rating witness');
    return JSON.parse(line.slice('RATING_NATIVE '.length));
  } finally {
    if (child?.pid) {
      try {
        process.platform === 'win32'
          ? child.kill('SIGKILL')
          : process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await rm(owned, { recursive: true, force: true });
  }
}
