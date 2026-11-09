import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { musicModuleSource } from './helpers/api-music-source';

const scopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
  'playback.control',
  'queue.write',
];
const operationId = '00000000-0000-4000-8000-000000000000';
const videoId = 'abcdefghijk';
const playlistId = 'PL' + 'a'.repeat(126);
const cursor = 'mcur_' + 'a'.repeat(43);
const revision = 'a'.repeat(32);
const epoch = revision + ':' + revision;

// Independently hand-counted maximum object members/array elements per tool.
// Strings do not contribute to the vendor element ceiling.
const largestArguments: [string, Record<string, unknown>, number][] = [
  ['music_now_playing', {}, 0],
  ['music_get_queue', { cursor, limit: 100 }, 2],
  ['music_search', { query: 'a'.repeat(256), kind: 'playlist', limit: 100 }, 3],
  [
    'music_browse',
    { target: { kind: 'playlist', id: playlistId }, limit: 100 },
    4,
  ],
  ['music_home', { cursor, limit: 100 }, 2],
  ['music_get_library_playlists', { cursor, limit: 100 }, 2],
  ['music_lyrics', { videoId }, 1],
  ['music_related', { videoId, limit: 100 }, 2],
  [
    'music_comments',
    { videoId, sort: 'newest', limit: 100, allowPublicWebFallback: true },
    4,
  ],
  ...[
    'previous',
    'next',
    'play',
    'pause',
    'toggle_playback',
    'toggle_shuffle',
  ].map((name): [string, Record<string, unknown>, number] => [
    `music_${name}`,
    { operationId },
    1,
  ]),
  ['music_switch_repeat', { iterations: 2, operationId }, 2],
  [
    'music_seek',
    { seconds: Number.MAX_VALUE / 1000, playbackEpoch: epoch, operationId },
    3,
  ],
  ['music_set_volume', { volume: 100, operationId }, 2],
  ['music_play_video', { videoId, playlistId, operationId }, 3],
  [
    'music_play_playlist',
    { videoId, playlistId, shuffle: true, operationId },
    4,
  ],
  ['music_start_radio', { seed: { kind: 'video', videoId }, operationId }, 4],
  [
    'music_enqueue',
    { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO', operationId },
    3,
  ],
  [
    'music_enqueue_playlist',
    {
      videoId,
      playlistId,
      insertPosition: 'INSERT_AFTER_CURRENT_VIDEO',
      operationId,
    },
    4,
  ],
  [
    'music_remove_from_queue',
    {
      queueRevision: revision,
      index: 2047,
      expectedVideoId: videoId,
      operationId,
    },
    4,
  ],
  ['music_clear_queue', { queueRevision: revision, operationId }, 2],
  ['music_operation_status', { operationId }, 1],
];

// An upper bound from every actual advertised branch, including optional fields.
// Fail closed for an unbounded record/array or a new schema form rather than
// silently assuming a newly added argument still fits the security ceiling.
function maximumElements(schema: any): number {
  expect(schema.$ref).toBeUndefined();
  for (const union of ['anyOf', 'oneOf'])
    if (schema[union]) return Math.max(...schema[union].map(maximumElements));
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    return Object.values(schema.properties ?? {}).reduce<number>(
      (total, child) => total + 1 + maximumElements(child),
      0,
    );
  }
  if (schema.type === 'array') {
    expect(Number.isSafeInteger(schema.maxItems)).toBe(true);
    return schema.maxItems * (1 + maximumElements(schema.items));
  }
  expect(['string', 'number', 'integer', 'boolean', 'null']).toContain(
    schema.type,
  );
  return 0;
}

async function modules() {
  return musicModuleSource([
    'src/plugins/api-server/backend/mcp-binding.ts',
    'src/plugins/api-server/backend/mcp-transport.ts',
    'src/plugins/api-server/backend/mcp-tools.ts',
  ]);
}

function session() {
  return {
    id: operationId,
    principal: { scopes },
    current: () => true,
    transactions: new Map(),
  };
}

test('all26 actual schemas have finite legitimate element maxima of at most4 and fit64', async () => {
  const m = await modules();
  const registry = m.createMcpToolRegistry({});
  const binding = m.createMcpBinding({}, session());
  try {
    expect(binding.tools).toHaveLength(26);
    expect(largestArguments).toHaveLength(26);
    const descriptors = registry.list(scopes);
    for (const [name, args, largest] of largestArguments) {
      const descriptor = descriptors.find((tool: any) => tool.name === name);
      expect(descriptor.inputSchema.safeParse(args).success, name).toBe(true);
      const advertised = binding.tools.find((tool: any) => tool.name === name);
      expect(maximumElements(advertised.inputSchema), name).toBe(largest);
      expect(largest).toBeLessThanOrEqual(64);
    }
  } finally {
    await binding.server.close();
  }
});

test('actual binding enforces64 elements before a service callback for flat and deep arguments', async () => {
  const m = await modules();
  const binding = m.createMcpBinding({}, session());
  const client = new Client({ name: 'owned-element-bound', version: '1' });
  let serviceCalls = 0;
  // Fixture-only probe on the actual configured server: its schema admits both
  // shapes, so only the configured vendor bound can prevent this callback.
  binding.server.registerTool(
    'owned_admission_probe',
    {
      inputSchema: z.object({ payload: z.unknown() }).strict(),
    },
    () => {
      serviceCalls++;
      return { content: [{ type: 'text', text: 'owned callback' }] };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await binding.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const call = (payload: unknown) =>
      client.callTool({
        name: 'owned_admission_probe',
        arguments: { payload },
      });
    expect((await call(Array(63).fill(0))).isError).not.toBe(true);
    expect(serviceCalls).toBe(1);
    expect((await call(Array(64).fill(0))).isError).toBe(true);
    let nested: unknown = 0;
    for (let index = 0; index < 64; index++) nested = { child: nested };
    expect((await call(nested)).isError).toBe(true);
    expect(serviceCalls).toBe(1);
  } finally {
    await client.close();
    await binding.server.close();
  }
});

test('actual configured vendor transport rejects over64KiB before SDK dispatch', async () => {
  const m = await modules();
  const owner = session();
  owner.transactions.set(7, {
    delivery: new AbortController(),
    canceled: false,
  });
  const transport = m.createMcpTransport(owner);
  const server = new Server({ name: 'owned-http-bound', version: '1' });
  await server.connect(transport.facade);
  try {
    const response = await transport.http.handleRequest(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'a'.repeat(65536), version: '1' },
          },
        }),
      }),
    );
    expect(response.status).toBe(413);
  } finally {
    await server.close();
  }
});
