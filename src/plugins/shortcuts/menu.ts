import prompt, { type KeybindOptions } from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import { backend } from './main';

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
  'like',
  'dislike',
];
const labels: Record<keyof ShortcutMappingType, string> = {
  previous: 'previous',
  playPause: 'play-pause',
  next: 'next',
  seekForward: 'seek-forward',
  seekBackward: 'seek-backward',
  like: 'like',
  dislike: 'dislike',
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
  const generation = backend.generation,
    documentRevision = backend.documentRevision;
  const contents = window.webContents,
    frame = contents.mainFrame;
  const currentOwner = () => {
    try {
      const unavailable =
        window.isDestroyed() ||
        window.webContents !== contents ||
        contents.isDestroyed?.() ||
        contents.mainFrame !== frame;
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
  if (!currentOwner()) return [];
  const promptKeybind = async (scope: 'global' | 'local') => {
    const current = await getConfig();
    if (!currentOwner()) return;
    const originalMapping = { ...current[scope] };
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
    if (!Array.isArray(output) || !currentOwner()) return;
    const latest = await getConfig();
    if (!currentOwner()) return;
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
      const action = entry.value as keyof ShortcutMappingType;
      if (
        entry.accelerator === originalMapping[action] ||
        latest[scope]?.[action] !== originalMapping[action]
      )
        continue;
      mapping[action] = entry.accelerator;
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
          if (!currentOwner()) return;
          const originalValue = current[key];
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
            !currentOwner() ||
            (typeof output !== 'string' && typeof output !== 'number')
          )
            return;
          const value = Number(output);
          const latest = await getConfig();
          if (
            Number.isFinite(value) &&
            value >= 1 &&
            value <= 600 &&
            currentOwner() &&
            latest[key] === originalValue
          )
            await setConfig({ [key]: value });
        },
      })),
    },
    {
      label: t('plugins.shortcuts.menu.override-media-keys'),
      type: 'checkbox',
      checked: config.overrideMediaKeys,
      click: (item) =>
        currentOwner()
          ? setConfig({ overrideMediaKeys: item.checked })
          : undefined,
    },
    {
      label: t('plugins.shortcuts.menu.focus-window-on-double-play-pause'),
      sublabel: t('plugins.shortcuts.menu.double-command-repeat-info'),
      type: 'checkbox',
      checked: config.focusWindowOnDoublePlayPause === true,
      click: (item) =>
        currentOwner()
          ? setConfig({ focusWindowOnDoublePlayPause: item.checked })
          : undefined,
    },
  ];
};
