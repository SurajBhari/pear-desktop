import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { musicModuleSource } from './helpers/api-music-source';

// Actual service, grant ledger, SDK and ephemeral HTTP; native broker effects are sinks.
const videoId = 'abcdefghijk';
const revision = '3'.repeat(32);
const epoch = '1'.repeat(32) + ':' + '2'.repeat(32);
const allScopes = [
  'playback.read',
  'catalog.read',
  'personalized.read',
  'library.read',
  'comments.read',
  'playback.control',
  'queue.write',
];
const mutations = [
  ['music_previous', {}, 'control', 'previous'],
  ['music_next', {}, 'control', 'next'],
  ['music_play', {}, 'control', 'play'],
  ['music_pause', {}, 'control', 'pause'],
  ['music_toggle_playback', {}, 'control', 'toggle_playback'],
  ['music_toggle_shuffle', {}, 'control', 'toggle_shuffle'],
  ['music_switch_repeat', { iterations: 2 }, 'control', 'switch_repeat'],
  ['music_seek', { seconds: 0, playbackEpoch: epoch }, 'control', 'seek'],
  ['music_set_volume', { volume: 0 }, 'control', 'set_volume'],
  ['music_play_video', { videoId }, 'navigate', 'play_song'],
  [
    'music_play_playlist',
    { playlistId: 'PLowned', shuffle: true },
    'navigate',
    'play_playlist',
  ],
  [
    'music_start_radio',
    { seed: { kind: 'video', videoId } },
    'navigate',
    'radio',
  ],
  ['music_enqueue', { videoId }, 'mutate-queue', 'enqueue_song'],
  [
    'music_enqueue_playlist',
    { playlistId: 'PLowned', insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' },
    'mutate-queue',
    'enqueue_playlist',
  ],
  [
    'music_remove_from_queue',
    { queueRevision: revision, index: 0, expectedVideoId: videoId },
    'mutate-queue',
    'remove_from_queue',
  ],
  [
    'music_clear_queue',
    { queueRevision: revision },
    'mutate-queue',
    'clear_queue',
  ],
] as const;

async function fixture(scopes = allScopes) {
  const m = await musicModuleSource([
    'src/plugins/api-server/backend/mcp.ts',
    'src/plugins/api-server/backend/music-service.ts',
    'src/plugins/api-server/backend/music-grant-store.ts',
  ]);
  let contents: string | null = null;
  let now = Date.now();
  const grants = new m.MusicGrantStore('/virtual-owned', () => now, {
    read: async () => ({ contents, binding: 'owned' }),
    stage: async (_: string, next: string) => ({
      commit: async () => {
        contents = next;
        return 'owned';
      },
      close: async () => {},
    }),
  });
  const native = new AbortController();
  const admission = {};
  const retirements = new Set<() => void>();
  const dispatched: any[] = [];
  let execute: (input: any, options: any) => Promise<unknown> = async (
    input,
    options,
  ) => {
    options.onPhysicalSettled?.('owned_settled');
    return input.operation === 'control'
      ? { version: 1, phase: 'owned_control_dispatch' }
      : input.operation === 'navigate'
        ? { version: 1, phase: 'owned_dispatch' }
        : {
            version: 1,
            phase: 'owned_queue_dispatch',
            ...(['enqueue_song', 'enqueue_playlist'].includes(
              input.command.action,
            )
              ? { count: 1 }
              : {}),
          };
  };
  const broker = {
    retain: () => () => {},
    subscribeRetirement: (fn: () => void) => {
      retirements.add(fn);
      return () => retirements.delete(fn);
    },
    capture: () => admission,
    isCurrent: (value: unknown) =>
      value === admission && !native.signal.aborted,
    read: async (_: unknown, input: any, _principal: unknown, options: any) => {
      dispatched.push(input);
      return execute(input, options);
    },
  };
  let listener: any;
  const service = m.createMusicService({
    now: () => now,
    window: {},
    config: { enabled: true, musicApiEnabled: false },
    grants,
    broker,
    resolveAccessOwner: () => listener?.owner,
  });
  listener = m.createMcpListener({ service, grants, port: 0 });
  await listener.start();
  const grant = await grants.issue(
    'W17 owned',
    'mcp',
    listener.resource,
    scopes,
    () => true,
  );
  const clients: Client[] = [];
  const connection = async (token = grant.token) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(listener.resource),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: 'owned-w17', version: '1' });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  };
  const { client, transport } = await connection();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const post = (
    body: unknown,
    sessionId = transport.sessionId!,
    signal?: AbortSignal,
  ) =>
    fetch(listener.resource, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${grant.token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify(body),
    });
  return {
    m,
    listener,
    service,
    grants,
    grant,
    native,
    client,
    transport,
    connection,
    call,
    post,
    dispatched,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    setExecute: (fn: typeof execute) => {
      execute = fn;
    },
    retire: () => {
      native.abort();
      for (const fn of retirements) fn();
    },
    close: async () => {
      for (const c of clients) await c.close();
      await listener.stop();
      service.stop();
    },
  };
}
function data(result: any) {
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: 'Music result.' }]);
  return result.structuredContent;
}

test('actual SDK client lists all26 and prepares, dispatches, replays and polls all16 mutations', async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools;
    expect(listed).toHaveLength(26);
    expect(f.dispatched).toHaveLength(0);
    for (const [name, args, lane, action] of mutations) {
      const before = f.dispatched.length;
      const pending = data(await f.call(name, args));
      expect(pending).toMatchObject({
        status: 'pending',
        operationId: expect.any(String),
      });
      expect(f.dispatched).toHaveLength(before);
      const input = { ...args, operationId: pending.operationId };
      const accepted = data(await f.call(name, input));
      expect(accepted).toMatchObject({
        operationId: pending.operationId,
        status: 'accepted',
      });
      expect(f.dispatched).toHaveLength(before + 1);
      expect(f.dispatched.at(-1)).toMatchObject({
        operation: lane,
        command: { action, ...args },
      });
      expect(data(await f.call(name, input))).toEqual(accepted);
      expect(
        data(
          await f.call('music_operation_status', {
            operationId: pending.operationId,
          }),
        ),
      ).toEqual(accepted);
      expect(f.dispatched).toHaveLength(before + 1);
      expect(
        listed.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
      ).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test('read-only grant omits mutation/status tools and cannot prepare or dispatch', async () => {
  const f = await fixture(['playback.read']);
  try {
    expect(
      (await f.client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual(['music_get_queue', 'music_now_playing']);
    for (const name of [
      'music_play',
      'music_enqueue',
      'music_operation_status',
    ]) {
      const response = await f.post({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name, arguments: {} },
      });
      expect(JSON.stringify(await response.json())).not.toContain(
        '"status":"pending"',
      );
    }
    expect(f.dispatched).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('strict write schemas reject invalid bounds, foreign authority and mismatched operation arguments', async () => {
  const f = await fixture();
  try {
    const bad: [string, Record<string, unknown>][] = [
      ['music_play', { action: 'pause' }],
      ['music_play', { transport: 'rest' }],
      ['music_set_volume', { volume: 101 }],
      ['music_set_volume', { volume: -1 }],
      ['music_seek', { seconds: 1 }],
      ['music_seek', { seconds: -1, playbackEpoch: epoch }],
      ['music_switch_repeat', { iterations: 3 }],
      ['music_play_video', { videoId: 'bad' }],
      ['music_play_playlist', { playlistId: 'bad' }],
      ['music_enqueue', { videoId, insertPosition: 'bad' }],
      [
        'music_remove_from_queue',
        { queueRevision: revision, index: 2048, expectedVideoId: videoId },
      ],
      ['music_clear_queue', { queueRevision: 'old' }],
      ['music_operation_status', { operationId: 'bad' }],
    ];
    for (const [name, args] of bad) {
      const result = await f.call(name, args);
      expect(result.isError, name).toBe(true);
    }
    expect(f.dispatched).toHaveLength(0);
    const prepared = data(await f.call('music_set_volume', { volume: 10 }));
    const conflict = await f.call('music_set_volume', {
      volume: 11,
      operationId: prepared.operationId,
    });
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'conflict' } },
    });
    expect(f.dispatched).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const scope of ['playback.control', 'queue.write']) {
  test(`status uses its actual originating action permission: ${scope}`, async () => {
    const f = await fixture([scope]);
    try {
      const listed = (await f.client.listTools()).tools.map(
        (tool) => tool.name,
      );
      expect(listed).toHaveLength(scope === 'queue.write' ? 5 : 13);
      expect(listed).toContain('music_operation_status');
      const name = scope === 'queue.write' ? 'music_enqueue' : 'music_pause';
      const args = scope === 'queue.write' ? { videoId } : {};
      const pending = data(await f.call(name, args));
      expect(
        data(
          await f.call('music_operation_status', {
            operationId: pending.operationId,
          }),
        ),
      ).toEqual(pending);
      expect(
        data(await f.call(name, { ...args, operationId: pending.operationId })),
      ).toMatchObject({ status: 'accepted' });
    } finally {
      await f.close();
    }
  });
}

test('receipts never cross another session of the same grant or another principal', async () => {
  const f = await fixture();
  try {
    const prepared = data(await f.call('music_play', {}));
    const sameGrant = await f.connection();
    const foreignGrant = await f.grants.issue(
      'Foreign',
      'mcp',
      f.listener.resource,
      allScopes,
      () => true,
    );
    const foreign = await f.connection(foreignGrant.token);
    for (const client of [sameGrant.client, foreign.client]) {
      for (const name of ['music_play', 'music_operation_status']) {
        const result = await client.callTool({
          name,
          arguments: { operationId: prepared.operationId },
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'unknown_operation' } },
        });
      }
    }
    expect(f.dispatched).toHaveLength(0);
    expect(
      data(await f.call('music_play', { operationId: prepared.operationId })),
    ).toMatchObject({ status: 'accepted' });
  } finally {
    await f.close();
  }
});

test('numeric0 cancellation completes its original POST while string0 and physical settlement stay independent', async () => {
  const f = await fixture();
  let settle: (() => void) | undefined;
  let physicallySettled = false;
  try {
    const headers = {
      Authorization: `Bearer ${f.grant.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    const initialized = await fetch(f.listener.resource, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'raw-bootstrap',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'zero-owned', version: '1' },
        },
      }),
    });
    const sid = initialized.headers.get('mcp-session-id')!;
    await initialized.arrayBuffer();
    const post = (body: unknown) => f.post(body, sid);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const preparation = await post({
      jsonrpc: '2.0',
      id: 'prepare',
      method: 'tools/call',
      params: { name: 'music_play', arguments: {} },
    });
    const prepared = data(
      ((await preparation.json()) as { result: unknown }).result,
    );
    f.setExecute(
      async (_input, options) =>
        new Promise((resolve) => {
          settle = () => {
            physicallySettled = true;
            options.onPhysicalSettled?.('owned_settled');
            resolve({ version: 1, phase: 'owned_control_dispatch' });
          };
        }),
    );
    const original = post({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: {
        name: 'music_play',
        arguments: { operationId: prepared.operationId },
      },
    });
    await expect.poll(() => f.dispatched.length).toBe(1);
    const other = await post({
      jsonrpc: '2.0',
      id: '0',
      method: 'tools/call',
      params: {
        name: 'music_operation_status',
        arguments: { operationId: prepared.operationId },
      },
    });
    expect(await other.json()).toMatchObject({
      id: '0',
      result: { structuredContent: { status: 'pending' } },
    });
    expect(
      (
        await post({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 0 },
        })
      ).status,
    ).toBe(202);
    expect(await (await original).json()).toMatchObject({
      id: 0,
      error: { code: -32800 },
    });
    expect(physicallySettled).toBe(false);
    expect(f.dispatched).toHaveLength(1);
    settle!();
    let sequence = 0;
    const call = async (name: string) => {
      const response = await post({
        jsonrpc: '2.0',
        id: 'after-' + sequence++,
        method: 'tools/call',
        params: { name, arguments: { operationId: prepared.operationId } },
      });
      return data(((await response.json()) as { result: unknown }).result);
    };
    await expect
      .poll(async () => (await call('music_operation_status')).status)
      .toBe('accepted');
    expect(await call('music_play')).toMatchObject({ status: 'accepted' });
    expect(f.dispatched).toHaveLength(1);
  } finally {
    settle?.();
    await f.close();
  }
});

test('concurrent duplicate operation IDs share one owned effect and retain uncertain outcomes', async () => {
  const f = await fixture();
  let rejectOwned: (() => void) | undefined;
  let physical: (() => void) | undefined;
  try {
    const prepared = data(await f.call('music_enqueue', { videoId }));
    f.setExecute(
      async (_input, options) =>
        new Promise((_resolve, reject) => {
          rejectOwned = () => reject(new Error('Owned sunk failure'));
          physical = () => options.onPhysicalSettled?.('owned_settled');
        }),
    );
    const input = { videoId, operationId: prepared.operationId };
    const first = f.call('music_enqueue', input);
    await expect.poll(() => f.dispatched.length).toBe(1);
    const duplicate = f.call('music_enqueue', input);
    rejectOwned!();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(data(a)).toMatchObject({
      status: 'uncertain',
      error: 'outcome_unknown',
    });
    expect(data(b)).toEqual(data(a));
    expect(data(await f.call('music_enqueue', input))).toEqual(data(a));
    expect(f.dispatched).toHaveLength(1);
    physical!();
  } finally {
    physical?.();
    rejectOwned?.();
    await f.close();
  }
});

test('DELETE retires pending receipts and another session cannot execute them', async () => {
  const f = await fixture();
  try {
    const prepared = data(await f.call('music_pause', {}));
    await f.transport.terminateSession();
    const next = await f.connection();
    const result = await next.client.callTool({
      name: 'music_pause',
      arguments: { operationId: prepared.operationId },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'unknown_operation' } },
    });
    expect(f.dispatched).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const retirement of ['revoke', 'native'] as const) {
  test(`original ${retirement} after SDK await suppresses a prepared receipt`, async () => {
    const f = await fixture();
    const original =
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
      async function (...args) {
        const response = await original.apply(this, args);
        if (retirement === 'revoke')
          await f.grants.revoke(f.grant.record.id, () => true);
        else f.retire();
        return response;
      };
    try {
      const [result] = await Promise.allSettled([f.call('music_play', {})]);
      expect(result.status).toBe('rejected');
      expect(f.dispatched).toHaveLength(0);
    } finally {
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
        original;
      await f.close();
    }
  });
}

test('the final receipt writer rejects SDK substitution despite a live witness', async () => {
  const f = await fixture();
  const original =
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
  WebStandardStreamableHTTPServerTransport.prototype.handleRequest =
    async function (...args) {
      const response = await original.apply(this, args);
      const message: any = await response.json();
      message.result.structuredContent = {
        operationId: '00000000-0000-4000-8000-000000000000',
        status: 'accepted',
        meaning: 'owned_control_dispatch',
      };
      return new Response(JSON.stringify(message), {
        status: response.status,
        headers: response.headers,
      });
    };
  try {
    const response = await f.post({
      jsonrpc: '2.0',
      id: 'receipt-swap',
      method: 'tools/call',
      params: { name: 'music_play', arguments: {} },
    });
    expect(await response.json()).toMatchObject({
      id: 'receipt-swap',
      error: { code: -32603 },
    });
    expect(f.dispatched).toHaveLength(0);
  } finally {
    WebStandardStreamableHTTPServerTransport.prototype.handleRequest = original;
    await f.close();
  }
});

test('advertised write schemas preserve bounds, defaults, IDs and strict nested authority', async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools;
    const validator = new AjvJsonSchemaValidator();
    for (const [name, args] of mutations) {
      const schema = listed.find((tool) => tool.name === name)!.inputSchema;
      const validate = validator.getValidator(schema);
      expect(validate(args).valid, name).toBe(true);
      expect(
        validate({
          ...args,
          operationId: '00000000-0000-4000-8000-000000000000',
        }).valid,
        name,
      ).toBe(true);
      for (const invalid of [
        { ...args, transport: 'rest' },
        { ...args, operationId: 'bad' },
      ]) {
        expect(validate(invalid).valid, name).toBe(false);
        expect((await f.call(name, invalid)).isError, name).toBe(true);
      }
    }
    for (const seed of [
      { kind: 'video', videoId, token: 'foreign' },
      { kind: 'current', videoId },
      { kind: 'playlist', playlistId: 'bad' },
    ]) {
      const schema = listed.find(
        (tool) => tool.name === 'music_start_radio',
      )!.inputSchema;
      expect(validator.getValidator(schema)({ seed }).valid).toBe(false);
      expect((await f.call('music_start_radio', { seed })).isError).toBe(true);
    }
    expect(f.dispatched).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('expired or unknown operation IDs never prepare or dispatch another effect', async () => {
  const f = await fixture();
  try {
    const pending = data(await f.call('music_pause', {}));
    f.advance(120_001);
    const expired = await f.call('music_pause', {
      operationId: pending.operationId,
    });
    expect(expired).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'expired_operation' } },
    });
    const unknown = await f.call('music_pause', {
      operationId: pending.operationId,
    });
    expect(unknown).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'unknown_operation' } },
    });
    expect(f.dispatched).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a lost original HTTP response never retries its operation or releases its physical effect', async () => {
  const f = await fixture();
  let settle: (() => void) | undefined;
  let physical = false;
  try {
    const prepared = data(await f.call('music_enqueue', { videoId }));
    f.setExecute(
      async (_input, options) =>
        new Promise((resolve) => {
          settle = () => {
            physical = true;
            options.onPhysicalSettled?.('owned_settled');
            resolve({ version: 1, phase: 'owned_queue_dispatch', count: 1 });
          };
        }),
    );
    const disconnected = new AbortController();
    const original = f.post(
      {
        jsonrpc: '2.0',
        id: 'lost-original',
        method: 'tools/call',
        params: {
          name: 'music_enqueue',
          arguments: { videoId, operationId: prepared.operationId },
        },
      },
      f.transport.sessionId!,
      disconnected.signal,
    );
    const observed = original.then(
      () => 'delivered',
      () => 'disconnected',
    );
    await expect.poll(() => f.dispatched.length).toBe(1);
    disconnected.abort();
    expect(await observed).toBe('disconnected');
    expect(physical).toBe(false);
    expect(
      data(
        await f.call('music_operation_status', {
          operationId: prepared.operationId,
        }),
      ),
    ).toMatchObject({ status: 'pending' });
    settle!();
    await expect
      .poll(
        async () =>
          data(
            await f.call('music_operation_status', {
              operationId: prepared.operationId,
            }),
          ).status,
      )
      .toBe('accepted');
    expect(
      data(
        await f.call('music_enqueue', {
          videoId,
          operationId: prepared.operationId,
        }),
      ),
    ).toMatchObject({ status: 'accepted' });
    expect(f.dispatched).toHaveLength(1);
  } finally {
    settle?.();
    await f.close();
  }
});
