import { t } from '@/i18n';
import {
  getCurrentAudioGraph,
  graphFromAnnouncement,
} from '@/providers/renderer-audio';

import {
  failureStatus,
  releaseRoute,
  routeTo,
  type OutputAudioContext,
} from './routing';

import type { CustomOutputPluginConfig, DeviceStatus } from './index';
import type { RendererContext } from '@/types/contexts';

// New sessions publish after uncancellable old writes; stopped queued owners are skipped.
let publicationQueue: Promise<void> = Promise.resolve();

export class OutputDeviceSession {
  private alive = true;
  private config?: CustomOutputPluginConfig;
  private configRevision = 0;
  private audio?: OutputAudioContext;
  private media = navigator.mediaDevices;
  private devices: Record<string, string> = {};
  private snapshotReady = false;
  private enumerationStatus?: DeviceStatus;
  private routingStatus?: DeviceStatus;
  private enumerateRevision = 0;
  private enumerating = false;
  private deviceRevision = 0;
  private publishedDeviceRevision = 0;
  private writeRevision = 0;
  private writing = false;
  private requestedDeviceRevision = 0;
  private requestedStatus?: DeviceStatus;

  constructor(
    private readonly context: RendererContext<CustomOutputPluginConfig>,
  ) {}

  async start() {
    document.addEventListener('peard:audio-can-play', this.ready);
    this.media?.addEventListener?.('devicechange', this.deviceChanged);
    this.adoptCurrent();
    const revision = this.configRevision;
    try {
      const config = await this.context.getConfig();
      if (!this.alive) return;
      if (this.configRevision === revision) this.config = config;
      this.refreshDevices();
    } catch {
      if (this.alive) {
        this.enumerationStatus = 'failed';
        this.publish();
      }
    }
  }

  configure(config: CustomOutputPluginConfig) {
    if (!this.alive) return;
    this.configRevision++;
    const changed = this.config?.output !== config.output;
    this.config = config;
    if (changed) this.routingStatus = undefined;
    this.adoptCurrent();
    this.apply();
  }

  stop() {
    if (!this.alive) return;
    this.alive = false;
    document.removeEventListener('peard:audio-can-play', this.ready);
    this.media?.removeEventListener?.('devicechange', this.deviceChanged);
    this.retireAudio();
  }

  private ready = (event: Event) => {
    if (!this.alive) return;
    const detail = (event as CustomEvent<Compressor>).detail;
    const graph = getCurrentAudioGraph();
    // Canonical live state only; stale events cannot initialize another graph.
    // EQ is the integration prerequisite for late enable.
    if (
      !graph ||
      graph.audioContext.state === 'closed' ||
      detail?.audioContext !== graph.audioContext
    )
      return;
    graphFromAnnouncement({ ...detail, audioGraph: graph });
    this.adoptCurrent();
    this.apply();
  };

  private contextChanged = () => {
    if (this.audio?.state === 'closed') this.retireAudio();
  };

  private retireAudio() {
    if (!this.audio) return;
    this.audio.removeEventListener('statechange', this.contextChanged);
    releaseRoute(this.audio, this);
    this.audio = undefined;
  }

  private adoptCurrent() {
    const graph = getCurrentAudioGraph();
    const audio = graph?.audioContext;
    if (audio === this.audio) return;
    this.retireAudio();
    this.routingStatus = undefined;
    if (audio && audio.state !== 'closed') {
      this.audio = audio;
      audio.addEventListener('statechange', this.contextChanged);
    }
  }

  private deviceChanged = () => {
    if (this.alive && this.config) this.refreshDevices();
  };

  private refreshDevices() {
    this.enumerateRevision++;
    if (!this.enumerating)
      this.enumerate().catch(() => {
        if (this.alive) {
          this.enumerationStatus = 'failed';
          this.publish();
        }
      });
  }

  private async enumerate() {
    this.enumerating = true;
    try {
      while (this.alive) {
        const revision = this.enumerateRevision;
        let devices: MediaDeviceInfo[] = [];
        let status: DeviceStatus | undefined;
        if (typeof this.media?.enumerateDevices !== 'function')
          status = 'unsupported';
        else {
          try {
            devices = await this.media.enumerateDevices();
          } catch (error) {
            status = failureStatus(error);
          }
        }
        if (!this.alive) return;
        if (revision !== this.enumerateRevision) continue;
        const entries = devices.filter(
          (device) => device.kind === 'audiooutput',
        );
        const next: Record<string, string> = Object.create(null) as Record<
          string,
          string
        >;
        next.default = t('plugins.custom-output-device.system-default');
        let limited = entries.length === 0;
        for (const [index, device] of entries.entries()) {
          if (!device.deviceId) continue;
          limited ||= !device.label;
          next[device.deviceId] =
            device.label ||
            t('plugins.custom-output-device.unnamed-device', {
              number: index + 1,
            });
        }
        this.devices = next;
        this.enumerationStatus = status ?? (limited ? 'limited' : undefined);
        this.snapshotReady = true;
        this.deviceRevision++;
        this.adoptCurrent();
        this.apply();
        this.publish();
        if (revision === this.enumerateRevision) return;
      }
    } finally {
      this.enumerating = false;
    }
  }

  private selectedSink() {
    const selected = this.config?.output;
    return selected &&
      selected !== 'default' &&
      Object.hasOwn(this.devices, selected)
      ? selected
      : '';
  }

  private status(): DeviceStatus | undefined {
    if (this.routingStatus) return this.routingStatus;
    if (this.enumerationStatus && this.enumerationStatus !== 'limited')
      return this.enumerationStatus;
    const selected = this.config?.output;
    if (
      this.snapshotReady &&
      selected &&
      selected !== 'default' &&
      !Object.hasOwn(this.devices, selected)
    )
      return 'unavailable';
    return this.enumerationStatus;
  }

  private apply() {
    if (!this.alive || !this.config || !this.snapshotReady) return;
    const audio = this.audio;
    const sink = this.selectedSink();
    if (audio)
      routeTo(audio, this, sink, (status) => {
        if (!this.alive || this.audio !== audio) return;
        this.routingStatus = status;
        if (status === 'unavailable' && sink)
          routeTo(audio, this, '', (fallbackStatus) => {
            if (!this.alive || this.audio !== audio || !fallbackStatus) return;
            this.routingStatus = fallbackStatus;
            this.publish();
          });
        this.publish();
      });
    this.publish();
  }

  private publish() {
    if (!this.alive) return;
    const status = this.status();
    if (
      this.deviceRevision === this.requestedDeviceRevision &&
      status === this.requestedStatus
    )
      return;
    this.requestedDeviceRevision = this.deviceRevision;
    this.requestedStatus = status;
    this.writeRevision++;
    if (!this.writing) this.persist().catch(() => {});
  }

  private write(patch: Partial<Omit<CustomOutputPluginConfig, 'enabled'>>) {
    const pending = publicationQueue.then(async () => {
      if (this.alive) await this.context.setConfig(patch);
    });
    publicationQueue = pending.catch(() => {});
    return pending;
  }

  private async persist() {
    this.writing = true;
    try {
      while (this.alive) {
        const revision = this.writeRevision;
        const devices = this.deviceRevision;
        if (devices !== this.publishedDeviceRevision) {
          // Our deepmerge-ts skips undefined values. Null is the explicit non-record reset.
          await this.write({ devices: null });
          if (!this.alive) return;
          if (revision !== this.writeRevision) continue;
          const status = this.status();
          await this.write({
            devices: this.devices,
            deviceStatus: status ?? null,
          });
          if (!this.alive) return;
          this.publishedDeviceRevision = devices;
        } else {
          const status = this.status();
          await this.write({ deviceStatus: status ?? null });
          if (!this.alive) return;
        }
        if (revision === this.writeRevision) return;
      }
    } catch {
      if (this.alive)
        console.warn(t('plugins.custom-output-device.persistence-failed'));
    } finally {
      this.writing = false;
    }
  }
}
