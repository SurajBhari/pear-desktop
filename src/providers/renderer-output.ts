import {
  OUTPUT_PEAK_PROCESSOR,
  OUTPUT_PEAK_WORKLET_SOURCE,
} from './output-peak-worklet';

export interface WetOutputLease {
  ready: Promise<boolean>;
  release(): void;
}

interface WetOwner {
  output: GainNode;
  failed(): void;
  active: boolean;
  connected: boolean;
}

const modules = new WeakMap<AudioContext, Promise<void>>();

function loadModule(context: AudioContext): Promise<void> {
  const existing = modules.get(context);
  if (existing) return existing;
  const url = URL.createObjectURL(
    new Blob([OUTPUT_PEAK_WORKLET_SOURCE], { type: 'application/javascript' }),
  );
  let registration: Promise<void>;
  try {
    registration = context.audioWorklet.addModule(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  const promise = registration.finally(() => {
    URL.revokeObjectURL(url);
  });
  modules.set(context, promise);
  promise.catch(() => {
    if (modules.get(context) === promise) modules.delete(context);
  });
  return promise;
}

function retire(node: AudioWorkletNode): void {
  node.onprocessorerror = null;
  try {
    node.port.postMessage({ type: 'dispose' });
  } catch {
    /* Closed. */
  }
  try {
    node.disconnect();
  } catch {
    /* Detached. */
  }
  try {
    node.port.close();
  } catch {
    /* Closed. */
  }
}

/** Renderer-owned post-EQ protection. Wet owners never own the EQ insert. */
export class RendererOutput {
  private node: AudioWorkletNode | null = null;
  private faultGuard: WaveShaperNode | null = null;
  private faultBypass = false;
  private loading: Promise<boolean> | null = null;
  private generation = 0;
  private closed = false;
  private failing = false;
  private owners = new Set<WetOwner>();
  private wantsOpen = false;
  private flushToken = 0;
  private gateAutomated = false;

  constructor(
    private context: AudioContext,
    private input: GainNode,
    private master: GainNode,
    private gate: GainNode,
  ) {}

  private setGateNow(value: number): void {
    // Remove any previously scheduled unmute as well as its old automation
    // anchors. Intrinsic assignment closes the final gate immediately.
    if (this.gateAutomated) {
      this.gate.gain.cancelScheduledValues(0);
      this.gateAutomated = false;
    }
    this.gate.gain.value = value;
  }

  registerWet(output: GainNode, failed: () => void): WetOutputLease {
    const owner: WetOwner = { output, failed, active: true, connected: false };
    this.owners.add(owner);
    const release = () => {
      if (!owner.active) return;
      owner.active = false;
      this.owners.delete(owner);
      try {
        owner.output.disconnect(this.master);
      } catch {
        /* Detached. */
      }
      owner.connected = false;
      // Once installed, the renderer keeps its delay/peak stage for this
      // graph's lifetime: removing it could expose retained post-EQ wet state.
      if (!this.owners.size && !this.node && !this.failing) this.retireOutput();
    };
    const ready = this.ensure().then((protectedOutput) => {
      if (!owner.active) return false;
      if (!protectedOutput || this.closed) {
        release();
        failed();
        return false;
      }
      try {
        owner.output.connect(this.master);
        owner.connected = true;
        return true;
      } catch (error) {
        this.disable(owner);
        owner.active = false;
        this.owners.delete(owner);
        failed();
        console.error('[renderer-output] wet connection failed', error);
        return false;
      }
    });
    return { ready, release };
  }

  mute(): void {
    this.wantsOpen = false;
    this.flushToken++;
    this.setGateNow(0);
  }

  unmute(): void {
    if (this.wantsOpen) return;
    this.wantsOpen = true;
    const node = this.node;
    if (!node) {
      this.setGateNow(1);
      return;
    }
    // Discard pre-mute PCM and old peak hold. The audio thread reopens only
    // after a complete fresh delay buffer; wall time cannot complete a flush.
    const token = ++this.flushToken;
    this.setGateNow(0);
    try {
      node.port.postMessage({ type: 'flush', token });
    } catch (error) {
      this.fail(error, this.generation, node);
    }
  }

  private ensure(): Promise<boolean> {
    if (this.closed || this.failing) return Promise.resolve(false);
    if (this.node) return Promise.resolve(true);
    if (this.loading) return this.loading;
    const generation = ++this.generation;
    const pending = (async () => {
      try {
        // Allocated disconnected before wet can enter the graph. This native
        // state-free guard is used ONLY if custom processing fails, including
        // retained hot EQ state after all wet owners have been detached.
        if (!this.faultGuard) {
          this.faultGuard = this.context.createWaveShaper();
          this.faultGuard.curve = new Float32Array([-1, 1]);
          this.faultGuard.oversample = 'none';
        }
        await loadModule(this.context);
        if (this.closed || generation !== this.generation || !this.owners.size)
          return false;
        const node = new AudioWorkletNode(this.context, OUTPUT_PEAK_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        this.node = node;
        node.onprocessorerror = () =>
          this.fail(
            new Error('Output peak processor failed'),
            generation,
            node,
          );
        node.port.onmessage = (
          event: MessageEvent<{
            type?: string;
            token?: number;
            readyAt?: number;
          }>,
        ) => {
          const data = event.data;
          if (
            this.node !== node ||
            generation !== this.generation ||
            !this.wantsOpen ||
            data.type !== 'flush-ready' ||
            data.token !== this.flushToken ||
            !Number.isFinite(data.readyAt)
          )
            return;
          if (data.readyAt! <= this.context.currentTime) this.setGateNow(1);
          else {
            this.gateAutomated = true;
            this.gate.gain.setValueAtTime(1, data.readyAt!);
          }
        };
        this.input.connect(node);
        node.connect(this.gate);
        try {
          this.input.disconnect(this.gate);
        } catch {
          /* Fault bypass instead. */
        }
        try {
          this.input.disconnect(this.faultGuard);
        } catch {
          /* Not active. */
        }
        this.faultGuard.disconnect();
        this.faultBypass = false;
        return true;
      } catch (error) {
        this.fail(error, generation, this.node);
        return false;
      } finally {
        if (generation === this.generation) this.loading = null;
      }
    })();
    // Allocation/URL creation may fail before the first await. fail() then
    // advances the epoch; never resurrect its already-failed promise here.
    if (generation === this.generation) this.loading = pending;
    return pending;
  }

  private disable(owner: WetOwner): void {
    try {
      owner.output.gain.cancelScheduledValues(this.context.currentTime);
      owner.output.gain.setValueAtTime(0, this.context.currentTime);
    } catch {
      /* Closed context. */
    }
    try {
      owner.output.disconnect(this.master);
    } catch {
      /* Detached. */
    }
    owner.connected = false;
  }

  private retireOutput(fault = false): void {
    this.generation++;
    this.loading = null;
    this.flushToken++;
    const node = this.node;
    try {
      if ((fault || this.faultBypass) && this.faultGuard) {
        // Identity within full scale; only overrange fault tails hard-limit.
        this.faultGuard.connect(this.gate);
        this.input.connect(this.faultGuard);
        this.faultBypass = true;
        try {
          this.input.disconnect(this.gate);
        } catch {
          /* Not bypassed. */
        }
      } else this.input.connect(this.gate);
    } catch {
      /* Closed context. */
    }
    if (node) {
      try {
        this.input.disconnect(node);
      } catch {
        /* Not connected. */
      }
      retire(node);
    }
    this.node = null;
    try {
      this.setGateNow(this.wantsOpen ? 1 : 0);
    } catch {
      /* Closed context. */
    }
  }

  private fail(
    error: unknown,
    generation: number,
    node: AudioWorkletNode | null,
    report = true,
  ): void {
    if (
      generation !== this.generation ||
      (node !== null && this.node !== node) ||
      this.failing
    )
      return;
    this.failing = true;
    this.generation++;
    this.loading = null;
    this.flushToken++;
    const owners = [...this.owners];
    // All owned wet edges are made silent and detached BEFORE dry/EQ bypass.
    for (const owner of owners) {
      owner.active = false;
      this.disable(owner);
    }
    this.owners.clear();
    for (const owner of owners) {
      try {
        owner.failed();
      } catch (failure) {
        console.error('[renderer-output] wet cleanup failed', failure);
      }
    }
    this.retireOutput(true);
    this.failing = false;
    if (report)
      console.error(
        '[renderer-output] protection unavailable; wet disabled',
        error,
      );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(
      new Error('Audio context closed'),
      this.generation,
      this.node,
      false,
    );
    if (this.faultGuard) {
      try {
        this.input.disconnect(this.faultGuard);
      } catch {
        /* Detached. */
      }
      try {
        this.faultGuard.disconnect();
      } catch {
        /* Detached. */
      }
    }
  }
}
