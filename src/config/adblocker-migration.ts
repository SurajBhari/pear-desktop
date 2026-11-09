interface MigrationStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => unknown;
}

/** Recover 3.12's renamed configuration without overwriting either preference. */
export const restoreAdblockerConfig = (store: MigrationStore): void => {
  if (store.get('plugins.adblocker') !== undefined) return;
  const tracker = store.get('plugins.do-not-track');
  if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker)) return;
  const config = tracker as Record<string, unknown>;
  store.set('plugins.adblocker', {
    ...config,
    ...(Array.isArray(config.additionalBlockLists)
      ? { additionalBlockLists: [...config.additionalBlockLists] }
      : {}),
  });
};
