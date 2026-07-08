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

const ROOT = `/tmp/gini-chat-needs-input-tests-${import.meta.file}`;

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
