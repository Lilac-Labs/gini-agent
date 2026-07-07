// Derived container attention. A container's attention state is computed on
// read from persisted facts (tasks, pending gates, acknowledgedAt) — it is
// NEVER stored on the ChatSessionRecord. Precedence:
//
//   needs_input > review > working > done_unacknowledged > none
//
//   - needs_input: a live run is parked on a pending `chat.choice`
//     SetupRequest (the ask_user card).
//   - review: a live run is parked on a pending Authorization (an agent-actor
//     gate the user approves/denies — a confirm/send card).
//   - working: a live run exists with no pending user decision.
//   - done_unacknowledged: the latest terminal run outcome is newer than the
//     container's `acknowledgedAt` (or it was never acknowledged).
//   - none: nothing live and the latest outcome (if any) is acknowledged.
//
// Callers iterating many sessions (GET /api/home) build the gate/task index
// once via buildContainerAttentionIndex and pass it in, the same
// pre-indexing listChatSessions does for its pending-gate counts.

import type {
  Authorization,
  ChatSessionRecord,
  ContainerAttention,
  RuntimeState,
  SetupRequest,
  Task
} from "../types";
import { isTerminalTaskStatus } from "./store";

export interface ContainerAttentionIndex {
  tasksBySession: Map<string, Task[]>;
  // Pending gates keyed by taskId, in state order (newest first — both
  // collections unshift on create).
  pendingChoicesByTask: Map<string, SetupRequest[]>;
  pendingAuthorizationsByTask: Map<string, Authorization[]>;
}

export function buildContainerAttentionIndex(state: RuntimeState): ContainerAttentionIndex {
  const tasksBySession = new Map<string, Task[]>();
  for (const task of state.tasks) {
    if (!task.chatSessionId) continue;
    const list = tasksBySession.get(task.chatSessionId);
    if (list) list.push(task);
    else tasksBySession.set(task.chatSessionId, [task]);
  }
  const pendingChoicesByTask = new Map<string, SetupRequest[]>();
  for (const setup of state.setupRequests) {
    if (setup.status !== "pending" || setup.action !== "chat.choice" || !setup.taskId) continue;
    const list = pendingChoicesByTask.get(setup.taskId);
    if (list) list.push(setup);
    else pendingChoicesByTask.set(setup.taskId, [setup]);
  }
  const pendingAuthorizationsByTask = new Map<string, Authorization[]>();
  for (const auth of state.authorizations) {
    if (auth.status !== "pending" || !auth.taskId) continue;
    const list = pendingAuthorizationsByTask.get(auth.taskId);
    if (list) list.push(auth);
    else pendingAuthorizationsByTask.set(auth.taskId, [auth]);
  }
  return { tasksBySession, pendingChoicesByTask, pendingAuthorizationsByTask };
}

export function deriveContainerAttention(
  state: RuntimeState,
  session: ChatSessionRecord,
  index: ContainerAttentionIndex = buildContainerAttentionIndex(state)
): ContainerAttention {
  let hasLive = false;
  let hasPendingChoice = false;
  let hasPendingAuthorization = false;
  for (const task of index.tasksBySession.get(session.id) ?? []) {
    if (isTerminalTaskStatus(task.status)) continue;
    hasLive = true;
    // The stored `needs_input` status and the gate-derived signal are the
    // same fact; the gate derivation stays as the fallback for the
    // GINI_NEEDS_INPUT_STATUS=0 escape hatch (which parks the same gates
    // under `waiting_approval`).
    if (task.status === "needs_input") hasPendingChoice = true;
    if ((index.pendingChoicesByTask.get(task.id) ?? []).length > 0) hasPendingChoice = true;
    if ((index.pendingAuthorizationsByTask.get(task.id) ?? []).length > 0) hasPendingAuthorization = true;
  }
  if (hasPendingChoice) return "needs_input";
  if (hasPendingAuthorization) return "review";
  if (hasLive) return "working";
  const outcome = latestRunOutcome(state, session, index);
  if (outcome && (!session.acknowledgedAt || session.acknowledgedAt < outcome.at)) {
    return "done_unacknowledged";
  }
  return "none";
}

// The newest terminal run outcome for a container: what the home outcome line
// renders and what `acknowledgedAt` is compared against. Any terminal status
// counts — a failure or cancellation is still an outcome the checkbox clears.
export interface ContainerRunOutcome {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  at: string;
}

export function latestRunOutcome(
  state: RuntimeState,
  session: ChatSessionRecord,
  index: ContainerAttentionIndex = buildContainerAttentionIndex(state)
): ContainerRunOutcome | undefined {
  let latest: Task | undefined;
  for (const task of index.tasksBySession.get(session.id) ?? []) {
    if (!isTerminalTaskStatus(task.status)) continue;
    if (!latest || task.updatedAt > latest.updatedAt) latest = task;
  }
  if (!latest) return undefined;
  return {
    taskId: latest.id,
    status: latest.status as ContainerRunOutcome["status"],
    summary: latest.summary,
    error: latest.error,
    at: latest.updatedAt
  };
}
