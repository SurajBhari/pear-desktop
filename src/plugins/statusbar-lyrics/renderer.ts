import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  untrack,
} from 'solid-js';

import { t } from '@/i18n';
import { _ytAPI } from '@/plugins/synced-lyrics/renderer';
import {
  config as lyricsConfig,
  currentTime,
} from '@/plugins/synced-lyrics/renderer/renderer';
import { currentLyrics } from '@/plugins/synced-lyrics/renderer/store';
import {
  convertChineseCharacter,
  romanize,
} from '@/plugins/synced-lyrics/renderer/utils';
import { getSongInfo } from '@/providers/song-info-front';
import { createRenderer } from '@/utils';

import { statusLength, type StatusbarLyricsPluginConfig } from './config';
import { statusDisplayTime, statusLine } from './line';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

type Payload = { key: string; text: string; length: number };
type Display = {
  text: string;
  id: string;
  length: number;
  pronunciation: boolean;
};
type Owner = {
  context: RendererContext<StatusbarLyricsPluginConfig>;
  disposed: boolean;
  token?: string;
  api?: MusicPlayer;
  nativeId?: string | null;
  releaseApi?: () => void;
  disposeRoot?: () => void;
  revise: () => void;
  settings: () => StatusbarLyricsPluginConfig | null;
  setSettings: (value: StatusbarLyricsPluginConfig) => void;
  desired?: Payload;
  acknowledged?: string;
  sending: boolean;
};
let active: Owner | undefined;
const current = (owner: Owner) => active === owner && !owner.disposed;
const verifiedId = (api: MusicPlayer | undefined) => {
  try {
    const id = api?.getVideoData?.()?.video_id;
    return typeof id === 'string' &&
      id &&
      api?.getPlayerResponse?.()?.videoDetails?.videoId === id
      ? id
      : null;
  } catch {
    return null;
  }
};
const flush = async (owner: Owner) => {
  if (owner.sending || !owner.token) return;
  owner.sending = true;
  try {
    while (
      current(owner) &&
      owner.desired &&
      owner.desired.key !== owner.acknowledged
    ) {
      const payload = owner.desired;
      try {
        const accepted: unknown = payload.text
          ? await owner.context.ipc.invoke(
              'statusbar-lyrics:set-text',
              owner.token,
              payload.text,
              payload.length,
            )
          : await owner.context.ipc.invoke(
              'statusbar-lyrics:clear',
              owner.token,
            );
        if (!current(owner)) return;
        if (accepted !== true) throw new Error('Status lyrics session retired');
        owner.acknowledged = payload.key;
      } catch {
        if (!current(owner)) return;
        console.warn(t('plugins.statusbar-lyrics.failed'));
        // A newer clear/text owns the next delivery even when this send fails.
        // Never spin on the same failed payload or a rejected native lease.
        if (owner.desired?.key === payload.key) break;
      }
    }
  } catch {
    if (current(owner)) console.warn(t('plugins.statusbar-lyrics.failed'));
  } finally {
    owner.sending = false;
  }
};
const publish = (owner: Owner, text: string, limit?: number) => {
  if (!current(owner)) return;
  const length =
    limit ?? untrack(() => statusLength(owner.settings()?.maxLength));
  owner.desired = { key: JSON.stringify([length, text]), text, length };
  flush(owner).catch(() => {});
};
const adopt = (owner: Owner, api: MusicPlayer) => {
  if (!current(owner)) return;
  if (owner.api === api) {
    owner.revise();
    return;
  }
  const previous = owner.api;
  owner.releaseApi?.();
  owner.api = api;
  owner.nativeId = verifiedId(api) ?? (previous ? null : undefined);
  const changed = (...args: unknown[]) => {
    if (!current(owner) || owner.api !== api) return;
    const detail =
      args[0] && typeof args[0] === 'object' && 'detail' in args[0]
        ? args[0].detail
        : undefined;
    const [, value] = Array.isArray(detail) ? detail : args;
    owner.nativeId =
      value &&
      typeof value === 'object' &&
      'videoId' in value &&
      typeof value.videoId === 'string' &&
      value.videoId === verifiedId(api)
        ? value.videoId
        : null;
    owner.revise();
  };
  api.addEventListener('videodatachange', changed);
  owner.releaseApi = () => api.removeEventListener('videodatachange', changed);
  owner.revise();
};

const stop = () => {
  const owner = active;
  if (!owner) return;
  active = undefined;
  owner.disposed = true;
  owner.disposeRoot?.();
  owner.releaseApi?.();
  if (owner.token)
    owner.context.ipc
      .invoke('statusbar-lyrics:clear', owner.token)
      .catch(() => {});
};

export const renderer = createRenderer<unknown, StatusbarLyricsPluginConfig>({
  async start(context) {
    stop();
    const [settings, setSettings] =
      createSignal<StatusbarLyricsPluginConfig | null>(null);
    const [revision, setRevision] = createSignal(0);
    const owner: Owner = {
      context,
      disposed: false,
      settings,
      setSettings,
      sending: false,
      revise: () => setRevision((value) => value + 1),
    };
    active = owner;
    try {
      const cfg = await context.getConfig();
      if (!current(owner)) return;
      setSettings(cfg);
      const token: unknown = await context.ipc.invoke(
        'statusbar-lyrics:session',
      );
      if (!current(owner)) return;
      if (typeof token !== 'string' || !token) {
        stop();
        return;
      }
      owner.token = token;
      if (_ytAPI) adopt(owner, _ytAPI);
      createRoot((dispose) => {
        owner.disposeRoot = dispose;
        const display = createMemo<Display | null>(
          () => {
            revision();
            const cfg = settings();
            const shared = lyricsConfig();
            const state = currentLyrics();
            const mediaMs = currentTime();
            const info = getSongInfo();
            const id = verifiedId(owner.api);
            const durationMs = info.songDuration * 1000;
            if (
              !current(owner) ||
              !cfg?.enabled ||
              !shared?.enabled ||
              owner.api !== _ytAPI ||
              !id ||
              (owner.nativeId !== undefined && id !== owner.nativeId) ||
              id !== info.videoId ||
              state.state !== 'done' ||
              mediaMs < 0 ||
              (Number.isFinite(durationMs) &&
                durationMs > 0 &&
                mediaMs >= durationMs)
            ) {
              return null;
            }
            const offset =
              'timingOffsetMs' in shared ? shared.timingOffsetMs : 0;
            const raw = statusLine(
              state.data?.lines,
              statusDisplayTime(mediaMs, offset),
              durationMs,
            );
            const conversion = shared.convertChineseCharacter;
            const text =
              raw && conversion && conversion !== 'disabled'
                ? convertChineseCharacter(raw, conversion)
                : raw;
            return {
              text,
              id,
              length: statusLength(cfg.maxLength),
              pronunciation: cfg.includePronunciation,
            };
          },
          null,
          {
            equals: (previous, next) =>
              previous === next ||
              (!!previous &&
                !!next &&
                previous.id === next.id &&
                previous.text === next.text &&
                previous.length === next.length &&
                previous.pronunciation === next.pronunciation),
          },
        );
        createEffect(() => {
          const value = display();
          if (!value) return publish(owner, '');
          const { text, id, length } = value;
          publish(owner, text, length);
          if (!text || !value.pronunciation) return;
          let alive = true;
          onCleanup(() => {
            alive = false;
          });
          romanize(text)
            .then((pronunciation) => {
              if (
                alive &&
                current(owner) &&
                verifiedId(owner.api) === id &&
                getSongInfo().videoId === id &&
                pronunciation.trim() &&
                pronunciation !== text
              )
                publish(owner, `${text} · ${pronunciation}`, length);
            })
            .catch(() => {});
        });
      });
    } catch (error) {
      if (current(owner)) stop();
      throw error;
    }
  },
  onPlayerApiReady(api) {
    if (active) adopt(active, api);
  },
  onConfigChange(config) {
    active?.setSettings(config);
  },
  stop,
});
