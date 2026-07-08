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
