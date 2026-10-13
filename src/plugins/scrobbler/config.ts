import { apiEndpoint, type WsAccount } from './services/ws-client';

export type WsServiceName = 'lastfm' | 'librefm';
export interface CompatibleAccountConfig {
  enabled: boolean;
  token?: string | null;
  sessionKey?: string | null;
  apiRoot: string;
  apiKey: string | null;
  secret: string | null;
}
export interface ScrobblerPluginConfig {
  enabled: boolean;
  scrobbleOtherMedia: boolean;
  alternativeTitles: boolean;
  /** Deprecated saved preference; use artistSource for an explicit choice. */
  alternativeArtist: boolean;
  artistSource?: 'primary' | 'first-tag';
  scrobblers: {
    lastfm: CompatibleAccountConfig;
    librefm: CompatibleAccountConfig;
    listenbrainz: { enabled: boolean; token?: string | null; apiRoot: string };
  };
}
type PartialLeaves<T> = {
  [K in keyof T]?: T[K] extends object ? PartialLeaves<T[K]> : T[K];
};
export type ScrobblerConfigPatch = PartialLeaves<
  Omit<ScrobblerPluginConfig, 'enabled'>
>;
export function applyScrobblerPatch(
  setter: (
    value: Partial<Omit<ScrobblerPluginConfig, 'enabled'>>,
  ) => void | Promise<void>,
  patch: ScrobblerConfigPatch,
) {
  // The loader uses config.setPartial for deep leaf patches; BaseContext's
  // shallow Partial annotation does not describe that existing runtime contract.
  return setter(patch as Partial<Omit<ScrobblerPluginConfig, 'enabled'>>);
}
export const defaultConfig: ScrobblerPluginConfig = {
  enabled: false,
  scrobbleOtherMedia: true,
  alternativeTitles: true,
  alternativeArtist: false,
  artistSource: 'primary',
  scrobblers: {
    lastfm: {
      enabled: false,
      token: null,
      sessionKey: null,
      apiRoot: 'https://ws.audioscrobbler.com/2.0/',
      apiKey: '04d76faaac8726e60988e14c105d421a',
      secret: 'a5d2a36fdf64819290f6982481eaffa2',
    },
    // Public application defaults from #4276, not user credentials.
    librefm: {
      enabled: false,
      token: null,
      sessionKey: null,
      apiRoot: 'https://libre.fm/2.0/',
      apiKey: 'ba02767a32bf0d4c5e048fab86065fe4',
      secret: 'baa68bbef1bc6a5f4514dc76b48bc0d5',
    },
    listenbrainz: {
      enabled: false,
      token: null,
      apiRoot: 'https://api.listenbrainz.org/1/',
    },
  },
};
export const authRootFor = (name: WsServiceName) =>
  name === 'lastfm'
    ? 'https://www.last.fm/api/auth/'
    : 'https://libre.fm/api/auth/';
const configuredCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
const optionalCredential = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.length <= 512);
export function readWsAccount(
  config: ScrobblerPluginConfig | undefined,
  name: WsServiceName,
) {
  try {
    if (config?.enabled !== true) return;
    const record = config.scrobblers?.[name];
    if (!record) return;
    const { enabled, apiRoot, apiKey, secret, sessionKey, token } = record;
    if (
      enabled !== true ||
      !configuredCredential(apiKey) ||
      !configuredCredential(secret) ||
      !optionalCredential(sessionKey) ||
      !optionalCredential(token)
    )
      return;
    const account: WsAccount = {
      apiRoot: apiEndpoint(apiRoot),
      apiKey,
      secret,
    };
    return {
      account,
      key:
        typeof sessionKey === 'string' && sessionKey.length ? sessionKey : null,
      fingerprint: JSON.stringify([name, account.apiRoot, apiKey, secret]),
    };
  } catch {
    return;
  }
}
export const sessionPatch = (
  name: WsServiceName,
  sessionKey: string | null,
): ScrobblerConfigPatch =>
  name === 'lastfm'
    ? { scrobblers: { lastfm: { sessionKey, token: null } } }
    : { scrobblers: { librefm: { sessionKey, token: null } } };
export function readListenbrainzAccount(
  config: ScrobblerPluginConfig | undefined,
) {
  try {
    if (config?.enabled !== true) return;
    const record = config.scrobblers?.listenbrainz;
    if (!record) return;
    const { enabled, apiRoot, token } = record;
    if (
      enabled !== true ||
      !configuredCredential(token) ||
      /[\r\n]/.test(token) ||
      typeof apiRoot !== 'string' ||
      apiRoot.length > 4096
    )
      return;
    const url = new URL(apiRoot);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return {
      apiRoot: url.href,
      token,
      fingerprint: JSON.stringify([url.href, token]),
    };
  } catch {
    return;
  }
}
