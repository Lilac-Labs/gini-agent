import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import "./hooks/builtins"; // the email-watch routes provision a backing job, which validates isKnownHook("skill-script")
import { createHandler, resolveInlineUpload } from "./http";
import { logDir, uploadsDir, webPortPath } from "./paths";
import { clearWebTargetCache } from "./web-target";
import { dirname, join } from "node:path";
import { addAudit, appendEvent, insertChatBlock, isPlausibleMime, mutateState, readState, readTrace, recordProviderAuthFailure, sanitizeFilename, storeUpload, uploadStat } from "./state";
import { getOrCreateAgentChat } from "./execution/chat";
import { createScheduledJob } from "./jobs";
import { removeMemoryDb } from "./state/memory-db";
import { listProviders } from "./integrations/connectors/registry";
import { resetGoogleLoginWebState } from "./integrations/connectors/google-login-web";
import { awaitTunnelSettled, setTunnelDeps, type TunnelChild } from "./integrations/tunnel";
import type { RuntimeConfig } from "./types";
import type { LoginHandle, RelayDefaults, Session, Store, TunnelOptions } from "gini-relay";

// Stub a provider's host-environment `detect()` so the connector-detection
// endpoint test stays deterministic AND fast regardless of what's installed
// on the developer's PATH. The production `detect()` for claude-code / codex
// shells out via spawnSync (`which`, `claude auth status`), which on a machine
// with those CLIs installed dominates this test's wall time (the unstubbed
// detect endpoint test measured 1.524641s). Mirrors the same in-place
// swap-and-restore helper used by src/jobs/connector-detection.test.ts. The
// registry is a process-wide singleton, so the returned restore fn MUST run in
// a finally to avoid leaking the stub into sibling tests.
function stubProviderDetect(
  providerId: string,
  value: { detected: boolean; suggestedName?: string; message?: string }
): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.detect;
  provider.detect = async () => value;
  return () => {
    provider.detect = previous;
  };
}

// Companion to stubProviderDetect. After connector auto-detection creates a
// record for a provider that exposes a `probe()`, runConnectorDetection runs
// an initial checkConnector → provider.probe, which for claude-code shells out
// to `claude auth status` again. Stub the probe so the detection endpoint
// test never touches a real subprocess. Same swap-and-restore discipline.
function stubProviderProbe(providerId: string, value: { ok: boolean; message: string }): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.probe;
  provider.probe = async () => value;
  return () => {
    provider.probe = previous;
  };
}

describe("runtime api", () => {
  test("applies approved improvement proposals and audits the decision", async () => {
    const config = testConfig("improvement-approve");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "skill",
        title: "review-traces",
        rationale: "Trace evidence shows repeated review steps.",
        payload: { name: "review-traces", steps: ["Inspect trace", "Summarize evidence"] }
      })
    });

    const applied = await call(handler, config, `/api/improvements/${proposal.id}/approve`, { method: "POST" });
    const state = readState(config.instance);

    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId).toBeString();
    expect(state.skills.some((skill) => skill.id === applied.appliedTargetId)).toBe(true);
    expect(state.audit.some((event) => event.action === "improvement.applied")).toBe(true);
  });

  test("rejected improvement proposals do not mutate target stores", async () => {
    const config = testConfig("improvement-reject");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "skill",
        title: "Remember review preference",
        payload: { name: "review-pref", description: "Prefer evidence-backed reviews.", trigger: "review", steps: ["Cite evidence"] }
      })
    });

    const rejected = await call(handler, config, `/api/improvements/${proposal.id}/reject`, { method: "POST" });
    const state = readState(config.instance);

    expect(rejected.status).toBe("rejected");
    expect(state.skills.some((skill) => skill.name === "review-pref")).toBe(false);
    expect(state.audit.some((event) => event.action === "improvement.rejected")).toBe(true);
  });

  test("only the owner bearer authorizes the mobile contracts (owner-token-only auth)", async () => {
    const config = testConfig("owner-only-mobile");
    const handler = createHandler(config);

    // A legacy device-shaped bearer must be refused — the pairing subsystem is
    // gone and bearer === config.token is the whole check (ADR owner-token-auth.md).
    const refused = await rawCall(handler, config, "/api/mobile/bootstrap", {}, "gini_device_00000000-0000-0000-0000-000000000000");
    expect(refused.status).toBe(401);

    const mobile = await callWithToken(handler, config, config.token, "/api/mobile/bootstrap");
    expect(mobile.instance).toBe(config.instance);
  });

  test("records promotion proposals without applying upgrades", async () => {
    const config = testConfig("promotion");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        candidateRef: "commit-abc",
        evidencePath: "/tmp/evidence.json",
        summary: "Candidate passed sandbox smoke.",
        rollbackPlan: "Restore snapshot snap_abc."
      })
    });
    const rejected = await call(handler, config, `/api/promotions/${proposal.id}/reject`, { method: "POST" });

    expect(rejected.status).toBe("rejected");
    expect(rejected.candidateRef).toBe("commit-abc");
    expect(readState(config.instance).audit.some((event) => event.action === "promotion.rejected")).toBe(true);
  });

  test("supports Hermes-parity control records for search, toolsets, subagents, MCP, messaging, and imports", async () => {
    const config = testConfig("hermes-parity");
    const handler = createHandler(config);

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "remember Hermes parity should be searchable" })
    });
    await waitForTask(handler, config, task.id);

    const search = await call(handler, config, "/api/search?q=Hermes");
    const toolsets = await call(handler, config, "/api/toolsets");
    const disabled = await call(handler, config, "/api/toolsets/messaging/disable", { method: "POST" });
    const subagent = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "reviewer", prompt: "review Hermes parity", parentTaskId: task.id, toolsets: ["memory"] })
    });
    await waitForTask(handler, config, subagent.taskId);
    const mcp = await call(handler, config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "demo-mcp", command: "echo", args: ["ok"], exposedTools: ["demo.echo"] })
    });
    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "demo-bridge", kind: "demo", deliveryTargets: ["local"] })
    });
    const report = await call(handler, config, "/api/imports/inspect", {
      method: "POST",
      body: JSON.stringify({ source: "hermes", path: process.cwd() })
    });

    expect(search.length).toBeGreaterThan(0);
    expect(toolsets.toolsets.some((item: { name: string }) => item.name === "session_search")).toBe(true);
    expect(disabled.status).toBe("disabled");
    expect(subagent.taskId).toBeString();
    expect(mcp.status).toBe("configured");
    expect(bridge.status).toBe("configured");
    expect(report.status).toBe("completed");
  });

  test("executes low-risk file tool tasks with trace and audit evidence", async () => {
    const config = testConfig("file-tools");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);

    const read = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    const readDetail = await waitForTask(handler, config, read.id);
    const list = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "list packages/runtime/src" })
    });
    const listDetail = await waitForTask(handler, config, list.id);
    const find = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "find Gini in README.md" })
    });
    const findDetail = await waitForTask(handler, config, find.id);
    const state = readState(config.instance);

    expect(readDetail.task.status).toBe("completed");
    expect(listDetail.task.summary).toContain("src/agent.ts");
    expect(findDetail.task.summary).toContain("README.md");
    expect(state.audit.some((event) => event.action === "file.read")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.list")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.search")).toBe(true);
  });

  test("supports agent config equivalents and Hermes parity reporting", async () => {
    const config = testConfig("agents-parity");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "research", toolsets: ["file", "web", "session_search"] })
    });
    const active = await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });
    const agents = await call(handler, config, "/api/agents");
    const parity = await call(handler, config, "/api/parity/hermes");

    expect(active.status).toBe("active");
    expect(agents.activeAgentId).toBe(created.id);
    expect(parity.ok).toBe(true);
    expect(parity.checks.some((item: { id: string; status: string }) => item.id === "agents" && item.status === "pass")).toBe(true);
  });

  test("DELETE /api/agents/:id removes the agent and cascades cleanup", async () => {
    const config = testConfig("agents-delete");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scratch" })
    });
    const deleted = await call(handler, config, `/api/agents/${created.id}`, { method: "DELETE" });

    expect(deleted.ok).toBe(true);
    expect(deleted.id).toBe(created.id);
    expect(deleted.bankDeleted).toBe(true);

    const after = await call(handler, config, "/api/agents");
    expect(after.agents.find((agent: { id: string }) => agent.id === created.id)).toBeUndefined();

    // Idempotent: a second delete on the same id returns 404, not 500.
    const followUp = await rawCall(handler, config, `/api/agents/${created.id}`, { method: "DELETE" }, config.token);
    expect(followUp.status).toBe(404);
  });

  test("DELETE /api/agents/:id rejects the default agent with 400", async () => {
    const config = testConfig("agents-delete-default");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/agents/agent_default", { method: "DELETE" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot delete the default agent");
  });

  test("DELETE /api/agents/:id rejects the active agent with 400", async () => {
    const config = testConfig("agents-delete-active");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "active" })
    });
    await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });

    const response = await rawCall(handler, config, `/api/agents/${created.id}`, { method: "DELETE" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot delete the active agent");
  });

  test("POST /api/agents/:id/archive then /unarchive round-trips archivedAt", async () => {
    const config = testConfig("agents-archive-roundtrip");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scratch" })
    });
    const archived = await call(handler, config, `/api/agents/${created.id}/archive`, { method: "POST" });
    expect(typeof archived.archivedAt).toBe("string");

    const restored = await call(handler, config, `/api/agents/${created.id}/unarchive`, { method: "POST" });
    expect(restored.archivedAt).toBeUndefined();
  });

  test("POST /api/agents/:id/archive rejects the default agent with 400", async () => {
    const config = testConfig("agents-archive-default");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/agents/agent_default/archive", { method: "POST" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot archive the default agent");
  });

  test("POST /api/agents/:id/archive archives the active agent and hands active to the default", async () => {
    const config = testConfig("agents-archive-active");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "active" })
    });
    await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });

    const archived = await call(handler, config, `/api/agents/${created.id}/archive`, { method: "POST" });
    expect(typeof archived.archivedAt).toBe("string");

    // Active selection reassigns to the always-present default agent.
    const agents = await call(handler, config, "/api/agents");
    expect(agents.activeAgentId).toBe("agent_default");
    expect(agents.defaultAgentId).toBe("agent_default");
  });

  test("POST /api/agents/:id/use rejects an archived agent with 400", async () => {
    const config = testConfig("agents-use-archived");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scratch" })
    });
    await call(handler, config, `/api/agents/${created.id}/archive`, { method: "POST" });

    const response = await rawCall(handler, config, `/api/agents/${created.id}/use`, { method: "POST" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot use an archived agent");
  });

  test("PATCH /api/agents/:id renames the agent", async () => {
    const config = testConfig("agents-rename");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Mansour" })
    });
    const renamed = await call(handler, config, `/api/agents/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Bob" })
    });
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe("Bob");

    const after = await call(handler, config, "/api/agents");
    expect(after.agents.find((agent: { id: string }) => agent.id === created.id)?.name).toBe("Bob");
  });

  test("PATCH /api/agents/:id returns 404 for an unknown agent", async () => {
    const config = testConfig("agents-rename-missing");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/agents/agent_does_not_exist",
      { method: "PATCH", body: JSON.stringify({ name: "Bob" }) },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("PATCH /api/agents/:id returns 400 for an empty name", async () => {
    // A missing / blank name is user input, not a server fault — it must
    // map to 400, never the catch-all 500.
    const config = testConfig("agents-rename-empty");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Mansour" })
    });
    const response = await rawCall(
      handler,
      config,
      `/api/agents/${created.id}`,
      { method: "PATCH", body: JSON.stringify({}) },
      config.token
    );
    expect(response.status).toBe(400);
  });

  test("POST /api/agents/:id/provider sets the agent's provider and /status reflects it", async () => {
    const config = testConfig("agents-set-provider");
    const handler = createHandler(config);
    // Configure the pinned provider so the resolved provider dispatches verbatim;
    // an unconfigured pin would transiently fall back to any other configured
    // provider (e.g. an ambient codex auth.json on the dev machine), which is a
    // separate path covered by the dispatch-fallback tests.
    const prevOpenai = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-agent-provider";
    try {
      const created = await call(handler, config, "/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "research" })
      });
      await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });

      const updated = await call(handler, config, `/api/agents/${created.id}/provider`, {
        method: "POST",
        body: JSON.stringify({ providerName: "openai", model: "gpt-4o" })
      });
      expect(updated.providerName).toBe("openai");
      expect(updated.model).toBe("gpt-4o");

      // The override drives inference: the active-agent block resolves the
      // agent's provider, not the instance default (echo in this config).
      const status = await call(handler, config, "/api/status");
      expect(status.activeAgent.resolvedProvider.name).toBe("openai");
      expect(status.activeAgent.resolvedProvider.model).toBe("gpt-4o");
      expect(status.activeAgent.providerSource).toBe("agent");
    } finally {
      if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenai;
    }
  });

  test("POST /api/agents/:id/provider with blank fields clears the override", async () => {
    const config = testConfig("agents-clear-provider");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "research", providerName: "openai", model: "gpt-4o" })
    });
    await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });

    const cleared = await call(handler, config, `/api/agents/${created.id}/provider`, {
      method: "POST",
      body: JSON.stringify({ providerName: "", model: "" })
    });
    expect(cleared.providerName).toBeUndefined();
    expect(cleared.model).toBeUndefined();

    // With no agent override, the active-agent block falls back to the
    // instance provider (echo) and reports the instance source.
    const status = await call(handler, config, "/api/status");
    expect(status.activeAgent.providerSource).toBe("instance");
    expect(status.activeAgent.resolvedProvider.name).toBe("echo");
  });

  test("POST /api/agents/:id/provider returns 404 for an unknown agent", async () => {
    const config = testConfig("agents-set-provider-missing");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/agents/agent_does_not_exist/provider",
      { method: "POST", body: JSON.stringify({ providerName: "openai", model: "gpt-4o" }) },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("POST /api/agents/:id/provider returns 400 for a lone providerName", async () => {
    const config = testConfig("agents-set-provider-partial");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "research" })
    });
    const response = await rawCall(
      handler,
      config,
      `/api/agents/${created.id}/provider`,
      { method: "POST", body: JSON.stringify({ providerName: "openai" }) },
      config.token
    );
    expect(response.status).toBe(400);
  });

  test("POST /api/agents/:id/provider returns 400 for an unknown provider", async () => {
    const config = testConfig("agents-set-provider-unknown");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "research" })
    });
    const response = await rawCall(
      handler,
      config,
      `/api/agents/${created.id}/provider`,
      { method: "POST", body: JSON.stringify({ providerName: "bogus", model: "x" }) },
      config.token
    );
    expect(response.status).toBe(400);
  });

  test("supports relay degraded health and notification delivery records", async () => {
    const config = testConfig("relay-notifications");
    const handler = createHandler(config);

    const relay = await call(handler, config, "/api/relays", {
      method: "POST",
      body: JSON.stringify({ name: "local", endpoint: "local://test", mode: "local-only" })
    });
    const health = await call(handler, config, `/api/relays/${relay.id}/health`, { method: "POST" });
    const notification = await call(handler, config, "/api/notifications", {
      method: "POST",
      body: JSON.stringify({ kind: "runtime", target: "local", title: "Runtime check", body: "Relay test" })
    });
    const sent = await call(handler, config, "/api/notifications/send", { method: "POST" });

    expect(health.status).toBe("degraded");
    expect(notification.status).toBe("queued");
    expect(sent.some((item: { id: string; status: string }) => item.id === notification.id && item.status === "sent")).toBe(true);
  });

  test("tunnel routes return the full TunnelState across the select/connect/disconnect flow", async () => {
    const config = testConfig("tunnel-routes");
    const handler = createHandler(config);

    // Inject fake gini-relay seams so the connect flow exercises the
    // connecting -> connected transition without OAuth, the host browser, or a
    // spawned frpc child. Restored in the finally.
    const session: Session = { token: "gsk_x", subdomain: "subroute", account: "u@test" };
    const relay: RelayDefaults = {
      relayUrl: "https://relay.test", frpsAddr: "relay.test", frpsPort: 7000,
      relayDomain: "relay.test", tlsServerName: "relay.test", frpToken: "t",
      caFile: "/tmp/ca", loopbackPorts: [8765], bandwidth: "1220KB"
    };
    const child: TunnelChild = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(0),
      exited: Promise.withResolvers<number>().promise
    };
    const store: Store = { home: "/tmp/h", deviceId: () => "d1", readSession: () => session, writeSession: () => {}, clearSession: () => {} };
    const handle: LoginHandle = {
      url: "https://relay.test/consent", redirectUri: "http://127.0.0.1:8765/cb",
      waitForSession: () => Promise.resolve(session), cancel: () => {}
    };
    // Inert manual drivers so nothing in this flow can shell out to a
    // host-installed tailscale/ngrok/cloudflared (or flip their catalog rows).
    const inertDriver = (requires: string) => ({
      detect: () => Promise.resolve({ enabled: false, requires }),
      connect: () => Promise.reject(new Error("manual driver must not run"))
    });
    setTunnelDeps({
      loginUrl: () => Promise.resolve(handle),
      buildTunnel: (_opts: TunnelOptions) => child,
      createStore: () => store,
      resolveDefaults: () => relay,
      openBrowser: () => {},
      resolveLocalPort: () => 4321,
      probeLocalPort: () => Promise.resolve(true),
      drivers: {
        tailscale: inertDriver("Tailscale network"),
        ngrok: inertDriver("ngrok account"),
        cloudflare: inertDriver("cloudflared CLI")
      }
    });

    try {
      // GET on a fresh instance: catalog present, nothing selected, idle.
      const initial = await call(handler, config, "/api/tunnel");
      expect(initial.status).toBe("idle");
      expect(initial.selectedProvider).toBeNull();
      expect(initial.providers.map((p: { id: string }) => p.id)).toEqual([
        "gini-relay",
        "tailscale",
        "ngrok",
        "cloudflare"
      ]);

      // select saves the choice without connecting.
      const selected = await call(handler, config, "/api/tunnel/select", {
        method: "POST",
        body: JSON.stringify({ provider: "gini-relay" })
      });
      expect(selected.selectedProvider).toBe("gini-relay");
      expect(selected.status).toBe("idle");

      // connect (no body provider) uses the saved selection; the route returns
      // "connecting" immediately while the background handshake runs.
      const connecting = await call(handler, config, "/api/tunnel/connect", {
        method: "POST",
        body: JSON.stringify({})
      });
      expect(connecting.status).toBe("connecting");
      expect(connecting.url).toBeUndefined();

      // Let the background flow settle, then GET reflects connected + url.
      await awaitTunnelSettled(config.instance);
      const connected = await call(handler, config, "/api/tunnel");
      expect(connected.status).toBe("connected");
      expect(connected.url).toBe("https://subroute.relay.test");

      // cancel returns to idle keeping the selection.
      const cancelled = await call(handler, config, "/api/tunnel/cancel", { method: "POST" });
      expect(cancelled.status).toBe("idle");
      expect(cancelled.selectedProvider).toBe("gini-relay");

      // connect with an explicit provider in the body overrides selection.
      const reconnecting = await call(handler, config, "/api/tunnel/connect", {
        method: "POST",
        body: JSON.stringify({ provider: "gini-relay" })
      });
      expect(reconnecting.status).toBe("connecting");
      await awaitTunnelSettled(config.instance);
      expect((await call(handler, config, "/api/tunnel")).status).toBe("connected");

      // disconnect tears down, keeps the selection.
      const disconnected = await call(handler, config, "/api/tunnel/disconnect", { method: "POST" });
      expect(disconnected.status).toBe("idle");
      expect(disconnected.selectedProvider).toBe("gini-relay");
    } finally {
      setTunnelDeps();
    }
  });

  test("GET /api/tunnel?detect=1 re-probes driver availability and flips catalog rows", async () => {
    const config = testConfig("tunnel-detect");
    const handler = createHandler(config);
    const inert = (requires: string) => ({
      detect: () => Promise.resolve({ enabled: false, requires }),
      connect: () => Promise.reject(new Error("unused"))
    });
    setTunnelDeps({
      drivers: {
        tailscale: { detect: () => Promise.resolve({ enabled: true }), connect: () => Promise.reject(new Error("unused")) },
        ngrok: inert("ngrok account"),
        cloudflare: inert("cloudflared CLI")
      }
    });
    try {
      // A plain GET never spawns detection: the catalog stays default-disabled.
      const plain = await call(handler, config, "/api/tunnel");
      const plainRow = plain.providers.find((p: { id: string }) => p.id === "tailscale");
      expect(plainRow.enabled).toBe(false);
      // detect=1 probes the drivers and the row flips.
      const detected = await call(handler, config, "/api/tunnel?detect=1");
      const row = detected.providers.find((p: { id: string }) => p.id === "tailscale");
      expect(row.enabled).toBe(true);
      expect(row.requires).toBeUndefined();
    } finally {
      setTunnelDeps();
    }
  });

  test("POST /api/tunnel/select rejects a disabled provider with a 400", async () => {
    const config = testConfig("tunnel-reject");
    const handler = createHandler(config);
    // The select path re-probes a disabled provider's prerequisite before
    // rejecting — pin detection to disabled so the rejection (and this test)
    // never depends on which CLIs the host machine happens to have.
    setTunnelDeps({
      drivers: {
        tailscale: { detect: () => Promise.resolve({ enabled: false, requires: "Tailscale network" }), connect: () => Promise.reject(new Error("unused")) },
        ngrok: { detect: () => Promise.resolve({ enabled: false, requires: "ngrok account" }), connect: () => Promise.reject(new Error("unused")) },
        cloudflare: { detect: () => Promise.resolve({ enabled: false, requires: "cloudflared CLI" }), connect: () => Promise.reject(new Error("unused")) }
      }
    });
    try {
      const response = await rawCall(handler, config, "/api/tunnel/select", {
        method: "POST",
        body: JSON.stringify({ provider: "ngrok" })
      }, config.token);
      expect(response.status).toBe(400);
      const value = await response.json();
      expect(value.error).toContain("not available");
      // The machine-readable code rides along so clients can branch on the
      // failure kind (the web UI opens the provider's guide on this code).
      expect(value.code).toBe("provider_unavailable");
    } finally {
      setTunnelDeps();
    }
  });

  test("supports V1 skill governance and job run history workflows", async () => {
    const config = testConfig("v1-skill-job");
    const handler = createHandler(config);

    const skill = await call(handler, config, "/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "triage", steps: ["Read trace"], tests: ["has name"] })
    });
    const enabled = await call(handler, config, `/api/skills/${skill.id}/enable`, { method: "POST" });
    const tested = await call(handler, config, `/api/skills/${skill.id}/test`, { method: "POST" });
    const updated = await call(handler, config, `/api/skills/${skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Updated skill", steps: ["Read trace", "Summarize"] })
    });
    const rolledBack = await call(handler, config, `/api/skills/${skill.id}/rollback`, { method: "POST" });

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script", intervalSeconds: 60, script: "echo script-ok", deliveryTargets: ["local"], timeoutSeconds: 5 })
    });
    const run = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    const runs = await call(handler, config, `/api/jobs/${job.id}/runs`);
    const replay = await call(handler, config, `/api/job-runs/${runs[0].id}/replay`, { method: "POST" });
    const events = await call(handler, config, "/api/events");

    expect(enabled.status).toBe("enabled");
    expect(tested.ok).toBe(true);
    expect(updated.version).toBe(2);
    expect(rolledBack.version).toBe(3);
    expect(run.exitCode).toBe(0);
    expect(runs[0].summary).toContain("script-ok");
    expect(replay.exitCode).toBe(0);
    expect(events.some((event: { action: string }) => event.action === "job.run.completed")).toBe(true);
  });

  test("PATCH /api/jobs/:id round-trips costBudget alongside other editable fields", async () => {
    const config = testConfig("v1-job-cost-budget");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cost-job", intervalSeconds: 120, prompt: "noop" })
    });
    expect(job.costBudget).toBeUndefined();

    const patched = await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ costBudget: 2.5, retryLimit: 4, timeoutSeconds: 45 })
    });
    expect(patched.costBudget).toBe(2.5);
    expect(patched.retryLimit).toBe(4);
    expect(patched.timeoutSeconds).toBe(45);

    const refetched = (await call(handler, config, "/api/jobs")).find((item: { id: string }) => item.id === job.id);
    expect(refetched.costBudget).toBe(2.5);

    const cleared = await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ costBudget: null })
    });
    expect(cleared.costBudget).toBeUndefined();
  });

  test("probes and invokes configured MCP command records", async () => {
    const config = testConfig("v1-mcp");
    const handler = createHandler(config);

    const server = await call(handler, config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "echo-mcp", command: "echo", args: ["ok"], exposedTools: ["echo.tool"] })
    });
    const health = await call(handler, config, `/api/mcp/${server.id}/health`, { method: "POST" });
    const invoked = await call(handler, config, `/api/mcp/${server.id}/invoke`, {
      method: "POST",
      body: JSON.stringify({ toolName: "echo.tool", input: { value: 1 } })
    });

    expect(health.status).toBe("configured");
    expect(health.message).toContain("completed");
    expect(invoked.ok).toBe(true);
    expect(invoked.stdout).toContain("ok");
  });

  test("exposes recorded runtime events as an SSE stream", async () => {
    const config = testConfig("events-stream");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "event-test", payload: { name: "event-test" } })
    });
    const response = await rawCall(handler, config, "/api/events/stream", {}, config.token);
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(chunk?.value);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("data:");
    expect(text).toContain("event_");
  });

  test("SSE stream honors Last-Event-ID for reconnect dedup", async () => {
    // Regression for the Round 2 reconnect storm: every reconnect was
    // re-replaying the entire event log, which compounded into thousands of
    // events/sec on the client when the EventSource thrashed. With dedup, a
    // reconnect that includes the most-recent id should yield zero historical
    // events on first read.
    const config = testConfig("events-stream-dedup");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "first", payload: { name: "first" } })
    });
    // Read the full event log once to discover the most-recent id.
    const events = await call(handler, config, "/api/events");
    expect(events.length).toBeGreaterThan(0);
    const lastEventId = events[events.length - 1].id;

    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "last-event-id": lastEventId } },
      config.token
    );
    // First read should yield no historical events (everything up to and
    // including lastEventId is suppressed). The TextDecoder.decode of an empty
    // chunk is "".
    const reader = response.body?.getReader();
    // Race the read against a short timeout; the heartbeat doesn't fire for
    // 1s, so an immediate read should observe an empty buffer. The timeout
    // value only needs to lose to a real event (there are none queued) and
    // win against the 1s heartbeat — 30ms is as conclusive as 200ms here and
    // doesn't burn the wall when the suite runs the whole describe block.
    const winner = await Promise.race([
      reader?.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 30))
    ]) as { value?: Uint8Array; done?: boolean };
    await reader?.cancel();
    const text = winner?.value ? new TextDecoder().decode(winner.value) : "";
    expect(text).toBe("");
  });

  test("SSE Last-Event-ID older than retained buffer still delivers retained events", async () => {
    // Regression for R3-G1: when the client's Last-Event-ID has rolled out of
    // the 1000-event ring buffer (long disconnect or burst), we must NOT
    // silently pre-seed every retained event into `seen` — that would deliver
    // nothing on reconnect and the client would never recover. Instead, treat
    // the unknown id as "best effort" and ship the entire retained window.
    const config = testConfig("events-stream-rollover");
    const handler = createHandler(config);

    // Generate more events than the ring buffer holds (1000), so a fabricated
    // earlier id is guaranteed not to be retained.
    await mutateState(config.instance, (state) => {
      for (let i = 0; i < 1100; i += 1) {
        appendEvent(
          state,
          {
            kind: "runtime",
            action: "noop",
            target: `target-${i}`,
            risk: "low",
            summary: `event ${i}`
          },
          { system: true }
        );
      }
    });

    // Construct a stale Last-Event-ID that mimics the ID format but isn't in
    // the buffer. (The buffer holds the last 1000; this id is intentionally
    // synthetic and won't match any retained event.)
    const staleId = "event_rolled_out_of_buffer";

    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "last-event-id": staleId } },
      config.token
    );
    const reader = response.body?.getReader();
    const winner = (await Promise.race([
      reader?.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 200))
    ])) as { value?: Uint8Array; done?: boolean };
    await reader?.cancel();
    const text = winner?.value ? new TextDecoder().decode(winner.value) : "";

    // Should have received the retained window, not silence.
    expect(text).toContain("data:");
    expect(text).toContain("event_");
  });

  test("supports local chat sessions backed by task execution and retry contracts", async () => {
    const config = testConfig("chat");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "Hermes-style chat" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "remember chat history works" })
    });
    await waitForTask(handler, config, submitted.taskId);
    const assistant = await call(handler, config, `/api/chat/${session.id}/tasks/${submitted.taskId}/sync`, { method: "POST" });
    const retry = await call(handler, config, `/api/tasks/${submitted.taskId}/retry`, { method: "POST" });
    const detail = await call(handler, config, `/api/chat/${session.id}`);

    expect(assistant.role).toBe("assistant");
    expect(retry.input).toContain("remember chat history works");
    expect(detail.messages).toHaveLength(2);
    expect(detail.taskIds).toContain(submitted.taskId);
  });

  test("chat message POST accepts an optional client surface field", async () => {
    const config = testConfig("chat-client-surface");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "surface chat" })
    });
    // A valid `client` value lands on the spawned task; an unrecognized one
    // resolves to unknown without rejecting the message (older clients must
    // keep working). See ADR client-surface-context.md.
    const tagged = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello from my phone", client: "mobile" })
    });
    const untagged = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello from somewhere", client: "fridge" })
    });
    const tasks = readState(config.instance).tasks;
    expect(tasks.find((t) => t.id === tagged.taskId)?.clientSurface).toBe("mobile");
    expect(tasks.find((t) => t.id === untagged.taskId)?.clientSurface).toBeUndefined();
  });

  test("queues a chat message posted during an in-flight turn and DELETE drops it", async () => {
    // While a session has a non-terminal chat task, a new POST enqueues onto
    // the session instead of starting a concurrent task; the queued item is
    // removable via DELETE /api/chat/:id/pending/:pendingId. See ADR
    // chat-message-queue.md.
    const config = testConfig("chat-queue-http");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "queue chat" })
    });
    // Seed a non-terminal task on the session so the next submit reads as busy
    // (without depending on a still-running agent loop).
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.tasks.push({
        id: "task_busy",
        title: "busy",
        input: "busy",
        status: "running",
        instance: state.instance,
        createdAt: at,
        updatedAt: at,
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id
      });
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push("task_busy");
    });

    const queued = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "while you were out" })
    });
    expect(queued.queued).toBe(true);
    expect(queued.pendingId).toBeString();
    expect(queued.taskId).toBeUndefined();

    let pending = readState(config.instance).chatSessions.find((s) => s.id === session.id)?.pendingMessages ?? [];
    expect(pending.map((p: { content: string }) => p.content)).toEqual(["while you were out"]);

    // Unknown pending id → 404.
    const missing = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/pending/pending_nope`,
      { method: "DELETE" },
      config.token
    );
    expect(missing.status).toBe(404);

    // Removing the real pending id clears the queue and reports removed:true.
    const removed = await call(handler, config, `/api/chat/${session.id}/pending/${queued.pendingId}`, {
      method: "DELETE"
    });
    expect(removed.removed).toBe(true);
    pending = readState(config.instance).chatSessions.find((s) => s.id === session.id)?.pendingMessages ?? [];
    expect(pending).toHaveLength(0);
  });

  test("approval-gated file patch produces a diff approval", async () => {
    // Memory CRUD via `/api/memory` was removed alongside the
    // state.memories consolidation. See ADR
    // runtime-identity-files.md.
    const config = testConfig("memory-patch");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    const detail = await waitForTask(handler, config, task.id);
    const approval = readState(config.instance).authorizations.find((item) => item.taskId === task.id);

    expect(detail.task.status).toBe("waiting_approval");
    expect(approval?.action).toBe("file.patch");
    expect(String(approval?.payload.diff)).toContain("--- before");
  });

  test("routes messaging bridge input to tasks and records outbound delivery", async () => {
    const config = testConfig("messaging-routing");
    const handler = createHandler(config);

    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "local-messages", kind: "demo", deliveryTargets: ["local"] })
    });
    const inbound = await call(handler, config, `/api/messaging/${bridge.id}/receive`, {
      method: "POST",
      body: JSON.stringify({ text: "remember message bridge works", target: "local" })
    });
    await waitForTask(handler, config, inbound.taskId);
    const outbound = await call(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "Task is visible in Gini", target: "local" })
    });
    const messages = await call(handler, config, `/api/messaging/${bridge.id}/messages`);

    expect(inbound.direction).toBe("inbound");
    expect(inbound.status).toBe("received");
    expect(outbound.status).toBe("sent");
    expect(messages).toHaveLength(2);
  });

  test("rejects send to a target outside the active agent's messagingTargets filter", async () => {
    const config = testConfig("messaging-agent-filter");
    const handler = createHandler(config);

    // Bridge advertises two targets so the per-call `target` selector has
    // something to disagree with the agent filter about.
    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "multi", kind: "demo", deliveryTargets: ["local", "slack"] })
    });
    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "local-only", toolsets: ["file"], messagingTargets: ["local"] })
    });
    await call(handler, config, `/api/agents/${agent.id}/use`, { method: "POST" });

    // local target is permitted → succeeds.
    const allowed = await call(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "ok", target: "local" })
    });
    expect(allowed.status).toBe("sent");

    // slack is outside the agent filter → server returns 400 with a typed
    // error message that names both target and agent.
    const rejected = await rawCall(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "nope", target: "slack" })
    }, config.token);
    expect(rejected.ok).toBe(false);
    const errorBody = await rejected.json();
    expect(String(errorBody.error)).toContain("not permitted by active agent");
    expect(String(errorBody.error)).toContain("slack");
  });

  test("GET / returns the runtime banner when the web server is not running", async () => {
    const config = testConfig("root-pointer");
    const handler = createHandler(config);

    const response = await handler(new Request(`http://127.0.0.1:${config.port}/`));
    const value = (await response.json()) as { name?: string; instance?: string; message?: string };

    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(value.name).toBe("gini-runtime");
    expect(value.instance).toBe(config.instance);
    expect(String(value.message)).toContain("Next.js");
  });

  // The web-down banner is reachable over the relay on bootstrap paths (exempt
  // from the session gate) during the web child's post-restart startup window.
  // A non-loopback (relay) caller must get only the bare name/message — never the
  // instance, port, or web-URL hint — so the banner can't leak deployment details.
  test("the web-down banner withholds deployment details from a relay caller", async () => {
    const config = testConfig("banner-relay-redaction");
    const handler = createHandler(config);

    const relayHost = "sub.gini-relay.lilaclabs.ai";
    const response = await handler(
      new Request(`https://${relayHost}/favicon.ico`, { headers: { host: relayHost } })
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as {
      name?: string;
      instance?: unknown;
      port?: unknown;
      ui_url_hint?: unknown;
    };
    expect(value.name).toBe("gini-runtime");
    expect(value.instance).toBeUndefined();
    expect(value.port).toBeUndefined();
    expect(value.ui_url_hint).toBeUndefined();
  });

  // The web reverse proxy: non-/api traffic and the /api/runtime/* BFF
  // namespace route to the Next.js server, while native /api/* stays
  // bearer-gated. With no web server running in tests, the proxy falls back
  // to the runtime banner — which is exactly what proves the routing: a path
  // that reached the bearer gate would 401, not return the banner.
  test("/api/runtime/* bypasses the gateway bearer gate and reaches the web proxy", async () => {
    const config = testConfig("bff-carveout");
    const handler = createHandler(config);

    // No Authorization header. A native /api/* path is gated → 401.
    const native = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`));
    expect(native.status).toBe(401);

    // The BFF namespace is carved out of the gate; with web down it falls
    // through to the proxy. An API-shaped path gets a 502 (not the 401 it
    // would get if it had hit the bearer gate, and not a 200 banner a caller
    // could mistake for success).
    const bff = await handler(new Request(`http://127.0.0.1:${config.port}/api/runtime/status`));
    expect(bff.status).toBe(502);
    const body = (await bff.json()) as { error?: string };
    expect(String(body.error)).toContain("Web UI not running");
  });

  test("non-/api paths proxy to the web server (banner fallback when web is down)", async () => {
    const config = testConfig("web-proxy-fallback");
    const handler = createHandler(config);

    const page = await handler(new Request(`http://127.0.0.1:${config.port}/some/app/route`));
    expect(page.status).toBe(200);
    const body = (await page.json()) as { name?: string };
    expect(body.name).toBe("gini-runtime");
  });

  // The gateway is the single trust front: every web-bound request is validated
  // before proxying so the inner web child stays relay-agnostic. An untrusted
  // (non-loopback, non-relay, non-allowlisted) Host is refused here.
  test("web-bound requests from an untrusted Host are refused before proxying", async () => {
    const config = testConfig("web-proxy-gate");
    const handler = createHandler(config);
    // Page/asset path → 404 (don't confirm the host exists).
    const page = await handler(new Request("http://evil.example/some/app/route", { headers: { host: "evil.example" } }));
    expect(page.status).toBe(404);
    // /api/runtime/* BFF namespace → 403 so a programmatic caller sees the refusal.
    const bff = await handler(new Request("http://evil.example/api/runtime/status", { headers: { host: "evil.example" } }));
    expect(bff.status).toBe(403);
  });

  // After validating the real Host/Origin, the gateway presents the inner web
  // child a loopback Host AND Origin so the child needs no relay awareness.
  test("proxyWeb rewrites Host and Origin to loopback before forwarding to the web child", async () => {
    const config = testConfig("web-proxy-rewrite");
    const handler = createHandler(config);
    const captured: { host: string | null; origin: string | null } = { host: null, origin: null };
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/runtime/__healthz") {
          return Response.json({ ok: true, service: "gini-web", instance: config.instance });
        }
        captured.host = req.headers.get("host");
        captured.origin = req.headers.get("origin");
        return new Response("ok");
      }
    });
    try {
      mkdirSync(dirname(webPortPath(config.instance)), { recursive: true });
      writeFileSync(webPortPath(config.instance), String(upstream.port));
      clearWebTargetCache(config.instance);
      // Loopback Host passes the gate; the original Origin points at the gateway
      // port, so a correct rewrite makes the child see the loopback web port.
      await handler(new Request(`http://127.0.0.1:${config.port}/some/app/route`, {
        headers: { origin: `http://127.0.0.1:${config.port}` }
      }));
      expect(captured.host).toBe(`127.0.0.1:${upstream.port}`);
      expect(captured.origin).toBe(`http://127.0.0.1:${upstream.port}`);
    } finally {
      await upstream.stop(true);
      clearWebTargetCache(config.instance);
    }
  });

  // The web child builds redirects from the loopback Host the gateway forwarded,
  // so an absolute Location points at the loopback web port — which would send a
  // remote tunnel browser to its own 127.0.0.1. The gateway rewrites it to a
  // relative path so the browser resolves it against the origin it used.
  test("proxyWeb rewrites an absolute loopback redirect Location to a relative path", async () => {
    const config = testConfig("web-proxy-redirect");
    const handler = createHandler(config);
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/runtime/__healthz") {
          return Response.json({ ok: true, service: "gini-web", instance: config.instance });
        }
        // Emulate the setup gate building an absolute redirect from its (gateway-
        // rewritten, loopback) Host.
        return new Response(null, { status: 307, headers: { location: `http://${req.headers.get("host")}/setup` } });
      }
    });
    try {
      mkdirSync(dirname(webPortPath(config.instance)), { recursive: true });
      writeFileSync(webPortPath(config.instance), String(upstream.port));
      clearWebTargetCache(config.instance);
      const res = await handler(new Request(`http://127.0.0.1:${config.port}/chat`, {
        headers: { origin: `http://127.0.0.1:${config.port}` }
      }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("/setup");
    } finally {
      await upstream.stop(true);
      clearWebTargetCache(config.instance);
    }
  });

  // The gateway forwards app cookies to the inner web child untouched (it owns
  // no cookies of its own under owner-token-only auth).
  test("proxyWeb passes application cookies through to the inner web child", async () => {
    const config = testConfig("web-proxy-cookie-pass");
    const handler = createHandler(config);
    const captured: { cookie: string | null } = { cookie: null };
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/runtime/__healthz") {
          return Response.json({ ok: true, service: "gini-web", instance: config.instance });
        }
        captured.cookie = req.headers.get("cookie");
        return new Response("ok");
      }
    });
    try {
      mkdirSync(dirname(webPortPath(config.instance)), { recursive: true });
      writeFileSync(webPortPath(config.instance), String(upstream.port));
      clearWebTargetCache(config.instance);
      await handler(new Request(`http://127.0.0.1:${config.port}/some/app/route`, {
        headers: {
          origin: `http://127.0.0.1:${config.port}`,
          cookie: "theme=dark; locale=en"
        }
      }));
      expect(captured.cookie).toBe("theme=dark; locale=en");
    } finally {
      await upstream.stop(true);
      clearWebTargetCache(config.instance);
    }
  });

  test("preserves full terminal stdout in a trace artifact when audit evidence is truncated", async () => {
    // Master plan §6.2 requires that "outputs are truncated intelligently
    // with full logs stored." The audit `evidence` field caps stdout/stderr
    // at 4KB for at-a-glance inline reading, but the full text must remain
    // retrievable. agent.executeApprovedAction writes a sibling artifact
    // under the task's trace directory and references it from both the
    // audit evidence and the trace record.
    const config = testConfig("terminal-output-preservation");
    config.workspaceRoot = "/tmp";
    const handler = createHandler(config);

    // Generate >4KB of stdout to force the inline excerpt to truncate.
    const command = "yes abcdefghij | head -n 500";
    const submitted = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: `shell ${command}` })
    });
    const detail = await waitForTask(handler, config, submitted.id);
    expect(detail.task.status).toBe("waiting_approval");

    const approval = readState(config.instance).authorizations.find((item) => item.taskId === submitted.id);
    expect(approval).toBeDefined();
    await call(handler, config, `/api/authorizations/${approval!.id}/approve`, { method: "POST" });

    const finalDetail = await waitForTask(handler, config, submitted.id, ["completed", "failed"]);
    expect(finalDetail.task.status).toBe("completed");

    const auditEntry = readState(config.instance).audit.find(
      (event) => event.action === "terminal.exec" && event.taskId === submitted.id
    );
    expect(auditEntry).toBeDefined();
    const evidence = auditEntry!.evidence as Record<string, unknown>;

    // Inline excerpt is truncated at 4000 bytes for display, but the audit
    // carries metadata that signals truncation and points at the artifact.
    expect(typeof evidence.stdout).toBe("string");
    expect((evidence.stdout as string).length).toBeLessThanOrEqual(4000);
    expect(evidence.stdoutTruncated).toBe(true);
    expect(typeof evidence.stdoutBytes).toBe("number");
    expect(evidence.stdoutBytes as number).toBeGreaterThan(4000);
    expect(typeof evidence.artifactPath).toBe("string");
    expect(typeof evidence.artifactRelPath).toBe("string");
    expect(String(evidence.artifactRelPath)).toContain(`traces/${submitted.id}/terminal-`);

    // The artifact file actually exists and contains the full output.
    const artifactPath = String(evidence.artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const body = readFileSync(artifactPath, "utf8");
    expect(body).toContain("--- stdout");
    expect(body).toContain("--- stderr");
    expect(body.length).toBeGreaterThan(4000);

    // The trace record for the executed command also references the artifact
    // so the Tasks timeline UI can surface a "View full output" affordance.
    const trace = readTrace(config.instance, submitted.id);
    const toolRecord = trace.find(
      (record) => record.type === "tool" && record.message === "Command executed"
    );
    expect(toolRecord).toBeDefined();
    const data = toolRecord!.data as Record<string, unknown>;
    expect(data.stdoutTruncated).toBe(true);
    expect(typeof data.artifactRelPath).toBe("string");
  });

  test("reports V1 readiness from runtime evidence", async () => {
    const config = testConfig("readiness");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "readiness", payload: { name: "readiness" } })
    });
    const readiness = await call(handler, config, "/api/readiness/v1");

    expect(readiness.ok).toBe(true);
    expect(readiness.checks.some((item: { id: string; status: string }) => item.id === "future_app_contracts" && item.status === "pass")).toBe(true);
  });

  test("models chat work as conversation runs with plan steps and compatibility tasks", async () => {
    const config = testConfig("conversation-runs");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "Planful chat" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "remember conversation runs are the execution layer" })
    });
    await waitForTask(handler, config, submitted.taskId);
    await call(handler, config, `/api/chat/${session.id}/tasks/${submitted.taskId}/sync`, { method: "POST" });

    const run = await call(handler, config, `/api/runs/${submitted.runId}`);
    const chat = await call(handler, config, `/api/chat/${session.id}`);
    const runs = await call(handler, config, "/api/runs");

    expect(run.kind).toBe("conversation_turn");
    expect(run.status).toBe("completed");
    expect(run.task.id).toBe(submitted.taskId);
    expect(run.planSteps.length).toBeGreaterThanOrEqual(2);
    expect(chat.runIds).toContain(submitted.runId);
    expect(chat.messages.some((message: { role: string; runId?: string }) => message.role === "assistant" && message.runId === submitted.runId)).toBe(true);
    expect(runs.some((item: { id: string }) => item.id === submitted.runId)).toBe(true);
  });

  test("GET /api/providers/catalog carries the persistent per-provider auth status", async () => {
    const config = testConfig("providers-catalog-auth");
    const handler = createHandler(config);

    // No failure records: every row reads ok with no reauth payload.
    const clean = await call(handler, config, "/api/providers/catalog");
    expect(clean.every((row: { authStatus?: string; reauth?: unknown }) => row.authStatus === "ok" && row.reauth === undefined)).toBe(true);

    // Record a codex auth failure (what failTask persists on a
    // ProviderAuthError, issue #233) and re-read the catalog.
    await mutateState(config.instance, (state) => {
      recordProviderAuthFailure(state, {
        provider: "codex",
        detail: "Provided authentication token is expired.",
        taskId: "task_catalog"
      });
    });
    const flagged = await call(handler, config, "/api/providers/catalog");
    const codex = flagged.find((row: { name: string }) => row.name === "codex");
    expect(codex.authStatus).toBe("needs_reauth");
    expect(codex.reauth).toMatchObject({
      detail: "Provided authentication token is expired.",
      reauthKind: "docs",
      reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
    });
    expect(typeof codex.reauth.at).toBe("string");
    // Unaffected rows stay ok.
    const openai = flagged.find((row: { name: string }) => row.name === "openai");
    expect(openai.authStatus).toBe("ok");
    expect(openai.reauth).toBeUndefined();
  });

  test("connector CRUD round-trips through /api/connectors without persisting plaintext secrets", async () => {
    const config = testConfig("connector-crud");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/connectors", {
      method: "POST",
      body: JSON.stringify({ provider: "linear", name: "primary linear", scopes: ["read"], secrets: { token: "lin_secret_abc" } })
    });

    expect(created.provider).toBe("linear");
    expect(created.secretRefs).toHaveLength(1);
    expect(created.secretRefs[0].purpose).toBe("token");
    // User-source default — only the auto-detection job emits "auto".
    expect(created.source).toBe("user");
    const raw = readFileSync(`${config.stateRoot}/state.json`, "utf8");
    expect(raw).not.toContain("lin_secret_abc");

    const listed = await call(handler, config, "/api/connectors");
    expect(listed.some((item: { id: string }) => item.id === created.id)).toBe(true);

    await call(handler, config, `/api/connectors/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ secrets: { token: "lin_secret_xyz" } })
    });
    const auditAfterRotate = readState(config.instance).audit;
    expect(auditAfterRotate.some((event) => event.action === "connector.rotate")).toBe(true);

    await call(handler, config, `/api/connectors/${created.id}`, { method: "DELETE" });
    const after = await call(handler, config, "/api/connectors");
    expect(after.some((item: { id: string }) => item.id === created.id)).toBe(false);
    expect(existsSync(`${config.stateRoot}/secrets/${created.id}.token.json`)).toBe(false);
  });

  test("deleting an auto-source connector tombstones the record with status=disabled", async () => {
    const config = testConfig("connector-tombstone");
    const handler = createHandler(config);
    // Seed an auto-source connector directly on state (detection runs on
    // the live gateway; this test boots a one-shot handler so we inject
    // the record by hand).
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.connectors.push({
        id: "id_auto_test",
        instance: state.instance,
        name: "auto-codex",
        provider: "codex",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "auto"
      });
    });
    const result = await call(handler, config, "/api/connectors/id_auto_test", { method: "DELETE" });
    expect(result.tombstoned).toBe(true);
    const state = readState(config.instance);
    const record = state.connectors.find((c) => c.id === "id_auto_test");
    expect(record?.status).toBe("disabled");
    expect(state.audit.some((event) => event.action === "connector.disable")).toBe(true);
  });

  test("POST /api/connectors/detect runs the detection job and is idempotent", async () => {
    const config = testConfig("connector-detect-endpoint");
    const handler = createHandler(config);
    // Stub the only two providers with a host-shelling detect() so the run
    // is deterministic and never spawns `which` / `claude auth status`.
    // claude-code detects positive → the first endpoint call creates an
    // auto-source connector; codex detects negative. The second call must
    // then skip claude-code with reason "exists", exercising the full
    // create-then-skip idempotency contract through the HTTP route.
    const restoreClaude = stubProviderDetect("claude-code", {
      detected: true,
      suggestedName: "Claude Code",
      message: "stub"
    });
    const restoreClaudeProbe = stubProviderProbe("claude-code", { ok: true, message: "stub" });
    const restoreCodex = stubProviderDetect("codex", { detected: false });
    try {
      const first = await call(handler, config, "/api/connectors/detect", { method: "POST" });
      expect(first).toHaveProperty("considered");
      expect(first).toHaveProperty("created");
      expect((first.created as Array<{ provider: string }>).map((c) => c.provider)).toContain("claude-code");
      // The second call should not create any new records — the detection
      // logic is idempotent at the registry+state level.
      const second = await call(handler, config, "/api/connectors/detect", { method: "POST" });
      const createdProviders = (second.created as Array<{ provider: string }>).map((c) => c.provider);
      expect(createdProviders).toEqual([]);
      expect((second.skipped as Array<{ provider: string; reason: string }>).find((s) => s.provider === "claude-code")?.reason).toBe("exists");
    } finally {
      restoreClaude();
      restoreClaudeProbe();
      restoreCodex();
    }
  });

  test("GET /api/connectors/providers returns the registry", async () => {
    const config = testConfig("providers-list");
    const handler = createHandler(config);
    const providers = await call(handler, config, "/api/connectors/providers");
    expect(Array.isArray(providers)).toBe(true);
    const ids = providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("demo");
    expect(ids).toContain("linear");
    expect(ids).toContain("generic");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    // Credential templates: linear (single env binding) → api-key prefill
    // with the MCP URL + server name; google-oauth-desktop (two bindings) →
    // oauth2 envMap.
    const linear = providers.find((p: { id: string }) => p.id === "linear");
    expect(linear.credentialTemplate).toEqual({
      type: "api-key",
      name: "LINEAR_API_KEY",
      mcpUrl: "https://mcp.linear.app/mcp",
      mcpName: "linear"
    });
    const gws = providers.find((p: { id: string }) => p.id === "google-oauth-desktop");
    expect(gws.credentialTemplate.type).toBe("oauth2");
    expect(gws.credentialTemplate.envMap).toEqual({
      client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
    });
    // Presence-only providers (no secret spec) carry no template.
    const demo = providers.find((p: { id: string }) => p.id === "demo");
    expect(demo.credentialTemplate).toBeUndefined();
  });

  test("POST /api/connectors threads a typed api-key credential through createConnector", async () => {
    const config = testConfig("connector-typed-create");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/connectors", {
      method: "POST",
      body: JSON.stringify({
        provider: "generic",
        name: "MY_SERVICE_KEY",
        type: "api-key",
        secrets: { MY_SERVICE_KEY: "lin_secret_typed" },
        metadata: { mcp: { url: "https://mcp.example.com/mcp", headerName: "Authorization", scheme: "Bearer" } }
      })
    });
    expect(created.type).toBe("api-key");
    expect(created.name).toBe("MY_SERVICE_KEY");
    expect(created.metadata.mcp.url).toBe("https://mcp.example.com/mcp");
    expect(created.secretRefs).toHaveLength(1);
    expect(created.secretRefs[0].purpose).toBe("MY_SERVICE_KEY");
    const raw = readFileSync(`${config.stateRoot}/state.json`, "utf8");
    expect(raw).not.toContain("lin_secret_typed");
  });

  test("POST /api/setup-requests/<id>/complete creates a connector and resolves the setup request on probe success", async () => {
    const config = testConfig("setup-requests-complete-happy");
    const handler = createHandler(config);
    // Stage a connector.request setup-request row directly. Demo provider has
    // no probe, so checkConnector falls back to presence-only => healthy
    // without any network mocking.
    const { createSetupRequest } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "demo",
        reason: "test connect",
        payload: {
          provider: "demo",
          providerLabel: "Demo",
          providerDescription: "Demo provider",
          reason: "test connect",
          fields: [],
          toolCallId: "call_demo_1"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: {}, scopes: [] })
    });
    expect(response.ok).toBe(true);
    expect(response.connector.provider).toBe("demo");
    expect(response.connector.health).toBe("healthy");

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    expect(resolved?.status).toBe("completed");
    expect(state.connectors.some((c) => c.provider === "demo" && c.health === "healthy")).toBe(true);
  });

  test("POST /api/setup-requests/<id>/complete grants the connector and enables the skill for skill.grant_connector", async () => {
    const config = testConfig("setup-complete-skill-grant");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-linear",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredConnectors: [{ provider: "linear" }]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-linear requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_1"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(true);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    expect(resolved?.status).toBe("completed");
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.status).toBe("enabled");
    expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    expect(state.audit.some((a) => a.action === "skill.connector.granted")).toBe(true);
  });

  test("POST /api/setup-requests/<id>/complete: a templateless connector.request creates a typed api-key, grants + enables the skill, and records no secret", async () => {
    const config = testConfig("setup-complete-templateless");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-some-service",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["SOME_SERVICE_API_KEY"]
      })
    );
    // Templateless payload: no `provider`, carries credentialType/Name/Label +
    // skillId (exactly what requestConnectorTool mints).
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "SOME_SERVICE_API_KEY",
        reason: "Enter your Some Service API key",
        payload: {
          credentialName: "SOME_SERVICE_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Some Service",
          skillId: skill.id,
          reason: "Enter your Some Service API key",
          toolCallId: "call_tl_complete"
        }
      })
    );

    const secretValue = "sk-some-service-super-secret";
    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { SOME_SERVICE_API_KEY: secretValue } })
    });
    expect(response.ok).toBe(true);
    expect(response.connector.health).toBe("healthy");

    const state = readState(config.instance);
    // A TYPED api-key record landed under the requested name.
    const connector = state.connectors.find((c) => c.name === "SOME_SERVICE_API_KEY");
    expect(connector).toBeDefined();
    expect(connector?.type).toBe("api-key");
    // The requesting skill was granted the credential and enabled (its only
    // required credential is now granted).
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors).toEqual(["SOME_SERVICE_API_KEY"]);
    expect(updated?.status).toBe("enabled");
    // The setup request resolved.
    expect(state.setupRequests.find((a) => a.id === approval.id)?.status).toBe("completed");
    // The audit row for connector.request carries the credential name but NO
    // secret value — the secret stays server-side.
    const requestAudit = state.audit.find((a) => a.action === "connector.request");
    expect(requestAudit).toBeDefined();
    expect((requestAudit?.evidence as Record<string, unknown>)?.credentialName).toBe("SOME_SERVICE_API_KEY");
    expect(JSON.stringify(state.audit)).not.toContain(secretValue);
  });

  test("POST /api/setup-requests/<id>/complete: a known-provider connector.request with skillId grants + enables the skill", async () => {
    const config = testConfig("setup-complete-known-grant");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    // demo provider has no probe (presence-only healthy) and no credential
    // template, so its record stays untyped — to exercise the grant we point
    // the skill's requiredCredentials at the connector name the demo create
    // lands ("Demo") and assert the grant is recorded. firstUngrantedCredential
    // only blocks on TYPED credentials, so an untyped demo connector enables.
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-demo",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["Demo"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "demo",
        reason: "connect demo",
        payload: {
          provider: "demo",
          providerLabel: "Demo",
          providerDescription: "Demo provider",
          fields: [],
          skillId: skill.id,
          reason: "connect demo",
          toolCallId: "call_known_complete"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: {}, scopes: [] })
    });
    expect(response.ok).toBe(true);
    expect(response.connector.provider).toBe("demo");

    const state = readState(config.instance);
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors).toEqual(["Demo"]);
    expect(updated?.status).toBe("enabled");
  });

  test("POST /api/setup-requests/<id>/complete: a known-provider (linear) connector.request creates a TYPED LINEAR_API_KEY, grants + enables the requesting skill", async () => {
    // Real template-path regression: a connector.request for {provider:"linear",
    // skillId} must land a TYPED LINEAR_API_KEY record (stamped from the
    // module's credentialTemplate), and because the requesting skill declares
    // LINEAR_API_KEY, completing the card grants it and enables the skill — no
    // second consent card. The demo provider can't prove this (it's untyped /
    // presence-only); linear has both a credentialTemplate and a live probe, so
    // we stub a healthy viewer query.
    const config = testConfig("setup-complete-linear-typed-grant");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-linear-typed",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["LINEAR_API_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "linear",
        reason: "connect linear",
        payload: {
          provider: "linear",
          providerLabel: "Linear",
          providerDescription: "Linear",
          fields: [],
          skillId: skill.id,
          reason: "connect linear",
          toolCallId: "call_linear_typed"
        }
      })
    );

    // Stub the Linear GraphQL probe with a healthy viewer so checkConnector
    // flips the typed record to healthy without a live network call.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "Tester", email: "t@e.co" } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    let response: { ok: boolean; connector?: { provider?: string } };
    try {
      response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { token: "lin_api_realish" } })
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(response.ok).toBe(true);

    const state = readState(config.instance);
    // The Linear template stamps a TYPED api-key record named LINEAR_API_KEY.
    const connector = state.connectors.find((c) => c.provider === "linear");
    expect(connector?.type).toBe("api-key");
    expect(connector?.name).toBe("LINEAR_API_KEY");
    expect(connector?.health).toBe("healthy");
    // The requesting skill (declares LINEAR_API_KEY) was granted + enabled.
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    expect(updated?.status).toBe("enabled");
    // No secret value leaked into the audit log.
    expect(JSON.stringify(state.audit)).not.toContain("lin_api_realish");
  });

  test("POST /api/setup-requests/<id>/complete: skillId for a skill that does NOT declare the credential creates the connector but does NOT grant or enable", async () => {
    // Auto-grant trust guard: the model supplies skillId, so /complete must
    // verify the named skill actually declares connector.name before granting.
    // A skill that does not declare the credential gets the connector created
    // (so the credential exists) but is neither granted the credential nor
    // enabled — "a skill only gets credentials it declared + the user granted".
    const config = testConfig("setup-complete-undeclared-no-grant");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "wants-other-cred",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        // Declares a DIFFERENT credential than the one being requested.
        requiredCredentials: ["OTHER_API_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "SOME_SERVICE_API_KEY",
        reason: "Enter your Some Service API key",
        payload: {
          credentialName: "SOME_SERVICE_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Some Service",
          skillId: skill.id,
          reason: "Enter your Some Service API key",
          toolCallId: "call_undeclared"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { SOME_SERVICE_API_KEY: "sk-secret" } })
    });
    expect(response.ok).toBe(true);

    const state = readState(config.instance);
    // The connector was created (the credential now exists).
    expect(state.connectors.some((c) => c.name === "SOME_SERVICE_API_KEY")).toBe(true);
    // But the skill — which never declared SOME_SERVICE_API_KEY — was NOT
    // granted it and stays disabled.
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors ?? []).not.toContain("SOME_SERVICE_API_KEY");
    expect(updated?.status).toBe("disabled");
  });

  test("POST /api/setup-requests/<id>/complete: a multi-credential skill grants the requested credential but stays DISABLED while another required credential has no connector", async () => {
    // Enable-when-fully-satisfied: a skill that requires two credentials and
    // only just got the first must NOT be enabled while the second has no
    // connector row at all. firstUngrantedCredential alone misses this (it
    // skips required creds with no connector); isSkillActive catches it.
    const config = testConfig("setup-complete-partial-multi-disabled");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-two-creds",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        // SECOND_API_KEY has no connector yet — it'll be requested separately.
        requiredCredentials: ["FIRST_API_KEY", "SECOND_API_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "FIRST_API_KEY",
        reason: "Enter your first API key",
        payload: {
          credentialName: "FIRST_API_KEY",
          credentialType: "api-key",
          credentialLabel: "First",
          skillId: skill.id,
          reason: "Enter your first API key",
          toolCallId: "call_first"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { FIRST_API_KEY: "sk-first" } })
    });
    expect(response.ok).toBe(true);

    const state = readState(config.instance);
    const updated = state.skills.find((s) => s.id === skill.id);
    // The requested credential was granted (the human entered it for this skill).
    expect(updated?.grantedConnectors).toEqual(["FIRST_API_KEY"]);
    // But the skill stays disabled — SECOND_API_KEY still has no connector.
    expect(updated?.status).toBe("disabled");
  });

  test("POST /api/setup-requests/<id>/complete on a multi-provider skill grants one provider, stays disabled, and mints the next grant card", async () => {
    const config = testConfig("setup-complete-skill-grant-multi");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    await seedTypedCredential(config, "LINEAR_API_KEY", "linear");
    await seedTypedCredential(config, "GENERIC_KEY", "generic");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-two",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["LINEAR_API_KEY", "GENERIC_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-two requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_multi"
        }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(true);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    expect(resolved?.status).toBe("completed");
    const updated = state.skills.find((s) => s.id === skill.id);
    // Only the first credential is granted; the skill stays disabled until the
    // remaining credential is granted too.
    expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    expect(updated?.status).toBe("disabled");
    // A new pending grant card was minted for the remaining credential.
    const next = state.setupRequests.find(
      (s) => s.status === "pending" && s.action === "skill.grant_connector" && s.payload.credentialName === "GENERIC_KEY"
    );
    expect(next).toBeDefined();
    expect(next?.payload.skillId).toBe(skill.id);
  });

  test("POST /api/setup-requests/<id>/complete: a double-complete of one grant request resolves once and mints exactly one next card", async () => {
    const config = testConfig("setup-complete-skill-grant-double");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    await seedTypedCredential(config, "LINEAR_API_KEY", "linear");
    await seedTypedCredential(config, "GENERIC_KEY", "generic");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-two-double",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["LINEAR_API_KEY", "GENERIC_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-two-double requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_double"
        }
      })
    );

    // Fire two completes of the SAME request. The mutateState lock serializes
    // the atomic claim, so exactly one wins; the loser hits the already-
    // resolved guard and mints nothing. No extra pending grant row.
    const [a, b] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token)
    ]);
    const oks = [a.ok, b.ok];
    expect(oks.filter(Boolean).length).toBe(1);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    expect(resolved?.status).toBe("completed");
    // Exactly one next card for the remaining credential — no duplicate from
    // the losing racer.
    const next = state.setupRequests.filter(
      (s) => s.status === "pending" && s.action === "skill.grant_connector" && s.payload.credentialName === "GENERIC_KEY"
    );
    expect(next.length).toBe(1);
    // No stray pending grant rows beyond that single next card.
    const pendingGrants = state.setupRequests.filter(
      (s) => s.status === "pending" && s.action === "skill.grant_connector"
    );
    expect(pendingGrants.length).toBe(1);
  });

  test("POST /api/setup-requests/<id>/complete: a double-complete of the FINAL grant request enables once and writes exactly one skill.enabled audit and one grant", async () => {
    const config = testConfig("setup-complete-skill-grant-final-double");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill, createTask, upsertTask } = await import("./state");
    // A single-provider skill so completing the one grant card is the FINAL
    // step (no next card): the winner records the grant, enables the skill,
    // and resumes the task. A losing racer must produce ZERO side effects —
    // no duplicate grant, no duplicate skill.enabled audit, no second resume.
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-linear-final-double",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredConnectors: [{ provider: "linear" }]
      })
    );
    // Seed a terminal task so the resume branch is exercised but bails fast
    // (resumeChatTask no-ops on a completed task) instead of polling for a
    // waiting_approval flip that never comes.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "grant final double");
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-linear-final-double requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_final_double"
        }
      })
    );

    const [a, b] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token)
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    expect(resolved?.status).toBe("completed");
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.status).toBe("enabled");
    // Exactly one grant — the loser double-granted nothing.
    expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    // Exactly ONE skill.enabled audit row (the loser produced no second one).
    expect(state.audit.filter((a) => a.action === "skill.enabled").length).toBe(1);
    // Exactly ONE grant audit row.
    expect(state.audit.filter((a) => a.action === "skill.connector.granted").length).toBe(1);
    // No extra pending grant rows from the losing racer.
    expect(
      state.setupRequests.filter((s) => s.status === "pending" && s.action === "skill.grant_connector").length
    ).toBe(0);
  });

  test("POST /api/setup-requests/<id>/complete vs cancel on the same grant card: Cancel prevents the grant+enable", async () => {
    const config = testConfig("setup-complete-skill-grant-cancel-race");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill, createTask, upsertTask } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-linear-cancel-race",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredConnectors: [{ provider: "linear" }]
      })
    );
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "grant cancel race");
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-linear-cancel-race requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_cancel_race"
        }
      })
    );

    // Race a complete against a cancel on the SAME card. The per-instance
    // mutateState lock serializes the two pending→terminal transitions, so
    // exactly one wins. The consent gate must be honored: whichever side wins,
    // a grant+enable happens ONLY if complete won — a winning cancel leaves the
    // skill disabled and ungranted.
    const [completeRes, cancelRes] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token)
    ]);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    const updated = state.skills.find((s) => s.id === skill.id);
    const granted = state.audit.some((a) => a.action === "skill.connector.granted");
    const enabled = state.audit.some((a) => a.action === "skill.enabled");

    if (resolved?.status === "cancelled") {
      // Cancel won — the consent gate is honored: NO grant, NO enable.
      expect(completeRes.ok).toBe(false);
      expect(updated?.status).toBe("disabled");
      expect(updated?.grantedConnectors ?? []).toEqual([]);
      expect(granted).toBe(false);
      expect(enabled).toBe(false);
    } else {
      // Complete won — cancel is a no-op against the now-completed row, and
      // the skill is granted+enabled.
      expect(resolved?.status).toBe("completed");
      expect(cancelRes.ok).toBe(false);
      expect(updated?.status).toBe("enabled");
      expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
      expect(granted).toBe(true);
      expect(enabled).toBe(true);
    }
  });

  test("POST /api/setup-requests/<id>/complete returns ok:false, claims the request, and cleans up the connector on probe failure", async () => {
    const config = testConfig("setup-requests-complete-probe-fail");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "linear",
        reason: "fetch issues",
        payload: {
          provider: "linear",
          providerLabel: "Linear",
          providerDescription: "Linear",
          reason: "fetch issues",
          fields: [],
          toolCallId: "call_linear_fail"
        }
      })
    );
    // Stub the Linear GraphQL probe with a 401 so the probe fails.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{\"errors\":[{\"message\":\"Unauthorized\"}]}", {
      status: 401,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    try {
      const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { token: "not-a-real-token" } })
      });
      expect(response.ok).toBe(false);
      expect(response.message).toBeString();
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The row was claimed BEFORE the create (claim-first race safety), so a
    // probe failure cannot bounce it back to pending — it stays completed
    // with a persisted failure outcome, and the orphaned unhealthy connector
    // is cleaned up so it never lingers as a half-configured record.
    const state = readState(config.instance);
    const after = state.setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("completed");
    expect(after?.connectOutcome?.ok).toBe(false);
    expect(state.connectors.some((c) => c.provider === "linear")).toBe(false);
  });

  test("POST /api/setup-requests/<id>/complete: an UNEXPECTED post-claim throw resumes the task instead of stranding it", async () => {
    // Strand-the-task regression: after the winning claim, createConnector /
    // grant / enable / resume can still throw (here: a duplicate credential
    // name). The route's catch-all would return 500 while the setup row sits
    // `completed` and the task stays `waiting_approval` — orphaned. The fix
    // wraps the whole post-claim block: any throw persists a failure outcome
    // and resumes the task. We seed a genuine waiting_approval task with a
    // resumable toolCallState (one pending request_connector call) so the
    // resume re-enters the echo loop and the task settles terminally.
    const config = testConfig("setup-complete-postclaim-throw");
    const handler = createHandler(config);
    const { createSetupRequest, createTask, upsertTask } = await import("./state");

    // Pre-seed a connector under the requested name so createConnector throws
    // on instance-wide name uniqueness AFTER the claim.
    await seedTypedCredential(config, "DUP_API_KEY", "generic");

    const toolCallId = "call_postclaim_throw";
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "needs dup key");
      task.status = "waiting_approval";
      task.toolCallState = {
        messages: [
          { role: "system", content: "you are gini" },
          { role: "user", content: "connect dup" },
          { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "request_connector", arguments: "{}" } }] }
        ],
        toolsHash: "test",
        pending: [{ toolCallId, toolName: "request_connector", approvalId: "" }],
        iterations: 1
      };
      upsertTask(state, task);
      return task.id;
    });

    const approval = await mutateState(config.instance, (state) => {
      const a = createSetupRequest(state, {
        taskId,
        action: "connector.request",
        target: "DUP_API_KEY",
        reason: "Enter your Dup API key",
        payload: {
          credentialName: "DUP_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Dup",
          reason: "Enter your Dup API key",
          toolCallId
        }
      });
      // Bind the approval to the task so the pending entry resolves on resume.
      const item = state.tasks.find((t) => t.id === taskId)!;
      item.toolCallState!.pending[0]!.approvalId = a.id;
      item.approvalIds.push(a.id);
      return a;
    });

    const raw = await rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { DUP_API_KEY: "dup-secret" } })
    }, config.token);
    const response = await raw.json();
    // The route returned a structured failure body (the outcome + resume ran;
    // it is NOT the bare catch-all 500 that bypasses both).
    expect(response.ok).toBe(false);
    expect(response.message).toBeString();

    const settled = await waitForTask(handler, config, taskId);
    // The task RESUMED — it is no longer stranded at waiting_approval.
    expect(settled.task.status).not.toBe("waiting_approval");

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    // The setup row is claimed (resolved) with a persisted failure outcome.
    expect(resolved?.status).toBe("completed");
    expect(resolved?.connectOutcome?.ok).toBe(false);
    // No duplicate connector was created — only the pre-seeded one remains.
    expect(state.connectors.filter((c) => c.name === "DUP_API_KEY").length).toBe(1);
  });

  test("POST /api/setup-requests/<id>/complete: a double-submit of a connector.request resolves once with no extra mutations", async () => {
    // Claim-first race safety for connector.request: two concurrent completes
    // of the same card — the mutateState lock serializes the atomic claim, so
    // exactly one wins and creates exactly one connector; the loser produces
    // zero side effects.
    const config = testConfig("setup-complete-connector-double");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-race-key",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["RACE_API_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "RACE_API_KEY",
        reason: "Enter your Race API key",
        payload: {
          credentialName: "RACE_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Race",
          skillId: skill.id,
          reason: "Enter your Race API key",
          toolCallId: "call_race"
        }
      })
    );

    const [a, b] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { RACE_API_KEY: "race-secret" } })
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { RACE_API_KEY: "race-secret" } })
      }, config.token)
    ]);
    // Exactly one winner.
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    expect(resolved?.status).toBe("completed");
    // Exactly one connector created — the loser created nothing.
    expect(state.connectors.filter((c) => c.name === "RACE_API_KEY").length).toBe(1);
    // The skill was granted the credential exactly once and enabled.
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors).toEqual(["RACE_API_KEY"]);
    expect(updated?.status).toBe("enabled");
    // Exactly one grant audit row from the single winner.
    expect(state.audit.filter((au) => au.action === "skill.connector.granted").length).toBe(1);
  });

  test("POST /api/setup-requests/<id>/complete 404s for an authorization id", async () => {
    const config = testConfig("setup-requests-complete-wrong-collection");
    const handler = createHandler(config);
    const { createAuthorization } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createAuthorization(state, {
        action: "file.write",
        target: "/tmp/x",
        risk: "high",
        reason: "stub",
        payload: { path: "/tmp/x", content: "hi" }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      { method: "POST", body: JSON.stringify({ secrets: {} }) },
      config.token
    );
    // Authorization ids never appear in the setupRequests collection, so
    // /complete returns 404 — the two endpoint families are independent.
    expect(response.status).toBe(404);
  });

  test("POST /api/setup-requests/<id>/complete creates a messaging bridge and resolves the setup request", async () => {
    // Happy-path pin for the chat-side Add Telegram flow. The card's
    // Submit button POSTs the name + bot token under `secrets`; the
    // gateway routes them into addMessagingBridge (the same code path
    // the CLI and the settings page already call) and resolves the
    // setup request so the chat-task loop can resume.
    const config = testConfig("setup-complete-bridge-happy");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "chat-test-bridge", toolCallId: "call_bridge_happy" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { name: "chat-test-bridge", botToken: "1234:ABCDEFGHIJKLMNOPQR" } })
    });
    expect(response.ok).toBe(true);
    expect(response.bridge?.name).toBe("chat-test-bridge");
    expect(response.bridge?.kind).toBe("telegram");

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === setup.id);
    expect(resolved?.status).toBe("completed");
    const bridge = state.messagingBridges.find((b) => b.name === "chat-test-bridge");
    expect(bridge).toBeDefined();
    expect(bridge?.kind).toBe("telegram");

    // Audit-row traceability pin: the chat-card create writes a
    // dedicated audit row with the originating setup-request id AND the
    // resulting bridge.id so operators can reconstruct
    // "setup X via chat-card → bridge Y" from the activity feed.
    // Without this row the chat path is indistinguishable from the
    // CLI / settings dialog in the audit log (both write the same
    // generic messaging.configured row via createMessagingBridgeRecord).
    const chatAddRow = state.audit.find(
      (e) => e.action === "messaging.add_bridge" && e.approvalId === setup.id
    );
    expect(chatAddRow).toBeDefined();
    expect(chatAddRow?.target).toBe(bridge?.id);
    expect((chatAddRow?.evidence as { kind?: string } | undefined)?.kind).toBe("telegram");
    expect((chatAddRow?.evidence as { bridgeName?: string } | undefined)?.bridgeName).toBe("chat-test-bridge");

    // Durable outcome pin: the /complete handler writes
    // setup.connectOutcome so a post-reload render of the resolved
    // card reads the truthful past-tense summary. Without this, the
    // React component's sticky state evaporates on reload and the
    // card would fall back to "Bridge added." even when the side
    // effect actually failed.
    expect(resolved?.connectOutcome?.ok).toBe(true);
    expect(resolved?.connectOutcome?.message).toContain("chat-test-bridge");
  });

  test("POST /api/setup-requests/<id>/complete refuses messaging.add_bridge that was already cancelled, and creates no bridge", async () => {
    // Race-safety pin: the messaging.add_bridge branch must resolve the
    // setup request BEFORE addMessagingBridge so a concurrent /cancel
    // (or cancel cascade) cannot leave an orphan bridge + encrypted
    // secret on disk after the user has already abandoned the prompt.
    // Mirrors the resolve-first contract in
    // src/execution/browser-fill-secrets.ts. We simulate the race by
    // pre-cancelling the setup request and then hitting /complete — the
    // handler must short-circuit at the "already !pending" guard,
    // return 410, and never touch addMessagingBridge.
    const config = testConfig("setup-complete-bridge-cancel-race");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "race-bridge", toolCallId: "call_bridge_race" }
      })
    );
    // Pre-cancel the setup request as if a concurrent operator had
    // clicked Cancel between the user's typing and the Submit landing
    // on the server.
    await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
    const beforeBridges = readState(config.instance).messagingBridges.length;

    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${setup.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { name: "race-bridge", botToken: "1234:ABCDEFGHIJKL" } })
      },
      config.token
    );
    // 410 Gone — the resolution-before-creation contract is upheld by
    // the outer "already !pending" guard. The load-bearing invariant
    // is the absence of any bridge / orphan secret on the other side.
    expect(response.status).toBe(410);

    const after = readState(config.instance);
    expect(after.messagingBridges.length).toBe(beforeBridges);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
  });

  test("POST /api/setup-requests/<id>/complete rejects malformed messaging.add_bridge tokens BEFORE resolving the setup request", async () => {
    // Token-format pre-check: addMessagingBridge runs
    // assertHeaderSafeToken internally, and the chat card disappears
    // once the setup request flips out of pending state. Without
    // pre-resolve token validation, a malformed token would burn the
    // request and the user could not retype from the same card.
    // The bounded module calls assertHeaderSafeToken BEFORE resolving;
    // this test pins that ordering by submitting a token with a control
    // character and asserting the request stays pending.
    const config = testConfig("setup-complete-bridge-bad-token-stays-pending");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "bad-token", toolCallId: "call_bridge_bad_token" }
      })
    );
    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      // Control character in the token — assertHeaderSafeToken
      // refuses any byte outside printable ASCII [\x21-\x7E].
      body: JSON.stringify({ secrets: { name: "bad-token", botToken: "1234:abc\ndef" } })
    });
    expect(response.ok).toBe(false);
    expect(typeof response.message).toBe("string");

    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
    expect(after.messagingBridges.length).toBe(0);
  });

  test("POST /api/setup-requests/<id>/complete returns ok:false when messaging.add_bridge is missing a name or token", async () => {
    // The chat card disables Submit until both inputs are non-empty,
    // but a CLI/API caller could POST a partial body. The gateway
    // mirrors the same readiness gate as the card so a partial
    // submission can't silently create a half-configured bridge.
    const config = testConfig("setup-complete-bridge-missing");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "missing-fields", toolCallId: "call_bridge_missing" }
      })
    );
    const missingToken = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { name: "missing-fields" } })
    });
    expect(missingToken.ok).toBe(false);
    expect(missingToken.message).toContain("Bot token");

    const missingName = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { botToken: "1234:ABCDEFGHIJ" } })
    });
    expect(missingName.ok).toBe(false);
    expect(missingName.message).toContain("name");

    // Both rejections must leave the setup request pending — otherwise
    // the chat card would flip out of pending state and the user
    // couldn't retry.
    const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
    expect(after?.status).toBe("pending");
  });

  test("screencast frames + input endpoints 404 for an unknown setup request", async () => {
    const config = testConfig("screencast-404");
    const handler = createHandler(config);
    const frames = await rawCall(handler, config, "/api/browser/screencast/nope/frames", {}, config.token);
    expect(frames.status).toBe(404);
    const input = await rawCall(handler, config, "/api/browser/screencast/nope/input", {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(input.status).toBe(404);
  });

  test("screencast frames returns 409 when no spawned browser is running", async () => {
    // A real browser.connect setup exists, but there's no live spawned Chrome
    // in this unit-test context, so the bridge fails to start and the endpoint
    // surfaces 409 rather than opening an empty stream.
    const config = testConfig("screencast-no-browser");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in to continue",
        payload: { toolCallId: "call_sc", signInStarted: true, screencast: true }
      })
    );
    const frames = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(frames.status).toBe(409);
    const input = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/input`, {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(input.status).toBe(409);
  });

  test("open-browser 409s with the no-URL message when no browser is live and no page URL is recorded", async () => {
    // A pending browser.connect with no live spawned Chrome AND no recorded url
    // can't relaunch anything to screencast, so it 409s with the distinct
    // no-URL message rather than attempting a blind navigate.
    const config = testConfig("open-browser-no-url-no-browser");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_no_url" }
      })
    );
    const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no page URL is recorded");
    // The row stays pending so a later retry (once a browser is live) works.
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });

  test("open-browser attempts a headless relaunch+navigate when a URL is recorded but no browser is live", async () => {
    // Restart/crash/disconnect drops the in-process spawned handle while the
    // durable card survives. With a recorded url, open-browser relaunches the
    // headless Chrome and navigates to it (the spawn-only replacement for the
    // removed managed relaunch) instead of stranding the user. We STUB the spawn
    // launcher to throw so the relaunch fails deterministically (no dependence
    // on ambient "is real Chrome installed?"), proving the recovery path was
    // taken and surfaces a 409 with the row left pending for a later real retry.
    const config = testConfig("open-browser-relaunch-attempt");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const browserMod = await import("./tools/browser");
    const browserTest = browserMod.__test;
    browserMod.setBrowserInstance(config.instance);
    browserTest.setSpawnChromeForTest(async () => {
      throw new Error("stubbed: no Chrome in this unit test");
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "Sign in",
          reason: "Sign in",
          payload: { toolCallId: "call_relaunch", url: "https://example.com/login" }
        })
      );
      const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      expect(res.status).toBe(409);
      const body = await res.json();
      // Distinct from the no-URL message: this 409 came from the relaunch attempt.
      expect(body.error).not.toContain("no page URL is recorded");
      expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
    } finally {
      browserTest.setSpawnChromeForTest(null);
      browserTest.uninstallFakeBrowserForTest();
      browserTest.resetBrowserInstanceForTest();
    }
  });

  test("open-browser refuses (no relaunch/navigate) when the user's Chrome is attached over CDP", async () => {
    // A stale Connect card racing a later cdp attach: the screencast streams the
    // SPAWNED Chrome, but the user is on cdp. /open-browser must NOT relaunch +
    // navigate the user's external Chrome to the recorded URL — it refuses with
    // the cdp-specific 409 BEFORE any navigation. (The dispatch guard stops NEW
    // cards on cdp; this covers an already-minted card hitting /open-browser.)
    const config = testConfig("open-browser-cdp-refuse");
    const handler = createHandler(config);
    const { createSetupRequest, now } = await import("./state");
    const setup = await mutateState(config.instance, (state) => {
      // Active cdp transport + a stale card carrying a recorded URL.
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: now() };
      return createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_cdp_stale", url: "https://example.com/login" }
      });
    });
    const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain("attached over CDP");
    // The card was NOT stamped as a live screencast (no navigation happened).
    const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
    expect(after?.status).toBe("pending");
    expect(after?.payload.signInStarted).toBeUndefined();
    expect(after?.payload.screencast).toBeUndefined();
  });

  test("frames reconnect on an already-stamped card relaunches the browser when none is live", async () => {
    // After a gateway/Chrome restart, an already-stamped sign-in card (screencast
    // + signInStarted, still pending) skips /open-browser — the modal reconnects
    // straight to /frames. So /frames must itself attempt the headless relaunch
    // when no browser is live and a URL is recorded, or the user is stuck on a
    // permanent 409. In this unit context there's no real Chrome, so the relaunch
    // fails fast and 409s — but via the relaunch path (distinct from the no-URL
    // message), proving the reconnect recovery is wired through /frames.
    const config = testConfig("frames-reconnect-relaunch");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        // Already stamped (the pre-restart open-browser ran); URL recorded.
        payload: { toolCallId: "call_frames_relaunch", url: "https://example.com/login", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).not.toContain("no page URL is recorded");
    // Row stays pending so a real retry (with a live browser) can recover.
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });

  test("frames reconnect on a stamped card with NO recorded URL 409s with the no-URL message", async () => {
    // The relaunch needs a target page; without a recorded URL there's nothing
    // to navigate to, so /frames 409s with the distinct no-URL message rather
    // than blindly relaunching.
    const config = testConfig("frames-reconnect-no-url");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_frames_no_url", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no page URL is recorded");
  });

  test("screencast endpoints reject a setup that isn't an active sign-in (lifecycle gate)", async () => {
    // A browser.connect setup that is NOT pending, OR not stamped screencast +
    // signInStarted, must be refused so a stale EventSource reconnect after
    // complete/cancel can't rebuild a live drive channel.
    const config = testConfig("screencast-lifecycle");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    // Pending, but never went through open-browser (no screencast/signInStarted).
    const notStarted = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ls" }
      })
    );
    const r1 = await rawCall(handler, config, `/api/browser/screencast/${notStarted.id}/frames`, {}, config.token);
    expect(r1.status).toBe(404);
    // Stamped screencast but cancelled — no longer pending.
    const cancelled = await mutateState(config.instance, (state) => {
      const s = createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ls2", signInStarted: true, screencast: true }
      });
      const row = state.setupRequests.find((x) => x.id === s.id);
      if (row) row.status = "cancelled";
      return s;
    });
    const r2 = await rawCall(handler, config, `/api/browser/screencast/${cancelled.id}/input`, {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(r2.status).toBe(404);
  });

  test("open-browser refuses a row cancelled before the stamp mutation (in-mutation status recheck)", async () => {
    // /open-browser checks pending on a pre-read, then stamps screencast +
    // signInStarted inside mutateState. A /cancel that commits in that window
    // must not get a live sign-in stamped on top: the in-mutation status
    // recheck returns 410 and leaves the cancelled row untouched.
    const config = testConfig("open-browser-raced-cancel");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const { __test: browserTest } = await import("./tools/browser");
    // A live spawned handle so getScreencastPort is non-null (we get past the
    // 409 no-browser gate and reach the stamp mutation).
    browserTest.installFakeSpawnedHandleForTest(9333, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com",
          reason: "Sign in to continue",
          payload: { toolCallId: "call_race" }
        })
      );
      // Cancel the row first — this is the racer that wins.
      await mutateState(config.instance, (state) => {
        const row = state.setupRequests.find((s) => s.id === setup.id);
        if (row) row.status = "cancelled";
      });
      const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      // The pre-read pending gate already 410s here; the in-mutation recheck is
      // the backstop for a cancel that lands AFTER that gate. Either way the
      // contract is: no live sign-in stamped on a terminal row.
      expect(res.status).toBe(410);
      const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
      expect(after?.status).toBe("cancelled");
      expect(after?.payload.signInStarted).toBeUndefined();
      expect(after?.payload.screencast).toBeUndefined();
    } finally {
      browserTest.uninstallFakeBrowserForTest();
    }
  });

  test("browser.connect /complete claims the row BEFORE writing the audit row (no duplicate on double-submit)", async () => {
    // The non-screencast fallback must resolve (claim pending->completed) before
    // writing the rich browser.connect audit row. A second /complete loses the
    // claim (ApprovalRaceLostError) and writes ZERO side effects, so exactly one
    // browser.connect audit row exists no matter how many completes race.
    const config = testConfig("browser-connect-complete-claim-first");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in to the store",
        reason: "Sign in to the store",
        // No screencast marker → the non-screencast fallback path.
        payload: { toolCallId: "call_complete", reason: "Sign in to the store" }
      })
    );
    const first = await rawCall(handler, config, `/api/setup-requests/${setup.id}/complete`, { method: "POST" }, config.token);
    expect(first.status).toBe(200);
    // Second complete on the now-terminal row loses the claim.
    const second = await rawCall(handler, config, `/api/setup-requests/${setup.id}/complete`, { method: "POST" }, config.token);
    expect(second.status).toBeGreaterThanOrEqual(400);
    const browserConnectAudits = readState(config.instance).audit.filter((a) => a.action === "browser.connect");
    expect(browserConnectAudits).toHaveLength(1);
  });

  test("open-browser is idempotent: a second open on an already-stamped row writes no duplicate audit", async () => {
    // /open-browser keeps the row pending, so two opens (double-click / retry)
    // both pass the pending check. The in-mutation already-stamped guard makes
    // the second a no-op so exactly one stage:open-browser audit row exists.
    const config = testConfig("open-browser-idempotent");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSpawnedHandleForTest(9333, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com",
          reason: "Sign in to continue",
          payload: { toolCallId: "call_idem", url: "https://example.com/login" }
        })
      );
      const first = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      expect(first.status).toBe(200);
      const second = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      // The second open succeeds (idempotent) but writes no extra audit/trace.
      expect(second.status).toBe(200);
      const openAudits = readState(config.instance).audit.filter(
        (a) => a.action === "browser.connect" && (a.evidence as Record<string, unknown> | undefined)?.stage === "open-browser"
      );
      expect(openAudits).toHaveLength(1);
    } finally {
      browserTest.uninstallFakeBrowserForTest();
    }
  });

  test("screencast frames stream a frame and input dispatches with a live bridge", async () => {
    // HTTP success path: install a fake bridge (no real Chrome) so the SSE
    // envelope + input dispatch wiring is exercised end to end at the gateway.
    const config = testConfig("screencast-success");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ok", signInStarted: true, screencast: true }
      })
    );
    // A minimal fake bridge: replays one frame to each subscriber and records
    // dispatched input. Installed as the live activeBridge so the no-factory
    // getOrStartBridge inside http.ts reuses it.
    const dispatched: unknown[] = [];
    const fakeBridge = {
      isClosed: () => false,
      subscribe(
        onFrame: (f: { data: string; meta: Record<string, unknown> }) => void,
        _onClose?: () => void,
        onUrl?: (url: string) => void
      ) {
        onUrl?.("https://signin.example.com/login");
        onFrame({ data: "QUJD", meta: { deviceWidth: 800 } });
        return () => undefined;
      },
      dispatchInput: async (m: { kind?: string }) => {
        dispatched.push(m);
        // Mirror the real bridge: selection-causing kinds return a selection.
        return m.kind === "copy" ? { selection: "picked text" } : {};
      },
      start: async () => undefined,
      stop: async () => undefined
    };
    sc.__setActiveBridgeForTest(fakeBridge as never, setup.id);
    try {
      const framesRes = await handler(
        new Request(`http://127.0.0.1:${config.port}/api/browser/screencast/${setup.id}/frames`, {
          headers: { authorization: `Bearer ${config.token}` }
        })
      );
      expect(framesRes.status).toBe(200);
      expect(framesRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = framesRes.body!.getReader();
      // onUrl and onFrame enqueue separate chunks; read both.
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      const second = decoder.decode((await reader.read()).value);
      const text = first + second;
      // The gateway-sourced origin is streamed as an `event: url` so the modal
      // can show the operator which site they're signing into.
      expect(text).toContain("event: url");
      expect(text).toContain("https://signin.example.com/login");
      expect(text).toContain("event: frame");
      expect(text).toContain("QUJD");
      await reader.cancel();

      const inputRes = await call(handler, config, `/api/browser/screencast/${setup.id}/input`, {
        method: "POST",
        body: JSON.stringify({ kind: "click", x: 10, y: 20, clickCount: 1 })
      });
      expect(inputRes.ok).toBe(true);
      expect(dispatched).toEqual([{ kind: "click", x: 10, y: 20, clickCount: 1 }]);

      // A copy relays the remote selection back in the response body so the
      // modal can serve it to the operator's clipboard.
      const copyRes = await call(handler, config, `/api/browser/screencast/${setup.id}/input`, {
        method: "POST",
        body: JSON.stringify({ kind: "copy" })
      });
      expect(copyRes.ok).toBe(true);
      expect(copyRes.selection).toBe("picked text");
    } finally {
      sc.__resetActiveBridgeForTest();
    }
  });

  test("the frames SSE stream closes when the bridge dies (no dangling keepalives)", async () => {
    const config = testConfig("screencast-frames-close-on-death");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_close", signInStarted: true, screencast: true }
      })
    );
    // A fake bridge that captures the onClose callback so the test can fire it,
    // simulating the CDP socket dropping.
    let fireClose: (() => void) | undefined;
    const fakeBridge = {
      isClosed: () => false,
      subscribe(onFrame: (f: { data: string; meta: Record<string, unknown> }) => void, onClose?: () => void) {
        onFrame({ data: "QUJD", meta: { deviceWidth: 800 } });
        fireClose = onClose;
        return () => undefined;
      },
      dispatchInput: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined
    };
    sc.__setActiveBridgeForTest(fakeBridge as never, setup.id);
    try {
      const framesRes = await handler(
        new Request(`http://127.0.0.1:${config.port}/api/browser/screencast/${setup.id}/frames`, {
          headers: { authorization: `Bearer ${config.token}` }
        })
      );
      expect(framesRes.status).toBe(200);
      const reader = framesRes.body!.getReader();
      await reader.read(); // first frame
      expect(fireClose).toBeDefined();
      fireClose!(); // bridge dies → route should close the stream
      const next = await reader.read();
      expect(next.done).toBe(true); // stream ended, not dangling on keepalives
    } finally {
      sc.__resetActiveBridgeForTest();
    }
  });

  test("completing a screencast browser.connect resolves the setup without a managed relaunch", async () => {
    // The screencast path keeps the agent on its headless Chrome the whole
    // time, so /complete just stops the bridge (a no-op here, no live bridge)
    // and resolves the setup — no connectBrowser relaunch.
    const config = testConfig("screencast-complete");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc3", signInStarted: true, screencast: true }
      })
    );
    const res = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(res.ok).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("completed");
  });

  test("cancelling a screencast browser.connect stops the bridge and cancels the setup", async () => {
    const config = testConfig("screencast-cancel");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc4", signInStarted: true, screencast: true }
      })
    );
    await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
  });

  test("cancel stops the owner's bridge unconditionally, even if the row isn't yet stamped screencast", async () => {
    // /cancel must not gate the bridge teardown on a pre-claim screencast read:
    // payload.screencast can flip true (via /open-browser) in the window between
    // that read and the atomic claim. Install a live bridge owned by the setup
    // on a row that is NOT yet stamped screencast, cancel it, and assert the
    // bridge is torn down anyway — the unconditional owner-scoped stop.
    const config = testConfig("screencast-cancel-unstamped");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        // Deliberately NOT stamped screencast/signInStarted yet.
        payload: { toolCallId: "call_sc_unstamped" }
      })
    );
    let stopped = false;
    const fakeBridge = {
      isClosed: () => false,
      stop: async () => {
        stopped = true;
      }
    } as unknown as import("./execution/browser-screencast").ScreencastBridge;
    sc.__setActiveBridgeForTest(fakeBridge, setup.id);
    try {
      await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
      expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
      expect(stopped).toBe(true);
    } finally {
      await sc.stopActiveBridge();
    }
  });

  test("a frames request after a screencast complete is rejected (no bridge recreation)", async () => {
    // /complete marks the setup terminal BEFORE stopping the bridge, so a
    // frames/input request racing the completion sees status!=="pending" and
    // 404s instead of recreating an orphaned bridge in the teardown gap.
    const config = testConfig("screencast-complete-then-frames");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc_race", signInStarted: true, screencast: true }
      })
    );
    const done = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(done.ok).toBe(true);
    const framesRes = await rawCall(
      handler,
      config,
      `/api/browser/screencast/${setup.id}/frames`,
      { method: "GET" },
      config.token
    );
    expect(framesRes.status).toBe(404);
  });

  test("screencast input rejects a malformed JSON body with 400", async () => {
    const config = testConfig("screencast-bad-body");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc2", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/input`, {
      method: "POST",
      body: "{not json"
    }, config.token);
    expect(res.status).toBe(400);
  });

  test("POST /api/setup-requests/<id>/complete refuses a code-less messaging.approve_pairing approve and keeps the request pending", async () => {
    // allowChat's pending-row presence check is gated on `expectedCode`
    // being defined (the legacy CLI's "operator knows what they're
    // doing" trust model). If a chat-card pairing payload arrives
    // without verificationCode (group chat: groups intentionally never
    // mint a code, or a stale request whose pending row was cleared and
    // recreated), a no-code allowChat call would bypass the pending-row
    // check and enroll a chat that is no longer pending. Pin that
    // messaging-pairing-connect refuses the approve branch up-front when
    // verificationCode is missing.
    const config = testConfig("setup-complete-pairing-codeless-refuses");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.approve_pairing",
        target: "bridge_codeless:7",
        reason: "Confirm pairing",
        // Deliberately omit verificationCode — the chat card normally
        // carries one for private chats, but a stale or group-chat
        // payload would not.
        payload: { bridgeId: "bridge_codeless", chatId: 7, toolCallId: "call_codeless" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(false);
    expect(response.message).toContain("code-less");
    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });

  test("POST /api/setup-requests/<id>/complete removes a messaging bridge through the setup-request flow", async () => {
    // Happy path for the chat-side Remove bridge card. The /complete
    // handler delegates to runMessagingRemoveConnect, which resolves
    // the setup request atomically then calls removeMessagingBridge.
    const config = testConfig("setup-complete-remove-bridge-happy");
    const handler = createHandler(config);

    // Create a real bridge via the existing endpoint so its
    // encrypted secret + state record exist before we try to remove it.
    const created = await call(handler, config, `/api/messaging`, {
      method: "POST",
      body: JSON.stringify({ name: "remove-me", kind: "telegram", botToken: "1234:ABCDEFGHIJKLMNOPQR" })
    });
    expect(created.id).toBeString();

    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.remove_bridge",
        target: created.id,
        reason: "Remove bridge",
        payload: { bridgeId: created.id, bridgeName: "remove-me", kind: "telegram", toolCallId: "call_remove" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(true);
    expect(response.removed).toBe(true);
    expect(response.bridgeId).toBe(created.id);

    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("completed");
    expect(after.messagingBridges.find((b) => b.id === created.id)).toBeUndefined();

    // Chat-card lineage audit row pin: the chat-card remove path
    // writes a dedicated audit row carrying the setup-request id +
    // bridgeId, so a chat-card remove is distinguishable from a CLI /
    // settings remove in the activity feed.
    const chatRemoveRow = after.audit.find(
      (e) => e.action === "messaging.remove_bridge" && e.approvalId === setup.id
    );
    expect(chatRemoveRow).toBeDefined();
    expect(chatRemoveRow?.target).toBe(created.id);
    expect((chatRemoveRow?.evidence as { bridgeName?: string } | undefined)?.bridgeName).toBe("remove-me");
  });

  test("POST /api/setup-requests/<id>/complete refuses partial browser.fill_secret submissions", async () => {
    // fillReady in BlockSetupRequested.tsx only disables the web
    // Submit button; CLI / mobile / direct API clients can still POST a
    // partial body. The gateway must enforce that every declared slot
    // has a non-empty value before any DOM fill happens — otherwise
    // /complete would resolve with some slots silently unfilled and the
    // agent would be told (in agent.ts:runApprovedAction) that every
    // declared slot was filled.
    const config = testConfig("complete-rejects-partial-fill-secret");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const { createTask, upsertTask } = require("./state") as typeof import("./state");
      const task = createTask(state.instance, "partial-test");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl so the origin guard's "no live page" refusal
    // doesn't fire before the missing-slot check; this test is about
    // partial submission, not origin binding.
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // Origin only — sanitizeUrlForAuditTarget strips pathname.
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      // The live URL can be on any path within the approved origin;
      // the equality check is on origin only after the SEC-C fix.
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("password");
    expect(body.message).toContain("Missing");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/setup-requests/<id>/complete: submitted fill_secret values never appear in state.json, trace JSONL, or runtime.jsonl", async () => {
    // End-to-end absence pin for the ADR's secret-handling guarantee:
    // submitted credential values must flow request-scope only and
    // never reach any persisted artifact. Without this test the only
    // protection is manual code review of every audit/trace/log write
    // touching the fill_secret path. Distinct marker strings let us
    // grep the raw bytes after the request — partial matches would
    // catch even an attempt to serialize a wrapper object containing
    // the value.
    const config = testConfig("fill-secret-no-state-leak");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "fill secret leak guard");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl on the payload AND install a matching fake
    // session so the origin guard passes and the fill loop actually
    // runs. The fills will error per-slot because the fake page's
    // .locator() returns nothing useful — what we care about is that
    // the audit row is written with redacted: true and the markers
    // never reach state/trace/log even when the runtime tries to
    // record what happened.
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      // Fake locator that no-ops on fill; the audit-row write still
      // happens regardless of whether the fill succeeded. Cast as
      // Partial<Page> since the fake only implements what
      // browserFillByLocator touches.
      locator: ((_sel: string) => ({
        fill: async () => { throw new Error("fake session, no real DOM"); }
      })) as unknown as import("playwright-core").Page["locator"],
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const USERNAME_MARKER = "tomsmith-LEAK-MARKER-zzzzz";
    const PASSWORD_MARKER = "SuperSecretPassword-LEAK-MARKER-zzzzz";
    await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: USERNAME_MARKER, password: PASSWORD_MARKER } })
      },
      config.token
    );
    // No browser session exists, so browserFillByLocator returns
    // errors for both slots and the audit row evidence carries
    // `errors[]` (no values) + filledSlots = []. The approval is
    // still resolved atomically before the fill loop so the deny
    // race is closed; the agent gets a partial-fill error result
    // via resumeChatTask.

    // Raw state.json bytes must not contain either marker.
    const stateJsonPath = `${config.stateRoot}/state.json`;
    const rawState = readFileSync(stateJsonPath, "utf8");
    expect(rawState).not.toContain(USERNAME_MARKER);
    expect(rawState).not.toContain(PASSWORD_MARKER);

    // Trace JSONL (per-task) must not contain either marker. The
    // file may not exist if no trace events fired for this task —
    // an empty file is fine, the test only fails on a leak.
    const traceJsonlPath = `${config.stateRoot}/traces/${taskId}.jsonl`;
    if (existsSync(traceJsonlPath)) {
      const rawTrace = readFileSync(traceJsonlPath, "utf8");
      expect(rawTrace).not.toContain(USERNAME_MARKER);
      expect(rawTrace).not.toContain(PASSWORD_MARKER);
    }

    // runtime.jsonl is the cross-task log file — also greppable.
    const runtimeLogPath = `${config.logRoot}/runtime.jsonl`;
    if (existsSync(runtimeLogPath)) {
      const rawLog = readFileSync(runtimeLogPath, "utf8");
      expect(rawLog).not.toContain(USERNAME_MARKER);
      expect(rawLog).not.toContain(PASSWORD_MARKER);
    }

    // The audit row itself: defense-in-depth. Both `evidence` (would
    // be undefined after redaction) and `target` must not contain
    // the markers. `target` is preserved across redaction; this pin
    // catches a future regression that would forget to sanitize URL
    // query strings or stuff secrets into the target field.
    const auditRows = readState(config.instance).audit.filter(
      (a) => a.action === "browser.fill_secret" && a.approvalId === approval.id
    );
    expect(auditRows.length).toBe(1);
    const row = auditRows[0]!;
    expect(row.redacted).toBe(true);
    expect(row.evidence).toBeUndefined();
    expect(row.target ?? "").not.toContain(USERNAME_MARKER);
    expect(row.target ?? "").not.toContain(PASSWORD_MARKER);
  });

  test("POST /api/setup-requests/<id>/complete refuses fill_secret when page navigated away from approved origin", async () => {
    // The approval.target encodes the origin the user consented
    // to fill into (protocol+host+port; pathname is stripped by
    // sanitizeUrlForAuditTarget). If the page has navigated to a
    // different origin (agent action, user click, JS redirect,
    // phishing redirect) between approval creation and Submit,
    // the live URL no longer matches and we refuse with 409 so a
    // fresh approval is required for the new destination. In
    // this test the browser session was never opened so
    // peekCurrentBrowserUrl returns undefined,
    // which the handler treats as "no live page to fill" — same
    // refusal path.
    const config = testConfig("complete-fill-secret-origin-mismatch");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // The /connect origin guard reads from the structural
          // approvedUrl on payload — peer approval actions carry
          // their contract fields under payload too. Stored as
          // origin only (no pathname) since reset/magic-link
          // URLs can carry tokens in the path.
          approvedUrl: "https://example.com"
        }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    // The browser session was never opened, so peekCurrentBrowserUrl
    // returns undefined and the /complete handler takes the
    // "session expired" branch (distinct from the "page navigated"
    // branch where a live session exists but its URL differs from
    // approvedUrl). Without that split the operator would see
    // "page navigated" after a 5-minute walk-away — misleading.
    expect(body.message).toContain("Browser session expired");
    expect(body.message).toContain("https://example.com");
    // Approval stayed pending — no resolveApproval call ran.
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/setup-requests/<id>/complete refuses sub-floor password-kind slot values", async () => {
    // The snapshot post-redactor uses literal substring replacement;
    // single-character (and other very short) values would shred
    // structural tokens like [@e1] in snapshot text. The 4-char
    // floor in src/tools/browser.ts:recordFilledSecret keeps the
    // redactor safe. For a password-kind slot a sub-floor value is
    // both a near-certain typo AND an un-redactable leak risk, so
    // /connect refuses it (the registry-skip-for-short-values would
    // otherwise let the value escape via a later unredacted tool
    // result). Non-password slots take the opposite path — see the
    // short-PII test below.
    const config = testConfig("complete-fill-secret-too-short");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "short value test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "pin", locator: "@e1", label: "PIN", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { pin: "12" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("too short");
    expect(body.message).toContain("pin");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/setup-requests/<id>/complete accepts a sub-floor non-password (PII) slot value", async () => {
    // fill_secret also collects identity/PII fields — a real call
    // asks for date of birth + last name. Short last names ("Shi",
    // "Ng", "Li") are valid and must fill. The redaction floor is a
    // redactor-safety constraint, not an input-validation gate, so a
    // text-kind slot below the floor is accepted and filled (it is
    // simply not redaction-registered, which is fine for a non-
    // credential). Pin the boundary so the floor never silently
    // re-broadens to block PII again.
    const config = testConfig("complete-fill-secret-short-pii");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "short PII test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Look up account",
        payload: {
          slots: [
            { name: "lastname", locator: "@e43", label: "Last Name", kind: "text" }
          ],
          reason: "Look up account",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const filled: Array<{ locator: string; value: string }> = [];
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com",
      close: () => Promise.resolve(),
      // browserFillByLocator resolves an @-ref to a literal
      // [data-gini-ref] selector, then calls page.locator(sel).fill().
      locator: (selector: string) => ({
        fill: (value: string) => {
          filled.push({ locator: selector, value });
          return Promise.resolve();
        },
        evaluate: () => Promise.resolve()
      })
    } as unknown as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { lastname: "Shi" } })
      },
      config.token
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.filledSlots).toEqual(["lastname"]);
    expect(filled).toEqual([{ locator: '[data-gini-ref="e43"]', value: "Shi" }]);
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("completed");
  });

  test("POST /api/setup-requests/<id>/complete: distinct 409 when live session exists but page navigated to a different origin", async () => {
    // Pin the OTHER 409 branch: a live session whose current URL no
    // longer matches the approved origin. This is the genuine
    // page-navigated case (agent click, JS redirect, phishing
    // redirect), distinct from the session-expired idle-sweep case
    // covered by the previous test.
    const config = testConfig("complete-fill-secret-real-navigation");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "real navigation test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    // Live session exists but the page URL is on a different origin
    // than what the approval captured — should take the "page
    // navigated" branch, NOT the "session expired" branch.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://evil.example.org/phishing",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Page navigated");
    expect(body.message).toContain("https://example.com");
    expect(body.message).toContain("https://evil.example.org");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  // Default transport (issue #420): /api/browser/connect with NO cdpUrl is a
  // no-op acknowledgement — the spawned Chrome launches lazily on the first
  // browser tool call, not at connect time, and carries no record.
  test("browser connect with no cdpUrl returns the stable disconnected status", async () => {
    const config = testConfig("browser-connect-empty-body");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      { method: "POST", body: JSON.stringify({}) },
      config.token
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  // A cdpUrl with an unsupported protocol is user-input error → 400, and no
  // record is written. (Validation happens before any probe/attach.)
  test("browser connect rejects an unsupported cdpUrl protocol with 400", async () => {
    const config = testConfig("browser-connect-bad-protocol");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      { method: "POST", body: JSON.stringify({ cdpUrl: "file:///etc/passwd" }) },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(String(body.error ?? body.message)).toContain("Unsupported cdpUrl protocol");
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  // An unreachable (but well-formed) loopback CDP endpoint surfaces as 400 with
  // a clear "Could not reach CDP endpoint" message, and writes no record. The
  // server-side env knobs shrink the probe deadline so the test doesn't burn
  // the full 15s budget (they are NOT plumbed from the POST body).
  test("browser connect surfaces an unreachable cdp endpoint as 400", async () => {
    const config = testConfig("browser-connect-unreachable-cdp");
    const handler = createHandler(config);
    const prevTimeout = process.env.GINI_CDP_PROBE_TIMEOUT_MS;
    const prevInterval = process.env.GINI_CDP_PROBE_INTERVAL_MS;
    process.env.GINI_CDP_PROBE_TIMEOUT_MS = "40";
    process.env.GINI_CDP_PROBE_INTERVAL_MS = "10";
    try {
      const response = await rawCall(
        handler,
        config,
        "/api/browser/connect",
        // Port 1 is reserved and never listening, so the probe always fails.
        { method: "POST", body: JSON.stringify({ cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc" }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(String(body.error ?? body.message)).toContain("Could not reach CDP endpoint");
      expect(readState(config.instance).browser ?? null).toBeNull();
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_CDP_PROBE_TIMEOUT_MS;
      else process.env.GINI_CDP_PROBE_TIMEOUT_MS = prevTimeout;
      if (prevInterval === undefined) delete process.env.GINI_CDP_PROBE_INTERVAL_MS;
      else process.env.GINI_CDP_PROBE_INTERVAL_MS = prevInterval;
    }
  });

  test("PATCH /api/settings/auto-approve rejects out-of-union approvalMode with 400", async () => {
    // An invalid value previously mapped to undefined and the PATCH
    // silently no-op'd while returning 200 — the client thought it
    // succeeded. Mirror job-level strict validation at the HTTP
    // boundary so misconfigured clients get a loud failure.
    const config = testConfig("settings-bad-approval-mode");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/settings/auto-approve",
      {
        method: "PATCH",
        body: JSON.stringify({ approvalMode: "bogus" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/approvalMode must be one of/);
    expect(body.validValues).toEqual(["strict", "auto", "yolo"]);
    // Original value on the config object must not have changed.
    expect(config.approvalMode).toBe("strict");
  });

  test("POST /api/browser/wipe-profile is no longer routed", async () => {
    const config = testConfig("browser-wipe-removed");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/wipe-profile",
      { method: "POST" },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("GET /api/browser reports the stable disconnected status", async () => {
    const config = testConfig("browser-status");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/browser", {}, config.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connected).toBe(false);
  });

  test("stamps the active agent on records and filters listings by agentId", async () => {
    const config = testConfig("records-agentid");
    const handler = createHandler(config);

    // Two agents — submit a task under each so we have heterogeneous rows.
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });

    // Task under the default agent. We use `read README.md` so runTask
    // dispatches a real low-risk file tool and the task lands in a terminal
    // state before the test ends — avoids a background failTask firing
    // after the test's state file has been cleaned up by the next test.
    config.workspaceRoot = process.cwd();
    const defaultTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(defaultTask.agentId).toBe(defaultAgentId);
    await waitForTask(handler, config, defaultTask.id);

    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const scoutTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(scoutTask.agentId).toBe(second.id);
    await waitForTask(handler, config, scoutTask.id);

    // Unfiltered listing includes both rows.
    const all = await call(handler, config, "/api/tasks");
    expect(all.some((task: { id: string }) => task.id === defaultTask.id)).toBe(true);
    expect(all.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);

    // Filtered listing returns only the matching agent's rows.
    const scoutOnly = await call(handler, config, `/api/tasks?agentId=${encodeURIComponent(second.id)}`);
    expect(scoutOnly.every((task: { agentId?: string }) => task.agentId === second.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === defaultTask.id)).toBe(false);

    // Empty string is treated as "no filter" — preserves legacy behavior.
    const empty = await call(handler, config, "/api/tasks?agentId=");
    expect(empty.length).toBe(all.length);
  });

  test("stamps the active agent on chat sessions and filters by agentId", async () => {
    const config = testConfig("records-agentid-chat");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const sessionA = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under default" })
    });
    expect(sessionA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const sessionB = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under scout" })
    });
    expect(sessionB.agentId).toBe(second.id);
    const scopedDefault = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionA.id)).toBe(true);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionB.id)).toBe(false);
    const scopedScout = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionB.id)).toBe(true);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionA.id)).toBe(false);
  });

  test("stamps the active agent on jobs and filters job listings", async () => {
    const config = testConfig("records-agentid-jobs");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const jobA = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "default-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(jobA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const jobB = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "scout-job", prompt: "hi", intervalSeconds: 3600 })
    });
    expect(jobB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/jobs?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scoped.every((j: { agentId?: string }) => j.agentId === defaultAgentId)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobA.id)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobB.id)).toBe(false);
  });

  test("stamps the active agent on subagents and filters by agentId", async () => {
    const config = testConfig("records-agentid-subagents");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const subA = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-default", prompt: "report" })
    });
    expect(subA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const subB = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-scout", prompt: "report" })
    });
    expect(subB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/subagents?agentId=${encodeURIComponent(second.id)}`);
    expect(scoped.every((s: { agentId?: string }) => s.agentId === second.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subB.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subA.id)).toBe(false);
  });

  test("subagent inherits the parent task's agent even when the active agent switched", async () => {
    const config = testConfig("records-agentid-subagent-inherit");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a parent task under the default agent so the resulting parent
    // task carries agentId=default.
    const parentTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "echo parent" })
    });
    await waitForTask(handler, config, parentTask.id);
    // Switch the active agent *before* spawning the subagent. The child
    // should still inherit the parent's agent id (default), not the active
    // agent (scout). Regression test for the inheritance bug where
    // spawnSubagent read `resolveEffectiveContext(...).agentId` directly.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const child = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({
        name: "child",
        prompt: "echo child",
        parentTaskId: parentTask.id
      })
    });
    expect(child.agentId).toBe(defaultAgentId);
    // The child task spawned by the subagent path should also carry the
    // parent's agent — not the active agent at the moment of spawn.
    await waitForTask(handler, config, child.taskId);
    const childDetail = await call(handler, config, `/api/tasks/${child.taskId}`);
    expect(childDetail.task.agentId).toBe(defaultAgentId);
  });

  test("approvals inherit agentId from the originating task and filter by agentId", async () => {
    const config = testConfig("records-agentid-approvals");
    // The patch flow writes through workspaceRoot; point at the repo so the
    // pre-image read in `patch README.md ::` succeeds.
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a patch task under the default agent — the agent loop blocks
    // on file.patch until approval, and createApproval inherits agentId
    // from the originating task.
    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    await waitForTask(handler, config, task.id);
    // Switch the active agent *before* asserting. The approval was already
    // created under the originating task, so it must carry the default
    // agent's id regardless of whoever is active now.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const approvals = readState(config.instance).authorizations.filter((a) => a.taskId === task.id);
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.agentId === defaultAgentId)).toBe(true);
    const scopedDefault = await call(handler, config, `/api/authorizations?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.every((a: { agentId?: string }) => a.agentId === defaultAgentId)).toBe(true);
    expect(scopedDefault.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(true);
    const scopedScout = await call(handler, config, `/api/authorizations?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(false);
  });

  test("stamps the active agent on events and audit and filters listings", async () => {
    const config = testConfig("records-agentid-events");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // The agent.activated audit/event for the second agent should be tagged
    // with its id — the runtime stamps the active agent via inferAgentId.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const events = await call(handler, config, `/api/events?agentId=${encodeURIComponent(second.id)}`);
    expect(events.every((e: { agentId?: string }) => e.agentId === second.id)).toBe(true);
    expect(events.some((e: { action: string }) => e.action === "agent.activated")).toBe(true);
    const defaultEvents = await call(handler, config, `/api/events?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(defaultEvents.every((e: { agentId?: string }) => e.agentId === defaultAgentId)).toBe(true);
    const audit = await call(handler, config, `/api/audit?agentId=${encodeURIComponent(second.id)}`);
    expect(audit.every((a: { agentId?: string }) => a.agentId === second.id)).toBe(true);
  });

  test("migrateRecordAgentIds is idempotent across repeated reads", async () => {
    const config = testConfig("records-agentid-idempotent");
    const handler = createHandler(config);
    // Seed an unstamped task to force a backfill on the first read.
    await mutateState(config.instance, (state) => {
      state.tasks.unshift({
        id: "task_legacy_one",
        title: "legacy",
        input: "legacy task",
        status: "completed",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Trigger reads to run normalizeState multiple times.
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    const audit = await call(handler, config, "/api/audit");
    const backfills = audit.filter((row: { action: string }) => row.action === "records.agentid.backfill");
    // Exactly one backfill row should exist regardless of how many reads.
    expect(backfills.length).toBe(1);
  });

  test("scheduled job fired after agent switch attributes the task to the originating agent", async () => {
    const config = testConfig("records-agentid-job-fire");
    const handler = createHandler(config);
    config.workspaceRoot = process.cwd();
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Create the job under the default agent. Use a read tool so the
    // spawned task can settle into a terminal state inside the test window
    // — keeps the runtime from logging a "Task not found" against a stale
    // state file after the next test cleans up.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "owner-test", prompt: "read README.md", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* the job fires.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    // Fire the job manually (the dispatch path is shared with the scheduler).
    const fired = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(fired.taskId).toBeString();
    // Wait for the resulting task to settle so its async tail doesn't
    // outlive the test and trip a "Task not found" failure on a later
    // test's state-file cleanup.
    await waitForTask(handler, config, fired.taskId);
    const detail = await call(handler, config, `/api/tasks/${fired.taskId}`);
    expect(detail.task.agentId).toBe(defaultAgentId);
    expect(detail.task.jobId).toBe(job.id);
  });

  test("POST /api/jobs ignores agentId in the request body", async () => {
    // Regression: the public input bag previously honored a caller-supplied
    // `agentId`, letting a malicious or buggy client attribute new jobs to
    // any agent. Now the HTTP path strips it and the runtime falls back to
    // the active agent.
    const config = testConfig("records-agentid-job-untrusted-input");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // While the active agent is still the default, post a job whose body
    // tries to spoof attribution to the scout agent.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "spoof-job",
        prompt: "hello",
        intervalSeconds: 3600,
        agentId: second.id
      })
    });
    expect(job.agentId).toBe(defaultAgentId);
    expect(job.agentId).not.toBe(second.id);
  });

  test("job lifecycle audits carry the originating job's agent across a switch", async () => {
    // Regression: addAudit's inferAgentId previously had no jobId fallback
    // and the lifecycle audit writes in src/jobs/index.ts didn't pass
    // agentId, so a paused/updated/removed audit after an agent switch
    // misattributed the row to the new active agent.
    const config = testConfig("records-agentid-job-audits");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "audit-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* exercising the lifecycle transitions.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/resume`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ intervalSeconds: 7200 })
    });
    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });
    const state = readState(config.instance);
    const targeted = state.audit.filter((a) => a.target === job.id);
    const lifecycle = targeted.filter((a) =>
      a.action === "job.paused"
      || a.action === "job.active"
      || a.action === "job.updated"
      || a.action === "job.removed"
    );
    expect(lifecycle.length).toBeGreaterThanOrEqual(4);
    expect(lifecycle.every((a) => a.agentId === defaultAgentId)).toBe(true);
  });

  test("chat message under a session keeps the session's agent across all emitted events", async () => {
    // Regression: createRun and createPlanStep previously emitted events
    // without an agentId. With the session bound to agent A, sending a
    // message after switching the active agent to B would mis-stamp the
    // run/step events to B even though the task itself inherits A.
    const config = testConfig("records-agentid-chat-message");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "owned by default" })
    });
    expect(session.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "read README.md" })
    });
    await waitForTask(handler, config, submitted.taskId);
    const task = (await call(handler, config, `/api/tasks/${submitted.taskId}`)).task;
    expect(task.agentId).toBe(defaultAgentId);
    // Every event for this run should carry the original session's agent —
    // not the now-active scout agent.
    const state = readState(config.instance);
    const runEvents = state.events.filter((e) => e.runId === submitted.runId);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.every((e) => e.agentId === defaultAgentId)).toBe(true);
    // The run.created and run.step.created events should specifically be
    // present and tagged.
    expect(runEvents.some((e) => e.action === "run.created")).toBe(true);
    expect(runEvents.some((e) => e.action === "run.step.created")).toBe(true);
  });

  test("chat session lifecycle events carry the session's agent", async () => {
    // Regression: createChatSession / deleteChatSession / renameChatSession
    // emitted lifecycle events without an agentId. A session created /
    // renamed / deleted while a different agent was active would attribute
    // the event to the active agent rather than the session's owner.
    const config = testConfig("records-agentid-chat-lifecycle");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Create the session under default.
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "lifecycle" })
    });
    expect(session.agentId).toBe(defaultAgentId);
    // Switch active to scout, then rename and delete the default-owned
    // session — both events should still carry the default's id.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await call(handler, config, `/api/chat/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "renamed" })
    });
    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });
    const state = readState(config.instance);
    const targeted = state.events.filter((e) => e.target === session.id);
    const created = targeted.find((e) => e.action === "chat.session.created");
    const renamed = targeted.find((e) => e.action === "chat.session.renamed");
    const deleted = targeted.find((e) => e.action === "chat.session.deleted");
    expect(created?.agentId).toBe(defaultAgentId);
    expect(renamed?.agentId).toBe(defaultAgentId);
    expect(deleted?.agentId).toBe(defaultAgentId);
  });

  test("deleting a chat session also clears the per-conversation identity snapshot", async () => {
    // Identity snapshots are keyed on conversationId (the chat session id);
    // without the cleanup in deleteChatSession each deleted chat leaks one
    // IdentitySnapshotRecord into state forever.
    const config = testConfig("records-identity-snapshot-cleanup");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "snapshot-cleanup" })
    });
    await mutateState(config.instance, (state) => {
      if (!state.identitySnapshots) state.identitySnapshots = {};
      state.identitySnapshots[session.id] = {
        identity: {
          instance: config.instance,
          runtimePort: config.port,
          agentName: "default",
          agentId: "agent_x",
          provider: "echo/test",
          toolsets: ["file"],
          memoryNamespace: "agent_x"
        },
        lastFullTurn: 1
      };
    });
    expect(readState(config.instance).identitySnapshots?.[session.id]).toBeDefined();
    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });
    expect(readState(config.instance).identitySnapshots?.[session.id]).toBeUndefined();
  });

  test("addAudit infers agentId from jobId when neither agentId nor taskId is provided", async () => {
    // Regression: inferAgentId's jobId fallback only fires when the caller
    // threads `jobId` (or appendEvent's persisted `jobId`) through. This
    // test pins that an audit row created with just jobId resolves to the
    // owning job's agent — without it the row would fall back to
    // state.activeAgentId after a switch.
    const config = testConfig("records-agentid-job-fallback");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "fallback-job", prompt: "hi", intervalSeconds: 3600 })
    });
    // Switch the active agent before emitting the audit.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "test.job.fallback",
          target: job.id,
          risk: "low",
          evidence: { jobId: job.id }
        },
        { jobId: job.id }
      );
    });
    const state = readState(config.instance);
    const audit = state.audit.find((a) => a.action === "test.job.fallback");
    expect(audit?.agentId).toBe(defaultAgentId);
    const paired = state.events.find((e) => e.action === "test.job.fallback");
    expect(paired?.agentId).toBe(defaultAgentId);
  });

  test("migrateRecordAgentIds re-stamps rows pointing at a deleted agent", async () => {
    // Regression: the migration's predicate previously only re-stamped
    // rows where agentId was missing. A row carrying the id of a deleted
    // agent stayed stranded under an unselectable bucket. Now stale ids
    // are treated the same as missing.
    const config = testConfig("records-agentid-stale");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    // Seed records pointing at a ghost agent that doesn't exist in
    // state.agents. The next read triggers normalizeState ->
    // migrateRecordAgentIds and should re-stamp them with the first
    // existing agent (the default).
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.tasks.unshift({
        id: "task_ghost",
        title: "ghost",
        input: "ghost task",
        status: "completed",
        instance: state.instance,
        agentId: "agent_ghost",
        createdAt: at,
        updatedAt: at,
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Trigger the migration via a fresh read.
    await call(handler, config, "/api/tasks");
    const stamped = readState(config.instance);
    const ghostTask = stamped.tasks.find((t) => t.id === "task_ghost");
    expect(ghostTask?.agentId).toBe(defaultAgentId);
    // Re-reading should be idempotent — no further backfill row beyond
    // what the first migration produced.
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    const audit = await call(handler, config, "/api/audit");
    const backfills = audit.filter((row: { action: string }) => row.action === "records.agentid.backfill");
    expect(backfills.length).toBe(1);
  });

  test("AgentContext resolves each source-id branch deterministically", async () => {
    // Pin the AgentContext contract: each branch in the union resolves to
    // the agent its source record carries, never to state.activeAgentId.
    // We exercise every branch from a single test instance so the
    // resolution matrix lives in one place.
    const config = testConfig("agent-context-branches");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Seed a task, job, session, and memory under the default agent.
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "branch-test" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "branch-job", prompt: "hi", intervalSeconds: 3600 })
    });
    await mutateState(config.instance, (state) => {
      state.tasks.unshift({
        id: "task_branch",
        title: "branch",
        input: "branch task",
        status: "completed",
        instance: state.instance,
        agentId: defaultAgentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Switch the active agent so any silent fallback would attribute to
    // scout rather than the source record's owner.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await mutateState(config.instance, (state) => {
      // explicit agentId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.agentId", target: "explicit", risk: "low" },
        { agentId: defaultAgentId }
      );
      // taskId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.taskId", target: "from-task", risk: "low" },
        { taskId: "task_branch" }
      );
      // jobId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.jobId", target: "from-job", risk: "low" },
        { jobId: job.id }
      );
      // sessionId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.sessionId", target: "from-session", risk: "low" },
        { sessionId: session.id }
      );
      // system: true branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.system", target: "system", risk: "low" },
        { system: true }
      );
    });
    const audit = readState(config.instance).audit;
    expect(audit.find((a) => a.action === "test.branch.agentId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.taskId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.jobId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.sessionId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.system")?.agentId).toBeUndefined();
  });

  test("AgentContext is required at the type level for every emitter", () => {
    // Pin the type-level invariant: calling appendEvent or addAudit
    // without an AgentContext is a compile error, not a silent
    // active-agent fallback. The `@ts-expect-error` directives below
    // force tsc to confirm the missing third argument is rejected.
    // If these comments stop catching an error, someone reintroduced a
    // two-argument overload and the whole point of this refactor is
    // undone.
    //
    // We never actually invoke these — the type check is the assertion.
    // Wrapping in a `false &&` keeps tsc inspecting the call signature
    // while keeping the runtime tree-shake-eligible.
    if (false as boolean) {
      const state = readState("agent-context-typecheck");
      // @ts-expect-error appendEvent requires an AgentContext as the third argument.
      appendEvent(state, { kind: "runtime", action: "no-context", target: "x", risk: "low", summary: "x" });
      // @ts-expect-error addAudit requires an AgentContext as the third argument.
      addAudit(state, { actor: "runtime", action: "no-context", target: "x", risk: "low" });
    }
    expect(true).toBe(true);
  });

  test("AgentContext returns undefined when the source record was deleted", async () => {
    // The contract says: if a sourceId is provided but the record doesn't
    // exist (deleted, race), resolveAgentId returns undefined. It must NOT
    // silently fall back to the active agent.
    const config = testConfig("agent-context-missing-source");
    const handler = createHandler(config);
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.task", target: "x", risk: "low" },
        { taskId: "task_does_not_exist" }
      );
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.job", target: "x", risk: "low" },
        { jobId: "job_does_not_exist" }
      );
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.session", target: "x", risk: "low" },
        { sessionId: "chat_does_not_exist" }
      );
    });
    const audit = readState(config.instance).audit;
    expect(audit.find((a) => a.action === "test.missing.task")?.agentId).toBeUndefined();
    expect(audit.find((a) => a.action === "test.missing.job")?.agentId).toBeUndefined();
    expect(audit.find((a) => a.action === "test.missing.session")?.agentId).toBeUndefined();
  });

  test("POST /api/messaging/:id/allow with a malformed chatId returns 400 (not 500)", async () => {
    // parseChatIdStrict throws "Invalid input: chatId must be ..." so
    // statusFromErrorMessage maps it to 400. Without the prefix, a
    // caller who PUTs `null` or `""` would see "internal error" 500.
    const config = testConfig("messaging-allow-bad-chatid");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const badPayloads: Array<unknown> = [null, "", "123abc", "abc", 1.5];
    for (const chatId of badPayloads) {
      const response = await rawCall(
        handler,
        config,
        `/api/messaging/${bridge.id}/allow`,
        { method: "POST", body: JSON.stringify({ chatId }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/chatId must be a finite integer/);
    }
  });

  test("POST /api/messaging/:id/allow with a mismatched verification code returns 409 (not 500)", async () => {
    // allowChat throws "Verification code mismatch — ..." when the
    // operator's UI snapshot lost a race against a fresher DM that
    // rotated the pending code. The HTTP layer must map that to 409
    // Conflict (stale-view), not the previous catch-all 500.
    const config = testConfig("messaging-allow-code-mismatch");
    const handler = createHandler(config);
    const { addMessagingBridge, recordDeniedChatAttempt } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await recordDeniedChatAttempt(config, bridge.id, { chatId: 42, chatType: "private" });
    const response = await rawCall(
      handler,
      config,
      `/api/messaging/${bridge.id}/allow`,
      {
        method: "POST",
        body: JSON.stringify({ chatId: 42, expectedCode: "ZZ-ZZ-ZZ" })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/Verification code mismatch/);
  });

  test("POST /api/messaging/:id/allow with an expired verification code returns 409 (not 500)", async () => {
    // allowChat throws "Verification code for chat ${chatId} has expired
    // ..." when the pending code aged past its TTL between page load and
    // click. Same 409 contract as the mismatch case so the UI can
    // distinguish stale-view conflicts from generic server errors.
    const { mutateState } = await import("./state/store");
    const config = testConfig("messaging-allow-code-expired");
    const handler = createHandler(config);
    const { addMessagingBridge, recordDeniedChatAttempt } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const pending = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 99,
      chatType: "private"
    });
    expect(pending?.verificationCode).toBeTruthy();
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (!live) return;
      const meta = { ...(live.metadata ?? {}) };
      const list = Array.isArray(meta.recentDeniedChats) ? [...meta.recentDeniedChats] : [];
      const idx = list.findIndex((entry: { chatId?: number }) => entry?.chatId === 99);
      if (idx < 0) return;
      list[idx] = {
        ...list[idx],
        verificationCodeExpiresAt: new Date(Date.now() - 60_000).toISOString()
      };
      meta.recentDeniedChats = list;
      live.metadata = meta;
    });
    const response = await rawCall(
      handler,
      config,
      `/api/messaging/${bridge.id}/allow`,
      {
        method: "POST",
        body: JSON.stringify({ chatId: 99, expectedCode: pending!.verificationCode })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/has expired/);
  });

  // ChatBlock protocol endpoints (ADR chat-block-protocol.md). The
  // routes are smoke-tested here; deeper assertions on per-block
  // shape live in src/state/chat-blocks.test.ts and
  // src/execution/chat-task.test.ts.
  test("GET /api/chat/:id/blocks returns ordered ChatBlock list and 404 for missing sessions", async () => {
    const config = testConfig("chat-blocks-list");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "blocks endpoint smoke" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "please reply" })
    });
    await waitForTask(handler, config, submitted.taskId);

    const blocks = await call(handler, config, `/api/chat/${session.id}/blocks`);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].kind).toBe("user_text");
    expect(blocks[0].text).toBe("please reply");
    // Ordinals monotonically increase.
    const ordinals = blocks.map((b: { ordinal: number }) => b.ordinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]).toBeGreaterThan(ordinals[i - 1]!);
    }

    const missing = await rawCall(
      handler,
      config,
      `/api/chat/chat_does_not_exist/blocks`,
      {},
      config.token
    );
    expect(missing.status).toBe(404);
  });

  test("DELETE /api/chat/:id cascades chat blocks (subsequent /blocks returns 404)", async () => {
    const config = testConfig("chat-blocks-cascade");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "cascade smoke" })
    });
    await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "blocks should disappear after delete" })
    });
    // Wait for at least the user_text block to land. We don't need the
    // assistant turn to finish for this assertion.
    let blocks: unknown[] = [];
    for (let i = 0; i < 50; i += 1) {
      const result = await call(handler, config, `/api/chat/${session.id}/blocks`);
      if (Array.isArray(result) && result.length > 0) {
        blocks = result;
        break;
      }
      await Bun.sleep(20);
    }
    expect(blocks.length).toBeGreaterThan(0);

    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });

    const afterDelete = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/blocks`,
      {},
      config.token
    );
    expect(afterDelete.status).toBe(404);
  });

  test("GET /api/chat/:id/stream returns SSE with chat_block frames", async () => {
    const config = testConfig("chat-blocks-stream");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "stream smoke" })
    });
    // Pre-publish some blocks so the initial backfill carries data.
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "stream this" })
    });
    await waitForTask(handler, config, submitted.taskId);

    const response = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Read just the first frame to confirm the SSE shape; if we
    // consumed the whole body we'd block on the keepalive interval.
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buffer = "";
    if (reader) {
      // Pump up to ~500ms collecting frames so the backfill arrives.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("user_text")) break;
      }
      await reader.cancel();
    }
    expect(buffer).toContain("event: chat_block");
    expect(buffer).toContain("user_text");
    expect(buffer).toContain("stream this");
  });

  test("GET /api/chat/:id/stream emits id frames as <block_id>:<iso_ts>", async () => {
    // Pins the SSE wire contract: each chat_block frame's `id:` line
    // carries `<block_id>:<iso_timestamp>`. The mobile/browser client
    // round-trips that string as Last-Event-ID on reconnect, and the
    // gateway parses the `:<ts>` suffix to detect in-place updates on
    // the cursor row (see listChatBlocksAfter). A regression that
    // strips the suffix would silently break resume semantics for the
    // streaming assistant_text case, so we pin the format at the HTTP
    // boundary.
    const config = testConfig("chat-blocks-stream-id-format");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "stream id format" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "id format check" })
    });
    await waitForTask(handler, config, submitted.taskId);

    const response = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buffer = "";
    if (reader) {
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("event: chat_block")) break;
      }
      await reader.cancel();
    }
    // Frame shape: `id: <block_id>:<iso_ts>\nevent: chat_block\n...`.
    // Block ids are `block_<random>` (no `:`); ISO timestamps look like
    // `YYYY-MM-DDTHH:MM:SS.sssZ`. The whole line must match this pattern.
    const idLineMatch = buffer.match(
      /^id: ([A-Za-z0-9_-]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/m
    );
    expect(idLineMatch).not.toBeNull();
    // Sanity: the captured block id portion does not itself contain `:`,
    // so splitting on the first colon in listChatBlocksAfter is safe.
    expect(idLineMatch?.[1]).not.toContain(":");
  });

  test("GET /api/chat/:id/stream emits chat_session frame on initial connect", async () => {
    // The mobile client reads the chat-detail header title from the
    // session record this frame carries. Without an initial emit,
    // there's a window where the header would render "Chat" / the
    // first-message fallback even though the gateway already knows
    // the canonical title (e.g. on reconnect to an already-renamed
    // session).
    const config = testConfig("chat-stream-session-initial");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "before-rename" })
    });
    await call(handler, config, `/api/chat/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed in the lobby" })
    });

    const response = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buffer = "";
    if (reader) {
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("event: chat_session")) break;
      }
      await reader.cancel();
    }
    expect(buffer).toContain("event: chat_session");
    expect(buffer).toContain("Renamed in the lobby");
  });

  test("GET /api/chat/:id/stream pushes chat_session frame on rename", async () => {
    // The auto-rename path (chat-task → autoRenameChatAfterTurn) fires
    // after task completion and the mobile chat-detail header must
    // pick up the new title without polling. Stand-in for the auto
    // case by hitting /rename explicitly — both paths route through
    // renameChat → publishChatSession.
    const config = testConfig("chat-stream-session-rename");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "" })
    });

    const response = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    // Drain the initial chat_session frame (the one emitted on connect)
    // so the assertion below targets the rename-driven frame.
    let buffer = "";
    if (reader) {
      const initialDeadline = Date.now() + 500;
      while (Date.now() < initialDeadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("event: chat_session")) break;
      }
      // Clear the buffer so we can detect the second emit independently.
      buffer = "";

      // Trigger the publish from another concurrent caller, then drain.
      await call(handler, config, `/api/chat/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Streamed rename" })
      });

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("Streamed rename")) break;
      }
      await reader.cancel();
    }
    expect(buffer).toContain("event: chat_session");
    expect(buffer).toContain("Streamed rename");
  });

  test("GET /api/chat/:id/stream returns 404 for unknown sessions", async () => {
    const config = testConfig("chat-blocks-stream-404");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      `/api/chat/chat_unknown/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("a tokenless web stream marks the session web-watched until it closes", async () => {
    // A web client (no X-Device-Token) opening a chat stream registers on
    // the pushless registry so the dispatcher can downgrade the phone's
    // completion alert to a silent badge refresh while the human reads on
    // the web. Closing the stream clears the entry — so a send-then-close
    // leaves the phone eligible for its normal alert.
    const config = testConfig("chat-stream-web-presence");
    const handler = createHandler(config);
    const { isSessionWebWatched, isDeviceWatching } = await import("./state");
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "web presence" })
    });

    expect(isSessionWebWatched(config.instance, session.id)).toBe(false);

    // No X-Device-Token header → treated as a web/CLI client.
    await withChatStream(handler, config, session.id, {}, () => {
      // Web presence is recorded; the device registry is untouched (no
      // token to key on).
      expect(isSessionWebWatched(config.instance, session.id)).toBe(true);
      expect(isDeviceWatching(config.instance, config.token, session.id)).toBe(false);
    });

    // Stream closed → presence cleared (the send-then-close path).
    expect(isSessionWebWatched(config.instance, session.id)).toBe(false);
  });

  test("a stream with a valid X-Device-Token registers per-device watch (not pushless)", async () => {
    // The mobile path: a registered device opens the stream with its
    // valid token, which lands in the per-device registry so the
    // dispatcher skips a redundant push to THIS device. It must NOT land
    // in the pushless registry (that's web-only).
    const config = testConfig("chat-stream-device-watch");
    const handler = createHandler(config);
    const { isSessionWebWatched, isDeviceWatching } = await import("./state");
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "device watch" })
    });
    // Register the device so deviceTokenFromRequest resolves it for the
    // caller's credential.
    const deviceToken = "valid_device_token_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww";
    await call(handler, config, "/api/push/devices", {
      method: "POST",
      body: JSON.stringify({ token: deviceToken, platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
    });

    await withChatStream(
      handler,
      config,
      session.id,
      { headers: { "x-device-token": deviceToken } },
      () => {
        // Device watch recorded; pushless registry untouched.
        expect(isDeviceWatching(config.instance, deviceToken, session.id)).toBe(true);
        expect(isSessionWebWatched(config.instance, session.id)).toBe(false);
      }
    );
    expect(isDeviceWatching(config.instance, deviceToken, session.id)).toBe(false);
  });

  test("a stream with a present-but-invalid X-Device-Token registers NO presence (not web, not device)", async () => {
    // Tri-state guard: deviceTokenFromRequest returns null for BOTH an
    // absent header AND a present-but-unregistered/mismatched token. Only
    // a truly-absent header is a web/CLI client. A real iPhone whose
    // persisted token went stale (rotated server-side, or re-paired) primes
    // that stale token onto the SSE handshake on cold launch — it must NOT
    // be misclassified as a web client, or it would silence its OWN
    // completion alerts for the session. With an invalid token present we
    // register nothing: no pushless downgrade, no per-device skip.
    const config = testConfig("chat-stream-stale-token");
    const handler = createHandler(config);
    const { isSessionWebWatched, isDeviceWatching } = await import("./state");
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "stale token" })
    });

    const staleToken = "stale_unregistered_token_zzzzzzzzzzzzzzzzzzzzzzzz";
    await withChatStream(
      handler,
      config,
      session.id,
      { headers: { "x-device-token": staleToken } },
      () => {
        // Neither registry recorded this stream — a stale-token phone keeps
        // its normal alert.
        expect(isSessionWebWatched(config.instance, session.id)).toBe(false);
        expect(isDeviceWatching(config.instance, staleToken, session.id)).toBe(false);
      }
    );
    expect(isSessionWebWatched(config.instance, session.id)).toBe(false);
  });

  test("an unauthenticated stream request 401s and creates no pushless presence", async () => {
    // The pushless registration is a notification side effect, so it must
    // sit behind the bearer gate: a request with no Authorization header
    // 401s before reaching the stream factory, leaving the registry empty.
    // Pins that the side effect can't be triggered by an unauthenticated
    // caller who merely knows a session id.
    const config = testConfig("chat-stream-unauth-no-presence");
    const handler = createHandler(config);
    const { isSessionWebWatched } = await import("./state");
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "unauth presence" })
    });

    // No token argument → no Authorization header.
    const response = await rawCall(handler, config, `/api/chat/${session.id}/stream`, {});
    expect(response.status).toBe(401);
    expect(isSessionWebWatched(config.instance, session.id)).toBe(false);
  });

  test("POST /api/messaging/:id/reject-pending with a malformed chatId returns 400 (not 500)", async () => {
    // Same parseChatIdStrict guard as /allow — pin it here so the new
    // route doesn't regress to 500 on bad input as the surface grows.
    const config = testConfig("messaging-reject-pending-bad-chatid");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const badPayloads: Array<unknown> = [null, "", "123abc", "abc", 1.5];
    for (const chatId of badPayloads) {
      const response = await rawCall(
        handler,
        config,
        `/api/messaging/${bridge.id}/reject-pending`,
        { method: "POST", body: JSON.stringify({ chatId }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/chatId must be a finite integer/);
    }
  });

  test("rejects /api/embedding/reembed payloads that pass both allBanks and bankId", async () => {
    // The CLI throws when both --all-banks and --bank are supplied
    // (src/cli/commands/embedding.ts). The HTTP API has to mirror
    // that contract: silently ignoring bankId when allBanks=true
    // would let a caller think they were reembedding a single bank
    // and instead trigger a full-instance reembed — a destructive,
    // irreversible operation against every bank in the instance.
    const config = testConfig("embedding-reembed-conflict");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/embedding/reembed",
      {
        method: "POST",
        body: JSON.stringify({ allBanks: true, bankId: "bank_default" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/mutually exclusive/);
  });

  describe("identity-files routes", () => {
    test("GET /api/identity-files returns INSTRUCTIONS.md, USER.md, and SOULs with budget metadata", async () => {
      const config = testConfig("identity-show");
      const handler = createHandler(config);
      // Seed USER.md so the budget snapshot is meaningful.
      const { writeUserProfile, scaffoldInstanceIdentityFiles } = await import("./runtime/identity-files");
      scaffoldInstanceIdentityFiles(config.instance);
      writeUserProfile(config.instance, "## Identity\n- Name: TestUser", "approved");
      const dump = await call(handler, config, "/api/identity-files");
      expect(dump.instance).toBe(config.instance);
      expect(dump.userProfile.content).toContain("Name: TestUser");
      expect(dump.userProfile.cap).toBe(1500);
      expect(dump.userProfile.budget.used).toBeGreaterThan(0);
      expect(dump.userProfile.budget.overCap).toBe(false);
      // INSTRUCTIONS.md is materialized by scaffold; the route returns
      // its content trimmed.
      expect(dump.instructions.content).toMatch(/You are a personal agent running on the gini-agent framework\./);
    });

    test("GET /api/identity-files/history?kind=user returns snapshots newest-first", async () => {
      const config = testConfig("identity-history");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      writeUserProfile(config.instance, "v2", "approved");
      writeUserProfile(config.instance, "v3", "approved");
      const out = await call(handler, config, "/api/identity-files/history?kind=user");
      expect(out.kind).toBe("user");
      // Three writes → two snapshots in history (first write has nothing
      // to roll back to).
      expect(out.entries.length).toBe(2);
      // Each entry carries a path-safe name and a positive size.
      for (const entry of out.entries) {
        expect(entry.name).toMatch(/\.md$/);
        expect(entry.sizeBytes).toBeGreaterThan(0);
      }
    });

    test("POST /api/identity-files/rollback restores from a snapshot and emits an audit row", async () => {
      const config = testConfig("identity-rollback");
      const handler = createHandler(config);
      const { writeUserProfile, listUserProfileHistory, userProfilePath } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1 body", "approved");
      writeUserProfile(config.instance, "v2 body", "approved");
      writeUserProfile(config.instance, "v3 body", "approved");
      const history = listUserProfileHistory(config.instance);
      const v1Snap = history.find((e) => readFileSync(e.path, "utf8") === "v1 body");
      expect(v1Snap).toBeDefined();
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: v1Snap!.name })
      });
      expect(result.ok).toBe(true);
      expect(result.restoredBytes).toBe(Buffer.byteLength("v1 body", "utf8"));
      // The active USER.md now holds the rolled-back body.
      expect(readFileSync(userProfilePath(config.instance), "utf8")).toBe("v1 body");
      // Audit row recorded the rollback.
      const state = readState(config.instance);
      const audit = state.audit.find((a) => a.action === "identity.user_profile.rollback");
      expect(audit).toBeDefined();
      // Pre-rollback snapshot was created so the rollback is itself
      // reversible.
      expect(result.preRestoreSnapshot).not.toBeNull();
    });

    test("POST /api/identity-files/rollback rejects an unknown snapshot name with reason='no snapshot'", async () => {
      const config = testConfig("identity-rollback-unknown");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: "2099-01-01T00-00-00.000Z.md" })
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no snapshot");
    });
  });

  describe("push device endpoints", () => {
    test("POST /api/push/devices upserts a token scoped to the owner credential", async () => {
      const config = testConfig("push-devices-upsert");
      const handler = createHandler(config);

      const ownerReg = await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      // Owner-token-only auth: every caller resolves to the "owner" credential.
      expect(ownerReg.ok).toBe(true);
      expect(ownerReg.device.credentialId).toBe("owner");
      expect(ownerReg.device.token).toBe("tok_owner");

      // A second install registers its own token under the same credential.
      const secondReg = await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_phone", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      expect(secondReg.ok).toBe(true);
      expect(secondReg.device.credentialId).toBe("owner");

      // Re-register the same token — idempotent rebind (bundle id updates).
      const rebind = await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile.dev" })
      });
      expect(rebind.device.bundleId).toBe("ai.lilaclabs.gini.mobile.dev");
      expect(rebind.device.credentialId).toBe("owner");
    });

    test("POST /api/push/devices validates inputs", async () => {
      const config = testConfig("push-devices-validate");
      const handler = createHandler(config);

      const missingToken = await rawCall(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      }, config.token);
      expect(missingToken.status).toBe(400);

      const wrongPlatform = await rawCall(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok", platform: "android", bundleId: "ai.lilaclabs.gini.mobile" })
      }, config.token);
      expect(wrongPlatform.status).toBe(400);

      const missingBundle = await rawCall(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok", platform: "ios" })
      }, config.token);
      expect(missingBundle.status).toBe(400);
    });

    test("DELETE /api/push/devices/:token removes the owner's token; a missing token is 404", async () => {
      const config = testConfig("push-devices-delete");
      const handler = createHandler(config);

      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_phone", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });

      const ownDelete = await call(handler, config, "/api/push/devices/tok_phone", { method: "DELETE" });
      expect(ownDelete.ok).toBe(true);

      // Second delete of the same token: 404.
      const repeatDelete = await rawCall(handler, config, "/api/push/devices/tok_phone", { method: "DELETE" }, config.token);
      expect(repeatDelete.status).toBe(404);

      // A token that never existed: 404 as well.
      const missingDelete = await rawCall(handler, config, "/api/push/devices/tok_never", { method: "DELETE" }, config.token);
      expect(missingDelete.status).toBe(404);
    });

    test("POST /api/push/devices → 200 row written with origin='loopback'", async () => {
      // Push devices register over loopback from the local web UI; the
      // row is tagged origin='loopback' (the only origin).
      const config = testConfig("push-devices-loopback");
      mkdirSync(config.stateRoot, { recursive: true });
      const handler = createHandler(config);

      const res = await rawCall(
        handler,
        config,
        "/api/push/devices",
        {
          method: "POST",
          body: JSON.stringify({ token: "tok_loop", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
        },
        config.token
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.device.origin).toBe("loopback");
    });

    test("POST /api/chat/:id/read records the cursor and GET /api/badge surfaces the unread total", async () => {
      const config = testConfig("chat-read-badge");
      const handler = createHandler(config);

      // Register a device first — read/badge now key per device, not
      // per credential, so the mobile client identifies itself via
      // X-Device-Token on every call.
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner_device", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const deviceHeader = { "x-device-token": "tok_owner_device" };

      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "read state" })
      });
      // Plant two visible blocks via the persistence layer — the read
      // endpoint validates the block id, but the unread aggregate is
      // what we're measuring here.
      const { insertChatBlock } = await import("./state");
      const b1 = insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: session.id,
        text: "hi"
      });
      insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: session.id,
        text: "follow up"
      });

      // Fresh device: no read state yet, both blocks unread.
      const before = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(before.unread).toBe(2);

      const marked = await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "POST",
        headers: deviceHeader,
        body: JSON.stringify({ lastReadBlockId: b1.id })
      });
      expect(marked.ok).toBe(true);
      expect(marked.readState.lastReadBlockId).toBe(b1.id);

      const after = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(after.unread).toBe(1);
    });

    test("GET /api/badge and /api/unread exclude archived sessions", async () => {
      // Regression: an archived session (e.g. a deleted recurring-job
      // channel) is hidden from every client by the `!archivedAt` filter,
      // so the user can never open it to clear its read-state. The badge
      // must not count its blocks — otherwise it pins at a number that
      // can never be drained.
      const config = testConfig("chat-badge-archived");
      const handler = createHandler(config);

      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner_device", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const deviceHeader = { "x-device-token": "tok_owner_device" };

      const live = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "live chat" })
      });
      const stale = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "old job channel" })
      });

      const { insertChatBlock } = await import("./state");
      insertChatBlock(config.instance, { kind: "assistant_text", sessionId: live.id, text: "reachable", streaming: false });
      insertChatBlock(config.instance, { kind: "assistant_text", sessionId: stale.id, text: "stuck 1", streaming: false });
      insertChatBlock(config.instance, { kind: "assistant_text", sessionId: stale.id, text: "stuck 2", streaming: false });

      // Both sessions visible → all three blocks count.
      const before = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(before.unread).toBe(3);

      // Archive the stale session — it now drops out of the badge.
      await mutateState(config.instance, (state) => {
        const session = state.chatSessions.find((s) => s.id === stale.id);
        if (session) session.archivedAt = new Date().toISOString();
      });

      const afterBadge = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(afterBadge.unread).toBe(1);

      const afterUnread = await call(handler, config, "/api/unread", { headers: deviceHeader });
      expect(afterUnread.counts[live.id]).toBe(1);
      expect(afterUnread.counts[stale.id]).toBeUndefined();
    });

    test("GET /api/badge and /api/unread exclude sessions of archived agents", async () => {
      // Second unreachable vector: archiving an agent stamps `archivedAt`
      // on the AGENT, not its chat session. Both clients show archived
      // agents in a Restore-only group with no way to open the chat, so
      // the session's blocks can never be marked read. The badge must
      // exclude them just like a self-archived session.
      const config = testConfig("chat-badge-archived-agent");
      const handler = createHandler(config);

      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner_device", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const deviceHeader = { "x-device-token": "tok_owner_device" };

      const agent = await call(handler, config, "/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "scratch agent" })
      });
      const agentChat = await getOrCreateAgentChat(config.instance, agent.id);

      const { insertChatBlock } = await import("./state");
      insertChatBlock(config.instance, {
        kind: "assistant_text",
        sessionId: agentChat.id,
        text: "agent reply 1",
        streaming: false,
        agentId: agent.id
      });
      insertChatBlock(config.instance, {
        kind: "assistant_text",
        sessionId: agentChat.id,
        text: "agent reply 2",
        streaming: false,
        agentId: agent.id
      });

      // Agent active → its chat is reachable, both blocks count.
      const before = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(before.unread).toBe(2);

      // Archive the agent (the session keeps no archivedAt of its own).
      await call(handler, config, `/api/agents/${agent.id}/archive`, { method: "POST" });
      const sessionStillUnarchived = readState(config.instance).chatSessions.find((s) => s.id === agentChat.id);
      expect(sessionStillUnarchived?.archivedAt).toBeUndefined();

      // Badge drops to zero — the only session belongs to an archived agent.
      const afterBadge = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(afterBadge.unread).toBe(0);
      const afterUnread = await call(handler, config, "/api/unread", { headers: deviceHeader });
      expect(afterUnread.counts[agentChat.id]).toBeUndefined();

      // Restoring the agent makes the chat reachable again → blocks recount.
      await call(handler, config, `/api/agents/${agent.id}/unarchive`, { method: "POST" });
      const afterRestore = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(afterRestore.unread).toBe(2);
    });

    test("GET /api/badge still counts a job channel owned by an archived agent", async () => {
      // Over-exclusion guard: a job CHANNEL (kind:"channel" / origin:"job")
      // stays on the channel rail even when its owning agent is archived —
      // the client filters key on kind/origin + !archivedAt, never on agent
      // state. So unless the channel is archived in its own right it is still
      // reachable and openable, and its blocks must keep counting. Only the
      // agent's CANONICAL chat vanishes with the agent.
      const config = testConfig("chat-badge-archived-agent-channel");
      const handler = createHandler(config);

      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner_device", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const deviceHeader = { "x-device-token": "tok_owner_device" };

      const agent = await call(handler, config, "/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "channel owner" })
      });
      // A real recurring job with its own dedicated channel (kind:"channel",
      // origin:"job"), owned by the agent. Going through createScheduledJob
      // means the job references the channel, so the orphan-channel sweep in
      // normalizeState leaves it live (a bare hand-built channel would be
      // archived as orphaned on the next state load).
      const job = await createScheduledJob(
        config,
        {
          name: "news-watch",
          prompt: "summarize headlines",
          intervalSeconds: 600,
          createDedicatedSession: { title: "news-watch" }
        },
        { originatingAgentId: agent.id }
      );
      const channelId = job.chatSessionId!;
      const channelSession = readState(config.instance).chatSessions.find((s) => s.id === channelId);
      expect(channelSession?.kind).toBe("channel");
      expect(channelSession?.agentId).toBe(agent.id);

      const { insertChatBlock } = await import("./state");
      insertChatBlock(config.instance, {
        kind: "assistant_text",
        sessionId: channelId,
        text: "digest 1",
        streaming: false,
        agentId: agent.id
      });

      const before = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(before.unread).toBe(1);

      // Archive the agent. The channel is still rendered on the rail, so it
      // must keep counting (unlike the agent's canonical chat).
      await call(handler, config, `/api/agents/${agent.id}/archive`, { method: "POST" });
      const sessionStillLive = readState(config.instance).chatSessions.find((s) => s.id === channelId);
      expect(sessionStillLive?.archivedAt).toBeUndefined();

      const afterBadge = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(afterBadge.unread).toBe(1);
      const afterUnread = await call(handler, config, "/api/unread", { headers: deviceHeader });
      expect(afterUnread.counts[channelId]).toBe(1);

      // But if the channel itself is archived, it drops out (vector 1).
      await mutateState(config.instance, (state) => {
        const s = state.chatSessions.find((x) => x.id === channelId);
        if (s) s.archivedAt = new Date().toISOString();
      });
      const afterChannelArchive = await call(handler, config, "/api/badge", { headers: deviceHeader });
      expect(afterChannelArchive.unread).toBe(0);
    });

    test("POST /api/chat/:id/read rejects bad input and cross-session ids", async () => {
      const config = testConfig("chat-read-validate");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_owner_device", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const deviceHeader = { "x-device-token": "tok_owner_device" };
      const sessionA = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "A" })
      });
      const sessionB = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "B" })
      });
      const { insertChatBlock } = await import("./state");
      const bA = insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: sessionA.id,
        text: "in A"
      });

      // Missing lastReadBlockId.
      const missing = await rawCall(
        handler,
        config,
        `/api/chat/${sessionA.id}/read`,
        { method: "POST", headers: deviceHeader, body: JSON.stringify({}) },
        config.token
      );
      expect(missing.status).toBe(400);

      // Block belongs to A — POSTing it on B's cursor is rejected.
      const cross = await rawCall(
        handler,
        config,
        `/api/chat/${sessionB.id}/read`,
        { method: "POST", headers: deviceHeader, body: JSON.stringify({ lastReadBlockId: bA.id }) },
        config.token
      );
      expect(cross.status).toBe(400);

      // Unknown session: 404.
      const noSession = await rawCall(
        handler,
        config,
        "/api/chat/chat_nonexistent/read",
        { method: "POST", headers: deviceHeader, body: JSON.stringify({ lastReadBlockId: bA.id }) },
        config.token
      );
      expect(noSession.status).toBe(404);

      // Missing X-Device-Token: 400 (mobile-only endpoint).
      const missingDevice = await rawCall(
        handler,
        config,
        `/api/chat/${sessionA.id}/read`,
        { method: "POST", body: JSON.stringify({ lastReadBlockId: bA.id }) },
        config.token
      );
      expect(missingDevice.status).toBe(400);

      // Foreign device token (not registered to this credential): 403.
      const foreignDevice = await rawCall(
        handler,
        config,
        `/api/chat/${sessionA.id}/read`,
        {
          method: "POST",
          headers: { "x-device-token": "tok_someone_else" },
          body: JSON.stringify({ lastReadBlockId: bA.id })
        },
        config.token
      );
      expect(foreignDevice.status).toBe(403);
    });

    test("read state is scoped per device, not per credential", async () => {
      // Two iPhones owned by the same human (both register under the
      // "owner" credential). iPhone A reading the chat must NOT clear
      // iPhone B's badge — that's the load-bearing per-device guarantee.
      const config = testConfig("chat-read-device");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_a", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_b", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });

      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "shared" })
      });
      const { insertChatBlock } = await import("./state");
      const block = insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: session.id,
        text: "hello"
      });

      // iPhone A marks read; its badge drops to 0. iPhone B's badge
      // is still 1 because read state is per-device.
      await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "POST",
        headers: { "x-device-token": "tok_iphone_a" },
        body: JSON.stringify({ lastReadBlockId: block.id })
      });
      const badgeA = await call(handler, config, "/api/badge", {
        headers: { "x-device-token": "tok_iphone_a" }
      });
      const badgeB = await call(handler, config, "/api/badge", {
        headers: { "x-device-token": "tok_iphone_b" }
      });
      expect(badgeA.unread).toBe(0);
      expect(badgeB.unread).toBe(1);
    });

    test("DELETE /api/chat/:id/read marks just the latest assistant turn unread", async () => {
      const config = testConfig("chat-unread-swipe");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_a", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_b", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const headerA = { "x-device-token": "tok_iphone_a" };
      const headerB = { "x-device-token": "tok_iphone_b" };
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "swipe" })
      });
      // Realistic chat: a few user messages culminating in an assistant
      // reply. After Mark Unread the badge should show 1 (just the
      // assistant turn), not 4 (every visible block).
      const { insertChatBlock } = await import("./state");
      insertChatBlock(config.instance, { kind: "user_text", sessionId: session.id, text: "hi" });
      insertChatBlock(config.instance, { kind: "user_text", sessionId: session.id, text: "still hi" });
      insertChatBlock(config.instance, { kind: "user_text", sessionId: session.id, text: "ok last one" });
      const assistant = insertChatBlock(config.instance, {
        kind: "assistant_text",
        sessionId: session.id,
        text: "hello back",
        streaming: false
      });

      // Both devices catch up first so the baseline badge is 0.
      await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "POST", headers: headerA, body: JSON.stringify({ lastReadBlockId: assistant.id })
      });
      await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "POST", headers: headerB, body: JSON.stringify({ lastReadBlockId: assistant.id })
      });
      expect((await call(handler, config, "/api/badge", { headers: headerA })).unread).toBe(0);

      // iPhone A swipes "Mark unread". The badge surfaces just the
      // latest assistant turn (1), not the full session.
      const cleared = await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "DELETE", headers: headerA
      });
      expect(cleared.ok).toBe(true);
      expect((await call(handler, config, "/api/badge", { headers: headerA })).unread).toBe(1);
      // iPhone B is unaffected (still caught up).
      expect((await call(handler, config, "/api/badge", { headers: headerB })).unread).toBe(0);

      // Idempotent — replaying lands on the same cursor; still 1.
      const second = await call(handler, config, `/api/chat/${session.id}/read`, {
        method: "DELETE", headers: headerA
      });
      expect(second.ok).toBe(true);
      expect((await call(handler, config, "/api/badge", { headers: headerA })).unread).toBe(1);

      // Unknown session: 404.
      const noSession = await rawCall(
        handler,
        config,
        "/api/chat/chat_nonexistent/read",
        { method: "DELETE", headers: headerA },
        config.token
      );
      expect(noSession.status).toBe(404);

      // Missing X-Device-Token: 400.
      const noDevice = await rawCall(
        handler,
        config,
        `/api/chat/${session.id}/read`,
        { method: "DELETE" },
        config.token
      );
      expect(noDevice.status).toBe(400);
    });

    test("GET /api/unread returns per-session unread counts scoped to the device", async () => {
      const config = testConfig("chat-unread-counts");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_a", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_iphone_b", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const headerA = { "x-device-token": "tok_iphone_a" };
      const headerB = { "x-device-token": "tok_iphone_b" };
      const sessionA = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "A" })
      });
      const sessionB = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "B" })
      });
      const { insertChatBlock } = await import("./state");
      insertChatBlock(config.instance, { kind: "user_text", sessionId: sessionA.id, text: "1" });
      const a2 = insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: sessionA.id,
        text: "2"
      });
      insertChatBlock(config.instance, { kind: "user_text", sessionId: sessionB.id, text: "3" });

      // Fresh device A — both sessions show their full count.
      const initial = await call(handler, config, "/api/unread", { headers: headerA });
      expect(initial.counts[sessionA.id]).toBe(2);
      expect(initial.counts[sessionB.id]).toBe(1);

      // A catches up on session A — it drops out of the map for A.
      await call(handler, config, `/api/chat/${sessionA.id}/read`, {
        method: "POST",
        headers: headerA,
        body: JSON.stringify({ lastReadBlockId: a2.id })
      });
      const after = await call(handler, config, "/api/unread", { headers: headerA });
      expect(after.counts[sessionA.id]).toBeUndefined();
      expect(after.counts[sessionB.id]).toBe(1);

      // Device B is unaffected.
      const bView = await call(handler, config, "/api/unread", { headers: headerB });
      expect(bView.counts[sessionA.id]).toBe(2);
      expect(bView.counts[sessionB.id]).toBe(1);

      // Missing X-Device-Token: 400.
      const noDevice = await rawCall(
        handler,
        config,
        "/api/unread",
        {},
        config.token
      );
      expect(noDevice.status).toBe(400);

      // Unauth: 401.
      const noAuth = await rawCall(handler, config, "/api/unread");
      expect(noAuth.status).toBe(401);
    });

    test("read + badge endpoints require authentication", async () => {
      const config = testConfig("chat-read-auth");
      const handler = createHandler(config);
      const read = await rawCall(handler, config, "/api/chat/chat_x/read", {
        method: "POST",
        body: JSON.stringify({ lastReadBlockId: "block_x" })
      });
      expect(read.status).toBe(401);
      const badge = await rawCall(handler, config, "/api/badge");
      expect(badge.status).toBe(401);
    });

    test("push device endpoints require authentication", async () => {
      const config = testConfig("push-devices-auth");
      const handler = createHandler(config);

      const post = await rawCall(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      expect(post.status).toBe(401);

      const del = await rawCall(handler, config, "/api/push/devices/tok", { method: "DELETE" });
      expect(del.status).toBe(401);
    });
  });

  describe("push preview endpoint", () => {
    test("GET /api/push/preview returns the latest assistant reply for a completed message", async () => {
      const config = testConfig("push-preview-message");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Morning briefing" })
      });
      const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "what's up" })
      });
      await waitForTask(handler, config, submitted.taskId);

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`
      );
      expect(preview.title).toBe("Morning briefing");
      // The echo provider replies with the user's text; the body must be
      // the actual reply, NOT a generic "Tap to read" string.
      expect(typeof preview.body).toBe("string");
      expect(preview.body.length).toBeGreaterThan(0);
      expect(preview.body).not.toBe("Tap to read");
    });

    test("GET /api/push/preview 404s when the session has no assistant message yet", async () => {
      const config = testConfig("push-preview-empty");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Empty chat" })
      });
      const res = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`,
        {},
        config.token
      );
      expect(res.status).toBe(404);
    });

    test("GET /api/push/preview surfaces a pending authorization's risk + summary", async () => {
      const config = testConfig("push-preview-approval");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Deploy bot" })
      });
      const { createAuthorization } = await import("./state");
      const approval = await mutateState(config.instance, (state) =>
        createAuthorization(state, {
          action: "terminal.exec",
          target: "rm -rf build",
          risk: "high",
          reason: "Clear the stale build cache",
          payload: {}
        })
      );

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=authorization_requested&approvalId=${approval.id}`
      );
      expect(preview.title).toBe("Approve in Deploy bot?");
      expect(preview.body).toBe("[high] Clear the stale build cache");
    });

    test("GET /api/push/preview surfaces a pending setup request's ask", async () => {
      const config = testConfig("push-preview-setup");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Email watch" })
      });
      const { createSetupRequest } = await import("./state");
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com/login",
          reason: "Sign in to your email provider",
          payload: {}
        })
      );

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=setup_requested&approvalId=${setup.id}`
      );
      expect(preview.title).toBe("Finish a step in Email watch");
      expect(preview.body).toBe("Sign in to your email provider");
    });

    test("GET /api/push/preview validates inputs and auth", async () => {
      const config = testConfig("push-preview-validation");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Validation chat" })
      });

      // Unauthenticated.
      const noAuth = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`
      );
      expect(noAuth.status).toBe(401);

      // Missing sessionId.
      const noSession = await rawCall(
        handler,
        config,
        `/api/push/preview?event=message_completed`,
        {},
        config.token
      );
      expect(noSession.status).toBe(400);

      // Unknown event.
      const badEvent = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=bogus`,
        {},
        config.token
      );
      expect(badEvent.status).toBe(400);

      // Unknown session.
      const badSession = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=chat_nope&event=message_completed`,
        {},
        config.token
      );
      expect(badSession.status).toBe(404);
    });

    test("POST /api/push/unwatch (no sessionId) clears the whole device bucket", async () => {
      const config = testConfig("push-unwatch");
      const handler = createHandler(config);
      // Register the device so requireDeviceToken accepts the header.
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_unwatch", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Seed two watched sessions for this device (as if it had opened
        // two chats), plus one for a different device that must survive.
        addSseSubscription(config.instance, "tok_unwatch", "chat_a");
        addSseSubscription(config.instance, "tok_unwatch", "chat_b");
        addSseSubscription(config.instance, "tok_other", "chat_a");
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_a")).toBe(true);

        // No sessionId → background beacon → clear everything for the device.
        const res = await call(handler, config, "/api/push/unwatch", {
          method: "POST",
          headers: { "x-device-token": "tok_unwatch" }
        });
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(2);
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_a")).toBe(false);
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_b")).toBe(false);
        // The other device is untouched.
        expect(isDeviceWatching(config.instance, "tok_other", "chat_a")).toBe(true);
      } finally {
        // Don't leak seeded entries into the process-wide registry.
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch?sessionId clears only that session", async () => {
      const config = testConfig("push-unwatch-session");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_nav", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Device watches two chats; navigating away from chat_a must leave
        // chat_b watched (the just-opened chat mustn't be race-cleared).
        addSseSubscription(config.instance, "tok_nav", "chat_a");
        addSseSubscription(config.instance, "tok_nav", "chat_b");

        const res = await call(handler, config, "/api/push/unwatch?sessionId=chat_a", {
          method: "POST",
          headers: { "x-device-token": "tok_nav" }
        });
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(1);
        expect(isDeviceWatching(config.instance, "tok_nav", "chat_a")).toBe(false);
        expect(isDeviceWatching(config.instance, "tok_nav", "chat_b")).toBe(true);
      } finally {
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch?sessionId&streamId clears only that stream, not a sibling on the same session", async () => {
      const config = testConfig("push-unwatch-stream");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_stream", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Thread View (card over the main chat) and the main chat both open
        // a stream on the SAME session, each with its own streamId. Tearing
        // down the thread must leave the main chat's watch intact.
        addSseSubscription(config.instance, "tok_stream", "chat_a", "stream_main");
        addSseSubscription(config.instance, "tok_stream", "chat_a", "stream_thread");

        const res = await call(
          handler,
          config,
          "/api/push/unwatch?sessionId=chat_a&streamId=stream_thread",
          { method: "POST", headers: { "x-device-token": "tok_stream" } }
        );
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(1);
        // The main chat's stream is still registered → session still watched.
        expect(isDeviceWatching(config.instance, "tok_stream", "chat_a")).toBe(true);
      } finally {
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch requires auth + a registered device token", async () => {
      const config = testConfig("push-unwatch-auth");
      const handler = createHandler(config);
      // Unauthenticated.
      const noAuth = await rawCall(handler, config, "/api/push/unwatch", { method: "POST" });
      expect(noAuth.status).toBe(401);
      // Authenticated but no X-Device-Token header.
      const noDevice = await rawCall(handler, config, "/api/push/unwatch", { method: "POST" }, config.token);
      expect(noDevice.status).toBe(400);
      // Authenticated with an unregistered device token.
      const badDevice = await rawCall(
        handler,
        config,
        "/api/push/unwatch",
        { method: "POST", headers: { "x-device-token": "tok_ghost" } },
        config.token
      );
      expect(badDevice.status).toBe(403);
    });
  });

  describe("cors", () => {
    // Save/restore the env override so individual cases don't leak.
    function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
      const prior = process.env.GINI_CORS_ORIGINS;
      if (value === undefined) delete process.env.GINI_CORS_ORIGINS;
      else process.env.GINI_CORS_ORIGINS = value;
      return fn().finally(() => {
        if (prior === undefined) delete process.env.GINI_CORS_ORIGINS;
        else process.env.GINI_CORS_ORIGINS = prior;
      });
    }

    test("preflight from an allowed origin returns 204 with CORS headers", async () => {
      await withEnv(undefined, async () => {
        const config = testConfig("cors-preflight-allowed");
        const handler = createHandler(config);
        const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:8090",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization"
          }
        }));
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8090");
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        expect(response.headers.get("vary")).toBe("Origin");
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        expect(response.headers.get("access-control-allow-methods")).toContain("POST");
        expect(response.headers.get("access-control-allow-headers") ?? "").toContain("Authorization");
        expect(response.headers.get("access-control-allow-headers") ?? "").toContain("X-Device-Token");
        expect(response.headers.get("access-control-allow-headers") ?? "").toContain("Last-Event-ID");
        expect(response.headers.get("access-control-max-age")).toBe("600");
      });
    });

    test("preflight from a disallowed origin returns 204 without allow-origin", async () => {
      await withEnv(undefined, async () => {
        const config = testConfig("cors-preflight-disallowed");
        const handler = createHandler(config);
        const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          method: "OPTIONS",
          headers: {
            origin: "http://evil.example.com",
            "access-control-request-method": "GET"
          }
        }));
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        // The protocol-level headers still go out — they describe what
        // the server *would* accept; the browser rejects because of the
        // missing allow-origin.
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
      });
    });

    test("normal GET from an allowed origin gets CORS headers", async () => {
      await withEnv(undefined, async () => {
        const config = testConfig("cors-get-allowed");
        const handler = createHandler(config);
        const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          headers: {
            origin: "http://localhost:3045",
            authorization: `Bearer ${config.token}`
          }
        }));
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3045");
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        expect(response.headers.get("vary")).toBe("Origin");
        expect(response.headers.get("access-control-expose-headers")).toBe("Last-Event-ID");
      });
    });

    test("non-browser caller without Origin gets no CORS headers", async () => {
      await withEnv(undefined, async () => {
        const config = testConfig("cors-no-origin");
        const handler = createHandler(config);
        const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          headers: { authorization: `Bearer ${config.token}` }
        }));
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("vary")).toBeNull();
      });
    });

    test("401 responses still carry CORS headers so the browser sees the status", async () => {
      await withEnv(undefined, async () => {
        const config = testConfig("cors-401");
        const handler = createHandler(config);
        const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          headers: { origin: "http://localhost:8090" } // no Authorization
        }));
        expect(response.status).toBe(401);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8090");
      });
    });

    test("GINI_CORS_ORIGINS env var overrides the default allowlist", async () => {
      await withEnv("https://example.com", async () => {
        const config = testConfig("cors-custom-env");
        const handler = createHandler(config);

        const allowed = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          headers: {
            origin: "https://example.com",
            authorization: `Bearer ${config.token}`
          }
        }));
        expect(allowed.headers.get("access-control-allow-origin")).toBe("https://example.com");

        // The defaults (localhost:8090, etc) should NOT be honored when
        // the env var is set — it's a full override, not an additive list.
        const denied = await handler(new Request(`http://127.0.0.1:${config.port}/api/status`, {
          headers: {
            origin: "http://localhost:8090",
            authorization: `Bearer ${config.token}`
          }
        }));
        expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      });
    });
  });
});

describe("GET /api/files", () => {
  test("returns content, absolute path, and name for an existing text file", async () => {
    const config = testConfig("files-read-ok");
    const workspace = `/tmp/gini-files-test-${Date.now()}`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/note.md`, "# Hello\n");
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=note.md");
    expect(file.name).toBe("note.md");
    expect(file.absolutePath).toBe(`${workspace}/note.md`);
    expect(file.content).toBe("# Hello\n");
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("rejects a path that escapes the workspace with 400", async () => {
    const config = testConfig("files-escape-400");
    const workspace = `/tmp/gini-files-test-${Date.now()}-escape`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=../outside.txt", {}, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("outside workspace");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns 404 for a non-existent file", async () => {
    const config = testConfig("files-missing-404");
    const workspace = `/tmp/gini-files-test-${Date.now()}-missing`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=nope.txt", {}, config.token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("File not found");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("reports a binary file without returning its content", async () => {
    const config = testConfig("files-binary");
    const workspace = `/tmp/gini-files-test-${Date.now()}-binary`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/blob.bin`, Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=blob.bin");
    expect(file.binary).toBe(true);
    expect(file.content).toBe(null);
    expect(file.bytes).toBe(4);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns 400 for a directory", async () => {
    const config = testConfig("files-directory");
    const workspace = `/tmp/gini-files-test-${Date.now()}-directory`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    mkdirSync(`${workspace}/sub`);
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=sub", {}, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Not a file");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("truncates a file larger than the read cap", async () => {
    const config = testConfig("files-truncate");
    const workspace = `/tmp/gini-files-test-${Date.now()}-truncate`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/big.txt`, "a".repeat(600 * 1024));
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=big.txt");
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(512 * 1024);
    expect(file.bytes).toBe(600 * 1024);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("raw=1 streams the file as a download attachment", async () => {
    const config = testConfig("files-raw");
    const workspace = `/tmp/gini-files-test-${Date.now()}-raw`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/note.md`, "# Hello\nworld\n");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=note.md&raw=1", {}, config.token);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("note.md");
    expect(await response.text()).toBe("# Hello\nworld\n");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("raw=1 download for a non-ASCII filename returns 200 with both header forms", async () => {
    const config = testConfig("files-raw-unicode");
    const workspace = `/tmp/gini-files-test-${Date.now()}-raw-unicode`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/café.md`, "# Hello\n");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, `/api/files?path=${encodeURIComponent("café.md")}&raw=1`, {}, config.token);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename="caf_.md"`);
    expect(disposition).toContain("filename*=UTF-8''");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 serves a PDF inline with the application/pdf content-type", async () => {
    const config = testConfig("files-inline-pdf");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-pdf`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/doc.pdf`, Buffer.from("%PDF-1.4\n"));
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=doc.pdf&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("inline");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 serves a PNG inline with the image/png content-type", async () => {
    const config = testConfig("files-inline-png");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-png`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/pic.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=pic.png&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 never serves an SVG inline — falls back to attachment download", async () => {
    const config = testConfig("files-inline-svg");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-svg`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/evil.svg`, "<svg onload=\"alert(1)\"></svg>");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=evil.svg&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition") ?? "").toContain("attachment");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 never serves HTML inline — falls back to attachment download", async () => {
    const config = testConfig("files-inline-html");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-html`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/evil.html`, "<script>alert(1)</script>");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=evil.html&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition") ?? "").toContain("attachment");

    rmSync(workspace, { recursive: true, force: true });
  });

  // The upload gate accepts any plausible MIME, not just images/audio. These
  // build the multipart request directly (not via call/rawCall, which pin
  // content-type: application/json) so FormData sets its own multipart
  // boundary header.
  test("POST /api/uploads accepts an application/pdf file and serves it back", async () => {
    const config = testConfig("uploads-pdf");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "report.pdf", { type: "application/pdf" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(201);
    const ref = await response.json();
    expect(ref.mimeType).toBe("application/pdf");

    const fetched = await rawCall(handler, config, `/api/uploads/${ref.id}`, {}, config.token);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/pdf");
    // Arbitrary MIME is accepted, so served uploads are forced to download and
    // never sniffed — a text/html or SVG upload can't execute on the app origin.
    expect(fetched.headers.get("content-disposition")).toBe("attachment");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    // The full-body response advertises range support so a media client knows
    // it may stream via byte ranges (iOS AVPlayer requires this to play remote
    // audio at all).
    expect(fetched.headers.get("accept-ranges")).toBe("bytes");
  });

  // `?inline=1` opts a safe-allowlisted upload into content-disposition: inline
  // so a file/PDF chip can open it as a preview in a browser tab instead of
  // forcing a download. These pin the per-mime allowlist decisions (the SSRF /
  // top-level-script surface lives in the unsafe branches).
  test("GET /api/uploads?inline=1 serves a PDF inline with its real type", async () => {
    const config = testConfig("uploads-inline-pdf");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "report.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("GET /api/uploads?inline=1 serves a PNG inline with its real type", async () => {
    const config = testConfig("uploads-inline-png");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "shot.png");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("GET /api/uploads?inline=1 coerces a markdown upload to text/plain inline", async () => {
    const config = testConfig("uploads-inline-md");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("# Title\n"), "text/markdown", "notes.md");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    // Coerced to text/plain so the browser shows raw text rather than
    // interpreting/executing the payload as a document.
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("GET /api/uploads?inline=1 never serves an SVG inline — keeps attachment", async () => {
    const config = testConfig("uploads-inline-svg");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("<svg/>"), "image/svg+xml", "x.svg");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("GET /api/uploads?inline=1 never serves HTML inline — keeps attachment", async () => {
    const config = testConfig("uploads-inline-html");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("<h1>x</h1>"), "text/html", "x.html");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("resolveInlineUpload returns null without the inline param and gates by mime", () => {
    // No inline param → always download, regardless of a safe mime.
    expect(resolveInlineUpload(null, "application/pdf")).toBeNull();
    expect(resolveInlineUpload("", "application/pdf")).toBeNull();
    // Safe direct image/pdf → its own type.
    expect(resolveInlineUpload("1", "application/pdf")).toEqual({ contentType: "application/pdf" });
    expect(resolveInlineUpload("1", "image/jpeg")).toEqual({ contentType: "image/jpeg" });
    // Text-like → coerced to text/plain.
    expect(resolveInlineUpload("1", "text/csv")).toEqual({ contentType: "text/plain; charset=utf-8" });
    expect(resolveInlineUpload("1", "application/json")).toEqual({ contentType: "text/plain; charset=utf-8" });
    // Unsafe / unknown → null (download).
    expect(resolveInlineUpload("1", "image/svg+xml")).toBeNull();
    expect(resolveInlineUpload("1", "text/html")).toBeNull();
    expect(resolveInlineUpload("1", "application/octet-stream")).toBeNull();
  });

  // A mobile in-app browser can't send the bearer header or the gateway cookie,
  // so the app mints a short-lived SIGNED url (POST /api/uploads/:id/sign) and
  // opens that. These pin: the mint is bearer-gated, the signed url authorizes a
  // header-less GET, and the signature is scoped + expiring.
  test("POST /api/uploads/:id/sign mints a signed path that authorizes a header-less GET", async () => {
    const config = testConfig("uploads-sign-ok");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "report.pdf");

    const minted = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }, config.token);
    expect(minted.status).toBe(200);
    const body = await minted.json();
    expect(body.path).toContain(`/api/uploads/${ref.id}?inline=1`);
    expect(body.path).toMatch(/[?&]exp=\d+/);
    expect(body.path).toMatch(/[?&]sig=[0-9a-f]{64}/);
    expect(typeof body.exp).toBe("number");

    // The signed path authorizes a GET with NO Authorization header.
    const got = await rawCall(handler, config, body.path, {});
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toBe("inline");
  });

  test("the mint endpoint itself still requires a bearer", async () => {
    const config = testConfig("uploads-sign-gated");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }); // no token
    expect(res.status).toBe(401);
  });

  test("signing an unknown upload id returns 404 (no signature for absent bytes)", async () => {
    const config = testConfig("uploads-sign-404");
    const handler = createHandler(config);
    const res = await rawCall(handler, config, `/api/uploads/does-not-exist/sign`, { method: "POST" }, config.token);
    expect(res.status).toBe(404);
  });

  test("an unsigned, unauthenticated upload GET is rejected 401", async () => {
    const config = testConfig("uploads-sign-unsigned");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}); // no token, no sig
    expect(res.status).toBe(401);
  });

  test("a tampered upload id on a signed url fails (signature is scoped to one id)", async () => {
    const config = testConfig("uploads-sign-scope");
    const handler = createHandler(config);
    const a = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "a.pdf");
    const b = storeUpload(config.instance, new Uint8Array([4, 5, 6]), "application/pdf", "b.pdf");
    const minted = await rawCall(handler, config, `/api/uploads/${a.id}/sign`, { method: "POST" }, config.token);
    const { path } = await minted.json();
    // Swap a's id for b's id but keep a's signature → must fail.
    const sig = new URL(`http://x${path}`).searchParams.get("sig");
    const exp = new URL(`http://x${path}`).searchParams.get("exp");
    const forged = `/api/uploads/${b.id}?inline=1&exp=${exp}&sig=${sig}`;
    const res = await rawCall(handler, config, forged, {});
    expect(res.status).toBe(401);
  });

  test("an expired signature is rejected 401", async () => {
    const config = testConfig("uploads-sign-expired");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    // Mint with the minimum TTL clamp (30s), then forge an already-past exp by
    // re-signing with a past timestamp using the same module the gateway uses.
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const { signUploadParams } = await import("./lib/upload-signing");
    const { sig } = signUploadParams(config.token, ref.id, pastExp);
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1&exp=${pastExp}&sig=${sig}`, {});
    expect(res.status).toBe(401);
  });

  test("a caller-supplied ?ttl= is honored and clamped to the [30,600]s ceiling", async () => {
    const config = testConfig("uploads-sign-ttl");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "x.pdf");

    // An in-range ttl rides through unchanged; an over-max one clamps to 600.
    // The exp the mint returns is now + clampedTtl, so assert exp lands within a
    // small window of that target (a couple seconds for clock drift across the call).
    const now = Math.floor(Date.now() / 1000);
    const inRange = await rawCall(handler, config, `/api/uploads/${ref.id}/sign?ttl=120`, { method: "POST" }, config.token);
    expect(inRange.status).toBe(200);
    expect((await inRange.json()).exp - now).toBeLessThanOrEqual(122);

    const clamped = await rawCall(handler, config, `/api/uploads/${ref.id}/sign?ttl=99999`, { method: "POST" }, config.token);
    expect(clamped.status).toBe(200);
    const clampedExp = (await clamped.json()).exp - Math.floor(Date.now() / 1000);
    expect(clampedExp).toBeGreaterThan(595);
    expect(clampedExp).toBeLessThanOrEqual(600);
  });

  test("a signed HEAD is also authorized (in-app browser preflight)", async () => {
    const config = testConfig("uploads-sign-head");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "x.pdf");
    const minted = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }, config.token);
    const { path } = await minted.json();
    const res = await rawCall(handler, config, path, { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  // iOS AVPlayer won't start a remote audio AVURLAsset unless the server honors
  // Range requests (206 + Content-Range). These pin the range semantics of the
  // upload GET so a regression can't silently break voice-message playback.
  test("GET /api/uploads honors a bounded Range with 206 + Content-Range", async () => {
    const config = testConfig("uploads-range-bounded");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=0-9" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("GET /api/uploads serves a mid-file Range slice with exact bytes", async () => {
    const config = testConfig("uploads-range-mid");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=10-19" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("GET /api/uploads clamps an over-long Range end to the last byte", async () => {
    const config = testConfig("uploads-range-clamp");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=40-999" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 40-49/50");
    expect(res.headers.get("content-length")).toBe("10");
  });

  test("GET /api/uploads serves an open-ended Range to EOF", async () => {
    const config = testConfig("uploads-range-open");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=48-" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 48-49/50");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([48, 49]);
  });

  test("GET /api/uploads serves a suffix Range (last N bytes)", async () => {
    const config = testConfig("uploads-range-suffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-5" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 45-49/50");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([45, 46, 47, 48, 49]);
  });

  test("GET /api/uploads returns 416 for a Range starting past EOF", async () => {
    const config = testConfig("uploads-range-416");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=999-" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */50");
  });

  test("GET /api/uploads ignores a malformed Range and serves the full 200 body", async () => {
    const config = testConfig("uploads-range-malformed");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "lines=1-2" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("GET /api/uploads treats a reversed Range (start>end) as malformed → full 200", async () => {
    const config = testConfig("uploads-range-reversed");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=20-10" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
  });

  test("GET /api/uploads treats an empty suffix Range (bytes=-) as malformed → full 200", async () => {
    const config = testConfig("uploads-range-emptysuffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
  });

  test("GET /api/uploads returns 416 for a zero-length suffix Range (bytes=-0)", async () => {
    const config = testConfig("uploads-range-zerosuffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-0" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */50");
  });

  test("GET /api/uploads returns 416 for any Range against a zero-byte upload", async () => {
    const config = testConfig("uploads-range-empty-file");
    const handler = createHandler(config);
    // storeUpload rejects an empty body, so write the manifest+bytes directly to
    // exercise the total===0 branch (a 0-byte stored file can't satisfy a range).
    const ref = storeUpload(config.instance, new Uint8Array([1]), "audio/wav");
    writeFileSync(join(uploadsDir(config.instance), `${ref.id}.wav`), new Uint8Array([]));

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=0-10" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */0");
  });

  test("HEAD /api/uploads advertises accept-ranges and the content length", async () => {
    const config = testConfig("uploads-head-range");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 42 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      method: "HEAD"
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("42");
  });

  test("POST /api/uploads accepts a text/csv file", async () => {
    const config = testConfig("uploads-csv");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(201);
    const ref = await response.json();
    expect(ref.mimeType).toBe("text/csv");
  });

  // The 415 gate fires on a structurally-invalid mime (no slash / whitespace).
  // It can't be reached through a real request: Bun's server-side
  // request.formData() normalizes an invalid part Content-Type (e.g.
  // "notamime") to application/octet-stream, and its File/FormData encoder
  // sniffs the part mime from the filename extension — either way the part
  // arrives plausible, so the predicate is exercised directly to pin the
  // 415-triggering condition.
  test("isPlausibleMime rejects structurally-invalid mimes (the 415 gate)", () => {
    expect(isPlausibleMime("notamime")).toBe(false);
    expect(isPlausibleMime("text/csv")).toBe(true);
    expect(isPlausibleMime("application/pdf")).toBe(true);
  });

  test("POST /api/uploads rejects an empty file with 400", async () => {
    const config = testConfig("uploads-empty");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File([], "empty.csv", { type: "text/csv" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(400);
  });

  test("POST /api/uploads rejects a file over the size cap with 413", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      const config = testConfig("uploads-toolarge");
      const handler = createHandler(config);
      const form = new FormData();
      form.set("file", new File(["this body is well over ten bytes"], "big.csv", { type: "text/csv" }));
      const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
        body: form
      }));
      expect(response.status).toBe(413);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("storeUpload sanitizes a filename with embedded newline/control chars to a single line", () => {
    const config = testConfig("uploads-filename");
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "text/csv", "a\nb\t\rc.csv");
    const stat = uploadStat(config.instance, ref.id);
    expect(stat?.filename).toBe("a b c.csv");
    expect(stat?.filename).not.toContain("\n");
  });

  // The exported sanitizeFilename is also applied at the model-facing render
  // in buildAttachmentContent, covering manifests written outside storeUpload.
  test("sanitizeFilename strips control chars, collapses whitespace, and caps length", () => {
    expect(sanitizeFilename("a\nb\tc.csv")).toBe("a b c.csv");
    expect(sanitizeFilename("x".repeat(300)).length).toBe(255);
  });
});

describe("GET /api/docs", () => {
  test("returns the requested doc section markdown and title", async () => {
    const config = testConfig("docs-section");
    const handler = createHandler(config);

    const doc = await call(handler, config, "/api/docs/providers/codex?section=re-authentication");
    expect(doc.title).toBe("Codex");
    expect(doc.anchor).toBe("re-authentication");
    expect(doc.markdown).toContain("## Re-authentication");
  });

  test("requires authentication", async () => {
    const config = testConfig("docs-unauth");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/docs/providers/codex");
    expect(response.status).toBe(401);
  });

  test("rejects a traversal path with 400", async () => {
    const config = testConfig("docs-traversal");
    const handler = createHandler(config);

    // Percent-encode the slashes so the WHATWG URL parser doesn't collapse the
    // `..` segments away — a literal `/api/docs/../package` normalizes to
    // `/api/package` and 404s before this route matches. Encoded, the route
    // matches and resolveDocPath's confinement check rejects the escaping path.
    const response = await rawCall(handler, config, "/api/docs/..%2F..%2Fpackage", {}, config.token);
    expect(response.status).toBe(400);
  });
});

describe("agent-chat and thread endpoints", () => {
  test("GET /api/agents/:id/chat returns a stable single session across calls", async () => {
    const config = testConfig("agent-chat-resolve");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Nova" })
    });

    const first = await call(handler, config, `/api/agents/${agent.id}/chat`);
    const second = await call(handler, config, `/api/agents/${agent.id}/chat`);

    expect(first.id).toBeString();
    expect(first.kind).toBe("agent");
    expect(first.agentId).toBe(agent.id);
    expect(second.id).toBe(first.id);
  });

  test("GET /api/chat/:id/threads lists threads and 404s on a missing session", async () => {
    const config = testConfig("thread-list");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Sage" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    // Root the thread off a main-chat assistant block, then add an agent
    // reply inside the thread.
    const root = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Here is the research plan.",
      streaming: false,
      agentId: agent.id
    });
    insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Step one is done.",
      streaming: false,
      agentId: agent.id,
      threadId: "thread_one",
      parentBlockId: root.id
    });

    const threads = await call(handler, config, `/api/chat/${session.id}/threads`);
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe("thread_one");
    expect(threads[0].parentBlockId).toBe(root.id);
    expect(threads[0].lastReplyAuthor).toBe("agent");
    expect(threads[0].rootPreview).toContain("research plan");

    const missing = await rawCall(handler, config, "/api/chat/chat_nope/threads", {}, config.token);
    expect(missing.status).toBe(404);
  });

  test("GET /api/chat/:id/threads/:tid/blocks returns the thread's blocks and 404s on a missing session", async () => {
    const config = testConfig("thread-blocks");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Scout" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    const root = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Parent message",
      streaming: false,
      agentId: agent.id
    });
    const reply = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Threaded reply",
      streaming: false,
      agentId: agent.id,
      threadId: "thread_blocks",
      parentBlockId: root.id
    });
    // A main-chat block that must NOT leak into the thread fetch.
    insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Main chat only",
      streaming: false,
      agentId: agent.id
    });

    const blocks = await call(handler, config, `/api/chat/${session.id}/threads/thread_blocks/blocks`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(reply.id);
    expect(blocks[0].threadId).toBe("thread_blocks");

    const missing = await rawCall(handler, config, "/api/chat/chat_nope/threads/thread_blocks/blocks", {}, config.token);
    expect(missing.status).toBe(404);
  });

  test("POST /api/chat/:id/threads/:tid/messages tags the block + task and mirrors to main with alsoToMain", async () => {
    const config = testConfig("thread-reply");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Echo" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    const root = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Original answer",
      streaming: false,
      agentId: agent.id
    });
    insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "First thread reply",
      streaming: false,
      agentId: agent.id,
      threadId: "thread_reply",
      parentBlockId: root.id
    });

    const submitted = await call(handler, config, `/api/chat/${session.id}/threads/thread_reply/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "follow up in the thread", alsoToMain: true })
    });

    expect(submitted.threadId).toBe("thread_reply");
    expect(submitted.taskId).toBeString();

    // The spawned task carries the thread membership so the whole response
    // threads (resolveEmitContext reads these off the task).
    const task = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    expect(task?.threadId).toBe("thread_reply");
    expect(task?.parentBlockId).toBe(root.id);

    // The user reply lands as a thread-tagged user_text block...
    const threadBlocks = await call(handler, config, `/api/chat/${session.id}/threads/thread_reply/blocks`);
    const threadUser = threadBlocks.find(
      (b: { kind: string; text?: string }) => b.kind === "user_text" && b.text === "follow up in the thread"
    );
    expect(threadUser.threadId).toBe("thread_reply");
    expect(threadUser.parentBlockId).toBe(root.id);

    // ...and alsoToMain mirrors it as an un-threaded main-chat user_text block.
    const allBlocks = await call(handler, config, `/api/chat/${session.id}/blocks`);
    const mainMirror = allBlocks.filter(
      (b: { kind: string; text?: string; threadId?: string }) =>
        b.kind === "user_text" && b.text === "follow up in the thread" && b.threadId === undefined
    );
    expect(mainMirror).toHaveLength(1);
  });

  test("POST /api/chat/:id/threads/:tid/messages 404s when the thread does not exist", async () => {
    const config = testConfig("thread-reply-missing");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Vega" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    const response = await rawCall(handler, config, `/api/chat/${session.id}/threads/thread_absent/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "no thread here" })
    }, config.token);
    expect(response.status).toBe(404);
    const value = await response.json();
    expect(String(value.error)).toContain("Thread not found");
  });

  test("POST /api/chat/:id/threads/:tid/messages 404s with Chat session not found on a bad session", async () => {
    const config = testConfig("thread-reply-bad-session");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/chat/chat_nope/threads/thread_one/messages", {
      method: "POST",
      body: JSON.stringify({ content: "no session here" })
    }, config.token);
    expect(response.status).toBe(404);
    const value = await response.json();
    expect(String(value.error)).toContain("Chat session not found");
  });

  test("POST /api/chat/:id/threads/:tid/messages creates a new thread off a main-chat parent block", async () => {
    const config = testConfig("thread-reply-create");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Orion" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    // A main-chat assistant block the user branches a brand-new thread from.
    const parent = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: session.id,
      text: "Here is my plan.",
      streaming: false,
      agentId: agent.id
    });

    // No prior blocks under thread_fresh — the parentBlockId in the body is
    // what brings the thread into existence.
    const submitted = await call(handler, config, `/api/chat/${session.id}/threads/thread_fresh/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "kick off the thread", parentBlockId: parent.id })
    });

    expect(submitted.threadId).toBe("thread_fresh");
    expect(submitted.taskId).toBeString();

    // The spawned task carries the new thread's membership.
    const task = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    expect(task?.threadId).toBe("thread_fresh");
    expect(task?.parentBlockId).toBe(parent.id);

    // The user reply lands as a thread-tagged user_text block rooted at the
    // parent, so the thread now exists and renders in the panel.
    const threadBlocks = await call(handler, config, `/api/chat/${session.id}/threads/thread_fresh/blocks`);
    const threadUser = threadBlocks.find(
      (b: { kind: string; text?: string }) => b.kind === "user_text" && b.text === "kick off the thread"
    );
    expect(threadUser.threadId).toBe("thread_fresh");
    expect(threadUser.parentBlockId).toBe(parent.id);
  });

  test("POST /api/chat/:id/threads/:tid/messages 404s when starting a new thread without a parent block", async () => {
    const config = testConfig("thread-reply-create-noparent");
    const handler = createHandler(config);

    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Lyra" })
    });
    const session = await call(handler, config, `/api/agents/${agent.id}/chat`);

    const response = await rawCall(handler, config, `/api/chat/${session.id}/threads/thread_new/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "no parent supplied" })
    }, config.token);
    expect(response.status).toBe(404);
    const value = await response.json();
    expect(String(value.error)).toContain("Thread not found");
  });

  test("GET /api/threads aggregates across agent sessions with agentName, newest first", async () => {
    const config = testConfig("threads-inbox");
    const handler = createHandler(config);

    const nova = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Nova" })
    });
    const sage = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Sage" })
    });
    const novaChat = await getOrCreateAgentChat(config.instance, nova.id);
    const sageChat = await getOrCreateAgentChat(config.instance, sage.id);

    // Nova's thread (older last reply).
    const novaRoot = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: novaChat.id,
      text: "Nova parent",
      streaming: false,
      agentId: nova.id
    });
    insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: novaChat.id,
      text: "Nova thread reply",
      streaming: false,
      agentId: nova.id,
      threadId: "thread_nova",
      parentBlockId: novaRoot.id
    });

    // Sage's thread (newer last reply — must sort first).
    await Bun.sleep(2);
    const sageRoot = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId: sageChat.id,
      text: "Sage parent",
      streaming: false,
      agentId: sage.id
    });
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: sageChat.id,
      text: "Sage thread reply",
      agentId: sage.id,
      threadId: "thread_sage",
      parentBlockId: sageRoot.id
    });

    const inbox = await call(handler, config, "/api/threads");
    expect(inbox).toHaveLength(2);
    // Newest last reply first.
    expect(inbox[0].threadId).toBe("thread_sage");
    expect(inbox[0].agentName).toBe("Sage");
    expect(inbox[0].lastReplyAuthor).toBe("user");
    expect(inbox[1].threadId).toBe("thread_nova");
    expect(inbox[1].agentName).toBe("Nova");
    expect(inbox[1].lastReplyAuthor).toBe("agent");

    // filter=unread is accepted but returns the full list (client filters).
    const all = await call(handler, config, "/api/threads?filter=unread");
    expect(all).toHaveLength(2);
  });

  test("GET /api/logs requires the bearer", async () => {
    const config = testConfig("logs-auth");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/logs");
    expect(response.status).toBe(401);
  });

  test("GET /api/logs returns parsed runtime entries by default", async () => {
    const config = testConfig("logs-runtime");
    const handler = createHandler(config);
    seedLogFile(config, "runtime.jsonl",
      `${JSON.stringify({ at: "2026-06-07T00:00:00.000Z", message: "boot", data: { token: "sk-secret-1" } })}\n` +
      `${JSON.stringify({ at: "2026-06-07T00:00:01.000Z", message: "ready" })}\n`
    );
    const tail = await call(handler, config, "/api/logs");
    expect(tail.stream).toBe("runtime");
    expect(tail.redacted).toBe(false);
    expect(tail.entries).toHaveLength(2);
    // Raw mode keeps the data payload untouched.
    expect(tail.entries[0].data).toEqual({ token: "sk-secret-1" });
    expect(tail.lines).toBeUndefined();
  });

  test("GET /api/logs honors the stream param and returns raw lines", async () => {
    const config = testConfig("logs-stream");
    const handler = createHandler(config);
    seedLogFile(config, "web.log", "web line 1\nweb line 2\n");
    const tail = await call(handler, config, "/api/logs?stream=web");
    expect(tail.stream).toBe("web");
    expect(tail.lines).toEqual(["web line 1", "web line 2"]);
    expect(tail.entries).toBeUndefined();
  });

  test("GET /api/logs with redact=true drops data and scrubs secrets", async () => {
    const config = testConfig("logs-redact");
    const handler = createHandler(config);
    seedLogFile(config, "runtime.jsonl",
      `${JSON.stringify({ at: "2026-06-07T00:00:00.000Z", message: "auth Bearer sk-leak-123", data: { token: "sk-leak-123" } })}\n`
    );
    const tail = await call(handler, config, "/api/logs?redact=true");
    expect(tail.redacted).toBe(true);
    expect(tail.entries).toHaveLength(1);
    expect(tail.entries[0].data).toBeUndefined();
    expect(tail.entries[0].message).not.toContain("sk-leak-123");
    expect(tail.entries[0].message).toContain("[redacted]");
  });

  test("GET /api/logs rejects an unknown stream with 400", async () => {
    const config = testConfig("logs-unknown");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/logs?stream=audit", {}, config.token);
    expect(response.status).toBe(400);
  });

  test("GET /api/logs clamps the limit to the most recent lines", async () => {
    const config = testConfig("logs-limit");
    const handler = createHandler(config);
    const body = Array.from({ length: 6 }, (_, i) => JSON.stringify({ message: `m${i}` })).join("\n") + "\n";
    seedLogFile(config, "runtime.jsonl", body);
    const tail = await call(handler, config, "/api/logs?limit=2");
    expect(tail.truncated).toBe(true);
    expect(tail.entries.map((e: { message: string }) => e.message)).toEqual(["m4", "m5"]);
  });
});

describe("email watcher routes", () => {
  test("GET /api/email/watchers is scoped to the active agent", async () => {
    const config = testConfig("http-email-list-scope");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });

    // A watcher created under the default agent.
    const underDefault = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "alice@example.com" })
    });
    // Switch to scout and create another watcher under it.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const underScout = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com" })
    });

    // GET now reflects the active agent (scout) — only its watcher.
    const scoutList = await call(handler, config, "/api/email/watchers");
    expect(scoutList.map((w: { id: string }) => w.id)).toEqual([(underScout as { id: string }).id]);

    // Switch back: GET returns only the default agent's watcher.
    await call(handler, config, `/api/agents/${defaultAgentId}/use`, { method: "POST" });
    const defaultList = await call(handler, config, "/api/email/watchers");
    expect(defaultList.map((w: { id: string }) => w.id)).toEqual([(underDefault as { id: string }).id]);
  });

  test("PATCH /api/email/watchers/:id toggles enabled and tears down / recreates the shared job", async () => {
    const config = testConfig("http-email-patch");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "alice@example.com" })
    });
    const id = (created as { id: string }).id;
    const jobId = (created as { jobId: string }).jobId;
    expect(jobId).toBeString();
    // The shared email-watch job is active and watches this sole watcher.
    const sharedJob = () =>
      readState(config.instance).jobs.find(
        (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
      );
    expect(sharedJob()?.id).toBe(jobId);
    expect(sharedJob()?.status).toBe("active");

    // Disabling the sole watcher tears the shared job down (nothing to poll).
    const disabled = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    expect((disabled as { enabled: boolean }).enabled).toBe(false);
    expect(sharedJob()).toBeUndefined();

    // Re-enabling recreates the shared job and re-stamps the watcher's jobId.
    const enabled = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true })
    });
    expect((enabled as { enabled: boolean }).enabled).toBe(true);
    expect(sharedJob()).toBeDefined();
    expect((enabled as { jobId: string }).jobId).toBe(sharedJob()!.id);
  });

  test("PATCH /api/email/watchers/:id rejects a non-boolean enabled with 400", async () => {
    const config = testConfig("http-email-patch-bad");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com" })
    });
    const id = (created as { id: string }).id;
    const response = await rawCall(
      handler,
      config,
      `/api/email/watchers/${id}`,
      { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) },
      config.token
    );
    expect(response.status).toBe(400);
  });

  test("PATCH /api/email/watchers/:id returns 404 for an unknown watcher", async () => {
    const config = testConfig("http-email-patch-404");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/email/watchers/nope",
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("PATCH /api/email/watchers/:id clears the objective with an explicit null", async () => {
    const config = testConfig("http-email-patch-clear");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com", objective: "Get a refund" })
    });
    const id = (created as { id: string }).id;
    expect((created as { objective?: string }).objective).toBe("Get a refund");
    // Explicit null clears (distinct from omitted = unchanged, "" = 400).
    const cleared = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ objective: null })
    });
    expect((cleared as { objective?: string }).objective).toBeUndefined();
    // An empty-string objective is still rejected.
    const empty = await rawCall(
      handler,
      config,
      `/api/email/watchers/${id}`,
      { method: "PATCH", body: JSON.stringify({ objective: "" }) },
      config.token
    );
    expect(empty.status).toBe(400);
  });

  test("POST /api/google/accounts rejects a configDir outside the allowed roots", async () => {
    const config = testConfig("http-google-accounts-configdir");
    const handler = createHandler(config);
    // A relative path is rejected.
    const relative = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ tag: "x", configDir: "relative/gws" }) },
      config.token
    );
    expect(relative.status).toBe(400);
    expect((await relative.json()).error).toContain("configDir must be");
    // An absolute but unrelated path is rejected (defense-in-depth — never
    // reaches registerAccount / a real gws spawn).
    const arbitrary = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ tag: "x", configDir: "/etc/passwd" }) },
      config.token
    );
    expect(arbitrary.status).toBe(400);
    expect((await arbitrary.json()).error).toContain("configDir must be");
  });

  test("POST /api/google/accounts/provision requires all three credential fields", async () => {
    const config = testConfig("http-google-provision-400");
    const handler = createHandler(config);
    for (const body of [
      {},
      { clientId: "id", clientSecret: "secret" },
      { clientId: "id", refreshToken: "token" },
      { clientId: "id", clientSecret: "secret", refreshToken: "  " }
    ]) {
      const response = await rawCall(
        handler,
        config,
        "/api/google/accounts/provision",
        { method: "POST", body: JSON.stringify(body) },
        config.token
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("clientId, clientSecret, and refreshToken");
    }
  });

  test("POST /api/google/accounts/provision registers a trusted account (201)", async () => {
    const config = testConfig("http-google-provision-201");
    const handler = createHandler(config);
    // The registry is HOME-keyed (machine-global), so point HOME at a scratch
    // dir for the duration of this test.
    const prevHome = process.env.HOME;
    const scratchHome = join("/tmp/gini-http-tests", `provision-home-${process.pid}-${Date.now()}`);
    mkdirSync(scratchHome, { recursive: true });
    process.env.HOME = scratchHome;
    try {
      const response = await rawCall(
        handler,
        config,
        "/api/google/accounts/provision",
        {
          method: "POST",
          body: JSON.stringify({
            clientId: "edge-client",
            clientSecret: "edge-secret",
            refreshToken: "1//refresh",
            email: "ada@example.com",
            principal: "sub-ada"
          })
        },
        config.token
      );
      expect(response.status).toBe(201);
      const account = await response.json();
      expect(account.tag).toBe("ada");
      expect(account.provisioned).toBe(true);
      expect(existsSync(join(account.configDir, "credentials.json"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(scratchHome, { recursive: true, force: true });
    }
  });

  test("POST /api/google/accounts/provision with primary:true heals the hosted baked credential in place", async () => {
    const config = testConfig("http-google-provision-primary");
    const handler = createHandler(config);
    const prevHome = process.env.HOME;
    const prevHosted = process.env.GINI_HOSTED;
    const prevCred = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    const scratchHome = join("/tmp/gini-http-tests", `provision-primary-${process.pid}-${Date.now()}`);
    const credentialsFile = join(scratchHome, ".config", "gws-hosted", "credentials.json");
    mkdirSync(dirname(credentialsFile), { recursive: true });
    writeFileSync(credentialsFile, "{}");
    process.env.HOME = scratchHome;
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialsFile;
    try {
      const { ensureHostedPrimaryAccount } = await import("./integrations/connectors/google-accounts");
      const { readGoogleAccounts } = await import("./state/google-accounts");
      const primary = await ensureHostedPrimaryAccount();
      expect(primary?.tag).toBe("primary");

      const response = await rawCall(
        handler,
        config,
        "/api/google/accounts/provision",
        {
          method: "POST",
          body: JSON.stringify({
            clientId: "edge-client",
            clientSecret: "edge-secret",
            refreshToken: "1//healed",
            email: "wilson@example.com",
            principal: "sub-wilson",
            primary: true
          })
        },
        config.token
      );
      expect(response.status).toBe(201);
      const account = await response.json();
      // Landed on the baked primary row — no duplicate minted.
      expect(account.id).toBe(primary!.id);
      expect(account.configDir).toBe(dirname(credentialsFile));
      expect(readGoogleAccounts()).toHaveLength(1);
      // The fresh token overwrote the baked file gws actually reads.
      expect(JSON.parse(readFileSync(credentialsFile, "utf8")).refresh_token).toBe("1//healed");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevHosted === undefined) delete process.env.GINI_HOSTED;
      else process.env.GINI_HOSTED = prevHosted;
      if (prevCred === undefined) delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
      else process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = prevCred;
      rmSync(scratchHome, { recursive: true, force: true });
    }
  });

  test("POST /api/google/accounts/provision with makePrimary:true persists the account as the primary", async () => {
    const config = testConfig("http-google-provision-make-primary");
    const handler = createHandler(config);
    const prevHome = process.env.HOME;
    const scratchHome = join("/tmp/gini-http-tests", `provision-make-primary-${process.pid}-${Date.now()}`);
    mkdirSync(scratchHome, { recursive: true });
    process.env.HOME = scratchHome;
    try {
      const { readPrimaryGoogleAccountId } = await import("./state/google-accounts");
      const provision = (body: Record<string, unknown>) =>
        rawCall(
          handler,
          config,
          "/api/google/accounts/provision",
          { method: "POST", body: JSON.stringify(body) },
          config.token
        );
      // An add (no flag) never touches the primary.
      const added = await provision({
        clientId: "edge-client",
        clientSecret: "edge-secret",
        refreshToken: "1//refresh-a",
        email: "ada@example.com",
        principal: "sub-ada"
      });
      expect(added.status).toBe(201);
      expect(readPrimaryGoogleAccountId()).toBeUndefined();
      // A sign-in-intent provision flips the persisted primary to its account.
      const signedIn = await provision({
        clientId: "edge-client",
        clientSecret: "edge-secret",
        refreshToken: "1//refresh-b",
        email: "bob@example.com",
        principal: "sub-bob",
        makePrimary: true
      });
      expect(signedIn.status).toBe(201);
      const account = await signedIn.json();
      expect(readPrimaryGoogleAccountId()).toBe(account.id);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(scratchHome, { recursive: true, force: true });
    }
  });

  test("GET /api/google/auth-mode reflects the hosted marker", async () => {
    const config = testConfig("http-google-auth-mode");
    const handler = createHandler(config);
    const prevHosted = process.env.GINI_HOSTED;
    delete process.env.GINI_HOSTED;
    try {
      expect(await call(handler, config, "/api/google/auth-mode")).toEqual({ mode: "loopback" });
      process.env.GINI_HOSTED = "1";
      expect(await call(handler, config, "/api/google/auth-mode")).toEqual({ mode: "edge" });
    } finally {
      if (prevHosted === undefined) delete process.env.GINI_HOSTED;
      else process.env.GINI_HOSTED = prevHosted;
    }
  });

  test("POST /api/google/accounts no longer requires a tag (configDir validation still applies)", async () => {
    const config = testConfig("http-google-accounts-no-tag");
    const handler = createHandler(config);
    // A tag-less body reaches the configDir gate (previously a missing tag was
    // its own 400) — the register path derives the tag from the live session.
    const response = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ configDir: "relative/gws" }) },
      config.token
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("configDir must be");
  });

  test("GET /api/google/login/start 302s to Google consent with PKCE and the browser-facing redirect_uri", async () => {
    const config = testConfig("http-google-login-start");
    const handler = createHandler(config);
    const prevHosted = process.env.GINI_HOSTED;
    delete process.env.GINI_HOSTED;
    resetGoogleLoginWebState();
    try {
      const origin = encodeURIComponent("http://127.0.0.1:3059");
      const response = await rawCall(
        handler,
        config,
        `/api/google/login/start?returnTo=%2Fonboarding&origin=${origin}`,
        {},
        config.token
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.host).toBe("accounts.google.com");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:3059/api/runtime/google/login/callback"
      );
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("state")).toBeTruthy();
    } finally {
      if (prevHosted === undefined) delete process.env.GINI_HOSTED;
      else process.env.GINI_HOSTED = prevHosted;
      resetGoogleLoginWebState();
    }
  });

  test("GET /api/google/login/start 400s on a non-loopback origin and in edge auth mode", async () => {
    const config = testConfig("http-google-login-start-400");
    const handler = createHandler(config);
    const prevHosted = process.env.GINI_HOSTED;
    delete process.env.GINI_HOSTED;
    resetGoogleLoginWebState();
    try {
      const lan = await rawCall(
        handler,
        config,
        `/api/google/login/start?origin=${encodeURIComponent("http://192.168.1.20:3000")}`,
        {},
        config.token
      );
      expect(lan.status).toBe(400);
      expect((await lan.json()).error).toContain("loopback");
      process.env.GINI_HOSTED = "1";
      const edge = await rawCall(
        handler,
        config,
        `/api/google/login/start?origin=${encodeURIComponent("http://127.0.0.1:3059")}`,
        {},
        config.token
      );
      expect(edge.status).toBe(400);
      expect((await edge.json()).error).toContain("edge sign-in flow");
    } finally {
      if (prevHosted === undefined) delete process.env.GINI_HOSTED;
      else process.env.GINI_HOSTED = prevHosted;
      resetGoogleLoginWebState();
    }
  });

  test("GET /api/google/login/callback with an unknown state 302s back with googleAddError=1 (never an error page)", async () => {
    const config = testConfig("http-google-login-callback");
    const handler = createHandler(config);
    resetGoogleLoginWebState();
    const response = await rawCall(
      handler,
      config,
      "/api/google/login/callback?code=bogus&state=bogus",
      {},
      config.token
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding?step=accounts&googleAddError=1");
  });
});

describe("response compression", () => {
  // Seed enough audit rows that /api/state's JSON body clears the 1 KB
  // threshold, so the compressible-path assertions exercise real compression
  // rather than the too-small skip.
  async function seedBulkyState(config: RuntimeConfig): Promise<void> {
    // Awaited by every caller: mutateState is async (it chains on the
    // per-instance write lock), so without awaiting it the subsequent
    // readState in the request under test can race the write and read state
    // before the bulky audit rows land — intermittently dropping the body
    // under the 1 KB threshold and skipping compression.
    await mutateState(config.instance, (state) => {
      for (let i = 0; i < 200; i += 1) {
        addAudit(state, {
          actor: "runtime",
          action: "test.bulk",
          target: `row-${i}`,
          risk: "low",
          evidence: { note: "padding to push the state payload past the gzip threshold" }
        }, { system: true });
      }
    });
  }

  test("gzips a large JSON response when the client accepts only gzip", async () => {
    const config = testConfig("gzip-json");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary") ?? "").toContain("Accept-Encoding");
    // The body is real gzip and decodes back to valid JSON state.
    const compressed = new Uint8Array(await response.arrayBuffer());
    const decoded = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed)));
    expect(decoded.instance).toBe(config.instance);
    // The compressed transfer is materially smaller than the raw JSON.
    const rawLen = new TextEncoder().encode(JSON.stringify(decoded)).length;
    expect(compressed.byteLength).toBeLessThan(rawLen);
  });

  test("prefers brotli when the client accepts both br and gzip", async () => {
    const config = testConfig("br-json");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip, br" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary") ?? "").toContain("Accept-Encoding");
    // The body is real brotli and decodes back to valid JSON state.
    const { brotliDecompressSync } = await import("node:zlib");
    const compressed = new Uint8Array(await response.arrayBuffer());
    const decoded = JSON.parse(new TextDecoder().decode(brotliDecompressSync(compressed)));
    expect(decoded.instance).toBe(config.instance);
    const rawLen = new TextEncoder().encode(JSON.stringify(decoded)).length;
    expect(compressed.byteLength).toBeLessThan(rawLen);
  });

  test("falls back to gzip when br is explicitly opted out (br;q=0)", async () => {
    const config = testConfig("br-optout");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "br;q=0, gzip" } },
      config.token
    );
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  test("does not compress when the client omits Accept-Encoding", async () => {
    const config = testConfig("gzip-absent");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(handler, config, "/api/state", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    const body = await response.json();
    expect(body.instance).toBe(config.instance);
  });

  test("honors gzip;q=0 as an explicit opt-out", async () => {
    const config = testConfig("gzip-q0");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip;q=0" } },
      config.token
    );
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("leaves a small JSON response uncompressed (below threshold)", async () => {
    const config = testConfig("gzip-small");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/tasks?agentId=does_not_exist",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    // Body is still the intact (empty) JSON array.
    expect(await response.json()).toEqual([]);
  });

  test("never compresses an SSE event stream", async () => {
    const config = testConfig("gzip-sse");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    try {
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
      expect(response.headers.get("content-encoding")).toBeNull();
    } finally {
      await response.body?.cancel();
    }
  });

  test("never compresses a web-proxy path (only the native /api surface is compressed)", async () => {
    // /api/runtime/* is a web-proxy path (isWebProxyPath). Those responses are
    // reachable unauthenticated via the pairing bootstrap and are gzip'd by the
    // web child itself, so the gateway must NOT brotli/gzip them — that would
    // let an unauthenticated client burn CPU on compression before any session
    // check. Unauthenticated relay-less loopback returns 401 here, but the
    // point is the absence of a gateway-applied Content-Encoding regardless.
    const config = testConfig("gzip-webproxy");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/runtime/status",
      { headers: { "accept-encoding": "gzip, br" } }
    );
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("never compresses a 206 byte-range response (preserves Content-Range semantics)", async () => {
    // A compressible upload (text/csv) over the 1 KB threshold, fetched with a
    // Range. The 206 carries Content-Range computed on the UNENCODED bytes, so
    // adding Content-Encoding would corrupt the range contract (RFC 7233).
    const config = testConfig("gzip-range");
    const handler = createHandler(config);
    const bytes = new TextEncoder().encode("col_a,col_b,col_c\n" + "1,2,3\n".repeat(500));
    const ref = storeUpload(config.instance, bytes, "text/csv");
    const res = await rawCall(
      handler,
      config,
      `/api/uploads/${ref.id}`,
      { headers: { range: "bytes=0-1999", "accept-encoding": "br, gzip" } },
      config.token
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toContain("bytes 0-1999/");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  }));
  return response;
}

// Opens a chat SSE stream, pumps frames until the initial `chat_session`
// frame lands (which only happens inside the stream's start() — i.e. AFTER
// presence registration), runs the caller's `whileOpen` assertions, then
// ALWAYS cancels the reader in a finally so a thrown assertion can't leak
// the stream (its keepalive interval and presence entry would otherwise
// survive the test). Returns after the reader is cancelled.
async function withChatStream(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  sessionId: string,
  init: RequestInit,
  whileOpen: () => void
): Promise<void> {
  const response = await rawCall(handler, config, `/api/chat/${sessionId}/stream`, init, config.token);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: undefined }), 50)
        )
      ]);
      if (done) break;
      if (value) buffer += decoder.decode(value);
      if (buffer.includes("event: chat_session")) break;
    }
    expect(buffer).toContain("event: chat_session");
    whileOpen();
  } finally {
    await reader.cancel();
  }
  // cancel() runs the stream's cleanup synchronously in-process; give the
  // microtask queue one turn to settle before the caller asserts the
  // post-close registry state.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-http-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  // Drop the cached SQLite handle for this instance before nuking the
  // directory. Without this, a prior test that opened the per-instance
  // memory DB leaves an open `bun:sqlite` handle pointing at the now-
  // unlinked file. The next call to getMemoryDb returns that cached
  // handle (the cache key is the instance name) and any write fails
  // because the inode is gone. removeMemoryDb closes the cached handle
  // AND unlinks the file + WAL/SHM siblings in one shot.
  removeMemoryDb(instance);
  // resumeChatTask polls for the loop's flip to waiting_approval before
  // staging a tool result. In-process the flip lands within a couple of
  // mutateState boundaries, and several fill_secret / approval tests seed a
  // task that never reaches waiting_approval at all — so the production
  // 1000ms/100ms budget is pure dead wall here (the fill_secret leak test
  // measured 1079.00ms in isolation, nearly all of it this poll). Shrink the
  // budget via the server-side env knob the production code reads (default
  // preserved at 1000/100); the race still resolves well within 40ms over 5ms
  // ticks in-process.
  process.env.GINI_RESUME_WAIT_BUDGET_MS = "40";
  process.env.GINI_RESUME_WAIT_TICK_MS = "5";
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    // These tests predate the approval-mode flip and rely on the
    // gated path. Force "strict" to keep them honest; new defaults
    // are exercised in approval-mode.test.ts.
    approvalMode: "strict"
  };
}

// Write a log file under the test config's instance log dir so the /api/logs
// route reads it. testConfig nukes the instance state dir and points
// GINI_LOG_ROOT at a sibling tree, so this lands in a clean per-instance dir.
function seedLogFile(config: RuntimeConfig, filename: string, body: string): void {
  const dir = logDir(config.instance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
}

// Seed a typed api-key credential so the per-(skill, credential) consent gate
// (firstUngrantedCredential) treats it as carrying a secret that needs consent.
async function seedTypedCredential(config: RuntimeConfig, name: string, provider: string) {
  const at = new Date().toISOString();
  await mutateState(config.instance, (state) => {
    state.connectors.push({
      id: `id_${name}`,
      instance: state.instance,
      name,
      provider,
      type: "api-key",
      status: "configured",
      scopes: [],
      secretRefs: [{ purpose: name, path: `/tmp/${name}.json` }],
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "user"
    });
  });
}

async function waitForTask(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  taskId: string,
  // The approve endpoint returns at decision durability while the side
  // effect + resume run detached, so a post-approve wait must exclude
  // the still-parked waiting_approval status or it returns the
  // pre-approve park immediately.
  statuses: string[] = ["completed", "failed", "waiting_approval"]
) {
  // Phase 5 added auto-recall + auto-retain to runTask. The retain side is
  // fire-and-forget so it can't block, but the inline recall + a few extra
  // mutateState audits push runTask completion past the original 500ms
  // budget on slower hosts. A 200-iteration / 10ms loop = 2s ceiling is
  // still well under any reasonable test timeout.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (statuses.includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}
