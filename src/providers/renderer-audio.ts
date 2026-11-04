import { RendererOutput, type WetOutputLease } from './renderer-output';

/** Renderer-owned music buses. Raw analyser taps retain the original media source. */
export interface RendererAudioGraph {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
  dryInput: GainNode;
  masterInput: GainNode;
  musicGate: GainNode;
  insertMain(input: AudioNode, output: AudioNode): () => void;
  insertDry(input: AudioNode, output: AudioNode): () => void;
  insertMaster(input: AudioNode, output: AudioNode): () => void;
  registerMedia(
    element: HTMLMediaElement,
    gain?: GainNode,
    output?: AudioNode,
    admission?: {
      publishDispose(dispose: () => void): void;
      isCurrent(): boolean;
    },
  ): () => void;
  readonly auxiliaryMediaCount: number;
  observeAuxiliaryMedia(listener: (count: number) => void): () => void;
  registerVolumePreparation(
    phase: 'attenuate' | 'scale',
    listener: () => void,
  ): () => void;
  prepareVolumeChange(): boolean;
  outputInput: GainNode;
  registerWetOutput(output: GainNode, failed: () => void): WetOutputLease;
}

let current: RendererAudioGraph | null = null;
const graphs = new WeakMap<AudioNode, RendererAudioGraph>();

export function getCurrentAudioGraph(): RendererAudioGraph | null {
  return current;
}

/** Announce actual media readiness, including a load already in progress. */
export function observeAudioGraphReadiness(
  graph: RendererAudioGraph,
  video: HTMLVideoElement,
  isOwnerCurrent: () => boolean,
): () => void {
  let disposed = false;
  const isCurrent = () =>
    !disposed &&
    isOwnerCurrent() &&
    current === graph &&
    graph.audioSource.mediaElement === video &&
    graph.audioContext.state !== 'closed' &&
    video.isConnected &&
    document.querySelector('video') === video;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    video.removeEventListener('canplaythrough', announce);
    video.removeEventListener('loadstart', arm);
    graph.audioContext.removeEventListener('statechange', contextChanged);
    window.removeEventListener('pagehide', dispose);
  };
  const announce = () => {
    video.removeEventListener('canplaythrough', announce);
    if (!isCurrent()) {
      dispose();
      return;
    }
    document.dispatchEvent(
      new CustomEvent('peard:audio-can-play', {
        detail: {
          audioContext: graph.audioContext,
          audioSource: graph.audioSource,
          audioGraph: graph,
        },
      }),
    );
  };
  const arm = () => {
    if (!isCurrent()) {
      dispose();
      return;
    }
    // The same callback deduplicates the current load and future loadstart.
    video.addEventListener('canplaythrough', announce, { once: true });
  };
  const contextChanged = () => {
    if (graph.audioContext.state === 'closed') dispose();
  };
  if (!isCurrent()) {
    dispose();
    return dispose;
  }
  video.addEventListener('loadstart', arm, { passive: true });
  graph.audioContext.addEventListener('statechange', contextChanged);
  window.addEventListener('pagehide', dispose, { once: true });
  if (video.readyState === 4 /* HAVE_ENOUGH_DATA */) announce();
  else arm();
  return dispose;
}

export function initializeAudioGraph(
  audioContext: AudioContext,
  audioSource: MediaElementAudioSourceNode,
): RendererAudioGraph {
  const existing = graphs.get(audioSource);
  if (existing) return (current = existing);
  const dryInput = audioContext.createGain();
  const masterInput = audioContext.createGain();
  const musicGate = audioContext.createGain();
  const outputInput = audioContext.createGain();
  let auxiliaryMediaCount = 0;
  // Only the renderer's original dry edge is ours to replace. Never detach raw taps.
  try {
    audioSource.disconnect(audioContext.destination);
  } catch {
    /* no original edge */
  }
  audioSource.connect(dryInput);
  dryInput.connect(masterInput);
  masterInput.connect(outputInput);
  outputInput.connect(musicGate);
  musicGate.connect(audioContext.destination);
  const output = new RendererOutput(
    audioContext,
    outputInput,
    masterInput,
    musicGate,
  );
  const volumePreparations = {
    attenuate: new Set<() => void>(),
    scale: new Set<() => void>(),
  };
  let preparingVolume = false;
  const prepareVolumeChange = () => {
    if (preparingVolume) return false;
    preparingVolume = true;
    try {
      // Audio can advance between JS event listeners. Complete conservative
      // attenuation and wet scaling before any owner may relax its target.
      for (const phase of ['attenuate', 'scale'] as const)
        for (const listener of [...volumePreparations[phase]])
          if (volumePreparations[phase].has(listener)) listener();
      return true;
    } finally {
      // A failed preparation must stop the caller's relaxation, while a later
      // event can retry. Nested preparation cannot reorder phases.
      preparingVolume = false;
    }
  };
  const main = audioSource.mediaElement;
  const syncMute = () => {
    if (main?.muted || main?.volume === 0) output.mute();
    // Opening the renderer gate must never expose stale zero/muted EQ gains
    // before the plugins' later volume listeners get their turn.
    else if (prepareVolumeChange()) output.unmute();
  };
  syncMute();
  main?.addEventListener('volumechange', syncMute);
  const contextChanged = () => {
    if (audioContext.state !== 'closed') return;
    output.close();
    main?.removeEventListener('volumechange', syncMute);
    audioContext.removeEventListener('statechange', contextChanged);
    if (current?.audioContext === audioContext) current = null;
  };
  audioContext.addEventListener('statechange', contextChanged);
  const mediaNodes = new WeakMap<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();
  const activeMedia = new WeakSet<HTMLMediaElement>();
  const auxiliaryObservers = new Set<(count: number) => void>();
  const notifyObserver = (listener: (count: number) => void) => {
    try {
      listener(auxiliaryMediaCount);
    } catch (error) {
      console.error('[audio-graph] Auxiliary observer failed', error);
    }
  };
  const notifyAuxiliaryMedia = () => {
    for (const listener of [...auxiliaryObservers])
      if (auxiliaryObservers.has(listener)) notifyObserver(listener);
  };
  function insert(upstream: AudioNode, downstream: AudioNode) {
    let active: { input: AudioNode; output: AudioNode; token: object } | null =
      null;
    return (input: AudioNode, output: AudioNode) => {
      if (active) throw new Error('The music insert is already owned');
      const token = {};
      try {
        upstream.connect(input);
        output.connect(downstream);
        upstream.disconnect(downstream);
      } catch (error) {
        try {
          upstream.disconnect(input);
        } catch {
          /* rollback only our edge */
        }
        try {
          output.disconnect(downstream);
        } catch {
          /* rollback only our edge */
        }
        throw error;
      }
      active = { input, output, token };
      return () => {
        if (active?.token !== token) return;
        upstream.connect(downstream);
        upstream.disconnect(input);
        output.disconnect(downstream);
        active = null;
      };
    };
  }
  const graph: RendererAudioGraph = {
    audioContext,
    audioSource,
    dryInput,
    masterInput,
    musicGate,
    insertMain: insert(audioSource, dryInput),
    insertDry: insert(dryInput, masterInput),
    insertMaster: insert(masterInput, outputInput),
    outputInput,
    registerWetOutput(wet, failed) {
      return output.registerWet(wet, failed);
    },
    get auxiliaryMediaCount() {
      return auxiliaryMediaCount;
    },
    observeAuxiliaryMedia(listener) {
      // Each subscription owns its callback even if callers reuse a function.
      const owned = (count: number) => listener(count);
      auxiliaryObservers.add(owned);
      notifyObserver(owned);
      return () => auxiliaryObservers.delete(owned);
    },
    registerVolumePreparation(phase, listener) {
      const owned = () => listener();
      const callbacks = volumePreparations[phase];
      callbacks.add(owned);
      return () => callbacks.delete(owned);
    },
    prepareVolumeChange,
    registerMedia(element, suppliedGain, suppliedOutput, admission) {
      if (element === audioSource.mediaElement)
        throw new Error('Main media is already registered');
      if (activeMedia.has(element))
        throw new Error('Auxiliary media is already registered');
      if (
        (suppliedGain && suppliedGain.context !== audioContext) ||
        (suppliedOutput && suppliedOutput.context !== audioContext)
      )
        throw new Error('Auxiliary nodes belong to another audio context');
      let source: MediaElementAudioSourceNode | undefined;
      let gain: GainNode | undefined = suppliedGain;
      let output: AudioNode | undefined = suppliedOutput;
      let disposed = false,
        counted = false;
      activeMedia.add(element);
      const disconnect = () => {
        let fault: unknown;
        try {
          if (source && gain) source.disconnect(gain);
        } catch (error) {
          fault = error;
        }
        try {
          if (output) output.disconnect(dryInput);
        } catch (error) {
          fault ??= error;
        }
        return fault;
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const fault = disconnect();
        activeMedia.delete(element);
        if (counted) {
          counted = false;
          auxiliaryMediaCount--;
          notifyAuxiliaryMedia();
        }
        if (fault) throw new Error('Auxiliary route retirement failed');
      };
      const live = () => {
        if (disposed) return false;
        const current = !admission || admission.isCurrent();
        return !disposed && current;
      };
      const check = () => {
        if (live()) return true;
        // A connection callout may finish after an early disposer ran.
        disconnect();
        dispose();
        return false;
      };
      try {
        admission?.publishDispose(dispose);
        if (!check()) return dispose;
        source = mediaNodes.get(element);
        if (!source) {
          source = audioContext.createMediaElementSource(element);
          mediaNodes.set(element, source);
        }
        if (!check()) return dispose;
        gain ??= audioContext.createGain();
        output ??= gain;
        if (!check()) return dispose;
        counted = true;
        auxiliaryMediaCount++;
        // Publish count before any dry edge; each observer can retire this route.
        for (const listener of [...auxiliaryObservers]) {
          if (!check()) return dispose;
          if (auxiliaryObservers.has(listener)) notifyObserver(listener);
          if (!check()) return dispose;
        }
        source.connect(gain);
        if (!check()) return dispose;
        output.connect(dryInput);
        check();
        return dispose;
      } catch (error) {
        try {
          dispose();
        } finally {
          disconnect();
        }
        throw error;
      }
    },
  };
  graphs.set(audioSource, graph);
  return (current = graph);
}

export function graphFromAnnouncement(detail: {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
  audioGraph?: RendererAudioGraph;
}): RendererAudioGraph {
  if (detail.audioGraph) {
    // Consumers may later request the source-only fallback (including the
    // reverb wet tap). Adopt the announced owner so that fallback cannot build
    // a second dry route around its master inserts such as Equalizer.
    graphs.set(detail.audioSource, detail.audioGraph);
    return (current = detail.audioGraph);
  }
  return initializeAudioGraph(detail.audioContext, detail.audioSource);
}
