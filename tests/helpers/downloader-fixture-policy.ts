/** The policy used by the actual-source downloader fixture compiler/loader. */
export const normalizeDownloaderFixtureId = (id: string) =>
  id.replaceAll('\\', '/');

export const downloaderFixturePolicy = (main: string, songInfo: string) => ({
  moduleSideEffects: (id: string) =>
    !normalizeDownloaderFixtureId(id).includes('/src/config/'),
  isMain: (id: string) =>
    normalizeDownloaderFixtureId(id) === normalizeDownloaderFixtureId(main),
  isSongInfo: (id: string) =>
    normalizeDownloaderFixtureId(id) === normalizeDownloaderFixtureId(songInfo),
  evaluate: <T>(code: string, load: () => T): T => {
    // External resolutions are absolute package paths, and native Windows
    // separators may be escaped again inside generated JavaScript literals.
    const imports = code.matchAll(
      /\brequire\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\)/g,
    );
    for (const match of imports) {
      const id = normalizeDownloaderFixtureId(match[1] ?? match[2]);
      if (id.split('/').includes('electron-store'))
        throw new Error('Fixture must not load a profile configuration store');
    }
    return load();
  },
});
