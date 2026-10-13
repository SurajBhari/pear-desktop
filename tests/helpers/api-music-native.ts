import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build, normalizePath } from 'vite';
const root = path.resolve(import.meta.dirname, '../..'),
  requireRoot = createRequire(path.join(root, 'package.json'));
/** Actual broker/controller and Electron IPC; only native getters and service responses are synthetic. */
export async function musicNative<T>(task: () => Promise<T>): Promise<T> {
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-music-native-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const mainEntry = path.join(owned, 'main-source.ts'),
      rendererEntry = path.join(owned, 'renderer-source.ts');
    await writeFile(
      mainEntry,
      [
        `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-request.ts')))};`,
        `export {backend} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/main.ts')))};`,
        `export {createMusicGrantMenu} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/music-menu.ts')))};`,
        `export {getMusicService} from ${JSON.stringify(normalizePath(path.join(root, 'src/plugins/api-server/backend/music-service.ts')))};`,
      ].join('\n'),
    );
    await writeFile(
      rendererEntry,
      `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-renderer.ts')))};`,
    );
    const common = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      resolve: { alias: {} },
      plugins: [
        {
          name: 'native-app-boundaries',
          enforce: 'pre' as const,
          resolveId(id: string) {
            if (['@/utils', '@/i18n', '@/config'].includes(id))
              return '\0owned:' + id;
            if (id.startsWith('@/')) {
              const p = path.join(root, 'src', id.slice(2));
              const resolved = [p, p + '.ts', path.join(p, 'index.ts')].find(
                (f) => existsSync(f) && statSync(f).isFile(),
              );
              return resolved && normalizePath(resolved);
            }
          },
          load(id: string) {
            if (id === '\0owned:@/utils')
              return 'export const createBackend=value=>value;export const LoggerPrefix="owned fixture";';
            if (id === '\0owned:@/i18n')
              return 'export const APPLICATION_NAME="Pear";export const t=value=>value;';
            if (id === '\0owned:@/config')
              return 'export const get=()=>false;export const set=()=>{};';
          },
        },
      ],
    };
    await build({
      ...common,
      plugins: [
        ...common.plugins,
        {
          name: 'assert-native-broker-singleton',
          generateBundle() {
            for (const relative of [
              'src/providers/music-request.ts',
              'src/plugins/api-server/backend/music-service.ts',
            ]) {
              const expected = normalizePath(path.join(root, relative));
              const ids = [...this.getModuleIds()].filter(
                (id) => id.replaceAll('\\', '/').split('?')[0] === expected,
              );
              if (ids.length !== 1 || ids[0] !== expected)
                this.error(
                  `Owned native singleton identity: ${relative}: ${JSON.stringify(ids)}`,
                );
            }
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        ssr: normalizePath(mainEntry),
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    await build({
      ...common,
      build: {
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: normalizePath(rendererEntry),
          name: 'MusicNativeSource',
          formats: ['iife'],
          fileName: () => 'renderer.js',
        },
      },
    });
    await writeFile(
      path.join(owned, 'preload.cjs'),
      `const {contextBridge,ipcRenderer}=require('electron');ipcRenderer.send('peard:owned-music-preload',{phase:'entered',mainFrame:process.isMainFrame});contextBridge.exposeInMainWorld('musicProof',{send:(channel,packet)=>ipcRenderer.send(channel,packet),subscribe:(channel,fn)=>{const h=(_e,...args)=>fn(...args);ipcRenderer.on(channel,h);return()=>ipcRenderer.off(channel,h)}});ipcRenderer.send('peard:owned-music-preload',{phase:'bridge-ready',mainFrame:process.isMainFrame});`,
    );
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body><ytmusic-app></ytmusic-app><iframe src="child.html"></iframe></body></html>',
    );
    await writeFile(
      path.join(owned, 'child.html'),
      '<html><body>Owned child</body></html>',
    );
    await writeFile(
      path.join(owned, 'entry.cjs'),
      `
const {app,BrowserWindow,ipcMain,session,net}=require('electron');const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};
for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned profile');app.setPath(key,target);}
let stage='ready';const mark=label=>{stage=label;console.log('MUSIC_NATIVE_STAGE '+JSON.stringify({stage,pid:process.pid,time:Date.now()}));};const bounded=async(label,operation)=>{mark(label);let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native phase did not complete: '+label)),5000);})]);}finally{clearTimeout(timer);}};app.on('browser-window-created',(_event,win)=>{const id=win.id,contents=win.webContents;for(const name of ['did-start-loading','did-stop-loading','did-finish-load','did-frame-finish-load','did-start-navigation','did-navigate','did-fail-load','render-process-gone'])contents.on(name,(...args)=>{const mainFrame=name==='did-frame-finish-load'?args[1]:name==='did-fail-load'?args[4]:name==='did-start-navigation'?(args[0]?.isMainFrame??args[3]):undefined;console.log('MUSIC_NATIVE_EVENT '+JSON.stringify({stage,window:id,event:name,time:Date.now(),pid:process.pid,rendererPid:contents.isDestroyed()?0:contents.getOSProcessId(),...(typeof mainFrame==='boolean'?{mainFrame}:{}),...(name==='did-fail-load'?{code:args[1]}:{}),...(name==='render-process-gone'?{reason:args[1]?.reason}:{})}));});});ipcMain.on('peard:owned-music-preload',(event,packet)=>{const win=BrowserWindow.fromWebContents(event.sender);if(!win||!['entered','bridge-ready'].includes(packet?.phase))return;console.log('MUSIC_NATIVE_PRELOAD '+JSON.stringify({stage,window:win.id,time:Date.now(),pid:process.pid,rendererPid:win.webContents.getOSProcessId(),phase:packet.phase,mainFrame:event.senderFrame===win.webContents.mainFrame}));});(async()=>{await app.whenReady();session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file://')}));net.fetch=async()=>{throw Error('Unexpected native remote request')};globalThis.MusicNativeProof={mark,bounded,app,owned,preload:path.join(owned,'preload.cjs'),BrowserWindow,ipcMain,source:require('./source.cjs'),bundle:fs.readFileSync(path.join(owned,'renderer.js'),'utf8')};stage='task';const result=await (${task.toString()})();stage='shutdown';console.log('MUSIC_NATIVE '+JSON.stringify(result));for(const w of BrowserWindow.getAllWindows())w.destroy();app.quit()})().catch(error=>{console.error('Owned native music witness failed at '+stage+': '+String(error?.stack??error).slice(-8000));app.exit(1)});
`,
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
              `Owned native music witness timed out; stdout: ${stdout}; stderr: ${stderr}`,
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
    if (process.env.PEAR_MUSIC_NATIVE_TRACE === '1')
      process.stdout.write(stdout);
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('MUSIC_NATIVE '));
    if (!line) throw Error('Missing native music witness');
    return JSON.parse(line.slice('MUSIC_NATIVE '.length));
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
