// Chat-block emission helpers.
//
// The chat-task agent loop in chat-task.ts and the approval-resume path in
// agent.ts both need to land ChatBlock rows (user_text, assistant_text
// streaming deltas, tool_call, tool_result, phase, approval_requested,
// system_note) into the SQLite chat_blocks table that backs the
// `/api/chat/:id/blocks` and `/api/chat/:id/stream` endpoints (see ADR
// chat-block-protocol.md).
//
// This module:
//
//   1. Resolves the (sessionId, agentId, runId) for a given task by
//      walking taskId → task.chatSessionId → ChatSessionRecord. Tasks
//      with no chatSessionId (subagent children, imperative CLI runs)
//      get a no-op shim so the chat-task call sites stay flat.
//   2. Wraps insertChatBlock / upsertAssistantTextBlock /
//      updateToolCallBlock so callers pass the kind-specific fields
//      and don't repeat the resolution boilerplate.
//   3. Wraps the tool-catalog helpers (chatBlockLabelFor /
//      chatBlockArgsPreviewFor) so tool_call emission is one call.
//
// The emit functions are intentionally tolerant of missing context:
// when readState can't find the session (e.g. it was deleted between
// task spawn and emission), they no-op and append a trace line. That
// behavior matches deleteChatSession's cascade delete — clients that
// fetched the block list at the right moment may see partial state,
// but the runtime never crashes mid-loop on a missing session.

import {
  appendLog,
  appendTrace,
  deleteChatBlock,
  insertChatBlock,
  readState,
  updateToolCallBlock,
  upsertAssistantTextBlock,
  type InsertChatBlockInput
} from "../state";
import type {
  AssistantTextBlock,
  AuthorizationAction,
  ChatBlock,
  Instance,
  RiskLevel,
  RuntimeConfig,
  SetupRequestAction,
  SystemNoteAuthError,
  Task,
  ToolCallStatus
} from "../types";
import { chatBlockArgsPreviewFor, chatBlockLabelFor } from "./tool-catalog";
import { redactSensitiveToolArgs } from "./tool-args-redact";
import { isSilentReply } from "../jobs/silent";

// Resolved chat-task emission context. Callers pass this through every
// per-iteration emission so we don't re-read state on each row.
export interface ChatEmitContext {
  instance: Instance;
  sessionId: string;
  agentId?: string;
  runId?: string;
  taskId: string;
  // Thread membership stamped onto every block emitted through this context.
  // Set when the turn is pre-seeded from the Task for a thread-reply. Absent
  // for main-chat turns.
  threadId?: string;
  parentBlockId?: string;
  // Render-only child→parent activity mirror target (ADR
  // chat-topics-tasks-subagents.md). Set when the emitting session has a
  // parentChatSessionId whose parent still exists — a Topic under Chat, or a
  // spawned child task container under its parent — so every emit helper can
  // mirror its block one level up into the parent thread. Forwarded copies
  // are never replayed into the model context.
  forward?: { sessionId: string; topicId: string; topicTitle: string };
}

// Resolve the emission context for a task. Returns undefined when the
// task has no chatSessionId — e.g. subagent children (per ADR
// chat-block-protocol.md the parent's spawn_subagent tool_call is the
// only visible row from a subagent run) and imperative CLI tasks.
//
// Also returns undefined when the chat session has been deleted since
// task spawn; the emit helpers below treat both cases identically
// (silent no-op + trace line) so call sites don't branch.
export function resolveEmitContext(
  config: RuntimeConfig,
  taskId: string
): ChatEmitContext | undefined {
  const state = readState(config.instance);
  const task: Task | undefined = state.tasks.find((t) => t.id === taskId);
  if (!task?.chatSessionId) return undefined;
  const session = state.chatSessions.find((s) => s.id === task.chatSessionId);
  if (!session) return undefined;
  // When the turn runs inside ANY child container (a session with a
  // parentChatSessionId whose parent still exists), every block it emits is
  // mirrored render-only one level up into the parent thread. The wire
  // fields keep the forwardedFromTopic* names (payload_json, render-only).
  const parentSession = session.parentChatSessionId
    ? state.chatSessions.find((s) => s.id === session.parentChatSessionId)
    : undefined;
  const forward = parentSession
    ? { sessionId: parentSession.id, topicId: session.id, topicTitle: session.title }
    : undefined;
  return {
    instance: config.instance,
    sessionId: task.chatSessionId,
    agentId: task.agentId ?? session.agentId,
    runId: task.runId,
    taskId,
    // Pre-thread the context when the task was spawned to reply inside a
    // thread. The whole response then threads.
    ...(task.threadId ? { threadId: task.threadId } : {}),
    ...(task.parentBlockId ? { parentBlockId: task.parentBlockId } : {}),
    ...(forward ? { forward } : {})
  };
}

// Common bookkeeping fields shared by every emit helper. Callers omit
// the kind-specific narrowing fields and we fill in sessionId, taskId,
// runId, agentId from the ChatEmitContext.
type EmitBookkeeping = Pick<ChatEmitContext, "sessionId" | "taskId" | "runId" | "threadId" | "parentBlockId"> & {
  agentId?: string | null;
};

function bookkeepingFor(ctx: ChatEmitContext): EmitBookkeeping {
  return {
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    // Stamp thread membership onto every kind of block (assistant text, tool
    // calls, tool results, phases, …) so an entire threaded turn stays in the
    // thread. insertChatBlock already persists these columns.
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    ...(ctx.parentBlockId ? { parentBlockId: ctx.parentBlockId } : {})
  };
}

// Emit a phase block. Used for the "Thinking", "Working: <toolName>",
// "Completed", "Cancelled" markers the chat UI renders between
// substantive blocks. Returns the inserted block (or undefined for
// no-context tasks).
export function emitPhase(
  ctx: ChatEmitContext | undefined,
  label: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "phase",
    label,
    ...bookkeepingFor(ctx)
  });
  mirrorInsert(ctx, (forward) => ({
    kind: "phase",
    sessionId: forward.sessionId,
    label,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    forwardedFromTopicId: forward.forwardedFromTopicId,
    forwardedFromTopicTitle: forward.forwardedFromTopicTitle
  }));
  return block;
}

// Emit a system_note block. Used for terminal-bail-out markers
// (cancellation, iteration-cap exhaustion, dispatch error before any
// tool ran) — anything that's runtime-level rather than user- or
// assistant-authored. Pass `authError` for a provider-credential failure
// so the client can name the provider and offer a re-auth CTA (issue #205).
export function emitSystemNote(
  ctx: ChatEmitContext | undefined,
  text: string,
  authError?: SystemNoteAuthError
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "system_note",
    text,
    ...(authError ? { authError } : {}),
    ...bookkeepingFor(ctx)
  });
  mirrorInsert(ctx, (forward) => ({
    kind: "system_note",
    sessionId: forward.sessionId,
    text,
    ...(authError ? { authError } : {}),
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    forwardedFromTopicId: forward.forwardedFromTopicId,
    forwardedFromTopicTitle: forward.forwardedFromTopicTitle
  }));
  return block;
}

// Emit a user_text block. Called by submitChatMessage right after
// createChatMessage(role:"user", …) — the legacy ChatMessageRecord and
// the new ChatBlock are dual-published during the migration window
// (ADR chat-block-protocol.md migration sequencing).
export function emitUserText(
  ctx: ChatEmitContext | undefined,
  text: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  return insertChatBlock(ctx.instance, {
    kind: "user_text",
    text,
    ...bookkeepingFor(ctx)
  });
}

// Insert an assistant_text block in `streaming: true` mode on the first
// provider-text delta. Subsequent deltas flow through
// updateAssistantTextDelta with the same id. The terminal flip to
// `streaming: false` flows through finalizeAssistantText, which keeps
// the accreted text intact.
export function emitAssistantTextStart(
  ctx: ChatEmitContext | undefined,
  text: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "assistant_text",
    text,
    streaming: true,
    ...bookkeepingFor(ctx)
  });
  return block.kind === "assistant_text" ? block : undefined;
}

// Update an in-flight assistant_text block. The wire contract is "full
// accreted text on every delta", so callers pass the running total
// rather than the increment — clients merge by id and reconnects are
// idempotent.
export function updateAssistantTextDelta(
  ctx: ChatEmitContext | undefined,
  blockId: string,
  fullText: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const updated = upsertAssistantTextBlock(ctx.instance, blockId, {
    text: fullText,
    streaming: true
  });
  return updated?.kind === "assistant_text" ? updated : undefined;
}

// Flip a streaming assistant_text block to its terminal state with the
// final text. Used both on natural completion (the model's final
// no-tool-call turn) and on cancellation (where the partial text is
// preserved per ADR chat-block-protocol.md risks §4).
export function finalizeAssistantText(
  ctx: ChatEmitContext | undefined,
  blockId: string,
  finalText: string
): AssistantTextBlock | undefined {
  if (!ctx) return undefined;
  const updated = upsertAssistantTextBlock(ctx.instance, blockId, {
    text: finalText,
    streaming: false
  });
  // Sole Topic→Chat forwarder of assistant_text (both intermediate narration
  // and the final answer). Mirror a non-streaming copy into the parent Chat,
  // skipping text the parent should never show: empty, the "(no content)"
  // placeholder, or a [SILENT] reply (retracted in the Topic too).
  const trimmed = finalText.trim();
  if (trimmed.length > 0 && trimmed !== "(no content)" && !isSilentReply(finalText)) {
    mirrorInsert(ctx, (forward) => ({
      kind: "assistant_text",
      sessionId: forward.sessionId,
      text: finalText,
      streaming: false,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      forwardedFromTopicId: forward.forwardedFromTopicId,
      forwardedFromTopicTitle: forward.forwardedFromTopicTitle
    }));
  }
  return updated?.kind === "assistant_text" ? updated : undefined;
}

// Retract an in-flight streamed assistant_text block instead of
// finalizing it. Used when the completed turn's text is the cron
// [SILENT] sentinel — the legacy message layer suppresses delivery, so
// the chat-block layer must not leave a visible "[SILENT]" row behind.
// No-op without an emit context (subagent children with no session).
export function deleteAssistantTextBlock(
  ctx: ChatEmitContext | undefined,
  blockId: string
): void {
  if (!ctx) return;
  deleteChatBlock(ctx.instance, blockId);
}

// Insert a tool_call block in `running` status right before dispatch.
// `argsFull` carries the parsed JSON args with credential-bearing values
// scrubbed via redactSensitiveToolArgs (clients expand to it for the
// "show full args" affordance, so a secret arg — apiKey / token /
// Authorization header — must not land here); `argsPreview` is the inline
// headline (file path / URL / command), capped to 80 chars by
// chatBlockArgsPreviewFor. argsFull is DISPLAY-only — dispatch parses the
// raw tool args independently, so redacting here does not affect execution.
export function emitToolCallRunning(
  ctx: ChatEmitContext | undefined,
  params: {
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
    resolveRefLabel?: (ref: string) => { role: string; name: string } | undefined;
    resolveJobName?: (jobId: string) => string | undefined;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "tool_call",
    toolName: params.toolName,
    displayLabel: chatBlockLabelFor(params.toolName),
    argsPreview: chatBlockArgsPreviewFor(params.toolName, params.args, params.resolveRefLabel, params.resolveJobName),
    argsFull: redactSensitiveToolArgs(params.args),
    status: "running",
    callId: params.callId,
    ...bookkeepingFor(ctx)
  });
  if (block.kind === "tool_call") {
    mirrorInsert(ctx, (forward) => ({
      kind: "tool_call",
      sessionId: forward.sessionId,
      toolName: block.toolName,
      displayLabel: block.displayLabel,
      argsPreview: block.argsPreview,
      argsFull: block.argsFull,
      status: "running",
      callId: block.callId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      agentId: ctx.agentId,
      forwardedFromTopicId: forward.forwardedFromTopicId,
      forwardedFromTopicTitle: forward.forwardedFromTopicTitle
    }));
  }
  return block;
}

// Attach a `runningHint` to a tool_call block that's already mounted in
// `running` status. The hint is advisory context a tool emits to explain
// why it's parked — currently only used by tools that block on an
// external event the agent can't drive (e.g. wait_for_messaging_pair
// blocking on an inbound Telegram DM). Clients may render the row more
// prominently when the hint is set; the wire contract is advisory, not a
// new block kind. The hint is cleared automatically when the tool's
// status leaves "running" (see updateToolCallBlock); a no-op when there's
// no emit context (subagent children with no session) or when the block
// can't be found.
export function setToolCallRunningHint(
  ctx: ChatEmitContext | undefined,
  callId: string,
  hint: string
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const updated = updateToolCallBlock(ctx.instance, callId, ctx.sessionId, { runningHint: hint }, ctx.taskId);
  mirrorToolCallUpdate(ctx, callId, { runningHint: hint });
  return updated ?? undefined;
}

// Flip a tool_call row's status (running → ok | error | denied). The
// lookup is by (sessionId, callId) scoped to ctx.taskId so callers don't
// need the block id — the chat-task loop and the approval-resume path both
// know the call id. The task scope matters because callId is not unique
// within a session (the codex text-backstop synthesizes a deterministic id
// that recurs across turns), so a settle must confine to its own turn's row.
export function emitToolCallStatus(
  ctx: ChatEmitContext | undefined,
  params: {
    callId: string;
    status: ToolCallStatus;
    errorMessage?: string;
    errorSeverity?: "info" | "error";
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const updated = updateToolCallBlock(ctx.instance, params.callId, ctx.sessionId, {
    status: params.status,
    errorMessage: params.errorMessage,
    errorSeverity: params.errorSeverity
  }, ctx.taskId);
  mirrorToolCallUpdate(ctx, params.callId, {
    status: params.status,
    errorMessage: params.errorMessage,
    errorSeverity: params.errorSeverity
  });
  return updated ?? undefined;
}

// Insert a tool_result block. `preview` is the truncated 80-char
// headline of the tool's result string (clients can show an expand
// hint when `truncated` is true). The full transcript continues to
// live on the legacy ChatMessageRecord during the migration window
// and on the task's audit chain.
export function emitToolResult(
  ctx: ChatEmitContext | undefined,
  params: {
    callId: string;
    result: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const MAX = 80;
  const trimmed = params.result.length > MAX
    ? params.result.slice(0, MAX - 1) + "…"
    : params.result;
  const block = insertChatBlock(ctx.instance, {
    kind: "tool_result",
    callId: params.callId,
    preview: trimmed,
    truncated: params.result.length > MAX,
    ...bookkeepingFor(ctx)
  });
  mirrorInsert(ctx, (forward) => ({
    kind: "tool_result",
    sessionId: forward.sessionId,
    callId: params.callId,
    preview: trimmed,
    truncated: params.result.length > MAX,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    forwardedFromTopicId: forward.forwardedFromTopicId,
    forwardedFromTopicTitle: forward.forwardedFromTopicTitle
  }));
  return block;
}

// Topic → Chat gate forward (ADR chat-topics-tasks-subagents.md). When a
// Topic turn pauses on a user gate (an ask_user choice card / a confirmation /
// an authorization), the question would otherwise land only in the Topic, so a
// user watching Chat never sees it. When the emitting session is a kind:"topic"
// with a parentChatSessionId, mirror a render-only copy of the SAME gate block
// (same id + payload) into the parent Chat. Because gates are global by id,
// acting on the forwarded card from Chat resolves the same gate and resumes the
// Topic turn. Best-effort: a forward failure must never break the gate.
function forwardGateToChat(
  ctx: ChatEmitContext,
  buildInput: (forward: {
    sessionId: string;
    forwardedFromTopicId: string;
    forwardedFromTopicTitle?: string;
  }) => InsertChatBlockInput
): void {
  const state = readState(ctx.instance);
  const session = state.chatSessions.find((s) => s.id === ctx.sessionId);
  if (session?.kind !== "topic" || !session.parentChatSessionId) return;
  try {
    insertChatBlock(
      ctx.instance,
      buildInput({
        sessionId: session.parentChatSessionId,
        forwardedFromTopicId: session.id,
        ...(session.title ? { forwardedFromTopicTitle: session.title } : {})
      })
    );
  } catch (error) {
    appendLog(ctx.instance, "chat.topic_gate_forward.insert_failed", {
      topicId: session.id,
      parentChatSessionId: session.parentChatSessionId,
      taskId: ctx.taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Topic → Chat activity mirror (ADR chat-topics-tasks-subagents.md). When the
// emitting session is a kind:"topic" spawned from a Chat (ctx.forward set),
// mirror a render-only copy of each block into the parent Chat so the user
// watching Chat sees the Topic turn's tool calls, narration, phases, and system
// notes — not just the forwarded final answer. Modeled on forwardGateToChat;
// best-effort: a mirror failure must never break the Topic write.
function mirrorInsert(
  ctx: ChatEmitContext,
  build: (forward: {
    sessionId: string;
    forwardedFromTopicId: string;
    forwardedFromTopicTitle: string;
  }) => InsertChatBlockInput
): void {
  if (!ctx.forward) return;
  try {
    insertChatBlock(
      ctx.instance,
      build({
        sessionId: ctx.forward.sessionId,
        forwardedFromTopicId: ctx.forward.topicId,
        forwardedFromTopicTitle: ctx.forward.topicTitle
      })
    );
  } catch (error) {
    appendLog(ctx.instance, "chat.topic_mirror.insert_failed", {
      topicId: ctx.forward.topicId,
      parentChatSessionId: ctx.forward.sessionId,
      taskId: ctx.taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Status/hint variant of the activity mirror: flip the parent Chat's mirrored
// tool_call copy by (callId, taskId). The mirror shares both the callId and the
// taskId with the Topic copy, so updateToolCallBlock with the parent sessionId
// finds the right row.
function mirrorToolCallUpdate(
  ctx: ChatEmitContext,
  callId: string,
  patch: {
    status?: ToolCallStatus;
    errorMessage?: string;
    errorSeverity?: "info" | "error";
    runningHint?: string;
  }
): void {
  if (!ctx.forward) return;
  try {
    updateToolCallBlock(ctx.instance, callId, ctx.forward.sessionId, patch, ctx.taskId);
  } catch (error) {
    appendLog(ctx.instance, "chat.topic_mirror.update_failed", {
      topicId: ctx.forward.topicId,
      parentChatSessionId: ctx.forward.sessionId,
      taskId: ctx.taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Insert an authorization_requested block when a tool call is gated
// pending user approval/denial (agent-actor flow).
export function emitAuthorizationRequested(
  ctx: ChatEmitContext | undefined,
  params: {
    authorizationId: string;
    action: AuthorizationAction;
    risk: RiskLevel;
    summary: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "authorization_requested",
    authorizationId: params.authorizationId,
    action: params.action,
    risk: params.risk,
    summary: params.summary,
    ...bookkeepingFor(ctx)
  });
  forwardGateToChat(ctx, (forward) => ({
    kind: "authorization_requested",
    sessionId: forward.sessionId,
    authorizationId: params.authorizationId,
    action: params.action,
    risk: params.risk,
    summary: params.summary,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    forwardedFromTopicId: forward.forwardedFromTopicId,
    ...(forward.forwardedFromTopicTitle ? { forwardedFromTopicTitle: forward.forwardedFromTopicTitle } : {})
  }));
  return block;
}

// Insert a setup_requested block when a tool call needs the user to
// perform a setup step (browser.connect, connector.request, or
// browser.fill_secret). No risk pill is rendered — the rule is
// structural per docs/adr/authorization-vs-setup-request.md.
export function emitSetupRequested(
  ctx: ChatEmitContext | undefined,
  params: {
    setupRequestId: string;
    action: SetupRequestAction;
    summary: string;
  }
): ChatBlock | undefined {
  if (!ctx) return undefined;
  const block = insertChatBlock(ctx.instance, {
    kind: "setup_requested",
    setupRequestId: params.setupRequestId,
    action: params.action,
    summary: params.summary,
    ...bookkeepingFor(ctx)
  });
  forwardGateToChat(ctx, (forward) => ({
    kind: "setup_requested",
    sessionId: forward.sessionId,
    setupRequestId: params.setupRequestId,
    action: params.action,
    summary: params.summary,
    taskId: ctx.taskId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    forwardedFromTopicId: forward.forwardedFromTopicId,
    ...(forward.forwardedFromTopicTitle ? { forwardedFromTopicTitle: forward.forwardedFromTopicTitle } : {})
  }));
  return block;
}

// Trace helper for the no-context branch. Useful when a higher-level
// caller wants to record that a block was suppressed (e.g. a subagent
// child finishing) so the trace has a breadcrumb without the noise of
// a real block emission.
export function traceMissingEmitContext(
  config: RuntimeConfig,
  taskId: string,
  intent: string
): void {
  appendTrace(config.instance, taskId, {
    type: "task",
    message: `Chat block emission skipped: no chat session bound (${intent})`,
    data: { intent }
  });
}

// Helper kept in this module so the type stays adjacent to the helpers
// that consume it. Re-exported for tests that want to construct a
// known-good context without going through resolveEmitContext.
export type { InsertChatBlockInput };
