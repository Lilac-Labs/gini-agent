// Tests for the Chat intake router (Phase 2, Commit B of ADR
// chat-topics-tasks-subagents.md). submitChatMessage classifies a message
// posted in a Chat (kind:"agent") session into one of three routes and
// dispatches accordingly:
//   - "chat"           → a normal chat-direct turn (answer in Chat).
//   - "new_topic"      → mint a kind:"topic" session, run the turn there, forward
//                        the final answer back into Chat.
//   - "existing_topic" → run the turn in the named Topic.
//
// The structured router decision is deterministic via the echo provider: each
// test seeds setEchoStructuredResponse("chat-route", {decision, ...}) so the
// classifier returns exactly that. The agent loop itself stays deterministic via
// the echo tool-calling stub. Setup mirrors chat-topic-forward.test.ts: HOME +
// embedding pinned to echo, a unique instance per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import { createChatSession, createTopic, insertChatBlock, listChatBlocks, mutateState, readState } from "../state";
import type { ChatSessionRecord, RuntimeConfig, Task } from "../types";
import { submitChatMessage } from "./chat";
import { settleSubmittedChatMessage } from "./chat-test-support";
import { buildRecentConversation, buildUserPrompt, selectCandidates } from "./chat-route";

// Submit + settle: the echo-first ack resolves before the routing verdict, so
// the routing outcome these tests pin (chat-direct vs topic dispatch) only
// exists once the dispatch continuation lands in state.
async function submitAndSettle(config: RuntimeConfig, sessionId: string, content: string) {
  const result = await submitChatMessage(config, sessionId, { content });
  return settleSubmittedChatMessage(config, sessionId, result, content);
}

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-chat-route-home-"));
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
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-route-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-route-test-logs",
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

describe("chat intake router", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  test("chat decision: runs a normal chat-direct turn, no topic minted", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-chat-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "chat" });
    setEchoToolCallingResponse({ provider, text: "It's 72 degrees.", toolCalls: [], finishReason: "stop" });

    const result = await submitAndSettle(config, chatId, "what's the weather?");
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    if ("topicId" in result) throw new Error("expected chat-direct submission, got topic dispatch");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No topic was minted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    // The answer is a durable assistant ChatMessageRecord in the Chat session.
    const chatAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAnswers.length).toBe(1);
    expect(chatAnswers[0]!.content).toBe("It's 72 degrees.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("new_topic: mints a Topic for the agent, runs there, forwards the answer to Chat", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-new-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const agentId = "agent_default";
    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, agentId, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "World Cup trip" });
    setEchoToolCallingResponse({
      provider,
      text: "I found three nonstop flights to SFO.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await submitAndSettle(config, chatId, "my dad and I want to fly to SF for a world cup game");
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // A new kind:"topic" session was minted with parentChatSessionId = Chat and
    // agentId = the Chat's agent.
    const topics = state.chatSessions.filter((s) => s.kind === "topic");
    expect(topics.length).toBe(1);
    const topic = topics[0]!;
    expect(topic.id).toBe(result.topicId);
    expect(topic.title).toBe("World Cup trip");
    expect(topic.parentChatSessionId).toBe(chatId);
    expect(topic.agentId).toBe(agentId);
    // The new topic's routing/retrieval descriptor is seeded with the
    // originating user message so a later follow-up can match it by content.
    expect(topic.topicSummary).toBe("my dad and I want to fly to SF for a world cup game");
    // Router-minted containers are UNPINNED (pinned serializes as false on
    // every topic mint) — pinning is a user gesture, so the container
    // surfaces on home, not in the sidebar, until the user pins it. And
    // nothing the router mints is ever headless.
    expect(topic.pinned).toBe(false);
    expect(topic.headless).toBeUndefined();

    // The turn ran in the Topic (replay-authoritative records live there).
    const topicAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topic.id &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(topicAnswers.length).toBe(1);
    expect(topicAnswers[0]!.content).toBe("I found three nonstop flights to SFO.");

    // The final answer is forwarded back into Chat as a render-only block (Commit
    // A behavior, now reached via the router).
    const forwarded = listChatBlocks(config.instance, chatId).find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topic.id
    );
    expect(forwarded).toBeDefined();
    if (forwarded!.kind === "assistant_text") {
      expect(forwarded!.text).toBe("I found three nonstop flights to SFO.");
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("existing_topic: runs the turn in the named Topic, mints no new one", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-existing-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "World Cup trip with dad",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id };
    });

    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId });
    setEchoToolCallingResponse({
      provider,
      text: "Booked Section 413 for both of you.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await submitAndSettle(config, chatId, "book the game tickets");
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    expect(result.topicId).toBe(topicId);
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No NEW topic minted — still exactly the one seeded.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(1);

    // The turn ran in the existing Topic.
    const topicAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topicId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(topicAnswers.length).toBe(1);
    expect(topicAnswers[0]!.content).toBe("Booked Section 413 for both of you.");

    // The answer forwarded back into Chat is tagged with the existing Topic.
    const forwarded = listChatBlocks(config.instance, chatId).find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId
    );
    expect(forwarded).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("hardening: existing_topic with an unknown topicId downgrades to chat-direct", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-bad-id-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId: "nonexistent" });
    setEchoToolCallingResponse({ provider, text: "Sure thing.", toolCalls: [], finishReason: "stop" });

    const result = await submitAndSettle(config, chatId, "do the thing");
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    // The bad topicId must NOT dispatch to a topic — it downgrades to chat-direct.
    if ("topicId" in result) throw new Error("expected chat-direct downgrade, got topic dispatch");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No topic was minted or targeted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    const chatAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAnswers.length).toBe(1);
    expect(chatAnswers[0]!.content).toBe("Sure thing.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("headless containers are excluded from router candidates", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-headless-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, headlessId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const headless = createTopic(state, {
        agentId: chat.agentId,
        title: "Email watch worker",
        parentChatSessionId: chat.id,
        headless: true
      });
      return { chatId: chat.id, headlessId: headless.id };
    });

    // The model picks the headless container — but it was never a candidate,
    // so the decision downgrades to chat-direct instead of dispatching a user
    // message into an invisible working thread.
    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId: headlessId });
    setEchoToolCallingResponse({ provider, text: "Answered in chat.", toolCalls: [], finishReason: "stop" });

    const result = await submitAndSettle(config, chatId, "anything new?");
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    if ("topicId" in result) throw new Error("expected chat-direct downgrade, got topic dispatch");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    // Nothing ran in the headless container.
    const state = readState(config.instance);
    expect(state.tasks.some((t) => t.chatSessionId === headlessId)).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("hardening: new_topic with an empty title gets a content-derived stub", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-empty-title-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "" });
    setEchoToolCallingResponse({ provider, text: "On it.", toolCalls: [], finishReason: "stop" });

    const result = await submitAndSettle(config, chatId, "plan a birthday party for my sister");
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    await waitForTerminal(config, result.taskId);

    const state = readState(config.instance);
    const topic = state.chatSessions.find((s) => s.id === result.topicId)!;
    // Title sanitized to a non-empty stub derived from the message.
    expect(topic.title.length).toBeGreaterThan(0);
    expect(topic.title).toBe("plan a birthday party for my");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("non-agent session: a kind:\"topic\" submit is not routed and runs in place", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-non-agent-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const topicId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "Existing topic",
        parentChatSessionId: chat.id
      });
      return topic.id;
    });

    // If routing were (incorrectly) invoked, this stub would mint a SECOND topic.
    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Should Not Apply" });
    setEchoToolCallingResponse({ provider, text: "Done in place.", toolCalls: [], finishReason: "stop" });

    const result = await submitAndSettle(config, topicId, "continue here");
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // Still exactly one topic: routing did not fire, so no second topic minted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(1);
    expect(state.chatSessions.some((s) => s.title === "Should Not Apply")).toBe(false);

    // The turn ran in the submitted topic session itself.
    const answers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topicId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(answers.length).toBe(1);
    expect(answers[0]!.content).toBe("Done in place.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("new_topic: a long originating message is truncated into topicSummary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-summary-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Long request" });
    setEchoToolCallingResponse({ provider, text: "On it.", toolCalls: [], finishReason: "stop" });

    const longContent = "x".repeat(300);
    const result = await submitAndSettle(config, chatId, longContent);
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    await waitForTerminal(config, result.taskId);

    const topic = readState(config.instance).chatSessions.find((s) => s.id === result.topicId)!;
    // Capped to 200 chars + the ellipsis, never the full 300-char message.
    expect(topic.topicSummary!.length).toBe(201);
    expect(topic.topicSummary!.endsWith("…")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

// Prompt-construction unit tests. The echo provider can't reason and doesn't
// expose the prompt it receives, so routing QUALITY is verified by a live
// dogfood; here we assert the pure builders carry the new context the router
// relies on — the recent-conversation transcript, the populated topicSummary,
// and recency order.
describe("chat router prompt construction", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-prompt-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
  });

  test("buildUserPrompt renders the recent-conversation section before message and topics, with populated summaries", () => {
    const candidates = [
      { topicId: "topic_a", title: "World Cup Final Trip", topicSummary: "my dad and I want to fly to SF for a world cup game" },
      { topicId: "topic_b", title: "Birthday Party", topicSummary: "plan a birthday party for my sister" }
    ];
    const recent = [
      "User: my dad and I want to fly to SF for a world cup game",
      "Gini [in #World Cup Final Trip]: I found three nonstop flights to SFO."
    ].join("\n");

    const prompt = buildUserPrompt("What are my best options for flights from San Francisco?", candidates, recent);

    // The recent-conversation section is present and comes BEFORE the message.
    expect(prompt).toContain("Recent conversation:");
    expect(prompt).toContain("Gini [in #World Cup Final Trip]:");
    expect(prompt.indexOf("Recent conversation:")).toBeLessThan(prompt.indexOf("Message:"));
    // Each candidate carries its populated summary (not just the bare title).
    expect(prompt).toContain("#World Cup Final Trip (id=topic_a): my dad and I want to fly to SF for a world cup game");
    expect(prompt).toContain("#Birthday Party (id=topic_b): plan a birthday party for my sister");
  });

  test("buildUserPrompt omits the recent-conversation section when there is no transcript", () => {
    const prompt = buildUserPrompt("hello", [{ topicId: "t1", title: "Trip", topicSummary: "go to SF" }]);
    expect(prompt).not.toContain("Recent conversation:");
    expect(prompt.startsWith("Message:")).toBe(true);
  });

  test("buildRecentConversation labels a forwarded answer with its topic and keeps the last blocks", () => {
    const instance = `chat-route-recent-${basename(root)}`;
    const config = buildConfig(mkdtempSync(join(tmpdir(), "gini-chat-route-ws-")), instance);
    const chatId = "chat_recent";
    insertChatBlock(instance, { kind: "user_text", sessionId: chatId, text: "fly to SF for a world cup game" });
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: chatId,
      text: "I found three nonstop flights to SFO.",
      streaming: false,
      forwardedFromTopicId: "topic_wc",
      forwardedFromTopicTitle: "World Cup Final Trip"
    });

    const transcript = buildRecentConversation(config, chatId);
    expect(transcript).toContain("User: fly to SF for a world cup game");
    expect(transcript).toContain("Gini [in #World Cup Final Trip]: I found three nonstop flights to SFO.");
  });

  test("buildRecentConversation truncates a long forwarded answer", () => {
    const instance = `chat-route-recent-trunc-${basename(root)}`;
    const config = buildConfig(mkdtempSync(join(tmpdir(), "gini-chat-route-ws-")), instance);
    const chatId = "chat_recent_trunc";
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: chatId,
      text: "y".repeat(300),
      streaming: false
    });
    const transcript = buildRecentConversation(config, chatId);
    // 160-char cap + the ellipsis, prefixed with the chat-direct "Gini: " label.
    expect(transcript).toBe(`Gini: ${"y".repeat(160)}…`);
  });

  test("selectCandidates orders the ≤cap path most-recently-updated first", async () => {
    const config = buildConfig(mkdtempSync(join(tmpdir(), "gini-chat-route-ws-")), `chat-route-order-${basename(root)}`);
    const topics: ChatSessionRecord[] = [
      { id: "old", instance: config.instance, title: "Older topic", kind: "topic", updatedAt: "2026-06-20T00:00:00.000Z", createdAt: "2026-06-20T00:00:00.000Z", messageIds: [], taskIds: [], runIds: [], topicSummary: "older" },
      { id: "new", instance: config.instance, title: "Newer topic", kind: "topic", updatedAt: "2026-06-24T00:00:00.000Z", createdAt: "2026-06-24T00:00:00.000Z", messageIds: [], taskIds: [], runIds: [], topicSummary: "newer" }
    ];
    const candidates = await selectCandidates(config, "any message", topics);
    expect(candidates.map((c) => c.topicId)).toEqual(["new", "old"]);
  });
});
