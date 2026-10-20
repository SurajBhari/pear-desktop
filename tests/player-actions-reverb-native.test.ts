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
        context.audioWorklet.addModule = async () => {
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
        if (i >= 24000) tailEnergy += samples[i] ** 2;
        peak = Math.max(peak, Math.abs(samples[i]));
      }
      // Before predelay, only the unity dry route (plus EQ preamp) is audible.
      const dry = samples[30];
      reverb.stop();
      eq.stop();
      return { tailEnergy, peak, dry, finite: samples.every(Number.isFinite) };
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
  expect(result.eqFlat.dry).toBeCloseTo(result.dryOnly.dry, 6);
  expect(result.dryOnly.tailEnergy).toBe(0);
  expect(result.eqStopped.tailEnergy).toBeCloseTo(result.eqFlat.tailEnergy, 6);
  expect(result.eqStopped.dry).toBeCloseTo(result.eqFlat.dry, 6);
});
