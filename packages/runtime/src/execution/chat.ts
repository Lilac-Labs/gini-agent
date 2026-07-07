import { ApprovalRaceLostError, cancelTask, resolveSetupRequest, submitTask } from "../agent";
import { persistConnectOutcome, resumeParkIfGatesSettled, safeResume } from "./safe-resume";
import {
  addAudit,
  appendEvent,
  appendLog,
  attachTaskToUserTextBlock,
  createChatMessage,
  createChatSession,
  createTaskContainer,
  createTopic,
  deleteChatBlock,
  deleteChatSession,
  enqueuePendingChatMessage,
  getLatestMessagesBySession,
  getMainChatBlock,
  insertChatBlock,
  isTerminalTaskStatus,
  latestRunOutcome,
  listChatBlocks,
  listThreadBlocks,
  mutateState,
  publishChatSession,
  readState,
  recordUsage,
  removePendingChatMessage,
  renameChatSession,
  sessionHasInFlightChatTask,
  shiftPendingChatMessage
} from "../state";
import type { AssistantTextBlock, AudioAttachment, ChatBlock, ChatClientSurface, ChatMessageRecord, ChatSessionRecord, ImageAttachment, Instance, RuntimeConfig, TaskStatus, UserTextBlock } from "../types";
import { readUpload, uploadStat } from "../state/uploads";
import { getSttProvider } from "../stt";
import { generateStructured, providerAuthFailureText, providerDisplayLabel, providerReauth } from "../provider";
import { providerOverrideForRuntime, resolveEffectiveContext } from "./effective-context";
import { createConversationRun, linkRunToTask } from "./runs";
import { routeChatMessage } from "./chat-route";
import { isSilentReply } from "../jobs/silent";

// Statuses where a task is no longer producing partial text. Once a task
// reaches one of these, the synthesized streaming message is dropped in
// favor of the synced assistant message (or task error).
//
// waiting_approval is intentionally NOT in this set. Earlier, we persisted
// a real ChatMessageRecord for waiting_approval and
// the syncChatTaskResult short-circuit (`if (existing) return existing`)
// meant the placeholder text never updated even after the task completed.
// We now treat waiting_approval as in-flight and synthesize the placeholder
// ephemerally so it auto-replaces with the real summary on completion.
const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

const DEFAULT_CHAT_TITLES: ReadonlySet<string> = new Set([
  "Untitled chat",
  "New chat"
]);

const AUTO_RENAME_USER_TURNS = 2;
const AUTO_RENAME_ASSISTANT_TURNS = 2;

// Truncation cap for the latest-message preview attached to each chat
// list row. 140 leaves enough text for a one-liner subtitle on the
// mobile list without ballooning the wire payload.
const LAST_MESSAGE_PREVIEW_CHARS = 140;

// Cap for the topicSummary seeded from a new topic's originating message. The
// summary is a routing/retrieval descriptor surfaced to the intake router, so
// it carries the gist of the request without bloating the router prompt.
const TOPIC_SUMMARY_CHARS = 200;

// Trim and bound the originating message used as a new topic's summary.
function truncateTopicSummary(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > TOPIC_SUMMARY_CHARS
    ? `${trimmed.slice(0, TOPIC_SUMMARY_CHARS).trimEnd()}…`
    : trimmed;
}

export function listChatSessions(config: RuntimeConfig) {
  const state = readState(config.instance);
  // Single SQL pass returns the most recent user_text / assistant_text
  // block per session, so clients can render a "last message" subtitle
  // without N+1 fetches. Sessions with no qualifying blocks fall back to
  // null and the client renders just the title.
  const latestByCallId = getLatestMessagesBySession(config.instance);
  // Pre-index pending gates by taskId so the per-session count below is
  // O(taskIds) instead of O(sessions × approvals). Authorizations and
  // SetupRequests are two parallel approval surfaces with the same
  // "session is awaiting the user" semantics — both contribute to the
  // sidebar indicator.
  const pendingByTaskId = new Map<string, number>();
  for (const auth of state.authorizations) {
    if (auth.status !== "pending" || !auth.taskId) continue;
    pendingByTaskId.set(auth.taskId, (pendingByTaskId.get(auth.taskId) ?? 0) + 1);
  }
  for (const setup of state.setupRequests) {
    if (setup.status !== "pending" || !setup.taskId) continue;
    pendingByTaskId.set(setup.taskId, (pendingByTaskId.get(setup.taskId) ?? 0) + 1);
  }
  // Headless containers (a silent watch job's working thread) never surface
  // in chrome: excluded from this unscoped listing, though still directly
  // addressable by id (GET /api/chat/:id, deep links).
  return state.chatSessions.filter((session) => !session.headless).map((session) => {
    const raw = latestByCallId.get(session.id) ?? null;
    const lastMessagePreview = raw
      ? raw.length > LAST_MESSAGE_PREVIEW_CHARS
        ? `${raw.slice(0, LAST_MESSAGE_PREVIEW_CHARS).trimEnd()}…`
        : raw
      : null;
    let pendingApprovalCount = 0;
    for (const taskId of session.taskIds) {
      pendingApprovalCount += pendingByTaskId.get(taskId) ?? 0;
    }
    return {
      ...session,
      lastMessagePreview,
      pendingApprovalCount,
      messages: state.chatMessages.filter(
        (message) => message.sessionId === session.id && message.kind !== "tool_transcript"
      ),
      runs: state.runs.filter((run) => session.runIds.includes(run.id))
    };
  });
}

export function getChatSession(config: RuntimeConfig, id: string) {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === id);
  if (!session) throw new Error(`Chat session not found: ${id}`);

  const stored = state.chatMessages.filter(
    (message) => message.sessionId === id && message.kind !== "tool_transcript"
  );
  const tasks = state.tasks.filter((task) => session.taskIds.includes(task.id));

  // Synthesize transient streaming assistant messages: any in-flight task
  // with partialSummary or in waiting_approval that doesn't yet have a
  // synced assistant message gets a virtual ChatMessageRecord so the chat
  // UI sees text mid-flight (or the "Waiting for approval" placeholder).
  // Once the real synced message arrives, this branch is skipped and the
  // synthesized one disappears — the caller never sees both for the same
  // task.
  //
  // waiting_approval is included here so the placeholder updates
  // automatically when approval grants and the task completes;
  // previously we persisted a real ChatMessageRecord for waiting_approval
  // and the sync short-circuit froze the UI at "Waiting for approval".
  //
  // Approval-reason messages (kind: "approval_reason") are durable history
  // bubbles persisted at request_connector time so the user can scroll
  // back and see what they were asked. They are intentionally excluded
  // from this "task already has its summary" check — otherwise the
  // partial-summary streaming bubble for the same task (gws install,
  // gws auth login, etc.) would be suppressed after the approval
  // resolves and the user would see no progress until task completion.
  const syncedAssistantTaskIds = new Set(
    stored
      .filter((m) => m.role === "assistant" && m.taskId && m.kind !== "approval_reason")
      .map((m) => m.taskId as string)
  );
  const synthetic: ChatMessageRecord[] = [];
  for (const task of tasks) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (syncedAssistantTaskIds.has(task.id)) continue;
    let content: string | undefined;
    if (task.status === "waiting_approval" || task.status === "needs_input") {
      // A needs_input park is all-chat.choice by construction, so the
      // SetupRequest-only skip below always suppresses its placeholder —
      // the choice card is the UI.
      // connector.request approvals now persist their `reason` as a durable
      // assistant message at request_connector time (kind:"approval_reason"),
      // so no placeholder is needed for that case — the real message is in
      // `stored` already.
      const hasPersistedApprovalReason = stored.some(
        (m) => m.role === "assistant" && m.taskId === task.id && m.kind === "approval_reason"
      );
      if (hasPersistedApprovalReason) continue;
      // SetupRequest cards render their own self-describing UI (Connect /
      // credential inputs / Submit) — a generic "Waiting for approval..."
      // bubble next to that card is redundant. Skip the placeholder when
      // the pending gates for this task are all SetupRequests.
      const pendingAuthorizations = state.authorizations.filter(
        (a) => a.taskId === task.id && a.status === "pending"
      );
      const pendingSetupRequests = state.setupRequests.filter(
        (s) => s.taskId === task.id && s.status === "pending"
      );
      if (pendingAuthorizations.length === 0 && pendingSetupRequests.length > 0) {
        continue;
      }
      content = task.currentStep || "Waiting for approval...";
    } else if (task.partialSummary) {
      content = task.partialSummary;
    }
    if (!content) continue;
    synthetic.push({
      // Stable id so React's keying stays consistent across polls; switches
      // to the real msg_* id once the task completes and sync runs.
      id: `${task.id}-streaming`,
      instance: state.instance,
      sessionId: id,
      role: "assistant",
      content,
      taskId: task.id,
      runId: task.runId,
      createdAt: task.updatedAt
    });
  }

  const messages = synthetic.length === 0
    ? stored
    : [...stored, ...synthetic].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    ...session,
    messages,
    tasks,
    runs: state.runs.filter((run) => session.runIds.includes(run.id)).map((run) => ({
      ...run,
      planSteps: state.planSteps.filter((step) => step.runId === run.id)
    }))
  };
}

export async function createChat(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => {
    const effective = resolveEffectiveContext(state, config);
    return createChatSession(state, String(input.title ?? "New chat"), undefined, effective.agentId);
  });
}

// Resolves the single canonical chat for an agent in the new chats IA.
// Precedence:
//   1. Among the agent's `kind: "agent"` sessions, the most-recently-updated
//      one that actually has history (messages or tasks). A stray empty
//      "New chat" can be marked `kind: "agent"` and be newer than the real
//      chat, so recency alone would surface the empty one; require content
//      first. Sessions not chosen are demoted (kind cleared) to enforce the
//      single-canonical-chat invariant and stop the duplicate recurring.
//      If none have content (brand-new agent whose sole canonical chat is
//      legitimately empty), fall back to the most-recently-updated one and
//      demote nothing.
//   2. Otherwise the most-recently-updated non-job, non-bridge session
//      for the agent — promoted to `kind: "agent"` and persisted.
//   3. Otherwise a fresh `kind: "agent"` session is created.
// Other sessions are never merged or deleted; they simply stop being
// surfaced by the new UI. Resolution runs inside a single mutateState so
// the promote/create branches don't race a concurrent caller into two
// canonical chats.
export async function getOrCreateAgentChat(
  instance: Instance,
  agentId: string
): Promise<ChatSessionRecord> {
  return mutateState(instance, (state) => {
    if (!state.agents.find((a) => a.id === agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const byRecency = (a: ChatSessionRecord, b: ChatSessionRecord): number =>
      b.updatedAt.localeCompare(a.updatedAt);
    const hasContent = (s: ChatSessionRecord): boolean =>
      (s.messageIds?.length ?? 0) > 0 || (s.taskIds?.length ?? 0) > 0;
    const owned = state.chatSessions.filter((session) => session.agentId === agentId);

    const canonicals = owned
      .filter((session) => session.kind === "agent")
      .sort(byRecency);
    if (canonicals.length > 0) {
      const withContent = canonicals.filter(hasContent);
      if (withContent.length > 0) {
        const chosen = withContent[0];
        // Demote the other canonicals so the agent keeps exactly one chat.
        // Only safe because `chosen` has history — never demote a
        // legitimately-empty brand-new canonical chat.
        for (const session of canonicals) {
          if (session.id !== chosen.id) session.kind = undefined;
        }
        return chosen;
      }
      return canonicals[0];
    }

    const promotable = owned
      // never promote a Topic into the canonical chat
      .filter((session) => session.origin !== "job" && session.source === undefined && session.kind !== "topic")
      .sort(byRecency)[0];
    if (promotable) {
      promotable.kind = "agent";
      return promotable;
    }

    return createChatSession(state, "New chat", undefined, agentId, undefined, "agent");
  });
}

export async function deleteChat(config: RuntimeConfig, id: string) {
  await mutateState(config.instance, (state) => deleteChatSession(state, id));
  return { ok: true };
}

export async function renameChat(config: RuntimeConfig, id: string, input: Record<string, unknown>) {
  const title = String(input.title ?? "");
  const updated = await mutateState(config.instance, (state) => renameChatSession(state, id, title));
  // Fan the rename out over /api/chat/:id/stream so open SSE
  // subscribers (mobile chat detail, web client) see the new title
  // without a refetch. Publish after mutateState resolves so the
  // disk-write commit precedes the event — matches chat-blocks
  // post-commit semantics.
  publishChatSession(config.instance, updated);
  return updated;
}

function parseAttachments(instance: string, raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;
    // Take the mimeType + size from the STORED upload metadata, not the
    // client's claim. buildAttachmentContent partitions image-vs-file on
    // mimeType, so a forged mimeType could route non-image bytes through the
    // vision image_url path (or hide an image from vision). uploadStat also
    // confirms the id is registered with this instance — a phantom id with no
    // backing bytes throws here rather than pinning a 404 in chat history.
    const stat = uploadStat(instance, id);
    if (!stat) {
      throw new Error(`Invalid input: upload not found: ${id}`);
    }
    out.push({ id, mimeType: stat.mimeType, size: stat.size });
  }
  return out;
}

// Parse the optional voice attachment on a submit. Mirrors the image-upload
// validation: reject a missing/foreign upload id so a client can't pin an
// audio bubble with no backing bytes. The mimeType + size are taken from the
// STORED upload metadata, not the client's claim, so a stray image id can't
// masquerade as a recording and persist as a playable bubble over non-audio
// bytes. The optional client-supplied durationMs is render-only metadata and
// safe to trust.
function parseAudioAttachment(instance: string, raw: unknown): AudioAttachment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
  if (!id || !mimeType) throw new Error("Invalid input: audio attachment requires id and mimeType.");
  const stat = uploadStat(instance, id);
  if (!stat) {
    throw new Error(`Invalid input: audio upload not found: ${id}`);
  }
  if (!stat.mimeType.startsWith("audio/")) {
    throw new Error(`Invalid input: audio attachment must be audio/* (got ${stat.mimeType})`);
  }
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : undefined;
  return { id, mimeType: stat.mimeType, size: stat.size, ...(durationMs !== undefined ? { durationMs } : {}) };
}

// Surfaces UI clients may claim in the `client` body field. Bridge kinds are
// deliberately NOT claimable here — those derive from the session source.
const CLIENT_SURFACE_VALUES: ReadonlySet<string> = new Set(["web", "mobile", "cli"]);

// Resolve the client surface of an inbound message. UI clients (web, mobile,
// CLI) tag each POST with `client`; an unrecognized or absent value is
// treated as unknown — never a 400, so older clients keep working. Messaging
// bridges don't send the field: their surface derives from the session's
// `source.kind` ("telegram" | "discord" | "openclaw"). Per-MESSAGE, not
// per-session, because the same session can be used from phone and desktop
// alternately. See ADR client-surface-context.md.
function resolveClientSurface(
  input: Record<string, unknown>,
  session: ChatSessionRecord
): ChatClientSurface | undefined {
  if (typeof input.client === "string" && CLIENT_SURFACE_VALUES.has(input.client)) {
    return input.client as ChatClientSurface;
  }
  return session.source?.kind;
}

// Shared submit preparation for both the main-chat and thread-reply paths.
// Resolves content + image + audio attachments, transcribes a voice message
// when the content is empty, guards against an empty submission, and
// re-validates the session after STT (which can run long enough for the
// session to be deleted mid-flight). Returns the live session so the caller
// inherits the owning agent without re-reading state.
async function prepareChatSubmission(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>
): Promise<{
  content: string;
  images: ImageAttachment[];
  audio: AudioAttachment | undefined;
  liveSession: ChatSessionRecord;
  clientSurface: ChatClientSurface | undefined;
}> {
  let content = String(input.content ?? "").trim();
  const images = parseAttachments(config.instance, input.images);
  const audio = parseAudioAttachment(config.instance, input.audio);
  // Validate the session before transcribing — STT (and, on the first voice
  // message, the one-time model download) is expensive, so a stale or deleted
  // sessionId must fail fast here rather than after the work is done.
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Chat session not found: ${sessionId}`);
  // A voice message arrives with empty content — transcribe the recording so
  // the transcript becomes the message content. The audio itself never
  // reaches the provider; only this transcript does. A transcription failure
  // surfaces as a user-facing error so the client retries rather than posting
  // a do-nothing task with no prompt.
  if (audio && !content) {
    const upload = readUpload(config.instance, audio.id);
    if (upload) {
      try {
        content = (await getSttProvider().transcribe(upload.bytes)).trim();
      } catch (error) {
        appendLog(config.instance, "chat.stt.failed", {
          sessionId,
          uploadId: audio.id,
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error("Could not transcribe the voice message. Please try again.");
      }
    }
  }
  if (!content && images.length === 0) {
    throw new Error(
      audio ? "No speech detected in the voice message." : "Chat message content is required."
    );
  }
  // Re-validate the session: transcription above can run a long time (the
  // first voice message downloads the model), and the chat may have been
  // deleted during that window. Re-read so a delete-during-transcription
  // can't create a run/task/block for a gone session or attribute work to a
  // stale record.
  const liveState = readState(config.instance);
  const liveSession = liveState.chatSessions.find((item) => item.id === sessionId);
  if (!liveSession) throw new Error(`Chat session not found: ${sessionId}`);
  return { content, images, audio, liveSession, clientSurface: resolveClientSurface(input, liveSession) };
}

// The prepared submission returned by prepareChatSubmission. Shared between
// the immediate run-now path and the auto-dispatch path so both create the
// task, message, and block identically.
type PreparedChatSubmission = Awaited<ReturnType<typeof prepareChatSubmission>>;

// Actually run a prepared chat submission: create the conversation run, spawn
// the chat task, persist the user message + ChatBlock. Extracted so the
// immediate submit path and the queue auto-dispatch path share one
// implementation.
async function runChatSubmission(
  config: RuntimeConfig,
  sessionId: string,
  prepared: PreparedChatSubmission,
  options?: {
    // The render-only user_text block inserted at accept time (echo-first
    // ack). When present, the task binds to that block instead of inserting
    // a second bubble for the same message.
    echoBlockId?: string;
  }
) {
  const { content, images, audio, liveSession, clientSurface } = prepared;
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  // Chat messages run through the tool-calling agent loop. The legacy
  // prefix-dispatch path stays available for the imperative CLI.
  // Inherit the session's owning agent so a switch between the chat's
  // creation and this message doesn't reattribute the new task.
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: sessionId,
    agentId: liveSession.agentId,
    ...(clientSurface ? { clientSurface } : {}),
    ...(images.length > 0 ? { images } : {})
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, {
      sessionId,
      role: "user",
      content,
      taskId: task.id,
      runId: run.id,
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(task.parentBlockId ? { parentBlockId: task.parentBlockId } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  // Dual-publish the user_text ChatBlock alongside the legacy
  // ChatMessageRecord during the migration window (ADR
  // chat-block-protocol.md). Both writes are best-effort independent:
  // a SQLite open failure here must not roll back the user's message,
  // and a JSON state failure above must not block the chat-block row
  // (the loop's later emissions tolerate missing user_text). Errors are
  // logged via appendLog so operators can spot drift.
  //
  // Echo-first ack: when the block already exists (inserted at accept time,
  // before the routing verdict), bind it to this turn instead of inserting a
  // duplicate. A vanished echo (session wiped mid-verdict) falls back to a
  // fresh insert so the turn always has its user_text row.
  try {
    const attached = options?.echoBlockId
      ? attachTaskToUserTextBlock(config.instance, options.echoBlockId, {
          taskId: task.id,
          runId: run.id
        })
      : null;
    if (!attached) {
      insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId,
        text: content,
        taskId: task.id,
        runId: run.id,
        agentId: liveSession.agentId ?? null,
        ...(images.length > 0 ? { images } : {}),
        ...(audio ? { audio } : {})
      });
    }
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return { sessionId, runId: run.id, taskId: task.id, status: task.status };
}

// Supersede rule (design invariant: approval is click-only). When a new user
// message arrives while the session's ONE live task is parked at
// waiting_approval on Authorization gates (confirm cards) and the queue is
// empty, cancel the gated task so the message runs as a fresh turn instead of
// queueing behind a gate that may never resolve. User text NEVER resolves a
// gate as approval — even a literal "yes, send it" takes this path (gate
// cancelled, side effect NOT executed); the only path that executes a gated
// side effect is the explicit approve endpoint. No affirmation/intent
// classification, ever.
//
// Deliberately narrow:
//   - non-empty pendingMessages → no supersede (FIFO order is preserved; the
//     message queues as today);
//   - mid-loop (running) tasks → no supersede (mid-run steering stays
//     queue-only);
//   - any pending SetupRequest gate (chat.choice question, credential card) →
//     no supersede (the park is a question to answer, not a decision to
//     override).
// Returns the cancelled task's id so the caller can stamp
// `supersededByTaskId` once the replacement task exists.
async function supersedeGatedTaskForMessage(
  config: RuntimeConfig,
  sessionId: string
): Promise<string | undefined> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session || (session.pendingMessages?.length ?? 0) > 0) return undefined;
  const liveTasks = state.tasks.filter(
    (t) => t.chatSessionId === sessionId && !isTerminalTaskStatus(t.status)
  );
  if (liveTasks.length !== 1 || liveTasks[0]!.status !== "waiting_approval") return undefined;
  const liveTask = liveTasks[0]!;
  const hasPendingAuthorization = state.authorizations.some(
    (a) => a.taskId === liveTask.id && a.status === "pending"
  );
  const hasPendingSetupRequest = state.setupRequests.some(
    (s) => s.taskId === liveTask.id && s.status === "pending"
  );
  if (!hasPendingAuthorization || hasPendingSetupRequest) return undefined;
  // cancelTask tears the gates down (pending Authorizations → denied, tool_call
  // rows settle to "denied") and emits the "Superseded by your new message"
  // system note. The new run is submitted only AFTER this returns.
  await cancelTask(config, liveTask.id, { reason: "superseded" });
  return liveTask.id;
}

// Needs-input answer path. When the session's ONE live task is parked on an
// ask_user question, a plain message post IS the answer: resolve the pending
// chat.choice SetupRequest with the freeform-answer semantics of
// POST /api/setup-requests/:id/complete { choice: { other } } and resume the
// SAME task — zero client changes for CLI/bridges. Keys on the park-stamped
// `Task.needsInput.setupRequestId` rather than the status alone so the path
// also works under the GINI_NEEDS_INPUT_STATUS=0 escape hatch (which exposes
// the same park as `waiting_approval`).
//
// Deliberately disjoint from the supersede path: supersede requires ≥1
// pending Authorization and ZERO pending SetupRequests; this path requires
// the park to be all-chat.choice (the stamped SetupRequest still pending).
// A non-empty queue preserves FIFO order — the message queues as today.
async function answerNeedsInputForMessage(
  config: RuntimeConfig,
  sessionId: string,
  prepared: PreparedChatSubmission
): Promise<{ sessionId: string; runId?: string; taskId: string; status: TaskStatus } | undefined> {
  const content = prepared.content.trim();
  if (!content) return undefined;
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session || (session.pendingMessages?.length ?? 0) > 0) return undefined;
  const liveTasks = state.tasks.filter(
    (t) => t.chatSessionId === sessionId && !isTerminalTaskStatus(t.status)
  );
  if (liveTasks.length !== 1) return undefined;
  const liveTask = liveTasks[0]!;
  if (liveTask.status !== "needs_input" && liveTask.status !== "waiting_approval") return undefined;
  const setupRequestId = liveTask.needsInput?.setupRequestId;
  if (!setupRequestId) return undefined;
  const setup = state.setupRequests.find((s) => s.id === setupRequestId);
  if (!setup || setup.action !== "chat.choice") return undefined;
  if (setup.status !== "pending") {
    // The stamp points at an already-settled question: a restart killed the
    // detached resume after the answer persisted, wedging the park. Kick the
    // idempotent settled-park heal (a no-op when a live resume is in flight
    // or a gate is genuinely pending), then let this message take its normal
    // path — it queues behind the resuming run and drains when it settles.
    resumeParkIfGatesSettled(config, liveTask.id);
    return undefined;
  }
  const toolCallId = typeof setup.payload.toolCallId === "string" ? setup.payload.toolCallId : undefined;
  if (!toolCallId) return undefined;
  // Atomically claim the row first, same order as the /complete handler. A
  // concurrent /complete (answering from the card) or a racing second
  // message can win the claim — ApprovalRaceLostError falls through to the
  // normal queue path so the message is never lost and never double-answers.
  try {
    await resolveSetupRequest(config, setupRequestId, "complete", { actor: "user", resumeChatTask: false });
  } catch (error) {
    if (error instanceof ApprovalRaceLostError) return undefined;
    throw error;
  }
  await persistConnectOutcome(config, setupRequestId, { ok: true, message: `You answered: ${content}` });
  // Render the user's answer in the thread. Best-effort, like the submit
  // path's user_text insert — the answer itself rides the tool result.
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId,
      text: prepared.content,
      taskId: liveTask.id,
      ...(liveTask.runId ? { runId: liveTask.runId } : {}),
      agentId: session.agentId ?? null,
      ...(prepared.images.length > 0 ? { images: prepared.images } : {})
    });
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      taskId: liveTask.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // Detached resume, mirroring the /complete handler: the POST returns
  // immediately and the resumed turn streams as usual.
  void safeResume(config, liveTask.id, toolCallId, `User answered: "${content}"`, {
    context: "chat.choice",
    approvalId: setupRequestId
  });
  // A parked chat task normally carries its runId; omit the field on the
  // rare stampless legacy park instead of fabricating an empty id.
  return {
    sessionId,
    ...(liveTask.runId ? { runId: liveTask.runId } : {}),
    taskId: liveTask.id,
    status: liveTask.status
  };
}

// Stamp supersede provenance onto the cancelled task once the replacement
// turn exists. Best-effort ordering: the stamp lands after the new task is
// created because its id doesn't exist before then.
async function stampSupersededBy(
  config: RuntimeConfig,
  cancelledTaskId: string,
  newTaskId: string
): Promise<void> {
  await mutateState(config.instance, (current) => {
    const cancelled = current.tasks.find((t) => t.id === cancelledTaskId);
    if (cancelled) cancelled.supersededByTaskId = newTaskId;
  });
}

// bypassQueue guarantees the run-now shape, so the messaging bridge gets a
// taskId without narrowing on a `queued` discriminant. The default (and the
// explicit { bypassQueue: false }) keeps the discriminated union for
// interactive clients that must handle the queued case.
type RunNowResult = Awaited<ReturnType<typeof runChatSubmission>>;
// The needs-input answer path resumes the parked task instead of minting a
// fresh run, so its result carries the task's runId only when the park has
// one (see answerNeedsInputForMessage).
type AnswerResult = NonNullable<Awaited<ReturnType<typeof answerNeedsInputForMessage>>>;
type QueuedResult = { sessionId: string; queued: true; pendingId: string };
// A Chat-routed message dispatched into a Topic returns the Topic-shaped result
// (topicId-keyed instead of sessionId-keyed). submitChatMessage's union widens to
// include it; the HTTP handler JSON-stringifies the result without destructuring,
// so the topic shape serializes correctly alongside the chat-direct shapes.
type TopicDispatchResult = Awaited<ReturnType<typeof dispatchChatMessageToTopic>>;
// Echo-first instant ack for a routed Chat message: the POST resolves as soon
// as the user's message is durably rendered, before the routing verdict
// exists. Run/task ids arrive via the block/session streams once the verdict
// dispatches the turn. `blockId` is the echo block, so a caller that needs
// the eventual taskId (e.g. scripts/e2e-browser-tools.ts) can poll for the
// block gaining one.
type AcceptedResult = { sessionId: string; accepted: true; blockId?: string };

// Upper bound on the routing verdict. A hung provider must not strand an
// accepted message un-dispatched forever — on timeout (or any router error)
// the message runs as a chat-direct turn, the same fallback coerceDecision
// uses for an unparseable verdict.
const ROUTE_VERDICT_TIMEOUT_MS = 15_000;

export function submitChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>,
  options: { bypassQueue: true }
): Promise<RunNowResult>;
export function submitChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>,
  options?: { bypassQueue?: boolean; routeTimeoutMs?: number }
): Promise<RunNowResult | AnswerResult | QueuedResult | TopicDispatchResult | AcceptedResult>;
export async function submitChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>,
  options?: { bypassQueue?: boolean; routeTimeoutMs?: number }
): Promise<RunNowResult | AnswerResult | QueuedResult | TopicDispatchResult | AcceptedResult> {
  const prepared = await prepareChatSubmission(config, sessionId, input);
  // The queue is for interactive clients (web/mobile/CLI composer), where a
  // human queues follow-ups while watching a turn. The messaging bridge is a
  // different ingestion path whose reply-mirror contract depends on a
  // per-inbound-message taskId, so it passes bypassQueue to always run now.
  // See ADR chat-message-queue.md.
  if (options?.bypassQueue) {
    return runChatSubmission(config, sessionId, prepared);
  }
  // Needs-input answer and supersede carve-outs run BEFORE intake routing: a
  // message posted while THIS session's own live turn is parked must answer
  // or supersede that turn in place — routing it into a Topic would strand
  // the parked gate behind a turn the user has already moved past. Same
  // order as the topic-dispatch path: answer first, then supersede. See
  // answerNeedsInputForMessage / supersedeGatedTaskForMessage.
  const answered = await answerNeedsInputForMessage(config, sessionId, prepared);
  if (answered) return answered;
  const supersededTaskId = await supersedeGatedTaskForMessage(config, sessionId);
  // Intake routing (ADR chat-topics-tasks-subagents.md). A message posted in a
  // user's Chat (kind:"agent") is classified before the turn's context loads —
  // the route selects which transcript loads. The verdict is a model call
  // (~1s+), so it must NOT gate the POST: the message is echoed and
  // acknowledged immediately, and routing + dispatch continue off the request
  // path. The bypassQueue run-now path and non-Chat sessions
  // (topic/channel/bridge) are never routed — and neither is a message that
  // just superseded this Chat's parked turn: the replacement run belongs in
  // this session.
  if (prepared.liveSession.kind === "agent" && supersededTaskId === undefined) {
    return acceptRoutedChatMessage(config, sessionId, prepared, options?.routeTimeoutMs);
  }
  return queueOrRunChatSubmission(config, sessionId, prepared, undefined, supersededTaskId);
}

// Chat-direct queue-or-run, shared by the non-routed synchronous path and the
// post-verdict continuation. Enqueue instead of running when a turn is already
// in flight for this session, or when the queue is already non-empty (so a
// later submit can't jump ahead of earlier queued messages while the current
// turn runs). The gateway is the source of truth — concurrent submits
// serialize here rather than starting parallel tasks. See ADR
// chat-message-queue.md.
//
// The state read happens AFTER any supersede carve-out so the cancelled task
// no longer counts as in-flight — and doubles as the queue-drain race guard:
// if a concurrent submit (or the cancel's own drain) started a new turn in
// the window, the in-flight check queues this message as usual instead of
// running a second turn. When the caller superseded a parked turn, the
// replacement run is stamped onto the cancelled task (supersededByTaskId).
async function queueOrRunChatSubmission(
  config: RuntimeConfig,
  sessionId: string,
  prepared: PreparedChatSubmission,
  echoBlockId: string | undefined,
  supersededTaskId?: string
): Promise<RunNowResult | QueuedResult> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  const shouldQueue =
    sessionHasInFlightChatTask(state, sessionId) || (session?.pendingMessages?.length ?? 0) > 0;
  if (shouldQueue) {
    const { content, images, clientSurface } = prepared;
    const pending = await mutateState(config.instance, (current) =>
      enqueuePendingChatMessage(current, sessionId, {
        content,
        ...(images.length > 0 ? { images } : {}),
        ...(clientSurface ? { clientSurface } : {}),
        ...(echoBlockId ? { echoBlockId } : {})
      })
    );
    const updated = readState(config.instance).chatSessions.find((item) => item.id === sessionId);
    if (updated) publishChatSession(config.instance, updated);
    return { sessionId, queued: true as const, pendingId: pending.id };
  }
  const result = await runChatSubmission(config, sessionId, prepared, { echoBlockId });
  if (supersededTaskId) await stampSupersededBy(config, supersededTaskId, result.taskId);
  return result;
}

// Echo-first instant ack (the responsiveness contract): render the user's
// message NOW, resolve the POST NOW, and let the routing verdict + dispatch
// finish off the request path. No run/task exists until the verdict lands, so
// every queue/busy invariant in ADR chat-message-queue.md still evaluates at
// dispatch time exactly as before — the only reordering is that the user's
// bubble and the 201 no longer wait ~1s+ on the router's model call.
async function acceptRoutedChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  prepared: PreparedChatSubmission,
  routeTimeoutMs: number | undefined
): Promise<AcceptedResult> {
  const { content, images, audio, liveSession } = prepared;
  // Same render-only echo shape dispatchChatMessageToTopic writes into Chat:
  // no taskId/runId yet. Chat-direct dispatch later binds the block to its
  // turn (attachTaskToUserTextBlock); a topic verdict leaves it as the Chat
  // echo of the Topic turn. Best-effort — an insert failure must not reject
  // the message.
  let echoBlockId: string | undefined;
  try {
    echoBlockId = insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId,
      text: content,
      agentId: liveSession.agentId ?? null,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    }).id;
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  void routeAndDispatchChatMessage(config, sessionId, prepared, echoBlockId, routeTimeoutMs).catch(
    (error) => {
      appendLog(config.instance, "chat.accept.dispatch_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      // The POST already succeeded, so a dispatch failure would otherwise be
      // silent — surface it in the transcript instead of today's HTTP 500.
      try {
        insertChatBlock(config.instance, {
          kind: "system_note",
          sessionId,
          text: "That message could not start a turn. Please try sending it again."
        });
      } catch {
        // Best-effort: the appendLog above is the durable record.
      }
    }
  );
  return { sessionId, accepted: true as const, ...(echoBlockId ? { blockId: echoBlockId } : {}) };
}

// Post-ack continuation: obtain the routing verdict (bounded, never throws
// into the void — timeout and router errors degrade to "chat") and dispatch
// the prepared message to the destination the verdict selects.
async function routeAndDispatchChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  prepared: PreparedChatSubmission,
  echoBlockId: string | undefined,
  routeTimeoutMs: number | undefined
): Promise<void> {
  let decision: Awaited<ReturnType<typeof routeChatMessage>> = { decision: "chat" };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    decision = await Promise.race([
      routeChatMessage(config, sessionId, prepared.content, { excludeBlockId: echoBlockId }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("chat-route verdict timed out")),
          routeTimeoutMs ?? ROUTE_VERDICT_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    appendLog(config.instance, "chat.route.failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  // The session can be deleted while the verdict is pending; its blocks (the
  // echo included) die with it, so there is nothing to dispatch or clean up.
  if (!readState(config.instance).chatSessions.find((item) => item.id === sessionId)) return;
  if (decision.decision === "new_topic") {
    // Deliberately UNPINNED (createTopic sets `pinned` only on request):
    // pinning is a user gesture, so a router-minted container surfaces on
    // home — never in the sidebar — until the user pins it. See ADR
    // task-containers-and-runs.md.
    const topicId = await mutateState(config.instance, (state) =>
      createTopic(state, {
        agentId: prepared.liveSession.agentId,
        title: decision.title,
        parentChatSessionId: sessionId,
        // Seed the topic's routing/retrieval descriptor with the originating
        // message so the router can recognize a later follow-up by content,
        // not just the short title — no extra model call. See ADR
        // chat-topics-tasks-subagents.md (Routing).
        topicSummary: truncateTopicSummary(prepared.content)
      }).id
    );
    await dispatchChatMessageToTopic(config, sessionId, topicId, prepared, { skipChatEcho: true });
    return;
  }
  if (decision.decision === "existing_topic") {
    // The candidate was validated at verdict time, but the topic can vanish
    // in the gap — fall back to the chat-direct path instead of failing the
    // already-accepted message.
    if (readState(config.instance).chatSessions.find((item) => item.id === decision.topicId)) {
      await dispatchChatMessageToTopic(config, sessionId, decision.topicId, prepared, {
        skipChatEcho: true
      });
      return;
    }
  }
  await queueOrRunChatSubmission(config, sessionId, prepared, echoBlockId);
}

// Auto-dispatch the next queued message for a session when the current turn
// ends. Pops the first pending message (FIFO), publishes the shrunk queue,
// then runs it as its own real chat turn. A run failure is logged and
// swallowed so a single bad turn doesn't crash the dispatch chain; the rest
// of the queue stays intact for the next terminal transition.
//
// Idempotent + in-flight-guarded: the busy-check AND the FIFO shift happen
// inside ONE mutateState so the pop only fires when the session is truly
// idle. This closes two races: the submitTask `.finally` hook fires when a
// chat task resolves into the NON-terminal `waiting_approval` status (the
// turn paused, not ended), and several terminal owners (approval-resume
// completion, deny-while-paused, cancel-while-paused) fire this redundantly.
// `sessionHasInFlightChatTask` treats queued/running/waiting_approval as
// in-flight, so a premature or redundant call pops nothing and no-ops; at
// most one queued message drains, and only once the session has no live turn.
export async function dispatchNextPendingChatMessage(config: RuntimeConfig, sessionId: string): Promise<void> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (!session) return;
  const popped = await mutateState(config.instance, (current) => {
    if (sessionHasInFlightChatTask(current, sessionId)) return undefined;
    return shiftPendingChatMessage(current, sessionId);
  });
  if (!popped) return;
  const afterShift = readState(config.instance).chatSessions.find((item) => item.id === sessionId);
  if (!afterShift) return;
  publishChatSession(config.instance, afterShift);
  const prepared: PreparedChatSubmission = {
    content: popped.content,
    images: popped.images ?? [],
    audio: undefined,
    liveSession: afterShift,
    clientSurface: popped.clientSurface
  };
  try {
    // A Topic session drains into its own context via runTopicSubmission; a
    // queued thread reply re-dispatches back into its thread; a main-chat
    // message runs as a normal turn. Topic membership (session.kind) and
    // popped.threadId distinguish them.
    if (afterShift.kind === "topic") {
      await runTopicSubmission(config, sessionId, prepared);
    } else if (popped.threadId) {
      await runThreadSubmission(config, sessionId, popped.threadId, popped.parentBlockId!, prepared, {
        alsoToMain: popped.alsoToMain
      });
    } else {
      // A queued echo-first message already has its bubble on screen — bind
      // the drained turn to that block instead of inserting a second one.
      await runChatSubmission(config, sessionId, prepared, { echoBlockId: popped.echoBlockId });
    }
  } catch (error) {
    appendLog(config.instance, "chat.queue.dispatch_failed", {
      sessionId,
      pendingId: popped.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Remove a queued message by id (DELETE /api/chat/:id/pending/:pendingId).
// Publishes the updated session so the queue pill updates live everywhere.
export async function removePendingChatMessageById(
  config: RuntimeConfig,
  sessionId: string,
  pendingId: string
): Promise<boolean> {
  // Capture the echo block before the pending record is gone: an echo-first
  // message that gets dequeued must also lose its bubble, or the transcript
  // keeps a message that will never run. (Live SSE subscribers see no
  // retraction — deleteChatBlock emits none — but the remover's own refetch
  // and every later load drop it.)
  const echoBlockId = readState(config.instance)
    .chatSessions.find((item) => item.id === sessionId)
    ?.pendingMessages?.find((item) => item.id === pendingId)?.echoBlockId;
  const removed = await mutateState(config.instance, (current) =>
    removePendingChatMessage(current, sessionId, pendingId)
  );
  if (removed) {
    if (echoBlockId) deleteChatBlock(config.instance, echoBlockId);
    const updated = readState(config.instance).chatSessions.find((item) => item.id === sessionId);
    if (updated) publishChatSession(config.instance, updated);
  }
  return removed;
}

// Posts a user reply inside a thread, creating the thread on the first reply.
// The whole spawned task threads (decision E: a user reply in a thread stays
// in the thread regardless of the agent's routing directive), so
// threadId/parentBlockId are stamped on the task up front — resolveEmitContext
// reads them and every emit* block lands tagged with the same thread
// membership.
//
// Create-or-append:
//   - Existing thread (has blocks): inherit parentBlockId from its first block.
//   - New thread (no blocks): require `input.parentBlockId` pointing at a
//     main-chat block in this session — the message the user branched from.
export async function submitThreadReply(
  config: RuntimeConfig,
  sessionId: string,
  threadId: string,
  input: Record<string, unknown>
) {
  // Validate the session first so a bad sessionId fails as "Chat session not
  // found" (404) rather than the misleading "Thread not found" — the thread
  // lookup below is scoped to a session that may not exist.
  const state = readState(config.instance);
  if (!state.chatSessions.find((item) => item.id === sessionId)) {
    throw new Error(`Chat session not found: ${sessionId}`);
  }
  // Resolve the thread's parent_block_id. An existing thread inherits it from
  // its first block (a missing one is corruption — fail loudly). A new thread
  // (no blocks yet) must carry the parentBlockId of the main-chat message the
  // user is branching from.
  const existing = listThreadBlocks(config.instance, sessionId, threadId);
  let parentBlockId: string;
  if (existing.length > 0) {
    const inherited = existing[0].parentBlockId;
    if (!inherited) throw new Error("Thread is missing its parent message");
    parentBlockId = inherited;
  } else {
    const requested = typeof input.parentBlockId === "string" ? input.parentBlockId : "";
    if (!requested) throw new Error("Thread not found: a parent message is required to start a thread");
    // The parent must be a main-chat (un-threaded) block in THIS session —
    // a thread can't root on another session's block or on a threaded one.
    const parent = getMainChatBlock(config.instance, sessionId, requested);
    if (!parent) throw new Error("Thread not found: parent message not found in this chat");
    parentBlockId = parent.id;
  }
  const prepared = await prepareChatSubmission(config, sessionId, input);
  // Serialize behind any live turn for this session, exactly like
  // submitChatMessage: enqueue when a turn is already in flight or the queue
  // is non-empty, so a reply typed mid-turn (e.g. while a prior turn is paused
  // at waiting_approval) queues instead of spawning a second competing task.
  // The session-scoped guard keeps one live turn per session; the queued reply
  // carries its thread membership so auto-dispatch re-runs it in this thread.
  // See ADR chat-message-queue.md.
  const liveState = readState(config.instance);
  const session = liveState.chatSessions.find((item) => item.id === sessionId);
  const shouldQueue =
    sessionHasInFlightChatTask(liveState, sessionId) || (session?.pendingMessages?.length ?? 0) > 0;
  if (shouldQueue) {
    const { content, images, clientSurface } = prepared;
    const pending = await mutateState(config.instance, (current) =>
      enqueuePendingChatMessage(current, sessionId, {
        content,
        ...(images.length > 0 ? { images } : {}),
        ...(clientSurface ? { clientSurface } : {}),
        threadId,
        parentBlockId,
        alsoToMain: Boolean(input.alsoToMain)
      })
    );
    const updated = readState(config.instance).chatSessions.find((item) => item.id === sessionId);
    if (updated) publishChatSession(config.instance, updated);
    return { sessionId, queued: true as const, pendingId: pending.id };
  }
  return runThreadSubmission(config, sessionId, threadId, parentBlockId, prepared, {
    alsoToMain: Boolean(input.alsoToMain)
  });
}

// Actually run a prepared thread reply: create the conversation run, spawn the
// thread-tagged task, persist the user message + thread ChatBlock (and the
// optional main-chat mirror). Extracted so the immediate submit path and the
// queue auto-dispatch path produce an identical threaded turn.
async function runThreadSubmission(
  config: RuntimeConfig,
  sessionId: string,
  threadId: string,
  parentBlockId: string,
  prepared: PreparedChatSubmission,
  options?: { alsoToMain?: boolean }
) {
  const { content, images, audio, liveSession, clientSurface } = prepared;
  const run = await createConversationRun(config, { conversationId: sessionId, input: content });
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: sessionId,
    agentId: liveSession.agentId,
    threadId,
    parentBlockId,
    ...(clientSurface ? { clientSurface } : {}),
    ...(images.length > 0 ? { images } : {})
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, {
      sessionId,
      role: "user",
      content,
      taskId: task.id,
      runId: run.id,
      threadId,
      parentBlockId,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  // Dual-publish the user_text ChatBlock, tagged with the thread membership
  // so it renders in the thread panel and threads the response.
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId,
      text: content,
      taskId: task.id,
      runId: run.id,
      agentId: liveSession.agentId ?? null,
      threadId,
      parentBlockId,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // When the client asks to also show the reply in the main transcript,
  // mirror only the user's message (not the agent's threaded response) into
  // the main chat as an un-threaded user_text block. Best-effort like the
  // thread block above.
  if (options?.alsoToMain) {
    try {
      insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId,
        text: content,
        taskId: task.id,
        runId: run.id,
        agentId: liveSession.agentId ?? null,
        ...(images.length > 0 ? { images } : {}),
        ...(audio ? { audio } : {})
      });
    } catch (error) {
      appendLog(config.instance, "chat.user_block.insert_failed", {
        sessionId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { sessionId, threadId, runId: run.id, taskId: task.id, status: task.status };
}

// Run a prepared chat turn inside a Topic's isolated context (ADR
// chat-topics-tasks-subagents.md). Modeled on runThreadSubmission but it swaps
// the session id itself instead of tagging blocks: both run.conversationId AND
// task.chatSessionId bind to `topicId`, so replay (priorChatMessages filters
// m.sessionId === topicId), emit (resolveEmitContext keys on task.chatSessionId),
// and the FIFO queue all follow the Topic automatically. There are no
// threadId/parentBlockId tags — a Topic is a real separate session.
//
// `prepared.liveSession` is the CHAT session the message arrived on; the Topic's
// own agentId is resolved from state here (topics carry agentId via createTopic)
// so the task inherits the Topic owner, not whatever the Chat session pointed at.
export async function runTopicSubmission(
  config: RuntimeConfig,
  topicId: string,
  prepared: PreparedChatSubmission
) {
  const { content, images, audio, clientSurface } = prepared;
  const topicSession = readState(config.instance).chatSessions.find((item) => item.id === topicId);
  if (!topicSession) throw new Error(`Topic session not found: ${topicId}`);
  const topicAgentId = topicSession.agentId;
  const run = await createConversationRun(config, { conversationId: topicId, input: content });
  const task = await submitTask(config, content, {
    runId: run.id,
    mode: "chat",
    chatSessionId: topicId,
    agentId: topicAgentId,
    ...(clientSurface ? { clientSurface } : {}),
    ...(images.length > 0 ? { images } : {})
  });
  await linkRunToTask(config, run.id, task);
  await mutateState(config.instance, (current) => {
    const message = createChatMessage(current, {
      sessionId: topicId,
      role: "user",
      content,
      taskId: task.id,
      runId: run.id,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
    const runRecord = current.runs.find((item) => item.id === run.id);
    if (runRecord) {
      runRecord.userMessageId = message.id;
      runRecord.updatedAt = message.createdAt;
    }
  });
  // Render the user's message inside the Topic. Best-effort like the other
  // submit paths — a block-insert failure must not roll back the turn.
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: topicId,
      text: content,
      taskId: task.id,
      runId: run.id,
      agentId: topicAgentId ?? null,
      ...(images.length > 0 ? { images } : {}),
      ...(audio ? { audio } : {})
    });
  } catch (error) {
    appendLog(config.instance, "chat.user_block.insert_failed", {
      sessionId: topicId,
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return { topicId, runId: run.id, taskId: task.id, status: task.status };
}

// Direct start (POST /api/containers): mint an UNPINNED task container under
// the agent's root Chat session and run the message as its first turn,
// bypassing the intake router. Reuses prepareChatSubmission (attachment/STT
// validation) and runTopicSubmission, so blocks, queueing, and session-scoped
// context continuity behave exactly like a router-dispatched Topic turn.
// Pinning stays a user gesture — a directly-started container surfaces on
// home, never in the sidebar, until the user pins it.
export async function startTaskContainer(
  config: RuntimeConfig,
  input: Record<string, unknown>
): Promise<{ containerId: string; taskId: string; status: TaskStatus }> {
  const effective = resolveEffectiveContext(readState(config.instance), config);
  const agentId = typeof input.agentId === "string" && input.agentId ? input.agentId : effective.agentId;
  if (!agentId) throw new Error("No agent available to own the task container.");
  // Optional creation-gesture fact (which composer mode minted the
  // container). Validated up front so a bad value 400s before anything is
  // minted; absent stays absent — unknown is meaningful on old records.
  let startedAs: "task" | "message" | undefined;
  if (input.startedAs !== undefined && input.startedAs !== null) {
    if (input.startedAs !== "task" && input.startedAs !== "message") {
      throw new Error(`Invalid input: startedAs must be "task" or "message" (got ${String(input.startedAs)})`);
    }
    startedAs = input.startedAs;
  }
  // Parent edge = the agent's canonical Chat session (same shape the router's
  // new_topic mint uses), resolved BEFORE the container exists so a validation
  // failure in prepareChatSubmission below leaves no orphan container behind.
  const agentChat = await getOrCreateAgentChat(config.instance, agentId);
  const prepared = await prepareChatSubmission(config, agentChat.id, input);
  const requestedTitle = typeof input.title === "string" ? input.title.trim() : "";
  const containerId = await mutateState(config.instance, (state) =>
    createTaskContainer(state, {
      agentId,
      // No client-supplied title → title from the user's brief (createChatSession
      // caps it at 80 chars).
      title: requestedTitle || prepared.content,
      parentChatSessionId: agentChat.id,
      // Same routing/retrieval descriptor seeding as the router's new_topic
      // path, so a later Chat follow-up can be routed here by content.
      topicSummary: truncateTopicSummary(prepared.content),
      ...(startedAs ? { startedAs } : {})
    }).id
  );
  const result = await runTopicSubmission(config, containerId, prepared);
  return { containerId, taskId: result.taskId, status: result.status };
}

// Retry a failed container run (POST /api/containers/:id/retry): re-submit
// the newest failed run's original input as a fresh message into the
// container, through the SAME submitChatMessage machinery a thread post
// uses, so follow-up continuity, queueing rules, and events all hold.
// Preconditions: the target is a task container (not the agent's root Chat)
// and is non-headless, no run is in flight and no backlog is queued (409 —
// the live or queued work is already the failure's replacement), and the
// newest terminal run outcome is "failed" (a completed or cancelled outcome
// has nothing to retry).
export async function retryFailedContainerRun(
  config: RuntimeConfig,
  containerId: string
): Promise<{ taskId: string; status: TaskStatus }> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((item) => item.id === containerId);
  if (!session) throw new Error(`Chat session not found: ${containerId}`);
  // Retry targets task containers only. The agent's root Chat (kind:"agent")
  // has no retry affordance — and a re-submit into it would pass through
  // intake routing, minting (and then withdrawing) the run against a
  // different session than the one the caller named.
  if (session.kind === "agent") {
    throw new Error(`Invalid input: ${containerId} is a Chat session, not a task container — nothing to retry.`);
  }
  if (session.headless) {
    throw new Error(`Invalid input: container ${containerId} is headless — it has no retry affordance.`);
  }
  // statusFromErrorMessage maps this prefix to 409.
  if (sessionHasInFlightChatTask(state, containerId)) {
    throw new Error(`Container already has a live run: ${containerId}`);
  }
  const outcome = latestRunOutcome(state, session);
  if (!outcome || outcome.status !== "failed") {
    throw new Error(`Invalid input: the newest run outcome for ${containerId} is not "failed" — nothing to retry.`);
  }
  const failedRun = state.tasks.find((item) => item.id === outcome.taskId);
  const input = failedRun?.input?.trim();
  if (!input) {
    throw new Error(`Invalid input: the failed run for ${containerId} recorded no input to retry.`);
  }
  const result = await submitChatMessage(config, containerId, {
    content: input,
    // Carry the failed run's image attachments so the retry re-submits the
    // ORIGINAL submission faithfully (parseAttachments re-validates the
    // upload ids against stored bytes, same as a fresh client submit).
    ...(failedRun?.images && failedRun.images.length > 0 ? { images: failedRun.images } : {})
  });
  if ("queued" in result) {
    // The message queued instead of running: either a turn started in the
    // window between the in-flight check and the submit, or the container's
    // queue already held a backlog. Withdraw the just-queued entry and
    // report the conflict truthfully — the user can retry once the
    // container drains.
    await removePendingChatMessageById(config, containerId, result.pendingId);
    throw new Error(`Container already has a live run or queued backlog: ${containerId}`);
  }
  if ("accepted" in result) {
    // Structurally unreachable: retry rejects kind:"agent" containers above,
    // and only kind:"agent" sessions take the echo-first accepted path.
    throw new Error(`Container retry unexpectedly took the routed-chat path: ${containerId}`);
  }
  // Same event shape as acknowledgeContainer so the ops event feed carries
  // the user gesture alongside the run-lifecycle rows the submit emitted.
  await mutateState(config.instance, (current) => {
    const live = current.chatSessions.find((item) => item.id === containerId);
    if (!live) return;
    appendEvent(
      current,
      {
        kind: "task",
        action: "chat.session.retried",
        target: live.id,
        risk: "low",
        summary: `Container retried: ${live.title}`
      },
      { sessionId: live.id }
    );
  });
  return { taskId: result.taskId, status: result.status };
}

// Dispatch a Chat-routed message into a Topic (ADR
// chat-topics-tasks-subagents.md). The orchestrator the router calls once it has
// chosen a Topic for a Chat message:
//   1. Render the user's own message in the CHAT session so they see it in
//      Chat (BLOCK ONLY — no ChatMessageRecord in Chat, which keeps Chat's
//      replay transcript clean; the replay-authoritative user+answer rows live
//      in the Topic).
//   2. If the Topic already has a live turn (or a non-empty queue), enqueue the
//      message onto the TOPIC's pendingMessages so it serializes behind the
//      in-flight Topic turn. Otherwise run it now in the Topic's context.
// The Topic's final answer is forwarded back into the Chat session from inside
// persistFinalAnswerRow (one site, covering chat-routed, queued, and
// direct-in-topic turns).
export async function dispatchChatMessageToTopic(
  config: RuntimeConfig,
  chatSessionId: string,
  topicId: string,
  prepared: PreparedChatSubmission,
  options?: {
    // Set by the echo-first submit path, which already rendered the user's
    // message into Chat at accept time — inserting it again here would paint
    // a duplicate bubble. The echo shape is identical either way (render-only,
    // no taskId/runId).
    skipChatEcho?: boolean;
  }
): Promise<
  | { topicId: string; runId?: string; taskId: string; status: TaskStatus }
  | { topicId: string; queued: true; pendingId: string }
> {
  const { content, images, audio, liveSession, clientSurface } = prepared;
  // Echo the user's message into Chat as a render-only block. Best-effort.
  if (!options?.skipChatEcho) {
    try {
      insertChatBlock(config.instance, {
        kind: "user_text",
        sessionId: chatSessionId,
        text: content,
        agentId: liveSession.agentId ?? null,
        ...(images.length > 0 ? { images } : {}),
        ...(audio ? { audio } : {})
      });
    } catch (error) {
      appendLog(config.instance, "chat.user_block.insert_failed", {
        sessionId: chatSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  // Needs-input answer BEFORE the supersede check, scoped to the TOPIC: a
  // Topic turn parked on an ask_user question consumes this message as its
  // answer and resumes the SAME task. See answerNeedsInputForMessage.
  const answered = await answerNeedsInputForMessage(config, topicId, prepared);
  if (answered) {
    return {
      topicId,
      ...(answered.runId ? { runId: answered.runId } : {}),
      taskId: answered.taskId,
      status: answered.status
    };
  }
  // Supersede check BEFORE the queue decision, scoped to the TOPIC: a Topic
  // turn parked on Authorization gates with an empty queue is cancelled so
  // this message runs now. See supersedeGatedTaskForMessage.
  const supersededTaskId = await supersedeGatedTaskForMessage(config, topicId);
  // Serialize behind any live Topic turn, exactly like submitChatMessage but
  // scoped to the TOPIC's queue: a message routed in mid-turn queues onto the
  // Topic instead of spawning a second competing task. See ADR
  // chat-message-queue.md. Re-read AFTER the supersede (queue-drain race
  // guard — a turn started concurrently in the window queues this message).
  const liveState = readState(config.instance);
  const topicSession = liveState.chatSessions.find((item) => item.id === topicId);
  const shouldQueue =
    sessionHasInFlightChatTask(liveState, topicId) || (topicSession?.pendingMessages?.length ?? 0) > 0;
  if (shouldQueue) {
    const pending = await mutateState(config.instance, (current) =>
      enqueuePendingChatMessage(current, topicId, {
        content,
        ...(images.length > 0 ? { images } : {}),
        ...(clientSurface ? { clientSurface } : {})
      })
    );
    const updated = readState(config.instance).chatSessions.find((item) => item.id === topicId);
    if (updated) publishChatSession(config.instance, updated);
    return { topicId, queued: true as const, pendingId: pending.id };
  }
  const result = await runTopicSubmission(config, topicId, prepared);
  if (supersededTaskId) await stampSupersededBy(config, supersededTaskId, result.taskId);
  return result;
}

export async function syncChatTaskResult(config: RuntimeConfig, sessionId: string, taskId: string) {
  const message = await mutateState(config.instance, (state) => {
    // Reject a missing session INSIDE the same mutateState so a
    // concurrent chat-session delete can't race past a pre-check
    // (the finalize-job hook does its own pre-check as a fast-path
    // optimization, but the atomic invariant lives here).
    // createChatMessage previously silently skipped the session-
    // linkage step on a missing session — that would have landed an
    // orphan ChatMessageRecord with no session pointing at it.
    const session = state.chatSessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Chat session not found: ${sessionId}`);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    // Tasks can have multiple assistant messages — the durable
    // approval-reason bubble (kind: "approval_reason") emitted from
    // request_connector lives alongside the eventual terminal summary,
    // and a tool-calling turn persists assistant rows tagged
    // kind:"tool_transcript" (model-facing replay state). The
    // short-circuit here is only for the *summary*, so it must ignore
    // both — otherwise the first tool_transcript assistant row would be
    // mistaken for the terminal summary and suppress the real one.
    const existing = state.chatMessages.find(
      (message) =>
        message.taskId === taskId &&
        message.role === "assistant" &&
        message.kind !== "approval_reason" &&
        message.kind !== "tool_transcript"
    );
    if (existing) return existing;
    // Only sync truly terminal task results into a real ChatMessageRecord.
    // waiting_approval is in-flight — the synthetic
    // placeholder rendered by getChatSession swaps out automatically once
    // approval grants and the task finishes.
    if (!isTerminalTaskStatus(task.status)) {
      throw new Error(`Task is not ready for chat sync: ${task.status}`);
    }
    // [SILENT] sentinel — emitted by scheduled jobs that have nothing
    // new to report (e.g. a watcher run that found no change). The
    // cron-execution hint instructs the LLM to respond with "[SILENT]"
    // to suppress delivery. We honor the literal token or a trailing
    // "[SILENT]" line after a no-op preamble, but reject a leading/inline
    // sentinel (see src/jobs/silent.ts), and only for successfully
    // completed tasks — a failure should still surface in chat.
    if (
      task.status === "completed" &&
      typeof task.summary === "string" &&
      isSilentReply(task.summary)
    ) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "chat.message.suppressed_silent",
          target: sessionId,
          taskId,
          risk: "low",
          evidence: { runId: task.runId }
        },
        { taskId }
      );
      return null;
    }
    // A provider auth failure surfaces the same actionable, provider-named
    // line the chat system note shows the web, so messaging/CLI/text-only
    // clients aren't left with a bare "token expired" (issue #205).
    const content = task.status === "completed"
      ? task.summary ?? "Task completed."
      : task.authErrorProvider
        ? providerAuthFailureText(
            providerDisplayLabel(task.authErrorProvider),
            providerReauth(task.authErrorProvider)
          )
        : task.error ?? task.currentStep ?? `Task is ${task.status}.`;
    const message = createChatMessage(state, {
      sessionId,
      role: "assistant",
      content,
      taskId,
      runId: task.runId,
      ...(task.threadId ? { threadId: task.threadId } : {}),
      ...(task.parentBlockId ? { parentBlockId: task.parentBlockId } : {})
    });
    if (task.runId) {
      const run = state.runs.find((item) => item.id === task.runId);
      if (run) {
        run.assistantMessageId = message.id;
        run.updatedAt = message.createdAt;
      }
    }
    return message;
  });
  if (message) {
    await autoRenameChatAfterTurn(config, sessionId).catch((error) => {
      appendLog(config.instance, "chat.auto_title.failed", {
        sessionId,
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return message;
}

export async function autoRenameChatAfterTurn(config: RuntimeConfig, sessionId: string): Promise<void> {
  const snapshot = readState(config.instance);
  const session = snapshot.chatSessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!isDefaultChatTitle(session.title)) return;
  if (isScheduledJobDeliverySession(snapshot, sessionId)) return;

  // Source of truth is chat_blocks (ADR chat-block-protocol.md). The legacy
  // chatMessages table only carries user rows for web-driven chats — assistant
  // text lives in chat_blocks — so a chatMessages-based count would never
  // cross the threshold for the primary UI path.
  const blocks = listChatBlocks(config.instance, sessionId);
  const userBlocks = blocks.filter((b): b is UserTextBlock => b.kind === "user_text");
  const assistantBlocks = blocks.filter(
    (b): b is AssistantTextBlock => b.kind === "assistant_text" && !b.streaming
  );
  if (userBlocks.length < AUTO_RENAME_USER_TURNS || assistantBlocks.length < AUTO_RENAME_ASSISTANT_TURNS) return;

  const title = await generateChatTitleFromBlocks(config, blocks, session.agentId);
  if (!title) return;

  let renamed = false;
  const updated = await mutateState(config.instance, (state) => {
    const live = state.chatSessions.find((item) => item.id === sessionId);
    if (!live) return undefined;
    if (!isDefaultChatTitle(live.title)) return live;
    if (isScheduledJobDeliverySession(state, sessionId)) return live;
    renamed = true;
    return renameChatSession(state, sessionId, title);
  });
  // Publish only when the title actually changed — re-emitting on
  // every turn would push redundant events to subscribers and force
  // them to re-render the header for no reason. The branches above
  // that return `live` (already-titled session, scheduled-job
  // delivery) intentionally skip the publish.
  if (renamed && updated) publishChatSession(config.instance, updated);
}

function isDefaultChatTitle(title: string): boolean {
  return DEFAULT_CHAT_TITLES.has(title.trim());
}

function isScheduledJobDeliverySession(state: ReturnType<typeof readState>, sessionId: string): boolean {
  const session = state.chatSessions.find((item) => item.id === sessionId);
  if (session?.origin === "job") return true;
  return state.jobs.some((job) => job.chatSessionId === sessionId);
}

async function generateChatTitleFromBlocks(
  config: RuntimeConfig,
  blocks: ChatBlock[],
  agentId: string | undefined
): Promise<string | undefined> {
  const turns = blocks
    .filter((b) => b.kind === "user_text" || (b.kind === "assistant_text" && !b.streaming))
    .slice(-8)
    .map((b) => {
      const text = (b as UserTextBlock | AssistantTextBlock).text ?? "";
      return `${b.kind === "user_text" ? "User" : "Assistant"}: ${text}`;
    });
  const transcript = turns.join("\n");
  if (!transcript) return undefined;

  const result = await generateStructured(
    config,
    {
      schemaName: "ChatTitle",
      echoTag: "chat-title",
      system: [
        "You write concise sidebar titles for chat conversations.",
        "Choose the title from the conversation's actual topic and intent.",
        "Return JSON with one field: title.",
        "Use 2 to 7 words. No quotes, emojis, markdown, punctuation padding, or prefixes like \"Chat about\"."
      ].join(" "),
      user: `Conversation transcript:\n${transcript}`,
      validator: {
        parse(value: unknown) {
          if (!value || typeof value !== "object") return { title: "" };
          const title = (value as { title?: unknown }).title;
          return { title: sanitizeGeneratedChatTitle(title) ?? "" };
        }
      }
    },
    providerOverrideForRuntime(config)
  );
  void recordUsage(config.instance, { source: "chat-title", agentId }, result.cost).catch(() => {});
  return result.data.title || undefined;
}

function sanitizeGeneratedChatTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^["'`*_#\s.?!:;,-]+|["'`*_#\s.?!:;,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  if (isDefaultChatTitle(title)) return undefined;
  return title;
}
