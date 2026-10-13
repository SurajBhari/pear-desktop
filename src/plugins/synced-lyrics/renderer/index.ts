import { getSongInfo } from '@/providers/song-info-front';
import { createRenderer } from '@/utils';

import { resetLyricsPickerSelection } from './components/LyricsPicker';
import { disposeReactiveRoot } from './reactive-root';
import {
  config as currentConfig,
  setConfig,
  setCurrentTime,
  startLyricsEffects,
} from './renderer';
import {
  currentLyrics,
  fetchLyrics,
  invalidateLyricsTrack,
  retrySearch,
  startLyricsSession,
  stopLyricsSession,
} from './store';
import {
  disposeLyricsView,
  selectors,
  startLyricsView,
  tabStates,
  waitForLyricsElement,
} from './utils';

import { ProviderNames } from '../providers';

import type { SyncedLyricsPluginConfig } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export let _ytAPI: MusicPlayer | null = null;
const unavailableFetch = (): Promise<
  [number, string, Record<string, string>]
> => Promise.reject(new Error('Lyrics renderer is stopped'));
export let netFetch: (
  url: string,
  init?: RequestInit,
) => Promise<[number, string, Record<string, string>]> = unavailableFetch;

export type LyricsExportStatus = 'saved' | 'cancelled' | 'invalid' | 'error';
const unavailableExport = (): Promise<LyricsExportStatus> =>
  Promise.resolve('cancelled');
export let exportCurrentLyrics: () => Promise<LyricsExportStatus> =
  unavailableExport;

const verifiedApiVideoId = (api: MusicPlayer): string | null => {
  try {
    const id = api.getVideoData?.()?.video_id;
    return typeof id === 'string' &&
      id &&
      api.getPlayerResponse?.()?.videoDetails?.videoId === id
      ? id
      : null;
  } catch {
    return null;
  }
};

export const renderer = createRenderer<
  {
    generation: number;
    active: boolean;
    observerCallback: MutationCallback;
    observer?: MutationObserver;
    headerController?: AbortController;
    apiHandler?: (...args: unknown[]) => void;
    nativeVideoId?: string | null;
    unsubscribe?: () => void;
    releasePlayer: () => void;
    stop: () => void;
    videoDataChange: () => Promise<void>;
    updateTimestampInterval?: ReturnType<typeof setInterval>;
  },
  SyncedLyricsPluginConfig
>({
  generation: 0,
  active: false,
  onConfigChange(newConfig) {
    if (!this.active) return;
    const changed =
      (currentConfig()?.useYTMLyricsWithoutProxy === true) !==
      (newConfig.useYTMLyricsWithoutProxy === true);
    setConfig(newConfig);
    if (!changed || !_ytAPI) return;
    const song = getSongInfo();
    if (
      verifiedApiVideoId(_ytAPI) === song.videoId &&
      (this.nativeVideoId === undefined || this.nativeVideoId === song.videoId)
    )
      retrySearch(ProviderNames.YTMusic, song);
  },
  observerCallback(mutations) {
    for (const mutation of mutations) {
      const header = mutation.target as HTMLElement;
      if (mutation.attributeName === 'disabled')
        header.removeAttribute('disabled');
      else if (mutation.attributeName === 'aria-selected')
        tabStates[header.ariaSelected ?? 'false']?.();
    }
  },
  releasePlayer() {
    this.headerController?.abort();
    this.headerController = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    if (_ytAPI && this.apiHandler)
      _ytAPI.removeEventListener('videodatachange', this.apiHandler);
    this.apiHandler = undefined;
    if (this.updateTimestampInterval !== undefined)
      clearInterval(this.updateTimestampInterval);
    this.updateTimestampInterval = undefined;
    disposeLyricsView();
    _ytAPI = null;
  },
  async onPlayerApiReady(api) {
    if (!this.active) return;
    const previousApi = _ytAPI;
    // A same-API UI remount cannot undo native B/unknown observations. A new
    // API needs its own agreeing identity; only initial unobserved bootstrap
    // may accept song metadata without that evidence.
    const nativeVideoId =
      previousApi === api
        ? this.nativeVideoId
        : previousApi
          ? verifiedApiVideoId(api)
          : (verifiedApiVideoId(api) ?? undefined);
    if (
      (previousApi && previousApi !== api) ||
      (!previousApi && nativeVideoId && getSongInfo().videoId !== nativeVideoId)
    )
      invalidateLyricsTrack();
    this.releasePlayer();
    _ytAPI = api;
    this.nativeVideoId = nativeVideoId;
    startLyricsView();
    const handler = (...args: unknown[]) => {
      if (!this.active || _ytAPI !== api || this.apiHandler !== handler) return;
      const [name, value] = args;
      const id =
        value &&
        typeof value === 'object' &&
        'videoId' in value &&
        typeof value.videoId === 'string' &&
        value.videoId
          ? value.videoId
          : null;
      if (
        id === null ||
        name === 'dataloaded' ||
        getSongInfo().videoId !== id ||
        (this.nativeVideoId !== undefined && id !== this.nativeVideoId)
      )
        invalidateLyricsTrack();
      this.nativeVideoId = id;
      this.videoDataChange().catch(console.error);
    };
    this.apiHandler = handler;
    api.addEventListener('videodatachange', this.apiHandler);
    await this.videoDataChange();
  },
  async videoDataChange() {
    const api = _ytAPI;
    if (!this.active || !api) return;
    const generation = this.generation;
    if (this.updateTimestampInterval === undefined)
      this.updateTimestampInterval = setInterval(() => {
        if (this.active && this.generation === generation && _ytAPI === api)
          setCurrentTime(api.getCurrentTime() * 1000);
      }, 100);
    this.headerController?.abort();
    const controller = new AbortController();
    this.headerController = controller;
    this.observer ??= new MutationObserver((mutations, observer) => {
      if (this.active && this.generation === generation && _ytAPI === api)
        this.observerCallback(mutations, observer);
    });
    this.observer.disconnect();
    const header = await waitForLyricsElement<HTMLElement>(
      selectors.head,
      controller.signal,
    );
    if (
      !header ||
      controller.signal.aborted ||
      !this.active ||
      this.generation !== generation ||
      _ytAPI !== api
    )
      return;
    header.removeAttribute('disabled');
    tabStates[header.ariaSelected ?? 'false']?.();
    this.observer.observe(header, { attributes: true });
  },
  async start(ctx: RendererContext<SyncedLyricsPluginConfig>) {
    this.stop();
    this.active = true;
    const generation = this.generation;
    try {
      const config = await ctx.getConfig();
      if (!this.active || this.generation !== generation) return;
      if (!ctx.ipc.subscribe)
        throw new Error('Lyrics renderer requires owned IPC subscriptions');
      netFetch = ctx.ipc.invoke.bind(ctx.ipc, 'synced-lyrics:fetch');
      exportCurrentLyrics = async () => {
        const song = getSongInfo();
        const selected = currentLyrics();
        if (
          !this.active ||
          this.generation !== generation ||
          !_ytAPI ||
          verifiedApiVideoId(_ytAPI) !== song.videoId ||
          (this.nativeVideoId !== undefined &&
            this.nativeVideoId !== song.videoId) ||
          selected.state !== 'done' ||
          !selected.data
        )
          return 'cancelled';
        try {
          return (await ctx.ipc.invoke('synced-lyrics:export', {
            videoId: song.videoId,
            result: JSON.parse(JSON.stringify(selected.data)),
            offsetMs: currentConfig()?.timingOffsetMs,
            enhanced: currentConfig()?.enhancedLrc === true,
          })) as LyricsExportStatus;
        } catch {
          return 'error';
        }
      };
      setConfig(config);
      startLyricsSession();
      startLyricsEffects();
      startLyricsView();
      this.unsubscribe = ctx.ipc.subscribe(
        'peard:update-song-info',
        (info: SongInfo) => {
          if (
            this.active &&
            this.generation === generation &&
            (this.nativeVideoId === undefined ||
              this.nativeVideoId === info.videoId)
          )
            fetchLyrics(info);
        },
      );
    } catch (error) {
      if (this.generation === generation) this.stop();
      throw error;
    }
  },
  stop() {
    this.active = false;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.releasePlayer();
    this.nativeVideoId = undefined;
    stopLyricsSession();
    resetLyricsPickerSelection();
    setConfig(null);
    setCurrentTime(-1);
    disposeReactiveRoot();
    netFetch = unavailableFetch;
    exportCurrentLyrics = unavailableExport;
  },
});
