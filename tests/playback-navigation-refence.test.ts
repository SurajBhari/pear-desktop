import { test, expect } from '@playwright/test';
import { navigationFixture } from './helpers/playback-navigation-fixture';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (r) => r.abort());
});

for (const remote of [false, true]) {
  test(`trailing replacement store snapshot preserves cast eligibility remote=${remote}`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((remote) => {
      const w = window as any;
      w.previousCommand();
      const native = (document.querySelector('#queue') as any).queue;
      const original = native.getItems;
      let calls = 0;
      native.getItems = () => {
        const rows = original();
        if (++calls === 2)
          w.storeState = {
            queue: w.queue,
            castStatus: remote ? { remoteWatchEndpoint: {} } : {},
          };
        return rows;
      };
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      return { skips: w.state.skips.length, calls };
    }, remote);
    expect(result.calls).toBe(2);
    expect(result.skips).toBe(remote ? 2 : 1);
  });
}

for (const replace of [false, true]) {
  test(`optional absent queue data retains its prototype path replace=${replace}`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((replace) => {
      const w = window as any;
      delete w.queue.queueContextParams;
      w.previousCommand();
      const native = (document.querySelector('#queue') as any).queue;
      const original = native.getItems;
      let calls = 0;
      native.getItems = () => {
        const rows = original();
        if (++calls === 2 && replace)
          Object.setPrototypeOf(w.queue, {
            queueContextParams: 'replacement-context',
          });
        return rows;
      };
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      return { skips: w.state.skips.length, calls };
    }, replace);
    expect(result.calls).toBe(2);
    expect(result.skips).toBe(replace ? 2 : 1);
  });
}

for (const mutation of [
  'none',
  'shared-replace',
  'media-unready',
  'media-seeking',
  'queue-prototype',
] as const) {
  test(`trailing native callback ${mutation} cannot retain stale occurrence facts`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((mutation) => {
      const w = window as any;
      w.FilterFixture.blocklist.renderer.stop();
      w.previousCommand();
      const policy = Symbol('independent-policy');
      const before = w.navigation.allowsArtist(w.state.id, policy);
      const video = document.querySelector('video')!;
      const native = (document.querySelector('#queue') as any).queue;
      if (mutation === 'queue-prototype') {
        delete w.queue.selectedItemIndex;
        Object.setPrototypeOf(w.queue, { selectedItemIndex: w.state.index });
      }
      const original = native.getItems;
      let calls = 0,
        changed = false;
      native.getItems = () => {
        const result = original();
        if (++calls === 2) {
          changed = mutation !== 'none';
          if (mutation === 'shared-replace')
            w.mainConfig.get = () => ({ 'music-together': { enabled: true } });
          if (mutation === 'media-unready')
            Object.defineProperty(video, 'readyState', {
              configurable: true,
              value: 0,
            });
          if (mutation === 'media-seeking')
            Object.defineProperty(video, 'seeking', {
              configurable: true,
              value: true,
            });
          if (mutation === 'queue-prototype')
            Object.setPrototypeOf(w.queue, { selectedItemIndex: 3 });
        }
        return result;
      };
      const after = w.navigation.allowsArtist(w.state.id, policy);
      const followup = w.navigation.allowsArtist(w.state.id, policy);
      return { before, after, followup, calls, changed };
    }, mutation);
    console.log(mutation, JSON.stringify(result));
    expect(result.before).toBe(true);
    expect(result.changed).toBe(mutation !== 'none');
    expect(result.after).toBe(mutation === 'none');
    expect(result.followup).toBe(mutation === 'none');
  });
}

for (const mutation of [
  'none',
  'shared-replace',
  'media-unready',
  'media-seeking',
  'queue-prototype',
  'ad-class',
] as const) {
  test(`actual artist refresh rejects trailing ${mutation} instead of donating one stale exemption`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((mutation) => {
      const w = window as any;
      w.previousCommand();
      const video = document.querySelector('video')!;
      const native = (document.querySelector('#queue') as any).queue;
      if (mutation === 'queue-prototype') {
        delete w.queue.selectedItemIndex;
        Object.setPrototypeOf(w.queue, { selectedItemIndex: w.state.index });
      }
      const original = native.getItems;
      let calls = 0,
        changed = false;
      native.getItems = () => {
        const rows = original();
        if (++calls === 2) {
          changed = mutation !== 'none';
          if (mutation === 'shared-replace')
            w.mainConfig.get = () => ({ 'music-together': { enabled: true } });
          if (mutation === 'media-unready')
            Object.defineProperty(video, 'readyState', {
              configurable: true,
              value: 0,
            });
          if (mutation === 'media-seeking')
            Object.defineProperty(video, 'seeking', {
              configurable: true,
              value: true,
            });
          if (mutation === 'queue-prototype')
            Object.setPrototypeOf(w.queue, { selectedItemIndex: 3 });
          if (mutation === 'ad-class') w.api.classList.add('ad-showing');
        }
        return rows;
      };
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      const first = w.state.skips.length;
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      return { first, followup: w.state.skips.length, calls, changed };
    }, mutation);
    console.log('ACTUAL_FILTER', mutation, JSON.stringify(result));
    expect(result.changed).toBe(mutation !== 'none');
    expect(result.first).toBe(mutation === 'none' ? 1 : 2);
    expect(result.followup).toBe(mutation === 'none' ? 1 : 2);
  });
}

for (const control of [
  'shared-in-place',
  'media-seeking-event',
  'queue-own-index',
  'inherited-stable',
] as const) {
  test(`nearby actual-source control ${control} distinguishes fenced changes from stale facts`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((control) => {
      const w = window as any;
      w.previousCommand();
      const plugins = { 'music-together': { enabled: false } };
      w.mainConfig.get = () => plugins;
      if (control === 'inherited-stable') {
        delete w.queue.selectedItemIndex;
        Object.setPrototypeOf(w.queue, { selectedItemIndex: w.state.index });
      }
      const native = (document.querySelector('#queue') as any).queue;
      const original = native.getItems;
      let calls = 0,
        entered = false;
      native.getItems = () => {
        const rows = original();
        if (++calls === 2) {
          entered = true;
          if (control === 'shared-in-place')
            plugins['music-together'].enabled = true;
          if (control === 'media-seeking-event')
            document
              .querySelector('video')!
              .dispatchEvent(new Event('seeking'));
          if (control === 'queue-own-index') w.queue.selectedItemIndex = 3;
        }
        return rows;
      };
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      return { skips: w.state.skips.length, entered };
    }, control);
    console.log('NEARBY_CONTROL', control, JSON.stringify(result));
    expect(result).toEqual({
      skips: control === 'inherited-stable' ? 1 : 2,
      entered: true,
    });
  });
}

for (const mutation of [
  'none',
  'local-store',
  'remote-store',
  'replacement-queue',
] as const) {
  test(`native identity callback after trailing store read ${mutation} retains current snapshot`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((mutation) => {
      const w = window as any;
      w.previousCommand();
      const store = (document.querySelector('#queue') as any).queue.store.store;
      const read = store.getState,
        response = w.api.getPlayerResponse;
      const barBaseline = w.reads.bar;
      let storeReads = 0,
        changed = false,
        lateCalls = 0;
      store.getState = () => {
        storeReads++;
        return read();
      };
      w.api.getPlayerResponse = () => {
        if (w.reads.bar >= barBaseline + 4) {
          lateCalls++;
          if (!changed && mutation !== 'none') {
            changed = true;
            if (mutation === 'local-store')
              w.storeState = { queue: w.queue, castStatus: {} };
            if (mutation === 'remote-store')
              w.storeState = {
                queue: w.queue,
                castStatus: { remoteWatchEndpoint: {} },
              };
            if (mutation === 'replacement-queue')
              w.storeState = {
                queue: { ...w.queue, selectedItemIndex: 3 },
                castStatus: {},
              };
          }
        }
        return response();
      };
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      const first = w.state.skips.length;
      w.FilterFixture.blocklist.renderer.onPlayerApiReady(w.api);
      return {
        storeReads,
        lateCalls,
        changed,
        first,
        followup: w.state.skips.length,
      };
    }, mutation);
    console.log('LATE_NATIVE', mutation, JSON.stringify(result));
    expect(result.lateCalls).toBeGreaterThan(0);
    expect(result.changed).toBe(mutation !== 'none');
    expect(result.first).toBe(
      ['none', 'local-store'].includes(mutation) ? 1 : 2,
    );
    expect(result.followup).toBe(
      ['none', 'local-store'].includes(mutation) ? 1 : 2,
    );
  });
}

for (const depth of [0, 15, 16, 17]) {
  test(`optional cast endpoint at prototype depth ${depth} cannot be treated as absent`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const result = await page.evaluate((depth) => {
      const w = window as any;
      let cast: any = { remoteWatchEndpoint: { source: 'controlled-remote' } };
      for (let i = 0; i < depth; i++) cast = Object.create(cast);
      w.storeState.castStatus = cast;
      w.previousCommand();
      return {
        remotePresent: w.storeState.castStatus.remoteWatchEndpoint != null,
        skips: w.state.skips.length,
        effects: w.state.effects,
      };
    }, depth);
    console.log('OPTIONAL_DEPTH', depth, JSON.stringify(result));
    expect(result).toEqual({ remotePresent: true, skips: 2, effects: 1 });
  });
}
