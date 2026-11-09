import { test, expect } from '@playwright/test';
import { playerActionsFixture } from './helpers/player-actions-fixture';

const config = (f: any, slow = 0.8) => ({
  ...f.source.plugin.config,
  enabled: true,
  slowedReverb: { active: true, slow, reverbIntensity: 0 },
});
const speed = (f: any, value: number) =>
  f.speedControls
    .at(-1)
    .onImmediateValueChanged(
      new f.dom.CustomEvent('change', { detail: { value } }),
    );
const start = (f: any, slow = 0.8) =>
  f.source.plugin.renderer.start({
    getConfig: async () => config(f, slow),
    setConfig: async () => {},
  });
const beginAd = async (f: any) => {
  f.dom.document.querySelector('#movie_player')!.classList.add('ad-showing');
  const ad = f.source.createAdSpeedup(f.dom.document);
  ad.start();
  await f.settle();
  return ad;
};
const endAd = async (f: any) => {
  f.dom.document.querySelector('#movie_player')!.classList.remove('ad-showing');
  await f.settle();
};

test('the latest explicit speed owner wins without ratechange feedback', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    speed(f, 2);
    await start(f);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(0.8);
    speed(f, 1.5);
    expect(f.drainRates()).toBe(0);
    f.tick(2000);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(1.5);
    expect(f.media.preservesPitch).toBe(true);
  } finally {
    await f.close();
  }
});

test('actual ad speedup keeps priority while live slow preferences change and releases to latest intent', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  try {
    await start(f);
    ad = await beginAd(f);
    expect(f.media.playbackRate).toBe(16);
    f.tick(2000);
    f.drainRates();
    expect(f.media.playbackRate).toBe(16);
    const slider =
      f.source.plugin.renderer.slowedReverb.section.root.querySelector(
        'input[type=range]',
      );
    slider.value = '0.7';
    slider.dispatchEvent(new f.dom.Event('change'));
    await f.settle();
    f.drainRates();
    expect(f.media.playbackRate).toBe(16);
    await endAd(f);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(0.7);
    expect(f.media.paused).toBe(true);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('a real user speed16 is never classified as an ad and an actual ad retains newer playback-speed intent', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  try {
    await start(f);
    f.source.playbackSpeed.onPlayerApiReady();
    speed(f, 16);
    expect(f.drainRates()).toBe(0);
    f.tick(2000);
    expect(f.media.playbackRate).toBe(16);
    expect(f.media.preservesPitch).toBe(true);
    ad = await beginAd(f);
    speed(f, 1.3);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(16);
    await endAd(f);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(1.3);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('disabling slowed playback during an actual ad restores the original rate after the override ends', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  f.media.playbackRate = 1.25;
  f.media.volume = 0;
  f.media.muted = true;
  try {
    await start(f);
    ad = await beginAd(f);
    f.source.plugin.renderer.stop();
    expect(f.media.playbackRate).toBe(16);
    await endAd(f);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(1.25);
    expect(f.media.paused).toBe(true);
    expect(f.media.volume).toBe(0);
    expect(f.media.muted).toBe(true);
    expect(f.intervals.size).toBe(0);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('disabling ad speedup resumes the latest user intent even while the ad class remains', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  try {
    await start(f);
    ad = await beginAd(f);
    ad.stop();
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(0.8);
    f.tick(2000);
    expect(f.media.playbackRate).toBe(0.8);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('playback-speed unload disposes the actual Solid owner and every observer even when menu never attached', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    expect(() => f.source.playbackSpeed.onUnload()).not.toThrow();
    expect(f.speedDisposals).toBe(1);
    expect(f.activeObservers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('old playback-speed controls cannot change a new enabled generation', async () => {
  const f = await playerActionsFixture();
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    const old = f.speedControls.at(-1);
    try {
      f.source.playbackSpeed.onUnload();
    } catch {
      /* The separate teardown regression pins this baseline issue. */
    }
    f.source.playbackSpeed.onPlayerApiReady();
    old.onImmediateValueChanged(
      new f.dom.CustomEvent('change', { detail: { value: 2 } }),
    );
    expect(f.media.playbackRate).toBe(1);
  } finally {
    await f.close();
  }
});

test('enabling slowed playback during an ad still remembers the unforced original rate', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  f.media.playbackRate = 1.25;
  try {
    ad = await beginAd(f);
    await start(f);
    expect(f.media.playbackRate).toBe(16);
    f.source.plugin.renderer.stop();
    await endAd(f);
    f.drainRates();
    expect(f.media.playbackRate).toBe(1.25);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('saved section looping leaves the actual ad override alone and resumes after its release', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  const r = f.source.plugin.renderer;
  try {
    await r.start({
      getConfig: async () => ({
        ...config(f, 1),
        sectionRepeat: {
          active: true,
          saved: [{ videoId: 'A', startSeconds: 1, endSeconds: 2 }],
        },
      }),
      setConfig: async () => {},
    });
    r.onPlayerApiReady(f.api('A'));
    Object.defineProperty(f.media, 'paused', { get: () => false });
    ad = await beginAd(f);
    f.media.currentTime = 3;
    f.tick(100);
    expect(f.media.currentTime).toBe(3);
    await endAd(f);
    f.tick(100);
    expect(f.media.currentTime).toBe(1);
  } finally {
    ad?.stop();
    await f.close();
  }
});

test('an untouched playback-speed control never replaces the unforced fallback with its default signal', async () => {
  const f = await playerActionsFixture();
  let ad: any;
  f.media.playbackRate = 1.25;
  try {
    f.source.playbackSpeed.onPlayerApiReady();
    await start(f);
    ad = await beginAd(f);
    f.source.plugin.renderer.stop();
    await endAd(f);
    expect(f.drainRates()).toBe(0);
    expect(f.media.playbackRate).toBe(1.25);
  } finally {
    ad?.stop();
    await f.close();
  }
});
