// Phase-3 unified-task-model runtime surface: the `needs_input` status.
//
// An all-chat.choice park (ask_user) is reclassified from waiting_approval to
// needs_input, with the question payload stamped on Task.needsInput. A plain
// message post into the parked session answers the question and resumes the
// SAME task (zero client changes for CLI/bridges); the card's /complete
// endpoint keeps working; a turn that touches an approval gate keeps
// waiting_approval; the park survives a gateway restart; a second resolve of
// an already-answered question fails gracefully; and GINI_NEEDS_INPUT_STATUS=0
// parks as waiting_approval while the internal machinery keeps working.
//
// Uses the echo provider with stubbed tool-calling responses so the parked
// task is a REAL chat-task loop pause (toolCallState snapshot included) and
// the resume paths run end to end — same harness as http-chat-choice.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import { createHandler } from "../http";
import { ApprovalRaceLostError, reconcileInFlightTasks, resolveSetupRequest } from "../agent";
import { persistConnectOutcome } from "./safe-resume";
import { resumeChatTask } from "./chat-task";
import { dispatchChatMessageToTopic, submitChatMessage as submitChatMessageRaw } from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";
import { createChatSession, createTopic, listChatBlocks, mutateState, readState, sessionHasInFlightChatTask } from "../state";
import type { RuntimeConfig, Task } from "../types";

// Narrow the submit union to the run-now branch for the answer-path asserts
// (a queued result where a run-now is expected is a test-setup bug). An
// echo-first accepted result (kind:"agent" intake) settles to the dispatched
// outcome first; answer-path results pass through synchronously.
async function submitChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>
): Promise<{ runId?: string; taskId: string; status: Task["status"] }> {
  const result = await submitChatMessageRaw(config, sessionId, input);
  const settled = await settleSubmittedChatMessage(
    config,
    sessionId,
    result,
    String(input.content ?? "")
  );
  if ("queued" in settled) throw new Error("expected run-now submission, got queued");
  return settled;
}

const ROOT = "/tmp/gini-chat-needs-input-tests";

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  // Shrink the resume race-window poll (production default 1000/100) so the
  // in-process harness resolves within a couple of mutateState boundaries.
  process.env.GINI_RESUME_WAIT_BUDGET_MS = "40";
  process.env.GINI_RESUME_WAIT_TICK_MS = "5";
});

afterEach(() => {
  clearEchoToolCallingResponses();
  clearEchoStructuredResponses();
  delete process.env.GINI_NEEDS_INPUT_STATUS;
});

afterAll(() => {
  delete process.env.GINI_RESUME_WAIT_BUDGET_MS;
  delete process.env.GINI_RESUME_WAIT_TICK_MS;
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7346,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`,
    approvalMode: "strict"
  };
}

async function waitForTask(
  config: RuntimeConfig,
  taskId: string,
  status: Task["status"],
  timeoutMs = 5000
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (task?.status === status) return task;
    // Tight poll: the status flips on the in-process microtask/timer queue, so a
    // small interval just notices the already-settled transition sooner (each
    // wait sheds ~half a poll interval of dead wall-clock). The 5s deadline still
    // bounds a genuine hang identically. Notably the ->completed resumes settle in
    // <1 tick, so a 20ms interval was pure floor there.
    await Bun.sleep(2);
  }
  throw new Error(`Task ${taskId} did not reach ${status} within ${timeoutMs}ms`);
}

const QUESTION = "How should I search the web?";
const OPTIONS = [
  { label: "Set up Brave + Exa", description: "Best coverage" },
  { label: "Set up Brave only" },
  { label: "Neither — use web_fetch" }
];

function stubAskUser(config: RuntimeConfig): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text: "",
    toolCalls: [
      {
        id: "call_choice",
        type: "function",
        function: {
          name: "ask_user",
          arguments: JSON.stringify({ question: QUESTION, options: OPTIONS })
        }
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

// Drive a real chat turn that parks on ask_user. Returns the parked task id,
// session id, and the pending chat.choice setup-request id.
async function parkOnAskUser(
  config: RuntimeConfig,
  parkedStatus: Task["status"] = "needs_input"
): Promise<{ taskId: string; sessionId: string; setupId: string }> {
  stubAskUser(config);
  const session = await mutateState(config.instance, (state) => createChatSession(state, "needs-input session"));
  const submitted = await submitChatMessage(config, session.id, { content: "find me fresh results" });
  await waitForTask(config, submitted.taskId, parkedStatus);
  const setup = readState(config.instance).setupRequests.find(
    (s) => s.taskId === submitted.taskId && s.action === "chat.choice"
  );
  if (!setup) throw new Error("chat.choice setup request not minted");
  return { taskId: submitted.taskId, sessionId: session.id, setupId: setup.id };
}

describe("needs_input park", () => {
  test("an all-chat.choice park stamps status needs_input + the question payload", async () => {
    const instance = "needs-input-park";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);

    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("needs_input");
    expect(task?.currentStep).toBe("Waiting for your answer");
    expect(task?.needsInput?.question).toBe(QUESTION);
    expect(task?.needsInput?.options).toEqual(OPTIONS.map((o) => o.label));
    expect(task?.needsInput?.setupRequestId).toBe(setupId);
    // blockId points at the setup_requested card so clients can deep-link.
    const setupBlock = listChatBlocks(config.instance, sessionId).find((b) => b.kind === "setup_requested");
    expect(task?.needsInput?.blockId).toBe(setupBlock!.id);
    // The paused snapshot is intact — this is the same park, reclassified.
    expect(task?.toolCallState?.pending?.length).toBe(1);
    // needs_input counts as in-flight, so a concurrent turn can't start.
    expect(sessionHasInFlightChatTask(state, sessionId)).toBe(true);
  });

  test("a turn that touches an approval gate parks as waiting_approval (no needsInput stamp)", async () => {
    const instance = "needs-input-mixed";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    // The model asks for a gated file_write AND ask_user in the same turn.
    // The Authorization gate pends first, so the park is NOT all-chat.choice
    // and keeps waiting_approval exactly as before.
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "",
      toolCalls: [
        {
          id: "call_write",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) }
        },
        {
          id: "call_choice",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({ question: QUESTION, options: OPTIONS })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    const session = await mutateState(config.instance, (state) => createChatSession(state, "mixed session"));
    const submitted = await submitChatMessage(config, session.id, { content: "write it out" });
    const parked = await waitForTask(config, submitted.taskId, "waiting_approval");
    expect(parked.needsInput).toBeUndefined();
    expect(parked.currentStep).toBe("Waiting for approval");
    const state = readState(config.instance);
    expect(state.authorizations.some((a) => a.taskId === submitted.taskId && a.status === "pending")).toBe(true);
  });

  test("GINI_NEEDS_INPUT_STATUS=0 parks as waiting_approval but still stamps needsInput", async () => {
    const instance = "needs-input-hatch";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    process.env.GINI_NEEDS_INPUT_STATUS = "0";
    const { taskId, setupId } = await parkOnAskUser(config, "waiting_approval");

    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("waiting_approval");
    // The internal machinery still runs — only the exposed status differs.
    expect(task?.needsInput?.setupRequestId).toBe(setupId);

    // The message-answer path keys on the stamp, so it works under the hatch.
    stubAnswer(config, "Got it — Brave only.");
    const answered = await submitChatMessage(config, task!.chatSessionId!, { content: "brave only please" });
    expect(answered.taskId).toBe(taskId);
    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Got it — Brave only.");
  });
});

describe("needs_input answer paths", () => {
  test("a plain message post answers the question and resumes the SAME task", async () => {
    const instance = "needs-input-answer";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);

    stubAnswer(config, "Got it, using DuckDuckGo.");
    const answered = await submitChatMessage(config, sessionId, { content: "just use duckduckgo" });
    // Same task, same run — no new turn was minted.
    expect(answered.taskId).toBe(taskId);
    expect(readState(config.instance).tasks.filter((t) => t.chatSessionId === sessionId).length).toBe(1);

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Got it, using DuckDuckGo.");
    // The park stamp is consumed by the resume.
    expect(finished.needsInput).toBeUndefined();

    const state = readState(config.instance);
    const setup = state.setupRequests.find((s) => s.id === setupId);
    expect(setup?.status).toBe("completed");
    expect(setup?.connectOutcome).toEqual({ ok: true, message: "You answered: just use duckduckgo" });

    const blocks = listChatBlocks(config.instance, sessionId);
    // The user's message renders in the thread, and the answer rode the
    // ask_user tool result into the loop.
    expect(blocks.some((b) => b.kind === "user_text" && b.text === "just use duckduckgo")).toBe(true);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes('User answered: "just use duckduckgo"'))
    ).toBe(true);
  });

  test("an option-less ask_user is rejected in place — no park, no chat.choice SetupRequest", async () => {
    // ask_user is options-only: an open-ended ask belongs in the model's
    // plain message text, so the dispatcher returns a graceful steering
    // error instead of minting an empty choice card. The turn keeps running
    // on the error result and finishes normally — it never parks.
    const instance = "needs-input-optionless";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "",
      toolCalls: [
        {
          id: "call_open",
          type: "function",
          function: { name: "ask_user", arguments: JSON.stringify({ question: "What should the reply say?" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    // The model recovers by asking in prose — the steered path.
    stubAnswer(config, "What should the reply say?");
    const session = await mutateState(config.instance, (state) => createChatSession(state, "open question session"));
    const submitted = await submitChatMessage(config, session.id, { content: "reply to dana for me" });
    const finished = await waitForTask(config, submitted.taskId, "completed");
    expect(finished.needsInput).toBeUndefined();

    const state = readState(config.instance);
    expect(state.setupRequests.filter((s) => s.taskId === submitted.taskId)).toEqual([]);
    const blocks = listChatBlocks(config.instance, session.id);
    // The error text steers the model to plain message text.
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes("ask_user only presents choices"))
    ).toBe(true);
    expect(blocks.some((b) => b.kind === "setup_requested")).toBe(false);
  });

  test("a Chat message dispatched into a parked Topic answers and resumes the SAME task", async () => {
    const instance = "needs-input-topic-dispatch";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);

    // Park a TOPIC on ask_user (a kind:"topic" submit is never routed and
    // runs in place).
    stubAskUser(config);
    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, { title: "Search setup", parentChatSessionId: chat.id });
      return { chatId: chat.id, topicId: topic.id };
    });
    const parked = await submitChatMessage(config, topicId, { content: "find me fresh results" });
    await waitForTask(config, parked.taskId, "needs_input");

    // A Chat-routed message lands through dispatchChatMessageToTopic — the
    // needs-input pre-check consumes it as the answer BEFORE the queue
    // decision, resuming the SAME task instead of queueing behind the park.
    stubAnswer(config, "Got it — Brave only.");
    const liveSession = readState(config.instance).chatSessions.find((s) => s.id === chatId)!;
    const dispatched = await dispatchChatMessageToTopic(config, chatId, topicId, {
      content: "brave only please",
      images: [],
      audio: undefined,
      liveSession,
      clientSurface: undefined
    });
    if ("queued" in dispatched) throw new Error("expected the answer path to run now, got queued");
    expect(dispatched.taskId).toBe(parked.taskId);

    const finished = await waitForTask(config, parked.taskId, "completed");
    expect(finished.summary).toBe("Got it — Brave only.");
    // The message resumed the parked turn — it never minted a second task.
    expect(readState(config.instance).tasks.filter((t) => t.chatSessionId === topicId).length).toBe(1);
  });

  test("a parked root-Chat question consumes the message as its answer before intake routing", async () => {
    // The answer carve-out runs BEFORE routeChatMessage: a message posted
    // while the root Chat's own live run is parked on ask_user answers and
    // resumes that SAME task. Routing it into a Topic would strand the
    // parked question forever.
    const instance = "needs-input-router";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);

    // Park the ROOT Chat (kind:"agent" — the only kind the router runs on).
    stubAskUser(config);
    const chatId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Messages", undefined, undefined, undefined, "agent").id
    );
    const submitted = await submitChatMessage(config, chatId, { content: "find me fresh results" });
    await waitForTask(config, submitted.taskId, "needs_input");

    // The router would classify the answer as a new topic; the parked
    // question must consume it before the router is ever consulted.
    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Should Not Mint" });
    stubAnswer(config, "Got it — Brave only.");
    const answered = await submitChatMessage(config, chatId, { content: "brave only please" });
    expect(answered.taskId).toBe(submitted.taskId);

    const finished = await waitForTask(config, submitted.taskId, "completed");
    expect(finished.summary).toBe("Got it — Brave only.");
    const state = readState(config.instance);
    // No topic was minted and no second task started in the Chat.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    expect(state.tasks.filter((t) => t.chatSessionId === chatId).length).toBe(1);
  });

  test("POST /api/setup-requests/:id/complete still answers the card", async () => {
    const instance = "needs-input-complete";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, setupId } = await parkOnAskUser(config);

    stubAnswer(config, "Great — setting up Brave and Exa now.");
    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ choice: { label: "Set up Brave + Exa" } })
      })
    );
    expect(response.status).toBe(200);
    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Great — setting up Brave and Exa now.");
    expect(finished.needsInput).toBeUndefined();
  });

  test("double answer: the second resolve of an answered question fails gracefully", async () => {
    const instance = "needs-input-race";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);

    stubAnswer(config, "Answered once.");
    const answered = await submitChatMessage(config, sessionId, { content: "first answer wins" });
    expect(answered.taskId).toBe(taskId);

    // A near-simultaneous answer from the thread card loses the claim with a
    // typed already-resolved error, never a double resume.
    await expect(
      resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false })
    ).rejects.toThrow(ApprovalRaceLostError);
    // The HTTP surface maps the same race to 410 via its pending pre-check.
    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ choice: { label: "Set up Brave only" } })
      })
    );
    expect(response.status).toBe(410);

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Answered once.");
    // Exactly one answer reached the loop.
    const answers = listChatBlocks(config.instance, sessionId).filter(
      (b) => b.kind === "tool_result" && b.preview.includes("User answered:")
    );
    expect(answers.length).toBe(1);
  });

  test("a needs_input park survives a restart-reconcile and stays answerable", async () => {
    const instance = "needs-input-restart";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);

    // Boot-time reconcile claims only running/queued orphans — a parked
    // question is durable state waiting on the user, exactly like
    // waiting_approval, so a restart must leave it untouched.
    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a parked question must not be re-dispatched");
      }
    });
    expect(reconciled.resumed).toEqual([]);
    expect(reconciled.failed).toEqual([]);
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");

    // The durable toolCallState still resumes after the "restart": a message
    // post answers the surviving question and completes the same task.
    stubAnswer(config, "Resumed after restart.");
    const answered = await submitChatMessage(config, sessionId, { content: "resume it" });
    expect(answered.taskId).toBe(taskId);
    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Resumed after restart.");
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("completed");
  });
});

// Simulate the crash window that wedges a park: the answer's persist
// completed (gate atomically claimed + human-readable outcome recorded —
// exactly what answerNeedsInputForMessage and the /complete handler do
// before their DETACHED safeResume) but the process died before the resume
// ran. The task stays parked on a gate that is already terminal.
async function wedgeAnsweredPark(config: RuntimeConfig, setupId: string, outcomeMessage: string): Promise<void> {
  await resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false });
  await persistConnectOutcome(config, setupId, { ok: true, message: outcomeMessage });
}

describe("wedged park recovery", () => {
  test("boot reconcile resumes a needs_input park whose answer persisted before a crash", async () => {
    const instance = "needs-input-wedge-boot";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);
    await wedgeAnsweredPark(config, setupId, "You answered: brave only");
    // The wedge: task still parked, its only gate already terminal.
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("completed");

    stubAnswer(config, "Resumed from the settled gate.");
    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a settled park resumes through the gate machinery, never re-dispatch");
      }
    });
    expect(reconciled.resumed).toEqual([taskId]);
    expect(reconciled.failed).toEqual([]);

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Resumed from the settled gate.");
    // The persisted answer rode the ask_user tool result into the loop.
    expect(
      listChatBlocks(config.instance, sessionId).some(
        (b) => b.kind === "tool_result" && b.preview.includes('User answered: "brave only"')
      )
    ).toBe(true);
  });

  test("boot reconcile resumes a waiting_approval park whose approval persisted before a crash", async () => {
    const instance = "needs-input-wedge-approval";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "",
      toolCalls: [
        {
          id: "call_write",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    const session = await mutateState(config.instance, (state) => createChatSession(state, "approval wedge session"));
    const submitted = await submitChatMessage(config, session.id, { content: "write it out" });
    await waitForTask(config, submitted.taskId, "waiting_approval");
    // Simulate: the approve decision persisted, the process died before the
    // approved action's result reached the loop.
    await mutateState(config.instance, (state) => {
      const row = state.authorizations.find((a) => a.taskId === submitted.taskId && a.status === "pending");
      if (!row) throw new Error("pending authorization not found");
      row.status = "approved";
      row.updatedAt = new Date().toISOString();
    });

    stubAnswer(config, "Continued after the restart.");
    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a settled park resumes through the gate machinery, never re-dispatch");
      }
    });
    expect(reconciled.resumed).toEqual([submitted.taskId]);
    const finished = await waitForTask(config, submitted.taskId, "completed");
    expect(finished.summary).toBe("Continued after the restart.");
    // The loop got an honest interrupted-result marker, not a fabricated
    // success for a side effect whose outcome the restart lost. (The block
    // preview truncates, so pin the marker's leading clause.)
    expect(
      listChatBlocks(config.instance, session.id).some(
        (b) => b.kind === "tool_result" && b.preview.includes("Approved, but the gateway restarted")
      )
    ).toBe(true);
  });

  test("a wedged approval with an execution audit row resumes with the executed result, never the hedge", async () => {
    const instance = "needs-input-wedge-executed";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "",
      toolCalls: [
        {
          id: "call_write",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    const session = await mutateState(config.instance, (state) => createChatSession(state, "executed wedge session"));
    const submitted = await submitChatMessage(config, session.id, { content: "write it out" });
    await waitForTask(config, submitted.taskId, "waiting_approval");
    // Simulate: approve persisted AND the executor ran — its audit row,
    // stamped with the approvalId at execution time, is the durable proof —
    // but the process died before the captured result reached the loop.
    await mutateState(config.instance, (state) => {
      const row = state.authorizations.find((a) => a.taskId === submitted.taskId && a.status === "pending");
      if (!row) throw new Error("pending authorization not found");
      row.status = "approved";
      row.updatedAt = new Date().toISOString();
      state.audit.push({
        id: "audit_exec_proof",
        instance: state.instance,
        at: new Date().toISOString(),
        actor: "runtime",
        action: "file.write",
        target: "out.txt",
        risk: "high",
        taskId: submitted.taskId,
        approvalId: row.id,
        evidence: { beforeBytes: 0, afterBytes: 5 }
      });
    });

    stubAnswer(config, "Continued from the proven execution.");
    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a settled park resumes through the gate machinery, never re-dispatch");
      }
    });
    expect(reconciled.resumed).toEqual([submitted.taskId]);
    const finished = await waitForTask(config, submitted.taskId, "completed");
    expect(finished.summary).toBe("Continued from the proven execution.");

    // The resumed model saw the executed marker with the audit evidence and
    // the do-not-re-run instruction — not the may-or-may-not hedge.
    const toolResults = getEchoToolCallingCalls()
      .flat()
      .filter((m) => m.role === "tool" && typeof m.content === "string")
      .map((m) => String(m.content));
    const executed = toolResults.find((content) =>
      content.includes("Approved and executed before the gateway restarted")
    );
    expect(executed).toBeDefined();
    expect(executed).toContain("Do NOT re-run this action");
    expect(executed).toContain("Executed: file.write — out.txt");
    expect(executed).toContain("0 bytes before, 5 bytes after");
    expect(toolResults.some((content) => content.includes("may or may not have executed"))).toBe(false);
  });

  test("two racing resumes of the same settled park write exactly one set of transcript rows and blocks", async () => {
    // Two settled-park heal entry points can kick resumeChatTask for the
    // same park concurrently. Both pass stage 1 (the result write is
    // idempotent), but the stage-2 park→running claim admits exactly one —
    // and the loser must bail BEFORE persisting transcript rows or emitting
    // tool_result blocks, or every double-kick duplicates the transcript.
    const instance = "needs-input-double-kick";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);
    await wedgeAnsweredPark(config, setupId, "You answered: brave only");

    stubAnswer(config, "Resumed exactly once.");
    const result = 'User answered: "brave only"';
    await Promise.all([
      resumeChatTask(config, taskId, "call_choice", result),
      resumeChatTask(config, taskId, "call_choice", result)
    ]);
    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Resumed exactly once.");

    const answerBlocks = listChatBlocks(config.instance, sessionId).filter(
      (b) => b.kind === "tool_result" && b.preview.includes("User answered:")
    );
    expect(answerBlocks.length).toBe(1);
    const transcriptRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.kind === "tool_transcript" && m.role === "tool"
    );
    expect(transcriptRows.length).toBe(1);
  });

  test("boot reconcile fails a park with zero pending gates and no resume snapshot", async () => {
    // The failure-path artifact shape: gates all terminal AND the snapshot
    // cleared by a prior failure path. The settled-park heal has nothing to
    // resume against and no gate resolution will ever arrive — the boot
    // reconcile must fail it honestly instead of leaving it wedged forever.
    const instance = "needs-input-wedge-artifact";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, setupId } = await parkOnAskUser(config);
    await wedgeAnsweredPark(config, setupId, "You answered: brave only");
    await mutateState(config.instance, (state) => {
      state.tasks.find((t) => t.id === taskId)!.toolCallState = undefined;
    });

    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a snapshot-less park has nothing to dispatch");
      }
    });
    expect(reconciled.resumed).toEqual([]);
    expect(reconciled.failed).toEqual([taskId]);
    const failed = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("no resume snapshot");
  });

  test("boot reconcile leaves a park with a PENDING gate and no snapshot untouched", async () => {
    // Only the gate-less shape is unrecoverable. A park still waiting on the
    // user keeps waiting, snapshot or not — /complete and message paths must
    // never find it failed.
    const instance = "needs-input-wedge-pending-no-snapshot";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId } = await parkOnAskUser(config);
    await mutateState(config.instance, (state) => {
      state.tasks.find((t) => t.id === taskId)!.toolCallState = undefined;
    });

    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a live park must not be touched");
      }
    });
    expect(reconciled.resumed).toEqual([]);
    expect(reconciled.failed).toEqual([]);
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");
  });

  test("boot reconcile still leaves a park with a PENDING gate untouched", async () => {
    // The wedge selector keys on "zero pending gates" — a live question
    // (pending chat.choice) parked before the restart is durable user-facing
    // state, exactly the case the park-survives-restart test above pins.
    const instance = "needs-input-wedge-live-park";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId } = await parkOnAskUser(config);

    const reconciled = await reconcileInFlightTasks(config, {
      cutoffIso: new Date(Date.now() + 60_000).toISOString(),
      dispatch: async () => {
        throw new Error("a live park must not be touched");
      }
    });
    expect(reconciled.resumed).toEqual([]);
    expect(reconciled.failed).toEqual([]);
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");
  });

  test("POST /complete on the settled question of a wedged park kicks the resume", async () => {
    const instance = "needs-input-wedge-complete";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, setupId } = await parkOnAskUser(config);
    await wedgeAnsweredPark(config, setupId, "You answered: brave only");

    stubAnswer(config, "Healed via complete.");
    const response = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ choice: { label: "Set up Brave only" } })
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: true });
    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Healed via complete.");

    // Once the task actually resumed, a further /complete is a plain
    // double-answer again: 410, no second resume.
    const again = await handler(
      new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ choice: { label: "Set up Brave only" } })
      })
    );
    expect(again.status).toBe(410);
  });

  test("a message into a wedged container kicks the resume and drains behind it", async () => {
    const instance = "needs-input-wedge-message";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const { taskId, sessionId, setupId } = await parkOnAskUser(config);
    await wedgeAnsweredPark(config, setupId, "You answered: brave only");

    // Hold the healed turn's model call briefly so the nudge deterministically
    // queues behind the resuming run instead of racing its completion.
    setEchoToolCallingResponse(
      {
        provider: normalizeProvider(config.provider),
        text: "Healed by the nudge.",
        toolCalls: [],
        finishReason: "stop"
      },
      undefined,
      { delayMs: 150 }
    );
    stubAnswer(config, "Follow-up drained.");
    const result = await submitChatMessageRaw(config, sessionId, { content: "hello?" });
    if (!("queued" in result)) throw new Error("expected the nudge to queue behind the healing run");

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Healed by the nudge.");

    // The queued nudge drains as its own follow-up turn once the healed run
    // settles — the wedge never eats the message.
    const deadline = Date.now() + 5000;
    for (;;) {
      const state = readState(config.instance);
      const tasks = state.tasks.filter((t) => t.chatSessionId === sessionId);
      const pending = state.chatSessions.find((s) => s.id === sessionId)?.pendingMessages?.length ?? 0;
      if (tasks.length === 2 && tasks.every((t) => t.status === "completed") && pending === 0) break;
      if (Date.now() > deadline) throw new Error("queued message did not drain after the healed run");
      await Bun.sleep(2);
    }
    expect(
      listChatBlocks(config.instance, sessionId).some((b) => b.kind === "user_text" && b.text === "hello?")
    ).toBe(true);
  });
});
