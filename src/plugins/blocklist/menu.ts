import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import {
  normalizeArtist,
  sameArtist,
  validArtistList,
  type BlockedArtist,
} from './matching';

import type { BlocklistPluginConfig } from './index';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export async function onMenu(
  context: MenuContext<BlocklistPluginConfig>,
): Promise<MenuTemplate> {
  const { window, getConfig, setConfig, refresh } = context;
  const config = await getConfig();
  if (window.isDestroyed()) return [];
  if (!validArtistList(config.blockedArtists))
    return [{ label: t('plugins.blocklist.menu.unsupported'), enabled: false }];
  let writes = Promise.resolve();
  const mutate = (edit: (artists: BlockedArtist[]) => BlockedArtist[]) => {
    const result = writes.then(async () => {
      const latest = await getConfig();
      if (
        window.isDestroyed() ||
        !latest.enabled ||
        !validArtistList(latest.blockedArtists)
      )
        return;
      const artists = edit(latest.blockedArtists);
      if (artists === latest.blockedArtists) return;
      await setConfig({ blockedArtists: artists });
      if (!window.isDestroyed()) await refresh();
    });
    writes = result.catch((error) =>
      console.error('[blocklist] Could not save artist list', error),
    );
    return writes;
  };
  const ask = async (artist?: BlockedArtist) => {
    if (window.isDestroyed()) return;
    const output: unknown = await prompt(
      {
        title: t(
          `plugins.blocklist.menu.${artist ? 'edit' : 'add'}.prompt-title`,
        ),
        label: t('plugins.blocklist.menu.add.prompt-label'),
        type: 'input',
        value: artist?.name || '',
        width: 400,
        ...promptOptions(),
      },
      window,
    );
    if (window.isDestroyed() || typeof output !== 'string') return;
    const name = output.trim();
    if (!name || name.length > 200) return;
    await mutate((artists) => {
      const candidate = {
        name,
        ...(artist?.channelId &&
        normalizeArtist(name) === normalizeArtist(artist.name)
          ? { channelId: artist.channelId }
          : {}),
      };
      if (
        artists.some(
          (item) =>
            item !== artist &&
            sameArtist(item, candidate) &&
            (!artist || !sameArtist(item, artist)),
        )
      )
        return artists;
      if (!artist)
        return artists.some((item) => sameArtist(item, candidate))
          ? artists
          : [...artists, candidate];
      if (!artists.some((item) => sameArtist(item, artist))) return artists;
      return artists.map((item) =>
        sameArtist(item, artist)
          ? { ...item, ...candidate, channelId: candidate.channelId }
          : item,
      );
    });
  };
  const template: MenuTemplate = [
    { label: t('plugins.blocklist.menu.add.label'), click: () => ask() },
    { type: 'separator' },
  ];
  if (!config.blockedArtists.length)
    template.push({
      label: t('plugins.blocklist.menu.no-artists'),
      enabled: false,
    });
  for (const artist of config.blockedArtists)
    template.push({
      label: artist.name,
      submenu: [
        {
          label: t('plugins.blocklist.menu.edit.label'),
          click: () => ask(artist),
        },
        {
          label: t('plugins.blocklist.menu.remove'),
          click: () =>
            mutate((artists) =>
              artists.filter((item) => !sameArtist(item, artist)),
            ),
        },
      ],
    });
  if (config.blockedArtists.length)
    template.push(
      { type: 'separator' },
      {
        label: t('plugins.blocklist.menu.clear'),
        click: () => mutate(() => []),
      },
    );
  return template;
}
