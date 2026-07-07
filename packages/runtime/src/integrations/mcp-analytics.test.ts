import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mutateState } from "../state";
import type { McpServerRecord, RuntimeConfig } from "../types";
import { invokeMcpTool } from "./mcp";
import { __setPosthogFactoryForTest, shutdownPosthog } from "./posthog";

// End-to-end masking proof: drive the real `invokeMcpTool` against a mock MCP
// server that returns chat-derived secret content, capture into a mock PostHog
// host, and assert the wire payload carries only safe metadata — never the tool
// arguments or the response body.

const ROOT = "/tmp/gini-mcp-analytics-unit";

// Distinctive strings that stand in for chat-derived content. They must NOT
// appear in anything sent to PostHog.
const SECRET_QUERY = "SECRET_CHAT_QUERY_9f3a1c";
const SECRET_RESPONSE = "SECRET_TOOL_RESULT_b72e40";

let mcpServer: ReturnType<typeof Bun.serve>;
let posthogServer: ReturnType<typeof Bun.serve>;
let mcpUrl = "";
const posthogBodies: string[] = [];
let savedKey: string | undefined;
let savedHost: string | undefined;

function decodeBody(bytes: Uint8Array): string {
  // posthog-node may gzip the batch payload; sniff the gzip magic bytes.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Buffer.from(gunzipSync(bytes)).toString("utf8");
  }
  return Buffer.from(bytes).toString("utf8");
}

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo" as const, model: "echo" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

function configuredServer(instance: string, url: string): McpServerRecord {
  return {
    id: "mcp_search",
    instance,
    name: "linear",
    command: "",
    args: [],
    envKeys: [],
    status: "configured",
    exposedTools: [],
    createdAt: "",
    updatedAt: "",
    transport: "http",
    url,
    headers: undefined
  };
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  savedKey = process.env.POSTHOG_PROJECT_API_KEY;
  savedHost = process.env.POSTHOG_HOST;

  // Mock MCP server: answers tools/call with a result carrying the secret.
  mcpServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id?: number; method?: string };
      return Response.json({
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: { content: [{ type: "text", text: SECRET_RESPONSE }], isError: false }
      });
    }
  });
  mcpUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;

  // Mock PostHog host: records every request body (gzip-aware).
  posthogServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 0) posthogBodies.push(decodeBody(bytes));
      return Response.json({ status: 1 });
    }
  });

  process.env.POSTHOG_PROJECT_API_KEY = "phc_test_masking";
  process.env.POSTHOG_HOST = `http://127.0.0.1:${posthogServer.port}`;
  __setPosthogFactoryForTest(null); // real posthog-node client → mock host
});

afterEach(() => {
  posthogBodies.length = 0;
});

afterAll(async () => {
  await shutdownPosthog();
  mcpServer.stop(true);
  posthogServer.stop(true);
  if (savedKey === undefined) delete process.env.POSTHOG_PROJECT_API_KEY;
  else process.env.POSTHOG_PROJECT_API_KEY = savedKey;
  if (savedHost === undefined) delete process.env.POSTHOG_HOST;
  else process.env.POSTHOG_HOST = savedHost;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("invokeMcpTool → PostHog", () => {
  test("runs the tool with real chat args but sends PostHog only masked metadata", async () => {
    const instance = "mcp-analytics-mask";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      state.mcpServers.push(configuredServer(instance, mcpUrl));
    });

    const result = await invokeMcpTool(
      config,
      "mcp_search",
      "search_issues",
      { query: SECRET_QUERY },
      { taskId: "task_secret" }
    );

    // The tool actually ran with the real (secret) argument + response.
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(SECRET_RESPONSE);

    // Flush the buffered analytics event to the mock host.
    await shutdownPosthog();
    const wire = posthogBodies.join("\n");

    // Pull the captured $mcp_tool_call event out of the recorded batch(es).
    const events = posthogBodies
      .flatMap((b) => (JSON.parse(b) as { batch?: Array<{ event: string; properties: Record<string, unknown> }> }).batch ?? [])
      .filter((e) => e.event === "$mcp_tool_call");
    expect(events).toHaveLength(1);
    const props = events[0]!.properties;

    // Safe metadata is present and correct.
    expect(props.$mcp_tool_name).toBe("search_issues");
    expect(props.$mcp_server_name).toBe("linear");
    expect(props.$mcp_parameter_count).toBe(1);
    expect(props.$mcp_response_bytes).toBe(SECRET_RESPONSE.length);
    expect(props.gini_masked).toBe(true);

    // The two chat-derived fields PostHog's own SDK would send are absent as KEYS
    // ($mcp_response_bytes is a safe byte count, not the response).
    expect(props).not.toHaveProperty("$mcp_parameters");
    expect(props).not.toHaveProperty("$mcp_response");

    // And no chat-derived content leaked anywhere on the wire.
    expect(wire).not.toContain(SECRET_QUERY);
    expect(wire).not.toContain(SECRET_RESPONSE);
  });

  test("captures masked metadata for a stdio-transport invocation too", async () => {
    const instance = "mcp-analytics-stdio";
    const config = makeConfig(instance);
    mkdirSync(config.workspaceRoot, { recursive: true }); // runMcpProbe spawns with cwd=workspaceRoot
    await mutateState(instance, (state) => {
      state.mcpServers.push({
        ...configuredServer(instance, ""),
        id: "mcp_stdio",
        transport: "stdio",
        command: "true" // exits 0, emits nothing → empty response, no leak surface
      });
    });

    const result = await invokeMcpTool(config, "mcp_stdio", "noop_tool", { q: SECRET_QUERY }, {});
    expect(result.ok).toBe(true);

    await shutdownPosthog();
    const events = posthogBodies
      .flatMap((b) => (JSON.parse(b) as { batch?: Array<{ event: string; properties: Record<string, unknown> }> }).batch ?? [])
      .filter((e) => e.event === "$mcp_tool_call");
    expect(events).toHaveLength(1);
    expect(events[0]!.properties.$mcp_transport).toBe("stdio");
    expect(events[0]!.properties.$mcp_response_bytes).toBe(0);
    // No task id ⇒ no session stitching id.
    expect(events[0]!.properties).not.toHaveProperty("$session_id");
    expect(posthogBodies.join("\n")).not.toContain(SECRET_QUERY);
  });
});
