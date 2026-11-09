import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

import { test } from '@playwright/test';
import { createStore } from 'solid-js/store';

type Info = { videoId: string };
type Data = { videoId: string; provider: string; request: number };
type State = { state: string; data: Data | null; error: Error | null };
type Cache = {
  state: string;
  data: Record<string, State>;
  ytMusicWithoutProxy: boolean;
};
type LyricsModule = {
  lyricsStore: { lyrics: Record<string, State> };
  currentLyrics: () => State;
  fetchLyrics: (info: Info) => void;
  retrySearch: (provider: string, info: Info) => void;
  startLyricsSession: () => void;
  stopLyricsSession: () => void;
};
type Request = {
  videoId: string;
  provider: string;
  request: number;
  resolve: () => void;
};
const source = readFileSync(
  new URL('../src/plugins/synced-lyrics/renderer/store.ts', import.meta.url),
  'utf8',
);
const isolated = stripTypeScriptTypes(source, { mode: 'transform' })
  .replace(/^import[\s\S]*?;\n/gm, '')
  .replaceAll('export ', '');
const providerSource = readFileSync(
  new URL('../src/plugins/synced-lyrics/providers/index.ts', import.meta.url),
  'utf8',
);
const enumStart = providerSource.indexOf('export enum ProviderNames');
const enumEnd = providerSource.indexOf('\n}', enumStart) + 2;
assert(enumStart >= 0 && enumEnd > enumStart);
const enumCode = stripTypeScriptTypes(
  providerSource.slice(enumStart, enumEnd),
  { mode: 'transform' },
).replaceAll('export ', '');
const ProviderNames = (
  vm.runInThisContext(
    '(function(){' + enumCode + '\nreturn ProviderNames;})',
  ) as () => Record<string, string>
)();
const providerNames = Object.values(ProviderNames);
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

function fixture() {
  const maps: Map<unknown, unknown>[] = [];
  class ObservedMap extends Map<unknown, unknown> {
    constructor() {
      super();
      maps.push(this);
    }
  }
  const state = { current: '', proxy: false, autoComplete: true };
  const requests: Request[] = [];
  const providers = Object.fromEntries(
    providerNames.map((provider) => [
      provider,
      {
        search: (info: Info) => {
          let resolve!: (data: Data) => void;
          const promise = new Promise<Data>((done) => (resolve = done));
          const request = requests.length + 1;
          const data = { videoId: info.videoId, provider, request };
          const entry = {
            videoId: info.videoId,
            provider,
            request,
            resolve: () => resolve(data),
          };
          requests.push(entry);
          if (state.autoComplete) entry.resolve();
          return promise;
        },
      },
    ]),
  );
  type Bindings = {
    createStore: typeof createStore;
    getSongInfo: () => Info;
    config: () => { useYTMLyricsWithoutProxy: boolean };
    ProviderNames: typeof ProviderNames;
    providerNames: string[];
    providers: typeof providers;
    Map: typeof ObservedMap;
  };
  // Execute the actual isolated store in a fresh function. Imports are removed;
  // renderer/config/provider implementations are never loaded. The real Solid
  // server store and module objects share this realm, preserving store updates.
  const instantiate = vm.runInThisContext(
    '(function({createStore,getSongInfo,config,ProviderNames,providerNames,providers,Map}){' +
      isolated +
      '\nreturn {lyricsStore,currentLyrics,fetchLyrics,retrySearch,startLyricsSession,stopLyricsSession};})',
  ) as (bindings: Bindings) => LyricsModule;
  const module = instantiate({
    createStore,
    getSongInfo: () => ({ videoId: state.current }),
    config: () => ({ useYTMLyricsWithoutProxy: state.proxy }),
    ProviderNames,
    providerNames,
    providers,
    Map: ObservedMap,
  });
  const cache = maps[0] as Map<string, Cache>;
  const attempts = maps[1] as Map<string, number>;
  module.startLyricsSession();
  const play = (videoId: string) => {
    state.current = videoId;
    module.fetchLyrics({ videoId });
  };
  const complete = async (videoId: string) => {
    play(videoId);
    await flush();
  };
  const count = (videoId: string, provider = ProviderNames.YTMusic) =>
    requests.filter(
      (request) => request.videoId === videoId && request.provider === provider,
    ).length;
  return { module, state, cache, attempts, requests, play, complete, count };
}

test('oldest completed track refetches after capacity while recent track remains a hit', async () => {
  const f = fixture();
  for (let n = 0; n < 33; n++) await f.complete('track-' + n);
  const recent = f.count('track-31');
  await f.complete('track-31');
  assert.equal(f.count('track-31'), recent);
  await f.complete('track-0');
  assert.equal(f.count('track-0'), 2, 'Evicted oldest track must refetch');
  assert.equal(f.module.currentLyrics().data?.videoId, 'track-0');
  assert.equal(f.cache.size, 32);
});

test('owned completed hit becomes most recent before the next eviction', async () => {
  const f = fixture();
  for (let n = 0; n < 32; n++) await f.complete('track-' + n);
  await f.complete('track-0');
  await f.complete('track-32');
  assert.equal(f.cache.has('track-0'), true);
  assert.equal(f.cache.has('track-1'), false);
  await f.complete('track-0');
  assert.equal(f.count('track-0'), 1);
  await f.complete('track-1');
  assert.equal(f.count('track-1'), 2);
});

test('loading entries share the total bound and current entry survives every trim', async () => {
  const f = fixture();
  f.state.autoComplete = false;
  for (let n = 0; n < 40; n++) {
    f.play('pending-' + n);
    await flush();
    assert(f.cache.size <= 32, 'Loading entries count toward total capacity');
    assert.equal(f.cache.has(f.state.current), true);
  }
  assert.equal(f.cache.size, 32);
  assert.equal(f.cache.get('pending-39')?.state, 'loading');
  assert.equal(f.attempts.size, providerNames.length);
});

test('evicted pending completion cannot repopulate cache or overwrite current lyrics', async () => {
  const f = fixture();
  f.state.autoComplete = false;
  f.play('retired');
  await flush();
  const retired = f.cache.get('retired')!;
  const pending = [...f.requests];
  f.state.autoComplete = true;
  for (let n = 0; n < 33; n++) await f.complete('next-' + n);
  assert.equal(f.cache.has('retired'), false);
  for (const request of pending) request.resolve();
  await flush();
  assert.equal(f.cache.has('retired'), false);
  assert.equal(f.cache.size, 32);
  assert.equal(f.module.currentLyrics().data?.videoId, 'next-32');
  assert.equal(retired.state, 'loading');
  assert(
    Object.values(retired.data).every((value) => value.state === 'fetching'),
  );
});

test('A to B to A replaces pending ownership and old cleanup cannot delete the new cache', async () => {
  const f = fixture();
  f.state.autoComplete = false;
  f.play('A');
  await flush();
  const first = f.cache.get('A');
  const oldA = f.requests.filter((request) => request.videoId === 'A');
  f.play('B');
  await flush();
  f.play('A');
  await flush();
  const current = f.cache.get('A');
  assert.notEqual(current, first);
  for (const request of oldA) request.resolve();
  await flush();
  assert.equal(f.cache.get('A'), current);
  assert.equal(f.module.currentLyrics().state, 'fetching');
  const newA = f.requests.filter(
    (request) => request.videoId === 'A' && !oldA.includes(request),
  );
  for (const request of newA) request.resolve();
  await flush();
  assert.equal(f.module.currentLyrics().data?.request, newA[0].request);
  for (const request of f.requests.filter((request) => request.videoId === 'B'))
    request.resolve();
  await flush();
  assert.equal(f.cache.get('A'), current);
  assert.equal(f.module.currentLyrics().data?.videoId, 'A');
});

test('stop clears both maps and restart fetches fresh data despite old pending completion', async () => {
  const f = fixture();
  await f.complete('cached');
  f.state.autoComplete = false;
  f.play('pending');
  await flush();
  const old = f.requests.filter((request) => request.videoId === 'pending');
  f.module.stopLyricsSession();
  assert.equal(f.cache.size, 0);
  assert.equal(f.attempts.size, 0);
  old[0].resolve();
  await flush();
  assert.equal(f.cache.size, 0);
  assert.equal(f.module.currentLyrics().state, 'fetching');
  f.module.startLyricsSession();
  f.state.autoComplete = true;
  await f.complete('pending');
  const fresh = { ...f.module.lyricsStore.lyrics };
  for (const request of old.slice(1)) request.resolve();
  await flush();
  assert.deepEqual(f.module.lyricsStore.lyrics, fresh);
  assert.equal(f.count('pending'), 2);
  await f.complete('cached');
  assert.equal(f.count('cached'), 2);
  assert.equal(f.module.currentLyrics().data?.videoId, 'cached');
});

test('proxy mode refresh reuses completed providers and requeries only YTMusic', async () => {
  const f = fixture();
  await f.complete('A');
  const cache = f.cache.get('A');
  const previous = { ...f.module.lyricsStore.lyrics };
  f.state.proxy = true;
  await f.complete('A');
  assert.equal(f.cache.get('A'), cache);
  assert.equal(f.count('A'), 2);
  for (const provider of providerNames.filter(
    (name) => name !== ProviderNames.YTMusic,
  )) {
    assert.equal(f.count('A', provider), 1);
    assert.deepEqual(f.module.lyricsStore.lyrics[provider], previous[provider]);
  }
  assert.equal(f.cache.get('A')?.ytMusicWithoutProxy, true);
  assert.equal(f.module.currentLyrics().state, 'done');
});

test('retry of the current provider keeps the active cache and retires after a track change', async () => {
  const f = fixture();
  await f.complete('A');
  const cache = f.cache.get('A');
  f.state.autoComplete = false;
  f.module.retrySearch(ProviderNames.YTMusic, { videoId: 'A' });
  await flush();
  assert.equal(f.cache.get('A'), cache);
  assert.equal(f.cache.size, 1);
  assert.equal(f.count('A'), 2);
  assert.equal(f.module.currentLyrics().state, 'fetching');
  const retry = f.requests.at(-1)!;
  f.state.autoComplete = true;
  await f.complete('B');
  retry.resolve();
  await flush();
  f.module.retrySearch(ProviderNames.YTMusic, { videoId: 'A' });
  await flush();
  assert.equal(f.count('A'), 2);
  assert.equal(f.module.currentLyrics().data?.videoId, 'B');
});

test('unowned completed lookup does not gain recency before the song-info guard', async () => {
  const f = fixture();
  for (let n = 0; n < 32; n++) await f.complete('track-' + n);
  f.state.current = 'different-live-song';
  f.module.fetchLyrics({ videoId: 'track-0' });
  await flush();
  await f.complete('track-32');
  assert.equal(f.cache.has('track-0'), false);
  await f.complete('track-0');
  assert.equal(f.count('track-0'), 2);
});
