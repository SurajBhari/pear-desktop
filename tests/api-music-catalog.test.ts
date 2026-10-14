import { test, expect } from '@playwright/test';
import { musicCatalogSource } from './helpers/api-music-source';
import {
  artistId,
  albumId,
  videoId,
  home151,
  playlist1000,
  responsiveSong,
  twoRowBrowse,
  categoryButton,
  singleColumn,
  carousel,
  searchPage,
  continuationPage,
} from './helpers/music-catalog-fixtures';

async function fixture() {
  const source = await musicCatalogSource();
  expect(typeof source.normalizeMusicSource).toBe('function');
  return source;
}

test('supported151-item multi-shelf Home retains every recognized item with literal100+51 slices', async () => {
  const m = await fixture(),
    source = m.normalizeMusicSource(home151(), 'home');
  expect(source.items).toHaveLength(151);
  expect(source.items.map((item: any) => item.id)).toEqual(
    Array.from({ length: 151 }, (_, i) => videoId(i)),
  );
  expect(source.shelves.map((shelf: any) => shelf.title)).toEqual([
    'Shelf One',
    'Shelf Two',
    'Shelf Three',
  ]);
  const first = m.sliceMusicSource(source, 0, 100),
    second = m.sliceMusicSource(source, first.nextOffset, 100);
  expect(first.items).toHaveLength(100);
  expect(second.items).toHaveLength(51);
  expect(second.nextOffset).toBeNull();
  expect(JSON.stringify(source)).not.toContain(
    'synthetic-tracking-must-not-leave-parser',
  );
});
test('normal1000-row two-column playlist is accepted and duplicate order is retained', async () => {
  const m = await fixture(),
    source = m.normalizeMusicSource(playlist1000(), 'browse');
  expect(source.items).toHaveLength(1000);
  expect(source.items[0]).toMatchObject({
    kind: 'song',
    id: videoId(0),
    title: 'Fixture Track 0',
    artists: [{ id: artistId, name: 'Fixture Artist' }],
    durationSeconds: 210,
    album: { id: albumId, title: 'Fixture Album' },
  });
  expect(source.items[999].id).toBe(videoId(999));
  const duplicates = m.normalizeMusicSource(
    singleColumn([
      carousel([responsiveSong(0), responsiveSong(0), responsiveSong(1)]),
    ]),
    'browse',
  );
  expect(duplicates.items.map((item: any) => item.id)).toEqual([
    videoId(0),
    videoId(0),
    videoId(1),
  ]);
});
test('artist album playlist and service-owned category recipe use distinct validated identities', async () => {
  const m = await fixture();
  const source = m.normalizeMusicSource(
    singleColumn([
      carousel([
        twoRowBrowse('artist', artistId),
        twoRowBrowse('album', albumId),
        twoRowBrowse('playlist', 'PLfixture'),
        categoryButton(),
      ]),
    ]),
    'browse',
  );
  expect(source.items.map((item: any) => [item.kind, item.id])).toEqual([
    ['artist', artistId],
    ['album', albumId],
    ['playlist', 'PLfixture'],
    ['category', 'genres'],
  ]);
  expect(source.targetRecipes).toEqual([
    {
      itemIndex: 3,
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'synthetic-service-owned-params',
    },
  ]);
});
test('selected search and typed continuation envelopes preserve private continuation separately', async () => {
  const m = await fixture(),
    initial = m.normalizeMusicSource(searchPage(), 'search'),
    next = m.normalizeMusicSource(continuationPage(), 'search');
  expect(initial.items.map((item: any) => item.id)).toEqual([videoId(0)]);
  expect(initial.continuation).toEqual({
    endpoint: 'search',
    token: 'synthetic-service-continuation',
  });
  expect(next.items.map((item: any) => item.id)).toEqual([videoId(1)]);
  expect(next.continuation).toBeNull();
  const withInactive = searchPage();
  withInactive.contents.tabbedSearchResultsRenderer.tabs.push({
    tabRenderer: {
      selected: false,
      content: {
        sectionListRenderer: { contents: [carousel([responsiveSong(99)])] },
      },
    },
  } as any);
  expect(
    m
      .normalizeMusicSource(withInactive, 'search')
      .items.map((item: any) => item.id),
  ).toEqual([videoId(0)]);
});
test('verified empty differs from unknown layout and malformed recognized rows fail explicitly', async () => {
  const m = await fixture();
  expect(
    m.normalizeMusicSource(singleColumn([carousel([])]), 'browse').items,
  ).toEqual([]);
  for (const value of [
    {},
    [],
    { contents: { unknownRenderer: {} } },
    singleColumn([carousel([{ musicResponsiveListItemRenderer: {} }])]),
  ])
    expect(() => m.normalizeMusicSource(value, 'browse')).toThrow();
});
test('boxed coercing getter and cyclic provider values cannot be evaluated or silently become data', async () => {
  const m = await fixture();
  let called = 0;
  const row: any = responsiveSong(0);
  Object.defineProperty(row.musicResponsiveListItemRenderer, 'flexColumns', {
    get() {
      called++;
      return [];
    },
  });
  expect(() =>
    m.normalizeMusicSource(singleColumn([carousel([row])]), 'browse'),
  ).toThrow();
  expect(called).toBe(0);
  const cycle: any = {};
  cycle.contents = cycle;
  expect(() => m.normalizeMusicSource(cycle, 'browse')).toThrow();
  const boxed: any = responsiveSong(0);
  boxed.musicResponsiveListItemRenderer.playlistItemData.videoId = new String(
    videoId(0),
  );
  expect(() =>
    m.normalizeMusicSource(singleColumn([carousel([boxed])]), 'browse'),
  ).toThrow();
});
test('true source item/depth/work budgets reject without truncation and oversized text is not clipped', async () => {
  const m = await fixture();
  expect(() =>
    m.normalizeMusicSource(
      singleColumn([
        carousel(Array.from({ length: 2049 }, (_, i) => responsiveSong(i))),
      ]),
      'browse',
    ),
  ).toThrow();
  const row = responsiveSong(0);
  row.musicResponsiveListItemRenderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text =
    'x'.repeat(513);
  expect(() =>
    m.normalizeMusicSource(singleColumn([carousel([row])]), 'browse'),
  ).toThrow();
  let deep: any = responsiveSong(0);
  for (let i = 0; i < 33; i++) deep = { nested: deep };
  expect(() =>
    m.normalizeMusicSource(singleColumn([carousel([deep])]), 'browse'),
  ).toThrow();
});

test('ordinary Explore navigation buttons remain typed and keep parameters in private recipes', async () => {
  const m = await fixture();
  const ids = [
    'FEmusic_explore',
    'FEmusic_charts',
    'FEmusic_moods_and_genres',
    'FEmusic_new_releases_albums',
  ];
  const rows = ids.map((id) => {
    const row = categoryButton(id);
    row.musicNavigationButtonRenderer.clickCommand.browseEndpoint.browseId = id;
    return row;
  });
  const source = m.normalizeMusicSource(
    singleColumn([{ gridRenderer: { items: rows } }]),
    'browse',
  );
  expect(source.items.map((item: any) => item.id)).toEqual([
    'explore',
    'charts',
    'genres',
    'new-releases',
  ]);
  expect(source.targetRecipes.map((recipe: any) => recipe.browseId)).toEqual(
    ids,
  );
});
test('title-linked library playlist identity is supported when row endpoint is absent', async () => {
  const m = await fixture(),
    playlist: any = twoRowBrowse('playlist', 'PLfixture');
  delete playlist.musicTwoRowItemRenderer.navigationEndpoint;
  expect(
    m.normalizeMusicSource(singleColumn([carousel([playlist])]), 'library')
      .items[0],
  ).toMatchObject({ kind: 'playlist', id: 'PLfixture' });
});
test('known native video type remains video rather than being relabeled song', async () => {
  const m = await fixture();
  const video = responsiveSong(0);
  video.musicResponsiveListItemRenderer.navigationEndpoint.watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType =
    'MUSIC_VIDEO_TYPE_UGC';
  video.musicResponsiveListItemRenderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].navigationEndpoint.watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType =
    'MUSIC_VIDEO_TYPE_UGC';
  expect(
    m.normalizeMusicSource(singleColumn([carousel([video])]), 'search').items[0]
      .kind,
  ).toBe('video');
});
test('conflicting title and row identities reject rather than silently choosing one', async () => {
  const m = await fixture();
  const conflict = twoRowBrowse('playlist', 'PLfixture');
  conflict.musicTwoRowItemRenderer.title.runs[0].navigationEndpoint =
    structuredClone(conflict.musicTwoRowItemRenderer.navigationEndpoint);
  conflict.musicTwoRowItemRenderer.title.runs[0].navigationEndpoint.browseEndpoint.browseId =
    'VLPLdifferent';
  expect(() =>
    m.normalizeMusicSource(singleColumn([carousel([conflict])]), 'browse'),
  ).toThrow();
});
test('proxy-thrown error codes and private exceptions never escape the fixed local source error', async () => {
  const m = await fixture(),
    privateValue = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw { code: 'private-code', message: 'synthetic-private-message' };
        },
      },
    );
  let caught: any;
  try {
    m.normalizeMusicSource(privateValue, 'browse');
  } catch (error) {
    caught = error;
  }
  expect(caught.message).toBe('Invalid music service response.');
  expect(caught.code).toBe('source');
});

test('page byte paging includes every intersecting shelf label and preserves remaining items', async () => {
  const m = await fixture(),
    items = Array.from({ length: 64 }, (_, i) => ({
      kind: 'song',
      id: videoId(i),
      title: '🎵'.repeat(512),
      artists: [{ name: '🎵'.repeat(256) }],
      durationSeconds: null,
    }));
  const source = {
    version: 1,
    items,
    shelves: items.map((_, i) => ({
      title: '🎵'.repeat(512),
      start: i,
      count: 1,
    })),
    continuation: null,
    targetRecipes: [],
  };
  const first = m.sliceMusicSource(source, 0, 100);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    256 * 1024,
  );
  expect(first.items.length).toBeLessThan(64);
  const second = m.sliceMusicSource(source, first.nextOffset, 100);
  expect([...first.items, ...second.items].map((item: any) => item.id)).toEqual(
    items.map((item) => item.id),
  );
});

test('ordinary all-search primary music card shelf preserves its verified item and every recognized secondary row', async () => {
  const m = await fixture(),
    primary = twoRowBrowse('artist', artistId).musicTwoRowItemRenderer;
  const card = {
    musicCardShelfRenderer: {
      ...primary,
      onTap: primary.navigationEndpoint,
      contents: [responsiveSong(0), responsiveSong(1)],
    },
  };
  delete (card.musicCardShelfRenderer as any).navigationEndpoint;
  const source = m.normalizeMusicSource(singleColumn([card as any]), 'search');
  expect(source.items.map((i: any) => i.id)).toEqual([
    artistId,
    videoId(0),
    videoId(1),
  ]);
});

test('decoded known label recipe and hidden-property budgets reject before oversized trim join or encoding work', async () => {
  const m = await fixture();
  const originalTrim = String.prototype.trim,
    originalJoin = Array.prototype.join,
    originalEncode = TextEncoder.prototype.encode;
  let trim = 0,
    join = 0,
    encode = 0;
  const marker = 'KNOWN_BUDGET_MARKER';
  String.prototype.trim = function () {
    if (this.length > 1024) trim++;
    return originalTrim.call(this);
  };
  Array.prototype.join = function (separator?: string) {
    if (
      this.some(
        (v: any) =>
          typeof v === 'string' && v.length > 1024 && v.startsWith(marker),
      )
    )
      join++;
    return originalJoin.call(this, separator);
  };
  TextEncoder.prototype.encode = function (value?: string) {
    if (value?.startsWith(marker) && value.length > 8192) encode++;
    return originalEncode.call(this, value);
  };
  try {
    const row = responsiveSong(0);
    row.musicResponsiveListItemRenderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text =
      marker + 'x'.repeat(10000);
    expect(() =>
      m.normalizeMusicSource(singleColumn([carousel([row])]), 'browse'),
    ).toThrow();
    const button = categoryButton();
    button.musicNavigationButtonRenderer.clickCommand.browseEndpoint.params =
      marker + 'x'.repeat(10000);
    expect(() =>
      m.normalizeMusicSource(
        singleColumn([{ gridRenderer: { items: [button] } }]),
        'browse',
      ),
    ).toThrow();
    expect({ trim, join, encode }).toEqual({ trim: 0, join: 0, encode: 0 });
  } finally {
    String.prototype.trim = originalTrim;
    Array.prototype.join = originalJoin;
    TextEncoder.prototype.encode = originalEncode;
  }
  const hidden = home151();
  Object.defineProperty(hidden, 'unvisited', {
    value: new Array(100001).fill(null),
    enumerable: false,
  });
  expect(() => m.normalizeMusicSource(hidden, 'home')).toThrow();
});
// C1 fixture acceptance retains the unchanged public parser and bounded layouts.
test('collection title-linked duplicates and verified empty stay truthful before main library projection', async () => {
  const m = await fixture();
  const titleOnly: any = twoRowBrowse('playlist', 'PLcollection');
  delete titleOnly.musicTwoRowItemRenderer.navigationEndpoint;
  const normalized = m.normalizeMusicSource(
    singleColumn([
      carousel([titleOnly, titleOnly, responsiveSong(0)], 'Collections'),
    ]),
    'library',
  );
  expect(normalized.items.map((i: any) => [i.kind, i.id])).toEqual([
    ['playlist', 'PLcollection'],
    ['playlist', 'PLcollection'],
    ['song', videoId(0)],
  ]);
  expect(normalized.shelves).toEqual([
    { title: 'Collections', start: 0, count: 3 },
  ]);
  for (const route of ['home', 'library']) {
    expect(
      m.normalizeMusicSource(singleColumn([carousel([])]), route).items,
    ).toEqual([]);
    expect(() =>
      m.normalizeMusicSource({ contents: { unknownRenderer: {} } }, route),
    ).toThrow('Unsupported music service layout.');
    expect(() =>
      m.normalizeMusicSource(
        singleColumn([carousel([{ musicTwoRowItemRenderer: {} }])]),
        route,
      ),
    ).toThrow();
  }
});
