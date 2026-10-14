import { test, expect } from '@playwright/test';
import { musicNative } from './helpers/api-music-native';

test('actual Electron raw sender physical tombstones reload and renderer loss preserve usable owned reads', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    let phase = 'initial';
    const bounded = <T>(label: string, operation: Promise<T>): Promise<T> =>
      f.bounded(phase + ':' + label, operation);
    const wait = async (check: () => Promise<boolean> | boolean) => {
      const end = Date.now() + 5000;
      while (!(await bounded('observation', Promise.resolve().then(check)))) {
        if (Date.now() >= end) throw Error('Missing native observation');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
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
      });
    const window = make(),
      foreign = make();
    await bounded('initial-load', window.loadFile(f.owned + '/main.html'));
    await bounded('foreign-load', foreign.loadFile(f.owned + '/child.html'));
    const evaluate = (code: string) =>
      bounded(
        'renderer-evaluation',
        window.webContents.executeJavaScript(code),
      );
    const setup = async () => {
      await evaluate(f.bundle);
      await evaluate(
        `window.held=[];window.fetches=[];window.nativeListeners={};window.nativeApi={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>1.2345,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,addEventListener:(name,fn)=>{window.nativeListeners[name]=fn},removeEventListener:()=>{}};document.querySelector('ytmusic-app').networkManager={fetch:(url,data)=>new Promise(resolve=>window.fetches.push({url,data,resolve}))};window.musicController=MusicNativeSource.createMusicRendererController(window.nativeApi,()=>window.nativeApi,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(packet.type==='ready')window.held.push(packet);else window.musicProof.send(channel,packet)}});undefined;`,
      );
    };
    phase = 'physical-dispatch';
    await setup();
    const broker = f.source.createMusicRequestBroker(window),
      controllers = Array.from({ length: 5 }, () => new AbortController());
    const calls = controllers.map((c, i) =>
      broker
        .read(
          broker.capture(),
          { operation: 'search', query: 'fixture' },
          'p' + i,
          { signal: c.signal },
        )
        .catch((e: any) => e.code),
    );
    await wait(async () => await evaluate('window.held.length===4'));
    const query = await evaluate('window.held[0]');
    await bounded(
      'foreign-reply',
      foreign.webContents.executeJavaScript(
        `window.musicProof.send('peard:music-reply',${JSON.stringify(query)})`,
      ),
    );
    const child = window.webContents.mainFrame.frames[0];
    await bounded(
      'child-reply',
      child.executeJavaScript(
        `window.musicProof.send('peard:music-reply',${JSON.stringify(query)})`,
      ),
    );
    const beforeValid = await evaluate('window.fetches.length');
    await evaluate(
      `for(const packet of window.held.splice(0))window.musicProof.send('peard:music-reply',packet)`,
    );
    await wait(async () => await evaluate('window.fetches.length===4'));
    phase = 'physical-cancel';
    controllers[0].abort();
    const canceled = await bounded('aborted-call-retired', calls[0]),
      physicalAfterCancel = broker.stats().dispatched,
      nativeAfterCancel = await evaluate('window.fetches.length');
    await evaluate(
      `window.fetches[0].resolve({contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[{musicPlaylistShelfRenderer:{contents:[]}}]}}}}]}}})`,
    );
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.musicProof.send('peard:music-reply',window.held.shift())`,
    );
    await wait(async () => await evaluate('window.fetches.length===5'));
    phase = 'same-frame-navigation';
    const frame = window.webContents.mainFrame;
    await bounded('same-frame-reload', window.loadFile(f.owned + '/main.html'));
    const reusedFrame = frame === window.webContents.mainFrame;
    await bounded('old-calls-retired', Promise.all(calls));
    const afterReload = broker.stats().dispatched;
    await setup();
    phase = 'late-old-reply';
    const snapshotPromise = broker.read(
      broker.capture(),
      { operation: 'current' },
      'current',
    );
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.musicProof.send('peard:music-reply',${JSON.stringify({ ...query, type: 'settled', result: { ok: true, value: { version: 1, items: [], shelves: [], continuation: null, targetRecipes: [] } } })})`,
    );
    const afterLateOld = broker.stats().dispatched;
    await evaluate(
      `window.musicProof.send('peard:music-reply',window.held.shift())`,
    );
    const snapshot = await bounded('snapshot-settled', snapshotPromise);
    phase = 'renderer-loss';
    const crashPromise = broker
      .read(
        broker.capture(),
        { operation: 'search', query: 'fixture' },
        'crash',
      )
      .catch((e: any) => e.code);
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.musicProof.send('peard:music-reply',window.held.shift())`,
    );
    await wait(async () => await evaluate('window.fetches.length===1'));
    const rendererPid = window.webContents.getOSProcessId();
    const ownedRenderer = f.app
      .getAppMetrics()
      .find((entry: any) => entry.pid === rendererPid && entry.type === 'Tab');
    if (
      !Number.isInteger(rendererPid) ||
      rendererPid <= 0 ||
      rendererPid === process.pid ||
      !ownedRenderer
    )
      throw Error('Missing distinct owned native renderer process');
    const gone = new Promise<{ reason: string }>((resolve) =>
      window.webContents.once(
        'render-process-gone',
        (_event: any, details: any) => resolve({ reason: details.reason }),
      ),
    );
    // The Linux runner did not emit terminal evidence after force-crashing.
    // Terminate only this verified owned renderer; Electron must still deliver
    // its actual terminal process event below.
    if (process.platform === 'linux') process.kill(rendererPid, 'SIGKILL');
    else window.webContents.forcefullyCrashRenderer();
    const termination = await bounded('renderer-gone', gone);
    if (
      process.platform === 'linux'
        ? termination.reason !== 'killed'
        : !['crashed', 'killed'].includes(termination.reason)
    )
      throw Error(
        'Unexpected native renderer termination: ' + termination.reason,
      );
    const crashResult = await bounded('crash-call-retired', crashPromise),
      afterCrash = broker.stats().dispatched;
    phase = 'renderer-recovery';
    await bounded(
      'crashed-renderer-reload',
      window.loadFile(f.owned + '/main.html'),
    );
    const replacementRendererPid = window.webContents.getOSProcessId();
    if (
      !Number.isInteger(replacementRendererPid) ||
      replacementRendererPid <= 0 ||
      replacementRendererPid === rendererPid ||
      replacementRendererPid === process.pid
    )
      throw Error('Missing replacement native renderer process');
    await setup();
    phase = 'recovered-read';
    const after = broker.read(
      broker.capture(),
      { operation: 'current' },
      'reload',
    );
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.musicProof.send('peard:music-reply',window.held.shift())`,
    );
    const reloaded = await bounded('recovered-read-settled', after);
    broker.dispose();
    return {
      beforeValid,
      canceled,
      physicalAfterCancel,
      nativeAfterCancel,
      afterReload,
      reusedFrame,
      afterLateOld,
      snapshot: { id: snapshot.current.id, ms: snapshot.elapsedMilliseconds },
      crashResult,
      afterCrash,
      termination: termination.reason,
      distinctRenderer: replacementRendererPid !== rendererPid,
      reloaded: reloaded.current.id,
    };
  });
  expect(result).toMatchObject({
    beforeValid: 0,
    canceled: 'retired',
    physicalAfterCancel: 4,
    nativeAfterCancel: 4,
    afterReload: 0,
    reusedFrame: true,
    afterLateOld: 1,
    snapshot: { id: 'current0001', ms: 1234.5 },
    crashResult: 'retired',
    afterCrash: 0,
    termination:
      process.platform === 'linux'
        ? 'killed'
        : expect.stringMatching(/^(crashed|killed)$/),
    distinctRenderer: true,
    reloaded: 'current0001',
  });
});

test('actual backend native grant editor private ledger renderer and REST deliver current and100+51 pages end to end', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const http = require('node:http'),
      fs = require('node:fs'),
      path = require('node:path');
    const reserve = http.createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise<void>((r) => reserve.close(r));
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    await window.webContents.executeJavaScript(f.bundle);
    await window.webContents.executeJavaScript(
      `window.musicPackets=[];window.nativeFetches=0;window.nativeApi={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>1.2345,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,addEventListener:()=>{},removeEventListener:()=>{}};const rows=Array.from({length:151},(_,i)=>({musicResponsiveListItemRenderer:{playlistItemData:{videoId:'v'+String(i).padStart(10,'0')},flexColumns:[{musicResponsiveListItemFlexColumnRenderer:{text:{runs:[{text:'Fixture '+i}]}}}]}}));document.querySelector('ytmusic-app').networkManager={fetch:async(url,data)=>{window.nativeFetches++;return{contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[{musicPlaylistShelfRenderer:{contents:rows}}]}}}}]}}}}};window.controller=MusicNativeSource.createMusicRendererController(window.nativeApi,()=>window.nativeApi,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{window.musicPackets.push(packet);window.musicProof.send(channel,packet)}});undefined;`,
    );
    let config = {
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
    };
    const listeners: any[] = [];
    const context = {
      window,
      getConfig: () => config,
      setConfig: (partial: any) => {
        config = { ...config, ...partial };
        f.source.backend.onConfigChange(config);
      },
      ipc: {
        send: (...args: any[]) => window.webContents.send(...args),
        on: (channel: string, fn: any) => {
          const h = (_e: any, ...args: any[]) => fn(...args);
          listeners.push([channel, h]);
          f.ipcMain.on(channel, h);
        },
        handle: (channel: string, fn: any) => f.ipcMain.handle(channel, fn),
        removeHandler: (channel: string) => f.ipcMain.removeHandler(channel),
      },
    };
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const choices = [0, 1, 2, 0],
      dialogs: any[] = [];
    let token: string | undefined;
    const menu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => f.source.getMusicService(window),
      {
        prompt: async () => 'Native socket client',
        show: async (options: any) => {
          dialogs.push(options);
          return { response: choices.shift() };
        },
        copy: (value: string) => (token = value),
      },
    );
    await menu
      .find((item: any) => item.label === 'Create client grant…')
      .click();
    if (!token) throw Error('Missing native explicit copy');
    const request = (
      target: string,
      method = 'GET',
      body?: any,
      credential?: string,
    ) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: target,
            method,
            headers: {
              host: '127.0.0.1:' + port,
              ...(credential ? { authorization: 'Bearer ' + credential } : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
          },
          (res: any) => {
            let text = '';
            res.on('data', (chunk: any) => (text += chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: text ? JSON.parse(text) : null,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const denied = await request('/api/v1/music/current'),
      legacy = await request('/api/v1/song');
    const current = await request(
      '/api/v1/music/current',
      'GET',
      undefined,
      token,
    );
    const first = await request(
        '/api/v1/music/search',
        'POST',
        { query: 'fixture', limit: 100 },
        token,
      ),
      second = await request(
        '/api/v1/music/search',
        'POST',
        { cursor: first.body.nextCursor, limit: 100 },
        token,
      ),
      replay = await request(
        '/api/v1/music/search',
        'POST',
        { cursor: first.body.nextCursor, limit: 100 },
        token,
      );
    const service = f.source.getMusicService(window),
      records = await service.grants.list(),
      ledger = fs.readFileSync(
        path.join(f.owned, 'userData', 'music-client-grants', 'grants.json'),
        'utf8',
      );
    const packets = await window.webContents.executeJavaScript(
      'JSON.stringify(window.musicPackets)',
    );
    const fetchCount = await window.webContents.executeJavaScript(
      'window.nativeFetches',
    );
    await service.grants.revoke(records[0].id, () => true);
    const revoked = await request(
      '/api/v1/music/current',
      'GET',
      undefined,
      token,
    );
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    return {
      denied: denied.status,
      legacy: legacy.status,
      legacyCors: legacy.headers['access-control-allow-origin'],
      current: current.status,
      id: current.body.current.id,
      ms: current.body.elapsedMilliseconds,
      counts: [first.body.items.length, second.body.items.length],
      replaySame: JSON.stringify(replay.body) === JSON.stringify(second.body),
      fetchCount,
      scopes: records[0].scopes,
      ledgerBearer: ledger.includes(token),
      rendererBearer: packets.includes(token),
      dialogBearer: JSON.stringify(dialogs).includes(token),
      newCors: current.headers['access-control-allow-origin'] ?? null,
      revoked: revoked.status,
    };
  });
  expect(result).toEqual({
    denied: 401,
    legacy: 204,
    legacyCors: '*',
    current: 200,
    id: 'current0001',
    ms: 1234.5,
    counts: [100, 51],
    replaySame: true,
    fetchCount: 1,
    scopes: ['playback.read', 'catalog.read'],
    ledgerBearer: false,
    rendererBearer: false,
    dialogBearer: false,
    newCors: null,
    revoked: 401,
  });
});

test('actual API restart retains four native tombstones then last settlement and stop clean only owned pool hooks', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof,
      http = require('node:http');
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > end) throw Error('Missing owned restart witness');
        await new Promise((r) => setTimeout(r, 2));
      }
    };
    const reserve = http.createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise<void>((r) => reserve.close(r));
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    const frame = window.webContents.mainFrame;
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(
      `window.fetches=[];window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001',title:'Owned current',author:'Owned artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>2.125,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,addEventListener:()=>{},removeEventListener:()=>{}};document.querySelector('ytmusic-app').networkManager={fetch:(url,data)=>new Promise(resolve=>window.fetches.push({url,data,resolve}))};window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,window.musicProof);undefined;`,
    );
    const foreign = () => {};
    f.ipcMain.on('peard:music-reply', foreign);
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
    };
    const listeners: any[] = [],
      context = {
        window,
        getConfig: () => config,
        setConfig() {},
        ipc: {
          send: (...args: any[]) => window.webContents.send(...args),
          on: (channel: string, fn: any) => {
            const h = (_e: any, ...args: any[]) => fn(...args);
            listeners.push([channel, h]);
            f.ipcMain.on(channel, h);
          },
          handle: (channel: string, fn: any) => f.ipcMain.handle(channel, fn),
          removeHandler: (channel: string) => f.ipcMain.removeHandler(channel),
        },
      };
    const start = async () => {
      await f.source.backend.start(context);
      if (!f.source.backend.server.listening)
        await new Promise<void>((r) =>
          f.source.backend.server.once('listening', r),
        );
    };
    const stop = async () => {
      const server = f.source.backend.server,
        closed = new Promise<void>((r) => server.once('close', r));
      f.source.backend.stop();
      await closed;
    };
    await start();
    const service = f.source.getMusicService(window),
      grants = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          service.grants.issue(
            'Owned ' + i,
            'rest',
            service.resource,
            ['catalog.read', 'playback.read'],
            () => true,
          ),
        ),
      );
    const request = (token: string, current = false) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            agent: false,
            path: '/api/v1/music/' + (current ? 'current' : 'search'),
            method: current ? 'GET' : 'POST',
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + token,
              ...(current ? {} : { 'content-type': 'application/json' }),
            },
          },
          (res: any) => {
            let text = '';
            res.on('data', (chunk: any) => (text += chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                body: text ? JSON.parse(text) : null,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(current ? undefined : '{"query":"fixture"}');
      });
    const old = grants.map((grant: any) => request(grant.token));
    await wait(async () => await evaluate('window.fetches.length===4'));
    const original = f.source.createMusicRequestBroker(window);
    await stop();
    const retiredStatuses = (await Promise.all(old)).map((r: any) => r.status),
      retainedSlots = original.stats().dispatched;
    await start();
    const reused = f.source.createMusicRequestBroker(window) === original,
      next = request(grants[0].token);
    await wait(() => original.stats().queued === 1);
    const beforeSettlement = await evaluate('window.fetches.length');
    const empty = `{contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[{musicPlaylistShelfRenderer:{contents:[]}}]}}}}]}}}`;
    await evaluate(`window.fetches[0].resolve(${empty})`);
    await wait(async () => await evaluate('window.fetches.length===5'));
    const afterSettlement = await evaluate('window.fetches.length');
    await evaluate(`window.fetches[4].resolve(${empty})`);
    const nextResult = await next;
    for (let i = 1; i < 4; i++)
      await evaluate(`window.fetches[${i}].resolve(${empty})`);
    await wait(() => original.stats().dispatched === 0);
    await stop();
    const afterQuiescentStop = f.ipcMain.listenerCount('peard:music-reply'),
      foreignPreserved =
        f.ipcMain.listeners('peard:music-reply')[0] === foreign;
    await start();
    const reacquired = f.source.createMusicRequestBroker(window) !== original,
      current = await request(grants[0].token, true),
      finalFetches = await evaluate('window.fetches.length');
    await stop();
    for (const [channel, handler] of listeners)
      f.ipcMain.removeListener(channel, handler);
    f.ipcMain.removeListener('peard:music-reply', foreign);
    return {
      retiredStatuses,
      retainedSlots,
      reused,
      beforeSettlement,
      afterSettlement,
      nextStatus: nextResult.status,
      afterQuiescentStop,
      foreignPreserved,
      reacquired,
      sameFrame: window.webContents.mainFrame === frame,
      current: current.body.current.id,
      ms: current.body.elapsedMilliseconds,
      finalFetches,
    };
  });
  expect(result).toEqual({
    retiredStatuses: [409, 409, 409, 409],
    retainedSlots: 4,
    reused: true,
    beforeSettlement: 4,
    afterSettlement: 5,
    nextStatus: 200,
    afterQuiescentStop: 1,
    foreignPreserved: true,
    reacquired: true,
    sameFrame: true,
    current: 'current0001',
    ms: 2125,
    finalFetches: 5,
  });
});

test('actual startup honors newer disabled capability config instead of a stale asynchronous enabled snapshot', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof,
      http = require('node:http');
    const reserve = http.createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise<void>((r) => reserve.close(r));
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    const oldConfig = {
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
      latest = { ...oldConfig, musicApiEnabled: false };
    let release: (() => void) | undefined,
      waiting = true;
    const listeners: any[] = [];
    const context = {
      window,
      getConfig: () =>
        waiting
          ? new Promise(
              (r) =>
                (release = () => {
                  waiting = false;
                  r(oldConfig);
                }),
            )
          : latest,
      setConfig() {},
      ipc: {
        send: (...args: any[]) => window.webContents.send(...args),
        on: (channel: string, fn: any) => {
          const h = (_e: any, ...args: any[]) => fn(...args);
          listeners.push([channel, h]);
          f.ipcMain.on(channel, h);
        },
        handle: (channel: string, fn: any) => f.ipcMain.handle(channel, fn),
        removeHandler: (channel: string) => f.ipcMain.removeHandler(channel),
      },
    };
    const pending = f.source.backend.start(context);
    f.source.backend.onConfigChange(latest);
    release!();
    await pending;
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const enabled = !!f.source.getMusicService(window),
      nativeFlag = f.source.backend.musicConfig.musicApiEnabled,
      ledgerCreated = !!f.source.backend.musicGrants;
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    return { enabled, nativeFlag, ledgerCreated };
  });
  expect(result).toEqual({
    enabled: false,
    nativeFlag: false,
    ledgerCreated: false,
  });
});

for (const mode of ['abort', 'deadline', 'service-reconfig'] as const)
  test(`actual native ${mode} before ready ACK retires twelve leases and preserves the same controller`, async () => {
    const previous = process.env.PEAR_HANDSHAKE_NATIVE_MODE;
    process.env.PEAR_HANDSHAKE_NATIVE_MODE = mode;
    try {
      const result = await musicNative(async () => {
        const f = (globalThis as any).MusicNativeProof;
        const mode = process.env.PEAR_HANDSHAKE_NATIVE_MODE;
        if (!['abort', 'deadline', 'service-reconfig'].includes(mode!))
          throw Error('Invalid owned handshake mode');
        const window = new f.BrowserWindow({
          show: false,
          webPreferences: {
            preload: f.preload,
            contextIsolation: true,
            sandbox: true,
          },
        });
        await window.loadFile(f.owned + '/main.html');
        const evaluate = (code: string) =>
          window.webContents.executeJavaScript(code);
        const wait = async (check: () => boolean | Promise<boolean>) => {
          const end = Date.now() + 5000;
          while (!(await check())) {
            if (Date.now() >= end)
              throw Error('Missing owned pre-ACK observation');
            await new Promise((r) => setTimeout(r, 5));
          }
        };
        await evaluate(f.bundle);
        await evaluate(
          `window.readyPackets=[];window.holdReady=true;window.readDeliveries=0;window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>1.25,getDuration:()=>100,getVolume:()=>50,getPlayerState:()=>2,addEventListener:()=>{},removeEventListener:()=>{}};document.querySelector('ytmusic-app').networkManager={fetch:async()=>{throw Error('Current must not fetch')}};window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:(channel,callback)=>window.musicProof.subscribe(channel,packet=>{if(channel==='peard:music-read')window.readDeliveries++;callback(packet);}),send:(channel,packet)=>{if(packet.type==='ready'){window.readyPackets.push(packet);if(window.holdReady)return;}window.musicProof.send(channel,packet)}});window.originalController=window.controller;undefined;`,
        );
        const broker = f.source.createMusicRequestBroker(window);
        let observed = 0;
        const observer = (_event: any, packet: any) => {
          if (packet.type === 'ready') observed++;
        };
        f.ipcMain.on('peard:music-reply', observer);
        let config: any, token: string | undefined;
        const listeners: any[] = [];
        if (mode === 'service-reconfig') {
          const http = require('node:http'),
            reserve = http.createServer();
          await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
          const port = reserve.address().port;
          await new Promise<void>((r) => reserve.close(r));
          config = {
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
          };
          const context = {
            window,
            getConfig: () => config,
            setConfig() {},
            ipc: {
              send: (...args: any[]) => window.webContents.send(...args),
              on: (name: string, callback: any) => {
                const fn = (_e: any, ...args: any[]) => callback(...args);
                listeners.push([name, fn]);
                f.ipcMain.on(name, fn);
              },
              handle: (name: string, callback: any) =>
                f.ipcMain.handle(name, callback),
              removeHandler: (name: string) => f.ipcMain.removeHandler(name),
            },
          };
          await f.source.backend.start(context);
          if (!f.source.backend.server.listening)
            await new Promise<void>((r) =>
              f.source.backend.server.once('listening', r),
            );
          const service = f.source.getMusicService(window),
            issued = await service.grants.issue(
              'Owned pre-ACK',
              'rest',
              service.resource,
              ['playback.read'],
              () => true,
            );
          token = issued.token;
        }
        const canceled: string[] = [];
        for (let i = 0; i < 12; i++) {
          const control = new AbortController();
          const pending = (
            mode === 'service-reconfig'
              ? f.source.getMusicService(window).current(token)
              : broker.read(
                  broker.capture(),
                  { operation: 'current' },
                  'native-owner',
                  {
                    signal: control.signal,
                    ...(mode === 'deadline'
                      ? { deadline: Date.now() + 100 }
                      : {}),
                  },
                )
          ).then(
            () => 'success',
            (e: any) => e.code,
          );
          await wait(
            async () =>
              (await evaluate('window.readyPackets.length')) === i + 1,
          );
          if (mode === 'abort') control.abort();
          else if (mode === 'service-reconfig')
            f.source.backend.onConfigChange({ ...config });
          canceled.push(await pending);
          await evaluate(
            `window.musicProof.send('peard:music-reply',window.readyPackets[${i}]);undefined;`,
          );
          await wait(() => observed === i + 1);
        }
        const afterCancel = broker.stats(),
          beforeHealthy = await evaluate('window.readDeliveries');
        await evaluate('window.holdReady=false;undefined;');
        const healthy = await (
          mode === 'service-reconfig'
            ? f.source.getMusicService(window).current(token)
            : broker.read(
                broker.capture(),
                { operation: 'current' },
                'healthy',
                { deadline: Date.now() + 1000 },
              )
        ).then(
          (value: any) => ({ code: 'success', elapsed: value.elapsedSeconds }),
          (e: any) => ({ code: e.code }),
        );
        const native = await evaluate(
          '({sameController:window.controller===window.originalController,ready:window.readyPackets.length,readDeliveries:window.readDeliveries})',
        );
        if (mode === 'service-reconfig') {
          const server = f.source.backend.server,
            closed = new Promise<void>((r) => server.once('close', r));
          f.source.backend.stop();
          await closed;
          for (const [name, fn] of listeners)
            f.ipcMain.removeListener(name, fn);
        }
        broker.dispose();
        f.ipcMain.removeListener('peard:music-reply', observer);
        window.destroy();
        return { canceled, afterCancel, beforeHealthy, healthy, native };
      });
      expect(result).toEqual({
        canceled: Array(12).fill(mode === 'deadline' ? 'timeout' : 'retired'),
        afterCancel: { dispatched: 0, queued: 0 },
        beforeHealthy: 0,
        healthy: { code: 'success', elapsed: 1.25 },
        native: { sameController: true, ready: 13, readDeliveries: 1 },
      });
    } finally {
      if (previous === undefined) delete process.env.PEAR_HANDSHAKE_NATIVE_MODE;
      else process.env.PEAR_HANDSHAKE_NATIVE_MODE = previous;
    }
  });

// N1 append-only actual physical ownership proof; original native tests above stay byte-identical.
test('N1 actual late authenticated ACK and committed/process/window termination notify physical settlement once', async () => {
  const proof = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const make = () =>
      new f.BrowserWindow({
        show: false,
        webPreferences: {
          preload: f.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegrationInSubFrames: true,
        },
      });
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end)
          throw Error('Missing N1 native physical observation');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const anchor = make();
    const results: any[] = [];
    for (const mode of ['late-ack', 'committed', 'process', 'window']) {
      const window = make();
      await window.loadFile(f.owned + '/main.html');
      const evaluate = (code: string) =>
        window.webContents.executeJavaScript(code);
      await evaluate(f.bundle);
      await evaluate(
        `window.replies=[];window.events=0;window.api={getVideoData:()=>({video_id:'seedVideo01'}),getPlayerResponse:()=>({videoDetails:{videoId:'seedVideo01'}}),addEventListener(){},removeEventListener(){}};const app=document.querySelector('ytmusic-app');app.networkManager={fetch:()=>new Promise(()=>{})};app.addEventListener('yt-navigate',()=>window.events++);window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(packet.type==='settled')window.replies.push(packet);else window.musicProof.send(channel,packet)}});undefined;`,
      );
      const broker = f.source.createMusicRequestBroker(window),
        controller = new AbortController(),
        notices: any[] = [];
      const p = broker
        .read(
          broker.capture(),
          {
            operation: 'navigate',
            command: { action: 'play_song', videoId: 'seedVideo01' },
            deadlineAt: Date.now() + 10000,
          },
          'n1',
          {
            signal: controller.signal,
            deadline: mode === 'late-ack' ? Date.now() + 60 : undefined,
            onPhysicalSettled: (reason: string) =>
              notices.push({ reason, slots: broker.stats().dispatched }),
          },
        )
        .catch((e: any) => e.code);
      await wait(async () => await evaluate('window.replies.length===1'));
      const packet = await evaluate('window.replies[0]'),
        dispatches = await evaluate('window.events');
      // A logical cancellation or source retirement never certifies physical completion.
      if (mode !== 'late-ack') controller.abort();
      const logical = await p;
      const before = {
        notices: notices.length,
        slots: broker.stats().dispatched,
      };
      if (mode === 'late-ack') {
        const foreign = make();
        await foreign.loadFile(f.owned + '/child.html');
        await foreign.webContents.executeJavaScript(
          `window.musicProof.send('peard:music-reply',${JSON.stringify(packet)})`,
        );
        const child = window.webContents.mainFrame.frames[0];
        await child.executeJavaScript(
          `window.musicProof.send('peard:music-reply',${JSON.stringify(packet)})`,
        );
        for (const patch of [
          { nonce: 'f'.repeat(32) },
          { documentId: 'f'.repeat(32) },
          { sourceId: 'f'.repeat(32) },
          { requestId: '00000000-0000-4000-8000-000000000000' },
        ])
          await evaluate(
            `window.musicProof.send('peard:music-reply',${JSON.stringify({ ...packet, ...patch })})`,
          );
        await new Promise((r) => setTimeout(r, 20));
        const afterWrong = {
          notices: notices.length,
          slots: broker.stats().dispatched,
        };
        await evaluate(
          `window.musicProof.send('peard:music-reply',${JSON.stringify(packet)});window.musicProof.send('peard:music-reply',${JSON.stringify(packet)})`,
        );
        await wait(() => notices.length === 1);
        results.push({
          mode,
          logical,
          dispatches,
          before,
          afterWrong,
          notices,
        });
        foreign.destroy();
      } else {
        if (mode === 'committed') await window.loadFile(f.owned + '/main.html');
        else if (mode === 'process') {
          window.webContents.forcefullyCrashRenderer();
          await wait(() => notices.length === 1);
        } else window.destroy();
        await wait(() => notices.length === 1);
        results.push({ mode, logical, dispatches, before, notices });
      }
      if (!window.isDestroyed()) window.destroy();
      broker.dispose();
    }
    anchor.destroy();
    return results;
  });
  expect(proof).toHaveLength(4);
  for (const row of proof) {
    expect(row.dispatches).toBe(1);
    expect(row.before).toEqual({ notices: 0, slots: 1 });
    expect(row.notices).toEqual([
      {
        reason:
          row.mode === 'late-ack'
            ? 'authenticated_ack'
            : 'authoritative_termination',
        slots: 0,
      },
    ]);
    if (row.mode === 'late-ack') {
      expect(row.logical).toBe('timeout');
      expect(row.afterWrong).toEqual(row.before);
    } else expect(row.logical).toBe('retired');
  }
  console.log('N1_PHYSICAL_NATIVE_PROOF ' + JSON.stringify(proof));
});
