import { test, expect } from '@playwright/test';
import { musicNative } from './helpers/api-music-native';

test('actual native Home/library grant editor broker raw main-frame IPC and REST preserve synthetic collections', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const http = require('node:http');
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
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`
      window.collectionCalls=[];window.remoteResolvers=[];window.hold=false;
      window.api={isConnected:true,addEventListener:()=>{},removeEventListener:()=>{}};
      const run=(text)=>({runs:[{text}]});
      const song=(i)=>({musicTwoRowItemRenderer:{title:run('Owned '+i),navigationEndpoint:{watchEndpoint:{videoId:i===37?'v0000000000':'v'+i.toString(36).padStart(10,'0'),watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}}},subtitle:run('Song')}});
      const playlist=(id,title,titleOnly=false)=>{const endpoint={browseEndpoint:{browseId:'VL'+id,browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_PLAYLIST'}}}};return {musicTwoRowItemRenderer:{title:{runs:[{text:title,navigationEndpoint:endpoint}]},...(titleOnly?{}:{navigationEndpoint:endpoint}),subtitle:run('Playlist')}}};
      const shelf=(rows,title)=>({musicCarouselShelfRenderer:{header:{musicCarouselShelfBasicHeaderRenderer:{title:run(title)}},contents:rows}});
      const page=(shelves,token)=>({contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:shelves,...(token?{continuations:[{nextContinuationData:{continuation:token}}]}:{})}}}}]}}});
      window.homeFixture=page([shelf(Array.from({length:37},(_,i)=>song(i)),'Shelf One'),shelf(Array.from({length:65},(_,i)=>song(i+37)),'Shelf Two'),shelf(Array.from({length:49},(_,i)=>song(i+102)),'Shelf Three')],'private-home-next');
      window.libraryFixture=page([shelf([playlist('PLnativeA','First A',true),playlist('PLnativeA','Duplicate A'),song(0),playlist('PLnativeB','First B')],'Library')],'private-library-next');
      window.remotePage=(rows,token)=>({continuationContents:{musicShelfContinuation:{contents:rows,continuations:token?[{nextContinuationData:{continuation:token}}]:[]}}});
      window.playlistFixture=playlist;window.songFixture=song;
      window.nativeFetch=function(url,data){window.collectionCalls.push({url,data});if(window.hold)return new Promise(r=>window.remoteResolvers.push(r));if(data.browseId==='FEmusic_home')return Promise.resolve(window.homeFixture);if(data.browseId==='FEmusic_liked_playlists')return Promise.resolve(window.libraryFixture);if(data.continuation==='private-home-next')return Promise.resolve(window.remotePage([song(152)]));if(data.continuation==='private-library-next')return Promise.resolve(window.remotePage([playlist('PLnativeA','Remote duplicate')],'private-library-last'));if(data.continuation==='private-library-last')return Promise.resolve(window.remotePage([playlist('PLnativeB','Remote duplicate'),playlist('PLnativeC','First C',true)]));throw Error('Unexpected recipe');};
      document.querySelector('ytmusic-app').networkManager={fetch:window.nativeFetch};
      window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,window.musicProof);undefined;
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
    const listeners: any[] = [];
    const context = {
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
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const service = f.source.getMusicService(window);
    const coldBeforeMenu = await evaluate('window.collectionCalls.length');
    const choices = [4, 2, 0];
    let token: string | undefined;
    const menu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => service,
      {
        prompt: async () => 'Owned queue socket client',
        show: async () => ({ response: choices.shift() }),
        copy: (value: string) => {
          token = value;
        },
      },
    );
    await menu
      .find((item: any) => item.label.startsWith('Create client grant'))
      .click();
    if (!token) {
      f.source.backend.stop();
      return { copied: false };
    }
    let exactMainReplies = 0,
      foreignReplies = 0;
    const observe = (event: any, packet: any) => {
      if (packet.type !== 'settled') return;
      if (
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame
      )
        exactMainReplies++;
      else foreignReplies++;
    };
    f.ipcMain.on('peard:music-reply', observe);
    const request = (path = '/home', query = '', credential = token) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + path + query,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + credential,
            },
          },
          (res: any) => {
            let body = '';
            res.on('data', (chunk: any) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    const coldAfterMenu = await evaluate('window.collectionCalls.length');
    const first = await request('/home', '?limit=100');
    const second = await request(
      '/home',
      '?limit=100&cursor=' + first.body.nextCursor,
    );
    const replay = await request(
      '/home',
      '?limit=100&cursor=' + first.body.nextCursor,
    );
    const afterLocal = await evaluate('window.collectionCalls.length');
    const third = await request(
      '/home',
      '?limit=100&cursor=' + second.body.nextCursor,
    );
    let libraryToken: string | undefined;
    const libraryChoices = [5, 2, 0];
    const libraryMenu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => service,
      {
        prompt: async () => 'Owned library reader',
        show: async () => ({ response: libraryChoices.shift() }),
        copy: (value: string) => {
          libraryToken = value;
        },
      },
    );
    await libraryMenu
      .find((i: any) => i.label.startsWith('Create client grant'))
      .click();
    if (!libraryToken) throw Error('Missing explicit library grant');
    const library = await request(
      '/library/playlists',
      '?limit=100',
      libraryToken,
    );
    const duplicate = await request(
      '/library/playlists',
      '?limit=100&cursor=' + library.body.nextCursor,
      libraryToken,
    );
    const afterDuplicate = await evaluate('window.collectionCalls.length');
    const final = await request(
      '/library/playlists',
      '?limit=100&cursor=' + duplicate.body.nextCursor,
      libraryToken,
    );
    const wrongScope = await request('/library/playlists');
    const wrongCursor = await request(
      '/library/playlists',
      '?limit=100&cursor=' + first.body.nextCursor,
      libraryToken,
    );
    const legacy = await request('/home', '', 'legacy-client-id');
    const calls = await evaluate('window.collectionCalls');
    await evaluate('window.hold=true;undefined;');
    const held = request('/home');
    const end = Date.now() + 4000;
    while ((await evaluate('window.remoteResolvers.length')) !== 1) {
      if (Date.now() > end) throw Error('Missing native held fetch');
      await new Promise((r) => setTimeout(r, 5));
    }
    await evaluate(
      `document.querySelector('ytmusic-app').networkManager.fetch=(...args)=>window.nativeFetch(...args);window.remoteResolvers.shift()(window.homeFixture);undefined;`,
    );
    const retired = await held;
    await evaluate('window.hold=false;window.controller.refresh();undefined;');
    const recovered = await request('/home', '?limit=100');
    await evaluate(
      `window.bindingNetwork=document.querySelector('ytmusic-app').networkManager;window.bindingFetch=window.bindingNetwork.fetch;window.bindingCalls=0;window.bindingThreshold=Infinity;window.bindingTriggered=false;Object.defineProperty(window.bindingNetwork,'fetch',{configurable:true,get(){if(window.controller.stats().active && ++window.bindingCalls===window.bindingThreshold){window.bindingTriggered=true;document.querySelector('ytmusic-app').networkManager={fetch:window.bindingFetch};}return window.bindingFetch;}});undefined;`,
    );
    const bindingWarm = await request('/home', '?limit=100');
    const bindingCount = await evaluate('window.bindingCalls');
    await evaluate(
      `window.bindingCalls=0;window.bindingThreshold=${bindingCount};undefined;`,
    );
    const bindingRace = await request('/home', '?limit=100');
    const bindingTriggered = await evaluate('window.bindingTriggered');
    await evaluate('window.controller.refresh();undefined;');
    const bindingRecovery = await request('/home', '?limit=100');
    await evaluate(
      `window.savedHome=window.homeFixture;window.homeFixture={contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[]}}}}]}}};undefined;`,
    );
    const empty = await request('/home');
    await evaluate(
      'window.homeFixture={contents:{unknownRenderer:{}}};undefined;',
    );
    const unknown = await request('/home');
    await evaluate(
      `window.homeFixture={contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[{musicShelfRenderer:{contents:[{musicTwoRowItemRenderer:{}}]}}]}}}}]}}};undefined;`,
    );
    const malformed = await request('/home');
    await evaluate(
      "window.savedNetwork=document.querySelector('ytmusic-app').networkManager;document.querySelector('ytmusic-app').networkManager=undefined;undefined;",
    );
    const unavailable = await request('/home');
    await evaluate(
      "document.querySelector('ytmusic-app').networkManager=window.savedNetwork;window.homeFixture=window.savedHome;window.controller.refresh();undefined;",
    );
    const available = await request('/home', '?limit=100');
    await evaluate('window.controller.dispose();undefined;');
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    f.ipcMain.removeListener('peard:music-reply', observe);
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    return {
      copied: true,
      coldBeforeMenu,
      coldAfterMenu,
      first,
      second,
      replayEqual: JSON.stringify(replay) === JSON.stringify(second),
      afterLocal,
      third,
      library,
      duplicate,
      afterDuplicate,
      final,
      wrongScope: wrongScope.status,
      wrongCursor: wrongCursor.status,
      legacy: legacy.status,
      calls,
      retired: retired.status,
      recovered: recovered.status,
      exactMainReplies,
      foreignReplies,
      bindingWarm: bindingWarm.status,
      bindingRace: bindingRace.status,
      bindingRecovery: bindingRecovery.status,
      bindingTriggered,
      empty: {
        status: empty.status,
        items: empty.body.items,
        nextCursor: empty.body.nextCursor,
      },
      unknown: unknown.status,
      malformed: malformed.status,
      unavailable: unavailable.status,
      available: available.status,
    };
  });
  expect(result.copied).toBe(true);
  expect(result).toMatchObject({
    coldBeforeMenu: 0,
    coldAfterMenu: 0,
    afterLocal: 1,
    afterDuplicate: 4,
    wrongScope: 403,
    wrongCursor: 404,
    legacy: 401,
    retired: 409,
    recovered: 200,
    foreignReplies: 0,
  });
  expect(result.first.status).toBe(200);
  expect(result.first.body.items).toHaveLength(100);
  expect(result.first.body.items[0].id).toBe('v0000000000');
  expect(result.first.body.items[37].id).toBe('v0000000000');
  expect(result.first.body.shelves).toEqual([
    { title: 'Shelf One', start: 0, count: 37 },
    { title: 'Shelf Two', start: 37, count: 63 },
  ]);
  expect(result.second.body.items).toHaveLength(51);
  expect(result.second.body.shelves).toEqual([
    { title: 'Shelf Two', start: 0, count: 2 },
    { title: 'Shelf Three', start: 2, count: 49 },
  ]);
  expect(result.replayEqual).toBe(true);
  expect(result.third.body.items.map((i: any) => i.id)).toEqual([
    'v0000000048',
  ]);
  expect(result.library.body.items.map((i: any) => [i.id, i.title])).toEqual([
    ['PLnativeA', 'First A'],
    ['PLnativeB', 'First B'],
  ]);
  expect(result.duplicate.body.items).toEqual([]);
  expect(result.duplicate.body.nextCursor).toMatch(/^mcur_/);
  expect(result.final.body.items.map((i: any) => [i.id, i.title])).toEqual([
    ['PLnativeC', 'First C'],
  ]);
  expect(result.calls).toEqual([
    { url: '/browse', data: { browseId: 'FEmusic_home' } },
    { url: '/browse', data: { continuation: 'private-home-next' } },
    { url: '/browse', data: { browseId: 'FEmusic_liked_playlists' } },
    { url: '/browse', data: { continuation: 'private-library-next' } },
    { url: '/browse', data: { continuation: 'private-library-last' } },
  ]);
  expect(result.exactMainReplies).toBe(14);
  expect(result).toMatchObject({
    empty: { status: 200, items: [], nextCursor: null },
    unknown: 502,
    malformed: 502,
    unavailable: 503,
    available: 200,
  });
  expect(result).toMatchObject({
    bindingWarm: 200,
    bindingRace: 409,
    bindingRecovery: 200,
    bindingTriggered: true,
  });
});

test('collection remote cursor shares native tombstones FIFO and rejects foreign raw frames', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const http = require('node:http');
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
        nodeIntegrationInSubFrames: true,
      },
    });
    await window.loadFile(f.owned + '/main.html');
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`
      window.collectionCalls=[];window.remoteResolvers=[];window.hold=false;
      window.api={isConnected:true,addEventListener:()=>{},removeEventListener:()=>{}};
      const run=(text)=>({runs:[{text}]});
      const song=(i)=>({musicTwoRowItemRenderer:{title:run('Owned '+i),navigationEndpoint:{watchEndpoint:{videoId:i===37?'v0000000000':'v'+i.toString(36).padStart(10,'0'),watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}}},subtitle:run('Song')}});
      const playlist=(id,title,titleOnly=false)=>{const endpoint={browseEndpoint:{browseId:'VL'+id,browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_PLAYLIST'}}}};return {musicTwoRowItemRenderer:{title:{runs:[{text:title,navigationEndpoint:endpoint}]},...(titleOnly?{}:{navigationEndpoint:endpoint}),subtitle:run('Playlist')}}};
      const shelf=(rows,title)=>({musicCarouselShelfRenderer:{header:{musicCarouselShelfBasicHeaderRenderer:{title:run(title)}},contents:rows}});
      const page=(shelves,token)=>({contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:shelves,...(token?{continuations:[{nextContinuationData:{continuation:token}}]}:{})}}}}]}}});
      window.homeFixture=page([shelf(Array.from({length:37},(_,i)=>song(i)),'Shelf One'),shelf(Array.from({length:65},(_,i)=>song(i+37)),'Shelf Two'),shelf(Array.from({length:49},(_,i)=>song(i+102)),'Shelf Three')],'private-home-next');
      window.libraryFixture=page([shelf([playlist('PLnativeA','First A',true),playlist('PLnativeA','Duplicate A'),song(0),playlist('PLnativeB','First B')],'Library')],'private-library-next');
      window.remotePage=(rows,token)=>({continuationContents:{musicShelfContinuation:{contents:rows,continuations:token?[{nextContinuationData:{continuation:token}}]:[]}}});
      window.playlistFixture=playlist;window.songFixture=song;
      window.nativeFetch=function(url,data){window.collectionCalls.push({url,data});if(window.holdFetch)return new Promise(r=>window.remoteResolvers.push(r));if(data.browseId==='FEmusic_home')return Promise.resolve(window.homeFixture);if(data.browseId==='FEmusic_liked_playlists')return Promise.resolve(window.libraryFixture);if(data.continuation==='private-home-next')return Promise.resolve(window.remotePage([song(152)]));if(data.continuation==='private-library-next')return Promise.resolve(window.remotePage([playlist('PLnativeA','Remote duplicate')],'private-library-last'));if(data.continuation==='private-library-last')return Promise.resolve(window.remotePage([playlist('PLnativeB','Remote duplicate'),playlist('PLnativeC','First C',true)]));throw Error('Unexpected recipe');};
      document.querySelector('ytmusic-app').networkManager={fetch:window.nativeFetch};
      window.homeFixture={contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:[shelf([song(0)],'Home')],continuations:[{nextContinuationData:{continuation:'private-home-next'}}]}}}}]}}};window.held=[];window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(window.hold&&packet.type==='settled')window.held.push(packet);else window.musicProof.send(channel,packet)}});undefined;
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
    const listeners: any[] = [];
    const context = {
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
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((r) =>
        f.source.backend.server.once('listening', r),
      );
    const service = f.source.getMusicService(window);
    const choices = [4, 2, 0];
    let token: string | undefined;
    const menu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => service,
      {
        prompt: async () => 'Owned queue socket client',
        show: async () => ({ response: choices.shift() }),
        copy: (value: string) => {
          token = value;
        },
      },
    );
    await menu
      .find((item: any) => item.label.startsWith('Create client grant'))
      .click();
    if (!token) throw Error('Missing explicit native grant copy');
    let exactMainReplies = 0,
      foreignReplies = 0;
    const observe = (event: any, packet: any) => {
      if (packet.type !== 'settled') return;
      if (
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame
      )
        exactMainReplies++;
      else foreignReplies++;
    };
    f.ipcMain.on('peard:music-reply', observe);
    const request = (query = '') =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music/home' + query,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + token,
            },
          },
          (res: any) => {
            let body = '';
            res.on('data', (chunk: any) => (body += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });
    const wait = async (fn: () => any) => {
      const end = Date.now() + 5000;
      while (!(await fn())) {
        if (Date.now() > end) throw Error('Missing shared pool observation');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const first = await request('?limit=100');
    const input = { limit: 100, cursor: first.body.nextCursor };
    const other = await service.grants.issue(
      'Other controlled reader',
      'rest',
      service.resource,
      ['personalized.read'],
      () => true,
    );
    const foreign = await service.home(other.token, input).then(
      () => 'unexpected',
      (e: any) => e.code,
    );
    const broker = f.source.createMusicRequestBroker(window);
    await evaluate('window.hold=true;undefined;');
    const controls = Array.from({ length: 4 }, () => new AbortController());
    const calls = controls.map((c, i) =>
      broker
        .read(
          broker.capture(),
          { operation: 'home' },
          i < 2 ? 'physical-A' : 'physical-B',
          { signal: c.signal },
        )
        .then(
          () => 'ok',
          (e: any) => e.code,
        ),
    );
    await wait(async () => await evaluate('window.held.length===4'));
    const continuation = service.home(token, input);
    await wait(() => broker.stats().queued === 1);
    controls[0].abort();
    const canceled = await calls[0],
      afterCancel = broker.stats();
    await evaluate(
      `window.oldSettled=window.held.shift();window.musicProof.send('peard:music-reply',{...window.oldSettled,nonce:'f'.repeat(32)});undefined;`,
    );
    const afterWrong = broker.stats();
    const foreignWindow = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await foreignWindow.loadFile(f.owned + '/main.html');
    const packet = await evaluate('window.oldSettled');
    const forge =
      "window.musicProof.send('peard:music-reply'," +
      JSON.stringify(packet) +
      ');undefined;';
    await foreignWindow.webContents.executeJavaScript(forge);
    const subframe = window.webContents.mainFrame.frames[0];
    if (!subframe) throw Error('Missing owned child frame');
    await subframe.executeJavaScript(forge);
    await wait(() => foreignReplies === 2);
    const afterForeign = broker.stats();

    await evaluate(
      `window.musicProof.send('peard:music-reply',window.oldSettled);undefined;`,
    );
    await wait(async () => await evaluate('window.held.length===4'));
    const afterExact = broker.stats();
    await evaluate(
      `window.hold=false;for(const packet of window.held.splice(0))window.musicProof.send('peard:music-reply',packet);undefined;`,
    );
    const page = await continuation;
    await Promise.all(calls);
    await wait(() => broker.stats().dispatched === 0);
    const beforeReplay = exactMainReplies;
    const replay = await service.home(token, input);
    const replayPhysical = exactMainReplies - beforeReplay;
    const fetches = await evaluate('window.collectionCalls.length');
    await evaluate('window.controller.dispose();undefined;');
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    f.ipcMain.removeListener('peard:music-reply', observe);
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    return {
      first: first.status,
      foreign,
      canceled,
      afterCancel,
      afterWrong,
      afterForeign,
      afterExact,
      count: page.items.length,
      id: page.items[0].id,
      replayEqual: JSON.stringify(page) === JSON.stringify(replay),
      replayPhysical,
      fetches,
      foreignReplies,
    };
  });
  console.log('NATIVE_COLLECTION_POOL ' + JSON.stringify(result));
  expect(result.first).toBe(200);
  expect(result.foreign).toBe('not_found');
  expect(result.canceled).toBe('retired');
  expect(result.afterCancel).toMatchObject({ dispatched: 4, queued: 1 });
  expect(result.afterWrong).toMatchObject({ dispatched: 4, queued: 1 });
  expect(result.afterExact).toMatchObject({ dispatched: 4, queued: 0 });
  expect(result.afterForeign).toMatchObject({ dispatched: 4, queued: 1 });
  expect(result.count).toBe(1);
  expect(result.id).toBe('v0000000048');
  expect(result.replayEqual).toBe(true);
  expect(result.replayPhysical).toBe(0);
  expect(result.fetches).toBe(6);
  expect(result.foreignReplies).toBe(2);
});
// F2: actual native source/metadata reentry; synthetic query only observes its inner epoch.
test('F2 actual native canceled-job and capture reentry preserve adopted source artifacts', async () => {
  const result = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const http = require('node:http');
    const reserve = http.createServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port;
    await new Promise<void>((r) => reserve.close(r));
    const win = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(f.owned + '/main.html');
    const evaluate = (s: string) => win.webContents.executeJavaScript(s);
    await evaluate(f.bundle);
    await evaluate(`
      window.calls=[];window.held=[];window.hold=false;
      window.api={isConnected:true,addEventListener(){},removeEventListener(){}};
      const run=text=>({runs:[{text}]});
      const watch=i=>({watchEndpoint:{videoId:'v'+i.toString(36).padStart(10,'0'),watchEndpointMusicSupportedConfigs:{watchEndpointMusicConfig:{musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}}});
      const song=i=>({musicResponsiveListItemRenderer:{navigationEndpoint:watch(i),playlistItemData:{videoId:'v'+i.toString(36).padStart(10,'0')},flexColumns:[{musicResponsiveListItemFlexColumnRenderer:{text:run('Independent '+i)}},{musicResponsiveListItemFlexColumnRenderer:{text:run('Synthetic artist')}}],clickTrackingParams:'PRIVATE_TRACKING_SENTINEL'}});
      const video=i=>({musicMultiRowListItemRenderer:{title:run('Independent video '+i),subtitle:run('Synthetic artist'),onTap:watch(i)}});
      const playlist=(i,title,only=true)=>{const ep={browseEndpoint:{browseId:'VLPLindependent'+i,browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:'MUSIC_PAGE_TYPE_PLAYLIST'}}}};return {musicTwoRowItemRenderer:{title:{runs:[{text:title,navigationEndpoint:ep}]},...(only?{}:{navigationEndpoint:ep}),subtitle:run('Playlist')}}};
      const shelf=(rows,title)=>({musicCarouselShelfRenderer:{header:{musicCarouselShelfBasicHeaderRenderer:{title:run(title)}},contents:rows}});
      const page=(shelves,token)=>({contents:{singleColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{selected:true,content:{sectionListRenderer:{contents:shelves,...(token?{continuations:[{nextContinuationData:{continuation:token}}]}:{})}}}}]}}});
      const remote=(rows,token)=>({continuationContents:{musicShelfContinuation:{contents:rows,continuations:token?[{nextContinuationData:{continuation:token}}]:[]}}});
      window.homePage=page([shelf(Array.from({length:37},(_,i)=>song(i)),'Independent A'),shelf(Array.from({length:65},(_,i)=>i===0?song(0):video(i+37)),'Independent B'),shelf(Array.from({length:49},(_,i)=>song(i+102)),'Independent C')],'INDEPENDENT_HOME_PRIVATE');
      const rows=Array.from({length:103},(_,i)=>playlist(i,'First '+i,i%2===0));rows.splice(100,0,playlist(0,'Duplicate must lose'));rows.push(song(0));
      window.libraryPage=page([shelf(rows,'Independent library')],'INDEPENDENT_LIBRARY_PRIVATE');
      window.nativeFetch=function(url,data){window.calls.push({url,data});if(window.rejectFetch)return Promise.reject(Error('Owned provider failure'));if(window.hold)return new Promise(r=>window.held.push(r));if(data.browseId==='FEmusic_home')return Promise.resolve(window.homePage);if(data.browseId==='FEmusic_liked_playlists')return Promise.resolve(window.libraryPage);if(data.continuation==='INDEPENDENT_HOME_PRIVATE')return Promise.resolve(remote([song(999)]));if(data.continuation==='INDEPENDENT_LIBRARY_PRIVATE')return Promise.resolve(remote([playlist(0,'Remote duplicate')],'INDEPENDENT_LIBRARY_LAST'));if(data.continuation==='INDEPENDENT_LIBRARY_LAST')return Promise.resolve(remote([playlist(102,'Remote old'),playlist(103,'New title')]));throw Error('Unexpected recipe');};
      document.querySelector('ytmusic-app').networkManager={fetch:window.nativeFetch};
      window.callbacks={};window.packets=[];
      const ownedIpc={subscribe:(channel,fn)=>{window.callbacks[channel]=fn;return window.musicProof.subscribe(channel,fn);},send:(channel,packet)=>{window.packets.push({type:packet.type,sourceId:packet.sourceId,requestId:packet.requestId});window.musicProof.send(channel,packet);}};
      window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>{window.captureHook?.();return window.api;},ownedIpc);undefined;
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
    const listeners: any[] = [];
    const context = {
      window: win,
      getConfig: () => config,
      setConfig() {},
      refresh() {},
      ipc: {
        send: (...a: any[]) => win.webContents.send(...a),
        on: (channel: string, fn: any) => {
          const h = (_e: any, ...a: any[]) => fn(...a);
          listeners.push([channel, h]);
          f.ipcMain.on(channel, h);
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
    const service = f.source.getMusicService(win);
    const coldBefore = await evaluate('window.calls.length');
    const dialogs: any[] = [];
    const grant = async (name: string, choices: number[]) => {
      let token: string | undefined;
      const menu = await f.source.createMusicGrantMenu(context, () => service, {
        prompt: async () => name,
        show: async (o: any) => {
          dialogs.push({ buttons: o.buttons, detail: o.detail });
          return { response: choices.shift() };
        },
        copy: (v: string) => {
          token = v;
        },
      });
      await menu
        .find((i: any) => i.label.startsWith('Create client grant'))
        .click();
      if (!token) throw Error('Explicit menu copy missing');
      return token;
    };
    const home = await grant('Independent Home', [4, 2, 0]);
    const library = await grant('Independent library', [5, 2, 0]);
    const empty = await grant('Independent toggled empty', [4, 4, 5, 5, 2, 0]);
    const coldAfter = await evaluate('window.calls.length');
    const records = (await service.grants.list()).map((r: any) => ({
      name: r.name,
      scopes: r.scopes,
    }));
    const request = (
      path: string,
      token: string = home,
      extra: any = {},
      body?: string,
      overrideMethod?: string,
    ) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + path,
            method: overrideMethod ?? (body === undefined ? 'GET' : 'POST'),
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + token,
              ...extra,
            },
          },
          (res: any) => {
            let data = '';
            res.on('data', (b: any) => (data += b));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                body: JSON.parse(data),
                cache: res.headers['cache-control'],
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    const wait = async (check: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 4000;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw Error('Missing owned reentry observation');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const firstA = await request('/home?limit=100');
    await request('/home?limit=100&cursor=' + firstA.body.nextCursor);
    const sourceA = await evaluate(
      'window.packets.filter(p=>p.type==="ready").at(-1).sourceId',
    );
    await evaluate('window.hold=true;undefined;');
    const oldPhysical = request('/home');
    await wait(async () => await evaluate('window.held.length===1'));
    await evaluate(
      `window.fetchB=function(...a){return window.nativeFetch(...a)};window.networkB={fetch:window.fetchB};document.querySelector('ytmusic-app').networkManager=window.networkB;window.hold=false;window.controller.refresh();undefined;`,
    );
    const firstB = await request('/home?limit=100');
    const secondB = await request(
      '/home?limit=100&cursor=' + firstB.body.nextCursor,
    );
    const sourceB = await evaluate(
      'window.packets.filter(p=>p.type==="ready").at(-1).sourceId',
    );
    await evaluate(
      `window.canceledGetterCalls=0;window.armCanceledGetter=true;Object.defineProperty(window.networkB,'fetch',{configurable:true,get(){window.canceledGetterCalls++;if(window.armCanceledGetter){window.armCanceledGetter=false;document.querySelector('ytmusic-app').networkManager={fetch:window.nativeFetch};window.controller.refresh();}return window.fetchB;}});window.held.shift()(window.homePage);queueMicrotask(()=>{window.canceledGetterCallsAtSettlement=window.canceledGetterCalls;window.armCanceledGetter=false;Object.defineProperty(window.networkB,'fetch',{configurable:true,writable:true,value:window.fetchB});});undefined;`,
    );
    await wait(
      async () =>
        await evaluate(
          'window.packets.some(p=>p.type==="settled"&&p.sourceId===' +
            JSON.stringify(sourceA) +
            ')',
        ),
    );
    const oldStatus = (await oldPhysical).status;
    const canceledGetterCalls = await evaluate(
      'window.canceledGetterCallsAtSettlement',
    );
    const replayB = await request(
      '/home?limit=100&cursor=' + firstB.body.nextCursor,
    );
    const retiredBBeforeCurrentReentry = await evaluate(
      'window.packets.some(p=>p.type==="retire"&&p.sourceId===' +
        JSON.stringify(sourceB) +
        ')',
    );
    await evaluate(
      `window.fetchC=function(...a){return window.nativeFetch(...a)};window.captureHook=()=>{window.captureHook=undefined;document.querySelector('ytmusic-app').networkManager={fetch:window.fetchC};window.controller.refresh();window.callbacks['peard:music-owner-query']({requestId:'11111111-1111-4111-8111-111111111111',nonce:'b'.repeat(32)});};window.outerRefresh=!!window.controller.refresh();window.nestedSource=window.packets.find(p=>p.requestId==='11111111-1111-4111-8111-111111111111'&&p.type==='ready').sourceId;undefined;`,
    );
    const currentReentry = await evaluate(
      '({outerRefresh:window.outerRefresh,nestedSource:window.nestedSource,retiredNested:window.packets.some(p=>p.type==="retire"&&p.sourceId===window.nestedSource)})',
    );
    const firstC = await request('/home?limit=100');
    const adoptedSourceC = await evaluate(
      'window.packets.filter(p=>p.type==="ready").at(-1).sourceId',
    );
    const secondC = await request(
      '/home?limit=100&cursor=' + firstC.body.nextCursor,
    );
    const replayC = await request(
      '/home?limit=100&cursor=' + firstC.body.nextCursor,
    );
    await evaluate(
      `window.fetchD=function(...a){return window.nativeFetch(...a)};document.querySelector('ytmusic-app').networkManager={fetch:window.fetchD};window.captureHook=()=>{window.captureHook=undefined;window.controller.refresh();window.callbacks['peard:music-owner-query']({requestId:'22222222-2222-4222-8222-222222222222',nonce:'c'.repeat(32)});};window.reenteredIsCurrent=window.controller.isCurrent();window.metadataSource=window.packets.find(p=>p.requestId==='22222222-2222-4222-8222-222222222222'&&p.type==='ready').sourceId;undefined;`,
    );
    const metadata = await evaluate(
      '({isCurrent:window.reenteredIsCurrent,source:window.metadataSource,retired:window.packets.some(p=>p.type==="retire"&&p.sourceId===window.metadataSource)})',
    );
    const firstD = await request('/home?limit=100');
    const adoptedSourceD = await evaluate(
      'window.packets.filter(p=>p.type==="ready").at(-1).sourceId',
    );
    await request('/home?limit=100&cursor=' + firstD.body.nextCursor);
    await evaluate('window.rejectFetch=true;undefined;');
    const failure = await request('/home');
    await evaluate('window.rejectFetch=false;undefined;');
    const replayD = await request(
      '/home?limit=100&cursor=' + firstD.body.nextCursor,
    );
    const healthy = await evaluate('window.controller.isCurrent()');
    await evaluate('window.controller.dispose();undefined;');
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    for (const [c, h] of listeners) f.ipcMain.removeListener(c, h);
    return {
      coldBefore,
      coldAfter,
      firstA: firstA.status,
      firstB: firstB.status,
      secondB: secondB.status,
      oldStatus,
      canceledGetterCalls,
      replayB: replayB.status,
      retiredBBeforeCurrentReentry,
      currentReentry,
      firstC: firstC.status,
      secondC: secondC.status,
      replayC: replayC.status,
      adoptedSourceC,
      metadata,
      firstD: firstD.status,
      adoptedSourceD,
      failure: failure.status,
      replayD: replayD.status,
      healthy,
    };
  });
  console.log('NATIVE_C1_F2_REENTRY ' + JSON.stringify(result));
  expect(result).toMatchObject({
    coldBefore: 0,
    coldAfter: 0,
    firstA: 200,
    firstB: 200,
    secondB: 200,
    oldStatus: 409,
    firstC: 200,
    secondC: 200,
    replayC: 200,
    firstD: 200,
    failure: 502,
    replayD: 200,
    healthy: true,
  });
  expect.soft(result.canceledGetterCalls).toBe(0);
  expect.soft(result.replayB).toBe(200);
  expect.soft(result.retiredBBeforeCurrentReentry).toBe(false);
  expect.soft(result.currentReentry.outerRefresh).toBe(false);
  expect.soft(result.currentReentry.retiredNested).toBe(false);
  expect.soft(result.adoptedSourceC).toBe(result.currentReentry.nestedSource);
  expect.soft(result.metadata.isCurrent).toBe(false);
  expect.soft(result.metadata.retired).toBe(false);
  expect.soft(result.adoptedSourceD).toBe(result.metadata.source);
});
