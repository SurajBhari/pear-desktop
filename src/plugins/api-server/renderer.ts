import { createLegacyClockRendererController } from '@/providers/legacy-clock-renderer';
import { createMusicRendererController } from '@/providers/music-renderer';
import { createRenderer } from '@/utils';

import type { APIServerConfig } from './config';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

let controller: ReturnType<typeof createMusicRendererController> | undefined;
let clockController:
  | ReturnType<typeof createLegacyClockRendererController>
  | undefined;
let currentApi: MusicPlayer | null = null;
let currentContext: RendererContext<APIServerConfig> | undefined;
let config: APIServerConfig | undefined;
let running = false;
let generation = 0;
let configRevision = 0;
let readyRevision = 0;
const disposeController = () => {
  const previous = controller,
    clock = clockController;
  controller = undefined;
  clockController = undefined;
  previous?.dispose();
  clock?.dispose();
};
const activate = () => {
  if (
    running &&
    config?.enabled === true &&
    currentApi &&
    currentContext &&
    !clockController
  ) {
    const epoch = generation,
      revision = configRevision,
      ready = readyRevision,
      api = currentApi,
      ctx = currentContext;
    const candidate = createLegacyClockRendererController(
      api,
      () => currentApi,
      ctx.ipc,
    );
    if (
      !running ||
      epoch !== generation ||
      revision !== configRevision ||
      ready !== readyRevision ||
      currentApi !== api ||
      currentContext !== ctx ||
      clockController
    )
      candidate.dispose();
    else clockController = candidate;
  }
  if (
    !running ||
    config?.enabled !== true ||
    config.musicApiEnabled !== true ||
    !currentApi ||
    !currentContext ||
    controller
  )
    return;
  const epoch = generation,
    revision = configRevision,
    ready = readyRevision,
    api = currentApi,
    ctx = currentContext;
  const candidate = createMusicRendererController(
    api,
    () => currentApi,
    ctx.ipc,
  );
  if (
    !running ||
    epoch !== generation ||
    revision !== configRevision ||
    ready !== readyRevision ||
    currentApi !== api ||
    currentContext !== ctx ||
    controller
  )
    candidate.dispose();
  else controller = candidate;
};
const stop = () => {
  running = false;
  generation++;
  configRevision++;
  readyRevision++;
  currentApi = null;
  currentContext = undefined;
  config = undefined;
  disposeController();
};
export const renderer = createRenderer<unknown, APIServerConfig>({
  async start(ctx) {
    const epoch = generation + 1,
      revision = configRevision + 1,
      ready = readyRevision + 1;
    stop();
    if (epoch !== generation || ready !== readyRevision) return;
    running = true;
    const next = await ctx.getConfig();
    if (
      !running ||
      epoch !== generation ||
      revision !== configRevision ||
      ready !== readyRevision
    )
      return;
    config = next;
    activate();
  },
  async onPlayerApiReady(api, ctx) {
    if (!running) return;
    const epoch = generation,
      revision = configRevision,
      ready = ++readyRevision;
    disposeController();
    if (!running || epoch !== generation || ready !== readyRevision) return;
    currentApi = api;
    currentContext = ctx;
    const next = await ctx.getConfig();
    if (
      !running ||
      epoch !== generation ||
      revision !== configRevision ||
      ready !== readyRevision ||
      currentApi !== api ||
      currentContext !== ctx
    )
      return;
    config = next;
    activate();
  },
  onConfigChange(next) {
    configRevision++;
    config = next;
    disposeController();
    activate();
  },
  stop,
});
