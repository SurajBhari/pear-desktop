import { test, expect } from '@playwright/test';
import { musicModuleSource } from './helpers/api-music-source';
import { home151 } from './helpers/music-catalog-fixtures';
async function fixture() {
  const m = await musicModuleSource(
    'src/plugins/api-server/backend/scheme/music.ts',
  );
  expect(typeof m.parseMusicInput).toBe('function');
  return m;
}
test('typed input distinguishes public targets opaque references and safe enum filters without provider params', async () => {
  const m = await fixture();
  expect(
    m.parseMusicInput({ query: 'fixture', kind: 'song', limit: 100 }, 'search'),
  ).toMatchObject({ query: 'fixture', kind: 'song', limit: 100 });
  expect(
    m.parseMusicInput({ target: { kind: 'category', id: 'genres' } }, 'browse')
      .limit,
  ).toBe(50);
  for (const value of [
    { target: { kind: 'category', id: 'FEmusic_home' } },
    { target: { kind: 'album', id: 'UC' + 'a'.repeat(22) } },
    {
      target: {
        kind: 'playlist',
        id: 'https://music.youtube.com/playlist?list=PLfixture',
      },
    },
    {
      target: { kind: 'artist', id: 'UC' + 'a'.repeat(22), params: 'private' },
    },
  ])
    expect(() => m.parseMusicInput(value, 'browse')).toThrow(
      'Invalid music request.',
    );
  expect(() =>
    m.parseMusicInput({ query: 'fixture', params: 'provider' }, 'search'),
  ).toThrow();
  expect(() =>
    m.parseMusicInput(
      { cursor: 'mcur_' + 'a'.repeat(43), query: 'fixture' },
      'search',
    ),
  ).toThrow();
});
test('query scalar utf8 body-size and page limits are exact including lone-surrogate rejection', async () => {
  const m = await fixture();
  expect(
    m.parseMusicInput({ query: '🎵'.repeat(256) }, 'search').query,
  ).toHaveLength(512);
  for (const value of [
    { query: '🎵'.repeat(257) },
    { query: '\ud800' },
    { query: ' ' },
    { query: '\0' },
    { query: 'fixture', limit: 0 },
    { query: 'fixture', limit: 101 },
    { query: 'fixture', limit: '50' },
  ])
    expect(() => m.parseMusicInput(value, 'search')).toThrow();
});
test('main validates complete normalized envelopes and cross-field shelf recipe identity rather than trusting renderer DTO', async () => {
  const m = await fixture(),
    catalog = await musicModuleSource('src/providers/music-catalog.ts'),
    source = catalog.normalizeMusicSource(home151(), 'home');
  expect(m.parseNativeCatalog(source).items).toHaveLength(151);
  for (const changed of [
    { ...source, rawProvider: {} },
    { ...source, shelves: [{ title: 'Fixture', start: 150, count: 2 }] },
    { ...source, targetRecipes: [{ itemIndex: 0, browseId: 'FEmusic_home' }] },
    { ...source, items: [{ ...source.items[0], id: 'invalid' }] },
  ])
    expect(() => m.parseNativeCatalog(changed)).toThrow(
      'Invalid music service response.',
    );
});
test('precise current DTO requires agreeing elapsed milliseconds and finite nonnegative clocks', async () => {
  const m = await fixture(),
    value = {
      version: 1,
      playbackEpoch: 'a'.repeat(32) + ':' + 'b'.repeat(32),
      current: null,
      state: 'paused',
      elapsedSeconds: 1.2345,
      elapsedMilliseconds: 1234.5,
      durationSeconds: null,
      volume: null,
    };
  expect(m.parseNativeSnapshot(value)).toEqual(value);
  for (const changed of [
    { ...value, elapsedMilliseconds: 1234 },
    { ...value, elapsedSeconds: Infinity },
    { ...value, volume: 101 },
    { ...value, elapsedSeconds: -1 },
    { ...value, rawProvider: {} },
  ])
    expect(() => m.parseNativeSnapshot(changed)).toThrow();
});
