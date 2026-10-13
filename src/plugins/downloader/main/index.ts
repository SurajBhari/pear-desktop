import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

import { Mutex } from 'async-mutex';
import { BG, type BgConfig } from 'bgutils-js';
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Notification,
} from 'electron';
import is from 'electron-is';
import filenamify from 'filenamify';
import lazyVar from 'lazy-var';
import NodeID3 from 'node-id3';
import {
  Innertube,
  UniversalCache,
  YTNodes,
  Platform,
  type YT,
  type YTMusic,
  type Types,
} from '\u0079\u006f\u0075\u0074\u0075\u0062\u0065i.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import {
  registerCallback,
  cleanupName,
  getImage,
  MediaType,
  type SongInfo,
  SongInfoEvent,
} from '@/providers/song-info';

import {
  createDownloaderInitialization,
  type DownloaderInitialization,
} from './initialization';
import {
  cropMaxWidth,
  clearErrorFeedback,
  getFolder,
  sendErrorFeedback,
  sendFeedback as sendFeedback_,
  setBadge,
} from './utils';

import {
  describeAudioFormats,
  selectAudioFormat,
  sourceContainer,
  validateAudioPreference,
  type AudioDescriptor,
} from '../audio';
import {
  checkDuplicate,
  publishCompleted,
  hasVerifiedTrack,
  scanLibrary,
  type CompletedInput,
  type LibraryReport,
} from '../library';
import { downloadSelectedAudio } from '../transfer';
import { DefaultPresetList, type Preset } from '../types';

import type { DownloaderPluginConfig } from '../index';
import type { BackendContext } from '@/types/contexts';
import type { GetPlayerResponse } from '@/types/get-player-response';

type CustomSongInfo = SongInfo & { trackId?: string };

const ffmpeg = lazyVar.lazy(async () =>
  (await import('@ffmpeg.wasm/main')).createFFmpeg({
    log: false,
    logger() {}, // Console.log,
    progress() {}, // Console.log,
  }),
);
const ffmpegMutex = new Mutex();

Platform.shim.eval = (
  data: Types.BuildScriptResult,
  env: Record<string, Types.VMPrimative>,
) => {
  const properties = [];

  if (env.n) {
    properties.push(`n: exportedVars.nFunction("${env.n}")`);
  }

  if (env.sig) {
    properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  }

  const code = `${data.output}\nreturn { ${properties.join(', ')} }`;

  // oxlint-disable-next-line typescript/no-unsafe-return,typescript/no-implied-eval,typescript/no-unsafe-call
  return new Function(code)();
};

let win: BrowserWindow;
let playingUrl: string;
let lastErrorNotification: Notification | undefined;

const isPremium = async (targetWindow: BrowserWindow) => {
  // If signed out, it is understood as non-premium
  const isSignedIn = (await targetWindow.webContents.executeJavaScript(
    '!!yt.config_.LOGGED_IN',
  )) as boolean;

  if (!isSignedIn) return false;

  // If signed in, check if the upgrade button is present
  const upgradeBtnIconPathData =
    (await targetWindow.webContents.executeJavaScript(
      'document.querySelector(\'iron-iconset-svg[name="yt-sys-icons"] #\u0079\u006f\u0075\u0074\u0075\u0062\u0065_music_monochrome\')?.firstChild?.getAttribute("d")?.substring(0, 15)',
    )) as string | null;

  // Fallback to non-premium if the icon is not found
  if (!upgradeBtnIconPathData) return false;

  const upgradeButton = `ytmusic-guide-entry-renderer:has(> tp-yt-paper-item > yt-icon path[d^="${upgradeBtnIconPathData}"])`;

  return (await targetWindow.webContents.executeJavaScript(
    `!document.querySelector('${upgradeButton}')`,
  )) as boolean;
};

const sendError = (rejection: unknown, source?: string) => {
  const errorOwner = backend;
  const error =
    rejection instanceof Error ? rejection : new Error(String(rejection));
  const songNameMessage = source ? `\nin ${source}` : '';
  const cause = error.cause
    ? `\n\n${
        // oxlint-disable-next-line typescript/no-base-to-string,typescript/restrict-template-expressions
        error.cause instanceof Error ? error.cause.toString() : error.cause
      }`
    : '';
  const message = `${error.toString()}${songNameMessage}${cause}`;

  console.error(message);
  console.trace(error);
  try {
    setBadge(0);
  } catch (badgeError) {
    console.warn('Could not clear downloader badge', badgeError);
  }
  const targetWindow = win;
  if (targetWindow.isDestroyed()) return;
  targetWindow.setProgressBar(-1);
  const title = t('plugins.downloader.backend.dialog.error.title');
  const compact =
    `${t('plugins.downloader.backend.dialog.error.message')}: ${error.message}`
      .replace(/\s+/g, ' ')
      .trim();
  let feedback = compact;
  if (compact.length > 200) {
    feedback = '';
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segments.segment(compact)) {
      if (feedback.length + segment.length > 199) break;
      feedback += segment;
    }
    feedback += '…';
  }
  if (targetWindow.isFocused()) {
    clearErrorFeedback(targetWindow);
    const failedDialog = (dialogError: unknown) => {
      console.warn('Could not show downloader error dialog', dialogError);
      if (isCurrentBinding(errorOwner))
        sendErrorFeedback(targetWindow, feedback);
    };
    try {
      dialog
        .showMessageBox(targetWindow, {
          type: 'info',
          buttons: [t('plugins.downloader.backend.dialog.error.buttons.ok')],
          title,
          message: t('plugins.downloader.backend.dialog.error.message'),
          detail: message,
        })
        .catch(failedDialog);
    } catch (dialogError) {
      failedDialog(dialogError);
    }
    return;
  }
  sendErrorFeedback(targetWindow, feedback);
  try {
    if (!Notification.isSupported()) return;
    lastErrorNotification?.close();
    lastErrorNotification = new Notification({
      title,
      body: feedback,
      silent: true,
    });
    lastErrorNotification.on('failed', (_, notificationError) => {
      console.warn('Could not show downloader notification', notificationError);
    });
    lastErrorNotification.show();
  } catch (notificationError) {
    console.warn('Could not show downloader notification', notificationError);
  }
};

export const getCookieFromWindow = async (win: BrowserWindow) => {
  return (
    await win.webContents.session.cookies.get({
      url: 'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com',
    })
  )
    .map((it) => it.name + '=' + it.value)
    .join(';');
};

let config: DownloaderPluginConfig;

interface DownloaderBinding {
  context: BackendContext<DownloaderPluginConfig>;
  session: Electron.Session;
  initialization: DownloaderInitialization<Innertube>;
  disposed: boolean;
  ready: boolean;
  cleanup: (() => void)[];
  scan?: AbortController;
  library?: LibraryReport;
  review: { id: string; title: string; reason: string }[];
}
let backend: DownloaderBinding | undefined;
const botguardMutex = new Mutex();
const isOwnedBinding = (
  owner: DownloaderBinding | undefined,
): owner is DownloaderBinding =>
  !!owner &&
  backend === owner &&
  !owner.disposed &&
  !owner.context.window.isDestroyed() &&
  !owner.context.window.webContents.isDestroyed() &&
  owner.context.window.webContents.session === owner.session;
const isCurrentBinding = (
  owner: DownloaderBinding | undefined,
): owner is DownloaderBinding => isOwnedBinding(owner) && owner.ready;
const assertCurrentBinding = (owner: DownloaderBinding) => {
  if (!isCurrentBinding(owner))
    throw new Error('Downloader backend is no longer active');
};
const disposeBinding = (owner: DownloaderBinding | undefined) => {
  if (!owner || owner.disposed) return;
  owner.disposed = true;
  owner.scan?.abort();
  owner.initialization.dispose();
  for (const dispose of owner.cleanup) dispose();
  owner.cleanup = [];
  if (backend === owner) {
    setBadge(0);
    if (!owner.context.window.isDestroyed())
      owner.context.window.setProgressBar(-1);
    backend = undefined;
    playingUrl = '';
  }
};

const initializeDownloader = async (
  owner: DownloaderBinding,
  signal: AbortSignal,
) => {
  const targetWindow = owner.context.window;
  const cookie = await getCookieFromWindow(targetWindow);
  assertCurrentBinding(owner);
  const nativeFetch = getNetFetchAsFetch();
  const ownedFetch: typeof fetch = async (input, init) => {
    assertCurrentBinding(owner);
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return nativeFetch(input, {
      ...init,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
  };
  const client = await Innertube.create({
    cache: new UniversalCache(false),
    cookie,
    generate_session_locally: true,
    fetch: ownedFetch,
  });
  assertCurrentBinding(owner);
  const visitorData = client.session.context.client.visitorData;
  if (visitorData) {
    // Botguard temporarily uses process globals; retired work restores them
    // before a new backend enters this section.
    await botguardMutex.runExclusive(async () => {
      assertCurrentBinding(owner);
      const previousWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        'window',
      );
      const previousDocument = Object.getOwnPropertyDescriptor(
        globalThis,
        'document',
      );
      // Never invoke prior accessors, and do not partially overlay immutable
      // globals. PoToken setup remains optional in that environment.
      if (
        previousWindow?.configurable === false ||
        previousDocument?.configurable === false
      )
        return;
      try {
        const [width, height] = targetWindow.getSize();
        const window = new (await import('happy-dom')).Window({
          width,
          height,
          console,
        });
        const document = window.document;
        assertCurrentBinding(owner);
        Object.defineProperties(globalThis, {
          window: {
            value: window,
            writable: true,
            configurable: true,
            enumerable: previousWindow?.enumerable ?? true,
          },
          document: {
            value: document,
            writable: true,
            configurable: true,
            enumerable: previousDocument?.enumerable ?? true,
          },
        });
        const bgConfig: BgConfig = {
          fetch: ownedFetch,
          globalObj: globalThis,
          identifier: visitorData,
          requestKey: 'O43z0dpjhgX20SCx4KAo',
        };
        const bgChallenge = await BG.Challenge.create(bgConfig);
        assertCurrentBinding(owner);
        const interpreterJavascript =
          bgChallenge?.interpreterJavascript
            .privateDoNotAccessOrElseSafeScriptWrappedValue;
        if (interpreterJavascript) {
          // Preserve the existing Botguard interpreter path.
          // oxlint-disable-next-line typescript/no-implied-eval,typescript/no-unsafe-call
          new Function(interpreterJavascript)();
          const token = await BG.PoToken.generate({
            program: bgChallenge.program,
            globalName: bgChallenge.globalName,
            bgConfig,
          });
          assertCurrentBinding(owner);
          client.session.po_token = token.poToken;
        }
      } catch {
        // A missing PoToken stays optional; backend retirement is terminal.
        assertCurrentBinding(owner);
      } finally {
        if (previousWindow)
          Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousDocument)
          Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
      }
    });
  }
  assertCurrentBinding(owner);
  return client;
};

export const onMainLoad = async (
  context: BackendContext<DownloaderPluginConfig>,
) => {
  disposeBinding(backend);
  let owner: DownloaderBinding;
  const initialization = createDownloaderInitialization(
    () => isCurrentBinding(owner),
    (signal) => initializeDownloader(owner, signal),
  );
  owner = {
    context,
    session: context.window.webContents.session,
    initialization,
    disposed: false,
    ready: false,
    cleanup: [],
    review: [],
  };
  backend = owner;
  const closed = () => disposeBinding(owner);
  context.window.once('closed', closed);
  owner.cleanup.push(() => context.window.removeListener('closed', closed));
  try {
    const loadedConfig = await context.getConfig();
    if (!isOwnedBinding(owner)) return;
    win = context.window;
    config = loadedConfig;
    playingUrl = '';
    owner.ready = true;
    const { ipc } = context;
    ipc.handle('download-song', (url: string) =>
      isCurrentBinding(owner) ? downloadSong(url) : undefined,
    );
    owner.cleanup.push(() => ipc.removeHandler('download-song'));
    const sourceChanged = (
      _event: Electron.IpcMainEvent,
      data: GetPlayerResponse,
    ) => {
      if (isCurrentBinding(owner))
        playingUrl = data.microformat.microformatDataRenderer.urlCanonical;
    };
    ipcMain.on('peard:video-src-changed', sourceChanged);
    owner.cleanup.push(() =>
      ipcMain.removeListener('peard:video-src-changed', sourceChanged),
    );
    ipc.handle('download-playlist-request', (url: string) =>
      isCurrentBinding(owner) ? downloadPlaylist(url) : undefined,
    );
    owner.cleanup.push(() => ipc.removeHandler('download-playlist-request'));
    const handlers: Record<string, (...args: never[]) => unknown> = {
      'downloader-settings': () => ({
        config,
        library: owner.library,
        review: owner.review,
      }),
      'downloader-save-settings': async (value: unknown) => {
        const settings = value as Partial<DownloaderPluginConfig>;
        const sourceAudio = validateAudioPreference(settings?.sourceAudio);
        if (
          ![
            'legacy',
            'skip-any',
            'keep-better',
            'save-variant',
            'ask',
          ].includes(settings.duplicatePolicy ?? '') ||
          typeof settings.sourceFallback !== 'boolean'
        )
          throw new Error('Invalid duplicate/fallback settings');
        if (
          settings.selectedPreset !== undefined &&
          !Object.hasOwn(DefaultPresetList, settings.selectedPreset)
        )
          throw new Error('Unknown output preset');
        const patch = {
          sourceAudio,
          sourceFallback: settings.sourceFallback,
          duplicatePolicy: settings.duplicatePolicy,
          selectedPreset: settings.selectedPreset ?? config.selectedPreset,
        };
        assertCurrentBinding(owner);
        await context.setConfig(patch);
        assertCurrentBinding(owner);
        config = { ...config, ...patch };
        return config;
      },
      'downloader-formats': async (url?: string) => {
        const id = getVideoId(url ?? playingUrl);
        if (!id)
          throw new Error('Select a track before inspecting source audio');
        const yt = await owner.initialization.get();
        assertCurrentBinding(owner);
        let info: YTMusic.TrackInfo | YT.VideoInfo = await yt.music.getInfo(id);
        let client: 'YTMUSIC' | 'TV_EMBEDDED' = 'YTMUSIC';
        assertCurrentBinding(owner);
        if (info.playability_status?.status === 'LOGIN_REQUIRED') {
          info = await getAndroidTvInfo(id, yt);
          client = 'TV_EMBEDDED';
          assertCurrentBinding(owner);
        }
        const rows = describeAudioFormats(
          [
            ...(info.streaming_data?.formats ?? []),
            ...(info.streaming_data?.adaptive_formats ?? []),
          ],
          client === 'TV_EMBEDDED',
        );
        for (const row of rows) row.client = client;
        const live =
          info.page[0].video_details?.is_live ||
          info.page[0].video_details?.is_post_live_dvr;
        if (
          live ||
          ['LOGIN_REQUIRED', 'UNPLAYABLE'].includes(
            info.playability_status?.status ?? '',
          )
        )
          for (const row of rows) {
            row.supported = false;
            row.reason = live
              ? 'Live/Post-Live-DVR unsupported'
              : 'Track not playable in current session';
          }
        const premiumHint = await isPremium(owner.context.window).catch(
          () => undefined,
        );
        assertCurrentBinding(owner);
        return { id, title: info.basic_info.title, formats: rows, premiumHint };
      },
      'downloader-selected': async (id: string, key: string) => {
        if (
          typeof id !== 'string' ||
          !/^[\w-]{1,128}$/.test(id) ||
          typeof key !== 'string' ||
          key.length > 4096
        )
          throw new Error('Invalid track/source selection');
        return downloadSongFromIdInOperation(
          id,
          undefined,
          undefined,
          undefined,
          true,
          key,
        );
      },
      'downloader-scan': async () => {
        owner.scan?.abort();
        const scan = new AbortController();
        owner.scan = scan;
        const result = await scanLibrary(getFolder(config.downloadFolder), {
          signal: scan.signal,
          onProgress: (visited) => {
            if (isCurrentBinding(owner))
              context.ipc.send('downloader-scan-progress', visited);
          },
        });
        assertCurrentBinding(owner);
        if (owner.scan !== scan) throw new Error('Scan superseded');
        owner.library = result;
        return result;
      },
      'downloader-scan-cancel': () => {
        owner.scan?.abort();
      },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      ipc.handle(event, (...args: never[]) => {
        assertCurrentBinding(owner);
        return handler(...args);
      });
      owner.cleanup.push(() => ipc.removeHandler(event));
    }
    owner.cleanup.push(downloadSongOnFinishSetup(context, owner));
  } catch (error) {
    disposeBinding(owner);
    throw error;
  }
};

export const onMainStop = ({
  window,
}: BackendContext<DownloaderPluginConfig>) => {
  if (backend?.context.window === window) disposeBinding(backend);
};

export const onConfigChange = (newConfig: DownloaderPluginConfig) => {
  if (isCurrentBinding(backend)) config = newConfig;
};
export const openDownloaderSettings = () => {
  if (isCurrentBinding(backend))
    backend.context.ipc.send('downloader-open-settings');
};

const resolvePreset = (selected: string | undefined): Preset => {
  const name = selected ?? 'mp3 (256kbps)';
  if (name === 'Custom')
    return config.customPresetSetting ?? DefaultPresetList['Custom'];
  return Object.hasOwn(DefaultPresetList, name)
    ? DefaultPresetList[name]
    : DefaultPresetList['mp3 (256kbps)'];
};

export async function downloadSong(
  url: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
  interactive = true,
) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  let resolvedName;
  try {
    clearErrorFeedback(win);
    await downloadSongUnsafe(
      owner,
      false,
      url,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
      undefined,
      interactive,
    );
  } catch (error: unknown) {
    if (backend === owner && !owner.disposed)
      sendError(error as Error, resolvedName || url);
  }
}

export async function downloadSongFromId(
  id: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  await downloadSongFromIdInOperation(
    id,
    playlistFolder,
    trackId,
    increasePlaylistProgress,
    true,
  );
}

async function downloadSongFromIdInOperation(
  id: string,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
  startOperation = false,
  selectedKey?: string,
) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  let resolvedName;
  try {
    if (startOperation) clearErrorFeedback(win);
    return await downloadSongUnsafe(
      owner,
      true,
      id,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
      selectedKey,
      startOperation,
    );
  } catch (error: unknown) {
    if (backend === owner && !owner.disposed)
      sendError(error as Error, resolvedName || id);
    return {
      status: 'failed' as const,
      error: error instanceof Error ? error.message : 'Download failed',
    };
  }
}

function downloadSongOnFinishSetup(
  { ipc }: Pick<BackendContext<DownloaderPluginConfig>, 'ipc' | 'getConfig'>,
  owner: DownloaderBinding,
) {
  let currentUrl: string | undefined;
  let duration: number | undefined;
  let time = 0;

  const defaultDownloadFolder = app.getPath('downloads');

  const unregister = registerCallback((songInfo: SongInfo, event) => {
    if (!isCurrentBinding(owner)) return;
    if (event === SongInfoEvent.TimeChanged) {
      const elapsedSeconds = songInfo.elapsedSeconds ?? 0;
      if (elapsedSeconds > time) time = elapsedSeconds;
      return;
    }
    if (
      !songInfo.isPaused &&
      songInfo.url !== currentUrl &&
      config.downloadOnFinish?.enabled
    ) {
      if (typeof currentUrl === 'string' && duration && duration > 0) {
        if (
          config.downloadOnFinish.mode === 'seconds' &&
          duration - time <= config.downloadOnFinish.seconds
        ) {
          downloadSong(
            currentUrl,
            config.downloadOnFinish.folder ??
              config.downloadFolder ??
              defaultDownloadFolder,
            undefined,
            undefined,
            false,
          );
        } else if (
          config.downloadOnFinish.mode === 'percent' &&
          time >= duration * (config.downloadOnFinish.percent / 100)
        ) {
          downloadSong(
            currentUrl,
            config.downloadOnFinish.folder ??
              config.downloadFolder ??
              defaultDownloadFolder,
            undefined,
            undefined,
            false,
          );
        }
      }

      currentUrl = songInfo.url;
      duration = songInfo.songDuration;
      time = 0;
    }
  });

  const playerReady = () => {
    if (isCurrentBinding(owner)) ipc.send('peard:setup-time-changed-listener');
  };
  ipcMain.on('peard:player-api-loaded', playerReady);
  return () => {
    unregister();
    ipcMain.removeListener('peard:player-api-loaded', playerReady);
  };
}

async function downloadSongUnsafe(
  owner: DownloaderBinding,
  isId: boolean,
  idOrUrl: string,
  setName: (name: string) => void,
  playlistFolder?: string,
  trackId?: string,
  increasePlaylistProgress: (value: number) => void = () => {},
  selectedKey?: string,
  interactive = false,
) {
  const sendFeedback = (message: unknown, progress?: number) => {
    if (!isCurrentBinding(owner)) return;
    if (!playlistFolder) {
      sendFeedback_(win, message);
      if (progress && !isNaN(progress)) {
        win.setProgressBar(progress);
      }
    }
  };

  sendFeedback(t('plugins.downloader.backend.feedback.downloading'), 2);

  let id: string | null;
  if (isId) {
    id = idOrUrl;
  } else {
    id = getVideoId(idOrUrl);
    if (typeof id !== 'string')
      throw new Error(
        t('plugins.downloader.backend.feedback.video-id-not-found'),
      );
  }

  if (
    config.duplicatePolicy === 'skip-any' &&
    (await hasVerifiedTrack(
      getFolder(playlistFolder || config.downloadFolder),
      id,
      () => assertCurrentBinding(owner),
    ))
  ) {
    sendFeedback('Already downloaded (verified track)', -1);
    return { status: 'skipped' as const };
  }
  const yt = await owner.initialization.get();
  assertCurrentBinding(owner);
  let info: YTMusic.TrackInfo | YT.VideoInfo = await yt.music.getInfo(id);
  let infoClient: 'YTMUSIC' | 'TV_EMBEDDED' = 'YTMUSIC';
  assertCurrentBinding(owner);

  if (!info) {
    throw new Error(
      t('plugins.downloader.backend.feedback.video-id-not-found'),
    );
  }

  const metadata = getMetadata(info);
  if (metadata.album === 'N/A') {
    metadata.album = '';
  }

  metadata.trackId = trackId;

  const dir = getFolder(playlistFolder || config.downloadFolder);
  const name = `${metadata.artist ? `${metadata.artist} - ` : ''}${
    metadata.title
  }`;
  setName(name);

  let playabilityStatus = info.playability_status;
  let bypassedResult: YT.VideoInfo;
  if (playabilityStatus?.status === 'LOGIN_REQUIRED') {
    // Try to bypass the age restriction
    bypassedResult = await getAndroidTvInfo(id, yt);
    assertCurrentBinding(owner);
    playabilityStatus = bypassedResult.playability_status;

    if (playabilityStatus?.status === 'LOGIN_REQUIRED') {
      throw new Error(
        `[${playabilityStatus.status}] ${playabilityStatus.reason}`,
      );
    }

    info = bypassedResult;
    infoClient = 'TV_EMBEDDED';
  }

  if (playabilityStatus?.status === 'UNPLAYABLE') {
    const errorScreen =
      playabilityStatus.error_screen as YTNodes.PlayerErrorMessage | null;
    throw new Error(
      `[${playabilityStatus.status}] ${errorScreen?.reason.text}: ${errorScreen?.subreason.text}`,
    );
  }

  const presetSetting = resolvePreset(config.selectedPreset);
  const formats = [
    ...(info.streaming_data?.formats ?? []),
    ...(info.streaming_data?.adaptive_formats ?? []),
  ];
  if (
    !/^[\w-]{1,128}$/.test(metadata.videoId) ||
    (info.basic_info.id && info.basic_info.id !== metadata.videoId)
  )
    throw new Error(
      'Streaming response track identity does not match metadata',
    );
  const rows = describeAudioFormats(formats, infoClient === 'TV_EMBEDDED');
  for (const row of rows) row.client = infoClient;
  let selected: AudioDescriptor;
  const preference = validateAudioPreference(
    config.sourceAudio ?? { mode: 'best' },
  );
  try {
    selected = selectAudioFormat(rows, preference, selectedKey);
  } catch (error) {
    if (!config.sourceFallback || selectedKey) throw error;
    selected = selectAudioFormat(rows, { ...preference, mode: 'best' });
    sendFeedback('Requested source unavailable; using best offered source');
  }
  const format = formats[rows.indexOf(selected)];

  let targetFileExtension: string;
  if (!presetSetting?.extension) {
    targetFileExtension = sourceContainer(selected);
  } else {
    targetFileExtension = presetSetting?.extension ?? 'mp3';
  }

  let filename = filenamify(`${name}.${targetFileExtension}`, {
    replacement: '_',
    maxLength: 255,
  });
  if (!is.macOS()) {
    filename = filename.normalize('NFC');
  }
  const filePath = join(dir, filename);

  if (!/^[\w]{1,12}$/.test(targetFileExtension))
    throw new Error('Invalid output extension');
  const policy = config.duplicatePolicy ?? 'legacy';
  if (policy === 'legacy' && config.skipExisting && existsSync(filePath)) {
    sendFeedback(null, -1);
    return;
  }

  const root = getFolder(config.downloadFolder);
  // Explicit alternate folders outside the configured library own their index.
  const within = relative(resolve(root), resolve(dir));
  const libraryRoot =
    within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
      ? dir
      : root;
  const completed: CompletedInput = {
    videoId: metadata.videoId,
    source: selected,
    output: {
      extension: targetFileExtension,
      args: [...(presetSetting?.ffmpegArgs ?? []), '-vn'],
    },
    policy,
    preference,
  };
  let stopped: 'skipped' | 'needs-choice' = 'skipped';
  const decide = async () => {
    const decision = await checkDuplicate(libraryRoot, completed, () =>
      assertCurrentBinding(owner),
    );
    if (decision === 'skip') {
      sendFeedback('Already downloaded (verified source/output policy)', -1);
      return false;
    }
    if (decision === 'ask') {
      stopped = 'needs-choice';
      if (!interactive) {
        if (!owner.review.some((row) => row.id === id))
          owner.review.push({
            id,
            title: name,
            reason: 'Existing source quality requires manual choice',
          });
        owner.review = owner.review.slice(-100);
        sendFeedback(
          'Existing track requires a source-quality choice; queued for manual review',
          -1,
        );
        return false;
      }
      const result = await dialog.showMessageBox(owner.context.window, {
        type: 'question',
        message:
          'This track already has a verified download. Source qualities cannot be safely ordered, or your policy asks each time.',
        buttons: ['Keep existing', 'Save selected variant'],
        defaultId: 0,
        cancelId: 0,
      });
      assertCurrentBinding(owner);
      if (result.response !== 1) {
        stopped = 'skipped';
        return false;
      }
      completed.approved = true;
    }
    return true;
  };
  if (!(await decide())) return { status: stopped };
  const iterableStream = await downloadSelectedAudio(info, format, () =>
    assertCurrentBinding(owner),
  );

  console.info(
    t('plugins.downloader.backend.feedback.download-info', {
      artist: metadata.artist,
      title: metadata.title,
      videoId: metadata.videoId,
    }),
  );

  if (!existsSync(dir)) {
    mkdirSync(dir);
  }

  let fileBuffer = await iterableStreamToProcessedUint8Array(
    iterableStream,
    targetFileExtension,
    metadata,
    completed.output.args,
    format.content_length ?? 0,
    sendFeedback,
    increasePlaylistProgress,
    owner,
  );
  assertCurrentBinding(owner);

  if (fileBuffer && targetFileExtension === 'mp3') {
    fileBuffer = await writeID3(
      Buffer.from(fileBuffer),
      metadata,
      sendFeedback,
      owner,
    );
    assertCurrentBinding(owner);
  }

  if (fileBuffer) {
    const saved = await publishCompleted(
      libraryRoot,
      dir,
      filename,
      fileBuffer,
      completed,
      () => assertCurrentBinding(owner),
    );
    assertCurrentBinding(owner);
    if (saved.status === 'needs-choice') {
      sendFeedback('Concurrent download requires manual source choice', -1);
      return { status: 'needs-choice' as const };
    }
    if (saved.status === 'skipped') {
      sendFeedback('Already downloaded (verified)', -1);
      return { status: 'skipped' as const };
    }
    sendFeedback(
      `Saved ${selected.codec} (${Math.round((selected.averageBitrate ?? selected.bitrate ?? 0) / 1000) || 'unknown'} kbps source) → ${targetFileExtension}`,
      -1,
    );
    owner.review = owner.review.filter((row) => row.id !== id);
    return {
      status: 'saved' as const,
      path: saved.path,
      source: selected,
      extension: targetFileExtension,
    };
  } else {
    throw new Error(
      'Audio processing/tagging failed; no file or completion record saved',
    );
  }
}

async function downloadChunks(
  stream: AsyncGenerator<Uint8Array, void>,
  contentLength: number,
  sendFeedback: (str: string, value?: number) => void,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  const chunks = [];
  let downloaded = 0;
  for await (const chunk of stream) {
    downloaded += chunk.length;
    chunks.push(chunk);
    const ratio = downloaded / contentLength;
    const progress = Math.floor(ratio * 100);
    sendFeedback(
      t('plugins.downloader.backend.feedback.download-progress', {
        percent: progress,
      }),
      ratio,
    );
    // 15% for download, 85% for conversion
    // This is a very rough estimate, trying to make the progress bar look nice
    increasePlaylistProgress(ratio * 0.15);
  }
  return chunks;
}

async function iterableStreamToProcessedUint8Array(
  stream: AsyncGenerator<Uint8Array, void>,
  extension: string,
  metadata: CustomSongInfo,
  presetFfmpegArgs: string[],
  contentLength: number,
  sendFeedback: (str: string, value?: number) => void,
  increasePlaylistProgress: (value: number) => void = () => {},
  owner: DownloaderBinding,
): Promise<Uint8Array | null> {
  sendFeedback(t('plugins.downloader.backend.feedback.loading'), 2); // Indefinite progress bar after download

  const safeVideoName = randomBytes(32).toString('hex');

  return await ffmpegMutex.runExclusive(async () => {
    try {
      assertCurrentBinding(owner);
      const ffmpegInstance = await ffmpeg.get();
      if (!ffmpegInstance.isLoaded()) {
        await ffmpegInstance.load();
      }

      sendFeedback(t('plugins.downloader.backend.feedback.preparing-file'));
      ffmpegInstance.FS(
        'writeFile',
        safeVideoName,
        Buffer.concat(
          await downloadChunks(
            stream,
            contentLength,
            sendFeedback,
            increasePlaylistProgress,
          ),
        ),
      );

      sendFeedback(t('plugins.downloader.backend.feedback.converting'));

      ffmpegInstance.setProgress(({ ratio }) => {
        sendFeedback(
          t('plugins.downloader.backend.feedback.conversion-progress', {
            percent: Math.floor(ratio * 100),
          }),
          ratio,
        );
        const conversionProgress = ratio * 0.85;
        increasePlaylistProgress(0.15 + conversionProgress);
      });

      const safeVideoNameWithExtension = `${safeVideoName}.${extension}`;
      try {
        await ffmpegInstance.run(
          '-i',
          safeVideoName,
          ...presetFfmpegArgs,
          ...getFFmpegMetadataArgs(metadata),
          safeVideoNameWithExtension,
        );
      } finally {
        ffmpegInstance.FS('unlink', safeVideoName);
      }

      sendFeedback(t('plugins.downloader.backend.feedback.saving'));

      try {
        return ffmpegInstance.FS('readFile', safeVideoNameWithExtension);
      } finally {
        ffmpegInstance.FS('unlink', safeVideoNameWithExtension);
      }
    } catch (error: unknown) {
      if (isCurrentBinding(owner)) sendError(error as Error, safeVideoName);
    }
    return null;
  });
}

const getCoverBuffer = async (url: string) => {
  const nativeImage = cropMaxWidth(await getImage(url));
  return nativeImage && !nativeImage.isEmpty() ? nativeImage.toPNG() : null;
};

async function writeID3(
  buffer: Buffer,
  metadata: CustomSongInfo,
  sendFeedback: (str: string, value?: number) => void,
  owner: DownloaderBinding,
) {
  try {
    sendFeedback(t('plugins.downloader.backend.feedback.writing-id3'));
    const tags: NodeID3.Tags = {};

    // Create the metadata tags
    tags.title = metadata.title;
    tags.artist = metadata.artist;
    tags.userDefinedText = [
      { description: 'pear-desktop:youtube-video-id', value: metadata.videoId },
    ];

    if (metadata.album) {
      tags.album = metadata.album;
    }

    const coverBuffer = await getCoverBuffer(metadata.imageSrc ?? '');
    if (coverBuffer) {
      tags.image = {
        mime: 'image/png',
        type: {
          id: NodeID3.TagConstants.AttachedPicture.PictureType.FRONT_COVER,
        },
        description: 'thumbnail',
        imageBuffer: coverBuffer,
      };
    }

    if (metadata.trackId) {
      tags.trackNumber = metadata.trackId;
    }

    return NodeID3.write(tags, buffer);
  } catch (error: unknown) {
    if (isCurrentBinding(owner))
      sendError(error as Error, `${metadata.artist} - ${metadata.title}`);
    return null;
  }
}

export async function downloadPlaylist(givenUrl?: string | URL) {
  const owner = backend;
  if (!isCurrentBinding(owner)) return;
  clearErrorFeedback(win);
  let yt: Innertube;
  try {
    yt = await owner.initialization.get();
    assertCurrentBinding(owner);
  } catch (error) {
    if (isCurrentBinding(owner)) sendError(error);
    return;
  }
  try {
    givenUrl = new URL(givenUrl ?? '');
  } catch {
    givenUrl = new URL(win.webContents.getURL());
  }

  const playlistId =
    getPlaylistID(givenUrl) || getPlaylistID(new URL(playingUrl));

  if (!playlistId) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-id-not-found')),
    );
    return;
  }

  const sendFeedback = (message?: unknown) => {
    if (isCurrentBinding(owner)) sendFeedback_(win, message);
  };

  console.log(
    t('plugins.downloader.backend.feedback.trying-to-get-playlist-id', {
      playlistId,
    }),
  );
  sendFeedback(t('plugins.downloader.backend.feedback.getting-playlist-info'));
  let playlist: YTMusic.Playlist;
  const items: YTNodes.MusicResponsiveListItem[] = [];
  try {
    playlist = await yt.music.getPlaylist(playlistId);
    assertCurrentBinding(owner);
    if (playlist?.items) {
      const filteredItems = playlist.items.filter(
        (item): item is YTNodes.MusicResponsiveListItem =>
          item instanceof YTNodes.MusicResponsiveListItem,
      );

      items.push(...filteredItems);
    }
  } catch (error: unknown) {
    if (!isCurrentBinding(owner)) return;
    sendError(
      Error(
        t('plugins.downloader.backend.feedback.playlist-is-mix-or-private', {
          error: String(error),
        }),
      ),
    );
    return;
  }

  if (!playlist || !playlist.items || playlist.items.length === 0) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-is-empty')),
    );
    return;
  }

  const normalPlaylistTitle =
    playlist.header && 'title' in playlist.header
      ? playlist.header?.title?.text
      : undefined;
  const playlistTitle =
    normalPlaylistTitle ??
    playlist.page.contents_memo
      ?.get('MusicResponsiveListItemFlexColumn')
      ?.at(2)
      ?.as(YTNodes.MusicResponsiveListItemFlexColumn)?.title?.text ??
    'NO_TITLE';
  const isAlbum = !normalPlaylistTitle;

  const configuredLimit = config.playlistMaxItems;
  const limit =
    typeof configuredLimit === 'number' &&
    Number.isFinite(configuredLimit) &&
    configuredLimit >= 1
      ? Math.floor(configuredLimit)
      : undefined;
  try {
    while (playlist.has_continuation && (!limit || items.length < limit)) {
      playlist = await playlist.getContinuation();
      assertCurrentBinding(owner);
      const filteredItems = playlist.items.filter(
        (item): item is YTNodes.MusicResponsiveListItem =>
          item instanceof YTNodes.MusicResponsiveListItem,
      );
      items.push(...filteredItems);
    }
  } catch (error) {
    if (isCurrentBinding(owner)) sendError(error);
    return;
  }
  // A capped collection remains a playlist/album, including its folder/tags.
  const naturallySingle = items.length === 1 && !playlist.has_continuation;
  if (limit) items.splice(limit);

  if (naturallySingle) {
    sendFeedback(
      t('plugins.downloader.backend.feedback.playlist-has-only-one-song'),
    );
    await downloadSongFromIdInOperation(items.at(0)!.id!);
    return;
  }

  let safePlaylistTitle = filenamify(playlistTitle, { replacement: ' ' });
  if (!is.macOS()) {
    safePlaylistTitle = safePlaylistTitle.normalize('NFC');
  }

  const folder = getFolder(config.downloadFolder ?? '');
  const playlistFolder = join(folder, safePlaylistTitle);
  if (existsSync(playlistFolder)) {
    if (
      !config.skipExisting &&
      (config.duplicatePolicy ?? 'legacy') === 'legacy'
    ) {
      sendError(
        new Error(
          t('plugins.downloader.backend.feedback.folder-already-exists', {
            playlistFolder,
          }),
        ),
      );
      return;
    }
  } else {
    mkdirSync(playlistFolder, { recursive: true });
  }

  dialog.showMessageBox(win, {
    type: 'info',
    buttons: [
      t('plugins.downloader.backend.dialog.start-download-playlist.buttons.ok'),
    ],
    title: t('plugins.downloader.backend.dialog.start-download-playlist.title'),
    message: t(
      'plugins.downloader.backend.dialog.start-download-playlist.message',
      {
        playlistTitle,
      },
    ),
    detail: t(
      'plugins.downloader.backend.dialog.start-download-playlist.detail',
      {
        playlistSize: items.length,
      },
    ),
  });

  if (is.dev()) {
    console.log(
      t('plugins.downloader.backend.feedback.downloading-playlist', {
        playlistTitle,
        playlistSize: items.length,
        playlistId,
      }),
    );
  }

  win.setProgressBar(2); // Starts with indefinite bar

  setBadge(items.length);

  let counter = 1;

  const progressStep = 1 / items.length;

  const increaseProgress = (itemPercentage: number) => {
    if (!isCurrentBinding(owner)) return;
    const currentProgress = (counter - 1) / (items.length ?? 1);
    const itemProgress = progressStep * itemPercentage;
    const newProgress = currentProgress + itemProgress;
    win.setProgressBar(newProgress);
  };

  try {
    for (const song of items) {
      assertCurrentBinding(owner);
      sendFeedback(
        t('plugins.downloader.backend.feedback.downloading-counter', {
          current: counter,
          total: items.length,
        }),
      );
      const trackId = isAlbum ? counter : undefined;
      await downloadSongFromIdInOperation(
        song.id!,
        playlistFolder,
        trackId?.toString(),
        increaseProgress,
      ).catch((error) =>
        sendError(
          new Error(
            t('plugins.downloader.backend.feedback.error-while-downloading', {
              author: song.author!.name,
              title: song.title!,
              error: String(error),
            }),
          ),
        ),
      );

      assertCurrentBinding(owner);
      owner.context.window.setProgressBar(counter / items.length);
      setBadge(items.length - counter);
      counter++;
    }
  } catch (error: unknown) {
    if (isCurrentBinding(owner)) sendError(error as Error);
  } finally {
    if (isCurrentBinding(owner)) {
      owner.context.window.setProgressBar(-1); // Close progress bar
      setBadge(0); // Close badge counter
      sendFeedback(); // Clear feedback
    }
  }
}

function getFFmpegMetadataArgs(metadata: CustomSongInfo) {
  if (!metadata) {
    return [];
  }

  return [
    ...(metadata.title ? ['-metadata', `title=${metadata.title}`] : []),
    ...(metadata.artist ? ['-metadata', `artist=${metadata.artist}`] : []),
    ...(metadata.album ? ['-metadata', `album=${metadata.album}`] : []),
    ...(metadata.videoId
      ? [
          '-metadata',
          `comment=https://music.youtube.com/watch?v=${metadata.videoId}`,
        ]
      : []),
    ...(metadata.trackId ? ['-metadata', `track=${metadata.trackId}`] : []),
  ];
}

// Playlist radio modifier needs to be cut from playlist ID
const INVALID_PLAYLIST_MODIFIER = 'RDAMPL';

const getPlaylistID = (aURL?: URL): string | null | undefined => {
  const result =
    aURL?.searchParams.get('list') || aURL?.searchParams.get('playlist');
  if (result?.startsWith(INVALID_PLAYLIST_MODIFIER)) {
    return result.slice(INVALID_PLAYLIST_MODIFIER.length);
  }

  return result;
};

const getVideoId = (url: URL | string): string | null => {
  const parsedUrl = URL.parse(url);
  if (!parsedUrl) return null;
  return parsedUrl.searchParams.get('v');
};

const getMetadata = (info: YTMusic.TrackInfo): CustomSongInfo => ({
  videoId: info.basic_info.id!,
  title: cleanupName(info.basic_info.title!),
  artist: cleanupName(info.basic_info.author!),
  album: info.player_overlays?.browser_media_session?.as(
    YTNodes.BrowserMediaSession,
  ).album?.text,
  imageSrc: info.basic_info.thumbnail?.find((t) => !t.url.endsWith('.webp'))
    ?.url,
  views: info.basic_info.view_count!,
  songDuration: info.basic_info.duration!,
  mediaType: MediaType.Audio,
});

// This is used to bypass age restrictions
const getAndroidTvInfo = async (
  id: string,
  client: Innertube,
): Promise<YT.VideoInfo> => {
  // GetInfo 404s with the bypass, so we use getBasicInfo instead
  // that's fine as we only need the streaming data
  return await client.getBasicInfo(id, {
    client: 'TV_EMBEDDED',
  });
};
