// Pins the derived-attention contract (state/attention.ts): attention is
// computed from persisted facts on read — never stored — with precedence
// needs_input > review > working > done_unacknowledged > none, and
// acknowledging a container clears done_unacknowledged. Also pins
// latestRunOutcome picking the NEWEST terminal run.
//
// Hermetic: in-memory states from createEmptyState (no disk I/O), env root
// scoped to this file so parallel test files can't collide.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState } from "./store";
import { buildContainerAttentionIndex, deriveContainerAttention, latestRunOutcome } from "./attention";
import { acknowledgeContainer, createAuthorization, createSetupRequest, createTask, createTopic } from "./records";
import type { RuntimeState, Task } from "../types";

const ROOT = "/tmp/gini-state-attention-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function seedTask(
  state: RuntimeState,
  sessionId: string,
  status: Task["status"],
  at: string,
  extra: Partial<Task> = {}
): Task {
  const task = createTask(state.instance, `run in ${sessionId}`, undefined, undefined, undefined, undefined, undefined, sessionId);
  task.status = status;
  task.updatedAt = at;
  Object.assign(task, extra);
  state.tasks.unshift(task);
  return task;
}

describe("deriveContainerAttention precedence", () => {
  test("no runs → none", () => {
    const state = createEmptyState("attn-none");
    const session = createTopic(state, { title: "Empty container" });
    expect(deriveContainerAttention(state, session)).toBe("none");
  });

  test("a live run with no pending gates → working", () => {
    const state = createEmptyState("attn-working");
    const session = createTopic(state, { title: "Busy container" });
    seedTask(state, session.id, "running", "2026-07-01T10:00:00.000Z");
    expect(deriveContainerAttention(state, session)).toBe("working");
  });

  test("a pending Authorization on a live run → review", () => {
    const state = createEmptyState("attn-review");
    const session = createTopic(state, { title: "Draft ready" });
    const task = seedTask(state, session.id, "waiting_approval", "2026-07-01T10:00:00.000Z");
    createAuthorization(state, {
      taskId: task.id,
      action: "messaging.send",
      target: "sarah@example.com",
      risk: "medium",
      reason: "Send the reply draft",
      payload: {}
    });
    expect(deriveContainerAttention(state, session)).toBe("review");
  });

  test("a pending chat.choice beats a pending Authorization (needs_input > review)", () => {
    const state = createEmptyState("attn-needs-input");
    const session = createTopic(state, { title: "Question pending" });
    const task = seedTask(state, session.id, "waiting_approval", "2026-07-01T10:00:00.000Z");
    createAuthorization(state, {
      taskId: task.id,
      action: "file.write",
      target: "/tmp/report.md",
      risk: "medium",
      reason: "Write the report",
      payload: {}
    });
    createSetupRequest(state, {
      taskId: task.id,
      action: "chat.choice",
      target: "Which venue?",
      reason: "Which venue?",
      payload: { question: "Which venue?", options: [{ label: "A" }, { label: "B" }], toolCallId: "call_1" }
    });
    expect(deriveContainerAttention(state, session)).toBe("needs_input");
  });

  test("the stored needs_input status derives needs_input without joining gate rows", () => {
    // The park stamps status "needs_input" directly; the gate-based
    // derivation above remains the fallback for the GINI_NEEDS_INPUT_STATUS=0
    // escape hatch (which parks the same gates under waiting_approval).
    const state = createEmptyState("attn-stored-status");
    const session = createTopic(state, { title: "Stored status" });
    seedTask(state, session.id, "needs_input", "2026-07-01T10:00:00.000Z", {
      needsInput: { question: "Which venue?", setupRequestId: "setup_x" }
    });
    expect(deriveContainerAttention(state, session)).toBe("needs_input");
  });

  test("a pending non-choice SetupRequest stays working (only chat.choice maps to needs_input)", () => {
    const state = createEmptyState("attn-confirm");
    const session = createTopic(state, { title: "Confirm pending" });
    const task = seedTask(state, session.id, "waiting_approval", "2026-07-01T10:00:00.000Z");
    createSetupRequest(state, {
      taskId: task.id,
      action: "confirmation.request",
      target: "Send it?",
      reason: "Send it?",
      payload: { summary: "Send it?", confirmLabel: "Send", toolCallId: "call_2" }
    });
    expect(deriveContainerAttention(state, session)).toBe("working");
  });

  test("pending gates on a terminal run never count", () => {
    const state = createEmptyState("attn-stale-gate");
    const session = createTopic(state, { title: "Stale gate" });
    const task = seedTask(state, session.id, "completed", "2026-07-01T10:00:00.000Z", { summary: "Done." });
    createAuthorization(state, {
      taskId: task.id,
      action: "terminal.exec",
      target: "rm -rf /tmp/x",
      risk: "high",
      reason: "Stale row",
      payload: {}
    });
    // The stale pending authorization doesn't derive review; the terminal
    // outcome (unacknowledged) drives the state instead.
    expect(deriveContainerAttention(state, session)).toBe("done_unacknowledged");
  });

  test("terminal outcome without acknowledgment → done_unacknowledged; acknowledge clears it to none", () => {
    const state = createEmptyState("attn-ack");
    const session = createTopic(state, { title: "Finished errand" });
    seedTask(state, session.id, "completed", "2026-07-01T10:00:00.000Z", { summary: "Booked." });
    expect(deriveContainerAttention(state, session)).toBe("done_unacknowledged");

    acknowledgeContainer(state, session.id);
    expect(deriveContainerAttention(state, session)).toBe("none");
  });

  test("a new outcome after acknowledgment re-surfaces done_unacknowledged", () => {
    const state = createEmptyState("attn-reack");
    const session = createTopic(state, { title: "Recurring errand" });
    seedTask(state, session.id, "completed", "2026-07-01T10:00:00.000Z", { summary: "First result." });
    acknowledgeContainer(state, session.id);
    expect(deriveContainerAttention(state, session)).toBe("none");

    // A later terminal run (newer than the acknowledge stamp) needs a fresh
    // acknowledgment.
    const later = new Date(Date.now() + 60_000).toISOString();
    seedTask(state, session.id, "completed", later, { summary: "Second result." });
    expect(deriveContainerAttention(state, session)).toBe("done_unacknowledged");
  });

  test("accepts a prebuilt index (the multi-session read path)", () => {
    const state = createEmptyState("attn-index");
    const working = createTopic(state, { title: "Working" });
    const idle = createTopic(state, { title: "Idle" });
    seedTask(state, working.id, "running", "2026-07-01T10:00:00.000Z");
    const index = buildContainerAttentionIndex(state);
    expect(deriveContainerAttention(state, working, index)).toBe("working");
    expect(deriveContainerAttention(state, idle, index)).toBe("none");
  });
});

describe("latestRunOutcome", () => {
  test("returns the newest terminal run with its summary/error", () => {
    const state = createEmptyState("attn-outcome");
    const session = createTopic(state, { title: "History" });
    seedTask(state, session.id, "completed", "2026-07-01T09:00:00.000Z", { summary: "Older." });
    const newest = seedTask(state, session.id, "failed", "2026-07-01T11:00:00.000Z", { error: "Provider exploded" });
    seedTask(state, session.id, "running", "2026-07-01T12:00:00.000Z");

    const outcome = latestRunOutcome(state, session);
    expect(outcome?.taskId).toBe(newest.id);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.error).toBe("Provider exploded");
    expect(outcome?.at).toBe("2026-07-01T11:00:00.000Z");
  });

  test("returns undefined when the container has no terminal runs", () => {
    const state = createEmptyState("attn-no-outcome");
    const session = createTopic(state, { title: "Only live" });
    seedTask(state, session.id, "running", "2026-07-01T10:00:00.000Z");
    expect(latestRunOutcome(state, session)).toBeUndefined();
  });
});
