import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { ts } from 'ts-morph';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

// Audit actual native edges: retiring an old owner must neither leak its
// routes nor remove a raw tap or a newer graph that shares the same source.
async function retirementFixture(page: import('@playwright/test').Page) {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(() => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    const edges = new Map<AudioNode, Set<AudioNode>>();
    const sources = new WeakMap<
      HTMLMediaElement,
      MediaElementAudioSourceNode
    >();
    const track = <T extends AudioNode>(node: T): T => {
      const targets = new Set<AudioNode>();
      edges.set(node, targets);
      const connect = node.connect.bind(node);
      const disconnect = node.disconnect.bind(node);
      node.connect = ((...args: any[]) => {
        const result = (connect as any)(...args);
        targets.add(args[0]);
        return result;
      }) as typeof node.connect;
      node.disconnect = ((...args: any[]) => {
        const result = (disconnect as any)(...args);
        if (args.length) targets.delete(args[0]);
        else targets.clear();
        return result;
      }) as typeof node.disconnect;
      return node;
    };
    const gain = context.createGain.bind(context);
    context.createGain = () => track(gain());
    const mediaSource = context.createMediaElementSource.bind(context);
    context.createMediaElementSource = (media) => {
      const source = track(mediaSource(media));
      sources.set(media, source);
      return source;
    };
    const media = document.querySelector('video')!;
    const source = context.createMediaElementSource(media);
    const rawTap = context.createGain();
    source.connect(rawTap);
    rawTap.connect(context.destination);
    const graph = fixture.initializeAudioGraph(context, source);
    (window as any).retirementFixture = {
      fixture,
      context,
      media,
      source,
      rawTap,
      graph,
      edges,
      sources,
    };
  });
}

test('retiring active audio inserts preserves raw taps and late releases cannot reconnect an old bus', async ({
  page,
}) => {
  await retirementFixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).retirementFixture;
    const inserts = Array.from({ length: 3 }, () => f.context.createGain());
    const releases = [
      f.graph.insertMain(inserts[0], inserts[0]),
      f.graph.insertDry(inserts[1], inserts[1]),
      f.graph.insertMaster(inserts[2], inserts[2]),
    ];
    const activeBefore = inserts.map((node) => f.edges.get(node).size);
    f.fixture.retireAudioGraph(f.graph);
    const retiredBus = [
      ...inserts,
      f.graph.dryInput,
      f.graph.masterInput,
      f.graph.outputInput,
      f.graph.musicGate,
    ];
    // A reused video retains its native source, but owns fresh renderer buses.
    const next = f.fixture.initializeAudioGraph(f.context, f.source);
    for (const release of releases) {
      release();
      release();
    }
    f.fixture.retireAudioGraph(f.graph);
    const result = {
      activeBefore,
      retiredEdges: retiredBus.map((node) => f.edges.get(node).size),
      sourceTargets: f.edges.get(f.source).size,
      preservedRawTap: f.edges.get(f.source).has(f.rawTap),
      preservedNewDry: f.edges.get(f.source).has(next.dryInput),
      preservedRawOutput: f.edges.get(f.rawTap).has(f.context.destination),
      currentIsNext: f.fixture.getCurrentAudioGraph() === next,
      contextOpen: f.context.state !== 'closed',
    };
    f.fixture.retireAudioGraph(next);
    await f.context.close();
    return result;
  });
  expect(result).toEqual({
    activeBefore: [1, 1, 1],
    retiredEdges: [0, 0, 0, 0, 0, 0, 0],
    sourceTargets: 2,
    preservedRawTap: true,
    preservedNewDry: true,
    preservedRawOutput: true,
    currentIsNext: true,
    contextOpen: true,
  });
});

test('an insert release still detaches its private route when restoring dry audio throws', async ({
  page,
}) => {
  await retirementFixture(page);
  const result = await page.evaluate(async () => {
    const f = (window as any).retirementFixture;
    const insert = f.context.createGain();
    const release = f.graph.insertMain(insert, insert);
    const connect = f.source.connect.bind(f.source);
    f.source.connect = (...args: any[]) => {
      if (args[0] === f.graph.dryInput)
        throw new Error('Native dry route restoration failed');
      return connect(...args);
    };
    let message = '';
    try {
      release();
    } catch (error) {
      message = (error as Error).message;
    }
    const afterRelease = {
      privateInputConnected: f.edges.get(f.source).has(insert),
      privateOutputEdges: f.edges.get(insert).size,
    };
    // Cleanup failure must not orphan ownership or remove unrelated raw taps.
    f.fixture.retireAudioGraph(f.graph);
    release();
    const result = {
      message,
      afterRelease,
      afterRetirement: {
        privateInputConnected: f.edges.get(f.source).has(insert),
        privateOutputEdges: f.edges.get(insert).size,
      },
      preservedRawTap: f.edges.get(f.source).has(f.rawTap),
      preservedRawOutput: f.edges.get(f.rawTap).has(f.context.destination),
    };
    await f.context.close();
    return result;
  });
  expect(result).toEqual({
    message: 'Native dry route restoration failed',
    afterRelease: { privateInputConnected: false, privateOutputEdges: 0 },
    afterRetirement: { privateInputConnected: false, privateOutputEdges: 0 },
    preservedRawTap: true,
    preservedRawOutput: true,
  });
});

for (const retireDuring of ['admission', 'source-connect', 'output-connect']) {
  test(`audio graph retirement removes active auxiliary audio and fences in-flight ${retireDuring}`, async ({
    page,
  }) => {
    await retirementFixture(page);
    const result = await page.evaluate(async (retireDuring) => {
      const f = (window as any).retirementFixture;
      const activeMedia = document.createElement('audio');
      const pendingMedia = document.createElement('audio');
      const activeGain = f.context.createGain();
      const pendingGain = f.context.createGain();
      const releaseActive = f.graph.registerMedia(activeMedia, activeGain);
      const countBefore = f.graph.auxiliaryMediaCount;
      const retire = () => f.fixture.retireAudioGraph(f.graph);
      if (retireDuring === 'source-connect') {
        const create = f.context.createMediaElementSource.bind(f.context);
        f.context.createMediaElementSource = (media: HTMLMediaElement) => {
          const source = create(media);
          if (media === pendingMedia) {
            const connect = source.connect.bind(source);
            source.connect = (...args: any[]) => {
              const result = connect(...args);
              retire();
              return result;
            };
          }
          return source;
        };
      } else if (retireDuring === 'output-connect') {
        const connect = pendingGain.connect.bind(pendingGain);
        pendingGain.connect = (...args: any[]) => {
          const result = connect(...args);
          retire();
          return result;
        };
      }
      let releasePending: (() => void) | undefined;
      const returnedRelease = f.graph.registerMedia(
        pendingMedia,
        pendingGain,
        undefined,
        {
          publishDispose(dispose: () => void) {
            releasePending = dispose;
            if (retireDuring === 'admission') retire();
          },
          isCurrent: () => true,
        },
      );
      releaseActive();
      releasePending?.();
      returnedRelease();
      let rejectedNewMedia = false;
      try {
        f.graph.registerMedia(document.createElement('audio'));
      } catch {
        rejectedNewMedia = true;
      }
      const activeSource = f.sources.get(activeMedia);
      const pendingSource = f.sources.get(pendingMedia);
      const result = {
        countBefore,
        countAfter: f.graph.auxiliaryMediaCount,
        activeSourceEdges: f.edges.get(activeSource).size,
        pendingSourceEdges: pendingSource ? f.edges.get(pendingSource).size : 0,
        gainEdges: [activeGain, pendingGain].map(
          (node) => f.edges.get(node).size,
        ),
        mainOnlyKeepsRawTap:
          f.edges.get(f.source).size === 1 &&
          f.edges.get(f.source).has(f.rawTap),
        rejectedNewMedia,
        current: f.fixture.getCurrentAudioGraph(),
      };
      await f.context.close();
      return result;
    }, retireDuring);
    expect(result).toEqual({
      countBefore: 1,
      countAfter: 0,
      activeSourceEdges: 0,
      pendingSourceEdges: 0,
      gainEdges: [0, 0],
      mainOnlyKeepsRawTap: true,
      rejectedNewMedia: true,
      current: null,
    });
  });
}

for (const retirement of ['pagehide', 'owner-loss', 'new-owner']) {
  test(`synchronous audio readiness ${retirement} cannot resurrect a retired lifetime`, async ({
    page,
  }) => {
    await retirementFixture(page);
    const result = await page.evaluate(async (retirement) => {
      const f = (window as any).retirementFixture;
      Object.defineProperty(f.media, 'readyState', { get: () => 4 });
      let currentOwner = true;
      let announcements = 0;
      let next: any;
      const onReady = () => {
        announcements++;
        const replacement = document.createElement('video');
        Object.defineProperty(replacement, 'readyState', { get: () => 4 });
        f.media.replaceWith(replacement);
        if (retirement === 'pagehide')
          window.dispatchEvent(new Event('pagehide'));
        else {
          currentOwner = false;
          if (retirement === 'new-owner')
            next = f.fixture.initializeAudioGraph(
              f.context,
              f.context.createMediaElementSource(replacement),
            );
        }
      };
      document.addEventListener('peard:audio-can-play', onReady);
      const stop = f.fixture.observeAudioGraphLifetime(
        f.graph,
        () => currentOwner,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.body.append(document.createElement('div'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      stop();
      const result = {
        announcements,
        oldSourceOnlyKeepsRawTap:
          f.edges.get(f.source).size === 1 &&
          f.edges.get(f.source).has(f.rawTap),
        oldDestinationEdges: f.edges.get(f.graph.musicGate).size,
        currentIsExpected: f.fixture.getCurrentAudioGraph() === (next ?? null),
        contextOpen: f.context.state !== 'closed',
      };
      document.removeEventListener('peard:audio-can-play', onReady);
      if (next) f.fixture.retireAudioGraph(next);
      await f.context.close();
      return result;
    }, retirement);
    expect(result).toEqual({
      announcements: 1,
      oldSourceOnlyKeepsRawTap: true,
      oldDestinationEdges: 0,
      currentIsExpected: true,
      contextOpen: true,
    });
  });
}

// Run the actual renderer startup function with only its app/IPC boundaries
// isolated. Web Audio, shared routing, EQ and DOM event registration are real.
async function readinessFixture(
  page: import('@playwright/test').Page,
  ready: number,
  deferred = false,
  retireOnReady = false,
  retireOnData = false,
) {
  const renderer = await readFile(
    new URL('../src/renderer.ts', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
    'renderer.ts',
    renderer,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = source.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          [
            'languageDocumentActive',
            'isLanguageDocumentCurrent',
            'api',
            'firstDataLoaded',
            'repeatPreference',
            'playlistQueue',
            'disposeMusicActionsOwner',
            'disposeAudioAnnouncements',
            'audioAnnouncementGeneration',
          ].includes(declaration.name.text),
      ),
  );
  const pagehide = source.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(source) ===
        'window.addEventListener' &&
      statement.expression.arguments[0]?.getText(source) === "'pagehide'",
  );
  const startup = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'onApiLoaded',
  );
  if (!pagehide || !startup)
    throw new Error('Actual renderer startup not found');
  const bootstrap =
    stripTypeScriptTypes(
      [...declarations, pagehide, startup]
        .map((node) => node.getText(source))
        .join('\n'),
    ) +
    (retireOnData ? '\nfirstDataLoaded = true;' : '') +
    '\nreturn onApiLoaded;';
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(
    async ({ bootstrap, ready, deferred, retireOnReady, retireOnData }) => {
      const f = (window as any).EqualizerFixture;
      const contexts: AudioContext[] = [];
      const media: {
        element: HTMLVideoElement;
        state: number;
        listeners: Map<string, Set<unknown>>;
      }[] = [];
      const notifications: CustomEvent[] = [];
      const messages: string[] = [];
      const releases: (() => void)[] = [];
      let inserts = 0;
      const prepare = (element: HTMLVideoElement, state: number) => {
        const row = {
          element,
          state,
          listeners: new Map<string, Set<unknown>>(),
        };
        Object.defineProperty(element, 'readyState', { get: () => row.state });
        const add = element.addEventListener.bind(element);
        const remove = element.removeEventListener.bind(element);
        element.addEventListener = ((
          type: string,
          listener: any,
          options: any,
        ) => {
          if (type === 'loadstart' || type === 'canplaythrough') {
            const set = row.listeners.get(type) ?? new Set();
            set.add(listener);
            row.listeners.set(type, set);
          }
          add(type, listener, options);
        }) as any;
        element.removeEventListener = ((
          type: string,
          listener: any,
          options: any,
        ) => {
          row.listeners.get(type)?.delete(listener);
          remove(type, listener, options);
        }) as any;
        media.push(row);
        return row;
      };
      prepare(document.querySelector('video')!, ready);
      document.addEventListener('peard:audio-can-play', (event) => {
        notifications.push(event as CustomEvent);
        if (retireOnReady) window.dispatchEvent(new Event('pagehide'));
      });
      if (retireOnData)
        document.addEventListener('videodatachange', () =>
          window.dispatchEvent(new Event('pagehide')),
        );
      await f.plugin.renderer.start({
        getConfig: async () => ({
          ...f.plugin.config,
          enabled: true,
          schemaVersion: 3,
          profile: {
            mode: 'custom',
            preamp: 0,
            bands: [
              { id: 'saved', type: 'peaking', frequency: 1000, gain: 12, Q: 1 },
            ],
          },
        }),
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      Object.assign(window, {
        electronIs: {
          osx: () => false,
          windows: () => false,
          linux: () => false,
        },
        ipcRenderer: {
          on() {},
          send(channel: string) {
            messages.push(channel);
          },
        },
        mainConfig: { get: () => false },
      });
      const AsyncFunction = Object.getPrototypeOf(
        async function () {},
      ).constructor;
      const load = new AsyncFunction(
        'initializeAudioGraph',
        'observeAudioGraphLifetime',
        'createPlaylistQueueController',
        'createRepeatPreference',
        'publishMusicActionsOwner',
        'getAllLoadedRendererPlugins',
        'callOnPlayerApiReady',
        'retireLanguageRequests',
        bootstrap,
      )(
        (context: AudioContext, audio: MediaElementAudioSourceNode) => {
          contexts.push(context);
          const graph = f.initializeAudioGraph(context, audio);
          const insert = graph.insertMaster;
          graph.insertMaster = (...args: any[]) => {
            inserts++;
            return insert(...args);
          };
          return graph;
        },
        f.observeAudioGraphLifetime,
        () => ({ dispose() {} }),
        () => ({ dispose() {} }),
        () => () => {},
        () => (deferred ? { owned: { renderer: {} } } : {}),
        () => new Promise<void>((resolve) => releases.push(resolve)),
        () => {},
      );
      const owner = await load;
      const fixture = {
        media,
        contexts,
        notifications,
        releases,
        load: owner,
        pending: Promise.resolve(),
        start() {
          this.pending = owner();
        },
        emit(type: string, index = media.length - 1) {
          const row = media[index];
          if (type === 'canplaythrough') row.state = 4;
          row.element.dispatchEvent(new Event(type));
        },
        replace(state = 3) {
          const video = document.createElement('video');
          media[media.length - 1].element.replaceWith(video);
          prepare(video, state);
        },
        summary() {
          return {
            inserts,
            notifications: notifications.length,
            currentIsLast:
              f.getCurrentAudioGraph()?.audioContext === contexts.at(-1),
            firstLoadListeners: media[0].listeners.get('loadstart')?.size ?? 0,
            firstPendingListeners:
              media[0].listeners.get('canplaythrough')?.size ?? 0,
            loadListeners: media.map(
              (row) => row.listeners.get('loadstart')?.size ?? 0,
            ),
            dialogs: document.querySelectorAll('dialog').length,
            apiLoadedMessages: messages.filter(
              (channel) => channel === 'peard:player-api-loaded',
            ).length,
          };
        },
        async close() {
          f.plugin.renderer.stop();
          for (const context of contexts)
            if (context.state !== 'closed') await context.close();
        },
      };
      (window as any).readyFixture = fixture;
      // The current media load already started before renderer registration.
      fixture.emit('loadstart');
      fixture.start();
      if (!deferred) await fixture.pending;
    },
    { bootstrap, ready, deferred, retireOnReady, retireOnData },
  );
}

for (const ready of [2, 3]) {
  test(`shared audio readiness catches current load at readyState${ready} and applies saved EQ before panel`, async ({
    page,
  }) => {
    await readinessFixture(page, ready);
    const before = await page.evaluate(() =>
      (window as any).readyFixture.summary(),
    );
    expect(before).toMatchObject({ inserts: 0, notifications: 0, dialogs: 0 });
    await page.evaluate(() => {
      const f = (window as any).readyFixture;
      f.emit('canplaythrough');
      f.emit('playing');
    });
    expect(
      await page.evaluate(() => (window as any).readyFixture.summary()),
    ).toMatchObject({ inserts: 1, notifications: 1, dialogs: 0 });
    await page.evaluate(() => (window as any).readyFixture.close());
  });
}

test('shared audio readiness keeps initial-ready4 and later loads single without premature play announcements', async ({
  page,
}) => {
  await readinessFixture(page, 4);
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({ inserts: 1, notifications: 1 });
  await page.evaluate(() => {
    const f = (window as any).readyFixture;
    f.emit('canplaythrough');
    f.emit('play');
    f.emit('pause');
  });
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({ inserts: 1, notifications: 1 });
  await page.evaluate(() => {
    const f = (window as any).readyFixture;
    f.emit('loadstart');
    f.emit('loadstart');
    f.emit('canplaythrough');
  });
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({ inserts: 1, notifications: 2 });
  await page.evaluate(() => (window as any).readyFixture.close());
});

test('shared audio readiness replaces the renderer owner and removes old pending listeners', async ({
  page,
}) => {
  await readinessFixture(page, 3);
  await page.evaluate(async () => {
    const f = (window as any).readyFixture;
    f.emit('loadstart');
    f.replace();
    await f.load();
  });
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({ firstLoadListeners: 0, firstPendingListeners: 0 });
  await page.evaluate(() => {
    const f = (window as any).readyFixture;
    f.emit('canplaythrough', 0);
    f.emit('canplaythrough');
  });
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({ inserts: 1, notifications: 1, currentIsLast: true });
  await page.evaluate(() => (window as any).readyFixture.close());
});

for (const retirement of ['closed', 'detached', 'new-owner', 'pagehide']) {
  test(`shared audio readiness rejects pending ${retirement} announcements`, async ({
    page,
  }) => {
    await readinessFixture(page, 3);
    await page.evaluate(async (retirement) => {
      const f = (window as any).readyFixture;
      f.emit('loadstart');
      if (retirement === 'closed') {
        const context = f.contexts[0];
        const state = new Promise<void>((resolve) =>
          context.addEventListener('statechange', () => {
            if (context.state === 'closed') resolve();
          }),
        );
        await context.close();
        await state;
      } else if (retirement === 'pagehide')
        window.dispatchEvent(new Event('pagehide'));
      else {
        f.replace();
        if (retirement === 'new-owner') {
          const fixture = (window as any).EqualizerFixture,
            context = new AudioContext();
          f.contexts.push(context);
          fixture.initializeAudioGraph(
            context,
            context.createMediaElementSource(f.media[1].element),
          );
        }
      }
      f.emit('canplaythrough', 0);
    }, retirement);
    expect(
      await page.evaluate(() => (window as any).readyFixture.summary()),
    ).toMatchObject({ inserts: 0, notifications: 0 });
    await page.evaluate(() => (window as any).readyFixture.close());
  });
}

test('shared audio readiness does not bind after pagehide during awaited player callbacks', async ({
  page,
}) => {
  await readinessFixture(page, 3, true);
  await page.evaluate(async () => {
    const f = (window as any).readyFixture;
    window.dispatchEvent(new Event('pagehide'));
    f.releases.shift()();
    await f.pending;
    f.emit('loadstart');
    f.emit('canplaythrough');
  });
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({
    inserts: 0,
    notifications: 0,
    firstLoadListeners: 0,
    firstPendingListeners: 0,
  });
  await page.evaluate(() => (window as any).readyFixture.close());
});

test('shared audio readiness keeps the newest disposer when older player callbacks finish last', async ({
  page,
}) => {
  await readinessFixture(page, 3, true);
  const listeners = await page.evaluate(async () => {
    const f = (window as any).readyFixture;
    f.replace();
    const second = f.load();
    f.releases[1]();
    await second;
    f.releases[0]();
    await f.pending;
    f.replace();
    const third = f.load();
    const listeners = f.summary().loadListeners;
    f.releases[2]();
    await third;
    await f.close();
    return listeners;
  });
  expect(listeners).toEqual([0, 0, 0]);
});

test('shared audio readiness retirement during immediate announcement stops later startup publication', async ({
  page,
}) => {
  await readinessFixture(page, 4, false, true);
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({
    notifications: 1,
    firstLoadListeners: 0,
    firstPendingListeners: 0,
    apiLoadedMessages: 0,
  });
  await page.evaluate(() => (window as any).readyFixture.close());
});

test('shared audio readiness cannot announce after a reentrant data-loaded retirement', async ({
  page,
}) => {
  await readinessFixture(page, 4, false, false, true);
  expect(
    await page.evaluate(() => (window as any).readyFixture.summary()),
  ).toMatchObject({
    inserts: 0,
    notifications: 0,
    apiLoadedMessages: 0,
    firstLoadListeners: 0,
    firstPendingListeners: 0,
  });
  await page.evaluate(() => (window as any).readyFixture.close());
});

test('a repeated start releases the previous insert so a subsequent stop restores dry unity', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const sample = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    fixture.initializeAudioGraph(context, source);
    const config = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: { mode: 'custom', preamp: -6, bands: [] },
    };
    const ctx = {
      getConfig: async () => config,
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    };
    await fixture.plugin.renderer.start(ctx);
    await fixture.plugin.renderer.start(ctx);
    fixture.plugin.renderer.stop();
    source.start();
    return (await context.startRendering()).getChannelData(0)[3000];
  });
  expect(sample).toBeCloseTo(0.2, 5);
});

test('an enabled zero-gain EQ preserves unity instead of summing a parallel dry copy', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const value = await page.evaluate(async () => {
    const plugin = (window as any).EqualizerFixture.plugin;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    const graph = (window as any).EqualizerFixture.initializeAudioGraph(
      context,
      source,
    );
    await plugin.renderer.start({
      getConfig: async () => ({
        enabled: true,
        filters: [{ type: 'peaking', frequency: 1000, gain: 0, Q: 1 }],
        presets: { 'bass-booster': false },
      }),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: context,
          audioSource: source,
          audioGraph: graph,
        },
      }),
    );
    source.start();
    const output = await context.startRendering();
    plugin.renderer.stop();
    return output.getChannelData(0)[3000];
  });
  expect(value).toBeCloseTo(0.2, 5);
});

test('editor changes layouts, arbitrary bands and user presets without autosaving on open', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    (window as any).writes = [];
    await fixture.plugin.renderer.start({
      getConfig: async () => ({ ...fixture.plugin.config, enabled: true }),
      setConfig: async (value: unknown) => (window as any).writes.push(value),
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).writes.length)).toBe(0);
  await page
    .getByLabel('plugins.equalizer.editor.layout')
    .selectOption('graphic-20');
  await expect(page.locator('.eq-band')).toHaveCount(20);
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.use-custom' })
    .click();
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.add-band' })
    .click();
  await expect(page.locator('.eq-band')).toHaveCount(21);
  await page
    .getByLabel('plugins.equalizer.editor.preset-name')
    .fill('Owned test preset');
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.save' })
    .click();
  await expect(
    page.getByLabel('plugins.equalizer.editor.preset').locator('option'),
  ).toContainText(['Owned test preset']);
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.close' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});

for (const gain of [-12, 12])
  test(`live peaking ${gain} dB has the measured serial response with headroom`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle("export * from '@/providers/renderer-audio';"),
    );
    const amplitude = await page.evaluate(async (gain) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, 48000, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 48000, 48000);
      source.buffer
        .getChannelData(0)
        .forEach(
          (_, i, samples) =>
            (samples[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000)),
        );
      fixture.initializeAudioGraph(context, source);
      const config = {
        enabled: true,
        schemaVersion: 2,
        bypass: false,
        profile: {
          mode: 'custom',
          preamp: -6,
          bands: [{ id: 'peak', type: 'peaking', frequency: 1000, gain, Q: 1 }],
        },
        userPresets: [],
        rememberedProfiles: {},
      };
      await fixture.plugin.renderer.start({
        getConfig: async () => config,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      source.start();
      const output = await context.startRendering();
      fixture.plugin.renderer.stop();
      return Math.max(
        ...output.getChannelData(0).slice(30000, 40000).map(Math.abs),
      );
    }, gain);
    expect(amplitude).toBeCloseTo(0.1 * 10 ** ((gain - 6) / 20), 4);
  });

test('hot config edits and linear same-input replacement do not add a midpoint boost', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 48000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 48000, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    fixture.initializeAudioGraph(context, source);
    const config = {
      enabled: true,
      schemaVersion: 2,
      bypass: false,
      profile: { mode: 'custom', preamp: 0, bands: [] },
      userPresets: [],
      rememberedProfiles: {},
    };
    await fixture.plugin.renderer.start({
      getConfig: async () => config,
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.onConfigChange({
      ...config,
      profile: {
        ...config.profile,
        bands: [
          { id: 'identity', type: 'peaking', frequency: 1000, gain: 0, Q: 1 },
        ],
      },
    });
    source.start();
    const samples = (await context.startRendering()).getChannelData(0);
    fixture.plugin.renderer.stop();
    return { min: Math.min(...samples), max: Math.max(...samples) };
  });
  expect(result.min).toBeCloseTo(0.2, 5);
  expect(result.max).toBeCloseTo(0.2, 5);
});

for (const interrupted of [false, true])
  test(`flat playback-time handovers preserve unity${interrupted ? ' through interrupted suspended fades and bypass' : ''}`, async ({
    page,
  }) => {
    await fixturePage(
      page,
      await equalizerBundle(
        "export * from '@/providers/renderer-audio';export {flatProfile} from '@/plugins/equalizer/config';",
      ),
    );
    const result = await page.evaluate(async (interrupted) => {
      const fixture = (window as any).EqualizerFixture;
      const context = new OfflineAudioContext(1, 4800, 48000);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 4800, 48000);
      source.buffer.getChannelData(0).fill(0.2);
      fixture.initializeAudioGraph(context, source);
      const config = {
        ...fixture.plugin.config,
        enabled: true,
        schemaVersion: 2,
        bypass: false,
        profile: { mode: 'custom', preamp: 0, bands: [] },
      };
      await fixture.plugin.renderer.start({
        getConfig: async () => config,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      const first = context.suspend(0.01);
      const second = interrupted ? context.suspend(0.021) : null;
      const third = interrupted ? context.suspend(0.032) : null;
      source.start();
      const rendering = context.startRendering();
      await first;
      fixture.plugin.renderer.onConfigChange({
        ...config,
        profile: fixture.flatProfile('graphic-20'),
      });
      if (interrupted) await new Promise((resolve) => setTimeout(resolve, 90));
      await context.resume();
      if (second && third) {
        await second;
        fixture.plugin.renderer.onConfigChange({
          ...config,
          profile: fixture.flatProfile('graphic-8'),
        });
        fixture.plugin.renderer.onConfigChange(config);
        await new Promise((resolve) => setTimeout(resolve, 90));
        await context.resume();
        await third;
        fixture.plugin.renderer.onConfigChange({
          ...config,
          profile: fixture.flatProfile('graphic-14'),
        });
        fixture.plugin.renderer.onConfigChange({ ...config, bypass: true });
        await context.resume();
      }
      const samples = (await rendering).getChannelData(0);
      fixture.plugin.renderer.stop();
      return {
        finite: [...samples].every(Number.isFinite),
        min: Math.min(...samples),
        max: Math.max(...samples),
      };
    }, interrupted);
    expect(result.finite).toBe(true);
    expect(result.min).toBeCloseTo(0.2, 5);
    expect(result.max).toBeCloseTo(0.2, 5);
  });

test('hot compressor enable inserts the dry route instead of leaving an uncompressed copy', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export * from '@/providers/renderer-audio';export {default as compressor} from '@/plugins/audio-compressor';",
    ),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 48000, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 48000, 48000);
    source.buffer
      .getChannelData(0)
      .forEach(
        (_, i, values) =>
          (values[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 48000)),
      );
    let actualCompressor: DynamicsCompressorNode;
    const nativeCompressor = context.createDynamicsCompressor.bind(context);
    context.createDynamicsCompressor = () =>
      (actualCompressor = nativeCompressor());
    const detachArgs: number[] = [];
    const nativeDisconnect = source.disconnect.bind(source);
    source.disconnect = (...args: any[]) => {
      detachArgs.push(args.length);
      return (nativeDisconnect as any)(...args);
    };
    fixture.initializeAudioGraph(context, source);
    fixture.compressor.renderer.start();
    source.start();
    const samples = (await context.startRendering()).getChannelData(0);
    fixture.compressor.renderer.stop();
    const reference = new OfflineAudioContext(1, 48000, 48000);
    const tone = reference.createBufferSource();
    tone.buffer = source.buffer;
    const compressor = reference.createDynamicsCompressor();
    for (const key of [
      'threshold',
      'ratio',
      'knee',
      'attack',
      'release',
    ] as const)
      compressor[key].value = actualCompressor![key].value;
    tone.connect(compressor);
    compressor.connect(reference.destination);
    tone.start();
    const expected = (await reference.startRendering()).getChannelData(0);
    return {
      peak: Math.max(...samples.slice(30000).map(Math.abs)),
      reference: Math.max(...expected.slice(30000).map(Math.abs)),
      blanket: detachArgs.includes(0),
    };
  });
  expect(result.peak).toBeCloseTo(result.reference, 5);
  expect(result.peak).toBeGreaterThan(0);
  expect(result.blanket).toBe(false);
});

test('stop before config resolves and repeated hot enable preserve raw analyser taps', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 4800, 48000);
    source.buffer.getChannelData(0).fill(0.2);
    const analyser = context.createAnalyser();
    const silent = context.createGain();
    silent.gain.value = 0;
    analyser.connect(silent);
    silent.connect(context.destination);
    source.connect(analyser);
    fixture.initializeAudioGraph(context, source);
    let resolve!: (value: unknown) => void;
    const pending = fixture.plugin.renderer.start({
      getConfig: () => new Promise((done) => (resolve = done)),
      setConfig: async () => {},
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.stop();
    resolve(fixture.plugin.config);
    await pending;
    const raw = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: { mode: 'custom', preamp: 0, bands: [] },
    };
    for (let i = 0; i < 20; i++) {
      await fixture.plugin.renderer.start({
        getConfig: async () => raw,
        setConfig: async () => {},
        ipc: { on() {}, removeAllListeners() {} },
      });
      document.dispatchEvent(
        new CustomEvent('peard:audio-can-play', {
          detail: { audioContext: context, audioSource: source },
        }),
      );
      fixture.plugin.renderer.stop();
    }
    source.start();
    const suspended = context.suspend(0.05);
    const rendering = context.startRendering();
    await suspended;
    const tap = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(tap);
    await context.resume();
    const output = (await rendering).getChannelData(0);
    return { main: output[3000], tap: tap[tap.length - 1] };
  });
  expect(result.main).toBeCloseTo(0.2, 5);
  expect(result.tap).toBeCloseTo(0.2, 5);
});

test('a delayed settings echo cannot erase a later band edit before saving a preset', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle("export * from '@/providers/renderer-audio';"),
  );
  await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const context = new AudioContext();
    fixture.initializeAudioGraph(
      context,
      context.createMediaElementSource(document.querySelector('video')),
    );
    const raw = {
      ...fixture.plugin.config,
      enabled: true,
      schemaVersion: 2,
      profile: {
        mode: 'custom',
        preamp: 0,
        bands: [0, 1].map((i) => ({
          id: `band-${i}`,
          type: 'peaking',
          frequency: 500 + i * 500,
          gain: 0,
          Q: 1,
        })),
      },
    };
    (window as any).savedWrites = [];
    (window as any).initialConfig = raw;
    await fixture.plugin.renderer.start({
      getConfig: async () => raw,
      setConfig: (value: unknown) => {
        (window as any).savedWrites.push(value);
        if ((window as any).savedWrites.length === 1)
          return new Promise(
            (resolve) => ((window as any).resolveSave = resolve),
          );
      },
      ipc: { on() {}, removeAllListeners() {} },
    });
    fixture.plugin.renderer.openEditor();
  });
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(0)
    .fill('5');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(0)
    .press('Tab');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(1)
    .fill('6');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .nth(1)
    .press('Tab');
  await page.evaluate(() => {
    const fixture = (window as any).EqualizerFixture;
    fixture.plugin.renderer.onConfigChange({
      ...(window as any).initialConfig,
      ...(window as any).savedWrites[0],
    });
    (window as any).resolveSave();
  });
  await page
    .getByLabel('plugins.equalizer.editor.preset-name')
    .fill('Preserve both edits');
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.save' })
    .click();
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.close' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).savedWrites.at(-1)?.userPresets?.[0]?.profile.bands[1]
            .gain,
      ),
    )
    .toBe(6);
  await page.evaluate(() =>
    (window as any).EqualizerFixture.plugin.renderer.stop(),
  );
});
