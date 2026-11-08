import type { RendererAudioGraph } from '@/providers/renderer-audio';
export type PlaybackSnapshot = {
  rate: number;
  flags: ReadonlyArray<{
    key: 'preservesPitch' | 'mozPreservesPitch' | 'webkitPreservesPitch';
    value: boolean;
  }>;
};
// One synchronous admission/retirement transaction across controller replacements.
let transaction: object | undefined;

/** Owned outgoing transport. Silent preparation never counts as audible auxiliary. */
export class TransitionAudio {
  readonly ready: Promise<void>;
  readonly element = document.createElement('audio');
  private detach: (() => void) | undefined;
  private abort = new AbortController();
  private loaded = false;
  private disposed = false;
  private admitted = false;
  private rejectReady: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private userGain?: GainNode;
  private envelopeGain?: GainNode;
  get envelope(): AudioParam {
    if (!this.envelopeGain || !this.admitted || this.disposed)
      throw new Error('Auxiliary is not admitted');
    return this.envelopeGain.gain;
  }
  constructor(
    url: string,
    private graph: RendererAudioGraph,
    options?: { deferAdmission?: boolean },
  ) {
    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';
    this.element.volume = 0;
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const finish = (error?: Error) => {
        if (!this.rejectReady) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.rejectReady = null;
        if (error) reject(error);
        else {
          this.loaded = true;
          resolve();
        }
      };
      this.element.addEventListener('loadedmetadata', () => finish(), {
        once: true,
        signal: this.abort.signal,
      });
      this.element.addEventListener(
        'error',
        () =>
          finish(
            new Error('Auxiliary media could not load with CORS permission'),
          ),
        { once: true, signal: this.abort.signal },
      );
      this.timer = setTimeout(
        () => finish(new Error('Auxiliary media load timed out')),
        10000,
      );
    });
    this.ready.catch(() => {});
    try {
      if (!options?.deferAdmission) {
        if (!this.admit()) throw new Error('Auxiliary admission busy');
        this.envelope.value = 1;
      }
      this.element.src = url;
      this.element.load();
    } catch (error) {
      this.unload();
      throw error;
    }
  }
  admit(): boolean {
    if (
      this.disposed ||
      transaction ||
      this.graph.audioContext.state === 'closed'
    )
      return false;
    if (this.admitted) return true;
    const token = {};
    transaction = token;
    try {
      this.userGain = this.graph.audioContext.createGain();
      if (this.disposed) return false;
      this.envelopeGain = this.graph.audioContext.createGain();
      this.envelopeGain.gain.value = 0;
      if (this.disposed) return false;
      this.userGain.connect(this.envelopeGain);
      if (this.disposed) return false;
      const detach = this.graph.registerMedia(
        this.element,
        this.userGain,
        this.envelopeGain,
        {
          publishDispose: (dispose) => {
            this.detach = dispose;
          },
          isCurrent: () => !this.disposed && transaction === token,
        },
      );
      if (this.disposed) {
        detach();
        return false;
      }
      this.detach = detach;
      this.admitted = true;
      this.element.volume = 1;
      return !this.disposed;
    } catch (error) {
      this.unload();
      throw error;
    } finally {
      if (transaction === token) transaction = undefined;
      if (this.disposed) this.disconnectInternal();
    }
  }
  setPlaybackSnapshot(snapshot: PlaybackSnapshot): boolean {
    if (
      this.disposed ||
      this.admitted ||
      !Number.isFinite(snapshot.rate) ||
      snapshot.rate < 0.07 ||
      snapshot.rate > 16
    )
      return false;
    try {
      this.element.playbackRate = snapshot.rate;
      for (const { key, value } of snapshot.flags) {
        if (
          this.disposed ||
          typeof value !== 'boolean' ||
          !(key in this.element)
        )
          return false;
        (this.element as unknown as Record<string, unknown>)[key] = value;
      }
      return (
        !this.disposed &&
        this.element.playbackRate === snapshot.rate &&
        snapshot.flags.every(
          ({ key, value }) =>
            (this.element as unknown as Record<string, unknown>)[key] === value,
        )
      );
    } catch {
      return false;
    }
  }
  state() {
    return this.loaded && !this.disposed ? 'loaded' : 'loading';
  }
  bindUserVolume(main: HTMLMediaElement) {
    const sync = () => {
      if (this.userGain && !this.disposed)
        this.userGain.gain.value = main.muted ? 0 : main.volume;
    };
    sync();
    main.addEventListener('volumechange', sync, { signal: this.abort.signal });
  }
  async play() {
    await this.ready;
    if (
      this.disposed ||
      !this.admitted ||
      this.graph.audioContext.state !== 'running'
    )
      throw new Error('Auxiliary playback is unavailable');
    await this.element.play();
    if (this.disposed) {
      this.element.pause();
      throw new Error('Auxiliary media was retired');
    }
  }
  seek(time: number) {
    if (!this.loaded || this.disposed || !Number.isFinite(time) || time < 0)
      return;
    this.element.currentTime = Number.isFinite(this.element.duration)
      ? Math.min(time, Math.max(0, this.element.duration - 0.01))
      : time;
  }
  pause() {
    this.element.pause();
  }
  private disconnectInternal() {
    try {
      this.userGain?.disconnect();
    } catch {
      /* exact owned chain */
    }
    try {
      this.envelopeGain?.disconnect();
    } catch {
      /* exact owned chain */
    }
  }
  unload() {
    if (this.disposed) return;
    this.disposed = true;
    const token = {};
    const reserved = !transaction;
    if (reserved) transaction = token;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rejectReady?.(new Error('Auxiliary media was retired'));
    this.rejectReady = null;
    this.abort.abort();
    const detach = this.detach;
    this.detach = undefined;
    // Each retirement must run even if a preceding native operation throws.
    try {
      if (this.envelopeGain) {
        this.envelopeGain.gain.cancelScheduledValues(
          this.graph.audioContext.currentTime,
        );
        this.envelopeGain.gain.value = 0;
      }
    } catch {
      /* transport below is still retired */
    }
    try {
      this.element.pause();
    } catch {
      /* still detach */
    }
    try {
      detach?.();
    } catch {
      /* route fault: silence and retire transport */
    }
    this.disconnectInternal();
    try {
      this.element.removeAttribute('src');
    } catch {
      /* still load retirement */
    }
    try {
      this.element.load();
    } catch {
      /* retired */
    }
    if (reserved && transaction === token) transaction = undefined;
  }
}
