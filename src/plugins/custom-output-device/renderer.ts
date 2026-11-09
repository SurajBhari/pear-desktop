import { createRenderer } from '@/utils';

import { OutputDeviceSession } from './session';

import type { CustomOutputPluginConfig } from './index';

let session: OutputDeviceSession | undefined;

export const renderer = createRenderer<unknown, CustomOutputPluginConfig>({
  async start(context) {
    session?.stop();
    const owner = new OutputDeviceSession(context);
    session = owner;
    await owner.start();
  },
  stop() {
    session?.stop();
    session = undefined;
  },
  onConfigChange(config) {
    session?.configure(config);
  },
});
