import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { build } from 'vite';
import solid from 'vite-plugin-solid';

let bundle: string;
test.beforeAll(async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const directory = await mkdtemp(path.join(tmpdir(), 'pear-speed-slider-'));
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(
      entry,
      `export {onPlayerApiReady as start,onUnload as stop} from '@/plugins/playback-speed/renderer';export {getPlaybackRateOwner} from '@/plugins/utils/renderer/playback-rate-owner';`,
    );
    const mocks: Record<string, string> = {
      '@/i18n': 'export const t=key=>key;',
      '@/providers/dom-elements':
        'export const getSongMenu=()=>document.querySelector("#menu");',
      '@/plugins/utils/renderer/check':
        'export const isMusicOrVideoTrack=()=>true,isPlayerMenu=()=>true;',
    };
    const output = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          ...Object.keys(mocks).map((find) => ({
            find,
            replacement: `\0${find}`,
          })),
          { find: '@', replacement: path.join(root, 'src') },
        ],
      },
      plugins: [
        {
          name: 'speed-slider-app-boundaries',
          enforce: 'pre',
          resolveId: (id) => (id in mocks ? `\0${id}` : undefined),
          load: (id) => mocks[id.slice(1)],
        },
        solid(),
      ],
      build: {
        write: false,
        lib: { entry, formats: ['iife'], name: 'SpeedSliderFixture' },
      },
    });
    const buildResult = Array.isArray(output) ? output[0] : output;
    if (!('output' in buildResult)) throw Error('No speed slider output');
    const result = buildResult.output.find((item) => item.type === 'chunk');
    if (!result || result.type !== 'chunk')
      throw Error('No speed slider bundle');
    bundle = result.code;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // YouTube supplies tp-yt-paper-slider. Its Polymer range behavior snaps
    // relative to min (IronRangeBehavior._calcStep). A native range input is
    // the independent browser grid oracle here; the production UI/event path
    // is real, but this does not qualify YouTube's custom widget rendering.
    customElements.define(
      'tp-yt-paper-slider',
      class extends HTMLElement {
        input?: HTMLInputElement;
        static get observedAttributes() {
          return ['min', 'max', 'step', 'value'];
        }
        connectedCallback() {
          const input = document.createElement('input');
          input.type = 'range';
          input.dataset.gridOracle = '';
          this.input = input;
          this.append(input);
          this.sync();
          input.addEventListener('input', () => {
            this.dispatchEvent(
              new CustomEvent('immediate-value-changed', {
                detail: { value: Number(input.value) },
              }),
            );
          });
        }
        attributeChangedCallback() {
          this.sync();
        }
        sync() {
          if (!this.input) return;
          for (const name of ['min', 'max', 'step'])
            this.input.setAttribute(name, this.getAttribute(name) ?? '');
          this.input.value = this.getAttribute('value') ?? '1';
        }
        get min() {
          return Number(this.getAttribute('min') ?? 0);
        }
        set min(value: number) {
          this.setAttribute('min', String(value));
        }
        get max() {
          return Number(this.getAttribute('max') ?? 100);
        }
        set max(value: number) {
          this.setAttribute('max', String(value));
        }
        get step() {
          return Number(this.getAttribute('step') ?? 1);
        }
        set step(value: number) {
          this.setAttribute('step', String(value));
        }
        get value() {
          return Number(this.input?.value ?? this.getAttribute('value') ?? 1);
        }
        set value(value: number) {
          this.setAttribute('value', String(value));
        }
      },
    );
  });
  await page.route('https://speed.fixture.invalid/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="movie_player"><video></video></div><ytmusic-popup-container><div id="menu"></div></ytmusic-popup-container>',
    }),
  );
  await page.goto('https://speed.fixture.invalid/');
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    video.playbackRate = 1.25;
    video.volume = 0.25;
    video.muted = true;
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).SpeedSliderFixture.start());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => (window as any).SpeedSliderFixture.stop());
});

test('the slider describes the supported rate range without claiming playback on mount', async ({
  page,
}) => {
  const slider = page.locator('tp-yt-paper-slider');
  expect(
    await slider.evaluate((node: any) => ({
      min: node.min,
      max: node.max,
      step: node.step,
    })),
  ).toEqual({ min: 0.07, max: 16, step: 0.01 });
  for (const node of [slider, slider.locator('#sliderBar')]) {
    await expect(node).toHaveAttribute('aria-valuemin', '0.07');
    await expect(node).toHaveAttribute('aria-valuemax', '16');
  }
  expect(
    await page.evaluate(() => {
      const video = document.querySelector('video')!;
      return {
        rate: video.playbackRate,
        owner: (window as any).SpeedSliderFixture.getPlaybackRateOwner(video),
      };
    }),
  ).toEqual({ rate: 1.25, owner: null });
});

for (const rate of [0.07, 0.25, 0.5, 1, 1.25, 1.5, 2, 16]) {
  test(`the slider selects ${rate}x without a min-relative step shift`, async ({
    page,
  }) => {
    const selected = await page
      .locator('[data-grid-oracle]')
      .evaluate((node, rate) => {
        const input = node as HTMLInputElement;
        // Move the existing setpoint first: a native echo of its initial 1x
        // value intentionally does not claim an untouched external rate.
        input.value = String(rate === 0.5 ? 2 : 0.5);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.value = String(rate);
        const selected = Number(input.value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return selected;
      }, rate);
    expect(selected).toBeCloseTo(rate, 10);
    await expect(page.locator('tp-yt-paper-slider')).toHaveAttribute(
      'aria-valuenow',
      String(rate),
    );
    expect(
      await page.evaluate(() => {
        const video = document.querySelector('video')!;
        return {
          rate: video.playbackRate,
          muted: video.muted,
          volume: video.volume,
          paused: video.paused,
        };
      }),
    ).toEqual({ rate, muted: true, volume: 0.25, paused: true });
  });
}
