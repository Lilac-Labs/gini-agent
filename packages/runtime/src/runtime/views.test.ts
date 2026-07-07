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
      // but it lives in the sidebar Messages section — never a task row.
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
});
