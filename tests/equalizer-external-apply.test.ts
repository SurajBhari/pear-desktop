import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('external config apply prepares retained wet tail before a queued volume event', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(`
 export {EqualizerController} from '@/plugins/equalizer/controller';
 export {createSlowedReverbController} from '@/plugins/player-actions/slowed-reverb/controller';
 export {DATTORRO_WORKLET_SOURCE} from '@/plugins/player-actions/slowed-reverb/worklet';
 export {computeDattorroParams} from '@/plugins/player-actions/slowed-reverb/engine';
 export * from '@/providers/renderer-audio';`),
  );
  const result = await page.evaluate(async () => {
    const f = (window as any).EqualizerFixture;
    const run = async (lower: boolean) => {
      const ctx = new OfflineAudioContext(2, 96000, 48000);
      const media = Object.assign(new EventTarget(), {
        volume: 1,
        muted: false,
      });
      const source = ctx.createBufferSource();
      Object.defineProperty(source, 'mediaElement', { value: media });
      const buffer = ctx.createBuffer(2, 96000, 48000);
      for (let i = 0; i < 24000; i++)
        for (let c = 0; c < 2; c++)
          buffer.getChannelData(c)[i] =
            0.9 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
      source.buffer = buffer;
      const graph = f.initializeAudioGraph(ctx, source);
      const raw = f.DATTORRO_WORKLET_SOURCE.replace(
        "registerProcessor('dattorro-reverb', DattorroReverbProcessor);",
        "class Ready extends DattorroReverbProcessor{handleMessage(data){super.handleMessage(data);if(data.type==='setParams')this.port.postMessage('ready')}};registerProcessor('dattorro-reverb',Ready);",
      );
      const addModule = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
      ctx.audioWorklet.addModule = async () => {
        const url = URL.createObjectURL(
          new Blob([raw], { type: 'application/javascript' }),
        );
        try {
          await addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      const wet = f.createSlowedReverbController();
      wet.ctx = { getConfig: () => wet.config, setConfig: () => {} };
      wet.config = {
        active: true,
        slow: 1,
        reverbIntensity: 1,
        wetHighpass: 180,
        wetLowpass: 6500,
      };
      wet.wireAudio(ctx, source);
      await wet.ensureWorklet();
      await new Promise((resolve) => {
        wet.reverbNode.port.onmessage = (e) => {
          if (e.data === 'ready') resolve(null);
        };
        wet.applyReverb();
      });
      const eq = new f.EqualizerController(graph);
      eq.apply(
        {
          mode: 'custom',
          preamp: 0,
          bands: [
            { id: 'a', type: 'peaking', frequency: 1000, gain: 36, Q: 1 },
          ],
        },
        false,
        true,
      );
      source.start();
      const pause = ctx.suspend(0.5),
        later = lower ? ctx.suspend(0.52) : null,
        rendering = ctx.startRendering();
      await pause;
      if (lower) {
        media.volume = 0.03;
        eq.apply(
          {
            mode: 'custom',
            preamp: 0,
            bands: [
              { id: 'a', type: 'peaking', frequency: 1000, gain: 36, Q: 1 },
            ],
          },
          false,
          true,
        );
        await ctx.resume();
        await later;
        media.dispatchEvent(new Event('volumechange'));
      }
      await ctx.resume();
      const rendered = await rendering;
      let peak = 0;
      for (const channel of [0, 1])
        for (const v of rendered.getChannelData(channel).slice(24240, 24960))
          peak = Math.max(peak, Math.abs(v));
      let settledPeak = 0;
      for (const channel of [0, 1])
        for (const value of rendered
          .getChannelData(channel)
          .slice(26400, 48000))
          settledPeak = Math.max(settledPeak, Math.abs(value));
      const preamp = eq.getResponse().effectivePreampDb;
      wet.teardownAudio();
      eq.stop();
      return { peak, settledPeak, preamp };
    };
    return { steady: await run(false), lowered: await run(true) };
  });
  console.log(JSON.stringify(result));
  expect(result.lowered.peak).toBeLessThanOrEqual(1);
  // Wet scaling precedes the existing 20 ms EQ handover. A brief conservative
  // dip is expected; the queued event must not leave the old loud tail exposed.
  expect(result.lowered.peak).toBeLessThanOrEqual(result.steady.peak + 0.00001);
  expect(result.lowered.peak).toBeGreaterThan(result.steady.peak / 2);
  expect(result.lowered.settledPeak).toBeCloseTo(result.steady.settledPeak, 5);
});
