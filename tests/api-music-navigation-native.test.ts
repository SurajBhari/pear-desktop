import { test, expect } from '@playwright/test';
import { musicNative } from './helpers/api-music-native';

test('N1 actual native prepared navigation six positive recipes and immutable replay', async () => {
  const proof = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof;
    const seeds = [
      {
        'name': 'ordinary-song',
        'command': {
          'action': 'play_song',
          'videoId': 'seedVideo01',
          'playlistId': 'PL_N1PlaylistA',
        },
        'raw': null,
        'expected': {
          'watchEndpoint': {
            'videoId': 'seedVideo01',
            'playlistId': 'PL_N1PlaylistA',
          },
        },
      },
      {
        'name': 'ordinary-playlist',
        'command': {
          'action': 'play_playlist',
          'playlistId': 'PL_N1PlaylistA',
          'shuffle': false,
        },
        'raw': null,
        'expected': {
          'watchPlaylistEndpoint': { 'playlistId': 'PL_N1PlaylistA' },
        },
      },
      {
        'name': 'shuffled-playlist',
        'command': {
          'action': 'play_playlist',
          'playlistId': 'PL_N1PlaylistA',
          'shuffle': true,
        },
        'raw': {
          'header': {
            'musicResponsiveHeaderRenderer': {
              'buttons': [
                {
                  'buttonRenderer': {
                    'icon': { 'iconType': 'MUSIC_SHUFFLE' },
                    'navigationEndpoint': {
                      'watchPlaylistEndpoint': {
                        'playlistId': 'PL_N1PlaylistA',
                        'params': 'opaqueShuffleSeedA',
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        'expected': {
          'watchPlaylistEndpoint': {
            'playlistId': 'PL_N1PlaylistA',
            'params': 'opaqueShuffleSeedA',
          },
        },
      },
      {
        'name': 'video-radio',
        'command': {
          'action': 'radio',
          'seed': { 'kind': 'video', 'videoId': 'seedVideo01' },
        },
        'raw': {
          'contents': {
            'singleColumnMusicWatchNextResultsRenderer': {
              'tabbedRenderer': {
                'watchNextTabbedResultsRenderer': {
                  'tabs': [
                    {
                      'tabRenderer': {
                        'content': {
                          'musicQueueRenderer': {
                            'content': {
                              'playlistPanelRenderer': {
                                'playlistId': 'PL_N1QueueSource',
                                'contents': [
                                  {
                                    'playlistPanelVideoRenderer': {
                                      'videoId': 'seedVideo01',
                                      'navigationEndpoint': {
                                        'watchEndpoint': {
                                          'videoId': 'seedVideo01',
                                        },
                                      },
                                      'menu': {
                                        'menuRenderer': {
                                          'items': [
                                            {
                                              'menuNavigationItemRenderer': {
                                                'icon': { 'iconType': 'MIX' },
                                                'navigationEndpoint': {
                                                  'watchEndpoint': {
                                                    'videoId': 'seedVideo01',
                                                    'playlistId':
                                                      'RDSERVICE_video_A',
                                                    'params':
                                                      'opaqueRadioVideoB',
                                                  },
                                                },
                                              },
                                            },
                                          ],
                                        },
                                      },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        'expected': {
          'watchEndpoint': {
            'videoId': 'seedVideo01',
            'playlistId': 'RDSERVICE_video_A',
            'params': 'opaqueRadioVideoB',
          },
        },
      },
      {
        'name': 'playlist-radio',
        'command': {
          'action': 'radio',
          'seed': { 'kind': 'playlist', 'playlistId': 'PL_N1PlaylistA' },
        },
        'raw': {
          'header': {
            'musicResponsiveHeaderRenderer': {
              'buttons': [
                {
                  'buttonRenderer': {
                    'icon': { 'iconType': 'MIX' },
                    'navigationEndpoint': {
                      'watchPlaylistEndpoint': {
                        'playlistId': 'RDSERVICE_playlist_C',
                        'params': 'opaqueRadioPlaylistC',
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        'expected': {
          'watchPlaylistEndpoint': {
            'playlistId': 'RDSERVICE_playlist_C',
            'params': 'opaqueRadioPlaylistC',
          },
        },
      },
      {
        'name': 'current-radio',
        'command': { 'action': 'radio', 'seed': { 'kind': 'current' } },
        'raw': {
          'contents': {
            'singleColumnMusicWatchNextResultsRenderer': {
              'tabbedRenderer': {
                'watchNextTabbedResultsRenderer': {
                  'tabs': [
                    {
                      'tabRenderer': {
                        'content': {
                          'musicQueueRenderer': {
                            'content': {
                              'playlistPanelRenderer': {
                                'playlistId': 'PL_N1QueueSource',
                                'contents': [
                                  {
                                    'playlistPanelVideoRenderer': {
                                      'videoId': 'seedVideo03',
                                      'navigationEndpoint': {
                                        'watchEndpoint': {
                                          'videoId': 'seedVideo03',
                                        },
                                      },
                                      'menu': {
                                        'menuRenderer': {
                                          'items': [
                                            {
                                              'menuNavigationItemRenderer': {
                                                'icon': { 'iconType': 'MIX' },
                                                'navigationEndpoint': {
                                                  'watchEndpoint': {
                                                    'videoId': 'seedVideo03',
                                                    'playlistId':
                                                      'RDSERVICE_current_D',
                                                    'params':
                                                      'opaqueRadioCurrentD',
                                                  },
                                                },
                                              },
                                            },
                                          ],
                                        },
                                      },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        'expected': {
          'watchEndpoint': {
            'videoId': 'seedVideo03',
            'playlistId': 'RDSERVICE_current_D',
            'params': 'opaqueRadioCurrentD',
          },
        },
      },
    ];
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
      },
    });
    await window.loadFile(f.owned + '/main.html');
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(`window.video='seedVideo03';window.identityReads=0;window.broadReads=0;window.fetches=[];window.dispatches=[];window.listeners={};window.raw={};window.selfTransition=false;window.hold=false;window.resolvers=[];window.holdAck=false;window.ackPackets=[];
      window.api={getVideoData(){window.identityReads++;return {video_id:window.video};},getPlayerResponse(){window.identityReads++;return {videoDetails:{videoId:window.video}};},getCurrentTime(){window.broadReads++;throw Error('Broad getter');},getDuration(){window.broadReads++;throw Error('Broad getter');},getVolume(){window.broadReads++;throw Error('Broad getter');},getPlayerState(){window.broadReads++;throw Error('Broad getter');},addEventListener(k,fn){window.listeners[k]=fn;},removeEventListener(k){delete window.listeners[k];}};
      const app=document.querySelector('ytmusic-app');app.networkManager={fetch:function(url,data){window.fetches.push({url,data,receiver:this===app.networkManager});if(window.hold)return new Promise(resolve=>window.resolvers.push(resolve));return Promise.resolve(window.raw);}};
      app.addEventListener('yt-navigate',e=>{window.dispatches.push({receiver:e.target===app,endpoint:e.detail.endpoint});if(window.selfTransition){window.video='other000001';window.listeners.videodatachange();}});
      window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(window.holdAck&&packet.type==='settled')window.ackPackets.push(packet);else window.musicProof.send(channel,packet)}});undefined;`);
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
    const service = f.source.getMusicService(window),
      choices = [6, 2, 0];
    let token: string | undefined;
    const menu = await f.source.createMusicGrantMenu(
      { ...context, refresh() {} },
      () => service,
      {
        prompt: async () => 'Owned N1 control',
        show: async () => ({ response: choices.shift() }),
        copy: (v: string) => {
          token = v;
        },
      },
    );
    await menu
      .find((item: any) => item.label === 'Create client grant…')
      .click();
    if (!token) throw Error('Missing playback control grant');
    const request = (target: string, method = 'GET', body?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + target,
            method,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + token,
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
          },
          (response: any) => {
            let text = '';
            response.on('data', (chunk: any) => (text += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(text) }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const cold = await evaluate(
      '({identity:window.identityReads,broad:window.broadReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
    );
    let brokerCalls = 0;
    const broker = f.source.createMusicRequestBroker(window),
      originalRead = broker.read;
    broker.read = function (...args: any[]) {
      brokerCalls++;
      return originalRead.apply(this, args);
    };
    const bindings: any[] = [];
    const observer = (event: any, packet: any) => {
      if (
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        packet.type === 'settled' &&
        packet.result?.value?.binding
      )
        bindings.push({
          documentId: packet.documentId,
          binding: packet.result.value.binding,
        });
    };
    f.ipcMain.on('peard:music-reply', observer);
    const results: any[] = [];
    for (const seed of seeds) {
      await evaluate(
        `window.raw=${JSON.stringify(seed.raw ?? {})};window.video='seedVideo03';window.selfTransition=${seed.name === 'current-radio'};undefined;`,
      );
      const before = await evaluate(
          '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
        ),
        beforeBroker = brokerCalls;
      const preparedReply = await request(
          '/operations/prepare',
          'POST',
          seed.command,
        ),
        prepared = preparedReply.body;
      const { action, ...args } = seed.command;
      const route =
        action === 'play_song'
          ? '/play/song'
          : action === 'play_playlist'
            ? '/play/playlist'
            : '/radio';
      const afterPrepare = await evaluate(
        '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
      );
      const receiptReply = await request(route, 'POST', {
          ...args,
          operationId: prepared.operationId,
        }),
        receipt = receiptReply.body;
      const afterExecute = await evaluate(
        '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
      );
      const replayReply = await request(route, 'POST', {
          ...args,
          operationId: prepared.operationId,
        }),
        statusReply = await request('/operations/' + prepared.operationId),
        replay = replayReply.body,
        status = statusReply.body;
      const afterReplay = await evaluate(
        '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
      );
      results.push({
        name: seed.name,
        httpStatuses: [
          preparedReply.status,
          receiptReply.status,
          replayReply.status,
          statusReply.status,
        ],
        prepared,
        receipt,
        replay,
        status,
        before,
        afterPrepare,
        afterExecute,
        afterReplay,
        brokerCalls: brokerCalls - beforeBroker,
        event: await evaluate('window.dispatches.at(-1)'),
        expected: seed.expected,
      });
    }
    const fences: any[] = [];
    for (const mode of ['B', 'ABA']) {
      const current = seeds.find((s) => s.name === 'current-radio')!;
      await evaluate(
        `window.hold=true;window.resolvers=[];window.selfTransition=false;window.video='seedVideo03';window.listeners.videodatachange();window.raw=${JSON.stringify(current.raw)};undefined;`,
      );
      const prepared = await service.prepare(token, current.command),
        beforeBroker = brokerCalls;
      const pending = service.navigate(token, {
        ...current.command,
        operationId: prepared.operationId,
      });
      const end = Date.now() + 5000;
      while (!(await evaluate('window.resolvers.length===1'))) {
        if (Date.now() >= end) throw Error('Current native probe missing');
        await new Promise((r) => setTimeout(r, 5));
      }
      const before = await evaluate('window.dispatches.length');
      await evaluate(
        `window.video='other000001';window.listeners.videodatachange();${mode === 'ABA' ? "window.video='seedVideo03';window.listeners.videodatachange();" : ''}window.resolvers[0](window.raw);undefined;`,
      );
      const receipt = await pending,
        after = await evaluate(
          '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
        );
      const replay = await service.navigate(token, {
          ...current.command,
          operationId: prepared.operationId,
        }),
        status = await service.operation(token, prepared.operationId),
        afterReplay = await evaluate(
          '({identity:window.identityReads,fetches:window.fetches.length,dispatches:window.dispatches.length})',
        );
      fences.push({
        mode,
        receipt,
        replay,
        status,
        before,
        after,
        afterReplay,
        brokerCalls: brokerCalls - beforeBroker,
      });
    }
    await evaluate(
      'window.hold=false;window.holdAck=true;window.ackPackets=[];undefined;',
    );
    const lostCommand = { action: 'play_song', videoId: 'seedVideo01' },
      lostPrepared = await service.prepare(token, lostCommand),
      beforeLostBroker = brokerCalls,
      beforeLostEvents = await evaluate('window.dispatches.length');
    const lostResult = await service
      .navigate(
        token,
        { ...lostCommand, operationId: lostPrepared.operationId },
        undefined,
        Date.now() + 80,
      )
      .catch((error: any) => error.code);
    const deadline = Date.now() + 5000;
    while (!(await evaluate('window.ackPackets.length===1'))) {
      if (Date.now() >= deadline) throw Error('Missing lost native ACK');
      await new Promise((r) => setTimeout(r, 5));
    }
    const statusBefore = await service.operation(
        token,
        lostPrepared.operationId,
      ),
      replayBefore = await service.navigate(token, {
        ...lostCommand,
        operationId: lostPrepared.operationId,
      }),
      beforeAck = broker.stats().dispatched;
    const latePhase = await evaluate('window.ackPackets[0].result.value.phase');
    await evaluate(
      "window.musicProof.send('peard:music-reply',window.ackPackets[0]);window.musicProof.send('peard:music-reply',window.ackPackets[0]);undefined;",
    );
    while (broker.stats().dispatched) {
      if (Date.now() >= deadline)
        throw Error('Late native ACK did not release capacity');
      await new Promise((r) => setTimeout(r, 5));
    }
    const statusAfter = await service.operation(
        token,
        lostPrepared.operationId,
      ),
      replayAfter = await service.navigate(token, {
        ...lostCommand,
        operationId: lostPrepared.operationId,
      });
    const uncertainty = {
      lostResult,
      statusBefore,
      replayBefore,
      statusAfter,
      replayAfter,
      beforeAck,
      afterAck: broker.stats().dispatched,
      latePhase,
      brokerCalls: brokerCalls - beforeLostBroker,
      dispatches:
        (await evaluate('window.dispatches.length')) - beforeLostEvents,
    };
    f.ipcMain.removeListener('peard:music-reply', observer);
    const final = await evaluate(
      '({broad:window.broadReads,fetches:window.fetches})',
    );
    const server = f.source.backend.server,
      closed = new Promise<void>((r) => server.once('close', r));
    f.source.backend.stop();
    await closed;
    for (const [channel, h] of listeners) f.ipcMain.removeListener(channel, h);
    window.destroy();
    return { cold, results, final, bindings, fences, uncertainty };
  });
  expect(proof.cold).toEqual({
    identity: 0,
    broad: 0,
    fetches: 0,
    dispatches: 0,
  });
  expect(proof.results).toHaveLength(6);
  for (const row of proof.results) {
    expect(row.httpStatuses).toEqual([200, 200, 200, 200]);
    expect(row.afterPrepare).toEqual(row.before);
    expect(row.receipt).toEqual({
      operationId: row.prepared.operationId,
      status: 'accepted',
      meaning: 'owned_navigation_dispatch',
    });
    expect(row.replay).toEqual(row.receipt);
    expect(row.status).toEqual(row.receipt);
    expect(row.afterReplay).toEqual(row.afterExecute);
    expect(row.brokerCalls).toBe(1);
    expect(row.afterExecute.dispatches - row.before.dispatches).toBe(1);
    expect(row.event).toEqual({ receiver: true, endpoint: row.expected });
    if (row.name !== 'current-radio')
      expect(row.afterExecute.identity).toBe(row.before.identity);
  }
  expect(proof.uncertainty.lostResult).toBe('timeout');
  expect(proof.uncertainty.statusBefore).toMatchObject({
    status: 'uncertain',
    error: 'outcome_unknown',
  });
  expect(proof.uncertainty.statusAfter).toEqual(proof.uncertainty.statusBefore);
  expect(proof.uncertainty.replayBefore).toEqual(
    proof.uncertainty.statusBefore,
  );
  expect(proof.uncertainty.replayAfter).toEqual(proof.uncertainty.statusBefore);
  expect(proof.uncertainty.beforeAck).toBe(1);
  expect(proof.uncertainty.afterAck).toBe(0);
  expect(proof.uncertainty.brokerCalls).toBe(1);
  expect(proof.uncertainty.dispatches).toBe(1);
  expect(proof.uncertainty.latePhase).toBe('owned_dispatch');
  expect(proof.final.broad).toBe(0);
  expect(proof.final.fetches).toHaveLength(6);
  expect(proof.bindings).toHaveLength(1);
  expect(proof.bindings[0].binding.videoId).toBe('seedVideo03');
  expect(proof.bindings[0].binding.playbackEpoch).toMatch(
    /^[0-9a-f]{32}:[0-9a-f]{32}$/,
  );
  expect(proof.bindings[0].binding.playbackEpoch.split(':')[0]).toBe(
    proof.bindings[0].documentId,
  );
  for (const row of proof.fences) {
    expect(row.receipt).toMatchObject({ status: 'failed', error: 'retired' });
    expect(row.replay).toEqual(row.receipt);
    expect(row.status).toEqual(row.receipt);
    expect(row.afterReplay).toEqual(row.after);
    expect(row.after.dispatches).toBe(row.before);
    expect(row.brokerCalls).toBe(1);
  }
  expect(proof.final.fetches.every((call: any) => call.receiver)).toBe(true);
  console.log('N1_NATIVE_PROOF ' + JSON.stringify(proof));
});

// F2 R1: genuine native windows and actual HTTP must fence all receipt phases.
test('N1 F2 actual native original context rejects pending executing and terminal receipt access', async () => {
  const proof = await musicNative(async () => {
    const f = (globalThis as any).MusicNativeProof,
      http = require('node:http');
    const reserve = http.createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const port = reserve.address().port;
    await new Promise<void>((resolve) => reserve.close(resolve));
    const make = () =>
      new f.BrowserWindow({
        show: false,
        webPreferences: {
          preload: f.preload,
          contextIsolation: true,
          sandbox: true,
        },
      });
    const window = make();
    await window.loadFile(f.owned + '/main.html');
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code);
    await evaluate(f.bundle);
    await evaluate(
      `window.identityReads=0;window.fetches=0;window.dispatches=[];window.holdAck=false;window.acks=[];window.api={getVideoData(){window.identityReads++;return {video_id:'seedVideo01'};},getPlayerResponse(){window.identityReads++;return {videoDetails:{videoId:'seedVideo01'}};},addEventListener(){},removeEventListener(){}};const app=document.querySelector('ytmusic-app');app.networkManager={fetch(){window.fetches++;return Promise.resolve({header:{musicResponsiveHeaderRenderer:{buttons:[]}}});}};app.addEventListener('yt-navigate',event=>window.dispatches.push({receiver:event.target===app,endpoint:event.detail.endpoint}));window.controller=MusicNativeSource.createMusicRendererController(window.api,()=>window.api,{subscribe:window.musicProof.subscribe,send:(channel,packet)=>{if(window.holdAck&&packet.type==='settled')window.acks.push(packet);else window.musicProof.send(channel,packet)}});undefined;`,
    );
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
            const listener = (_event: any, ...args: any[]) => fn(...args);
            listeners.push([channel, listener]);
            f.ipcMain.on(channel, listener);
          },
          handle: (channel: string, fn: any) => f.ipcMain.handle(channel, fn),
          removeHandler: (channel: string) => f.ipcMain.removeHandler(channel),
        },
      };
    await f.source.backend.start(context);
    if (!f.source.backend.server.listening)
      await new Promise<void>((resolve) =>
        f.source.backend.server.once('listening', resolve),
      );
    const service = f.source.getMusicService(window),
      grant = await service.grants.issue(
        'Owned F2 context',
        'rest',
        service.resource,
        ['playback.control'],
        () => true,
      ),
      token = grant.token;
    const request = (path: string, method = 'GET', body?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/v1/music' + path,
            method,
            headers: {
              host: '127.0.0.1:' + port,
              authorization: 'Bearer ' + token,
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
          },
          (response: any) => {
            let text = '';
            response.on('data', (chunk: any) => (text += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(text) }),
            );
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const wait = async (check: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() >= end)
          throw Error('Missing F2 native context observation');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const broker = f.source.createMusicRequestBroker(window),
      originalRead = broker.read;
    let originalBrokerCalls = 0;
    broker.read = function (...args: any[]) {
      originalBrokerCalls++;
      return originalRead.apply(this, args);
    };
    const records: any[] = [];
    for (const phase of [
      'pending',
      'executing',
      'accepted',
      'failed',
      'uncertain',
      'retired',
    ])
      for (const mode of ['foreign-window', 'same-window-new-service']) {
        f.source.backend.musicService = service;
        await evaluate(
          `window.holdAck=${phase === 'executing' || phase === 'uncertain'};window.acks=[];undefined;`,
        );
        const command: any =
          phase === 'failed'
            ? {
                action: 'play_playlist',
                playlistId: 'PL_N1PlaylistA',
                shuffle: true,
              }
            : { action: 'play_song', videoId: 'seedVideo01' };
        const route = phase === 'failed' ? '/play/playlist' : '/play/song',
          { action: _action, ...args } = command;
        const prepared = await request('/operations/prepare', 'POST', command),
          id = prepared.body.operationId,
          body = { ...args, operationId: id },
          beforeOriginalBroker = originalBrokerCalls,
          beforeOriginalDispatch = await evaluate('window.dispatches.length');
        const row = service.operations.lookup(
          id,
          grant.record,
          service.resource,
        );
        let executing: Promise<any> | undefined;
        if (phase === 'executing') {
          executing = service.navigate(token, { ...command, operationId: id });
          await wait(async () => await evaluate('window.acks.length===1'));
        } else if (phase === 'uncertain') {
          await service
            .navigate(
              token,
              { ...command, operationId: id },
              undefined,
              Date.now() + 80,
            )
            .catch((error: any) => error.code);
          await wait(async () => await evaluate('window.acks.length===1'));
        } else if (phase === 'accepted' || phase === 'failed')
          await request(route, 'POST', body);
        else if (phase === 'retired') service.configure(config);
        const before = {
            receipt: { ...row.receipt },
            expires: row.expires,
            physicalHold: row.physicalHold,
            executing: row.executing,
          },
          beforeNative = await evaluate(
            '({identity:window.identityReads,fetches:window.fetches,dispatches:window.dispatches.length})',
          );
        const other = mode === 'foreign-window' ? make() : window;
        if (other !== window) await other.loadFile(f.owned + '/main.html');
        const second = new service.constructor({
            window: other,
            config,
            grants: service.grants,
          }),
          secondBroker = f.source.createMusicRequestBroker(other),
          secondRead = secondBroker.read;
        let foreignBrokerCalls = 0;
        secondBroker.read = function (...values: any[]) {
          foreignBrokerCalls++;
          return secondRead.apply(this, values);
        };
        f.source.backend.musicService = second;
        const status = await request('/operations/' + id);
        let returned = false;
        const replayPromise = request(route, 'POST', body).then((reply) => {
          returned = true;
          return reply;
        });
        const until = Date.now() + 150;
        while (!returned && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 5));
        const rejectedBeforeOriginalSettlement = returned,
          afterRequests = {
            receipt: { ...row.receipt },
            expires: row.expires,
            physicalHold: row.physicalHold,
            executing: row.executing,
          };
        if (phase === 'executing') {
          await evaluate(
            "window.musicProof.send('peard:music-reply',window.acks.shift());undefined;",
          );
          await executing;
        }
        const replay = await replayPromise;
        secondBroker.read = secondRead;
        f.source.backend.musicService = service;
        second.stop();
        if (other !== window) other.destroy();
        const afterNative = await evaluate(
          '({identity:window.identityReads,fetches:window.fetches,dispatches:window.dispatches.length})',
        );
        let originalStatus: any, originalReplay: any;
        if (phase !== 'retired') {
          originalStatus = await request('/operations/' + id);
          if (phase !== 'pending')
            originalReplay = await request(route, 'POST', body);
        }
        let afterLateAck: any;
        if (phase === 'uncertain') {
          await evaluate(
            "window.musicProof.send('peard:music-reply',window.acks.shift());undefined;",
          );
          await wait(() => broker.stats().dispatched === 0);
          afterLateAck = await request('/operations/' + id);
        }
        if (phase === 'pending')
          originalReplay = await request(route, 'POST', body);
        records.push({
          phase,
          mode,
          status,
          replay,
          rejectedBeforeOriginalSettlement,
          before,
          afterRequests,
          beforeNative,
          afterNative,
          foreignBrokerCalls,
          originalStatus,
          originalReplay,
          afterLateAck,
          originalBrokerCalls: originalBrokerCalls - beforeOriginalBroker,
          originalDispatches:
            (await evaluate('window.dispatches.length')) -
            beforeOriginalDispatch,
        });
      }
    // A committed replacement supplies real generation/document termination. Access
    // under its new admission must not project the original pending receipt.
    const replacement = await request('/operations/prepare', 'POST', {
        action: 'play_song',
        videoId: 'seedVideo01',
      }),
      replacementRow = service.operations.lookup(
        replacement.body.operationId,
        grant.record,
        service.resource,
      ),
      oldAdmission = broker.capture();
    await window.loadFile(f.owned + '/main.html');
    const newAdmission = broker.capture(),
      retiredBefore = { ...replacementRow.receipt };
    const replacementStatus = await request(
        '/operations/' + replacement.body.operationId,
      ),
      replacementReplay = await request('/play/song', 'POST', {
        videoId: 'seedVideo01',
        operationId: replacement.body.operationId,
      });
    const replacementProof = {
      oldGeneration: oldAdmission.generation,
      newGeneration: newAdmission.generation,
      sameFrame: oldAdmission.frame === newAdmission.frame,
      status: replacementStatus,
      replay: replacementReplay,
      before: retiredBefore,
      after: replacementRow.receipt,
    };
    const server = f.source.backend.server,
      closed = new Promise<void>((resolve) => server.once('close', resolve));
    f.source.backend.stop();
    await closed;
    for (const [channel, listener] of listeners)
      f.ipcMain.removeListener(channel, listener);
    window.destroy();
    return { records, replacementProof };
  });
  console.log('N1_F2_CONTEXT_NATIVE_PROOF ' + JSON.stringify(proof));
  expect(proof.records).toHaveLength(12);
  for (const row of proof.records) {
    expect(row.status.status).toBe(409);
    expect(row.status.body.error.code).toBe('retired');
    expect(row.replay.status).toBe(409);
    expect(row.replay.body.error.code).toBe('retired');
    expect(row.rejectedBeforeOriginalSettlement).toBe(true);
    expect(row.afterRequests).toEqual(row.before);
    expect(row.afterNative).toEqual(row.beforeNative);
    expect(row.foreignBrokerCalls).toBe(0);
    if (row.phase !== 'retired') {
      expect(row.originalStatus.status).toBe(200);
      expect(row.originalReplay.status).toBe(200);
    }
    if (row.phase === 'uncertain') {
      expect(row.before.physicalHold).toBe(true);
      expect(row.afterLateAck.body).toEqual(row.originalStatus.body);
    }
    expect(row.originalBrokerCalls).toBe(row.phase === 'retired' ? 0 : 1);
    expect(row.originalDispatches).toBe(
      ['failed', 'retired'].includes(row.phase) ? 0 : 1,
    );
  }
  expect(proof.replacementProof.newGeneration).toBeGreaterThan(
    proof.replacementProof.oldGeneration,
  );
  expect(proof.replacementProof.status.status).toBe(409);
  expect(proof.replacementProof.replay.status).toBe(409);
  expect(proof.replacementProof.after).toEqual(proof.replacementProof.before);
});
