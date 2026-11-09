import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { MCP_LIMITS, type McpSession } from './mcp-sessions';
import { mcpPublicSchema, mcpRegistrationSchema } from './mcp-tool-schemas';
import { createMcpToolRegistry } from './mcp-tools';

import type { MusicService } from './music-service';

export function createMcpBinding(service: MusicService, session: McpSession) {
  const server = new McpServer(
    { name: 'pear-desktop-music', version: '1' },
    {
      capabilities: { tools: {} },
      // GHSA-46jr-4wx8-v453: the vendor guard is opt-in, even after upgrading.
      maxToolInputElements: MCP_LIMITS.toolInputElements,
    },
  );
  const registry = createMcpToolRegistry(service);
  const descriptors = registry.list(session.principal.scopes);
  for (const tool of descriptors) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: mcpRegistrationSchema(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args, extra) => {
        const row = session.transactions.get(extra.requestId);
        const invocation = row?.takeInvocation?.();
        if (row) row.takeInvocation = undefined;
        if (!row || !invocation || !session.current())
          throw new McpError(ErrorCode.InvalidRequest, 'Invalid request.');
        return registry.callOwned(
          tool.name,
          args,
          {
            ...invocation,
            signal: AbortSignal.any([invocation.signal, extra.signal]),
          },
          {
            capture(witness) {
              if (row.witness || row.controller.signal.aborted) return false;
              row.witness = witness;
              return true;
            },
          },
        );
      },
    );
  }
  // Public list contract keeps the strict source grammar rather than SDK's empty union projection.
  const tools = descriptors.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: mcpPublicSchema(tool.inputSchema),
    annotations: { ...tool.annotations },
  }));
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  return { server, tools };
}
