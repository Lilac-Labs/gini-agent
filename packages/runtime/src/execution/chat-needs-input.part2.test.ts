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
