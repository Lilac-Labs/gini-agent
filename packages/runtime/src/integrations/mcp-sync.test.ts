import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, readState } from "../state";
import { writeSecret } from "../state/secrets";
import type { ConnectorRecord, McpServerRecord, RuntimeConfig } from "../types";
import { checkConnector, createConnector } from "./connectors";
import { syncProviderMcpServers } from "./mcp-sync";

const ROOT = mkdtempSync(join(tmpdir(), "gini-mcp-sync-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo" as const, model: "echo" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`
  };
}

function newConnector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_linear",
    instance: overrides.instance ?? "dev",
    name: "Linear",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    health: "healthy",
    source: "user",
    ...overrides
  };
}

describe("syncProviderMcpServers", () => {
  test("registers a 'linear' MCP server when a healthy Linear connector exists", async () => {
    const config = buildConfig("mcp-sync-create");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toContain("linear");
    const state = readState(config.instance);
    const server = state.mcpServers.find((s) => s.name === "linear");
    expect(server).toBeDefined();
    expect(server?.transport).toBe("http");
    expect(server?.url).toBe("https://mcp.linear.app/mcp");
    expect(server?.headers?.Authorization).toBe("Bearer ${LINEAR_API_KEY}");
  });

  test("is idempotent — calling twice does not produce duplicates", async () => {
    const config = buildConfig("mcp-sync-idempotent");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
    });
    await syncProviderMcpServers(config);
    const second = await syncProviderMcpServers(config);
    expect(second).toEqual([]);
    const state = readState(config.instance);
    const matches = state.mcpServers.filter((s) => s.name === "linear");
    expect(matches.length).toBe(1);
  });

  test("skips when the matching connector is not healthy yet", async () => {
    const config = buildConfig("mcp-sync-unhealthy");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "unknown" }));
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toEqual([]);
    const state = readState(config.instance);
    expect(state.mcpServers.find((s) => s.name === "linear")).toBeUndefined();
  });

  test("does NOT overwrite an existing user-managed 'linear' MCP server", async () => {
    const config = buildConfig("mcp-sync-existing");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
      // Pre-existing user-managed entry with custom config.
      const existing: McpServerRecord = {
        id: "mcp_existing",
        instance: config.instance,
        name: "linear",
        command: "",
        args: [],
        envKeys: [],
        status: "configured",
        exposedTools: ["custom-tool"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        transport: "http",
        url: "https://custom.example.com/mcp",
        headers: { Authorization: "Bearer custom" }
      };
      state.mcpServers.push(existing);
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toEqual([]);
    const state = readState(config.instance);
    const matches = state.mcpServers.filter((s) => s.name === "linear");
    expect(matches.length).toBe(1);
    // User config preserved.
    expect(matches[0]?.url).toBe("https://custom.example.com/mcp");
    expect(matches[0]?.headers?.Authorization).toBe("Bearer custom");
    expect(matches[0]?.exposedTools).toEqual(["custom-tool"]);
  });

  test("leaves a disabled 'linear' entry alone (does not re-create on top)", async () => {
    const config = buildConfig("mcp-sync-disabled");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
      const tombstoned: McpServerRecord = {
        id: "mcp_tombstone",
        instance: config.instance,
        name: "linear",
        command: "",
        args: [],
        envKeys: [],
        status: "disabled",
        exposedTools: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        transport: "http",
        url: "https://mcp.linear.app/mcp"
      };
      state.mcpServers.push(tombstoned);
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toEqual([]);
    const state = readState(config.instance);
    const matches = state.mcpServers.filter((s) => s.name === "linear");
    expect(matches.length).toBe(1);
    expect(matches[0]?.status).toBe("disabled");
  });

  test("createConnector → checkConnector flow auto-registers via the lifecycle hook", async () => {
    const config = buildConfig("mcp-sync-lifecycle");
    // createConnector now probes immediately for probe-having providers.
    // With a fake token the probe fails, landing health at "unhealthy".
    const connector = await createConnector(config, {
      name: "Linear",
      provider: "linear",
      secrets: { token: "lin_api_test" }
    });
    // The probe ran and failed (fake token), so health is unhealthy.
    expect(connector.health).toBe("unhealthy");
    // Before the connector is healthy, no MCP server should appear.
    await syncProviderMcpServers(config);
    let state = readState(config.instance);
    expect(state.mcpServers.find((s) => s.name === "linear")).toBeUndefined();

    // Flip to healthy (what a successful probe would do) and re-sync.
    await mutateState(config.instance, (s) => {
      const c = s.connectors.find((x) => x.id === connector.id);
      if (c) c.health = "healthy";
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toContain("linear");
    state = readState(config.instance);
    expect(state.mcpServers.find((s) => s.name === "linear")).toBeDefined();
  });

  test("re-checks usability inside the lock — concurrent disable wins the race", async () => {
    // Simulates: the pre-lock check sees a healthy connector, but before
    // the mutateState callback fires, an operator (or another path)
    // disables the connector. The lock-scoped re-check must observe the
    // disabled state and bail out, leaving no MCP row behind.
    const config = buildConfig("mcp-sync-race-disable");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
    });
    // Flip status to disabled in a separate mutate so the in-lock re-check
    // sees the latest value.
    await mutateState(config.instance, (state) => {
      const c = state.connectors.find((x) => x.id === "id_linear");
      if (c) c.status = "disabled";
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toEqual([]);
    const state = readState(config.instance);
    expect(state.mcpServers.find((s) => s.name === "linear")).toBeUndefined();
  });

  test("does not report a stale 'created' entry when a concurrent CLI add wins", async () => {
    // Pre-lock check sees no MCP row; in-lock re-check finds one (the
    // user's `gini mcp add linear` raced ahead). `created` must not list
    // `linear` because we never inserted.
    const config = buildConfig("mcp-sync-race-existing");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
    });
    await mutateState(config.instance, (state) => {
      const racer: McpServerRecord = {
        id: "mcp_user_linear",
        instance: config.instance,
        name: "linear",
        command: "",
        args: [],
        envKeys: [],
        status: "configured",
        exposedTools: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        transport: "http",
        url: "https://mcp.linear.app/mcp"
      };
      state.mcpServers.push(racer);
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toEqual([]);
  });

  test("emits a mcp.configured audit with actor=runtime (not actor=user)", async () => {
    const config = buildConfig("mcp-sync-audit-actor");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({ id: "id_linear", instance: config.instance, health: "healthy" }));
    });
    await syncProviderMcpServers(config);
    const state = readState(config.instance);
    const auto = state.audit.find((a) => a.action === "mcp.auto_register");
    expect(auto?.actor).toBe("runtime");
    const configured = state.audit.find((a) => a.action === "mcp.configured");
    expect(configured).toBeDefined();
    // Runtime-driven creation must NOT look user-initiated.
    expect(configured?.actor).toBe("runtime");
  });

  test("registers an MCP server named by an api-key credential carrying metadata.mcp", async () => {
    // Name-based pass: a typed api-key credential (name == env var) with
    // `metadata.mcp` materializes a server row NAMED BY THE CREDENTIAL whose
    // single header is `<scheme> ${<name>}`, resolvable by name at invoke time.
    const config = buildConfig("mcp-sync-credential");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_cred",
        instance: config.instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        health: "healthy",
        metadata: { mcp: { url: "https://mcp.linear.app/mcp", headerName: "Authorization", scheme: "Bearer" } }
      }));
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toContain("LINEAR_API_KEY");
    const state = readState(config.instance);
    const server = state.mcpServers.find((s) => s.name === "LINEAR_API_KEY");
    expect(server).toBeDefined();
    expect(server?.transport).toBe("http");
    expect(server?.url).toBe("https://mcp.linear.app/mcp");
    expect(server?.headers?.Authorization).toBe("Bearer ${LINEAR_API_KEY}");
  });

  test("registers under metadata.mcp.name when set, keying the header on the credential name", async () => {
    // The migrated LINEAR_API_KEY credential drives the "linear" server row
    // (so skills' `server: "linear"` keeps resolving) while the header still
    // references ${LINEAR_API_KEY} (the credential name, == env var).
    const config = buildConfig("mcp-sync-credential-named-row");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_cred_named",
        instance: config.instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        health: "healthy",
        metadata: { mcp: { url: "https://mcp.linear.app/mcp", name: "linear", headerName: "Authorization", scheme: "Bearer" } }
      }));
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toContain("linear");
    const state = readState(config.instance);
    // Exactly one row, named "linear" — never a separate LINEAR_API_KEY row.
    expect(state.mcpServers.filter((s) => s.name === "linear").length).toBe(1);
    expect(state.mcpServers.find((s) => s.name === "LINEAR_API_KEY")).toBeUndefined();
    const server = state.mcpServers.find((s) => s.name === "linear");
    expect(server?.url).toBe("https://mcp.linear.app/mcp");
    expect(server?.headers?.Authorization).toBe("Bearer ${LINEAR_API_KEY}");
  });

  test("credential MCP header honors headerName and scheme overrides", async () => {
    const config = buildConfig("mcp-sync-credential-override");
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_cred2",
        instance: config.instance,
        name: "SOME_API_KEY",
        type: "api-key",
        provider: "generic",
        health: "healthy",
        metadata: { mcp: { url: "https://mcp.example.com/mcp", headerName: "X-Api-Key", scheme: "Token" } }
      }));
    });
    const created = await syncProviderMcpServers(config);
    expect(created).toContain("SOME_API_KEY");
    const server = readState(config.instance).mcpServers.find((s) => s.name === "SOME_API_KEY");
    expect(server?.headers?.["X-Api-Key"]).toBe("Token ${SOME_API_KEY}");
  });

  test("clean sync (no failure) leaves no mcp.auto_register_failed audit", async () => {
    // Negative control for the failure path: a presence-only provider
    // (no mcpServer descriptor) flips healthy and syncProviderMcpServers
    // is effectively a no-op. The catch handler must not fire.
    const config = buildConfig("mcp-sync-failure-clean");
    await mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_demo",
        instance: config.instance,
        name: "Demo",
        provider: "demo",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "unknown",
        source: "user"
      });
    });
    const updated = await checkConnector(config, "id_demo");
    expect(updated.health).toBe("healthy");
    const state = readState(config.instance);
    const failure = state.audit.find((a) => a.action === "mcp.auto_register_failed");
    expect(failure).toBeUndefined();
  });
});
