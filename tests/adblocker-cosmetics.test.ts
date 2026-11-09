import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));

test('native cosmetic/scriptlet IPC works initially and on hot blocklist changes, preserving URL and app styles', async () => {
  test.setTimeout(30_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-cosmetics-test-'));
  try {
    for (const file of await readdir(path.join(root, 'src/providers'))) {
      if (!/^blocker-.*\.ts$/.test(file)) continue;
      const source = await readFile(
        path.join(root, 'src/providers', file),
        'utf8',
      );
      const compiled = stripTypeScriptTypes(source)
        .replace(
          /(['"])(\.\/blocker-[^'"]+)\1/g,
          (_, quote, name) => `${quote}${name}.mjs${quote}`,
        )
        .replace(
          /(['"])@ghostery\/adblocker-electron\1/g,
          JSON.stringify(
            pathToFileURL(require.resolve('@ghostery/adblocker-electron')).href,
          ),
        );
      await writeFile(
        path.join(directory, file.replace('.ts', '.mjs')),
        compiled,
      );
    }
    const preload = path.join(directory, 'fixture-preload.cjs');
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{invoke:(...args)=>ipcRenderer.invoke(...args)});`,
    );
    const script = `
const { app, session, ipcMain, BrowserWindow, net } = require('electron');
const {createRequire}=require('node:module');
const requireRoot=createRequire(${JSON.stringify(path.join(root, 'package.json'))});
const {enhanceWebRequest}=requireRoot('@jellybrick/electron-better-web-request');
const {ElectronBlocker}=requireRoot('@ghostery/adblocker-electron');
let engineFacade;
const actualEnable=ElectronBlocker.prototype.enableBlockingInSession;
ElectronBlocker.prototype.enableBlockingInSession=function(target){engineFacade=target;return actualEnable.call(this,target);};
(async()=>{
 await app.whenReady();
 const provider=await import('./blocker-session.mjs');
 const {createBlockerBackend}=await import('./blocker-backend.mjs');
 const native=session.fromPartition('pear-cosmetics-in-memory');
 const enhanced=enhanceWebRequest(native);
 const fixtureURL='https://pear-blocker-fixture.test/player?queue=kept#track';
 const html='<html><head><style>.keep{color:rgb(12,34,56)}</style><script>window.__unsafeAuthorRan=true;</script></head><body><div class="ad">ad</div><div class="keep">keep</div></body></html>';
 native.protocol.handle('https',()=>new Response(html,{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}}));
 const subscription='https://pear-blocker-subscription.test/list.txt';
 const resources=JSON.stringify({redirects:[{name:'fixture.js',aliases:[],contentType:'application/javascript',body:'window.__pearFixtureScriptlet=true;'}],scriptlets:[]});
 net.fetch=async(url)=>{
   if(url===subscription) return new Response('pear-blocker-fixture.test##.ad\\npear-blocker-fixture.test##+js(fixture)');
   if(String(url).endsWith('/ublock-origin/resources.json')) return new Response(resources);
   throw new Error('Unexpected fixture network request '+url);
 };
 const ipc=[];
 const handle=ipcMain.handle.bind(ipcMain);
 ipcMain.handle=(name,callback)=>handle(name,async(event,...args)=>{
   const result=await callback(event,...args);
   if(name.startsWith('@ghostery/adblocker/')) ipc.push({name,nativeSession:event.sender.session===native,facadeSession:event.sender.session===engineFacade,result:result??null});
   return result;
 });
 const win=new BrowserWindow({show:false,webPreferences:{session:native,preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 let config={enabled:true,blocker:'With blocklists',cache:false,additionalBlockLists:[],disableDefaultLists:false};
 const backend=createBlockerBackend('adblocker',async()=>[subscription]);
 const unowned=new BrowserWindow({show:false,webPreferences:{session:native,preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 let unownedLoads=0;unowned.webContents.on('did-finish-load',()=>unownedLoads++);
 await unowned.loadURL(fixtureURL);
 let loads=0;win.webContents.on('did-finish-load',()=>loads++);
 const phases=[];
 const observe=async(phase)=>{await new Promise(r=>setTimeout(r,220));phases.push({phase,loads,unownedLoads,url:win.webContents.getURL(),...(await win.webContents.executeJavaScript('({display:getComputedStyle(document.querySelector(".ad")).display,keep:getComputedStyle(document.querySelector(".keep")).color,scriptlet:window.__pearFixtureScriptlet===true,authorScript:window.__unsafeAuthorRan===true})'))});};
 await backend.start({getConfig:()=>config,window:win});
 await win.loadURL(fixtureURL);
 await observe('initial enabled');
 const ipcResponse=await win.webContents.executeJavaScript('window.fixture.invoke("@ghostery/adblocker/is-mutation-observer-enabled")');
 config={...config,blocker:'In player'};await backend.onConfigChange(config);
 await observe('initial disabled');
 await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});await observe('clean In player document');
 config={...config,blocker:'With blocklists'};await backend.onConfigChange(config);
 await observe('hot enabled');
 const failed=createBlockerBackend('failed-owner',async()=>['https://pear-blocker-subscription.test/offline']);
 await failed.start({getConfig:()=>config,window:win});await observe('failed startup');await failed.stop();
 await backend.onConfigChange(config);
 await observe('redundant settings');
 await provider.setSessionBlockLists(native,'absent-owner',null);
 await observe('absent owner disabled');
 config={...config,blocker:'In player'};await backend.onConfigChange(config);
 await observe('hot disabled');
 const raceWindow=new BrowserWindow({show:false,webPreferences:{session:session.fromPartition('pear-cosmetics-race'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
 const racingStart=backend.start({getConfig:()=>config,window:raceWindow});
 const racingStop=backend.stop();
 const raceErrors=(await Promise.allSettled([racingStart,racingStop])).filter(x=>x.status==='rejected').map(x=>String(x.reason));
 console.log('PEAR_COSMETICS '+JSON.stringify({phases,ipc,ipcResponse,fixtureURL,raceErrors}));
 raceWindow.destroy();
 win.destroy();unowned.destroy();app.quit();
})().catch(error=>{console.error(error);app.exit(1);});`;
    const entry = path.join(directory, 'entry.cjs');
    await writeFile(entry, script);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
      ],
      { cwd: directory, env, timeout: 25_000 },
    );
    const result = JSON.parse(
      stdout
        .split('\n')
        .find((line) => line.startsWith('PEAR_COSMETICS '))!
        .slice(15),
    );
    console.log(JSON.stringify(result));
    expect(result.ipcResponse).toBe(true);
    expect(result.raceErrors).toEqual([]);
    expect(result.ipc.length).toBeGreaterThan(0);
    expect(result.ipc.every((item) => item.nativeSession)).toBe(true);
    expect(result.ipc.every((item) => !item.facadeSession)).toBe(true);
    for (const phase of result.phases) {
      expect(phase.url).toBe(result.fixtureURL);
      expect(phase.keep).toBe('rgb(12, 34, 56)');
      expect(phase.authorScript).toBe(false);
      expect(phase.unownedLoads).toBe(1);
      const inactive =
        phase.phase === 'clean In player document' ||
        (phase.phase.includes('disabled') &&
          phase.phase !== 'absent owner disabled');
      expect(phase.display).toBe(inactive ? 'block' : 'none');
      expect(phase.scriptlet).toBe(!inactive);
    }
    const enabled = result.phases.find((item) => item.phase === 'hot enabled');
    expect(
      result.phases.find((item) => item.phase === 'initial enabled').loads,
    ).toBe(1);
    expect(
      result.phases.find((item) => item.phase === 'failed startup').loads,
    ).toBe(enabled.loads);
    expect(
      result.phases.find((item) => item.phase === 'redundant settings').loads,
    ).toBe(enabled.loads);
    expect(
      result.phases.find((item) => item.phase === 'absent owner disabled')
        .loads,
    ).toBe(enabled.loads);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
