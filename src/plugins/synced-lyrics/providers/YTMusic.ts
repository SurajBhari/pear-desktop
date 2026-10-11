import { config } from '../renderer/renderer';

import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';
import type { MusicPlayerAppElement } from '@/types/music-player-app-element';

const headers = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

const client = {
  clientName: '26',
  clientVersion: '7.01.05',
};

export class YTMusic implements LyricProvider {
  public name = 'YTMusic';
  public baseUrl =
    'https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/';

  // prettier-ignore
  public async search(
    { videoId, title, artist }: SearchSongInfo,
  ): Promise<LyricResult | null> {
    const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
    const network = app?.networkManager;
    if (!app?.isConnected || typeof network?.fetch !== 'function') return null;
    const owner: LyricsRequestOwner = {
      app,
      network,
      withoutProxy: config()?.useYTMLyricsWithoutProxy === true,
    };
    const data = await this.fetchNext(videoId, owner);
    if (!this.isCurrent(owner)) return null;

    const { tabs } =
      data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer ?? {};
    if (!Array.isArray(tabs)) return null;

    const lyricsTab = tabs.find((it) => {
      const pageType = it?.tabRenderer?.endpoint?.browseEndpoint
        ?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
      return pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS';
    });

    if (!lyricsTab) return null;

    const { browseId } = lyricsTab?.tabRenderer?.endpoint?.browseEndpoint ?? {};
    if (!browseId) return null;

    const browse = await this.fetchBrowse(browseId, owner);
    if (!this.isCurrent(owner) || !browse?.contents) return null;
    const { contents } = browse;

    /*
      NOTE: Due to the nature of the library, the json responses are not consistent,
            this means we have to check for multiple possible paths to get the lyrics.
    */

    const syncedLines = contents?.elementRenderer?.newElement?.type
      ?.componentType?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;

    const synced = syncedLines?.length && syncedLines[0]?.cueRange
      ? syncedLines.map((it) => ({
        time: this.millisToTime(parseInt(it.cueRange.startTimeMilliseconds)),
        timeInMs: parseInt(it.cueRange.startTimeMilliseconds),
        duration: parseInt(it.cueRange.endTimeMilliseconds) -
          parseInt(it.cueRange.startTimeMilliseconds),
        text: it.lyricLine.trim() === '♪' ? '' : it.lyricLine.trim(),
        status: 'upcoming' as const,
      }))
      : undefined;

    const plain = !synced
      ? syncedLines?.length
        ? syncedLines.map((it) => it.lyricLine).join('\n')
        : contents?.messageRenderer
        ? contents?.messageRenderer?.text?.runs?.map((it) => it.text).join('\n')
        : contents?.sectionListRenderer?.contents?.[0]
          ?.musicDescriptionShelfRenderer?.description?.runs?.map((it) =>
            it.text,
          )?.join('\n')
      : undefined;

    if (typeof plain === 'string' && plain === 'Lyrics not available') {
      return null;
    }

    if (synced?.length && synced[0].timeInMs > 300) {
      synced.unshift({
        duration: 0,
        text: '',
        time: '00:00.00',
        timeInMs: 0,
        status: 'upcoming' as const,
      });
    }

    return {
      title,
      artists: [artist],

      lyrics: plain,
      lines: synced,
    };
  }

  private millisToTime(millis: number) {
    const minutes = Math.floor(millis / 60000);
    const seconds = Math.floor((millis - minutes * 60 * 1000) / 1000);
    const remaining = (millis - minutes * 60 * 1000 - seconds * 1000) / 10;
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}.${remaining.toString().padStart(2, '0')}`;
  }

  // RATE LIMITED (2 req per sec)
  private PROXIED_ENDPOINT = 'https://ytmbrowseproxy.zvz.be/';

  private isCurrent(owner: LyricsRequestOwner) {
    return (
      owner.app.isConnected &&
      document.querySelector('ytmusic-app') === owner.app &&
      owner.app.networkManager === owner.network &&
      (config()?.useYTMLyricsWithoutProxy === true) === owner.withoutProxy
    );
  }

  private async fetchNext(videoId: string, owner: LyricsRequestOwner) {
    if (!this.isCurrent(owner)) return null;
    const data = await owner.network.fetch<
      NextData,
      {
        videoId: string;
      }
    >('/next?prettyPrint=false', {
      videoId,
    });
    return this.isCurrent(owner) ? data : null;
  }

  private async fetchBrowse(
    browseId: string,
    owner: LyricsRequestOwner,
  ): Promise<BrowseData | null> {
    if (!this.isCurrent(owner)) return null;
    if (owner.withoutProxy) {
      const data = await owner.network.fetch<BrowseData, { browseId: string }>(
        '/browse?prettyPrint=false',
        { browseId },
      );
      return this.isCurrent(owner) ? data : null;
    }
    const response = await fetch(
      this.PROXIED_ENDPOINT + 'browse?prettyPrint=false',
      {
        headers,
        method: 'POST',
        body: JSON.stringify({
          browseId,
          context: { client },
        }),
      },
    );
    if (!this.isCurrent(owner)) return null;
    const data = (await response.json()) as BrowseData;
    return this.isCurrent(owner) ? data : null;
  }
}

type LyricsRequestOwner = {
  app: MusicPlayerAppElement;
  network: MusicPlayerAppElement['networkManager'];
  withoutProxy: boolean;
};

interface NextData {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: {
            tabRenderer: {
              endpoint: {
                browseEndpoint: {
                  browseId: string;
                  browseEndpointContextSupportedConfigs: {
                    browseEndpointContextMusicConfig: {
                      pageType: string;
                    };
                  };
                };
              };
            };
          }[];
        };
      };
    };
  };
}

interface BrowseData {
  contents: {
    elementRenderer: {
      newElement: {
        type: {
          componentType: {
            model: {
              timedLyricsModel: {
                lyricsData: {
                  timedLyricsData: SyncedLyricLine[];
                };
              };
            };
          };
        };
      };
    };
    messageRenderer: {
      text: PlainLyricsTextRenderer;
    };
    sectionListRenderer: {
      contents: {
        musicDescriptionShelfRenderer: {
          description: PlainLyricsTextRenderer;
        };
      }[];
    };
  };
}

interface SyncedLyricLine {
  lyricLine: string;
  cueRange: CueRange;
}

interface CueRange {
  startTimeMilliseconds: string;
  endTimeMilliseconds: string;
}

interface PlainLyricsTextRenderer {
  runs: {
    text: string;
  }[];
}
