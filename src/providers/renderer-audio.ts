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
const retirements = new WeakMap<RendererAudioGraph, () => void>();

export function getCurrentAudioGraph(): RendererAudioGraph | null {
  return current;
}

/** Retire only this renderer graph's edges, not other plugins' raw source taps. */
export function retireAudioGraph(graph: RendererAudioGraph): void {
  retirements.get(graph)?.();
}

/** Follow media replacements, retaining one native source per reused element. */
export function observeAudioGraphLifetime(
  initialGraph: RendererAudioGraph,
  isOwnerCurrent: () => boolean,
): () => void {
  const context = initialGraph.audioContext;
  const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  sources.set(initialGraph.audioSource.mediaElement, initialGraph.audioSource);
  let graph: RendererAudioGraph | null = initialGraph;
  let observedVideo: HTMLVideoElement | null | undefined;
  let disposeReadiness: (() => void) | undefined;
  let disposed = false;
  let epoch = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    epoch++;
    observer.disconnect();
    disposeReadiness?.();
    disposeReadiness = undefined;
    const previous = graph;
    graph = null;
    if (previous) retireAudioGraph(previous);
    window.removeEventListener('pagehide', dispose);
    context.removeEventListener('statechange', contextChanged);
  };
  const update = () => {
    if (disposed) return;
    if (!isOwnerCurrent() || context.state === 'closed') {
      dispose();
      return;
    }
    const video = document.querySelector<HTMLVideoElement>('video');
    if (video === observedVideo) return;
    observedVideo = video;
    const generation = ++epoch;
    disposeReadiness?.();
    disposeReadiness = undefined;
    const previous = graph;
    graph = null;
    if (previous && previous.audioSource.mediaElement !== video)
      retireAudioGraph(previous);
    if (!video || disposed || !isOwnerCurrent()) return;
    try {
      let next = previous?.audioSource.mediaElement === video ? previous : null;
      if (!next) {
        let source = sources.get(video);
        if (!source) {
          source = context.createMediaElementSource(video);
          sources.set(video, source);
        }
        if (disposed || generation !== epoch || !isOwnerCurrent()) return;
        next = initializeAudioGraph(context, source);
      }
      if (disposed || generation !== epoch || !isOwnerCurrent()) {
        retireAudioGraph(next);
        return;
      }
      graph = next;
      const stop = observeAudioGraphReadiness(
        next,
        video,
        () => !disposed && generation === epoch && isOwnerCurrent(),
      );
      // An immediate readiness subscriber can pagehide/rebind this owner.
      if (disposed || generation !== epoch || !isOwnerCurrent()) {
        stop();
        dispose();
      } else disposeReadiness = stop;
    } catch (error) {
      if (graph) retireAudioGraph(graph);
      graph = null;
      console.error('[audio-graph] Media replacement binding failed', error);
    }
  };
  const contextChanged = () => {
    if (context.state === 'closed') dispose();
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('pagehide', dispose, { once: true });
  context.addEventListener('statechange', contextChanged);
  update();
  return dispose;
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
  let retired = false;
  const insertRetirements = new Set<() => void>();
  const auxiliaryDisposers = new Set<() => void>();
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
    if (retired || preparingVolume) return false;
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
    retireAudioGraph(graph);
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
    const detach = (owned: { input: AudioNode; output: AudioNode }) => {
      try {
        upstream.disconnect(owned.input);
      } catch {
        /* Detached. */
      }
      try {
        owned.output.disconnect(downstream);
      } catch {
        /* Detached. */
      }
    };
    insertRetirements.add(() => {
      const owned = active;
      active = null;
      if (owned) detach(owned);
    });
    return (input: AudioNode, output: AudioNode) => {
      if (retired) throw new Error('The audio graph is retired');
      if (active) throw new Error('The music insert is already owned');
      const token = {};
      const owned = { input, output, token };
      active = owned;
      const check = () => {
        if (retired || active !== owned)
          throw new Error('The audio graph is retired');
      };
      try {
        upstream.connect(input);
        check();
        output.connect(downstream);
        check();
        upstream.disconnect(downstream);
        check();
      } catch (error) {
        if (active === owned) active = null;
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
      return () => {
        if (retired || active?.token !== token) return;
        active = null;
        try {
          upstream.connect(downstream);
        } finally {
          if (retired) {
            try {
              upstream.disconnect(downstream);
            } catch {
              /* Detached. */
            }
          }
          detach(owned);
        }
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
      if (retired) return () => {};
      // Each subscription owns its callback even if callers reuse a function.
      const owned = (count: number) => listener(count);
      auxiliaryObservers.add(owned);
      notifyObserver(owned);
      return () => auxiliaryObservers.delete(owned);
    },
    registerVolumePreparation(phase, listener) {
      if (retired) return () => {};
      const owned = () => listener();
      const callbacks = volumePreparations[phase];
      callbacks.add(owned);
      return () => callbacks.delete(owned);
    },
    prepareVolumeChange,
    registerMedia(element, suppliedGain, suppliedOutput, admission) {
      if (retired) throw new Error('The audio graph is retired');
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
        auxiliaryDisposers.delete(dispose);
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
        if (retired || disposed) return false;
        const current = !admission || admission.isCurrent();
        return !retired && !disposed && current;
      };
      const check = () => {
        if (live()) return true;
        // A connection callout may finish after an early disposer ran.
        disconnect();
        dispose();
        return false;
      };
      auxiliaryDisposers.add(dispose);
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
  retirements.set(graph, () => {
    if (retired) return;
    retired = true;
    retirements.delete(graph);
    if (graphs.get(audioSource) === graph) graphs.delete(audioSource);
    if (current === graph) current = null;
    main?.removeEventListener('volumechange', syncMute);
    audioContext.removeEventListener('statechange', contextChanged);
    // Shutdown can synchronously reopen the gate and invoke wet owners.
    // Remove our destination edge before either of those callouts.
    try {
      musicGate.disconnect(audioContext.destination);
    } catch {
      /* Detached. */
    }
    output.close();
    for (const retire of insertRetirements) retire();
    insertRetirements.clear();
    for (const dispose of [...auxiliaryDisposers]) {
      try {
        dispose();
      } catch (error) {
        console.error('[audio-graph] Auxiliary retirement failed', error);
      }
    }
    auxiliaryDisposers.clear();
    auxiliaryObservers.clear();
    volumePreparations.attenuate.clear();
    volumePreparations.scale.clear();
    try {
      audioSource.disconnect(dryInput);
    } catch {
      /* Detached. */
    }
    for (const node of [dryInput, masterInput, outputInput, musicGate]) {
      try {
        node.disconnect();
      } catch {
        /* Detached. */
      }
    }
  });
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
