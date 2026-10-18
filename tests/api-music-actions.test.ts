import { test, expect } from '@playwright/test';
import { musicHttpFixture } from './helpers/api-music-http';
import { musicModuleSource } from './helpers/api-music-source';

const epoch = '1'.repeat(32) + ':' + '2'.repeat(32);
const commands = [
  { action: 'previous' },
  { action: 'next' },
  { action: 'play' },
  { action: 'pause' },
  { action: 'toggle_playback' },
  { action: 'toggle_shuffle' },
  { action: 'switch_repeat' },
  { action: 'seek', seconds: 0, playbackEpoch: epoch },
  { action: 'set_volume', volume: 0 },
];
for (const command of commands) {
  test(`C9 REST prepares useful ${command.action} and dispatches once through service`, async () => {
    const f = await musicHttpFixture();
    try {
      const grant = await f.store.issue(
        'C9',
        'rest',
        f.service.resource,
        ['playback.control'],
        () => true,
      );
      const headers = { authorization: 'Bearer ' + grant.token };
      const frame = {};
      (f.service as any).broker.capture = () => ({ frame, generation: 0 });
      f.setHold();
      const prepared = await f.http(
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify(command),
        headers,
      );
      expect(prepared.status).toBe(200);
      expect(prepared.body).toEqual({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'pending',
      });
      expect(f.calls).toHaveLength(0);
      const body = JSON.stringify({
        ...command,
        operationId: prepared.body.operationId,
      });
      const execution = f.http('/api/v1/music/control', 'POST', body, headers);
      await expect.poll(() => f.calls.length).toBe(1);
      const canonical =
        command.action === 'switch_repeat'
          ? { ...command, iterations: 1 }
          : command;
      expect(f.calls[0].input).toEqual({
        operation: 'control',
        command: canonical,
        deadlineAt: expect.any(Number),
      });
      f.calls[0].options.onPhysicalSettled('settled');
      f.calls[0].resolve({ version: 1, phase: 'owned_control_dispatch' });
      const result = await execution;
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        operationId: prepared.body.operationId,
        status: 'accepted',
        meaning: 'owned_control_dispatch',
      });
      expect(
        (await f.http('/api/v1/music/control', 'POST', body, headers)).body,
      ).toEqual(result.body);
      expect(
        (
          await f.http(
            '/api/v1/music/operations/' + prepared.body.operationId,
            'GET',
            undefined,
            headers,
          )
        ).body,
      ).toEqual(result.body);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

import { Window } from 'happy-dom';
import { build } from 'vite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
let source: any, coreInit: string;
test.beforeAll(async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'pear-actions-source-'));
  try {
    const entry = path.join(owned, 'entry.ts');
    const core = await readFile(path.join(root, 'src/renderer.ts'), 'utf8');
    coreInit = core.slice(
      core.indexOf('async function onApiLoaded() {') +
        'async function onApiLoaded() {'.length,
      core.indexOf('  // Workaround for macOS traffic lights'),
    );
    const navigationStart = core.indexOf(
      "  window.ipcRenderer.on('peard:previous-video'",
    );
    const navigationEnd = core.indexOf(
      "  window.ipcRenderer.on('peard:play'",
      navigationStart,
    );
    expect(navigationStart).toBeGreaterThan(0);
    expect(navigationEnd).toBeGreaterThan(navigationStart);
    const navigationHandlers = core.slice(navigationStart, navigationEnd);
    await writeFile(
      entry,
      [
        `export * from ${JSON.stringify(path.join(root, 'src/providers/music-actions.ts'))};`,
        `export * from ${JSON.stringify(path.join(root, 'src/providers/music-renderer.ts'))};`,
        `export * from ${JSON.stringify(path.join(root, 'src/plugins/api-server/backend/scheme/music.ts'))};`,
        `import {publishMusicActionsOwner} from ${JSON.stringify(path.join(root, 'src/providers/music-actions.ts'))};`,
        `import {createRepeatPreference} from ${JSON.stringify(path.join(root, 'src/providers/repeat-preference.ts'))};`,
        `import {createPlaylistQueueController} from ${JSON.stringify(path.join(root, 'src/providers/queue-playlist-renderer.ts'))};`,
        `let api,repeatPreference,playlistQueue,disposeMusicActionsOwner; export function initializeCore(next){api=next;${coreInit};return{repeatPreference,playlistQueue,disposeMusicActionsOwner};}`,
        `export function registerLegacyNavigation(){${navigationHandlers}}`,
      ].join('\n'),
    );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      resolve: { alias: { '@': path.join(root, 'src') } },
      build: {
        ssr: entry,
        outDir: owned,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { output: { entryFileNames: 'source.mjs' } },
      },
    });
    source = await import(pathToFileURL(path.join(owned, 'source.mjs')).href);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
function actionsFixture() {
  const dom = new Window(),
    w = dom as any,
    doc = dom.document;
  const saved = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
  };
  (globalThis as any).window = w;
  (globalThis as any).document = doc;
  doc.body.innerHTML =
    '<ytmusic-app></ytmusic-app><ytmusic-player-bar><button class="previous-button ytmusic-player-bar"></button><button class="next-button ytmusic-player-bar"></button></ytmusic-player-bar><div id="movie_player"></div><input id="volume-slider"><input id="expand-volume-slider">';
  w.ipcRenderer = {
    send() {},
    subscribe() {
      return () => {};
    },
  };
  const api = doc.querySelector('#movie_player') as any,
    bar = doc.querySelector('ytmusic-player-bar') as any,
    app = doc.querySelector('ytmusic-app') as any;
  let video = 'current0001',
    activeApi = api,
    state = 2,
    mode = 0;
  const calls: any[] = [],
    packets: any[] = [],
    listeners = new Map<string, any>(),
    events = new Map<string, any>();
  const record = (name: string, receiver: any, args: any[]) =>
    calls.push({ name, receiver, args });
  api.getVideoData = () => ({ video_id: video });
  api.getPlayerResponse = () => ({
    videoDetails: {
      videoId: video,
      title: 'Owned title',
      author: 'Owned artist',
    },
  });
  api.getCurrentTime = () => 1;
  api.getDuration = () => 10;
  api.getVolume = () => 50;
  api.getPlayerState = () => state;
  api.addEventListener = (name: string, fn: any) => events.set(name, fn);
  api.removeEventListener = (name: string) => events.delete(name);
  api.playVideo = function () {
    record('play', this, []);
  };
  api.pauseVideo = function () {
    record('pause', this, []);
  };
  api.seekTo = function (...args: any[]) {
    record('seek', this, args);
  };
  api.setVolume = function (...args: any[]) {
    record('set_volume', this, args);
  };
  bar.queue = {
    shuffle: function () {
      record('toggle_shuffle', this, []);
    },
  };
  bar.onRepeatButtonClick = function () {
    record('switch_repeat', this, []);
    mode = (mode + 1) % 3;
  };
  bar.getState = () => ({
    queue: { repeatMode: ['NONE', 'ALL', 'ONE'][mode] },
  });
  for (const action of ['previous', 'next']) {
    const button = doc.querySelector('.' + action + '-button') as any;
    const click = button.click;
    button.click = function () {
      record(action, this, []);
      return click.call(this);
    };
  }
  app.networkManager = {
    fetch() {
      throw Error('Unexpected provider call');
    },
  };
  w.blockerSceneGuard = {
    cancelFromUser: function () {
      record('guard', this, []);
    },
  };
  const core = source.initializeCore(api),
    registry = source.getMusicActionsOwner(api);
  const controller = source.createMusicRendererController(
    api,
    () => activeApi,
    {
      send: (_c: string, p: any) => packets.push(p),
      subscribe: (c: string, fn: any) => {
        listeners.set(c, fn);
        return () => listeners.delete(c);
      },
    },
  );
  let serial = 0;
  const read = (input: any) => {
    const request = {
      requestId:
        '00000000-0000-4000-8000-' + String(++serial).padStart(12, '0'),
      nonce: 'a'.repeat(32),
    };
    listeners.get('peard:music-owner-query')(request);
    const ready = packets.find((p) => p.requestId === request.requestId);
    listeners.get('peard:music-read')({ ...ready, input });
    return () =>
      packets.find(
        (p) => p.requestId === request.requestId && p.type === 'settled',
      )?.result;
  };
  const control = async (command: any) => {
    const result = read({
      operation: 'control',
      command,
      deadlineAt: Date.now() + 10000,
    });
    await Promise.resolve();
    await Promise.resolve();
    return result();
  };
  const current = async () => {
    const result = read({ operation: 'current' });
    await Promise.resolve();
    return result()?.value;
  };
  return {
    dom,
    w,
    doc,
    api,
    bar,
    app,
    calls,
    core,
    registry,
    controller,
    control,
    current,
    read,
    setState: (v: number) => (state = v),
    setVideo: (v: string) => {
      video = v;
      events.get('videodatachange')?.();
    },
    replaceApi: () => (activeApi = { ...api }),
    close() {
      controller.dispose();
      core.disposeMusicActionsOwner();
      core.repeatPreference.dispose();
      core.playlistQueue.dispose();
      dom.happyDOM.abort();
      Object.assign(globalThis, saved);
    },
  };
}
for (const command of commands)
  test(`C9 actual actor ${command.action} invokes captured native receiver`, async () => {
    const f = actionsFixture();
    try {
      const actual =
        command.action === 'seek'
          ? { ...command, playbackEpoch: (await f.current()).playbackEpoch }
          : command;
      const result = await f.control(actual);
      expect(result).toEqual({
        ok: true,
        value: { version: 1, phase: 'owned_control_dispatch' },
      });
      expect(f.calls[0].name).toBe('guard');
      const target = f.calls[1];
      expect(target.name).toBe(
        command.action === 'toggle_playback' ? 'play' : command.action,
      );
      const receiver =
        command.action === 'previous' || command.action === 'next'
          ? f.doc.querySelector('.' + command.action + '-button')
          : command.action === 'toggle_shuffle'
            ? f.bar.queue
            : command.action === 'switch_repeat'
              ? f.bar
              : f.api;
      expect(target.receiver).toBe(receiver);
      expect(target.args).toEqual(
        command.action === 'seek'
          ? [0]
          : command.action === 'set_volume'
            ? [0]
            : [],
      );
      expect(f.calls).toHaveLength(2);
      if (command.action === 'set_volume') {
        expect((f.doc.querySelector('#volume-slider') as any).value).toBe('0');
        expect(
          (f.doc.querySelector('#expand-volume-slider') as any).value,
        ).toBe('0');
      }
      expect(f.registry.repeatPreference).toBe(f.core.repeatPreference);
      expect(f.registry.playlistQueue).toBe(f.core.playlistQueue);
    } finally {
      f.close();
    }
  });

test('C9 strict own-data schemas and protected navigation types', async () => {
  let getters = 0;
  const bad = [
    ...[
      'insert',
      'remove',
      'clear',
      'queue_insert',
      'queue_remove',
      'queue_clear',
      'queue_add',
      'seek_by',
      'mute',
      'play_song',
    ].map((action) => ({ action })),
    { action: 'seek', seconds: -1, playbackEpoch: epoch },
    { action: 'seek', seconds: Infinity, playbackEpoch: epoch },
    { action: 'seek', seconds: Number.MAX_VALUE, playbackEpoch: epoch },
    { action: 'seek', seconds: '0', playbackEpoch: epoch },
    { action: 'seek', seconds: 0, playbackEpoch: 'legacy' },
    { action: 'set_volume', volume: 101 },
    { action: 'set_volume', volume: -1 },
    { action: 'set_volume', volume: NaN },
    { action: 'set_volume', volume: new Number(1) },
    { action: 'switch_repeat', iterations: 0 },
    { action: 'switch_repeat', iterations: 3 },
    { action: 'switch_repeat', iterations: 1.5 },
    { action: 'play', operationId: 'caller' },
    { action: 'play', extra: 0 },
    Object.create({ action: 'play' }),
    {
      get action() {
        getters++;
        return 'play';
      },
    },
    { action: 'play', [Symbol()]: true },
  ];
  for (const value of bad) expect(source.parseControlCommand(value)).toBeNull();
  expect(getters).toBe(0);
  expect(source.parseControlCommand({ action: 'switch_repeat' })).toEqual({
    action: 'switch_repeat',
    iterations: 1,
  });
  for (const volume of [0, 0.01, 100])
    expect(
      source.parseControlCommand({ action: 'set_volume', volume }),
    ).toEqual({ action: 'set_volume', volume });
  expect(() => source.parseMusicPrepareInput({ action: 'play' })).toThrow(
    'Invalid music request',
  );
  expect(
    source.parseMusicOperationPrepareInput({
      action: 'play_song',
      videoId: 'seedVideo01',
    }),
  ).toEqual({ action: 'play_song', videoId: 'seedVideo01' });
  expect(
    source.parseNativeMusicInput({
      operation: 'navigate',
      command: { action: 'play' },
      deadlineAt: Date.now() + 10000,
    }),
  ).toBeNull();
  expect(
    source.parseNativeMusicInput({
      operation: 'control',
      command: { action: 'play' },
      deadlineAt: Date.now() + 10000,
      [Symbol()]: true,
    }),
  ).toBeNull();
});

test('C9 actual core initialization publishes SAME instances and retires old owner before replacement/pagehide', async () => {
  const f = actionsFixture();
  try {
    expect(f.calls).toHaveLength(0);
    const first = f.registry,
      retained = first.current;
    const second = source.initializeCore(f.api),
      owner = source.getMusicActionsOwner(f.api);
    expect(retained()).toBe(false);
    expect(owner.repeatPreference).toBe(second.repeatPreference);
    expect(owner.playlistQueue).toBe(second.playlistQueue);
    expect(owner.repeatPreference).not.toBe(first.repeatPreference);
    expect(f.calls).toHaveLength(0);
    f.w.dispatchEvent(new f.w.Event('pagehide'));
    expect(owner.current()).toBe(false);
    expect(source.getMusicActionsOwner(f.api)).toBeUndefined();
    second.repeatPreference.dispose();
    second.playlistQueue.dispose();
  } finally {
    f.close();
  }
});

for (const mode of [
  'missing',
  'guard_throw',
  'guard_retire',
  'guard_method',
  'getter_method',
  'queue_replace',
  'partial_repeat',
  'preference_throw',
  'slider_throw',
  'identity_B',
  'identity_ABA',
  'self_transition',
  'absent_sliders',
  'no_volume_track',
])
  test(`C9 native boundary ${mode}`, async () => {
    const f = actionsFixture();
    try {
      let command: any = { action: 'play' },
        expected: any;
      if (mode === 'missing') {
        delete f.api.playVideo;
        expected = {
          ok: true,
          value: {
            version: 1,
            phase: 'pre_effect_denial',
            reason: 'unavailable',
          },
        };
      }
      if (mode === 'guard_throw')
        f.w.blockerSceneGuard.cancelFromUser = function () {
          f.calls.push({ name: 'guard' });
          throw Error('Guard failure');
        };
      if (mode === 'guard_retire')
        f.w.blockerSceneGuard.cancelFromUser = function () {
          f.calls.push({ name: 'guard' });
          f.core.disposeMusicActionsOwner();
        };
      if (mode === 'guard_method')
        f.w.blockerSceneGuard.cancelFromUser = function () {
          f.calls.push({ name: 'guard' });
          f.api.playVideo = () => f.calls.push({ name: 'stale' });
        };
      if (mode === 'getter_method') {
        const old = f.api.getPlayerState;
        f.api.getPlayerState = () => {
          f.core.disposeMusicActionsOwner();
          return old();
        };
        command = { action: 'toggle_playback' };
        expected = {
          ok: true,
          value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
        };
      }
      if (mode === 'queue_replace') {
        command = { action: 'toggle_shuffle' };
        f.w.blockerSceneGuard.cancelFromUser = function () {
          f.calls.push({ name: 'guard' });
          f.bar.queue = {
            shuffle() {
              f.calls.push({ name: 'stale' });
            },
          };
        };
      }
      if (mode === 'partial_repeat') {
        command = { action: 'switch_repeat', iterations: 2 };
        let n = 0;
        f.bar.onRepeatButtonClick = function () {
          f.calls.push({ name: 'switch_repeat' });
          if (++n === 2) throw Error('Second click');
        };
      }
      if (mode === 'preference_throw') {
        command = { action: 'switch_repeat' };
        f.core.repeatPreference.rememberUserChange = () => {
          throw Error('Preference');
        };
      }
      if (mode === 'slider_throw') {
        command = { action: 'set_volume', volume: 50 };
        Object.defineProperty(f.doc.querySelector('#volume-slider'), 'value', {
          set() {
            throw Error('Slider');
          },
          configurable: true,
        });
      }
      if (mode === 'identity_B' || mode === 'identity_ABA') {
        const snap = await f.current();
        command = {
          action: 'seek',
          seconds: 0,
          playbackEpoch: snap.playbackEpoch,
        };
        f.setVideo('other000001');
        if (mode === 'identity_ABA') f.setVideo('current0001');
        expected = {
          ok: true,
          value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
        };
      }
      if (mode === 'self_transition')
        f.api.playVideo = function () {
          f.calls.push({ name: 'play' });
          f.setVideo('other000001');
        };
      if (mode === 'absent_sliders') {
        command = { action: 'set_volume', volume: 100 };
        f.doc.querySelector('ytmusic-player-bar')?.remove();
        for (const s of ['#volume-slider', '#expand-volume-slider'])
          f.doc.querySelector(s)?.remove();
      }
      if (mode === 'no_volume_track') {
        command = { action: 'set_volume', volume: 0.01 };
        f.api.getVideoData = () => {
          throw Error('No identity');
        };
        f.api.getPlayerResponse = () => {
          throw Error('No identity');
        };
      }
      const result = await f.control(command);
      if (expected) expect(result).toEqual(expected);
      else if (
        ['self_transition', 'absent_sliders', 'no_volume_track'].includes(mode)
      )
        expect(result).toEqual({
          ok: true,
          value: { version: 1, phase: 'owned_control_dispatch' },
        });
      else expect(result.ok).toBe(false);
      if (
        [
          'guard_retire',
          'guard_method',
          'queue_replace',
          'getter_method',
          'missing',
          'identity_B',
          'identity_ABA',
        ].includes(mode)
      )
        expect(f.calls.filter((c) => c.name !== 'guard')).toHaveLength(0);
    } finally {
      f.close();
    }
  });

test('C9 repeat2 and toggle alternate state preserve ordinary useful behavior', async () => {
  const f = actionsFixture();
  try {
    expect(
      (await f.control({ action: 'switch_repeat', iterations: 2 })).ok,
    ).toBe(true);
    expect(f.calls.map((c) => c.name)).toEqual([
      'guard',
      'switch_repeat',
      'switch_repeat',
    ]);
    f.calls.length = 0;
    f.setState(3);
    expect((await f.control({ action: 'toggle_playback' })).ok).toBe(true);
    expect(f.calls.map((c) => c.name)).toEqual(['guard', 'pause']);
  } finally {
    f.close();
  }
});

test('C9 a later native getter cannot replace an already checked method descriptor', async () => {
  const f = actionsFixture();
  try {
    delete f.w.blockerSceneGuard;
    const play = f.api.playVideo,
      network = f.app.networkManager;
    let reads = 0,
      armed = false;
    Object.defineProperty(f.api, 'playVideo', {
      configurable: true,
      get() {
        if (++reads >= 2) armed = true;
        return play;
      },
    });
    Object.defineProperty(f.app, 'networkManager', {
      configurable: true,
      get() {
        if (armed) {
          armed = false;
          Object.defineProperty(f.api, 'playVideo', {
            configurable: true,
            value: () => f.calls.push({ name: 'replacement' }),
          });
        }
        return network;
      },
    });
    expect(await f.control({ action: 'play' })).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

async function operationFixture() {
  const { musicServiceFixture } = await import('./helpers/api-music-service');
  const f = await musicServiceFixture(),
    broker = (f.service as any).broker,
    admission = broker.capture();
  broker.capture = () => admission;
  const grant = await f.store.issue(
      'C9 operations',
      'rest',
      f.resource,
      ['playback.control'],
      () => true,
    ),
    calls: any[] = [];
  broker.read = (_a: any, input: any, _p: any, options: any) =>
    new Promise((resolve, reject) =>
      calls.push({ input, options, resolve, reject }),
    );
  return { ...f, broker, grant, calls, admission };
}
const until = (check: () => boolean) => expect.poll(check).toBe(true);
const savedRow = (ledger: any, row: any, calls: any[]) => ({
  present: ledger.rows.has(row.id),
  command: row.command,
  canonical: row.canonical,
  requiredScope: row.requiredScope,
  binding: row.binding,
  receipt: { ...row.receipt },
  expires: row.expires,
  executing: row.executing,
  promise: row.promise,
  physicalHold: row.physicalHold,
  timer: ledger.timer,
  calls: calls.length,
});
for (const phase of [
  'pending',
  'executing',
  'accepted',
  'failed',
  'uncertain',
  'retired',
])
  for (const context of [
    'foreign-window',
    'same-window-new-service',
    'frame',
    'generation',
    'revision',
  ])
    test(`C9 original context ${context} denies status and execute in ${phase}`, async () => {
      const f = await operationFixture();
      let second: any, execution: Promise<any> | undefined;
      try {
        const prepared = await f.service.prepare(f.grant.token, {
            action: 'play',
          }),
          command = { action: 'play', operationId: prepared.operationId },
          ledger = (f.service as any).operations,
          row = ledger.rows.get(prepared.operationId);
        expect(row.requiredScope).toBe('playback.control');
        expect(
          Object.getOwnPropertyDescriptor(row, 'requiredScope')?.writable,
        ).toBe(false);
        if (!['pending', 'retired'].includes(phase)) {
          execution = f.service
            .control(f.grant.token, command)
            .catch((e: any) => e.code);
          await until(() => f.calls.length === 1);
          if (phase === 'uncertain') {
            f.calls[0].reject(Error('Lost ACK'));
            await execution;
          } else if (phase !== 'executing') {
            f.calls[0].options.onPhysicalSettled('authenticated_ack');
            f.calls[0].resolve(
              phase === 'failed'
                ? {
                    version: 1,
                    phase: 'pre_effect_denial',
                    reason: 'unsupported',
                  }
                : { version: 1, phase: 'owned_control_dispatch' },
            );
            await execution;
          }
        }
        if (phase === 'retired' || context === 'revision')
          f.service.configure(f.config);
        let caller = f.service;
        if (
          context.includes('window') ||
          context === 'same-window-new-service'
        ) {
          second = new f.service.constructor({
            window:
              context === 'foreign-window'
                ? {}
                : (f.service as any).runtime.window,
            config: f.config,
            grants: f.store,
            broker: f.broker,
            now: (f.service as any).now,
          });
          caller = second;
        } else if (context === 'frame' || context === 'generation')
          f.broker.capture = () => ({
            ...f.admission,
            ...(context === 'frame' ? { frame: {} } : { generation: 1 }),
          });
        const before = savedRow(ledger, row, f.calls);
        await expect(
          caller.operation(f.grant.token, row.id),
        ).rejects.toMatchObject({ code: 'retired' });
        await expect(
          caller.control(f.grant.token, command),
        ).rejects.toMatchObject({ code: 'retired' });
        expect(savedRow(ledger, row, f.calls)).toEqual(before);
        if (phase === 'executing') {
          f.calls[0].options.onPhysicalSettled('authenticated_ack');
          f.calls[0].resolve({ version: 1, phase: 'owned_control_dispatch' });
          await execution;
        }
        f.broker.capture = () => f.admission;
        if (context !== 'revision' && phase !== 'retired') {
          expect(await f.service.operation(f.grant.token, row.id)).toEqual(
            row.receipt,
          );
          if (phase !== 'pending')
            expect(await f.service.control(f.grant.token, command)).toEqual(
              row.receipt,
            );
        }
        if (phase === 'uncertain')
          f.calls[0].options.onPhysicalSettled('authenticated_ack');
      } finally {
        second?.stop();
        await f.close();
      }
    });
for (const route of ['status', 'execute'])
  for (const context of ['scope', 'service', 'frame', 'generation', 'revision'])
    test(`C9 expired actual membership preserved under ${context} denial/${route}`, async () => {
      const f = await operationFixture();
      let second: any;
      try {
        const p = await f.service.prepare(f.grant.token, { action: 'pause' }),
          ledger = (f.service as any).operations,
          row = ledger.rows.get(p.operationId);
        let caller = f.service,
          token = f.grant.token;
        if (context === 'scope')
          token = (
            await f.store.issue(
              'Read only',
              'rest',
              f.resource,
              ['playback.read'],
              () => true,
            )
          ).token;
        if (context === 'service') {
          second = new f.service.constructor({
            window: {},
            config: f.config,
            grants: f.store,
            broker: f.broker,
            now: (f.service as any).now,
          });
          caller = second;
        }
        if (context === 'revision') f.service.configure(f.config);
        if (context === 'frame' || context === 'generation')
          f.broker.capture = () => ({
            ...f.admission,
            ...(context === 'frame' ? { frame: {} } : { generation: 1 }),
          });
        f.advance(120001);
        const before = savedRow(ledger, row, f.calls);
        await expect(
          route === 'status'
            ? caller.operation(token, row.id)
            : caller.control(token, { action: 'pause', operationId: row.id }),
        ).rejects.toMatchObject({
          code: context === 'scope' ? 'forbidden' : 'retired',
        });
        expect(savedRow(ledger, row, f.calls)).toEqual(before);
        f.broker.capture = () => f.admission;
        if (context !== 'revision') {
          await expect(
            f.service.operation(f.grant.token, row.id),
          ).rejects.toMatchObject({ code: 'expired_operation' });
          expect(ledger.rows.has(row.id)).toBe(false);
        }
      } finally {
        second?.stop();
        await f.close();
      }
    });
test('C9 independent TTL cleanup and executing/physical holds are separately attributed', async () => {
  const f = await operationFixture();
  try {
    const idle = await f.service.prepare(f.grant.token, { action: 'pause' }),
      active = await f.service.prepare(f.grant.token, { action: 'play' }),
      ledger = (f.service as any).operations,
      row = ledger.rows.get(active.operationId),
      timer = ledger.timer;
    const execution = f.service
      .control(f.grant.token, { action: 'play', operationId: row.id })
      .catch((e: any) => e.code);
    await until(() => f.calls.length === 1);
    f.advance(120001);
    timer._onTimeout();
    expect(ledger.rows.has(idle.operationId)).toBe(false);
    expect(ledger.rows.has(row.id)).toBe(true);
    expect(row.executing).toBe(true);
    expect(row.physicalHold).toBe(true);
    f.calls[0].reject(Error('Lost ACK'));
    await execution;
    const receipt = { ...row.receipt };
    expect(receipt.status).toBe('uncertain');
    expect(await f.service.operation(f.grant.token, row.id)).toEqual(receipt);
    expect(
      await f.service.control(f.grant.token, {
        action: 'play',
        operationId: row.id,
      }),
    ).toEqual(receipt);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    expect(ledger.rows.has(row.id)).toBe(false);
    expect(row.receipt).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('C9 canonical conflict/concurrent replay/duplicate cancellation and preparation/status are dispatch free', async () => {
  const f = await operationFixture();
  try {
    const p = await f.service.prepare(f.grant.token, {
        action: 'switch_repeat',
      }),
      command = {
        action: 'switch_repeat',
        iterations: 1,
        operationId: p.operationId,
      };
    expect(f.calls).toHaveLength(0);
    expect(await f.service.operation(f.grant.token, p.operationId)).toEqual(p);
    const original = f.service.control(f.grant.token, command);
    await until(() => f.calls.length === 1);
    const controller = new AbortController(),
      duplicate = f.service
        .control(f.grant.token, command, controller.signal)
        .catch((e: any) => e.code);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await duplicate).toBe('retired');
    expect(f.calls[0].options.signal.aborted).toBe(false);
    await expect(
      f.service.control(f.grant.token, { ...command, iterations: 2 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.calls).toHaveLength(1);
    f.calls[0].options.onPhysicalSettled('authenticated_ack');
    f.calls[0].resolve({ version: 1, phase: 'owned_control_dispatch' });
    expect((await original).status).toBe('accepted');
    expect(await f.service.control(f.grant.token, command)).toEqual(
      await f.service.operation(f.grant.token, p.operationId),
    );
    expect(f.calls).toHaveLength(1);
    await expect(
      f.service.control(f.grant.token, {
        ...command,
        operationId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'unknown_operation' });
  } finally {
    await f.close();
  }
});
for (const context of ['service', 'frame', 'revision', 'grant'])
  test(`C9 async authentication ${context} retirement precedes mutable lookup`, async () => {
    const f = await operationFixture();
    try {
      const p = await f.service.prepare(f.grant.token, { action: 'play' }),
        ledger = (f.service as any).operations,
        row = ledger.rows.get(p.operationId);
      f.authHold();
      const pending = f.service
        .control(f.grant.token, { action: 'play', operationId: p.operationId })
        .catch((e: any) => e.code);
      await new Promise((r) => setTimeout(r, 5));
      if (context === 'service') f.service.stop();
      else if (context === 'frame') f.retire();
      else if (context === 'revision') f.service.configure(f.config);
      else await f.store.revoke(f.grant.record.id, () => true);
      const before = savedRow(ledger, row, f.calls);
      f.authRelease();
      expect(['retired', 'unauthorized']).toContain(await pending);
      expect(savedRow(ledger, row, f.calls)).toEqual(before);
    } finally {
      f.authRelease();
      await f.close();
    }
  });
for (const mode of [
  'extra',
  'hidden',
  'symbol',
  'getter',
  'wrong_phase',
  'wrong_version',
  'count',
  'class',
  'denial_extra',
])
  test(`C9 strict post-effect envelope ${mode} remains uncertain`, async () => {
    const f = await operationFixture();
    try {
      const p = await f.service.prepare(f.grant.token, { action: 'play' }),
        command = { action: 'play', operationId: p.operationId };
      const pending = f.service.control(f.grant.token, command);
      await until(() => f.calls.length === 1);
      let value: any = { version: 1, phase: 'owned_control_dispatch' },
        getters = 0;
      if (mode === 'extra') value.state = 'playing';
      if (mode === 'hidden')
        Object.defineProperty(value, 'binding', {
          value: {},
          enumerable: false,
        });
      if (mode === 'symbol') value[Symbol()] = 1;
      if (mode === 'getter')
        Object.defineProperty(value, 'phase', {
          enumerable: true,
          get() {
            getters++;
            return 'owned_control_dispatch';
          },
        });
      if (mode === 'wrong_phase') value.phase = 'owned_dispatch';
      if (mode === 'wrong_version') value.version = 2;
      if (mode === 'count') value.count = 1;
      if (mode === 'class') Object.setPrototypeOf(value, { foreign: true });
      if (mode === 'denial_extra')
        value = {
          version: 1,
          phase: 'pre_effect_denial',
          reason: 'unavailable',
          count: 0,
        };
      f.calls[0].options.onPhysicalSettled('authenticated_ack');
      f.calls[0].resolve(value);
      const receipt = await pending;
      expect(receipt).toEqual({
        operationId: p.operationId,
        status: 'uncertain',
        error: 'outcome_unknown',
      });
      expect(getters).toBe(0);
      expect(await f.service.control(f.grant.token, command)).toEqual(receipt);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
test('C9 actual HTTP raw policy/action separation and unsupported queue commands do not dispatch', async () => {
  const f = await musicHttpFixture();
  try {
    const grant = await f.store.issue(
        'C9 HTTP',
        'rest',
        f.service.resource,
        ['playback.control'],
        () => true,
      ),
      headers = { authorization: 'Bearer ' + grant.token };
    for (const [target, method, body, extra] of [
      ['/api/v1/music/control', 'GET', undefined, {}],
      ['/api/v1/music/control?x=1', 'POST', '{}', {}],
      ['/api/v1/music/%63ontrol', 'POST', '{}', {}],
      ['/api/v1/music/control/', 'POST', '{}', {}],
      [
        '/api/v1/music/control',
        'POST',
        '{}',
        { origin: 'https://foreign.example' },
      ],
      ['/api/v1/music/control', 'POST', '{}', { host: 'evil.example' }],
      [
        '/api/v1/music/control',
        'POST',
        '{}',
        { authorization: 'Bearer legacy.JWT' },
      ],
      [
        '/api/v1/music/control',
        'POST',
        '{}',
        { authorization: 'Bearer ' + f.grant.token },
      ],
      ['/api/v1/music/control', 'POST', 'x'.repeat(16385), {}],
      [
        '/api/v1/music/operations/prepare',
        'POST',
        JSON.stringify({ action: 'queue_clear' }),
        {},
      ],
      [
        '/api/v1/music/play/song',
        'POST',
        JSON.stringify({ action: 'play' }),
        {},
      ],
      [
        '/api/v1/music/control',
        'POST',
        JSON.stringify({
          action: 'play_song',
          videoId: 'seedVideo01',
          operationId: '00000000-0000-4000-8000-000000000000',
        }),
        {},
      ],
    ] as any[])
      expect(
        (await f.http(target, method, body, { ...headers, ...extra })).status,
      ).toBeGreaterThanOrEqual(400);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('C9 ledger original-scope reservation retains per-principal capacity', async () => {
  const f = await operationFixture();
  try {
    for (let i = 0; i < 32; i++)
      await f.service.prepare(f.grant.token, { action: 'pause' });
    await expect(
      f.service.prepare(f.grant.token, { action: 'pause' }),
    ).rejects.toMatchObject({ code: 'busy' });
    const rows = [...(f.service as any).operations.rows.values()] as any[];
    expect(rows).toHaveLength(32);
    for (const row of rows) {
      expect(row.requiredScope).toBe('playback.control');
      expect(row.bytes).toBeGreaterThan(
        JSON.stringify(row.command).length + 'playback.control'.length,
      );
    }
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('C9 late getter replacement of button and optional guard is fenced before invocation', async () => {
  for (const mode of ['button', 'guard']) {
    const f = actionsFixture();
    try {
      delete f.w.blockerSceneGuard;
      let reads = 0;
      const button = f.doc.querySelector('.previous-button') as any,
        click = button.click;
      Object.defineProperty(button, 'click', {
        configurable: true,
        get() {
          if (++reads === 2) {
            if (mode === 'button') {
              button.remove();
              const next = f.doc.createElement('button');
              next.className = 'previous-button ytmusic-player-bar';
              f.bar.append(next);
            } else
              f.w.blockerSceneGuard = {
                cancelFromUser() {
                  f.calls.push({ name: 'new_guard' });
                },
              };
          }
          return click;
        },
      });
      expect(await f.control({ action: 'previous' })).toEqual({
        ok: true,
        value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
      });
      expect(f.calls).toHaveLength(0);
    } finally {
      f.close();
    }
  }
});

for (const replaceDuringCapture of [false, true])
  test(`C9-MR-1 actual renderer fences stable queue accessor replacement ${replaceDuringCapture}`, async ({}, testInfo) => {
    const f = actionsFixture();
    try {
      delete f.w.blockerSceneGuard;
      const oldQueue = f.bar.queue;
      const replacementQueue = {
        shuffle: function () {
          f.calls.push({
            name: 'replacement_shuffle',
            receiver: this,
            args: [],
          });
        },
      };
      let currentQueue = oldQueue,
        queueReads = 0,
        networkGetterReads = 0,
        armed = false,
        replacementObserved = false;
      Object.defineProperty(f.bar, 'queue', {
        configurable: true,
        get() {
          if (++queueReads === 2 && replaceDuringCapture) armed = true;
          return currentQueue;
        },
      });
      const originalQueueDescriptor = Object.getOwnPropertyDescriptor(
        f.bar,
        'queue',
      );
      const network = f.app.networkManager;
      Object.defineProperty(f.app, 'networkManager', {
        configurable: true,
        get() {
          networkGetterReads++;
          if (armed) {
            armed = false;
            currentQueue = replacementQueue;
            replacementObserved = true;
          }
          return network;
        },
      });
      // This callback is reached by the actual renderer's valid(job)->capture(),
      // after the dispatcher has resolved bar.queue. No context.valid substitute.
      const result = await f.control({ action: 'toggle_shuffle' });
      const witness = {
        replaceDuringCapture,
        result,
        queueReads,
        networkGetterReads,
        replacementObserved,
        descriptorUnchanged:
          Object.getOwnPropertyDescriptor(f.bar, 'queue')?.get ===
          originalQueueDescriptor?.get,
        oldReceiverCalls: f.calls.filter(
          (call) => call.name === 'toggle_shuffle',
        ).length,
        replacementCalls: f.calls.filter(
          (call) => call.name === 'replacement_shuffle',
        ).length,
        oldReceiverExact: f.calls
          .filter((call) => call.name === 'toggle_shuffle')
          .every((call) => call.receiver === oldQueue),
      };
      await writeFile(
        testInfo.outputPath('actual-actor-witness.json'),
        JSON.stringify(witness, null, 2),
      );
      expect(witness.descriptorUnchanged).toBe(true);
      if (replaceDuringCapture) {
        expect(witness.replacementObserved).toBe(true);
        expect(result).toEqual({
          ok: true,
          value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
        });
        expect(witness.oldReceiverCalls).toBe(0);
        expect(witness.replacementCalls).toBe(0);
      } else {
        expect(result).toEqual({
          ok: true,
          value: { version: 1, phase: 'owned_control_dispatch' },
        });
        expect(witness.oldReceiverCalls).toBe(1);
        expect(witness.oldReceiverExact).toBe(true);
        expect(witness.replacementCalls).toBe(0);
      }
    } finally {
      f.close();
    }
  });

for (const replaceFromMethodGetter of [false, true])
  test(`C9-MR-1 later resolved method fences its queue receiver ${replaceFromMethodGetter}`, async ({}, testInfo) => {
    const f = actionsFixture();
    try {
      delete f.w.blockerSceneGuard;
      const oldQueue = f.bar.queue,
        shuffle = oldQueue.shuffle,
        replacementQueue = {
          shuffle: function () {
            f.calls.push({
              name: 'replacement_shuffle',
              receiver: this,
              args: [],
            });
          },
        };
      let currentQueue = oldQueue,
        queueReads = 0,
        queueValueValidated = false,
        pendingUIUpdate = false,
        replacementObserved = false;
      Object.defineProperty(f.bar, 'queue', {
        configurable: true,
        get() {
          if (++queueReads > 1) queueValueValidated = true;
          return currentQueue;
        },
      });
      Object.defineProperty(oldQueue, 'shuffle', {
        configurable: true,
        get() {
          if (pendingUIUpdate) {
            pendingUIUpdate = false;
            currentQueue = replacementQueue;
            replacementObserved = true;
          }
          return shuffle;
        },
      });
      const queueDescriptor = Object.getOwnPropertyDescriptor(f.bar, 'queue'),
        methodDescriptor = Object.getOwnPropertyDescriptor(oldQueue, 'shuffle'),
        network = f.app.networkManager;
      Object.defineProperty(f.app, 'networkManager', {
        configurable: true,
        get() {
          // The actual renderer capture observes a UI update queued for the
          // provider's next method read. Both accessor descriptors stay stable.
          if (queueValueValidated && replaceFromMethodGetter)
            pendingUIUpdate = true;
          return network;
        },
      });
      const result = await f.control({ action: 'toggle_shuffle' });
      const witness = {
        replaceFromMethodGetter,
        result,
        replacementObserved,
        queueDescriptorUnchanged:
          Object.getOwnPropertyDescriptor(f.bar, 'queue')?.get ===
          queueDescriptor?.get,
        methodDescriptorUnchanged:
          Object.getOwnPropertyDescriptor(oldQueue, 'shuffle')?.get ===
          methodDescriptor?.get,
        oldReceiverCalls: f.calls.filter(
          (call) => call.name === 'toggle_shuffle',
        ).length,
        replacementCalls: f.calls.filter(
          (call) => call.name === 'replacement_shuffle',
        ).length,
      };
      await writeFile(
        testInfo.outputPath('adjacent-method-witness.json'),
        JSON.stringify(witness, null, 2),
      );
      expect(witness.queueDescriptorUnchanged).toBe(true);
      expect(witness.methodDescriptorUnchanged).toBe(true);
      if (replaceFromMethodGetter) {
        expect(witness.replacementObserved).toBe(true);
        expect(result).toEqual({
          ok: true,
          value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
        });
        expect(witness.oldReceiverCalls).toBe(0);
        expect(witness.replacementCalls).toBe(0);
      } else {
        expect(result).toEqual({
          ok: true,
          value: { version: 1, phase: 'owned_control_dispatch' },
        });
        expect(witness.oldReceiverCalls).toBe(1);
        expect(witness.replacementCalls).toBe(0);
      }
    } finally {
      f.close();
    }
  });

test('C9-MR-1 terminal method getter cannot dispatch after retiring the actual actor', async ({}, testInfo) => {
  const f = actionsFixture();
  try {
    delete f.w.blockerSceneGuard;
    const queue = f.bar.queue,
      shuffle = queue.shuffle,
      network = f.app.networkManager;
    let queueReads = 0,
      queueValidated = false,
      pendingRetirement = false,
      retired = false,
      receiverReadsAfterRetirement = 0;
    Object.defineProperty(f.bar, 'queue', {
      configurable: true,
      get() {
        if (retired) receiverReadsAfterRetirement++;
        if (++queueReads > 1) queueValidated = true;
        return queue;
      },
    });
    Object.defineProperty(queue, 'shuffle', {
      configurable: true,
      get() {
        if (pendingRetirement) {
          pendingRetirement = false;
          retired = true;
          f.controller.dispose();
        }
        return shuffle;
      },
    });
    Object.defineProperty(f.app, 'networkManager', {
      configurable: true,
      get() {
        if (queueValidated) pendingRetirement = true;
        return network;
      },
    });
    const result = await f.control({ action: 'toggle_shuffle' });
    await writeFile(
      testInfo.outputPath('terminal-retirement-witness.json'),
      JSON.stringify(
        {
          result,
          retired,
          receiverReadsAfterRetirement,
          nativeCalls: f.calls.length,
        },
        null,
        2,
      ),
    );
    expect(retired).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(f.calls).toHaveLength(0);
    expect(receiverReadsAfterRetirement).toBe(0);
  } finally {
    f.close();
  }
});

test('C9-MR-1 terminal method getter cannot dispatch into an observed new episode', async ({}, testInfo) => {
  const f = actionsFixture();
  try {
    delete f.w.blockerSceneGuard;
    const play = f.api.playVideo,
      network = f.app.networkManager;
    let methodReads = 0,
      methodValidated = false,
      pendingTrackChange = false,
      changed = false;
    Object.defineProperty(f.api, 'playVideo', {
      configurable: true,
      get() {
        if (pendingTrackChange) {
          pendingTrackChange = false;
          changed = true;
          f.setVideo('other000001');
        }
        if (++methodReads > 1) methodValidated = true;
        return play;
      },
    });
    Object.defineProperty(f.app, 'networkManager', {
      configurable: true,
      get() {
        if (methodValidated) pendingTrackChange = true;
        return network;
      },
    });
    const result = await f.control({ action: 'play' });
    await writeFile(
      testInfo.outputPath('terminal-episode-witness.json'),
      JSON.stringify({ result, changed, nativeCalls: f.calls.length }, null, 2),
    );
    expect(changed).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

for (const withGuard of [false, true])
  for (const change of ['stable', 'detach', 'adopt', 'registry'] as const)
    test(`C9-MR-2 actual actor terminal owner ${change} guard ${withGuard}`, async ({}, testInfo) => {
      const f = actionsFixture();
      const foreign = new Window();
      let replacementCore: any;
      try {
        const queue = f.bar.queue,
          shuffle = queue.shuffle,
          network = f.app.networkManager;
        let queueReads = 0,
          queueValidated = false,
          methodValidated = false,
          guardEntered = false,
          pendingChange = false,
          changed = false;
        if (withGuard)
          f.w.blockerSceneGuard.cancelFromUser = function () {
            f.calls.push({ name: 'guard', receiver: this, args: [] });
            guardEntered = true;
            methodValidated = false;
            pendingChange = false;
          };
        else delete f.w.blockerSceneGuard;
        Object.defineProperty(f.bar, 'queue', {
          configurable: true,
          get() {
            if (++queueReads > 1) queueValidated = true;
            return queue;
          },
        });
        Object.defineProperty(queue, 'shuffle', {
          configurable: true,
          get() {
            if (pendingChange && !changed && change !== 'stable') {
              pendingChange = false;
              changed = true;
              if (change === 'detach') f.api.remove();
              else if (change === 'adopt') foreign.document.body.append(f.api);
              else replacementCore = source.initializeCore(f.api);
            }
            if (queueValidated) methodValidated = true;
            return shuffle;
          },
        });
        Object.defineProperty(f.app, 'networkManager', {
          configurable: true,
          get() {
            if (methodValidated && (!withGuard || guardEntered))
              pendingChange = true;
            return network;
          },
        });
        const result = await f.control({ action: 'toggle_shuffle' });
        const witness = {
          withGuard,
          change,
          result,
          changed,
          connected: f.api.isConnected,
          inOriginalDocument: f.api.ownerDocument === f.doc,
          guardCalls: f.calls.filter((call) => call.name === 'guard').length,
          targetCalls: f.calls.filter((call) => call.name === 'toggle_shuffle')
            .length,
        };
        await writeFile(
          testInfo.outputPath('terminal-owner-witness.json'),
          JSON.stringify(witness, null, 2),
        );
        if (change === 'stable') {
          expect(result).toEqual({
            ok: true,
            value: { version: 1, phase: 'owned_control_dispatch' },
          });
          expect(witness.targetCalls).toBe(1);
          expect(witness.guardCalls).toBe(withGuard ? 1 : 0);
        } else {
          expect(changed).toBe(true);
          if (withGuard)
            expect(result).toEqual({ ok: false, reason: 'retired' });
          else
            expect(result).toEqual({
              ok: true,
              value: {
                version: 1,
                phase: 'pre_effect_denial',
                reason: 'retired',
              },
            });
          expect(witness.targetCalls).toBe(0);
          expect(witness.guardCalls).toBe(withGuard ? 1 : 0);
        }
      } finally {
        replacementCore?.disposeMusicActionsOwner();
        replacementCore?.repeatPreference.dispose();
        replacementCore?.playlistQueue.dispose();
        await foreign.happyDOM.abort();
        f.close();
      }
    });

test('C9-MR-2 native owner proof ignores instance DOM method shadowing without disabling legitimate getters', async () => {
  const f = actionsFixture();
  try {
    let instanceRootReads = 0,
      connectionReads = 0;
    Object.defineProperty(f.api, 'getRootNode', {
      configurable: true,
      get() {
        instanceRootReads++;
        throw Error('Instance DOM method must not be called');
      },
    });
    Object.defineProperty(f.api, 'isConnected', {
      configurable: true,
      get() {
        connectionReads++;
        return true;
      },
    });
    expect(await f.control({ action: 'toggle_shuffle' })).toEqual({
      ok: true,
      value: { version: 1, phase: 'owned_control_dispatch' },
    });
    expect(instanceRootReads).toBe(0);
    expect(connectionReads).toBeGreaterThan(0);
    expect(f.calls.map((call) => call.name)).toEqual([
      'guard',
      'toggle_shuffle',
    ]);
  } finally {
    f.close();
  }
});

test('C9-MR-2 captured owner cannot be masked by an own isConnected accessor after detach', async () => {
  const f = actionsFixture();
  try {
    delete f.w.blockerSceneGuard;
    const queue = f.bar.queue,
      shuffle = queue.shuffle,
      network = f.app.networkManager;
    let queueReads = 0,
      queueValidated = false,
      methodValidated = false,
      pending = false,
      detached = false;
    Object.defineProperty(f.api, 'isConnected', {
      configurable: true,
      get() {
        return true;
      },
    });
    Object.defineProperty(f.api, 'getRootNode', {
      configurable: true,
      get() {
        throw Error('No instance DOM method lookup');
      },
    });
    Object.defineProperty(f.bar, 'queue', {
      configurable: true,
      get() {
        if (++queueReads > 1) queueValidated = true;
        return queue;
      },
    });
    Object.defineProperty(queue, 'shuffle', {
      configurable: true,
      get() {
        if (pending && !detached) {
          pending = false;
          detached = true;
          f.api.remove();
        }
        if (queueValidated) methodValidated = true;
        return shuffle;
      },
    });
    Object.defineProperty(f.app, 'networkManager', {
      configurable: true,
      get() {
        if (methodValidated) pending = true;
        return network;
      },
    });
    expect(await f.control({ action: 'toggle_shuffle' })).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(detached).toBe(true);
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('C9-MR-2 later target getter cannot invoke a replaced guard receiver', async ({}, testInfo) => {
  const f = actionsFixture();
  try {
    const first = f.w.blockerSceneGuard,
      queue = f.bar.queue,
      shuffle = queue.shuffle,
      network = f.app.networkManager;
    const replacement = {
      cancelFromUser() {
        f.calls.push({ name: 'replacement_guard', receiver: this, args: [] });
      },
    };
    let currentGuard = first,
      queueReads = 0,
      queueValidated = false,
      methodValidated = false,
      pending = false,
      replaced = false;
    Object.defineProperty(f.w, 'blockerSceneGuard', {
      configurable: true,
      get() {
        return currentGuard;
      },
    });
    Object.defineProperty(f.bar, 'queue', {
      configurable: true,
      get() {
        if (++queueReads > 1) queueValidated = true;
        return queue;
      },
    });
    Object.defineProperty(queue, 'shuffle', {
      configurable: true,
      get() {
        if (pending && !replaced) {
          pending = false;
          replaced = true;
          currentGuard = replacement;
        }
        if (queueValidated) methodValidated = true;
        return shuffle;
      },
    });
    Object.defineProperty(f.app, 'networkManager', {
      configurable: true,
      get() {
        if (methodValidated) pending = true;
        return network;
      },
    });
    const result = await f.control({ action: 'toggle_shuffle' });
    await writeFile(
      testInfo.outputPath('guard-owner-witness.json'),
      JSON.stringify(
        { result, replaced, calls: f.calls.map((call) => call.name) },
        null,
        2,
      ),
    );
    expect(replaced).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: { version: 1, phase: 'pre_effect_denial', reason: 'retired' },
    });
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('C9-MR-2 unsupported non-DOM bridge publication does not throw or admit new controls', () => {
  const f = actionsFixture();
  let retire: (() => void) | undefined;
  try {
    let volumes = 0;
    const api = {
      isConnected: true,
      setVolume() {
        volumes++;
      },
    };
    expect(() => {
      retire = source.publishMusicActionsOwner(api, {
        repeatPreference: f.core.repeatPreference,
        playlistQueue: f.core.playlistQueue,
        getApi: () => api,
      });
    }).not.toThrow();
    expect(() =>
      source.dispatchMusicControl(
        api,
        { action: 'set_volume', volume: 1 },
        {
          current: () => true,
          valid: () => true,
          probe() {
            throw Error('No track prerequisite');
          },
          enter() {},
        },
      ),
    ).toThrow();
    expect(volumes).toBe(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    retire?.();
    f.close();
  }
});

// Adapted from pear-devs/pear-desktop#4750 by @adriellpz.
// Exercise actual registered core handlers and the owned native C9 controller.
for (const action of ['previous', 'next'] as const) {
  test(`player UI ${action}: C9 uses captured API without legacy controls`, async () => {
    const f = actionsFixture();
    try {
      f.bar.remove();
      f.api[action + 'Video'] = function (...args: unknown[]) {
        f.calls.push({ name: action, receiver: this, args });
      };
      expect(await f.control({ action })).toEqual({
        ok: true,
        value: { version: 1, phase: 'owned_control_dispatch' },
      });
      expect(f.calls.map((c: any) => c.name)).toEqual(['guard', action]);
      expect(f.calls[1].receiver).toBe(f.api);
      expect(f.calls[1].args).toEqual([]);
    } finally {
      f.close();
    }
  });

  test(`player UI ${action}: actual legacy IPC prefers button and falls back to API`, () => {
    for (const legacy of [true, false]) {
      const f = actionsFixture();
      try {
        const handlers = new Map<string, () => void>();
        f.w.ipcRenderer.on = (channel: string, callback: () => void) =>
          handlers.set(channel, callback);
        f.api[action + 'Video'] = function (...args: unknown[]) {
          f.calls.push({ name: action, receiver: this, args });
        };
        const button = f.doc.querySelector('.' + action + '-button');
        if (!legacy) f.bar.remove();
        source.registerLegacyNavigation();
        const handler = handlers.get('peard:' + action + '-video');
        expect(handler).toBeDefined();
        handler!();
        expect(f.calls.map((c: any) => c.name)).toEqual(['guard', action]);
        expect(f.calls[1].receiver).toBe(legacy ? button : f.api);
        expect(f.calls[1].args).toEqual([]);
      } finally {
        f.close();
      }
    }
  });

  test(`player UI ${action}: C9 absent API stays unavailable without dispatch`, async () => {
    const f = actionsFixture();
    try {
      f.bar.remove();
      expect(await f.control({ action })).toEqual({
        ok: true,
        value: {
          version: 1,
          phase: 'pre_effect_denial',
          reason: 'unavailable',
        },
      });
      expect(f.calls).toEqual([]);
    } finally {
      f.close();
    }
  });

  test(`player UI ${action}: C9 captured fallback rejects reentrant replacement`, async () => {
    for (const mode of ['button', 'method', 'owner', 'playback'] as const) {
      const f = actionsFixture();
      try {
        f.bar.remove();
        const method = action + 'Video';
        f.api[method] = function () {
          f.calls.push({ name: action, receiver: this, args: [] });
        };
        f.w.blockerSceneGuard.cancelFromUser = () => {
          f.calls.push({ name: 'guard' });
          if (mode === 'button') {
            const button = f.doc.createElement('button');
            button.className = action + '-button ytmusic-player-bar';
            button.click = () => {
              f.calls.push({ name: 'replacement-button' });
            };
            f.doc.body.append(button);
          } else if (mode === 'method') {
            f.api[method] = () => {
              f.calls.push({ name: 'replacement-method' });
            };
          } else if (mode === 'owner') f.replaceApi();
          else f.setVideo('replaced001');
        };
        expect(await f.control({ action })).toEqual({
          ok: false,
          reason: 'retired',
        });
        expect(f.calls.map((c: any) => c.name)).toEqual(['guard']);
      } finally {
        f.close();
      }
    }
  });
}
