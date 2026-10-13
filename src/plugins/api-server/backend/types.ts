import { type serve } from '@hono/node-server';
import { type OpenAPIHono as Hono } from '@hono/zod-openapi';

import type { APIServerConfig } from '../config';
import type { MusicGrantStore } from './music-grant-store';
import type { MusicService } from './music-service';
import type { SongInfo } from '@/providers/song-info';
import type { BackendContext } from '@/types/contexts';
import type { RepeatMode, VolumeState } from '@/types/datahost-get-state';
import type { BrowserWindow } from 'electron';

export type HonoApp = Hono<{
  Variables: { playlistQueueSignal?: AbortSignal };
}>;
export type BackendType = {
  app?: HonoApp;
  server?: ReturnType<typeof serve>;
  oldConfig?: APIServerConfig;
  songInfo?: SongInfo;
  startRevision?: number;
  unsubscribeSongInfo?: () => void;
  queueRequestScope?: AbortController;
  currentRepeatMode?: RepeatMode;
  volumeState?: VolumeState;
  musicWindow?: BrowserWindow;
  musicConfig?: APIServerConfig;
  musicConfigRevision?: number;
  musicService?: MusicService;
  musicGrants?: MusicGrantStore;
  configureMusic(config: APIServerConfig): void;

  init: (ctx: BackendContext<APIServerConfig>) => void;
  run: (config: APIServerConfig) => void;
  end: () => void;
};
