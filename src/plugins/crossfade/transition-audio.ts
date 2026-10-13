import type { RendererAudioGraph } from '@/providers/renderer-audio';

/** Native, owned media transport. Never reaches into Howler's private pooled HTML5 nodes. */
export class TransitionAudio {
  readonly element = document.createElement('audio');
  readonly ready: Promise<void>;
  private detach: () => void;
  private abort = new AbortController();
  private loaded = false;
  private disposed = false;
  private rejectReady: ((error: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private userGain: GainNode;

  constructor(
    url: string,
    private graph: RendererAudioGraph,
  ) {
    this.element.crossOrigin = 'anonymous'; // Must precede src; denied CORS fails rather than playing outside EQ.
    this.element.preload = 'auto';
    this.element.volume = 0;
    this.userGain = graph.audioContext.createGain();
    this.detach = graph.registerMedia(this.element, this.userGain);
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const finish = (error?: Error) => {
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
    // unload() may cancel an un-awaited in-flight load; keep its rejection owned.
    this.ready.catch(() => {});
    this.element.src = url;
    this.element.load();
  }

  state() {
    return this.loaded && !this.disposed ? 'loaded' : 'loading';
  }

  bindUserVolume(main: HTMLMediaElement) {
    const sync = () => {
      this.userGain.gain.value = main.muted ? 0 : main.volume;
    };
    sync();
    main.addEventListener('volumechange', sync, { signal: this.abort.signal });
  }
  async play() {
    await this.ready;
    if (this.disposed || this.graph.audioContext.state === 'closed')
      throw new Error('Auxiliary media was retired');
    if (this.graph.audioContext.state === 'suspended')
      await this.graph.audioContext.resume();
    if (this.disposed) throw new Error('Auxiliary media was retired');
    await this.element.play();
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
  unload() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rejectReady?.(new Error('Auxiliary media was retired'));
    this.rejectReady = null;
    this.abort.abort();
    this.element.pause();
    this.detach();
    this.element.removeAttribute('src');
    this.element.load();
  }
}
