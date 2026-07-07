// Tests for the echo-first instant ack on the routed chat submit path (ADR
// chat-message-queue.md, HTTP contract; ADR chat-topics-tasks-subagents.md,
// Routing). A message posted in a kind:"agent" session resolves the POST with
// { sessionId, accepted, blockId } BEFORE the routing verdict: the user's
// bubble (a render-only user_text echo) is durable immediately, and the
// verdict later binds it to a chat-direct turn, leaves it as the Chat echo of
// a topic turn, or threads it through the pending queue.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import {
  createChatSession,
  createTopic,
  deleteChatBlock,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import {
  deleteChat,
  dispatchNextPendingChatMessage,
  removePendingChatMessageById,
  submitChatMessage
} from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";
import type { RuntimeConfig, Task } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
let workspaceRoot: string;
let prevState: string | undefined;
let prevLog: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-chat-accept-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  root = mkdtempSync(join(tmpdir(), "gini-chat-accept-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-accept-ws-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  clearEchoToolCallingResponses();
  clearEchoStructuredResponses();
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
  rmSync(workspaceRoot, { recursive: true, force: true });
  clearEchoToolCallingResponses();
  clearEchoStructuredResponses();
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7342,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: root,
    logRoot: `${root}-logs`,
    approvalMode: "strict"
  };
}

// Routing (and therefore the echo-first ack) fires only for kind:"agent"
// sessions — the user's canonical Chat — so create one explicitly.
async function createAgentChat(config: RuntimeConfig, title: string): Promise<string> {
  return mutateState(config.instance, (state) => {
    return createChatSession(state, title, undefined, undefined, undefined, "agent").id;
  });
}

function stubTurn(config: RuntimeConfig): void {
  setEchoToolCallingResponse({
    provider: normalizeProvider(config.provider),
    text: "ok",
    toolCalls: [],
    finishReason: "stop"
  });
}

async function seedInFlightTask(config: RuntimeConfig, sessionId: string): Promise<string> {
  const taskId = `task_inflight_${Math.random().toString(36).slice(2, 8)}`;
  await mutateState(config.instance, (state) => {
    const task: Task = {
      id: taskId,
      title: "in flight",
      input: "busy",
      status: "running",
      instance: state.instance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: [],
      chatSessionId: sessionId
    };
    state.tasks.push(task);
    const session = state.chatSessions.find((s) => s.id === sessionId);
    if (session) session.taskIds.push(taskId);
  });
  return taskId;
}

async function settleTask(config: RuntimeConfig, taskId: string, status: Task["status"]): Promise<void> {
  await mutateState(config.instance, (state) => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = status;
      task.updatedAt = new Date().toISOString();
    }
  });
}

function userTextBlocks(config: RuntimeConfig, sessionId: string, text: string) {
  return listChatBlocks(config.instance, sessionId).filter(
    (b) => b.kind === "user_text" && b.text === text
  );
}

describe("echo-first instant ack", () => {
  test("returns accepted + blockId and renders the echo before the verdict lands", async () => {
    // A local server that never responds keeps the routing verdict pending, so
    // the pre-verdict window is observable instead of a race. The tiny
    // routeTimeoutMs then degrades routing to chat-direct.
    const hang = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {})
    });
    process.env.CHAT_ACCEPT_TEST_KEY = "test-key";
    const config: RuntimeConfig = {
      ...buildConfig("chat-accept-window"),
      provider: {
        name: "openai",
        model: "test",
        baseUrl: `http://127.0.0.1:${hang.port}/v1`,
        apiKeyEnv: "CHAT_ACCEPT_TEST_KEY"
      }
    };
    try {
      const chatId = await createAgentChat(config, "window");
      const result = await submitChatMessage(
        config,
        chatId,
        { content: "hello there" },
        { routeTimeoutMs: 120 }
      );
      if (!("accepted" in result)) throw new Error("expected the accepted ack shape");
      expect(result.sessionId).toBe(chatId);
      expect(result.accepted).toBe(true);
      expect(result.blockId).toBeString();

      // The echo is durable and render-only right now — no task exists yet
      // because the verdict is still hanging.
      const echo = listChatBlocks(config.instance, chatId).find((b) => b.id === result.blockId);
      expect(echo?.kind).toBe("user_text");
      expect(echo?.taskId).toBeUndefined();
      expect(readState(config.instance).tasks).toHaveLength(0);

      // After the verdict times out, routing degrades to chat-direct and the
      // echo binds to the dispatched turn.
      const settled = await settleSubmittedChatMessage(config, chatId, result, "hello there");
      if (!("taskId" in settled)) throw new Error("expected a dispatched turn");
      const bound = listChatBlocks(config.instance, chatId).find((b) => b.id === result.blockId);
      expect(bound?.taskId).toBe(settled.taskId);
      // Exactly one bubble for the message — bound in place, not re-inserted.
      expect(userTextBlocks(config, chatId, "hello there")).toHaveLength(1);
    } finally {
      hang.stop(true);
      delete process.env.CHAT_ACCEPT_TEST_KEY;
    }
  });

  test("a router failure degrades to a chat-direct dispatch instead of losing the message", async () => {
    // An openai provider whose key env is unset makes routeChatMessage reject
    // immediately — the accepted message must still dispatch as a chat turn.
    const config: RuntimeConfig = {
      ...buildConfig("chat-accept-router-fail"),
      provider: {
        name: "openai",
        model: "test",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnv: "CHAT_ACCEPT_TEST_KEY_UNSET"
      }
    };
    const chatId = await createAgentChat(config, "router-fail");
    const result = await submitChatMessage(config, chatId, { content: "still goes through" });
    const settled = await settleSubmittedChatMessage(
      config,
      chatId,
      result,
      "still goes through"
    );
    if (!("taskId" in settled)) throw new Error("expected a dispatched turn");
    if ("topicId" in settled) throw new Error("expected a chat-direct dispatch");
    expect(settled.sessionId).toBe(chatId);
    // No topic was minted on the failure fallback.
    expect(readState(config.instance).chatSessions.filter((s) => s.kind === "topic")).toHaveLength(0);
  });

  test("a topic verdict leaves exactly one render-only echo in Chat (no duplicate bubble)", async () => {
    const config = buildConfig("chat-accept-topic");
    stubTurn(config);
    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Trip" });
    const chatId = await createAgentChat(config, "topic");

    const result = await submitChatMessage(config, chatId, { content: "plan a big trip" });
    const settled = await settleSubmittedChatMessage(config, chatId, result, "plan a big trip");
    if (!("topicId" in settled) || !("taskId" in settled)) {
      throw new Error("expected a topic dispatch");
    }

    // Chat keeps ONE echo, still render-only (the turn belongs to the topic).
    const chatEchoes = userTextBlocks(config, chatId, "plan a big trip");
    expect(chatEchoes).toHaveLength(1);
    expect(chatEchoes[0]!.taskId).toBeUndefined();
    // The topic carries the task-bearing user row.
    const topicRows = userTextBlocks(config, settled.topicId, "plan a big trip");
    expect(topicRows).toHaveLength(1);
    expect(topicRows[0]!.taskId).toBe(settled.taskId);
  });

  test("a queued message carries its echoBlockId, and removal deletes the bubble", async () => {
    const config = buildConfig("chat-accept-queued-remove");
    const chatId = await createAgentChat(config, "queued");
    await seedInFlightTask(config, chatId);

    const result = await submitChatMessage(config, chatId, { content: "wait your turn" });
    if (!("accepted" in result)) throw new Error("expected the accepted ack shape");
    const settled = await settleSubmittedChatMessage(config, chatId, result, "wait your turn");
    if (!("queued" in settled)) throw new Error("expected a queued dispatch");

    const pending = readState(config.instance)
      .chatSessions.find((s) => s.id === chatId)
      ?.pendingMessages?.find((p) => p.id === settled.pendingId);
    expect(pending?.echoBlockId).toBe(result.blockId!);

    // Dequeuing the message removes its bubble too — a message that will
    // never run must not linger in the transcript.
    const removed = await removePendingChatMessageById(config, chatId, settled.pendingId);
    expect(removed).toBe(true);
    expect(listChatBlocks(config.instance, chatId).some((b) => b.id === result.blockId)).toBe(false);
  });

  test("draining a queued message binds the existing echo instead of inserting a duplicate", async () => {
    const config = buildConfig("chat-accept-drain");
    stubTurn(config);
    const chatId = await createAgentChat(config, "drain");
    const inFlight = await seedInFlightTask(config, chatId);

    const result = await submitChatMessage(config, chatId, { content: "queued then drained" });
    if (!("accepted" in result)) throw new Error("expected the accepted ack shape");
    const settled = await settleSubmittedChatMessage(config, chatId, result, "queued then drained");
    if (!("queued" in settled)) throw new Error("expected a queued dispatch");

    await settleTask(config, inFlight, "completed");
    await dispatchNextPendingChatMessage(config, chatId);

    const bubbles = userTextBlocks(config, chatId, "queued then drained");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.id).toBe(result.blockId!);
    expect(bubbles[0]!.taskId).toBeString();
  });

  test("draining falls back to a fresh insert when the echo block vanished", async () => {
    const config = buildConfig("chat-accept-drain-fallback");
    stubTurn(config);
    const chatId = await createAgentChat(config, "drain-fallback");
    const inFlight = await seedInFlightTask(config, chatId);

    const result = await submitChatMessage(config, chatId, { content: "echo went missing" });
    if (!("accepted" in result)) throw new Error("expected the accepted ack shape");
    await settleSubmittedChatMessage(config, chatId, result, "echo went missing");
    // Simulate the echo row disappearing before the drain binds it.
    deleteChatBlock(config.instance, result.blockId!);

    await settleTask(config, inFlight, "completed");
    await dispatchNextPendingChatMessage(config, chatId);

    // The turn still gets its user_text row — freshly inserted, task-bound.
    const bubbles = userTextBlocks(config, chatId, "echo went missing");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.id).not.toBe(result.blockId!);
    expect(bubbles[0]!.taskId).toBeString();
  });

  test("a topic verdict onto a busy topic queues on the topic, still without a duplicate echo", async () => {
    const config = buildConfig("chat-accept-topic-busy");
    const chatId = await createAgentChat(config, "topic-busy");
    const topicId = await mutateState(config.instance, (state) => {
      const chat = state.chatSessions.find((s) => s.id === chatId)!;
      return createTopic(state, {
        agentId: chat.agentId,
        title: "Busy topic",
        parentChatSessionId: chatId
      }).id;
    });
    await seedInFlightTask(config, topicId);
    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId });

    const result = await submitChatMessage(config, chatId, { content: "queue me on the topic" });
    const settled = await settleSubmittedChatMessage(
      config,
      chatId,
      result,
      "queue me on the topic"
    );
    if (!("queued" in settled) || !("topicId" in settled)) {
      throw new Error("expected a topic-queued dispatch");
    }
    expect(settled.topicId).toBe(topicId);
    // The Chat still shows exactly the one accept-time echo.
    expect(userTextBlocks(config, chatId, "queue me on the topic")).toHaveLength(1);
    // The message waits on the TOPIC's queue, not the chat's.
    const topicPending = readState(config.instance)
      .chatSessions.find((s) => s.id === topicId)?.pendingMessages ?? [];
    expect(topicPending.map((p) => p.content)).toEqual(["queue me on the topic"]);
  });

  test("settleSubmittedChatMessage times out when nothing ever dispatches", async () => {
    const config = buildConfig("chat-accept-settle-timeout");
    const chatId = await createAgentChat(config, "settle-timeout");
    const fabricated = { sessionId: chatId, accepted: true as const, blockId: "block_never" };
    await expect(
      settleSubmittedChatMessage(config, chatId, fabricated, "never dispatched", 80)
    ).rejects.toThrow("was not dispatched within 80ms");
  });

  test("a session deleted while the verdict is pending dispatches nothing", async () => {
    const hang = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {})
    });
    process.env.CHAT_ACCEPT_TEST_KEY = "test-key";
    const config: RuntimeConfig = {
      ...buildConfig("chat-accept-deleted"),
      provider: {
        name: "openai",
        model: "test",
        baseUrl: `http://127.0.0.1:${hang.port}/v1`,
        apiKeyEnv: "CHAT_ACCEPT_TEST_KEY"
      }
    };
    try {
      const chatId = await createAgentChat(config, "deleted");
      const routeTimeoutMs = 80;
      const result = await submitChatMessage(
        config,
        chatId,
        { content: "orphaned" },
        { routeTimeoutMs }
      );
      if (!("accepted" in result)) throw new Error("expected the accepted ack shape");
      await deleteChat(config, chatId);

      // Give the timed-out verdict continuation time to run, then confirm it
      // no-oped: no task, no run, no resurrected session. The window must
      // comfortably outlast routeTimeoutMs (when the continuation fires) — poll
      // across ~3x that so the no-op is observed at and past the firing point.
      const deadline = Date.now() + routeTimeoutMs * 3;
      while (Date.now() < deadline) {
        expect(readState(config.instance).tasks).toHaveLength(0);
        await Bun.sleep(15);
      }
      expect(readState(config.instance).chatSessions.some((s) => s.id === chatId)).toBe(false);
    } finally {
      hang.stop(true);
      delete process.env.CHAT_ACCEPT_TEST_KEY;
    }
  });
});
