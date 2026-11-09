import { test, expect } from '@playwright/test';
import { musicNative } from './helpers/api-music-native';

test('M1 actual native menu catalog grant socket semantic recipes minimal current ABA replay and authenticated physical tombstones', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    // Sink both system protocol registration methods BEFORE any source/backend task callout.
    let protocolCalls = 0;
    f.app.setAsDefaultProtocolClient = () => {
      protocolCalls++;
      return false;
    };
    f.app.removeAsDefaultProtocolClient = () => {
      protocolCalls++;
      return false;
    };
    const http = require('node:http'),
      reserve = http.createServer();
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
        nodeIntegrationInSubFrames: true,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`
   window.calls=[];window.identityReads=0;window.broadReads=0;window.nativeListeners={};window.video='v0000000000';window.hold=false;window.resolvers=[];window.readPackets=[];
   window.api={isConnected:true,getVideoData(){window.identityReads++;return {video_id:window.video};},getPlayerResponse(){window.identityReads++;return {videoDetails:{videoId:window.video}};},getCurrentTime(){window.broadReads++;throw Error('Forbidden broad getter');},getVolume(){window.broadReads++;throw Error('Forbidden broad getter');},getDuration(){window.broadReads++;throw Error('Forbidden broad getter');},getPlayerState(){window.broadReads++;throw Error('Forbidden broad getter');},addEventListener(k,fn){window.nativeListeners[k]=fn;},removeEventListener(k){delete window.nativeListeners[k];}};
   window.queueRows=Array.from({length:151},(_,i)=>({playlistPanelVideoRenderer:{videoId:'duplicate01',title:{simpleText:'Queue literal '+i},shortBylineText:{runs:[{text:'Queue artist'}]},lengthText:{simpleText:'3:35'},musicVideoType:'MUSIC_VIDEO_TYPE_ATV',selected:i===0}}));const queueElement=document.createElement('div');queueElement.id='queue';document.body.append(queueElement);queueElement.queue={getItems:()=>window.queueRows,store:{store:{getState:()=>({queue:{items:window.queueRows,selectedItemIndex:0}}),subscribe:()=>()=>{}}}};
   window.aba=()=>{window.video='other000001';window.nativeListeners.videodatachange();window.video='v0000000000';window.nativeListeners.videodatachange();};
   const tab=(browseId,pageType)=>({tabRenderer:{title:'非英語',endpoint:{browseEndpoint:{browseId,browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType}}}}}});
   window.next={contents:{singleColumnMusicWatchNextResultsRenderer:{tabbedRenderer:{watchNextTabbedResultsRenderer:{tabs:[{tabRenderer:{content:{musicQueueRenderer:{}}}},tab('MPTR_owned','MUSIC_PAGE_TYPE_TRACK_RELATED'),tab('MPLY_owned','MUSIC_PAGE_TYPE_TRACK_LYRICS')]}}}},currentVideoEndpoint:{watchEndpoint:{videoId:'v0000000000'}}};
   window.lyrics={contents:{sectionListRenderer:{contents:[{musicDescriptionShelfRenderer:{description:{runs:[{text:'Привіт, світе\\n'},{text:'Καλημέρα\\n'},{text:'こんにちは 🎵'}]},footer:{simpleText:'Source: Public fixture\\n© Synthetic attribution'}}}]}}};
   const song=i=>({musicTwoRowItemRenderer:{title:{runs:[{text:'Literal native '+i}]},navigationEndpoint:{watchEndpoint:{videoId:i===37?'v0000000000':'v'+i.toString(36).padStart(10,'0'),watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}}},subtitle:{runs:[{text:'Song'}]}}});
   const shelf=(rows,title)=>({musicCarouselShelfRenderer:{header:{musicCarouselShelfBasicHeaderRenderer:{title:{runs:[{text:title}]} }},contents:rows}});
   window.section={contents:[shelf(Array.from({length:37},(_,i)=>song(i)),'Shelf One'),shelf(Array.from({length:65},(_,i)=>song(i+37)),'Shelf Two'),shelf(Array.from({length:49},(_,i)=>song(i+102)),'Shelf Three')],continuations:[{nextContinuationData:{continuation:'private-related-next'}}]};
   window.related={contents:{sectionListRenderer:window.section}};
   window.home={contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:window.section}}}]}}};
   window.nativeFetch=function(url,data){window.calls.push({url,data,receiver:this===document.querySelector('ytmusic-app').networkManager});if(window.hold)return new Promise(r=>window.resolvers.push({url,data,resolve:r}));if(url==='/next')return Promise.resolve(window.next);if(data.browseId==='MPLY_owned')return Promise.resolve(window.lyrics);if(data.browseId==='MPTR_owned')return Promise.resolve(window.related);if(data.browseId==='FEmusic_home')return Promise.resolve(window.home);if(data.continuation==='private-related-next')return Promise.resolve({continuationContents:{sectionListContinuation:{contents:[],continuations:[]}}});throw Error('Unexpected recipe');};
   document.querySelector('ytmusic-app').networkManager={fetch:window.nativeFetch};window.musicProof.subscribe('peard:music-read',p=>window.readPackets.push(p));window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,window.musicProof);undefined;
  `);
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
    const context = {
      window,
      getConfig: () => config,
      setConfig() {},
      ipc: {
        send: (...args: any[]) => window.webContents.send(...args),
        on: (channel: string, fn: any) =>
          f.ipcMain.on(channel, (_e: any, ...args: any[]) => fn(...args)),
        handle: (channel: string, fn: any) => f.ipcMain.handle(channel, fn),
        removeHandler: (channel: string) => f.ipcMain.removeHandler(channel),
      },
    };
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const service = f.source.getMusicService(window),
      cold = await evaluate(
        '({reads:window.identityReads,calls:window.calls.length})',
      );
    const choices = [1, 2, 0];
    let token: string | undefined;
    const menu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => service,
      {
        prompt: async () => 'Owned metadata catalog client',
        show: async () => ({ response: choices.shift() }),
        copy: (v: string) => {
          token = v;
        },
      },
    );
    await menu
      .find((i: any) => i.label.startsWith('Create client grant'))
      .click();
    if (!token) throw Error('Missing native catalog-only grant');
    const afterMenu = await evaluate(
      '({reads:window.identityReads,calls:window.calls.length})',
    );
    const request = (path: string, credential = token) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + path,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + credential,
            },
          },
          (res: any) => {
            let body = '';
            res.on('data', (c: any) => (body += c));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    let exactMainReplies = 0,
      foreignReplies = 0;
    const observer = (e: any, p: any) => {
      if (p.type !== 'settled') return;
      if (
        e.sender === window.webContents &&
        e.senderFrame === window.webContents.mainFrame
      )
        exactMainReplies++;
      else foreignReplies++;
    };
    f.ipcMain.on('peard:music-reply', observer);
    const explicit = await request('/song/lyrics?videoId=v0000000000'),
      explicitReads = await evaluate('window.identityReads');
    if (explicit.status !== 200) {
      f.source.backend.stop();
      return { baselineMissing: explicit.status } as any;
    }
    const first = await request('/song/related?videoId=v0000000000&limit=100'),
      second = await request(
        '/song/related?limit=100&cursor=' + first.body.nextCursor,
      ),
      replay = await request(
        '/song/related?limit=100&cursor=' + first.body.nextCursor,
      ),
      afterLocal = await evaluate('window.calls.length');
    const third = await request(
        '/song/related?limit=100&cursor=' + second.body.nextCursor,
      ),
      current = await request('/song/lyrics?current=true');
    const currentPage = await request('/song/related?current=true&limit=100'),
      beforeProbe = await evaluate('window.calls.length');
    const currentRest = await request(
        '/song/related?limit=100&cursor=' + currentPage.body.nextCursor,
      ),
      afterProbe = await evaluate('window.calls.length');
    await evaluate('window.aba();undefined;');
    const retiredReplay = await request(
        '/song/related?limit=100&cursor=' + currentPage.body.nextCursor,
      ),
      explicitReplay = await request(
        '/song/related?limit=100&cursor=' + first.body.nextCursor,
      );
    const deny = await service.grants.issue(
        'Playback only',
        'rest',
        service.resource,
        ['playback.read'],
        () => true,
      ),
      beforeDenied = await evaluate(
        '({reads:window.identityReads,calls:window.calls.length})',
      );
    const denied = await request('/song/lyrics?current=true', deny.token),
      afterDenied = await evaluate(
        '({reads:window.identityReads,calls:window.calls.length})',
      );
    const mixed = await service.grants.issue(
      'Mixed read quota',
      'rest',
      service.resource,
      ['catalog.read', 'personalized.read', 'playback.read'],
      () => true,
    );
    const beforeMixed = service.stats().cursors;
    const mixedPages = [
      await service.queue(mixed.token, { limit: 100 }),
      await service.home(mixed.token, { limit: 100 }),
      await service.related(mixed.token, {
        videoId: 'v0000000000',
        limit: 100,
      }),
    ];
    for (let i = 0; i < 29; i++)
      await service.related(mixed.token, {
        videoId: 'v0000000000',
        limit: 100,
      });
    const mixedCursorDelta = service.stats().cursors - beforeMixed;
    const mixedOverflow = await service.queue(mixed.token, { limit: 100 }).then(
      () => 'ok',
      (e: any) => e.code,
    );
    await service.grants.revoke(mixed.record.id, () => true);
    const mixedAfterRevoke = service.stats().cursors - beforeMixed;
    const broker = f.source.createMusicRequestBroker(window),
      wait = async (check: () => any) => {
        for (let n = 0; n < 500; n++) {
          if (await check()) return;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw Error('Native bounded condition failed');
      };
    await evaluate(
      'window.hold=true;window.resolvers=[];window.readPackets=[];undefined;',
    );
    const controls = Array.from({ length: 4 }, () => new AbortController()),
      physical = controls.map((c, i) =>
        broker
          .read(
            broker.capture(),
            {
              operation: 'lyrics',
              target: { videoId: 'v0000000000' },
              deadlineAt: Date.now() + 15000,
            },
            i < 2 ? 'physical-A' : 'physical-B',
            { signal: c.signal },
          )
          .then(
            () => 'ok',
            (e: any) => e.code,
          ),
      );
    await wait(async () => await evaluate('window.resolvers.length===4'));
    const queued = Array.from({ length: 8 }, (_, i) =>
      broker
        .read(
          broker.capture(),
          i === 0
            ? { operation: 'home' }
            : i === 1
              ? { operation: 'queue' }
              : {
                  operation: 'lyrics',
                  target: { videoId: 'v0000000000' },
                  deadlineAt: Date.now() + 15000,
                },
          'queued-' + i,
        )
        .then(
          () => 'ok',
          (e: any) => e.code,
        ),
    );
    await wait(() => broker.stats().queued === 8);
    const overflow = await broker
      .read(broker.capture(), { operation: 'home' }, 'overflow')
      .then(
        () => 'ok',
        (e: any) => e.code,
      );
    controls[0].abort();
    const canceled = await physical[0],
      afterCancel = broker.stats();
    const packet = await evaluate('window.readPackets[0]');
    const forged = {
      ...packet,
      type: 'settled',
      result: { ok: false, reason: 'retired' },
    };
    await evaluate(
      "window.musicProof.send('peard:music-reply'," +
        JSON.stringify({ ...forged, nonce: 'f'.repeat(32) }) +
        ');undefined;',
    );
    await new Promise((r) => setTimeout(r, 20));
    const afterWrong = broker.stats();
    const foreignWindow = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
      },
    });
    await foreignWindow.loadFile(f.owned + '/main.html');
    const forge =
      "window.musicProof.send('peard:music-reply'," +
      JSON.stringify(forged) +
      ');undefined;';
    await foreignWindow.webContents.executeJavaScript(forge);
    const subframe = window.webContents.mainFrame.frames[0];
    if (!subframe) throw Error('Missing raw child frame');
    await subframe.executeJavaScript(forge);
    await wait(() => foreignReplies === 2);
    const afterForeign = broker.stats();
    const beforeSettlement = await evaluate('window.calls.length');
    await evaluate(
      'window.hold=false;window.resolvers.shift().resolve(window.next);undefined;',
    );
    await wait(() => broker.stats().queued < 8);
    const afterSettlement = broker.stats();
    await evaluate(
      'for(const r of window.resolvers.splice(0))r.resolve(window.next);undefined;',
    );
    const physicalResults = await Promise.all(physical),
      queuedResults = await Promise.all(queued);
    await wait(() => broker.stats().dispatched === 0);
    const recipes = await evaluate('window.calls'),
      broadReads = await evaluate('window.broadReads');
    await evaluate('window.controller.dispose();undefined;');
    f.source.backend.stop();
    f.ipcMain.removeListener('peard:music-reply', observer);
    return {
      cold,
      afterMenu,
      explicit,
      explicitReads,
      first: {
        status: first.status,
        count: first.body.items.length,
        duplicate: first.body.items[37].id,
        privateLeak: JSON.stringify(first.body).includes(
          'private-related-next',
        ),
      },
      second: { count: second.body.items.length, shelves: second.body.shelves },
      replay: JSON.stringify(replay) === JSON.stringify(second),
      afterLocal,
      third,
      current,
      currentRest: { count: currentRest.body.items.length },
      beforeProbe,
      afterProbe,
      retiredReplay,
      explicitReplay: JSON.stringify(explicitReplay) === JSON.stringify(second),
      denied,
      beforeDenied,
      afterDenied,
      mixedCounts: mixedPages.map((p) => p.items.length),
      mixedCursorDelta,
      mixedOverflow,
      mixedAfterRevoke,
      overflow,
      canceled,
      afterCancel,
      afterWrong,
      afterForeign,
      afterSettlement,
      beforeSettlement,
      physicalResults,
      queuedResults,
      recipes: recipes.slice(0, 2),
      allReceiver: recipes.every((call: any) => call.receiver),
      broadReads,
      exactMainReplies,
      foreignReplies,
      protocolCalls,
    };
  });
  expect(result.baselineMissing ?? null).toBeNull();
  expect(result.cold).toEqual({ reads: 0, calls: 0 });
  expect(result.afterMenu).toEqual(result.cold);
  expect(result.explicitReads).toBe(0);
  expect(result.explicit).toEqual({
    status: 200,
    body: {
      videoId: 'v0000000000',
      available: true,
      lyrics: 'Привіт, світе\nΚαλημέρα\nこんにちは 🎵',
      source: 'Source: Public fixture\n© Synthetic attribution',
    },
  });
  expect(result.first.status).toBe(200);
  expect(result.first.count).toBe(100);
  expect(result.first.duplicate).toBe('v0000000000');
  expect(result.second.count).toBe(51);
  expect(result.second.shelves).toEqual([
    { title: 'Shelf Two', start: 0, count: 2 },
    { title: 'Shelf Three', start: 2, count: 49 },
  ]);
  expect(result.replay).toBe(true);
  expect(result.afterLocal).toBe(4);
  expect(result.third.body.items).toEqual([]);
  expect(result.current).toEqual(result.explicit);
  expect(result.currentRest.count).toBe(51);
  expect(result.afterProbe).toBe(result.beforeProbe);
  expect(result.retiredReplay.status).toBe(409);
  expect(result.explicitReplay).toBe(true);
  expect(result.denied.status).toBe(403);
  expect(result.afterDenied).toEqual(result.beforeDenied);
  expect(result.mixedCounts).toEqual([100, 100, 100]);
  expect(result.mixedCursorDelta).toBe(32);
  expect(result.mixedOverflow).toBe('budget');
  expect(result.mixedAfterRevoke).toBe(0);
  expect(result.overflow).toBe('busy');
  expect(result.canceled).toBe('retired');
  expect(result.afterCancel).toEqual({ dispatched: 4, queued: 8 });
  expect(result.afterWrong).toEqual(result.afterCancel);
  expect(result.afterForeign).toEqual(result.afterCancel);
  expect(result.afterSettlement.queued).toBeLessThan(8);
  expect(result.physicalResults).toEqual(['retired', 'ok', 'ok', 'ok']);
  expect(result.queuedResults).toEqual(Array(8).fill('ok'));
  expect(result.foreignReplies).toBe(2);
  expect(result.exactMainReplies).toBeGreaterThan(12);
  expect(result.broadReads).toBe(0);
  expect(result.protocolCalls).toBe(0);
  expect(result.allReceiver).toBe(true);
  expect(result.recipes[0]).toEqual({
    url: '/next',
    data: { videoId: 'v0000000000', isAudioOnly: true },
    receiver: true,
  });
  expect(result.recipes[1]).toEqual({
    url: '/browse',
    data: { browseId: 'MPLY_owned' },
    receiver: true,
  });
  expect(result.first.privateLeak).toBe(false);
});
