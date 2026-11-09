import { test, expect } from '@playwright/test';
import { playbackPitchNative } from './helpers/playback-pitch-native';

test('a native getter owner transfer retires the obsolete acquisition before it can install or write', async () => {
  const result = await playbackPitchNative(async () => {
    document.body.innerHTML =
      '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
    const source = (window as any).pitchSource;
    const video = document.querySelector('video')!;
    const native = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'preservesPitch',
    )!;
    const controller = source.createSlowedReverbController();
    await controller.start({
      getConfig: async () => ({ active: true, slow: 0.8, reverbIntensity: 0 }),
      setConfig: async () => {},
    });
    let armed = false;
    let transfers = 0;
    const get = function (this: HTMLVideoElement) {
      if (armed) {
        armed = false;
        transfers++;
        source.claimPlaybackRate('slowed-reverb', 0.8);
      }
      return native.get!.call(this);
    };
    const set = function (this: HTMLVideoElement, value: boolean) {
      native.set!.call(this, value);
    };
    Object.defineProperty(video, 'preservesPitch', {
      configurable: true,
      get,
      set,
    });
    source.playbackSpeed.onPlayerApiReady();
    source.playbackSpeed.onConfigChange({
      enabled: true,
      preservesPitch: true,
    });
    armed = true;
    const input = document.querySelector<HTMLInputElement>(
      '#native-pitch-speed',
    )!;
    input.value = '2';
    input.dispatchEvent(new Event('change'));
    const current = {
      owner: source.getPlaybackRateOwner(video),
      pitch: video.preservesPitch,
      rate: video.playbackRate,
      transfers,
    };
    source.playbackSpeed.onUnload();
    controller.stop();
    const after = Object.getOwnPropertyDescriptor(video, 'preservesPitch');
    const prototype = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'preservesPitch',
    );
    return {
      current,
      originalGetterRestored: after?.get === get,
      originalSetterRestored: after?.set === set,
      nativePrototypeIntact:
        prototype?.get === native.get && prototype?.set === native.set,
    };
  });
  expect(result).toEqual({
    current: { owner: 'slowed-reverb', pitch: false, rate: 0.8, transfers: 1 },
    originalGetterRestored: true,
    originalSetterRestored: true,
    nativePrototypeIntact: true,
  });
});

test('native setter and restoration getter reentry preserve the latest owner and leave no obsolete descriptor', async () => {
  const results = await playbackPitchNative(async () => {
    const source = (window as any).pitchSource;
    const results = [];
    for (const phase of ['setter', 'restoration-getter']) {
      document.body.innerHTML =
        '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
      const video = document.querySelector('video')!;
      const native = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'preservesPitch',
      )!;
      const controller = source.createSlowedReverbController();
      await controller.start({
        getConfig: async () => ({
          active: true,
          slow: 0.8,
          reverbIntensity: 0,
        }),
        setConfig: async () => {},
      });
      let armed = false;
      let transfers = 0;
      const transfer = () => {
        if (armed) {
          armed = false;
          transfers++;
          source.claimPlaybackRate('slowed-reverb', 0.8);
        }
      };
      const get = function (this: HTMLVideoElement) {
        if (phase === 'restoration-getter') transfer();
        return native.get!.call(this);
      };
      const set = function (this: HTMLVideoElement, value: boolean) {
        if (phase === 'setter') transfer();
        native.set!.call(this, value);
      };
      Object.defineProperty(video, 'preservesPitch', {
        configurable: true,
        get,
        set,
      });
      source.playbackSpeed.onPlayerApiReady();
      source.playbackSpeed.onConfigChange({
        enabled: true,
        preservesPitch: true,
      });
      armed = phase === 'setter';
      const input = document.querySelector<HTMLInputElement>(
        '#native-pitch-speed',
      )!;
      input.value = phase === 'setter' ? '2.1' : '2.2';
      input.dispatchEvent(new Event('change'));
      if (phase === 'restoration-getter') {
        armed = true;
        source.playbackSpeed.onUnload();
      }
      const current = {
        owner: source.getPlaybackRateOwner(video),
        pitch: video.preservesPitch,
        transfers,
      };
      source.playbackSpeed.onUnload();
      controller.stop();
      const after = Object.getOwnPropertyDescriptor(video, 'preservesPitch');
      results.push({
        phase,
        current,
        originalGetterRestored: after?.get === get,
        originalSetterRestored: after?.set === set,
      });
    }
    return results;
  });
  expect(results).toEqual(
    ['setter', 'restoration-getter'].map((phase) => ({
      phase,
      current: { owner: 'slowed-reverb', pitch: false, transfers: 1 },
      originalGetterRestored: true,
      originalSetterRestored: true,
    })),
  );
});

test('actual source transfers native pitch at the same rate without a native ratechange or stale cleanup', async () => {
  const result = await playbackPitchNative(async () => {
    document.body.innerHTML =
      '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
    const source = (window as any).pitchSource;
    const video = document.querySelector('video')!;
    const native = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'preservesPitch',
    );
    video.preservesPitch = false;
    const nativeControl = video.preservesPitch;
    video.preservesPitch = true;
    let rateEvents = 0;
    video.addEventListener('ratechange', () => rateEvents++);
    const nativeRateChange = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Native ratechange control missing')),
        1500,
      );
      video.addEventListener(
        'ratechange',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    const controller = source.createSlowedReverbController();
    await controller.start({
      getConfig: async () => ({ active: true, slow: 0.8, reverbIntensity: 0 }),
      setConfig: async () => {},
    });
    await nativeRateChange;
    const before = rateEvents;
    source.playbackSpeed.onPlayerApiReady();
    const input = document.querySelector<HTMLInputElement>(
      '#native-pitch-speed',
    )!;
    input.value = '0.8';
    input.dispatchEvent(new Event('change'));
    const handover = {
      pitch: video.preservesPitch,
      rate: video.playbackRate,
      owner: source.getPlaybackRateOwner(video),
    };
    controller.stop();
    const afterStaleStop = video.preservesPitch;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const extraRateEvents = rateEvents - before;
    source.playbackSpeed.onConfigChange({
      enabled: true,
      preservesPitch: false,
    });
    const second = source.createSlowedReverbController();
    await second.start({
      getConfig: async () => ({ active: true, slow: 0.8, reverbIntensity: 0 }),
      setConfig: async () => {},
    });
    source.playbackSpeed.onConfigChange({
      enabled: true,
      preservesPitch: true,
    });
    const reverse = {
      pitch: video.preservesPitch,
      owner: source.getPlaybackRateOwner(video),
    };
    source.playbackSpeed.onUnload();
    const afterSpeedStop = video.preservesPitch;
    second.stop();
    const after = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'preservesPitch',
    );
    return {
      nativeControl,
      nativeRateEvents: before,
      handover,
      afterStaleStop,
      extraRateEvents,
      reverse,
      afterSpeedStop,
      finalPitch: video.preservesPitch,
      nativeDescriptorIntact:
        native?.get === after?.get && native?.set === after?.set,
      ownWrapperGone: !Object.hasOwn(video, 'preservesPitch'),
      muted: video.muted,
      volume: video.volume,
      paused: video.paused,
    };
  });
  expect(result).toEqual({
    nativeControl: false,
    nativeRateEvents: 1,
    handover: { pitch: true, rate: 0.8, owner: 'playback-speed' },
    afterStaleStop: true,
    extraRateEvents: 0,
    reverse: { pitch: false, owner: 'slowed-reverb' },
    afterSpeedStop: false,
    finalPitch: true,
    nativeDescriptorIntact: true,
    ownWrapperGone: true,
    muted: false,
    volume: 1,
    paused: true,
  });
});

test('native equal-valued foreign setter writes and foreign readonly descriptors survive teardown and reentry', async () => {
  const result = await playbackPitchNative(async () => {
    document.body.innerHTML =
      '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
    const source = (window as any).pitchSource;
    const video = document.querySelector('video')!;
    const start = (rate: number) => {
      source.playbackSpeed.onPlayerApiReady();
      source.playbackSpeed.onConfigChange({
        enabled: true,
        preservesPitch: false,
      });
      const input = document.querySelector<HTMLInputElement>(
        '#native-pitch-speed',
      )!;
      input.value = String(rate);
      input.dispatchEvent(new Event('change'));
    };
    start(2);
    video.preservesPitch = false;
    source.playbackSpeed.onUnload();
    const equal = {
      pitch: video.preservesPitch,
      own: Object.hasOwn(video, 'preservesPitch'),
    };
    video.preservesPitch = true;
    start(2.1);
    video.preservesPitch = true;
    source.playbackSpeed.onUnload();
    const different = {
      pitch: video.preservesPitch,
      own: Object.hasOwn(video, 'preservesPitch'),
    };
    Object.defineProperty(video, 'preservesPitch', {
      configurable: false,
      writable: false,
      value: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(video, 'preservesPitch');
    start(2.2);
    source.playbackSpeed.onConfigChange({
      enabled: true,
      preservesPitch: true,
    });
    source.playbackSpeed.onUnload();
    const after = Object.getOwnPropertyDescriptor(video, 'preservesPitch');
    return {
      equal,
      different,
      readonly: {
        pitch: video.preservesPitch,
        configurable: after?.configurable,
        writable: after?.writable,
      },
      descriptorIntact: JSON.stringify(descriptor) === JSON.stringify(after),
      owner: source.getPlaybackRateOwner(video),
    };
  });
  expect(result).toEqual({
    equal: { pitch: false, own: false },
    different: { pitch: true, own: false },
    readonly: { pitch: false, configurable: false, writable: false },
    descriptorIntact: true,
    owner: null,
  });
});

test('foreign assignment through every supported native pitch alias survives conditional cleanup', async () => {
  const result = await playbackPitchNative(async () => {
    document.body.innerHTML =
      '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
    const source = (window as any).pitchSource;
    const outcomes: { key: string; before: unknown[]; after: unknown[] }[] = [];
    const keys = [
      'preservesPitch',
      'mozPreservesPitch',
      'webkitPreservesPitch',
    ];
    for (const [index, key] of keys.entries()) {
      const video = document.createElement('video') as any;
      document.querySelector('video')!.replaceWith(video);
      if (typeof video[key] !== 'boolean') continue;
      source.playbackSpeed.onPlayerApiReady();
      source.playbackSpeed.onConfigChange({
        enabled: true,
        preservesPitch: false,
      });
      const input = document.querySelector<HTMLInputElement>(
        '#native-pitch-speed',
      )!;
      input.value = String(2 + index / 10);
      input.dispatchEvent(new Event('change'));
      video[key] = false;
      const before = keys.map((name) =>
        typeof video[name] === 'boolean' ? video[name] : null,
      );
      source.playbackSpeed.onUnload();
      const after = keys.map((name) =>
        typeof video[name] === 'boolean' ? video[name] : null,
      );
      outcomes.push({ key, before, after });
    }
    return outcomes;
  });
  expect(result.length).toBeGreaterThan(0);
  for (const outcome of result)
    expect(outcome.after, outcome.key).toEqual(outcome.before);
});

test('normal native setter callouts preserve foreign intent through later cleanup', async () => {
  const results = await playbackPitchNative(async () => {
    const source = (window as any).pitchSource;
    const results = [];
    for (const phase of [
      'nested-preference-setter',
      'throwing-foreign-setter',
    ]) {
      document.body.innerHTML =
        '<div id="movie_player"><video></video></div><ytmusic-popup-container><ytmusic-menu-popup-renderer></ytmusic-menu-popup-renderer></ytmusic-popup-container>';
      const video = document.querySelector('video')!;
      const native = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'preservesPitch',
      )!;
      if (!native.get || !native.set)
        throw new Error('Native pitch accessor missing');
      let armed = phase === 'nested-preference-setter',
        foreignWrites = 0,
        rejected = false;
      const get = function (this: HTMLVideoElement) {
        return native.get!.call(this);
      };
      const set = function (this: HTMLVideoElement, next: boolean) {
        native.set!.call(this, next);
        if (!armed) return;
        armed = false;
        if (phase === 'nested-preference-setter') {
          foreignWrites++;
          video.preservesPitch = false;
        } else {
          foreignWrites++;
          throw new Error('Owned native setter rejection');
        }
      };
      Object.defineProperty(video, 'preservesPitch', {
        configurable: true,
        get,
        set,
      });
      source.playbackSpeed.onPlayerApiReady();
      source.playbackSpeed.onConfigChange({
        enabled: true,
        preservesPitch: false,
      });
      const input = document.querySelector<HTMLInputElement>(
        '#native-pitch-speed',
      )!;
      input.value = '2';
      input.dispatchEvent(new Event('change'));
      if (phase === 'throwing-foreign-setter') {
        armed = true;
        try {
          video.preservesPitch = false;
        } catch {
          rejected = true;
        }
      }
      const before = native.get!.call(video);
      source.playbackSpeed.onUnload();
      const descriptor = Object.getOwnPropertyDescriptor(
        video,
        'preservesPitch',
      );
      const prototype = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        'preservesPitch',
      );
      results.push({
        phase,
        before,
        after: native.get!.call(video),
        foreignWrites,
        rejected,
        owner: source.getPlaybackRateOwner(video),
        getterRestored: descriptor?.get === get,
        setterRestored: descriptor?.set === set,
        prototypeIntact:
          prototype?.get === native.get && prototype?.set === native.set,
      });
    }
    return results;
  });
  expect(results).toEqual(
    ['nested-preference-setter', 'throwing-foreign-setter'].map((phase) => ({
      phase,
      before: false,
      after: false,
      foreignWrites: 1,
      rejected: phase === 'throwing-foreign-setter',
      owner: null,
      getterRestored: true,
      setterRestored: true,
      prototypeIntact: true,
    })),
  );
});
