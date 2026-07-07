// Container-aware ask_user framing in the system prompt
// (TASK_CONTAINER_HANDOFF_BLOCK). A run inside a surfaced task container
// (kind "topic"/"channel", non-headless) executes handed-off work the user
// tracks from home rows, so its prompt carries the handoff line steering
// input needs toward ask_user — including non-headless job channels
// (ask_user is available there and the user isn't watching the thread). The
// root agent Chat (the user IS in the thread), headless channels (no user
// surface; ask_user is excluded there), and subagent runs (override prompt
// path — even inside a topic-kind spawn_task child container) must NOT
// carry it.

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
import { TASK_CONTAINER_HANDOFF_BLOCK } from "../system-prompt";
import { submitChatMessage } from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";
import { dispatchToolCall } from "./tool-dispatch";
import { createChatSession, createTopic, mutateState, readState } from "../state";
import type { RuntimeConfig, RuntimeState, Task } from "../types";

const ROOT = "/tmp/gini-chat-container-context-tests";

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterEach(() => {
  clearEchoToolCallingResponses();
  clearEchoStructuredResponses();
});

afterAll(() => {
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

async function waitForCompleted(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (task?.status === "completed") return task;
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`);
}

function stubTurn(config: RuntimeConfig): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text: "Done.",
    toolCalls: [],
    finishReason: "stop"
  });
}

function firstSystemContent(): string {
  const calls = getEchoToolCallingCalls();
  expect(calls.length).toBeGreaterThan(0);
  return String(calls[0]!.find((m) => m.role === "system")?.content ?? "");
}

// Insert a synthetic running task bound to `chatSessionId` — the spawning
// run a spawn_task dispatch acts on behalf of (mirrors spawn-task.test.ts).
function insertRunningTask(state: RuntimeState, id: string, chatSessionId: string): void {
  state.tasks.unshift({
    id,
    title: "spawning run",
    input: "",
    status: "running",
    instance: state.instance,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tracePath: "",
    auditIds: [],
    approvalIds: [],
    skillIds: [],
    mode: "chat",
    chatSessionId
  });
  const session = state.chatSessions.find((s) => s.id === chatSessionId);
  if (session && !session.taskIds.includes(id)) session.taskIds.push(id);
}

describe("task-container handoff framing", () => {
  test("a topic-kind container run carries the handoff line", async () => {
    const instance = "container-context-topic";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const topicId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return createTopic(state, { title: "Book a table", parentChatSessionId: chat.id }).id;
    });

    stubTurn(config);
    const submitted = await submitChatMessage(config, topicId, { content: "book a dinner reservation" });
    if (!("taskId" in submitted)) throw new Error("expected a run-now submission");
    await waitForCompleted(config, submitted.taskId);
    expect(firstSystemContent()).toContain(TASK_CONTAINER_HANDOFF_BLOCK);
  });

  test("the root agent Chat does NOT carry the handoff line", async () => {
    const instance = "container-context-agent";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const chatId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Messages", undefined, undefined, undefined, "agent").id
    );

    // Keep the message in the Chat itself: a kind:"agent" submit consults the
    // router first, and a topic decision would move the run into a container.
    // The echo-first accepted ack resolves before the verdict, so settle to
    // the dispatched run before inspecting the captured prompt.
    setEchoStructuredResponse("chat-route", { decision: "chat" });
    stubTurn(config);
    const accepted = await submitChatMessage(config, chatId, { content: "book a dinner reservation" });
    const submitted = await settleSubmittedChatMessage(config, chatId, accepted, "book a dinner reservation");
    if (!("taskId" in submitted)) throw new Error("expected a run-now submission");
    await waitForCompleted(config, submitted.taskId);
    expect(firstSystemContent()).not.toContain(TASK_CONTAINER_HANDOFF_BLOCK);
  });

  test("a spawn_task child run (subagent context) does NOT carry the handoff line", async () => {
    const instance = "container-context-spawn-child";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const spawningTaskId = "task_spawner";
    await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const parent = createTopic(state, {
        agentId: chat.agentId,
        title: "Inbox watch",
        parentChatSessionId: chat.id
      });
      insertRunningTask(state, spawningTaskId, parent.id);
    });

    stubTurn(config);
    const dispatched = await dispatchToolCall(
      config,
      spawningTaskId,
      "spawn_task",
      "call_spawn",
      JSON.stringify({ title: "Draft reply to Sam", prompt: "Draft a reply to Sam's email." })
    );
    if (dispatched.kind !== "sync") throw new Error(`expected a sync spawn_task result, got ${dispatched.kind}`);
    const payload = JSON.parse(dispatched.result);
    expect(payload.status).toBe("completed");
    // The child container IS a non-headless topic — the shape the handoff
    // line targets — so only the subagent override-prompt context suppresses
    // it here.
    const child = readState(config.instance).chatSessions.find((s) => s.id === payload.containerId)!;
    expect(child.kind).toBe("topic");
    expect(child.headless).not.toBe(true);
    expect(firstSystemContent()).not.toContain(TASK_CONTAINER_HANDOFF_BLOCK);
  });

  test("a non-headless job channel DOES carry the handoff line", async () => {
    // ask_user is available in a non-headless channel and the user tracks it
    // from home rows, not the thread — the handoff framing applies.
    const instance = "container-context-job-channel";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const channelId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Email watch", undefined, undefined, "job", "channel").id
    );

    stubTurn(config);
    const submitted = await submitChatMessage(config, channelId, { content: "check the feed" });
    if (!("taskId" in submitted)) throw new Error("expected a run-now submission");
    await waitForCompleted(config, submitted.taskId);
    expect(firstSystemContent()).toContain(TASK_CONTAINER_HANDOFF_BLOCK);
  });

  test("a headless channel does NOT carry the handoff line", async () => {
    const instance = "container-context-headless";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    const config = buildConfig(instance);
    const channelId = await mutateState(config.instance, (state) => {
      const channel = createChatSession(state, "Silent watch", undefined, undefined, "job", "channel");
      channel.headless = true;
      return channel.id;
    });

    stubTurn(config);
    const submitted = await submitChatMessage(config, channelId, { content: "check the feed" });
    if (!("taskId" in submitted)) throw new Error("expected a run-now submission");
    await waitForCompleted(config, submitted.taskId);
    expect(firstSystemContent()).not.toContain(TASK_CONTAINER_HANDOFF_BLOCK);
  });
});
