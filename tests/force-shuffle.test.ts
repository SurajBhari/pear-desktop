import { test, expect } from '@playwright/test';
import {
  forceShuffleFixture,
  forceShuffleSource,
} from './helpers/force-shuffle';

let source: string;
test.beforeAll(async () => {
  source = await forceShuffleSource();
});

test('Force declares default-off native always/preserve modes and menu writes exact mode patches', async () => {
  const f = forceShuffleFixture(source);
  try {
    expect(f.force?.config).toEqual({ enabled: false, mode: 'always' });
    const patches: unknown[] = [];
    const menu = await f.force.menu({
      getConfig: async () => ({ enabled: true, mode: 'preserve' }),
      setConfig: async (patch: unknown) => {
        patches.push(patch);
      },
    });
    expect(menu.map((item: any) => item.checked)).toEqual([false, true]);
    await menu[0].click();
    await menu[1].click();
    expect(patches).toEqual([{ mode: 'always' }, { mode: 'preserve' }]);
  } finally {
    await f.close();
  }
});

test('only agreeing core metadata admits a single native action after exactly 1.5 seconds', async () => {
  const f = forceShuffleFixture(source);
  try {
    await f.startForce();
    f.admit('trackAAAAAA', 'dataupdated');
    f.advance(2000);
    expect(f.calls).toHaveLength(0);
    f.admit();
    expect(
      [...f.timers.values()].filter((timer) => timer.ms === 1500),
    ).toHaveLength(1);
    f.advance(1499);
    expect(f.calls).toHaveLength(0);
    f.advance(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].at).toBe(3500);
    expect(f.calls[0].selected).toEqual({
      playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
    });
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('Resume participates in the shared action cooldown across same-document restart', async () => {
  const f = forceShuffleFixture(source);
  try {
    await f.startResume();
    expect(f.calls).toHaveLength(1);
    f.reset();
    await f.startResume();
    expect(f.calls).toHaveLength(1);
    f.advance(3000);
    f.populate();
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('preserve mode retains positive intent through native reset and respects explicit user off', async () => {
  const f = forceShuffleFixture(source, { mode: 'preserve', shuffled: true });
  try {
    await f.startForce();
    f.reset();
    await f.settle();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    f.click();
    await f.settle();
    f.advance(3000);
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    expect(f.bar.hasAttribute('shuffle-on')).toBe(false);
    f.click();
    await f.settle();
    f.reset();
    await f.settle();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('both plugins with a late queue produce one native shuffle and release readiness work', async () => {
  const f = forceShuffleFixture(source, { items: [], missingQueue: true });
  try {
    await f.startResume();
    await f.startForce();
    f.admit();
    f.advance(500);
    f.queueElement.queue = f.queue;
    f.dom.document.body.append(f.dom.document.createElement('span'));
    await f.settle();
    f.populate();
    await f.settle();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.bar.hasAttribute('shuffle-on')).toBe(true);
  } finally {
    await f.close();
  }
});

test('ABA and repeated core admissions retain one check and old callbacks cannot clear the latest episode', async () => {
  const f = forceShuffleFixture(source);
  try {
    await f.startForce();
    f.admit();
    const a = [...f.timers.values()][0].callback;
    f.identity('trackBBBBBB');
    f.admit();
    const b = [...f.timers.values()][0].callback;
    f.identity('trackAAAAAA');
    f.admit();
    a();
    b();
    expect(f.timers.size).toBe(1);
    expect(f.calls).toHaveLength(0);
    f.advance(1000);
    f.admit();
    expect(f.timers.size).toBe(1);
    f.advance(1499);
    expect(f.calls).toHaveLength(0);
    f.advance(1);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('native API, response, event and selected queue identity must agree and invalid methods fail closed', async () => {
  for (const failure of [
    'api-response',
    'event',
    'selection',
    'empty',
    'index',
    'method',
  ]) {
    const f = forceShuffleFixture(source);
    try {
      await f.startForce();
      if (failure === 'api-response') f.identity('trackAAAAAA', 'trackBBBBBB');
      if (failure === 'selection')
        f.populate([
          {
            playlistPanelVideoRenderer: {
              videoId: 'trackBBBBBB',
              selected: true,
            },
          },
        ]);
      if (failure === 'empty') f.populate([]);
      if (failure === 'index') f.populate(undefined, -1);
      if (failure === 'method') (f.queue as any).shuffle = undefined;
      f.admit(failure === 'event' ? 'trackBBBBBB' : 'trackAAAAAA');
      f.advance(1500);
      expect(f.calls, failure).toHaveLength(0);
      expect(f.timers.size, failure).toBe(0);
      expect(f.subscriptions.size, failure).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('queue, store, action facade and method replacement retire the captured native binding', async () => {
  for (const replacement of ['queue', 'store', 'method', 'facade']) {
    const f = forceShuffleFixture(source);
    try {
      await f.startForce();
      f.admit();
      if (replacement === 'queue') f.queueElement.queue = { ...f.queue };
      if (replacement === 'store') f.queue.store.store = { ...f.store };
      if (replacement === 'method')
        f.queue.shuffle = () => {
          throw Error('Retired method must not be used');
        };
      if (replacement === 'facade')
        (f.bar as any).queue = {
          shuffle() {
            throw Error('New facade needs a new admission');
          },
        };
      f.advance(1500);
      expect(f.calls, replacement).toHaveLength(0);
      expect(f.subscriptions.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('DOM queue ABA and a selected-item ABA notification cancel the old admission', async () => {
  for (const replacement of ['dom', 'selected']) {
    const f = forceShuffleFixture(source);
    try {
      await f.startForce();
      f.admit();
      if (replacement === 'dom') {
        f.queueElement.remove();
        f.dom.document.body.append(f.queueElement);
        await f.settle();
      } else {
        f.populate([
          {
            playlistPanelVideoRenderer: {
              videoId: 'trackBBBBBB',
              selected: true,
            },
          },
        ]);
        f.populate();
      }
      f.advance(1500);
      expect(f.calls, replacement).toHaveLength(0);
      expect(f.timers.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('player bar retirement removes every owned observer and readiness subscription', async () => {
  const f = forceShuffleFixture(source);
  try {
    await f.startForce();
    f.admit();
    f.bar.replaceWith(f.dom.document.createElement('ytmusic-player-bar'));
    await f.settle();
    expect(f.timers.size).toBe(0);
    expect(f.subscriptions.size).toBe(0);
    expect(f.observers.size).toBe(0);
    f.advance(1500);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('config, disable, navigation and window retirement invalidate saved callbacks', async () => {
  for (const cancellation of ['config', 'disable', 'navigation', 'pagehide']) {
    const f = forceShuffleFixture(source);
    try {
      await f.startForce();
      f.admit();
      const old = [...f.timers.values()][0].callback;
      if (cancellation === 'config')
        f.force.renderer.onConfigChange({ enabled: true, mode: 'preserve' });
      if (cancellation === 'disable')
        f.force.renderer.onConfigChange({ enabled: false, mode: 'always' });
      if (cancellation === 'navigation')
        f.dom.history.pushState({}, '', '/browse');
      if (cancellation === 'pagehide')
        f.dom.dispatchEvent(new f.dom.Event('pagehide'));
      old();
      f.advance(1500);
      expect(f.calls, cancellation).toHaveLength(0);
      expect(f.subscriptions.size).toBe(0);
      expect(f.timers.size).toBe(0);
      if (cancellation === 'disable' || cancellation === 'pagehide')
        expect(f.observers.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('an explicit off click is respected by always mode for same-video admissions until a new track', async () => {
  const f = forceShuffleFixture(source, { shuffled: true });
  try {
    await f.startForce();
    f.admit();
    f.click();
    await f.settle();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(0);
    f.identity('trackBBBBBB');
    f.populate();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].selected).toEqual({
      playlistPanelVideoRenderer: { videoId: 'trackBBBBBB', selected: true },
    });
  } finally {
    await f.close();
  }
});

test('a current force check can proceed after pending Resume expiry without a coordinator timer', async () => {
  const f = forceShuffleFixture(source, { items: [] });
  try {
    await f.startResume();
    await f.startForce();
    f.advance(9000);
    f.admit();
    f.advance(1000);
    expect(f.calls).toHaveLength(0);
    f.populate();
    f.advance(500);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].at).toBe(10500);
    expect(f.timers.size).toBe(0);
    expect(f.subscriptions.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('pending restore priority blocks Force even with a ready Force facade', async () => {
  const f = forceShuffleFixture(source);
  try {
    const priority = f.source.actionOwner.createShuffleActionOwner(
      f.dom.document,
      'restore',
    );
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(0);
    priority.release();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('cooldown is reserved before a reentrant native callback and survives plugin reenable', async () => {
  const f = forceShuffleFixture(source);
  let reserved: boolean | undefined;
  try {
    f.onShuffle = () => {
      const restore = f.source.actionOwner.createShuffleActionOwner(
        f.dom.document,
        'restore',
      );
      reserved = restore.begin(f.now);
      restore.release();
      f.force.renderer.stop();
    };
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(reserved).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.observers.size).toBe(0);
    f.onShuffle = undefined;
    f.reset();
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    f.advance(1500);
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('coordinator replacement tokens preserve newer priority and cooldown, without hooks or timers', async () => {
  const f = forceShuffleFixture(source);
  try {
    const create = f.source.actionOwner.createShuffleActionOwner;
    const old = create(f.dom.document, 'restore'),
      latest = create(f.dom.document, 'restore');
    old.release();
    expect(old.begin(0)).toBe(false);
    expect(latest.isCurrent()).toBe(true);
    const force = create(f.dom.document, 'force');
    expect(force.begin(0)).toBe(false);
    expect(latest.begin(0)).toBe(true);
    latest.release();
    expect(force.begin(2999)).toBe(false);
    expect(force.begin(3000)).toBe(true);
    const replacement = create(f.dom.document, 'force');
    force.release();
    expect(replacement.isCurrent()).toBe(true);
    expect(replacement.begin(5999)).toBe(false);
    expect(replacement.begin(6000)).toBe(true);
    expect(f.timers.size).toBe(0);
    expect(f.observers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('late startup configs and stale generation callbacks cannot revive a disabled or replacement owner', async () => {
  const f = forceShuffleFixture(source);
  let resolve!: (config: unknown) => void;
  try {
    const pending = f.force.renderer.onPlayerApiReady(f.api, {
      ...f.forceContext,
      getConfig: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    f.force.renderer.stop();
    await f.startForce();
    f.admit();
    resolve({ enabled: true, mode: 'always' });
    await pending;
    expect(f.timers.size).toBe(1);
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    f.force.renderer.stop();
    expect(f.observers.size).toBe(0);
    expect(f.subscriptions.size).toBe(0);
    const loading = f.force.renderer.onPlayerApiReady(f.api, {
      ...f.forceContext,
      getConfig: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    f.force.renderer.onConfigChange({ enabled: false, mode: 'always' });
    resolve({ enabled: true, mode: 'always' });
    await loading;
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('native getter admission reentry preserves the new check and readiness keepers cannot revive old ownership', async () => {
  const f = forceShuffleFixture(source);
  try {
    await f.startForce();
    const read = f.api.getVideoData;
    let armed = true;
    f.api.getVideoData = () => {
      if (armed) {
        armed = false;
        f.admit();
      }
      return read();
    };
    f.admit();
    expect(f.timers.size).toBe(1);
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
    f.force.renderer.stop();
    f.reset();
    await f.startForce();
    let releases = 0;
    f.store.subscribe = () => {
      f.force.renderer.stop();
      return () => {
        releases++;
      };
    };
    f.admit();
    expect(releases).toBe(1);
    expect(f.timers.size).toBe(0);
    expect(f.observers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('a positively observed native state survives reset before preserve admission', async () => {
  const f = forceShuffleFixture(source, { mode: 'preserve' });
  try {
    await f.startForce();
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.reset();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an explicit off click keeps the admitted identity when native metadata is temporarily unready', async () => {
  const f = forceShuffleFixture(source, { shuffled: true });
  try {
    await f.startForce();
    f.admit();
    const read = f.api.getVideoData;
    f.api.getVideoData = () => ({ video_id: '' });
    f.click();
    f.api.getVideoData = read;
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(0);
    expect(f.bar.hasAttribute('shuffle-on')).toBe(false);
  } finally {
    await f.close();
  }
});

test('a Resume keeper that stops the action does not reserve cooldown against the next Force owner', async () => {
  const f = forceShuffleFixture(source);
  try {
    const subscribe = f.store.subscribe;
    f.store.subscribe = (callback) => {
      const release = subscribe(callback) as () => void;
      return () => {
        release();
        f.resume.renderer.stop();
      };
    };
    await f.startResume();
    expect(f.calls).toHaveLength(0);
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('partially ready queue identities cannot be replaced under the old metadata admission', async () => {
  for (const replacement of ['element', 'queue', 'store']) {
    const f = forceShuffleFixture(source, {
      missingQueue: replacement === 'element',
    });
    try {
      const nativeShuffle = f.queue.shuffle;
      if (replacement !== 'element') (f.queue as any).shuffle = undefined;
      await f.startForce();
      f.admit();
      if (replacement === 'element') {
        const next = f.dom.document.createElement('div') as any;
        next.id = 'queue';
        next.queue = f.queue;
        f.queueElement.replaceWith(next);
        await f.settle();
      } else if (replacement === 'queue') {
        f.queueElement.queue = { ...f.queue, shuffle: nativeShuffle };
      } else {
        f.queue.store.store = { ...f.store };
        f.queue.shuffle = nativeShuffle;
      }
      f.advance(1500);
      expect(f.calls, replacement).toHaveLength(0);
      expect(f.subscriptions.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('a native state getter cannot replace the store and authorize an old queue action', async () => {
  const f = forceShuffleFixture(source);
  try {
    const read = f.store.getState;
    let armed = true;
    f.store.getState = () => {
      if (armed) {
        armed = false;
        f.queue.store.store = { ...f.store, getState: read };
      }
      return read();
    };
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(f.calls).toHaveLength(0);
    expect(f.subscriptions.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('the current bar facade and unambiguous selected-flag fallback are native action controls', async () => {
  const f = forceShuffleFixture(source);
  try {
    let calls = 0;
    let receiver = false;
    const facade = {
      shuffle() {
        calls++;
        receiver = this === facade;
        f.bar.setAttribute('shuffle-on', '');
      },
    };
    (f.bar as any).queue = facade;
    f.selectIndex(undefined);
    await f.startForce();
    f.admit();
    f.advance(1500);
    expect(calls).toBe(1);
    expect(receiver).toBe(true);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
  const ambiguous = forceShuffleFixture(source, {
    items: [
      {
        playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
      },
      {
        playlistPanelVideoRenderer: { videoId: 'trackBBBBBB', selected: true },
      },
    ],
  });
  try {
    ambiguous.selectIndex(undefined);
    await ambiguous.startForce();
    ambiguous.admit();
    ambiguous.advance(1500);
    expect(ambiguous.calls).toHaveLength(0);
  } finally {
    await ambiguous.close();
  }
});

test('a late callable bar facade can complete an actionless view queue without replacing its identity', async () => {
  const f = forceShuffleFixture(source);
  try {
    (f.queue as any).shuffle = undefined;
    await f.startForce();
    f.admit();
    let calls = 0;
    let receiver = false;
    const facade = {
      shuffle() {
        calls++;
        receiver = this === facade;
        f.bar.setAttribute('shuffle-on', '');
      },
    };
    (f.bar as any).queue = facade;
    f.advance(1500);
    expect(calls).toBe(1);
    expect(receiver).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(f.subscriptions.size).toBe(0);
  } finally {
    await f.close();
  }
});
