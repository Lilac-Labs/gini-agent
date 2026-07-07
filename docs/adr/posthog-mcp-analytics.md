# ADR: PostHog MCP Analytics with Chat Masking

- **Status:** Accepted
- **Date:** 2026-07-07
- **See also:** [Connector Secret Storage](./connector-secret-storage.md), [Comprehensive Token Usage Accounting](./usage-accounting.md)

## Decision

Gini emits a masked PostHog `$mcp_tool_call` event for every outbound MCP tool
invocation, sending **only** safe metadata — never the tool arguments or the
tool result, which are chat-derived.

- A single chokepoint, `invokeMcpTool` in
  `packages/runtime/src/integrations/mcp.ts`, times each tool call and hands a
  reduced `McpToolCallAnalytics` shape to `captureMcpToolCall`. The chat-derived
  `input` and `result.stdout` are reduced **at the call site** to a top-level
  argument *count* and a response *byte length* before crossing into the
  analytics module, so no chat content ever reaches
  `packages/runtime/src/integrations/posthog.ts`.
- The event uses PostHog's published `$mcp_*` wire schema
  (`$mcp_source: "posthog_mcp_analytics"`, `$mcp_tool_name`,
  `$mcp_server_name`, `$mcp_transport`, `$mcp_duration_ms`, `$mcp_is_error`,
  `$mcp_parameter_count`, `$mcp_response_bytes`, a `$session_id`/
  `$mcp_conversation_id` derived by SHA-256 from the opaque task id) so the data
  lands in PostHog's MCP Analytics views. `$mcp_parameters` and `$mcp_response`
  (the two fields PostHog's own SDK would send) are deliberately never built.
- Analytics is **env-gated and off by default**: the `posthog-node` client is
  constructed lazily only when `POSTHOG_PROJECT_API_KEY` is set
  (`POSTHOG_HOST` overrides the default `https://us.i.posthog.com`), the same
  no-op-without-env idiom the APNs dispatcher uses. The project (`phc_…`) key is
  read from the environment, never hardcoded.
- Events are anonymous: the distinct id is a hash of the instance slug and every
  event carries `$process_person_profile: false`, so no PostHog person profile
  is minted. `disableGeoip: true` drops IP-based geolocation.
- `shutdownPosthog()` joins the runtime's SIGTERM drain in `server.ts` so
  buffered events flush before exit; `redactEventProperties` is a defense-in-depth
  denylist that strips `$mcp_parameters`/`$mcp_response`/`$set` and any
  credential-looking key if a future edit ever adds one.

## Context

The request was to run `@posthog/wizard mcp-analytics`. Two facts make the
wizard's default path a non-fit here:

- **The wizard can't run headless.** It is an Ink TUI that requires raw-mode
  stdin; in a non-interactive shell it aborts with "Raw mode is not supported",
  and it OAuth-gates before doing any work.
- **Gini exposes no MCP server to wrap.** PostHog's `@posthog/mcp`
  `instrument(server, posthog)` patches an MCP **server's** request handlers.
  Gini is an MCP *host/client*: it calls tools *on* external MCP servers
  (`invokeMcpTool` over HTTP/stdio via `/api/mcp`) and serves no MCP endpoint of
  its own, so there is no `Server` object to instrument.

Gini is a chat agent, so an MCP tool call's arguments and results are derived
from user conversation. PostHog's MCP SDK would send those as `$mcp_parameters`
and `$mcp_response` (its automatic sanitizer only redacts secret-shaped keys and
binary blobs, not free-form chat text). That is the leak this design closes.

## Consequences

- **Chat content cannot leak by construction.** The analytics module never
  receives arguments or results — only counts and metadata — so there is no code
  path that could serialize chat text into an event. The denylist is a second
  layer, not the primary guarantee.
- **The MCP Analytics dashboard still works.** Per-tool and per-server call
  volume, latency (`$mcp_duration_ms`), and error rate (`$mcp_is_error`) all
  populate from the safe metadata; only the payload drill-down is intentionally
  empty.
- **Client-side, not server-side, semantics.** Because Gini is the caller, an
  event means "Gini invoked tool X on server Y", not "someone invoked Gini's
  tool X". If Gini ever exposes its own MCP server, that surface can adopt
  `@posthog/mcp`'s `instrument()` directly alongside this client-side path.
- **Best-effort and non-blocking.** `captureMcpToolCall` never throws and never
  awaits the network on the tool-call path; a telemetry failure is swallowed so
  it can never surface to the agent or delay a tool result.
- **Not covered (intentional):** web/product analytics via `posthog-js` in the
  Next.js app is out of scope here; if added later it needs its own session-replay
  and autocapture masking for the chat UI.

## Acceptance checks

- With `POSTHOG_PROJECT_API_KEY` unset, `invokeMcpTool` behaves exactly as
  before and emits nothing.
- An end-to-end test drives `invokeMcpTool` against a mock MCP server that
  returns secret content and a mock PostHog host; the tool receives the real
  secret argument/response, but the captured `$mcp_tool_call` contains only safe
  metadata and neither secret string appears anywhere on the wire.
- `buildMcpToolCallProperties` never contains `$mcp_parameters` or
  `$mcp_response`; `redactEventProperties` strips them (and credential-looking
  keys) if present.
- `posthog.ts` holds 100% line and function coverage.
- `bun run typecheck` and `bun run test` stay green.
