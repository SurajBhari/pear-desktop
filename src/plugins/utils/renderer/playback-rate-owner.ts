/** Only the two user speed controls and the existing ad-speedup writer arbitrate here. */
let owner: string | null = null;
let preferredRate: number | undefined;
let ad: { video: HTMLVideoElement; originalRate: number } | null = null;
const ownerListeners = new Set<() => void>();

/** Pitch policies observe handovers even when the numeric rate does not change. */
export function subscribePlaybackRateOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

function notifyOwner(): void {
  for (const listener of ownerListeners) listener();
}

export const PLAYBACK_RATE_OWNER_CHANGED = 'peard:playback-rate-owner-changed';

export function claimPlaybackRate(id: string, rate?: number): void {
  const changed = owner !== id;
  owner = id;
  if (rate !== undefined && Number.isFinite(rate)) preferredRate = rate;
  if (changed) notifyOwner();
}

export function releasePlaybackRate(id: string, restoreRate?: number): void {
  if (owner !== id) return;
  owner = null;
  if (restoreRate !== undefined && Number.isFinite(restoreRate))
    preferredRate = restoreRate;
  notifyOwner();
}

export function isAdSpeedupOverride(video?: HTMLVideoElement): boolean {
  return ad !== null && (video === undefined || ad.video === video);
}

export function getPlaybackRateOwner(video?: HTMLVideoElement): string | null {
  return isAdSpeedupOverride(video) ? 'ad-speedup' : owner;
}

export function isPlaybackRateOwner(
  id: string,
  video?: HTMLVideoElement,
): boolean {
  const current = getPlaybackRateOwner(video);
  return current === null || current === id;
}

export function isPlaybackRateControlledByOther(
  id: string,
  video?: HTMLVideoElement,
): boolean {
  const current = getPlaybackRateOwner(video);
  return current !== null && current !== id;
}

/** The actual ad controller calls this only after its ad-state predicate succeeds. */
export function beginAdSpeedupOverride(
  video: HTMLVideoElement,
  originalRate: number,
): void {
  if (owner === null || preferredRate === undefined)
    preferredRate = originalRate;
  ad = { video, originalRate };
  notifyOwner();
}

export function getUnforcedPlaybackRate(
  video: HTMLVideoElement,
  observedRate: number,
): number {
  return isAdSpeedupOverride(video)
    ? (preferredRate ?? ad!.originalRate)
    : observedRate;
}

export function endAdSpeedupOverride(
  video: HTMLVideoElement,
  notify = true,
): void {
  if (ad?.video !== video) return;
  ad = null;
  notifyOwner();
  if (notify) {
    const EventClass = video.ownerDocument.defaultView?.Event ?? Event;
    video.dispatchEvent(new EventClass(PLAYBACK_RATE_OWNER_CHANGED));
  }
}
