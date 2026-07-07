// Phase-2 unified-task-model runtime surface: the supersede rule and the
// direct-start entrypoint.
//
// Supersede (design invariant: approval is click-only): a user message that
// arrives while the session's live task is parked at waiting_approval on
// Authorization gates cancels the gated task (reason "superseded") and runs
// the message as a fresh turn. User text NEVER resolves a gate as approval —
// even a literal "yes, send it" cancels the gate without executing the side
// effect; the only path that executes a gated side effect is the explicit
// approve endpoint. Non-empty queues, mid-loop (running) turns, and
// SetupRequest gates keep today's queueing behavior.
//
// Setup mirrors chat-topic-forward.test.ts: the echo provider makes the agent
// loop deterministic, HOME points at a unique mkdtemp dir so the
// machine-global Google account registry can't shift system-prompt size, and
// each test uses a unique instance so per-instance state can't bleed across
// reruns in the same worker.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import {
  createAuthorization,
  createChatSession,
  createSetupRequest,
  createTopic,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import type { RuntimeConfig, Task } from "../types";
import { createHandler } from "../http";
import { createChat, dispatchChatMessageToTopic, runTopicSubmission, submitChatMessage } from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-supersede-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  rmSync(scratchHome, { recursive: true, force: true });
});

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7344,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-supersede-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-supersede-test-logs",
    approvalMode: "strict"
  };
}

async function waitFor(
  config: RuntimeConfig,
  taskId: string,
  match: (task: Task) => boolean,
  timeoutMs = 5000
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (task && match(task)) return task;
    await Bun.sleep(10);
  }
  throw new Error(`Task ${taskId} did not reach the expected state within ${timeoutMs}ms`);
}

// Drive a real gated turn: the echo model requests a file_write, which is
// approval-gated in strict mode, so the task parks at waiting_approval with a
// pending Authorization. Returns the parked task.
function stubGatedWrite(config: RuntimeConfig, callId: string): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text: "",
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "from-agent" }) }
      }
    ],
    finishReason: "tool_calls"
  });
}

function stubAnswer(config: RuntimeConfig, text: string): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text,
    toolCalls: [],
    finishReason: "stop"
  });
}

// Seed a task directly on the session (no live agent loop) so no-supersede
// branches can be pinned without racing a real turn.
async function seedTask(config: RuntimeConfig, sessionId: string, status: Task["status"]): Promise<string> {
  const taskId = `task_seeded_${Math.random().toString(36).slice(2, 8)}`;
  await mutateState(config.instance, (state) => {
    const task: Task = {
      id: taskId,
      title: "seeded",
      input: "seeded",
      status,
      instance: state.instance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: [],
      mode: "chat",
      chatSessionId: sessionId
    };
    state.tasks.push(task);
    const session = state.chatSessions.find((s) => s.id === sessionId);
    if (session) session.taskIds.push(taskId);
  });
  return taskId;
}

describe("supersede on a pending Authorization gate", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-supersede-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  test("a new message cancels the gated task without executing and starts a fresh run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-e2e-${basename(workspaceRoot)}`);
    const chat = await createChat(config, { title: "supersede" });

    stubGatedWrite(config, "call_w");
    const first = await submitChatMessage(config, chat.id, { content: "please create out.txt" });
    if ("queued" in first || !("taskId" in first)) throw new Error("expected a run-now submission");
    const parked = await waitFor(config, first.taskId, (t) => t.status === "waiting_approval");
    const gate = readState(config.instance).authorizations.find(
      (a) => a.taskId === parked.id && a.status === "pending"
    );
    expect(gate).toBeDefined();

    stubAnswer(config, "Understood — changed the plan.");
    const second = await submitChatMessage(config, chat.id, { content: "actually write something else" });
    if ("queued" in second || !("taskId" in second)) throw new Error("expected the supersede path to run now");
    expect(second.taskId).not.toBe(first.taskId);

    // The gated task is cancelled with supersede provenance stamped.
    const cancelled = await waitFor(config, first.taskId, (t) => t.status === "cancelled");
    await waitFor(config, first.taskId, (t) => t.supersededByTaskId === second.taskId);
    expect(cancelled.status).toBe("cancelled");

    // The gate settled WITHOUT executing: authorization denied, file never
    // written, tool_call card flipped to denied.
    const state = readState(config.instance);
    expect(state.authorizations.find((a) => a.id === gate!.id)?.status).toBe("denied");
    expect(existsSync(join(workspaceRoot, "out.txt"))).toBe(false);
    const blocks = listChatBlocks(config.instance, chat.id);
    const gateCall = blocks.find((b) => b.kind === "tool_call" && b.callId === "call_w");
    expect(gateCall).toBeDefined();
    if (gateCall?.kind === "tool_call") expect(gateCall.status).toBe("denied");
    // The user sees why the card flipped.
    expect(
      blocks.some((b) => b.kind === "system_note" && b.text === "Superseded by your new message")
    ).toBe(true);
    // The cancel audit carries the supersede reason.
    const cancelAudit = state.audit.find(
      (a) => a.taskId === first.taskId && a.action === "task.cancelled"
    );
    expect(cancelAudit?.evidence?.reason).toBe("superseded");

    // The new run carries the message and completes normally.
    const finished = await waitFor(config, second.taskId, (t) => t.status === "completed");
    expect(finished.summary).toBe("Understood — changed the plan.");
    expect(finished.input).toBe("actually write something else");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a literal affirmation ('yes, send it') supersedes — it never approves or executes", async () => {
    // The invariant this pins: user text never resolves a gate as approval.
    // No affirmation/intent classification exists anywhere — even text that
    // reads as consent takes the supersede path, and the side effect runs
    // ONLY via the explicit approve endpoint.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-affirm-${basename(workspaceRoot)}`);
    const chat = await createChat(config, { title: "affirm" });

    stubGatedWrite(config, "call_affirm");
    const first = await submitChatMessage(config, chat.id, { content: "write out.txt" });
    if ("queued" in first || !("taskId" in first)) throw new Error("expected a run-now submission");
    const parked = await waitFor(config, first.taskId, (t) => t.status === "waiting_approval");

    stubAnswer(config, "Starting over with your message.");
    const second = await submitChatMessage(config, chat.id, { content: "yes, send it" });
    if ("queued" in second || !("taskId" in second)) throw new Error("expected the supersede path to run now");

    await waitFor(config, first.taskId, (t) => t.status === "cancelled");
    await waitFor(config, second.taskId, (t) => t.status === "completed");

    const state = readState(config.instance);
    // The gate was cancelled, never approved: no approval decision executed
    // the write, and the file does not exist.
    const gate = state.authorizations.find((a) => a.taskId === parked.id);
    expect(gate?.status).toBe("denied");
    expect(existsSync(join(workspaceRoot, "out.txt"))).toBe(false);
    // The affirmation text became the NEW run's input — not an approval.
    expect(state.tasks.find((t) => t.id === second.taskId)?.input).toBe("yes, send it");
    expect(state.tasks.find((t) => t.id === first.taskId)?.supersededByTaskId).toBe(second.taskId);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("supersede applies to a message dispatched into a Topic", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-topic-${basename(workspaceRoot)}`);
    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createTopic(state, { title: "root" }); // any parent session works
      const topic = createTopic(state, { title: "Email draft", parentChatSessionId: chat.id });
      return { chatId: chat.id, topicId: topic.id };
    });
    const preparedFor = (content: string) => {
      const liveSession = readState(config.instance).chatSessions.find((s) => s.id === chatId)!;
      return { content, images: [], audio: undefined, liveSession, clientSurface: undefined };
    };

    stubGatedWrite(config, "call_topic");
    const first = await runTopicSubmission(config, topicId, preparedFor("draft the file"));
    await waitFor(config, first.taskId, (t) => t.status === "waiting_approval");

    stubAnswer(config, "Fresh topic turn.");
    const second = await dispatchChatMessageToTopic(config, chatId, topicId, preparedFor("change of plan"));
    if ("queued" in second) throw new Error("expected the supersede path to run now");
    expect(second.taskId).not.toBe(first.taskId);

    await waitFor(config, first.taskId, (t) => t.status === "cancelled");
    await waitFor(config, first.taskId, (t) => t.supersededByTaskId === second.taskId);
    const newTask = await waitFor(config, second.taskId, (t) => t.status === "completed");
    expect(newTask.chatSessionId).toBe(topicId);
    expect(existsSync(join(workspaceRoot, "out.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a parked root-Chat gate supersedes in place — intake routing never sends the message to a topic", async () => {
    // The carve-outs run BEFORE routeChatMessage: a message posted while the
    // root Chat's own live run is parked on an Authorization gate must
    // supersede that run in the root Chat. Routing it into a Topic would
    // strand the parked gate behind a turn the user has already moved past.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-router-${basename(workspaceRoot)}`);
    // A kind:"agent" session is the root Chat — the only kind the router runs on.
    const chatId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Messages", undefined, undefined, undefined, "agent").id
    );

    stubGatedWrite(config, "call_root_gate");
    // The kind:"agent" submit resolves with the echo-first accepted ack —
    // settle to the dispatched run before waiting on the gate.
    const firstAccepted = await submitChatMessage(config, chatId, { content: "write out.txt" });
    const first = await settleSubmittedChatMessage(config, chatId, firstAccepted, "write out.txt");
    if ("queued" in first || !("taskId" in first)) throw new Error("expected a run-now submission");
    await waitFor(config, first.taskId, (t) => t.status === "waiting_approval");

    // The router would classify the follow-up as a new topic; the parked
    // gate must win before the router is ever consulted.
    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Should Not Mint" });
    stubAnswer(config, "Fresh start in Chat.");
    const second = await submitChatMessage(config, chatId, { content: "actually do something else" });
    if ("queued" in second || !("taskId" in second)) throw new Error("expected the supersede path to run now");

    // The replacement turn runs in the ROOT chat, not a routed topic.
    expect(readState(config.instance).tasks.find((t) => t.id === second.taskId)?.chatSessionId).toBe(chatId);
    await waitFor(config, first.taskId, (t) => t.status === "cancelled");
    await waitFor(config, first.taskId, (t) => t.supersededByTaskId === second.taskId);
    await waitFor(config, second.taskId, (t) => t.status === "completed");

    const state = readState(config.instance);
    // No topic was minted and the gate settled without executing.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    expect(state.authorizations.find((a) => a.taskId === first.taskId)?.status).toBe("denied");
    expect(existsSync(join(workspaceRoot, "out.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("non-empty pendingMessages queues instead of superseding", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-queued-${basename(workspaceRoot)}`);
    const chat = await createChat(config, { title: "queued" });
    const taskId = await seedTask(config, chat.id, "waiting_approval");
    await mutateState(config.instance, (state) => {
      createAuthorization(state, {
        taskId,
        action: "file.write",
        target: "out.txt",
        risk: "medium",
        reason: "Write out.txt",
        payload: { path: "out.txt", toolCallId: "call_seeded" }
      });
      const session = state.chatSessions.find((s) => s.id === chat.id);
      if (session) {
        session.pendingMessages = [
          { id: "pending_first", content: "already queued", createdAt: new Date().toISOString() }
        ];
      }
    });

    const result = await submitChatMessage(config, chat.id, { content: "and another" });

    // Queued behind the existing message — no cancel, gate untouched.
    expect("queued" in result && result.queued).toBe(true);
    const state = readState(config.instance);
    expect(state.tasks.find((t) => t.id === taskId)?.status).toBe("waiting_approval");
    expect(state.authorizations.find((a) => a.taskId === taskId)?.status).toBe("pending");
    const pending = state.chatSessions.find((s) => s.id === chat.id)?.pendingMessages ?? [];
    expect(pending.map((p) => p.content)).toEqual(["already queued", "and another"]);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a mid-loop (running) task queues unchanged", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-running-${basename(workspaceRoot)}`);
    const chat = await createChat(config, { title: "running" });
    const taskId = await seedTask(config, chat.id, "running");

    const result = await submitChatMessage(config, chat.id, { content: "steer mid-run" });

    expect("queued" in result && result.queued).toBe(true);
    const state = readState(config.instance);
    expect(state.tasks.find((t) => t.id === taskId)?.status).toBe("running");
    expect(state.tasks.find((t) => t.id === taskId)?.supersededByTaskId).toBeUndefined();
    expect((state.chatSessions.find((s) => s.id === chat.id)?.pendingMessages ?? []).map((p) => p.content)).toEqual([
      "steer mid-run"
    ]);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a pending SetupRequest gate does not supersede — the message queues", async () => {
    // SetupRequest parks (chat.choice questions, credential cards) are
    // questions to answer, not decisions to override. A REAL ask_user park
    // carries the needsInput stamp and takes the answer path
    // (chat-needs-input.test.ts); this seeded park has no stamp — the
    // credential-card / legacy shape — so the message queues as today.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-supersede-ws-"));
    const config = buildConfig(workspaceRoot, `supersede-setup-${basename(workspaceRoot)}`);
    const chat = await createChat(config, { title: "setup" });
    const taskId = await seedTask(config, chat.id, "waiting_approval");
    await mutateState(config.instance, (state) => {
      createSetupRequest(state, {
        taskId,
        action: "chat.choice",
        target: "Which venue?",
        reason: "Which venue?",
        payload: { question: "Which venue?", options: [{ label: "A" }, { label: "B" }], toolCallId: "call_choice" }
      });
    });

    const result = await submitChatMessage(config, chat.id, { content: "hold on" });

    expect("queued" in result && result.queued).toBe(true);
    const state = readState(config.instance);
    expect(state.tasks.find((t) => t.id === taskId)?.status).toBe("waiting_approval");
    expect(state.setupRequests.find((s) => s.taskId === taskId)?.status).toBe("pending");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("direct start (POST /api/containers)", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-direct-start-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("mints an unpinned container under the agent chat and runs the first turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-direct-ws-"));
    const config = buildConfig(workspaceRoot, `direct-start-${basename(workspaceRoot)}`);
    const handler = createHandler(config);
    stubAnswer(config, "Your June balance is settled.");

    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/containers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ content: "check my Splitwise balance from June" })
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { containerId: string; taskId: string; status: string };
    expect(body.containerId).toBeString();
    expect(body.taskId).toBeString();
    expect(body.status).toBeString();

    const state = readState(config.instance);
    const container = state.chatSessions.find((s) => s.id === body.containerId);
    expect(container).toBeDefined();
    // Unpinned work item under the agent's canonical Chat — the router was
    // never involved and pinning stays a user gesture.
    expect(container?.kind).toBe("topic");
    expect(container?.pinned).toBeFalsy();
    expect(container?.title).toBe("check my Splitwise balance from June");
    const agentChat = state.chatSessions.find((s) => s.kind === "agent");
    expect(agentChat).toBeDefined();
    expect(container?.parentChatSessionId).toBe(agentChat!.id);
    // The first turn runs INSIDE the container.
    expect(state.tasks.find((t) => t.id === body.taskId)?.chatSessionId).toBe(body.containerId);

    const finished = await waitFor(config, body.taskId, (t) => t.status === "completed");
    expect(finished.summary).toBe("Your June balance is settled.");
    const userMsg = readState(config.instance).chatMessages.find(
      (m) => m.sessionId === body.containerId && m.role === "user"
    );
    expect(userMsg?.content).toBe("check my Splitwise balance from June");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("persists the startedAs creation gesture and rejects bad values with 400", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-direct-ws-"));
    const config = buildConfig(workspaceRoot, `direct-start-started-as-${basename(workspaceRoot)}`);
    const handler = createHandler(config);
    stubAnswer(config, "Hello!");

    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/containers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ content: "just saying hi", startedAs: "message" })
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { containerId: string };
    expect(readState(config.instance).chatSessions.find((s) => s.id === body.containerId)?.startedAs).toBe("message");

    // A bad enum value 400s before anything is minted.
    const topicsBefore = readState(config.instance).chatSessions.filter((s) => s.kind === "topic").length;
    const rejected = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/containers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ content: "hi again", startedAs: "conversation" })
      })
    );
    expect(rejected.status).toBe(400);
    expect(readState(config.instance).chatSessions.filter((s) => s.kind === "topic").length).toBe(topicsBefore);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a validation failure leaves no orphan container behind", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-direct-ws-"));
    const config = buildConfig(workspaceRoot, `direct-start-empty-${basename(workspaceRoot)}`);
    const handler = createHandler(config);

    const sessionsBefore = readState(config.instance).chatSessions.length;
    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/containers`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ content: "   " })
      })
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    // The agent's canonical chat may have been lazily created, but no topic
    // container was minted for the rejected submission.
    const sessions = readState(config.instance).chatSessions;
    expect(sessions.filter((s) => s.kind === "topic").length).toBe(0);
    expect(sessions.length).toBeLessThanOrEqual(sessionsBefore + 1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
