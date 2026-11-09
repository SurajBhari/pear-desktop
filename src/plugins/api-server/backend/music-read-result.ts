import {
  MusicServiceError,
  utf8Bytes,
  type PlaybackSnapshot,
  type QueuePage,
  type LyricsResult,
  type CommentPage,
  type MusicFailure,
  type MusicOperationReceipt,
} from '../music-types';

import type { MusicPage } from './music-service';

export type MusicReadDTO =
  | PlaybackSnapshot
  | QueuePage
  | MusicPage
  | LyricsResult
  | CommentPage
  | MusicOperationReceipt;
export type MusicReadEncoder<T> = (value: T) => string;
export const MUSIC_READ_RESULT_MAX_BYTES = 256 * 1024;
const summary = 'Music result.';
export type McpReadLogicalResult =
  | {
      content: [{ type: 'text'; text: 'Music result.' }];
      structuredContent: Record<string, unknown>;
    }
  | {
      isError: true;
      content: [{ type: 'text'; text: string }];
      structuredContent: { error: { code: MusicFailure; message: string } };
    };
const codes: readonly MusicFailure[] = Object.freeze([
  'invalid',
  'source',
  'unsupported',
  'budget',
  'retired',
  'busy',
  'unavailable',
  'timeout',
  'forbidden',
  'unauthorized',
  'not_found',
  'unknown_operation',
  'expired_operation',
  'conflict',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
function code(value: unknown): value is MusicFailure {
  return typeof value === 'string' && codes.some((entry) => entry === value);
}
/** Total inspection: no foreign code-only error or accessor acquires authority. */
export function musicReadErrorCode(error: unknown): MusicFailure {
  try {
    if (error instanceof MusicServiceError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor && 'value' in descriptor && code(descriptor.value))
        return descriptor.value;
    }
  } catch {
    /* Hostile proxy/descriptor inspection is a fixed source failure. */
  }
  return 'source';
}
export function musicReadFailure(error: unknown): McpReadLogicalResult {
  const safe = new MusicServiceError(musicReadErrorCode(error));
  return {
    isError: true,
    content: [{ type: 'text', text: safe.message }],
    structuredContent: { error: { code: safe.code, message: safe.message } },
  };
}
export function musicReadPayloadLimit(transport: 'rest' | 'mcp'): number {
  // The fixed success wrapper contributes73 bytes, with no duplicate DTO text.
  return MUSIC_READ_RESULT_MAX_BYTES - (transport === 'mcp' ? 73 : 0);
}
export function encodeMusicReadSuccess(value: MusicReadDTO): string {
  const encoded = JSON.stringify({
    content: [{ type: 'text', text: summary }],
    structuredContent: value,
  });
  if (utf8Bytes(encoded) > MUSIC_READ_RESULT_MAX_BYTES)
    throw new MusicServiceError('budget');
  return encoded;
}
/** Pure fresh data only. No reviver, authority callback, DTO cast or SDK cast. */
export function decodeMusicReadResult(encoded: string): McpReadLogicalResult {
  try {
    if (
      typeof encoded !== 'string' ||
      utf8Bytes(encoded) > MUSIC_READ_RESULT_MAX_BYTES
    )
      throw new Error();
    const value: unknown = JSON.parse(encoded);
    if (
      !record(value) ||
      !Array.isArray(value.content) ||
      value.content.length !== 1 ||
      !record(value.content[0])
    )
      throw new Error();
    const text = value.content[0];
    if (
      !keys(text, ['type', 'text']) ||
      text.type !== 'text' ||
      typeof text.text !== 'string' ||
      !record(value.structuredContent) ||
      JSON.stringify(value) !== encoded
    )
      throw new Error();
    if (
      keys(value, ['content', 'structuredContent']) &&
      text.text === summary
    ) {
      const result: McpReadLogicalResult = {
        content: [{ type: 'text', text: summary }],
        structuredContent: value.structuredContent,
      };
      if (JSON.stringify(result) !== encoded) throw new Error();
      return result;
    }
    const data = value.structuredContent;
    if (
      !keys(value, ['isError', 'content', 'structuredContent']) ||
      value.isError !== true ||
      !keys(data, ['error']) ||
      !record(data.error) ||
      !keys(data.error, ['code', 'message']) ||
      !code(data.error.code)
    )
      throw new Error();
    const safe = new MusicServiceError(data.error.code);
    if (data.error.message !== safe.message || text.text !== safe.message)
      throw new Error();
    // The public SDK projects errors as content/structuredContent/isError.
    // Only this fixed dictionary may normalize key order; success remains byte-bound.
    return musicReadFailure(safe);
  } catch {
    return musicReadFailure(new MusicServiceError('source'));
  }
}
