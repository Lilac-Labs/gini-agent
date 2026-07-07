// Pins the chat.choice /complete and /cancel contracts for the ask_user tool:
//   - { choice: { label } } with a stored option label resumes the paused chat
//     task with `User selected: "<label>"` (plus the option description) and
//     persists a truthful outcome for the resolved card.
//   - an unknown label or malformed body 400s BEFORE the claim, leaving the
//     row pending so the user can pick again.
//   - { choice: { other } } resumes with `User answered: "<text>"`.
//   - /cancel (the card's Skip affordance) resumes the loop with the skip
//     fallback instead of failing the task.
//
// Uses the echo provider with stubbed tool-calling responses so the paused
// task is a REAL chat-task loop pause (toolCallState snapshot included) and
// the /complete resume path runs end to end.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "./provider";
import { createHandler } from "./http";
import { submitChatMessage as submitChatMessageRaw } from "./execution/chat";
import { settleSubmittedChatMessage, type SettledDispatch } from "./execution/chat-test-support";
import { createChatSession, listChatBlocks, mutateState, readState } from "./state";
import type { RuntimeConfig, Task } from "./types";

// These tests submit on idle sessions, which always run immediately. Settle
// the echo-first ack into the dispatched turn and narrow to the run-now
// branch so the existing `.taskId` reads stay typed (a queued result here is
// a test-setup bug). See ADR chat-message-queue.md.
async function submitChatMessage(
  ...args: Parameters<typeof submitChatMessageRaw>
): Promise<Extract<SettledDispatch, { taskId: string }>> {
  const result = await submitChatMessageRaw(...args);
  const settled = await settleSubmittedChatMessage(
    args[0],
    args[1],
    result,
    String(args[2].content ?? "")
  );
  if ("queued" in settled) throw new Error("expected run-now submission, got queued");
  return settled;
}

const ROOT = "/tmp/gini-http-chat-choice-tests";

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterEach(() => {
  clearEchoToolCallingResponses();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
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
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach ${status} within ${timeoutMs}ms`);
}

// Drive a real chat turn that pauses on ask_user. Returns the paused task id,
// session id, and the pending chat.choice setup-request id.
async function pauseOnAskUser(
  config: RuntimeConfig
): Promise<{ taskId: string; sessionId: string; setupId: string }> {
  const toolArgs = {
    question: "How should I search the web?",
    options: [
      { label: "Set up Brave + Exa", description: "Best coverage" },
      { label: "Set up Brave only" },
      { label: "Neither — use web_fetch" }
    ]
  };
  const provider = normalizeProvider(config.provider);
  setEchoToolCallingResponse({
    provider,
    text: "",
    toolCalls: [
      {
        id: "call_choice",
        type: "function",
        function: {
          name: "ask_user",
          arguments: JSON.stringify(toolArgs)
        }
      }
    ],
    finishReason: "tool_calls"
  });
  const session = await mutateState(config.instance, (state) => createChatSession(state, "choice session"));
  const submitted = await submitChatMessage(config, session.id, { content: "find me fresh results" });
  // An all-chat.choice park is reclassified as needs_input.
  await waitForTask(config, submitted.taskId, "needs_input");
  const setup = readState(config.instance).setupRequests.find(
    (s) => s.taskId === submitted.taskId && s.action === "chat.choice"
  );
  if (!setup) throw new Error("chat.choice setup request not minted");
  return { taskId: submitted.taskId, sessionId: session.id, setupId: setup.id };
}

function completeRequest(config: RuntimeConfig, setupId: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body)
  });
}

describe("chat.choice /complete and /cancel", () => {
  test("a valid listed label resumes the task with the selection (description included)", async () => {
    const instance = "chat-choice-label";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await pauseOnAskUser(config);

    // Final model turn after the resume feeds the selection back.
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "Great — setting up Brave and Exa now.",
      toolCalls: [],
      finishReason: "stop"
    });

    const response = await handler(completeRequest(config, setupId, { choice: { label: "Set up Brave + Exa" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Great — setting up Brave and Exa now.");

    const blocks = listChatBlocks(config.instance, sessionId);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes('User selected: "Set up Brave + Exa" — Best coverage'))
    ).toBe(true);

    const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
    expect(setup?.status).toBe("completed");
    // Persisted outcome keeps the resolved card truthful after reload.
    expect(setup?.connectOutcome).toEqual({ ok: true, message: "You selected: Set up Brave + Exa" });
  });

  test("an unknown label 400s and leaves the row pending and the task paused", async () => {
    const instance = "chat-choice-unknown";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, setupId } = await pauseOnAskUser(config);

    const response = await handler(completeRequest(config, setupId, { choice: { label: "Not an option" } }));
    expect(response.status).toBe(400);

    const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
    expect(setup?.status).toBe("pending");
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");
  });

  test("a label against an option-less question 400s and the row stays answerable", async () => {
    const instance = "chat-choice-optionless-label";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    // Historical question-only park (the dispatcher now rejects option-less
    // ask_user calls, but rows minted before that persist): strip the stored
    // options so NO label can ever match — the free-text `other` is the only
    // remaining answer shape.
    const { taskId, setupId } = await pauseOnAskUser(config);
    await mutateState(config.instance, (state) => {
      const setup = state.setupRequests.find((s) => s.id === setupId);
      if (setup) setup.payload = { ...setup.payload, options: [] };
    });

    const response = await handler(completeRequest(config, setupId, { choice: { label: "X" } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("Unknown option label: X");
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("pending");
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("needs_input");

    // The row is still answerable through the card's free-text input.
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "Replying with a yes.",
      toolCalls: [],
      finishReason: "stop"
    });
    const other = await handler(completeRequest(config, setupId, { choice: { other: "Tell them yes" } }));
    expect(other.status).toBe(200);
    await waitForTask(config, taskId, "completed");
  });

  test("a malformed body 400s and leaves the row pending", async () => {
    const instance = "chat-choice-malformed";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { setupId } = await pauseOnAskUser(config);

    for (const body of [{}, { choice: "Set up Brave only" }, { choice: { other: "   " } }]) {
      const response = await handler(completeRequest(config, setupId, body));
      expect(response.status).toBe(400);
    }
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("pending");
  });

  test("a freeform other answer resumes the task with the typed text", async () => {
    const instance = "chat-choice-other";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await pauseOnAskUser(config);

    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "Got it, using DuckDuckGo.",
      toolCalls: [],
      finishReason: "stop"
    });

    const response = await handler(completeRequest(config, setupId, { choice: { other: "just use duckduckgo" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await waitForTask(config, taskId, "completed");
    const blocks = listChatBlocks(config.instance, sessionId);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes('User answered: "just use duckduckgo"'))
    ).toBe(true);
    const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
    expect(setup?.connectOutcome).toEqual({ ok: true, message: "You answered: just use duckduckgo" });
  });

  test("cancel (Skip) marks the row cancelled and resumes the task with the skip fallback", async () => {
    const instance = "chat-choice-skip";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await pauseOnAskUser(config);

    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "No problem — I'll pick the simplest path.",
      toolCalls: [],
      finishReason: "stop"
    });

    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` }
    }));
    expect(response.status).toBe(200);

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("No problem — I'll pick the simplest path.");
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("cancelled");

    const blocks = listChatBlocks(config.instance, sessionId);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes("User skipped the question"))
    ).toBe(true);
  });
});
