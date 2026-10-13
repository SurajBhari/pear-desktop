import { ipcMain } from 'electron';
import is from 'electron-is';

import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { sortSegments } from './segments';

import type { Segment } from './types';
import type { GetPlayerResponse } from '@/types/get-player-response';
import type { MusicPlayer } from '@/types/music-player';

export type SponsorBlockPluginConfig = {
  enabled: boolean;
  apiURL: string;
  categories: (
    | 'sponsor'
    | 'intro'
    | 'outro'
    | 'interaction'
    | 'selfpromo'
    | 'music_offtopic'
  )[];
};

type SegmentResponse = { videoId: string; requestId: number } & (
  | { phase: 'begin' }
  | { phase: 'result'; segments: Segment[] }
);
type RendererState = {
  video: HTMLVideoElement | null;
  playerApi: MusicPlayer | undefined;
  unsubscribe: (() => void) | undefined;
  applySegments(target: HTMLVideoElement): void;
  timeUpdateListener(this: void, event: Event): void;
  metadataListener(this: void, event: Event): void;
  emptyListener(this: void, event: Event): void;
  resetSegments(this: void): void;
  stop(): void;
};
let backendEpoch = 0;
let requestEpoch = 0;
let requestController: AbortController | undefined;
let removeBackendListener: (() => void) | undefined;
let rendererEpoch = 0;
let rendererActive = false;
let currentSegments: Segment[] = [];
let segmentVideoId = '';
let observedVideoId = '';
let currentRequestId = 0;
let mediaReady = false;

const stopBackend = () => {
  backendEpoch++;
  requestEpoch++;
  requestController?.abort();
  requestController = undefined;
  removeBackendListener?.();
  removeBackendListener = undefined;
};

const normalizeSegments = (data: unknown): Segment[] => {
  if (!Array.isArray(data) || data.length > 10000) return [];
  const segments: Segment[] = [];
  for (const submission of data) {
    if (
      !submission ||
      typeof submission !== 'object' ||
      !('segment' in submission)
    )
      continue;
    const segment = submission.segment;
    if (
      !Array.isArray(segment) ||
      segment.length !== 2 ||
      typeof segment[0] !== 'number' ||
      typeof segment[1] !== 'number' ||
      !Number.isFinite(segment[0]) ||
      !Number.isFinite(segment[1]) ||
      segment[0] < 0 ||
      segment[1] <= segment[0]
    )
      continue;
    segments.push([segment[0], segment[1]]);
  }
  return sortSegments(segments);
};

export default createPlugin<
  unknown,
  unknown,
  RendererState,
  SponsorBlockPluginConfig
>({
  name: () => t('plugins.sponsorblock.name'),
  description: () => t('plugins.sponsorblock.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    apiURL: 'https://sponsor.ajay.app',
    categories: [
      'sponsor',
      'intro',
      'outro',
      'interaction',
      'selfpromo',
      'music_offtopic',
    ],
  } as SponsorBlockPluginConfig,
  backend: {
    async start({ getConfig, ipc, window }) {
      stopBackend();
      const epoch = backendEpoch;
      const config = await getConfig();
      if (epoch !== backendEpoch) return;
      const listener = async (
        event: Electron.IpcMainEvent,
        data: GetPlayerResponse,
      ) => {
        if (epoch !== backendEpoch || event.sender !== window.webContents)
          return;
        requestController?.abort();
        const request = ++requestEpoch;
        const controller = new AbortController();
        requestController = controller;
        const videoId = data?.videoDetails?.videoId;
        if (typeof videoId !== 'string' || !videoId || videoId.length > 128) {
          ipc.send('sponsorblock-skip', {
            phase: 'begin',
            videoId: '',
            requestId: request,
          });
          return;
        }
        // Fence the preceding video before the network result can arrive.
        ipc.send('sponsorblock-skip', {
          phase: 'begin',
          videoId,
          requestId: request,
        });
        let segments: Segment[] = [];
        try {
          const url = new URL(
            `${config.apiURL.replace(/\/$/, '')}/api/skipSegments`,
          );
          url.searchParams.set('videoID', videoId);
          url.searchParams.set('categories', JSON.stringify(config.categories));
          const response = await fetch(url.toString(), {
            signal: controller.signal,
            redirect: 'follow',
          });
          if (response.status === 200)
            segments = normalizeSegments(await response.json());
        } catch (error) {
          if (!controller.signal.aborted && is.dev())
            console.log('error on sponsorblock request:', error);
        }
        if (
          controller.signal.aborted ||
          epoch !== backendEpoch ||
          request !== requestEpoch ||
          window.isDestroyed?.()
        )
          return;
        ipc.send('sponsorblock-skip', {
          phase: 'result',
          videoId,
          segments,
          requestId: request,
        });
      };
      ipcMain.on('peard:video-src-changed', listener);
      removeBackendListener = () =>
        ipcMain.removeListener('peard:video-src-changed', listener);
    },
    stop: stopBackend,
  },
  renderer: {
    video: null as HTMLVideoElement | null,
    playerApi: undefined as MusicPlayer | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    applySegments(target: HTMLVideoElement) {
      if (
        !rendererActive ||
        target !== this.video ||
        !mediaReady ||
        !observedVideoId ||
        segmentVideoId !== observedVideoId
      )
        return;
      try {
        if (
          this.playerApi?.getVideoData?.()?.video_id !== observedVideoId ||
          this.playerApi?.getPlayerResponse?.()?.videoDetails?.videoId !==
            observedVideoId
        )
          return;
      } catch {
        return;
      }
      for (const [start, end] of currentSegments) {
        if (target.currentTime >= start && target.currentTime < end) {
          target.currentTime = end;
          break;
        }
      }
    },
    timeUpdateListener: (_event: Event) => {},
    metadataListener: (_event: Event) => {},
    emptyListener: (_event: Event) => {},
    resetSegments: () => {
      currentSegments = [];
      segmentVideoId = '';
      observedVideoId = '';
      currentRequestId = 0;
      mediaReady = false;
    },
    start({ ipc }) {
      this.stop();
      if (!ipc.subscribe)
        throw new Error('SponsorBlock requires an owned IPC subscription');
      rendererActive = true;
      const epoch = rendererEpoch;
      const receive = (packet: SegmentResponse) => {
        if (
          !rendererActive ||
          epoch !== rendererEpoch ||
          !packet ||
          !Number.isSafeInteger(packet.requestId) ||
          packet.requestId <= 0 ||
          typeof packet.videoId !== 'string'
        )
          return;
        if (packet.phase === 'begin') {
          if (packet.requestId <= currentRequestId) return;
          currentRequestId = packet.requestId;
          observedVideoId = packet.videoId;
          segmentVideoId = '';
          currentSegments = [];
          return;
        }
        if (
          packet.phase !== 'result' ||
          packet.requestId !== currentRequestId ||
          packet.videoId !== observedVideoId ||
          !Array.isArray(packet.segments) ||
          packet.segments.length > 10000
        )
          return;
        currentSegments = normalizeSegments(
          packet.segments.map((segment) => ({ segment })),
        );
        segmentVideoId = packet.videoId;
        if (this.video) this.applySegments(this.video);
      };
      this.unsubscribe = ipc.subscribe('sponsorblock-skip', receive);
    },
    onPlayerApiReady(playerApi: MusicPlayer, { ipc }) {
      if (!rendererActive) return;
      this.video?.removeEventListener('timeupdate', this.timeUpdateListener);
      this.video?.removeEventListener('emptied', this.emptyListener);
      this.video?.removeEventListener('loadedmetadata', this.metadataListener);
      this.resetSegments();
      this.playerApi = playerApi;
      this.video = document.querySelector<HTMLVideoElement>('video');
      const video = this.video;
      const epoch = rendererEpoch;
      mediaReady = (video?.readyState ?? 0) > 0;
      this.timeUpdateListener = (event: Event) => {
        if (event.target instanceof HTMLVideoElement)
          this.applySegments(event.target);
      };
      this.emptyListener = (event: Event) => {
        if (
          rendererActive &&
          epoch === rendererEpoch &&
          event.target === this.video
        )
          mediaReady = false;
      };
      this.metadataListener = (event: Event) => {
        if (
          !rendererActive ||
          epoch !== rendererEpoch ||
          video !== this.video ||
          event.target !== video
        )
          return;
        mediaReady = (video?.readyState ?? 0) > 0;
        if (video) this.applySegments(video);
      };
      this.video?.addEventListener('timeupdate', this.timeUpdateListener);
      this.video?.addEventListener('emptied', this.emptyListener);
      this.video?.addEventListener('loadedmetadata', this.metadataListener);
      // Seed the current track when enabled after playback has already started (#4637).
      ipc.send('peard:video-src-changed', playerApi.getPlayerResponse());
    },
    stop() {
      rendererActive = false;
      rendererEpoch++;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.video?.removeEventListener('timeupdate', this.timeUpdateListener);
      this.video?.removeEventListener('emptied', this.emptyListener);
      this.video?.removeEventListener('loadedmetadata', this.metadataListener);
      this.resetSegments();
      this.video = null;
      this.playerApi = undefined;
    },
  },
});
