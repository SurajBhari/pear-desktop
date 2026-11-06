import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('native reverb tone cuts only the wet spectrum and Equalizer still controls dry and wet', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(`
    export {createSlowedReverbController} from '@/plugins/player-actions/slowed-reverb/controller';
    export {EqualizerController} from '@/plugins/equalizer/controller';
    export * from '@/providers/renderer-audio';
    export {outputPeakDelayFrames} from '@/providers/output-peak-worklet';
    export {DATTORRO_WORKLET_SOURCE} from '@/plugins/player-actions/slowed-reverb/worklet';
  `),
  );
  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const video = document.querySelector('video')!;
    const render = async (
      frequency: number,
      wetHighpass: number,
      wetLowpass: number,
      eqDb: number,
      wet = true,
      eqFirst = true,
      stopEq = false,
    ) => {
      const context = new OfflineAudioContext(2, 96000, 48000);
      const input = context.createBufferSource();
      // The graph normally receives a media source. Offline rendering substitutes
      // a buffer source while preserving the current-media identity contract.
      Object.defineProperty(input, 'mediaElement', { value: video });
      const buffer = context.createBuffer(2, 96000, 48000);
      for (let i = 0; i < 24000; i++) {
        const sample = Math.sin((2 * Math.PI * frequency * i) / 48000) * 0.05;
        buffer.getChannelData(0)[i] = sample;
        buffer.getChannelData(1)[i] = sample;
      }
      input.buffer = buffer;
      input.connect(context.destination);
      // Simulate an explicitly announced graph originating in another module
      // instance, whose source has not been initialized by this provider.
      const bootstrap = context.createBufferSource();
      Object.defineProperty(bootstrap, 'mediaElement', { value: video });
      const owned = fixture.initializeAudioGraph(context, bootstrap);
      input.disconnect(context.destination);
      input.connect(owned.dryInput);
      const graph = { ...owned, audioSource: input };
      document.dispatchEvent(
        new CustomEvent('peard:audio-can-play', {
          detail: {
            audioContext: context,
            audioSource: input,
            audioGraph: graph,
          },
        }),
      );
      const eq = new fixture.EqualizerController(graph);
      const applyEq = () =>
        eq.apply({ mode: 'custom', preamp: eqDb, bands: [] }, false);
      if (eqFirst) applyEq();
      const reverb = fixture.createSlowedReverbController();
      if (wet) {
        // Only instrument the port acknowledgement. Production DSP, controller,
        // Biquads and serial EQ insert are used without substitutes.
        const source = fixture.DATTORRO_WORKLET_SOURCE.replace(
          "registerProcessor('dattorro-reverb', DattorroReverbProcessor);",
          "class Ready extends DattorroReverbProcessor {handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);",
        );
        const addModule = context.audioWorklet.addModule.bind(
          context.audioWorklet,
        );
        context.audioWorklet.addModule = async (moduleUrl) => {
          const moduleSource = await fetch(moduleUrl).then((response) =>
            response.text(),
          );
          if (!moduleSource.includes("registerProcessor('dattorro-reverb'"))
            return addModule(moduleUrl);
          const url = URL.createObjectURL(
            new Blob([source], { type: 'application/javascript' }),
          );
          try {
            await addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        await reverb.start({
          getConfig: async () => ({
            active: true,
            slow: 1,
            reverbIntensity: 1,
            wetHighpass,
            wetLowpass,
          }),
          setConfig: () => {},
        });
        await reverb.ensureWorklet();
        await new Promise<void>((resolve) => {
          reverb.reverbNode.port.onmessage = (event: MessageEvent) => {
            if (event.data === 'ready') resolve();
          };
        });
      }
      if (!eqFirst) applyEq();
      if (stopEq) eq.stop();
      input.start();
      const audio = await context.startRendering();
      const samples = audio.getChannelData(0);
      let tailEnergy = 0,
        peak = 0;
      for (let i = 0; i < samples.length; i++) {
        if (i >= 24000 + (wet ? fixture.outputPeakDelayFrames(48000) : 0))
          tailEnergy += samples[i] ** 2;
        peak = Math.max(peak, Math.abs(samples[i]));
      }
      // Before predelay, only the unity dry route (plus EQ preamp) is audible.
      const dry =
        samples[30 + (wet ? fixture.outputPeakDelayFrames(48000) : 0)];
      reverb.stop();
      eq.stop();
      return {
        mixGain: owned.masterInput.gain.value,
        tailEnergy,
        peak,
        dry,
        finite: samples.every(Number.isFinite),
      };
    };
    const bassOpen = await render(60, 20, 20000, 0);
    const bassCut = await render(60, 600, 20000, 0);
    const trebleOpen = await render(10000, 20, 20000, 0);
    const trebleCut = await render(10000, 20, 2000, 0);
    const eqFlat = await render(1000, 180, 6500, 0);
    const eqAttenuated = await render(1000, 180, 6500, -12, true, false);
    const dryOnly = await render(1000, 180, 6500, 0, false);
    const eqStopped = await render(1000, 180, 6500, -12, true, true, true);
    return {
      bassOpen,
      bassCut,
      trebleOpen,
      trebleCut,
      eqFlat,
      eqAttenuated,
      dryOnly,
      eqStopped,
    };
  });
  for (const sample of Object.values(result)) {
    expect(sample.finite).toBe(true);
    expect(sample.peak).toBeLessThan(1);
  }
  expect(result.bassCut.tailEnergy).toBeLessThan(
    result.bassOpen.tailEnergy * 0.03,
  );
  expect(result.trebleCut.tailEnergy).toBeLessThan(
    result.trebleOpen.tailEnergy * 0.03,
  );
  expect(result.bassCut.dry).toBeCloseTo(result.bassOpen.dry, 6);
  expect(result.trebleCut.dry).toBeCloseTo(result.trebleOpen.dry, 6);
  expect(result.eqFlat.tailEnergy).toBeGreaterThan(0.001);
  expect(result.eqAttenuated.tailEnergy / result.eqFlat.tailEnergy).toBeCloseTo(
    10 ** (-12 / 10),
    3,
  );
  expect(result.eqAttenuated.dry / result.eqFlat.dry).toBeCloseTo(
    10 ** (-12 / 20),
    5,
  );
  expect(result.eqFlat.dry).toBeCloseTo(
    result.dryOnly.dry * result.eqFlat.mixGain,
    6,
  );
  expect(result.dryOnly.tailEnergy).toBe(0);
  expect(result.eqStopped.tailEnergy).toBeCloseTo(result.eqFlat.tailEnergy, 6);
  expect(result.eqStopped.dry).toBeCloseTo(result.eqFlat.dry, 6);
});

test('native reverb remains audible across media replacements, gaps and returning elements', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(`
    export {createSlowedReverbController} from '@/plugins/player-actions/slowed-reverb/controller';
    export {initializeAudioGraph,observeAudioGraphLifetime,getCurrentAudioGraph} from '@/providers/renderer-audio';
  `),
  );
  await page.locator('body').click();
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const original = document.querySelector('video')!;
    const replacement = document.createElement('video');
    // A short, exactly periodic mono tone exercises real MediaElement sources.
    const rate = 48000,
      samples = 12000;
    const wave = new ArrayBuffer(44 + samples * 2),
      view = new DataView(wave);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++)
        view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, wave.byteLength - 8, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++)
      view.setInt16(
        44 + i * 2,
        Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.05 * 32767),
        true,
      );
    const url = URL.createObjectURL(new Blob([wave], { type: 'audio/wav' }));
    const context = new AudioContext({ sampleRate: rate });
    const reverb = f.createSlowedReverbController();
    let dispose = () => {};
    let active = true;
    const rows: { rms: number; sameContext: boolean; sourceReused: boolean }[] =
      [];
    try {
      for (const media of [original, replacement]) {
        media.loop = true;
        media.src = url;
        media.load();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Fixture media readiness timeout')),
            5000,
          );
          const ready = () => {
            clearTimeout(timer);
            resolve();
          };
          if (media.readyState === 4) ready();
          else media.addEventListener('canplaythrough', ready, { once: true });
        });
      }
      const source = context.createMediaElementSource(original);
      const graph = f.initializeAudioGraph(context, source);
      await reverb.start({
        getConfig: async () => ({
          active: true,
          slow: 1,
          reverbIntensity: 0.4,
        }),
        setConfig: () => {},
      });
      dispose = f.observeAudioGraphLifetime(graph, () => active);
      await context.resume();
      for (const media of [
        original,
        original,
        replacement,
        original,
        replacement,
        original,
        replacement,
        original,
      ]) {
        if (rows.length === 1) {
          original.remove();
          const deadline = performance.now() + 5000;
          while (f.getCurrentAudioGraph() && performance.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 0));
          if (f.getCurrentAudioGraph())
            throw new Error('Detached media graph was not retired');
          document.body.append(original);
        }
        const current = document.querySelector('video')!;
        if (current !== media) {
          current.pause();
          current.replaceWith(media);
        }
        await media.play();
        const deadline = performance.now() + 5000;
        let analyser: AnalyserNode | undefined;
        let wet: GainNode | undefined;
        let rms = 0;
        try {
          while (performance.now() < deadline) {
            if (
              reverb.audioSource?.mediaElement === media &&
              reverb.wetGain &&
              reverb.reverbNode
            ) {
              if (wet !== reverb.wetGain) {
                if (analyser && wet) wet.disconnect(analyser);
                wet = reverb.wetGain;
                analyser = context.createAnalyser();
                analyser.fftSize = 2048;
                wet!.connect(analyser);
              }
              const pcm = new Float32Array(analyser!.fftSize);
              analyser!.getFloatTimeDomainData(pcm);
              if (!pcm.every(Number.isFinite))
                throw new Error('Nonfinite native reverb output');
              rms = Math.sqrt(
                pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length,
              );
              if (rms > 0.00001) break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const currentGraph = f.getCurrentAudioGraph();
          rows.push({
            rms,
            sameContext: currentGraph?.audioContext === context,
            sourceReused:
              media !== original || currentGraph?.audioSource === source,
          });
          if (rms <= 0.00001)
            throw new Error(
              'Native wet audio did not recover after media replacement',
            );
        } finally {
          if (wet && analyser) {
            try {
              wet.disconnect(analyser);
            } catch {}
          }
          analyser?.disconnect();
        }
      }
      return rows;
    } finally {
      reverb.stop();
      active = false;
      dispose();
      original.pause();
      replacement.pause();
      await context.close();
      URL.revokeObjectURL(url);
    }
  });
  expect(result).toHaveLength(8);
  for (const row of result) {
    expect(row.rms).toBeGreaterThan(0.00001);
    expect(row.sameContext).toBe(true);
    expect(row.sourceReused).toBe(true);
  }
});
