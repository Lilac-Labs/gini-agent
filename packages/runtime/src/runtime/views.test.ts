import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { createTask, createTopic, mutateState, readState } from "../state";
import { homeView, publicState } from "./views";

function testConfig(instance: string): RuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), `gini-views-${instance}-`));
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

describe("publicState", () => {
  test("filters tool_transcript chat messages and never exposes legacy pairing collections", async () => {
    const config = testConfig("views-public");
    // Touch state once so the instance exists on disk.
    await mutateState(config.instance, () => undefined);
    const snapshot = publicState(config) as Record<string, unknown>;
    // The pairing subsystem is gone (owner-token-only auth; see ADR
    // owner-token-auth.md): normalizeState sheds the legacy collections, so
    // none of them can reach the public view.
    expect("pairingRequests" in snapshot).toBe(false);
    expect("pairingCodes" in snapshot).toBe(false);
    expect("devices" in snapshot).toBe(false);
    // tool_transcript rows are internal — they never reach /api/state.
    const chatMessages = snapshot.chatMessages as Array<{ kind?: string }>;
    expect(chatMessages.every((m) => m.kind !== "tool_transcript")).toBe(true);
  });
});

// Minimal JobRecord for the routineJobId mapping — only identity, schedule,
// and the chatSessionId provenance under test matter here.
function seedJob(state: RuntimeState, id: string, chatSessionId: string | undefined, createdAt: string): void {
  state.jobs.push({
    id,
    instance: state.instance,
    name: id,
    prompt: "check things",
    status: "active",
    deliveryTargets: [],
    context: [],
    retryLimit: 0,
    timeoutSeconds: 60,
    intervalSeconds: 3600,
    ...(chatSessionId ? { chatSessionId } : {}),
    createdAt,
    updatedAt: createdAt,
    nextRunAt: createdAt,
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    runIds: []
  });
}

function seedTask(state: RuntimeState, sessionId: string, status: Task["status"], at: string): Task {
  const task = createTask(state.instance, `run in ${sessionId}`, undefined, undefined, undefined, undefined, undefined, sessionId);
  task.status = status;
  task.updatedAt = at;
  if (status === "completed") task.summary = "Done.";
  state.tasks.unshift(task);
  return task;
}

describe("homeView", () => {
  test("message-mode containers never become task rows; task/undefined startedAs still do; recents unaffected", async () => {
    const config = testConfig("views-home-messages");
    // Prime the instance (migration markers) BEFORE seeding, the way a booted
    // gateway does — otherwise the ack-seed pass would stamp the seeded
    // sessions acknowledged on the next read.
    readState(config.instance);
    const ids = await mutateState(config.instance, (state) => {
      // Message conversation parked on a question: needs_input attention,
      // but it lives in Home's Chats section — never a task row.
      const askingMessage = createTopic(state, { title: "hi", startedAs: "message" });
      seedTask(state, askingMessage.id, "needs_input", "2026-07-01T10:00:00.000Z");

      // Message conversation with a finished reply: done attention is also
      // excluded from tasks, but its completed run still feeds Recents.
      const doneMessage = createTopic(state, { title: "thanks", startedAs: "message" });
      seedTask(state, doneMessage.id, "completed", "2026-07-01T11:00:00.000Z");

      // Explicit task-mode and legacy (undefined startedAs) containers keep
      // their rows exactly as before.
      const taskMode = createTopic(state, { title: "Book the table", startedAs: "task" });
      seedTask(state, taskMode.id, "needs_input", "2026-07-01T12:00:00.000Z");
      const legacy = createTopic(state, { title: "Old errand" });
      seedTask(state, legacy.id, "completed", "2026-07-01T09:00:00.000Z");

      return {
        askingMessage: askingMessage.id,
        doneMessage: doneMessage.id,
        taskMode: taskMode.id,
        legacy: legacy.id
      };
    });

    const home = homeView(config);
    expect(home.tasks.map((t) => t.id)).toEqual([ids.taskMode, ids.legacy]);
    // Recents are the artifact feed — message-mode completions stay in it.
    expect(home.recents.map((r) => r.containerId)).toEqual([ids.doneMessage, ids.legacy]);
  });

  test("stamps routineJobId when a job was created from the conversation — newest wins; other rows omit it", async () => {
    const config = testConfig("views-home-routine");
    readState(config.instance);
    const ids = await mutateState(config.instance, (state) => {
      // Two jobs point at the same conversation (e.g. the user re-created the
      // routine in the same thread) — the newest by createdAt wins.
      const withRoutine = createTopic(state, { title: "HN mentions", startedAs: "task" });
      seedTask(state, withRoutine.id, "completed", "2026-07-01T12:00:00.000Z");
      seedJob(state, "job_old", withRoutine.id, "2026-07-01T10:00:00.000Z");
      seedJob(state, "job_new", withRoutine.id, "2026-07-01T11:00:00.000Z");

      // A row without a matching job, plus a job with no chatSessionId
      // (imperative/CLI creation) that must map to no row at all.
      const plain = createTopic(state, { title: "No routine here", startedAs: "task" });
      seedTask(state, plain.id, "completed", "2026-07-01T09:00:00.000Z");
      seedJob(state, "job_unbound", undefined, "2026-07-01T08:00:00.000Z");

      return { withRoutine: withRoutine.id, plain: plain.id };
    });

    const home = homeView(config);
    const withRoutine = home.tasks.find((t) => t.id === ids.withRoutine);
    const plain = home.tasks.find((t) => t.id === ids.plain);
    expect(withRoutine?.routineJobId).toBe("job_new");
    expect(plain).toBeDefined();
    expect(plain?.routineJobId).toBeUndefined();
  });

  test("acknowledged completions move to done; unacknowledged stay task rows; acknowledged failures vanish", async () => {
    const config = testConfig("views-home-done");
    readState(config.instance);
    const ids = await mutateState(config.instance, (state) => {
      // Completed and acknowledged after the outcome → a Done row carrying
      // the outcome's timestamp and summary first line.
      const acked = createTopic(state, { title: "Ship the report", startedAs: "task" });
      seedTask(state, acked.id, "completed", "2026-07-01T10:00:00.000Z");
      acked.acknowledgedAt = "2026-07-01T10:05:00.000Z";

      // Completed but never acknowledged → still a done_unacknowledged task
      // row, never a Done row.
      const unacked = createTopic(state, { title: "Book flights", startedAs: "task" });
      seedTask(state, unacked.id, "completed", "2026-07-01T11:00:00.000Z");

      // Failed and acknowledged → neither list (Done shows only successes).
      const failedAcked = createTopic(state, { title: "Broken errand", startedAs: "task" });
      seedTask(state, failedAcked.id, "failed", "2026-07-01T09:00:00.000Z");
      failedAcked.acknowledgedAt = "2026-07-01T09:05:00.000Z";

      return { acked: acked.id, unacked: unacked.id, failedAcked: failedAcked.id };
    });

    const home = homeView(config);
    expect(home.tasks.map((t) => t.id)).toEqual([ids.unacked]);
    expect(home.tasks[0]?.attention).toBe("done_unacknowledged");
    expect(home.done.map((d) => d.id)).toEqual([ids.acked]);
    expect(home.done[0]?.completedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(home.done[0]?.outcomeLine).toBe("Done.");
  });

  test("done sorts by completedAt desc and caps at 10", async () => {
    const config = testConfig("views-home-done-cap");
    readState(config.instance);
    await mutateState(config.instance, (state) => {
      for (let hour = 0; hour <= 10; hour++) {
        const topic = createTopic(state, { title: `Errand ${hour}`, startedAs: "task" });
        seedTask(state, topic.id, "completed", `2026-07-01T${String(hour).padStart(2, "0")}:00:00.000Z`);
        topic.acknowledgedAt = "2026-07-02T00:00:00.000Z";
      }
    });

    const home = homeView(config);
    expect(home.done).toHaveLength(10);
    // Newest first; the cap drops the oldest completion (hour 00).
    expect(home.done[0]?.completedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(home.done[9]?.completedAt).toBe("2026-07-01T01:00:00.000Z");
    const stamps = home.done.map((d) => d.completedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});
