import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Execute the actual plugin definition; only external dependency hosts are injected.
const source = stripTypeScriptTypes(
  readFileSync(new URL('../src/plugins/crossfade/index.ts', import.meta.url), 'utf8'),
).replace(/^import[\s\S]*?;\s*$/gm, '')
  .replace('export default', 'globalThis.plugin =');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function host(options = {}) {
  const video = Object.assign(new EventTarget(), {
    currentTime: 20, duration: 100, paused: false,
    volume: 0.73, muted: true, playbackRate: 2,
  });
  const navigation = Object.assign(new EventTarget(), {
    currentEntry: { url: 'https://fixture.invalid/watch?v=A' },
  });
  const calls = { streams: [], next: 0, warnings: [], releases: 0, unsubscribes: 0,
    activeMain: 0 };
  const audios = [], faders = [], gains = [], handlers = [], listeners = new Set();
  const foreign = { events: 0, owner: 'same-clamped-owner' };
  const foreignListener = () => foreign.events++;
  listeners.add(foreignListener);
  video.addEventListener('pause', foreignListener);
  const statuses = [];
  const graph = {
    disconnect() { assert.fail('shared graph must remain connected'); },
    audioContext: { state: 'running', createGain() {
      const gain = { gain: { value: 1 }, disconnected: false,
        disconnect() { this.disconnected = true; } };
      gains.push(gain); return gain;
    } },
    // renderer-audio grants one exclusive main insertion, released idempotently.
    insertMain() {
      if (calls.activeMain) throw new Error('The music insert is already owned');
      calls.activeMain = 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        calls.activeMain = 0;
        calls.releases++;
      };
    },
  };
  class Auxiliary {
    constructor(url) {
      this.url = url; this.element = { volume: 0 }; this.unloaded = false;
      this.seeks = []; this.plays = 0; this.pauses = 0;
      this.load = deferred(); this.playResult = deferred();
      this.ready = this.load.promise;
      if (!options.holdReady) this.load.resolve();
      if (!options.holdPlay) this.playResult.resolve();
      audios.push(this);
    }
    state() { return this.unloaded ? 'unloaded' : 'loaded'; }
    bindUserVolume(main) { assert.equal(main, video); }
    seek(time) { this.seeks.push(time); }
    play() { this.plays++; return this.playResult.promise; }
    pause() { this.pauses++; }
    unload() { this.unloaded = true; }
  }
  class Fader {
    constructor(media, config) {
      this.media = media; this.stopped = false;
      if (config.initialVolume !== undefined) media.volume = config.initialVolume;
      faders.push(this);
    }
    stop() { this.stopped = true; }
    fadeOut(done) { this.media.volume = 0.4; this.done = done; }
    fadeTo(_volume, done) { this.media.volume = 0.5; this.done = done; }
  }
  const context = vm.createContext({
    AbortController, URLSearchParams, Promise, Set,
    createPlugin: (definition) => definition,
    t: (key) => key, getCurrentAudioGraph: () => options.noGraph ? null : graph,
    VolumeFader: Fader, TransitionAudio: Auxiliary,
    console: { warn: (...args) => calls.warnings.push(args) },
    window: { navigation },
    document: {
      querySelector: (selector) => selector === 'video' ? video : { click() { calls.next++; } },
      createElement() {
        const status = { style: {}, isConnected: false, textContent: '',
          setAttribute() {}, remove() { this.isConnected = false; } };
        statuses.push(status); return status;
      },
      body: { append(status) { status.isConnected = true; } },
    },
  });
  new vm.Script(source, { filename: 'crossfade/index.ts' }).runInContext(context);
  const renderer = context.plugin.renderer;
  const ipc = { on() { assert.fail('unowned listener fallback'); },
    removeAllListeners() { assert.fail('global listener removal'); },
    invoke(channel, id) {
    assert.equal(channel, 'audio-url'); calls.streams.push(id);
    return options.lookup ? options.lookup(id) : Promise.resolve(`stream:${id}`);
  } };
  if (options.subscription !== 'missing') ipc.subscribe = (channel, callback) => {
    assert.equal(channel, 'peard:playback-speed-step');
    handlers.push(callback); listeners.add(callback);
    options.acquiring?.({ renderer, callback, calls, listeners, navigation });
    if (options.subscription === 'throw') throw new Error('unsupported');
    if (options.subscription === 'noncallable') return 17;
    return () => {
      calls.unsubscribes++; listeners.delete(callback);
      options.disposing?.({ renderer, calls });
    };
  };
  if (options.subscription === 'notfunction') ipc.subscribe = 17;
  await renderer.start({ ipc, getConfig: async () => context.plugin.config });
  const h = { renderer, video, navigation, calls, audios, faders, gains, handlers,
    listeners, foreign, statuses,
    speed(...args) { for (const callback of [...listeners]) callback(...args); },
    navigate(id) {
      const event = new Event('navigate');
      event.destination = { url: `https://fixture.invalid/watch?v=${id}` };
      navigation.dispatchEvent(event);
    },
  };
  renderer.onPlayerApiReady();
  return h;
}

async function heldFade(h) {
  h.navigate('B'); await flush();
  assert.equal(h.audios.length, 1);
  h.navigate('C');
  assert.equal(h.gains.at(-1).gain.value, 0);
  return h.faders.at(-1);
}

// Break caught: no speed subscriber, or a command inferred from rate/owner changes.
for (const direction of [1, -1]) test(`speed ${direction} cancels a held fade with unchanged rate and owner`, async () => {
  const h = await host();
  h.video.playbackRate = direction === 1 ? 2 : 0.25;
  const fade = await heldFade(h);
  h.speed(direction); await flush();
  assert.equal(fade.stopped, true);
  assert.equal(h.audios[0].unloaded, true);
  assert.equal(h.gains[0].gain.value, 1);
  assert.equal(h.calls.releases, 0);
  assert.deepEqual([h.video.volume, h.video.muted, h.video.playbackRate, h.foreign.owner],
    [0.73, true, direction === 1 ? 2 : 0.25, 'same-clamped-owner']);
  const seeks = h.audios[0].seeks.length;
  h.video.dispatchEvent(new Event('seeking'));
  h.video.dispatchEvent(new Event('pause'));
  assert.equal(h.audios[0].seeks.length, seeks);
  assert.equal(h.audios[0].pauses, 0);
  assert.equal(h.foreign.events, 2); // speed listener and unrelated pause listener
  fade.done(); await flush();
  assert.deepEqual(h.calls.streams, ['B']);
  assert.equal(h.calls.warnings.length, 0);
  assert.equal(h.statuses.some((status) => status.isConnected), false);
  h.renderer.stop();
});

// Break caught: allocating the request only after waiting revives cancelled navigation.
test('cancellation fences queued navigation and old fade completion without consuming a newer wait', async () => {
  const h = await host(); const oldFade = await heldFade(h);
  h.navigate('D'); h.speed(1); await flush();
  assert.deepEqual(h.calls.streams, ['B']);
  h.navigate('E'); await flush();
  assert.deepEqual(h.calls.streams, ['B', 'E']);
  h.navigate('F'); const freshFade = h.faders.at(-1);
  h.navigate('G'); oldFade.done(); await flush();
  assert.deepEqual(h.calls.streams, ['B', 'E']);
  assert.equal(freshFade.stopped, false);
  h.speed(-1); await flush();
  assert.equal(freshFade.stopped, true);
  oldFade.done(); freshFade.done(); await flush();
  assert.deepEqual(h.calls.streams, ['B', 'E']);
  h.navigate('H'); await flush();
  assert.deepEqual(h.calls.streams, ['B', 'E', 'H']);
  h.renderer.stop();
});

// Break caught: missing request invalidation allows late URL allocation or error UI.
for (const reject of [false, true]) test(`late stream ${reject ? 'rejection' : 'resolution'} stays retired`, async () => {
  const lookup = deferred(); const h = await host({ lookup: () => lookup.promise });
  h.navigate('B'); await flush(); h.speed(1);
  if (reject) lookup.reject(new Error('late URL')); else lookup.resolve('stream:B');
  await flush(); assert.equal(h.audios.length, 0); assert.equal(h.calls.warnings.length, 0);
  h.renderer.stop();
});

// Break caught: stale ready/play continuations mutate a replacement envelope or show errors.
for (const phase of ['ready', 'play']) for (const reject of [false, true])
  test(`late ${phase} ${reject ? 'rejection' : 'resolution'} cannot affect fresh navigation`, async () => {
    const h = await host({ holdReady: phase === 'ready', holdPlay: phase === 'play' });
    h.navigate('B'); await flush(); const old = h.audios[0];
    if (phase === 'play') { h.video.dispatchEvent(new Event('play')); await flush(); }
    h.speed(-1); h.navigate('C'); await flush();
    const pending = phase === 'ready' ? old.load : old.playResult;
    if (reject) pending.reject(new Error('late media')); else pending.resolve();
    await flush();
    assert.equal(old.unloaded, true);
    assert.equal(h.audios.length, 2);
    assert.equal(h.audios[1].unloaded, false);
    assert.equal(h.gains[0].gain.value, 1);
    assert.equal(h.calls.warnings.length, 0);
    if (phase === 'ready') assert.equal(old.plays, 0);
    h.renderer.stop();
  });

// Break caught: accepting extra arguments, strings, zero, or acquiring callbacks too early.
test('invalid commands leave a held fade running', async () => {
  const h = await host();
  const fade = await heldFade(h);
  for (const args of [[], [0], ['1'], [NaN], [2], [1, -1], [-1, undefined], [{}]]) h.speed(...args);
  await flush(); assert.equal(fade.stopped, false);
  fade.done(); await flush(); assert.deepEqual(h.calls.streams, ['B', 'C']);
  h.renderer.stop();
});

test('synchronous subscription callback cannot cancel navigation begun during acquisition', async () => {
  const h = await host({ acquiring: ({ callback, navigation }) => {
    const event = new Event('navigate');
    event.destination = { url: 'https://fixture.invalid/watch?v=B' };
    navigation.dispatchEvent(event);
    callback(1);
  } });
  await flush(); assert.deepEqual(h.calls.streams, ['B']);
  assert.equal(h.audios.length, 1); h.renderer.stop();
});

// Break caught: unsupported providers activate retained callbacks or invoke global removal.
for (const subscription of ['missing', 'throw', 'noncallable', 'notfunction'])
  test(`${subscription} subscriber is inert and keeps foreign listeners`, async () => {
    const h = await host({ subscription }); const fade = await heldFade(h);
    h.speed(1); await flush(); assert.equal(fade.stopped, false);
    fade.done(); await flush(); assert.deepEqual(h.calls.streams, ['B', 'C']);
    h.renderer.stop();
    assert.equal(h.listeners.size >= 1, true);
    assert.equal(h.calls.unsubscribes, 0);
    assert.equal(h.calls.warnings.length, 0);
  });

// Break caught: stale subscription/fade replay or non-idempotent stop affects replacement.
test('stop and readiness replacement release only owned listeners and stale callbacks stay inert', async () => {
  const h = await host(); const oldFade = await heldFade(h); const oldHandler = h.handlers[0];
  h.renderer.onPlayerApiReady(); await flush();
  assert.equal(h.calls.unsubscribes, 1); assert.equal(h.listeners.size, 2);
  h.navigate('E'); await flush(); h.navigate('F'); const fresh = h.faders.at(-1);
  oldHandler(1); oldFade.done(); await flush();
  assert.equal(fresh.stopped, false);
  assert.deepEqual(h.calls.streams, ['B', 'E']);
  h.speed(1); h.speed(-1); h.renderer.stop(); h.renderer.stop(); await flush();
  assert.equal(h.calls.unsubscribes, 2); assert.equal(h.calls.releases, 2);
  assert.equal(h.listeners.size, 1);
  h.handlers[1](1); fresh.done(); await flush();
  assert.deepEqual(h.calls.streams, ['B', 'E']);
});

// Break caught: publishing disposal after subscribe leaks the handle returned after retirement.
for (const action of ['stop', 'replace']) test(`${action} during acquisition immediately retires the late handle`, async () => {
  let entered = false;
  const h = await host({ acquiring: ({ renderer, callback }) => {
    callback(1);
    if (entered) return; entered = true;
    if (action === 'stop') renderer.stop(); else renderer.onPlayerApiReady();
  } });
  assert.equal(h.calls.unsubscribes, 1);
  assert.equal(h.listeners.size, action === 'stop' ? 1 : 2);
  h.navigate('B'); await flush();
  assert.deepEqual(h.calls.streams, action === 'stop' ? [] : ['B']);
  h.renderer.stop(); assert.equal(h.listeners.size, 1);
});

// Break caught: unsubscribe reentry clobbers a new disposer or recursively invokes itself.
for (const action of ['stop', 'replace']) test(`${action} during unsubscribe cannot clobber the newest lifetime`, async () => {
  let entered = false;
  const h = await host({ disposing: ({ renderer }) => {
    if (entered) return; entered = true;
    if (action === 'stop') renderer.stop(); else renderer.onPlayerApiReady();
  } });
  h.renderer.onPlayerApiReady(); await flush();
  assert.equal(h.calls.unsubscribes, 1);
  assert.equal(h.listeners.size, action === 'stop' ? 1 : 2);
  assert.equal(h.calls.activeMain, action === 'stop' ? 0 : 1);
  if (action === 'replace') {
    h.renderer.onPlayerApiReady();
    assert.equal(h.calls.activeMain, 1);
    assert.equal(h.calls.releases, 2);
  }
  h.navigate('B'); await flush();
  assert.deepEqual(h.calls.streams, action === 'stop' ? [] : ['B']);
  h.renderer.stop(); assert.equal(h.listeners.size, 1);
  assert.equal(h.calls.activeMain, 0);
});

test('a missing graph acquires no speed listener', async () => {
  const h = await host({ noGraph: true });
  assert.equal(h.handlers.length, 0); h.renderer.stop(); assert.equal(h.listeners.size, 1);
});

test('stop followed by readiness supports fresh navigation and real lookup errors remain visible', async () => {
  const lookup = deferred(); const h = await host({ lookup: () => lookup.promise });
  h.renderer.stop(); h.renderer.onPlayerApiReady();
  h.navigate('B'); await flush();
  assert.deepEqual(h.calls.streams, ['B']);
  lookup.reject(new Error('current lookup failed')); await flush();
  assert.equal(h.calls.warnings.length, 1);
  assert.equal(h.statuses.filter((status) => status.isConnected).length, 1);
  assert.equal(h.statuses.at(-1).textContent, 'plugins.crossfade.route-unavailable');
  h.renderer.stop();
});
