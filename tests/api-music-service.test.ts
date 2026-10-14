import { test, expect } from '@playwright/test';
import { musicServiceFixture } from './helpers/api-music-service';

test('service preserves literal100+51 local remainder before remote continuation and replays exact completed page', async () => {
  const f = await musicServiceFixture();
  try {
    const first = await f.service.search(f.grant.token, {
      query: 'fixture',
      limit: 100,
    });
    expect(first.items).toHaveLength(100);
    expect(f.calls).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^mcur_/);
    const second = await f.service.search(f.grant.token, {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second.items).toHaveLength(51);
    expect(second.nextCursor).toBeNull();
    expect(f.calls).toHaveLength(1);
    expect(
      await f.service.search(f.grant.token, {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).toEqual(second);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('foreign cursors are404-equivalent and own native-source config expiry retirement cannot publish cached pages', async () => {
  const f = await musicServiceFixture();
  try {
    const first = await f.service.search(f.grant.token, {
      query: 'fixture',
      limit: 100,
    });
    await expect(
      f.service.search(f.other.token, { cursor: first.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    f.retireSource();
    await expect(
      f.service.search(f.grant.token, { cursor: first.nextCursor, limit: 100 }),
    ).rejects.toMatchObject({ code: 'retired' });
  } finally {
    await f.close();
  }
  const expired = await musicServiceFixture();
  try {
    const first = await expired.service.search(expired.grant.token, {
      query: 'fixture',
      limit: 100,
    });
    expired.advance(120001);
    await expect(
      expired.service.search(expired.grant.token, {
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    await expired.close();
  }
});
test('caller explicit cursor alone performs next native page and concurrent use cannot duplicate it', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const initial = f.service.search(f.grant.token, { query: 'fixture' });
    while (!f.calls.length) await Promise.resolve();
    f.calls[0].resolve(f.c.normalizeMusicSource(f.searchPage(), 'search'));
    const first = await initial;
    expect(f.calls).toHaveLength(1);
    const next = f.service.search(f.grant.token, { cursor: first.nextCursor });
    while (f.calls.length < 2) await Promise.resolve();
    await expect(
      f.service.search(f.grant.token, { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(f.calls[1].input).toEqual({
      operation: 'continuation',
      endpoint: 'search',
      token: 'synthetic-service-continuation',
    });
    f.calls[1].resolve(
      f.c.normalizeMusicSource(f.continuationPage(), 'search'),
    );
    const page = await next;
    expect(page.items[0].title).toBe('Fixture Track 1');
    expect(
      await f.service.search(f.grant.token, { cursor: first.nextCursor }),
    ).toEqual(page);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('main owner capture precedes async auth and retirement cancellation revocation settle callers before physical promises', async () => {
  const stale = await musicServiceFixture();
  try {
    stale.authHold();
    const p = stale.service
      .search(stale.grant.token, { query: 'fixture' })
      .catch((e: any) => e.code);
    stale.service.configure({ ...stale.config, port: 26540 });
    stale.authRelease();
    expect(await p).toBe('retired');
    expect(stale.calls).toHaveLength(0);
  } finally {
    await stale.close();
  }
  const canceled = await musicServiceFixture();
  try {
    canceled.setHold();
    const signal = new AbortController(),
      p = canceled.service
        .search(canceled.grant.token, { query: 'fixture' }, signal.signal)
        .catch((e: any) => e.code);
    while (!canceled.calls.length) await Promise.resolve();
    signal.abort();
    expect(await p).toBe('retired');
    canceled.calls[0].resolve(
      canceled.c.normalizeMusicSource(canceled.searchPage(), 'search'),
    );
  } finally {
    await canceled.close();
  }
  const revoked = await musicServiceFixture();
  try {
    revoked.setHold();
    const p = revoked.service
      .search(revoked.grant.token, { query: 'fixture' })
      .catch((e: any) => e.code);
    while (!revoked.calls.length) await Promise.resolve();
    await revoked.store.revoke(revoked.grant.record.id, () => true);
    expect(await p).toBe('retired');
    revoked.calls[0].resolve(
      revoked.c.normalizeMusicSource(revoked.searchPage(), 'search'),
    );
  } finally {
    await revoked.close();
  }
});
test('valid empty scopes deny403 and reserved collections require explicit library permission', async () => {
  const f = await musicServiceFixture();
  try {
    const empty = await f.store.issue(
      'Empty',
      'rest',
      f.resource,
      [],
      () => true,
    );
    await expect(
      f.service.search(empty.token, { query: 'fixture' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      f.service.search('legacy-client-id', { query: 'fixture' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      f.service.browse(f.grant.token, {
        target: { kind: 'playlist', id: 'WL' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('opaque category references are source principal bound and provider recipes never become client DTO fields', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const first = f.service.search(f.grant.token, { query: 'fixture' });
    while (!f.calls.length) await Promise.resolve();
    const source = {
      version: 1,
      items: [
        {
          kind: 'category',
          id: 'genres',
          title: 'Genre fixture',
          artists: [],
          durationSeconds: null,
        },
      ],
      shelves: [],
      continuation: null,
      targetRecipes: [
        {
          itemIndex: 0,
          browseId: 'FEmusic_moods_and_genres_category',
          params: 'synthetic-server-owned-recipe',
        },
      ],
    };
    f.calls[0].resolve(source);
    const page = await first;
    expect(page.items[0].reference).toMatch(/^mref_/);
    expect(JSON.stringify(page)).not.toContain('synthetic-server-owned-recipe');
    await expect(
      f.service.browse(f.other.token, {
        target: { kind: 'reference', id: page.items[0].reference },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const browse = f.service.browse(f.grant.token, {
      target: { kind: 'reference', id: page.items[0].reference },
    });
    while (f.calls.length < 2) await Promise.resolve();
    expect(f.calls[1].input).toEqual({
      operation: 'browse',
      browseId: 'FEmusic_moods_and_genres_category',
      params: 'synthetic-server-owned-recipe',
    });
    f.calls[1].resolve({
      version: 1,
      items: [],
      shelves: [],
      continuation: null,
      targetRecipes: [],
    });
    expect((await browse).items).toEqual([]);
  } finally {
    await f.close();
  }
});
test('complete256KiB DTO byte paging keeps echo shelves and every remaining item', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const query = '🎵'.repeat(256),
      pending = f.service.search(f.grant.token, { query, limit: 100 });
    while (!f.calls.length) await Promise.resolve();
    const items = Array.from({ length: 64 }, (_, i) => ({
      kind: 'song',
      id: 'v' + String(i).padStart(10, '0'),
      title: '🎵'.repeat(512),
      artists: [{ name: '🎵'.repeat(256) }],
      durationSeconds: null,
    }));
    f.calls[0].resolve({
      version: 1,
      items,
      shelves: items.map((_, i) => ({
        title: '🎵'.repeat(512),
        start: i,
        count: 1,
      })),
      continuation: null,
      targetRecipes: [],
    });
    const first = await pending;
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      256 * 1024,
    );
    const second = await f.service.search(f.grant.token, {
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect([...first.items, ...second.items].map((i: any) => i.id)).toEqual(
      items.map((i) => i.id),
    );
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('cursor principal count and cache byte quotas are bounded and expiry releases capacity', async () => {
  const f = await musicServiceFixture();
  try {
    for (let i = 0; i < 32; i++)
      await f.service.search(f.grant.token, { query: 'fixture', limit: 100 });
    expect(f.service.stats().cursors).toBe(32);
    expect(f.service.stats().cacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    await expect(
      f.service.search(f.grant.token, { query: 'fixture', limit: 100 }),
    ).rejects.toMatchObject({ code: 'budget' });
    f.advance(120001);
    await f.service.search(f.grant.token, { query: 'fixture', limit: 100 });
    expect(f.service.stats().cursors).toBe(1);
  } finally {
    await f.close();
  }
});
test('absolute grant expiry settles an unabortable native caller before its native promise', async () => {
  const f = await musicServiceFixture();
  try {
    f.advance(86400000 - 5);
    f.setHold();
    const p = f.service
      .search(f.grant.token, { query: 'fixture' })
      .catch((e: any) => e.code);
    while (!f.calls.length) await Promise.resolve();
    expect(await p).toBe('retired');
    f.calls[0].resolve({
      version: 1,
      items: [],
      shelves: [],
      continuation: null,
      targetRecipes: [],
    });
  } finally {
    await f.close();
  }
});

test('configuration retirement and grant revocation delete private cached payloads and restore admission capacity', async () => {
  const f = await musicServiceFixture();
  try {
    for (let i = 0; i < 32; i++)
      await f.service.search(f.grant.token, { query: 'fixture', limit: 100 });
    f.service.configure({ ...f.config });
    expect(f.service.stats().cursors).toBe(0);
    await f.service.search(f.grant.token, { query: 'fixture', limit: 100 });
    expect(f.service.stats().cursors).toBe(1);
    await f.store.revoke(f.grant.record.id, () => true);
    expect(f.service.stats().cursors).toBe(0);
    expect(f.service.stats().cacheBytes).toBe(0);
  } finally {
    await f.close();
  }
});

test('configured nonlocal listener cannot advertise an enabled first-unit local grant resource', async () => {
  const f = await musicServiceFixture();
  try {
    f.service.configure({ ...f.config, hostname: '192.0.2.1' });
    expect(f.service.enabled).toBe(false);
    await expect(
      f.service.search(f.grant.token, { query: 'fixture' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('canonical legacy FL-prefixed favorites IDs still require library permission on new read routes', async () => {
  const f = await musicServiceFixture();
  try {
    for (const id of ['WL', 'LL', 'LM', 'FLfixture'])
      await expect(
        f.service.browse(f.grant.token, { target: { kind: 'playlist', id } }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('search continuation cannot change the authenticated native endpoint family', async () => {
  const f = await musicServiceFixture();
  try {
    f.setHold();
    const p = f.service.search(f.grant.token, { query: 'fixture' });
    while (!f.calls.length) await Promise.resolve();
    const source = f.c.normalizeMusicSource(f.searchPage(), 'search');
    source.continuation.endpoint = 'browse';
    f.calls[0].resolve(source);
    await expect(p).rejects.toMatchObject({ code: 'source' });
    expect(f.service.stats().cursors).toBe(0);
  } finally {
    await f.close();
  }
});

test('idle cached payloads are deleted by absolute grant expiry without another request or config event', async () => {
  const f = await musicServiceFixture();
  try {
    f.advance(86400000 - 20);
    await f.service.search(f.grant.token, { query: 'fixture', limit: 100 });
    expect(f.service.stats().cursors).toBe(1);
    f.advance(21);
    await new Promise((r) => setTimeout(r, 40));
    expect(f.service.stats().cursors).toBe(0);
    expect(f.service.stats().cacheBytes).toBe(0);
  } finally {
    await f.close();
  }
});


test('queue client schema rejects malformed input before native dispatch', async () => {
  const f = await musicServiceFixture();
  try {
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: '1' }, { limit: 1, token: 'raw' }, { cursor: 'raw', limit: 1 }])
      await expect(f.service.queue(f.grant.token, input)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});
// C1 ownership controls exercise the same cache/admission/ledger as catalog and queue.
test('Home and library use shared32-principal cursor quota and release on revoke', async () => {
  const f = await musicServiceFixture();
  try {
    const grant = await f.store.issue(
      'Shared scopes',
      'rest',
      f.resource,
      ['catalog.read', 'personalized.read', 'library.read'],
      () => true,
    );
    expect(f.calls).toHaveLength(0);
    for (let i = 0; i < 16; i++)
      await f.service.home(grant.token, { limit: 100 });
    for (let i = 0; i < 16; i++)
      await f.service.search(grant.token, { query: 'fixture', limit: 100 });
    expect(f.service.stats().cursors).toBe(32);
    // A new Home call cannot allocate a separate collection cache beyond catalog's quota.
    await expect(
      f.service.home(grant.token, { limit: 100 }),
    ).rejects.toMatchObject({ code: 'budget' });
    expect(f.service.stats().cursors).toBe(32);
    await f.store.revoke(grant.record.id, () => true);
    expect(f.service.stats()).toEqual({
      cursors: 0,
      references: 0,
      cacheBytes: 0,
    });
  } finally {
    await f.close();
  }
});
test('collection grant expiry configuration and source retirement cannot reuse completed replay', async () => {
  for (const retire of ['expiry', 'config', 'source']) {
    const f = await musicServiceFixture();
    try {
      const grant = await f.store.issue(
        'Home scope',
        'rest',
        f.resource,
        ['personalized.read'],
        () => true,
      );
      const first = await f.service.home(grant.token, { limit: 100 });
      const second = await f.service.home(grant.token, {
        cursor: first.nextCursor,
        limit: 100,
      });
      expect(second.items).toHaveLength(51);
      if (retire === 'expiry') f.advance(86400001);
      else if (retire === 'config') f.service.configure({ ...f.config });
      else f.retireSource();
      await expect(
        f.service.home(grant.token, { cursor: first.nextCursor, limit: 100 }),
      ).rejects.toMatchObject({
        code:
          retire === 'expiry'
            ? 'unauthorized'
            : retire === 'config'
              ? 'not_found'
              : 'retired',
      });
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});
