import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { editedConfig, flatProfile } from '../src/plugins/equalizer/config';
import { configPaths } from './helpers/equalizer-config-paths';
import { equalizerBundle, fixturePage } from './helpers/equalizer-bundle';

type ExpectedPreset = {
  id: string;
  upstreamId: string;
  preamp: number;
  bands: { frequency: number; gain: number; Q: number; type: string }[];
};
const expected: ExpectedPreset[] = JSON.parse(
  await readFile(
    new URL('./fixtures/equalizer-stock-presets.json', import.meta.url),
    'utf8',
  ),
) as ExpectedPreset[];
async function editor(page: Page, raw?: object) {
  const paths = await configPaths();
  if (raw) paths.ipcWrite(raw);
  await page.exposeBinding('saveEq', (_source, value) => paths.ipcWrite(value));
  await fixturePage(page, await equalizerBundle());
  await page.evaluate(async (initial) => {
    const win = window as any;
    win.writes = [];
    await win.EqualizerFixture.plugin.renderer.start({
      getConfig: async () => ({ ...initial, enabled: true }),
      setConfig: async (value: unknown) => {
        win.writes.push(structuredClone(value));
        await win.saveEq(value);
      },
      ipc: { on() {}, removeAllListeners() {} },
    });
    win.EqualizerFixture.plugin.renderer.openEditor();
  }, paths.ipcRead());
  return paths;
}
const picker = (page: Page) =>
  page
    .getByLabel('plugins.equalizer.editor.preset')
    .and(page.locator('select'));
async function selectStock(page: Page, id: string) {
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator(`option[value="stock:${id}"]`)).toHaveCount(
    1,
  );
  const before = await page.evaluate(() => (window as any).writes.length);
  await picker(page).selectOption('stock:' + id);
  await expect
    .poll(() => page.evaluate(() => (window as any).writes.length))
    .toBeGreaterThan(before);
}
test.afterEach(async ({ page }) => {
  await page.evaluate(() =>
    (window as any).EqualizerFixture?.plugin.renderer.stop(),
  );
});

test('all thirty upstream stock curves apply exact custom profiles through actual panel and config setters', async ({
  page,
}) => {
  const paths = await editor(page);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('option[value^="stock:"]')).toHaveCount(30);
  for (const preset of expected) {
    await selectStock(page, preset.id);
    await expect
      .poll(() => paths.ipcRead().profile.bands[0]?.gain)
      .toBe(preset.bands[0].gain);
    for (const value of [
      paths.ipcRead(),
      await paths.menu.getConfig(),
      paths.reads.at(-1),
    ]) {
      expect(value.profile.mode).toBe('custom');
      expect(value.profile.preamp).toBe(preset.preamp);
      expect(
        value.profile.bands.map(({ id: _id, ...band }: any) => band),
      ).toEqual(preset.bands);
      expect(value.profile.bands).toHaveLength(10);
      expect(
        new Set(value.profile.bands.map((band: any) => band.id)).size,
      ).toBe(10);
      expect(value.userPresets).toEqual([]);
    }
    await expect(page.locator('.eq-band')).toHaveCount(10);
    await expect(
      page.getByLabel('plugins.equalizer.editor.layout'),
    ).toHaveValue('custom');
    await expect(
      page.getByRole('button', {
        name: 'plugins.equalizer.editor.delete',
        exact: true,
      }),
    ).toBeDisabled();
  }
});

test('stock edits and saved copies remain independent from immutable catalogue and arbitrary saved IDs', async ({
  page,
}) => {
  const custom = { ...flatProfile('custom'), preamp: -3 };
  const raw = editedConfig(
    { ...(await configPaths()).ipcRead(), enabled: true },
    custom,
    {
      userPresets: [
        { id: 'stock:rock', name: 'Owned Rock', profile: custom },
        { id: 'flat', name: 'Owned Flat', profile: { ...custom, preamp: -4 } },
      ],
    },
  );
  const paths = await editor(page, raw);
  await expect(picker(page)).toBeVisible();
  await expect(
    picker(page).locator('option[value="user:stock:rock"]'),
  ).toHaveCount(1);
  await expect(picker(page).locator('option[value="user:flat"]')).toHaveCount(
    1,
  );
  await selectStock(page, 'rock');
  await page
    .getByLabel('plugins.equalizer.editor.gain', { exact: true })
    .first()
    .fill('-9');
  await page
    .getByLabel('plugins.equalizer.editor.preset-name')
    .fill('Rock copy');
  await page
    .getByRole('button', { name: 'plugins.equalizer.editor.save', exact: true })
    .click();
  await expect.poll(() => paths.ipcRead().userPresets.length).toBe(3);
  expect(
    paths.ipcRead().userPresets.find((p: any) => p.name === 'Rock copy').profile
      .bands[0].gain,
  ).toBe(-9);
  await selectStock(page, 'rock');
  expect(paths.ipcRead().profile.bands[0].gain).toBe(5.9);
  await picker(page).selectOption('user:stock:rock');
  await expect(page.locator('.eq-band')).toHaveCount(0);
  await expect(page.getByLabel('plugins.equalizer.editor.preamp')).toHaveValue(
    '-3',
  );
  await picker(page).selectOption('user:flat');
  await expect(page.getByLabel('plugins.equalizer.editor.preamp')).toHaveValue(
    '-4',
  );
  expect(paths.ipcRead().userPresets.slice(0, 2)).toEqual(raw.userPresets);
  await page.getByLabel('plugins.equalizer.editor.preamp').fill('-5');
  await page
    .getByRole('button', {
      name: 'plugins.equalizer.editor.update',
      exact: true,
    })
    .click();
  await expect
    .poll(
      () =>
        paths.ipcRead().userPresets.find((p: any) => p.id === 'flat')?.profile
          .preamp,
    )
    .toBe(-5);
  await expect(picker(page)).toHaveValue('user:flat');
  await page
    .getByRole('button', {
      name: 'plugins.equalizer.editor.delete',
      exact: true,
    })
    .click();
  await expect.poll(() => paths.ipcRead().userPresets.length).toBe(2);
  await expect(picker(page).locator('option[value="user:flat"]')).toHaveCount(
    0,
  );
  await expect(picker(page).locator('option[value="stock:flat"]')).toHaveCount(
    1,
  );
  expect(
    paths.ipcRead().userPresets.find((p: any) => p.id === 'stock:rock'),
  ).toEqual(raw.userPresets![0]);
});

test('stock selection retains raw legacy data and exact outgoing remembered mode', async ({
  page,
}) => {
  const raw = {
    enabled: true,
    filters: [{ type: 'peaking', frequency: 500, gain: 3, Q: 2 }],
    presets: { 'bass-booster': true },
    retainedUnknown: { marker: 'owned public fixture' },
  };
  const paths = await editor(page, raw);
  expect(paths.raw().filters).toEqual(raw.filters);
  expect(paths.raw().presets).toEqual(raw.presets);
  expect(paths.raw().retainedUnknown).toEqual(raw.retainedUnknown);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await selectStock(page, 'rock');
  expect(paths.raw().filters).toEqual(raw.filters);
  expect(paths.raw().presets).toEqual(raw.presets);
  expect(paths.raw().retainedUnknown).toEqual(raw.retainedUnknown);
  expect(paths.raw().legacy).toEqual({
    filters: raw.filters,
    presets: raw.presets,
  });
  expect(
    paths
      .raw()
      .rememberedProfiles.custom.bands.map((b: any) => [
        b.frequency,
        b.gain,
        b.Q,
      ]),
  ).toEqual([
    [500, 3, 2],
    [80, 12, 100],
  ]);
  const before = paths.raw().userPresets;
  await picker(page).selectOption('bass');
  await expect(page.locator('.eq-band')).toHaveCount(1);
  await expect(page.getByLabel('plugins.equalizer.editor.preamp')).toHaveValue(
    '-12',
  );
  await picker(page).selectOption('flat');
  await expect(page.locator('.eq-band')).toHaveCount(0);
  expect(paths.raw().userPresets).toEqual(before);
});

test('stock selection remembers an edited graphic layout without appending bands on a return', async ({
  page,
}) => {
  const profile = flatProfile('graphic-14');
  profile.bands[0].gain = 3;
  const paths = await editor(
    page,
    editedConfig((await configPaths()).ipcRead(), profile),
  );
  await selectStock(page, 'acoustic');
  expect(paths.ipcRead().rememberedProfiles['graphic-14']).toEqual(profile);
  await page
    .getByLabel('plugins.equalizer.editor.layout')
    .selectOption('graphic-14');
  await expect(page.locator('.eq-band')).toHaveCount(14);
  await expect.poll(() => paths.ipcRead().profile.bands.length).toBe(14);
  expect(paths.ipcRead().profile).toEqual(profile);
  await selectStock(page, 'rock');
  await selectStock(page, 'bass-reducer');
  expect(paths.ipcRead().profile.bands).toHaveLength(10);
  expect(paths.ipcRead().profile.preamp).toBe(0);
});
