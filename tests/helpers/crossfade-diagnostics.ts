/** Bounded owned-fixture observations, never a product/native diagnostic API. */
export const diagnosticCases = [
  'OVERLAP_DEFAULT',
  'ROUTING_REGISTER',
  'ROUTING_VOLUME',
  'SPEED_SAME_NEGATIVE',
  'SPEED_INVALID_NUMBER_TWO',
  'SPEED_INVALID_STRING_ONE',
  'SPEED_INVALID_ARRAY',
  'SPEED_TRANSFER',
] as const;
export type DiagnosticCase = (typeof diagnosticCases)[number];
type Stage = 'FIXTURE_READY' | 'VOLUME_COMPARISON' | 'TERMINAL';
const titles = [
  'actual source retains the same outgoing A tail after B play; opening 750Hz never returns in qualified overlap',
  'actual crossfade renderer registers its outgoing media in the owned dry mix',
  'deliberate main mute and volume zero silence outgoing audio during an actual fade',
  'owned same-value speed command -1 retires an admitted outgoing source',
  'invalid speed command 2 does not acquire cancellation ownership',
  'invalid speed command "1" does not acquire cancellation ownership',
  'invalid speed command [] does not acquire cancellation ownership',
  'speed-owner transfer at the same numeric rate retires outgoing without touching user controls',
] as const;
export function diagnosticCaseForTitle(title: string): DiagnosticCase | null {
  const index = titles.indexOf(title as (typeof titles)[number]);
  return index < 0 ? null : diagnosticCases[index];
}
const number = (value: unknown, min: number, max: number, integer = false) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max &&
  (!integer || Number.isInteger(value))
    ? value
    : null;
const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
const object = (value: unknown): any =>
  value && typeof value === 'object' ? value : {};
const clock = (value: unknown) => {
  const c = object(value);
  return {
    wallMs: number(c.wallMs, 0, 3600000),
    audioSeconds: number(c.audioSeconds, 0, 3600),
  };
};
const sample = (value: unknown) => {
  if (!value) return null;
  const s = object(value);
  return {
    clock: clock(s.clock),
    peak500: number(s.peak500, 0, 1),
    peak1000: number(s.peak1000, 0, 1),
    volume: number(s.volume, 0, 1),
    muted: bool(s.muted),
    events: number(s.events, 0, 64, true),
  };
};
export function unavailableDiagnostic(caseId: DiagnosticCase) {
  return {
    schema: 'PR90_MAC_AUDIO_V1' as const,
    case: caseId,
    status: 'UNAVAILABLE' as const,
    refused: false,
    observerDisposed: false,
    records: [] as any[],
  };
}
/** Reconstruct every field before serialization, including reporter-boundary input. */
export function sanitizeDiagnosticReport(value: unknown): any | null {
  try {
    const v = object(value);
    const caseValue = v.case;
    const caseId = diagnosticCases.find((knownCase) => knownCase === caseValue);
    if (!caseId) return null;
    const inputRecords = v.records;
    const records = Array.isArray(inputRecords) ? inputRecords : [];
    const recordLength = number(records.length, 0, 0xffffffff, true);
    if (recordLength === null) return null;
    const recordLimit = Math.min(recordLength, 3);
    const result: any[] = [];
    for (let index = 0; index < recordLimit; index++) {
      const raw: unknown = records[index];
      const r = object(raw),
        c = object(r.context),
        m = object(r.main),
        volume = object(r.volume);
      const stateValue = c.state;
      const state =
        stateValue === 'running'
          ? 'running'
          : stateValue === 'suspended'
            ? 'suspended'
            : stateValue === 'closed'
              ? 'closed'
              : stateValue === 'interrupted'
                ? 'interrupted'
                : 'UNAVAILABLE';
      const checkpointValue = r.checkpoint;
      const checkpoint =
        checkpointValue === 'FIXTURE_READY'
          ? 'FIXTURE_READY'
          : checkpointValue === 'VOLUME_COMPARISON'
            ? 'VOLUME_COMPARISON'
            : checkpointValue === 'TERMINAL'
              ? 'TERMINAL'
              : 'UNAVAILABLE';
      const fft = number(c.fftSize, 32, 32768, true);
      result.push({
        checkpoint,
        status: r.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
        clock: clock(r.clock),
        context: {
          state,
          sampleRate: number(c.sampleRate, 8000, 384000, true),
          fftSize: fft && (fft & (fft - 1)) === 0 ? fft : null,
        },
        requests: number(r.requests, 0, 64, true),
        registered: number(r.registered, 0, 64, true),
        currentAuxiliary: number(r.currentAuxiliary, 0, 64, true),
        maximumAuxiliary: number(r.maximumAuxiliary, 0, 64, true),
        admitted: bool(r.admitted),
        retired: bool(r.retired),
        admission: r.admission ? clock(r.admission) : null,
        retirement: r.retirement ? clock(r.retirement) : null,
        main: r.main
          ? {
              time: number(m.time, 0, 86400),
              duration: number(m.duration, 0, 86400),
              readyState: number(m.readyState, 0, 4, true),
              networkState: number(m.networkState, 0, 3, true),
              paused: bool(m.paused),
              ended: bool(m.ended),
              errorCode: number(m.errorCode, 1, 4, true),
            }
          : null,
        auxiliaryStatus: 'UNAVAILABLE',
        auxiliary: null,
        volume: r.volume
          ? {
              heard: sample(volume.heard),
              reduced: sample(volume.reduced),
              events: number(volume.events, 0, 64, true),
              lastEvent: volume.lastEvent ? clock(volume.lastEvent) : null,
            }
          : null,
      });
    }
    return {
      schema: 'PR90_MAC_AUDIO_V1',
      case: caseId,
      status: v.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
      refused: v.refused === true || recordLength > 3,
      observerDisposed: v.observerDisposed === true,
      records: result,
    };
  } catch {
    // Caller uses a separately known fixed case if hostile input cannot be read.
    return null;
  }
}
type Fixture = {
  main: HTMLMediaElement;
  context: AudioContext;
  analyser: AnalyserNode;
  graph: {
    observeAuxiliaryMedia(listener: (count: number) => void): () => void;
  };
  requests: () => number;
  registered: () => number;
};
/** Lazy browser entry. Bundled into the owned fixture; no top-level browser reads. */
export function createCrossfadeDiagnostic(
  caseId: DiagnosticCase,
  fixture: Fixture,
) {
  if (!diagnosticCases.includes(caseId)) return null;
  const output = {
    ...unavailableDiagnostic(caseId),
    status: 'AVAILABLE' as 'AVAILABLE' | 'UNAVAILABLE',
  };
  let startedWall: number | null = null,
    startedAudio: number | null = null;
  let current = 0,
    maximum = 0,
    admitted = false,
    retired = false;
  let admission: ReturnType<typeof clock> | null = null,
    retirement: ReturnType<typeof clock> | null = null;
  let events = 0,
    lastEvent: ReturnType<typeof clock> | null = null;
  let heard: ReturnType<typeof sample> = null,
    reduced: ReturnType<typeof sample> = null;
  let release: (() => void) | null = null,
    listening = false,
    disposed = false;
  let finalReport: any | null = null;
  const unavailable = () => {
    output.status = 'UNAVAILABLE';
  };
  try {
    startedWall = performance.now();
    startedAudio = fixture.context.currentTime;
  } catch {
    unavailable();
  }
  const pairedClock = () => {
    try {
      const wall = performance.now(),
        audio = fixture.context.currentTime;
      return clock({
        wallMs: startedWall === null ? null : wall - startedWall,
        audioSeconds: startedAudio === null ? null : audio - startedAudio,
      });
    } catch {
      unavailable();
      return clock(null);
    }
  };
  const onVolume = () => {
    if (disposed) return;
    if (events >= 64) {
      output.refused = true;
      return;
    }
    events++;
    lastEvent = pairedClock();
  };
  try {
    release = fixture.graph.observeAuxiliaryMedia((count) => {
      if (disposed) return;
      const valid = number(count, 0, 64, true);
      if (valid === null) {
        output.refused = true;
        return;
      }
      const at = pairedClock();
      if (valid > 0 && !admitted) {
        admitted = true;
        admission = at;
      }
      if (current > 0 && valid === 0) {
        retired = true;
        retirement = at;
      }
      current = valid;
      maximum = Math.max(maximum, valid);
    });
    if (caseId === 'ROUTING_VOLUME') {
      fixture.main.addEventListener('volumechange', onVolume);
      listening = true;
    }
  } catch {
    unavailable();
  }
  function checkpoint(stage: Stage) {
    if (disposed) return;
    if (
      !['FIXTURE_READY', 'VOLUME_COMPARISON', 'TERMINAL'].includes(stage) ||
      output.records.length >= 3 ||
      output.records.some((r) => r.checkpoint === stage)
    ) {
      output.refused = true;
      return;
    }
    const record: any = {
      checkpoint: stage,
      status: 'AVAILABLE',
      clock: pairedClock(),
      context: null,
      requests: null,
      registered: null,
      currentAuxiliary: current,
      maximumAuxiliary: maximum,
      admitted,
      retired,
      admission,
      retirement,
      main: null,
      volume: null,
    };
    try {
      record.context = {
        state: fixture.context.state,
        sampleRate: fixture.context.sampleRate,
        fftSize: fixture.analyser.fftSize,
      };
      record.requests = fixture.requests();
      record.registered = fixture.registered();
      const m = fixture.main;
      record.main = {
        time: m.currentTime,
        duration: m.duration,
        readyState: m.readyState,
        networkState: m.networkState,
        paused: m.paused,
        ended: m.ended,
        errorCode: m.error?.code ?? null,
      };
      if (stage === 'VOLUME_COMPARISON')
        record.volume = { heard, reduced, events, lastEvent };
    } catch {
      record.status = 'UNAVAILABLE';
      unavailable();
    }
    output.records.push(record);
  }
  function volumeSample(
    phase: 'HEARD' | 'REDUCED',
    peak500: number,
    peak1000: number,
  ) {
    if (disposed || caseId !== 'ROUTING_VOLUME') return;
    try {
      const value = sample({
        clock: pairedClock(),
        peak500,
        peak1000,
        volume: fixture.main.volume,
        muted: fixture.main.muted,
        events,
      });
      if (phase === 'HEARD' && !heard) heard = value;
      else if (phase === 'REDUCED' && !reduced) {
        reduced = value;
        checkpoint('VOLUME_COMPARISON');
      } else output.refused = true;
    } catch {
      unavailable();
    }
  }
  function finish() {
    if (finalReport) return finalReport;
    try {
      if (!output.records.some((r) => r.checkpoint === 'TERMINAL'))
        checkpoint('TERMINAL');
    } catch {
      unavailable();
    } finally {
      disposed = true;
      try {
        release?.();
        output.observerDisposed = release !== null;
      } catch {
        unavailable();
      }
      release = null;
      try {
        if (listening)
          fixture.main.removeEventListener('volumechange', onVolume);
      } catch {
        unavailable();
      }
      listening = false;
    }
    finalReport =
      sanitizeDiagnosticReport(output) ?? unavailableDiagnostic(caseId);
    return finalReport;
  }
  return { checkpoint, volumeSample, finish };
}
