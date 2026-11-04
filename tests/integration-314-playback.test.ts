import { expect, test } from '@playwright/test';
import { navigationFixture } from './helpers/playback-navigation-fixture';
import { startCrossfadeFixture } from './helpers/crossfade-native';

// These controls catch a category predicate lost in the merge, an artist
// exemption applied to the category filter, and independent physical-next claims.
for (const category of ['acoustic', 'demo'] as const) {
  for (const alternative of [false, true]) {
    for (const categoryFirst of [false, true]) {
      test(`selected ${category} ${alternative ? 'alternativeTitle' : 'title'} overrides exact Previous permission, categoryFirst=${categoryFirst}`, async ({
        page,
      }) => {
        await navigationFixture(page, {
          sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
        });
        const result = await page.evaluate(
          async ({ category, alternative, categoryFirst }) => {
            const w = window as any,
              f = w.FilterFixture;
            f.blocklist.renderer.stop();
            let publish = (_: unknown) => {};
            const startArtist = async () => {
              await f.blocklist.renderer.start(w.context);
              f.blocklist.renderer.onPlayerApiReady(w.api);
            };
            const startCategory = async () => {
              await f.live.renderer.start({
                ...w.context,
                getConfig: async () => ({
                  enabled: true,
                  categories: { live: false, [category]: true },
                }),
                ipc: {
                  subscribe: (_: string, cb: typeof publish) => {
                    publish = cb;
                    return () => {};
                  },
                },
              });
              f.live.renderer.onPlayerApiReady(w.api);
            };
            if (categoryFirst) {
              await startCategory();
              await startArtist();
            } else {
              await startArtist();
              await startCategory();
            }
            const announce = w.announce;
            w.announce = (name: string) => {
              if (w.state.index === 4) {
                const marked =
                  category === 'acoustic'
                    ? 'Song (Acoustic Version)'
                    : 'Song (Demo)';
                w.state.title = alternative ? 'Song' : marked;
                w.metadata = {
                  videoId: w.state.id,
                  artist: w.state.author,
                  title: w.state.title,
                  ...(alternative ? { alternativeTitle: marked } : {}),
                };
              }
              announce(name);
              publish(w.metadata);
            };
            const before = w.state.skips.length;
            w.previousCommand();
            w.announce('dataupdated');
            const skipped = w.state.skips.slice(before);
            f.live.renderer.stop();
            f.blocklist.renderer.stop();
            return { effects: w.state.effects, skipped };
          },
          { category, alternative, categoryFirst },
        );
        expect(result).toEqual({
          effects: 1,
          skipped: [{ id: 'trackA00001', index: 4 }],
        });
      });
    }
  }
}

for (const enabled of [false, true]) {
  test(`all-off categories retain valid artist Previous permission, enabled=${enabled}`, async ({
    page,
  }) => {
    await navigationFixture(page, {
      sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
    });
    const result = await page.evaluate(async (enabled) => {
      const w = window as any,
        f = w.FilterFixture;
      await f.live.renderer.start({
        ...w.context,
        getConfig: async () => ({
          enabled,
          categories: {
            live: false,
            acoustic: false,
            demo: false,
            session: false,
            venue: false,
          },
        }),
      });
      f.live.renderer.onPlayerApiReady(w.api);
      const before = w.state.skips.length;
      w.previousCommand();
      w.announce('dataupdated');
      const permitted = w.state.skips.length - before;
      w.navigation.cancel();
      w.announce('dataupdated');
      return {
        permitted,
        afterRetirement: w.state.skips.length - before,
        effects: w.state.effects,
      };
    }, enabled);
    expect(result).toEqual({ permitted: 0, afterRetirement: 1, effects: 1 });
  });
}

for (const committed of [false, true]) {
  test(`reservation release ${committed ? 'preserves committed' : 'rolls back unconsumed'} intent before a real filter refresh`, async ({
    page,
  }) => {
    await navigationFixture(page, {
      sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
    });
    const result = await page.evaluate((committed) => {
      const w = window as any,
        f = w.FilterFixture;
      let matches = false;
      const filter = f.createPlaybackFilter(w.context, () => matches, {
        kind: 'live',
      });
      filter.attach(w.api);
      const reservation = f.claimCrossfadeNext(w.api, 'trackB00001', 5);
      matches = true;
      const before = w.state.skips.length;
      filter.refresh();
      const during = w.state.skips.length - before;
      if (committed) reservation.commit();
      reservation.release();
      filter.refresh();
      filter.refresh();
      const after = w.state.skips.length - before;
      filter.stop();
      return { reserved: !!reservation, during, after };
    }, committed);
    expect(result).toEqual({
      reserved: true,
      during: 0,
      after: committed ? 0 : 1,
    });
  });
}

test('a filter-owned physical skip blocks crossfade and survives one of two filter owners stopping', async ({
  page,
}) => {
  await navigationFixture(page, {
    sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
  });
  const result = await page.evaluate(() => {
    const w = window as any,
      f = w.FilterFixture;
    const first = f.createPlaybackFilter(w.context, () => true, {
      kind: 'live',
    });
    const second = f.createPlaybackFilter(w.context, () => true, {
      kind: 'live',
    });
    const before = w.state.skips.length;
    first.attach(w.api);
    second.attach(w.api);
    first.stop();
    second.refresh();
    const blocked = f.claimCrossfadeNext(w.api, 'trackB00001', 5) === null;
    second.stop();
    return { skipped: w.state.skips.slice(before), blocked };
  });
  expect(result).toEqual({
    skipped: [{ id: 'trackB00001', index: 5 }],
    blocked: true,
  });
});

test('an old committed reservation release cannot clear a new selected-category skip after Previous', async ({
  page,
}) => {
  await navigationFixture(page, {
    sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
  });
  const result = await page.evaluate(async () => {
    const w = window as any,
      f = w.FilterFixture,
      old = f.claimCrossfadeNext(w.api, 'trackB00001', 5);
    old.commit();
    await f.live.renderer.start({
      ...w.context,
      getConfig: async () => ({ enabled: true, categories: { demo: true } }),
    });
    f.live.renderer.onPlayerApiReady(w.api);
    const announce = w.announce;
    w.announce = (name: string) => {
      if (w.state.index === 4) w.state.title = 'Song (Demo)';
      announce(name);
    };
    const before = w.state.skips.length;
    w.previousCommand();
    old.release();
    w.announce('dataupdated');
    const blocked = f.claimCrossfadeNext(w.api, 'trackA00001', 4) === null;
    return { skipped: w.state.skips.slice(before), blocked };
  });
  expect(result).toEqual({
    skipped: [{ id: 'trackA00001', index: 4 }],
    blocked: true,
  });
});

for (const stopDuringGetter of [false, true]) {
  test(`a reservation acquired in the final advance getter fences the filter, stop=${stopDuringGetter}`, async ({
    page,
  }) => {
    await navigationFixture(page, {
      sourceRoot: process.env.INTEGRATION_314_SOURCE_ROOT,
    });
    const result = await page.evaluate((stopDuringGetter) => {
      const w = window as any,
        f = w.FilterFixture;
      let enabled = false;
      const filter = f.createPlaybackFilter(w.context, () => enabled, {
        kind: 'live',
      });
      filter.attach(w.api);
      const advance = w.api.nextVideo;
      let reservation: any;
      Object.defineProperty(w.api, 'nextVideo', {
        configurable: true,
        get() {
          if (!reservation) {
            reservation = f.claimCrossfadeNext(w.api, 'trackB00001', 5);
            if (stopDuringGetter) filter.stop();
          }
          return advance;
        },
      });
      const before = w.state.skips.length;
      enabled = true;
      filter.refresh();
      const during = w.state.skips.length - before;
      reservation.release();
      const nextFilter = stopDuringGetter
        ? f.createPlaybackFilter(w.context, () => true, { kind: 'live' })
        : filter;
      nextFilter.attach(w.api);
      nextFilter.refresh();
      const after = w.state.skips.slice(before);
      nextFilter.stop();
      return { reserved: !!reservation, during, after };
    }, stopDuringGetter);
    expect(result).toEqual({
      reserved: true,
      during: 0,
      after: [{ id: 'trackB00001', index: 5 }],
    });
  });
}

for (const filterFirst of [false, true]) {
  test(`actual crossfade controller and actual filter produce one physical next, filterFirst=${filterFirst}`, async ({
    page,
  }) => {
    await startCrossfadeFixture(page, {
      requestDelay: true,
      sourceExports:
        "export {createPlaybackFilter,claimCrossfadeNext} from '@/plugins/utils/renderer/playback-filter';",
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).crossfadeFixture.requests),
      )
      .toBe(1);
    await page.evaluate((filterFirst) => {
      const w = window as any,
        f = w.crossfadeFixture,
        production = w.EqualizerFixture;
      let enabled = false;
      const filter = production.createPlaybackFilter(
        { ipc: { subscribe: () => () => {} } },
        (track: any) => enabled && track.videoId === 'AAAAAAAAAAA',
        { kind: 'live' },
      );
      filter.attach(f.api);
      f.integrationFilter = filter;
      f.integrationProbeCalls = 0;
      if (filterFirst) {
        enabled = true;
        filter.refresh();
      } else {
        // Snapshot validation also reads nextVideo. Its getter is not a
        // reservation boundary and would recursively refresh the filter.
        // The handoff's zero-gain callout runs after the actual shared claim.
        const insert = f.graph.insertMain.bind(f.graph);
        f.graph.insertMain = (input: GainNode, output: GainNode) => {
          const set = input.gain.setValueAtTime.bind(input.gain);
          input.gain.setValueAtTime = (value: number, time: number) => {
            const result = set(value, time);
            // Incoming-B envelope setup can also write zero after native next.
            if (value === 0 && f.nexts === 0) {
              f.integrationProbeCalls++;
              f.integrationProbeBefore = f.nexts;
              const competing = production.claimCrossfadeNext(
                f.api,
                'AAAAAAAAAAA',
                0,
              );
              f.integrationProbeExcluded = competing === null;
              competing?.release();
              enabled = true;
              filter.refresh();
              f.integrationProbeAfter = f.nexts;
            }
            return result;
          };
          return insert(input, output);
        };
      }
      f.resolve();
    }, filterFirst);
    await expect
      .poll(() => page.evaluate(() => (window as any).crossfadeFixture.nexts), {
        timeout: 7000,
      })
      .toBe(1);
    const result = await page.evaluate(async () => {
      const f = (window as any).crossfadeFixture;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const nexts = f.nexts;
      const probe = {
        calls: f.integrationProbeCalls,
        before: f.integrationProbeBefore,
        after: f.integrationProbeAfter,
        excluded: f.integrationProbeExcluded,
      };
      f.integrationFilter.stop();
      f.renderer.stop();
      await f.context.close();
      return { nexts, probe };
    });
    expect(result.nexts).toBe(1);
    if (!filterFirst)
      expect(result.probe).toEqual({
        calls: 1,
        before: 0,
        after: 0,
        excluded: true,
      });
  });
}
