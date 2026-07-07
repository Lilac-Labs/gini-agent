// Tests for the Topic dispatch + Topic→Chat forward mechanism (Phase 2,
// Commit A of ADR chat-topics-tasks-subagents.md). We call
// dispatchChatMessageToTopic / runTopicSubmission DIRECTLY — the router that
// chooses a Topic for a Chat message is Commit B and not exercised here.
//
// Setup mirrors chat-task.test.ts: the echo provider makes the agent loop
// deterministic, HOME points at a unique mkdtemp dir so the machine-global
// Google account registry can't shift system-prompt size, and each test uses a
// unique instance (derived from the mkdtemp basename) so per-instance state
// can't bleed across reruns in the same worker.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import {
  createChatSession,
  createTopic,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import type { RuntimeConfig, Task } from "../types";
import {
  dispatchChatMessageToTopic,
  runTopicSubmission,
  submitChatMessage
} from "./chat";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-topic-fwd-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  rmSync(scratchHome, { recursive: true, force: true });
});

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-topic-fwd-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-topic-fwd-test-logs",
    approvalMode: "strict"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "waiting_approval")
    ) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("topic dispatch + forward", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-topic-fwd-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // Build the PreparedChatSubmission shape the direct-dispatch entrypoints
  // expect, with liveSession pointing at the given Chat session record.
  function prepared(config: RuntimeConfig, content: string, chatSessionId: string) {
    const liveSession = readState(config.instance).chatSessions.find((s) => s.id === chatSessionId)!;
    return { content, images: [], audio: undefined, liveSession, clientSurface: undefined };
  }

  test("new-topic round-trip: answer lands in the Topic, forwarded copy in Chat", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-roundtrip-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, topicId, topicTitle } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "World Cup trip with dad",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id, topicTitle: topic.title };
    });

    setEchoToolCallingResponse({
      provider,
      text: "I found three nonstop flights to SFO.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await dispatchChatMessageToTopic(
      config,
      chatId,
      topicId,
      prepared(config, "find flights to SF for the world cup", chatId)
    );
    if ("queued" in result) throw new Error("expected a run-now dispatch, got queued");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);

    // (a) The Topic session owns the replay-authoritative records: the user
    // ChatMessageRecord + the answer ChatMessageRecord, plus the user_text block.
    const topicUserMsgs = state.chatMessages.filter(
      (m) => m.sessionId === topicId && m.role === "user"
    );
    expect(topicUserMsgs.length).toBe(1);
    expect(topicUserMsgs[0]!.content).toBe("find flights to SF for the world cup");

    const topicAnswerMsgs = state.chatMessages.filter(
      (m) =>
        m.sessionId === topicId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(topicAnswerMsgs.length).toBe(1);
    expect(topicAnswerMsgs[0]!.content).toBe("I found three nonstop flights to SFO.");

    const topicBlocks = listChatBlocks(config.instance, topicId);
    expect(topicBlocks.some((b) => b.kind === "user_text" && b.text === "find flights to SF for the world cup")).toBe(true);

    // (b) The Chat session shows the user bubble block AND the forwarded answer.
    const chatBlocks = listChatBlocks(config.instance, chatId);
    expect(
      chatBlocks.some((b) => b.kind === "user_text" && b.text === "find flights to SF for the world cup")
    ).toBe(true);
    const forwarded = chatBlocks.find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId
    );
    expect(forwarded).toBeDefined();
    expect(forwarded!.kind).toBe("assistant_text");
    if (forwarded!.kind === "assistant_text") {
      expect(forwarded!.text).toBe("I found three nonstop flights to SFO.");
      expect(forwarded!.streaming).toBe(false);
      expect(forwarded!.forwardedFromTopicTitle).toBe(topicTitle);
      expect(forwarded!.taskId).toBe(finished.id);
    }

    // (c) The answer ChatMessageRecord lives in the TOPIC, not Chat: Chat has
    // NO assistant ChatMessageRecord (forward is block-only).
    const chatAssistantMsgs = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAssistantMsgs.length).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("tool calls and thinking mirror into Chat", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-mirror-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "Investor scheduling",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id };
    });

    // Turn drives one tool call (get_current_time is always-on, read-only,
    // auto-approved) then a final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Checking the time.",
      toolCalls: [{ id: "call_clock", type: "function", function: { name: "get_current_time", arguments: "{}" } }],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "It's mid-afternoon, so let's aim for tomorrow morning.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await dispatchChatMessageToTopic(
      config,
      chatId,
      topicId,
      prepared(config, "when can we meet?", chatId)
    );
    if ("queued" in result) throw new Error("expected a run-now dispatch, got queued");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    // The parent Chat mirrors the Topic turn's full activity: the tool call
    // (settled to "ok"), at least one phase marker, and the final answer — all
    // tagged with the originating Topic.
    const chatBlocks = listChatBlocks(config.instance, chatId);

    const mirroredToolCall = chatBlocks.find(
      (b) => b.kind === "tool_call" && b.forwardedFromTopicId === topicId
    );
    expect(mirroredToolCall).toBeDefined();
    if (mirroredToolCall!.kind === "tool_call") {
      expect(mirroredToolCall!.callId).toBe("call_clock");
      expect(mirroredToolCall!.status).toBe("ok");
      expect(mirroredToolCall!.taskId).toBe(finished.id);
    }

    const mirroredPhase = chatBlocks.find(
      (b) => b.kind === "phase" && b.forwardedFromTopicId === topicId
    );
    expect(mirroredPhase).toBeDefined();
    expect(mirroredPhase!.taskId).toBe(finished.id);

    // finalize forwards both intermediate narration and the final answer, so
    // the final answer is among the forwarded assistant_text blocks.
    const forwardedAnswer = chatBlocks.find(
      (b) =>
        b.kind === "assistant_text" &&
        b.forwardedFromTopicId === topicId &&
        b.text === "It's mid-afternoon, so let's aim for tomorrow morning."
    );
    expect(forwardedAnswer).toBeDefined();
    expect(forwardedAnswer!.taskId).toBe(finished.id);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("replay scoping: a second Topic turn replays the first answer (no re-answer)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-replay-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const topicId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "Section seats",
        parentChatSessionId: chat.id
      });
      return topic.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "Section 413 has better sightlines than Cat2.",
      toolCalls: [],
      finishReason: "stop"
    });
    const first = await runTopicSubmission(config, topicId, prepared(config, "is 413 better than Cat2?", topicId));
    const firstFinished = await waitForTerminal(config, first.taskId);
    expect(firstFinished.status).toBe("completed");

    clearEchoToolCallingResponses();
    setEchoToolCallingResponse({ provider, text: "Noted.", toolCalls: [], finishReason: "stop" });
    const second = await runTopicSubmission(config, topicId, prepared(config, "ok thanks", topicId));
    const secondFinished = await waitForTerminal(config, second.taskId);
    expect(secondFinished.status).toBe("completed");

    // Turn 2's provider messages must replay turn 1's answer (scoped to the
    // Topic) so the Topic doesn't re-answer the prior question.
    const calls = getEchoToolCallingCalls();
    const lastTurn = calls[calls.length - 1]!;
    const replayed = lastTurn.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(replayed).toContain("Section 413 has better sightlines than Cat2.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("follow-up into an idle container mints a new task there and replays prior context", async () => {
    // The follow-up continuity contract (unified task model): posting into a
    // container with NO live run — via the public submitChatMessage path that
    // POST /api/chat/:id/messages uses — mints a fresh task in the SAME
    // container, and session-scoped packing replays the prior turns into the
    // new task's context for free.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-followup-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const topicId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return createTopic(state, {
        agentId: chat.agentId,
        title: "Splitwise June",
        parentChatSessionId: chat.id
      }).id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "You owe Sam $42 from June.",
      toolCalls: [],
      finishReason: "stop"
    });
    const first = await submitChatMessage(config, topicId, { content: "check my June balance" });
    if ("queued" in first || !("taskId" in first)) throw new Error("expected the first submit to run now");
    const firstFinished = await waitForTerminal(config, first.taskId);
    expect(firstFinished.status).toBe("completed");

    clearEchoToolCallingResponses();
    setEchoToolCallingResponse({ provider, text: "Settled it.", toolCalls: [], finishReason: "stop" });
    const second = await submitChatMessage(config, topicId, { content: "pay him back" });
    if ("queued" in second || !("taskId" in second)) throw new Error("expected the follow-up to run now");
    expect(second.taskId).not.toBe(first.taskId);
    const secondFinished = await waitForTerminal(config, second.taskId);
    expect(secondFinished.status).toBe("completed");

    // Both tasks live in the SAME container.
    expect(secondFinished.chatSessionId).toBe(topicId);
    const state = readState(config.instance);
    expect(state.tasks.find((t) => t.id === first.taskId)?.chatSessionId).toBe(topicId);

    // The follow-up's provider messages replay turn 1 (user + answer) —
    // context continuity comes from session-scoped packing, not the caller.
    const calls = getEchoToolCallingCalls();
    const lastTurn = calls[calls.length - 1]!;
    const replayed = lastTurn.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(replayed).toContain("check my June balance");
    expect(replayed).toContain("You owe Sam $42 from June.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("per-topic queue: a second routed message queues on the Topic and drains in order", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-queue-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "Trip planning",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id };
    });

    // Turn 1: a delayed model call so turn 2 arrives while turn 1 is in flight.
    setEchoToolCallingResponse(
      { provider, text: "First answer.", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 400 }
    );
    const first = await dispatchChatMessageToTopic(config, chatId, topicId, prepared(config, "first message", chatId));
    if ("queued" in first) throw new Error("expected the first dispatch to run now");

    // Wait until the Topic genuinely has a live turn, then route a second
    // message — it must queue onto the TOPIC, not the Chat.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (readState(config.instance).tasks.find((t) => t.id === first.taskId)?.status === "running") break;
      await Bun.sleep(10);
    }
    // Queue turn 2's answer before dispatching so the drained turn can complete.
    setEchoToolCallingResponse({ provider, text: "Second answer.", toolCalls: [], finishReason: "stop" });
    const second = await dispatchChatMessageToTopic(config, chatId, topicId, prepared(config, "second message", chatId));
    expect("queued" in second).toBe(true);

    // The pending message is on the TOPIC's queue, not the Chat's.
    const queued = readState(config.instance);
    const topicSession = queued.chatSessions.find((s) => s.id === topicId)!;
    const chatSession = queued.chatSessions.find((s) => s.id === chatId)!;
    expect(topicSession.pendingMessages?.length ?? 0).toBe(1);
    expect(topicSession.pendingMessages?.[0]?.content).toBe("second message");
    expect(chatSession.pendingMessages?.length ?? 0).toBe(0);

    await waitForTerminal(config, first.taskId);

    // The queue drains via runTopicSubmission: both answers complete and the
    // Topic's queue empties. Wait for the second turn to land its answer.
    const drainDeadline = Date.now() + 5000;
    while (Date.now() < drainDeadline) {
      const answers = readState(config.instance).chatMessages.filter(
        (m) =>
          m.sessionId === topicId &&
          m.role === "assistant" &&
          m.kind !== "tool_transcript" &&
          m.kind !== "approval_reason"
      );
      if (answers.length >= 2) break;
      await Bun.sleep(20);
    }

    const finalState = readState(config.instance);
    expect(finalState.chatSessions.find((s) => s.id === topicId)!.pendingMessages?.length ?? 0).toBe(0);

    // Both forwarded answers land in Chat in order.
    const forwarded = listChatBlocks(config.instance, chatId)
      .filter((b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId)
      .map((b) => (b.kind === "assistant_text" ? b.text : ""));
    expect(forwarded).toEqual(["First answer.", "Second answer."]);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("child-of-child forwards one level up only: into ITS parent topic, not the root Chat", async () => {
    // Forwarding is generalized to ANY session with a parentChatSessionId
    // whose parent exists — including when the parent is itself a topic
    // (spawned child task containers nest this way). The mirror is one hop:
    // the grandparent must see nothing from the grandchild.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-nested-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, parentTopicId, childTopicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const parentTopic = createTopic(state, {
        agentId: chat.agentId,
        title: "Inbox watch",
        parentChatSessionId: chat.id
      });
      const childTopic = createTopic(state, {
        agentId: chat.agentId,
        title: "Reply to Sam",
        parentChatSessionId: parentTopic.id
      });
      return { chatId: chat.id, parentTopicId: parentTopic.id, childTopicId: childTopic.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Drafted the reply to Sam.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await runTopicSubmission(config, childTopicId, prepared(config, "draft the reply", childTopicId));
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    // The child's answer mirrors into ITS parent topic.
    const parentBlocks = listChatBlocks(config.instance, parentTopicId);
    const forwarded = parentBlocks.find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === childTopicId
    );
    expect(forwarded).toBeDefined();
    if (forwarded!.kind === "assistant_text") {
      expect(forwarded!.text).toBe("Drafted the reply to Sam.");
      expect(forwarded!.forwardedFromTopicTitle).toBe("Reply to Sam");
    }

    // One hop only: the root Chat sees NOTHING from the grandchild.
    const chatBlocks = listChatBlocks(config.instance, chatId);
    expect(chatBlocks.some((b) => b.forwardedFromTopicId === childTopicId)).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("chat-direct turn is unchanged: answer stays in Chat and forwards nothing", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-topic-ws-"));
    const config = buildConfig(workspaceRoot, `topic-fwd-chat-direct-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "Direct chat answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await submitChatMessage(config, chatId, { content: "hi there" }, { bypassQueue: true });
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // The answer is a durable ChatMessageRecord in the Chat session.
    const chatAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAnswers.length).toBe(1);
    expect(chatAnswers[0]!.content).toBe("Direct chat answer.");

    // Nothing was forwarded anywhere: no block carries a forward marker.
    const allSessions = state.chatSessions.map((s) => s.id);
    for (const sid of allSessions) {
      const forwarded = listChatBlocks(config.instance, sid).filter(
        (b) => b.kind === "assistant_text" && b.forwardedFromTopicId
      );
      expect(forwarded.length).toBe(0);
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
