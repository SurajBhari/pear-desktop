import { test, expect } from '@playwright/test';
import {
  resumeShuffleFixture,
  resumeShuffleSource,
} from './helpers/resume-shuffle';

let source: string;
test.beforeAll(async () => {
  source = await resumeShuffleSource();
});

test('resume waits for the owned queue and shuffles once, then releases readiness work', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    expect(f.calls()).toBe(0);
    expect(f.subscriptions.size).toBe(1);
    f.populate();
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(1);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.writes.at(-1)).toEqual({ shuffled: true });
  } finally {
    await f.close();
  }
});

test('initial false is saved and subsequent user shuffle changes are persisted until stop', async () => {
  const f = resumeShuffleFixture(source, { shuffled: false });
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    await f.settle();
    expect(f.writes).toEqual([{ shuffled: false }]);
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    expect(f.writes.at(-1)).toEqual({ shuffled: true });
    f.plugin.renderer.stop();
    const count = f.writes.length;
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    expect(f.writes.length).toBe(count);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test('stop and superseding startup retire delayed config responses', async () => {
  const f = resumeShuffleFixture(source);
  let resolve!: (v: any) => void;
  try {
    const pending = f.plugin.renderer.onPlayerApiReady(f.api, {
      ...f.context,
      getConfig: () => new Promise((r) => (resolve = r)),
    });
    f.plugin.renderer.stop();
    await f.plugin.renderer.onPlayerApiReady(f.api, {
      ...f.context,
      getConfig: async () => ({ enabled: true, shuffled: false }),
    });
    resolve({ enabled: true, shuffled: true });
    await pending;
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.writes).toEqual([{ shuffled: false }]);
    expect(f.subscriptions.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('synchronous store subscribe still releases the returned subscription after one shuffle', async () => {
  const f = resumeShuffleFixture(source, {
    sync: true,
    items: [
      {
        playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
      },
    ],
  });
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    await f.settle();
    expect(f.calls()).toBe(1);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('A to B to A and a replaced queue cannot consume an old restore', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    expect(f.subscriptions.size).toBe(1);
    f.change('trackBBBBBB');
    f.change('trackAAAAAA');
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('timeout preserves the saved choice without shuffling a late queue', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    expect(f.timers.size).toBe(1);
    f.expire();
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.subscriptions.size).toBe(0);
    expect(f.writes).toEqual([]);
  } finally {
    await f.close();
  }
});

test('disabled resume does not restore and late queue discovery remains bounded', async () => {
  const f = resumeShuffleFixture(source, { resume: false });
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.writes).toEqual([{ shuffled: false }]);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
  const late = resumeShuffleFixture(source, { missingQueue: true });
  try {
    await late.plugin.renderer.onPlayerApiReady(late.api, late.context);
    late.queueElement.queue = late.queue;
    late.dom.document.body.append(late.dom.document.createElement('span'));
    await late.settle();
    late.populate();
    await late.settle();
    expect(late.calls()).toBe(1);
    expect(late.timers.size).toBe(0);
  } finally {
    await late.close();
  }
});

test('queue replacement and mismatched selected items cannot shuffle a retired queue', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.queueElement.queue = { ...f.queue };
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
  const other = resumeShuffleFixture(source);
  try {
    await other.plugin.renderer.onPlayerApiReady(other.api, other.context);
    other.populate([
      {
        playlistPanelVideoRenderer: { videoId: 'trackBBBBBB', selected: true },
      },
    ]);
    expect(other.calls()).toBe(0);
    other.populate();
    await other.settle();
    expect(other.calls()).toBe(1);
  } finally {
    await other.close();
  }
});

test('temporary native shuffle reset during queue loading does not erase the saved preference', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    expect(f.writes).toEqual([{ shuffled: true }]);
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(1);
    expect(f.writes.at(-1)).toEqual({ shuffled: true });
  } finally {
    await f.close();
  }
});

test('an explicit native shuffle-button click cancels pending restore and records user choice', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    const button = f.dom.document.createElement('button');
    button.className = 'shuffle';
    f.bar.append(button);
    button.click();
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    f.populate();
    expect(f.calls()).toBe(0);
    expect(f.writes.at(-1)).toEqual({ shuffled: false });
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('native player-bar shuffle facade can act on a distinct queue-view store', async () => {
  const f = resumeShuffleFixture(source);
  try {
    let nativeCalls = 0;
    (f.bar as any).queue = {
      shuffle() {
        nativeCalls++;
        f.bar.setAttribute('shuffle-on', '');
      },
    };
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.populate();
    await f.settle();
    expect(nativeCalls).toBe(1);
    expect(f.calls()).toBe(0);
    expect(f.subscriptions.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('SVG click inside the native shuffle button cancels pending restoration', async () => {
  const f = resumeShuffleFixture(source);
  try {
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    const button = f.dom.document.createElement('button');
    button.className = 'shuffle';
    const svg = f.dom.document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg',
    );
    button.append(svg);
    f.bar.append(button);
    expect(svg instanceof f.dom.HTMLElement).toBe(false);
    svg.dispatchEvent(new f.dom.MouseEvent('click', { bubbles: true }));
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    f.populate();
    expect(f.calls()).toBe(0);
    expect(f.writes.at(-1)).toEqual({ shuffled: false });
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('subscription disposal that reenters stop supersedes the interrupted ready', async () => {
  const f = resumeShuffleFixture(source);
  try {
    const subscribe = f.queue.store.store.subscribe;
    f.queue.store.store.subscribe = (callback) => {
      const release = subscribe(callback);
      return () => {
        release();
        f.plugin.renderer.stop();
      };
    };
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.populate();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.subscriptions.size).toBe(0);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('unready native identity preserves saved shuffle through reset and timeout until explicit choice', async () => {
  const f = resumeShuffleFixture(source);
  try {
    f.api.getVideoData = () => ({ video_id: '' });
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    f.expire();
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    expect(f.writes).toEqual([{ shuffled: true }]);
    expect(f.calls()).toBe(0);
    expect(f.timers.size).toBe(0);
    const button = f.dom.document.createElement('button');
    button.className = 'shuffle';
    f.bar.append(button);
    button.click();
    f.bar.setAttribute('shuffle-on', '');
    await f.settle();
    f.bar.removeAttribute('shuffle-on');
    await f.settle();
    expect(f.writes.at(-1)).toEqual({ shuffled: false });
  } finally {
    await f.close();
  }
});

test('synchronous subscription callbacks cannot act before a callable release is verified', async () => {
  const f = resumeShuffleFixture(source, {
    items: [
      {
        playlistPanelVideoRenderer: { videoId: 'trackAAAAAA', selected: true },
      },
    ],
  });
  try {
    let callback!: () => void;
    (f.queue.store.store as any).subscribe = (candidate: () => void) => {
      callback = candidate;
      candidate();
      return {};
    };
    await f.plugin.renderer.onPlayerApiReady(f.api, f.context);
    callback();
    await f.settle();
    expect(f.calls()).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.timers.size).toBe(0);
  } finally {
    await f.close();
  }
});
