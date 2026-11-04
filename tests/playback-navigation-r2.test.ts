import { expect, test } from '@playwright/test';
import { navigationFixture } from './helpers/playback-navigation-fixture';

for (const retirement of ['disable', 'list-remove', 'stop'] as const) {
  test(`R2 ${retirement} reentry cannot execute an earlier cached artist match`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const observed = await page.evaluate((retirement) => {
      const w = window as any,
        f = w.FilterFixture;
      w.previousCommand();
      const original = w.api.getPlaylistIndex;
      let calls = 0,
        changed = false;
      w.api.getPlaylistIndex = () => {
        if (++calls === 2) {
          changed = true;
          if (retirement === 'stop') f.blocklist.renderer.stop();
          else
            f.blocklist.renderer.onConfigChange(
              retirement === 'disable'
                ? { ...w.config, enabled: false }
                : { ...w.config, blockedArtists: [] },
            );
        }
        return original();
      };
      f.blocklist.renderer.onPlayerApiReady(w.api);
      return { changed, skips: w.state.skips.length, effects: w.state.effects };
    }, retirement);
    expect(observed).toEqual({ changed: true, skips: 1, effects: 1 });
  });
}

test('R2 attachment reentry cannot advance the replacement player twice', async ({
  page,
}) => {
  await navigationFixture(page);
  const observed = await page.evaluate(() => {
    const w = window as any,
      f = w.FilterFixture;
    w.previousCommand();
    const original = w.api.getPlaylistIndex;
    let calls = 0,
      changed = false,
      replacementSkips = 0;
    w.api.getPlaylistIndex = () => {
      if (++calls === 2) {
        changed = true;
        const player = document.createElement('div') as any;
        for (const key of Object.keys(w.api)) player[key] = w.api[key];
        player.getPlaylistIndex = original;
        player.nextVideo = () => replacementSkips++;
        document.body.append(player);
        f.blocklist.renderer.onPlayerApiReady(player);
      }
      return original();
    };
    f.blocklist.renderer.onPlayerApiReady(w.api);
    return { changed, originalSkips: w.state.skips.length, replacementSkips };
  });
  expect(observed).toEqual({
    changed: true,
    originalSkips: 1,
    replacementSkips: 1,
  });
});

test('R2 final advance getter policy retirement cannot set a stale skip claim', async ({
  page,
}) => {
  await navigationFixture(page);
  const observed = await page.evaluate(() => {
    const w = window as any,
      f = w.FilterFixture;
    w.previousCommand();
    w.navigation.cancel();
    const advance = w.api.nextVideo;
    let changed = false;
    Object.defineProperty(w.api, 'nextVideo', {
      configurable: true,
      get() {
        if (!changed) {
          changed = true;
          f.blocklist.renderer.onConfigChange({ ...w.config, enabled: false });
        }
        return advance;
      },
    });
    f.blocklist.renderer.onPlayerApiReady(w.api);
    return { changed, skips: w.state.skips.length };
  });
  expect(observed).toEqual({ changed: true, skips: 1 });
});

for (const layout of [
  'supported',
  'unsupported',
  'wrong',
  'replace',
  'retire',
  'late-replace',
  'descriptor-replace',
] as const) {
  test(`R2 native queue accessor ${layout} uses only fenced own backing links`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const observed = await page.evaluate((layout) => {
      const w = window as any,
        node = document.querySelector('#queue') as any;
      const nativeQueue = node.queue;
      let calls = 0;
      if (layout === 'late-replace') {
        const original = w.api.getPlaylistIndex;
        w.api.getPlaylistIndex = () => {
          node.inst.queue = { ...nativeQueue };
          return original();
        };
      }
      if (layout !== 'unsupported') node.inst = { queue: nativeQueue };
      Object.defineProperty(node, 'queue', {
        configurable: true,
        get() {
          calls++;
          if (layout === 'wrong') return { ...nativeQueue };
          if (layout === 'replace') {
            const captured = this.inst.queue;
            this.inst = { queue: captured };
            return captured;
          }
          if (layout === 'descriptor-replace')
            Object.defineProperty(node, 'queue', {
              configurable: true,
              get: () => nativeQueue,
            });
          if (layout === 'retire') w.disposeOwner();
          return this.inst?.queue ?? nativeQueue;
        },
      });
      w.previousCommand();
      return {
        getterUsed: calls > 0,
        skips: w.state.skips.length,
        effects: w.state.effects,
      };
    }, layout);
    expect(observed).toEqual({
      getterUsed: layout !== 'unsupported',
      skips: layout === 'supported' ? 1 : 2,
      effects: 1,
    });
  });
}

for (const shape of [
  'array',
  'null',
  'number',
  'date',
  'map',
  'absent',
  'partial',
  'false',
  'true',
] as const) {
  test(`R2 shared playback ${shape} configuration keeps only verified record defaults`, async ({
    page,
  }) => {
    await navigationFixture(page);
    const observed = await page.evaluate((shape) => {
      const w = window as any;
      const values: any = {
        array: [],
        null: null,
        number: 1,
        date: new Date(),
        map: new Map(),
        partial: {},
        false: { enabled: false },
        true: { enabled: true },
      };
      const plugins =
        shape === 'absent' ? {} : { 'music-together': values[shape] };
      w.mainConfig.get = () => plugins;
      w.previousCommand();
      return { skips: w.state.skips.length, effects: w.state.effects };
    }, shape);
    expect(observed).toEqual({
      skips: ['absent', 'partial', 'false'].includes(shape) ? 1 : 2,
      effects: 1,
    });
  });
}

for (const emptied of [false, true]) {
  test(`R2 initial target load seeking ${emptied ? 'after emptied' : 'before ready'} defers until confirmation, then later seek retires`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    const observed = await page.evaluate((emptied) => {
      const w = window as any,
        video = document.querySelector('video')!;
      w.api.previousVideo = () => {
        Object.defineProperty(video, 'readyState', {
          configurable: true,
          value: 0,
        });
        if (emptied) video.dispatchEvent(new Event('emptied'));
        w.play(4);
        video.dispatchEvent(new Event('seeking'));
      };
      w.previousCommand();
      const loading = w.state.skips.length;
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: 1,
      });
      video.dispatchEvent(new Event('loadedmetadata'));
      w.announce('dataupdated');
      const confirmed = w.state.skips.length;
      video.dispatchEvent(new Event('seeking'));
      w.announce('dataupdated');
      return { loading, confirmed, laterSeek: w.state.skips.length };
    }, emptied);
    expect(observed).toEqual({ loading: 1, confirmed: 1, laterSeek: 2 });
  });
}

test('R2 settled native seek/restart retires artist occurrence permission', async ({
  page,
}) => {
  await navigationFixture(page);
  const observed = await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    w.state.time = 26;
    w.state.time = 0;
    document.querySelector('video')!.dispatchEvent(new Event('seeking'));
    w.announce('dataupdated');
    return { skips: w.state.skips.length, effects: w.state.effects };
  });
  expect(observed).toEqual({ skips: 2, effects: 1 });
});

for (const key of ['k', 'Shift+P']) {
  test(`R2 observed Previous ${key} works without legacy control or aria advertisement`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    await page.evaluate(() => {
      const w = window as any;
      document.addEventListener('keydown', (event) => {
        if (['k', 'p'].includes(event.key.toLowerCase())) w.api.previousVideo();
      });
    });
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return { skips: w.state.skips.length, effects: w.state.effects };
      }),
    ).toEqual({ skips: 1, effects: 1 });
  });
}

for (const key of ['j', 'Shift+N']) {
  test(`R2 observed Next ${key} cancels settled permission and dispatches no extra command`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    await page.evaluate(() => (window as any).previousCommand());
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => {
        const w = window as any;
        w.announce('dataupdated');
        return { skips: w.state.skips.length, effects: w.state.effects };
      }),
    ).toEqual({ skips: 2, effects: 1 });
  });
}

for (const second of [false, true]) {
  test(`R2 Shift+P first-key restart ${second ? 'then immediate second Previous' : 'cannot donate a later return'}`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    await page.evaluate(() => {
      const w = window as any;
      let presses = 0;
      w.state.time = 26;
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'P' || !event.shiftKey) return;
        w.state.effects++;
        if (++presses === 1) {
          w.state.time = 0;
          document.querySelector('video')!.dispatchEvent(new Event('seeking'));
          w.announce('dataloaded');
        } else w.play(4);
      });
    });
    await page.keyboard.press('Shift+P');
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return { index: w.state.index, skips: w.state.skips.length };
      }),
    ).toEqual({ index: 5, skips: 1 });
    if (second) await page.keyboard.press('Shift+P');
    else await page.evaluate(() => (window as any).play(4));
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return {
          index: w.state.index,
          skips: w.state.skips.length,
          effects: w.state.effects,
        };
      }),
    ).toEqual({ index: 4, skips: second ? 1 : 2, effects: second ? 2 : 1 });
  });
}

for (const guard of [
  'editable',
  'dialog',
  'modifier',
  'synthetic',
  'unknown',
  'repeat',
] as const) {
  test(`R2 keyboard ${guard} input cannot donate Previous permission`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    await page.evaluate((guard) => {
      const w = window as any;
      if (guard === 'editable') {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
      }
      if (guard === 'dialog')
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div role="dialog" aria-modal="true"></div>',
        );
      document.addEventListener('keydown', (event) => {
        if (
          ['k', 'q'].includes(event.key.toLowerCase()) &&
          (guard !== 'repeat' || event.repeat)
        )
          w.api.previousVideo();
      });
    }, guard);
    if (guard === 'synthetic')
      await page.evaluate(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', bubbles: true }),
        ),
      );
    else if (guard === 'repeat') {
      await page.keyboard.down('k');
      await page.keyboard.down('k');
      await page.keyboard.up('k');
    } else
      await page.keyboard.press(
        guard === 'modifier' ? 'Shift+K' : guard === 'unknown' ? 'q' : 'k',
      );
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return { skips: w.state.skips.length, effects: w.state.effects };
      }),
    ).toEqual({ skips: 2, effects: 1 });
  });
}

test('R2 wrong-focus trusted keyboard input cannot donate Previous permission', async ({
  page,
}) => {
  await navigationFixture(page, { button: false });
  await page.evaluate(() => {
    const w = window as any;
    w.focusReads = 0;
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => {
        w.focusReads++;
        return false;
      },
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'k') w.api.previousVideo();
    });
  });
  await page.keyboard.press('k');
  const observed = await page.evaluate(() => {
    const w = window as any;
    return {
      focusReads: w.focusReads,
      skips: w.state.skips.length,
      effects: w.state.effects,
    };
  });
  expect(observed).toEqual({ focusReads: 1, skips: 2, effects: 1 });
});

for (const key of ['q', 'j']) {
  test(`R2 competing ${key} input retires a pending explicit Previous`, async ({
    page,
  }) => {
    await navigationFixture(page, { button: false });
    await page.evaluate(() => {
      const w = window as any;
      w.api.previousVideo = () => w.state.effects++;
      w.previousCommand();
    });
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => {
        const w = window as any;
        w.play(4);
        return { skips: w.state.skips.length, effects: w.state.effects };
      }),
    ).toEqual({ skips: 2, effects: 1 });
  });
}

test('R2 immediate second Previous remains valid while the known source restart is seeking', async ({
  page,
}) => {
  await navigationFixture(page, { button: false });
  await page.evaluate(() => {
    const w = window as any,
      video = document.querySelector('video')!;
    let presses = 0;
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'P' || !event.shiftKey) return;
      w.state.effects++;
      if (++presses === 1) {
        Object.defineProperty(video, 'seeking', {
          configurable: true,
          value: true,
        });
        video.dispatchEvent(new Event('seeking'));
        w.announce('dataloaded');
      } else w.play(4);
    });
  });
  await page.keyboard.press('Shift+P');
  await page.keyboard.press('Shift+P');
  const observed = await page.evaluate(() => {
    const w = window as any,
      video = document.querySelector('video')!;
    const loading = w.state.skips.length;
    Object.defineProperty(video, 'seeking', {
      configurable: true,
      value: false,
    });
    video.dispatchEvent(new Event('seeked'));
    w.announce('dataupdated');
    return { loading, settled: w.state.skips.length, effects: w.state.effects };
  });
  expect(observed).toEqual({ loading: 1, settled: 1, effects: 2 });
});

test('R2 provisional unready target cannot extend its original intent deadline', async ({
  page,
}) => {
  await page.clock.install();
  await navigationFixture(page, { button: false });
  await page.evaluate(() => {
    const w = window as any;
    w.api.previousVideo = () => {
      Object.defineProperty(document.querySelector('video'), 'readyState', {
        configurable: true,
        value: 0,
      });
      w.play(4);
    };
    w.previousCommand();
  });
  expect(await page.evaluate(() => (window as any).state.skips.length)).toBe(1);
  await page.clock.fastForward(2001);
  expect(
    await page.evaluate(() => {
      const w = window as any;
      w.announce('dataupdated');
      return w.state.skips.length;
    }),
  ).toBe(2);
});

test('R2 retired match leaves a clean claim for one later legitimate re-enable skip', async ({
  page,
}) => {
  await navigationFixture(page);
  const observed = await page.evaluate(() => {
    const w = window as any,
      f = w.FilterFixture;
    w.previousCommand();
    let calls = 0;
    const original = w.api.getPlaylistIndex;
    w.api.getPlaylistIndex = () => {
      if (++calls === 2)
        f.blocklist.renderer.onConfigChange({ ...w.config, enabled: false });
      return original();
    };
    f.blocklist.renderer.onPlayerApiReady(w.api);
    const disabled = w.state.skips.length;
    w.api.getPlaylistIndex = original;
    f.blocklist.renderer.onConfigChange(w.config);
    w.announce('dataupdated');
    return { disabled, reenabled: w.state.skips.length };
  });
  expect(observed).toEqual({ disabled: 1, reenabled: 2 });
});

test('R2 settled permission is not extended into a new unready media phase', async ({
  page,
}) => {
  await navigationFixture(page);
  const skips = await page.evaluate(() => {
    const w = window as any;
    w.previousCommand();
    Object.defineProperty(document.querySelector('video'), 'readyState', {
      configurable: true,
      value: 0,
    });
    w.announce('dataupdated');
    return w.state.skips.length;
  });
  expect(skips).toBe(2);
});
