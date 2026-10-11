import type { MusicPlayer } from '@/types/music-player';

export interface CompressorConfig {
  enabled: boolean;
  autoTrackGain: boolean;
  maxTrackGainDb: number;
}

export const defaultConfig: CompressorConfig = {
  enabled: false,
  autoTrackGain: false,
  maxTrackGainDb: 6,
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const identity = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : null;
// Present mode flags are supported only as primitive false; never coerce them.
const inactiveFlag = (value: Record<string, unknown>, key: string) =>
  !(key in value) || value[key] === false;

/** Unknown metadata never becomes a normalization target or an amplification. */
function relativeGain(
  response: unknown,
  videoId: string,
  cap: unknown,
): number | null {
  const data = record(response);
  if (identity(record(data?.videoDetails)?.videoId) !== videoId) return null;
  const audio = record(record(data?.playerConfig)?.audioConfig);
  if (!audio) return null;
  const db = audio.loudnessDb;
  if (typeof db !== 'number' || !Number.isFinite(db)) return null;
  if (!inactiveFlag(audio, 'enablePerFormatLoudness')) return null;
  if ('trackAbsoluteLoudnessLkfs' in audio || 'loudnessTargetLkfs' in audio)
    return null;
  const normalization = record(audio.loudnessNormalizationConfig);
  if (
    audio.loudnessNormalizationConfig !== undefined &&
    (!normalization ||
      !inactiveFlag(normalization, 'applyStatefulNormalization') ||
      !inactiveFlag(normalization, 'preserveStatefulLoudnessTarget'))
  )
    return null;
  const streaming = record(data?.streamingData);
  for (const list of [streaming?.formats, streaming?.adaptiveFormats]) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const format = record(value);
      if (!format) continue;
      if ('trackAbsoluteLoudnessLkfs' in format) return null;
      if (
        'loudnessDb' in format &&
        (typeof format.loudnessDb !== 'number' ||
          !Number.isFinite(format.loudnessDb) ||
          Math.abs(format.loudnessDb - db) > 0.01)
      )
        return null;
    }
  }
  const limit =
    typeof cap === 'number' && Number.isFinite(cap)
      ? Math.max(0, Math.min(12, cap))
      : 6;
  return 10 ** (Math.min(Math.max(-db, 0), limit) / 20);
}

/** Owns gain automation and a bounded native-identity/response reconciliation. */
export class TrackGain {
  private api: MusicPlayer | null = null;
  private config = defaultConfig;
  private blocked = false;
  private stopped = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private videoId: string | null = null;
  private envelope = { from: 1, to: 1, start: 0, end: 0 };
  private readonly onVideoData = () => this.refresh();

  constructor(readonly node: GainNode) {
    node.gain.value = 1;
  }

  setApi(api: MusicPlayer | null) {
    this.api?.removeEventListener('videodatachange', this.onVideoData);
    this.api = api;
    this.videoId = null;
    this.setGain(1, true);
    api?.addEventListener('videodatachange', this.onVideoData);
    this.refresh();
  }

  configure(config: CompressorConfig) {
    this.config = config;
    this.refresh();
  }

  auxiliary(count: number) {
    this.blocked = count !== 0;
    this.refresh();
  }

  private setGain(value: number, immediate = false) {
    const now = this.node.context.currentTime;
    const previous = this.envelope;
    const progress =
      previous.end > previous.start
        ? Math.max(
            0,
            Math.min(
              1,
              (now - previous.start) / (previous.end - previous.start),
            ),
          )
        : 1;
    const delta = (previous.to - previous.from) * progress;
    const level = previous.from + delta;
    if (!immediate && value === previous.to) return;
    this.node.gain.cancelScheduledValues(now);
    this.node.gain.setValueAtTime(immediate ? value : level, now);
    const duration = immediate ? 0 : value > level ? 0.1 : 0.05;
    if (duration) this.node.gain.linearRampToValueAtTime(value, now + duration);
    this.envelope = {
      from: immediate ? value : level,
      to: value,
      start: now,
      end: now + duration,
    };
  }

  refresh() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.config.autoTrackGain !== true || this.blocked || !this.api) {
      this.setGain(1, true);
      return;
    }
    this.reconcile(epoch, 20);
  }

  private reconcile(epoch: number, retries: number) {
    if (this.stopped || this.epoch !== epoch) return;
    let value: number | null = null;
    try {
      const nativeId = identity(this.api?.getVideoData()?.video_id);
      if (nativeId !== this.videoId) this.setGain(1, true);
      this.videoId = nativeId;
      if (nativeId) {
        value = relativeGain(
          this.api?.getPlayerResponse(),
          nativeId,
          this.config.maxTrackGainDb,
        );
        // An API getter may synchronously dispatch navigation or teardown.
        if (identity(this.api?.getVideoData()?.video_id) !== nativeId)
          value = null;
      }
    } catch {
      value = null;
    }
    if (this.stopped || this.epoch !== epoch) return;
    if (value === null) this.setGain(1, true);
    else this.setGain(value);
    if (value === null && retries > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.reconcile(epoch, retries - 1);
      }, 400);
    }
  }

  stop() {
    this.stopped = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.api?.removeEventListener('videodatachange', this.onVideoData);
    this.api = null;
    this.setGain(1, true);
  }
}
