import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPosthogFactoryForTest,
  buildMcpToolCallProperties,
  captureMcpToolCall,
  distinctIdFor,
  posthogClient,
  posthogEnabled,
  redactEventProperties,
  sessionIdFor,
  shutdownPosthog,
  type McpToolCallAnalytics,
  type PostHogLike
} from "./posthog";

// A recording fake so we can assert what would go on the wire without a
// network round-trip.
function fakeClient(overrides: Partial<PostHogLike> = {}) {
  const captured: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = [];
  let shutdownCalls = 0;
  let flushCalls = 0;
  const client: PostHogLike & { captured: typeof captured; shutdownCalls: () => number; flushCalls: () => number } = {
    captured,
    shutdownCalls: () => shutdownCalls,
    flushCalls: () => flushCalls,
    capture: (payload) => { captured.push(payload); },
    flush: async () => { flushCalls += 1; },
    shutdown: () => { shutdownCalls += 1; },
    ...overrides
  };
  return client;
}

const SAMPLE: McpToolCallAnalytics = {
  instance: "dev",
  serverName: "linear",
  transport: "http",
  toolName: "search_issues",
  ok: true,
  durationMs: 42,
  parameterCount: 2,
  responseBytes: 128,
  taskId: "task_abc"
};

let savedKey: string | undefined;
let savedHost: string | undefined;

beforeEach(() => {
  savedKey = process.env.POSTHOG_PROJECT_API_KEY;
  savedHost = process.env.POSTHOG_HOST;
  delete process.env.POSTHOG_PROJECT_API_KEY;
  delete process.env.POSTHOG_HOST;
  __setPosthogFactoryForTest(null); // reset singleton to the real factory
});

afterEach(async () => {
  await shutdownPosthog(0); // tear down any real client + clear its flush timer
  __setPosthogFactoryForTest(null);
  if (savedKey === undefined) delete process.env.POSTHOG_PROJECT_API_KEY;
  else process.env.POSTHOG_PROJECT_API_KEY = savedKey;
  if (savedHost === undefined) delete process.env.POSTHOG_HOST;
  else process.env.POSTHOG_HOST = savedHost;
});

describe("sessionIdFor / distinctIdFor", () => {
  test("derives a deterministic ses_<32hex> from the task id", () => {
    const a = sessionIdFor("task_abc", "dev");
    const b = sessionIdFor("task_abc", "dev");
    expect(a).toBe(b);
    expect(a).toMatch(/^ses_[0-9a-f]{32}$/);
    // Different instance ⇒ different session (namespaced).
    expect(sessionIdFor("task_abc", "other")).not.toBe(a);
  });

  test("returns undefined without a task id", () => {
    expect(sessionIdFor(undefined, "dev")).toBeUndefined();
  });

  test("hashes the instance slug into a stable distinct id", () => {
    const id = distinctIdFor("dev");
    expect(id).toBe(distinctIdFor("dev"));
    expect(id).toMatch(/^gini_[0-9a-f]{16}$/);
    expect(id).not.toContain("dev");
  });
});

describe("buildMcpToolCallProperties (masking by construction)", () => {
  test("emits only safe metadata; never the arguments or the response", () => {
    const props = buildMcpToolCallProperties(SAMPLE);
    expect(props.$mcp_source).toBe("posthog_mcp_analytics");
    expect(props.$mcp_tool_name).toBe("search_issues");
    expect(props.$mcp_resource_name).toBe("search_issues");
    expect(props.$mcp_server_name).toBe("linear");
    expect(props.$mcp_transport).toBe("http");
    expect(props.$mcp_duration_ms).toBe(42);
    expect(props.$mcp_is_error).toBe(false);
    expect(props.$mcp_parameter_count).toBe(2);
    expect(props.$mcp_response_bytes).toBe(128);
    expect(props.$process_person_profile).toBe(false);
    expect(props.gini_masked).toBe(true);
    // The two chat-derived fields PostHog's own SDK would send must be absent.
    expect(props).not.toHaveProperty("$mcp_parameters");
    expect(props).not.toHaveProperty("$mcp_response");
  });

  test("adds a session + conversation id when a task id is present", () => {
    const props = buildMcpToolCallProperties(SAMPLE);
    expect(props.$session_id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(props.$mcp_conversation_id).toBe(props.$session_id);
  });

  test("omits session/conversation ids for a task-less (manual) invocation", () => {
    const props = buildMcpToolCallProperties({ ...SAMPLE, taskId: undefined });
    expect(props).not.toHaveProperty("$session_id");
    expect(props).not.toHaveProperty("$mcp_conversation_id");
  });

  test("maps a failed call to $mcp_is_error true", () => {
    const props = buildMcpToolCallProperties({ ...SAMPLE, ok: false });
    expect(props.$mcp_is_error).toBe(true);
  });
});

describe("redactEventProperties (safety-net denylist)", () => {
  test("strips forbidden payload + person keys and credential-looking keys", () => {
    const out = redactEventProperties({
      $mcp_tool_name: "search",
      $mcp_parameters: { query: "secret chat text" },
      $mcp_response: { body: "secret result" },
      $set: { email: "x@y.z" },
      authorization: "Bearer abc",
      api_key: "phc_leak",
      password: "hunter2",
      gini_masked: true
    });
    expect(out).toEqual({ $mcp_tool_name: "search", gini_masked: true });
    expect(out).not.toHaveProperty("$mcp_parameters");
    expect(out).not.toHaveProperty("$mcp_response");
    expect(out).not.toHaveProperty("$set");
    expect(out).not.toHaveProperty("authorization");
    expect(out).not.toHaveProperty("api_key");
    expect(out).not.toHaveProperty("password");
  });
});

describe("posthogClient / posthogEnabled (env gating)", () => {
  test("is disabled (null) when POSTHOG_PROJECT_API_KEY is unset", () => {
    expect(posthogClient()).toBeNull();
    expect(posthogEnabled()).toBe(false);
  });

  test("constructs a client with the default host when the key is set", () => {
    let seenHost = "";
    __setPosthogFactoryForTest((_key, host) => { seenHost = host; return fakeClient(); });
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    expect(posthogEnabled()).toBe(true);
    // Memoized: a second call returns the same instance without re-constructing.
    expect(posthogClient()).toBe(posthogClient());
    expect(seenHost).toBe("https://us.i.posthog.com");
  });

  test("treats an empty POSTHOG_HOST as unset (falls back to default)", () => {
    let seenHost = "";
    __setPosthogFactoryForTest((_key, host) => { seenHost = host; return fakeClient(); });
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    process.env.POSTHOG_HOST = "";
    posthogClient();
    expect(seenHost).toBe("https://us.i.posthog.com");
  });

  test("honors a custom POSTHOG_HOST and builds the real posthog-node client", () => {
    // Uses the REAL default factory (no injection) so `new PostHog(...)` is
    // exercised. A discard host keeps any stray flush off the network; the
    // afterEach shutdown clears the client's flush timer.
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    process.env.POSTHOG_HOST = "http://127.0.0.1:9";
    const client = posthogClient();
    expect(client).not.toBeNull();
  });
});

describe("captureMcpToolCall", () => {
  test("no-ops when analytics is disabled", () => {
    // No key set ⇒ client is null ⇒ nothing thrown, nothing sent.
    expect(() => captureMcpToolCall(SAMPLE)).not.toThrow();
  });

  test("captures a masked $mcp_tool_call when enabled", () => {
    const client = fakeClient();
    __setPosthogFactoryForTest(() => client);
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    captureMcpToolCall(SAMPLE);
    expect(client.captured).toHaveLength(1);
    const [event] = client.captured;
    expect(event.event).toBe("$mcp_tool_call");
    expect(event.distinctId).toBe(distinctIdFor("dev"));
    expect(event.properties.$mcp_tool_name).toBe("search_issues");
    expect(event.properties).not.toHaveProperty("$mcp_parameters");
    expect(event.properties).not.toHaveProperty("$mcp_response");
  });

  test("swallows a capture failure so telemetry never breaks a tool call", () => {
    const client = fakeClient({ capture: () => { throw new Error("boom"); } });
    __setPosthogFactoryForTest(() => client);
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    expect(() => captureMcpToolCall(SAMPLE)).not.toThrow();
  });
});

describe("shutdownPosthog", () => {
  test("is a no-op when no client was ever created", async () => {
    await expect(shutdownPosthog()).resolves.toBeUndefined();
  });

  test("flushes then shuts down the active client", async () => {
    const client = fakeClient();
    __setPosthogFactoryForTest(() => client);
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    posthogClient(); // materialize the singleton
    await shutdownPosthog();
    expect(client.flushCalls()).toBe(1);
    expect(client.shutdownCalls()).toBe(1);
    // Singleton is cleared: a subsequent shutdown is a no-op.
    await shutdownPosthog();
    expect(client.flushCalls()).toBe(1);
  });

  test("bails out via the timeout when flush hangs", async () => {
    const client = fakeClient({ flush: () => new Promise<void>(() => {}) });
    __setPosthogFactoryForTest(() => client);
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    posthogClient();
    // timeoutMs 0 ⇒ the Bun.sleep arm wins the race; shutdown() still runs.
    await shutdownPosthog(0);
    expect(client.shutdownCalls()).toBe(1);
  });

  test("swallows a flush rejection during shutdown", async () => {
    const client = fakeClient({ flush: async () => { throw new Error("flush failed"); } });
    __setPosthogFactoryForTest(() => client);
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test";
    posthogClient();
    await expect(shutdownPosthog()).resolves.toBeUndefined();
  });
});
