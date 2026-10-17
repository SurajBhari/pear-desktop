import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import {
  applyScrobblerPatch,
  type ScrobblerPluginConfig,
  type ScrobblerConfigPatch,
  type WsServiceName,
} from './config';
import { backend } from './main';
import { validMusicBrainzEmail } from './services/musicbrainz';
import { RegexFilters } from './services/regex-filters';

import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export const onMenu = async ({
  window,
  getConfig,
  setConfig,
}: MenuContext<ScrobblerPluginConfig>): Promise<MenuTemplate> => {
  const epoch = backend.lifecycleRevision ?? 0;
  const contents = window.webContents;
  let frame: Electron.WebFrameMain | undefined;
  try {
    frame = contents.mainFrame;
  } catch {
    return [];
  }
  const current = () => {
    try {
      return (
        (backend.lifecycleRevision ?? 0) === epoch &&
        !window.isDestroyed() &&
        !contents.isDestroyed() &&
        window.webContents === contents &&
        contents.mainFrame === frame
      );
    } catch {
      return false;
    }
  };
  const config = await getConfig();
  if (!current()) return [];
  const write = (patch: ScrobblerConfigPatch) =>
    current() ? applyScrobblerPatch(setConfig, patch) : undefined;
  const contact = async (enable = false) => {
    const original = await getConfig();
    if (!current()) return false;
    const originalEmail = original.musicBrainzEmail,
      originalEnabled = original.useMusicBrainz;
    const output: unknown = await prompt(
      {
        title: t('plugins.scrobbler.prompt.musicbrainz-email.title'),
        label: t('plugins.scrobbler.prompt.musicbrainz-email.label'),
        type: 'input',
        value: original.musicBrainzEmail ?? '',
        inputAttrs: { type: 'email', maxLength: 254 },
        ...promptOptions(),
      },
      window,
    );
    if (!current() || typeof output !== 'string') return false;
    const email = output.trim();
    if ((email !== '' && !validMusicBrainzEmail(email)) || (enable && !email))
      return false;
    const latest = await getConfig();
    if (
      !current() ||
      latest.musicBrainzEmail !== originalEmail ||
      (enable && latest.useMusicBrainz !== originalEnabled)
    )
      return false;
    await write({
      musicBrainzEmail: email,
      ...(enable
        ? { useMusicBrainz: true }
        : !email
          ? { useMusicBrainz: false }
          : {}),
    });
    return current();
  };
  const editFilter = async (index: number) => {
    const original = await getConfig();
    if (!current()) return;
    const snapshot = JSON.stringify(original.customRegexFilters ?? []);
    const patterns = original.customRegexFilters ?? [];
    if (
      !Array.isArray(patterns) ||
      patterns.length > 32 ||
      patterns.some((value) => typeof value !== 'string') ||
      index > patterns.length
    )
      return;
    const output: unknown = await prompt(
      {
        title: t('plugins.scrobbler.menu.regex-filters'),
        label: t('plugins.scrobbler.prompt.regex-filter.label'),
        type: 'input',
        value: patterns[index] ?? '',
        inputAttrs: { type: 'text', maxLength: 256 },
        ...promptOptions(),
      },
      window,
    );
    if (!current() || typeof output !== 'string' || /[\r\n]/.test(output))
      return;
    const next = [...patterns];
    if (output.trim()) next[index] = output.trim();
    else next.splice(index, 1);
    const validator = new RegexFilters();
    let result;
    try {
      result = await validator.validate(next.join('\n'));
    } finally {
      validator.stop();
    }
    if (!current()) return;
    if (!result.ok) {
      const { dialog } = await import('electron');
      if (current())
        await dialog.showMessageBox(window, {
          type: 'error',
          title: t('plugins.scrobbler.dialog.invalid-regex.title'),
          message: t('plugins.scrobbler.dialog.invalid-regex.message', {
            line: result.line ?? index + 1,
          }),
        });
      return;
    }
    const latest = await getConfig();
    if (
      current() &&
      JSON.stringify(latest.customRegexFilters ?? []) === snapshot
    )
      await write({ customRegexFilters: result.patterns });
  };
  const tuple = (value: ScrobblerPluginConfig, name: WsServiceName) => {
    const account = value.scrobblers?.[name];
    return JSON.stringify([account?.apiRoot, account?.apiKey, account?.secret]);
  };
  const settings = async (name: WsServiceName) => {
    const original = await getConfig();
    if (!current()) return;
    const account = original.scrobblers?.[name];
    if (!account) return;
    const originalTuple = tuple(original, name),
      originalKey = account.apiKey ?? null,
      originalSecret = account.secret ?? null;
    const output: unknown = await prompt(
      {
        title:
          (name === 'lastfm' ? 'Last.fm' : 'Libre.fm') +
          ' — ' +
          t('plugins.scrobbler.menu.lastfm.api-settings'),
        label: t('plugins.scrobbler.menu.lastfm.api-settings'),
        type: 'multiInput',
        multiInputOptions: [
          {
            label: t('plugins.scrobbler.prompt.lastfm.api-key'),
            value: account.apiKey ?? '',
            inputAttrs: { type: 'text' },
          },
          {
            label: t('plugins.scrobbler.prompt.lastfm.api-secret'),
            value: account.secret ?? '',
            inputAttrs: { type: 'password' },
          },
        ],
        resizable: true,
        height: 360,
        ...promptOptions(),
      },
      window,
    );
    if (
      !current() ||
      !Array.isArray(output) ||
      output.length !== 2 ||
      output.some((v) => typeof v !== 'string')
    )
      return;
    const latest = await getConfig();
    if (!current() || tuple(latest, name) !== originalTuple) return;
    const [keyValue, secretValue] = output;
    if (typeof keyValue !== 'string' || typeof secretValue !== 'string') return;
    const next: { apiKey?: string | null; secret?: string | null } = {};
    const key = keyValue || null,
      secret = secretValue || null;
    if (key !== originalKey) next.apiKey = key;
    if (secret !== originalSecret) next.secret = secret;
    if (!Object.keys(next).length) return;
    await write(
      name === 'lastfm'
        ? { scrobblers: { lastfm: next } }
        : { scrobblers: { librefm: next } },
    );
  };
  const listenSettings = async () => {
    const original = await getConfig();
    if (!current()) return;
    const originalRoot = original.scrobblers.listenbrainz.apiRoot,
      originalToken = original.scrobblers.listenbrainz.token ?? null;
    const output: unknown = await prompt(
      {
        title: t('plugins.scrobbler.prompt.listenbrainz.token.title'),
        label: t('plugins.scrobbler.prompt.listenbrainz.token.label'),
        type: 'input',
        value: originalToken ?? '',
        inputAttrs: { type: 'password' },
        ...promptOptions(),
      },
      window,
    );
    if (!current() || typeof output !== 'string') return;
    const latest = await getConfig();
    if (
      !current() ||
      latest.scrobblers.listenbrainz.apiRoot !== originalRoot ||
      (latest.scrobblers.listenbrainz.token ?? null) !== originalToken
    )
      return;
    const token = output || null;
    if (token !== originalToken)
      await write({ scrobblers: { listenbrainz: { token } } });
  };
  const compatible = (name: WsServiceName) => ({
    label: name === 'lastfm' ? 'Last.fm' : 'Libre.fm',
    submenu: [
      {
        label: t('main.menu.plugins.enabled'),
        type: 'checkbox' as const,
        checked: config.scrobblers[name]?.enabled === true,
        click(item: Electron.MenuItem) {
          return write(
            name === 'lastfm'
              ? { scrobblers: { lastfm: { enabled: item.checked } } }
              : { scrobblers: { librefm: { enabled: item.checked } } },
          );
        },
      },
      {
        label: t('plugins.scrobbler.menu.lastfm.api-settings'),
        click: () => settings(name),
      },
      {
        label: 'Authenticate',
        click: () =>
          current() ? backend.authenticate?.(name, window) : undefined,
      },
    ],
  });
  return [
    {
      label: t('plugins.scrobbler.menu.scrobble-other-media'),
      type: 'checkbox',
      checked: config.scrobbleOtherMedia,
      click: (item) => write({ scrobbleOtherMedia: item.checked }),
    },
    {
      label: t('plugins.scrobbler.menu.scrobble-alternative-title'),
      type: 'checkbox',
      checked: config.alternativeTitles,
      click: (item) => write({ alternativeTitles: item.checked }),
    },
    {
      label: t('plugins.scrobbler.menu.scrobble-alternative-artist'),
      type: 'checkbox',
      checked: config.artistSource === 'first-tag',
      click: (item) =>
        write({ artistSource: item.checked ? 'first-tag' : 'primary' }),
    },
    {
      label: t('plugins.scrobbler.menu.regex-filters'),
      submenu: [
        {
          label: t('main.menu.plugins.enabled'),
          type: 'checkbox',
          checked: config.regexFiltersEnabled === true,
          click: (item) => write({ regexFiltersEnabled: item.checked }),
        },
        ...(Array.isArray(config.customRegexFilters)
          ? config.customRegexFilters.slice(0, 32)
          : []
        ).map((pattern, index) => ({
          label: `${index + 1}. ${String(pattern).slice(0, 100)}`,
          click: () => editFilter(index),
        })),
        {
          label: t('plugins.scrobbler.menu.add-regex-filter'),
          enabled: (config.customRegexFilters?.length ?? 0) < 32,
          click: () => editFilter(config.customRegexFilters?.length ?? 0),
        },
      ],
    },
    {
      label: t('plugins.scrobbler.menu.use-musicbrainz'),
      type: 'checkbox',
      checked: config.useMusicBrainz === true,
      async click(item) {
        const original = await getConfig();
        if (!current()) return;
        if (item.checked && !validMusicBrainzEmail(original.musicBrainzEmail)) {
          item.checked = await contact(true);
        } else await write({ useMusicBrainz: item.checked });
      },
    },
    {
      label: t('plugins.scrobbler.menu.musicbrainz-email'),
      click: () => contact(),
    },
    compatible('lastfm'),
    compatible('librefm'),
    {
      label: 'ListenBrainz',
      submenu: [
        {
          label: t('main.menu.plugins.enabled'),
          type: 'checkbox',
          checked: config.scrobblers.listenbrainz.enabled,
          click: (item) =>
            write({ scrobblers: { listenbrainz: { enabled: item.checked } } }),
        },
        {
          label: t('plugins.scrobbler.menu.listenbrainz.token'),
          click: listenSettings,
        },
      ],
    },
  ];
};
