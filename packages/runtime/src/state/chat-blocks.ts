// Chat block persistence and pub-sub. Implements the storage half of the
// ChatBlock protocol described in ADR chat-block-protocol.md.
//
// Storage shape: one row per block in the SQLite `chat_blocks` table (see
// memory-db.ts:applyMigrations step 4 for the schema). Each row carries
// the typed payload as JSON in `payload_json` plus denormalized columns
// (session_id, ordinal, kind, task_id, run_id, agent_id, created_at,
// updated_at) for indexable queries. The schema's UNIQUE (session_id,
// ordinal) constraint plus the per-session SELECT-MAX-then-INSERT
// transaction guarantees a single monotonic stream of ordinals even
// under interleaved writers.
//
// Pub-sub: insertChatBlock / upsertChatBlock fire a single EventEmitter
// event per session AFTER the SQLite commit, so subscribers (the SSE
// route in src/http.ts) observe rows that are already durable. Listeners
// are best-effort — a throwing handler is logged via console.warn and
// other subscribers continue to receive the event.

import { EventEmitter } from "node:events";
import type {
  AssistantTextBlock,
  AudioAttachment,
  AuthorizationAction,
  ChatBlock,
  ChatBlockKind,
  ImageAttachment,
  Instance,
  ProviderName,
  RiskLevel,
  SetupRequestAction,
  SystemNoteAuthError,
  ThreadSummary,
  ToolCallBlock,
  ToolCallStatus
} from "../types";
import { id, now } from "./ids";
import { getMemoryDb } from "./memory-db";

// EventEmitter shared across all (instance, sessionId) subscriptions. We
// scope events with the composite key below so different instances /
// sessions don't fan out into each other. Limit is bumped because the SSE
// route may register many concurrent subscribers across browser tabs;
// the default of 10 emits a noisy warning when the third browser tab
// opens a stream.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function subscriptionKey(instance: Instance, sessionId: string): string {
  return `${instance}::${sessionId}`;
}

// Input shape for inserting a brand-new block. Callers omit the bookkeeping
// fields (id, ordinal, createdAt, updatedAt) — those are allocated inside
// the transaction so writers never need to pre-claim ordinals. `agentId`
// is denormalized onto the row so the agent-inbox query in the API doesn't
// have to join through chat_sessions.
//
// For `assistant_text` the caller supplies `streaming: true` on the
// initial insert; subsequent deltas flow through upsertAssistantTextBlock
// with the same id. For all other kinds the row is append-only.
//
// Distribute-over-union so each branch keeps its discriminant + narrowing
// fields rather than the TS compiler collapsing the intersection into a
// shapeless rest type. `assistant_text` and `tool_call` carry an
// `updatedAt` field that's allocated on insert, so they're omitted from
// the input too.
type InsertInputFor<B extends ChatBlock> = B extends AssistantTextBlock | ToolCallBlock
  ? Omit<B, "id" | "ordinal" | "createdAt" | "updatedAt" | "instance"> & {
      agentId?: string | null;
    }
  : Omit<B, "id" | "ordinal" | "createdAt" | "instance"> & {
      agentId?: string | null;
    };
export type InsertChatBlockInput = InsertInputFor<ChatBlock>;

interface ChatBlockRow {
  id: string;
  session_id: string;
  instance: string;
  agent_id: string | null;
  ordinal: number;
  // Includes "approval_requested" as a legacy value still resident in
  // pre-split DBs (the CHECK constraint accepts it; rowToBlock migrates
  // it on read).
  kind: ChatBlockKind | "approval_requested";
  payload_json: string;
  task_id: string | null;
  run_id: string | null;
  thread_id: string | null;
  parent_block_id: string | null;
  created_at: string;
  updated_at: string;
}

// Parse an array of image attachments off a block payload, dropping any
// entry without a usable id. A hand-edited or truncated row must never
// yield a half-formed attachment that a client would try to fetch. Used by
// the user_text parse — the only kind that carries inbound image attachments.
// Outbound agent images ride inline in the reply text as `gini-upload://`
// refs, not a block field (see ADR outbound-chat-attachments.md).
function parseImagesPayload(raw: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const images = raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      id: String(item.id ?? ""),
      mimeType: String(item.mimeType ?? ""),
      size: Number(item.size ?? 0)
    }))
    .filter((image) => image.id.length > 0);
  return images.length > 0 ? images : undefined;
}

// Parse the optional voice attachment off a user_text payload, guarding
// types the same way the inline-image parse does (a hand-edited or
// truncated row must not yield a half-formed attachment).
function parseAudioPayload(raw: unknown): AudioAttachment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const id = String(item.id ?? "");
  if (id.length === 0) return undefined;
  const durationMs = typeof item.durationMs === "number" ? item.durationMs : undefined;
  return {
    id,
    mimeType: String(item.mimeType ?? ""),
    size: Number(item.size ?? 0),
    ...(durationMs !== undefined ? { durationMs } : {})
  };
}

function rowToBlock(row: ChatBlockRow): ChatBlock {
  // The payload column carries the typed kind-specific fields
  // (text/label/toolName/etc.). Bookkeeping fields are denormalized
  // onto their own columns so we can index them — they're re-assembled
  // here without re-reading payload_json for the canonical values.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const base = {
    id: row.id,
    sessionId: row.session_id,
    instance: row.instance as Instance,
    ordinal: row.ordinal,
    createdAt: row.created_at,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    // Omit when NULL so main-chat blocks keep a clean payload.
    ...(row.thread_id != null ? { threadId: row.thread_id } : {}),
    ...(row.parent_block_id != null ? { parentBlockId: row.parent_block_id } : {})
  };
  switch (row.kind) {
    case "user_text": {
      const images = parseImagesPayload(payload.images);
      const audio = parseAudioPayload(payload.audio);
      return {
        ...base,
        kind: "user_text",
        text: String(payload.text ?? ""),
        ...(images ? { images } : {}),
        ...(audio ? { audio } : {})
      };
    }
    case "assistant_text":
      return {
        ...base,
        kind: "assistant_text",
        updatedAt: row.updated_at,
        text: String(payload.text ?? ""),
        streaming: Boolean(payload.streaming),
        // Forward-marker fields ride in payload_json (render-only; no dedicated
        // column). Present only on a Topic answer forwarded into the parent Chat.
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        updatedAt: row.updated_at,
        toolName: String(payload.toolName ?? ""),
        displayLabel: String(payload.displayLabel ?? payload.toolName ?? ""),
        argsPreview: String(payload.argsPreview ?? ""),
        argsFull: (payload.argsFull && typeof payload.argsFull === "object"
          ? (payload.argsFull as Record<string, unknown>)
          : {}),
        status: (payload.status as ToolCallStatus) ?? "running",
        errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
        errorSeverity: payload.errorSeverity === "info" || payload.errorSeverity === "error" ? payload.errorSeverity : undefined,
        callId: String(payload.callId ?? ""),
        runningHint: typeof payload.runningHint === "string" ? payload.runningHint : undefined,
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        callId: String(payload.callId ?? ""),
        preview: String(payload.preview ?? ""),
        truncated: Boolean(payload.truncated),
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "phase":
      return {
        ...base,
        kind: "phase",
        label: String(payload.label ?? ""),
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "approval_requested": {
      // Legacy block kind from before the Authorization/SetupRequest split.
      // Partition by action so old rows render with the right new card
      // type. See docs/adr/authorization-vs-setup-request.md.
      const action = String(payload.action ?? "");
      if (action === "browser.connect" || action === "connector.request" || action === "browser.fill_secret") {
        return {
          ...base,
          kind: "setup_requested",
          setupRequestId: String(payload.approvalId ?? ""),
          action: action as SetupRequestAction,
          summary: String(payload.summary ?? "")
        };
      }
      return {
        ...base,
        kind: "authorization_requested",
        authorizationId: String(payload.approvalId ?? ""),
        action: action as AuthorizationAction,
        risk: (payload.risk as RiskLevel) ?? "low",
        summary: String(payload.summary ?? "")
      };
    }
    case "authorization_requested":
      return {
        ...base,
        kind: "authorization_requested",
        authorizationId: String(payload.authorizationId ?? ""),
        action: String(payload.action ?? "") as AuthorizationAction,
        risk: (payload.risk as RiskLevel) ?? "low",
        summary: String(payload.summary ?? ""),
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "setup_requested":
      return {
        ...base,
        kind: "setup_requested",
        setupRequestId: String(payload.setupRequestId ?? ""),
        action: String(payload.action ?? "") as SetupRequestAction,
        summary: String(payload.summary ?? ""),
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    case "system_note": {
      const raw =
        payload.authError && typeof payload.authError === "object"
          ? (payload.authError as Partial<SystemNoteAuthError>)
          : undefined;
      // Backfill the routing fields for rows written before they existed so
      // every returned block satisfies SystemNoteAuthError (the renderer never
      // sees a half-populated authError).
      const authError: SystemNoteAuthError | undefined = raw
        ? {
            provider: raw.provider as ProviderName,
            providerLabel: String(raw.providerLabel ?? raw.provider ?? ""),
            detail: String(raw.detail ?? ""),
            reauthKind: raw.reauthKind === "docs" || raw.reauthKind === "aws" ? raw.reauthKind : "settings",
            reauthUrl: typeof raw.reauthUrl === "string" ? raw.reauthUrl : "/settings"
          }
        : undefined;
      return {
        ...base,
        kind: "system_note",
        text: String(payload.text ?? ""),
        ...(authError ? { authError } : {}),
        ...(typeof payload.forwardedFromTopicId === "string"
          ? { forwardedFromTopicId: payload.forwardedFromTopicId }
          : {}),
        ...(typeof payload.forwardedFromTopicTitle === "string"
          ? { forwardedFromTopicTitle: payload.forwardedFromTopicTitle }
          : {})
      };
    }
    default: {
      // Exhaustiveness guard. CHECK constraint on the kind column makes
      // this unreachable for rows we wrote, but a hand-edited DB might
      // slip a bad kind through.
      const exhaustive: never = row.kind;
      throw new Error(`Unknown chat_block kind: ${exhaustive}`);
    }
  }
}

// Build the kind-specific payload JSON. Bookkeeping fields are kept on
// dedicated columns; only the kind-specific narrowing fields go into
// the JSON blob.
function payloadFor(block: ChatBlock): string {
  switch (block.kind) {
    case "user_text":
      return JSON.stringify({
        text: block.text,
        ...(block.images && block.images.length > 0 ? { images: block.images } : {}),
        ...(block.audio ? { audio: block.audio } : {})
      });
    case "assistant_text":
      return JSON.stringify({
        text: block.text,
        streaming: block.streaming,
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "tool_call":
      return JSON.stringify({
        toolName: block.toolName,
        displayLabel: block.displayLabel,
        argsPreview: block.argsPreview,
        argsFull: block.argsFull,
        status: block.status,
        errorMessage: block.errorMessage,
        errorSeverity: block.errorSeverity,
        callId: block.callId,
        runningHint: block.runningHint,
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "tool_result":
      return JSON.stringify({
        callId: block.callId,
        preview: block.preview,
        truncated: block.truncated,
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "phase":
      return JSON.stringify({
        label: block.label,
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "authorization_requested":
      return JSON.stringify({
        authorizationId: block.authorizationId,
        action: block.action,
        risk: block.risk,
        summary: block.summary,
        // Forward markers ride in payload_json (render-only) on a gate block
        // copied from a Topic into the parent Chat. Same treatment as the
        // assistant_text forward above.
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "setup_requested":
      return JSON.stringify({
        setupRequestId: block.setupRequestId,
        action: block.action,
        summary: block.summary,
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
    case "system_note":
      return JSON.stringify({
        text: block.text,
        ...(block.authError ? { authError: block.authError } : {}),
        ...(block.forwardedFromTopicId ? { forwardedFromTopicId: block.forwardedFromTopicId } : {}),
        ...(block.forwardedFromTopicTitle ? { forwardedFromTopicTitle: block.forwardedFromTopicTitle } : {})
      });
  }
}

// Allocates the next ordinal slot for a session inside a SQLite
// transaction so concurrent writers don't both grab the same number.
// SQLite serializes writes through the per-database lock, but reading
// MAX(ordinal) and inserting must happen inside a single BEGIN/COMMIT
// pair or two writers could observe the same `next` value.
//
// The schema's UNIQUE (session_id, ordinal) constraint is the last-line
// defense against an interleave bug.
export function insertChatBlock(
  instance: Instance,
  input: InsertChatBlockInput
): ChatBlock {
  const db = getMemoryDb(instance);
  const at = now();
  const blockId = id("block");

  // SAVEPOINT lets nested mutateState callers (which already hold a write
  // lock via the JSON state file) still run this inside their own
  // transaction without conflicting. SQLite TXN nesting is otherwise
  // disallowed; SAVEPOINT works inside or outside one.
  db.exec("SAVEPOINT chat_block_insert");
  try {
    const maxRow = db
      .query<{ m: number | null }, [string]>(
        "SELECT MAX(ordinal) AS m FROM chat_blocks WHERE session_id = ?"
      )
      .get(input.sessionId);
    const nextOrdinal = (maxRow?.m ?? 0) + 1;

    // Build the canonical ChatBlock object from the input + allocated
    // fields so the persisted payload, the row, and the return value
    // all carry exactly the same data.
    const block: ChatBlock = (() => {
      const base = {
        id: blockId,
        sessionId: input.sessionId,
        instance,
        ordinal: nextOrdinal,
        createdAt: at,
        taskId: input.taskId,
        runId: input.runId,
        ...(input.threadId != null ? { threadId: input.threadId } : {}),
        ...(input.parentBlockId != null ? { parentBlockId: input.parentBlockId } : {})
      };
      switch (input.kind) {
        case "user_text":
          return {
            ...base,
            kind: "user_text",
            text: input.text,
            ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
            ...(input.audio ? { audio: input.audio } : {})
          };
        case "assistant_text":
          return {
            ...base,
            kind: "assistant_text",
            updatedAt: at,
            text: input.text,
            streaming: input.streaming,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "tool_call":
          return {
            ...base,
            kind: "tool_call",
            updatedAt: at,
            toolName: input.toolName,
            displayLabel: input.displayLabel,
            argsPreview: input.argsPreview,
            argsFull: input.argsFull,
            status: input.status,
            errorMessage: input.errorMessage,
            errorSeverity: input.errorSeverity,
            callId: input.callId,
            runningHint: input.runningHint,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "tool_result":
          return {
            ...base,
            kind: "tool_result",
            callId: input.callId,
            preview: input.preview,
            truncated: input.truncated,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "phase":
          return {
            ...base,
            kind: "phase",
            label: input.label,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "authorization_requested":
          return {
            ...base,
            kind: "authorization_requested",
            authorizationId: input.authorizationId,
            action: input.action,
            risk: input.risk,
            summary: input.summary,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "setup_requested":
          return {
            ...base,
            kind: "setup_requested",
            setupRequestId: input.setupRequestId,
            action: input.action,
            summary: input.summary,
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
        case "system_note":
          return {
            ...base,
            kind: "system_note",
            text: input.text,
            ...(input.authError ? { authError: input.authError } : {}),
            ...(input.forwardedFromTopicId ? { forwardedFromTopicId: input.forwardedFromTopicId } : {}),
            ...(input.forwardedFromTopicTitle ? { forwardedFromTopicTitle: input.forwardedFromTopicTitle } : {})
          };
      }
    })();

    db.run(
      `INSERT INTO chat_blocks
         (id, session_id, instance, agent_id, ordinal, kind, payload_json,
          task_id, run_id, thread_id, parent_block_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id,
        block.sessionId,
        instance,
        input.agentId ?? null,
        block.ordinal,
        block.kind,
        payloadFor(block),
        block.taskId ?? null,
        block.runId ?? null,
        input.threadId ?? null,
        input.parentBlockId ?? null,
        block.createdAt,
        block.kind === "assistant_text" ? block.updatedAt : at
      ]
    );
    db.exec("RELEASE chat_block_insert");
    publish(instance, block);
    return block;
  } catch (error) {
    db.exec("ROLLBACK TO chat_block_insert");
    db.exec("RELEASE chat_block_insert");
    throw error;
  }
}

// Finds the latest in-flight (streaming) assistant_text block for a
// task. Used by the cancellation path in agent.ts to flip the row to
// `streaming: false` while preserving the partial text observed so far
// (ADR chat-block-protocol.md risks §4). Returns the block id, full
// accreted text, and session id so the caller can route both the
// finalize and the follow-on system_note through the same session.
// Returns null when the task has no chat session bound, no streaming
// row, or the schema has no chat_blocks rows yet.
export function findInFlightAssistantTextForTask(
  instance: Instance,
  taskId: string
): { blockId: string; sessionId: string; text: string } | null {
  const db = getMemoryDb(instance);
  // Search for the latest assistant_text row that's still streaming and
  // was emitted by this task. Streaming rows have `payload.streaming
  // === true`; we use json_extract because the column lives in
  // payload_json. There's at most one in practice (a single in-flight
  // assistant_text per loop iteration), but ordering by ordinal DESC
  // makes the read deterministic regardless.
  const row = db
    .query<ChatBlockRow, [string]>(
      `SELECT * FROM chat_blocks
       WHERE task_id = ? AND kind = 'assistant_text'
         AND json_extract(payload_json, '$.streaming') = 1
       ORDER BY ordinal DESC
       LIMIT 1`
    )
    .get(taskId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    blockId: row.id,
    sessionId: row.session_id,
    text: String(payload.text ?? "")
  };
}

// One-shot boot heal for orphaned streaming assistant_text blocks (the "stuck
// cursor"). A block left at streaming:true by a process that died/was killed
// mid-stream — whose owning task is now terminal, waiting_approval, or pruned
// from state.json — would otherwise render a perpetual cursor forever, since
// nothing replays a dead turn. This settles each such block in place
// (streaming:false, its OWN accreted text re-written verbatim — never empty),
// the same lossless flip finalizeAssistantText performs on a live cancel.
//
// SAFETY (see docs/adr/chat-block-protocol.md + the per-turn-abort design):
//   - The caller MUST run this on a quiescent boot, BEFORE the gateway binds
//     its HTTP port and BEFORE reconcileInFlightTasks re-dispatches resumed
//     turns, so no live or resumed writer can race the finalize. (mutateState
//     locks only state.json, never chat_blocks — placement IS the race guard.)
//   - `cutoffIso` excludes any block touched at/after this boot (a block whose
//     updated_at >= cutoff belongs to a turn THIS process started, not an
//     orphan). Same updatedAt<cutoff discipline reconcileInFlightTasks uses.
//   - `isSafeToHeal(taskId)` is supplied by the caller from state.json: it MUST
//     return false for running/queued tasks (a running/queued orphan is resumed
//     by reconcileInFlightTasks, which mints a FRESH block — the resume path,
//     not this sweep, owns settling its stale block) and true only for
//     terminal/waiting_approval/absent-task blocks. taskId is null for rows with
//     no owning task (legacy/pruned), which the caller treats as safe.
//
// Scans via idx_chat_blocks_streaming (the partial index on the same predicate)
// so cost is O(stuck rows), not a full table scan. Returns the number of blocks
// healed. Does NOT publish() — a boot backfill of old orphans has no live SSE
// subscriber, and a silent in-place settle avoids waking pollers with stale
// months-old rows.
export function healOrphanedStreamingBlocks(
  instance: Instance,
  cutoffIso: string,
  isSafeToHeal: (taskId: string | null) => boolean
): number {
  const db = getMemoryDb(instance);
  const rows = db
    .query<ChatBlockRow, [string]>(
      `SELECT * FROM chat_blocks
       WHERE kind = 'assistant_text'
         AND json_extract(payload_json, '$.streaming') = 1
         AND updated_at < ?`
    )
    .all(cutoffIso);
  let healed = 0;
  for (const row of rows) {
    if (!isSafeToHeal(row.task_id ?? null)) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    // Re-write the block's OWN text verbatim and only flip the flag — the
    // last-writer-wins upsert means passing anything else would destroy the
    // user-visible partial reply.
    payload.text = String(payload.text ?? "");
    payload.streaming = false;
    db.run(
      `UPDATE chat_blocks SET payload_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(payload), now(), row.id]
    );
    healed += 1;
  }
  return healed;
}

// Returns true when the given task has emitted at least one
// assistant_text block whose text is non-empty after trimming. The push
// dispatcher consults this on terminal `phase: Completed` blocks to
// decide between an alert (the task produced a user-visible message) and
// a silent badge tick (only tool calls / system notes — nothing for the
// user to read). Uses LIMIT 1 + EXISTS-style early exit so the lookup
// stays O(rows-until-first-hit) rather than scanning the whole task.
export function taskProducedAssistantText(
  instance: Instance,
  taskId: string
): boolean {
  const db = getMemoryDb(instance);
  const row = db
    .query<{ payload_json: string }, [string]>(
      `SELECT payload_json FROM chat_blocks
       WHERE task_id = ? AND kind = 'assistant_text'
       ORDER BY ordinal ASC`
    )
    .all(taskId);
  for (const r of row) {
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        return true;
      }
    } catch {
      // malformed row — skip
    }
  }
  return false;
}

// Returns the full text of the most recent non-empty, FINALIZED
// assistant_text block in a session, or null when the session has none.
// The push notification-preview endpoint consults this so the iOS
// Notification Service Extension can show the latest assistant reply on
// the lock screen. Because it reads the latest row by ordinal (not by
// task), a notification collapsed onto a single session entry always
// reflects the newest completed message even across multiple agent turns.
//
// Only finalized rows (`streaming = false`) are considered: the NSE
// fetches this asynchronously after a turn's `Completed` push, and by then
// a *newer* turn may already be mid-stream (a quick user follow-up or a
// job firing on the same session). Without the finalized filter the
// preview could surface that newer turn's half-streamed partial text under
// the older turn's "new message" banner — confusing, even though it would
// eventually converge. A streaming block carries the full accreted text on
// every delta and flips to `streaming = false` on its terminal delta, so
// filtering to finalized rows yields the last *complete* reply.
//
// Thread replies are excluded so the preview tracks the main chat the
// notification deep-links to. Rows are scanned newest-first (ordinal DESC)
// and the loop stops at the first non-empty text, skipping trailing
// whitespace-only blocks — in the common case that's a single row.
export function latestAssistantTextForSession(
  instance: Instance,
  sessionId: string
): string | null {
  return scanLatestFinalizedAssistantText(
    instance,
    `SELECT payload_json FROM chat_blocks
     WHERE session_id = ? AND kind = 'assistant_text' AND thread_id IS NULL
       AND json_extract(payload_json, '$.streaming') = 0
     ORDER BY ordinal DESC`,
    [sessionId]
  );
}

// Thread variant: the newest finalized assistant reply WITHIN a specific
// thread. The push dispatcher emits a `message_completed` alert for a
// threaded turn too (the turn produced a real reply), but that reply lives
// under a thread_id — so the main-chat lookup above would surface stale
// main-chat text or nothing. The notification-preview endpoint calls this
// instead when the push carries a threadId, so a threaded completion shows
// the thread's own reply.
export function latestAssistantTextForThread(
  instance: Instance,
  sessionId: string,
  threadId: string
): string | null {
  return scanLatestFinalizedAssistantText(
    instance,
    `SELECT payload_json FROM chat_blocks
     WHERE session_id = ? AND thread_id = ? AND kind = 'assistant_text'
       AND json_extract(payload_json, '$.streaming') = 0
     ORDER BY ordinal DESC`,
    [sessionId, threadId]
  );
}

// Shared scan: run the query (already ordered newest-first), return the
// first row whose payload `text` is non-empty after trimming, else null.
// Skips whitespace-only and malformed rows. Both the main-chat and thread
// lookups above differ only in their WHERE clause, so they share this.
function scanLatestFinalizedAssistantText(
  instance: Instance,
  sql: string,
  params: string[]
): string | null {
  const db = getMemoryDb(instance);
  const rows = db.query<{ payload_json: string }, string[]>(sql).all(...params);
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        return payload.text;
      }
    } catch {
      // malformed row — skip and keep scanning older blocks
    }
  }
  return null;
}

// Updates an existing assistant_text block's text + updated_at without
// allocating a new ordinal. Used by the streaming-delta path: the first
// delta inserts the block via insertChatBlock; subsequent deltas flow
// through here with the same id and the running total text so listeners
// can render a continuously growing message without splicing deltas
// client-side.
//
// Also flips `streaming: false` on the terminal delta. Callers pass the
// full accreted text — the wire contract is "carry the whole string on
// every frame" exactly so reconnect/resume is idempotent.
export function upsertAssistantTextBlock(
  instance: Instance,
  blockId: string,
  patch: { text: string; streaming: boolean }
): ChatBlock | null {
  const db = getMemoryDb(instance);
  const at = now();
  const row = db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE id = ? AND kind = 'assistant_text'"
    )
    .get(blockId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  payload.text = patch.text;
  payload.streaming = patch.streaming;
  db.run(
    `UPDATE chat_blocks
       SET payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(payload), at, blockId]
  );
  const updated = rowToBlock({ ...row, payload_json: JSON.stringify(payload), updated_at: at });
  publish(instance, updated);
  return updated;
}

// Attaches a task/run to an existing user_text block in place. Used by the
// echo-first submit path: the block is inserted render-only at accept time
// (before the routing verdict exists), and the chat-direct dispatch later
// binds it to the turn it started — instead of inserting a duplicate bubble.
// Publishes the updated block so live subscribers pick up the association.
// Returns null when the block no longer exists (e.g. its session was
// deleted while the verdict was pending).
export function attachTaskToUserTextBlock(
  instance: Instance,
  blockId: string,
  binding: { taskId: string; runId: string }
): ChatBlock | null {
  const db = getMemoryDb(instance);
  const at = now();
  const row = db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE id = ? AND kind = 'user_text'"
    )
    .get(blockId);
  if (!row) return null;
  db.run(
    `UPDATE chat_blocks
       SET task_id = ?, run_id = ?, updated_at = ?
     WHERE id = ?`,
    [binding.taskId, binding.runId, at, blockId]
  );
  const updated = rowToBlock({
    ...row,
    task_id: binding.taskId,
    run_id: binding.runId,
    updated_at: at
  });
  publish(instance, updated);
  return updated;
}

// Updates an existing tool_call block in place — used to flip a running
// row to `ok`, `error`, or `denied` once the dispatch resolves (and to
// stamp `errorMessage` on error). Looking up by call_id makes the resume
// path simple: the chat-task loop and the approval-resume path both
// know the provider-issued call id but not the block id.
//
// `taskId` scopes the lookup to the OWNING turn. callId is NOT globally
// unique within a session: the codex text-backstop synthesizes a
// deterministic, content-derived id (`call_textbackstop_<hash>`) that
// recurs across turns when the same gated call is re-emitted. Without the
// task filter, a LATE settle for an old turn (e.g. an approved action that
// was aborted by a cancel, or a resume-terminal bail) would match the
// NEWEST `(session_id, callId)` row by ordinal and overwrite a fresh
// turn's tool_call with a stale status. Scoping by `task_id` confines each
// settle to its own turn's row. Omitting `taskId` keeps the legacy
// session+callId behavior for callers (and tests) without task context.
export function updateToolCallBlock(
  instance: Instance,
  callId: string,
  sessionId: string,
  patch: {
    status?: "running" | "ok" | "error" | "denied";
    errorMessage?: string;
    errorSeverity?: "info" | "error";
    runningHint?: string;
  },
  taskId?: string
): ChatBlock | null {
  const db = getMemoryDb(instance);
  const at = now();
  const row = taskId !== undefined
    ? db
        .query<ChatBlockRow, [string, string, string]>(
          `SELECT * FROM chat_blocks
           WHERE session_id = ? AND kind = 'tool_call'
             AND json_extract(payload_json, '$.callId') = ?
             AND task_id = ?
           ORDER BY ordinal DESC
           LIMIT 1`
        )
        .get(sessionId, callId, taskId)
    : db
        .query<ChatBlockRow, [string, string]>(
          `SELECT * FROM chat_blocks
           WHERE session_id = ? AND kind = 'tool_call'
             AND json_extract(payload_json, '$.callId') = ?
           ORDER BY ordinal DESC
           LIMIT 1`
        )
        .get(sessionId, callId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.errorMessage !== undefined) payload.errorMessage = patch.errorMessage;
  if (patch.errorSeverity !== undefined) payload.errorSeverity = patch.errorSeverity;
  // Clear the running hint when the tool leaves the running state — the
  // amber waiting-card is only meaningful while we're still waiting.
  if (patch.runningHint !== undefined) payload.runningHint = patch.runningHint;
  if (patch.status !== undefined && patch.status !== "running") delete payload.runningHint;
  db.run(
    `UPDATE chat_blocks
       SET payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(payload), at, row.id]
  );
  const updated = rowToBlock({ ...row, payload_json: JSON.stringify(payload), updated_at: at });
  publish(instance, updated);
  return updated;
}

// Returns blocks for a session in ordinal-ascending order. Used by the
// initial GET /api/chat/:id/blocks fetch and by the SSE handler when no
// Last-Event-ID is supplied.
export function listChatBlocks(instance: Instance, sessionId: string): ChatBlock[] {
  const db = getMemoryDb(instance);
  return db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE session_id = ? ORDER BY ordinal ASC"
    )
    .all(sessionId)
    .map(rowToBlock);
}

// Returns blocks added (or last-updated, for assistant_text and tool_call)
// AFTER the given Last-Event-ID cursor. Used by the SSE handler so a
// reconnecting client gets only what it missed. When the cursor row is
// not found in the table (rolled out / wrong session), returns the full
// list — best-effort recovery, mirroring the legacy eventStream
// ring-buffer behavior in src/http.ts.
//
// Cursor format: the SSE emitter writes `id: <block_id>:<ts>` where `ts`
// is the row's `updated_at` snapshot at emit time. On reconnect the
// client (react-native-sse or any compliant EventSource) round-trips
// that string as `Last-Event-ID`. Parsing it back gives us:
//   - `cursor_id`  — used to read the cursor row's current `ordinal`
//                     (so the >ordinal half of the resume filter keeps
//                     working for late-arriving insert-only kinds)
//   - `client_ts`  — the timestamp the client actually saw, NOT the
//                     row's current `updated_at`. This is what makes
//                     in-place mutations (assistant_text deltas,
//                     tool_call status flips) on the cursor row itself
//                     replay correctly — the row's updated_at moved
//                     forward while the client was offline, and the
//                     comparison must be against the older snapshot.
//
// Back-compat: an old client without the `:<ts>` suffix falls back to
// reading the cursor row's CURRENT `updated_at` as `client_ts`. Combined
// with the `>=` comparison below, this means the cursor row itself is
// still replayed with whatever payload it currently holds. The semantic
// gap vs. the suffixed path: if the cursor row was upserted between the
// snapshot the client saw and the resume, the bare-id client receives
// the latest payload (correct) but cannot prove which version it had.
// Earlier-ordinal in-place mutations that landed strictly before the
// fallback's `cutoff.updated_at` are not replayed — only the suffixed
// `<id>:<ts>` form preserves the client's actual snapshot timestamp.
//
// Resume filter: `(ordinal > cursor.ordinal OR updated_at >= client_ts)`.
// The `>=` handles same-ms ties — two events sharing an ISO timestamp
// would otherwise cause one to be skipped. The client's id-keyed upsert
// collapses any benign re-replay of the unchanged cursor row.
export function listChatBlocksAfter(
  instance: Instance,
  sessionId: string,
  afterBlockId: string | null
): ChatBlock[] {
  if (!afterBlockId) return listChatBlocks(instance, sessionId);
  // Parse the optional `:<ts>` suffix off the cursor. ISO timestamps
  // never contain `:` outside the time portion, so we split on the FIRST
  // `:` to separate the block id from the remainder; the block id format
  // (`block_<random>`) does not contain `:` either.
  const colonIdx = afterBlockId.indexOf(":");
  const cursorId =
    colonIdx === -1 ? afterBlockId : afterBlockId.slice(0, colonIdx);
  const clientTsFromCursor =
    colonIdx === -1 ? null : afterBlockId.slice(colonIdx + 1);

  const db = getMemoryDb(instance);
  const cutoff = db
    .query<{ ordinal: number; updated_at: string }, [string, string]>(
      "SELECT ordinal, updated_at FROM chat_blocks WHERE id = ? AND session_id = ?"
    )
    .get(cursorId, sessionId);
  if (!cutoff) {
    // Cursor is unknown to this session — replay everything we have.
    return listChatBlocks(instance, sessionId);
  }
  // If the client sent a snapshot timestamp, use it; otherwise (legacy
  // client) compare against the cursor row's CURRENT updated_at. With the
  // `>=` filter that follows, the cursor row still replays with its
  // current payload — but the fallback can't recover earlier-ordinal
  // in-place mutations that landed strictly before the cursor's current
  // updated_at, because no older snapshot is available.
  const clientTs = clientTsFromCursor ?? cutoff.updated_at;
  return db
    .query<ChatBlockRow, [string, number, string]>(
      `SELECT * FROM chat_blocks
       WHERE session_id = ?
         AND (ordinal > ? OR updated_at >= ?)
       ORDER BY ordinal ASC`
    )
    .all(sessionId, cutoff.ordinal, clientTs)
    .map(rowToBlock);
}

// Per-session most-recent message text. Returns a Map keyed by sessionId
// containing the latest user_text / assistant_text block's text (other
// block kinds are skipped — phase/tool_call/tool_result/etc. aren't
// "messages" in the conversational sense). Used by the chat list
// endpoint to populate a preview subtitle without N+1 queries.
//
// Uses a window function so we get the latest matching row per session
// in one SQL trip. Sessions with no qualifying blocks are omitted from
// the map (caller treats that as null).
export function getLatestMessagesBySession(
  instance: Instance
): Map<string, string> {
  const db = getMemoryDb(instance);
  const rows = db
    .query<{ session_id: string; payload_json: string }, [string]>(
      `SELECT session_id, payload_json FROM (
         SELECT session_id, payload_json, kind, ordinal,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ordinal DESC) AS rn
         FROM chat_blocks
         WHERE instance = ? AND kind IN ('user_text', 'assistant_text')
       ) WHERE rn = 1`
    )
    .all(instance);
  const map = new Map<string, string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { text?: string };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        map.set(row.session_id, payload.text);
      }
    } catch {
      // skip malformed rows — never block the chat list on a parse error
    }
  }
  return map;
}

// Returns the blocks belonging to one thread, in ordinal-ascending order.
// A thread is a span of blocks tagged with `thread_id` inside the agent's
// single session; ordinals stay monotonic across the whole session, so
// thread blocks may interleave with main-chat blocks in the raw stream.
export function listThreadBlocks(
  instance: Instance,
  sessionId: string,
  threadId: string
): ChatBlock[] {
  const db = getMemoryDb(instance);
  return db
    .query<ChatBlockRow, [string, string]>(
      "SELECT * FROM chat_blocks WHERE session_id = ? AND thread_id = ? ORDER BY ordinal ASC"
    )
    .all(sessionId, threadId)
    .map(rowToBlock);
}

// Returns the main-chat blocks for a session — everything NOT tagged with
// a thread_id — in ordinal-ascending order. The chat transcript renders
// from this so thread replies don't leak into the main stream.
export function listMainChatBlocks(instance: Instance, sessionId: string): ChatBlock[] {
  const db = getMemoryDb(instance);
  return db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE session_id = ? AND thread_id IS NULL ORDER BY ordinal ASC"
    )
    .all(sessionId)
    .map(rowToBlock);
}

// Returns the main-chat (un-threaded) user_text block belonging to a task,
// or undefined when the task has none (job/channel turns have no user
// message). When the agent routes a turn into a thread, the thread roots at
// the user message that started the turn so the reply chip renders right
// where the user asked and the thread reads human → agent. A turn with no
// such block does not thread. Latest-by-ordinal guards against a task ever
// carrying more than one user_text row.
export function getMainChatUserTextBlockForTask(
  instance: Instance,
  sessionId: string,
  taskId: string
): ChatBlock | undefined {
  const db = getMemoryDb(instance);
  const row = db
    .query<ChatBlockRow, [string, string]>(
      `SELECT * FROM chat_blocks
       WHERE session_id = ? AND thread_id IS NULL AND kind = 'user_text' AND task_id = ?
       ORDER BY ordinal DESC
       LIMIT 1`
    )
    .get(sessionId, taskId);
  return row ? rowToBlock(row) : undefined;
}

// Returns a single main-chat (un-threaded) block by id, scoped to the
// session, or undefined when it's absent, belongs to another session, or is
// itself threaded. The user-initiated "Reply in thread" path validates the
// parent message this way before branching a new thread off it.
export function getMainChatBlock(
  instance: Instance,
  sessionId: string,
  blockId: string
): ChatBlock | undefined {
  const db = getMemoryDb(instance);
  const row = db
    .query<ChatBlockRow, [string, string]>(
      "SELECT * FROM chat_blocks WHERE id = ? AND session_id = ? AND thread_id IS NULL"
    )
    .get(blockId, sessionId);
  return row ? rowToBlock(row) : undefined;
}

// Truncates a preview string to a chip-friendly length without splitting
// mid-word awkwardly — a hard cut is fine here since previews are advisory.
function truncatePreview(text: string, max = 140): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

// Pulls the renderable text off a chat_blocks payload. Only user_text and
// assistant_text carry conversational text; everything else previews empty.
function textFromPayload(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as { text?: unknown };
    return typeof payload.text === "string" ? payload.text : "";
  } catch {
    return "";
  }
}

// Aggregate row backing the thread-summary queries. One row per distinct
// thread_id in scope, with the reply count, last-reply timestamp, and the
// parent_block_id the thread branched from.
//
// `last_reply_at` is the newest MESSAGE block (user_text / assistant_text) —
// not the newest block of any kind. A run appends auxiliary blocks (a trailing
// `phase` "Completed", tool_call / tool_result, system_note) AFTER the reply
// text, and counting those would push the timestamp past the message the user
// actually reads. Since the unread badge compares a per-device "last seen"
// against this value, an auxiliary trailing block would re-flag a thread the
// user has already opened. Keeping this message-only also matches reply_count,
// lastReplyPreview, and lastReplyAuthor, which are already message-derived.
interface ThreadAggRow {
  thread_id: string;
  session_id: string;
  agent_id: string | null;
  parent_block_id: string | null;
  reply_count: number;
  last_reply_at: string;
}

// Phase labels that end a run. Mirrors TERMINAL_PHASE_LABELS on the web chat
// surface so a thread reports activity exactly while the chat page would
// render its run as in flight.
const TERMINAL_PHASE_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

// A thread's in-flight state, or null when idle. Scans the thread's
// activity-bearing blocks newest-first. Overlapping tasks can interleave
// their blocks in one thread (replies are not serialized), so one task's
// terminal phase must not mask another task's still-running work: each
// task is decided by ITS OWN newest decisive block, and the thread
// aggregates — any task parked on a gate ⇒ "waiting_approval" (the
// actionable state wins, matching the UI's ordering), else any running
// task ⇒ "running". Per task, the decisive rules are:
//   - an authorization/setup gate ⇒ waiting — gate blocks carry no
//     resolution state, but resolving one always appends newer blocks (the
//     resumed run's phases, or a terminal phase on deny), so a gate that is
//     still the task's newest row means the run is parked on it
//   - a phase block ⇒ running while its label is non-terminal
//   - a tool call still running ahead of any phase block ⇒ running (the
//     same backwards walk the web ThreadPanel uses for its composer state)
// Rows whose payload doesn't parse (or a phase row with no string label) are
// skipped rather than guessed at, so a single malformed row can't pin a
// thread "running" forever.
function threadActivity(
  db: ReturnType<typeof getMemoryDb>,
  sessionId: string,
  threadId: string
): "running" | "waiting_approval" | null {
  const rows = db
    .query<{ kind: string; payload_json: string; task_id: string | null }, [string, string]>(
      `SELECT kind, payload_json, task_id FROM chat_blocks
       WHERE session_id = ? AND thread_id = ?
         AND kind IN ('phase', 'tool_call', 'authorization_requested', 'setup_requested')
       ORDER BY ordinal DESC`
    )
    .all(sessionId, threadId);
  let anyRunning = false;
  let anyWaiting = false;
  const decidedTasks = new Set<string>();
  for (const row of rows) {
    // Legacy rows without a task id share one pseudo-task bucket.
    const taskKey = row.task_id ?? "";
    if (decidedTasks.has(taskKey)) continue;
    if (row.kind === "authorization_requested" || row.kind === "setup_requested") {
      decidedTasks.add(taskKey);
      anyWaiting = true;
      continue;
    }
    let payload: { label?: unknown; status?: unknown };
    try {
      payload = JSON.parse(row.payload_json) as { label?: unknown; status?: unknown };
    } catch {
      continue;
    }
    if (row.kind === "phase" && typeof payload.label === "string") {
      decidedTasks.add(taskKey);
      if (!TERMINAL_PHASE_LABELS.has(payload.label)) anyRunning = true;
      continue;
    }
    if (row.kind === "tool_call" && payload.status === "running") {
      decidedTasks.add(taskKey);
      anyRunning = true;
    }
  }
  if (anyWaiting) return "waiting_approval";
  return anyRunning ? "running" : null;
}

// Builds ThreadSummary objects from aggregate rows, hydrating the parent
// preview + author (text/kind of the rooted main-chat block — a human
// user_text for an agent-started thread, an assistant_text for a
// user-started one) and the last-reply preview (most recent text-bearing
// block in the thread).
function buildThreadSummaries(db: ReturnType<typeof getMemoryDb>, rows: ThreadAggRow[]): ThreadSummary[] {
  return rows.map((row) => {
    const rootRow = row.parent_block_id
      ? db
          .query<{ payload_json: string; kind: string }, [string]>(
            "SELECT payload_json, kind FROM chat_blocks WHERE id = ?"
          )
          .get(row.parent_block_id)
      : null;
    const lastReplyRow = db
      .query<{ payload_json: string; kind: string }, [string, string]>(
        `SELECT payload_json, kind FROM chat_blocks
         WHERE session_id = ? AND thread_id = ? AND kind IN ('user_text', 'assistant_text')
         ORDER BY ordinal DESC
         LIMIT 1`
      )
      .get(row.session_id, row.thread_id);
    const rootPreview = rootRow ? truncatePreview(textFromPayload(rootRow.payload_json)) : "";
    const rootAuthor = rootRow ? (rootRow.kind === "user_text" ? "user" : "agent") : undefined;
    const lastReplyPreview = lastReplyRow ? truncatePreview(textFromPayload(lastReplyRow.payload_json)) : "";
    const lastReplyAuthor = lastReplyRow
      ? lastReplyRow.kind === "user_text"
        ? "user"
        : "agent"
      : undefined;
    const activity = threadActivity(db, row.session_id, row.thread_id);
    return {
      threadId: row.thread_id,
      sessionId: row.session_id,
      ...(row.agent_id != null ? { agentId: row.agent_id } : {}),
      ...(row.parent_block_id != null ? { parentBlockId: row.parent_block_id } : {}),
      ...(rootPreview.length > 0 ? { rootPreview } : {}),
      ...(rootAuthor ? { rootAuthor } : {}),
      replyCount: row.reply_count,
      lastReplyAt: row.last_reply_at,
      ...(lastReplyPreview.length > 0 ? { lastReplyPreview } : {}),
      ...(lastReplyAuthor ? { lastReplyAuthor } : {}),
      ...(activity ? { activity } : {})
    };
  });
}

// One ThreadSummary per distinct thread in a session, newest reply first.
// Drives the per-agent Threads tab and the inline thread chips.
export function summarizeThreads(instance: Instance, sessionId: string): ThreadSummary[] {
  const db = getMemoryDb(instance);
  const rows = db
    .query<ThreadAggRow, [string]>(
      `SELECT thread_id,
              session_id,
              MAX(agent_id) AS agent_id,
              MAX(parent_block_id) AS parent_block_id,
              SUM(CASE WHEN kind IN ('user_text','assistant_text') THEN 1 ELSE 0 END) AS reply_count,
              COALESCE(
                MAX(CASE WHEN kind IN ('user_text','assistant_text') THEN created_at END),
                MAX(created_at)
              ) AS last_reply_at
       FROM chat_blocks
       WHERE session_id = ? AND thread_id IS NOT NULL
       GROUP BY thread_id, session_id
       ORDER BY last_reply_at DESC, thread_id ASC`
    )
    .all(sessionId);
  return buildThreadSummaries(db, rows);
}

// Cross-agent thread inbox: one ThreadSummary per distinct thread across
// the given canonical agent-chat sessions, newest reply first. Sessions
// live in the JSON RuntimeState (not SQLite), so the caller resolves the
// `kind='agent'` session ids and passes them in rather than this layer
// joining a non-existent SQL table. An empty list yields no rows.
export function summarizeThreadsForInstance(
  instance: Instance,
  agentSessionIds: string[]
): ThreadSummary[] {
  if (agentSessionIds.length === 0) return [];
  const db = getMemoryDb(instance);
  const placeholders = agentSessionIds.map(() => "?").join(", ");
  const rows = db
    .query<ThreadAggRow, string[]>(
      `SELECT thread_id,
              session_id,
              MAX(agent_id) AS agent_id,
              MAX(parent_block_id) AS parent_block_id,
              SUM(CASE WHEN kind IN ('user_text','assistant_text') THEN 1 ELSE 0 END) AS reply_count,
              COALESCE(
                MAX(CASE WHEN kind IN ('user_text','assistant_text') THEN created_at END),
                MAX(created_at)
              ) AS last_reply_at
       FROM chat_blocks
       WHERE instance = ? AND thread_id IS NOT NULL AND session_id IN (${placeholders})
       GROUP BY thread_id, session_id
       ORDER BY last_reply_at DESC, thread_id ASC, session_id ASC`
    )
    .all(instance, ...agentSessionIds);
  return buildThreadSummaries(db, rows);
}

// Cascade delete invoked by deleteChatSession in src/state/records.ts so
// stale block rows don't survive the session. Returns the number of rows
// removed so the caller can audit it; idempotent for sessions that never
// had blocks.
export function deleteChatBlocksForSession(
  instance: Instance,
  sessionId: string
): number {
  const db = getMemoryDb(instance);
  const result = db.run("DELETE FROM chat_blocks WHERE session_id = ?", [sessionId]);
  return result.changes ?? 0;
}

// Delete a single block by id. Used to retract an in-flight streamed
// assistant_text block that the turn ultimately suppresses (the cron
// [SILENT] sentinel). Returns true when a row was removed; idempotent
// for ids that no longer exist.
export function deleteChatBlock(instance: Instance, blockId: string): boolean {
  const db = getMemoryDb(instance);
  const result = db.run("DELETE FROM chat_blocks WHERE id = ?", [blockId]);
  return (result.changes ?? 0) > 0;
}

// Subscribe to a session's block stream. Returns an unsubscribe function;
// the SSE route in src/http.ts calls this on ReadableStream.cancel() so
// a closed connection doesn't accumulate dead listeners.
//
// Listeners are invoked AFTER the SQLite commit, so observers see only
// durable rows. Throwing handlers are caught and logged so a single
// buggy subscriber can't take down the emit fan-out.
export function subscribeChatBlocks(
  instance: Instance,
  sessionId: string,
  handler: (block: ChatBlock) => void
): () => void {
  const key = subscriptionKey(instance, sessionId);
  const wrapped = (block: ChatBlock): void => {
    try {
      handler(block);
    } catch (error) {
      // Best-effort logging — a thrown handler must not break the fan-out.
      console.warn(
        `[chat-blocks] subscriber for ${key} threw:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}

function publish(instance: Instance, block: ChatBlock): void {
  emitter.emit(subscriptionKey(instance, block.sessionId), block);
  // Fan out to instance-wide subscribers too — the APNs dispatcher
  // listens here so it sees every block for the instance without
  // having to enumerate sessions and re-subscribe as they spawn.
  emitter.emit(instanceKey(instance), block);
}

function instanceKey(instance: Instance): string {
  return `${instance}::*`;
}

// Subscribe to every block emitted on this instance, across all
// sessions. Returns an unsubscribe function. Used by long-lived
// observers (e.g. the APNs push dispatcher) that need a fan-out point
// independent of which session is active. Per-session SSE handlers
// continue to use subscribeChatBlocks(instance, sessionId, handler) so
// they only see their own traffic.
export function subscribeAllChatBlocks(
  instance: Instance,
  handler: (block: ChatBlock) => void
): () => void {
  const key = instanceKey(instance);
  const wrapped = (block: ChatBlock): void => {
    try {
      handler(block);
    } catch (error) {
      console.warn(
        `[chat-blocks] instance subscriber for ${key} threw:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}
