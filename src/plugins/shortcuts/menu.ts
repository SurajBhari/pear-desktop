import prompt, { type KeybindOptions } from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import type {
  SeekSecondsKey,
  ShortcutMappingType,
  ShortcutsPluginConfig,
} from './index';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

const actions: (keyof ShortcutMappingType)[] = [
  'previous',
  'playPause',
  'next',
  'seekForward',
  'seekBackward',
];
const labels: Record<keyof ShortcutMappingType, string> = {
  previous: 'previous',
  playPause: 'play-pause',
  next: 'next',
  seekForward: 'seek-forward',
  seekBackward: 'seek-backward',
};
const seekSettings: { key: SeekSecondsKey; label: string; fallback: number }[] =
  [
    { key: 'seekForwardSeconds', label: 'music-forward', fallback: 5 },
    { key: 'seekBackwardSeconds', label: 'music-backward', fallback: 5 },
    {
      key: 'podcastSeekForwardSeconds',
      label: 'podcast-forward',
      fallback: 10,
    },
    {
      key: 'podcastSeekBackwardSeconds',
      label: 'podcast-backward',
      fallback: 30,
    },
  ];

export const onMenu = async ({
  window,
  getConfig,
  setConfig,
}: MenuContext<ShortcutsPluginConfig>): Promise<MenuTemplate> => {
  const config = await getConfig();
  const promptKeybind = async (scope: 'global' | 'local') => {
    const current = await getConfig();
    if (window.isDestroyed()) return;
    const options: KeybindOptions[] = actions.map((action) => ({
      value: action,
      label: t(
        `plugins.shortcuts.prompt.keybind.keybind-options.${labels[action]}`,
      ),
      default: current[scope]?.[action],
    }));
    const output: unknown = await prompt(
      {
        title: t('plugins.shortcuts.prompt.keybind.title'),
        label: t(`plugins.shortcuts.prompt.keybind.${scope}-label`),
        type: 'keybind',
        keybindOptions: options,
        height: 380,
        ...promptOptions(),
      },
      window,
    );
    if (!Array.isArray(output) || window.isDestroyed()) return;
    const latest = await getConfig();
    if (window.isDestroyed()) return;
    const mapping = { ...latest[scope] };
    let changed = false;
    for (const entry of output) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('value' in entry) ||
        !('accelerator' in entry) ||
        typeof entry.value !== 'string' ||
        typeof entry.accelerator !== 'string' ||
        !actions.includes(entry.value as keyof ShortcutMappingType)
      )
        continue;
      mapping[entry.value as keyof ShortcutMappingType] = entry.accelerator;
      changed = true;
    }
    if (changed) await setConfig({ [scope]: mapping });
  };
  return [
    {
      label: t('plugins.shortcuts.menu.set-keybinds'),
      click: () => promptKeybind('global'),
    },
    {
      label: t('plugins.shortcuts.menu.set-local-keybinds'),
      click: () => promptKeybind('local'),
    },
    {
      label: t('plugins.shortcuts.menu.seek-seconds'),
      type: 'submenu',
      submenu: seekSettings.map(({ key, label, fallback }) => ({
        label: t(`plugins.shortcuts.menu.seek.${label}`),
        async click() {
          const current = await getConfig();
          if (window.isDestroyed()) return;
          const output: unknown = await prompt(
            {
              title: t('plugins.shortcuts.prompt.seek.title'),
              label: t(`plugins.shortcuts.menu.seek.${label}`),
              value: String(current[key] ?? fallback),
              type: 'counter',
              counterOptions: { minimum: 1, maximum: 600, multiFire: true },
              width: 450,
              ...promptOptions(),
            },
            window,
          );
          if (
            output === null ||
            output === undefined ||
            window.isDestroyed() ||
            (typeof output !== 'string' && typeof output !== 'number')
          )
            return;
          const value = Number(output);
          if (Number.isFinite(value) && value >= 1 && value <= 600)
            await setConfig({ [key]: value });
        },
      })),
    },
    {
      label: t('plugins.shortcuts.menu.override-media-keys'),
      type: 'checkbox',
      checked: config.overrideMediaKeys,
      click: (item) => setConfig({ overrideMediaKeys: item.checked }),
    },
  ];
};
