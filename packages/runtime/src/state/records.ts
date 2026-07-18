import type {
  Authorization,
  ChatMessageRecord,
  ChatSessionRecord,
  ConnectorRecord,
  ImportReport,
  ImprovementProposal,
  JobRecord,
  JobRunRecord,
  Instance,
  McpServerRecord,
  MessagingBridgeRecord,
  MessagingMessageRecord,
  NotificationRecord,
  PendingChatMessage,
  AgentRecord,
  PromotionProposal,
  RelayRecord,
  RunRecord,
  RuntimeState,
  SetupRequest,
  SkillRecord,
  SkillOutcome,
  LearningFinding,
  SnapshotRecord,
  SubagentRecord,
  Task,
  TunnelSelectionRecord,
  PlanStepRecord
} from "../types";
import { id, now } from "./ids";
import { addAudit, appendEvent, type AgentContext } from "./audit";
import { deleteChatBlocksForSession } from "./chat-blocks";
import { tracePath } from "./trace";
import { isTerminalTaskStatus } from "./store";

export function taskCounts(tasks: Task[]): Record<Task["status"], number> {
  return {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    waiting_approval: tasks.filter((task) => task.status === "waiting_approval").length,
    needs_input: tasks.filter((task) => task.status === "needs_input").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length
  };
}

export function upsertTask(state: RuntimeState, task: Task): Task {
  const index = state.tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  return task;
}

// Appends streamed delta text to a task's `partialSummary`, bumping
// updatedAt. Used by runTask to expose mid-flight provider output to the
// chat UI without waiting for the buffered final response. Silently no-ops
// if the task no longer exists (cancellation race).
export function appendTaskPartial(state: RuntimeState, taskId: string, delta: string): void {
  if (!delta) return;
  const task = state.tasks.find((existing) => existing.id === taskId);
  if (!task) return;
  task.partialSummary = (task.partialSummary ?? "") + delta;
  task.updatedAt = now();
}

export function createTask(
  instance: Instance,
  input: string,
  jobId?: string,
  parentTaskId?: string,
  subagentId?: string,
  runId?: string,
  agentId?: string,
  chatSessionId?: string
): Task {
  const at = now();
  const taskId = id("task");
  return {
    id: taskId,
    title: input.slice(0, 80) || "Untitled task",
    input,
    status: "queued",
    instance,
    agentId,
    createdAt: at,
    updatedAt: at,
    tracePath: tracePath(instance, taskId),
    auditIds: [],
    approvalIds: [],
    skillIds: [],
    jobId,
    parentTaskId,
    subagentId,
    runId,
    chatSessionId
  };
}

export function createRun(
  state: RuntimeState,
  run: Omit<RunRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "planStepIds" | "childRunIds" | "approvalIds">
): RunRecord {
  const at = now();
  const item: RunRecord = {
    id: id("run"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    planStepIds: [],
    childRunIds: [],
    approvalIds: [],
    ...run
  };
  state.runs.unshift(item);
  if (item.parentRunId) {
    const parent = state.runs.find((candidate) => candidate.id === item.parentRunId);
    if (parent && !parent.childRunIds.includes(item.id)) parent.childRunIds.push(item.id);
  }
  if (item.conversationId) {
    const session = state.chatSessions.find((candidate) => candidate.id === item.conversationId);
    if (session && !session.runIds.includes(item.id)) {
      session.runIds.push(item.id);
      session.updatedAt = at;
    }
  }
  // Resolve the originating agent so the run.created event lands under the
  // right inbox even when the run is bound to a chat session or scheduled
  // job whose owning agent isn't the currently active one. taskId resolves
  // later (via linkRunToTask) so don't rely on it here — chain
  // session → job → system instead.
  appendEvent(
    state,
    {
      kind: "run",
      action: "run.created",
      target: item.id,
      runId: item.id,
      risk: "low",
      summary: item.title,
      data: { kind: item.kind, conversationId: item.conversationId, parentRunId: item.parentRunId },
      jobId: item.jobId
    },
    item.conversationId
      ? { sessionId: item.conversationId }
      : item.jobId
        ? { jobId: item.jobId }
        : { system: true }
  );
  return item;
}

export function createPlanStep(
  state: RuntimeState,
  step: Omit<PlanStepRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): PlanStepRecord {
  const at = now();
  const item: PlanStepRecord = {
    id: id("step"),
    instance: state.instance,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...step
  };
  state.planSteps.unshift(item);
  const run = state.runs.find((candidate) => candidate.id === item.runId);
  if (run && !run.planStepIds.includes(item.id)) run.planStepIds.push(item.id);
  // Walk the parent run (conversationId -> session, jobId -> job, taskId
  // -> task) so the step event inherits the same agent attribution as
  // run.created. AgentContext keeps the chain explicit at the call site.
  const stepTaskId = item.taskId ?? run?.taskId;
  const stepAgent: AgentContext = run?.conversationId
    ? { sessionId: run.conversationId }
    : run?.jobId
      ? { jobId: run.jobId }
      : stepTaskId
        ? { taskId: stepTaskId }
        : { system: true };
  appendEvent(
    state,
    {
      kind: "run",
      action: "run.step.created",
      target: item.runId,
      runId: item.runId,
      taskId: stepTaskId,
      risk: "low",
      summary: item.title,
      data: { stepId: item.id },
      jobId: run?.jobId
    },
    stepAgent
  );
  return item;
}

export function createChatSession(
  state: RuntimeState,
  title: string,
  source?: ChatSessionRecord["source"],
  agentId?: string,
  origin?: ChatSessionRecord["origin"],
  kind?: ChatSessionRecord["kind"]
): ChatSessionRecord {
  const at = now();
  const session: ChatSessionRecord = {
    id: id("chat"),
    instance: state.instance,
    agentId,
    title: title.slice(0, 80) || "Untitled chat",
    createdAt: at,
    updatedAt: at,
    messageIds: [],
    taskIds: [],
    runIds: [],
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
    ...(kind ? { kind } : {})
  };
  state.chatSessions.unshift(session);
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.created",
      target: session.id,
      risk: "low",
      summary: `Chat session created: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Mint a subject-scoped Topic session (`kind:"topic"`) with its own isolated
// context window (ADR chat-topics-tasks-subagents.md). A Topic reuses the
// chat-session machinery (block stream, SSE, read-state); `title` is the
// topic's display name and `parentChatSessionId` records the Chat that
// spawned it (for later forward-back).
export function createTopic(
  state: RuntimeState,
  opts: {
    agentId?: string;
    title: string;
    parentChatSessionId?: string;
    origin?: ChatSessionRecord["origin"];
    topicSummary?: string;
    // Container facts (see the field comments on ChatSessionRecord). All
    // opt-in: `pinned` is a user gesture only, `headless` hides the container
    // from chrome, `correlationKey` + `spawnedByTaskId` record an idempotent
    // spawn's identity/provenance, `surfaced` marks an agent-created
    // container as user-facing.
    pinned?: boolean;
    headless?: boolean;
    correlationKey?: string;
    spawnedByTaskId?: string;
    surfaced?: boolean;
    startedAs?: ChatSessionRecord["startedAs"];
  }
): ChatSessionRecord {
  const session = createChatSession(state, opts.title, undefined, opts.agentId, opts.origin, "topic");
  if (opts.parentChatSessionId) session.parentChatSessionId = opts.parentChatSessionId;
  if (opts.topicSummary) session.topicSummary = opts.topicSummary;
  // Always serialized (false, not omitted): a fresh gateway must serve the
  // `pinned` field on every topic so pinned-aware clients (mobile's sidebar
  // heuristic) can tell "unpinned" apart from "old gateway without pinning".
  session.pinned = opts.pinned === true;
  if (opts.headless) session.headless = true;
  if (opts.correlationKey) session.correlationKey = opts.correlationKey;
  if (opts.spawnedByTaskId) session.spawnedByTaskId = opts.spawnedByTaskId;
  if (opts.surfaced) session.surfaced = true;
  if (opts.startedAs) session.startedAs = opts.startedAs;
  return session;
}

// Container vocabulary alias. In the unified task model a work-item "task
// container" IS a `kind:"topic"` chat session — a topic is just a task
// container the user pinned. New call sites should prefer this name.
export const createTaskContainer = createTopic;

// Stamp the home checkbox: the user acknowledged the container's latest
// outcome, so derived attention (state/attention.ts) decays
// `done_unacknowledged` to `none`. Deliberately does NOT bump `updatedAt` —
// checking a row off is a read gesture, not new activity, and must not
// re-sort recency-ordered session lists.
export function acknowledgeContainer(state: RuntimeState, id: string): ChatSessionRecord {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);
  session.acknowledgedAt = now();
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.acknowledged",
      target: session.id,
      risk: "low",
      summary: `Container acknowledged: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Pin/unpin a container. Pinning is a user gesture — the sidebar lists
// `pinned === true` only, and nothing the agent or router creates is ever
// auto-pinned.
export function setContainerPinned(state: RuntimeState, id: string, pinned: boolean): ChatSessionRecord {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);
  session.pinned = pinned;
  session.updatedAt = now();
  appendEvent(
    state,
    {
      kind: "task",
      action: pinned ? "chat.session.pinned" : "chat.session.unpinned",
      target: session.id,
      risk: "low",
      summary: `Container ${pinned ? "pinned" : "unpinned"}: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Archive / un-archive a container. Archiving stamps `archivedAt`, which
// hides the container from every list surface (sidebar sections, home
// candidates, channel rails) while keeping its full history directly
// addressable (GET /api/chat/<id>, deep links). Idempotent: re-asserting the
// current state returns the session unchanged — no event, no updatedAt bump —
// mirroring archiveAgent's double-archive semantics.
export function setContainerArchived(state: RuntimeState, id: string, archived: boolean): ChatSessionRecord {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);
  if (archived === Boolean(session.archivedAt)) return session;
  if (archived) session.archivedAt = now();
  else delete session.archivedAt;
  session.updatedAt = now();
  appendEvent(
    state,
    {
      kind: "task",
      action: archived ? "chat.session.archived" : "chat.session.unarchived",
      target: session.id,
      risk: "low",
      summary: `Container ${archived ? "archived" : "unarchived"}: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Idempotent-spawn lookup: the existing child container of `parentId` minted
// under `key`, if any. Linear scan; deliberately does NOT filter
// `archivedAt`/`acknowledgedAt` — dedup must survive the user dismissing or
// archiving the child, or a re-firing spawner (e.g. a watch job) would
// re-mint the same finding after cleanup.
export function findChildContainerByCorrelationKey(
  state: RuntimeState,
  parentId: string,
  key: string
): ChatSessionRecord | undefined {
  return state.chatSessions.find(
    (session) => session.parentChatSessionId === parentId && session.correlationKey === key
  );
}

// Find an existing chat session bound to a (bridge, chat_id) pair, or
// create one. We key on the bridge id + chat id so that if a user
// disables and re-creates the bridge, conversations from a different
// bridge id start fresh (which matches the user's mental model: a new
// bridge is a new bot).
export function findOrCreateTelegramChatSession(
  state: RuntimeState,
  bridgeId: string,
  chatId: number
): ChatSessionRecord {
  const target = String(chatId);
  const existing = state.chatSessions.find((session) =>
    session.source?.kind === "telegram" &&
    session.source.bridgeId === bridgeId &&
    session.source.chatId === chatId
  );
  if (existing) return existing;
  return createChatSession(state, `Telegram chat ${target}`, {
    kind: "telegram",
    bridgeId,
    chatId,
    target
  }, state.activeAgentId);
}

// Discord channels map 1:1 to chat sessions. We key on (bridgeId,
// channelId) so re-creating the bridge starts a fresh conversation —
// same mental model as Telegram. The target is the channel snowflake
// the dispatcher hands back to sendMessagingOutput.
export function findOrCreateDiscordChatSession(
  state: RuntimeState,
  bridgeId: string,
  channelId: string
): ChatSessionRecord {
  const existing = state.chatSessions.find((session) =>
    session.source?.kind === "discord" &&
    session.source.bridgeId === bridgeId &&
    session.source.channelId === channelId
  );
  if (existing) return existing;
  return createChatSession(state, `Discord channel ${channelId}`, {
    kind: "discord",
    bridgeId,
    channelId,
    target: channelId
  });
}

// Slack DM sessions are per-THREAD, not per-channel — each top-level
// DM message starts its own thread (and its own chat session); replies
// typed inside that thread continue the same session. We key on
// (bridgeId, channelId, threadTs) where threadTs is the thread ROOT
// ts, so re-creating the bridge starts fresh conversations — same
// mental model as Telegram / Discord. The target is the DM channel id
// the dispatcher hands back to sendMessagingOutput; threadTs is the
// outbound thread anchor (chat.postMessage's thread_ts).
export function findOrCreateSlackChatSession(
  state: RuntimeState,
  bridgeId: string,
  channelId: string,
  threadTs: string
): ChatSessionRecord {
  const existing = state.chatSessions.find((session) =>
    session.source?.kind === "slack" &&
    session.source.bridgeId === bridgeId &&
    session.source.channelId === channelId &&
    session.source.threadTs === threadTs
  );
  if (existing) return existing;
  return createChatSession(state, `Slack thread ${threadTs}`, {
    kind: "slack",
    bridgeId,
    channelId,
    threadTs,
    target: channelId
  });
}

export function deleteChatSession(state: RuntimeState, id: string): ChatSessionRecord {
  const index = state.chatSessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`Chat session not found: ${id}`);
  const session = state.chatSessions[index]!;
  state.chatSessions.splice(index, 1);
  state.chatMessages = state.chatMessages.filter((message) => message.sessionId !== id);
  // ChatBlock rows (ADR chat-block-protocol.md) live in SQLite, parallel
  // to the legacy ChatMessageRecord list above. Drop them at the same
  // boundary so a deleted session doesn't leave orphan block rows the
  // /blocks endpoint would surface after re-create. Best-effort: a SQLite
  // open failure here must not abort the in-memory state delete (the
  // rest of the cleanup is irreversibly written above), so we swallow
  // errors and log via console.warn so operators can spot drift.
  try {
    deleteChatBlocksForSession(state.instance, id);
  } catch (error) {
    console.warn(
      `[chat-blocks] cascade delete failed for session ${id}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  // Identity snapshots are keyed on conversationId (the chat session id),
  // so removing the session must drop the matching snapshot or we leak
  // one IdentitySnapshotRecord per deleted chat forever.
  if (state.identitySnapshots) {
    delete state.identitySnapshots[id];
  }
  // The session record is gone from state.chatSessions; resolve via the
  // captured agentId so the event still attributes to the owner.
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.deleted",
      target: id,
      risk: "low",
      summary: `Chat session deleted: ${session.title}`
    },
    session.agentId ? { agentId: session.agentId } : { system: true }
  );
  return session;
}

export function renameChatSession(state: RuntimeState, id: string, title: string): ChatSessionRecord {
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);
  const trimmed = title.trim();
  session.title = (trimmed ? trimmed.slice(0, 80) : "") || "Untitled chat";
  session.updatedAt = now();
  appendEvent(
    state,
    {
      kind: "task",
      action: "chat.session.renamed",
      target: session.id,
      risk: "low",
      summary: `Chat session renamed: ${session.title}`
    },
    { sessionId: session.id }
  );
  return session;
}

// Append a message to the session's FIFO pending-message queue (ADR
// chat-message-queue.md). Called inside mutateState while a turn is already in
// flight for the session; the returned record carries the allocated id +
// createdAt so the caller can publish it and return the pendingId.
export function enqueuePendingChatMessage(
  state: RuntimeState,
  sessionId: string,
  msg: Omit<PendingChatMessage, "id" | "createdAt">
): PendingChatMessage {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Chat session not found: ${sessionId}`);
  const pending: PendingChatMessage = {
    id: id("pending"),
    createdAt: now(),
    ...msg
  };
  if (!session.pendingMessages) session.pendingMessages = [];
  session.pendingMessages.push(pending);
  return pending;
}

// Remove a queued message by id. Returns whether anything was removed so the
// caller can decide whether to publish the updated session.
export function removePendingChatMessage(
  state: RuntimeState,
  sessionId: string,
  pendingId: string
): boolean {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session?.pendingMessages) return false;
  const index = session.pendingMessages.findIndex((item) => item.id === pendingId);
  if (index < 0) return false;
  session.pendingMessages.splice(index, 1);
  return true;
}

// Pop the first queued message (FIFO) for auto-dispatch when a turn ends.
// Returns undefined if the queue is empty or the session is gone.
export function shiftPendingChatMessage(
  state: RuntimeState,
  sessionId: string
): PendingChatMessage | undefined {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session?.pendingMessages || session.pendingMessages.length === 0) return undefined;
  return session.pendingMessages.shift();
}

// True when a non-terminal chat task is already running for the session.
// Queued/running/waiting_approval/needs_input all count as in-flight; the
// enqueue policy treats this as "a turn is busy" so a new message queues
// instead of starting a concurrent task.
export function sessionHasInFlightChatTask(state: RuntimeState, sessionId: string): boolean {
  return state.tasks.some((t) => t.chatSessionId === sessionId && !isTerminalTaskStatus(t.status));
}

// Monotonic counter stamped onto every chat message as `seq`. Several
// transcript rows (assistant tool_calls + its paired tool results) can be
// created within the same millisecond, so createdAt alone can't order them;
// seq is the stable tiebreaker replay sorts on. It only needs to be monotonic
// within a process run — across restarts createdAt differs, so a reset counter
// is harmless.
let chatMessageSeq = 0;

export function createChatMessage(
  state: RuntimeState,
  message: Omit<ChatMessageRecord, "id" | "instance" | "createdAt">
): ChatMessageRecord {
  const item: ChatMessageRecord = {
    id: id("msg"),
    instance: state.instance,
    createdAt: now(),
    seq: chatMessageSeq++,
    ...message
  };
  state.chatMessages.push(item);
  const session = state.chatSessions.find((candidate) => candidate.id === item.sessionId);
  if (session) {
    session.messageIds.push(item.id);
    if (item.taskId && !session.taskIds.includes(item.taskId)) session.taskIds.push(item.taskId);
    if (item.runId && !session.runIds.includes(item.runId)) session.runIds.push(item.runId);
    session.updatedAt = item.createdAt;
    // Tool-transcript rows are model-facing replay state, not human-facing
    // summaries; only let a real assistant turn drive the session summary.
    if (item.role === "assistant" && item.kind !== "tool_transcript") {
      session.summary = item.content.slice(0, 240);
    }
  }
  return item;
}

// Mint an Authorization (agent-actor gate). Resolves via
// /api/authorizations/<id>/{approve,deny}; the runtime performs the
// side-effecting action on approval. See
// docs/adr/authorization-vs-setup-request.md.
export function createAuthorization(
  state: RuntimeState,
  authorization: Omit<Authorization, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): Authorization {
  const at = now();
  // Inherit agentId from the originating task when the caller didn't supply
  // one. Authorizations follow the task that requested them — that's the
  // agent whose inbox the row should land in.
  const taskAgentId = authorization.taskId
    ? state.tasks.find((task) => task.id === authorization.taskId)?.agentId
    : undefined;
  const item: Authorization = {
    id: id("authz"),
    instance: state.instance,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...authorization,
    agentId: authorization.agentId ?? taskAgentId
  };
  state.authorizations.unshift(item);
  addAudit(
    state,
    {
      actor: "runtime",
      action: "authorization.requested",
      target: item.target,
      risk: item.risk,
      taskId: item.taskId,
      approvalId: item.id,
      evidence: { action: item.action, reason: item.reason }
    },
    item.taskId
      ? { taskId: item.taskId, agentId: item.agentId }
      : item.agentId
        ? { agentId: item.agentId }
        : { system: true }
  );
  return item;
}

// Mint a SetupRequest (user-actor gate). Resolves via
// /api/setup-requests/<id>/{complete,cancel}. The side effect (e.g.
// connectBrowser, createConnector, playwright.fill) executes inside the
// /complete endpoint before the request is marked completed. See
// docs/adr/authorization-vs-setup-request.md.
export function createSetupRequest(
  state: RuntimeState,
  setupRequest: Omit<SetupRequest, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): SetupRequest {
  const at = now();
  const taskAgentId = setupRequest.taskId
    ? state.tasks.find((task) => task.id === setupRequest.taskId)?.agentId
    : undefined;
  const item: SetupRequest = {
    id: id("setup"),
    instance: state.instance,
    status: "pending",
    createdAt: at,
    updatedAt: at,
    ...setupRequest,
    agentId: setupRequest.agentId ?? taskAgentId
  };
  state.setupRequests.unshift(item);
  // Per-action audit risk is preserved by the calling site (e.g. the
  // browser-fill-secret dispatcher stamps `risk: "high"` on its credential
  // audit row). The setup.requested envelope itself is informational and
  // carries no risk classification.
  addAudit(
    state,
    {
      actor: "runtime",
      action: "setup.requested",
      target: item.target,
      risk: "low",
      taskId: item.taskId,
      approvalId: item.id,
      evidence: { action: item.action, reason: item.reason }
    },
    item.taskId
      ? { taskId: item.taskId, agentId: item.agentId }
      : item.agentId
        ? { agentId: item.agentId }
        : { system: true }
  );
  return item;
}

export function createSkill(
  state: RuntimeState,
  skill: Omit<SkillRecord, "id" | "instance" | "createdAt" | "updatedAt" | "version" | "tests" | "successCount" | "failureCount" | "previousVersions" | "body"> & Partial<Pick<SkillRecord, "tests" | "successCount" | "failureCount" | "previousVersions" | "body" | "manifestPath" | "category" | "platforms" | "prerequisites" | "requiredConnectors" | "requiredCredentials" | "grantedConnectors" | "allowedTools" | "license" | "compatibility" | "manifestVersion" | "validationStatus" | "validationMessage" | "source">>
): SkillRecord {
  const at = now();
  const item: SkillRecord = {
    id: id("skill"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    version: 1,
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...skill
  };
  state.skills.unshift(item);
  return item;
}

export function createJob(
  state: RuntimeState,
  job: Omit<JobRecord, "id" | "instance" | "createdAt" | "updatedAt" | "status" | "lastRunAt" | "lastSuccessAt" | "lastFailureAt" | "lastError" | "runCount" | "missedRuns" | "taskIds" | "runIds" | "deliveryTargets" | "context" | "retryLimit" | "timeoutSeconds"> & Partial<Pick<JobRecord, "runIds" | "deliveryTargets" | "context" | "retryLimit" | "timeoutSeconds">>
): JobRecord {
  const at = now();
  const item: JobRecord = {
    id: id("job"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    status: "active",
    deliveryTargets: [],
    context: [],
    retryLimit: 0,
    timeoutSeconds: 600,
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    runIds: [],
    ...job
  };
  state.jobs.unshift(item);
  return item;
}

export function createJobRun(
  state: RuntimeState,
  run: Omit<JobRunRecord, "id" | "instance" | "createdAt" | "updatedAt" | "status" | "attempt">
): JobRunRecord {
  const at = now();
  const item: JobRunRecord = {
    id: id("jobrun"),
    instance: state.instance,
    status: "running",
    attempt: state.jobRuns.filter((candidate) => candidate.jobId === run.jobId).length + 1,
    createdAt: at,
    updatedAt: at,
    ...run
  };
  state.jobRuns.unshift(item);
  appendEvent(
    state,
    {
      kind: "job",
      action: "job.run.started",
      target: run.jobId,
      jobId: run.jobId,
      risk: "low",
      summary: `Job run started for ${run.jobId}`,
      data: { runId: item.id, trigger: item.trigger }
    },
    { jobId: run.jobId, agentId: run.agentId }
  );
  return item;
}

export function createImprovementProposal(
  state: RuntimeState,
  proposal: Omit<ImprovementProposal, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): ImprovementProposal {
  const at = now();
  const item: ImprovementProposal = {
    id: id("impr"),
    instance: state.instance,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.improvements.unshift(item);
  addAudit(
    state,
    {
      actor: "agent",
      action: "improvement.proposed",
      target: item.id,
      risk: "medium",
      taskId: item.sourceTaskId,
      evidence: { kind: item.kind, sourceTraceIds: item.sourceTraceIds }
    },
    item.sourceTaskId ? { taskId: item.sourceTaskId } : { system: true }
  );
  return item;
}

// Newest-first ring caps for the skill-learning rows. Bounded so the harvest
// loop can never grow durable state without limit (same posture as the
// pairing/audit rings). skillOutcomes is capped PER SKILL, not globally — a
// global ring lets a high-volume skill evict a quiet skill's history, which
// would corrupt any per-skill reliability metric (one skill's N depending on
// another's activity). A generous global ceiling backstops total memory.
const MAX_SKILL_OUTCOMES_PER_SKILL = 100;
const MAX_SKILL_OUTCOMES = 5000;
const MAX_LEARNING_FINDINGS = 500;

// Record one skill-learning outcome (ADR skill-learning-from-outcomes.md).
// Writes via the caller's mutateState transaction; bounds the ring on insert.
export function createSkillOutcome(
  state: RuntimeState,
  outcome: Omit<SkillOutcome, "id" | "instance" | "createdAt">
): SkillOutcome {
  const item: SkillOutcome = {
    id: id("skillout"),
    instance: state.instance,
    createdAt: now(),
    ...outcome
  };
  state.skillOutcomes.unshift(item);
  // Trim only the inserted row's skill bucket to its per-skill cap (newest-first
  // order keeps the most recent). Other skills' rows are untouched, so a chatty
  // skill never crowds out a quiet one. The unattributed bucket (no skillId)
  // shares one key.
  const key = item.skillId ?? "";
  let kept = 0;
  state.skillOutcomes = state.skillOutcomes.filter((o) => {
    if ((o.skillId ?? "") !== key) return true;
    kept += 1;
    return kept <= MAX_SKILL_OUTCOMES_PER_SKILL;
  });
  // Global backstop across all skills.
  if (state.skillOutcomes.length > MAX_SKILL_OUTCOMES) {
    state.skillOutcomes = state.skillOutcomes.slice(0, MAX_SKILL_OUTCOMES);
  }
  return item;
}

// Record one non-skill-edit learning finding (environment / credential /
// model-ignored / bundled-skill). Surfaced in the digest; never auto-actioned.
export function createLearningFinding(
  state: RuntimeState,
  finding: Omit<LearningFinding, "id" | "instance" | "status" | "createdAt">
): LearningFinding {
  const item: LearningFinding = {
    id: id("finding"),
    instance: state.instance,
    status: "open",
    createdAt: now(),
    ...finding
  };
  state.learningFindings.unshift(item);
  if (state.learningFindings.length > MAX_LEARNING_FINDINGS) {
    state.learningFindings = state.learningFindings.slice(0, MAX_LEARNING_FINDINGS);
  }
  return item;
}

export function createPromotionProposal(
  state: RuntimeState,
  proposal: Omit<PromotionProposal, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): PromotionProposal {
  const at = now();
  const item: PromotionProposal = {
    id: id("promo"),
    instance: state.instance,
    status: "proposed",
    createdAt: at,
    updatedAt: at,
    ...proposal
  };
  state.promotions.unshift(item);
  // Promotions decide instance-wide runtime upgrades; they don't belong
  // to a specific agent.
  addAudit(
    state,
    {
      actor: "user",
      action: "promotion.proposed",
      target: item.id,
      risk: "medium",
      evidence: { candidateRef: item.candidateRef, evidencePath: item.evidencePath }
    },
    { system: true }
  );
  return item;
}

export function decidePromotion(
  state: RuntimeState,
  promotionId: string,
  decision: "approve" | "reject"
): PromotionProposal {
  const promotion = state.promotions.find((item) => item.id === promotionId);
  if (!promotion) throw new Error(`Promotion proposal not found: ${promotionId}`);
  if (promotion.status !== "proposed") throw new Error(`Promotion proposal is already ${promotion.status}`);
  promotion.status = decision === "approve" ? "approved" : "rejected";
  promotion.decidedAt = now();
  promotion.updatedAt = promotion.decidedAt;
  addAudit(
    state,
    {
      actor: "user",
      action: `promotion.${promotion.status}`,
      target: promotion.id,
      risk: "medium",
      evidence: { candidateRef: promotion.candidateRef }
    },
    { system: true }
  );
  return promotion;
}

export function createSnapshotRecord(
  state: RuntimeState,
  snapshot: Omit<SnapshotRecord, "id" | "instance" | "createdAt" | "taskCount" | "auditCount">
): SnapshotRecord {
  const item: SnapshotRecord = {
    id: id("snap"),
    instance: state.instance,
    createdAt: now(),
    taskCount: state.tasks.length,
    auditCount: state.audit.length,
    ...snapshot
  };
  state.snapshots.unshift(item);
  // Snapshots capture the whole instance, not a single agent's data.
  addAudit(
    state,
    {
      actor: "user",
      action: "snapshot.created",
      target: item.id,
      risk: "medium",
      evidence: { path: item.path, reason: item.reason }
    },
    { system: true }
  );
  return item;
}

export function createSubagentRecord(
  state: RuntimeState,
  subagent: Omit<SubagentRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): SubagentRecord {
  const at = now();
  const item: SubagentRecord = {
    id: id("subagent"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...subagent
  };
  state.subagents.unshift(item);
  addAudit(
    state,
    {
      actor: "agent",
      action: "subagent.created",
      target: item.id,
      risk: "medium",
      taskId: item.parentTaskId,
      evidence: { name: item.name, toolsets: item.toolsets }
    },
    item.parentTaskId
      ? { taskId: item.parentTaskId, agentId: item.agentId }
      : item.agentId
        ? { agentId: item.agentId }
        : { system: true }
  );
  return item;
}

export function createMcpServerRecord(
  state: RuntimeState,
  server: Omit<McpServerRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">,
  options: { actor?: "user" | "runtime" | "agent" } = {}
): McpServerRecord {
  const at = now();
  const item: McpServerRecord = {
    id: id("mcp"),
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...server
  };
  state.mcpServers.unshift(item);
  // MCP servers are configured at the instance level; tool invocations
  // later attribute to the calling task. `actor` defaults to "user"
  // because the CRUD path (`gini mcp add`, POST /api/mcp/servers) is the
  // common case; runtime-driven creation (auto-register from a connector)
  // overrides this so the audit row honestly attributes to the system.
  addAudit(
    state,
    {
      actor: options.actor ?? "user",
      action: "mcp.configured",
      target: item.id,
      risk: "medium",
      evidence: { name: item.name, exposedTools: item.exposedTools }
    },
    { system: true }
  );
  return item;
}

// Field-default builder shared between the runtime helper and the
// openclaw migrator. The migrator needs to pre-mint a bridge id
// before it writes the encrypted bot-token file (the secret path is
// `messaging.<bridgeId>.bot-token.json`, so the id has to be known
// up front), and it emits a richer audit row tagged with the
// migration source. Extracting the field-default shape here keeps
// the migrator from drifting when fields are added to
// MessagingBridgeRecord — both callers inherit the new defaults
// instead of one branch silently producing a record missing them.
export function buildMessagingBridgeRecord(
  state: RuntimeState,
  bridge: Omit<MessagingBridgeRecord, "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): MessagingBridgeRecord {
  const at = now();
  return {
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...bridge
  };
}

export function createMessagingBridgeRecord(
  state: RuntimeState,
  bridge: Omit<MessagingBridgeRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message"> & { id?: string }
): MessagingBridgeRecord {
  // Callers may pre-generate the id and pass it in (e.g. addMessagingBridge
  // does so to write the bot-token secret under the same namespace before
  // the state mutation lands, collapsing the create+attach-ref dance into
  // one atomic mutation). When omitted, mint a fresh id here.
  // Spread first so an explicit-undefined id in `bridge` (TypeScript's Omit
  // doesn't forbid `id: undefined`; only omits absence) doesn't overwrite
  // the resolved id below. The id field then wins because it's after the
  // spread.
  const item = buildMessagingBridgeRecord(state, { ...bridge, id: bridge.id ?? id("bridge") });
  state.messagingBridges.unshift(item);
  // Messaging bridges live at the instance level; per-agent target
  // filtering happens at send time.
  addAudit(
    state,
    {
      actor: "user",
      action: "messaging.configured",
      target: item.id,
      risk: "medium",
      evidence: { kind: item.kind, deliveryTargets: item.deliveryTargets }
    },
    { system: true }
  );
  return item;
}

export function createMessagingMessageRecord(
  state: RuntimeState,
  message: Omit<MessagingMessageRecord, "id" | "instance" | "createdAt" | "updatedAt">
): MessagingMessageRecord {
  const at = now();
  const item: MessagingMessageRecord = {
    id: id("message"),
    instance: state.instance,
    createdAt: at,
    updatedAt: at,
    ...message
  };
  state.messagingMessages.unshift(item);
  appendEvent(
    state,
    {
      kind: "messaging",
      action: `messaging.${item.direction}.${item.status}`,
      target: item.bridgeId,
      taskId: item.taskId,
      risk: "low",
      summary: `${item.direction} message ${item.status}`,
      data: { messageId: item.id, target: item.target }
    },
    item.taskId ? { taskId: item.taskId } : { system: true }
  );
  return item;
}

export function createImportReport(
  state: RuntimeState,
  report: Omit<ImportReport, "id" | "instance" | "createdAt">
): ImportReport {
  const item: ImportReport = {
    id: id("import"),
    instance: state.instance,
    createdAt: now(),
    ...report
  };
  state.importReports.unshift(item);
  // Audit action mirrors the report mode so a state-mutating apply
  // doesn't pretend to be a read-only inspection in the activity feed.
  addAudit(
    state,
    {
      actor: "user",
      action: item.mode === "applied" ? "import.applied" : "import.inspected",
      target: item.id,
      risk: item.mode === "applied" ? "medium" : "low",
      evidence: {
        source: item.source,
        path: item.path,
        mode: item.mode,
        status: item.status,
        counts: item.counts
      }
    },
    { system: true }
  );
  return item;
}

export function createAgentRecord(
  state: RuntimeState,
  agent: Omit<AgentRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): AgentRecord {
  const at = now();
  const item: AgentRecord = {
    id: id("agent"),
    instance: state.instance,
    status: "inactive",
    createdAt: at,
    updatedAt: at,
    ...agent
  };
  state.agents.unshift(item);
  // The new agent IS the subject — there's no parent agent to attribute
  // this to. The agent record itself is the inbox owner from here on.
  addAudit(
    state,
    {
      actor: "user",
      action: "agent.created",
      target: item.id,
      risk: "low",
      evidence: { name: item.name, toolsets: item.toolsets }
    },
    { agentId: item.id }
  );
  return item;
}

export function createRelayRecord(
  state: RuntimeState,
  relay: Omit<RelayRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt" | "lastHealthAt" | "message">
): RelayRecord {
  const at = now();
  const item: RelayRecord = {
    id: id("relay"),
    instance: state.instance,
    status: "configured",
    createdAt: at,
    updatedAt: at,
    ...relay
  };
  state.relays.unshift(item);
  // Relays are instance-level transport endpoints.
  addAudit(
    state,
    {
      actor: "user",
      action: "relay.configured",
      target: item.id,
      risk: "medium",
      evidence: { mode: item.mode, endpoint: item.endpoint }
    },
    { system: true }
  );
  return item;
}

// Mint (or, on re-entry, the field-default shape for) the tunnel selection
// singleton. Unlike most create* helpers this does NOT push onto a list —
// the tunnel is a singleton stored at `state.tunnel`. The integration module
// assigns the returned record to `state.tunnel` inside its mutateState
// callback. No audit row here; the
// integration emits action-specific audit rows (select/connect/disconnect)
// at its side-effecting call sites, matching createRelayRecord's split of
// "record shape" from "side-effect audit".
export function createTunnelRecord(
  state: RuntimeState,
  tunnel: Omit<TunnelSelectionRecord, "instance" | "createdAt" | "updatedAt">
): TunnelSelectionRecord {
  const at = now();
  // Authoritative metadata is spread LAST so it always wins: callers build
  // `tunnel` by spreading the prior persisted record (`...state.tunnel`), which
  // carries its own instance/createdAt/updatedAt — putting those first would let
  // stale values survive and freeze `updatedAt`. `createdAt` is preserved from
  // the prior record (or stamped now on first creation); `updatedAt` always
  // advances to now.
  return {
    ...tunnel,
    instance: state.instance,
    createdAt: state.tunnel?.createdAt ?? at,
    updatedAt: at
  };
}

export function createNotificationRecord(
  state: RuntimeState,
  notification: Omit<NotificationRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt">
): NotificationRecord {
  const at = now();
  const item: NotificationRecord = {
    id: id("notify"),
    instance: state.instance,
    status: "queued",
    createdAt: at,
    updatedAt: at,
    ...notification
  };
  state.notifications.unshift(item);
  addAudit(
    state,
    {
      actor: "runtime",
      action: "notification.queued",
      target: item.id,
      risk: "low",
      taskId: item.taskId,
      evidence: { kind: item.kind, target: item.target }
    },
    item.taskId ? { taskId: item.taskId } : { system: true }
  );
  return item;
}

export function activateAgent(state: RuntimeState, idOrName: string): AgentRecord {
  const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
  if (!agent) throw new Error(`Agent not found: ${idOrName}`);
  // An archived agent is soft-deleted: it can't be the active selection
  // until it's explicitly restored. Block activation outright rather than
  // silently un-archiving it as a side effect.
  if (agent.archivedAt) {
    throw new Error("Cannot use an archived agent; restore it first.");
  }
  for (const item of state.agents) item.status = item.id === agent.id ? "active" : "inactive";
  agent.updatedAt = now();
  state.activeAgentId = agent.id;
  // The just-activated agent owns this audit row — that's the agent the
  // operator is now switching into.
  addAudit(
    state,
    {
      actor: "user",
      action: "agent.activated",
      target: agent.id,
      risk: "low",
      evidence: { name: agent.name }
    },
    { agentId: agent.id }
  );
  return agent;
}

export function updateConnectorHealth(connector: ConnectorRecord): ConnectorRecord {
  connector.lastHealthAt = now();
  connector.health = connector.status === "configured" ? "healthy" : "unhealthy";
  connector.message = connector.provider === "demo" ? "Demo connector is available without secrets." : connector.message;
  connector.updatedAt = now();
  return connector;
}
