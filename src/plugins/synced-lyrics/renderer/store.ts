import { createStore } from 'solid-js/store';

import { getSongInfo } from '@/providers/song-info-front';

import { config } from './renderer';

import {
  ProviderNames,
  type ProviderName,
  providerNames,
  type ProviderState,
} from '../providers';
import { providers } from '../providers/renderer';

import type { SongInfo } from '@/providers/song-info';

type LyricsStore = {
  provider: ProviderName;
  current: ProviderState;
  lyrics: Record<ProviderName, ProviderState>;
};
interface SearchCache {
  state: 'loading' | 'done';
  data: LyricsStore['lyrics'];
  ytMusicWithoutProxy: boolean;
}
const ytMusicWithoutProxy = () => config()?.useYTMLyricsWithoutProxy === true;
const initialData = () =>
  providerNames.reduce(
    (data, name) => {
      data[name] = { state: 'fetching', data: null, error: null };
      return data;
    },
    {} as LyricsStore['lyrics'],
  );

export const [lyricsStore, setLyricsStore] = createStore<LyricsStore>({
  provider: providerNames[0],
  lyrics: initialData(),
  get current() {
    return this.lyrics[this.provider];
  },
});
// Derive in the consumer's owner: a memo disposed on disable must not survive
// into the next session with its previous track/provider value.
export const currentLyrics = () => lyricsStore.current;

const searchCache = new Map<string, SearchCache>();
const attempts = new Map<ProviderName, number>();
let generation = 0;
let nextAttempt = 0;
let running = false;
let currentVideoId: string | null = null;
const maxSearchCacheEntries = 32;
const touchSearchCache = (videoId: string, cache: SearchCache) => {
  searchCache.delete(videoId);
  searchCache.set(videoId, cache);
  for (const key of searchCache.keys()) {
    if (searchCache.size <= maxSearchCacheEntries) break;
    if (key !== currentVideoId) searchCache.delete(key);
  }
};

export const stopLyricsSession = () => {
  running = false;
  generation++;
  currentVideoId = null;
  attempts.clear();
  searchCache.clear();
  setLyricsStore('provider', providerNames[0]);
  setLyricsStore('lyrics', initialData());
};
export const startLyricsSession = () => {
  stopLyricsSession();
  running = true;
};

export const invalidateLyricsTrack = () => {
  generation++;
  currentVideoId = null;
  attempts.clear();
  setLyricsStore('lyrics', initialData());
};

const finishCache = (cache: SearchCache) => {
  cache.state = Object.values(cache.data).every(
    (value) => value.state !== 'fetching',
  )
    ? 'done'
    : 'loading';
};
const search = (provider: ProviderName, info: SongInfo, cache: SearchCache) => {
  const epoch = generation;
  const attempt = ++nextAttempt;
  attempts.set(provider, attempt);
  const isCurrent = () =>
    running &&
    generation === epoch &&
    currentVideoId === info.videoId &&
    getSongInfo().videoId === info.videoId &&
    attempts.get(provider) === attempt &&
    searchCache.get(info.videoId) === cache;
  const publish = (state: ProviderState) => {
    if (!isCurrent()) return;
    cache.data[provider] = state;
    finishCache(cache);
    setLyricsStore('lyrics', provider, state);
  };
  // Provider transport is not aborted; only its obsolete results are retired.
  return Promise.resolve()
    .then(() => providers[provider].search(info))
    .then(
      (data) => publish({ state: 'done', data, error: null }),
      (error: unknown) =>
        publish({
          state: 'error',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
};

export const fetchLyrics = (info: SongInfo) => {
  if (!running) return;
  const epoch = ++generation;
  attempts.clear();
  currentVideoId =
    typeof info.videoId === 'string' && info.videoId ? info.videoId : null;
  if (currentVideoId === null) {
    setLyricsStore('lyrics', initialData());
    return;
  }
  const previous = searchCache.get(info.videoId);
  if (previous?.state === 'done') {
    if (getSongInfo().videoId !== info.videoId) return;
    touchSearchCache(info.videoId, previous);
    const changed = previous.ytMusicWithoutProxy !== ytMusicWithoutProxy();
    if (changed) {
      previous.ytMusicWithoutProxy = ytMusicWithoutProxy();
      previous.state = 'loading';
      previous.data[ProviderNames.YTMusic] = {
        state: 'fetching',
        data: null,
        error: null,
      };
    }
    setLyricsStore(
      'lyrics',
      () => JSON.parse(JSON.stringify(previous.data)) as LyricsStore['lyrics'],
    );
    if (changed)
      search(ProviderNames.YTMusic, info, previous).catch(console.error);
    return;
  }
  // A pending old observation (including A -> B -> A or same-ID refresh) is
  // not a completed cache hit. Replace its ownership instead of timer polling.
  const cache: SearchCache = {
    state: 'loading',
    data: initialData(),
    ytMusicWithoutProxy: ytMusicWithoutProxy(),
  };
  touchSearchCache(info.videoId, cache);
  if (getSongInfo().videoId === info.videoId)
    setLyricsStore('lyrics', initialData());
  Promise.allSettled(
    providerNames.map((provider) => search(provider, info, cache)),
  ).then(() => {
    if (searchCache.get(info.videoId) !== cache) return;
    if (!running || generation !== epoch) {
      if (cache.state === 'loading') searchCache.delete(info.videoId);
      return;
    }
    finishCache(cache);
  });
};

export const retrySearch = (provider: ProviderName, info: SongInfo) => {
  if (
    !running ||
    !currentVideoId ||
    currentVideoId !== info.videoId ||
    getSongInfo().videoId !== info.videoId
  )
    return;
  const cache = searchCache.get(info.videoId);
  if (!cache) return;
  const state: ProviderState = { state: 'fetching', data: null, error: null };
  if (provider === ProviderNames.YTMusic)
    cache.ytMusicWithoutProxy = ytMusicWithoutProxy();
  cache.state = 'loading';
  cache.data[provider] = state;
  setLyricsStore('lyrics', provider, state);
  search(provider, info, cache).catch(console.error);
};
