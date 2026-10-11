import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');
const requireRoot = createRequire(path.join(root, 'package.json'));

/** Real app modules and Electron; only app config/wrappers and network are fixtures. */
export async function scrobblerIntegrationNative<T>(
  task: () => Promise<T>,
): Promise<T> {
  const owned = await mkdtemp(
    path.join(tmpdir(), 'pear-scrobbler-integration-native-'),
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const entry = path.join(owned, 'source.ts');
    await writeFile(
      entry,
      [
        `export {createScrobblerManager} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/main.ts'))};`,
        `export {defaultConfig} from ${JSON.stringify(path.join(root, 'src/plugins/scrobbler/config.ts'))};`,
        `export {setupSongInfo,registerCallback,getSongInfoProvenance,getCurrentSongInfoProvenance} from ${JSON.stringify(path.join(root, 'src/providers/song-info.ts'))};`,
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      ssr: { noExternal: true },
      plugins: [
        {
          name: 'scrobbler-native-app-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (['@/config', '@/utils', '@/i18n'].includes(id))
              return '\0owned:' + id;
            if (id.startsWith('@/'))
              return path.join(root, 'src', id.slice(2)) + '.ts';
          },
          load(id) {
            if (id === '\0owned:@/config')
              return 'export const get=()=>false;export const set=()=>{};';
            if (id === '\0owned:@/utils')
              return 'export const createBackend=value=>value;';
            if (id === '\0owned:@/i18n')
              return 'export const APPLICATION_NAME="Pear";';
          },
        },
      ],
      build: {
        ssr: true,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          input: entry,
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'source.cjs' },
        },
      },
    });
    const preload = path.join(owned, 'preload.cjs');
    await writeFile(
      preload,
      'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("scrobbleProof",{send:(event,data)=>ipcRenderer.send(event,data)});',
    );
    await writeFile(
      path.join(owned, 'main.html'),
      '<html><body>Owned main<iframe src="child.html"></iframe></body></html>',
    );
    await writeFile(
      path.join(owned, 'child.html'),
      '<html><body>Owned child</body></html>',
    );
    const main = path.join(owned, 'entry.cjs');
    await writeFile(
      main,
      `
const {app,BrowserWindow,ipcMain,net,nativeImage,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');const owned=${JSON.stringify(owned)};
for(const key of ['userData','sessionData','downloads']){const target=path.join(owned,key);fs.mkdirSync(target,{recursive:true});if(!fs.realpathSync(target).startsWith(fs.realpathSync(owned)+path.sep))throw Error('Unowned native profile');app.setPath(key,target);}
app.on('window-all-closed',()=>{});
(async()=>{await app.whenReady();const configured=new WeakSet();const configure=ses=>{if(configured.has(ses))return;configured.add(ses);for(const scheme of ['https','http'])ses.protocol.handle(scheme,()=>new Response('<html><body>Owned intercepted auth</body></html>',{headers:{'Content-Type':'text/html'}}));};configure(session.defaultSession);app.on('session-created',configure);
globalThis.ScrobbleIntegrationProof={source:require(path.join(owned,'source.cjs')),app,BrowserWindow,ipcMain,net,nativeImage,session,owned,preload:${JSON.stringify(preload)}};
const result=await (${task.toString()})();console.log('SCROBBLER_INTEGRATION_NATIVE '+JSON.stringify(result));for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit();})().catch(error=>{console.error(error);app.exit(1)});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      requireRoot('electron') as string,
      [main, '--no-sandbox', `--user-data-dir=${path.join(owned, 'profile')}`],
      {
        cwd: owned,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (value) => {
      stdout += value;
    });
    child.stderr!.on('data', (value) => {
      stderr += value;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Owned native integration timed out')),
        25000,
      );
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(Error(`Native integration exited ${code}: ${stderr}`));
      });
    });
    const line = stdout
      .split('\n')
      .find((value) => value.startsWith('SCROBBLER_INTEGRATION_NATIVE '));
    if (!line) throw Error('Missing native integration result');
    return JSON.parse(line.slice('SCROBBLER_INTEGRATION_NATIVE '.length)) as T;
  } finally {
    if (child?.pid && child.exitCode === null) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Owned process already exited. */
      }
    }
    await rm(owned, { recursive: true, force: true });
  }
}
