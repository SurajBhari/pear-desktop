import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build, normalizePath } from 'vite';

const root = normalizePath(path.resolve(import.meta.dirname, '../..'));
const requireRoot = createRequire(path.join(root, 'package.json'));
const localShortcutPath = normalizePath(
  requireRoot.resolve('electron-localshortcut'),
);

/** Actual source, Electron registry/windows/input/IPC/provider. Callback stimuli are explicitly controlled. */
export async function shortcutRatingNative<T>(
  task: () => Promise<T>,
  { duplicateLocalCallbacks = false } = {},
): Promise<T> {
  const sourceRoot = normalizePath(
    process.env.PEAR_SHORTCUT_NATIVE_SOURCE_ROOT ?? root,
  );
  const owned = await mkdtemp(path.join(tmpdir(), 'shortcut-native-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const entry = path.join(owned, 'source.ts');
    await writeFile(
      entry,
      [
        `export {backend} from ${JSON.stringify(normalizePath(sourceRoot + '/src/plugins/shortcuts/main.ts'))};`,
        `export {default as shortcuts} from ${JSON.stringify(normalizePath(sourceRoot + '/src/plugins/shortcuts/index.ts'))};`,
        `export {default as precise} from ${JSON.stringify(normalizePath(sourceRoot + '/src/plugins/precise-volume/index.ts'))};`,
        `export * from ${JSON.stringify(normalizePath(sourceRoot + '/src/providers/song-info.ts'))};`,
        `export * as localShortcut from ${JSON.stringify(localShortcutPath)};`,
      ].join('\n'),
    );
    await build({
      root: sourceRoot,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'native-shortcut-public-boundaries',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === 'electron-localshortcut')
              return duplicateLocalCallbacks
                ? '\0native-shortcut:duplicate-local-callback'
                : localShortcutPath;
            if (['@/utils', '@/i18n', '@/config'].includes(id))
              return '\0native-shortcut:' + id;
            if (id === './mpris') return '\0native-shortcut:mpris';
            if (
              importer &&
              normalizePath(importer).endsWith('/precise-volume/index.ts') &&
              ['./renderer', './override'].includes(id)
            )
              return '\0native-shortcut:volume-renderer';
            if (id.startsWith('@/')) {
              const target = normalizePath(
                path.join(sourceRoot, 'src', id.slice(2)),
              );
              return [target, target + '.ts', target + '/index.ts'].find(
                (value) => existsSync(value) && statSync(value).isFile(),
              );
            }
          },
          load(id) {
            if (id === '\0native-shortcut:duplicate-local-callback')
              return `import * as actual from ${JSON.stringify(localShortcutPath)};export const isRegistered=actual.isRegistered,unregister=actual.unregister;export const register=(window,key,invoke)=>actual.register(window,key,()=>{invoke();invoke()});`;
            if (id === '\0native-shortcut:@/utils')
              return 'export const createBackend=v=>v,createPlugin=v=>v;';
            if (id === '\0native-shortcut:@/i18n')
              return 'export const t=k=>k,APPLICATION_NAME="Pear";';
            if (id === '\0native-shortcut:@/config')
              return 'export const get=()=>false,set=()=>{};';
            if (id === '\0native-shortcut:mpris')
              return 'export const registerMPRIS=()=>{};';
            if (id === '\0native-shortcut:volume-renderer')
              return 'export const onConfigChange=()=>{},onPlayerApiReady=()=>{},overrideListener=()=>{};';
          },
          generateBundle() {
            const owner = normalizePath(
              sourceRoot + '/src/utils/global-shortcut-owner.ts',
            );
            if (
              existsSync(owner) &&
              [...this.getModuleIds()].filter(
                (id) => normalizePath(id) === owner,
              ).length !== 1
            )
              this.error(
                'Native shortcut owner must have one shared module identity',
              );
            if (
              [...this.getModuleIds()].filter(
                (id) => normalizePath(id) === localShortcutPath,
              ).length !== 1
            )
              this.error(
                'Native local shortcuts must share one actual registry',
              );
          },
        },
      ],
      build: {
        ssr: normalizePath(entry),
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          output: { entryFileNames: 'source.cjs', format: 'cjs' },
          external: ['electron'],
        },
      },
    });
    const renderer = await readFile(
      path.join(sourceRoot, 'src/renderer.ts'),
      'utf8',
    );
    const from = renderer.indexOf(
      "  window.ipcRenderer.on(\n    'peard:update-like',",
    );
    const to = renderer.indexOf(
      "  window.ipcRenderer.on('peard:switch-repeat'",
      from,
    );
    if (from < 0 || to < from)
      throw Error('Actual native like-control handler not found');
    const client = path.join(owned, 'client.ts');
    await writeFile(client, renderer.slice(from, to));
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: owned,
        emptyOutDir: false,
        lib: {
          entry: normalizePath(client),
          formats: ['iife'],
          name: 'ActualLikeControl',
          fileName: () => 'client.js',
        },
        minify: false,
      },
    });
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body><video></video><div id="like-button-renderer" like-status="INDIFFERENT"></div></body></html>',
    );
    await writeFile(
      path.join(owned, 'preload.cjs'),
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('shortcutProof',{send:(...a)=>ipcRenderer.send(...a),on:(c,f)=>{const h=(e,...a)=>f({},...a);ipcRenderer.on(c,h);return()=>ipcRenderer.off(c,h)}});`,
    );
    const nativeEntry = path.join(owned, 'entry.cjs');
    await writeFile(
      nativeEntry,
      `const {app,BrowserWindow,globalShortcut,ipcMain,session,net}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});app.setPath(key,target)};(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file://')}));net.fetch=async()=>{throw Error('Unexpected native network request')};const callbacks=new Map(),register=globalShortcut.register.bind(globalShortcut),unregister=globalShortcut.unregister.bind(globalShortcut);globalShortcut.register=(key,fn)=>{const ok=register(key,fn);if(ok)callbacks.set(key,fn);return ok};globalShortcut.unregister=key=>{unregister(key);callbacks.delete(key)};globalThis.ShortcutNativeProof={app,BrowserWindow,globalShortcut,ipcMain,callbacks,owned,localShortcut:require('./source.cjs').localShortcut,versions:process.versions,preload:path.join(owned,'preload.cjs'),source:require('./source.cjs'),client:fs.readFileSync(path.join(owned,'client.js'),'utf8')};const result=await (${task.toString()})();console.log('SHORTCUT_NATIVE '+JSON.stringify(result));for(const w of BrowserWindow.getAllWindows())w.destroy();app.quit()})().catch(error=>{console.error(String(error?.stack??error));app.exit(1)});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      requireRoot('electron'),
      [nativeEntry, '--no-sandbox', '--disable-gpu'],
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
      (chunk) => (stdout = (stdout + chunk).slice(-20000)),
    );
    child.stderr!.on(
      'data',
      (chunk) => (stderr = (stderr + chunk).slice(-20000)),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(Error('Native shortcuts timeout; ' + stdout + '; ' + stderr)),
        25000,
      );
      child!.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.on('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(
              Error(
                'Native shortcuts exit ' + code + '; ' + stdout + '; ' + stderr,
              ),
            );
      });
    });
    const line = stdout
      .split('\n')
      .find((value) => value.startsWith('SHORTCUT_NATIVE '));
    if (!line) throw Error('Native shortcuts evidence missing');
    return JSON.parse(line.slice('SHORTCUT_NATIVE '.length));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(
          process.platform === 'win32' ? child.pid : -child.pid,
          'SIGKILL',
        );
      } catch {
        /* Already exited owned process. */
      }
    }
    await rm(owned, { recursive: true, force: true });
  }
}
