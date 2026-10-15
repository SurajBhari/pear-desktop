import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build, normalizePath } from 'vite';
const root = path.resolve(import.meta.dirname, '..'),
  requireRoot = createRequire(path.join(root, 'package.json'));
/** Actual broker/controller and Electron IPC; only native getters and service responses are synthetic. */
export async function actionsNative<T>(task: () => Promise<T>): Promise<T> {
  const suppliedEvidence = process.env.PEAR_A1_EVIDENCE_DIRECTORY;
  const prepared = process.env.PEAR_A1_PREPARED_FIXTURE;
  const prepareOnly = process.env.PEAR_A1_PREPARE_ONLY === '1';
  if ((prepareOnly || prepared) && !suppliedEvidence)
    throw Error(
      'Explicit local fixture mode requires an owned evidence directory',
    );
  if (prepareOnly && (process.env.CI || prepared))
    throw Error(
      'Prepare-only mode is local and cannot replace native CI assertions',
    );
  const ownedDirectory = (directory: string) => {
    if (!path.isAbsolute(directory))
      throw Error('Relative native evidence path');
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw Error('Unowned native evidence directory');
  };
  if (suppliedEvidence) ownedDirectory(suppliedEvidence);
  if (prepared) {
    ownedDirectory(prepared);
    if (
      !path.basename(prepared).startsWith('pear-actions-native-') ||
      realpathSync(path.dirname(prepared)) !== realpathSync(tmpdir())
    )
      throw Error('Unowned A1 prepared fixture');
  }
  const owned =
    prepared ?? (await mkdtemp(path.join(tmpdir(), 'pear-actions-native-')));
  const evidence = suppliedEvidence ?? owned;
  const observer = path.join(
    root,
    'tests/helpers/electron-startup-observer.cjs',
  );
  const observerSHA256 =
    '8581f0b3171f094830ba28970278585bcf34f7308538744c22c12fde0abf4f83';
  const fixtureFiles = [
    'entry.cjs',
    'preload.cjs',
    'main.html',
    'child.html',
    'main-source.ts',
    'renderer-source.ts',
    'source.cjs',
    'renderer.js',
  ];
  const sourceFiles = [
    'src/providers/music-actions.ts',
    'src/providers/music-renderer.ts',
    'src/renderer.ts',
    'src/plugins/api-server/music-types.ts',
    'src/plugins/api-server/backend/music-service.ts',
    'src/plugins/api-server/backend/music-operations.ts',
    'src/plugins/api-server/backend/scheme/music.ts',
    'src/plugins/api-server/backend/routes/music.ts',
    'tests/api-music-actions-native.test.ts',
    'tests/helpers/api-music-native.ts',
    'tests/helpers/electron-startup-observer.cjs',
  ];
  const factsPath = path.join(owned, 'startup-facts.json');
  let keepFixture = false;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if (!prepared) {
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
      const core = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
      const init = core.slice(
        core.indexOf('async function onApiLoaded() {') +
          'async function onApiLoaded() {'.length,
        core.indexOf('  // Workaround for macOS traffic lights'),
      );
      await writeFile(
        rendererEntry,
        [
          `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-renderer.ts')))};`,
          `export * from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-actions.ts')))};`,
          `import {publishMusicActionsOwner} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/music-actions.ts')))};`,
          `import {createRepeatPreference} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/repeat-preference.ts')))};`,
          `import {createPlaylistQueueController} from ${JSON.stringify(normalizePath(path.join(root, 'src/providers/queue-playlist-renderer.ts')))};`,
          `let api,repeatPreference,playlistQueue,disposeMusicActionsOwner;export function initializeCore(next){api=next;${init};return{repeatPreference,playlistQueue,disposeMusicActionsOwner};}`,
        ].join('\n'),
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
    }
    const crypto = await import('node:crypto');
    const hash = async (file: string) =>
      crypto
        .createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    if ((await hash(observer)) !== observerSHA256)
      throw Error('F3 observer bytes changed');
    const marker = path.join(evidence, 'A1-NATIVE-EVIDENCE-OWNER.json');
    const project = realpathSync(root);
    if (existsSync(marker)) {
      if (lstatSync(marker).isSymbolicLink())
        throw Error('Unowned evidence marker');
      const owner = JSON.parse(await readFile(marker, 'utf8'));
      if (owner.project !== project || owner.kind !== 'pear-a1-native')
        throw Error('Foreign native evidence owner');
    } else {
      if (prepared) throw Error('Missing explicit prepared evidence owner');
      await writeFile(
        marker,
        JSON.stringify({ kind: 'pear-a1-native', project }),
        { flag: 'wx' },
      );
    }
    const manifestPath = path.join(evidence, 'PREPARED-FIXTURE.json');
    if (!prepared) {
      const fixtureSHA256: Record<string, string> = {},
        sourceBindings: Record<string, string> = {};
      for (const file of fixtureFiles)
        fixtureSHA256[file] = await hash(path.join(owned, file));
      for (const file of sourceFiles)
        sourceBindings[file] = await hash(path.join(root, file));
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            status: prepareOnly
              ? 'PREPARED_UNLAUNCHED_PENDING_ROOT_ADMISSION'
              : 'SELF_CONTAINED_OWNED_NATIVE_FIXTURE',
            owned,
            entrySHA256: fixtureSHA256['entry.cjs'],
            fixtureSHA256,
            sourceBindings,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    }
    if (lstatSync(manifestPath).isSymbolicLink())
      throw Error('Unowned prepared manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const exactKeys = (value: object, expected: string[]) =>
      Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
    if (
      manifest.owned !== owned ||
      !exactKeys(manifest.fixtureSHA256, fixtureFiles) ||
      !exactKeys(manifest.sourceBindings, sourceFiles)
    )
      throw Error('Prepared fixture identity changed');
    for (const file of fixtureFiles)
      if ((await hash(path.join(owned, file))) !== manifest.fixtureSHA256[file])
        throw Error('Prepared fixture bytes changed');
    for (const file of sourceFiles)
      if ((await hash(path.join(root, file))) !== manifest.sourceBindings[file])
        throw Error('Prepared source bytes changed');
    for (const file of [
      'profile',
      'userData',
      'sessionData',
      'downloads',
      'startup-facts.json',
      'startup-facts.json.request',
    ])
      if (existsSync(path.join(owned, file)))
        throw Error('Native fixture profile/facts are not fresh');
    if (prepareOnly) {
      keepFixture = true;
      return { prepared: true } as T;
    }
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.V8_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    env.PEAR_TEST_STARTUP_FACTS = factsPath;
    child = spawn(
      realpathSync(requireRoot('electron') as string),
      [
        '--require',
        observer,
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
    const proof = JSON.parse(line.slice('MUSIC_NATIVE '.length));
    const facts = JSON.parse(await readFile(factsPath, 'utf8'));
    if (
      proof.mainPid !== child.pid ||
      proof.guardFacts?.pid !== child.pid ||
      facts.pid !== child.pid ||
      facts.visibleWindow !== false ||
      realpathSync(facts.userData) !==
        realpathSync(path.join(owned, 'userData'))
    )
      throw Error(
        'Guard facts do not identify the hidden spawned main/profile',
      );
    if (suppliedEvidence)
      await writeFile(
        path.join(evidence, 'ACTUAL-NATIVE-FACTS.json'),
        JSON.stringify({ facts, spawnedPID: child.pid }, null, 2),
        { flag: 'wx' },
      );
    return proof;
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.platform === 'win32'
          ? child.kill('SIGKILL')
          : process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    if (!keepFixture) await rm(owned, { recursive: true, force: true });
  }
}

test('C9 actual REST authenticated IPC native receiver and same core instances with lost/wrong ACK', async () => {
  const proof: any = await actionsNative(async () => {
    const f = (globalThis as any).MusicNativeProof,
      http = require('node:http'),
      fs = require('node:fs'),
      nativePath = require('node:path');
    const facts = process.env.PEAR_TEST_STARTUP_FACTS;
    if (!facts) throw Error('Missing exact CLI facts');
    fs.writeFileSync(facts + '.request', 'owned');
    const wait = async (check: () => Promise<boolean> | boolean) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end) throw Error('Missing owned witness');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await wait(
      () => fs.existsSync(facts) && !fs.existsSync(facts + '.request'),
    );
    const guardFacts = JSON.parse(fs.readFileSync(facts, 'utf8'));
    if (
      guardFacts.pid !== process.pid ||
      guardFacts.visibleWindow ||
      fs.realpathSync(guardFacts.userData) !==
        fs.realpathSync(nativePath.join(f.owned, 'userData'))
    )
      throw Error('Unqualified hidden main/profile');
    const reserve = http.createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise<void>((r) => reserve.close(r));
    const make = () =>
        new f.BrowserWindow({
          show: false,
          webPreferences: {
            preload: f.preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
          },
        }),
      win = make(),
      foreign = make();
    await win.loadFile(f.owned + '/main.html');
    await foreign.loadFile(f.owned + '/child.html');
    f.mark('C9-native-child-bridge-ready');
    const childBridgeReady =
      await win.webContents.mainFrame.frames[0].executeJavaScript(
        'typeof window.musicProof?.send === \"function\"',
      );
    if (!childBridgeReady) throw Error('Owned child preload bridge not ready');
    const evaluate = (code: string) => win.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`document.body.insertAdjacentHTML('beforeend','<ytmusic-player-bar><button class="previous-button ytmusic-player-bar"></button><button class="next-button ytmusic-player-bar"></button></ytmusic-player-bar><div id="movie_player"></div><input id="volume-slider"><input id="expand-volume-slider">');
   window.calls=[];window.video='current0001';window.mode=0;window.state=2;window.nativeEvents={};window.held=[];window.holdAck=false;window.fetches=0;window.selfTransition=false;
   window.ipcRenderer={send(){},subscribe(){return()=>{}}};window.api=document.querySelector('#movie_player');window.bar=document.querySelector('ytmusic-player-bar');window.appNode=document.querySelector('ytmusic-app');
   const record=(name,receiver,args)=>window.calls.push({name,receiver,args});
   api.getVideoData=()=>({video_id:window.video});api.getPlayerResponse=()=>({videoDetails:{videoId:window.video,title:'Synthetic current',author:'Synthetic artist'}});api.getCurrentTime=()=>0;api.getDuration=()=>100;api.getVolume=()=>50;api.getPlayerState=()=>window.state;api.addEventListener=(k,fn)=>window.nativeEvents[k]=fn;api.removeEventListener=k=>delete window.nativeEvents[k];
   api.playVideo=function(){record('play',this===api,[]);if(window.selfTransition){window.video='other000001';window.nativeEvents.videodatachange?.()}};api.pauseVideo=function(){record('pause',this===api,[])};api.seekTo=function(v){record('seek',this===api,[v])};api.setVolume=function(v){record('set_volume',this===api,[v])};
   bar.queue={shuffle:function(){record('toggle_shuffle',this===bar.queue,[])}};bar.onRepeatButtonClick=function(){record('switch_repeat',this===bar,[]);window.mode=(window.mode+1)%3};bar.getState=()=>({queue:{repeatMode:['NONE','ALL','ONE'][window.mode]}});
   for(const name of ['previous','next']){const button=document.querySelector('.'+name+'-button'),original=button.click;button.click=function(){record(name,this===button,[]);return Reflect.apply(original,this,[])}};
   appNode.networkManager={fetch(){window.fetches++;throw Error('Unexpected provider')}};window.blockerSceneGuard={cancelFromUser:function(){record('guard',this===window.blockerSceneGuard,[])}};
   window.core=MusicNativeSource.initializeCore(api);const owner=MusicNativeSource.getMusicActionsOwner(api);window.coreIdentity=owner.repeatPreference===core.repeatPreference&&owner.playlistQueue===core.playlistQueue;window.oldOwner=owner;
   window.controller=MusicNativeSource.createMusicRendererController(api,()=>api,{subscribe:window.musicProof.subscribe,send:(c,p)=>{if(window.holdAck&&p.type==='settled')window.held.push(p);else window.musicProof.send(c,p)}});undefined;`);
    const config = {
        enabled: true,
        musicApiEnabled: true,
        hostname: '127.0.0.1',
        port,
        useHttps: false,
        certPath: '',
        keyPath: '',
        secret: '0'.repeat(64),
        authorizedClients: [],
        authStrategy: 'NONE',
      },
      listeners: any[] = [];
    const context = {
      window: win,
      getConfig: () => config,
      setConfig() {},
      ipc: {
        send: (...a: any[]) => win.webContents.send(...a),
        on: (c: string, fn: any) => {
          const h = (_e: any, ...a: any[]) => fn(...a);
          listeners.push([c, h]);
          f.ipcMain.on(c, h);
        },
        handle: (c: string, fn: any) => f.ipcMain.handle(c, fn),
        removeHandler: (c: string) => f.ipcMain.removeHandler(c),
      },
    };
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const service = f.source.getMusicService(win),
      grant = await service.grants.issue(
        'Owned C9',
        'rest',
        service.resource,
        ['playback.control', 'playback.read'],
        () => true,
      ),
      broker = f.source.createMusicRequestBroker(win),
      originalRead = broker.read;
    let brokerCalls = 0;
    broker.read = function (...a: any[]) {
      brokerCalls++;
      return Reflect.apply(originalRead, this, a);
    };
    const packets: any[] = [];
    const observe = (e: any, p: any) => {
      if (
        e.sender === win.webContents &&
        e.senderFrame === win.webContents.mainFrame &&
        p.type === 'settled'
      )
        packets.push(p);
    };
    f.ipcMain.on('peard:music-reply', observe);
    const request = (target: string, method = 'GET', body?: any) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + target,
            method,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + grant.token,
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
          },
          (res: any) => {
            let text = '';
            res.on('data', (c: any) => (text += c));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: JSON.parse(text) }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const epoch = (await request('/current')).body.playbackEpoch,
      commands = [
        { action: 'previous' },
        { action: 'next' },
        { action: 'play' },
        { action: 'pause' },
        { action: 'toggle_playback' },
        { action: 'toggle_shuffle' },
        { action: 'switch_repeat' },
        { action: 'switch_repeat', iterations: 2 },
        { action: 'seek', seconds: 0, playbackEpoch: epoch },
        { action: 'seek', seconds: 1.25, playbackEpoch: epoch },
        { action: 'set_volume', volume: 0 },
        { action: 'set_volume', volume: 0.01 },
        { action: 'set_volume', volume: 100 },
      ];
    const rows: any[] = [];
    for (const command of commands) {
      const before = await evaluate(
          '({calls:window.calls.length,fetches:window.fetches})',
        ),
        beforeBroker = brokerCalls,
        beforePackets = packets.length,
        p = await request('/operations/prepare', 'POST', command),
        afterPrepare = await evaluate('window.calls.length'),
        body = { ...command, operationId: p.body.operationId },
        receipt = await request('/control', 'POST', body),
        afterExecute = await evaluate(
          'window.calls.slice(' + before.calls + ')',
        ),
        replay = await request('/control', 'POST', body),
        status = await request('/operations/' + p.body.operationId),
        afterReplay = await evaluate('window.calls.length');
      rows.push({
        command,
        statuses: [p.status, receipt.status, replay.status, status.status],
        prepared: p.body,
        receipt: receipt.body,
        replay: replay.body,
        status: status.body,
        before,
        afterPrepare,
        afterExecute,
        afterReplay,
        brokerCalls: brokerCalls - beforeBroker,
        packets: packets.slice(beforePackets).map((p) => p.result),
        sliders: await evaluate(
          '[document.querySelector("#volume-slider").value,document.querySelector("#expand-volume-slider").value]',
        ),
      });
    }
    await evaluate('window.state=3;undefined;');
    const other = await request('/operations/prepare', 'POST', {
      action: 'toggle_playback',
    });
    await request('/control', 'POST', {
      action: 'toggle_playback',
      operationId: other.body.operationId,
    });
    const alternate = await evaluate('window.calls.at(-1)');
    await evaluate('window.selfTransition=true;undefined;');
    const self = await request('/operations/prepare', 'POST', {
        action: 'play',
      }),
      selfReceipt = await request('/control', 'POST', {
        action: 'play',
        operationId: self.body.operationId,
      });
    await evaluate(
      'window.selfTransition=false;window.holdAck=true;undefined;',
    );
    const prepared = await service.prepare(grant.token, { action: 'pause' }),
      before = brokerCalls,
      lost = await service
        .control(
          grant.token,
          { action: 'pause', operationId: prepared.operationId },
          undefined,
          Date.now() + 80,
        )
        .catch((e: any) => e.code);
    await wait(async () => await evaluate('window.held.length===1'));
    const held = await evaluate('window.held[0]'),
      ledger = service.operations,
      row = ledger.rows.get(prepared.operationId),
      beforeWrong = {
        dispatched: broker.stats().dispatched,
        physicalHold: row.physicalHold,
        status: row.receipt.status,
      };
    f.mark('C9-late-ack-foreign-sender');
    await foreign.webContents.executeJavaScript(
      'window.musicProof.send("peard:music-reply",' +
        JSON.stringify(held) +
        ')',
    );
    f.mark('C9-late-ack-child-frame');
    await win.webContents.mainFrame.frames[0].executeJavaScript(
      'window.musicProof.send("peard:music-reply",' +
        JSON.stringify(held) +
        ')',
    );
    await evaluate(
      'window.musicProof.send("peard:music-reply",' +
        JSON.stringify({ ...held, nonce: 'f'.repeat(32) }) +
        ')',
    );
    await evaluate(
      'window.musicProof.send("peard:music-reply",' +
        JSON.stringify({ ...held, documentId: 'f'.repeat(32) }) +
        ')',
    );
    const afterWrong = {
      dispatched: broker.stats().dispatched,
      physicalHold: row.physicalHold,
      status: row.receipt.status,
    };
    await evaluate(
      'window.holdAck=false;window.musicProof.send("peard:music-reply",window.held.shift());undefined;',
    );
    await wait(() => broker.stats().dispatched === 0);
    const afterLate = await service.operation(
        grant.token,
        prepared.operationId,
      ),
      lostReplay = await service.control(grant.token, {
        action: 'pause',
        operationId: prepared.operationId,
      });
    const core = await evaluate(
      '(()=>{const first=window.oldOwner,second=MusicNativeSource.initializeCore(api),owner=MusicNativeSource.getMusicActionsOwner(api);const result={same:window.coreIdentity,oldRetired:!first.current(),sameNew:owner.repeatPreference===second.repeatPreference&&owner.playlistQueue===second.playlistQueue};window.dispatchEvent(new Event("pagehide"));result.pagehide=!owner.current()&&!MusicNativeSource.getMusicActionsOwner(api);return result})()',
    );
    const fetches = await evaluate('window.fetches');
    f.ipcMain.off('peard:music-reply', observe);
    broker.read = originalRead;
    await f.source.backend.stop(context);
    for (const [c, h] of listeners) f.ipcMain.off(c, h);
    win.destroy();
    foreign.destroy();
    return {
      rows,
      alternate,
      selfReceipt,
      core,
      fetches,
      lost,
      beforeWrong,
      afterWrong,
      afterLate,
      lostReplay,
      lostBrokerCalls: brokerCalls - before,
      physicalHoldAfterLate: row.physicalHold,
      guardFacts: {
        pid: guardFacts.pid,
        visibleWindow: guardFacts.visibleWindow,
        userDataOwned:
          fs.realpathSync(guardFacts.userData) ===
          fs.realpathSync(nativePath.join(f.owned, 'userData')),
      },
      mainPid: process.pid,
    };
  });
  if (process.env.PEAR_A1_PREPARE_ONLY === '1') {
    expect(proof.prepared).toBe(true);
    return;
  }
  for (const row of proof.rows) {
    expect(row.statuses).toEqual([200, 200, 200, 200]);
    expect(row.prepared.status).toBe('pending');
    expect(row.receipt).toEqual({
      operationId: row.prepared.operationId,
      status: 'accepted',
      meaning: 'owned_control_dispatch',
    });
    expect(row.replay).toEqual(row.receipt);
    expect(row.status).toEqual(row.receipt);
    expect(row.afterPrepare).toBe(row.before.calls);
    expect(row.brokerCalls).toBe(1);
    expect(row.afterReplay).toBe(row.before.calls + row.afterExecute.length);
    expect(row.packets).toEqual([
      { ok: true, value: { version: 1, phase: 'owned_control_dispatch' } },
    ]);
    expect(row.afterExecute[0]).toEqual({
      name: 'guard',
      receiver: true,
      args: [],
    });
    const expected =
      row.command.action === 'toggle_playback' ? 'play' : row.command.action;
    expect(row.afterExecute.slice(1).map((c: any) => c.name)).toEqual(
      Array.from({ length: row.command.iterations ?? 1 }, () => expected),
    );
    for (const c of row.afterExecute) expect(c.receiver).toBe(true);
    if (row.command.action === 'seek')
      expect(row.afterExecute[1].args).toEqual([row.command.seconds]);
    if (row.command.action === 'set_volume') {
      expect(row.afterExecute[1].args).toEqual([row.command.volume]);
      expect(row.sliders).toEqual([
        String(row.command.volume),
        String(row.command.volume),
      ]);
    }
  }
  expect(proof.alternate).toEqual({ name: 'pause', receiver: true, args: [] });
  expect(proof.selfReceipt.body.status).toBe('accepted');
  expect(proof.core).toEqual({
    same: true,
    oldRetired: true,
    sameNew: true,
    pagehide: true,
  });
  expect(proof.fetches).toBe(0);
  expect(proof.beforeWrong).toEqual({
    dispatched: 1,
    physicalHold: true,
    status: 'uncertain',
  });
  expect(proof.afterWrong).toEqual(proof.beforeWrong);
  expect(proof.afterLate.status).toBe('uncertain');
  expect(proof.lostReplay).toEqual(proof.afterLate);
  expect(proof.lostBrokerCalls).toBe(1);
  expect(proof.physicalHoldAfterLate).toBe(false);
  expect(proof.guardFacts).toEqual({
    pid: proof.mainPid,
    visibleWindow: false,
    userDataOwned: true,
  });
});
