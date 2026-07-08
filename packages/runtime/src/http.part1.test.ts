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
  const root = `/tmp/gini-http-tests-${import.meta.file}`;
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
