import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

import { createMcpBinding } from './mcp-binding';
import { mcpHttpPolicy, McpHttpFailure } from './mcp-http-policy';
import {
  createMcpSessions,
  MCP_LIMITS,
  type McpSession,
  type McpTransaction,
} from './mcp-sessions';
import { createMcpTransport } from './mcp-transport';
import {
  musicGrantLifetimeSignal,
  type MusicGrantStore,
} from './music-grant-store';
import { nativeMusicSignalAborted as aborted } from './music-publication';
import { decodeMusicReadResult } from './music-read-result';

import type { MusicAccessOwner, MusicInvocation } from './music-access';
import type { MusicService } from './music-service';

const clock = Date.now;
const idValid = (id: unknown): id is RequestId =>
  typeof id === 'string'
    ? id.length > 0 && id.length <= 128
    : typeof id === 'number' && Number.isSafeInteger(id);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcError = (id: RequestId, code = -32603) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code,
    message:
      code === -32800
        ? 'Request cancelled.'
        : code === -32602
          ? 'Invalid parameters.'
          : code === -32601
            ? 'Method not found.'
            : 'Request failed.',
  },
});

/** Observe the vendor promise after retirement without retaining the owned request graph. */
function observeOwned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let success: ((value: T) => void) | undefined = resolve;
    let failure: ((error: unknown) => void) | undefined = reject;
    const clear = () => {
      success = undefined;
      failure = undefined;
      signal.removeEventListener('abort', retire);
    };
    const retire = () => {
      const fail = failure;
      clear();
      fail?.(new McpHttpFailure(409));
    };
    promise.then(
      (value) => {
        const done = success;
        clear();
        done?.(value);
      },
      () => {
        const fail = failure;
        clear();
        fail?.(new McpHttpFailure(500));
      },
    );
    signal.addEventListener('abort', retire, { once: true });
    if (signal.aborted) retire();
  });
}
async function readBody(request: IncomingMessage, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new McpHttpFailure(409);
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value) && typeof value !== 'string')
      throw new McpHttpFailure(400);
    const bytes = Buffer.from(value);
    length += bytes.length;
    if (length > MCP_LIMITS.body) throw new McpHttpFailure(413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, length),
      ),
    );
  } catch {
    throw new McpHttpFailure(400);
  }
}

/** Owned literal-loopback listener; imported lazily by main only when enabled. */
export function createMcpListener(options: {
  service: MusicService;
  grants: MusicGrantStore;
  port: number;
}) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error('Invalid MCP port.');
  const { service, grants } = options;
  const lifetime = new AbortController();
  let port = options.port,
    stopped = false,
    started = false,
    pending = 0,
    output = 0;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const sessions = createMcpSessions(grants, service);
  const runtimes = new WeakMap<
    McpSession,
    ReturnType<typeof createMcpTransport> & {
      tools: ReturnType<typeof createMcpBinding>['tools'];
    }
  >();
  const sockets = new Set<import('node:net').Socket>();
  const resource = () => `http://127.0.0.1:${port}/mcp`;
  const owner: MusicAccessOwner = Object.freeze({
    identity: {},
    signal: lifetime.signal,
    current: () => !stopped && server.listening && !aborted(lifetime.signal),
  });
  const reserve = (bytes: number) => {
    if (output + bytes > MCP_LIMITS.output) throw new McpHttpFailure(503);
    output += bytes;
  };
  const release = (bytes: number) => {
    output -= bytes;
  };
  function failure(response: ServerResponse, status: number) {
    if (response.destroyed || response.writableEnded) return;
    const bytes = Buffer.from('{"error":"MCP request rejected."}');
    try {
      reserve(bytes.length);
    } catch {
      response.destroy();
      return;
    }
    let released = false;
    const done = () => {
      if (!released) {
        released = true;
        release(bytes.length);
      }
    };
    response.once('finish', done);
    response.once('close', done);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', bytes.length);
    response.end(bytes);
  }
  async function stage(
    response: Response,
    row: McpTransaction | undefined,
    session: McpSession,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const cancel = () => {
      reader?.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) throw new McpHttpFailure(409);
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (length + part.value.byteLength > MCP_LIMITS.response)
            throw new McpHttpFailure(500);
          reserve(part.value.byteLength);
          length += part.value.byteLength;
          chunks.push(part.value);
        }
      if (!row) {
        if (length) throw new McpHttpFailure(500);
        return Buffer.alloc(0);
      }
      if (signal.aborted) throw new McpHttpFailure(409);
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
      } catch {
        value = undefined;
      }
      if (!record(value) || value.jsonrpc !== '2.0' || value.id !== row.id)
        value = rpcError(row.id);
      else if ('error' in value) {
        const code =
          record(value.error) &&
          typeof value.error.code === 'number' &&
          [-32700, -32600, -32601, -32602, -32603, -32800].includes(
            value.error.code,
          )
            ? value.error.code
            : -32603;
        value = rpcError(row.id, row.canceled ? -32800 : code);
      } else if (row.canceled) value = rpcError(row.id, -32800);
      else if (row.method === 'tools/call') {
        const encoded = JSON.stringify(value.result);
        const result = decodeMusicReadResult(encoded);
        if (
          !('isError' in result) &&
          (!row.witness || !row.witness.matches(encoded))
        )
          value = rpcError(row.id);
        else value = { jsonrpc: '2.0', id: row.id, result };
      } else if (!record(value.result)) value = rpcError(row.id);
      else if (row.method === 'initialize')
        value = {
          jsonrpc: '2.0',
          id: row.id,
          result: {
            protocolVersion: session.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'pear-desktop-music', version: '1' },
          },
        };
      else if (row.method === 'tools/list')
        value = {
          jsonrpc: '2.0',
          id: row.id,
          result: { tools: runtimes.get(session)?.tools ?? [] },
        };
      else if (row.method === 'ping')
        value = { jsonrpc: '2.0', id: row.id, result: {} };
      else value = rpcError(row.id);
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MCP_LIMITS.response) throw new McpHttpFailure(500);
      reserve(bytes.length);
      return bytes;
    } finally {
      signal.removeEventListener('abort', cancel);
      release(length);
      reader?.cancel().catch(() => {});
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (++pending > MCP_LIMITS.http) {
      pending--;
      failure(response, 503);
      return;
    }
    let counted = true;
    const uncount = () => {
      if (counted) {
        counted = false;
        pending--;
      }
    };
    response.once('finish', uncount);
    response.once('close', uncount);
    const disconnected = new AbortController();
    const disconnect = () => {
      if (!response.writableFinished) {
        disconnected.abort();
        row?.controller.abort();
      }
    };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    const timeout = setTimeout(() => {
      disconnected.abort();
      response.destroy();
    }, 17_000);
    timeout.unref();
    let session: McpSession | undefined,
      row: McpTransaction | undefined,
      initializedHere = false,
      staged: Buffer | undefined,
      queued = false,
      stagedReleased = false;
    const releaseStaged = () => {
      if (staged && !stagedReleased) {
        stagedReleased = true;
        const length = staged.length;
        staged = undefined;
        release(length);
      }
      response.removeListener('finish', releaseStaged);
      response.removeListener('close', releaseStaged);
    };
    try {
      if (!owner.current()) throw new McpHttpFailure(409);
      const policy = mcpHttpPolicy(request, port);
      const principal = await observeOwned(
        grants.authenticate(policy.token, 'mcp', resource()),
        disconnected.signal,
      ).catch(() => {
        throw new McpHttpFailure(401);
      });
      if (!owner.current() || !grants.isCurrentPrincipal(principal))
        throw new McpHttpFailure(401);
      if (request.method !== 'POST' && request.method !== 'DELETE')
        throw new McpHttpFailure(405);
      if (policy.session) session = sessions.find(policy.session, principal);
      if (policy.session && !session) throw new McpHttpFailure(404);
      if (session && policy.version !== session.protocolVersion)
        throw new McpHttpFailure(400);
      if (request.method === 'DELETE') {
        policy.token = '';
        if (!session) throw new McpHttpFailure(404);
        session.retire();
        response.statusCode = 200;
        response.end();
        return;
      }
      const body = await readBody(request, disconnected.signal);
      if (
        !record(body) ||
        body.jsonrpc !== '2.0' ||
        typeof body.method !== 'string' ||
        body.method.length > 128 ||
        Object.keys(body).some(
          (key) => !['jsonrpc', 'id', 'method', 'params'].includes(key),
        )
      )
        throw new McpHttpFailure(400);
      const isRequest = Object.hasOwn(body, 'id');
      if (
        isRequest
          ? !idValid(body.id) || !JSONRPCRequestSchema.safeParse(body).success
          : !JSONRPCNotificationSchema.safeParse(body).success
      )
        throw new McpHttpFailure(400);
      if (body.method === 'initialize') {
        if (
          !isRequest ||
          policy.session ||
          !record(body.params) ||
          !['2025-06-18', '2025-11-25'].includes(
            String(body.params.protocolVersion),
          )
        )
          throw new McpHttpFailure(400);
        const native = service.captureTransportOwner('mcp', resource());
        if (policy.version && policy.version !== body.params.protocolVersion)
          throw new McpHttpFailure(400);
        session = sessions.create(
          principal,
          native,
          String(body.params.protocolVersion),
        );
        if (!session) throw new McpHttpFailure(503);
        initializedHere = true;
        const runtime = createMcpTransport(session),
          binding = createMcpBinding(service, session);
        runtimes.set(session, { ...runtime, tools: binding.tools });
        session.closeSdk = () => binding.server.close();
        await binding.server.connect(runtime.facade);
      } else if (!session) throw new McpHttpFailure(404);
      if (!session || !session.current()) throw new McpHttpFailure(404);
      if (body.method === 'notifications/cancelled') {
        if (
          isRequest ||
          !record(body.params) ||
          !idValid(body.params.requestId)
        )
          throw new McpHttpFailure(400);
        const target = session.transactions.get(body.params.requestId);
        if (target?.method === 'initialize') throw new McpHttpFailure(400);
        if (target) {
          target.canceled = true;
          target.controller.abort();
        }
        response.statusCode = 202;
        response.end();
        return;
      }
      if (!isRequest && body.method !== 'notifications/initialized')
        throw new McpHttpFailure(400);
      if (body.method === 'notifications/initialized') {
        if (isRequest || session.initialized) throw new McpHttpFailure(400);
        session.initialized = true;
      } else if (body.method !== 'initialize' && !session.initialized)
        throw new McpHttpFailure(400);
      if (isRequest) {
        if (!idValid(body.id)) throw new McpHttpFailure(400);
        row = sessions.admit(session, body.id, body.method);
        if (!row) throw new McpHttpFailure(409);
        if (body.method === 'tools/call') {
          let invocation: MusicInvocation | undefined = {
            token: policy.token,
            transport: 'mcp',
            resource: resource(),
            signal: row.controller.signal,
            session,
          };
          row.takeInvocation = () => {
            const value = invocation;
            invocation = undefined;
            return value;
          };
        }
      }
      policy.token = '';
      const runtime = runtimes.get(session);
      if (!runtime) throw new McpHttpFailure(404);
      const grantSignal = musicGrantLifetimeSignal(grants, principal);
      if (!grantSignal) throw new McpHttpFailure(401);
      const delivery = AbortSignal.any([
        disconnected.signal,
        lifetime.signal,
        session.signal,
        ...(row ? [row.delivery.signal] : []),
      ]);
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(policy.session ? { 'mcp-session-id': policy.session } : {}),
        ...(policy.version ? { 'mcp-protocol-version': policy.version } : {}),
      };
      const sdkRequest = new Request(resource(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: delivery,
      });
      const sdkResponse = await observeOwned(
        runtime.http.handleRequest(sdkRequest),
        delivery,
      );
      if (isRequest && sdkResponse.status !== 200)
        throw new McpHttpFailure(400);
      if (!isRequest && sdkResponse.status !== 202)
        throw new McpHttpFailure(400);
      staged = await stage(sdkResponse, row, session, delivery);
      response.statusCode = isRequest ? 200 : 202;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', staged.length);
      if (initializedHere) response.setHeader('mcp-session-id', session.id);
      const witness = row?.witness;
      // Complete all SDK/JSON/header preparation and reentrant readiness before native flags.
      response.once('finish', releaseStaged);
      response.once('close', releaseStaged);
      queued = true;
      const ready =
        session.current() &&
        grants.isCurrentPrincipal(principal) &&
        (!witness || row?.canceled || witness.ready());
      const time = clock();
      if (
        !ready ||
        aborted(disconnected.signal) ||
        aborted(lifetime.signal) ||
        aborted(session.signal) ||
        aborted(session.nativeSignal) ||
        aborted(grantSignal) ||
        time < principal.createdAt ||
        time >= principal.expiresAt ||
        (row && time >= row.deadline) ||
        (witness && !row?.canceled && !witness.current())
      ) {
        response.destroy();
        return;
      }
      // APPLICATION BYTE HANDOFF: no user/SDK/schema callbacks between checkpoint and end.
      response.end(staged);
    } catch (error) {
      if (initializedHere) session?.retire();
      if (
        !disconnected.signal.aborted &&
        !lifetime.signal.aborted &&
        !session?.signal.aborted
      )
        failure(response, error instanceof McpHttpFailure ? error.status : 500);
      else response.destroy();
    } finally {
      if (!queued) releaseStaged();
      clearTimeout(timeout);
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
      if (row && session) sessions.finish(session, row);
      if (response.destroyed) uncount();
    }
  }
  const server = createServer(
    {
      maxHeaderSize: MCP_LIMITS.headers,
      requestTimeout: 17_000,
      headersTimeout: 17_000,
    },
    (request, response) => {
      handle(request, response).catch(() => response.destroy());
    },
  );
  server.on('connection', (socket) => {
    if (stopped || sockets.size >= MCP_LIMITS.http) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('checkContinue', (_request, response) => failure(response, 417));
  server.on('checkExpectation', (_request, response) => failure(response, 417));
  server.on('error', () => {
    lifetime.abort();
    sessions.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  });
  const closeServer = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    owner,
    grants,
    transport: 'mcp' as const,
    get resource() {
      return resource();
    },
    captureNativeOwner: () => service.captureTransportOwner('mcp', resource()),
    async start() {
      if (started || stopped) throw new Error('MCP listener already started.');
      started = true;
      starting = new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('MCP listener unavailable.'));
            return;
          }
          port = address.port;
          // A retired generation may finish binding after stop's first check.
          // Startup settles only after that late bind has been drained.
          if (stopped) closeServer().then(resolve, reject);
          else resolve();
        });
      });
      await starting;
    },
    stop() {
      if (stopping) return stopping;
      let resolveStop!: () => void;
      let rejectStop!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      stopping = completion;
      stopped = true;
      // Publish the shared completion before synchronous retirement callbacks.
      (async () => {
        try {
          lifetime.abort();
          sessions.close();
        } finally {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await starting?.catch(() => {});
          await closeServer();
        }
      })().then(resolveStop, rejectStop);
      return completion;
    },
  };
}
export type McpListener = ReturnType<typeof createMcpListener>;
