import { serve } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { t } from 'i18next';

import {
  MediaType,
  registerCallback,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import type { AmuseSongInfo } from './types';

const amusePort = 9863;

const seconds = (value: number | undefined) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
const humanTime = (value: number) =>
  `${Math.floor(value / 60)}:${(value % 60).toString().padStart(2, '0')}`;

// Complete 6K Labs contract adapted from upstream #4721 (@aashish254).
const formatSongInfo = (info: SongInfo): AmuseSongInfo => {
  const hasSong = !!(info.artist && info.title);
  const elapsed = hasSong ? seconds(info.elapsedSeconds) : 0;
  const duration = hasSong ? seconds(info.songDuration) : 0;
  return {
    player: {
      hasSong,
      isPaused: hasSong ? (info.isPaused ?? false) : true,
      volumePercent: 0,
      seekbarCurrentPosition: elapsed,
      seekbarCurrentPositionHuman: humanTime(elapsed),
      statePercent:
        duration > 0
          ? Math.min(100, Math.round((elapsed / duration) * 100))
          : 0,
      likeStatus: 'INDIFFERENT',
      repeatType: 'NONE',
    },
    track: {
      duration,
      durationHuman: humanTime(duration),
      title: hasSong ? info.title : '',
      author: hasSong ? info.artist : '',
      album: hasSong ? (info.album ?? '') : '',
      cover: hasSong ? (info.imageSrc ?? '') : '',
      url: hasSong ? (info.url ?? '') : '',
      id: hasSong ? (info.videoId ?? '') : '',
      isVideo:
        hasSong &&
        [
          MediaType.OriginalMusicVideo,
          MediaType.UserGeneratedContent,
          MediaType.OtherVideo,
        ].includes(info.mediaType),
      isAdvertisement: false,
      inLibrary: false,
    },
  };
};

export default createBackend({
  currentSongInfo: {} as SongInfo,
  app: null as Hono | null,
  server: null as ReturnType<typeof serve> | null,
  start() {
    registerCallback((songInfo) => {
      this.currentSongInfo = songInfo;
    });

    this.app = new Hono();
    this.app.use('*', cors());
    this.app.get('/', (ctx) =>
      ctx.body(t('plugins.amuse.response.query'), 200),
    );

    const queryAndApiHandler = (ctx: Context) => {
      return ctx.json(formatSongInfo(this.currentSongInfo), 200);
    };

    this.app.get('/query', queryAndApiHandler);
    this.app.get('/api', queryAndApiHandler);

    try {
      this.server = serve({
        fetch: this.app.fetch.bind(this.app),
        port: amusePort,
      });
    } catch (err) {
      console.error(err);
    }
  },

  stop() {
    if (this.server) {
      this.server?.close();
    }
  },
});
