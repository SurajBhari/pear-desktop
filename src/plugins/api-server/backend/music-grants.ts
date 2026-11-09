import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { MUSIC_SCOPES, failMusic, type MusicScope } from '../music-types';

export type MusicTransport = 'rest' | 'mcp';
export interface MusicGrantRecord {
  id: string;
  name: string;
  transport: MusicTransport;
  resource: string;
  digest: string;
  scopes: MusicScope[];
  createdAt: number;
  expiresAt: number;
}
export const GRANT_LIFETIME_MS = 86400000;
export const GRANT_MAX_RECORDS = 128;
export const GRANT_MAX_BYTES = 512 * 1024;
const scopesValid = (scopes: unknown): scopes is MusicScope[] =>
  Array.isArray(scopes) &&
  scopes.length <= MUSIC_SCOPES.length &&
  new Set(scopes).size === scopes.length &&
  scopes.every((s) => MUSIC_SCOPES.includes(s as MusicScope));
const resourceValid = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.href === value
    );
  } catch {
    return false;
  }
};
const nameValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  Array.from(value).length <= 80 &&
  !Array.from(value).some(
    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  );
const tokenValid = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^pdm_[A-Za-z0-9_-]{43}$/.test(value))
    return false;
  const bytes = Buffer.from(value.slice(4), 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value.slice(4);
};
const digestToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
export function parseMusicBearer(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice(7);
  return tokenValid(token) ? token : null;
}
export function parseMusicGrantRecord(value: unknown): MusicGrantRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== 8 ||
    ![
      'id',
      'name',
      'transport',
      'resource',
      'digest',
      'scopes',
      'createdAt',
      'expiresAt',
    ].every((key) => Object.hasOwn(r, key))
  )
    return null;
  if (
    typeof r.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      r.id,
    ) ||
    !nameValid(r.name) ||
    !['rest', 'mcp'].includes(r.transport as string) ||
    !resourceValid(r.resource) ||
    typeof r.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.digest) ||
    !scopesValid(r.scopes) ||
    !Number.isSafeInteger(r.createdAt) ||
    !Number.isSafeInteger(r.expiresAt) ||
    (r.createdAt as number) < 0 ||
    (r.expiresAt as number) <= (r.createdAt as number) ||
    (r.expiresAt as number) - (r.createdAt as number) > GRANT_LIFETIME_MS
  )
    return null;
  return {
    id: r.id,
    name: r.name,
    transport: r.transport as MusicTransport,
    resource: r.resource,
    digest: r.digest,
    scopes: [...r.scopes],
    createdAt: r.createdAt as number,
    expiresAt: r.expiresAt as number,
  };
}
export function createMusicGrant(
  name: string,
  transport: MusicTransport,
  resource: string,
  scopes: MusicScope[] = [],
  now = Date.now(),
) {
  if (
    !nameValid(name) ||
    !['rest', 'mcp'].includes(transport) ||
    !resourceValid(resource) ||
    !scopesValid(scopes) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + GRANT_LIFETIME_MS)
  )
    return failMusic('invalid');
  const token = `pdm_${randomBytes(32).toString('base64url')}`;
  const record: MusicGrantRecord = {
    id: randomUUID(),
    name,
    transport,
    resource,
    digest: digestToken(token),
    scopes: [...scopes],
    createdAt: now,
    expiresAt: now + GRANT_LIFETIME_MS,
  };
  return { record, token };
}
export function grantAllows(
  record: MusicGrantRecord,
  token: unknown,
  transport: MusicTransport,
  resource: string,
  scope: MusicScope,
  now = Date.now(),
): boolean {
  return (
    grantMatches(record, token, transport, resource, now) &&
    record.scopes.includes(scope)
  );
}
export function grantMatches(
  record: MusicGrantRecord,
  token: unknown,
  transport: MusicTransport,
  resource: string,
  now = Date.now(),
): boolean {
  if (
    !tokenValid(token) ||
    !parseMusicGrantRecord(record) ||
    !Number.isSafeInteger(now) ||
    now < record.createdAt ||
    now >= record.expiresAt ||
    record.transport !== transport ||
    record.resource !== resource
  )
    return false;
  return timingSafeEqual(
    Buffer.from(record.digest, 'hex'),
    Buffer.from(digestToken(token), 'hex'),
  );
}
