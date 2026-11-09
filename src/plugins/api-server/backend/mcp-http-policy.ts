import { MCP_LIMITS } from './mcp-sessions';
import { parseMusicBearer } from './music-grants';

import type { IncomingMessage } from 'node:http';

export class McpHttpFailure extends Error {
  constructor(readonly status: number) {
    super('MCP request rejected.');
  }
}
export function mcpHttpPolicy(request: IncomingMessage, port: number) {
  if (request.url !== '/mcp') throw new McpHttpFailure(404);
  if (
    request.socket.localAddress !== '127.0.0.1' ||
    request.socket.localPort !== port ||
    !request.socket.remoteAddress?.startsWith('127.')
  )
    throw new McpHttpFailure(403);
  const entries = new Map<string, string>();
  let bytes = 0;
  if (request.rawHeaders.length % 2) throw new McpHttpFailure(400);
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i].toLowerCase(),
      value = request.rawHeaders[i + 1];
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 4;
    if (bytes > MCP_LIMITS.headers || entries.has(key))
      throw new McpHttpFailure(400);
    if (
      key === 'origin' ||
      key === 'forwarded' ||
      key.startsWith('x-forwarded-')
    )
      throw new McpHttpFailure(403);
    entries.set(key, value);
  }
  if (entries.get('host') !== `127.0.0.1:${port}`)
    throw new McpHttpFailure(403);
  const token = parseMusicBearer(entries.get('authorization'));
  if (!token) throw new McpHttpFailure(401);
  const session = entries.get('mcp-session-id');
  if (session !== undefined && !/^[A-Za-z0-9-]{1,128}$/.test(session))
    throw new McpHttpFailure(404);
  const version = entries.get('mcp-protocol-version');
  if (version !== undefined && !['2025-06-18', '2025-11-25'].includes(version))
    throw new McpHttpFailure(400);
  if (entries.has('content-encoding')) throw new McpHttpFailure(400);
  const length = entries.get('content-length');
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > MCP_LIMITS.body)
  )
    throw new McpHttpFailure(413);
  if (request.method === 'POST') {
    if (
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        entries.get('content-type') ?? '',
      )
    )
      throw new McpHttpFailure(415);
    const accept = (entries.get('accept') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase());
    if (
      !accept.includes('application/json') ||
      !accept.includes('text/event-stream')
    )
      throw new McpHttpFailure(406);
  }
  return { token, session, version };
}
