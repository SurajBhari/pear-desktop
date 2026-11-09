import { z } from 'zod';

import {
  VIDEO_ID_PATTERN,
  PLAYLIST_ID_PATTERN,
} from '@/providers/queue-playlist';

/** SDK's registration must receive an object root, including union input grammars. */
export function mcpRegistrationSchema(source: z.ZodType) {
  const branches = source instanceof z.ZodUnion ? source.options : [source];
  const shape: Record<string, z.ZodType> = {};
  for (const branch of branches) {
    if (!(branch instanceof z.ZodObject))
      throw new Error('MCP input must have object branches');
    for (const [key, value] of Object.entries(branch.shape)) {
      if (!(value instanceof z.ZodType))
        throw new Error('Invalid MCP input field');
      shape[key] = z.unknown().optional();
    }
  }
  return z
    .object(shape)
    .strict()
    .superRefine((value, context) => {
      if (!source.safeParse(value).success)
        context.addIssue({
          code: 'custom',
          message: 'Invalid music arguments.',
        });
    });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Zod custom predicate refinements need their equivalent public JSON constraints. */
function describeRefinements(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) describeRefinements(child);
    return;
  }
  if (!object(value)) return;
  const fields = value.properties;
  if (object(fields)) {
    if (object(fields.videoId))
      fields.videoId.pattern = VIDEO_ID_PATTERN.source;
    if (object(fields.query))
      Object.assign(fields.query, {
        minLength: 1,
        maxLength: 256,
        pattern: '^(?=[\\s\\S]*\\S)[^\\u0000-\\u001f\\u007f\\uD800-\\uDFFF]+$',
      });
    if (
      object(fields.kind) &&
      fields.kind.const === 'playlist' &&
      object(fields.id)
    )
      Object.assign(fields.id, {
        maxLength: 128,
        pattern: PLAYLIST_ID_PATTERN.source,
      });
  }
  for (const child of Object.values(value)) describeRefinements(child);
}
export function mcpPublicSchema(source: z.ZodType) {
  // Input mode keeps defaulted fields optional. Service refinements remain authoritative.
  const schema = z.toJSONSchema(source, {
    io: 'input',
    unrepresentable: 'any',
  });
  describeRefinements(schema);
  return { ...schema, type: 'object' as const };
}
