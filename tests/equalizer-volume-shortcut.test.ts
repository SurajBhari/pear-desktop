import { test, expect } from '@playwright/test';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

test('equalizer graph arrow edits do not trigger the precise volume shortcut', async ({
  page,
}) => {
  await fixturePage(
    page,
    await equalizerBundle(
      "export {createResponseView} from '@/plugins/equalizer/response-view';export {createVolumeSession} from '@/plugins/precise-volume/renderer';",
      true,
    ),
  );

  const result = await page.evaluate(async () => {
    const fixture = (window as any).EqualizerFixture;
    const band = { id: 'band-1', frequency: 1000, gain: 0, q: 1 };
    const editor = {
      profile: () => ({ bands: [band] }),
      edit: (_id: string, _frequency: number, gain: number) => {
        band.gain = gain;
      },
      add() {},
      flush() {},
    };
    const response = {
      sampleRate: 48000,
      autoPreamp: false,
      peakGainDb: 0,
      effectivePreampDb: 0,
      frequencies: [20, 1000, 20000],
      gainsDb: [0, 0, 0],
    };
    const view = fixture.createResponseView(() => response, editor);
    document.body.append(view.element);
    const writes: number[] = [];
    let volume = 50;
    const session = fixture.createVolumeSession({
      api: {
        getVolume: () => volume,
        setVolume: (value: number) => {
          volume = value;
          writes.push(value);
        },
        getPlayerResponse: () => null,
      },
      document,
      window,
      setConfig: async () => {},
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
      createObserver: () => ({ observe() {}, disconnect() {} }),
      videoToggleEnabled: () => false,
      isCurrent: () => true,
    });
    await session.start({
      enabled: true,
      steps: 1,
      arrowsShortcut: true,
      globalShortcuts: { volumeUp: '', volumeDown: '' },
      savedVolume: undefined,
    });
    const point = view.element.querySelector('[data-band-id]')!;
    point.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        code: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      }),
    );
    session.stop();
    view.dispose();
    return { gain: band.gain, volume, writes };
  });

  expect(result).toEqual({ gain: 0.1, volume: 50, writes: [] });
});
