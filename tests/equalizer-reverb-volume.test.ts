import { test, expect } from '@playwright/test';
import vm from 'node:vm';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';
import { DATTORRO_WORKLET_SOURCE } from '../src/plugins/player-actions/slowed-reverb/worklet';
import { computeDattorroParams } from '../src/plugins/player-actions/slowed-reverb/engine';

// Exercise the real processor before any delay state: a transient invalid or
// oversized normalized sample must behave exactly like its bounded PCM input.
test('wet processor bounds each normalized channel before retaining delay state', () => {
  const render = (bounded: boolean, stereo: boolean) => {
    let Processor: any;
    vm.runInNewContext(DATTORRO_WORKLET_SOURCE, {
      sampleRate: 48000,
      AudioWorkletProcessor: class {
        port = { onmessage: null };
      },
      registerProcessor: (_: string, value: any) => {
        Processor = value;
      },
    });
    const dsp = new Processor();
    dsp.handleMessage({ type: 'setParams', params: computeDattorroParams(1) });
    const output: number[] = [];
    const bound = (x: number) =>
      Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    for (let block = 0; block < 400; block++) {
      const left = new Float32Array(128),
        right = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        const value =
          block < 2
            ? [NaN, Infinity, -Infinity, 2000, -2000, 0.9, -0.9][i % 7]
            : 0;
        left[i] = bounded ? bound(value) : value;
        right[i] = bounded ? bound(-value * 0.5) : -value * 0.5;
      }
      const l = new Float32Array(128),
        r = new Float32Array(128);
      dsp.process([stereo ? [left, right] : [left]], [[l, r]]);
      output.push(...l, ...r);
    }
    return output;
  };
  for (const stereo of [true, false]) {
    const actual = render(false, stereo),
      reference = render(true, stereo);
    expect(actual.every(Number.isFinite)).toBe(true);
    expect(actual).toEqual(reference);
  }
});

let bundle: string;
test.beforeAll(async () => {
  bundle = await equalizerBundle(`
import {createSlowedReverbController} from '@/plugins/player-actions/slowed-reverb/controller';
import {EqualizerController} from '@/plugins/equalizer/controller';
import {initializeAudioGraph} from '@/providers/renderer-audio';
import {DATTORRO_WORKLET_SOURCE} from '@/plugins/player-actions/slowed-reverb/worklet';
export {createSlowedReverbController, initializeAudioGraph, EqualizerController};
export {graphFromAnnouncement} from '@/providers/renderer-audio';
export async function renderWetVolume(options = {}) {
  const {initialVolume=1, finalVolume=initialVolume, changeAt=.5, delay=0, eqFirst=false, eqGain=36, muted=false, observeBetween=false, observeGate=false, initialMuted=false} = options;
  const context = new OfflineAudioContext(2,96000,48000);
  // Acknowledge actual parameter delivery; offline rendering can otherwise
  // outrun queued MessagePort messages. The inherited production DSP is intact.
  const workletSource=DATTORRO_WORKLET_SOURCE.replace(
    "registerProcessor('dattorro-reverb', DattorroReverbProcessor);",
    "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);"
  );
  const addModule=context.audioWorklet.addModule.bind(context.audioWorklet);
  context.audioWorklet.addModule=async()=>{
    const url=URL.createObjectURL(new Blob([workletSource],{type:'application/javascript'}));
    try{await addModule(url);}finally{URL.revokeObjectURL(url);}
  };
  // A native media-source test separately proves volume precedes the graph.
  // This native gain gives OfflineAudioContext sample-exact setter/event gaps.
  const media = Object.assign(new EventTarget(),{volume:initialVolume,muted:initialMuted});
  let subscriptions = 0;
  const add = media.addEventListener.bind(media), remove = media.removeEventListener.bind(media);
  media.addEventListener = (name,...args) => {if(name==='volumechange')subscriptions++;return add(name,...args);};
  media.removeEventListener = (name,...args) => {if(name==='volumechange')subscriptions--;return remove(name,...args);};
  const source = context.createBufferSource();
  const buffer = context.createBuffer(2,96000,48000);
  for(let i=0;i<24000;i++)for(let c=0;c<2;c++)buffer.getChannelData(c)[i]=.9*Math.sin(2*Math.PI*1000*i/48000);
  source.buffer=buffer;
  const volume = context.createGain();volume.gain.value=initialMuted?0:initialVolume;source.connect(volume);
  Object.defineProperty(volume,'mediaElement',{value:media});
  const graph=initializeAudioGraph(context,volume);
  const profile={mode:'custom',preamp:0,bands:[{id:'a',type:'peaking',frequency:1000,gain:eqGain,Q:1}]};
  let eq, wet;
  const preparation={wet:[],eq:[],between:[],gate:[]};
  if(observeGate)media.addEventListener('volumechange',()=>preparation.gate.push({gate:graph.musicGate.gain.value,wet:preparation.wet.at(-1),eq:preparation.eq.at(-1)}));
  const between=()=>preparation.between.push({wet:preparation.wet.at(-1),eq:preparation.eq.at(-1)});
  const makeEq=()=>{eq=new EqualizerController(graph);eq.apply(profile,false,true);};
  if(eqFirst){makeEq();if(observeBetween)media.addEventListener('volumechange',between);}
  wet=createSlowedReverbController();
  wet.ctx={getConfig:()=>wet.config,setConfig:()=>{}};
  wet.config={active:true,slow:1,reverbIntensity:1,wetHighpass:180,wetLowpass:6500};
  wet.wireAudio(context,volume);await wet.ensureWorklet();
  await new Promise(resolve=>{
    wet.reverbNode.port.onmessage=event=>{if(event.data==='ready')resolve();};
    wet.applyReverb();
  });
  if(!eqFirst){if(observeBetween)media.addEventListener('volumechange',between);makeEq();}
  if(observeBetween||observeGate){
    for(const [node,key] of [[wet.wetGain,'wet'],[eq.current.preamp,'eq']]){
      const set=node.gain.setValueAtTime.bind(node.gain);
      node.gain.setValueAtTime=(value,time)=>{preparation[key].push(value);return set(value,time);};
    }
  }
  const liveSubscriptions=subscriptions;
  source.start();
  const paused=context.suspend(changeAt);
  const later=delay>0?context.suspend(changeAt+delay):null;
  const rendering=context.startRendering();await paused;
  media.volume=finalVolume;media.muted=muted;
  volume.gain.setValueAtTime(muted?0:finalVolume,context.currentTime);
  if(later){await context.resume();await later;}
  media.dispatchEvent(new Event('volumechange'));
  await context.resume();const rendered=await rendering;
  let peak=0,energy=0,count=0,lateEnergy=0;
  for(const channel of [0,1])for(const [i,value] of rendered.getChannelData(channel).entries()){
    if(i>=26400&&i<72000){peak=Math.max(peak,Math.abs(value));energy+=value*value;count++;}
    if(i>=72000)lateEnergy+=value*value;
  }
  const preamp=eq.getResponse().effectivePreampDb;
  const inputGain=wet.wetInput?.gain.value,outputGain=wet.wetGain?.gain.value;
  const ownedInput=wet.wetInput;
  wet.teardownAudio();const afterWetStop=subscriptions;eq.stop();
  return {preparation,samples:rendered.getChannelData(0),peak,rms:Math.sqrt(energy/count),lateEnergy,preamp,inputGain,outputGain,liveSubscriptions,afterWetStop,afterStop:subscriptions,inputReleased:wet.wetInput===null&&ownedInput!==null};
}
`);
});

for (const eqFirst of [false, true]) {
  test(`retained native wet tail follows a volume drop with EQ listener ${eqFirst ? 'first' : 'last'}`, async ({
    page,
  }) => {
    await fixturePage(page, bundle);
    const result = await page.evaluate(async (eqFirst) => {
      const run = (window as any).EqualizerFixture.renderWetVolume;
      const steady = await run({ eqFirst }),
        lower = await run({ eqFirst, finalVolume: 0.03 });
      return {
        steady: steady.peak,
        lower: lower.peak,
        preamp: lower.preamp,
        inputGain: lower.inputGain,
        outputGain: lower.outputGain,
        live: lower.liveSubscriptions,
        wetStopped: lower.afterWetStop,
        stopped: lower.afterStop,
        inputReleased: lower.inputReleased,
      };
    }, eqFirst);
    expect(result.lower).toBeLessThan(1);
    expect(result.lower).toBeCloseTo(result.steady, 5);
    expect(result.preamp).toBeCloseTo(-36 - 20 * Math.log10(0.03) - 0.1, 3);
    expect(result.inputGain).toBeCloseTo(1 / 0.03, 4);
    expect(result.outputGain).toBeCloseTo(0.03, 6);
    expect(result.live).toBe(3);
    expect(result.wetStopped).toBe(2);
    expect(result.stopped).toBe(1);
    expect(result.inputReleased).toBe(true);
  });

  test(`bounded native normalizer survives delayed volume rises with EQ listener ${eqFirst ? 'first' : 'last'}`, async ({
    page,
  }) => {
    await fixturePage(page, bundle);
    const results = await page.evaluate(async (eqFirst) => {
      const run = (window as any).EqualizerFixture.renderWetVolume;
      const results = [];
      for (const initialVolume of [0.001, 0.01])
        for (const delay of [128 / 48000, 0.02]) {
          const timely = await run({
              eqFirst,
              initialVolume,
              finalVolume: 1,
              changeAt: 0.25,
            }),
            delayed = await run({
              eqFirst,
              initialVolume,
              finalVolume: 1,
              changeAt: 0.25,
              delay,
            });
          results.push({
            delay,
            initialVolume,
            rms: delayed.rms,
            reference: timely.rms,
            peak: delayed.peak,
            referencePeak: timely.peak,
            late: delayed.lateEnergy,
            referenceLate: timely.lateEnergy,
            finite: delayed.samples.every(Number.isFinite),
          });
        }
      return results;
    }, eqFirst);
    for (const result of results) {
      expect(result.finite).toBe(true);
      expect(result.rms).toBeLessThan(result.reference * 1.1);
      expect(result.peak).toBeLessThan(result.referencePeak * 1.1);
      expect(result.late).toBeLessThan(result.referenceLate * 1.25);
    }
  });
}

test('steady wet/dry mix has one volume factor and zero/mute/epsilon stay finite and silent', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const run = (window as any).EqualizerFixture.renderWetVolume;
    const reference = await run({ eqGain: 0 });
    const scaled = [];
    for (const initialVolume of [0.25, 0.03, 0.00001]) {
      const low = await run({ eqGain: 0, initialVolume });
      let error = 0;
      for (let i = 0; i < low.samples.length; i++)
        error = Math.max(
          error,
          Math.abs(low.samples[i] / initialVolume - reference.samples[i]),
        );
      scaled.push({
        error,
        inputGain: low.inputGain,
        outputGain: low.outputGain,
      });
    }
    const silent = [];
    for (const options of [
      { initialVolume: 0 },
      { initialVolume: 1e-6 },
      { initialVolume: 1, finalVolume: 1, muted: true },
    ]) {
      const output = await run({ eqGain: 0, ...options });
      silent.push({
        peak: output.peak,
        finite: output.samples.every(Number.isFinite),
        input: output.inputGain,
        output: output.outputGain,
      });
    }
    return { scaled, silent };
  });
  for (const scaled of result.scaled)
    expect(scaled.error).toBeLessThan(0.00001);
  for (const silent of result.silent) {
    expect(silent.peak).toBe(0);
    expect(silent.finite).toBe(true);
    expect(silent.input).toBe(0);
    expect(silent.output).toBe(0);
  }
});

test('wet volume listeners follow the wired source through replacement, failure and teardown', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const create = () => {
      const context = new AudioContext();
      const media = document.createElement('audio');
      media.volume = 0.25;
      let listeners = 0;
      const add = media.addEventListener.bind(media),
        remove = media.removeEventListener.bind(media);
      media.addEventListener = ((name: string, ...args: any[]) => {
        if (name === 'volumechange') listeners++;
        return (add as any)(name, ...args);
      }) as any;
      media.removeEventListener = ((name: string, ...args: any[]) => {
        if (name === 'volumechange') listeners--;
        return (remove as any)(name, ...args);
      }) as any;
      const source = context.createMediaElementSource(media);
      const graph = f.initializeAudioGraph(context, source);
      return { context, media, source, graph, count: () => listeners };
    };
    const wet = f.createSlowedReverbController();
    wet.ctx = { getConfig: () => wet.config, setConfig: () => {} };
    wet.config = { active: true, slow: 1, reverbIntensity: 1 };
    const first = create();
    wet.wireAudio(first.context, first.source);
    await wet.ensureWorklet();
    const firstLive = first.count();
    const second = create();
    wet.wireAudio(second.context, second.source);
    await wet.ensureWorklet();
    const switched = [first.count(), second.count()];
    const writes: { input: number[]; output: number[] } = {
      input: [],
      output: [],
    };
    for (const [node, key] of [
      [wet.wetInput, 'input'],
      [wet.wetGain, 'output'],
    ] as const) {
      const set = node.gain.setValueAtTime.bind(node.gain);
      node.gain.setValueAtTime = (value: number, time: number) => {
        writes[key].push(value);
        return set(value, time);
      };
    }
    first.graph.prepareVolumeChange();
    first.media.volume = 0.5;
    first.media.dispatchEvent(new Event('volumechange'));
    const staleWrites = writes.input.length;
    second.media.volume = 0.1;
    second.media.dispatchEvent(new Event('volumechange'));
    const currentWrite = [writes.input.at(-1), writes.output.at(-1)];
    second.media.volume = 1e-6;
    second.media.dispatchEvent(new Event('volumechange'));
    const epsilon = [writes.input.at(-1), writes.output.at(-1)];
    second.media.volume = 1e-5;
    second.media.dispatchEvent(new Event('volumechange'));
    const nearZero = [writes.input.at(-1), writes.output.at(-1)];
    second.media.muted = true;
    second.media.dispatchEvent(new Event('volumechange'));
    const muted = [writes.input.at(-1), writes.output.at(-1)];
    wet.wireAudio(second.context, second.source);
    const repeated = second.count();
    wet.teardownAudio();
    const stopped = [
      second.count(),
      wet.wetInput === null,
      wet.wetVolumeMedia === null,
    ];
    const failure = create();
    failure.context.audioWorklet.addModule = async () => {
      throw Error('owned fixture module failure');
    };
    wet.wireAudio(failure.context, failure.source);
    await wet.ensureWorklet();
    const failed = [
      failure.count(),
      wet.wetInput === null,
      wet.wetGain === null,
      wet.wetVolumeMedia === null,
    ];
    await first.context.close();
    await second.context.close();
    await failure.context.close();
    return {
      firstLive,
      switched,
      staleWrites,
      currentWrite,
      epsilon,
      nearZero,
      muted,
      repeated,
      stopped,
      failed,
    };
  });
  expect(result.firstLive).toBe(2);
  expect(result.switched).toEqual([1, 2]);
  expect(result.staleWrites).toBe(0);
  expect(result.currentWrite[0]).toBeCloseTo(10, 6);
  expect(result.currentWrite[1]).toBeCloseTo(0.1, 6);
  expect(result.epsilon).toEqual([0, 0]);
  expect(result.nearZero[0]).toBeLessThanOrEqual(1e6);
  expect(result.nearZero[0]).toBeCloseTo(100000, 3);
  expect(result.nearZero[1]).toBeCloseTo(1e-5, 8);
  expect(result.muted).toEqual([0, 0]);
  expect(result.repeated).toBe(2);
  expect(result.stopped).toEqual([1, true, true]);
  expect(result.failed).toEqual([1, true, true, true]);
});

test('wet scaling and EQ tightening finish before intervening volume listeners can delay the other owner', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const run = (window as any).EqualizerFixture.renderWetVolume;
    const down = await run({
      eqFirst: true,
      observeBetween: true,
      finalVolume: 0.03,
    });
    const up = await run({
      eqFirst: false,
      observeBetween: true,
      initialVolume: 0.03,
      finalVolume: 1,
    });
    return { down: down.preparation.between[0], up: up.preparation.between[0] };
  });
  expect(result.down.wet).not.toBeUndefined();
  expect(result.down.wet).toBeCloseTo(0.03, 6);
  expect(result.up.eq).not.toBeUndefined();
  expect(result.up.eq).toBeLessThanOrEqual(10 ** (-36.09 / 20));
});

test('canonical graph volume preparation leases preserve phase order through reentry, errors and announced owners', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const context = new AudioContext();
    const media = document.createElement('audio');
    const source = context.createMediaElementSource(media);
    const original = f.initializeAudioGraph(context, source);
    const announced = { ...original };
    f.graphFromAnnouncement({
      audioContext: context,
      audioSource: source,
      audioGraph: announced,
    });
    const graph = f.graphFromAnnouncement({
      audioContext: context,
      audioSource: source,
    });
    const calls: string[] = [];
    let nested: boolean | undefined;
    const releaseA = graph.registerVolumePreparation('attenuate', () => {
      calls.push('attenuate');
      nested = graph.prepareVolumeChange();
    });
    const reused = () => calls.push('scale');
    const releaseB = graph.registerVolumePreparation('scale', reused);
    const releaseC = graph.registerVolumePreparation('scale', reused);
    const completed = graph.prepareVolumeChange();
    const initial = calls.splice(0);
    releaseB();
    releaseB();
    graph.prepareVolumeChange();
    const independent = calls.splice(0);
    const releaseError = graph.registerVolumePreparation('attenuate', () => {
      throw Error('owned preparation failure');
    });
    let relaxed = false,
      rejected = false;
    try {
      graph.prepareVolumeChange();
      relaxed = true;
    } catch {
      rejected = true;
    }
    const failed = calls.splice(0);
    releaseError();
    graph.prepareVolumeChange();
    const recovered = calls.splice(0);
    releaseA();
    releaseC();
    graph.prepareVolumeChange();
    const retired = calls.splice(0);
    await context.close();
    return {
      canonical: graph === announced,
      nested,
      completed,
      initial,
      independent,
      relaxed,
      rejected,
      failed,
      recovered,
      retired,
    };
  });
  expect(result.canonical).toBe(true);
  expect(result.nested).toBe(false);
  expect(result.completed).toBe(true);
  expect(result.initial).toEqual(['attenuate', 'scale', 'scale']);
  expect(result.independent).toEqual(['attenuate', 'scale']);
  expect(result.rejected).toBe(true);
  expect(result.relaxed).toBe(false);
  expect(result.failed).toEqual(['attenuate']);
  expect(result.recovered).toEqual(['attenuate', 'scale']);
  expect(result.retired).toEqual([]);
});

test('native music gate prepares zero and muted chains before reopening ahead of plugin listeners', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(async () => {
    const run = (window as any).EqualizerFixture.renderWetVolume;
    const results = [];
    for (const eqFirst of [false, true])
      for (const initialMuted of [false, true]) {
        const output = await run({
          eqFirst,
          initialVolume: initialMuted ? 1 : 0,
          initialMuted,
          finalVolume: 1,
          observeGate: true,
        });
        results.push(output.preparation.gate[0]);
      }
    return results;
  });
  for (const state of result) {
    expect(state.gate).toBe(1);
    expect(state.eq).not.toBeUndefined();
    expect(state.eq).toBeLessThanOrEqual(10 ** (-36.09 / 20));
    expect(state.wet).toBe(1);
  }
});

test('direct EQ apply prepares identical requests and aborts on preparation failure or reentry', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createGain();
    Object.defineProperty(source, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 1, muted: false }),
    });
    const graph = f.initializeAudioGraph(context, source);
    const eq = new f.EqualizerController(graph);
    const profile = (gain: number) => ({
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain, Q: 1 }],
    });
    eq.apply(profile(12), false, true);
    const before = eq.getResponse(),
      chain = eq.current;
    let preparations = 0;
    const release = graph.registerVolumePreparation(
      'scale',
      () => preparations++,
    );
    eq.apply(profile(12), false, true);
    const identical = preparations;
    release();
    const releaseThrow = graph.registerVolumePreparation('scale', () => {
      throw Error('owned preparation failure');
    });
    let rejected = false;
    try {
      eq.apply(profile(18), false, true);
    } catch {
      rejected = true;
    }
    const retainedAfterThrow =
      eq.getResponse() === before && eq.current === chain;
    releaseThrow();
    const releaseNested = graph.registerVolumePreparation('attenuate', () =>
      eq.apply(profile(18), false, true),
    );
    graph.prepareVolumeChange();
    releaseNested();
    const retainedAfterReentry =
      eq.getResponse() === before &&
      eq.current === chain &&
      eq.chains.size === 1;
    eq.stop();
    return { identical, rejected, retainedAfterThrow, retainedAfterReentry };
  });
  expect(result.identical).toBe(1);
  expect(result.rejected).toBe(true);
  expect(result.retainedAfterThrow).toBe(true);
  expect(result.retainedAfterReentry).toBe(true);
});

test('direct EQ apply validates invalid DSP before preparation and preserves a failed replacement and manual fade', async ({
  page,
}) => {
  await fixturePage(page, bundle);
  const result = await page.evaluate(() => {
    const f = (window as any).EqualizerFixture;
    const context = new OfflineAudioContext(1, 4800, 48000);
    const source = context.createGain();
    Object.defineProperty(source, 'mediaElement', {
      value: Object.assign(new EventTarget(), { volume: 0.1, muted: false }),
    });
    const graph = f.initializeAudioGraph(context, source);
    const eq = new f.EqualizerController(graph);
    const profile = (gain: number) => ({
      mode: 'custom',
      preamp: 0,
      bands: [{ id: 'a', type: 'peaking', frequency: 1000, gain, Q: 1 }],
    });
    eq.apply(profile(12), false, true);
    const before = eq.getResponse();
    let preparations = 0,
      rejected = 0;
    graph.registerVolumePreparation('scale', () => preparations++);
    for (const invalid of [
      { ...profile(12), preamp: NaN },
      {
        ...profile(12),
        bands: Array.from({ length: 65 }, (_, i) => ({
          ...profile(48).bands[0],
          id: String(i),
        })),
      },
      {
        ...profile(12),
        bands: Array.from({ length: 64 }, (_, i) => ({
          ...profile(48).bands[0],
          id: String(i),
        })),
      },
    ]) {
      try {
        eq.apply(invalid, false, true);
      } catch {
        rejected++;
      }
    }
    const probe = eq.sampler.probes[0],
      native = probe.getFrequencyResponse.bind(probe);
    probe.getFrequencyResponse = (_frequencies: any, magnitude: Float32Array) =>
      magnitude.fill(NaN);
    try {
      eq.apply(profile(18), false, true);
    } catch {
      rejected++;
    }
    probe.getFrequencyResponse = native;
    const invalidPreparations = preparations,
      retained = eq.getResponse() === before;
    eq.stop();
    const manual = new f.EqualizerController(graph);
    manual.apply(profile(12), false, false);
    const retiring = manual.current;
    manual.apply(profile(18), false, true);
    const target = manual.getResponse(),
      current = manual.current;
    let manualWrites = 0;
    const set = retiring.preamp.gain.setValueAtTime.bind(retiring.preamp.gain);
    retiring.preamp.gain.setValueAtTime = (value: number, time: number) => {
      manualWrites++;
      return set(value, time);
    };
    manual.apply(profile(18), false, true);
    const connect = manual.input.connect.bind(manual.input);
    manual.input.connect = () => {
      throw Error('owned failed input connection');
    };
    let failedConnection = false;
    try {
      manual.apply(profile(24), false, true);
    } catch {
      failedConnection = true;
    }
    manual.input.connect = connect;
    const failedTargetRetained =
      manual.getResponse() === target &&
      manual.current === current &&
      manual.chains.size === 2;
    manual.stop();
    return {
      rejected,
      invalidPreparations,
      retained,
      manualWrites,
      failedConnection,
      failedTargetRetained,
    };
  });
  expect(result.rejected).toBe(4);
  expect(result.invalidPreparations).toBe(0);
  expect(result.retained).toBe(true);
  expect(result.manualWrites).toBe(0);
  expect(result.failedConnection).toBe(true);
  expect(result.failedTargetRetained).toBe(true);
});
