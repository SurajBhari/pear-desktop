import { test, expect } from '@playwright/test';
import { deepmerge, deepmergeCustom } from 'deepmerge-ts';
import {
  defaultConfig,
  flatProfile,
  normalizeConfig,
  editedConfig,
} from '../src/plugins/equalizer/config';
import { configPaths } from './helpers/equalizer-config-paths';

const replaceArrays = deepmergeCustom({ mergeArrays: false });
// Installed config.setPartial and get-config/menu/watch use these respective mergers.
test('installed merger contract keeps exact 8/14/20 counts and permits custom/preset clear', () => {
  let saved: any = {};
  const read = () => deepmerge(defaultConfig, saved);
  const write = (value: object) =>
    (saved = replaceArrays(defaultConfig, saved, value));
  for (const count of [8, 14, 20] as const)
    for (let repeat = 0; repeat < 3; repeat++) {
      const profile = flatProfile(`graphic-${count}`);
      write(editedConfig(read(), profile));
      expect(normalizeConfig(read()).profile?.bands).toHaveLength(count);
      expect((read() as any).profile.bands).toHaveLength(count);
    }
  write(
    editedConfig(
      read(),
      { mode: 'custom', bands: [], preamp: 0 },
      { userPresets: [] },
    ),
  );
  expect((read() as any).profile.bands).toEqual([]);
  expect((read() as any).userPresets).toEqual([]);
  expect(normalizeConfig(read()).profile?.bands).toEqual([]);
});

test('actual IPC/menu setters and watcher readers roundtrip exact counts, removal and preset deletion', async () => {
  const paths = await configPaths();
  for (const count of [8, 14, 20] as const)
    for (let repeat = 0; repeat < 3; repeat++) {
      const profile = flatProfile(`graphic-${count}`);
      const value = editedConfig(paths.ipcRead(), profile);
      if (repeat % 2) await paths.menu.setConfig(value);
      else paths.ipcWrite(value);
      expect(paths.ipcRead().profile.bands).toHaveLength(count);
      expect((await paths.menu.getConfig()).profile.bands).toHaveLength(count);
      expect(paths.reads.at(-1).profile.bands).toHaveLength(count);
    }
  const custom = { ...flatProfile('graphic-8'), mode: 'custom' as const };
  paths.ipcWrite(
    editedConfig(paths.ipcRead(), custom, {
      userPresets: [{ id: 'owned', name: 'Owned preset', profile: custom }],
    }),
  );
  await paths.menu.setConfig(
    editedConfig(await paths.menu.getConfig(), {
      ...custom,
      bands: custom.bands.slice(1),
    }),
  );
  expect(paths.ipcRead().profile.bands).toHaveLength(7);
  await paths.menu.setConfig(
    editedConfig(
      paths.ipcRead(),
      { ...custom, bands: [] },
      { userPresets: [] },
    ),
  );
  for (const read of [
    paths.ipcRead(),
    await paths.menu.getConfig(),
    paths.reads.at(-1),
  ]) {
    expect(read.profile.bands).toEqual([]);
    expect(read.userPresets).toEqual([]);
  }
});

test('legacy shelf/settings are retained without mutating raw config or truncating oversized/future data', () => {
  const raw: any = {
    enabled: true,
    filters: [{ type: 'peaking', frequency: 500, gain: 3, Q: 2 }],
    presets: { 'bass-booster': true },
    privateUnknown: 'retained',
  };
  const before = structuredClone(raw);
  const normalized = normalizeConfig(deepmerge(defaultConfig, raw));
  expect(normalized.profile?.bands.map((b) => b.type)).toEqual([
    'peaking',
    'lowshelf',
  ]);
  expect(normalized.profile?.bands[1].Q).toBe(100);
  expect(raw).toEqual(before);
  for (const unsupported of [
    { ...raw, schemaVersion: 3 },
    { ...raw, filters: Array.from({ length: 65 }, () => raw.filters[0]) },
  ]) {
    const snapshot = structuredClone(unsupported);
    expect(
      normalizeConfig(deepmerge(defaultConfig, unsupported)).editable,
    ).toBe(false);
    expect(unsupported).toEqual(snapshot);
  }
});
