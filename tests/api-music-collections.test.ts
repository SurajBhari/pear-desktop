import { test, expect } from '@playwright/test';
import { musicServiceFixture } from './helpers/api-music-service';
import { musicRendererFixture } from './helpers/api-music-renderer';
import { musicModuleSource } from './helpers/api-music-source';
import {
  home151,
  singleColumn,
  carousel,
  responsiveSong,
  twoRowBrowse,
  categoryButton,
  videoId,
} from './helpers/music-catalog-fixtures';

const collectionGrant = (
  f: any,
  scopes = ['personalized.read', 'library.read', 'catalog.read'],
) =>
  f.store.issue(
    'Owned collection reader',
    'rest',
    f.service.resource,
    scopes,
    () => true,
  );
function homeWithContinuation() {
  const raw: any = home151();
  raw.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.continuations =
    [{ nextContinuationData: { continuation: 'private-home-next' } }];
  // A duplicate is intentional: Home preserves source order rather than unique IDs.
  raw.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[1].musicCarouselShelfRenderer.contents[0] =
    responsiveSong(0);
  return raw;
}
function playlist(id: string, title = 'First ' + id, titleOnly = false) {
  const row: any = twoRowBrowse('playlist', id);
  row.musicTwoRowItemRenderer.title.runs[0].text = title;
  if (titleOnly) delete row.musicTwoRowItemRenderer.navigationEndpoint;
  return row;
}
function remote(rows: any[], continuation?: string) {
  return {
    continuationContents: {
      musicShelfContinuation: {
        contents: rows,
        continuations: continuation
          ? [{ nextContinuationData: { continuation } }]
          : [],
      },
    },
  };
}

test('Home151 keeps duplicate order literal shelves100+51 before exactly one explicit remote page', async () => {
  const f = await musicServiceFixture();
  try {
    expect(typeof f.service.home).toBe('function');
    const grant = await collectionGrant(f, ['personalized.read']);
    f.setHold();
    const pending = f.service.home(grant.token, { limit: 100 });
    await expect.poll(() => f.calls.length).toBe(1);
    expect(f.calls[0].input).toEqual({ operation: 'home' });
    f.calls[0].resolve(
      f.c.normalizeMusicSource(homeWithContinuation(), 'home'),
    );
    const first = await pending;
    expect(first.items).toHaveLength(100);
    expect(first.items[37].id).toBe(videoId(0));
    expect(first.shelves).toEqual([
      { title: 'Shelf One', start: 0, count: 37 },
      { title: 'Shelf Two', start: 37, count: 63 },
    ]);
    const second = await f.service.home(grant.token, {
      limit: 100,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(51);
    expect(second.shelves).toEqual([
      { title: 'Shelf Two', start: 0, count: 2 },
      { title: 'Shelf Three', start: 2, count: 49 },
    ]);
    expect(
      await f.service.home(grant.token, {
        limit: 100,
        cursor: first.nextCursor,
      }),
    ).toEqual(second);
    expect(f.calls).toHaveLength(1);
    const thirdPromise = f.service.home(grant.token, {
      limit: 100,
      cursor: second.nextCursor,
    });
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1].input).toEqual({
      operation: 'continuation',
      endpoint: 'browse',
      token: 'private-home-next',
    });
    f.calls[1].resolve(
      f.c.normalizeMusicSource(remote([responsiveSong(152)]), 'browse'),
    );
    expect((await thirdPromise).items.map((i: any) => i.id)).toEqual([
      videoId(152),
    ]);
    expect(JSON.stringify([first, second])).not.toContain('private-home-next');
  } finally {
    await f.close();
  }
});

test('library title-linked first IDs dedup before local slicing and remote duplicate-only pages never prefetch', async () => {
  const f = await musicServiceFixture();
  try {
    expect(typeof f.service.library).toBe('function');
    const grant = await collectionGrant(f, ['library.read']);
    f.setHold();
    const initial = f.service.library(grant.token, { limit: 100 });
    await expect.poll(() => f.calls.length).toBe(1);
    expect(f.calls[0].input).toEqual({ operation: 'library' });
    const rows = Array.from({ length: 102 }, (_, i) =>
      playlist('PLowned' + i, 'First ' + i, i % 2 === 0),
    );
    rows.splice(100, 0, playlist('PLowned0', 'Duplicate loses'));
    rows.push(responsiveSong(0));
    const raw: any = singleColumn([carousel(rows, 'Owned playlists')]);
    raw.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.continuations =
      [{ nextContinuationData: { continuation: 'library-next' } }];
    f.calls[0].resolve(f.c.normalizeMusicSource(raw, 'library'));
    const first = await initial;
    expect(first.items).toHaveLength(100);
    expect(first.items[0].title).toBe('First 0');
    const second = await f.service.library(grant.token, {
      limit: 100,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i: any) => i.id)).toEqual([
      'PLowned100',
      'PLowned101',
    ]);
    expect(second.shelves).toEqual([
      { title: 'Owned playlists', start: 0, count: 2 },
    ]);
    expect(f.calls).toHaveLength(1);
    const duplicate = f.service.library(grant.token, {
      limit: 100,
      cursor: second.nextCursor,
    });
    await expect.poll(() => f.calls.length).toBe(2);
    f.calls[1].resolve(
      f.c.normalizeMusicSource(
        remote([playlist('PLowned0', 'Remote duplicate')], 'last-library'),
        'browse',
      ),
    );
    const empty = await duplicate;
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toMatch(/^mcur_/);
    expect(f.calls).toHaveLength(2);
    expect(
      await f.service.library(grant.token, {
        limit: 100,
        cursor: second.nextCursor,
      }),
    ).toEqual(empty);
    expect(f.calls).toHaveLength(2);
    const last = f.service.library(grant.token, {
      limit: 100,
      cursor: empty.nextCursor,
    });
    await expect.poll(() => f.calls.length).toBe(3);
    f.calls[2].resolve(
      f.c.normalizeMusicSource(
        remote([playlist('PLowned101'), playlist('PLnew', 'New', true)]),
        'browse',
      ),
    );
    expect((await last).items.map((i: any) => [i.id, i.title])).toEqual([
      ['PLnew', 'New'],
    ]);
    expect(f.service.stats().cacheBytes).toBeGreaterThan(
      JSON.stringify(rows).length / 4,
    );
  } finally {
    await f.close();
  }
});

test('collections are strict fixed native recipes and owner fetch replacement retires deferred actual-source read', async () => {
  const f = await musicRendererFixture();
  try {
    const home = f.read(undefined, { operation: 'home' });
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0]).toMatchObject({
      url: '/browse',
      data: { browseId: 'FEmusic_home' },
    });
    f.fetches[0].resolve(home151());
    await f.flush();
    expect(f.result(home)).toMatchObject({
      ok: true,
      value: { items: expect.any(Array) },
    });
    const library = f.read(undefined, { operation: 'library' });
    expect(f.fetches[1]).toMatchObject({
      url: '/browse',
      data: { browseId: 'FEmusic_liked_playlists' },
    });
    f.fetches[1].resolve(
      singleColumn([carousel([playlist('PLowned', 'Title', true)])]),
    );
    await f.flush();
    expect(f.result(library).value.items[0].id).toBe('PLowned');
    const bad = f.read(undefined, { operation: 'home', browseId: 'attacker' });
    expect(f.result(bad)).toEqual({ ok: false, reason: 'invalid' });
    expect(f.fetches).toHaveLength(2);
  } finally {
    f.close();
  }
});
test('exact fetch function identity retires held catalog read and healthy recovery succeeds', async () => {
  const f = await musicRendererFixture();
  try {
    const held = f.read();
    const original = f.app.networkManager.fetch;
    f.app.networkManager.fetch = (...args: any[]) => original(...args);
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(held)).toEqual({ ok: false, reason: 'retired' });
    f.controller.refresh();
    const next = f.read();
    f.fetches[1].resolve(f.searchPage());
    await f.flush();
    expect(f.result(next).ok).toBe(true);
  } finally {
    f.close();
  }
});
test('collection input/query rejects coercion unknown duplicate and default limit remains50', async () => {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/scheme/music.ts',
  );
  expect(typeof m.parseMusicCollectionInput).toBe('function');
  expect(m.parseMusicCollectionInput({})).toEqual({ limit: 50 });
  expect(m.parseMusicCollectionQuery(new URLSearchParams('limit=100'))).toEqual(
    { limit: 100 },
  );
  for (const value of [
    { limit: '100' },
    { limit: 0 },
    { limit: 101 },
    { browseId: 'FEmusic_home' },
    { cursor: 'private' },
    { limit: 1, query: 'x' },
  ])
    expect(() => m.parseMusicCollectionInput(value)).toThrow();
  for (const query of ['limit=01', 'limit=1&limit=2', 'limit=1e2', 'params=x'])
    expect(() =>
      m.parseMusicCollectionQuery(new URLSearchParams(query)),
    ).toThrow();
});

test('native fetch accessor disposal at final owner check cannot publish healthy catalog data', async () => {
  const f = await musicRendererFixture();
  try {
    const original = f.app.networkManager.fetch;
    let calls = 0,
      threshold = Infinity;
    Object.defineProperty(f.app.networkManager, 'fetch', {
      configurable: true,
      get() {
        if (++calls === threshold) f.controller.dispose();
        return original;
      },
    });
    const warm = f.read();
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(warm).ok).toBe(true);
    const count = calls;
    calls = 0;
    threshold = count;
    const raced = f.read();
    f.fetches[1].resolve(f.searchPage());
    await f.flush();
    expect(calls).toBeGreaterThanOrEqual(threshold);
    expect(f.result(raced)).toEqual({ ok: false, reason: 'retired' });
  } finally {
    f.close();
  }
});

test('collection scopes route principal resource source and concurrent cursor ownership fence cached and remote pages', async () => {
  const f = await musicServiceFixture();
  try {
    expect(typeof f.service.home).toBe('function');
    const both = await collectionGrant(f),
      homeOnly = await collectionGrant(f, ['personalized.read']),
      libraryOnly = await collectionGrant(f, ['library.read']);
    expect(f.calls).toHaveLength(0);
    for (const [method, token] of [
      ['home', f.grant.token],
      ['home', libraryOnly.token],
      ['library', homeOnly.token],
    ] as const)
      await expect(f.service[method](token, {})).rejects.toMatchObject({
        code: 'forbidden',
      });
    for (const token of ['legacy-client-id', 'eyJ.synthetic.jwt'])
      await expect(f.service.home(token, {})).rejects.toMatchObject({
        code: 'unauthorized',
      });
    expect(f.calls).toHaveLength(0);
    const first = await f.service.home(both.token, { limit: 100 });
    await expect(
      f.service.library(both.token, { cursor: first.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.service.home(homeOnly.token, { cursor: first.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      f.service.home(both.token, { cursor: first.nextCursor, limit: 99 }),
    ).rejects.toMatchObject({ code: 'invalid' });
    f.retireSource();
    await expect(
      f.service.home(both.token, { cursor: first.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
  const held = await musicServiceFixture();
  try {
    const grant = await collectionGrant(held, ['personalized.read']);
    held.setHold();
    const initial = held.service.home(grant.token, {});
    await expect.poll(() => held.calls.length).toBe(1);
    held.calls[0].resolve(
      held.c.normalizeMusicSource(
        singleColumn([carousel([responsiveSong(0)])]),
        'home',
      ),
    );
    const complete = await initial;
    expect(complete.nextCursor).toBeNull();
    const nextInitial = held.service.home(grant.token, {});
    await expect.poll(() => held.calls.length).toBe(2);
    held.calls[1].resolve(
      held.c.normalizeMusicSource(homeWithContinuation(), 'home'),
    );
    const first = await nextInitial;
    // Three local50-item slices exhaust151; final1-row slice keeps remote token private.
    let last = first;
    while (last.items.length === 50)
      last = await held.service.home(grant.token, { cursor: last.nextCursor });
    const next = held.service.home(grant.token, { cursor: last.nextCursor });
    await expect.poll(() => held.calls.length).toBe(3);
    await expect(
      held.service.home(grant.token, { cursor: last.nextCursor }),
    ).rejects.toMatchObject({ code: 'busy' });
    held.calls[2].resolve(
      held.c.normalizeMusicSource(remote([responsiveSong(152)]), 'browse'),
    );
    const page = await next;
    expect(
      await held.service.home(grant.token, { cursor: last.nextCursor }),
    ).toEqual(page);
    expect(held.calls).toHaveLength(3);
    await held.store.revoke(grant.record.id, () => true);
    expect(held.service.stats().cursors).toBe(0);
  } finally {
    await held.close();
  }
});

test('Home category references survive unrelated grant event and retain originating scope on browse consumption', async () => {
  const f = await musicServiceFixture();
  try {
    expect(typeof f.service.home).toBe('function');
    const home = await collectionGrant(f, ['personalized.read']);
    f.setHold();
    const pending = f.service.home(home.token, {});
    await expect.poll(() => f.calls.length).toBe(1);
    f.calls[0].resolve(
      f.c.normalizeMusicSource(
        singleColumn([carousel([categoryButton()])]),
        'home',
      ),
    );
    const page = await pending;
    expect(page.items[0].reference).toMatch(/^mref_/);
    expect(f.service.stats().references).toBe(1);
    await collectionGrant(f, ['catalog.read']);
    expect(f.service.stats().references).toBe(1);
    await expect(
      f.service.browse(home.token, {
        target: { kind: 'reference', id: page.items[0].reference },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await f.store.revoke(home.record.id, () => true);
    expect(f.service.stats().references).toBe(0);
  } finally {
    await f.close();
  }
});

test('library seen IDs are charged to shared aggregate cache and4MiB overflow is a truthful budget failure', async () => {
  const f = await musicServiceFixture();
  try {
    const grant = await collectionGrant(f);
    const ids = Array.from(
      { length: 512 },
      (_, i) => 'PL' + String(i).padStart(5, '0') + 'x'.repeat(95),
    );
    const raw = singleColumn([
      carousel(ids.map((id) => playlist(id, 'T'.repeat(450)))),
    ]);
    const source = f.c.normalizeMusicSource(raw, 'library');
    f.setHold();
    const read = async (route: 'home' | 'library') => {
      const p = f.service[route](grant.token, { limit: 100 });
      const call = f.calls.length;
      await expect.poll(() => f.calls.length).toBe(call + 1);
      f.calls[call].resolve(source);
      return p;
    };
    await read('home');
    const homeBytes = f.service.stats().cacheBytes;
    await read('library');
    const libraryBytes = f.service.stats().cacheBytes - homeBytes;
    expect(libraryBytes - homeBytes).toBeGreaterThan(
      ids.reduce((n, id) => n + id.length, 0),
    );
    let rejected = false;
    for (let i = 0; i < 20; i++) {
      try {
        await read('library');
      } catch (e: any) {
        expect(e.code).toBe('budget');
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(f.service.stats().cacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  } finally {
    await f.close();
  }
});

test('collection known empty unknown malformed and unavailable native return distinct results', async () => {
  const f = await musicRendererFixture();
  try {
    for (const operation of ['home', 'library']) {
      const empty = f.read(undefined, { operation });
      f.fetches.at(-1).resolve(singleColumn([carousel([])]));
      await f.flush();
      expect(f.result(empty)).toMatchObject({
        ok: true,
        value: { items: [], continuation: null },
      });
      const unknown = f.read(undefined, { operation });
      f.fetches.at(-1).resolve({ contents: { unknownRenderer: {} } });
      await f.flush();
      expect(f.result(unknown)).toEqual({ ok: false, reason: 'unsupported' });
      const malformed = f.read(undefined, { operation });
      f.fetches
        .at(-1)
        .resolve(singleColumn([carousel([{ musicTwoRowItemRenderer: {} }])]));
      await f.flush();
      expect(f.result(malformed)).toEqual({ ok: false, reason: 'source' });
    }
    f.app.networkManager = undefined;
    expect(f.query().type).toBe('unavailable');
  } finally {
    f.close();
  }
});

test('Home issued category recipe is consumed only by catalog plus live issuer scope and owner', async () => {
  const f = await musicServiceFixture();
  try {
    const grant = await collectionGrant(f);
    f.setHold();
    const p = f.service.home(grant.token, {});
    await expect.poll(() => f.calls.length).toBe(1);
    f.calls[0].resolve(
      f.c.normalizeMusicSource(
        singleColumn([carousel([categoryButton()])]),
        'home',
      ),
    );
    const home = await p;
    const browse = f.service.browse(grant.token, {
      target: { kind: 'reference', id: home.items[0].reference },
    });
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1].input).toEqual({
      operation: 'browse',
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'synthetic-service-owned-params',
    });
    f.calls[1].resolve(f.c.normalizeMusicSource(home151(), 'browse'));
    const first = await browse;
    const current = f.store.isCurrent.bind(f.store);
    // Model a scoped-policy retirement without retiring the still-valid catalog grant.
    f.store.isCurrent = (record: any, scope: string) =>
      scope !== 'personalized.read' && current(record, scope);
    await expect(
      f.service.browse(grant.token, { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('final network fetch accessor cannot replace captured app network and publish an old source', async () => {
  const f = await musicRendererFixture();
  try {
    const network = f.app.networkManager,
      original = network.fetch;
    let calls = 0,
      threshold = Infinity,
      triggered = false;
    Object.defineProperty(network, 'fetch', {
      configurable: true,
      get() {
        if (++calls === threshold) {
          triggered = true;
          f.app.networkManager = { fetch: original };
        }
        return original;
      },
    });
    const warm = f.read();
    f.fetches[0].resolve(f.searchPage());
    await f.flush();
    expect(f.result(warm).ok).toBe(true);
    const count = calls;
    calls = 0;
    threshold = count;
    const raced = f.read();
    f.fetches[1].resolve(f.searchPage());
    await f.flush();
    expect(triggered).toBe(true);
    expect(f.result(raced)).toEqual({ ok: false, reason: 'retired' });
    f.controller.refresh();
    const recovery = f.read();
    f.fetches[2].resolve(f.searchPage());
    await f.flush();
    expect(f.result(recovery).ok).toBe(true);
  } finally {
    f.close();
  }
});

test('nested category references retain Home issuer scope through a catalog browse page', async () => {
  const f = await musicServiceFixture();
  try {
    const grant = await collectionGrant(f);
    f.setHold();
    const homePromise = f.service.home(grant.token, {});
    await expect.poll(() => f.calls.length).toBe(1);
    f.calls[0].resolve(
      f.c.normalizeMusicSource(
        singleColumn([carousel([categoryButton()])]),
        'home',
      ),
    );
    const home = await homePromise;
    const browsePromise = f.service.browse(grant.token, {
      target: { kind: 'reference', id: home.items[0].reference },
    });
    await expect.poll(() => f.calls.length).toBe(2);
    f.calls[1].resolve(
      f.c.normalizeMusicSource(
        singleColumn([carousel([categoryButton('Nested')])]),
        'browse',
      ),
    );
    const nested = await browsePromise;
    const current = f.store.isCurrent.bind(f.store);
    f.store.isCurrent = (record: any, scope: string) =>
      scope !== 'personalized.read' && current(record, scope);
    const pending = f.service
      .browse(grant.token, {
        target: { kind: 'reference', id: nested.items[0].reference },
      })
      .then(
        () => 'accepted',
        (e: any) => e.code,
      );
    // If broken code dispatches, settle the synthetic boundary so the assertion is honest.
    await new Promise((r) => setTimeout(r, 10));
    if (f.calls.length === 3)
      f.calls[2].resolve(
        f.c.normalizeMusicSource(singleColumn([carousel([])]), 'browse'),
      );
    expect(await pending).toBe('retired');
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('collection cursors share128 global slots across Home library catalog and queue readers', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const tiny = f.c.normalizeMusicSource(
      singleColumn([carousel([playlist('PLfirst'), playlist('PLsecond')])]),
      'library',
    );
    const tokens = [];
    for (let i = 0; i < 5; i++)
      tokens.push(
        (
          await collectionGrant(f, [
            'personalized.read',
            'library.read',
            'catalog.read',
            'playback.read',
          ])
        ).token,
      );
    let call = 0;
    for (let principal = 0; principal < 4; principal++)
      for (let i = 0; i < 32; i++) {
        const route = ['home', 'library', 'search', 'queue'][i % 4];
        const value =
          route === 'search' ? { query: 'fixture', limit: 1 } : { limit: 1 };
        const pending = f.service[route](tokens[principal], value);
        while (f.calls.length === call) await Promise.resolve();
        f.calls[call++].resolve(
          route === 'queue'
            ? {
                version: 1,
                queueRevision: 'a'.repeat(32),
                selectedIndex: null,
                items: tiny.items,
              }
            : tiny,
        );
        await pending;
      }
    expect(f.service.stats().cursors).toBe(128);
    const overflow = f.service.home(tokens[4], { limit: 1 });
    while (f.calls.length === call) await Promise.resolve();
    f.calls[call].resolve(tiny);
    await expect(overflow).rejects.toMatchObject({ code: 'budget' });
    expect(f.service.stats().cursors).toBe(128);
    f.advance(120001);
    // Shared expiry frees all route kinds before the next allocation.
    const reclaimed = f.service.library(tokens[4], { limit: 1 });
    while (f.calls.length === call + 1) await Promise.resolve();
    f.calls[call + 1].resolve(tiny);
    await reclaimed;
    expect(f.service.stats().cursors).toBe(1);
  } finally {
    await f.close();
  }
});
// C1 F2: registered source retirement must precede settled/cached admission.
test('F2 current-source mismatch emits epoch retirement before the old physical settlement', async () => {
  const f = await musicRendererFixture();
  try {
    const held = f.read(undefined, { operation: 'home' });
    const original = f.app.networkManager.fetch;
    f.app.networkManager.fetch = (...args: any[]) => original(...args);
    const start = f.sent.length;
    f.fetches[0].resolve(home151());
    await f.flush();
    const events = f.sent.slice(start).map((p: any) => p[1]);
    expect(events[0]).toMatchObject({
      type: 'retire',
      sourceId: held.sourceId,
    });
    expect(events.find((p: any) => p.type === 'settled')).toMatchObject({
      sourceId: held.sourceId,
      result: { ok: false, reason: 'retired' },
    });
    const fresh = f.query();
    expect(fresh.type).toBe('ready');
    expect(fresh.sourceId).not.toBe(held.sourceId);
    const next = f.read(fresh, { operation: 'home' });
    f.fetches[1].resolve(home151());
    await f.flush();
    expect(f.result(next).ok).toBe(true);
  } finally {
    f.close();
  }
});

test('F2 canceled old jobs never enter native getters or retire a newer adopted source', async () => {
  const f = await musicRendererFixture();
  try {
    const old = f.read(undefined, { operation: 'home' }),
      original = f.app.networkManager.fetch;
    const fetchB = (...args: any[]) => original(...args);
    f.app.networkManager = { fetch: fetchB };
    f.controller.refresh();
    const newer = f.read(undefined, { operation: 'home' });
    f.fetches[1].resolve(home151());
    await f.flush();
    expect(f.result(newer).ok).toBe(true);
    const networkB = f.app.networkManager;
    let getters = 0;
    Object.defineProperty(networkB, 'fetch', {
      configurable: true,
      get() {
        getters++;
        if (getters === 1) {
          f.app.networkManager = { fetch: original };
          f.controller.refresh();
        }
        return fetchB;
      },
    });
    f.fetches[0].resolve(home151());
    await f.flush();
    Object.defineProperty(networkB, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchB,
    });
    expect(getters).toBe(0);
    expect(f.result(old)).toEqual({ ok: false, reason: 'retired' });
    expect(f.query().sourceId).toBe(newer.sourceId);
  } finally {
    f.close();
  }
});

for (const action of ['refresh', 'isCurrent'] as const)
  test(`F2 ${action} capture reentry cannot overwrite or certify a newer adopted epoch`, async () => {
    const f = await musicRendererFixture(),
      source = await musicModuleSource('src/providers/music-renderer.ts');
    f.controller.dispose();
    let armed = false,
      adopted: any,
      controller: any;
    const original = f.app.networkManager.fetch;
    const fetchB = (...args: any[]) => original(...args);
    controller = source.createMusicRendererController(
      f.originalApi,
      () => {
        if (armed) {
          armed = false;
          if (action === 'refresh') f.app.networkManager = { fetch: fetchB };
          controller.refresh();
          adopted = f.query();
        }
        return f.originalApi;
      },
      f.ipc,
    );
    try {
      const old = f.query();
      if (action === 'isCurrent') f.app.networkManager = { fetch: fetchB };
      armed = true;
      const result = controller[action]();
      expect(adopted.type).toBe('ready');
      expect(adopted.sourceId).not.toBe(old.sourceId);
      if (action === 'isCurrent') expect(result).toBe(false);
      expect(f.query().sourceId).toBe(adopted.sourceId);
      const read = f.read(adopted, { operation: 'home' });
      f.fetches[0].resolve(home151());
      await f.flush();
      expect(f.result(read).ok).toBe(true);
    } finally {
      controller.dispose();
      f.close();
    }
  });

test('F2 synchronous retire IPC callout cannot clear newer handshakes or overwrite its adopted owner', async () => {
  const f = await musicRendererFixture();
  try {
    const initial = f.query(),
      original = f.app.networkManager.fetch;
    const fetchB = (...args: any[]) => original(...args),
      fetchC = (...args: any[]) => original(...args);
    const send = f.ipc.send;
    let armed = true,
      adopted: any;
    f.ipc.send = (...args: any[]) => {
      send(...args);
      if (args[1].type === 'retire' && armed) {
        armed = false;
        f.app.networkManager = { fetch: fetchC };
        f.controller.refresh();
        adopted = f.query();
      }
    };
    f.app.networkManager = { fetch: fetchB };
    f.controller.refresh();
    expect(adopted.type).toBe('ready');
    expect(adopted.sourceId).not.toBe(initial.sourceId);
    expect(f.query().sourceId).toBe(adopted.sourceId);
    const read = f.read(adopted, { operation: 'home' });
    f.fetches[0].resolve(home151());
    await f.flush();
    expect(f.result(read).ok).toBe(true);
  } finally {
    f.close();
  }
});
