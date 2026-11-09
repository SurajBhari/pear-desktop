/** Lazy single-flight initialization, adapted from #4734 (@maseckt). */
export interface DownloaderInitialization<T> {
  get: () => Promise<T>;
  dispose: () => void;
  signal: AbortSignal;
}

export const createDownloaderInitialization = <T>(
  isCurrent: () => boolean,
  initialize: (signal: AbortSignal) => Promise<T>,
): DownloaderInitialization<T> => {
  const controller = new AbortController();
  let pending: Promise<T> | undefined;
  let disposed = false;
  const assertCurrent = () => {
    if (disposed || !isCurrent())
      throw new Error('Downloader backend is no longer active');
  };
  return {
    signal: controller.signal,
    get: () => {
      assertCurrent();
      if (!pending) {
        const attempt = Promise.resolve()
          .then(() => {
            assertCurrent();
            return initialize(controller.signal);
          })
          .then((client) => {
            assertCurrent();
            return client;
          })
          .catch((error: unknown) => {
            if (pending === attempt) pending = undefined;
            throw error;
          });
        pending = attempt;
      }
      return pending;
    },
    dispose: () => {
      disposed = true;
      pending = undefined;
      controller.abort();
    },
  };
};
