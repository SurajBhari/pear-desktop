import { isIP } from 'node:net';

import { parseMusicBearer } from './music-grants';

import { MusicServiceError, type MusicFailure } from '../music-types';

import type { APIServerConfig } from '../config';
import type { IncomingMessage } from 'node:http';

const prefix = '/api/v1/music';
export interface MusicHttpResources {
  readonly local?: string;
  readonly remote?: string;
}
/** Main-owned listener lifetime. Never contains a request or bearer. */
export interface MusicHttpListenerOwner {
  readonly identity: object;
  readonly address: string;
  readonly port: number;
  readonly tls: boolean;
  readonly resources: MusicHttpResources;
  readonly signal: AbortSignal;
  ownsSocket(socket: object): boolean;
  current(): boolean;
}
export class MusicHttpFailure extends MusicServiceError {
  constructor(
    code: MusicFailure,
    readonly status: 400 | 401 | 403 | 409,
  ) {
    super(code);
  }
}
function reject(
  status: 400 | 401 | 403 | 409,
  code: MusicFailure = 'forbidden',
): never {
  throw new MusicHttpFailure(code, status);
}

export function normalizeMusicIp(
  value: string | undefined,
): string | undefined {
  if (!value || value.includes('%')) return;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
function loopback(ip: string) {
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}
export function localMusicHttpResource(
  config: APIServerConfig,
): string | undefined {
  const hostname = config.hostname.toLowerCase();
  if (
    !['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(hostname) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    return;
  const host = hostname === '::1' || hostname === '::' ? '[::1]' : '127.0.0.1';
  const advertised = hostname === 'localhost' ? 'localhost' : host;
  const https = config.useHttps && !!config.certPath && !!config.keyPath;
  return new URL(
    `${https ? 'https' : 'http'}://${advertised}:${config.port}${prefix}`,
  ).href;
}
function remoteResource(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const ip = normalizeMusicIp(hostname);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.href !== value ||
      url.pathname !== prefix ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !hostname ||
      hostname.includes('*') ||
      hostname.replace(/\.$/, '') === 'localhost' ||
      hostname.endsWith('.localhost') ||
      (ip && (loopback(ip) || ip === '0.0.0.0' || ip === '::'))
    )
      return;
    return value;
  } catch {
    return;
  }
}
export function musicHttpResources(
  config: APIServerConfig,
): MusicHttpResources {
  if (config.enabled !== true || config.musicApiEnabled !== true)
    return Object.freeze({});
  const local = localMusicHttpResource(config);
  const remote =
    config.musicApiRemoteEnabled === true
      ? remoteResource(config.musicApiRemoteResource)
      : undefined;
  return Object.freeze({
    ...(local ? { local } : {}),
    ...(remote && remote !== local ? { remote } : {}),
  });
}
export function musicHttpListenerSupports(
  owner: MusicHttpListenerOwner,
  resource: string,
): boolean {
  const audience = new URL(resource);
  const port = Number(
    audience.port || (audience.protocol === 'https:' ? 443 : 80),
  );
  return (
    !owner.signal.aborted &&
    normalizeMusicIp(owner.address) !== undefined &&
    owner.port === port &&
    owner.tls === (audience.protocol === 'https:') &&
    Object.values(owner.resources).includes(resource) &&
    owner.current() &&
    !owner.signal.aborted
  );
}
/** Classifies aliases for rejection only; it never authorizes a decoded target. */
export function isMusicHttpNamespace(
  rawTarget: string,
  parsedPath: string,
): boolean {
  const namespace = (target: string) =>
    target === prefix ||
    [
      prefix + '/',
      prefix + '%',
      prefix + '?',
      prefix + '\\',
      prefix + '#',
    ].some((start) => target.startsWith(start));
  for (let target of [rawTarget, parsedPath]) {
    if (/^https?:\/\//i.test(target)) {
      try {
        target = new URL(target).pathname;
      } catch {
        /* raw target still checked below */
      }
    }
    if (namespace(target)) return true;
    try {
      if (namespace(decodeURIComponent(target))) return true;
    } catch {
      /* malformed encoding is not accepted */
    }
  }
  return false;
}
/** No DNS, body reads, forwarded trust, or acquisition of a replacement owner. */
export function musicHttpPolicy(
  incoming: IncomingMessage,
  owner: MusicHttpListenerOwner,
): { token: string; resource: string } {
  const live = () => {
    if (owner.signal.aborted || !owner.current() || owner.signal.aborted)
      reject(409, 'retired');
  };
  live();
  if (!owner.ownsSocket(incoming.socket)) reject(403);
  live();
  const peer = normalizeMusicIp(incoming.socket.remoteAddress);
  const local = normalizeMusicIp(incoming.socket.localAddress);
  const bound = normalizeMusicIp(owner.address);
  if (!peer || !local || !bound) reject(403);
  const entries = new Map<string, string[]>();
  if (incoming.rawHeaders.length % 2) reject(400, 'invalid');
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    const key = incoming.rawHeaders[i].toLowerCase();
    entries.set(key, [...(entries.get(key) ?? []), incoming.rawHeaders[i + 1]]);
  }
  const host = entries.get('host');
  if (!host || host.length !== 1) reject(403);
  const selected: { kind: 'local' | 'remote'; resource: string }[] = [];
  for (const kind of ['local', 'remote'] as const) {
    const resource = owner.resources[kind];
    if (resource && new URL(resource).host === host[0])
      selected.push({ kind, resource });
  }
  if (selected.length !== 1) reject(403);
  const { kind, resource } = selected[0];
  if (kind === 'local' && !loopback(peer)) reject(403);
  if (
    !musicHttpListenerSupports(owner, resource) ||
    incoming.socket.localPort !== owner.port ||
    (bound !== '0.0.0.0' && bound !== '::' && local !== bound) ||
    ((incoming.socket as typeof incoming.socket & { encrypted?: boolean })
      .encrypted ===
      true) !==
      owner.tls
  )
    reject(403);
  live();
  if (
    [...entries.keys()].some(
      (key) =>
        key === 'origin' ||
        key === 'forwarded' ||
        key.startsWith('x-forwarded-'),
    )
  )
    reject(403);
  const authorization = entries.get('authorization');
  if (!authorization || authorization.length !== 1)
    reject(
      authorization?.length ? 403 : 401,
      authorization?.length ? 'forbidden' : 'unauthorized',
    );
  const token = parseMusicBearer(authorization[0]);
  if (!token) reject(401, 'unauthorized');
  if ((entries.get('content-type')?.length ?? 0) > 1) reject(400, 'invalid');
  live();
  return { token, resource };
}
