# Local MCP music access

MCP music access is off by default. Enable the API Server plugin, then **MCP music access → Enable MCP music access**. The main process owns a separate HTTP listener at `http://127.0.0.1:26539/mcp` (`mcpPort` changes the port). Expanded REST music access can remain off. Both transports use the same music service, renderer controller, caches, and physical request broker.

Use **MCP music access → Create client grant…** to choose the read permissions and explicitly copy the credential. Credentials last 24 hours and can be revoked from the same native menu. The credential stays in the main process and clipboard; it is never shown in a dialog renderer or stored in settings. REST credentials and MCP credentials have separate transport and exact-URL audiences.

A manual-header SDK client can connect as follows. Supply the token from your own secret input; do not put it in a URL or commit it to a configuration file.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:26539/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
);
const client = new Client({ name: 'local-music-client', version: '1' });
await client.connect(transport);
const tools = await client.listTools();
const current = await client.callTool({ name: 'music_now_playing', arguments: {} });
await transport.terminateSession();
await client.close();
```

The nine read tools are `music_now_playing`, `music_get_queue`, `music_search`, `music_browse`, `music_home`, `music_get_library_playlists`, `music_lyrics`, `music_related`, and `music_comments`. `tools/list` returns only tools covered by the authenticated grant. The five read permissions are `playback.read`, `catalog.read`, `personalized.read`, `library.read`, and `comments.read`. A grant with no permissions can initialize and list an empty set. Initialization, listing, and ping do not access the music source.

Arguments have strict object schemas. Cursor, selector, limit, nested target, and explicit public-WEB comment fallback rules match the expanded music service. Calls return a fixed text summary with useful data in `structuredContent`, or a fixed bounded error. The sixteen mutation tools and `music_operation_status` use the receipt workflow below. Read-only grants omit them. The native editor also offers explicit `playback.control` and `queue.write` grants, with no permissions selected by default.

Playback control tools are `music_previous`, `music_next`, `music_play`, `music_pause`, `music_toggle_playback`, `music_toggle_shuffle`, `music_switch_repeat`, `music_seek`, and `music_set_volume`. Selection tools are `music_play_video`, `music_play_playlist`, and `music_start_radio`. These require `playback.control`. Queue tools are `music_enqueue`, `music_enqueue_playlist`, `music_remove_from_queue`, and `music_clear_queue`; they require `queue.write`.

Each mutation is two-phase using the same tool and the existing shared service ledger:

1. Omit `operationId` to prepare. The result is a `pending` receipt containing a server-issued operation ID. Preparation makes no native request or playback/queue effect.
2. Repeat the same action arguments with that `operationId` to dispatch. A matching completed ID returns its existing receipt; conflicting arguments fail. Unknown or expired IDs never create a replacement operation or retry an effect.
3. Use `music_operation_status` with the ID after a lost response or uncertain outcome. Status requires the original action permission and exact credential/resource/session. A second session, even using the same credential, cannot use that receipt.

```ts
const argumentsForVolume = { volume: 35 };
const prepared = await client.callTool({
  name: 'music_set_volume', arguments: argumentsForVolume,
});
if (prepared.isError) throw new Error('Preparation failed');
const operationId = prepared.structuredContent!.operationId;
const dispatched = await client.callTool({
  name: 'music_set_volume',
  arguments: { ...argumentsForVolume, operationId },
});
const receipt = await client.callTool({
  name: 'music_operation_status', arguments: { operationId },
});
```

`accepted` means owned dispatch or an owned queue no-op; it does not prove audible playback. `uncertain` preserves an unknown outcome and must not trigger a fresh mutation. Dispatch receipts remain governed by the shared broker's physical settlement rules even when the requesting client cancels. Unexecuted receipts expire after two minutes; cancellation does not create a retry or replacement ID.

Seek requires a current snapshot's `playbackEpoch` plus finite nonnegative `seconds`; volume is 0–100 and repeat iterations are 1 or 2. Radio uses an explicit `seed` with kind `video`, `playlist`, or `current`. Queue removal requires `queueRevision`, `index`, and `expectedVideoId`; clear requires `queueRevision`. Obtain those guards from `music_get_queue` with `playback.read`. Song/playlist enqueue uses the shared insertion lane, with optional `insertPosition` (`INSERT_AT_END` by default or `INSERT_AFTER_CURRENT_VIDEO`). Advertised strict schemas provide the remaining fields and defaults. No caller-supplied token, action, transport, resource, or session field belongs in tool arguments.

Only literal loopback HTTP and `/mcp` are accepted. Every POST and DELETE requires the bearer, exact Host, and its owned session. Non-initialization requests require the negotiated `MCP-Protocol-Version` (`2025-11-25` or `2025-06-18`). POST accepts one JSON-RPC object, requires both JSON and event-stream Accept types, and returns JSON. Browser Origin, forwarded authority, batches, GET/SSE/resumption, OAuth, and remote access are outside this profile.

Sessions are limited to 16 globally and four per grant, with 15-minute idle and one-hour absolute lifetimes. Active request IDs are limited to four per session, eight per grant, and 32 globally. Numeric and string IDs are distinct, including numeric zero. The most recent 128 completed IDs remain unavailable for up to two minutes; older completed labels are evicted without limiting the number of requests a live session can complete. Clients should use fresh IDs rather than reuse completed labels. This bounds routing tombstones independently of the SDK's patched JSON cleanup. HTTP connections/transactions are capped at 64; headers at 16 KiB, input at 64 KiB, logical tool results at 256 KiB, and staged or queued output at 4 MiB globally. Responses are rejected rather than truncated.

Authenticated cancellation affects only its matching active request, including numeric zero. The cancellation notification receives empty HTTP 202. Its original request completes through normal SDK JSON send with fixed error `-32800`; this is a deliberate exception to the protocol's SHOULD-not-respond cancellation guidance, allowing the original JSON POST and HTTP resources to finish while other requests stay live. Client-local cancellation alone is not proof of HTTP completion. Source physical slots remain governed by the shared broker's settlement/tombstone rules.

The final writer checks original service, grant epoch, source, request, session, listener, frame admission, and time lifetimes after SDK awaits and sanitization. A retired success is not delivered. Reconfiguration, listener loss, native frame retirement, committed revoke, DELETE, and shutdown retire owned sessions.

The signed R9 foundation plus this uncommitted W17 source candidate exposes all 26 approved names through the public SDK, with isolated SDK/loopback fixtures. Native application acceptance, dependency notices and packaging, platform/manual clients and independent exact-source review remain open. Registration and fixture results do not establish full-feature production acceptance.

The original MCP tool names and feature semantics credit upstream #4633 (@hwangseonu); the comments integration credits #4744 (@SurajBhari). The scoped transport and shared-service adaptation retain those contributions.

The SDK is pinned to 1.32.0 to address the five published October 2026 advisories. GHSA-46jr-4wx8-v453 requires opt-in validation limits in addition to upgrading: the configured server admits at most 64 tool-argument object members/array elements, and the vendor HTTP reader shares the owned listener's 64 KiB body ceiling. All 26 strict argument grammars have a maximum of four elements. OAuth, experimental tasks and SDK bearer middleware remain outside this profile; authentication continues to bind owned grants to the exact local resource.
