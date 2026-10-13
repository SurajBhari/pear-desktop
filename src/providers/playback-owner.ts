import { isOwnerId, isRecord, isVideoId } from './queue-playlist';

import type { MusicPlayer } from '@/types/music-player';

export type PlaybackBinding = Readonly<{
  documentId: string;
  episodeId: string;
  videoId: string;
}>;
export type LegacyClockValue = PlaybackBinding & {
  elapsedMilliseconds: number;
};
export const playbackOwnerId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export function parsePlaybackBinding(value: unknown): PlaybackBinding | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !isOwnerId(value.documentId) ||
    !isOwnerId(value.episodeId) ||
    !isVideoId(value.videoId)
  )
    return null;
  return Object.freeze({
    documentId: value.documentId,
    episodeId: value.episodeId,
    videoId: value.videoId,
  });
}
export const samePlaybackBinding = (
  a: PlaybackBinding | null | undefined,
  b: PlaybackBinding | null | undefined,
) =>
  !!a &&
  !!b &&
  a.documentId === b.documentId &&
  a.episodeId === b.episodeId &&
  a.videoId === b.videoId;
export const nativeElapsedMilliseconds = (seconds: unknown) => {
  if (typeof seconds !== 'number' || seconds < 0) return undefined;
  const milliseconds = seconds * 1000;
  return Number.isFinite(seconds) && Number.isFinite(milliseconds)
    ? milliseconds
    : undefined;
};
export const nativePlaybackIdentity = (api: MusicPlayer) => {
  const id = api.getVideoData()?.video_id;
  return isVideoId(id) && api.getPlayerResponse()?.videoDetails?.videoId === id
    ? id
    : undefined;
};

let owner: ReturnType<typeof buildPlaybackOwner> | undefined;
let adoptionRevision = 0;
const documentId = playbackOwnerId();
function buildPlaybackOwner(api: MusicPlayer) {
  let episodeId = playbackOwnerId(),
    retired = false;
  const observers = new Set<
    (binding: { documentId: string; episodeId: string }) => void
  >();
  const isCurrent = () =>
    !retired &&
    owner?.api === api &&
    (api as MusicPlayer & Partial<HTMLElement>).isConnected !== false;
  const rotate = () => {
    const previous = { documentId, episodeId };
    episodeId = playbackOwnerId();
    for (const observer of observers) observer(previous);
  };
  const binding = (videoId: string, expected?: PlaybackBinding) => {
    const captured = episodeId;
    try {
      if (!isCurrent() || nativePlaybackIdentity(api) !== videoId) return null;
      const value = Object.freeze({ documentId, episodeId: captured, videoId });
      if (
        !isCurrent() ||
        captured !== episodeId ||
        (expected && !samePlaybackBinding(value, expected)) ||
        nativePlaybackIdentity(api) !== videoId ||
        !isCurrent() ||
        captured !== episodeId
      )
        return null;
      return value;
    } catch {
      return null;
    }
  };
  const clock = (expected: PlaybackBinding): LegacyClockValue | null => {
    if (!binding(expected.videoId, expected)) return null;
    try {
      const milliseconds = nativeElapsedMilliseconds(api.getCurrentTime());
      if (milliseconds === undefined || !binding(expected.videoId, expected))
        return null;
      return { ...expected, elapsedMilliseconds: milliseconds };
    } catch {
      return null;
    }
  };
  const dispose = () => {
    if (retired) return;
    retired = true;
    rotate();
    api.removeEventListener('videodatachange', rotate);
    window.removeEventListener('pagehide', dispose);
    observers.clear();
  };
  api.addEventListener('videodatachange', rotate);
  window.addEventListener('pagehide', dispose);
  return {
    api,
    binding,
    clock,
    isCurrent,
    dispose,
    subscribeRetirement(
      observer: (binding: { documentId: string; episodeId: string }) => void,
    ) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}
/** Metadata lifecycle owns this passive observer; no plugin polling or catalog prerequisite. */
export function adoptPlaybackOwner(api: MusicPlayer) {
  if (owner?.api === api && owner.isCurrent()) return owner;
  const revision = ++adoptionRevision;
  const previous = owner;
  owner = undefined;
  previous?.dispose();
  const candidate = buildPlaybackOwner(api);
  if (revision !== adoptionRevision) candidate.dispose();
  else owner = candidate;
  return candidate;
}
export const getPlaybackOwner = (api: MusicPlayer) =>
  owner?.api === api && owner.isCurrent() ? owner : undefined;
