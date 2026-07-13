# ADR: ChatBlock Protocol For Runtime-Emitted Conversation Stream

- **Status:** Accepted
- **Date:** 2026-05-21
- **See also:** [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md), [One Chat Per Agent, Threads, And Job Channels](./agent-chat-threads-and-channels.md)

## Decision

The runtime emits a typed `ChatBlock` stream per chat session. Clients
(web, mobile, future CLI bridges) consume the stream and render it
directly. There is no client-side translation step that maps task
state, ChatMessageRecord rows, and partial summaries onto chat-bubble
shapes — the runtime owns the semantic vocabulary and exposes it on the
wire.

Blocks are persisted in SQLite (`chat_blocks` table, `memory.db`
schema bumped 2 → 3) and exposed through two endpoints:

- `GET /api/chat/:id/blocks` — ordered list for initial render
- `GET /api/chat/:id/stream` — SSE companion for live updates, honoring
  `Last-Event-ID` for clean reconnects

Opening the stream also registers the caller as present on the session,
for push-suppression purposes: a request carrying a valid `X-Device-Token`
lands in the per-device watch registry (so the dispatcher skips a
redundant completion push to that device), and a tokenless web/CLI stream
lands in the per-session pushless registry (so the dispatcher downgrades
the user's phone completion alert to a silent badge tick while they read
on the web). The entry lives only for the stream's lifetime — it clears on
`cancel()`. See [Mobile Push Notifications](./mobile-push-notifications.md)
for the suppression and downgrade rules.

The protocol is additive. Legacy `GET /api/chat/:id`, the synthesized
streaming placeholder in `getChatSession`, and `syncChatTaskResult`
remain untouched during the migration window so existing web and mobile
clients keep working. Phase 1 (this ADR) lands the runtime emission
and the new endpoints; phases 2 and 3 migrate the web and mobile
clients; phase 4 retires the legacy path.

## Context

Before this change, every chat client rebuilt the same UI vocabulary by
parsing runtime artifacts that were never meant to drive a UI directly:

- `Task.currentStep` was a free-form string the chat-task loop wrote at
  every iteration. Clients pattern-matched it (`"Thinking"`,
  `"Working: file_read"`, `"Waiting for approval"`) to choose a
  spinner state.
- `Task.partialSummary` was an unstructured streaming-text accumulator.
  Clients displayed it as the in-flight assistant message and swapped
  it out when `Task.summary` settled.
- `ChatMessageRecord` rows were the durable transcript, but tool calls
  and approvals only surfaced as inline text inside the assistant's
  reply — clients had no structured cue that a tool was being run.
- Approval bubbles came from a separate `/api/approvals` poll, joined
  back to the chat by `taskId`. The Connect dialog vs the regular
  Approve/Deny pair was disambiguated by reading `approval.action`
  from a different endpoint. Today the surface is split into
  `/api/authorizations*` and `/api/setup-requests*` (see ADR
  authorization-vs-setup-request.md).

The web client carried this translation logic. When the mobile client
landed (`packages/mobile/`), it had to reimplement the same vocabulary —
copying the phase-string regex, the partialSummary swap, the approval
join — and any divergence between the two clients silently produced a
different rendering for the same task.

The translation is also brittle. The chat-task loop has lots of state
transitions (terminal-bail-out guards, cancellation mid-stream, sibling
approval denial, iteration cap reached) that map cleanly onto
purpose-built block types but resist being squeezed back into "did
currentStep change?". Worse, every new client surface (CLI bridges,
remote previews, screen readers) would need the same translation code.

## Required Now

- A typed `ChatBlock` discriminated union in `packages/runtime/src/types.ts`. The
  current set:

  ```ts
  export type ChatBlock =
    | UserTextBlock
    | AssistantTextBlock
    | ToolCallBlock
    | ToolResultBlock
    | PhaseBlock
    | AuthorizationRequestedBlock
    | SetupRequestedBlock
    | SystemNoteBlock;
  ```

  Each block carries `id`, `sessionId`, `instance`, `ordinal`,
  `createdAt`, optional `taskId`/`runId`, plus the kind-specific
  fields. `AssistantTextBlock` also carries `updatedAt` and a
  `streaming` flag; `ToolCallBlock` carries `updatedAt`, a `status`
  in `{ running, ok, error, denied }`, an optional `errorSeverity`
  in `{ info, error }`, and an optional `runningHint` string.
  `errorSeverity` lets a failed call render as a muted "needs setup"
  notice instead of a red error — e.g. `web_search` with no connector
  keeps the verbose steering as the model-facing tool result and shows
  the user a short `"info"` line; the runtime derives it from a
  `ToolDisplayError` thrown by the tool and clients default to
  `"error"` when it is absent (see ADR web-search-connectors.md).
  `runningHint` is advisory context a tool emits while parked in
  `running` to explain why it's waiting and what (if anything) the
  user can do to unblock it; clients MAY render a hint-bearing row
  more prominently than a bare running row. It's reserved for tools
  that block on an external event the agent cannot drive (today only
  `wait_for_messaging_pair`, waiting on an inbound Telegram DM up to
  600s) and is cleared automatically when status leaves `running`.
  `ToolCallBlock` also carries an optional `jobId`: the id of the
  scheduled job a successful `create_job` or `update_job` call
  created/patched, stamped when the dispatch settles `ok`. It is a
  structured side channel for the routine card — clients open the
  routine's details from the block without parsing the id back out of
  the 80-char-truncated `tool_result` preview. The id originates as
  `DispatchResult.jobId` from the job-creating/updating tool handlers
  (never extracted from the result string) and is absent on failed
  calls, on every other tool — including `delete_job`, whose card
  could only ever render a deleted-routine tombstone — and on blocks
  predating the field.
  Outbound (agent → user) media rides a DIFFERENT channel than inbound:
  the block schema is unchanged — `AssistantTextBlock` and `ToolResultBlock`
  carry NO `images` field (only `UserTextBlock.images` exists, for the
  user's own inbound uploads). An agent-produced attachment is referenced
  INLINE in the reply text as a `gini-upload://<id>` markdown ref the model
  pastes where the attachment belongs; each client rewrites the ref to its
  own authed image/file source when rendering. Bytes live under
  `uploads/<id>.<ext>` and are fetched via `GET /api/uploads/:id`. This is
  render-only — image bytes do NOT re-enter the model loop (the tool's text
  result already does). A browser screenshot or a promoted-file upload is
  surfaced this way. See ADR outbound-chat-attachments.md.

- Persistence in `packages/runtime/src/state/chat-blocks.ts`. SQLite is the source of
  truth, not the JSON `RuntimeState` blob. `ordinal` is allocated as
  `MAX(ordinal) + 1` per `session_id` inside a `SAVEPOINT` transaction;
  the `UNIQUE (session_id, ordinal)` constraint is the last-line
  defense against interleaved writers. Inserts and upserts fire an
  in-process `EventEmitter` event after the SQLite commit so SSE
  subscribers only observe durable rows.

- Thread membership is an additive tag on the same rows. `ChatBlockBase`
  carries optional `threadId` / `parentBlockId` (`chat_blocks` columns
  `thread_id` / `parent_block_id`, `memory.db` schema bumped 8 → 9 with
  the `idx_chat_blocks_thread` index on `(session_id, thread_id,
  ordinal)`). A thread is a span of blocks inside the agent's one
  session, not a separate session — thread blocks draw from the same
  per-session ordinal sequence, ride the same SSE stream and
  `Last-Event-ID` resume, and the `UNIQUE (session_id, ordinal)`
  invariant is preserved. `listThreadBlocks` / `listMainChatBlocks` /
  `summarizeThreads` / `summarizeThreadsForInstance` query thread
  membership; inserts and upserts carry the columns forward so streaming
  preserves membership with no extra arguments.
  **Superseded:** thread tagging is replaced by **Topics**
  ([Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md)) — a
  side-conversation is now its own `kind:"topic"` session rather than a tag on
  the agent's one stream. The `thread_id` / `parent_block_id` columns are retained
  but dormant (legacy threads had their tags nulled), and the thread-read helpers
  above are unused. The block wire protocol itself (block shapes, ordinal stream,
  SSE, `Last-Event-ID` resume) is unchanged and applies per Topic session. See ADR
  agent-chat-threads-and-channels.md for the historical threading model and its
  agent-decided routing (`start_thread` control tool + `<route>thread</route>`
  fallback).

- Emission in `packages/runtime/src/execution/chat-task.ts` via helpers in
  `packages/runtime/src/execution/chat-task-emit.ts`. The loop resolves an emission
  context once per `runLoop` entry (`(instance, sessionId, agentId,
  runId)`) and threads emit calls through the existing mutation points
  rather than scattering SQLite writes inline. Tasks without a chat
  session (subagent children, imperative CLI runs) get an `undefined`
  context and emission no-ops — subagent inner work stays opaque to
  the user, only the parent's `spawn_subagent` tool_call surfaces.

- Streaming `assistant_text` carries the FULL accreted text on every
  delta, not just the increment. Clients merge by `id` so a reconnect
  always observes a monotonically growing string and never needs to
  splice deltas itself. The terminal flip to `streaming: false`
  preserves the partial text the user already saw — cancellation and
  failure paths intentionally do not drop the in-flight row.

- `AuthorizationRequestedBlock.action` and `SetupRequestedBlock.action`
  are part of the wire contract so clients can branch on the card
  variant without a cross-endpoint join.
  - `AuthorizationRequestedBlock` — standard Approve / Deny pair
    posting to `/api/authorizations/<id>/{approve,deny}`. Carries
    `risk` and `summary` so the bubble renders without a follow-up
    fetch.
  - `SetupRequestedBlock` — user-actor card. Layouts keyed off
    `action`:
    - `connector.request` — render the Connect dialog. Submit posts
      `{ secrets, scopes, name }` to
      `/api/setup-requests/<id>/complete`. The model's reason is emitted
      as its own `assistant_text` bubble above this card (so the card
      itself stays minimal), and `/complete` resumes the paused run in
      the background so the dialog closes immediately rather than
      blocking on the resumed agent stream (see ADR
      web-search-connectors.md).
    - `browser.fill_secret` — render an inline form with one input
      per slot in `setupRequest.payload.slots`. Submit posts
      `{ secrets: { <slot.name>: <value>, ... } }` to
      `/api/setup-requests/<id>/complete`. The card also reads
      `setupRequest.payload.approvedUrl` to render the "fill
      destination" badge so the human reviewer can spot a target
      mismatch. See ADR [browser-fill-secret.md](browser-fill-secret.md).
    - `browser.connect` — Connect button posts to
      `/api/setup-requests/<id>/open-browser`; the follow-up
      completion button ("I've signed in", or "I'm done" when the
      payload carries `mode: "handoff"` — see
      [browser-connect-handoff.md](browser-connect-handoff.md))
      posts to `/api/setup-requests/<id>/complete`.
    - `messaging.add_bridge` — render an inline form with a name
      input (pre-seeded from `setupRequest.payload.suggestedName`)
      and a password-masked bot-token input. Submit posts
      `{ secrets: { name, botToken } }` to
      `/api/setup-requests/<id>/complete`, which runs the
      `addMessagingBridge` side effect. The card reads
      `setupRequest.payload.kind` (currently `"telegram"`;
      `"discord"` is reserved but the chat card does not collect
      channel IDs, so the dispatcher tool only advertises Telegram
      from chat — see [telegram-bridge.md](telegram-bridge.md)).
    - `messaging.approve_pairing` — render a confirmation card
      showing the pending sender, chat id, chat type, verification
      code, and expiry from `setupRequest.payload`. Two buttons:
      Approve posts `{}` to `/complete`; Reject posts
      `{ reject: true }` to `/complete`. Server calls `allowChat`
      (with the `verificationCode` from the payload as
      `expectedCode`) or `rejectPendingChat`.
    - `messaging.remove_bridge` — render a destructive confirmation
      card showing `setupRequest.payload.bridgeName` +
      `payload.kind` and the irreversibility warning. Submit posts
      `{}` to `/complete`, which routes into `removeMessagingBridge`.
    Cancel always posts to `/api/setup-requests/<id>/cancel`. The
    three `messaging.*` setups are SetupRequests, not Authorizations,
    so they never appear under `/api/authorizations`; the home page
    and /permissions list render a "resolve in chat" hint rather than
    an inline Approve/Reject control for them.

- Tool catalog labels live with the catalog. `displayLabel` on each
  `TOOL_DEFS` entry plus `chatBlockLabelFor` / `chatBlockArgsPreviewFor`
  helpers in `packages/runtime/src/execution/tool-catalog.ts` keep the per-tool
  vocabulary in one place. `argsPreview` is capped at 80 chars (single
  bubble line on a phone); `argsFull` is the parsed JSON for
  "show full args" affordances, with credential-bearing keys
  (`apiKey`, `token`, `headers`, …) replaced by `[redacted]` via
  `redactSensitiveToolArgs` (`packages/runtime/src/execution/tool-args-redact.ts`). The
  same helper scrubs the resolved `self.config` approval payload, so a
  tool's secret args never persist to a client-rendered surface (the
  real values still reach the handler for execution). Browser ref tools
  (`browser_click`, `browser_type`, `browser_fill_form`, …) enrich
  `argsPreview` by resolving the `@eN` ref to the snapshot element's
  role + name — e.g. `button "Buy a License"` instead of `@e38` — via an
  optional resolver `chatBlockArgsPreviewFor` accepts, wired at emit time
  to the live browser session by `peekRefLabel` (`packages/runtime/src/tools/browser.ts`).
  The opaque ref stays in `argsFull`, and the preview falls back to the
  bare ref when the element has no recorded name or the session is gone.
  jobId-only job tools (`run_job`, `delete_job`) use the same shape: a
  second optional resolver enriches `argsPreview` by resolving the
  `jobId` to the job's stored name — e.g. `Hydration reminder` instead of
  `job_6e0fd00b` — wired at emit time to `listJobs` (`packages/runtime/src/jobs`). A
  model-supplied `name` (e.g. `create_job`) still wins, and the preview
  falls back to the bare id when the job can't be resolved. `terminal_exec`
  masks its `argsPreview` (returns `""`) because a raw shell command line is
  noise — and a path/secret-leak risk — in an end-user inline preview; the
  full command stays in `argsFull.command` and clients surface it on row
  expansion.

- The SSE endpoint is its own handler (`chatBlockStream` in
  `packages/runtime/src/http.ts`), not a reuse of the existing global `eventStream`.
  The global stream polls the runtime ring buffer; the per-session
  chat stream subscribes to an `EventEmitter` keyed on
  `(instance, sessionId)` so each browser tab only receives its
  session's traffic and reconnects don't replay unrelated activity.

- Cascade delete. `deleteChatSession` in `packages/runtime/src/state/records.ts` clears
  the matching `chat_blocks` rows so a deleted session doesn't leave
  orphan rows the `/blocks` endpoint would surface after re-create.
  Best-effort: a SQLite open failure during the cascade does not
  abort the in-memory state delete (which is irreversibly applied by
  that point), and operators see the failure in `appendLog`.

## Migration Path

1. **Phase 1 (this change):** runtime emits ChatBlocks and exposes the
   new endpoints. Legacy `/api/chat/:id` and the
   `ChatMessageRecord`/`syncChatTaskResult` write path continue to
   run unchanged. The runtime dual-publishes during the migration
   window.

2. **Phase 2 (web):** rewrite `packages/web/src/app/chat/page.tsx` to fetch
   `/api/chat/:id/blocks` and subscribe to `/api/chat/:id/stream`.
   The legacy `MessageBubble`, `PhaseIndicator`, and `ApprovalActions`
   components either retire or get embedded inside per-block
   components.

3. **Phase 3 (mobile):** mirror phase 2. Polling
   `/api/chat/:id/blocks` at 800ms in-flight / 3s idle is acceptable
   for v1 — the mobile client doesn't have SSE wired up yet.

4. **Phase 4 (cleanup, future):** retire the legacy
   `/api/chat/:id` shape that mixes messages + tasks. Drop the
   `/sync` endpoint and the synthesized streaming placeholder in
   `getChatSession`. The durable ChatMessageRecord rows are NOT part
   of this cleanup: user rows and the final assistant answer row
   (written server-side by `persistFinalAnswerRow` on chat-task
   completion) keep landing, because they are model-facing replay
   state — `priorChatMessages` rehydrates them so the model sees its
   own prior answers — not a UI legacy.

## Read And Write Semantics

- **Write paths:**
  - `submitChatMessage` inserts the `user_text` block alongside the
    legacy ChatMessageRecord. The block carries optional `images` and
    `audio` upload refs (`{ id, mimeType, size }`); clients fetch the
    bytes via `GET /api/uploads/:id`. The `images` field name is
    retained for wire compatibility but now carries refs to **any**
    attached file (PDF, CSV, logs), not only images: the
    `POST /api/uploads` gate accepts any plausible MIME (storage was
    already generic), and the stored `mimeType`/`size` are authoritative
    so a client-forged MIME can't steer how the bytes are delivered.
    Images inline as `image_url` data URLs; **non-image files are
    delivered to the model in core, by provider capability** — a native
    `document` content part when the provider ingests documents, else
    inlined extracted text (boundary-wrapped, capped), else a workspace
    path reference — and are always materialized into the agent's
    workspace (see [chat-file-attachments.md](chat-file-attachments.md)).
    The inline `image_url` path and `vision_query` stay image-only. Served
    uploads are returned `Content-Disposition: attachment` + `nosniff` so
    an arbitrary-MIME upload can't execute as a same-origin document. A
    voice message's `audio` is
    render-only — it is transcribed on the gateway and only the
    transcript becomes the block text and model input (see
    [voice-messages-and-local-stt.md](voice-messages-and-local-stt.md)).
  - `runChatTask` emits `phase("Thinking")` before each model call,
    `assistant_text` on streaming deltas (full text on every frame),
    `phase("Working: <tool>")` + `tool_call(running)` before each
    dispatch, `tool_call(ok)`/`tool_call(error)` + `tool_result` on
    sync resolution, and `approval_requested` when a tool gates pending
    approval.
  - `resumeChatTask` flips paused `tool_call(running)` rows to `ok`
    when their approvals resolve, and emits the matching
    `tool_result` rows from the captured side-effect output.
  - `cancelTask` flips any in-flight `assistant_text` to
    `streaming: false` (preserving partial text), settles any
    `tool_call(running)` row that was awaiting approval to `denied`
    (sourcing the gated tool-call ids from the durable pending
    `authorization` / `setup_request` rows, so a cancel landing
    mid-dispatch — before the loop persists `toolCallState` — still
    stops the row spinning), then emits `system_note("Cancelled")` and
    `phase("Cancelled")`. The runtime model call now carries the turn's
    `AbortSignal`; `cancelTask` aborts it at the source so the in-flight
    provider fetch + stream reader stop immediately (rejecting with an
    `AbortError`) instead of producing deltas until the connection's
    natural end (see `packages/runtime/src/execution/turn-abort.ts`). As defense-in-depth
    for the brief window before the abort unwinds the stream, the streaming
    flush re-checks terminal status and drops post-cancel deltas (no new
    `assistant_text` block is born after the cancel); the same
    terminal-status guard also suppressed a stray `phase("Completed")` once
    the task was terminal (formerly in the now-removed `switchTurnToThread`
    turn-routing helper, superseded by Topics — see
    chat-topics-tasks-subagents.md). A stuck streaming block
    left by a process that died mid-stream (before this landed) is healed:
    `runChatTask` settles a resumed task's own stale block, and a one-shot
    boot sweep (`healOrphanedStreamingBlocks`) settles orphaned blocks whose
    task is terminal/waiting_approval/absent.
  - `failTask` mirrors cancelTask: finalize streaming text, emit
    `system_note(<error>)`, `phase("Failed")`.
  - `decideApproval(deny)` flips the matching `tool_call` to
    `denied`, then runs the cancelTask-equivalent emission inline
    (the deny path flips the task to failed atomically inside its
    own `mutateState`, bypassing `failTask`'s emission).

- **Read paths:**
  - `listChatBlocks(instance, sessionId)` returns rows in ordinal
    ascending order — used by the initial `/blocks` fetch.
  - `listChatBlocksAfter(instance, sessionId, afterId)` honors the
    SSE `Last-Event-ID` cursor; an unknown cursor falls back to the
    full list (best-effort recovery, matching the global
    `eventStream`'s ring-buffer behavior).
  - SSE frames carry `id: <blockId>\nevent: chat_block\ndata: <json>\n\n`.
    Browsers' `EventSource` auto-attaches the last `id` as
    `Last-Event-ID` on reconnect.
  - Clients treat `/blocks` as the reconciliation source of truth, not
    just the initial seed. A half-open `EventSource` (readyState stuck
    `OPEN`, so `onerror` never fires and the browser never reconnects —
    e.g. a backgrounded tab whose socket silently died) can drop the
    terminal frame; trusting the stream alone would strand the UI on the
    last non-terminal phase with a dead stop button. So the web client
    re-fetches `/blocks` and merges it (`mergeSeedWithLive`: freshest
    committed copy wins on an `id` collision via `updatedAt ?? createdAt`,
    so a finalized `streaming: false` row replaces a stranded
    `streaming: true` one; ties keep the live frame) while a turn is in
    flight (a ~3s poll, evaluated per conversation — main and each thread
    — so a thread's terminal phase can't mask a still-running main turn),
    on tab focus / visibility regained, and when the user hits stop. This
    bounds recovery from a half-open stream to one poll interval without
    depending on the `EventSource` noticing it died.
  - The same SSE connection also delivers a second event kind,
    `chat_session`, carrying the current `ChatSessionRecord` payload.
    The gateway emits it once on initial connect (so the client has
    the canonical title without a separate REST round-trip) and again
    whenever the session is renamed — both via `PATCH /api/chat/:id`
    and via the auto-rename path in
    `packages/runtime/src/execution/chat.ts:autoRenameChatAfterTurn`. The pub/sub lives
    in `packages/runtime/src/state/chat-session-events.ts`; publishers fire **after**
    `mutateState` resolves so subscribers only observe durable
    records, matching the chat-block post-commit semantics. The
    `chat_session` event has no `id:` line and is not part of the
    `Last-Event-ID` resume cursor — every reconnect re-emits the
    current record from the initial-send path, so a missed transient
    rename frame is harmless.

## Alternatives Considered

- **Shared TypeScript module imported by both clients.** A single
  module under `packages/chat-protocol/` could host the
  ChatMessageRecord → block translation, and both web and mobile
  could import it. Rejected because (a) the existing repo doesn't
  use a monorepo workspace pattern, so introducing one to share a
  ~200-line file is heavy-handed, (b) the bundler complexity for
  React Native plus Next.js for a single shared module hits
  Metro/Webpack interop edge cases, and (c) the protocol still needs
  durable storage server-side (the SSE stream has to backfill on
  reconnect), so the source of truth ends up on the runtime
  anyway. Once the runtime owns the semantics, clients are pure
  renderers and the shared module shrinks to nothing.

- **Client-side derivation only.** Keep the runtime emitting
  `ChatMessageRecord` + `Task` and ship a richer client SDK that
  derives blocks locally. Rejected because the ambiguity is the
  problem — two clients with the same input today produce subtly
  different rendering, and adding a third client surface (a CLI
  bridge, a remote agent preview) would re-derive the same logic
  with new bugs. Centralizing the vocabulary server-side is the
  point.

- **Reuse the existing `/api/events/stream` for chat updates.** The
  global event stream already has SSE plumbing. Rejected because the
  global stream is whole-instance scope, fans out activity across all
  agents and all sessions, and the ring buffer (1000 events) would
  drop chat-block frames under load. Per-session subscriptions with
  their own emitter and durable SQLite-backed backfill is the right
  granularity.

## Consequences

Pro:

- The "two clients render the same task differently" bug class is
  gone. The semantic vocabulary lives in one place; clients are pure
  renderers of typed blocks.
- New client surfaces (CLI bridges, screen readers, future
  embeddings) ship one renderer pass instead of one translation pass.
- The protocol is reconnect-clean *when the browser actually
  reconnects*. `Last-Event-ID` resumes mid-stream with no replay of
  already-seen blocks, and `assistant_text` deltas always carry the full
  accreted text so a reconnect during a stream never observes torn
  state. A half-open `EventSource` never fires `onerror` and so never
  reconnects, so the durable `/blocks` list — not the live stream — is
  the client's source of truth; clients reconcile against it (poll
  while in flight, refetch on focus / stop) rather than trusting a
  single stream (see Read paths).
- Tests can pin block shapes directly instead of inferring rendering
  from `Task.currentStep` strings.

Con:

- Dual-publishing during the migration window costs an extra SQLite
  insert per emit. Per-iteration the write batches with the existing
  `mutateState` flush so the overhead is small, but the bookkeeping
  is real and is the price of a phased migration.
- The runtime owns more UI vocabulary than before. A new tool needs
  a `displayLabel` and an `argsPreview` mapping; both are next to
  the spec in `tool-catalog.ts`, but it's still server work to add
  a new tool that today is client work.
- The chat-blocks table is per-instance SQLite, not the JSON
  `RuntimeState` blob. That follows the precedent set by Hindsight
  memory (ADR agent-memory-isolation.md) but operators inspecting
  state by `cat`'ing `state.json` won't see chat-block rows. The
  `/blocks` endpoint and the standard SQLite tooling are the
  inspection surface.

## Acceptance Checks

- `bun test packages/runtime/src/state/chat-blocks.test.ts` covers ordinal allocation,
  upsert idempotence, the callId-based tool_call lookup, cursor-based
  list, subscriber isolation, and cascade delete.
- `bun test packages/runtime/src/execution/chat-task.test.ts` covers the
  end-to-end block emission for a tool-calling turn, the action field
  on `approval_requested`, parallel-fan-out distinct callIds and
  ordinals, the subagent emission skip, cancellation system_notes,
  and `deleteChatSession` cascade.
- `bun test packages/runtime/src/http.test.ts` smoke-tests `GET /blocks` and `GET
  /stream` including the 404 paths and SSE frame shape.
- The live-gateway verification (kigali instance) confirms the
  protocol works end-to-end: a chat session POST + message produces
  the expected `user_text` → phases → `assistant_text` sequence,
  the SSE stream receives the same blocks as frames, and
  `DELETE /api/chat/:id` clears the block list (subsequent
  `/blocks` GET returns 404).
- The legacy `GET /api/chat/:id` keeps returning `{ session,
  messages, tasks }` with the same shape, so the existing web and
  mobile clients still render correctly while the new endpoints
  light up.
