import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));

test('real media automatically restores pause/position through a correlated main-frame guard', async () => {
  test.setTimeout(30_000);
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pear-scene-native-test-'),
  );
  try {
    for (const file of await readdir(path.join(root, 'src/providers'))) {
      if (!/^blocker-(documents|scene.*)\.ts$/.test(file)) continue;
      const source = stripTypeScriptTypes(
        await readFile(path.join(root, 'src/providers', file), 'utf8'),
      ).replace(
        /(['"])(\.\/blocker-[^'"]+)\1/g,
        (_, quote, name) => `${quote}${name}.mjs${quote}`,
      );
      await writeFile(
        path.join(directory, file.replace('.ts', '.mjs')),
        source,
      );
    }
    const guardSource = stripTypeScriptTypes(
      await readFile(
        path.join(root, 'src/providers/blocker-scene-preload.ts'),
        'utf8',
      ),
    )
      .replace(
        /import\s*\{([\s\S]*?)\}\s*from 'electron';/,
        'const {$1}=require("electron");',
      )
      .replace(
        'export const installBlockerSceneGuard',
        'const installBlockerSceneGuard',
      );
    await writeFile(
      path.join(directory, 'preload.cjs'),
      guardSource + '\ninstallBlockerSceneGuard();',
    );
    const script = `
const {app,BrowserWindow,session,ipcMain}=require('electron');
(async()=>{
 const fs=require("node:fs"),path=require("node:path");
 const ownedRoot=${JSON.stringify(directory)};
 for(const key of ["userData","sessionData"]){const owned=path.join(ownedRoot,key);fs.mkdirSync(owned,{recursive:true});if(!fs.realpathSync(owned).startsWith(fs.realpathSync(ownedRoot)+path.sep))throw Error("Unowned Electron profile");app.setPath(key,owned);}
 await app.whenReady();
 const main=await import('./blocker-scene-main.mjs');main.installBlockerSceneBridge();
 const docs=await import('./blocker-documents.mjs');
 const native=session.fromPartition('scene-native-fixture');
 const wave=Buffer.alloc(44+8000*30*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
 native.protocol.handle('https',request=>{if(request.url.includes('tone.wav')){const range=request.headers.get('range');const start=Number(range?.match(/bytes=(\d+)-/)?.[1]??0);const body=wave.subarray(start);return new Response(body,{status:range?206:200,headers:{'Content-Type':'audio/wav','Content-Length':String(body.length),'Accept-Ranges':'bytes',...(range?{'Content-Range':'bytes '+start+'-'+(wave.length-1)+'/'+wave.length}:{})}})}return new Response('<html><style>.keep{color:rgb(12,34,56)}</style><video autoplay src="https://scene.test/tone.wav"></video><div class="keep">keep</div></html>',{headers:{'Content-Type':'text/html'}})});
 const win=new BrowserWindow({show:false,webPreferences:{session:native,preload:${JSON.stringify(path.join(directory, 'preload.cjs'))},sandbox:false,contextIsolation:true,nodeIntegration:false,autoplayPolicy:'no-user-gesture-required'}});
 docs.setBlockerDocument(native,'ads',win.webContents);
 const releasePackets=[];const send=win.webContents.send.bind(win.webContents);win.webContents.send=(ch,...args)=>{if(ch==='peard:blocker-scene-release')releasePackets.push({muted:args[1],reason:args[2]});return send(ch,...args)};
 let loads=0;win.webContents.on('did-finish-load',()=>loads++);
 const get=code=>win.webContents.executeJavaScript(code,true);
 const wait=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('fixture readiness');};
 await win.loadURL('https://scene.test/player?kept=1#position');
 await wait(()=>get('document.querySelector("video").readyState>=2'));
 await get('document.querySelector("video").currentTime=18;document.querySelector("video").pause()');
 let initial;
 await wait(async()=>{const snapshot=await get('({time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused,seeking:document.querySelector("video").seeking})');const settled=snapshot.paused&&!snapshot.seeking&&initial?.time===snapshot.time;initial=snapshot;return settled;});
 docs.reloadBlockerDocuments(native);
 await wait(async()=>loads===2);await wait(async()=>main.getBlockerDocumentStatus(win.webContents).kind==='verified');
 const preserved=await get('({time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused})');
 await wait(()=>get('!blockerSceneGuard.pending()'));const beforeLoads=loads;
 console.log('SCENE_AUTO '+JSON.stringify({status:main.getBlockerDocumentStatus(win.webContents),loads,preserved}));
 const explicit=await main.applyPendingBlockerDocument(win.webContents);
 const restored=await get('({time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused,muted:document.querySelector("video").muted,guard:blockerSceneGuard.pending(),keep:getComputedStyle(document.querySelector(".keep")).color})');
 await get('document.querySelector("video").play()');
 docs.reloadBlockerDocuments(native);await wait(async()=>loads===3);await wait(async()=>main.getBlockerDocumentStatus(win.webContents).kind==='verified');await wait(()=>get('!blockerSceneGuard.pending()'));
 const playing=await main.applyPendingBlockerDocument(win.webContents);
 const resumed=await get('({time:document.querySelector("video").currentTime,paused:document.querySelector("video").paused,guard:blockerSceneGuard.pending()})');
 console.log('PEAR_NATIVE '+JSON.stringify({initial,preserved,beforeLoads,explicit,restored,playing,resumed,loads,url:win.webContents.getURL(),nativeMute:win.webContents.isAudioMuted(),releasePackets}));
 win.destroy();app.quit();
})().catch(error=>{console.error(error);app.exit(1)});`;
    const entry = path.join(directory, 'entry.cjs');
    await writeFile(entry, script);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const execution = promisify(execFile)(
      require('electron') as string,
      [
        entry,
        `--user-data-dir=${path.join(directory, 'profile')}`,
        '--no-sandbox',
      ],
      {
        cwd: directory,
        env,
        timeout: 25_000,
        detached: process.platform !== 'win32',
      },
    );
    let stdout: string;
    try {
      ({ stdout } = await execution);
    } finally {
      const pid = execution.child.pid;
      if (pid && process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    const result = JSON.parse(
      stdout
        .split('\n')
        .find((line) => line.startsWith('PEAR_NATIVE '))!
        .slice(12),
    );
    console.log(JSON.stringify(result));
    expect(result.beforeLoads).toBe(2);
    // Native seek/pause may settle past the requested time. Preserve the actual
    // pre-reload position with the existing tolerance, rather than the request.
    expect(result.initial.paused).toBe(true);
    expect(result.initial.time).toBeGreaterThan(0);
    expect(result.preserved.paused).toBe(true);
    expect(result.preserved.time).toBeCloseTo(result.initial.time, 1);
    expect(result.explicit.kind).toBe('verified');
    expect(result.restored.paused).toBe(true);
    expect(result.restored.time).toBeCloseTo(result.initial.time, 1);
    expect(result.restored.guard).toBe(false);
    expect(result.restored.muted).toBe(false);
    expect(result.restored.keep).toBe('rgb(12, 34, 56)');
    expect(result.playing.kind).toBe('verified');
    expect(result.resumed.paused).toBe(false);
    expect(result.resumed.time).toBeGreaterThanOrEqual(result.initial.time);
    expect(result.resumed.time).toBeLessThan(result.initial.time + 1);
    expect(result.resumed.guard).toBe(false);
    expect(result.nativeMute).toBe(false);
    expect(result.url).toBe('https://scene.test/player?kept=1#position');
    expect(result.loads).toBe(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
