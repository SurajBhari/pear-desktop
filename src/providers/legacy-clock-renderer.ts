import {
  getPlaybackOwner,
  parsePlaybackBinding,
  type PlaybackBinding,
} from './playback-owner';
import { isOwnerId, isRecord, isRequestId } from './queue-playlist';

import type { APIServerConfig } from '@/plugins/api-server/config';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

type Job = {
  requestId: string;
  nonce: string;
  binding: PlaybackBinding;
  canceled: boolean;
};
export function createLegacyClockRendererController(
  api: MusicPlayer,
  getApi: () => MusicPlayer | null,
  ipc: RendererContext<APIServerConfig>['ipc'],
) {
  if (!ipc.subscribe)
    return { dispose() {}, stats: () => ({ challenges: 0, active: 0 }) };
  let disposed = false;
  const challenges = new Map<string, Job>(),
    active = new Map<string, Job>(),
    releases: (() => void)[] = [];
  const current = () => !disposed && getApi() === api;
  const send = (packet: object) => {
    try {
      ipc.send('peard:legacy-clock-reply', packet);
    } catch {
      /* Document retirement. */
    }
  };
  let observedOwner: ReturnType<typeof getPlaybackOwner>,
    releaseOwner: (() => void) | undefined;
  const observeOwner = () => {
    const playbackOwner = getPlaybackOwner(api);
    if (playbackOwner === observedOwner) return;
    releaseOwner?.();
    observedOwner = playbackOwner;
    releaseOwner = playbackOwner?.subscribeRetirement(
      ({ documentId, episodeId }) =>
        send({ type: 'retire', documentId, sourceId: episodeId }),
    );
  };
  observeOwner();
  releases.push(() => releaseOwner?.());
  const matches = (job: Job, packet: Record<string, unknown>) =>
    job.nonce === packet.nonce &&
    job.binding.documentId === packet.documentId &&
    job.binding.episodeId === packet.sourceId;
  const subscribe = (channel: string, fn: (packet: unknown) => void) => {
    if (!ipc.subscribe)
      throw new Error('Owned clock subscriptions unavailable');
    releases.push(ipc.subscribe(channel, fn));
  };
  subscribe('peard:legacy-clock-owner-query', (packet) => {
    if (
      !isRecord(packet) ||
      !isRequestId(packet.requestId) ||
      !isOwnerId(packet.nonce)
    )
      return;
    observeOwner();
    const binding = parsePlaybackBinding(packet.binding);
    if (
      !binding ||
      !current() ||
      !getPlaybackOwner(api)?.binding(binding.videoId, binding)
    ) {
      send({
        requestId: packet.requestId,
        nonce: packet.nonce,
        type: 'unavailable',
      });
      return;
    }
    if (challenges.has(packet.requestId) || challenges.size + active.size >= 12)
      return;
    const job: Job = {
      requestId: packet.requestId,
      nonce: packet.nonce,
      binding,
      canceled: false,
    };
    challenges.set(job.requestId, job);
    send({
      requestId: job.requestId,
      nonce: job.nonce,
      documentId: binding.documentId,
      sourceId: binding.episodeId,
      type: 'ready',
    });
  });
  subscribe('peard:legacy-clock-read', (packet) => {
    if (!isRecord(packet) || !isRequestId(packet.requestId)) return;
    const job = challenges.get(packet.requestId);
    if (!job || !matches(job, packet)) return;
    challenges.delete(job.requestId);
    active.set(job.requestId, job);
    let value;
    try {
      if (current()) value = getPlaybackOwner(api)?.clock(job.binding);
    } finally {
      active.delete(job.requestId);
      send({
        requestId: job.requestId,
        nonce: job.nonce,
        documentId: job.binding.documentId,
        sourceId: job.binding.episodeId,
        type: 'settled',
        result:
          value && current() && !job.canceled
            ? { ok: true, value }
            : { ok: false, reason: 'retired' },
      });
    }
  });
  subscribe('peard:legacy-clock-cancel', (packet) => {
    if (
      !isRecord(packet) ||
      !isRequestId(packet.requestId) ||
      !isOwnerId(packet.nonce)
    )
      return;
    if (packet.phase === 'owner') {
      if (packet.documentId !== undefined || packet.sourceId !== undefined)
        return;
      const job = challenges.get(packet.requestId);
      if (job?.nonce === packet.nonce) challenges.delete(packet.requestId);
    } else if (packet.phase === 'read') {
      const job = active.get(packet.requestId);
      if (job && matches(job, packet)) job.canceled = true;
    }
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const job of [...challenges.values(), ...active.values()]) {
      job.canceled = true;
      send({
        type: 'retire',
        documentId: job.binding.documentId,
        sourceId: job.binding.episodeId,
      });
    }
    challenges.clear();
    for (const release of releases.splice(0)) release();
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose);
  return {
    dispose,
    stats: () => ({ challenges: challenges.size, active: active.size }),
  };
}
