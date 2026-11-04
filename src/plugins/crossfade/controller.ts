import { claimCrossfadeNext } from '@/plugins/utils/renderer/playback-filter';
import { subscribePlaybackRateOwner } from '@/plugins/utils/renderer/playback-rate-owner';
import {
  getPlaybackOwner,
  samePlaybackBinding,
  type PlaybackBinding,
} from '@/providers/playback-owner';
import {
  getCurrentAudioGraph,
  type RendererAudioGraph,
} from '@/providers/renderer-audio';

import {
  normalizeCrossfadeConfig,
  effectiveCrossfadeLead,
  type CrossfadePluginConfig,
} from './config';
import { scheduleOverlap } from './envelope';
import {
  readNativeCrossfadeState,
  sameCrossfadeOwners,
  type NativeCrossfadeState,
} from './native-state';
import { validCrossfadeStream, type StreamResult } from './stream';
import { TransitionAudio } from './transition-audio';

import type { MusicPlayer } from '@/types/music-player';

let pendingRequest: object | undefined;
/** Physical IPC is not cancellable. Retire consumers, retain this slot until settlement. */
export function requestCrossfadeAudio(
  videoId: string,
  invoke: (videoId: string) => Promise<StreamResult | null>,
):
  | { kind: 'busy' }
  | { kind: 'started'; token: object; result: Promise<StreamResult | null> } {
  if (pendingRequest) return { kind: 'busy' };
  const token = {};
  pendingRequest = token;
  let promise: Promise<StreamResult | null>;
  try {
    promise = Promise.resolve(invoke(videoId));
  } catch (error) {
    promise = Promise.reject(
      error instanceof Error ? error : new Error('Audio request failed'),
    );
  }
  const result = promise.finally(() => {
    if (pendingRequest === token) pendingRequest = undefined;
  });
  return { kind: 'started', token, result };
}
const controllers = new WeakMap<HTMLVideoElement, object>();
type State =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'handoff'
  | 'overlap'
  | 'stopped';
/** Only network and unavailable status are injected; native state/transport remain production-owned. */
export function createCrossfadeController(options: {
  api: MusicPlayer;
  main: HTMLVideoElement;
  graph: RendererAudioGraph;
  config: CrossfadePluginConfig;
  requestAudio: (videoId: string) => Promise<StreamResult | null>;
  onUnavailable: (error: unknown) => void;
}) {
  const { api, main, graph } = options,
    token = {};
  controllers.set(main, token);
  let config = normalizeCrossfadeConfig(options.config),
    state: State = 'idle',
    generation = 0;
  let incomingBinding: PlaybackBinding | null = null;
  let capture: NativeCrossfadeState | null = null,
    audio: TransitionAudio | null = null;
  let mainGain: GainNode | undefined,
    releaseMain: (() => void) | undefined,
    releaseClaim: (() => void) | undefined;
  let cancelAlignment: (() => void) | undefined;
  let overlap: ReturnType<typeof scheduleOverlap> = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  let rejected = '';
  let handoffStart = 0,
    sourceChanges = 0,
    loaded = false,
    lastSource = '',
    emptied = false;
  const abort = new AbortController();
  const live = () => state !== 'stopped' && controllers.get(main) === token;
  const active = (expected: number) => live() && generation === expected;
  const key = (s: NativeCrossfadeState) =>
    `${s.binding.documentId}:${s.binding.episodeId}:${s.source}`;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const retire = () => {
    const alignment = cancelAlignment;
    cancelAlignment = undefined;
    alignment?.();
    const a = audio;
    audio = null;
    const release = releaseMain;
    releaseMain = undefined;
    const gain = mainGain;
    mainGain = undefined;
    const claim = releaseClaim;
    releaseClaim = undefined;
    const envelope = overlap;
    overlap = null;
    clearTimer();
    try {
      envelope?.cancel();
    } catch {
      /* native playback fallback still runs */
    }
    try {
      if (gain) {
        gain.gain.cancelScheduledValues(graph.audioContext.currentTime);
        gain.gain.setValueAtTime(1, graph.audioContext.currentTime);
      }
    } catch {
      /* owned insert is retired below */
    }
    try {
      a?.unload();
    } finally {
      try {
        release?.();
      } finally {
        try {
          gain?.disconnect();
        } finally {
          claim?.();
        }
      }
    }
  };
  const cancel = () => {
    generation++;
    if (capture) rejected = key(capture);
    capture = null;
    if (state !== 'stopped') state = 'idle';
    retire();
  };
  const unavailable = () => {
    if (!live()) return;
    cancel();
    options.onUnavailable(
      new Error('Crossfade is unavailable for this transition'),
    );
  };
  const snapshot = () =>
    live() ? readNativeCrossfadeState(api, main, graph) : null;
  const sameA = (s: NativeCrossfadeState | null) =>
    !!capture &&
    !!s &&
    sameCrossfadeOwners(capture, s) &&
    s.source === capture.source &&
    samePlaybackBinding(capture.binding, s.binding) &&
    s.selectedIndex === capture.selectedIndex;
  const tail = () => {
    const outgoing = audio;
    if (!outgoing) return 0;
    try {
      const duration = outgoing.element.duration,
        time = outgoing.element.currentTime,
        rate = outgoing.element.playbackRate;
      if (
        audio !== outgoing ||
        !live() ||
        !Number.isFinite(duration) ||
        !Number.isFinite(time) ||
        !Number.isFinite(rate) ||
        rate <= 0
      )
        return 0;
      return ((duration - time) / rate) * 1000;
    } catch {
      return 0;
    }
  };
  const finishOverlap = (expected: number) => {
    if (!live() || generation !== expected || state !== 'overlap' || !overlap)
      return;
    if (graph.audioContext.state !== 'running') {
      cancel();
      return;
    }
    if (graph.audioContext.currentTime < overlap.endTime) {
      timer = setTimeout(
        () => finishOverlap(expected),
        Math.max(20, (overlap.endTime - graph.audioContext.currentTime) * 1000),
      );
      return;
    }
    capture = null;
    state = 'idle';
    generation++;
    retire();
  };
  const beginOverlap = () => {
    const expected = generation,
      captured = capture;
    if (
      state !== 'handoff' ||
      !captured ||
      !audio ||
      !loaded ||
      sourceChanges !== 1 ||
      main.currentSrc === captured.source ||
      main.currentSrc !== lastSource ||
      main.currentTime > 1 ||
      main.paused ||
      performance.now() - handoffStart > 2000
    )
      return false;
    const s = snapshot();
    if (!active(expected)) return false;
    if (
      !s ||
      !sameCrossfadeOwners(captured, s) ||
      s.videoId !== captured.nextId ||
      s.selectedIndex !== captured.selectedIndex + 1 ||
      s.binding.documentId !== captured.binding.documentId ||
      s.binding.episodeId === captured.binding.episodeId ||
      (incomingBinding !== null &&
        !samePlaybackBinding(incomingBinding, s.binding)) ||
      tail() < 100
    ) {
      cancel();
      return false;
    }
    incomingBinding = s.binding;
    try {
      const scheduled = scheduleOverlap(
        graph.audioContext,
        mainGain!.gain,
        audio.envelope,
        {
          fadeInMs: config.fadeInDuration,
          fadeOutMs: config.fadeOutDuration,
          scaling: config.fadeScaling,
          availableTailMs: tail(),
        },
      );
      if (!live() || generation !== expected || state !== 'handoff') {
        scheduled?.cancel();
        return false;
      }
      overlap = scheduled;
      if (!overlap) {
        cancel();
        return false;
      }
      state = 'overlap';
      clearTimer();
      timer = setTimeout(
        () => finishOverlap(expected),
        Math.max(20, (overlap.endTime - graph.audioContext.currentTime) * 1000),
      );
      return true;
    } catch {
      unavailable();
      return false;
    }
  };
  const readAlignment = (outgoing: TransitionAudio, expected: number) => {
    const before = snapshot();
    if (!active(expected) || audio !== outgoing || !sameA(before)) return null;
    try {
      const element = outgoing.element;
      const rate = element.playbackRate,
        time = element.currentTime;
      const ready =
        element.readyState >= 2 &&
        !element.paused &&
        !element.ended &&
        !element.seeking;
      const flags = before!.playback.flags.map(
        ({ key }) => (element as unknown as Record<string, unknown>)[key],
      );
      const after = snapshot();
      if (
        !active(expected) ||
        audio !== outgoing ||
        !sameA(after) ||
        !after ||
        !ready ||
        !Number.isFinite(time) ||
        rate !== after.playback.rate ||
        flags.some(
          (value, index) => value !== after.playback.flags[index]?.value,
        )
      )
        return null;
      return { state: after, delta: after.time - time };
    } catch {
      return null;
    }
  };
  const realignOutgoingA = (
    outgoing: TransitionAudio,
    expected: number,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const current = snapshot();
      if (
        !active(expected) ||
        audio !== outgoing ||
        !sameA(current) ||
        !current
      ) {
        resolve(false);
        return;
      }
      const remainingMs =
        ((current.duration - current.time) / current.playback.rate) * 1000;
      if (remainingMs <= 100) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        outgoing.element.removeEventListener('seeked', seeked);
        outgoing.element.removeEventListener('error', failed);
        outgoing.element.removeEventListener('pause', failed);
        if (cancelAlignment === failed) cancelAlignment = undefined;
        clearTimer();
        resolve(success);
      };
      const failed = () => finish(false);
      const seeked = () => {
        const aligned = readAlignment(outgoing, expected);
        finish(!!aligned && Math.abs(aligned.delta) <= 0.1);
      };
      cancelAlignment = failed;
      outgoing.element.addEventListener('seeked', seeked);
      outgoing.element.addEventListener('error', failed);
      outgoing.element.addEventListener('pause', failed);
      clearTimer();
      timer = setTimeout(failed, Math.min(250, remainingMs - 100));
      // Still current native A: exactly one corrective seek, never an incoming-B sync.
      try {
        outgoing.seek(current.time);
        if (!active(expected) || audio !== outgoing) failed();
      } catch {
        failed();
      }
    });
  const handoff = () => {
    const expected = generation;
    const s = snapshot();
    if (!active(expected)) return;
    const outgoing = audio,
      gain = mainGain,
      captured = capture;
    const aligned = outgoing && readAlignment(outgoing, expected);
    // A null alignment may mean that its callout already installed a successor.
    if (!active(expected)) return;
    if (
      !aligned ||
      Math.abs(aligned.delta) > 0.1 ||
      !sameA(s) ||
      !outgoing ||
      !gain ||
      !captured
    ) {
      cancel();
      return;
    }
    const remainingTail = tail();
    if (!active(expected)) return;
    if (remainingTail < 100) {
      cancel();
      return;
    }
    const claim = claimCrossfadeNext(
      api,
      captured.videoId,
      captured.selectedIndex,
    );
    if (!active(expected)) {
      claim?.release();
      return;
    }
    if (!claim) {
      cancel();
      return;
    }
    const started = performance.now();
    if (!active(expected)) {
      claim.release();
      return;
    }
    releaseClaim = () => claim.release();
    // Publish intent before native next can synchronously emit load/metadata callbacks.
    state = 'handoff';
    incomingBinding = null;
    sourceChanges = 0;
    loaded = false;
    emptied = false;
    lastSource = captured.source;
    handoffStart = started;
    timer = setTimeout(
      () => {
        if (active(expected) && state === 'handoff') cancel();
      },
      Math.max(1, Math.min(2000, remainingTail - 100)),
    );
    const ownsHandoff = () =>
      active(expected) &&
      state === 'handoff' &&
      capture === captured &&
      audio === outgoing &&
      mainGain === gain;
    try {
      const context = captured.audioContext;
      gain.gain.cancelScheduledValues(context.currentTime);
      if (!ownsHandoff()) return;
      gain.gain.setValueAtTime(0, context.currentTime);
      if (!ownsHandoff()) return;
      outgoing.envelope.setValueAtTime(1, context.currentTime);
      if (!ownsHandoff()) return;
      claim.commit();
      if (!ownsHandoff()) return;
      api.nextVideo();
    } catch {
      if (active(expected)) unavailable();
    }
  };
  const arm = async () => {
    if (state !== 'prepared' || !audio) return;
    const outgoing = audio,
      expected = generation;
    const ready = snapshot();
    if (!active(expected)) return;
    if (!sameA(ready) || !ready) {
      if (active(expected)) cancel();
      return;
    }
    state = 'preparing';
    const remainingMs =
      ((ready.duration - ready.time) / ready.playback.rate) * 1000;
    timer = setTimeout(
      () => {
        if (live() && generation === expected) cancel();
      },
      Math.max(1, Math.min(2000, remainingMs - 100)),
    );
    try {
      if (
        Math.abs(outgoing.element.duration - ready.duration) > 1 ||
        !outgoing.setPlaybackSnapshot(ready.playback) ||
        !sameA(snapshot()) ||
        !outgoing.admit()
      ) {
        if (active(expected)) unavailable();
        return;
      }
      outgoing.bindUserVolume(main);
      if (!sameA(snapshot()) || !live() || generation !== expected) {
        if (active(expected)) cancel();
        return;
      }
      const gain = graph.audioContext.createGain();
      if (!live() || generation !== expected) {
        gain.disconnect();
        return;
      }
      mainGain = gain;
      gain.gain.value = 1;
      if (!sameA(snapshot()) || !live() || generation !== expected) {
        if (active(expected)) cancel();
        return;
      }
      const release = graph.insertMain(gain, gain);
      if (!live() || generation !== expected) {
        release();
        gain.disconnect();
        return;
      }
      releaseMain = release;
      if (!sameA(snapshot()) || !live() || generation !== expected) {
        if (active(expected)) cancel();
        return;
      }
      outgoing.seek(main.currentTime);
      await outgoing.play();
      if (
        !sameA(snapshot()) ||
        !live() ||
        generation !== expected ||
        audio !== outgoing
      ) {
        if (active(expected)) cancel();
        return;
      }
      const alignment = readAlignment(outgoing, expected);
      if (!alignment) {
        if (active(expected)) cancel();
        return;
      }
      if (
        Math.abs(alignment.delta) > 0.1 &&
        !(await realignOutgoingA(outgoing, expected))
      ) {
        if (active(expected)) cancel();
        return;
      }
      if (!active(expected) || audio !== outgoing) return;
      clearTimer();
      handoff();
    } catch {
      if (live() && generation === expected)
        if (active(expected)) unavailable();
    }
  };
  const prepare = async (s: NativeCrossfadeState) => {
    state = 'preparing';
    capture = s;
    const expected = ++generation;
    const request = requestCrossfadeAudio(s.videoId, options.requestAudio);
    if (request.kind === 'busy') {
      if (active(expected)) cancel();
      return;
    }
    timer = setTimeout(() => {
      if (live() && generation === expected) cancel();
    }, 10000);
    try {
      const stream = await request.result;
      if (!live() || generation !== expected || state !== 'preparing') return;
      const current = snapshot();
      if (!active(expected)) return;
      if (!sameA(current)) {
        if (active(expected)) cancel();
        return;
      }
      const supported =
        validCrossfadeStream(stream) && main.canPlayType(stream.mimeType);
      if (!active(expected)) return;
      if (!supported || !validCrossfadeStream(stream)) {
        if (active(expected)) unavailable();
        return;
      }
      const outgoing = new TransitionAudio(stream.url, graph, {
        deferAdmission: true,
      });
      if (!active(expected)) {
        outgoing.unload();
        return;
      }
      audio = outgoing;
      await outgoing.ready;
      if (!live() || generation !== expected || audio !== outgoing) {
        outgoing.unload();
        return;
      }
      const ready = snapshot();
      if (!active(expected)) return;
      if (!sameA(ready) || !ready) {
        if (active(expected)) cancel();
        return;
      }
      if (Math.abs(outgoing.element.duration - ready.duration) > 1) {
        if (active(expected)) unavailable();
        return;
      }
      clearTimer();
      state = 'prepared';
      tick();
    } catch {
      if (live() && generation === expected)
        if (active(expected)) unavailable();
    }
  };
  const tick = () => {
    if (!live() || !config.overlapEligible) return;
    if (state === 'handoff') {
      const revision = (
        main.ownerDocument.defaultView as unknown as {
          blockerSceneGuard?: { userRevision?: () => number };
        }
      )?.blockerSceneGuard?.userRevision?.();
      if (
        !capture ||
        revision !== capture.revision ||
        getCurrentAudioGraph() !== graph ||
        graph.audioSource !== capture.audioSource ||
        graph.audioContext !== capture.audioContext ||
        graph.audioSource.mediaElement !== main ||
        main.ownerDocument.querySelector('video') !== main ||
        main.ownerDocument.querySelector('#movie_player') !==
          (api as unknown as Element) ||
        getPlaybackOwner(api) !== capture.owner
      )
        cancel();
      return;
    }
    if (state === 'overlap') {
      const s = snapshot();
      if (
        !capture ||
        !s ||
        !sameCrossfadeOwners(capture, s) ||
        s.videoId !== capture.nextId ||
        s.source === capture.source ||
        !samePlaybackBinding(incomingBinding, s.binding)
      )
        cancel();
      return;
    }
    if (state === 'preparing' || state === 'prepared') {
      if (!sameA(snapshot())) {
        cancel();
        return;
      }
    }
    if (state === 'prepared') {
      if (
        (main.duration - main.currentTime) / main.playbackRate <=
        effectiveCrossfadeLead(config)
      )
        arm().catch(unavailable);
      return;
    }
    if (
      state !== 'idle' ||
      main.paused ||
      !Number.isFinite(main.duration) ||
      (main.duration - main.currentTime) / main.playbackRate >
        effectiveCrossfadeLead(config) + 10
    )
      return;
    const s = snapshot();
    if (s?.nextId && key(s) !== rejected) prepare(s).catch(unavailable);
  };
  const media = (event: Event) => {
    if (!live()) return;
    if (event.type === 'timeupdate' || event.type === 'peard:src-changed') {
      tick();
      return;
    }
    if (state === 'idle') return;
    if (state === 'handoff') {
      tick();
      if (state !== 'handoff') return;
      if (event.type === 'emptied') {
        // Controlled native/local-WAV evidence: one reset precedes loadstart B.
        // It is legal only inside our published next intent with native target agreement.
        if (
          emptied ||
          sourceChanges ||
          main.readyState !== 0 ||
          main.currentTime > 1 ||
          api.getVideoData()?.video_id !== capture?.nextId ||
          api.getPlayerResponse()?.videoDetails?.videoId !== capture?.nextId
        ) {
          cancel();
          return;
        }
        emptied = true;
        return;
      }
      if (event.type === 'loadstart') {
        if (sourceChanges !== 0) {
          cancel();
          return;
        }
        sourceChanges++;
        lastSource = main.currentSrc;
        return;
      }
      if (event.type === 'loadedmetadata') {
        if (
          sourceChanges !== 1 ||
          !main.currentSrc ||
          main.currentSrc === capture?.source ||
          (lastSource &&
            lastSource !== capture?.source &&
            main.currentSrc !== lastSource)
        ) {
          cancel();
          return;
        }
        lastSource = main.currentSrc;
        loaded = true;
        return;
      }
      if (event.type === 'playing') {
        if (!beginOverlap()) cancel();
        return;
      }
      // No native load-time pause/seek exception is admitted without a future measured ruling.
      if (
        [
          'pause',
          'seeking',
          'seeked',
          'emptied',
          'ended',
          'error',
          'ratechange',
        ].includes(event.type)
      )
        cancel();
      return;
    }
    if (
      state === 'overlap' &&
      (event.type === 'waiting' || event.type === 'stalled')
    ) {
      cancel();
      return;
    }
    if (
      [
        'pause',
        'seeking',
        'seeked',
        'loadstart',
        'emptied',
        'ended',
        'error',
        'ratechange',
      ].includes(event.type)
    )
      cancel();
  };
  for (const name of [
    'timeupdate',
    'loadstart',
    'loadedmetadata',
    'playing',
    'waiting',
    'stalled',
    'play',
    'pause',
    'seeking',
    'seeked',
    'emptied',
    'ended',
    'error',
    'ratechange',
    'peard:src-changed',
  ])
    main.addEventListener(name, media, { signal: abort.signal });
  const user = (event: Event) => {
    if (event.isTrusted) cancel();
  };
  main.ownerDocument.addEventListener('pointerdown', user, {
    capture: true,
    signal: abort.signal,
  });
  main.ownerDocument.addEventListener('keydown', user, {
    capture: true,
    signal: abort.signal,
  });
  main.ownerDocument.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '.next-button,.previous-button,ytmusic-playlist-panel-video-renderer',
        )
      )
        cancel();
    },
    { capture: true, signal: abort.signal },
  );
  graph.audioContext.addEventListener(
    'statechange',
    () => {
      if (graph.audioContext.state !== 'running') cancel();
    },
    { signal: abort.signal },
  );
  main.ownerDocument.defaultView?.addEventListener(
    'pagehide',
    () => controller.dispose(),
    { signal: abort.signal },
  );
  const metadata = () => {
    if (!live()) return;
    const expected = generation,
      captured = capture;
    if (state === 'handoff' && captured) {
      try {
        const nativeId = api.getVideoData()?.video_id;
        const responseId = api.getPlayerResponse()?.videoDetails?.videoId;
        if (!active(expected)) return;
        if (nativeId === captured.videoId) {
          if (
            !samePlaybackBinding(
              captured.owner.binding(captured.videoId),
              captured.binding,
            )
          ) {
            cancel();
            return;
          }
        } else if (
          nativeId !== captured.nextId ||
          (responseId !== captured.videoId && responseId !== captured.nextId)
        ) {
          cancel();
          return;
        } else {
          const binding = captured.owner.binding(nativeId);
          if (!active(expected)) return;
          if (binding) {
            if (
              incomingBinding &&
              !samePlaybackBinding(incomingBinding, binding)
            ) {
              cancel();
              return;
            }
            incomingBinding = binding;
          }
        }
      } catch {
        cancel();
        return;
      }
    }
    if (active(expected)) tick();
  };
  api.addEventListener('videodatachange', metadata);
  const releaseRate = subscribePlaybackRateOwner(cancel);
  const controller = {
    configure(next: CrossfadePluginConfig) {
      if (!live()) return;
      cancel();
      config = normalizeCrossfadeConfig(next);
    },
    cancel,
    dispose() {
      if (state === 'stopped') return;
      state = 'stopped';
      generation++;
      capture = null;
      abort.abort();
      api.removeEventListener('videodatachange', metadata);
      releaseRate();
      retire();
      if (controllers.get(main) === token) controllers.delete(main);
    },
  };
  return controller;
}
