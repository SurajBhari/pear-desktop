import { CompatibleScrobbler, type CompatibleDependencies } from './compatible';

import type { ServiceRuntime } from './base';
export class LastFmScrobbler extends CompatibleScrobbler {
  constructor(runtime: ServiceRuntime, dependencies?: CompatibleDependencies) {
    super('lastfm', runtime, dependencies);
  }
}
export const createLastFmService = (
  runtime: ServiceRuntime,
  dependencies?: CompatibleDependencies,
) => new LastFmScrobbler(runtime, dependencies);
