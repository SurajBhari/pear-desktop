/** Synthetic public layouts. Field paths are pinned by public-shapes/SOURCE.json. */
export const PUBLIC_SHAPE_COMMIT = 'bad89d2657e88f907011655f199fba9fb615c339';
export const artistId = 'UCAAAAAAAAAAAAAAAAAAAAAA';
export const albumId = 'MPREb_fixture_album';
export const videoId = (index: number) =>
  'v' + index.toString(36).padStart(10, '0');
const text = (value: string) => ({ runs: [{ text: value }] });
const watch = (id: string) => ({
  watchEndpoint: {
    videoId: id,
    watchEndpointMusicSupportedConfigs: {
      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    },
  },
});
const browse = (id: string, pageType: string) => ({
  browseEndpoint: {
    browseId: id,
    browseEndpointContextSupportedConfigs: {
      browseEndpointContextMusicConfig: { pageType },
    },
  },
});
const artistRun = () => ({
  text: 'Fixture Artist',
  navigationEndpoint: browse(artistId, 'MUSIC_PAGE_TYPE_ARTIST'),
});
const image = (id: string) => ({
  thumbnails: [
    { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
  ],
});

export function responsiveSong(index: number) {
  const id = videoId(index);
  return {
    musicResponsiveListItemRenderer: {
      navigationEndpoint: watch(id),
      playlistItemData: { videoId: id },
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: 'Fixture Track ' + index,
                  navigationEndpoint: watch(id),
                },
              ],
            },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                artistRun(),
                { text: ' • ' },
                {
                  text: 'Fixture Album',
                  navigationEndpoint: browse(albumId, 'MUSIC_PAGE_TYPE_ALBUM'),
                },
                { text: ' • ' },
                { text: '3:30' },
              ],
            },
          },
        },
      ],
      fixedColumns: [
        { musicResponsiveListItemFixedColumnRenderer: { text: text('3:30') } },
      ],
      thumbnail: { musicThumbnailRenderer: { thumbnail: image(id) } },
      clickTrackingParams: 'synthetic-tracking-must-not-leave-parser',
    },
  };
}
export function twoRowSong(index: number) {
  const id = videoId(index);
  return {
    musicTwoRowItemRenderer: {
      title: text('Fixture Track ' + index),
      navigationEndpoint: watch(id),
      subtitle: { runs: [{ text: 'Song' }, { text: ' • ' }, artistRun()] },
      thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: image(id) } },
    },
  };
}
export function multiRowVideo(index: number) {
  const id = videoId(index);
  return {
    musicMultiRowListItemRenderer: {
      title: text('Fixture Video ' + index),
      subtitle: { runs: [artistRun()] },
      onTap: watch(id),
      thumbnail: { musicThumbnailRenderer: { thumbnail: image(id) } },
      secondTitle: text('Synthetic subtitle'),
      description: text('Synthetic public description'),
    },
  };
}
export function twoRowBrowse(
  kind: 'artist' | 'album' | 'playlist',
  id: string,
) {
  const pageType = `MUSIC_PAGE_TYPE_${kind.toUpperCase()}`;
  const endpoint = browse(kind === 'playlist' ? 'VL' + id : id, pageType);
  return {
    musicTwoRowItemRenderer: {
      title: {
        runs: [{ text: 'Fixture ' + kind, navigationEndpoint: endpoint }],
      },
      navigationEndpoint: endpoint,
      subtitle: { runs: [artistRun()] },
      thumbnailRenderer: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [{ url: 'https://lh3.googleusercontent.com/fixture' }],
          },
        },
      },
    },
  };
}
export function categoryButton(title = 'Fixture mood') {
  return {
    musicNavigationButtonRenderer: {
      buttonText: text(title),
      clickCommand: {
        browseEndpoint: {
          browseId: 'FEmusic_moods_and_genres_category',
          params: 'synthetic-service-owned-params',
        },
      },
    },
  };
}
export function singleColumn(shelves: unknown[]) {
  return {
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              selected: true,
              title: 'Synthetic',
              content: { sectionListRenderer: { contents: shelves } },
            },
          },
        ],
      },
    },
  };
}
export function carousel(items: unknown[], title = 'Fixture shelf') {
  return {
    musicCarouselShelfRenderer: {
      header: { musicCarouselShelfBasicHeaderRenderer: { title: text(title) } },
      contents: items,
    },
  };
}
export const home151 = () =>
  singleColumn([
    carousel(
      Array.from({ length: 37 }, (_, i) => twoRowSong(i)),
      'Shelf One',
    ),
    carousel(
      Array.from({ length: 65 }, (_, i) => responsiveSong(i + 37)),
      'Shelf Two',
    ),
    carousel(
      Array.from({ length: 49 }, (_, i) => multiRowVideo(i + 102)),
      'Shelf Three',
    ),
  ]);
export function playlist1000() {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              selected: true,
              content: { sectionListRenderer: { contents: [] } },
            },
          },
        ],
        secondaryContents: {
          sectionListRenderer: {
            contents: [
              {
                musicPlaylistShelfRenderer: {
                  contents: Array.from({ length: 1000 }, (_, i) =>
                    responsiveSong(i),
                  ),
                },
              },
            ],
          },
        },
      },
    },
  };
}
export const searchPage = () => ({
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicShelfRenderer: {
                      title: text('Songs'),
                      contents: [responsiveSong(0)],
                      continuations: [
                        {
                          nextContinuationData: {
                            continuation: 'synthetic-service-continuation',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
});
export const continuationPage = () => ({
  continuationContents: {
    musicShelfContinuation: {
      contents: [responsiveSong(1)],
      continuations: [],
    },
  },
});
