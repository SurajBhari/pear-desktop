import { Mutex } from 'async-mutex';
import {
  type BrowserWindow,
  type IpcMainEvent,
  type WebFrameMain,
  ipcMain,
  nativeImage,
  net,
} from 'electron';

import * as config from '@/config';

import {
  parsePlaybackBinding,
  samePlaybackBinding,
  type PlaybackBinding,
} from './playback-owner';
import { isRecord } from './queue-playlist';

import type { GetPlayerResponse } from '@/types/get-player-response';

export enum MediaType {
  /**
   * Audio uploaded by the original artist
   */
  Audio = 'AUDIO',
  /**
   * Official music video uploaded by the original artist
   */
  OriginalMusicVideo = 'ORIGINAL_MUSIC_VIDEO',
  /**
   * Normal video uploaded by a user
   */
  UserGeneratedContent = 'USER_GENERATED_CONTENT',
  /**
   * Podcast episode
   */
  PodcastEpisode = 'PODCAST_EPISODE',
  OtherVideo = 'OTHER_VIDEO',
}

export interface SongInfo {
  title: string;
  alternativeTitle?: string;
  artist: string;
  artistUrl?: string;
  views: number;
  uploadDate?: string;
  imageSrc?: string | null;
  image?: Electron.NativeImage | null;
  isPaused?: boolean;
  songDuration: number;
  elapsedSeconds?: number;
  url?: string;
  album?: string | null;
  videoId: string;
  playlistId?: string;
  mediaType: MediaType;
  tags?: string[];
}

declare const provenanceBrand: unique symbol;
/** Read-only identity for one native metadata admission; never serialized. */
export type SongInfoProvenance = Readonly<{ [provenanceBrand]: true }>;
const provenance = new WeakMap<SongInfo, SongInfoProvenance>();
const playbackBindings = new WeakMap<SongInfo, PlaybackBinding>();
export const getSongInfoPlaybackBinding = (info: SongInfo) =>
  playbackBindings.get(info) ?? null;
export const getSongInfoProvenance = (
  info: SongInfo,
): SongInfoProvenance | null => provenance.get(info) ?? null;

type Admission = {
  readonly epoch: number;
  readonly token: SongInfoProvenance;
  readonly frame: WebFrameMain;
  playbackBinding: PlaybackBinding | null;
};
type ProviderOwner = {
  readonly window: BrowserWindow;
  readonly contents: BrowserWindow['webContents'];
  disposed: boolean;
  admission?: Admission;
  dispose(): void;
};
const providers = new WeakMap<BrowserWindow, ProviderOwner>();
const admissionEpochs = new WeakMap<BrowserWindow, number>();
let activeProvider: ProviderOwner | undefined;
const frameFor = (owner: ProviderOwner): WebFrameMain | null => {
  if (owner.disposed || activeProvider !== owner) return null;
  try {
    if (
      owner.window.isDestroyed() ||
      owner.window.webContents !== owner.contents ||
      owner.contents.isDestroyed()
    )
      return null;
    const frame = owner.contents.mainFrame;
    return !owner.disposed && activeProvider === owner && frame ? frame : null;
  } catch {
    return null;
  }
};
const isCurrentAdmission = (owner: ProviderOwner, admission: Admission) => {
  const frame = frameFor(owner);
  return (
    frame === admission.frame &&
    !owner.disposed &&
    activeProvider === owner &&
    owner.admission === admission
  );
};
export const getCurrentSongInfoProvenance = (
  window: BrowserWindow,
): SongInfoProvenance | null => {
  const owner = providers.get(window);
  const admission = owner?.admission;
  return owner && admission && isCurrentAdmission(owner, admission)
    ? admission.token
    : null;
};
export const isSongInfoCurrent = (info: SongInfo, window: BrowserWindow) =>
  readCurrentSongInfo?.() === info &&
  getSongInfoProvenance(info) !== null &&
  getSongInfoProvenance(info) === getCurrentSongInfoProvenance(window);

const getOwnedImage = async (
  src: string,
  current: () => boolean,
): Promise<Electron.NativeImage | null> => {
  if (!current()) return null;
  const result = await net.fetch(src);
  if (!current()) return null;
  const buffer = await result.arrayBuffer();
  if (!current()) return null;
  const output = nativeImage.createFromBuffer(Buffer.from(buffer));
  if (!current()) return null;
  const empty = output.isEmpty();
  if (!current()) return null;
  if (empty && !src.endsWith('.jpg') && src.includes('.jpg')) {
    // Fix hidden webp files (https://github.com/pear-devs/pear-desktop/issues/315)
    return getOwnedImage(src.slice(0, src.lastIndexOf('.jpg') + 4), current);
  }
  return output;
};
// Preserve the public artwork API; only provider reads use an admission guard.
export const getImage = async (src: string): Promise<Electron.NativeImage> => {
  const image = await getOwnedImage(src, () => true);
  if (!image) throw new Error('Artwork is unavailable');
  return image;
};

type PreparedSong = { info: SongInfo; resume?: { url: string } };
const handleData = async (
  data: GetPlayerResponse,
  current: () => boolean,
): Promise<PreparedSong | null> => {
  if (
    !current() ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.videoDetails?.videoId !== 'string' ||
    !data.videoDetails.videoId.trim()
  ) {
    return null;
  }

  // Fill songInfo with empty values
  const songInfo: SongInfo = {
    title: '',
    alternativeTitle: '',
    artist: '',
    artistUrl: '',
    views: 0,
    uploadDate: '',
    imageSrc: '',
    image: null,
    isPaused: undefined,
    songDuration: 0,
    elapsedSeconds: 0,
    url: '',
    album: undefined,
    videoId: '',
    playlistId: '',
    mediaType: MediaType.Audio,
    tags: [],
  } satisfies SongInfo;

  let resume: PreparedSong['resume'];
  const microformat = data.microformat?.microformatDataRenderer;
  if (microformat) {
    resume = { url: microformat.urlCanonical };
    songInfo.uploadDate = microformat.uploadDate;
    songInfo.url = microformat.urlCanonical?.split('&')[0];
    songInfo.playlistId =
      URL.parse(microformat.urlCanonical)?.searchParams?.get('list') ?? '';
    if (microformat.pageOwnerDetails?.externalChannelId) {
      songInfo.artistUrl = `https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/channel/${microformat.pageOwnerDetails.externalChannelId}`;
    }
    songInfo.alternativeTitle = microformat.linkAlternates.find(
      (link) => link.title,
    )?.title;
    songInfo.tags = Array.isArray(microformat.tags) ? microformat.tags : [];
  }

  const { videoDetails } = data;
  if (videoDetails) {
    songInfo.title = cleanupName(videoDetails.title);
    songInfo.artist = cleanupName(videoDetails.author);
    songInfo.views = Number(videoDetails.viewCount);
    songInfo.songDuration = Number(videoDetails.lengthSeconds);
    songInfo.elapsedSeconds = videoDetails.elapsedSeconds;
    songInfo.isPaused = videoDetails.isPaused;
    songInfo.videoId = videoDetails.videoId;
    songInfo.album = videoDetails.album; // Will be undefined if video exist

    switch (videoDetails?.musicVideoType) {
      case 'MUSIC_VIDEO_TYPE_ATV':
        songInfo.mediaType = MediaType.Audio;
        break;
      case 'MUSIC_VIDEO_TYPE_OMV':
        songInfo.mediaType = MediaType.OriginalMusicVideo;
        break;
      case 'MUSIC_VIDEO_TYPE_UGC':
        songInfo.mediaType = MediaType.UserGeneratedContent;
        break;
      case 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE':
        songInfo.mediaType = MediaType.PodcastEpisode;
        // HACK: Podcast's participant is not the artist
        if (!config.get('options.usePodcastParticipantAsArtist')) {
          songInfo.artist = cleanupName(
            data.microformat.microformatDataRenderer.pageOwnerDetails.name,
          );
        }
        break;
      default:
        songInfo.mediaType = MediaType.OtherVideo;
        // HACK: This is a workaround for "podcast" types where "musicVideoType" doesn't exist. Google :facepalm:
        if (
          !config.get('options.usePodcastParticipantAsArtist') &&
          (data.responseContext.serviceTrackingParams
            ?.at(0)
            ?.params?.find((it) => it.key === 'ipcc')?.value ?? '1') != '0'
        ) {
          songInfo.artist = cleanupName(
            data.microformat.microformatDataRenderer.pageOwnerDetails.name,
          );
        }
        break;
    }

    const thumbnails = videoDetails.thumbnail?.thumbnails;
    songInfo.imageSrc = thumbnails?.at(-1)?.url?.split('?')?.at(0);

    if (!current()) return null;
    if (songInfo.imageSrc) {
      const head = await net.fetch(songInfo.imageSrc, { method: 'HEAD' });
      if (!current()) return null;
      if (!head.ok) songInfo.imageSrc = thumbnails.at(-1)?.url;
    }
    if (!current()) return null;
    if (songInfo.imageSrc)
      songInfo.image = await getOwnedImage(songInfo.imageSrc, current);
  }
  if (!current()) return null;

  return { info: songInfo, resume };
};

export enum SongInfoEvent {
  VideoSrcChanged = 'peard:video-src-changed',
  PlayOrPaused = 'peard:play-or-paused',
  TimeChanged = 'peard:time-changed',
}

// This variable will be filled with the callbacks once they register
export type SongInfoCallback = (
  songInfo: SongInfo,
  event: SongInfoEvent,
) => void;
const callbacks: Set<SongInfoCallback> = new Set();
let readCurrentSongInfo: (() => SongInfo | null) | undefined;

// This function will allow plugins to register callback that will be triggered when data changes
export const registerCallback = (
  callback: SongInfoCallback,
  { replayCurrent = false }: { replayCurrent?: boolean } = {},
): (() => void) => {
  const alreadyRegistered = callbacks.has(callback);
  callbacks.add(callback);
  try {
    if (replayCurrent) {
      const current = readCurrentSongInfo?.();
      if (current) callback(current, SongInfoEvent.VideoSrcChanged);
    }
  } catch (error) {
    if (!alreadyRegistered) callbacks.delete(callback);
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    callbacks.delete(callback);
  };
};

const registerProvider = (win: BrowserWindow): (() => void) => {
  activeProvider?.dispose();
  const dataMutex = new Mutex();
  let songInfo: SongInfo | null = null;
  const owner: ProviderOwner = {
    window: win,
    contents: win.webContents,
    disposed: false,
    dispose: () => {},
  };
  const readSongInfo = () => {
    const admission = owner.admission;
    return songInfo &&
      admission &&
      getSongInfoProvenance(songInfo) === admission.token &&
      isCurrentAdmission(owner, admission)
      ? songInfo
      : null;
  };
  const captureFrame = (event: IpcMainEvent): WebFrameMain | null => {
    try {
      const frame = frameFor(owner);
      return frame &&
        event?.sender === owner.contents &&
        event.senderFrame === frame &&
        frameFor(owner) === frame
        ? frame
        : null;
    } catch {
      return null;
    }
  };
  const notify = (
    info: SongInfo,
    event: SongInfoEvent,
    admission: Admission,
  ) => {
    for (const callback of callbacks) {
      if (!isCurrentAdmission(owner, admission)) return;
      callback(info, event);
    }
  };
  const metadata = async (
    event: IpcMainEvent,
    data: GetPlayerResponse,
    annotation: unknown,
  ) => {
    const frame = captureFrame(event);
    if (!frame) return;
    const epoch = (admissionEpochs.get(win) ?? 0) + 1;
    admissionEpochs.set(win, epoch);
    const admission: Admission = {
      epoch,
      frame,
      token: Object.freeze({}) as SongInfoProvenance,
      playbackBinding: null,
    };
    // Invalidate at raw arrival, including an owned unknown/invalid payload.
    owner.admission = admission;
    songInfo = null;
    admission.playbackBinding = parsePlaybackBinding(annotation);
    const current = () => isCurrentAdmission(owner, admission);
    try {
      const info = await dataMutex.runExclusive(async () => {
        if (!current()) return null;
        const prepared = await handleData(data, current);
        if (!prepared || !current()) return null;
        const extracted = prepared.info;
        provenance.set(extracted, admission.token);
        if (prepared.resume) {
          config.set('url', prepared.resume.url);
          if (!current()) return null;
        }
        owner.contents.send('peard:update-song-info', extracted);
        if (!current()) return null;
        // A passive update can arrive during artwork extraction or publication.
        const binding = admission.playbackBinding;
        if (binding && binding.videoId === extracted.videoId)
          playbackBindings.set(extracted, binding);
        songInfo = extracted;
        return extracted;
      });
      if (info && current())
        notify(info, SongInfoEvent.VideoSrcChanged, admission);
    } catch {
      // Failed or retired extraction cannot publish partially prepared data.
    }
  };
  const update = async (
    event: IpcMainEvent,
    kind: SongInfoEvent,
    mutate: (info: SongInfo, current: () => boolean) => void,
  ) => {
    const admission = owner.admission;
    if (!admission) return;
    const frame = captureFrame(event);
    if (
      !frame ||
      frame !== admission.frame ||
      !isCurrentAdmission(owner, admission)
    )
      return;
    const current = () => isCurrentAdmission(owner, admission);
    const info = await dataMutex.runExclusive(() => {
      if (
        !current() ||
        !songInfo ||
        getSongInfoProvenance(songInfo) !== admission.token
      )
        return null;
      const info = songInfo;
      mutate(info, current);
      return current() ? info : null;
    });
    if (info && current()) notify(info, kind, admission);
  };
  const paused = (
    event: IpcMainEvent,
    data: { isPaused: boolean; elapsedSeconds: number },
  ) => {
    if (!data || typeof data !== 'object') return Promise.resolve();
    return update(event, SongInfoEvent.PlayOrPaused, (info, current) => {
      const { isPaused, elapsedSeconds } = data;
      if (!current()) return;
      info.isPaused = isPaused;
      if (!current()) return;
      info.elapsedSeconds = elapsedSeconds;
    });
  };
  const refreshPlaybackBinding = (event: IpcMainEvent, packet: unknown) => {
    if (
      !isRecord(packet) ||
      Object.keys(packet).length !== 3 ||
      !Object.hasOwn(packet, 'type') ||
      packet.type !== 'playback-binding-refresh' ||
      !Object.hasOwn(packet, 'previous') ||
      !Object.hasOwn(packet, 'binding')
    )
      return;
    const previous = parsePlaybackBinding(packet.previous);
    const binding = parsePlaybackBinding(packet.binding);
    if (
      !previous ||
      (packet.binding !== null && !binding) ||
      (binding &&
        (binding.documentId !== previous.documentId ||
          binding.videoId !== previous.videoId ||
          binding.episodeId === previous.episodeId))
    )
      return;
    const admission = owner.admission;
    if (!admission) return;
    const frame = captureFrame(event);
    const info = songInfo;
    if (
      !frame ||
      frame !== admission.frame ||
      (info &&
        (getSongInfoProvenance(info) !== admission.token ||
          info.videoId !== previous.videoId ||
          !samePlaybackBinding(playbackBindings.get(info), previous))) ||
      !isCurrentAdmission(owner, admission) ||
      songInfo !== info ||
      !samePlaybackBinding(admission.playbackBinding, previous)
    )
      return;
    admission.playbackBinding = binding;
    if (info) {
      if (binding) playbackBindings.set(info, binding);
      else playbackBindings.delete(info);
    }
  };
  const elapsed = (event: IpcMainEvent, seconds: unknown) => {
    if (typeof seconds !== 'number') {
      refreshPlaybackBinding(event, seconds);
      return Promise.resolve();
    }
    return update(event, SongInfoEvent.TimeChanged, (info) => {
      info.elapsedSeconds = seconds;
    });
  };
  const retireDocument = () => {
    if (owner.disposed || activeProvider !== owner) return;
    // WebFrameMain identity can survive a same-origin document replacement.
    owner.admission = undefined;
    songInfo = null;
  };
  const dispose = () => {
    if (owner.disposed) return;
    owner.disposed = true;
    owner.admission = undefined;
    songInfo = null;
    ipcMain.removeListener(SongInfoEvent.VideoSrcChanged, metadata);
    ipcMain.removeListener(SongInfoEvent.PlayOrPaused, paused);
    ipcMain.removeListener(SongInfoEvent.TimeChanged, elapsed);
    win.removeListener('closed', dispose);
    owner.contents.removeListener('did-navigate', retireDocument);
    owner.contents.removeListener('render-process-gone', retireDocument);
    owner.contents.removeListener('destroyed', dispose);
    if (providers.get(win) === owner) providers.delete(win);
    if (activeProvider === owner) activeProvider = undefined;
    if (readCurrentSongInfo === readSongInfo) readCurrentSongInfo = undefined;
  };
  owner.dispose = dispose;
  activeProvider = owner;
  providers.set(win, owner);
  readCurrentSongInfo = readSongInfo;
  win.once('closed', dispose);
  owner.contents.on('did-navigate', retireDocument);
  owner.contents.on('render-process-gone', retireDocument);
  owner.contents.once('destroyed', dispose);
  ipcMain.on(SongInfoEvent.VideoSrcChanged, metadata);
  ipcMain.on(SongInfoEvent.PlayOrPaused, paused);
  ipcMain.on(SongInfoEvent.TimeChanged, elapsed);
  try {
    // A live window can bootstrap before its main frame exists.
    if (win.isDestroyed() || owner.contents.isDestroyed()) dispose();
  } catch {
    dispose();
  }
  return dispose;
};

const suffixesToRemove = [
  // Artist names
  /\s*(- topic)$/i,
  /\s*vevo$/i,

  // Video titles
  /\s*[(|[]official(.*?)[)|\]]/i, // (Official Music Video), [Official Visualizer], etc...
  /\s*[(|[]((lyrics?|visualizer|audio)\s*(video)?)[)|\]]/i,
  /\s*[(|[](performance video)[)|\]]/i,
  /\s*[(|[](clip official)[)|\]]/i,
  /\s*[(|[](video version)[)|\]]/i,
  /\s*[(|[](HD|HQ)\s*?(?:audio)?[)|\]]$/i,
  /\s*[(|[](live)[)|\]]$/i,
  /\s*[(|[]4K\s*?(?:upgrade)?[)|\]]$/i,
];

export function cleanupName(name: string): string {
  if (!name) {
    return name;
  }

  for (const suffix of suffixesToRemove) {
    name = name.replace(suffix, '');
  }

  return name;
}

export const setupSongInfo = registerProvider;
