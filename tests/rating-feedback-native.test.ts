import { test, expect } from '@playwright/test';
import { ratingFeedbackNative } from './helpers/rating-feedback-native';
test('rating feedback genuine seeded passive metadata admission precedes observed native transition', async () => {
  const result = await ratingFeedbackNative(async () => {
    const f = (globalThis as any).RatingNativeProof;
    const win = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
      },
    });
    await win.loadFile(f.owned + '/main.html');
    const security: any[] = [];
    f.ipcMain.on('peard:rating-feedback-state', (e: any) =>
      security.push({
        sender: e.sender === win.webContents,
        frame: e.senderFrame === win.webContents.mainFrame,
      }),
    );
    const packets: any[] = [];
    f.ipcMain.on('peard:rating-feedback-state', (e: any, v: any) =>
      packets.push(v),
    );
    const raw: any[] = [];
    f.ipcMain.on('peard:video-src-changed', (e: any) =>
      raw.push({
        sender: e.sender === win.webContents,
        frame: e.senderFrame === win.webContents.mainFrame,
      }),
    );
    const off = f.source.setupSongInfo(win);
    let info: any;
    f.source.registerCallback((i: any) => (info = i));
    const config = {
      enabled: true,
      interactive: false,
      unpauseNotification: false,
      notifyOnLikeChange: true,
      urgency: 'normal',
      toastStyle: 1,
      trayControls: false,
    };
    await f.source.onMainLoad({
      window: win,
      getConfig: () => config,
      ipc: { send: (...a: any[]) => win.webContents.send(...a) },
    });
    await win.webContents.executeJavaScript(
      `window.ipcRenderer=window.ratingProof;${f.bundle};window.listeners={};window.api=Object.assign(document.querySelector('ytmusic-app'),{getVideoData:()=>({video_id:'seeded00001'}),getPlayerResponse:()=>({microformat:{microformatDataRenderer:{urlCanonical:'https://music.youtube.com/watch?v=seeded00001',linkAlternates:[],tags:[]}},videoDetails:{videoId:'seeded00001',title:'Seed title',author:'Seed artist',lengthSeconds:'120',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),addEventListener:(k,f)=>(listeners[k]??=[]).push(f),removeEventListener:(k,f)=>listeners[k]=listeners[k]?.filter(x=>x!==f)});RatingNativeSource.setupFront(api);for(const h of listeners.videodatachange??[])h('dataloaded',{videoId:'seeded00001'});for(const h of listeners.videodatachange??[])h('dataupdated',{videoId:'seeded00001',title:'Seed title',author:'Seed artist',lengthSeconds:120});`,
    );
    const end = Date.now() + 5000;
    while (!info) {
      if (Date.now() > end) throw Error('Genuine metadata missing');
      await new Promise((r) => setTimeout(r, 5));
    }
    const binding = f.source.getSongInfoPlaybackBinding(info),
      provenance = f.source.getSongInfoProvenance(info);
    const admitted = {
      current: f.source.isSongInfoCurrent(info, win),
      provenance: !!provenance,
      binding: !!binding,
      raw: raw.slice(),
    };
    if (!admitted.current || !admitted.provenance || !admitted.binding)
      throw Error(
        'Positive genuine provider admission failed ' +
          JSON.stringify(admitted),
      );
    await win.webContents.executeJavaScript(
      `if(RatingNativeSource.createRatingFeedbackRenderer){window.controller=RatingNativeSource.createRatingFeedbackRenderer({ipc:ratingProof,getConfig:()=>(${JSON.stringify(config)})});controller.start();controller.onPlayerApiReady(api);}`,
    );
    await new Promise((r) => setTimeout(r, 30));
    const before = f.shown.filter((n: any) =>
      n.title.includes('rating'),
    ).length;
    await win.webContents.executeJavaScript(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
    );
    await new Promise((r) => setTimeout(r, 40));
    const count = () =>
      f.shown.filter((n: any) => n.title.includes('rating')).length;
    const drain = () => new Promise((r) => setTimeout(r, 35));
    const js = (code: string) =>
      win.webContents.executeJavaScript(code + ';void 0');
    const trace: any = { first: count() };
    const initial = packets.find((p: any) => p.type === 'snapshot');
    const attack = { ...initial, type: 'change', state: 'DISLIKE' };
    const foreign = new f.BrowserWindow({
      show: false,
      webPreferences: {
        preload: f.preload,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await foreign.loadFile(f.owned + '/child.html');
    await foreign.webContents.executeJavaScript(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify(attack)})`,
    );
    const child = win.webContents.mainFrame.frames[0];
    if (!child) throw Error('Actual child frame missing');
    await child.executeJavaScript(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify(attack)})`,
    );
    await drain();
    trace.afterForeign = count();
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','DISLIKE')`,
    );
    await drain();
    trace.afterHealthy = count();
    await js(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify(initial)});ratingProof.send('peard:rating-feedback-state',${JSON.stringify(attack)});ratingProof.send('peard:rating-feedback-state',{type:'ready'});ratingProof.send('peard:rating-feedback-state',{type:'ready'});`,
    );
    await drain();
    trace.afterLate = count();
    await js(
      `document.querySelector('#like-button-renderer').outerHTML='<div id="like-button-renderer" like-status="INDIFFERENT"></div>'`,
    );
    await drain();
    trace.replacementBaseline = count();
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
    );
    await drain();
    trace.replacementChange = count();
    await js(
      `controller.stop();controller.start();controller.onPlayerApiReady(api)`,
    );
    await drain();
    trace.softBaseline = count();
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','DISLIKE')`,
    );
    await drain();
    trace.softChange = count();
    const oldBinding = f.source.getSongInfoPlaybackBinding(info),
      oldInfo = info,
      oldProvenance = f.source.getSongInfoProvenance(info);
    await js(
      `for(const h of [...listeners.videodatachange])h('dataupdated',{videoId:'seeded00001'})`,
    );
    await drain();
    trace.passive = {
      sameReference: info === oldInfo,
      sameProvenance: f.source.getSongInfoProvenance(info) === oldProvenance,
      differentEpisode:
        f.source.getSongInfoPlaybackBinding(info).episodeId !==
        oldBinding.episodeId,
      count: count(),
    };
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','INDIFFERENT')`,
    );
    await drain();
    trace.passiveChange = count();
    await js(
      `document.querySelector('#like-button-renderer').removeAttribute('like-status')`,
    );
    await drain();
    trace.unknown = count();
    const denialBase = packets.filter((p: any) => p.type === 'snapshot').at(-1);
    const deny = { ...denialBase, type: 'change', state: 'LIKE' };
    for (const bad of [
      { ...deny, nonce: 'bad' },
      { ...deny, binding: { ...deny.binding, episodeId: 'd'.repeat(32) } },
      { ...deny, state: 'like' },
      { ...deny, state: 'UNKNOWN' },
      { ...deny, sourceGeneration: 0 },
      { ...deny, sourceGeneration: 1.5 },
      { ...deny, extra: true },
      { type: 'ready', extra: true },
      { ...deny, type: 'unexpected' },
    ])
      await js(
        `ratingProof.send('peard:rating-feedback-state',${JSON.stringify(bad)})`,
      );
    await js(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify(deny)},'extra')`,
    );
    await drain();
    trace.malformed = count();
    // The production update-like listener calls the seeded observed native method; it does not create feedback itself.
    await js(
      `${f.controlListener};window.controlCalls=[];document.querySelector('#like-button-renderer').updateLikeStatus=status=>{controlCalls.push(status);document.querySelector('#like-button-renderer').setAttribute('like-status',status)}`,
    );
    f.source.getSongControls(win).like();
    await drain();
    trace.control = count();
    trace.controlCalls =
      await win.webContents.executeJavaScript('controlCalls');
    f.locale = 'ru';
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','DISLIKE')`,
    );
    await drain();
    trace.locale = f.shown
      .filter((n: any) => n.title.includes('rating'))
      .at(-1).title;
    const replay = packets.filter((p: any) => p.type === 'change').at(-1);
    const oldFrame = win.webContents.mainFrame;
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', resolve);
      win.reload();
    });
    await js(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify({ ...replay, state: 'LIKE' })})`,
    );
    await drain();
    trace.reloadOld = count();
    trace.reloadSameFrame = oldFrame === win.webContents.mainFrame;
    const previousInfo = info,
      previousProvenance = f.source.getSongInfoProvenance(info);
    await js(
      `window.ipcRenderer=ratingProof;${f.bundle};window.listeners={};window.api=Object.assign(document.querySelector('ytmusic-app'),{getVideoData:()=>({video_id:'seeded00001'}),getPlayerResponse:()=>({microformat:{microformatDataRenderer:{urlCanonical:'https://music.youtube.com/watch?v=seeded00001',linkAlternates:[],tags:[]}},videoDetails:{videoId:'seeded00001',title:'Reload title',author:'Artist',lengthSeconds:'120',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),addEventListener:(k,f)=>(listeners[k]??=[]).push(f),removeEventListener:(k,f)=>listeners[k]=listeners[k]?.filter(x=>x!==f)});RatingNativeSource.setupFront(api);for(const h of listeners.videodatachange)h('dataloaded',{videoId:'seeded00001'});for(const h of listeners.videodatachange)h('dataupdated',{videoId:'seeded00001'});window.controller=RatingNativeSource.createRatingFeedbackRenderer({ipc:ratingProof,getConfig:()=>(${JSON.stringify(config)})});controller.start();controller.onPlayerApiReady(api);`,
    );
    const reloadEnd = Date.now() + 5000;
    while (info === previousInfo) {
      if (Date.now() > reloadEnd)
        throw Error('New native reload admission missing');
      await new Promise((r) => setTimeout(r, 5));
    }
    await drain();
    trace.reloadAdmission = {
      newReference: info !== previousInfo,
      newProvenance:
        f.source.getSongInfoProvenance(info) !== previousProvenance,
      current: f.source.isSongInfoCurrent(info, win),
      count: count(),
    };
    await js(
      `ratingProof.send('peard:rating-feedback-state',${JSON.stringify({ ...replay, state: 'LIKE' })})`,
    );
    await drain();
    trace.replayAfterNewAdmission = count();
    await js(
      `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
    );
    await drain();
    trace.reloadHealthy = count();
    f.source.onMainStop?.();
    off();
    return {
      admitted,
      before,
      ratings: f.shown.filter((n: any) => n.title.includes('rating')),
      trace,
      security,
    };
  });
  expect(result.admitted).toMatchObject({
    current: true,
    provenance: true,
    binding: true,
    raw: [{ sender: true, frame: true }],
  });
  expect(result.before).toBe(0);
  expect(result.ratings).toHaveLength(8);
  expect(result.ratings[0]).toMatchObject({ body: 'Seed title', silent: true });
  expect(result.trace).toMatchObject({
    first: 1,
    afterForeign: 1,
    afterHealthy: 2,
    afterLate: 2,
    replacementBaseline: 2,
    replacementChange: 3,
    softBaseline: 3,
    softChange: 4,
    passive: {
      sameReference: true,
      sameProvenance: true,
      differentEpisode: true,
      count: 4,
    },
    passiveChange: 5,
    unknown: 5,
    malformed: 5,
    control: 6,
    controlCalls: ['LIKE'],
    locale: 'ru:plugins.notifications.rating.disliked',
    reloadOld: 7,
    reloadAdmission: {
      newReference: true,
      newProvenance: true,
      current: true,
      count: 7,
    },
    replayAfterNewAdmission: 7,
    reloadHealthy: 8,
  });
  expect(result.security).toContainEqual({ sender: false, frame: false });
  expect(result.security).toContainEqual({ sender: true, frame: false });
});

for (const stage of [
  'image',
  'constructor',
  'on-get',
  'show-get',
  'frame-get',
  'native-get',
])
  test('native rating final callout retirement fence at ' + stage, async () => {
    const result = await ratingFeedbackNative(
      async () => {
        const f = (globalThis as any).RatingNativeProof;
        const win = new f.BrowserWindow({
          show: false,
          webPreferences: {
            preload: f.preload,
            contextIsolation: true,
            sandbox: true,
          },
        });
        await win.loadFile(f.owned + '/main.html');
        const off = f.source.setupSongInfo(win);
        let info: any;
        f.source.registerCallback((i: any) => (info = i));
        const config = {
          enabled: true,
          interactive: false,
          unpauseNotification: false,
          notifyOnLikeChange: true,
          urgency: 'normal',
          toastStyle: 1,
          trayControls: false,
        };
        await f.source.onMainLoad({
          window: win,
          getConfig: () => config,
          ipc: { send: (...a: any[]) => win.webContents.send(...a) },
        });
        const bootstrap = `window.ipcRenderer=ratingProof;${f.bundle};window.listeners={};window.api=Object.assign(document.querySelector('ytmusic-app'),{getVideoData:()=>({video_id:'seeded00001'}),getPlayerResponse:()=>({microformat:{microformatDataRenderer:{urlCanonical:'https://music.youtube.com/watch?v=seeded00001',linkAlternates:[],tags:[]}},videoDetails:{videoId:'seeded00001',title:'Native fence title',author:'Artist',lengthSeconds:'120',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),addEventListener:(k,f)=>(listeners[k]??=[]).push(f),removeEventListener:(k,f)=>listeners[k]=listeners[k]?.filter(x=>x!==f)});RatingNativeSource.setupFront(api);for(const h of listeners.videodatachange)h('dataloaded',{videoId:'seeded00001'});for(const h of listeners.videodatachange)h('dataupdated',{videoId:'seeded00001'});window.controller=RatingNativeSource.createRatingFeedbackRenderer({ipc:ratingProof,getConfig:()=>(${JSON.stringify(config)})});controller.start();controller.onPlayerApiReady(api);void 0;`;
        await win.webContents.executeJavaScript(bootstrap);
        const end = Date.now() + 5000;
        while (!info) {
          if (Date.now() > end)
            throw Error('Missing positive native fence admission');
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => setTimeout(r, 40));
        const admitted =
          f.source.isSongInfoCurrent(info, win) &&
          !!f.source.getSongInfoPlaybackBinding(info);
        if (!admitted) throw Error('Invalid positive native fence admission');
        const retire = () => {
          f.hook = undefined;
          f.source.onConfigChange({ ...config, enabled: false });
        };
        if (f.settings.stage === 'image') {
          info.image = f.nativeImage.createFromBitmap(
            Buffer.from([0, 0, 0, 255]),
            { width: 1, height: 1 },
          );
          const actual = info.image.resize.bind(info.image);
          info.image.resize = (...a: any[]) => {
            const result = actual(...a);
            retire();
            return result;
          };
        } else if (f.settings.stage === 'frame-get') {
          const contents = win.webContents,
            frame = contents.mainFrame;
          Object.defineProperty(contents, 'mainFrame', {
            configurable: true,
            get() {
              Object.defineProperty(contents, 'mainFrame', {
                configurable: true,
                value: frame,
              });
              retire();
              return frame;
            },
          });
        } else if (f.settings.stage === 'native-get')
          await win.webContents.executeJavaScript(
            `api.getVideoData=()=>{api.getVideoData=()=>({video_id:'seeded00001'});for(const h of [...listeners.videodatachange])h('dataupdated',{videoId:'seeded00001'});return {video_id:'seeded00001'}};void 0`,
          );
        else
          f.hook = (s: string) => {
            if (s === f.settings.stage) retire();
          };
        await win.webContents.executeJavaScript(
          `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
        );
        await new Promise((r) => setTimeout(r, 50));
        const ratings = f.shown.filter((n: any) => n.title.includes('rating'));
        f.source.onMainStop();
        off();
        return {
          admitted,
          ratings,
          closed: f.closed.length,
          listeners: f.ipcMain.listenerCount('peard:rating-feedback-state'),
        };
      },
      { stage },
    );
    expect(result.admitted).toBe(true);
    expect(result.ratings).toEqual([]);
    expect(result.listeners).toBe(0);
  });

for (const mode of [
  'normal',
  'windows-interactive',
  'no-subscribe',
  'counter-exhausted',
])
  test(
    'native rating one stream and owned observer budget ' + mode,
    async () => {
      const result = await ratingFeedbackNative(
        async () => {
          const f = (globalThis as any).RatingNativeProof;
          const win = new f.BrowserWindow({
            show: false,
            webPreferences: {
              preload: f.preload,
              contextIsolation: true,
              sandbox: true,
            },
          });
          await win.loadFile(f.owned + '/main.html');
          const off = f.source.setupSongInfo(win);
          let info: any;
          f.source.registerCallback((i: any) => (info = i));
          const packets: any[] = [];
          f.ipcMain.on('peard:rating-feedback-state', (_e: any, v: any) =>
            packets.push(v),
          );
          const config = {
            enabled: true,
            interactive: true,
            unpauseNotification: true,
            refreshOnPlayPause: true,
            notifyOnLikeChange: true,
            urgency: 'normal',
            toastStyle: 1,
            trayControls: false,
          };
          await f.source.onMainLoad({
            window: win,
            getConfig: () => config,
            ipc: { send: (...a: any[]) => win.webContents.send(...a) },
          });
          await win.webContents.executeJavaScript(
            `window.ipcRenderer=ratingProof;window.observed=new Set();window.NativeObserver=MutationObserver;window.MutationObserver=class extends NativeObserver{observe(...a){super.observe(...a);observed.add(this)}disconnect(){observed.delete(this);super.disconnect()}};${f.bundle};window.listeners={};window.api=Object.assign(document.querySelector('ytmusic-app'),{getVideoData:()=>({video_id:'seeded00001'}),getPlayerResponse:()=>({microformat:{microformatDataRenderer:{urlCanonical:'https://music.youtube.com/watch?v=seeded00001',linkAlternates:[],tags:[]}},videoDetails:{videoId:'seeded00001',title:'Budget title',author:'Artist',lengthSeconds:'120',musicVideoType:'MUSIC_VIDEO_TYPE_ATV'}}),addEventListener:(k,f)=>(listeners[k]??=[]).push(f),removeEventListener:(k,f)=>listeners[k]=listeners[k]?.filter(x=>x!==f)});RatingNativeSource.setupFront(api);for(const h of listeners.videodatachange)h('dataloaded',{videoId:'seeded00001'});for(const h of listeners.videodatachange)h('dataupdated',{videoId:'seeded00001'});window.controller=RatingNativeSource.createRatingFeedbackRenderer({ipc:${f.settings.stage === 'no-subscribe' ? '({send:ratingProof.send,on:ratingProof.on})' : 'ratingProof'},getConfig:()=>(${JSON.stringify(config)})});controller.start();controller.onPlayerApiReady(api);void 0`,
          );
          const end = Date.now() + 5000;
          while (!info) {
            if (Date.now() > end)
              throw Error('Missing positive budget metadata');
            await new Promise((r) => setTimeout(r, 5));
          }
          await new Promise((r) => setTimeout(r, 40));
          const admitted =
            f.source.isSongInfoCurrent(info, win) &&
            !!f.source.getSongInfoPlaybackBinding(info);
          if (!admitted) throw Error('Invalid positive budget admission');
          const active =
            await win.webContents.executeJavaScript('observed.size');
          await win.webContents.executeJavaScript(
            `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
          );
          await new Promise((r) => setTimeout(r, 35));
          await win.webContents.executeJavaScript(
            `document.querySelector('#like-button-renderer').setAttribute('like-status','LIKE')`,
          );
          await new Promise((r) => setTimeout(r, 25));
          const ratingCount = f.shown.filter((n: any) =>
            n.title.includes('rating'),
          ).length;
          await win.webContents.executeJavaScript('controller.stop();void 0');
          const stopped =
            await win.webContents.executeJavaScript('observed.size');
          f.source.onMainStop();
          off();
          return {
            admitted,
            active,
            stopped,
            ratingCount,
            snapshots: packets.filter((p: any) => p.type === 'snapshot').length,
          };
        },
        {
          stage: mode,
          windows: mode === 'windows-interactive',
          exhausted: mode === 'counter-exhausted',
        },
      );
      expect(result.admitted).toBe(true);
      expect(result.stopped).toBe(0);
      expect(result.ratingCount).toBe(
        mode === 'no-subscribe' || mode === 'counter-exhausted' ? 0 : 1,
      );
      expect(result.snapshots).toBe(
        mode === 'no-subscribe' || mode === 'counter-exhausted' ? 0 : 1,
      );
    },
  );

test('native physical tray callback leases and protocol slots preserve newer owners, foreign listeners and defaults', async () => {
  const result = await ratingFeedbackNative(async () => {
    const f = (globalThis as any).RatingNativeProof;
    const win = new f.BrowserWindow({ show: false });
    await win.loadFile(f.owned + '/child.html');
    const captures: any[] = [];
    const actualOn = f.source.Tray.prototype.on;
    f.source.Tray.prototype.on = function (...args: any[]) {
      if (!captures.includes(this)) captures.push(this);
      return actualOn.apply(this, args);
    };
    f.source.state.values['options.tray'] = true;
    f.source.state.values['options.trayClickPlayPause'] = true;
    const observed: string[] = [];
    const actualSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel: string, ...a: any[]) => {
      observed.push(channel);
      return actualSend(channel, ...a);
    };
    f.source.setUpTray(f.source.app, win);
    const physical = captures[0];
    if (!physical || physical.isDestroyed())
      throw Error('Actual owned physical Tray missing');
    let foreign = 0,
      a = 0,
      b = 0;
    const unrelated = () => foreign++;
    physical.on('click', unrelated);
    const live = { isCurrent: () => true };
    const offA = f.source.registerOwnedTrayOnClick(live, () => a++);
    physical.emit('click', {}, {});
    const offB = f.source.registerOwnedTrayOnClick(live, () => b++);
    offA();
    physical.emit('click', {}, {});
    offB();
    physical.emit('click', {}, {});
    const restored = observed.includes('peard:toggle-play');
    const newer = f.source.registerOwnedTrayOnClick(live, () => a++);
    f.source.setTrayOnClick(() => b++);
    newer();
    physical.emit('click', {}, {});
    const oldOwner = f.source.registerOwnedTrayOnClick(live, () => a++);
    f.source.setUpTray(f.source.app, win);
    const replacement = captures[1];
    oldOwner();
    replacement.emit('click', {}, {});
    const replacementIntact =
      observed.filter((x) => x === 'peard:toggle-play').length === 2;
    let d = 0;
    const double = f.source.registerOwnedTrayOnDoubleClick(live, () => d++);
    replacement.emit('double-click', {}, {});
    f.source.setTrayOnDoubleClick(() => (d += 10));
    double();
    replacement.emit('double-click', {}, {});
    const protocol: string[] = [];
    f.source.setupProtocolHandler(win);
    const p = f.source.registerOwnedProtocolHandler(live, () =>
      protocol.push('owned'),
    );
    f.source.handleProtocol('play');
    p();
    f.source.handleProtocol('play');
    const protocolDefault = observed.includes('peard:play');
    const older = f.source.registerOwnedProtocolHandler(live, () =>
      protocol.push('old'),
    );
    f.source.changeProtocolHandler(() => protocol.push('new'));
    older();
    f.source.handleProtocol('play');
    physical.removeListener('click', unrelated);
    physical.destroy();
    replacement.destroy();
    f.source.Tray.prototype.on = actualOn;
    win.destroy();
    return {
      nativePhysical: true,
      registrationSinkCalls: f.protocolRegistrations.length,
      a,
      b,
      foreign,
      restored,
      replacementIntact,
      d,
      protocol,
      protocolDefault,
    };
  });
  expect(result).toEqual({
    nativePhysical: true,
    registrationSinkCalls: 1,
    a: 1,
    b: 2,
    foreign: 4,
    restored: true,
    replacementIntact: true,
    d: 11,
    protocol: ['owned', 'new'],
    protocolDefault: true,
  });
});

test('F2 native restoration predicate installing newer setter must preserve it and exact foreign listener', async () => {
  const result = await ratingFeedbackNative(async () => {
    const f = (globalThis as any).RatingNativeProof;
    if (!Array.isArray(f.protocolRegistrations))
      throw Error('Missing mandatory protocol registration sink');
    const win = new f.BrowserWindow({ show: false });
    await win.loadFile(f.owned + '/main.html');
    f.source.setupProtocolHandler(win);
    const events: string[] = [];
    f.source.changeProtocolHandler(() => events.push('protocol-default'));
    let armedP = false;
    const pA = f.source.registerOwnedProtocolHandler(
      {
        isCurrent() {
          if (armedP) {
            armedP = false;
            f.source.changeProtocolHandler(() => events.push('protocol-newer'));
          }
          return true;
        },
      },
      () => events.push('protocol-A'),
    );
    const pB = f.source.registerOwnedProtocolHandler(
      { isCurrent: () => true },
      () => events.push('protocol-B'),
    );
    f.source.handleProtocol('owned-noop');
    armedP = true;
    pB();
    f.source.handleProtocol('owned-noop');
    pA();
    f.source.handleProtocol('owned-noop');
    let physical: any;
    const actualOn = f.source.Tray.prototype.on;
    f.source.Tray.prototype.on = function (...a: any[]) {
      if (a[0] === 'click') physical = this;
      return actualOn.apply(this, a);
    };
    f.source.state.values['options.tray'] = true;
    f.source.setUpTray(f.source.app, win);
    f.source.setTrayOnClick(() => events.push('tray-default'));
    f.source.Tray.prototype.on = actualOn;
    if (!physical) throw Error('Missing exact physical tray');
    const foreign = () => events.push('tray-foreign');
    physical.on('click', foreign);
    let armedT = false;
    const tA = f.source.registerOwnedTrayOnClick(
      {
        isCurrent() {
          if (armedT) {
            armedT = false;
            f.source.setTrayOnClick(() => events.push('tray-newer'));
          }
          return true;
        },
      },
      () => events.push('tray-A'),
    );
    const tB = f.source.registerOwnedTrayOnClick(
      { isCurrent: () => true },
      () => events.push('tray-B'),
    );
    const bHandler = physical
      .listeners('click')
      .find((h: any) => h !== foreign);
    physical.emit('click', {}, {});
    armedT = true;
    tB();
    physical.emit('click', {}, {});
    tA();
    physical.emit('click', {}, {});
    const exact = {
      count: physical.listenerCount('click'),
      foreignCount: physical
        .listeners('click')
        .filter((h: any) => h === foreign).length,
      BRemoved: !physical.listeners('click').includes(bHandler),
    };
    physical.removeListener('click', foreign);
    physical.destroy();
    return {
      events,
      exact,
      registrationSinkCalls: f.protocolRegistrations.length,
    };
  });
  console.log('F2_NATIVE_WITNESS ' + JSON.stringify(result));
  expect(result.registrationSinkCalls).toBe(1);
  expect(result.exact).toEqual({ count: 2, foreignCount: 1, BRemoved: true });
  expect(result.events).toEqual([
    'protocol-B',
    'protocol-newer',
    'protocol-newer',
    'tray-foreign',
    'tray-B',
    'tray-foreign',
    'tray-newer',
    'tray-foreign',
    'tray-newer',
  ]);
});

test('F2 native listener registration retirement must leave no newly added notification listeners', async () => {
  const result = await ratingFeedbackNative(async () => {
    const f = (globalThis as any).RatingNativeProof;
    if (!Array.isArray(f.protocolRegistrations))
      throw Error('Missing mandatory outer protocol sink');
    const win = new f.BrowserWindow({ show: false });
    await win.loadFile(f.owned + '/main.html');
    const counts = () => ({
      closed: win.listenerCount('closed'),
      destroyed: win.webContents.listenerCount('destroyed'),
      navigation: win.webContents.listenerCount('did-start-navigation'),
      rating: f.ipcMain.listenerCount('peard:rating-feedback-state'),
    });
    const before = counts();
    let armed = true,
      reentered = 0,
      oldClosed: any;
    // EventEmitter produces newListener synchronously during the actual native .on.
    // No synthetic closed/navigation/window lifecycle event is emitted.
    const nativeRegistration = (name: string, listener: any) => {
      if (armed && name === 'closed') {
        oldClosed = listener;
        armed = false;
        reentered++;
        f.source.onMainStop();
      }
    };
    win.on('newListener', nativeRegistration);
    const config = {
      enabled: true,
      interactive: false,
      notifyOnLikeChange: true,
      unpauseNotification: false,
      urgency: 'normal',
      toastStyle: 1,
      trayControls: false,
    };
    await f.source.onMainLoad({
      window: win,
      getConfig: () => config,
      ipc: { send: (...a: any[]) => win.webContents.send(...a) },
    });
    win.removeListener('newListener', nativeRegistration);
    const after = counts();
    f.source.onMainStop();
    const afterRepeatedStop = counts();
    const unrelated = () => {};
    win.on('closed', unrelated);
    win.webContents.on('destroyed', unrelated);
    win.webContents.on('did-start-navigation', unrelated);
    const healthyBaseline = counts();
    await f.source.onMainLoad({
      window: win,
      getConfig: () => config,
      ipc: { send: (...a: any[]) => win.webContents.send(...a) },
    });
    const healthy = counts();
    oldClosed();
    const afterStaleCallback = counts();
    f.source.onMainStop();
    const afterHealthyStop = counts();
    const unrelatedPreserved = {
      closed: win.listeners('closed').filter((x: any) => x === unrelated)
        .length,
      destroyed: win.webContents
        .listeners('destroyed')
        .filter((x: any) => x === unrelated).length,
      navigation: win.webContents
        .listeners('did-start-navigation')
        .filter((x: any) => x === unrelated).length,
    };
    win.removeListener('closed', unrelated);
    win.webContents.removeListener('destroyed', unrelated);
    win.webContents.removeListener('did-start-navigation', unrelated);
    return {
      before,
      after,
      afterRepeatedStop,
      reentered,
      healthyBaseline,
      healthy,
      afterStaleCallback,
      afterHealthyStop,
      unrelatedPreserved,
      shown: f.shown.length,
      registrationSinkCalls: f.protocolRegistrations.length,
    };
  });
  console.log('F2_NATIVE_WITNESS ' + JSON.stringify(result));
  expect(result.reentered).toBe(1);
  expect(result.shown).toBe(0);
  expect(result.registrationSinkCalls).toBe(0);
  expect(result.afterStaleCallback).toEqual(result.healthy);
  expect(result.afterHealthyStop).toEqual(result.healthyBaseline);
  expect(result.unrelatedPreserved).toEqual({
    closed: 1,
    destroyed: 1,
    navigation: 1,
  });
  expect(result.healthy.rating).toBe(1);
  expect(result.healthy.closed).toBe(result.healthyBaseline.closed + 1);
  expect.soft(result.after).toEqual(result.before);
  expect.soft(result.afterRepeatedStop).toEqual(result.before);
});

test('F2 native prior lease self-retirement during restoration must fall through to still-live defaults', async () => {
  const result = await ratingFeedbackNative(async () => {
    const f = (globalThis as any).RatingNativeProof;
    // Helper installs this registration sink before loading source/tasks.
    if (
      typeof f.source.app.setAsDefaultProtocolClient !== 'function' ||
      !Array.isArray(f.protocolRegistrations)
    )
      throw Error('Missing mandatory outer registration sink');
    const win = new f.BrowserWindow({ show: false });
    await win.loadFile(f.owned + '/main.html');
    f.source.setupProtocolHandler(win);
    const events: string[] = [];
    f.source.changeProtocolHandler(() => events.push('protocol-default'));
    f.source.handleProtocol('owned-noop');
    let retireProtocolA: any,
      armedProtocol = false,
      protocolChecks = 0;
    retireProtocolA = f.source.registerOwnedProtocolHandler(
      {
        isCurrent() {
          protocolChecks++;
          if (armedProtocol) {
            armedProtocol = false;
            retireProtocolA();
          }
          return true;
        },
      },
      () => events.push('protocol-A'),
    );
    const retireProtocolB = f.source.registerOwnedProtocolHandler(
      { isCurrent: () => true },
      () => events.push('protocol-B'),
    );
    f.source.handleProtocol('owned-noop');
    armedProtocol = true;
    retireProtocolB();
    f.source.handleProtocol('owned-noop');
    const protocolEvents = events.slice();
    f.source.state.values['options.tray'] = true;
    f.source.setUpTray(f.source.app, win);
    f.source.setTrayOnClick(() => events.push('tray-default'));
    // Only controlled actual Tray callbacks are invoked; default window/focus callbacks are replaced.

    // setUpTray exports no physical handle; an unrelated real native Tray is not a valid substitute.
    // Capture the exact physical instance via its prototype on method while registration is performed.
    let exactTray: any;
    const on = f.source.Tray.prototype.on;
    f.source.Tray.prototype.on = function (...args: any[]) {
      if (args[0] === 'click') exactTray = this;
      return on.apply(this, args);
    };
    f.source.setTrayOnClick(() => events.push('tray-default'));
    f.source.Tray.prototype.on = on;
    if (!exactTray) throw Error('Actual current Tray identity not captured');
    const defaultManaged = exactTray.listeners('click')[0];
    const foreign = () => events.push('tray-foreign');
    exactTray.on('click', foreign);
    exactTray.emit('click', {}, {});
    const initialTrayDefault = events.includes('tray-default');
    const baselineListenerCount = exactTray.listenerCount('click');
    let retireTrayA: any,
      armedTray = false,
      trayChecks = 0;
    retireTrayA = f.source.registerOwnedTrayOnClick(
      {
        isCurrent() {
          trayChecks++;
          if (armedTray) {
            armedTray = false;
            retireTrayA();
          }
          return true;
        },
      },
      () => events.push('tray-A'),
    );
    const handlerA = exactTray
      .listeners('click')
      .find((h: any) => h !== foreign);
    const retireTrayB = f.source.registerOwnedTrayOnClick(
      { isCurrent: () => true },
      () => events.push('tray-B'),
    );
    const handlerB = exactTray
      .listeners('click')
      .find((h: any) => h !== foreign);
    exactTray.emit('click', {}, {});
    const before = events.length;
    armedTray = true;
    retireTrayB();
    exactTray.emit('click', {}, {});
    const afterRestore = events.slice(before);
    const exactListeners = {
      baselineCount: baselineListenerCount,
      restoredCount: exactTray.listenerCount('click'),
      defaultPresent: exactTray.listeners('click').includes(defaultManaged),
      deadAPresent: exactTray.listeners('click').includes(handlerA),
      BRemoved: !exactTray.listeners('click').includes(handlerB),
      foreignCount: exactTray
        .listeners('click')
        .filter((h: any) => h === foreign).length,
    };
    // Healthy control: a later explicit managed setter remains usable and preserves foreign callbacks.
    f.source.changeProtocolHandler(() => events.push('protocol-new'));
    f.source.handleProtocol('owned-noop');
    f.source.setTrayOnClick(() => events.push('tray-new'));
    exactTray.emit('click', {}, {});
    exactTray.removeListener('click', foreign);
    exactTray.destroy();
    return {
      registrationSinkCalls: f.protocolRegistrations.length,
      protocolEvents,
      afterRestore,
      initialTrayDefault,
      exactListeners,
      allEvents: events,
      protocolChecks,
      trayChecks,
    };
  });
  console.log('F2_NATIVE_WITNESS ' + JSON.stringify(result));
  expect(result.registrationSinkCalls).toBe(1);
  expect(result.allEvents).toContain('protocol-B');
  expect(result.allEvents).toContain('tray-B');
  expect(result.allEvents).toContain('protocol-new');
  expect(result.allEvents).toContain('tray-new');
  expect(result.allEvents).toContain('tray-foreign');
  expect(result.initialTrayDefault).toBe(true);
  expect(result.exactListeners).toMatchObject({
    baselineCount: 2,
    restoredCount: 2,
    BRemoved: true,
    foreignCount: 1,
  });
  expect.soft(result.exactListeners.defaultPresent).toBe(true);
  expect.soft(result.exactListeners.deadAPresent).toBe(false);
  expect
    .soft(result.protocolEvents)
    .toEqual(['protocol-default', 'protocol-B', 'protocol-default']);
  expect.soft(result.afterRestore).toEqual(['tray-foreign', 'tray-default']);
});
