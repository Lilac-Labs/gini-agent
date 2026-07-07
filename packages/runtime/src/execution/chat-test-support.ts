// Test support for the echo-first submit contract. submitChatMessage resolves
// a routed (kind:"agent") session submit with { accepted, blockId } BEFORE the
// routing verdict lands; the run/task/queue outcome materializes in state a
// beat later. Tests that need the old synchronous result shape call
// settleSubmittedChatMessage to poll state until the dispatch continuation
// finishes, and get back the pre-echo-first union (run-now / topic / queued).
// Imported only by tests — production code must not depend on it.

import { listChatBlocks, readState } from "../state";
import type { RuntimeConfig, TaskStatus } from "../types";
import type { submitChatMessage } from "./chat";

type SubmitResult = Awaited<ReturnType<typeof submitChatMessage>>;

export type SettledDispatch =
  // runId is optional on the run members: the needs-input answer path (chat
  // or topic side) resumes the parked task instead of minting a fresh run, so
  // its (sync, passthrough) result carries the task's runId only when the
  // park has one.
  | { sessionId: string; runId?: string; taskId: string; status: TaskStatus }
  | { topicId: string; runId?: string; taskId: string; status: TaskStatus }
  | { sessionId: string; queued: true; pendingId: string }
  | { topicId: string; queued: true; pendingId: string };

// Poll until an accepted submission has been dispatched (run-now, topic, or
// queued) and return the equivalent of the old synchronous result. Sync
// results (bypassQueue, non-agent sessions) pass through unchanged. `content`
// disambiguates the topic-side rows the dispatch creates — tests run on fresh
// per-test instances, so a content match is unambiguous there.
export async function settleSubmittedChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  result: SubmitResult,
  content: string,
  timeoutMs = 5000
): Promise<SettledDispatch> {
  if (!("accepted" in result)) return result;
  const blockId = "blockId" in result ? result.blockId : undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    // Chat-direct run: the echo block gained its task binding.
    if (blockId) {
      const echo = listChatBlocks(config.instance, sessionId).find((b) => b.id === blockId);
      if (echo?.taskId && echo.runId) {
        const task = state.tasks.find((t) => t.id === echo.taskId);
        if (task) {
          return { sessionId, runId: echo.runId, taskId: echo.taskId, status: task.status };
        }
      }
    }
    // Chat-direct queued: the pending entry carries the echo block id.
    const chatSession = state.chatSessions.find((s) => s.id === sessionId);
    const chatPending = chatSession?.pendingMessages?.find(
      (p) => (blockId !== undefined && p.echoBlockId === blockId) || p.content === content
    );
    if (chatPending) {
      return { sessionId, queued: true as const, pendingId: chatPending.id };
    }
    // Topic dispatch: the turn's replay-authoritative user row (or its queued
    // pending entry) lives in a topic parented to this chat.
    for (const topic of state.chatSessions) {
      if (topic.kind !== "topic" || topic.parentChatSessionId !== sessionId) continue;
      const userRow = state.chatMessages.find(
        (m) => m.sessionId === topic.id && m.role === "user" && m.content === content && m.taskId
      );
      if (userRow?.taskId) {
        const task = state.tasks.find((t) => t.id === userRow.taskId);
        if (task?.runId) {
          return { topicId: topic.id, runId: task.runId, taskId: task.id, status: task.status };
        }
      }
      const topicPending = topic.pendingMessages?.find((p) => p.content === content);
      if (topicPending) {
        return { topicId: topic.id, queued: true as const, pendingId: topicPending.id };
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `Accepted chat message was not dispatched within ${timeoutMs}ms (session ${sessionId})`
  );
}
