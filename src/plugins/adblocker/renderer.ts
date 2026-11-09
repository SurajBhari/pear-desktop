import { createAdSpeedup } from './ad-speedup';
import { blockers, type AdblockerConfig } from './types';

export const createAdblockerRenderer = (doc?: Document) => {
  let speedup: ReturnType<typeof createAdSpeedup> | undefined;
  let revision = 0;
  const configure = (config: AdblockerConfig) => {
    if (config.enabled && config.blocker === blockers.AdSpeedup) {
      speedup ??= createAdSpeedup(doc);
      speedup.start();
    } else {
      speedup?.stop();
      speedup = undefined;
    }
  };
  return {
    async start({
      getConfig,
    }: {
      getConfig: () => AdblockerConfig | Promise<AdblockerConfig>;
    }) {
      const expected = ++revision;
      const config = await getConfig();
      if (expected === revision) configure(config);
    },
    stop() {
      revision++;
      speedup?.stop();
      speedup = undefined;
    },
    onConfigChange(config: AdblockerConfig) {
      revision++;
      configure(config);
    },
  };
};
