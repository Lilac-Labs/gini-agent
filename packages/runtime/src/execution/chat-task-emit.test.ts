// Coverage for emitToolResult: it persists a tool_result block with a
// truncated preview, and no-ops for a no-context (subagent / CLI) task. An
// agent-produced attachment reaches the user via a markdown ref the model
// pastes into its reply, not via this block. See ADR outbound-chat-attachments.md.
//
// Also covers the Topic→Chat gate forward (ADR chat-topics-tasks-subagents.md):
// a gate emitted into a kind:"topic" session with a parentChatSessionId lands a
// render-only copy of the SAME gate (same id + payload) in the parent Chat.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { closeAllMemoryDbs, createChatSession, createTopic, insertChatBlock, listChatBlocks, mutateState } from "../state";
import { emitSetupRequested, emitToolCallStatus, emitToolResult } from "./chat-task-emit";
import type { ChatEmitContext } from "./chat-task-emit";

const ROOT = "/tmp/gini-emit-toolresult-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  closeAllMemoryDbs();
});

function ctx(instance: string, sessionId: string): ChatEmitContext {
  return { instance, sessionId, taskId: "task_emit" };
}

describe("emitToolResult", () => {
  test("returns undefined for a no-context (subagent / CLI) task", () => {
    expect(emitToolResult(undefined, { callId: "c", result: "x" })).toBeUndefined();
  });

  test("persists a short result as an untruncated preview", () => {
    const instance = "emit-toolresult-short";
    const block = emitToolResult(ctx(instance, "chat_e1"), { callId: "call_ok", result: "done" });
    if (block?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.preview).toBe("done");
    expect(block.truncated).toBe(false);
    const listed = listChatBlocks(instance, "chat_e1")[0];
    if (listed?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(listed.preview).toBe("done");
  });

  test("truncates a long preview past the 80-char cap and flags truncated", () => {
    const instance = "emit-toolresult-trunc";
    const block = emitToolResult(ctx(instance, "chat_e2"), { callId: "call_long", result: "z".repeat(200) });
    if (block?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.truncated).toBe(true);
    expect(block.preview.length).toBeLessThanOrEqual(80);
    expect(block.preview.endsWith("…")).toBe(true);
  });
});

describe("emitToolCallStatus", () => {
  test("passes jobId through to the persisted tool_call block on the ok flip", () => {
    const instance = "emit-toolcall-jobid";
    // The running row the loop mounted before dispatch. taskId must match
    // the emit context — updateToolCallBlock scopes the settle to its turn.
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_j",
      taskId: "task_emit",
      toolName: "create_job",
      displayLabel: "Create scheduled job",
      argsPreview: "morning-brief",
      argsFull: { name: "morning-brief" },
      status: "running",
      callId: "call_create"
    });
    const updated = emitToolCallStatus(ctx(instance, "chat_j"), {
      callId: "call_create",
      status: "ok",
      jobId: "job_from_dispatch"
    });
    expect(updated?.kind === "tool_call" && updated.jobId).toBe("job_from_dispatch");
    const listed = listChatBlocks(instance, "chat_j")[0];
    expect(listed?.kind === "tool_call" && listed.jobId).toBe("job_from_dispatch");
    expect(listed?.kind === "tool_call" && listed.status).toBe("ok");
  });
});

describe("Topic→Chat gate forward", () => {
  test("a setup_requested gate in a Topic forwards an actionable copy (same id) into the parent Chat", async () => {
    const instance = "emit-gate-forward";
    const { chatId, topicId, topicTitle } = await mutateState(instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "World Cup trip",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id, topicTitle: topic.title };
    });

    const topicCtx: ChatEmitContext = { instance, sessionId: topicId, taskId: "task_topic" };
    emitSetupRequested(topicCtx, {
      setupRequestId: "setup_42",
      action: "chat.choice",
      summary: "Which hotel?"
    });

    // The gate lands in the Topic.
    const topicBlocks = listChatBlocks(instance, topicId);
    const topicGate = topicBlocks.find((b) => b.kind === "setup_requested");
    if (topicGate?.kind !== "setup_requested") throw new Error("expected a setup_requested block in the Topic");
    expect(topicGate.setupRequestId).toBe("setup_42");
    expect(topicGate.forwardedFromTopicId).toBeUndefined();

    // A render-only copy with the SAME gate id + payload lands in the parent Chat,
    // tagged with the Topic. Acting on it resolves the same global gate.
    const chatBlocks = listChatBlocks(instance, chatId);
    const forwarded = chatBlocks.find((b) => b.kind === "setup_requested");
    if (forwarded?.kind !== "setup_requested") throw new Error("expected a forwarded setup_requested block in Chat");
    expect(forwarded.setupRequestId).toBe("setup_42");
    expect(forwarded.action).toBe("chat.choice");
    expect(forwarded.summary).toBe("Which hotel?");
    expect(forwarded.forwardedFromTopicId).toBe(topicId);
    expect(forwarded.forwardedFromTopicTitle).toBe(topicTitle);
  });

  test("a setup_requested gate in plain Chat (no parent) is NOT forwarded", async () => {
    const instance = "emit-gate-no-forward";
    const chatId = await mutateState(instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    const chatCtx: ChatEmitContext = { instance, sessionId: chatId, taskId: "task_chat" };
    emitSetupRequested(chatCtx, {
      setupRequestId: "setup_99",
      action: "chat.choice",
      summary: "Pick one"
    });

    const blocks = listChatBlocks(instance, chatId);
    const gates = blocks.filter((b) => b.kind === "setup_requested");
    expect(gates.length).toBe(1);
    expect(gates[0]!.kind === "setup_requested" && gates[0]!.forwardedFromTopicId).toBeUndefined();
  });
});
