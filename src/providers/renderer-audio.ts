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
  registerMedia(element: HTMLMediaElement, gain?: GainNode): () => void;
  readonly auxiliaryMediaCount: number;
  observeAuxiliaryMedia(listener: (count: number) => void): () => void;
  registerVolumePreparation(
    phase: 'attenuate' | 'scale',
    listener: () => void,
  ): () => void;
  prepareVolumeChange(): boolean;
}

let current: RendererAudioGraph | null = null;
const graphs = new WeakMap<AudioNode, RendererAudioGraph>();

export function getCurrentAudioGraph(): RendererAudioGraph | null {
  return current;
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
  // Only the renderer's original dry edge is ours to replace. Never detach raw taps.
  try {
    audioSource.disconnect(audioContext.destination);
  } catch {
    /* no original edge */
  }
  audioSource.connect(dryInput);
  dryInput.connect(masterInput);
  masterInput.connect(musicGate);
  musicGate.connect(audioContext.destination);
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
    if (main?.muted || main?.volume === 0) musicGate.gain.value = 0;
    // Opening the renderer gate must never expose stale zero/muted EQ gains
    // before the plugins' later volume listeners get their turn.
    else if (prepareVolumeChange()) musicGate.gain.value = 1;
  };
  syncMute();
  main?.addEventListener('volumechange', syncMute);
  const contextChanged = () => {
    if (audioContext.state !== 'closed') return;
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
  let auxiliaryMediaCount = 0;
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
    insertMaster: insert(masterInput, musicGate),
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
    registerMedia(element, suppliedGain) {
      if (element === audioSource.mediaElement)
        throw new Error('Main media is already registered');
      if (activeMedia.has(element))
        throw new Error('Auxiliary media is already registered');
      if (suppliedGain && suppliedGain.context !== audioContext)
        throw new Error('Auxiliary gain belongs to another audio context');
      let source = mediaNodes.get(element);
      if (!source) {
        source = audioContext.createMediaElementSource(element);
        mediaNodes.set(element, source);
      }
      const gain = suppliedGain ?? audioContext.createGain();
      activeMedia.add(element);
      auxiliaryMediaCount++;
      // Observers may remove makeup gain before any auxiliary audio enters dry.
      notifyAuxiliaryMedia();
      try {
        source.connect(gain);
        gain.connect(dryInput);
      } catch (error) {
        try {
          source.disconnect(gain);
        } catch {
          /* own edge only */
        }
        try {
          gain.disconnect(dryInput);
        } catch {
          /* own edge only */
        }
        activeMedia.delete(element);
        auxiliaryMediaCount--;
        notifyAuxiliaryMedia();
        throw error;
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        source.disconnect(gain);
        gain.disconnect(dryInput);
        activeMedia.delete(element);
        auxiliaryMediaCount--;
        // A zero count is observable only after the dry edge is retired.
        notifyAuxiliaryMedia();
      };
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
