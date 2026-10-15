import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';
import { musicRendererFixture } from './helpers/api-music-renderer';
import { musicServiceFixture } from './helpers/api-music-service';
import { musicHttpFixture } from './helpers/api-music-http';
import { home151, categoryButton } from './helpers/music-catalog-fixtures';

const videoId = 'v0000000000';
const watchNext = () => ({
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                title: '再生中',
                content: { musicQueueRenderer: {} },
              },
            },
            {
              tabRenderer: {
                title: 'Σχετικά',
                endpoint: {
                  browseEndpoint: {
                    browseId: 'MPTR_native-related',
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: {
                        pageType: 'MUSIC_PAGE_TYPE_TRACK_RELATED',
                      },
                    },
                  },
                },
              },
            },
            {
              tabRenderer: {
                title: '歌詞',
                endpoint: {
                  browseEndpoint: {
                    browseId: 'MPLY_native-lyrics',
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: {
                        pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS',
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  currentVideoEndpoint: { watchEndpoint: { videoId } },
});
const lyricPage = () => ({
  contents: {
    sectionListRenderer: {
      contents: [
        {
          musicDescriptionShelfRenderer: {
            description: {
              runs: [
                { text: 'Привіт, світе\n' },
                { text: 'Καλημέρα\n' },
                { text: 'こんにちは 🎵' },
              ],
            },
            footer: {
              simpleText: 'Source: Public fixture\n© Synthetic attribution',
            },
          },
        },
      ],
    },
  },
});
const expectedLyrics = {
  videoId,
  available: true,
  lyrics: 'Привіт, світе\nΚαλημέρα\nこんにちは 🎵',
  source: 'Source: Public fixture\n© Synthetic attribution',
};
const relatedPage = () => {
  const raw: any = home151();
  const section =
    raw.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content
      .sectionListRenderer;
  section.contents[1].musicCarouselShelfRenderer.contents[0] = structuredClone(
    section.contents[0].musicCarouselShelfRenderer.contents[0],
  );
  section.continuations = [
    { nextContinuationData: { continuation: 'private-related-next' } },
  ];
  return { contents: { sectionListRenderer: section } };
};
const binding = (epoch: string | null = null) => ({
  videoId,
  playbackEpoch: epoch,
});
const lyricsEnvelope = (epoch: string | null = null) => ({
  version: 1,
  binding: binding(epoch),
  lyrics: expectedLyrics,
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test('M1 literal multilingual lyrics semantic tabs timed lines unavailable and related151 preserve useful native shapes', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts');
  expect(typeof m.parseLyrics).toBe('function');
  expect(m.parseWatchNextTabs(watchNext(), videoId)).toEqual({
    lyrics: 'MPLY_native-lyrics',
    related: 'MPTR_native-related',
  });
  expect(m.parseLyrics(lyricPage())).toEqual({
    available: true,
    lyrics: expectedLyrics.lyrics,
    source: expectedLyrics.source,
  });
  expect(
    m.parseLyrics({
      contents: {
        messageRenderer: { text: { runs: [{ text: '歌詞は利用できません' }] } },
      },
    }),
  ).toEqual({ available: false, lyrics: null, source: null });
  expect(
    m.parseLyrics({
      contents: {
        sectionListRenderer: {
          contents: [
            {
              musicDescriptionShelfRenderer: {
                description: { simpleText: '' },
              },
            },
          ],
        },
      },
    }),
  ).toEqual({ available: false, lyrics: null, source: null });
  expect(
    m.parseLyrics({
      contents: {
        timedLyricsModel: {
          lyricsData: {
            timedLyricsData: [
              { lyricLine: 'Hello 🌍' },
              { lyricLine: 'Здравей\nсвят' },
            ],
          },
        },
      },
    }),
  ).toEqual({
    available: true,
    lyrics: 'Hello 🌍\nЗдравей\nсвят',
    source: null,
  });
  const source = m.parseRelated(relatedPage());
  expect(source.items).toHaveLength(151);
  expect(source.items[37]).toEqual(source.items[0]);
  expect(source.shelves).toEqual([
    { title: 'Shelf One', start: 0, count: 37 },
    { title: 'Shelf Two', start: 37, count: 65 },
    { title: 'Shelf Three', start: 102, count: 49 },
  ]);
  expect(source.continuation).toEqual({
    endpoint: 'browse',
    token: 'private-related-next',
  });
  expect(
    m.parseRelated({ contents: { sectionListRenderer: { contents: [] } } })
      .items,
  ).toEqual([]);
  expect(
    m.parseRelated({
      contents: { messageRenderer: { text: { simpleText: '沒有推薦' } } },
    }).items,
  ).toEqual([]);
  expect(
    m.parseRelated({
      continuationContents: {
        sectionListContinuation: relatedPage().contents.sectionListRenderer,
      },
    }).items,
  ).toHaveLength(151);
});

test('M1 strict metadata source budgets recipes selectors and envelope validation reject malformed ambiguity without getter coercion', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts');
  const s = await musicModuleSource(
    'src/plugins/api-server/backend/scheme/music.ts',
  );
  expect(typeof s.parseMusicLyricsInput).toBe('function');
  expect(s.parseMusicLyricsInput({ current: true })).toEqual({ current: true });
  expect(s.parseMusicRelatedInput({ videoId, limit: 100 })).toEqual({
    videoId,
    limit: 100,
  });
  for (const v of [
    {},
    { videoId, current: true },
    { current: false },
    { current: 1 },
    { videoId, params: 'raw' },
    { cursor: 'mcur_' + 'a'.repeat(43), videoId },
  ])
    expect(() => s.parseMusicLyricsInput(v)).toThrow();
  for (const q of [
    'current=false',
    'current=1',
    'videoId=' + videoId + '&videoId=' + videoId,
    'videoId=' + videoId + '&params=x',
  ])
    expect(() => s.parseMusicLyricsQuery(new URLSearchParams(q))).toThrow();
  expect(s.parseNativeLyricsMetadata(lyricsEnvelope())).toEqual(
    lyricsEnvelope(),
  );
  expect(() =>
    s.parseNativeLyricsMetadata({ ...lyricsEnvelope(), title: 'private' }),
  ).toThrow();
  expect(() => m.parseLyrics({})).toThrow();
  expect(() =>
    m.parseLyrics({ error: { code: 500 }, ...lyricPage() }),
  ).toThrow();
  const conflict = watchNext();
  conflict.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[1].tabRenderer.endpoint!.browseEndpoint.browseId =
    'MPLY_wrong';
  expect(() => m.parseWatchNextTabs(conflict, videoId)).toThrow();
  let reads = 0;
  const getter: any = {};
  Object.defineProperty(getter, 'contents', {
    enumerable: true,
    get() {
      reads++;
      return lyricPage().contents;
    },
  });
  expect(() => m.parseLyrics(getter)).toThrow();
  expect(reads).toBe(0);
  const cycle: any = lyricPage();
  cycle.cycle = cycle;
  expect(() => m.parseLyrics(cycle)).toThrow();
  expect(() =>
    m.parseLyrics({
      contents: {
        timedLyricsModel: {
          lyricsData: { timedLyricsData: [{ lyricLine: 12 }] },
        },
      },
    }),
  ).toThrow();
  const text = (v: string) => ({
    contents: {
      sectionListRenderer: {
        contents: [
          { musicDescriptionShelfRenderer: { description: { content: v } } },
        ],
      },
    },
  });
  expect(m.parseLyrics(text('a'.repeat(65536))).lyrics).toHaveLength(65536);
  expect(() => m.parseLyrics(text('a'.repeat(65537)))).toThrow();
  expect(() => m.parseLyrics(text('\ud800'))).toThrow();
});

test('M1 renderer two native stages hold one job and current ABA retires while explicit video reads zero playback', async () => {
  const f = await musicRendererFixture();
  try {
    let playbackReads = 0;
    const get = f.originalApi.getVideoData;
    f.originalApi.getVideoData = () => {
      playbackReads++;
      return get();
    };
    const explicit = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 15000,
    });
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0].url).toBe('/next');
    expect(f.fetches[0].data).toEqual({ videoId, isAudioOnly: true });
    f.setVideo('other000001');
    f.videoEvent();
    f.fetches[0].resolve(watchNext());
    await f.flush();
    expect(f.fetches).toHaveLength(2);
    expect(f.controller.stats().active).toBe(1);
    expect(f.fetches[1].data).toEqual({ browseId: 'MPLY_native-lyrics' });
    f.fetches[1].resolve(lyricPage());
    await f.flush();
    expect(f.result(explicit)).toEqual({ ok: true, value: lyricsEnvelope() });
    expect(playbackReads).toBe(1); // the explicitly emitted native event alone observes identity
    f.setVideo(videoId);
    f.videoEvent();
    const current = f.read(f.query(), {
      operation: 'related',
      target: { current: true },
      deadlineAt: Date.now() + 15000,
    });
    expect(f.fetches).toHaveLength(3);
    f.setVideo('other000001');
    f.videoEvent();
    f.setVideo(videoId);
    f.videoEvent();
    expect(f.result(current)).toBeUndefined();
    expect(f.controller.stats().active).toBe(1);
    f.fetches[2].resolve(watchNext());
    await f.flush();
    expect(f.fetches).toHaveLength(3);
    expect(f.result(current)).toEqual({ ok: false, reason: 'retired' });
  } finally {
    f.close();
  }
});

test('M1 service related100+51 replay remote category preserves one cache and explicit target performs zero probe', async () => {
  const f = await musicServiceFixture();
  try {
    expect(typeof f.service.related).toBe('function');
    f.setHold();
    const m = await musicModuleSource('src/providers/music-metadata.ts');
    const pending = f.service.related(f.other.token, { videoId, limit: 100 });
    await expect.poll(() => f.calls.length).toBe(1);
    expect(f.calls[0].input.operation).toBe('related');
    expect(f.calls[0].input.target).toEqual({ videoId });
    expect(f.calls[0].input.deadlineAt).toBe(f.calls[0].options.deadline);
    f.calls[0].resolve({
      version: 1,
      binding: binding(),
      source: m.parseRelated(relatedPage()),
    });
    const first = await pending;
    expect(first.videoId).toBe(videoId);
    expect(first.items).toHaveLength(100);
    const second = await f.service.related(f.other.token, {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.items).toHaveLength(51);
    expect(second.shelves).toEqual([
      { title: 'Shelf Two', start: 0, count: 2 },
      { title: 'Shelf Three', start: 2, count: 49 },
    ]);
    expect(
      await f.service.related(f.other.token, {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).toEqual(second);
    expect(f.calls).toHaveLength(1);
    const remote = f.service.related(f.other.token, {
      cursor: second.nextCursor,
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1].input).toEqual({
      operation: 'related-continuation',
      token: 'private-related-next',
      binding: binding(),
      deadlineAt: f.calls[1].options.deadline,
    });
    f.calls[1].resolve({
      version: 1,
      binding: binding(),
      source: m.parseRelated({
        continuationContents: {
          musicShelfContinuation: { contents: [], continuations: [] },
        },
      }),
    });
    expect((await remote).items).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('private-related');
  } finally {
    await f.close();
  }
});

test('M1 current cached remainder replay and nested category reference use minimal fresh probe and retire only affected episode', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const m = await musicModuleSource('src/providers/music-metadata.ts');
    const epoch = '1'.repeat(32) + ':' + '3'.repeat(32),
      nextEpoch = '1'.repeat(32) + ':' + '4'.repeat(32);
    const raw = relatedPage();
    raw.contents.sectionListRenderer.contents[0].musicCarouselShelfRenderer.contents[0] =
      categoryButton();
    const start = f.service.related(f.other.token, {
      current: true,
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(1);
    f.calls[0].resolve({
      version: 1,
      binding: binding(epoch),
      source: m.parseRelated(raw),
    });
    const page = await start;
    expect(page.items[0].reference).toMatch(/^mref_/);
    expect(JSON.stringify(page)).not.toContain('playbackEpoch');
    const remaining = f.service.related(f.other.token, {
      cursor: page.nextCursor,
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1].input.operation).toBe('metadata-current');
    await expect(
      f.service.related(f.other.token, { cursor: page.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'busy' });
    f.calls[1].resolve({ version: 1, binding: binding(epoch) });
    const rest = await remaining;
    expect(rest.items).toHaveLength(51);
    const replay = f.service.related(f.other.token, {
      cursor: page.nextCursor,
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(3);
    f.calls[2].resolve({ version: 1, binding: binding(epoch) });
    expect(await replay).toEqual(rest);
    const browse = f.service.browse(f.other.token, {
      target: { kind: 'reference', id: page.items[0].reference },
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(4);
    expect(f.calls[3].input.operation).toBe('metadata-current');
    f.calls[3].resolve({ version: 1, binding: binding(epoch) });
    await expect.poll(() => f.calls.length).toBe(5);
    expect(f.calls[4].input.expectedCurrent).toEqual(binding(epoch));
    f.calls[4].resolve(f.c.normalizeMusicSource(home151(), 'browse'));
    const nested = await browse;
    const nestedMore = f.service.browse(f.other.token, {
      cursor: nested.nextCursor,
      limit: 100,
    });
    await expect.poll(() => f.calls.length).toBe(6);
    f.calls[5].resolve({ version: 1, binding: binding(nextEpoch) });
    await expect(nestedMore).rejects.toMatchObject({ code: 'retired' });
    expect(f.service.stats().cursors).toBe(0);
    expect(f.service.stats().references).toBe(0);
  } finally {
    await f.close();
  }
});

test('M1 same total deadline forbids second dispatch and unabortable cancellation retains physical job', async () => {
  const f = await musicRendererFixture();
  try {
    const job = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 5,
    });
    expect(f.fetches).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    f.fetches[0].resolve(watchNext());
    await f.flush();
    expect(f.fetches).toHaveLength(1);
    expect(f.result(job)).toEqual({ ok: false, reason: 'timeout' });
    const canceled = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 15000,
    });
    f.emit('peard:music-cancel', { ...canceled, phase: 'read' });
    expect(f.result(canceled)).toBeUndefined();
    expect(f.controller.stats().active).toBe(1);
    f.fetches[1].resolve(watchNext());
    await f.flush();
    expect(f.fetches).toHaveLength(2);
    expect(f.result(canceled)).toEqual({ ok: false, reason: 'retired' });
    expect(f.controller.stats().active).toBe(0);
    const current = f.read(f.query(), {
      operation: 'lyrics',
      target: { current: true },
      deadlineAt: Date.now() + 15000,
    });
    const next = watchNext();
    next.currentVideoEndpoint.watchEndpoint.videoId = 'current0001';
    f.fetches[2].resolve(next);
    await f.flush();
    expect(f.fetches).toHaveLength(4);
    f.setVideo('other000001');
    f.videoEvent();
    f.setVideo('current0001');
    f.videoEvent();
    f.fetches[3].resolve(lyricPage());
    await f.flush();
    expect(f.result(current)).toEqual({ ok: false, reason: 'retired' });
  } finally {
    f.close();
  }
});

test('M1 real socket catalog-only lyrics current selection and strict body-free query denies before native reads', async () => {
  const f = await musicHttpFixture();
  try {
    f.setHold();
    const grant = await f.store.issue(
        'Catalog socket',
        'rest',
        f.service.resource,
        ['catalog.read'],
        () => true,
      ),
      headers = { authorization: 'Bearer ' + grant.token };
    const p = f.http(
      '/api/v1/music/song/lyrics?videoId=' + videoId,
      'GET',
      undefined,
      headers,
    );
    await expect.poll(() => f.calls.length).toBe(1);
    f.calls[0].resolve(lyricsEnvelope());
    const response = await p;
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expectedLyrics);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const epoch = '1'.repeat(32) + ':' + '3'.repeat(32);
    const c = f.http(
      '/api/v1/music/song/lyrics?current=true',
      'GET',
      undefined,
      headers,
    );
    await expect.poll(() => f.calls.length).toBe(2);
    f.calls[1].resolve(lyricsEnvelope(epoch));
    expect((await c).body).toEqual(expectedLyrics);
    for (const q of [
      'current=false',
      'current=1',
      'videoId=' + videoId + '&current=true',
      'video%49d=' + videoId,
      'videoId=' + videoId + '&videoId=' + videoId,
      'cursor=mcur_' + 'a'.repeat(43),
      'videoId=' + videoId + '&params=raw',
    ])
      expect(
        (
          await f.http(
            '/api/v1/music/song/lyrics?' + q,
            'GET',
            undefined,
            headers,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await f.http(
          '/api/v1/music/song/lyrics?videoId=' + videoId,
          'POST',
          '{}',
          headers,
        )
      ).status,
    ).toBe(405);
    const denied = await f.store.issue(
      'Playback socket',
      'rest',
      f.service.resource,
      ['playback.read'],
      () => true,
    );
    expect(
      (
        await f.http(
          '/api/v1/music/song/lyrics?current=true',
          'GET',
          undefined,
          { authorization: 'Bearer ' + denied.token },
        )
      ).status,
    ).toBe(403);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('M1 pinned elementRenderer timed lyricLine projection and native DTO guards reject accessors cycles and inherited selectors', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts'),
    s = await musicModuleSource(
      'src/plugins/api-server/backend/scheme/music.ts',
    );
  const raw = {
    contents: {
      elementRenderer: {
        newElement: {
          type: {
            componentType: {
              model: {
                timedLyricsModel: {
                  lyricsData: {
                    timedLyricsData: [
                      {
                        lyricLine: '♪ Hello 🌍',
                        cueRange: {
                          startTimeMilliseconds: '0',
                          endTimeMilliseconds: '1000',
                        },
                      },
                      {
                        lyricLine: 'Здравей\nсвят',
                        cueRange: {
                          startTimeMilliseconds: '1000',
                          endTimeMilliseconds: '2000',
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  expect(m.parseLyrics(raw)).toEqual({
    available: true,
    lyrics: '♪ Hello 🌍\nЗдравей\nсвят',
    source: null,
  });
  let reads = 0;
  const getter: any = { version: 1, binding: binding() };
  Object.defineProperty(getter, 'lyrics', {
    enumerable: true,
    get() {
      reads++;
      return expectedLyrics;
    },
  });
  expect(() => s.parseNativeLyricsMetadata(getter)).toThrow();
  expect(reads).toBe(0);
  const selector = Object.create({ videoId });
  expect(() => s.parseMusicLyricsInput(selector)).toThrow();
  const circular: any = lyricsEnvelope();
  circular.extra = circular;
  expect(() => s.parseNativeLyricsMetadata(circular)).toThrow();
});

test('M1 socket authorization wait consumes the authoritative native15s deadline rather than renewing at service admission', async () => {
  const f = await musicHttpFixture();
  try {
    f.authHold();
    f.setHold();
    const started = Date.now(),
      p = f.http(
        '/api/v1/music/song/lyrics?videoId=' + videoId,
        'GET',
        undefined,
        { authorization: 'Bearer ' + f.grant.token },
      );
    await new Promise((r) => setTimeout(r, 30));
    f.advance(1000);
    f.authRelease();
    await expect.poll(() => f.calls.length).toBe(1);
    expect(f.calls[0].input.deadlineAt).toBeLessThanOrEqual(started + 15025);
    expect(f.calls[0].input.deadlineAt).toBe(f.calls[0].options.deadline);
    f.calls[0].resolve(lyricsEnvelope());
    expect((await p).status).toBe(200);
  } finally {
    await f.close();
  }
});

test('M1 source work limits fallback recipe8192 and section wrapper boundary remain bounded without truncation', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts');
  const fallback = watchNext(),
    tabs: any[] =
      fallback.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
        .watchNextTabbedResultsRenderer.tabs;
  [tabs[1], tabs[2]] = [tabs[2], tabs[1]];
  delete tabs[1].tabRenderer.endpoint.browseEndpoint
    .browseEndpointContextSupportedConfigs;
  delete tabs[2].tabRenderer.endpoint.browseEndpoint
    .browseEndpointContextSupportedConfigs;
  tabs[1].tabRenderer.endpoint.browseEndpoint.browseId =
    'MPLY' + 'a'.repeat(8188);
  expect(m.parseWatchNextTabs(fallback, videoId).lyrics).toHaveLength(8192);
  tabs[1].tabRenderer.endpoint.browseEndpoint.browseId += 'a';
  expect(() => m.parseWatchNextTabs(fallback, videoId)).toThrow();
  const disabled = watchNext();
  const typed: any =
    disabled.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
      .watchNextTabbedResultsRenderer.tabs[2].tabRenderer;
  delete typed.endpoint.browseEndpoint.browseId;
  typed.disabled = true;
  expect(m.parseWatchNextTabs(disabled, videoId).lyrics).toBeNull();
  const unknown = watchNext();
  unknown.currentVideoEndpoint.watchEndpoint.videoId = 'other000001';
  expect(() => m.parseWatchNextTabs(unknown, videoId)).toThrow();
  const repeated = watchNext();
  repeated.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs.push(
    repeated.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
      .watchNextTabbedResultsRenderer.tabs[2],
  );
  expect(() => m.parseWatchNextTabs(repeated, videoId)).toThrow();
  const boundary: any = relatedPage();
  let decoration: any = 'literal leaf';
  for (let i = 0; i < 24; i++) decoration = { child: decoration };
  boundary.contents.sectionListRenderer.decoration = decoration;
  expect(m.parseRelated(boundary).items).toHaveLength(151);
  const wrapperOverflow = structuredClone(boundary);
  wrapperOverflow.contents.sectionListRenderer.decoration = {
    child: decoration,
  };
  expect(() => m.assertMetadataWorkBudget(wrapperOverflow)).not.toThrow();
  expect(m.parseRelated(wrapperOverflow).items).toHaveLength(151);
  const deep: any = lyricPage();
  let nesting: any = 'leaf';
  for (let i = 0; i < 33; i++) nesting = { child: nesting };
  deep.decoration = nesting;
  expect(() => m.parseLyrics(deep)).toThrow();
  const wide: any = lyricPage();
  wide.decoration = Array(100001).fill(0);
  expect(() => m.parseLyrics(wide)).toThrow();
  const prototype: any = Object.create({ contents: lyricPage().contents });
  expect(() => m.parseLyrics(prototype)).toThrow();
  const utf8 = {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            musicDescriptionShelfRenderer: {
              description: { simpleText: '界'.repeat(21845) + 'a' },
            },
          },
        ],
      },
    },
  };
  expect(m.parseLyrics(utf8).lyrics).toHaveLength(21846);
  utf8.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer.description.simpleText +=
    'a';
  expect(() => m.parseLyrics(utf8)).toThrow();
  const footer = lyricPage();
  footer.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer.footer.simpleText =
    '🎵'.repeat(512);
  expect(m.parseLyrics(footer).source).toHaveLength(1024);
  footer.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer.footer.simpleText +=
    'a';
  expect(() => m.parseLyrics(footer)).toThrow();
});

test('M1 source capture reentry current getter retirement and late canceled0getter preserve newer adopted source', async () => {
  const f = await musicRendererFixture();
  try {
    const first = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 15000,
    });
    const original = f.app.networkManager.fetch;
    let captures = 0,
      trigger = false;
    Object.defineProperty(f.app.networkManager, 'fetch', {
      configurable: true,
      get() {
        captures++;
        if (trigger) {
          trigger = false;
          f.app.networkManager = { fetch: original };
          f.controller.refresh();
        }
        return original;
      },
    });
    trigger = true;
    f.fetches[0].resolve(watchNext());
    await f.flush();
    expect(f.result(first)).toEqual({ ok: false, reason: 'retired' });
    expect(f.fetches).toHaveLength(1);
    const fresh = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 15000,
    });
    f.fetches[1].resolve(watchNext());
    await f.flush();
    f.fetches[2].resolve(lyricPage());
    await f.flush();
    expect(f.result(fresh)).toEqual({ ok: true, value: lyricsEnvelope() });
    const canceled = f.read(f.query(), {
      operation: 'lyrics',
      target: { videoId },
      deadlineAt: Date.now() + 15000,
    });
    f.emit('peard:music-cancel', { ...canceled, phase: 'read' });
    const before = captures;
    f.fetches[3].resolve(watchNext());
    await f.flush();
    expect(captures).toBe(before);
    expect(f.fetches).toHaveLength(4);
    f.setVideo(videoId);
    f.videoEvent();
    const getter = f.originalApi.getPlayerResponse;
    let armed = true;
    f.originalApi.getPlayerResponse = () => {
      const response = getter();
      if (armed) {
        armed = false;
        f.videoEvent();
      }
      return response;
    };
    const current = f.read(f.query(), {
      operation: 'lyrics',
      target: { current: true },
      deadlineAt: Date.now() + 15000,
    });
    await f.flush();
    expect(f.result(current)).toEqual({ ok: false, reason: 'retired' });
    expect(f.fetches).toHaveLength(4);
  } finally {
    f.close();
  }
});

test('M1 approved original SectionList depth32 entry preserves strict default catalog rejection and rejects native depth33 conflicts', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts'),
    c = await musicModuleSource('src/providers/music-catalog.ts');
  const raw: any = relatedPage();
  let deep: any = 'literal leaf';
  for (let n = 0; n < 29; n++) deep = { child: deep };
  raw.contents.sectionListRenderer.decoration = deep;
  expect(() => m.assertMetadataWorkBudget(raw)).not.toThrow();
  expect(m.parseRelated(raw).items).toHaveLength(151);
  expect(() => c.normalizeMusicSource(raw, 'browse')).toThrow(
    'Unsupported music service layout.',
  );
  const continuation = {
    continuationContents: {
      sectionListContinuation: raw.contents.sectionListRenderer,
    },
  };
  expect(m.parseRelated(continuation).items).toHaveLength(151);
  expect(() => c.normalizeMusicSource(continuation, 'browse')).toThrow();
  raw.contents.sectionListRenderer.decoration = { child: deep };
  expect(() => m.parseRelated(raw)).toThrow('Music response budget exceeded.');
  expect(() =>
    m.parseRelated({
      contents: { sectionListRenderer: { contents: [] } },
      continuationContents: { sectionListContinuation: { contents: [] } },
    }),
  ).toThrow();
  expect(() =>
    m.parseRelated({
      continuationContents: {
        sectionListContinuation: { contents: [] },
        musicShelfContinuation: { contents: [] },
      },
    }),
  ).toThrow();
});

test('M1 rejects inherited native array callbacks before executing provider prototype code', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts'),
    c = await musicModuleSource('src/providers/music-catalog.ts');
  const raw = watchNext(),
    tabs =
      raw.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
        .watchNextTabbedResultsRenderer.tabs;
  let visits = 0;
  const prototype = Object.create(Array.prototype);
  prototype.forEach = function (fn: any) {
    visits++;
    return Array.prototype.forEach.call(this, fn);
  };
  Object.setPrototypeOf(tabs, prototype);
  expect(() => m.parseWatchNextTabs(raw, videoId)).toThrow();
  expect(visits).toBe(0);
  const related = relatedPage(),
    rows = related.contents.sectionListRenderer.contents,
    iteratorPrototype = Object.create(Array.prototype);
  iteratorPrototype[Symbol.iterator] = function* () {
    visits++;
    yield* Array.prototype.values.call(this);
  };
  Object.setPrototypeOf(rows, iteratorPrototype);
  expect(() => c.normalizeRelatedMusicSource(related)).toThrow();
  expect(visits).toBe(0);
});

// MAIN M1-MAIN-01: holes must never resolve through inherited numeric getters.
test('M1 F2 rejects sparse own/inherited accessor runs timed tabs and native related arrays before any element read', async () => {
  const m = await musicModuleSource('src/providers/music-metadata.ts');
  const c = await musicModuleSource('src/providers/music-catalog.ts');
  const timedRows = [{ lyricLine: 'own 🎵' }, { lyricLine: '第二行' }];
  const timed = { contents: { elementRenderer: { newElement: { type: {
    componentType: { model: { timedLyricsModel: { lyricsData: { timedLyricsData: timedRows } } } },
  } } } } };
  const lyric = lyricPage();
  const next = watchNext();
  const tabs = next.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs;
  const direct = relatedPage();
  const carousel = relatedPage();
  const sectionContinuation = { continuationContents: { sectionListContinuation: relatedPage().contents.sectionListRenderer } };
  const shelfRows = [...relatedPage().contents.sectionListRenderer.contents[0].musicCarouselShelfRenderer.contents];
  const shelfContinuation = { continuationContents: { musicShelfContinuation: { contents: shelfRows, continuations: [] } } };
  const controls = [
    { name: 'lyrics runs', rows: lyric.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer.description.runs, read: () => m.parseLyrics(lyric) },
    { name: 'pinned timed data', rows: timedRows, read: () => m.parseLyrics(timed) },
    { name: 'watch tabs', rows: tabs, read: () => m.parseWatchNextTabs(next, videoId) },
    { name: 'direct related sections', rows: direct.contents.sectionListRenderer.contents, read: () => c.normalizeRelatedMusicSource(direct) },
    { name: 'related carousel rows', rows: carousel.contents.sectionListRenderer.contents[0].musicCarouselShelfRenderer.contents, read: () => c.normalizeRelatedMusicSource(carousel) },
    { name: 'section continuation', rows: sectionContinuation.continuationContents.sectionListContinuation.contents, read: () => c.normalizeRelatedMusicSource(sectionContinuation) },
    { name: 'shelf continuation rows', rows: shelfRows, read: () => c.normalizeRelatedMusicSource(shelfContinuation) },
  ];
  for (const control of controls) {
    for (const mode of ['hole', 'own', 'inherited'] as const) {
      const original = Object.getOwnPropertyDescriptor(control.rows, '1')!;
      const prototypeOriginal = Object.getOwnPropertyDescriptor(Array.prototype, '1');
      let calls = 0;
      let failure: any;
      let returned = false;
      const get = () => { calls++; return original.value; };
      try {
        delete (control.rows as any)[1];
        if (mode === 'own') Object.defineProperty(control.rows, '1', { enumerable: true, configurable: true, get });
        if (mode === 'inherited') Object.defineProperty(Array.prototype, '1', {
          configurable: true, get,
          set(value) { Object.defineProperty(this, '1', { value, writable: true, enumerable: true, configurable: true }); },
        });
        try { control.read(); returned = true; } catch (error) { failure = error; }
      } finally {
        if (prototypeOriginal) Object.defineProperty(Array.prototype, '1', prototypeOriginal);
        else delete (Array.prototype as any)[1];
        Object.defineProperty(control.rows, '1', original);
      }
      expect(returned, control.name + '/' + mode).toBe(false);
      expect(failure?.code, control.name + '/' + mode).toBe('source');
      expect(calls, control.name + '/' + mode).toBe(0);
      expect(Object.getOwnPropertyDescriptor(Array.prototype, '1')).toEqual(prototypeOriginal);
      expect(() => control.read(), control.name + ' healthy recovery').not.toThrow();
    }
  }
  expect(m.parseLyrics(lyric)).toEqual({ available: true, lyrics: 'Привіт, світе\nΚαλημέρα\nこんにちは 🎵', source: 'Source: Public fixture\n© Synthetic attribution' });
  expect(m.parseLyrics(timed)).toEqual({ available: true, lyrics: 'own 🎵\n第二行', source: null });
  expect(c.normalizeRelatedMusicSource(direct).items).toHaveLength(151);
  expect(() => c.normalizeMusicSource(direct, 'browse')).toThrow('Unsupported music service layout.');
});
