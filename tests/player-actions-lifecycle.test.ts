import { test, expect } from '@playwright/test';
import { playerActionsFixture } from './helpers/player-actions-fixture';

test('reused section controller adopts the current API on hot enable instead of the previous song', async () => {
  const f = await playerActionsFixture();
  const c = f.source.createSectionRepeatController();
  const config = {
    active: true,
    saved: [
      { videoId: 'A', startSeconds: 10, endSeconds: 20 },
      { videoId: 'B', startSeconds: 40, endSeconds: 50 },
    ],
  };
  const ctx = { getConfig: () => config, setConfig: () => {} };
  try {
    await c.start(ctx);
    c.onPlayerApiReady(f.api('A'));
    expect(f.media.currentTime).toBe(10);
    c.stop();
    f.media.currentTime = 0;
    await c.start(ctx);
    expect(f.media.currentTime).toBe(0);
    c.onPlayerApiReady(f.api('B'));
    expect(c.latestVideoId).toBe('B');
    expect(f.media.currentTime).toBe(40);
    expect(f.media.paused).toBe(true);
  } finally {
    c.stop();
    await f.close();
  }
});

test('reverb hot enable adopts a newer shared graph and detaches only owned wet edges', async () => {
  const f = await playerActionsFixture();
  const c = f.source.createSlowedReverbController();
  let cfg = { active: true, slow: 1, reverbIntensity: 0 };
  const ctx = { getConfig: () => cfg, setConfig: () => {} };
  const a = f.graph('A'),
    b = f.graph('B');
  try {
    await c.start(ctx);
    f.announce(a);
    c.stop();
    f.announce(b);
    cfg = { ...cfg, reverbIntensity: 0.5 };
    await c.start(ctx);
    expect(c.audioSource).toBe(b.audioSource);
    f.loads[0].resolve();
    await f.settle();
    expect(c.reverbNode).not.toBeNull();
    expect(b.audioSource.connections.size).toBe(3);
    c.stop();
    expect(b.audioSource.connections).toEqual(
      new Set([b.audioGraph.dryInput, b.unrelated]),
    );
    expect(a.audioSource.connections).toEqual(
      new Set([a.audioGraph.dryInput, a.unrelated]),
    );
  } finally {
    c.stop();
    await f.close();
  }
});

test('disabled default features allocate no DSP/watchdog and preserve media state through 50 toggles', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  f.media.playbackRate = 1.25;
  f.media.volume = 0;
  f.media.muted = true;
  const cfg = { ...f.source.plugin.config, enabled: true };
  try {
    for (let i = 0; i < 50; i++) {
      await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
      r.onPlayerApiReady(f.api('plain'));
      expect(f.intervals.size).toBe(0);
      expect(f.loads).toHaveLength(0);
      r.stop();
      r.stop();
      expect(f.intervals.size).toBe(0);
      expect(f.activeObservers.size).toBe(0);
      expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(0);
    }
    expect(f.media.playbackRate).toBe(1.25);
    expect(f.media.volume).toBe(0);
    expect(f.media.muted).toBe(true);
    expect(f.media.paused).toBe(true);
    expect(f.listenerSets.get('videodatachange')?.size ?? 0).toBe(0);
    expect(f.listenerSets.get('peard:audio-can-play')?.size).toBe(1);
  } finally {
    await f.close();
  }
});

test('a pending worklet load cannot create or attach a node after plugin disable', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const graph = f.graph('active');
  f.announce(graph);
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    slowedReverb: { active: true, slow: 1, reverbIntensity: 0.4 },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    expect(f.loads).toHaveLength(1);
    r.stop();
    f.loads[0].resolve();
    await f.settle();
    expect(r.slowedReverb.reverbNode).toBeNull();
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
    expect(f.intervals.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('stopping an unused controller never changes an unowned video rate or pitch', async () => {
  const f = await playerActionsFixture();
  const c = f.source.createSlowedReverbController();
  f.media.playbackRate = 1.75;
  f.media.preservesPitch = false;
  try {
    c.stop();
    expect(f.media.playbackRate).toBe(1.75);
    expect(f.media.preservesPitch).toBe(false);
  } finally {
    await f.close();
  }
});

test('a successful module load after disable is reused when the same context re-enables', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const graph = f.graph('same');
  f.announce(graph);
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    slowedReverb: { active: true, slow: 1, reverbIntensity: 0.4 },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    r.stop();
    f.loads[0].resolve();
    await f.settle();
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    await f.settle();
    expect(f.loads).toHaveLength(1);
    expect(r.slowedReverb.reverbNode).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('configuration commits are ordered and an older write echo cannot undo newer live input', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const writes: { patch: any; resolve: () => void }[] = [];
  const cfg = { ...f.source.plugin.config, enabled: true };
  try {
    await r.start({
      getConfig: async () => cfg,
      setConfig: (patch: any) =>
        new Promise<void>((resolve) => writes.push({ patch, resolve })),
    });
    const slider =
      r.slowedReverb.section.root.querySelector('input[type=range]');
    slider.value = '0.8';
    slider.dispatchEvent(new f.dom.Event('change'));
    await f.settle();
    slider.value = '0.7';
    slider.dispatchEvent(new f.dom.Event('change'));
    await f.settle();
    expect(writes).toHaveLength(1);
    r.onConfigChange({ ...cfg, slowedReverb: writes[0].patch.slowedReverb });
    expect(r.getCurrent().slowedReverb.slow).toBe(0.7);
    expect(f.media.playbackRate).toBe(0.7);
    writes[0].resolve();
    await f.settle();
    expect(writes).toHaveLength(2);
    expect(writes[1].patch.slowedReverb).toEqual({
      active: true,
      slow: 0.7,
      reverbIntensity: 0,
    });
    writes[1].resolve();
    await f.settle();
  } finally {
    for (const write of writes) write.resolve();
    await f.close();
  }
});

test('a delayed initial configuration cannot start features after stop or modify an unowned rate', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  let resolveConfig!: (value: any) => void;
  const config = {
    promise: new Promise<any>((resolve) => {
      resolveConfig = resolve;
    }),
    resolve: (value: any) => resolveConfig(value),
  };
  f.media.playbackRate = 1.6;
  try {
    const starting = r.start({
      getConfig: () => config.promise,
      setConfig: async () => {},
    });
    r.stop();
    config.resolve({
      ...f.source.plugin.config,
      enabled: true,
      slowedReverb: { active: true, slow: 0.8, reverbIntensity: 0.5 },
    });
    await starting;
    r.onPlayerApiReady(f.api('stale'));
    expect(f.media.playbackRate).toBe(1.6);
    expect(f.intervals.size).toBe(0);
    expect(f.loads).toHaveLength(0);
    expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('an old detached slider cannot mutate a later enabled generation', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  let writes = 0;
  const cfg = { ...f.source.plugin.config, enabled: true };
  const ctx = {
    getConfig: async () => cfg,
    setConfig: async () => {
      writes++;
    },
  };
  try {
    await r.start(ctx);
    const oldSlider =
      r.slowedReverb.section.root.querySelector('input[type=range]');
    r.stop();
    await r.start(ctx);
    oldSlider.value = '0.8';
    oldSlider.dispatchEvent(new f.dom.Event('change'));
    await f.settle();
    expect(writes).toBe(0);
    expect(f.media.playbackRate).toBe(1);
    expect(r.getCurrent().slowedReverb.slow).toBe(1);
  } finally {
    await f.close();
  }
});

test('the exact core dataloaded notification preserves a seeded loop only with agreeing current API data', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    sectionRepeat: {
      active: true,
      saved: [{ videoId: 'A', startSeconds: 10, endSeconds: 20 }],
    },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    r.onPlayerApiReady(f.api('A'));
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', {
        detail: { name: 'dataloaded' },
      }),
    );
    expect(r.sectionRepeat.latestVideoId).toBe('A');
    expect(r.sectionRepeat.pendingRestoreSeek).toBe(false);
    Object.defineProperty(f.media, 'paused', { get: () => false });
    f.media.currentTime = 25;
    f.tick(100);
    expect(f.media.currentTime).toBe(10);
  } finally {
    await f.close();
  }
});

test('an unknown native payload and a reserved notification with mismatched live data never reuse old loop points', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    sectionRepeat: {
      active: true,
      saved: [{ videoId: 'A', startSeconds: 10, endSeconds: 20 }],
    },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    r.onPlayerApiReady(f.api('A'));
    f.media.currentTime = 3;
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', {
        detail: { name: 'dataloaded', videoData: null },
      }),
    );
    expect(r.sectionRepeat.latestVideoId).toBeNull();
    f.tick(100);
    expect(f.media.currentTime).toBe(3);
    r.sectionRepeat.latestVideoId = 'A';
    r.sectionRepeat.api = {
      ...f.api('A'),
      getVideoData: () => ({ video_id: 'B' }),
    };
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', {
        detail: { name: 'dataloaded' },
      }),
    );
    expect(r.sectionRepeat.latestVideoId).toBeNull();
    f.tick(100);
    expect(f.media.currentTime).toBe(3);
  } finally {
    await f.close();
  }
});

test('reserved dataloaded on a replaced video cannot restore an old saved range', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    sectionRepeat: {
      active: true,
      saved: [{ videoId: 'A', startSeconds: 10, endSeconds: 20 }],
    },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    r.onPlayerApiReady(f.api('A'));
    f.media.remove();
    f.dom.document
      .querySelector('#movie_player')!
      .append(f.dom.document.createElement('video'));
    const replacement = f.video();
    replacement.currentTime = 3;
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', {
        detail: { name: 'dataloaded' },
      }),
    );
    expect(r.sectionRepeat.latestVideoId).toBeNull();
    expect(replacement.currentTime).toBe(3);
    expect(r.sectionRepeat.state.startSeconds).toBeNull();
  } finally {
    await f.close();
  }
});

test('default enable and disable preserve an existing zero playback rate', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  f.media.playbackRate = 0;
  try {
    await r.start({
      getConfig: async () => ({ ...f.source.plugin.config, enabled: true }),
      setConfig: async () => {},
    });
    expect(f.media.playbackRate).toBe(0);
    r.stop();
    expect(f.media.playbackRate).toBe(0);
  } finally {
    await f.close();
  }
});

test('saved acknowledgement waits for persistence and a failed save remains retryable', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const writes: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const cfg = { ...f.source.plugin.config, enabled: true };
  try {
    await r.start({
      getConfig: async () => cfg,
      setConfig: () =>
        new Promise<void>((resolve, reject) =>
          writes.push({ resolve, reject }),
        ),
    });
    r.onPlayerApiReady(f.api('A'));
    const root = r.sectionRepeat.section.root;
    const from = root.querySelector('input[type=text]');
    from.value = '0:10';
    from.dispatchEvent(new f.dom.Event('change'));
    const save = [...root.querySelectorAll('button')].find(
      (b: any) => b.textContent === 'plugins.section-repeat.panel.save',
    );
    save.click();
    await f.settle();
    expect(root.querySelector('[role=status]').textContent).not.toBe(
      'plugins.section-repeat.panel.status-saved',
    );
    writes[0].reject(new Error('fixture write failure'));
    await f.settle();
    expect(root.querySelector('[role=status]').textContent).toBe(
      'plugins.section-repeat.panel.status-save-failed',
    );
    save.click();
    await f.settle();
    expect(writes).toHaveLength(2);
    writes[1].resolve();
    await f.settle();
    expect(root.querySelector('[role=status]').textContent).toBe(
      'plugins.section-repeat.panel.status-saved',
    );
  } finally {
    for (const write of writes) write.resolve();
    await f.close();
  }
});

test('saving with a genuinely unknown song id never falls back to a stale API id', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  let writes = 0;
  try {
    await r.start({
      getConfig: async () => ({ ...f.source.plugin.config, enabled: true }),
      setConfig: async () => {
        writes++;
      },
    });
    r.onPlayerApiReady(f.api('A'));
    const root = r.sectionRepeat.section.root;
    const from = root.querySelector('input[type=text]');
    from.value = '0:10';
    from.dispatchEvent(new f.dom.Event('change'));
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', { detail: { videoData: null } }),
    );
    const save = [...root.querySelectorAll('button')].find(
      (b: any) => b.textContent === 'plugins.section-repeat.panel.save',
    );
    save.click();
    await f.settle();
    expect(writes).toBe(0);
  } finally {
    await f.close();
  }
});

test('failure of the second feature rolls back the first feature resources and rate', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const graph = f.graph('rollback');
  f.announce(graph);
  const failure = new Error('fixture second feature unavailable');
  r.sectionRepeat.start = async () => {
    throw failure;
  };
  try {
    await expect(
      r.start({
        getConfig: async () => ({
          ...f.source.plugin.config,
          enabled: true,
          slowedReverb: { active: true, slow: 0.8, reverbIntensity: 0.4 },
        }),
        setConfig: async () => {},
      }),
    ).rejects.toBe(failure);
    expect(r.running).toBe(false);
    expect(f.intervals.size).toBe(0);
    expect(f.dom.document.querySelectorAll('.pbg-cog')).toHaveLength(0);
    expect(f.media.playbackRate).toBe(1);
    f.loads[0].resolve();
    await f.settle();
    expect(graph.audioSource.connections).toEqual(
      new Set([graph.audioGraph.dryInput, graph.unrelated]),
    );
  } finally {
    await f.close();
  }
});

test('a replacement video cannot leave a wet tap on the old shared graph', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const old = f.graph('old');
  f.announce(old);
  try {
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        slowedReverb: { active: true, slow: 1, reverbIntensity: 0.4 },
      }),
      setConfig: async () => {},
    });
    f.loads[0].resolve();
    await f.settle();
    expect(old.audioSource.connections.size).toBe(3);
    f.media.remove();
    f.dom.document
      .querySelector('#movie_player')!
      .append(f.dom.document.createElement('video'));
    const current = f.video();
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', {
        detail: { videoData: { videoId: 'B' } },
      }),
    );
    expect(old.audioSource.connections).toEqual(
      new Set([old.audioGraph.dryInput, old.unrelated]),
    );
    expect(r.slowedReverb.reverbNode).toBeNull();
    const fresh = f.graph('new');
    expect(fresh.audioSource.mediaElement).toBe(current);
    f.announce(fresh);
    f.loads[1].resolve();
    await f.settle();
    expect(r.slowedReverb.audioSource).toBe(fresh.audioSource);
    expect(fresh.audioSource.connections.size).toBe(3);
  } finally {
    await f.close();
  }
});

test('a native unknown change fences enable seeding so a later stale API cannot restore A into B', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  const cfg = {
    ...f.source.plugin.config,
    enabled: true,
    sectionRepeat: {
      active: true,
      saved: [{ videoId: 'A', startSeconds: 10, endSeconds: 20 }],
    },
  };
  try {
    await r.start({ getConfig: async () => cfg, setConfig: async () => {} });
    r.onPlayerApiReady(f.api('A'));
    f.media.remove();
    f.dom.document
      .querySelector('#movie_player')!
      .append(f.dom.document.createElement('video'));
    const b = f.video();
    b.currentTime = 3;
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', { detail: { videoData: null } }),
    );
    r.onPlayerApiReady(f.api('A'));
    expect(r.sectionRepeat.latestVideoId).toBeNull();
    expect(b.currentTime).toBe(3);
    f.tick(100);
    expect(b.currentTime).toBe(3);
  } finally {
    await f.close();
  }
});

test('ended on the same video after an authoritative unknown change never seeks or plays an old section', async () => {
  const f = await playerActionsFixture();
  const r = f.source.plugin.renderer;
  let plays = 0;
  f.media.play = async () => {
    plays++;
  };
  try {
    await r.start({
      getConfig: async () => ({
        ...f.source.plugin.config,
        enabled: true,
        sectionRepeat: {
          active: true,
          saved: [{ videoId: 'A', startSeconds: 10, endSeconds: 20 }],
        },
      }),
      setConfig: async () => {},
    });
    r.onPlayerApiReady(f.api('A'));
    f.media.currentTime = 3;
    f.dom.document.dispatchEvent(
      new f.dom.CustomEvent('videodatachange', { detail: { videoData: null } }),
    );
    f.media.dispatchEvent(new f.dom.Event('ended'));
    expect(f.media.currentTime).toBe(3);
    expect(plays).toBe(0);
  } finally {
    await f.close();
  }
});
