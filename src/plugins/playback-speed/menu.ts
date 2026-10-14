import { t } from '@/i18n';

import { backend } from './main';

import type { PlaybackSpeedPluginConfig } from './index';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

const keys = ['speedUp', 'speedDown'] as const;
export const onMenu = async ({
  window,
  getConfig,
  setConfig,
}: MenuContext<PlaybackSpeedPluginConfig>): Promise<MenuTemplate> => {
  const generation = backend.generation,
    documentRevision = backend.documentRevision;
  const contents = window?.webContents,
    frame = contents?.mainFrame;
  const current = () => {
    try {
      const unavailable =
        window &&
        (window.isDestroyed() ||
          window.webContents !== contents ||
          contents?.isDestroyed?.() ||
          contents?.mainFrame !== frame);
      return (
        !unavailable &&
        generation === backend.generation &&
        documentRevision === backend.documentRevision
      );
    } catch {
      return false;
    }
  };
  const config = await getConfig();
  if (!current()) return [];
  return [
    {
      label: t('plugins.playback-speed.menu.preserve-pitch'),
      type: 'checkbox',
      checked: config.preservesPitch !== false,
      click: (item) =>
        current() ? setConfig({ preservesPitch: item.checked }) : undefined,
    },
    {
      label: t('plugins.playback-speed.menu.global-shortcuts'),
      async click() {
        const initial = await getConfig();
        if (!current()) return;
        const original = { ...initial.globalShortcuts };
        const { default: prompt } = await import('custom-electron-prompt');
        if (!current()) return;
        const output: unknown = await prompt(
          {
            title: t('plugins.playback-speed.prompt.global-shortcuts.title'),
            label: t('plugins.playback-speed.prompt.global-shortcuts.label'),
            type: 'keybind',
            keybindOptions: keys.map((value) => ({
              value,
              label: t(
                `plugins.playback-speed.prompt.global-shortcuts.${value}`,
              ),
              default: original[value],
            })),
            customStylesheet: 'dark',
          },
          window,
        );
        if (!Array.isArray(output) || !current()) return;
        const latest = await getConfig();
        if (!current()) return;
        const mapping = { ...latest.globalShortcuts };
        let changed = false;
        for (const entry of output) {
          if (
            !entry ||
            typeof entry !== 'object' ||
            !('value' in entry) ||
            !('accelerator' in entry) ||
            typeof entry.value !== 'string' ||
            typeof entry.accelerator !== 'string' ||
            !keys.includes(entry.value as (typeof keys)[number])
          )
            continue;
          const key = entry.value as (typeof keys)[number];
          if (
            entry.accelerator === original[key] ||
            latest.globalShortcuts?.[key] !== original[key]
          )
            continue;
          mapping[key] = entry.accelerator;
          changed = true;
        }
        if (changed && current()) await setConfig({ globalShortcuts: mapping });
      },
    },
    {
      label: t('plugins.playback-speed.menu.step'),
      async click() {
        const initial = await getConfig();
        if (!current()) return;
        const original = initial.step;
        const { default: prompt } = await import('custom-electron-prompt');
        if (!current()) return;
        const output: unknown = await prompt(
          {
            title: t('plugins.playback-speed.prompt.step.title'),
            label: t('plugins.playback-speed.prompt.step.label'),
            value: String(original ?? 0.1),
            type: 'counter',
            counterOptions: { minimum: 0.01, maximum: 15.93, multiFire: true },
            customStylesheet: 'dark',
          },
          window,
        );
        if (
          (typeof output !== 'string' && typeof output !== 'number') ||
          !current()
        )
          return;
        const value = Number(output);
        if (!Number.isFinite(value) || value < 0.01 || value > 15.93) return;
        const latest = await getConfig();
        if (current() && latest.step === original)
          await setConfig({ step: value });
      },
    },
  ];
};
