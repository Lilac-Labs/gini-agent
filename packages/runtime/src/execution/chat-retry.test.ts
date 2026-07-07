// POST /api/containers/:id/retry — the home Retry affordance. The server
// looks up the container's newest failed run and re-submits its ORIGINAL
// input as a fresh message through the submitChatMessage machinery (clients
// never carry the input; see retryFailedContainerRun in execution/chat.ts).
// Pins: the minted run's input equals the failed run's input (image
// attachments included), 409 while a run is in flight or a backlog is queued
// (the just-queued retry entry withdrawn), 404 for an unknown container,
// 400 when the newest terminal outcome isn't a failure, and 400 for the
// agent's root Chat (retry targets task containers only).
//
// Harness mirrors chat-supersede.test.ts: the echo provider makes the agent
// loop deterministic, HOME points at a mkdtemp dir so the machine-global
// Google account registry can't leak in, and each test uses a unique
// instance so per-instance state can't bleed across reruns.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clearEchoToolCallingResponses, normalizeProvider, setEchoToolCallingResponse } from "../provider";
import { createHandler } from "../http";
import { createChatSession, createTopic, mutateState, readState } from "../state";
import { storeUpload } from "../state/uploads";
import type { RuntimeConfig, Task } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
let prevState: string | undefined;
let prevLog: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-retry-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  root = mkdtempSync(join(tmpdir(), "gini-retry-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  clearEchoToolCallingResponses();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-logs`, { recursive: true, force: true });
  clearEchoToolCallingResponses();
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7347,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

async function callRetry(config: RuntimeConfig, containerId: string): Promise<Response> {
  const handler = createHandler(config);
  return handler(
    new Request(`http://127.0.0.1:${config.port}/api/containers/${containerId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }
    })
  );
}

function stubAnswer(config: RuntimeConfig, text: string): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text,
    toolCalls: [],
    finishReason: "stop"
  });
}

// Seed a terminal (or live) run directly on the container — no agent loop —
// so retry preconditions can be pinned deterministically.
async function seedTask(
  config: RuntimeConfig,
  sessionId: string,
  status: Task["status"],
  extra: Partial<Task> = {}
): Promise<string> {
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
      chatSessionId: sessionId,
      ...extra
    };
    state.tasks.push(task);
    const session = state.chatSessions.find((s) => s.id === sessionId);
    if (session) session.taskIds.push(taskId);
  });
  return taskId;
}

describe("POST /api/containers/:id/retry", () => {
  test("mints a new run from the failed run's original input", async () => {
    const config = buildConfig(`retry-ok-${basename(root)}`);
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Book the flight" }).id
    );
    const failedTaskId = await seedTask(config, containerId, "failed", {
      input: "Book me a flight to Lisbon on Friday",
      error: "Browser session expired"
    });

    stubAnswer(config, "Booked it this time.");
    const response = await callRetry(config, containerId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { taskId: string; status: string };
    expect(body.taskId).toBeString();
    expect(body.taskId).not.toBe(failedTaskId);
    expect(body.status).toBeString();

    const state = readState(config.instance);
    const minted = state.tasks.find((t) => t.id === body.taskId);
    expect(minted?.chatSessionId).toBe(containerId);
    // The retry re-runs the ORIGINAL failed input — the server looked it up.
    expect(minted?.input).toBe("Book me a flight to Lisbon on Friday");
    // The user gesture lands in the event feed like acknowledge does.
    expect(state.events.some((e) => e.action === "chat.session.retried" && e.target === containerId)).toBe(true);
  });

  test("the retried run carries the failed run's image attachments", async () => {
    const config = buildConfig(`retry-images-${basename(root)}`);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3, 4]), "image/png", "receipt.png");
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Expense the receipt" }).id
    );
    await seedTask(config, containerId, "failed", {
      input: "File this receipt",
      images: [ref]
    });

    stubAnswer(config, "Filed.");
    const response = await callRetry(config, containerId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { taskId: string };
    const minted = readState(config.instance).tasks.find((t) => t.id === body.taskId);
    // The retry is faithful to the original submission: the failed run's
    // image refs ride along with its input.
    expect(minted?.images).toEqual([ref]);
  });

  test("400 for the agent's root Chat — retry targets task containers only", async () => {
    const config = buildConfig(`retry-agent-chat-${basename(root)}`);
    const chatId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Root chat", undefined, undefined, undefined, "agent").id
    );
    // Even with a retryable failure on the session, the kind guard rejects
    // first — a Chat submission would pass through intake routing and mint
    // against a different session.
    await seedTask(config, chatId, "failed", { input: "original ask" });

    const response = await callRetry(config, chatId);
    expect(response.status).toBe(400);
    // No new run was minted alongside the seeded failure.
    expect(readState(config.instance).tasks.filter((t) => t.chatSessionId === chatId).length).toBe(1);
  });

  test("409 while a run is in flight", async () => {
    const config = buildConfig(`retry-live-${basename(root)}`);
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Busy container" }).id
    );
    await seedTask(config, containerId, "failed", { input: "original ask" });
    await seedTask(config, containerId, "running");

    const response = await callRetry(config, containerId);
    expect(response.status).toBe(409);
    // No new run was minted alongside the two seeded ones.
    expect(readState(config.instance).tasks.filter((t) => t.chatSessionId === containerId).length).toBe(2);
  });

  test("409 when the queue holds a backlog — the just-queued retry entry is withdrawn", async () => {
    const config = buildConfig(`retry-backlog-${basename(root)}`);
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Backlogged container" }).id
    );
    await seedTask(config, containerId, "failed", { input: "original ask" });
    // A non-empty queue with ZERO live tasks: the retry passes the in-flight
    // guard, submitChatMessage queues behind the backlog, and the withdraw
    // branch must remove exactly the entry the retry just queued.
    const backlog = { id: "pending_pre", content: "earlier follow-up", createdAt: new Date().toISOString() };
    await mutateState(config.instance, (state) => {
      const session = state.chatSessions.find((s) => s.id === containerId);
      if (session) session.pendingMessages = [backlog];
    });

    const response = await callRetry(config, containerId);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    // The conflict message covers the real cause — a queued backlog, not
    // necessarily a live run.
    expect(body.error).toContain("queued backlog");
    const after = readState(config.instance);
    // The queue is exactly the pre-call backlog: the retry's entry withdrawn.
    expect(after.chatSessions.find((s) => s.id === containerId)?.pendingMessages).toEqual([backlog]);
    // No new run was minted alongside the seeded failure.
    expect(after.tasks.filter((t) => t.chatSessionId === containerId).length).toBe(1);
  });

  test("404 for an unknown container", async () => {
    const config = buildConfig(`retry-404-${basename(root)}`);
    const response = await callRetry(config, "chat_missing");
    expect(response.status).toBe(404);
  });

  test("400 when the newest terminal outcome isn't a failure", async () => {
    const config = buildConfig(`retry-not-failed-${basename(root)}`);
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Finished fine" }).id
    );
    // An older failure superseded by a newer completed outcome: nothing to
    // retry — the newest outcome wins.
    await seedTask(config, containerId, "failed", {
      input: "first try",
      updatedAt: "2026-07-01T09:00:00.000Z"
    });
    await seedTask(config, containerId, "completed", {
      summary: "Done.",
      updatedAt: "2026-07-01T10:00:00.000Z"
    });

    const response = await callRetry(config, containerId);
    expect(response.status).toBe(400);
    expect(readState(config.instance).tasks.filter((t) => t.chatSessionId === containerId).length).toBe(2);
  });
});
