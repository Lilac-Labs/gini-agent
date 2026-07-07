import { PostHog } from "posthog-node";
import { createHash } from "node:crypto";

// PostHog MCP analytics for Gini's OUTBOUND MCP tool invocations.
//
// Gini is an MCP host/client: it calls tools ON external MCP servers via
// `invokeMcpTool`, and exposes no MCP server of its own. PostHog's
// `@posthog/mcp` `instrument(server, posthog)` patches an MCP *server's*
// request handlers, so it has nothing to wrap here. Instead we emit the same
// `$mcp_*` wire schema (https://posthog.com/docs/mcp-analytics/events) directly
// through `posthog-node`, so the calls still land in PostHog's MCP Analytics
// views. See ADR posthog-mcp-analytics.md.
//
// CHAT-MASKING INVARIANT: Gini's tool arguments and tool results are derived
// from user chat and MUST NEVER leave the process. PostHog's own SDK would send
// `$mcp_parameters` (the arguments) and `$mcp_response` (the result); this
// module sends NEITHER. It emits only safe metadata — tool name, server name,
// transport, latency, error flag — plus two coarse numbers (a top-level
// argument COUNT and a response BYTE length) that carry no content. Those
// numbers are computed by the caller, so this module never even receives the
// chat-derived payloads. `redactEventProperties` is a defense-in-depth denylist
// that strips any forbidden/sensitive key a future edit might introduce.

const SOURCE = "posthog_mcp_analytics";
const DEFAULT_HOST = "https://us.i.posthog.com";

// The two fields PostHog's MCP SDK sends that would carry chat-derived content.
// We never build them; this set makes `redactEventProperties` strip them if a
// future edit ever adds one. `$set`/`$set_once` would write person properties,
// which we also never want from an anonymous MCP event.
const FORBIDDEN_KEYS = new Set(["$mcp_parameters", "$mcp_response", "$set", "$set_once"]);

// Belt-and-suspenders: any property key that looks like a credential field is
// dropped, matching the sensitive-key family PostHog's own sanitizer redacts.
const SENSITIVE_KEY_PATTERN = /authorization|cookie|password|token|secret|api[_-]?key|private[_-]?key/i;

// A tool invocation reduced to only what is safe to send. No arguments, no
// results — the caller has already reduced those to `parameterCount` /
// `responseBytes` before constructing this.
export interface McpToolCallAnalytics {
  instance: string;
  serverName: string;
  transport: "http" | "stdio";
  toolName: string;
  ok: boolean;
  durationMs: number;
  // Number of top-level tool arguments. NEVER the keys or values.
  parameterCount: number;
  // Byte length of the tool result. NEVER the content.
  responseBytes: number;
  // Opaque task id; used only to derive a session id, never sent verbatim.
  taskId?: string;
}

// Minimal surface of the posthog-node client this module uses. Lets tests
// inject a fake without a network round-trip.
export interface PostHogLike {
  capture(payload: { distinctId: string; event: string; properties: Record<string, unknown>; disableGeoip?: boolean }): void;
  flush(): Promise<void>;
  shutdown(shutdownTimeoutMs?: number): void;
}

type ClientFactory = (apiKey: string, host: string) => PostHogLike;

const defaultFactory: ClientFactory = (apiKey, host) =>
  // Batch in the background; a telemetry flush must never block a tool call.
  // GeoIP is dropped — the operator's IP is not analytics.
  new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10_000, disableGeoip: true });

let factory: ClientFactory = defaultFactory;
let client: PostHogLike | null = null;
let resolved = false;

function host(): string {
  const h = process.env.POSTHOG_HOST?.trim();
  return h && h.length > 0 ? h : DEFAULT_HOST;
}

// Lazy singleton. Disabled (null) unless POSTHOG_PROJECT_API_KEY is set, the
// same env-gated no-op the APNs dispatcher uses (src/server.ts).
export function posthogClient(): PostHogLike | null {
  if (resolved) return client;
  resolved = true;
  const key = process.env.POSTHOG_PROJECT_API_KEY?.trim();
  client = key ? factory(key, host()) : null;
  return client;
}

export function posthogEnabled(): boolean {
  return posthogClient() !== null;
}

// Deterministic `ses_<32hex>` derived from the opaque task id, so every tool
// call in a task stitches into one MCP session without sending the task id.
export function sessionIdFor(taskId: string | undefined, instance: string): string | undefined {
  if (!taskId) return undefined;
  const hex = createHash("sha256").update(`${instance}:${taskId}`).digest("hex").slice(0, 32);
  return `ses_${hex}`;
}

// Stable anonymous distinct id, hashed so the operator-chosen instance slug
// never leaves. Paired with `$process_person_profile: false` so it never mints
// a PostHog person profile.
export function distinctIdFor(instance: string): string {
  return `gini_${createHash("sha256").update(instance).digest("hex").slice(0, 16)}`;
}

// Build the MASKED `$mcp_tool_call` properties. Allowlist by construction: only
// the safe fields below are ever present. Pure; exported for tests.
export function buildMcpToolCallProperties(a: McpToolCallAnalytics): Record<string, unknown> {
  const props: Record<string, unknown> = {
    $mcp_source: SOURCE,
    $mcp_tool_name: a.toolName,
    $mcp_resource_name: a.toolName,
    $mcp_server_name: a.serverName,
    $mcp_transport: a.transport,
    $mcp_duration_ms: a.durationMs,
    $mcp_is_error: !a.ok,
    $mcp_parameter_count: a.parameterCount,
    $mcp_response_bytes: a.responseBytes,
    $process_person_profile: false,
    gini_masked: true
  };
  const session = sessionIdFor(a.taskId, a.instance);
  if (session) {
    props.$session_id = session;
    props.$mcp_conversation_id = session;
  }
  return redactEventProperties(props);
}

// Defense-in-depth: drop any forbidden or credential-looking key. The builder
// above never adds one, so on the current path this returns the input intact —
// it exists so masking cannot silently regress.
export function redactEventProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// Capture one masked `$mcp_tool_call`. Never throws — a telemetry failure must
// never surface to the agent or interrupt a tool call.
export function captureMcpToolCall(a: McpToolCallAnalytics): void {
  const ph = posthogClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: distinctIdFor(a.instance),
      event: "$mcp_tool_call",
      properties: buildMcpToolCallProperties(a),
      disableGeoip: true
    });
  } catch {
    // swallow — best-effort telemetry
  }
}

// Drain then tear down on shutdown so trailing events aren't dropped. Safe when
// disabled. `flush()` is the awaitable drain; `shutdown()` stops the background
// flush timer. Bounded so a wedged flush can't stall the runtime drain.
export async function shutdownPosthog(timeoutMs = 2000): Promise<void> {
  if (!client) return;
  const active = client;
  client = null;
  resolved = false;
  try {
    await Promise.race([active.flush(), Bun.sleep(timeoutMs)]);
    active.shutdown();
  } catch {
    // swallow — shutdown must continue
  }
}

// Test seam: swap the client factory and reset the singleton. Passing null
// restores the real posthog-node factory.
export function __setPosthogFactoryForTest(next: ClientFactory | null): void {
  factory = next ?? defaultFactory;
  client = null;
  resolved = false;
}
