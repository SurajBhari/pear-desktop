import nextIcon from '@assets/media-icons-black/next.png?asset&asarUnpack';
import pauseIcon from '@assets/media-icons-black/pause.png?asset&asarUnpack';
import playIcon from '@assets/media-icons-black/play.png?asset&asarUnpack';
import previousIcon from '@assets/media-icons-black/previous.png?asset&asarUnpack';
import {
  app,
  ipcMain,
  type BrowserWindow,
  Notification,
  type IpcMainEvent,
} from 'electron';

import {
  APP_PROTOCOL,
  registerOwnedProtocolHandler,
} from '@/providers/protocol-handler';
import { getSongControls } from '@/providers/song-controls';
import { type SongInfo, type SongInfoEvent } from '@/providers/song-info';
import {
  registerOwnedTrayOnClick,
  registerOwnedTrayOnDoubleClick,
} from '@/tray';
import { mediaIcons } from '@/types/media-icons';

import { notificationImage, secondsToMinutes, ToastStyles } from './utils';

import type { NotificationsPluginConfig } from './index';
import type { BackendContext } from '@/types/contexts';

type Accessor<T> = () => T;

export default (
  win: BrowserWindow,
  config: Accessor<NotificationsPluginConfig>,
  { ipc: { send } }: BackendContext<NotificationsPluginConfig>,
  owner: { isCurrent(): boolean },
) => {
  const closeListeners = new Map<Notification, () => void>();
  let live = true,
    savedNotification: Notification | undefined,
    savedSongInfo: SongInfo | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const releases: Array<() => void> = [];
  const current = () => live && owner.isCurrent() && live;
  const close = () => {
    clearTimeout(timer);
    timer = undefined;
    const previous = savedNotification;
    savedNotification = undefined;
    if (previous) {
      const listener = closeListeners.get(previous);
      if (listener) previous.removeListener('close', listener);
      closeListeners.delete(previous);
      previous.close();
    }
  };
  const sendNotification = (songInfo: SongInfo) => {
    if (!current()) return;
    const iconSrc = notificationImage(songInfo, config());
    if (!current()) return;
    const icon = typeof iconSrc === 'object' ? iconSrc.toDataURL() : iconSrc;
    if (!current()) return;
    const xml = getXml(songInfo, icon);
    if (!current()) return;
    close();
    if (!current()) return;
    const candidate = new Notification({
      title: songInfo.title || 'Playing',
      body: songInfo.artist,
      icon: iconSrc,
      silent: true,
      toastXml: xml,
    });
    if (!current()) {
      candidate.close();
      return;
    }
    savedNotification = candidate;
    const onClose = () => {
      closeListeners.delete(candidate);
      candidate.removeListener('close', onClose);
      if (savedNotification === candidate) {
        savedNotification = undefined;
        clearTimeout(timer);
        timer = undefined;
      }
    };
    closeListeners.set(candidate, onClose);
    const on = candidate.on.bind(candidate) as (
      event: 'close',
      listener: () => void,
    ) => Notification;
    if (!current()) {
      closeListeners.delete(candidate);
      candidate.close();
      return;
    }
    on('close', onClose);
    if (!current()) {
      candidate.removeListener('close', onClose);
      candidate.close();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (current() && savedNotification === candidate) close();
    }, 5000);
    const show = candidate.show.bind(candidate);
    if (!current()) {
      close();
      return;
    }
    show();
    if (!current() && savedNotification === candidate) close();
  };
  const getXml = (songInfo: SongInfo, iconSrc: string) => {
    switch (config().toastStyle) {
      default:
      case ToastStyles.logo:
      case ToastStyles.legacy: {
        return xmlLogo(songInfo, iconSrc);
      }

      case ToastStyles.banner_top_custom: {
        return xmlBannerTopCustom(songInfo, iconSrc);
      }

      case ToastStyles.hero: {
        return xmlHero(songInfo, iconSrc);
      }

      case ToastStyles.banner_bottom: {
        return xmlBannerBottom(songInfo, iconSrc);
      }

      case ToastStyles.banner_centered_bottom: {
        return xmlBannerCenteredBottom(songInfo, iconSrc);
      }

      case ToastStyles.banner_centered_top: {
        return xmlBannerCenteredTop(songInfo, iconSrc);
      }
    }
  };

  const selectIcon = (kind: keyof typeof mediaIcons): string => {
    switch (kind) {
      case 'play':
        return playIcon;
      case 'pause':
        return pauseIcon;
      case 'next':
        return nextIcon;
      case 'previous':
        return previousIcon;
      default:
        return '';
    }
  };

  const display = (kind: keyof typeof mediaIcons) => {
    if (config().toastStyle === ToastStyles.legacy) {
      return `content="${mediaIcons[kind]}"`;
    }

    return `\
            content="${
              config().toastStyle
                ? ''
                : kind.charAt(0).toUpperCase() + kind.slice(1)
            }"\
            imageUri="file:///${selectIcon(kind)}"
        `;
  };

  const getButton = (kind: keyof typeof mediaIcons) =>
    `<action ${display(
      kind,
    )} activationType="protocol" arguments="${APP_PROTOCOL}://${kind}"/>`;

  const getButtons = (isPaused: boolean) => `\
    <actions>
        ${getButton('previous')}
        ${isPaused ? getButton('play') : getButton('pause')}
        ${getButton('next')}
    </actions>\
`;

  const toast = (content: string, isPaused: boolean) => `\
<toast>
    <audio silent="true" />
    <visual>
        <binding template="ToastGeneric">
            ${content}
        </binding>
    </visual>

    ${getButtons(isPaused)}
</toast>`;

  const xmlImage = (
    { title, artist, isPaused }: SongInfo,
    imgSrc: string,
    placement: string,
  ) =>
    toast(
      `\
            <image id="1" src="${imgSrc}" name="Image" ${placement}/>
            <text id="1">${title}</text>
            <text id="2">${artist}</text>\
`,
      isPaused ?? false,
    );

  const xmlLogo = (songInfo: SongInfo, imgSrc: string) =>
    xmlImage(songInfo, imgSrc, 'placement="appLogoOverride"');

  const xmlHero = (songInfo: SongInfo, imgSrc: string) =>
    xmlImage(songInfo, imgSrc, 'placement="hero"');

  const xmlBannerBottom = (songInfo: SongInfo, imgSrc: string) =>
    xmlImage(songInfo, imgSrc, '');

  const xmlBannerTopCustom = (songInfo: SongInfo, imgSrc: string) =>
    toast(
      `\
            <image id="1" src="${imgSrc}" name="Image" />
            <text>ㅤ</text>
            <group>
                <subgroup>
                    <text hint-style="body">${songInfo.title}</text>
                    <text hint-style="captionSubtle">${songInfo.artist}</text>
                </subgroup>
                ${xmlMoreData(songInfo)}
            </group>\
`,
      songInfo.isPaused ?? false,
    );

  const xmlMoreData = ({ album, elapsedSeconds, songDuration }: SongInfo) => `\
<subgroup hint-textStacking="bottom">
    ${
      album
        ? `<text hint-style="captionSubtle" hint-wrap="true" hint-align="right">${album}</text>`
        : ''
    }
    <text hint-style="captionSubtle" hint-wrap="true" hint-align="right">${secondsToMinutes(
      elapsedSeconds ?? 0,
    )} / ${secondsToMinutes(songDuration)}</text>
</subgroup>\
`;

  const xmlBannerCenteredBottom = (
    { title, artist, isPaused }: SongInfo,
    imgSrc: string,
  ) =>
    toast(
      `\
            <text>ㅤ</text>
            <group>
                <subgroup hint-weight="1" hint-textStacking="center">
                    <text hint-align="center" hint-style="${titleFontPicker(
                      title,
                    )}">${title}</text>
                    <text hint-align="center" hint-style="SubtitleSubtle">${artist}</text>
                </subgroup>
            </group>
            <image id="1" src="${imgSrc}" name="Image"  hint-removeMargin="true" />\
`,
      isPaused ?? false,
    );

  const xmlBannerCenteredTop = (
    { title, artist, isPaused }: SongInfo,
    imgSrc: string,
  ) =>
    toast(
      `\
            <image id="1" src="${imgSrc}" name="Image" />
            <text>ㅤ</text>
            <group>
                <subgroup hint-weight="1" hint-textStacking="center">
                    <text hint-align="center" hint-style="${titleFontPicker(
                      title,
                    )}">${title}</text>
                    <text hint-align="center" hint-style="SubtitleSubtle">${artist}</text>
                </subgroup>
            </group>\
`,
      isPaused ?? false,
    );

  const titleFontPicker = (title: string) => {
    if (title.length <= 13) {
      return 'Header';
    }

    if (title.length <= 22) {
      return 'Subheader';
    }

    if (title.length <= 26) {
      return 'Title';
    }

    return 'Subtitle';
  };

  const songControls = getSongControls(win);
  const loaded = (event: IpcMainEvent) => {
    if (!current()) return;
    try {
      const contents = win.webContents,
        frame = contents.mainFrame;
      if (
        event.sender !== contents ||
        event.senderFrame !== frame ||
        !current() ||
        win.webContents !== contents ||
        contents.mainFrame !== frame
      )
        return;
      send('peard:setup-time-changed-listener');
    } catch {}
  };
  ipcMain.on('peard:player-api-loaded', loaded);
  releases.push(() =>
    ipcMain.removeListener('peard:player-api-loaded', loaded),
  );
  if (config().trayControls) {
    releases.push(
      registerOwnedTrayOnClick({ isCurrent: current }, () => {
        if (!current()) return;
        if (savedNotification) close();
        else if (savedSongInfo) sendNotification(savedSongInfo);
      }),
    );
    releases.push(
      registerOwnedTrayOnDoubleClick({ isCurrent: current }, () => {
        if (!current()) return;
        const visible = win.isVisible();
        if (!current()) return;
        if (visible) win.hide();
        else win.show();
      }),
    );
  }
  const beforeQuit = () => {
    if (current()) close();
  };
  app.on('before-quit', beforeQuit);
  releases.push(() => app.removeListener('before-quit', beforeQuit));
  releases.push(
    registerOwnedProtocolHandler({ isCurrent: current }, (cmd, ...args) => {
      if (!current() || !Object.keys(songControls).includes(cmd)) return;
      // @ts-expect-error: cmd is a runtime-validated key of songControls
      songControls[cmd as keyof typeof songControls](...args);
      // Notification refresh follows observed PlayOrPaused, never a guessed command result.
    }),
  );
  return {
    show: sendNotification,
    observe(info: SongInfo, _event: SongInfoEvent) {
      if (current()) savedSongInfo = { ...info };
    },
    dispose() {
      if (!live) return;
      live = false;
      for (const release of releases.splice(0)) release();
      close();
      savedSongInfo = undefined;
    },
  };
};
