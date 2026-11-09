import { CompatibleScrobbler, type CompatibleDependencies } from './compatible';

import type { ServiceRuntime } from './base';

// Adapted from #4276; protocol and ownership are shared with Last.fm.
export class LibreFmScrobbler extends CompatibleScrobbler {
  constructor(runtime: ServiceRuntime, dependencies?: CompatibleDependencies) {
    super('librefm', runtime, dependencies);
  }
}
export const createLibreFmService = (
  runtime: ServiceRuntime,
  dependencies?: CompatibleDependencies,
) => new LibreFmScrobbler(runtime, dependencies);
