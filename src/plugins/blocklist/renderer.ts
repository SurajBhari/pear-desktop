import { t } from '@/i18n';
import { isPlayerMenu } from '@/plugins/utils/renderer/check';
import { getSongMenu } from '@/providers/dom-elements';
import { getSongInfo } from '@/providers/song-info-front';

import {
  channelIdFromUrl,
  normalizeArtist,
  sameArtist,
  validArtistList,
  type BlockedArtist,
} from './matching';

import type { BlocklistPluginConfig } from './index';
import type { MusicPlayer } from '@/types/music-player';

/** Artist target resolution adapted from #4567; never substitute current artist for an unrelated row. */
export function createBlocklistUI(
  getConfig: () => BlocklistPluginConfig,
  getApi: () => MusicPlayer | undefined,
  save: (artist: BlockedArtist, isOwned: () => boolean) => Promise<boolean>,
) {
  let disposed = false;
  let popup: HTMLElement | null = null;
  let popupObserver: MutationObserver | undefined;
  const owned = new Set<HTMLElement>();
  let popupEpoch = 0;
  const clear = () => {
    popupEpoch++;
    for (const node of owned) node.remove();
    owned.clear();
  };
  type NativeIdentity = { videoId?: string; responseVideoId?: string };
  const artistsFor = (
    menu: HTMLElement,
    nativeIdentity?: NativeIdentity,
  ): BlockedArtist[] => {
    const result: BlockedArtist[] = [];
    const add = (name?: string | null, channelId?: string) => {
      if (typeof name !== 'string' || !normalizeArtist(name) || !channelId)
        return;
      const artist = { name: name.trim(), channelId };
      if (!result.some((item) => sameArtist(item, artist))) result.push(artist);
    };
    if (isPlayerMenu(menu))
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        'ytmusic-player-bar a.yt-simple-endpoint[href]',
      ))
        add(
          link.textContent,
          channelIdFromUrl(link.getAttribute('href') || undefined),
        );
    if (result.length) return result;
    for (const endpoint of menu.querySelectorAll<HTMLElement>(
      '#navigation-endpoint',
    )) {
      const id = channelIdFromUrl(endpoint.getAttribute('href') || undefined);
      if (!id) continue;
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        `a[href*="${id}"]`,
      )) {
        if (
          link.closest('ytmusic-popup-container') ||
          channelIdFromUrl(link.getAttribute('href') || undefined) !== id
        )
          continue;
        if (link.textContent?.trim()) {
          add(link.textContent, id);
          break;
        }
      }
    }
    if (!result.length && isPlayerMenu(menu)) {
      const api = getApi();
      const info = getSongInfo();
      try {
        if (
          typeof info?.artist === 'string' &&
          normalizeArtist(info.artist) &&
          info.videoId
        ) {
          const identity = nativeIdentity ?? {
            videoId: api?.getVideoData()?.video_id,
            responseVideoId: api?.getPlayerResponse()?.videoDetails.videoId,
          };
          if (
            info.videoId === identity.videoId &&
            info.videoId === identity.responseVideoId
          )
            result.push({
              name: info.artist,
              ...(channelIdFromUrl(info.artistUrl)
                ? { channelId: channelIdFromUrl(info.artistUrl) }
                : {}),
            });
        }
      } catch {
        /* unavailable current identity: leave the menu unmodified */
      }
    }
    return validArtistList(result) ? result : [];
  };
  const refresh = () => {
    if (disposed) return;
    const menu = getSongMenu();
    const config = getConfig();
    const artists =
      menu && config.enabled && validArtistList(config.blockedArtists)
        ? artistsFor(menu)
        : [];
    const key = JSON.stringify(artists);
    if (
      menu &&
      [...owned].every(
        (node) =>
          node.isConnected &&
          menu.contains(node) &&
          node.dataset.blocklistKey === key,
      ) &&
      owned.size === artists.length
    )
      return;
    clear();
    if (!menu) return;
    const fragment = document.createDocumentFragment();
    for (const artist of artists) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blocklist-injected blocklist-menu-item';
      button.setAttribute('role', 'menuitem');
      button.textContent = t('plugins.blocklist.templates.button', {
        name: artist.name,
      });
      button.dataset.blocklistKey = key;
      button.onclick = async () => {
        if (disposed || !button.isConnected) return;
        const epoch = popupEpoch;
        const originPopup = menu.closest('ytmusic-popup-container');
        const originApi = getApi();
        let originVideoId: string | undefined;
        try {
          const id = originApi?.getVideoData()?.video_id;
          if (id && id === originApi?.getPlayerResponse()?.videoDetails.videoId)
            originVideoId = id;
        } catch {
          return;
        }
        const ownsPopup = () =>
          !disposed &&
          popupEpoch === epoch &&
          getConfig().enabled &&
          owned.has(button) &&
          button.isConnected &&
          menu.contains(button) &&
          getSongMenu() === menu &&
          popup === originPopup &&
          !!originPopup?.isConnected &&
          getApi() === originApi;
        const isOwned = () => {
          if (!ownsPopup()) return false;
          try {
            const identity: NativeIdentity = {
              videoId: originApi?.getVideoData()?.video_id,
              responseVideoId:
                originApi?.getPlayerResponse()?.videoDetails.videoId,
            };
            return (
              (!originVideoId ||
                (identity.videoId === originVideoId &&
                  identity.responseVideoId === originVideoId)) &&
              JSON.stringify(artistsFor(menu, identity)) === key &&
              ownsPopup()
            );
          } catch {
            return false;
          }
        };
        if (!isOwned()) return;
        const latest = getConfig();
        if (!validArtistList(latest.blockedArtists)) return;
        const artists = latest.blockedArtists.some((item) =>
          sameArtist(item, artist),
        )
          ? latest.blockedArtists
          : [...latest.blockedArtists, artist];
        if (
          !validArtistList(artists) ||
          !(await save(artist, isOwned)) ||
          !isOwned()
        )
          return;
        const dropdown = menu.closest<HTMLElement & { close?: () => void }>(
          'tp-yt-iron-dropdown',
        );
        if (dropdown && originPopup?.contains(dropdown)) dropdown.close?.();
      };
      owned.add(button);
      fragment.append(button);
    }
    menu.prepend(fragment);
  };
  const attach = () => {
    if (disposed) return;
    const next = popup?.isConnected
      ? popup
      : document.querySelector<HTMLElement>('ytmusic-popup-container');
    if (next === popup) return;
    popupObserver?.disconnect();
    popup = next;
    if (popup) {
      popupObserver = new MutationObserver(refresh);
      popupObserver.observe(popup, { childList: true, subtree: true });
    }
    refresh();
  };
  const observer = new MutationObserver(attach);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  attach();
  return {
    refresh,
    stop() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      popupObserver?.disconnect();
      clear();
      popup = null;
    },
  };
}
