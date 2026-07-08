// Unit coverage for the mcp_call branch of dispatchToolCall.
//
// The dispatcher converts a `mcp_call` invocation into an
// invokeMcpTool call. We stub fetch at the HTTP transport so the test
// stays hermetic: no network, no spawned subprocess. The test covers:
//   - happy-path call returns the flattened content string
//   - oversized content is truncated and tagged
//   - unknown server name produces a structured error envelope
//   - missing required args throw before reaching the network

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, createChatSession, createMcpServerRecord, createTask, readState, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";
import { capToolResultText, dispatchToolCall, withPromoteFileAttachmentTag, ToolDisplayError } from "./tool-dispatch";

const ROOT = mkdtempSync(join(tmpdir(), "gini-mcp-dispatch-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
// Shrink the wait_for_messaging_pair poll interval so the three pairing tests
// don't each wait a full production 1000ms tick. Server-side env, deleted in
// afterAll; production leaves it unset and keeps the 1000ms default.
process.env.GINI_PAIR_POLL_MS = "10";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  delete process.env.GINI_PAIR_POLL_MS;
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  // Build the task directly on state — submitTask would also kick off the
  // chat-task loop, and we only need the row for the dispatcher to
  // attribute audits to. Also seed a real chat-session row and bind
  // it to the task so the chat-card surface guards (which refuse
  // both missing-chatSessionId AND stale-session-ref tasks) accept
  // the dispatch — production callers that hit those tools always
  // have a live session.
  const task = createTask(config.instance, "dispatch test");
  let sessionId = "";
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "dispatch test session");
    sessionId = session.id;
    task.chatSessionId = sessionId;
    upsertTask(state, task);
  });
  return task.id;
}

async function addServer(instance: string, opts: { name: string; url?: string; status?: "configured" | "error" | "disabled" }): Promise<string> {
  const result = await mutateState(instance, (state) => createMcpServerRecord(state, {
    name: opts.name,
    command: "",
    args: [],
    envKeys: [],
    exposedTools: [],
    transport: "http",
    url: opts.url ?? "https://example.test/mcp",
    headers: {}
  }));
  if (opts.status && opts.status !== "configured") {
    await mutateState(instance, (state) => {
      const s = state.mcpServers.find((m) => m.id === result.id);
      if (s) s.status = opts.status!;
    });
  }
  return result.id;
}

function sseResponse(body: object): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}

describe("mcp_call dispatch", () => {
  test("returns flattened text content on happy path", async () => {
    const instance = `mcp-dispatch-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear" });
    const taskId = await newTask(config);
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const id = init?.body ? JSON.parse(String(init.body)).id : 0;
      return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "[{\"id\":\"LIN-1\",\"title\":\"hi\"}]" }] } });
    }) as unknown as typeof fetch;
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "list_issues", arguments: {} }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("LIN-1");
    }
  });

  test("truncates content above 12000 chars", async () => {
    const instance = `mcp-trunc-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear" });
    const taskId = await newTask(config);
    const big = "x".repeat(20_000);
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const id = init?.body ? JSON.parse(String(init.body)).id : 0;
      return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: big }] } });
    }) as unknown as typeof fetch;
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "list_issues" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result.length).toBe(12_000 + "\n... (truncated)".length);
      expect(result.result.endsWith("(truncated)")).toBe(true);
    }
  });

  test("returns structured error for unknown server", async () => {
    const instance = `mcp-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "nope", tool: "x" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Unknown MCP server");
    }
  });

  test("throws on missing required args", async () => {
    const instance = `mcp-args-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await expect(dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ tool: "x" }))).rejects.toThrow(/server/);
  });

  test("rejects when server is not configured", async () => {
    const instance = `mcp-status-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear", status: "error" });
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "x" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not configured");
    }
  });
});

describe("request_connector dispatch", () => {
  test("returns structured error for unknown provider", async () => {
    const instance = `req-connector-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "not-a-real-provider", reason: "test" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Unknown provider");
    }
  });

  test("fast-path returns proceed message when provider already healthy", async () => {
    const instance = `req-connector-existing-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Seed a healthy linear connector directly on state.
    await mutateState(instance, (state) => {
      const at = new Date().toISOString();
      state.connectors.push({
        id: "id_linear_existing",
        instance: state.instance,
        name: "Linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      });
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "linear", reason: "list issues" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("already connected");
    }
    // No approval should have been created.
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("creates a pending connector.request approval when no connector exists", async () => {
    const instance = `req-connector-pending-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_42",
      JSON.stringify({ provider: "linear", reason: "list my open issues" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("linear");
      expect(approval!.status).toBe("pending");
      expect(approval!.payload.provider).toBe("linear");
      expect(approval!.payload.providerLabel).toBe("Linear");
      expect(approval!.payload.toolCallId).toBe("call_42");
      expect(approval!.payload.reason).toBe("list my open issues");
      // The model's `reason` is persisted verbatim on both the approval
      // row and the payload — no runtime templating.
      expect(approval!.reason).toBe("list my open issues");
    }
  });

  test("google-oauth-desktop: request_connector proceeds to a pending approval with no read_skill prerequisite", async () => {
    // In hosted, the Google Workspace credential is baked into the guest at
    // provisioning and satisfied by the boot-registered account, so
    // google-oauth-desktop declares no setup skill. request_connector for it
    // behaves like any other registered provider: it mints a pending
    // connector.request approval directly, with no read_skill gate.
    const instance = `req-connector-gws-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "google-oauth-desktop", reason: "connect google" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("google-oauth-desktop");
      expect(approval!.payload.provider).toBe("google-oauth-desktop");
    }
  });

  test("templateless: unknown provider with type:'api-key' mints a typed connector.request card", async () => {
    // No registered provider for "some-service", but the model passed a
    // valid {name, type} so the request is accepted (templateless path).
    const instance = `req-connector-templateless-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_tl",
      JSON.stringify({
        name: "SOME_SERVICE_API_KEY",
        type: "api-key",
        label: "Some Service",
        mcpUrl: "https://some.test/mcp",
        reason: "Enter your Some Service API key"
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      // target is the credential name (no provider id available).
      expect(approval!.target).toBe("SOME_SERVICE_API_KEY");
      // No registered provider — known-provider fields stay undefined.
      expect(approval!.payload.provider).toBeUndefined();
      // Templateless typed-credential fields are carried for the card.
      expect(approval!.payload.credentialName).toBe("SOME_SERVICE_API_KEY");
      expect(approval!.payload.credentialType).toBe("api-key");
      expect(approval!.payload.credentialLabel).toBe("Some Service");
      expect(approval!.payload.mcpUrl).toBe("https://some.test/mcp");
      expect(approval!.payload.toolCallId).toBe("call_tl");
      expect(approval!.reason).toBe("Enter your Some Service API key");
    }
  });

  test("a skillId for a skill that does not declare the credential is dropped (no false grant promise)", async () => {
    // The model supplies skillId. When the named skill does NOT declare the
    // requested credential, the card must not promise "Grant X to skill Y" for
    // a grant /complete would refuse. The credential is still created on
    // completion — just not auto-granted — so skillId + credentialSkillName are
    // stripped from the payload.
    const instance = `req-connector-undeclared-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const { createSkill } = await import("../state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "unrelated-skill",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["OTHER_API_KEY"]
      })
    );
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_undeclared",
      JSON.stringify({
        name: "SOME_SERVICE_API_KEY",
        type: "api-key",
        skillId: skill.id,
        reason: "Enter your Some Service API key"
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      // skillId dropped because the skill does not declare SOME_SERVICE_API_KEY.
      expect(approval!.payload.skillId).toBeUndefined();
      expect(approval!.payload.credentialSkillName).toBeUndefined();
      // The credential itself is still requested.
      expect(approval!.payload.credentialName).toBe("SOME_SERVICE_API_KEY");
    }
  });

  test("templateless: payload carries the server-resolved credentialSkillName when the skill declares the credential", async () => {
    // The card displays "Grant <credential> to skill <name>" from a
    // server-resolved identity. The model supplies only the id, so the
    // dispatcher resolves the skill NAME from state and threads it into the
    // payload — and only when the skill declares the requested credential.
    const instance = `req-connector-skillname-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const { createSkill } = await import("../state");
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
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_skillname",
      JSON.stringify({
        name: "SOME_SERVICE_API_KEY",
        type: "api-key",
        skillId: skill.id,
        reason: "Enter your Some Service API key"
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval!.payload.skillId).toBe(skill.id);
      expect(approval!.payload.credentialSkillName).toBe("needs-some-service");
    }
  });

  test("templateless: type:'oauth2' with no registered provider is rejected (api-key only)", async () => {
    // Templateless request_connector supports api-key ONLY — an oauth2
    // credential needs a provider module / setup skill to model its env vars
    // and OAuth flow, so a no-provider oauth2 request bounces with a
    // recoverable error and mints no card.
    const instance = `req-connector-tl-oauth2-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_tl_oauth2",
      JSON.stringify({ name: "some-service-oauth", type: "oauth2", reason: "connect" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("api-key");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("templateless: a bad api-key name is rejected with a recoverable error before any card is minted", async () => {
    const instance = `req-connector-badname-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_bad",
      JSON.stringify({ name: "some-service", type: "api-key", reason: "connect" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("api-key credential name");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("skillId is carried into the payload for a known provider when the skill declares the credential", async () => {
    const instance = `req-connector-skillid-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const { createSkill } = await import("../state");
    // The known-provider request will mint a LINEAR_API_KEY credential, so the
    // skill must declare that name for the skillId to survive the guard.
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "linear-skill",
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
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_known_skill",
      JSON.stringify({ provider: "linear", skillId: skill.id, reason: "connect linear" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval!.payload.skillId).toBe(skill.id);
      expect(approval!.payload.credentialSkillName).toBe("linear-skill");
      expect(approval!.payload.provider).toBe("linear");
    }
  });

  test("surface guard: rejects a job-origin session synchronously", async () => {
    const instance = `req-connector-job-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    // Build a task bound to a session whose origin is "job" (headless).
    const task = createTask(config.instance, "job dispatch test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "job session");
      session.origin = "job";
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "request_connector",
      "call_job",
      JSON.stringify({ provider: "linear", reason: "connect" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("web chat");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });

  test("surface guard: rejects a telegram-sourced session synchronously", async () => {
    const instance = `req-connector-tg-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const task = createTask(config.instance, "telegram dispatch test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "telegram session");
      session.source = { kind: "telegram", bridgeId: "b1", chatId: 1, target: "t" };
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "request_connector",
      "call_tg",
      JSON.stringify({ provider: "linear", reason: "connect" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("telegram");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });

  test("request_messaging_bridge: creates a pending messaging.add_bridge approval with kind/suggestedName/reason in payload", async () => {
    // Chat-side affordance for adding a Telegram bridge. The
    // dispatcher mints a pending approval whose payload carries the
    // structural fields the /connect handler needs (kind, name
    // suggestion, the tool_call id to thread the resume), and the
    // approval reason matches the model's user-facing string so the
    // chat card shows it verbatim.
    const instance = `req-messaging-bridge-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_bridge",
      "call_bridge_1",
      JSON.stringify({
        kind: "telegram",
        suggestedName: "my-bot",
        reason: "Add a Telegram bot so I can DM you updates."
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("messaging.add_bridge");
      expect(approval!.target).toBe("telegram");
      expect(approval!.status).toBe("pending");
      expect(approval!.payload.kind).toBe("telegram");
      expect(approval!.payload.suggestedName).toBe("my-bot");
      expect(approval!.payload.toolCallId).toBe("call_bridge_1");
      expect(approval!.reason).toBe("Add a Telegram bot so I can DM you updates.");
    }
  });

  test("list_messaging_bridges returns the configured bridges as a JSON envelope", async () => {
    // The read-only inventory tool is the agent's entry point to
    // "what messaging bridges do I have?" without needing the
    // messaging toolset enabled. Pin the shape so the model can
    // depend on consistent fields.
    const instance = `list-messaging-bridges-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "t1",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = { botUsername: "test_bot" };
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_messaging_bridges",
      "call_list",
      JSON.stringify({})
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.bridges)).toBe(true);
      expect(parsed.bridges.length).toBe(1);
      expect(parsed.bridges[0].name).toBe("t1");
      expect(parsed.bridges[0].kind).toBe("telegram");
      expect(parsed.bridges[0].botUsername).toBe("test_bot");
    }
  });

  test("request_messaging_pairing: refuses unknown bridge / already-enrolled chat / missing pending row", async () => {
    // The dispatcher reads bridge + pending state up-front and
    // refuses without minting an approval whenever the card would
    // be unactionable. Three guards in one test.
    const instance = `req-pairing-guards-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Unknown bridge.
    const unknown = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_p1",
      JSON.stringify({ bridge: "nope", chatId: 1 })
    );
    expect(unknown.kind).toBe("sync");
    if (unknown.kind === "sync") {
      const parsed = JSON.parse(unknown.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    }

    // Seed a telegram bridge with chat 42 already enrolled, and chat
    // 99 on the pending list with a fresh code.
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [42],
        recentDeniedChats: [
          {
            chatId: 99,
            chatType: "private",
            sender: "@alice",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "ABCD-1234",
            // Fixed far-future timestamp. Wall-clock "now + 60s" can be
            // crossed by a CI worker stall (GC pause, CPU contention,
            // debugger break) and flake the test. The test pins
            // dispatcher behavior, not expiry; use 2099 to make the
            // unexpired-ness load-bearing on calendar, not test
            // execution speed.
            verificationCodeExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      };
    });

    // Already-enrolled chat → refuse.
    const enrolled = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_p2",
      JSON.stringify({ bridge: "tg", chatId: 42 })
    );
    expect(enrolled.kind).toBe("sync");
    if (enrolled.kind === "sync") {
      const parsed = JSON.parse(enrolled.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("already enrolled");
    }

    // Chat with no pending row → refuse.
    const noPending = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_p3",
      JSON.stringify({ bridge: "tg", chatId: 100 })
    );
    expect(noPending.kind).toBe("sync");
    if (noPending.kind === "sync") {
      const parsed = JSON.parse(noPending.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("No pending pairing request");
    }

    // Chat with valid pending row → pending approval minted.
    const happy = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_p4",
      JSON.stringify({ bridge: "tg", chatId: 99 })
    );
    expect(happy.kind).toBe("pending");
    if (happy.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === happy.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("messaging.approve_pairing");
      expect(approval!.payload.chatId).toBe(99);
      expect(approval!.payload.verificationCode).toBe("ABCD-1234");
    }
  });

  test("request_messaging_bridge: refuses a sessionless task (subagent child) up-front", async () => {
    // A subagent spawned with mode:"chat" can dispatch chat-card
    // tools but the parent task may not be bound to a chatSessionId.
    // emitApprovalRequested skips the chat-block insert when the
    // task has no session, so a minted approval would sit
    // unsurfaced. Refuse here so the agent gets a recoverable
    // tool_result instead.
    const instance = `req-bridge-sessionless-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    // Build a task WITHOUT a chatSessionId — mimics a subagent
    // child spawned in chat-mode without binding a session.
    const task = createTask(instance, "headless test");
    await mutateState(instance, (state) => {
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "request_messaging_bridge",
      "call_no_session",
      JSON.stringify({ kind: "telegram", suggestedName: "my-bot" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("web chat session");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });

  test("request_messaging_pairing: refuses a code-less pending row (group chat) up-front", async () => {
    // Group chats deliberately have no verification code; the chat-card
    // approve handshake requires one, so messaging-pairing-connect
    // refuses the approve call. Without an up-front refusal here, the
    // agent would mint a card whose Approve button bounces — only
    // Reject would clear it. Pin that the dispatcher returns ok:false
    // with a points-to-settings message instead of minting the card.
    const instance = `req-pairing-codeless-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-group",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [],
        recentDeniedChats: [
          {
            chatId: -1001,
            chatType: "supergroup",
            sender: "@grouptest",
            lastAttemptAt: new Date().toISOString()
            // Deliberately omit verificationCode + verificationCodeExpiresAt
          }
        ]
      };
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_codeless_mint",
      JSON.stringify({ bridge: "tg-group", chatId: -1001 })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("no verification code");
      expect(parsed.error).toContain("settings page");
    }
    // Critically: no approval row was minted.
    const state = readState(instance);
    expect(
      state.setupRequests.filter((a) => a.taskId === taskId && a.action === "messaging.approve_pairing").length
    ).toBe(0);
  });

  test("list_messaging_pairings: redacts verification codes from the read-only envelope", async () => {
    // Verification codes are security tokens whose entire purpose is
    // preventing TOFU enrollment race attacks (see messaging.ts
    // DeniedChatAttempt). A prompt-injected agent that scraped them
    // could race the legitimate user. Pin that the tool envelope
    // surfaces chatId / chatType / sender / lastAttemptAt for the
    // agent to route on, but never the verificationCode itself nor
    // its expiry timestamp.
    const instance = `list-pairings-redaction-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [42],
        recentDeniedChats: [
          {
            chatId: 99,
            chatType: "private",
            sender: "@alice",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "SECRET-1234",
            // Fixed far-future timestamp. Wall-clock "now + 60s" can be
            // crossed by a CI worker stall (GC pause, CPU contention,
            // debugger break) and flake the test. The test pins
            // dispatcher behavior, not expiry; use 2099 to make the
            // unexpired-ness load-bearing on calendar, not test
            // execution speed.
            verificationCodeExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      };
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_messaging_pairings",
      "call_list",
      JSON.stringify({ bridge: "tg" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.allowedChatIds).toEqual([42]);
      expect(Array.isArray(parsed.recentDeniedChats)).toBe(true);
      expect(parsed.recentDeniedChats.length).toBe(1);
      const entry = parsed.recentDeniedChats[0];
      expect(entry.chatId).toBe(99);
      expect(entry.chatType).toBe("private");
      expect(entry.sender).toBe("@alice");
      expect(typeof entry.lastAttemptAt).toBe("string");
      // The redactions: codes must NOT appear under any name.
      expect(entry.verificationCode).toBeUndefined();
      expect(entry.verificationCodeExpiresAt).toBeUndefined();
      // Stringified envelope must not contain the code either.
      expect(result.result).not.toContain("SECRET-1234");
    }
  });

  test("web_fetch: refuses loopback / RFC1918 / link-local URLs (SSRF guard)", async () => {
    // Without this guard, a prompt-injected agent could fetch the
    // local BFF (e.g. http://127.0.0.1:3000/api/runtime/approvals).
    // The BFF proxy injects the runtime bearer, which would return
    // state including approval payloads — defense in depth alongside
    // the read-API field redactions. Pin that the guard refuses
    // literal loopback / private / link-local addresses pre-fetch
    // (no live network required).
    const instance = `web-fetch-ssrf-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const refusedTargets = [
      "http://127.0.0.1:3082/api/runtime/approvals",
      "http://localhost:3082/api/state",
      "http://0.0.0.0/anything",
      "http://10.0.0.1/internal",
      "http://172.16.5.5/internal",
      "http://192.168.1.1/router",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      // fe80::/10 spans fe80 through febf — pin the upper end of
      // the range so a fe9x/feax/febx address can't bypass.
      "http://[fe90::1]/",
      "http://[fea0::1]/",
      "http://[febf::1]/",
      // RFC 6598 CGN space (100.64.0.0/10) and RFC 2544 benchmark
      // space (198.18.0.0/15) — non-globally-routable, can reach
      // CGN-internal proxies.
      "http://100.64.0.1/",
      "http://100.127.0.1/",
      "http://198.18.0.1/",
      "http://198.19.0.1/",
      "http://example.localhost/api",
      // IPv4-mapped IPv6 hex forms — all alias the same loopback /
      // RFC1918 addresses but bypass the dot-quad-only regex if not
      // decoded. URL parser normalizes [::127.0.0.1] to [::7f00:1]
      // (the deprecated IPv4-compatible form), so this isn't just an
      // attacker-crafted curiosity — it shows up unprompted.
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:a00:1]/",
      "http://[::ffff:c0a8:1]/",
      "http://[::ffff:ac10:1]/",
      "http://[::ffff:a9fe:1]/",
      "http://[::7f00:1]/"
    ];
    for (const url of refusedTargets) {
      await expect(
        dispatchToolCall(config, taskId, "web_fetch", `call_${url}`, JSON.stringify({ url }))
      ).rejects.toThrow(/web_fetch refuses/);
    }
  });

  test("wait_for_messaging_pair: surfaces a pre-existing pending row immediately", async () => {
    // The earlier snapshot-diff predicate filtered out chatIds that
    // were already in recentDeniedChats at tool-start, racing the
    // natural "user DMs the bot between request_messaging_bridge
    // resolving and wait_for_messaging_pair starting" window. Pin
    // the new behavior: a pending row with a verification code that
    // isn't on the allowlist must be surfaced on the very first
    // poll tick, regardless of whether it pre-existed.
    const instance = `wait-pair-preexisting-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-prewait",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [],
        recentDeniedChats: [
          {
            chatId: 77,
            chatType: "private",
            sender: "@earlybird",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "WAIT-7700",
            verificationCodeExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      };
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "wait_for_messaging_pair",
      "call_wait_prewait",
      JSON.stringify({ bridge: "tg-prewait", timeoutSeconds: 10 })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("messaging.approve_pairing");
      expect(approval!.payload.chatId).toBe(77);
      expect(approval!.payload.verificationCode).toBe("WAIT-7700");
    }
  });

  test("wait_for_messaging_pair: skips a pending row whose verification code has expired", async () => {
    // Without the expiry guard, an operator who left the chat tab
    // open across the 10-minute code TTL would see an approval card
    // whose Approve action fails at allowChat's expired-code throw.
    // Pin that the wait predicate filters expired rows out of
    // surfacing — the wait just keeps polling, waiting for a fresh
    // DM to mint a new code.
    const instance = `wait-pair-expired-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-expired",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [],
        recentDeniedChats: [
          {
            chatId: 33,
            chatType: "private",
            sender: "@stale",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "OLD-3333",
            // Already-past timestamp.
            verificationCodeExpiresAt: "2020-01-01T00:00:00.000Z"
          }
        ]
      };
    });
    const dispatchPromise = dispatchToolCall(
      config,
      taskId,
      "wait_for_messaging_pair",
      "call_wait_expired",
      JSON.stringify({ bridge: "tg-expired", timeoutSeconds: 10 })
    );
    // The expired row is filtered out on the loop's very first scan
    // (synchronous, before the first poll sleep), so we only need the
    // cancel to land before a subsequent tick re-scans. Cancel well
    // inside the first 1s poll interval so the next tick exits on the
    // task-terminal check instead of sitting out the full 10s timeout.
    await Bun.sleep(50);
    await mutateState(instance, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) task.status = "cancelled";
    });
    const result = await dispatchPromise;
    expect(result.kind).toBe("sync");
    // No approval was minted for the expired row.
    const state = readState(instance);
    expect(
      state.setupRequests.filter((a) => a.taskId === taskId && a.action === "messaging.approve_pairing").length
    ).toBe(0);
  });

  test("wait_for_messaging_pair: detects out-of-band enrollment and exits with success", async () => {
    // While the wait loop is running, a parallel operator (settings
    // page, `gini messaging allow`, or another agent's
    // request_messaging_pairing) can approve a chat. allowChat both
    // removes the pending row AND adds chatId to allowedChatIds, so
    // the pending-row predicate alone can't tell us a fresh enrollment
    // happened — both "approved out-of-band" and "no one DM'd yet"
    // look like nothing-to-surface. Pin that the snapshot-diff on
    // allowedChatIds exits with ok:true + the new chatIds when an
    // enrollment lands mid-wait.
    const instance = `wait-pair-out-of-band-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-oob",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [],
        recentDeniedChats: []
      };
    });
    const dispatchPromise = dispatchToolCall(
      config,
      taskId,
      "wait_for_messaging_pair",
      "call_wait_oob",
      JSON.stringify({ bridge: "tg-oob", timeoutSeconds: 10 })
    );
    // Simulate another path enrolling chat 555 while the wait is
    // running (e.g. operator clicked Approve on the settings page).
    // The loop's first scan runs synchronously on entry (before the
    // first poll sleep) and sees an empty allowlist; land the
    // enrollment well inside the first 1s poll interval so the next
    // tick's snapshot-diff detects the fresh chatId.
    await Bun.sleep(50);
    await mutateState(instance, (state) => {
      const live = state.messagingBridges.find((b) => b.name === "tg-oob");
      if (live) {
        live.metadata = { ...(live.metadata ?? {}), allowedChatIds: [555] };
      }
    });
    const result = await dispatchPromise;
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.outOfBand).toBe(true);
      expect(parsed.enrolledChatIds).toEqual([555]);
    }
    // No approval card was minted — the wait exited before the
    // request_messaging_pairing path fired.
    const state = readState(instance);
    expect(
      state.setupRequests.filter((a) => a.taskId === taskId && a.action === "messaging.approve_pairing").length
    ).toBe(0);
  });

  test("wait_for_messaging_pair: skips a pending row whose chat is already enrolled, then exits on task cancel", async () => {
    // Pin the second half of the new predicate: a pending row whose
    // chatId is already on the allowlist must NOT surface. Approved
    // rows are normally cleared from recentDeniedChats by allowChat,
    // so this is mostly defensive — but if a stale entry lingers,
    // the agent should still wait instead of double-surfacing the
    // same chat. The wait's lower-bound timeout is 10s so we cancel
    // the task mid-wait to exit fast; the wait tool's per-tick
    // task-terminal check returns the cancelled sync result.
    const instance = `wait-pair-already-enrolled-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-enrolled",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [88],
        recentDeniedChats: [
          {
            chatId: 88,
            chatType: "private",
            sender: "@alreadyhere",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "STALE-8888",
            verificationCodeExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      };
    });
    const dispatchPromise = dispatchToolCall(
      config,
      taskId,
      "wait_for_messaging_pair",
      "call_wait_enrolled",
      JSON.stringify({ bridge: "tg-enrolled", timeoutSeconds: 10 })
    );
    // The loop's first scan runs synchronously on entry (before the
    // first poll sleep) and decides the already-enrolled row is
    // unsurfacable. Cancel well inside the first 1s poll interval so
    // the next tick's task-terminal check exits the loop without
    // sitting out the full 10s timeout.
    await Bun.sleep(50);
    await mutateState(instance, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) task.status = "cancelled";
    });
    const result = await dispatchPromise;
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      // Either "cancelled" or "timed out" is acceptable here; the
      // load-bearing check is "no approval minted" below.
    }
    // No messaging.approve_pairing approval was minted for the
    // already-enrolled chat.
    const state = readState(instance);
    expect(
      state.setupRequests.filter((a) => a.taskId === taskId && a.action === "messaging.approve_pairing").length
    ).toBe(0);
  });

  test("wait_for_messaging_pair: folds the guidance into the running tool_call's runningHint (not a separate system_note)", async () => {
    // The wait card on its own only shows the bridge name — no
    // instruction that the user must open Telegram, tap Start, and
    // send a message before the poller can mint a pairing row. The
    // dispatch attaches the guidance to its own tool_call block via
    // `runningHint`, which the web/mobile chat surface renders as an
    // amber waiting-card with the guidance folded in. Pin that the
    // hint lands on the right block (and that we DON'T regress to the
    // pre-folding system_note layout, which split the wait row and the
    // guidance into two unrelated blocks). We seed a pre-existing
    // pending row so the wait returns "pending" on the first tick —
    // the hint write runs before any polling.
    const instance = `wait-pair-guidance-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const { listChatBlocks } = await import("../state");
    const { emitToolCallRunning, resolveEmitContext } = await import("./chat-task-emit");
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      const bridge = createMessagingBridgeRecord(state, {
        name: "tg-guidance",
        kind: "telegram",
        deliveryTargets: []
      });
      bridge.metadata = {
        allowedChatIds: [],
        recentDeniedChats: [
          {
            chatId: 909,
            chatType: "private",
            sender: "@guide",
            lastAttemptAt: new Date().toISOString(),
            verificationCode: "GUIDE-909",
            verificationCodeExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      };
    });

    // Mount the running tool_call block the same way the chat-task
    // loop would — dispatchToolCall doesn't emit it itself, so without
    // this the runningHint write would no-op against a missing row.
    const callId = "call_wait_guidance";
    const emitCtx = resolveEmitContext(config, taskId);
    expect(emitCtx).toBeDefined();
    emitToolCallRunning(emitCtx, {
      toolName: "wait_for_messaging_pair",
      callId,
      args: { bridge: "tg-guidance", timeoutSeconds: 10 }
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "wait_for_messaging_pair",
      callId,
      JSON.stringify({ bridge: "tg-guidance", timeoutSeconds: 10 })
    );
    // Pre-existing pending row → pending result, just confirming the
    // dispatcher reached the poll path past the runningHint write.
    expect(result.kind).toBe("pending");

    const state = readState(instance);
    const task = state.tasks.find((t) => t.id === taskId);
    expect(task?.chatSessionId).toBeDefined();
    const blocks = listChatBlocks(instance, task!.chatSessionId!);

    // The tool_call block carries the guidance in `runningHint`.
    // botUsername is empty (probe is gated on a secret ref, which
    // test bridges don't have), so the text falls back to the bridge
    // name.
    const toolCall = blocks.find(
      (b) => b.kind === "tool_call" && (b as { callId?: string }).callId === callId
    );
    expect(toolCall).toBeDefined();
    expect(toolCall?.kind).toBe("tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.runningHint).toBeDefined();
      expect(toolCall.runningHint).toContain("tg-guidance");
      expect(toolCall.runningHint).toContain("/start");
    }

    // Regression guard: the guidance must NOT be emitted as a
    // standalone system_note anymore (would re-introduce the split-card
    // layout the amber waiting-card was meant to fold together).
    const guidanceNote = blocks.find(
      (b) => b.kind === "system_note" && b.text.includes("Open Telegram and start a chat")
    );
    expect(guidanceNote).toBeUndefined();
  });

  test("request_remove_messaging_bridge: mints a pending approval for an existing bridge", async () => {
    const instance = `req-remove-bridge-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await mutateState(instance, (state) => {
      const { createMessagingBridgeRecord } = require("../state") as typeof import("../state");
      createMessagingBridgeRecord(state, {
        name: "doomed",
        kind: "telegram",
        deliveryTargets: []
      });
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_remove_messaging_bridge",
      "call_remove",
      JSON.stringify({ bridge: "doomed" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("messaging.remove_bridge");
      expect(approval!.payload.bridgeName).toBe("doomed");
      expect(approval!.payload.kind).toBe("telegram");
    }
  });

  test("request_messaging_pairing AND request_remove_messaging_bridge: refuse minting from telegram/discord-sourced chat tasks", async () => {
    // Surface guard pin. If the agent calls either tool while
    // running inside a chat-task whose owning session was spawned
    // from a Telegram (or Discord) bridge, the resulting passthrough
    // card would only render in the web chat — the task would park
    // in awaiting_approval and the telegram-poller would
    // reply_skip_non_terminal, leaving the Telegram user with a
    // typing indicator that never resolves. Matches the existing
    // guard on requestMessagingBridgeTool and browserFillSecretsTool.
    const instance = `req-messaging-surface-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Seed a chat session whose source is telegram, then bind the
    // task's chatSessionId to it.
    await mutateState(instance, (state) => {
      const { createChatSession } = require("../state") as typeof import("../state");
      const session = createChatSession(state, "tg session", {
        kind: "telegram",
        bridgeId: "bridge_x",
        chatId: 1,
        target: "1"
      });
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) task.chatSessionId = session.id;
    });

    const pairing = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_pairing",
      "call_pairing_tg",
      JSON.stringify({ bridge: "tg", chatId: 1 })
    );
    expect(pairing.kind).toBe("sync");
    if (pairing.kind === "sync") {
      const parsed = JSON.parse(pairing.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("web chat");
      expect(parsed.error).toContain("telegram");
    }

    const remove = await dispatchToolCall(
      config,
      taskId,
      "request_remove_messaging_bridge",
      "call_remove_tg",
      JSON.stringify({ bridge: "tg" })
    );
    expect(remove.kind).toBe("sync");
    if (remove.kind === "sync") {
      const parsed = JSON.parse(remove.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("web chat");
      expect(parsed.error).toContain("telegram");
    }
    // No approval rows minted on either refused path.
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("request_remove_messaging_bridge: refuses unknown bridge synchronously", async () => {
    const instance = `req-remove-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_remove_messaging_bridge",
      "call_remove_bad",
      JSON.stringify({ bridge: "missing" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not found");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("request_messaging_bridge: rejects unknown kind synchronously", async () => {
    // The chat card branches on payload.kind to pick the per-kind
    // help text and the Submit label. A bogus kind would render an
    // unknown bridge, fail the addMessagingBridge dispatch, and
    // leave a stale approval row. Refuse up-front so the agent
    // gets a recoverable tool result instead.
    const instance = `req-messaging-bridge-badkind-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_bridge",
      "call_bridge_bad",
      JSON.stringify({ kind: "whatsapp" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("telegram");
    }
    // No approval row should have been minted on the failure path.
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("request_messaging_bridge: rejects kind=discord with a points-to-settings error", async () => {
    // The catalog enum already restricts kind to telegram, but the
    // model can violate the schema. The chat card collects only
    // name + bot token, while Discord bridges need a deliveryTargets
    // channel-IDs list — so a discord-kind approval would render but
    // /connect would fail with no way for the user to provide the
    // missing field. Refuse here and point the user at the settings
    // page so the agent can fall back to plain text.
    const instance = `req-messaging-bridge-discord-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_bridge",
      "call_bridge_discord",
      JSON.stringify({ kind: "discord" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Discord");
      expect(parsed.error).toContain("settings page");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("request_messaging_bridge: rejects kind=slack with a points-to-settings error", async () => {
    // Same shape as the discord refusal: the chat card collects a
    // single bot token, and Slack bridges need TWO credentials (bot
    // token + app-level Socket Mode token) — so a slack-kind approval
    // would render but /connect would fail with no way for the user
    // to provide the second token.
    const instance = `req-messaging-bridge-slack-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_messaging_bridge",
      "call_bridge_slack",
      JSON.stringify({ kind: "slack" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Slack");
      expect(parsed.error).toContain("settings page");
    }
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("non-setupSkill provider: gate does not apply regardless of read_skill history", async () => {
    // Back-compat: providers without `setupSkill` (linear, generic, etc.)
    // must keep the existing direct-approval shape. The gate only fires
    // when the provider declares a setup skill.
    const instance = `req-connector-bypass-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // No toolCallState — confirms the gate doesn't accidentally block
    // providers that never had a setup skill in the first place.
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_3",
      JSON.stringify({ provider: "linear", reason: "list my open issues" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("linear");
    }
  });
});

describe("web_search dispatch", () => {
  test("no connector throws ToolDisplayError: verbose steering to the model, calm info line to the user", async () => {
    const instance = `web-search-no-connector-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Fresh instance has no brave-search/exa connector, so the dispatch
    // throws before touching the network or resolving any secret.
    let thrown: unknown;
    try {
      await dispatchToolCall(config, taskId, "web_search", "call_1", JSON.stringify({ query: "latest bun version" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolDisplayError);
    const err = thrown as ToolDisplayError;
    // The model is steered to keep searching via the live-web tools it
    // already has (browser / web_fetch a search engine) instead of
    // answering from memory, with request_connector offered as a quality
    // upgrade rather than a hard gate.
    expect(err.message).toContain("browser_navigate");
    expect(err.message).toContain("web_fetch");
    expect(err.message).toContain("do NOT answer from memory");
    expect(err.message).toContain("request_connector");
    // The user only sees a short, neutral line.
    expect(err.displayMessage).toBe("No search provider connected.");
    expect(err.displaySeverity).toBe("info");
  });

  test("explicit provider that isn't connected names that provider, even when another is connected", async () => {
    const instance = `web-search-wrong-provider-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Brave is connected and healthy; the model explicitly asks for Exa.
    // "No search provider connected." would be false here — the user has
    // Brave — so the display line must name the missing provider instead.
    await mutateState(instance, (state) => {
      state.connectors.unshift({
        id: "id_brave",
        instance,
        name: "Brave Search",
        provider: "brave-search",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        health: "healthy",
        source: "user"
      });
    });
    let thrown: unknown;
    try {
      await dispatchToolCall(config, taskId, "web_search", "call_2", JSON.stringify({ query: "q", provider: "exa" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolDisplayError);
    const err = thrown as ToolDisplayError;
    expect(err.displayMessage).toBe("Exa is not connected.");
    expect(err.displaySeverity).toBe("info");
  });
});

describe("get_current_time dispatch", () => {
  test("get_current_time returns the current wall-clock time with a UTC ISO", async () => {
    const instance = `get-time-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const res = await dispatchToolCall(config, taskId, "get_current_time", "call_time", "{}");
    expect(res.kind).toBe("sync");
    if (res.kind !== "sync") throw new Error("expected sync");
    expect(res.result).toMatch(/UTC: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(res.result).toMatch(/\b20\d{2}\b/); // a real year, not a guess
  });
});

describe("capToolResultText", () => {
  // The cap is 40_000 chars internally; tests probe around that boundary
  // without importing the constant (it's module-private by design).
  const CAP = 40_000;

  test("under the cap returns the identical string reference (no-op)", () => {
    const small = "x".repeat(1_000);
    const out = capToolResultText(small, "read_skill");
    // Byte-identical AND same reference — proves zero allocation/work on
    // the common path (the performance-safety guarantee).
    expect(out).toBe(small);
  });

  test("exactly at the cap is unchanged", () => {
    const atCap = "y".repeat(CAP);
    const out = capToolResultText(atCap, "db_schema");
    expect(out).toBe(atCap);
    expect(out.length).toBe(CAP);
  });

  test("over the cap truncates middle-out within the cap, keeping head and tail", () => {
    // Distinct head and tail sentinels with a unique middle so we can
    // assert the middle is gone but both ends survive.
    const head = "HEAD_SENTINEL_";
    const tail = "_TAIL_SENTINEL";
    const middle = "M".repeat(CAP * 2);
    const big = `${head}${middle}${tail}`;
    const out = capToolResultText(big, "vision_query");

    expect(out.length).toBeLessThanOrEqual(CAP);
    // Recovery marker present, names the tool, states an elided count.
    expect(out).toContain("characters elided from vision_query");
    expect(out).toContain("Re-run this tool with a narrower scope");
    // Middle-out: both original ends preserved.
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    // The middle was dropped: the full middle run can't fit under the cap.
    expect(out).not.toContain(middle);
  });
});

describe("withPromoteFileAttachmentTag", () => {
  const okPng = JSON.stringify({ ok: true, uploadId: "up_shot", mimeType: "image/png", size: 35106, filename: "shot.png" });

  function tagOf(raw: string): string | undefined {
    return (JSON.parse(withPromoteFileAttachmentTag("attachments", "promote-file", raw)) as { attachmentMarkdown?: string })
      .attachmentMarkdown;
  }

  test("adds an IMAGE markdown tag for an image upload", () => {
    expect(tagOf(okPng)).toBe("![image](gini-upload://up_shot)");
  });

  test("adds a LINK markdown tag (filename label) for a non-image upload", () => {
    const pdf = JSON.stringify({ ok: true, uploadId: "up_pdf", mimeType: "application/pdf", size: 99, filename: "report.pdf" });
    expect(tagOf(pdf)).toBe("[report.pdf](gini-upload://up_pdf)");
  });

  test("falls back to a generic file label when no filename is present", () => {
    const csv = JSON.stringify({ ok: true, uploadId: "up_csv", mimeType: "text/csv", size: 9 });
    expect(tagOf(csv)).toBe("[file](gini-upload://up_csv)");
  });

  test("leaves the result unchanged for any other skill", () => {
    expect(withPromoteFileAttachmentTag("google", "promote-file", okPng)).toBe(okPng);
  });

  test("leaves the result unchanged for any other script", () => {
    expect(withPromoteFileAttachmentTag("attachments", "signed-upload", okPng)).toBe(okPng);
  });

  test("leaves the result unchanged when the promote failed (ok:false)", () => {
    const failed = JSON.stringify({ ok: false, error: "File not found" });
    expect(withPromoteFileAttachmentTag("attachments", "promote-file", failed)).toBe(failed);
  });

  test("leaves the result unchanged when uploadId is missing", () => {
    const noId = JSON.stringify({ ok: true, mimeType: "image/png" });
    expect(withPromoteFileAttachmentTag("attachments", "promote-file", noId)).toBe(noId);
  });

  test("leaves the result unchanged on non-JSON input", () => {
    expect(withPromoteFileAttachmentTag("attachments", "promote-file", "boom")).toBe("boom");
  });
});

describe("ask_user dispatch", () => {
  test("rejects a missing question with a sync error and mints no card", async () => {
    const instance = `ask-user-noq-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_q",
      JSON.stringify({ options: [{ label: "A" }, { label: "B" }] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("question");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("rejects a single option or more than 6 with a sync error", async () => {
    // Exactly one option is a confirmation in disguise, and seven is past
    // the option bound — both stay recoverable errors.
    const instance = `ask-user-count-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const one = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_one",
      JSON.stringify({ question: "Pick one?", options: [{ label: "Only" }] })
    );
    expect(one.kind).toBe("sync");
    if (one.kind === "sync") {
      expect(JSON.parse(one.result).ok).toBe(false);
    }
    const seven = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_seven",
      JSON.stringify({
        question: "Pick one?",
        options: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `Option ${n}` }))
      })
    );
    expect(seven.kind).toBe("sync");
    if (seven.kind === "sync") {
      expect(JSON.parse(seven.result).ok).toBe(false);
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("rejects empty and duplicate option labels with a sync error", async () => {
    const instance = `ask-user-labels-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const empty = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_empty",
      JSON.stringify({ question: "Pick?", options: [{ label: "  " }, { label: "B" }] })
    );
    expect(empty.kind).toBe("sync");
    if (empty.kind === "sync") {
      expect(JSON.parse(empty.result).error).toContain("label");
    }
    // Duplicate detection runs on TRIMMED labels.
    const dup = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_dup",
      JSON.stringify({ question: "Pick?", options: [{ label: "Same" }, { label: " Same " }] })
    );
    expect(dup.kind).toBe("sync");
    if (dup.kind === "sync") {
      expect(JSON.parse(dup.result).error).toContain("Duplicate");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("valid call mints a pending chat.choice SetupRequest carrying question/options/toolCallId", async () => {
    const instance = `ask-user-pending-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_choice",
      JSON.stringify({
        question: "How should I search the web?",
        options: [
          { label: "Set up Brave + Exa", description: "Best coverage" },
          { label: "Set up Brave only" },
          { label: "Neither — use web_fetch", description: "No setup needed" }
        ]
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("chat.choice");
      expect(approval!.status).toBe("pending");
      // The question doubles as reason so the setup_requested block summary
      // (and transcripts) read as the question itself.
      expect(approval!.reason).toBe("How should I search the web?");
      expect(approval!.payload.question).toBe("How should I search the web?");
      expect(approval!.payload.toolCallId).toBe("call_choice");
      expect(approval!.payload.options).toEqual([
        { label: "Set up Brave + Exa", description: "Best coverage" },
        { label: "Set up Brave only" },
        { label: "Neither — use web_fetch", description: "No setup needed" }
      ]);
    }
  });

  test("a question-only call (no options) is rejected with a steer to plain message text", async () => {
    // ask_user is options-only: an open-ended ask belongs in the model's own
    // message text. Both an omitted field and an explicit empty array reject
    // gracefully without minting a chat.choice row.
    const instance = `ask-user-open-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const omitted = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_open",
      JSON.stringify({ question: "What should the reply to Dana say?" })
    );
    expect(omitted.kind).toBe("sync");
    if (omitted.kind === "sync") {
      const parsed = JSON.parse(omitted.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("ask_user only presents choices");
      expect(parsed.error).toContain("message text");
    }
    const emptyArray = await dispatchToolCall(
      config,
      taskId,
      "ask_user",
      "call_open_empty",
      JSON.stringify({ question: "What should the subject line be?", options: [] })
    );
    expect(emptyArray.kind).toBe("sync");
    if (emptyArray.kind === "sync") {
      expect(JSON.parse(emptyArray.result).ok).toBe(false);
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("surface guard: rejects a telegram-sourced session synchronously", async () => {
    const instance = `ask-user-tg-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const task = createTask(config.instance, "telegram ask_user test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "telegram session");
      session.source = { kind: "telegram", bridgeId: "b1", chatId: 1, target: "t" };
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "ask_user",
      "call_tg",
      JSON.stringify({ question: "Pick?", options: [{ label: "A" }, { label: "B" }] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("regular message");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });

  test("surface guard: rejects a session whose only surface is an outbound mirror", async () => {
    // Dedicated job-spawned sessions intentionally leave `source`
    // undefined (so they don't compete for inbound routing) and record
    // the bridge descriptor on `outboundMirror` instead — the guard
    // must check both fields, or such a session would park in
    // waiting_approval with no card anywhere to answer.
    const instance = `ask-user-mirror-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const task = createTask(config.instance, "mirror ask_user test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "job session");
      // Job-spawned: no inbound source, only the outbound mirror.
      session.outboundMirror = { kind: "telegram", bridgeId: "b1", chatId: 1, target: "t" };
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "ask_user",
      "call_mirror",
      JSON.stringify({ question: "Pick?", options: [{ label: "A" }, { label: "B" }] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("regular message");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });
});

describe("request_confirmation dispatch", () => {
  test("rejects a missing summary with a sync error and mints no card", async () => {
    const instance = `confirm-nosummary-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_confirmation",
      "call_c",
      JSON.stringify({ details: "the body" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("summary");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("valid call mints a pending confirmation.request SetupRequest carrying summary/details/confirmLabel/toolCallId", async () => {
    const instance = `confirm-pending-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_confirmation",
      "call_confirm",
      JSON.stringify({
        summary: "Send this reply to Dana in the project thread",
        details: "Hi Dana — looks great, ship it.",
        confirmLabel: "Send"
      })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("confirmation.request");
      expect(approval!.status).toBe("pending");
      // summary doubles as reason + target so the setup_requested block summary
      // and the audit rows read as the summary itself.
      expect(approval!.reason).toBe("Send this reply to Dana in the project thread");
      expect(approval!.target).toBe("Send this reply to Dana in the project thread");
      expect(approval!.payload.summary).toBe("Send this reply to Dana in the project thread");
      expect(approval!.payload.details).toBe("Hi Dana — looks great, ship it.");
      expect(approval!.payload.confirmLabel).toBe("Send");
      expect(approval!.payload.toolCallId).toBe("call_confirm");
    }
  });

  test("defaults confirmLabel to Confirm and omits details when not given", async () => {
    const instance = `confirm-defaults-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_confirmation",
      "call_default",
      JSON.stringify({ summary: "Post this reply on the GitHub issue" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const approval = readState(instance).setupRequests.find((a) => a.id === result.approvalId);
      expect(approval!.payload.confirmLabel).toBe("Confirm");
      expect(approval!.payload.details).toBeUndefined();
    }
  });

  test("surface guard: rejects a telegram-sourced session synchronously", async () => {
    const instance = `confirm-tg-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const task = createTask(config.instance, "telegram confirm test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "telegram session");
      session.source = { kind: "telegram", bridgeId: "b1", chatId: 1, target: "t" };
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "request_confirmation",
      "call_tg",
      JSON.stringify({ summary: "Send the reply" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      // The error must tell the agent NOT to proceed with the irreversible action.
      expect(parsed.error).toContain("Do NOT proceed");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });

  test("surface guard: rejects a session whose only surface is an outbound mirror", async () => {
    const instance = `confirm-mirror-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const task = createTask(config.instance, "mirror confirm test");
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "job session");
      session.outboundMirror = { kind: "telegram", bridgeId: "b1", chatId: 1, target: "t" };
      task.chatSessionId = session.id;
      upsertTask(state, task);
    });
    const result = await dispatchToolCall(
      config,
      task.id,
      "request_confirmation",
      "call_mirror",
      JSON.stringify({ summary: "Send the reply" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Do NOT proceed");
    }
    expect(readState(instance).setupRequests.filter((a) => a.taskId === task.id).length).toBe(0);
  });
});
