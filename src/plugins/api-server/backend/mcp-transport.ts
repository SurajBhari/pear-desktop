import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { MCP_LIMITS, type McpSession } from './mcp-sessions';

import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';

/** Only public Transport methods. Cancellation is consumed by the authenticated owner. */
export function createMcpTransport(session: McpSession) {
  const http = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => session.id,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_LIMITS.body,
  });
  const facade: Transport = {
    sessionId: session.id,
    start: () => http.start(),
    close: () => http.close(),
    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      if (!session.current()) return;
      if (
        'id' in message &&
        message.id !== undefined &&
        !('method' in message)
      ) {
        const row = session.transactions.get(message.id);
        if (!row || row.delivery.signal.aborted) return;
        if (row.canceled)
          message = {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32800, message: 'Request cancelled.' },
          };
      }
      await http.send(message, options);
    },
  };
  http.onmessage = <T extends JSONRPCMessage>(
    message: T,
    _extra?: MessageExtraInfo,
  ) => {
    // The bearer, raw HTTP headers, authInfo and requestInfo never enter the SDK protocol.
    facade.onmessage?.(message);
  };
  http.onclose = () => facade.onclose?.();
  http.onerror = () => {
    /* Raw SDK diagnostics are neither logged nor published. */
  };
  return { http, facade };
}
