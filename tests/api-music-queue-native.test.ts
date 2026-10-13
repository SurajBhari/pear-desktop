import { test, expect } from '@playwright/test';
import { musicNative } from './helpers/api-music-native';

test('actual Electron native grant editor raw IPC and REST preserve queue151 literal100+51 and retire ABA', async () => {
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
      window.queueFetches=0;window.queueSubscriptions=new Set();window.queueSelected=120;
      window.queueRows=Array.from({length:151},(_,i)=>({playlistPanelVideoRenderer:{
        videoId:i===120?'selected001':'duplicate01',title:{simpleText:'Native '+i},
        shortBylineText:{runs:[{text:'Native artist'}]},lengthText:{simpleText:'3:35'},
        musicVideoType:'MUSIC_VIDEO_TYPE_ATV',selected:i===120}}));window.originalRows=window.queueRows;
      window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{
        videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),
        getCurrentTime:()=>1.2345,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,
        addEventListener:()=>{},removeEventListener:()=>{}};
      const element=document.createElement('div');element.id='queue';document.body.append(element);
      window.nativeQueue={getItems:()=>window.queueRows,store:{store:{
        getState:()=>({queue:{items:window.queueRows,selectedItemIndex:window.queueSelected}}),
        subscribe:fn=>{window.queueSubscriptions.add(fn);return()=>window.queueSubscriptions.delete(fn)}}}};
      element.queue=window.nativeQueue;
      document.querySelector('ytmusic-app').networkManager={fetch:()=>{window.queueFetches++;throw Error('queue must not fetch')}};
      window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,window.musicProof);
      undefined;
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
    const choices = [0, 1, 2, 0];
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
            path: '/api/v1/music/queue' + query,
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
    const first = await request('?limit=100');
    const second = await request('?limit=100&cursor=' + first.body.nextCursor);
    const replay = await request('?limit=100&cursor=' + first.body.nextCursor);
    await evaluate(
      `window.queueRows=[...window.originalRows].reverse();window.queueSelected=30;for(const fn of [...window.queueSubscriptions])fn();window.queueRows=window.originalRows;window.queueSelected=120;for(const fn of [...window.queueSubscriptions])fn();undefined;`,
    );
    const stale = await request('?limit=100&cursor=' + first.body.nextCursor);
    const fresh = await request('?limit=100');
    await evaluate(
      `{const element=document.querySelector('#queue');element.remove();document.body.append(element);}undefined;`,
    );
    const domStale = await request(
      '?limit=100&cursor=' + fresh.body.nextCursor,
    );
    const domFresh = await request('?limit=100');
    await evaluate(
      `window.queueRows=[];window.queueSelected=-1;for(const fn of [...window.queueSubscriptions])fn();undefined;`,
    );
    const empty = await request();
    await evaluate(
      `document.querySelector('#queue').queue=undefined;undefined;`,
    );
    const missing = await request();
    await evaluate(
      `document.querySelector('#queue').queue=window.nativeQueue;undefined;`,
    );
    const restored = await request();
    const fetches = await evaluate('window.queueFetches');
    await evaluate('window.controller.dispose();undefined;');
    const subscriptionsAfterDispose = await evaluate(
      'window.queueSubscriptions.size',
    );
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    f.ipcMain.removeListener('peard:music-reply', observe);
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    return {
      first: {
        status: first.status,
        body: {
          total: first.body.total,
          selectedIndex: first.body.selectedIndex,
          count: first.body.items.length,
          first: first.body.items[0],
          last: first.body.items[99],
        },
      },
      second: {
        status: second.status,
        body: {
          count: second.body.items.length,
          selected: second.body.items[20],
          last: second.body.items[50],
          nextCursor: second.body.nextCursor,
        },
      },
      replayEqual: JSON.stringify(replay) === JSON.stringify(second),
      stale: stale.status,
      fresh: fresh.status,
      domStale: domStale.status,
      domFresh: domFresh.status,
      changedRevision: fresh.body.queueRevision !== first.body.queueRevision,
      empty,
      missing: missing.status,
      restored: restored.status,
      fetches,
      exactMainReplies,
      foreignReplies,
      subscriptionsAfterDispose,
    };
  });
  expect(result.first.status).toBe(200);
  expect(result.first.body).toMatchObject({ total: 151, selectedIndex: 120 });
  expect(result.first.body.count).toBe(100);
  expect(result.first.body.first).toMatchObject({
    index: 0,
    item: { id: 'duplicate01', title: 'Native 0' },
  });
  expect(result.first.body.last).toMatchObject({
    index: 99,
    item: { id: 'duplicate01', title: 'Native 99' },
  });
  expect(result.second.status).toBe(200);
  expect(result.second.body.count).toBe(51);
  expect(result.second.body.selected).toMatchObject({
    index: 120,
    selected: true,
    item: { id: 'selected001', title: 'Native 120' },
  });
  expect(result.second.body.last.index).toBe(150);
  expect(result.second.body.nextCursor).toBeNull();
  expect(result.replayEqual).toBe(true);
  expect(result).toMatchObject({
    domStale: 409,
    domFresh: 200,
    stale: 409,
    fresh: 200,
    changedRevision: true,
    missing: 503,
    restored: 200,
    fetches: 0,
    foreignReplies: 0,
    subscriptionsAfterDispose: 0,
  });
  expect(result.empty).toMatchObject({
    status: 200,
    body: { total: 0, selectedIndex: null, items: [], nextCursor: null },
  });
  expect(result.exactMainReplies).toBe(10);
});

test('review native final queue getter replacement must retire endpoint response', async () => {
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
      window.queueFetches=0;window.queueSubscriptions=new Set();window.queueSelected=120;
      window.queueRows=Array.from({length:151},(_,i)=>({playlistPanelVideoRenderer:{
        videoId:i===120?'selected001':'duplicate01',title:{simpleText:'Native '+i},
        shortBylineText:{runs:[{text:'Native artist'}]},lengthText:{simpleText:'3:35'},
        musicVideoType:'MUSIC_VIDEO_TYPE_ATV',selected:i===120}}));window.originalRows=window.queueRows;
      window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{
        videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),
        getCurrentTime:()=>1.2345,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,
        addEventListener:()=>{},removeEventListener:()=>{}};
      const element=document.createElement('div');element.id='queue';document.body.append(element);
      window.nativeQueue={getItems:()=>window.queueRows,store:{store:{
        getState:()=>({queue:{items:window.queueRows,selectedItemIndex:window.queueSelected}}),
        subscribe:fn=>{window.queueSubscriptions.add(fn);return()=>window.queueSubscriptions.delete(fn)}}}};
      element.queue=window.nativeQueue;
      document.querySelector('ytmusic-app').networkManager={fetch:()=>{window.queueFetches++;throw Error('queue must not fetch')}};
      window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,window.musicProof);
      undefined;
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
    const choices = [0, 1, 2, 0];
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
            path: '/api/v1/music/queue' + query,
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
    const first=await request('?limit=100');
    await evaluate(`window.originalGet=window.nativeQueue.getItems;window.getterCalls=0;window.threshold=Infinity;window.triggered=false;Object.defineProperty(window.nativeQueue,'getItems',{configurable:true,get(){if(++window.getterCalls===window.threshold){window.triggered=true;document.querySelector('#queue').queue={getItems:window.originalGet,store:window.nativeQueue.store};}return window.originalGet}});undefined;`);
    const warm=await request('?limit=100');
    const count=await evaluate('window.getterCalls');
    await evaluate(`window.getterCalls=0;window.threshold=${count};undefined;`);
    const raced=await request('?limit=100');
    const trigger=await evaluate('({triggered:window.triggered,calls:window.getterCalls})');
    await evaluate(`window.threshold=Infinity;document.querySelector('#queue').queue=window.nativeQueue;undefined;`);
    const recovery=await request('?limit=100');
    const remainder=await request('?limit=100&cursor='+recovery.body.nextCursor);
    const fetches=await evaluate('window.queueFetches');
    await evaluate('window.controller.dispose();undefined;');
    const subscriptionsAfterDispose=await evaluate('window.queueSubscriptions.size');
    const server=f.source.backend.server,closed=new Promise<void>(r=>server.once('close',r));f.source.backend.stop();await closed;
    f.ipcMain.removeListener('peard:music-reply',observe);for(const [channel,h] of listeners)f.ipcMain.removeListener(channel,h);
    return {first:first.status,warm:warm.status,count,trigger,raced:{status:raced.status,total:raced.body.total},recovery:{status:recovery.status,total:recovery.body.total,count:recovery.body.items.length},remainder:{status:remainder.status,count:remainder.body.items.length},fetches,exactMainReplies,foreignReplies,subscriptionsAfterDispose};
  });
  console.log('NATIVE_QUEUE_FINAL_GETTER '+JSON.stringify(result));
  expect(result.first).toBe(200);expect(result.warm).toBe(200);expect(result.trigger.triggered).toBe(true);
  expect(result.recovery).toEqual({status:200,total:151,count:100});expect(result.remainder).toEqual({status:200,count:51});expect(result.fetches).toBe(0);expect(result.foreignReplies).toBe(0);expect(result.subscriptionsAfterDispose).toBe(0);
  expect(result.raced.status).toBe(409);
});

test('review queue cursor uses shared native physical tombstones and rejects another principal', async () => {
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
      window.queueFetches=0;window.queueSubscriptions=new Set();window.queueSelected=120;
      window.queueRows=Array.from({length:151},(_,i)=>({playlistPanelVideoRenderer:{
        videoId:i===120?'selected001':'duplicate01',title:{simpleText:'Native '+i},
        shortBylineText:{runs:[{text:'Native artist'}]},lengthText:{simpleText:'3:35'},
        musicVideoType:'MUSIC_VIDEO_TYPE_ATV',selected:i===120}}));window.originalRows=window.queueRows;
      window.api={getVideoData:()=>({video_id:'current0001'}),getPlayerResponse:()=>({videoDetails:{
        videoId:'current0001',title:'Native current',author:'Native artist',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),
        getCurrentTime:()=>1.2345,getDuration:()=>215,getVolume:()=>77,getPlayerState:()=>1,
        addEventListener:()=>{},removeEventListener:()=>{}};
      const element=document.createElement('div');element.id='queue';document.body.append(element);
      window.nativeQueue={getItems:()=>window.queueRows,store:{store:{
        getState:()=>({queue:{items:window.queueRows,selectedItemIndex:window.queueSelected}}),
        subscribe:fn=>{window.queueSubscriptions.add(fn);return()=>window.queueSubscriptions.delete(fn)}}}};
      element.queue=window.nativeQueue;
      document.querySelector('ytmusic-app').networkManager={fetch:()=>{window.queueFetches++;throw Error('queue must not fetch')}};
      window.hold=false;window.held=[];window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(window.hold&&packet.type==='settled')window.held.push(packet);else window.musicProof.send(channel,packet)}});
      undefined;
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
    const choices = [0, 1, 2, 0];
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
            path: '/api/v1/music/queue' + query,
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
    const wait=async(fn:()=>any)=>{const end=Date.now()+5000;while(!(await fn())){if(Date.now()>end)throw Error('Missing shared pool observation');await new Promise(r=>setTimeout(r,5));}};
    const first=await request('?limit=100');const input={limit:100,cursor:first.body.nextCursor};
    const other=await service.grants.issue('Other controlled reader','rest',service.resource,['playback.read'],()=>true);
    const foreign=await service.queue(other.token,input).then(()=> 'unexpected', (e:any)=>e.code);
    const broker=f.source.createMusicRequestBroker(window);
    await evaluate('window.hold=true;undefined;');
    const controls=Array.from({length:4},()=>new AbortController());
    const calls=controls.map((c,i)=>broker.read(broker.capture(),{operation:i%2?'current':'queue'},i<2?'physical-A':'physical-B',{signal:c.signal}).then(()=> 'ok',(e:any)=>e.code));
    await wait(async()=>await evaluate('window.held.length===4'));
    const continuation=service.queue(token,input);
    await wait(()=>broker.stats().queued===1);
    controls[0].abort();const canceled=await calls[0],afterCancel=broker.stats();
    await evaluate(`window.oldSettled=window.held.shift();window.musicProof.send('peard:music-reply',{...window.oldSettled,nonce:'f'.repeat(32)});undefined;`);
    const afterWrong=broker.stats();
    await evaluate(`window.musicProof.send('peard:music-reply',window.oldSettled);undefined;`);
    await wait(async()=>await evaluate('window.held.length===4'));
    const afterExact=broker.stats();
    await evaluate(`window.hold=false;for(const packet of window.held.splice(0))window.musicProof.send('peard:music-reply',packet);undefined;`);
    const page=await continuation;await Promise.all(calls);await wait(()=>broker.stats().dispatched===0);
    const beforeReplay=exactMainReplies;const replay=await service.queue(token,input);const replayPhysical=exactMainReplies-beforeReplay;
    const fetches=await evaluate('window.queueFetches');await evaluate('window.controller.dispose();undefined;');
    const server=f.source.backend.server,closed=new Promise<void>(r=>server.once('close',r));f.source.backend.stop();await closed;f.ipcMain.removeListener('peard:music-reply',observe);for(const [channel,h]of listeners)f.ipcMain.removeListener(channel,h);
    return {first:first.status,foreign,canceled,afterCancel,afterWrong,afterExact,count:page.items.length,selected:page.items[20].index,replayEqual:JSON.stringify(page)===JSON.stringify(replay),replayPhysical,fetches,foreignReplies};
  });
  console.log('NATIVE_QUEUE_POOL '+JSON.stringify(result));expect(result.first).toBe(200);expect(result.foreign).toBe('not_found');expect(result.canceled).toBe('retired');
  expect(result.afterCancel).toMatchObject({dispatched:4,queued:1});expect(result.afterWrong).toMatchObject({dispatched:4,queued:1});expect(result.afterExact).toMatchObject({dispatched:4,queued:0});expect(result.count).toBe(51);expect(result.selected).toBe(120);expect(result.replayEqual).toBe(true);expect(result.replayPhysical).toBe(1);expect(result.fetches).toBe(0);expect(result.foreignReplies).toBe(0);
});
