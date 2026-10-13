import { test, expect } from '@playwright/test';

import { legacyClockNative } from './helpers/api-legacy-clock';

test('actual legacy-only Electron metadata and HTTP precision reject stale playback and reload ownership', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on(
      'console-message',
      (_event: unknown, _level: unknown, message: string) =>
        console.error('Owned renderer: ' + message),
    );
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(
        code.includes('await ') ? '(async()=>{' + code + '})()' : code,
      );
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end) throw Error('Missing owned observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const config = {
      enabled: true,
      musicApiEnabled: false,
      hostname: '127.0.0.1',
      port: 0,
      authStrategy: 'NONE',
      secret: 'owned fixture',
      authorizedClients: [],
      useHttps: false,
      certPath: '',
      keyPath: '',
    };
    const backend = f.source.backend;
    f.source.setupSongInfo(window);
    await backend.start({
      window,
      ipc: { on: () => {}, send: () => {} },
      getConfig: () => config,
    });
    await wait(() => !!backend.server.address());
    const address = backend.server.address();
    const read = async (alias = 'song') => {
      const response = await fetch(
        'http://127.0.0.1:' + address.port + '/api/v1/' + alias,
      );
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    };
    const setup = async () => {
      await evaluate(
        `window.ipcRenderer={send:window.musicProof.send,on:(channel,fn)=>window.musicProof.subscribe(channel,(...args)=>fn({},...args))};window.polls=0;window.expandedReplies=0;window.intervalOriginal=window.setInterval;window.setInterval=(...args)=>{window.polls++;return window.intervalOriginal(...args)};undefined;`,
      );
      await window.webContents.executeJavaScript(f.bundle);
      await evaluate(
        `window.heldSettlements=[];window.cancelPackets=[];window.holdSettlements=false;window.nativeListeners={};window.nativeId='current0001';window.nativeSeconds=1.2345;window.nativeApi={getVideoData:()=>({video_id:window.nativeId}),getPlayerResponse:()=>({videoDetails:{videoId:window.nativeId,title:'Owned metadata',author:'Owned artist',viewCount:'0',lengthSeconds:'30',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>window.nativeSeconds,getDuration:()=>30,getVolume:()=>50,getPlayerState:()=>1,getWatchNextResponse:()=>({}),addEventListener:(name,fn)=>(window.nativeListeners[name]??=[]).push(fn),removeEventListener:(name,fn)=>{window.nativeListeners[name]=(window.nativeListeners[name]??[]).filter(item=>item!==fn)}};window.emitNative=(name,id=window.nativeId)=>{window.nativeId=id;for(const fn of [...(window.nativeListeners.videodatachange??[])])fn(name,{videoId:id})};window.ctx={getConfig:()=>(${JSON.stringify(config)}),ipc:{subscribe:(channel,fn)=>window.musicProof.subscribe(channel,packet=>{if(channel==='peard:legacy-clock-cancel')window.cancelPackets.push(packet);fn(packet)}),send:(channel,...args)=>{if(channel==='peard:music-reply')window.expandedReplies++;if(window.holdSettlements&&channel==='peard:legacy-clock-reply'&&args[0].type==='settled')window.heldSettlements.push(args[0]);else window.musicProof.send(channel,...args)}}};MusicNativeSource.setupFront(window.nativeApi);await MusicNativeSource.pluginRenderer.start(window.ctx);await MusicNativeSource.pluginRenderer.onPlayerApiReady(window.nativeApi,window.ctx);undefined;`,
      );
    };
    const publish = async () => {
      const before = backend.songInfo;
      await evaluate(
        `window.emitNative('dataloaded');window.emitNative('dataupdated');undefined;`,
      );
      await wait(() => !!backend.songInfo && backend.songInfo !== before);
      await evaluate(
        `window.ipcRenderer.send('peard:time-changed',1);undefined;`,
      );
      await wait(() => backend.songInfo.elapsedSeconds === 1);
    };
    await window.loadFile(f.owned + '/main.html');
    await setup();
    const missing = await read();
    await publish();
    const original = backend.songInfo;
    const fractional = await read('song-info');
    await evaluate(`window.nativeSeconds=0;undefined;`);
    const zero = await read();
    const malformed = [];
    for (const value of [
      '-1',
      'NaN',
      'Infinity',
      'Number.MAX_VALUE',
      "'1.2345'",
      'null',
      'undefined',
    ]) {
      await evaluate('window.nativeSeconds=' + value + ';undefined;');
      malformed.push((await read()).body);
    }
    await evaluate(
      `window.nativeSeconds=1.2345;window.emitNative('unobserved','changed0001');window.emitNative('unobserved','current0001');undefined;`,
    );
    const aba = await read();
    await publish();
    await evaluate(
      `window.nativeApi.getCurrentTime=()=>{window.emitNative('unobserved','changed0001');window.emitNative('unobserved','current0001');return 1.2345};undefined;`,
    );
    const reentry = await read();
    await evaluate(
      `window.nativeApi.getCurrentTime=()=>window.nativeSeconds;undefined;`,
    );
    await publish();
    await evaluate(
      `window.oldApi=window.nativeApi;window.nativeApi={...window.nativeApi};MusicNativeSource.setupFront(window.nativeApi);await MusicNativeSource.pluginRenderer.onPlayerApiReady(window.nativeApi,window.ctx);undefined;`,
    );
    const replacement = await read();
    await publish();
    const fresh = await read();
    const beforeMissingBinding = backend.songInfo;
    await evaluate(
      `window.musicProof.send('peard:video-src-changed',window.nativeApi.getPlayerResponse());undefined;`,
    );
    await wait(() => backend.songInfo !== beforeMissingBinding);
    const missingBinding = await read();
    await publish();
    const beforeDelayed = backend.songInfo;
    await evaluate(
      `window.delayedData=window.nativeApi.getPlayerResponse();window.delayedBinding=MusicNativeSource.getPlaybackOwner(window.nativeApi).binding('current0001');window.emitNative('unobserved','changed0001');window.emitNative('unobserved','current0001');window.musicProof.send('peard:video-src-changed',window.delayedData,window.delayedBinding);undefined;`,
    );
    await wait(() => backend.songInfo !== beforeDelayed);
    const delayed = await read();
    await publish();
    const beforeFallback = backend.songInfo;
    await evaluate(
      `window.emitNative('dataloaded');window.emitNative('unobserved','changed0001');window.emitNative('unobserved','current0001');undefined;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const staleFallbackSuppressed = backend.songInfo === beforeFallback;
    await publish();
    const broker = f.source.createMusicRequestBroker(window);
    const binding = f.source.getSongInfoPlaybackBinding(backend.songInfo);
    await evaluate(`window.holdSettlements=true;undefined;`);
    const physicalControllers = Array.from(
      { length: 4 },
      () => new AbortController(),
    );
    const physical = physicalControllers.map(
      (controller: AbortController, i: number) =>
        broker
          .readClock(broker.capture(), binding, 'physical-' + i, {
            signal: controller.signal,
          })
          .catch((e: any) => e.code),
    );
    await wait(async () => await evaluate('window.heldSettlements.length===4'));
    const queuedResponse = read();
    await wait(() => broker.stats().queued === 1);
    await publish();
    await evaluate(
      `window.holdSettlements=false;for(const packet of window.heldSettlements.splice(0))window.musicProof.send('peard:legacy-clock-reply',packet);undefined;`,
    );
    const queuedReplacement = await queuedResponse;
    await Promise.all(physical);
    await evaluate(`window.holdSettlements=true;undefined;`);
    const disconnectController = new AbortController();
    const disconnect = fetch(
      'http://127.0.0.1:' + address.port + '/api/v1/song',
      { signal: disconnectController.signal },
    ).catch(() => null);
    await wait(async () => await evaluate('window.heldSettlements.length===1'));
    disconnectController.abort();
    await disconnect;
    await wait(
      async () =>
        await evaluate(
          "window.cancelPackets.some(packet=>packet.phase==='read')",
        ),
    );
    const disconnectTombstone = broker.stats().dispatched;
    await evaluate(
      `window.holdSettlements=false;for(const packet of window.heldSettlements.splice(0))window.musicProof.send('peard:legacy-clock-reply',packet);undefined;`,
    );
    await wait(() => broker.stats().dispatched === 0);
    const counters = await evaluate(
      `({polls:window.polls,expandedReplies:window.expandedReplies})`,
    );
    const oldInfo = backend.songInfo,
      oldFrame = window.webContents.mainFrame;
    await window.loadFile(f.owned + '/main.html');
    const reusedFrame = oldFrame === window.webContents.mainFrame;
    const reload = await read();
    await setup();
    await publish();
    const afterReload = await read();
    await evaluate(`MusicNativeSource.pluginRenderer.stop();undefined;`);
    const stopped = await read();
    backend.stop();
    return {
      missing,
      fractional,
      zero,
      malformed,
      aba,
      reentry,
      replacement,
      fresh,
      counters,
      missingBinding,
      delayed,
      staleFallbackSuppressed,
      queuedReplacement,
      disconnectTombstone,
      originalHasPrecision: 'elapsedMilliseconds' in original,
      originalInteger: original.elapsedSeconds,
      reusedFrame,
      reload,
      afterReload,
      stopped,
      oldInfoHasPrecision: 'elapsedMilliseconds' in oldInfo,
    };
  });
  expect(result.missing.status).toBe(204);
  expect(result.fractional.body.elapsedMilliseconds).toBe(1234.5);
  expect(result.fractional.body.elapsedSeconds).toBe(1);
  expect(result.zero.body.elapsedMilliseconds).toBe(0);
  for (const body of result.malformed)
    expect(body.elapsedMilliseconds).toBeUndefined();
  for (const reply of [
    result.aba,
    result.reentry,
    result.replacement,
    result.reload,
    result.stopped,
    result.missingBinding,
    result.delayed,
    result.queuedReplacement,
  ]) {
    expect(reply.status).toBe(200);
    expect(reply.body.elapsedMilliseconds).toBeUndefined();
  }
  expect(result.fresh.body.elapsedMilliseconds).toBe(1234.5);
  expect(result.afterReload.body.elapsedMilliseconds).toBe(1234.5);
  expect(result.counters).toEqual({ polls: 0, expandedReplies: 0 });
  expect(result.reusedFrame).toBe(true);
  expect(result.originalHasPrecision).toBe(false);
  expect(result.oldInfoHasPrecision).toBe(false);
  expect(result.originalInteger).toBe(1);
  expect(result.staleFallbackSuppressed).toBe(true);
  expect(result.disconnectTombstone).toBe(1);
});

test('actual narrow renderer retires exact pre-ACK challenges and keeps physical clock settlement tombstones', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end) throw Error('Missing owned handshake');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await window.loadFile(f.owned + '/main.html');
    await evaluate(
      `window.ipcRenderer={send:window.musicProof.send,on:(channel,fn)=>window.musicProof.subscribe(channel,(...args)=>fn({},...args))};undefined;`,
    );
    await evaluate(f.bundle);
    await evaluate(
      `window.held=[];window.cancels=[];window.foreign=0;window.listeners=[];window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001'}}),getCurrentTime:()=>1.2345,addEventListener:(name,fn)=>window.listeners.push(fn),removeEventListener:(name,fn)=>{window.listeners=window.listeners.filter(item=>item!==fn)}};window.primary=window.api;window.passive=MusicNativeSource.adoptPlaybackOwner(window.api);window.binding=window.passive.binding('current0001');window.foreignRelease=window.musicProof.subscribe('peard:legacy-clock-cancel',()=>window.foreign++);window.narrow=MusicNativeSource.createLegacyClockRendererController(window.api,()=>window.primary,{subscribe:(channel,fn)=>window.musicProof.subscribe(channel,packet=>{if(channel==='peard:legacy-clock-cancel')window.cancels.push(packet);fn(packet)}),send:(channel,packet)=>{if(packet.type==='ready'||packet.type==='settled')window.held.push(packet);else window.musicProof.send(channel,packet)}});undefined;`,
    );
    const binding = await evaluate('window.binding');
    const broker = f.source.createMusicRequestBroker(window);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const calls = controllers.map((controller: AbortController, i: number) =>
      broker
        .readClock(broker.capture(), binding, 'p' + i, {
          signal: controller.signal,
        })
        .catch((e: any) => e.code),
    );
    await wait(async () => await evaluate('window.held.length===3'));
    const queries = await evaluate('window.held.slice()');
    const malformed = [
      {
        ...queries[0],
        phase: 'owner',
        nonce: 'f'.repeat(32),
        documentId: undefined,
        sourceId: undefined,
      },
      { ...queries[0], phase: 'read' },
      { ...queries[0], phase: 'owner' },
      {
        ...queries[0],
        phase: 'wrong',
        documentId: undefined,
        sourceId: undefined,
      },
    ];
    for (const packet of malformed)
      window.webContents.send('peard:legacy-clock-cancel', packet);
    await wait(async () => await evaluate('window.cancels.length===4'));
    const malformedStats = await evaluate('window.narrow.stats()');
    controllers[0].abort();
    const preAck = await calls[0];
    await wait(
      async () => await evaluate('window.narrow.stats().challenges===2'),
    );
    const exactCancel = await evaluate('window.cancels.at(-1)');
    await evaluate(
      `window.musicProof.send('peard:legacy-clock-reply',window.held.shift());undefined;`,
    );
    const beforeRead = await evaluate('window.narrow.stats()');
    const queuedReady = queries[1];
    await evaluate(
      `window.musicProof.send('peard:legacy-clock-reply',${JSON.stringify(queuedReady)});undefined;`,
    );
    await wait(
      async () =>
        await evaluate("window.held.some(packet=>packet.type==='settled')"),
    );
    controllers[1].abort();
    const postRead = await calls[1],
      tombstone = broker.stats().dispatched;
    await evaluate(
      `const settled=window.held.find(packet=>packet.type==='settled');window.musicProof.send('peard:legacy-clock-reply',{...settled,sourceId:'f'.repeat(32)});undefined;`,
    );
    const wrongSettlement = broker.stats().dispatched;
    await evaluate(
      `window.musicProof.send('peard:legacy-clock-reply',window.held.find(packet=>packet.type==='settled'));undefined;`,
    );
    await wait(() => broker.stats().dispatched === 1);
    const afterSettlement = broker.stats().dispatched;
    controllers[2].abort();
    await Promise.all(calls);
    await evaluate(`window.held=[];undefined;`);
    const episodePromise = broker
      .readClock(broker.capture(), binding, 'episode-retire')
      .catch((e: any) => e.code);
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.musicProof.send('peard:legacy-clock-reply',window.held.shift());undefined;`,
    );
    await wait(
      async () =>
        await evaluate("window.held.some(packet=>packet.type==='settled')"),
    );
    await evaluate(
      `for(const listener of [...window.listeners])listener('unobserved',{videoId:'current0001'});undefined;`,
    );
    const episodeRetired = await episodePromise;
    const episodeTombstone = broker.stats().dispatched;
    await evaluate(
      `window.musicProof.send('peard:legacy-clock-reply',window.held.shift());undefined;`,
    );
    await wait(() => broker.stats().dispatched === 0);
    await evaluate(`window.narrow.dispose();undefined;`);
    const beforeForeign = await evaluate('window.foreign');
    window.webContents.send('peard:legacy-clock-cancel', {
      requestId: queries[0].requestId,
      nonce: queries[0].nonce,
      phase: 'owner',
    });
    await wait(
      async () => (await evaluate('window.foreign')) === beforeForeign + 1,
    );
    broker.dispose();
    return {
      malformedStats,
      preAck,
      exactCancel,
      beforeRead,
      postRead,
      tombstone,
      wrongSettlement,
      afterSettlement,
      episodeRetired,
      episodeTombstone,
      foreignPreserved:
        (await evaluate('window.foreign')) === beforeForeign + 1,
    };
  });
  expect(result.malformedStats).toEqual({ challenges: 3, active: 0 });
  expect(result.preAck).toBe('retired');
  expect(result.exactCancel.phase).toBe('owner');
  expect(result.exactCancel.documentId).toBeUndefined();
  expect(result.exactCancel.sourceId).toBeUndefined();
  expect(result.beforeRead).toEqual({ challenges: 2, active: 0 });
  expect(result.postRead).toBe('retired');
  expect(result.tombstone).toBe(2);
  expect(result.wrongSettlement).toBe(2);
  expect(result.afterSettlement).toBe(1);
  expect(result.foreignPreserved).toBe(true);
  expect(result.episodeRetired).toBe('retired');
  expect(result.episodeTombstone).toBe(1);
});

test('actual legacy-only renderer start ready and config leases reject stale asynchronous activation', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
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
    await window.webContents.executeJavaScript(
      `window.ipcRenderer={send:window.musicProof.send,on:(channel,fn)=>window.musicProof.subscribe(channel,(...args)=>fn({},...args))};undefined;`,
    );
    await window.webContents.executeJavaScript(f.bundle);
    return await window.webContents.executeJavaScript(
      `(async()=>{const source=MusicNativeSource.pluginRenderer;const enabled={enabled:true,musicApiEnabled:false};let resolveStart;const subscriptions=new Map();let foreign=0,polls=0;const timer=window.setInterval;window.setInterval=(...args)=>{polls++;return timer(...args)};window.musicProof.subscribe('peard:legacy-clock-owner-query',()=>foreign++);const ipc={send:()=>{},subscribe:(channel,fn)=>{const release=window.musicProof.subscribe(channel,fn);subscriptions.set(fn,channel);return()=>{subscriptions.delete(fn);release()}}};const context={ipc,getConfig:()=>enabled};const api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001'}}),getCurrentTime:()=>1.2345,addEventListener:()=>{},removeEventListener:()=>{}};MusicNativeSource.adoptPlaybackOwner(api);const oldStart=source.start({ipc,getConfig:()=>new Promise(resolve=>resolveStart=resolve)});source.stop();await source.start(context);await source.onPlayerApiReady(api,context);const live=subscriptions.size;resolveStart(enabled);await oldStart;const afterOldStart=subscriptions.size;let resolveReady;const pending=source.onPlayerApiReady({...api},{ipc,getConfig:()=>new Promise(resolve=>resolveReady=resolve)});source.onConfigChange({enabled:false,musicApiEnabled:false});resolveReady(enabled);await pending;const afterDisabled=subscriptions.size;source.onConfigChange(enabled);await source.onPlayerApiReady(api,context);const reenabled=subscriptions.size;source.stop();const afterStop=subscriptions.size;return {live,afterOldStart,afterDisabled,reenabled,afterStop,polls}})()`,
    );
  });
  expect(result).toEqual({
    live: 3,
    afterOldStart: 3,
    afterDisabled: 0,
    reenabled: 3,
    afterStop: 0,
    polls: 0,
  });
});

test('passive native API adoption preserves a newer API adopted during old listener installation', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
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
    await window.webContents.executeJavaScript(
      `window.ipcRenderer={send:window.musicProof.send,on:(channel,fn)=>window.musicProof.subscribe(channel,(...args)=>fn({},...args))};undefined;`,
    );
    await window.webContents.executeJavaScript(f.bundle);
    return await window.webContents.executeJavaScript(
      `(()=>{const make=()=>({getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{videoId:'current0001'}}),getCurrentTime:()=>1.2345,addEventListener:()=>{},removeEventListener:()=>{}});const newer=make(),old=make();old.addEventListener=()=>MusicNativeSource.adoptPlaybackOwner(newer);const abandoned=MusicNativeSource.adoptPlaybackOwner(old);const owned=MusicNativeSource.getPlaybackOwner(newer);const binding=owned?.binding('current0001');return {abandonedCurrent:abandoned.isCurrent(),elapsed:binding?owned.clock(binding)?.elapsedMilliseconds:null}})()`,
    );
  });
  expect(result.abandonedCurrent).toBe(false);
  expect(result.elapsed).toBe(1234.5);
});

test('actual HTTP final-owner callouts cannot publish revoked precision', async () => {
  const result = await legacyClockNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const window = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on(
      'console-message',
      (_event: unknown, _level: unknown, message: string) =>
        console.error('Owned renderer: ' + message),
    );
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(
        code.includes('await ') ? '(async()=>{' + code + '})()' : code,
      );
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end) throw Error('Missing owned observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const config = {
      enabled: true,
      musicApiEnabled: false,
      hostname: '127.0.0.1',
      port: 0,
      authStrategy: 'NONE',
      secret: 'owned fixture',
      authorizedClients: [],
      useHttps: false,
      certPath: '',
      keyPath: '',
    };
    const backend = f.source.backend;
    f.source.setupSongInfo(window);
    await backend.start({
      window,
      ipc: { on: () => {}, send: () => {} },
      getConfig: () => config,
    });
    await wait(() => !!backend.server.address());
    const address = backend.server.address();
    const read = async (alias = 'song') => {
      const response = await fetch(
        'http://127.0.0.1:' + address.port + '/api/v1/' + alias,
      );
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    };
    const setup = async () => {
      await evaluate(
        `window.ipcRenderer={send:window.musicProof.send,on:(channel,fn)=>window.musicProof.subscribe(channel,(...args)=>fn({},...args))};window.polls=0;window.expandedReplies=0;window.intervalOriginal=window.setInterval;window.setInterval=(...args)=>{window.polls++;return window.intervalOriginal(...args)};undefined;`,
      );
      await window.webContents.executeJavaScript(f.bundle);
      await evaluate(
        `window.heldSettlements=[];window.cancelPackets=[];window.holdSettlements=false;window.nativeListeners={};window.nativeId='current0001';window.nativeSeconds=1.2345;window.nativeApi={getVideoData:()=>({video_id:window.nativeId}),getPlayerResponse:()=>({videoDetails:{videoId:window.nativeId,title:'Owned metadata',author:'Owned artist',viewCount:'0',lengthSeconds:'30',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),getCurrentTime:()=>window.nativeSeconds,getDuration:()=>30,getVolume:()=>50,getPlayerState:()=>1,getWatchNextResponse:()=>({}),addEventListener:(name,fn)=>(window.nativeListeners[name]??=[]).push(fn),removeEventListener:(name,fn)=>{window.nativeListeners[name]=(window.nativeListeners[name]??[]).filter(item=>item!==fn)}};window.emitNative=(name,id=window.nativeId)=>{window.nativeId=id;for(const fn of [...(window.nativeListeners.videodatachange??[])])fn(name,{videoId:id})};window.ctx={getConfig:()=>(${JSON.stringify(config)}),ipc:{subscribe:(channel,fn)=>window.musicProof.subscribe(channel,packet=>{if(channel==='peard:legacy-clock-cancel')window.cancelPackets.push(packet);fn(packet)}),send:(channel,...args)=>{if(channel==='peard:music-reply')window.expandedReplies++;if(window.holdSettlements&&channel==='peard:legacy-clock-reply'&&args[0].type==='settled')window.heldSettlements.push(args[0]);else window.musicProof.send(channel,...args)}}};MusicNativeSource.setupFront(window.nativeApi);await MusicNativeSource.pluginRenderer.start(window.ctx);await MusicNativeSource.pluginRenderer.onPlayerApiReady(window.nativeApi,window.ctx);undefined;`,
      );
    };
    const publish = async () => {
      const before = backend.songInfo;
      await evaluate(
        `window.emitNative('dataloaded');window.emitNative('dataupdated');undefined;`,
      );
      await wait(() => !!backend.songInfo && backend.songInfo !== before);
      await evaluate(
        `window.ipcRenderer.send('peard:time-changed',1);undefined;`,
      );
      await wait(() => backend.songInfo.elapsedSeconds === 1);
    };
    await window.loadFile(f.owned + '/main.html');
    await setup();
    await publish();
    const baseline = await read();
    const originalDestroyed = window.isDestroyed.bind(window);
    let armed = false,
      calls = 0,
      threshold = 0,
      triggered = false;
    const arm = (_event: unknown, packet: any) => {
      if (packet.type === 'settled') {
        armed = true;
        calls = 0;
      }
    };
    f.ipcMain.on('peard:legacy-clock-reply', arm);
    window.isDestroyed = () => {
      if (armed && ++calls === threshold) {
        triggered = true;
        backend.configureMusic({ ...config, enabled: false });
      }
      return originalDestroyed();
    };
    const probes = [];
    for (threshold = 1; threshold <= 24; threshold++) {
      armed = false;
      calls = 0;
      triggered = false;
      backend.configureMusic(config);
      const reply = await read();
      armed = false;
      probes.push({
        threshold,
        calls,
        triggered,
        reply,
        disabledAtResponse: backend.musicConfig.enabled === false,
      });
    }
    window.isDestroyed = originalDestroyed;
    f.ipcMain.removeListener('peard:legacy-clock-reply', arm);
    backend.stop();
    return { baseline, probes };
  });
  expect(result.baseline.body.elapsedMilliseconds).toBe(1234.5);
  expect(result.probes.some((probe: any) => probe.triggered)).toBe(true);
  for (const probe of result.probes) {
    if (!probe.triggered) continue;
    expect(probe.disabledAtResponse).toBe(true);
    expect(probe.reply.status).toBe(200);
    expect(probe.reply.body.elapsedSeconds).toBe(1);
    expect(
      probe.reply.body.elapsedMilliseconds,
      JSON.stringify(probe),
    ).toBeUndefined();
  }
});
