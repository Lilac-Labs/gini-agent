// Pins the confirmation.request /complete and /cancel contracts for the
// request_confirmation tool:
//   - request_confirmation mints a pending confirmation.request SetupRequest
//     and PAUSES the task even when approvalMode is "yolo" (SetupRequests are
//     user-actor and never flow through resolveApprovalPolicy, so yolo can't
//     bypass them).
//   - /complete (Confirm) resumes the paused chat task with the tool result
//     { confirmed: true } and persists a truthful "Confirmed" outcome.
//   - /cancel (Cancel) resumes the loop with { confirmed: false } instead of
//     failing the task.
//
// Uses the echo provider with stubbed tool-calling responses so the paused
// task is a REAL chat-task loop pause (toolCallState snapshot included) and
// the resume path runs end to end. See docs/adr/user-confirmation-primitive.md.

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

const ROOT = "/tmp/gini-http-confirmation-tests";

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

// approvalMode "yolo" on purpose: a confirmation.request must still pause the
// task, proving the SetupRequest path is immune to the auto-approve bypass.
function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7341,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`,
    approvalMode: "yolo"
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

// Drive a real chat turn that pauses on request_confirmation. Returns the
// paused task id, session id, and the pending confirmation.request id.
async function pauseOnConfirmation(config: RuntimeConfig): Promise<{ taskId: string; sessionId: string; setupId: string }> {
  const provider = normalizeProvider(config.provider);
  setEchoToolCallingResponse({
    provider,
    text: "",
    toolCalls: [
      {
        id: "call_confirm",
        type: "function",
        function: {
          name: "request_confirmation",
          arguments: JSON.stringify({
            summary: "Send this reply to Dana in the project thread",
            details: "Hi Dana — looks great, ship it.",
            confirmLabel: "Send"
          })
        }
      }
    ],
    finishReason: "tool_calls"
  });
  const session = await mutateState(config.instance, (state) => createChatSession(state, "confirm session"));
  const submitted = await submitChatMessage(config, session.id, { content: "reply to Dana and tell her it's good to go" });
  await waitForTask(config, submitted.taskId, "waiting_approval");
  const setup = readState(config.instance).setupRequests.find(
    (s) => s.taskId === submitted.taskId && s.action === "confirmation.request"
  );
  if (!setup) throw new Error("confirmation.request setup request not minted");
  return { taskId: submitted.taskId, sessionId: session.id, setupId: setup.id };
}

function postRequest(config: RuntimeConfig, setupId: string, suffix: "complete" | "cancel", body?: unknown): Request {
  return new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${setupId}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

describe("confirmation.request /complete and /cancel", () => {
  test("request_confirmation pauses the task even under approvalMode yolo", async () => {
    const instance = "confirmation-pauses-yolo";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    createHandler(config);
    const { taskId, setupId } = await pauseOnConfirmation(config);

    // The task is parked waiting on the user despite yolo, and the row carries
    // the consent content the agent asked the user to approve.
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.status).toBe("waiting_approval");
    const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
    expect(setup?.action).toBe("confirmation.request");
    expect(setup?.status).toBe("pending");
    expect(setup?.target).toBe("Send this reply to Dana in the project thread");
    expect(setup?.payload.details).toBe("Hi Dana — looks great, ship it.");
    expect(setup?.payload.confirmLabel).toBe("Send");
  });

  test("Confirm resumes the task with the tool result { confirmed: true }", async () => {
    const instance = "confirmation-confirm";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await pauseOnConfirmation(config);

    // Final model turn after the resume sees the confirmation and "sends".
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "Sent the reply to Dana.",
      toolCalls: [],
      finishReason: "stop"
    });

    const response = await handler(postRequest(config, setupId, "complete", {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Sent the reply to Dana.");

    // The model receives an unambiguous boolean, not a prose/skip string.
    const blocks = listChatBlocks(config.instance, sessionId);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes('"confirmed":true'))
    ).toBe(true);

    const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
    expect(setup?.status).toBe("completed");
    // Persisted outcome keeps the resolved card truthful after reload.
    expect(setup?.connectOutcome).toEqual({ ok: true, message: "Confirmed" });
  });

  test("Cancel resumes the task with the tool result { confirmed: false } and does NOT fail it", async () => {
    const instance = "confirmation-cancel";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const handler = createHandler(config);
    const { taskId, sessionId, setupId } = await pauseOnConfirmation(config);

    // After a decline the agent holds off and asks what to change.
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "Okay, I won't send it. What would you like to change?",
      toolCalls: [],
      finishReason: "stop"
    });

    const response = await handler(postRequest(config, setupId, "cancel"));
    expect(response.status).toBe(200);

    const finished = await waitForTask(config, taskId, "completed");
    expect(finished.summary).toBe("Okay, I won't send it. What would you like to change?");
    // Cancel must NOT fail the task.
    expect(finished.status).toBe("completed");
    expect(readState(config.instance).setupRequests.find((s) => s.id === setupId)?.status).toBe("cancelled");

    const blocks = listChatBlocks(config.instance, sessionId);
    expect(
      blocks.some((b) => b.kind === "tool_result" && b.preview.includes('"confirmed":false'))
    ).toBe(true);
  });
});
