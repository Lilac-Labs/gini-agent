// Subagent orchestration.
//
// Slice 4: subagents are constrained child tasks. spawnSubagent creates a
// SubagentRecord, submits a chat-mode child task whose system prompt,
// toolset whitelist, and skill whitelist are taken from the record, and
// returns the record. The chat-task agent loop reads the linked subagent
// at runtime via getSubagentForTask and applies the constraints.
//
// The legacy single-arg spawn shape ({ name, prompt, toolsets? }) is
// preserved for back-compat with existing CLI calls — when systemPrompt
// is not provided, a generic "focused subagent" preamble is used.

import { cancelTask, submitTask } from "../agent";
import type { RuntimeConfig, RuntimeState, SubagentRecord, Task } from "../types";
import {
  appendTrace,
  createSubagentRecord,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState
} from "../state";
import { resolveEffectiveContext } from "../execution/effective-context";

// Default system prompt for a subagent when the caller doesn't provide one.
// Keep it short and behavioral: the model gets the user-facing `prompt` as
// its task input, plus the enabled-skill block and tool catalog as usual.
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a focused subagent inside the Gini runtime. " +
  "Your scope is the single task delegated to you by the parent agent. " +
  "Use the available tools to complete it, then return a concise final answer. " +
  "Do not spawn further subagents unless explicitly told to. " +
  "Stay within the toolsets and skills exposed in your system prompt.";

export interface SpawnSubagentInput {
  name?: string;
  prompt?: string;
  systemPrompt?: string;
  toolsets?: string[];
  skills?: string[];
  // Optional delegation framing rendered as `## Goal` / `## Context` sections
  // ahead of the prompt in the subagent's system context.
  goal?: string;
  context?: string;
  // Internal: when an agent loop spawns a child via the spawn_subagent tool,
  // it passes the parent task id so the SubagentRecord and the child task
  // both link back. Not part of the public API surface.
  parentTaskId?: string;
  // Internal: when a fan-out consumer (the jobs scheduler) spawns a worker into
  // a specific chat session, it passes that session id so the child task is
  // linked to it (the worker runs inside that channel). Threaded into submitTask
  // and stamped onto session.taskIds. Not part of the public API surface.
  chatSessionId?: string;
}

// Walk the parentTaskId chain back from `taskId` and return the depth in
// terms of subagent nesting (i.e. count of ancestor tasks that have a
// `subagentId`). The root user-submitted task has depth 0; a subagent
// spawned by it produces depth 1; grandchildren depth 2; etc.
export function subagentDepth(state: RuntimeState, taskId: string | undefined): number {
  let depth = 0;
  let cursor = taskId;
  // Cap the walk to avoid infinite loops if data is corrupted.
  for (let i = 0; i < 32 && cursor; i += 1) {
    const task = state.tasks.find((t) => t.id === cursor);
    if (!task) break;
    if (task.subagentId) depth += 1;
    cursor = task.parentTaskId;
  }
  return depth;
}

export const MAX_SUBAGENT_DEPTH = 3;

// Walk the parentChatSessionId chain up from `sessionId` and return the
// number of container ancestors. The root Chat (`kind:"agent"`) has depth 0;
// a topic under it depth 1; a spawned child container under that depth 2.
// spawn_task enforces MAX_SUBAGENT_DEPTH against this walk IN ADDITION to
// subagentDepth: each spawned child's follow-up runs start with a fresh
// task chain (no subagentId ancestry), so the task-chain walk alone could
// not cap container nesting.
export function containerChainDepth(state: RuntimeState, sessionId: string | undefined): number {
  let depth = 0;
  let cursor = sessionId;
  // Cap the walk to avoid infinite loops if data is corrupted.
  for (let i = 0; i < 32 && cursor; i += 1) {
    const session = state.chatSessions.find((s) => s.id === cursor);
    if (!session?.parentChatSessionId) break;
    depth += 1;
    cursor = session.parentChatSessionId;
  }
  return depth;
}

// Public spawner. Accepts an `input` bag (HTTP body / tool-call args).
// Returns the SubagentRecord (status "running" once the child task is
// submitted; legacy callers don't await completion).
export async function spawnSubagent(
  config: RuntimeConfig,
  input: SpawnSubagentInput | Record<string, unknown>
): Promise<SubagentRecord & { taskId: string }> {
  const prompt = String((input as SpawnSubagentInput).prompt ?? "");
  if (!prompt) throw new Error("Subagent prompt is required.");
  const name = String((input as SpawnSubagentInput).name ?? "Subagent");
  const systemPrompt =
    typeof (input as SpawnSubagentInput).systemPrompt === "string" && (input as SpawnSubagentInput).systemPrompt!.length > 0
      ? (input as SpawnSubagentInput).systemPrompt!
      : DEFAULT_SUBAGENT_SYSTEM_PROMPT;
  const toolsetIds = Array.isArray((input as SpawnSubagentInput).toolsets)
    ? (input as SpawnSubagentInput).toolsets!.map(String)
    : undefined;
  const skillNames = Array.isArray((input as SpawnSubagentInput).skills)
    ? (input as SpawnSubagentInput).skills!.map(String)
    : undefined;
  const goal =
    typeof (input as SpawnSubagentInput).goal === "string" && (input as SpawnSubagentInput).goal!.trim().length > 0
      ? (input as SpawnSubagentInput).goal!.trim()
      : undefined;
  const context =
    typeof (input as SpawnSubagentInput).context === "string" && (input as SpawnSubagentInput).context!.trim().length > 0
      ? (input as SpawnSubagentInput).context!.trim()
      : undefined;
  const parentTaskId =
    typeof (input as SpawnSubagentInput).parentTaskId === "string"
      ? (input as SpawnSubagentInput).parentTaskId
      : undefined;
  const chatSessionId =
    typeof (input as SpawnSubagentInput).chatSessionId === "string"
      ? (input as SpawnSubagentInput).chatSessionId
      : undefined;

  // Depth cap. We compute against a snapshot — race-free enough for the PoC
  // because the chain only grows as ancestors complete, and depth is
  // monotonic with respect to task creation order.
  if (parentTaskId) {
    const state = readState(config.instance);
    const depth = subagentDepth(state, parentTaskId);
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `max_subagent_depth_exceeded: parent chain already at depth ${depth} (cap ${MAX_SUBAGENT_DEPTH}).`
      );
    }
  }

  // Default toolsets list mirrors the legacy spawnSubagent default for
  // back-compat. We persist it on the record as the *advertised* toolsets;
  // the chat-task loop's filtering is governed by `toolsetIds` (which may
  // be undefined to mean "inherit").
  const advertisedToolsets = toolsetIds ?? ["file", "terminal", "memory", "session_search", "browser"];

  // Re-check the parent task's terminal status atomically with
  // subagent record creation. Without this serialization, a cancel
  // queued behind the dispatcher's lock-free pre-check could win
  // the lock between pre-check and here, leaving a fresh subagent
  // record (and its subsequent task) running under a cancelled
  // parent. We throw a structured error the dispatcher catches and
  // converts to a "skipped" tool result.
  let parentAgentId: string | undefined;
  const subagent = await mutateState(config.instance, (state) => {
    let parent: typeof state.tasks[number] | undefined;
    if (parentTaskId) {
      parent = state.tasks.find((t) => t.id === parentTaskId);
      // Refuse on `cancelled` (operator-initiated cancel race) AND
      // `failed` (sibling approval denial / runtime failure
      // mid-turn). `completed` is intentionally permitted because
      // the Hermes-parity integration test exercises a legitimate
      // "completed parent → attach a subagent for review" path —
      // a successful completion is not a security-relevant
      // boundary.
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot spawn subagent: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    // Inherit the parent task's owning agent so a switch between the
    // parent's submission and this spawn doesn't reattribute the child.
    // Mirrors the retryTask precedent (`existing.agentId ?? effective.agentId`)
    // — fall back to the active agent only for parentless / unstamped
    // legacy parents.
    const effective = resolveEffectiveContext(state, config);
    parentAgentId = parent?.agentId ?? effective.agentId;
    return createSubagentRecord(state, {
      name,
      prompt,
      parentTaskId,
      toolsets: advertisedToolsets,
      systemPrompt,
      toolsetIds,
      skillNames,
      ...(goal ? { goal } : {}),
      ...(context ? { context } : {}),
      agentId: parentAgentId
    });
  });

  // If `submitTask` throws after we just created the
  // `SubagentRecord` (e.g. its in-callback parent-status guard
  // rejects because `cancelTask` raced between our record creation
  // above and this submission), we MUST clean up the orphaned
  // record so it doesn't stay in `queued` forever. Rethrow as a
  // `Cannot spawn subagent ...` error so the dispatcher's existing
  // catch translates it into a skipped tool result.
  let task: Task;
  try {
    task = await submitTask(config, prompt, {
      mode: "chat",
      parentTaskId,
      subagentId: subagent.id,
      agentId: parentAgentId,
      chatSessionId
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await mutateState(config.instance, (state) => {
      const item = state.subagents.find((candidate) => candidate.id === subagent.id);
      if (!item) return;
      item.status = "failed";
      item.error = message;
      item.updatedAt = now();
    });
    if (message.startsWith("Cannot submit task: parent task ")) {
      // Translate the `submitTask` cancelled/failed-parent
      // rejection into the spawn_subagent vocabulary so the
      // existing tool-dispatch catch chain (which special-cases
      // `Cannot spawn subagent...`) converts it to a skipped tool
      // result.
      throw new Error(`Cannot spawn subagent: parent task ${parentTaskId} became terminal between record creation and task submission.`);
    }
    throw err;
  }

  // Respect a `cancelled` status that `cancelSubagent` may have
  // written between the `SubagentRecord` creation above and this
  // final attach mutation. An unconditional flip to `running`
  // would overwrite a deliberate cancel, leaving the subagent
  // record running against a freshly submitted child task the
  // operator already asked us not to run. When the record was
  // cancelled mid-spawn we ALSO cancel the just-submitted child
  // task — otherwise the operator's intent is preserved at the
  // record level but the side-effect-capable task survives.
  const attachResult = await mutateState(config.instance, (state) => {
    const item = state.subagents.find((candidate) => candidate.id === subagent.id);
    if (!item) return { childTaskShouldCancel: false as const };
    item.taskId = task.id;
    // Link the worker task to its chat session so getChatSession picks up the
    // in-flight task (and synthesizes a placeholder) the same way dispatchPromptRun
    // does for a job's own session. A session deleted mid-spawn just skips this.
    if (chatSessionId) {
      const session = state.chatSessions.find((candidate) => candidate.id === chatSessionId);
      if (session && !session.taskIds.includes(task.id)) {
        session.taskIds.push(task.id);
        session.updatedAt = now();
      }
    }
    if (item.status === "cancelled" || item.status === "failed") {
      // Keep the prior terminal verdict; just record the taskId so
      // observability tools can correlate the audit trail. Signal
      // the post-mutation code to cancel the freshly-submitted
      // child task too.
      item.updatedAt = now();
      return { childTaskShouldCancel: true as const, recordStatus: item.status };
    }
    item.status = "running";
    item.updatedAt = now();
    return { childTaskShouldCancel: false as const };
  });
  if (attachResult.childTaskShouldCancel) {
    appendTrace(config.instance, task.id, {
      type: "task",
      message: `Subagent record was ${attachResult.recordStatus} mid-spawn; cancelling freshly submitted child task`,
      data: { subagentId: subagent.id, recordStatus: attachResult.recordStatus }
    });
    try {
      await cancelTask(config, task.id);
    } catch {
      // Best-effort — if the child task race-completes faster than
      // the cancel, the cascade is moot. The record's terminal
      // verdict already reflects the operator's intent.
    }
  }

  appendTrace(config.instance, task.id, {
    type: "tool",
    message: "Subagent spawned",
    data: {
      subagentId: subagent.id,
      parentTaskId,
      toolsetIds,
      skillNames,
      systemPromptBytes: systemPrompt.length
    }
  });

  return { ...subagent, taskId: task.id, status: "running", systemPrompt, toolsetIds, skillNames, goal, context };
}

// Refresh subagent statuses by joining against their child tasks. Pulls
// summary/error onto resultSummary/resultError so callers don't need to
// resolve the task separately.
export async function refreshSubagents(config: RuntimeConfig): Promise<SubagentRecord[]> {
  return mutateState(config.instance, (state) => {
    for (const subagent of state.subagents) {
      if (!subagent.taskId) continue;
      if (
        subagent.status === "completed" ||
        subagent.status === "failed" ||
        subagent.status === "cancelled"
      ) {
        continue;
      }
      const task = state.tasks.find((item) => item.id === subagent.taskId);
      if (!task) continue;
      if (task.status === "completed") {
        subagent.status = "completed";
        subagent.completedAt = now();
        subagent.summary = task.summary;
        subagent.resultSummary = task.summary;
        if (task.needsInput) subagent.resultNeedsInput = task.needsInput;
        subagent.updatedAt = subagent.completedAt;
      } else if (task.status === "failed") {
        subagent.status = "failed";
        subagent.completedAt = now();
        subagent.error = task.error;
        subagent.resultError = task.error;
        subagent.updatedAt = subagent.completedAt;
      } else if (task.status === "cancelled") {
        subagent.status = "cancelled";
        subagent.completedAt = now();
        subagent.error = subagent.error ?? "Cancelled";
        subagent.resultError = subagent.resultError ?? "Cancelled";
        subagent.updatedAt = subagent.completedAt;
      }
    }
    return state.subagents;
  });
}

export async function listSubagents(config: RuntimeConfig): Promise<SubagentRecord[]> {
  await refreshSubagents(config);
  return readState(config.instance).subagents;
}

// Cancel a running subagent by cancelling its underlying child task. The
// next refreshSubagents tick will mirror the cancelled task into the
// SubagentRecord. If the subagent has no taskId yet (still queued in the
// micro-window between createSubagentRecord and submitTask), we set the
// status directly to "cancelled".
export async function cancelSubagent(config: RuntimeConfig, subagentId: string): Promise<SubagentRecord> {
  const stage = await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) throw new Error(`Subagent not found: ${subagentId}`);
    return { taskId: sub.taskId, status: sub.status };
  });
  if (stage.taskId && stage.status !== "completed" && stage.status !== "failed" && stage.status !== "cancelled") {
    try {
      await cancelTask(config, stage.taskId);
    } catch {
      // Race: the task was finalized between read and cancel. Fall through
      // to refresh and let the join sync the record.
    }
  }
  await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) return;
    if (sub.status !== "completed" && sub.status !== "failed") {
      sub.status = "cancelled";
      sub.completedAt = sub.completedAt ?? now();
      sub.updatedAt = sub.completedAt;
    }
  });
  await refreshSubagents(config);
  const final = readState(config.instance).subagents.find((item) => item.id === subagentId);
  if (!final) throw new Error(`Subagent disappeared: ${subagentId}`);
  return final;
}

// Resolve the SubagentRecord for a given task, or undefined if the task
// isn't a subagent child. Used by the chat-task loop to apply constraints.
export function getSubagentForTask(state: RuntimeState, task: Task): SubagentRecord | undefined {
  if (!task.subagentId) return undefined;
  return state.subagents.find((item) => item.id === task.subagentId);
}

// Apply terminal status to the SubagentRecord linked to a task. Called from
// the chat-task loop right after the task transitions to a terminal state
// so the parent's polling loop sees the result on the next tick without
// waiting for an external refresh.
export async function syncSubagentFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!task.subagentId) return;
  await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === task.subagentId);
    if (!sub) return;
    if (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled") return;
    if (task.status === "completed") {
      sub.status = "completed";
      sub.completedAt = now();
      sub.summary = task.summary;
      sub.resultSummary = task.summary;
      if (task.needsInput) sub.resultNeedsInput = task.needsInput;
      sub.updatedAt = sub.completedAt;
    } else if (task.status === "failed") {
      sub.status = "failed";
      sub.completedAt = now();
      sub.error = task.error;
      sub.resultError = task.error;
      sub.updatedAt = sub.completedAt;
    } else if (task.status === "cancelled") {
      sub.status = "cancelled";
      sub.completedAt = now();
      sub.error = sub.error ?? "Cancelled";
      sub.resultError = sub.resultError ?? "Cancelled";
      sub.updatedAt = sub.completedAt;
    }
  });
}
