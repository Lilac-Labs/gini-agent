// Unit tests for the per-session chat message queue (ADR
// chat-message-queue.md). While a session has an in-flight chat task, a newly
// posted message is queued on the session instead of running concurrently;
// when the current turn ends, the next queued message auto-dispatches (FIFO,
// one per turn).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { insertChatBlock, listChatBlocks, listThreadBlocks, mutateState, readState } from "../state";
import {
  createChat,
  dispatchNextPendingChatMessage,
  removePendingChatMessageById,
  submitChatMessage,
  submitThreadReply
} from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";
import type { RuntimeConfig, Task } from "../types";

// Submit + settle: the echo-first ack resolves before the routing verdict, so
// the queue-vs-run outcome these tests pin only exists once the dispatch
// continuation lands in state.
async function submitAndSettle(config: RuntimeConfig, sessionId: string, content: string) {
  const result = await submitChatMessage(config, sessionId, { content });
  return settleSubmittedChatMessage(config, sessionId, result, content);
}

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7341,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-queue-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-queue-test-logs",
    approvalMode: "strict"
  };
}

function stubTurn(config: RuntimeConfig): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text: "ok",
    toolCalls: [],
    finishReason: "stop"
  });
}

async function waitForStatus(
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

// Seed a non-terminal chat task directly on the session so the session reads
// as "busy" without running the agent loop. Returns the task id.
async function seedInFlightTask(config: RuntimeConfig, sessionId: string): Promise<string> {
  const taskId = `task_inflight_${Math.random().toString(36).slice(2, 8)}`;
  await mutateState(config.instance, (state) => {
    const task: Task = {
      id: taskId,
      title: "in flight",
      input: "busy",
      status: "running",
      instance: state.instance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: [],
      chatSessionId: sessionId
    };
    state.tasks.push(task);
    const session = state.chatSessions.find((s) => s.id === sessionId);
    if (session) session.taskIds.push(taskId);
  });
  return taskId;
}

// Settle a seeded task to a terminal status so the session reads as idle —
// the precondition the auto-dispatch guard requires before it pops the queue.
async function settleTask(config: RuntimeConfig, taskId: string, status: Task["status"]): Promise<void> {
  await mutateState(config.instance, (state) => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = status;
      task.updatedAt = new Date().toISOString();
    }
  });
}

function session(config: RuntimeConfig, sessionId: string) {
  return readState(config.instance).chatSessions.find((s) => s.id === sessionId);
}

describe("chat message queue", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-queue-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-queue-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("idle session runs the submission immediately", async () => {
    const config = buildConfig(workspaceRoot, "queue-idle");
    stubTurn(config);
    const chat = await createChat(config, { title: "idle" });

    const result = await submitAndSettle(config, chat.id, "hello");

    expect("queued" in result).toBe(false);
    if ("queued" in result) throw new Error("unexpected queued result");
    expect(result.taskId).toBeString();
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);

    await waitForStatus(config, result.taskId, (t) => t.status === "completed");
  });

  test("busy session enqueues without starting a second task", async () => {
    const config = buildConfig(workspaceRoot, "queue-busy");
    const chat = await createChat(config, { title: "busy" });
    await seedInFlightTask(config, chat.id);
    const tasksBefore = readState(config.instance).tasks.length;

    const result = await submitAndSettle(config, chat.id, "queued one");

    expect("queued" in result && result.queued).toBe(true);
    if (!("queued" in result)) throw new Error("expected queued result");
    expect(result.pendingId).toBeString();

    const pending = session(config, chat.id)?.pendingMessages ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.content).toBe("queued one");
    expect(pending[0]?.id).toBe(result.pendingId);
    // No second task was created — the in-flight one is the only task.
    expect(readState(config.instance).tasks.length).toBe(tasksBefore);
  });

  test("bypassQueue runs immediately even while a turn is in flight, never enqueuing", async () => {
    // The messaging bridge passes { bypassQueue: true } so every inbound
    // message gets its own taskId — the poller's reply-mirror waits on that
    // task and sends the assistant reply back out. A queued submit would
    // land without a taskId and the reply would be silently dropped. Pin
    // that bypassQueue runs now (new task, returned taskId) and does NOT
    // enqueue, even with a turn already in flight.
    const config = buildConfig(workspaceRoot, "queue-bypass");
    stubTurn(config);
    const chat = await createChat(config, { title: "bypass" });
    await seedInFlightTask(config, chat.id);
    const tasksBefore = readState(config.instance).tasks.length;

    const result = await submitChatMessage(
      config,
      chat.id,
      { content: "from messaging" },
      { bypassQueue: true }
    );

    // Run-now shape: a real taskId, no queued flag.
    expect("queued" in result).toBe(false);
    expect(result.taskId).toBeString();
    // A new task was created and the queue stayed empty.
    expect(readState(config.instance).tasks.length).toBe(tasksBefore + 1);
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);

    await waitForStatus(config, result.taskId, (t) => t.status === "completed");
  });

  test("enqueues behind an existing queue even when no task is running, preserving order", async () => {
    const config = buildConfig(workspaceRoot, "queue-nonempty-no-task");
    const chat = await createChat(config, { title: "ordered" });
    // Pre-seed a pending message with no in-flight task. A new submit must
    // still queue (behind it) rather than jumping ahead and running now.
    await mutateState(config.instance, (state) => {
      const s = state.chatSessions.find((item) => item.id === chat.id);
      if (s) s.pendingMessages = [{ id: "pending_existing", content: "first", createdAt: new Date().toISOString() }];
    });

    const result = await submitAndSettle(config, chat.id, "second");

    expect("queued" in result && result.queued).toBe(true);
    const pending = session(config, chat.id)?.pendingMessages ?? [];
    expect(pending.map((p) => p.content)).toEqual(["first", "second"]);
    // No task was started for the run-ahead message.
    expect(readState(config.instance).tasks).toHaveLength(0);
  });

  test("dispatchNextPendingChatMessage pops FIFO and runs the next message once the turn settles", async () => {
    const config = buildConfig(workspaceRoot, "queue-dispatch");
    stubTurn(config);
    const chat = await createChat(config, { title: "dispatch" });
    // Queue two messages behind an in-flight task.
    const inFlight = await seedInFlightTask(config, chat.id);
    await submitAndSettle(config, chat.id, "alpha");
    await submitAndSettle(config, chat.id, "beta");
    expect((session(config, chat.id)?.pendingMessages ?? []).map((p) => p.content)).toEqual([
      "alpha",
      "beta"
    ]);
    const tasksBefore = readState(config.instance).tasks.length;
    // Settle the in-flight turn so the session reads as idle — the guarded
    // dispatch only pops once no live turn remains.
    await settleTask(config, inFlight, "completed");

    await dispatchNextPendingChatMessage(config, chat.id);

    // FIFO: "alpha" popped and dispatched as its own real turn; "beta" remains.
    const pending = session(config, chat.id)?.pendingMessages ?? [];
    expect(pending.map((p) => p.content)).toEqual(["beta"]);
    expect(readState(config.instance).tasks.length).toBe(tasksBefore + 1);
    const userMsg = readState(config.instance).chatMessages.find(
      (m) => m.sessionId === chat.id && m.role === "user" && m.content === "alpha"
    );
    expect(userMsg).toBeDefined();
  });

  test("dispatchNextPendingChatMessage is a no-op with an empty queue", async () => {
    const config = buildConfig(workspaceRoot, "queue-dispatch-empty");
    const chat = await createChat(config, { title: "empty" });
    const tasksBefore = readState(config.instance).tasks.length;

    await dispatchNextPendingChatMessage(config, chat.id);

    expect(readState(config.instance).tasks.length).toBe(tasksBefore);
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);
  });

  test("does NOT dispatch while a turn is paused at waiting_approval, then drains once it settles", async () => {
    const config = buildConfig(workspaceRoot, "queue-waiting-approval");
    stubTurn(config);
    const chat = await createChat(config, { title: "approval" });
    // Seed a turn paused for approval and a queued message behind it. The
    // premature `.finally` at waiting_approval (the turn paused, not ended)
    // would otherwise start the queued message as a second concurrent turn.
    const paused = await seedInFlightTask(config, chat.id);
    await settleTask(config, paused, "waiting_approval");
    await submitAndSettle(config, chat.id, "queued during approval");
    expect((session(config, chat.id)?.pendingMessages ?? []).map((p) => p.content)).toEqual([
      "queued during approval"
    ]);
    const tasksBefore = readState(config.instance).tasks.length;

    // waiting_approval counts as in-flight: the guard refuses to pop.
    await dispatchNextPendingChatMessage(config, chat.id);

    expect((session(config, chat.id)?.pendingMessages ?? []).map((p) => p.content)).toEqual([
      "queued during approval"
    ]);
    expect(readState(config.instance).tasks.length).toBe(tasksBefore);

    // Once the paused turn reaches a terminal status, the same call drains it.
    await settleTask(config, paused, "completed");
    await dispatchNextPendingChatMessage(config, chat.id);

    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);
    expect(readState(config.instance).tasks.length).toBe(tasksBefore + 1);
    const userMsg = readState(config.instance).chatMessages.find(
      (m) => m.sessionId === chat.id && m.role === "user" && m.content === "queued during approval"
    );
    expect(userMsg).toBeDefined();
  });

  test("thread reply enqueues behind an in-flight task, carrying its thread membership", async () => {
    const config = buildConfig(workspaceRoot, "queue-thread-busy");
    const chat = await createChat(config, { title: "thread-busy" });
    // Root a thread on a main-chat block, then make the session busy so a
    // reply typed mid-turn has to queue instead of spawning a second task.
    const parent = insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: chat.id,
      text: "original message",
      agentId: null
    });
    await seedInFlightTask(config, chat.id);
    const tasksBefore = readState(config.instance).tasks.length;

    const result = await submitThreadReply(config, chat.id, "thread_busy", {
      content: "reply during a live turn",
      parentBlockId: parent.id
    });

    expect("queued" in result && result.queued).toBe(true);
    if (!("queued" in result)) throw new Error("expected queued result");
    expect(result.pendingId).toBeString();
    // No second task spawned — the in-flight one is still the only task.
    expect(readState(config.instance).tasks.length).toBe(tasksBefore);
    const pending = session(config, chat.id)?.pendingMessages ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.content).toBe("reply during a live turn");
    expect(pending[0]?.threadId).toBe("thread_busy");
    expect(pending[0]?.parentBlockId).toBe(parent.id);
  });

  test("dispatchNextPendingChatMessage re-dispatches a queued thread reply back into its thread", async () => {
    const config = buildConfig(workspaceRoot, "queue-thread-dispatch");
    stubTurn(config);
    const chat = await createChat(config, { title: "thread-dispatch" });
    const parent = insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: chat.id,
      text: "original message",
      agentId: null
    });
    const inFlight = await seedInFlightTask(config, chat.id);
    // alsoToMain asks the reply to mirror into the main transcript; the flag
    // must survive the queue so the popped reply still inserts the mirror.
    await submitThreadReply(config, chat.id, "thread_dispatch", {
      content: "queued thread reply",
      parentBlockId: parent.id,
      alsoToMain: true
    });
    const queued = (session(config, chat.id)?.pendingMessages ?? [])[0];
    expect(queued?.threadId).toBe("thread_dispatch");
    expect(queued?.alsoToMain).toBe(true);
    const tasksBefore = readState(config.instance).tasks.length;
    // Settle the live turn so the guarded dispatch can pop.
    await settleTask(config, inFlight, "completed");

    await dispatchNextPendingChatMessage(config, chat.id);

    // The queue drained and a new task spawned for the popped reply.
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);
    expect(readState(config.instance).tasks.length).toBe(tasksBefore + 1);
    // The dispatched task threads — it is not a main-chat turn.
    const dispatched = readState(config.instance).tasks.find((t) => t.id !== inFlight);
    expect(dispatched?.threadId).toBe("thread_dispatch");
    expect(dispatched?.parentBlockId).toBe(parent.id);
    // The user row lands as a thread-tagged block, not in the main stream.
    const threadBlocks = listThreadBlocks(config.instance, chat.id, "thread_dispatch");
    const userBlock = threadBlocks.find((b) => b.kind === "user_text" && b.text === "queued thread reply");
    expect(userBlock).toBeDefined();
    expect(userBlock?.threadId).toBe("thread_dispatch");
    // alsoToMain survived the queue: an un-threaded mirror of the reply is
    // also inserted into the main transcript.
    const mainMirror = listChatBlocks(config.instance, chat.id).find(
      (b) => b.kind === "user_text" && b.text === "queued thread reply" && !b.threadId
    );
    expect(mainMirror).toBeDefined();
  });

  test("a queued main-chat message still drains via the main path, with no thread membership", async () => {
    const config = buildConfig(workspaceRoot, "queue-main-after-thread");
    stubTurn(config);
    const chat = await createChat(config, { title: "main-drain" });
    const inFlight = await seedInFlightTask(config, chat.id);
    await submitAndSettle(config, chat.id, "plain main message");
    expect((session(config, chat.id)?.pendingMessages ?? [])[0]?.threadId).toBeUndefined();
    const tasksBefore = readState(config.instance).tasks.length;
    await settleTask(config, inFlight, "completed");

    await dispatchNextPendingChatMessage(config, chat.id);

    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);
    expect(readState(config.instance).tasks.length).toBe(tasksBefore + 1);
    // The dispatched task is a main-chat turn — no thread membership.
    const dispatched = readState(config.instance).tasks.find((t) => t.id !== inFlight);
    expect(dispatched?.threadId).toBeUndefined();
    const userMsg = readState(config.instance).chatMessages.find(
      (m) => m.sessionId === chat.id && m.role === "user" && m.content === "plain main message"
    );
    expect(userMsg).toBeDefined();
    expect(userMsg?.threadId).toBeUndefined();
  });

  test("removePendingChatMessageById removes the right item and reports unknown ids", async () => {
    const config = buildConfig(workspaceRoot, "queue-remove");
    const chat = await createChat(config, { title: "remove" });
    await seedInFlightTask(config, chat.id);
    const first = await submitAndSettle(config, chat.id, "keep me");
    const second = await submitAndSettle(config, chat.id, "remove me");
    if (!("queued" in first) || !("queued" in second)) throw new Error("expected queued results");

    const removed = await removePendingChatMessageById(config, chat.id, second.pendingId);
    expect(removed).toBe(true);
    const pending = session(config, chat.id)?.pendingMessages ?? [];
    expect(pending.map((p) => p.content)).toEqual(["keep me"]);
    expect(pending.map((p) => p.id)).toEqual([first.pendingId]);

    // An unknown id removes nothing and reports false.
    const removedUnknown = await removePendingChatMessageById(config, chat.id, "pending_does_not_exist");
    expect(removedUnknown).toBe(false);
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(1);
  });

  test("end-to-end: a message posted during a turn auto-dispatches when the turn completes", async () => {
    const config = buildConfig(workspaceRoot, "queue-e2e");
    stubTurn(config);
    const chat = await createChat(config, { title: "e2e" });

    // First message runs immediately.
    const first = await submitAndSettle(config, chat.id, "first turn");
    if ("queued" in first) throw new Error("first submit should run now");

    // Second posted while the first turn is in flight enqueues. The submitTask
    // .finally chokepoint drains it once the first turn settles, so poll for
    // the second user message to appear.
    const second = await submitAndSettle(config, chat.id, "second turn");

    if ("queued" in second) {
      // Auto-dispatch fires on the first turn's terminal transition; wait for
      // the queued message to drain into its own user row.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const userContents = readState(config.instance).chatMessages
          .filter((m) => m.sessionId === chat.id && m.role === "user")
          .map((m) => m.content);
        if (userContents.includes("second turn")) break;
        await Bun.sleep(10);
      }
    }

    const userContents = readState(config.instance).chatMessages
      .filter((m) => m.sessionId === chat.id && m.role === "user")
      .map((m) => m.content);
    expect(userContents).toContain("first turn");
    expect(userContents).toContain("second turn");
    expect(session(config, chat.id)?.pendingMessages ?? []).toHaveLength(0);
  });
});
