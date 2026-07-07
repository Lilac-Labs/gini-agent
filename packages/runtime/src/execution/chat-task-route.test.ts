// Integration tests for the chat turn's emit-context resolution.
//
// Agent turns no longer route themselves into threads (Topics replace
// threads, ADR chat-topics-tasks-subagents.md): a plain reply stays in the
// session's main timeline. The dormant thread-reply path still pre-seeds
// `task.threadId`/`task.parentBlockId`, and resolveEmitContext honors those
// fields so a pre-seeded task threads its whole response.
//
// We drive real turns through submitChatMessage with the echo provider's
// stubbed tool-calling responses so the loop is fully deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { createTask, listChatBlocks, mutateState, readState, upsertTask } from "../state";
import { listMainChatBlocks } from "../state/chat-blocks";
import type { RuntimeConfig, Task } from "../types";
import { createChat, submitChatMessage as submitChatMessageRaw } from "./chat";
import { settleSubmittedChatMessage, type SettledDispatch } from "./chat-test-support";
import { runChatTask } from "./chat-task";

// These tests submit on idle sessions, which always run immediately. Settle
// the echo-first ack into the dispatched turn and narrow to the run-now
// branch so the existing `.taskId` reads stay typed (a queued result here is
// a test-setup bug). See ADR chat-message-queue.md.
async function submitChatMessage(
  ...args: Parameters<typeof submitChatMessageRaw>
): Promise<Extract<SettledDispatch, { taskId: string }>> {
  const result = await submitChatMessageRaw(...args);
  const settled = await settleSubmittedChatMessage(
    args[0],
    args[1],
    result,
    String(args[2].content ?? "")
  );
  if ("queued" in settled) throw new Error("expected run-now submission, got queued");
  return settled;
}

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-route-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-route-test-logs"
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

describe("chat-task emit context", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // Runs a first main-chat turn so a prior assistant_text block exists, then
  // returns the session id + the last main-chat assistant block id.
  async function seedFirstTurn(
    config: RuntimeConfig,
    provider: ReturnType<typeof normalizeProvider>
  ): Promise<{ sessionId: string; parentBlockId: string }> {
    setEchoToolCallingResponse({
      provider,
      text: "First main-chat answer.",
      toolCalls: [],
      finishReason: "stop"
    });
    const session = await createChat(config, { title: "route-test" });
    const first = await submitChatMessage(config, session.id, { content: "hello" });
    await waitForTerminal(config, first.taskId);
    const main = listMainChatBlocks(config.instance, session.id);
    const lastAssistant = [...main].reverse().find((b) => b.kind === "assistant_text");
    expect(lastAssistant).toBeDefined();
    return { sessionId: session.id, parentBlockId: lastAssistant!.id };
  }

  test("a plain agent reply stays in the main chat with text untouched", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-none");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "Plain main-chat reply.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "and?" });
    const finished = await waitForTerminal(config, second.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Plain main-chat reply.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === second.taskId);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBeUndefined();
  });

  test("a task pre-seeded with task.threadId threads its whole response", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-preseed");
    const provider = normalizeProvider(config.provider);
    const { sessionId, parentBlockId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "Replying inside the existing thread.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Build the task with the thread fields already set (mirrors how the
    // dormant thread-reply path spawns it) and run it directly so the loop
    // resolves its emit context from the pre-seeded fields with no race.
    const seededThreadId = "thread_preseed";
    const task = createTask(config.instance, "thread reply", undefined, undefined, undefined, undefined, undefined, sessionId);
    task.mode = "chat";
    task.threadId = seededThreadId;
    task.parentBlockId = parentBlockId;
    await mutateState(config.instance, (state) => {
      upsertTask(state, task);
    });
    const finished = await runChatTask(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Replying inside the existing thread.");

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === task.id);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBe(seededThreadId);
    expect(blocks[0]!.parentBlockId).toBe(parentBlockId);
  });
});
