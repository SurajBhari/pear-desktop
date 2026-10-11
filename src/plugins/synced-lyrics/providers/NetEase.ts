// Adapted from upstream #4113 by ArjixWasTaken (MIT).
import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';

export class NetEase implements LyricProvider {
  name = 'NetEase';
  baseUrl = 'https://interface.music.163.com';
  async search(info: SearchSongInfo): Promise<LyricResult | null> {
    return window.ipcRenderer.invoke('synced-lyrics:netease', {
      title: info.alternativeTitle || info.title,
      artist: info.artist,
      songDuration: info.songDuration,
    }) as Promise<LyricResult | null>;
  }
}
