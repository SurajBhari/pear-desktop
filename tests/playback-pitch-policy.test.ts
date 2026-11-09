import { test, expect } from '@playwright/test';
import { playerActionsFixture } from './helpers/player-actions-fixture';

const speed = (f: any, value: number) =>
  f.speedControls
    .at(-1)
    .onImmediateValueChanged(
      new f.dom.CustomEvent('change', { detail: { value } }),
    );
const pitch = (f: any, preservesPitch: boolean) =>
  f.source.playbackSpeed.onConfigChange({ enabled: true, preservesPitch });
const slow = (f: any, rate = 0.8) =>
  f.source.plugin.renderer.start({
    getConfig: async () => ({
      ...f.source.plugin.config,
      enabled: true,
      slowedReverb: { active: true, slow: rate, reverbIntensity: 0 },
    }),
    setConfig: async () => {},
  });

test('pitch checkbox defaults to preserved pitch and persists the native checkbox state', async () => {
  const f = await playerActionsFixture();
  try {
    const updates: unknown[] = [];
    expect(f.source.playbackSpeedPlugin.config.preservesPitch).toBe(true);
    const menu = await f.source.playbackSpeedPlugin.menu({
      getConfig: async () => ({ enabled: true }),
      setConfig: (patch: unknown) => updates.push(patch),
    });
    expect(menu[0].type).toBe('checkbox');
    expect(menu[0].checked).toBe(true);
    await menu[0].click({ checked: false });
    expect(updates).toEqual([{ preservesPitch: false }]);
  } finally {
    await f.close();
  }
});

test('live pitch preference follows its rate owner without claiming a rate or changing other media state', async () => {
  const f = await playerActionsFixture();
  try {
    f.media.muted = true;
    f.media.volume = 0;
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe(null);
    expect(f.media.preservesPitch).toBe(true);
    speed(f, 2);
    expect(f.media.preservesPitch).toBe(false);
    expect(f.drainRates()).toBe(0);
    pitch(f, true);
    expect(f.media.preservesPitch).toBe(true);
    expect(f.media.playbackRate).toBe(2);
    expect(f.drainRates()).toBe(0);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    expect(f.media.paused).toBe(true);
    expect(f.media.volume).toBe(0);
    expect(f.media.muted).toBe(true);
  } finally {
    await f.close();
  }
});

test('same-rate transfers apply current pitch and stale Player Actions cleanup cannot overwrite it', async () => {
  const f = await playerActionsFixture();
  try {
    await slow(f);
    expect(f.media.preservesPitch).toBe(false);
    f.drainRates();
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    speed(f, 0.8);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
    expect(f.media.preservesPitch).toBe(false);
    expect(f.drainRates()).toBe(0);
    f.tick(2000);
    f.source.plugin.renderer.stop();
    expect(f.media.preservesPitch).toBe(false);
    pitch(f, true);
    expect(f.media.preservesPitch).toBe(true);
    await slow(f);
    expect(f.media.preservesPitch).toBe(false);
    pitch(f, true);
    expect(f.media.preservesPitch).toBe(false);
    f.source.playbackSpeed.onUnload();
    expect(f.media.preservesPitch).toBe(false);
    f.source.plugin.renderer.stop();
    expect(f.media.preservesPitch).toBe(true);
  } finally {
    await f.close();
  }
});

test('foreign differing and equal-valued pitch writes survive watchdogs and cleanup', async () => {
  for (const foreign of [true, false]) {
    const f = await playerActionsFixture();
    try {
      f.source.playbackSpeed.onPlayerApiReady();
      pitch(f, false);
      speed(f, 1.7);
      expect(f.media.preservesPitch).toBe(false);
      f.media.preservesPitch = foreign;
      f.media.dispatchEvent(new f.dom.Event('ratechange'));
      f.tick(2000);
      expect(f.media.preservesPitch).toBe(foreign);
      f.source.playbackSpeed.onUnload();
      expect(f.media.preservesPitch).toBe(foreign);
      expect(
        Object.getOwnPropertyDescriptor(f.media, 'preservesPitch')?.get,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }
});

test('replacement releases only the old exact element and foreign descriptors survive stop', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    speed(f, 1.4);
    const old = f.media;
    const next = f.dom.document.createElement('video');
    old.replaceWith(next);
    f.video();
    await f.settle();
    expect(old.preservesPitch).toBe(true);
    expect(next.preservesPitch).toBe(false);
    const foreign = { configurable: true, writable: true, value: false };
    Object.defineProperty(next, 'preservesPitch', foreign);
    f.source.playbackSpeed.onUnload();
    expect(Object.getOwnPropertyDescriptor(next, 'preservesPitch')).toEqual({
      ...foreign,
      enumerable: false,
    });
    expect(f.activeObservers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('actual ads suspend pitch ownership and resume the latest user preference, unlike user speed16', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    speed(f, 16);
    expect(f.media.preservesPitch).toBe(false);
    f.dom.document.querySelector('#movie_player')!.classList.add('ad-showing');
    ad = f.source.createAdSpeedup(f.dom.document);
    ad.start();
    await f.settle();
    expect(f.media.preservesPitch).toBe(true);
    speed(f, 1.3);
    pitch(f, true);
    pitch(f, false);
    expect(f.media.playbackRate).toBe(16);
    expect(f.media.preservesPitch).toBe(true);
    f.dom.document
      .querySelector('#movie_player')!
      .classList.remove('ad-showing');
    await f.settle();
    expect(f.media.playbackRate).toBe(1.3);
    expect(f.media.preservesPitch).toBe(false);
    expect(f.drainRates()).toBe(0);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('Player Actions uses the same conditional lease for foreign writes and an unowned stop', async () => {
  const f = await playerActionsFixture();
  try {
    await slow(f);
    f.media.preservesPitch = false;
    f.source.plugin.renderer.stop();
    expect(f.media.preservesPitch).toBe(false);
    f.media.preservesPitch = true;
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    speed(f, 1.6);
    await f.source.plugin.renderer.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 0 },
      }),
      setConfig: async () => {},
    });
    f.source.plugin.renderer.stop();
    expect(f.media.preservesPitch).toBe(false);
    f.source.playbackSpeed.onUnload();
    expect(f.media.preservesPitch).toBe(true);
  } finally {
    await f.close();
  }
});

test('boolean aliases retain individual baselines while unsupported and readonly flags remain intact', async () => {
  const f = await playerActionsFixture();
  try {
    Object.defineProperty(f.media, 'mozPreservesPitch', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(f.media, 'webkitPreservesPitch', {
      configurable: true,
      writable: true,
      value: 'unsupported',
    });
    Object.defineProperty(f.media, 'preservesPitch', {
      configurable: true,
      writable: false,
      value: false,
    });
    const descriptors = Object.getOwnPropertyDescriptors(f.media);
    f.source.playbackSpeed.onPlayerApiReady();
    speed(f, 1.2);
    expect((f.media as any).mozPreservesPitch).toBe(true);
    expect(f.media.preservesPitch).toBe(false);
    expect((f.media as any).webkitPreservesPitch).toBe('unsupported');
    f.source.playbackSpeed.onUnload();
    for (const key of [
      'preservesPitch',
      'mozPreservesPitch',
      'webkitPreservesPitch',
    ]) {
      expect(Object.getOwnPropertyDescriptor(f.media, key)).toEqual(
        descriptors[key],
      );
    }
  } finally {
    await f.close();
  }
});

test('late initial config cannot overwrite live config or a later enabled generation', async () => {
  const f = await playerActionsFixture();
  try {
    let resolve!: (value: unknown) => void;
    const loading = f.source.playbackSpeed.onPlayerApiReady(undefined, {
      getConfig: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    pitch(f, false);
    speed(f, 1.3);
    resolve({ enabled: true, preservesPitch: true });
    await loading;
    expect(f.media.preservesPitch).toBe(false);
    f.source.playbackSpeed.onUnload();
    const stale = f.source.playbackSpeed.onPlayerApiReady(undefined, {
      getConfig: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    f.source.playbackSpeed.onUnload();
    f.source.playbackSpeed.onPlayerApiReady();
    speed(f, 1.4);
    resolve({ enabled: true, preservesPitch: false });
    await stale;
    expect(f.media.preservesPitch).toBe(true);
    expect(f.source.getPlaybackRateOwner(f.media)).toBe('playback-speed');
  } finally {
    await f.close();
  }
});

test('coupled boolean aliases preserve equal-valued foreign intent through either setter', async () => {
  for (const key of ['preservesPitch', 'webkitPreservesPitch']) {
    const f = await playerActionsFixture();
    try {
      let value = true;
      for (const alias of ['preservesPitch', 'webkitPreservesPitch'])
        Object.defineProperty(f.media, alias, {
          configurable: true,
          get: () => value,
          set: (next) => {
            value = next;
          },
        });
      f.source.playbackSpeed.onPlayerApiReady();
      pitch(f, false);
      speed(f, 1.5);
      (f.media as any)[key] = false;
      f.source.playbackSpeed.onUnload();
      expect(value, key).toBe(false);
    } finally {
      await f.close();
    }
  }
});

test('clamped wheel gestures and slider echoes retain the current rate and pitch owner', async () => {
  for (const [boundary, deltaY] of [
    [16, -1],
    [0.07, 1],
  ]) {
    const f = await playerActionsFixture();
    try {
      f.source.playbackSpeed.onPlayerApiReady();
      speed(f, boundary);
      await slow(f);
      f.drainRates();
      speed(f, boundary);
      const event = new f.dom.WheelEvent('wheel', { deltaY, cancelable: true });
      f.speedControls.at(-1).onWheel(event);
      expect(event.defaultPrevented).toBe(true);
      expect(f.source.getPlaybackRateOwner(f.media)).toBe('slowed-reverb');
      expect(f.media.playbackRate).toBe(0.8);
      expect(f.media.preservesPitch).toBe(false);
      expect(f.drainRates()).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('an owned write forwarded through another supported accessor is not mistaken for foreign intent', async () => {
  const f = await playerActionsFixture();
  try {
    Object.defineProperty(f.media, 'webkitPreservesPitch', {
      configurable: true,
      writable: true,
      value: true,
    });
    Object.defineProperty(f.media, 'preservesPitch', {
      configurable: true,
      get: () => (f.media as any).webkitPreservesPitch,
      set: (value) => {
        (f.media as any).webkitPreservesPitch = value;
      },
    });
    f.source.playbackSpeed.onPlayerApiReady();
    pitch(f, false);
    speed(f, 1.6);
    expect(f.media.preservesPitch).toBe(false);
    f.source.playbackSpeed.onUnload();
    expect(f.media.preservesPitch).toBe(true);
    expect((f.media as any).webkitPreservesPitch).toBe(true);
  } finally {
    await f.close();
  }
});
