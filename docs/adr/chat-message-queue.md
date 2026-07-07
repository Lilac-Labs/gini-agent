# ADR: Server-Side Chat Message Queue

## Decision

An **interactive-client** chat submission serializes its turns through a **per-session FIFO message queue owned by the gateway**. "Interactive client" means the web/mobile/CLI composer, where a human queues follow-ups while watching a turn run. While a session has an in-flight chat task, a newly posted interactive message is enqueued on the session record (`ChatSessionRecord.pendingMessages: PendingChatMessage[]` in `packages/runtime/src/types.ts`) instead of starting a concurrent task. When the current turn ends — for any reason — the next queued message auto-dispatches as its own real chat turn (one per turn). The queue is part of durable session state and propagates to every client over the existing `chat_session` SSE event.

The **messaging bridge** (Telegram/Discord inbound) bypasses the queue: each inbound message runs immediately, retaining its prior concurrent behavior by design (see "Why messaging bypasses the queue" below).

## Context

Before this decision, two messages posted to the same session ran their tasks CONCURRENTLY: `submitChatMessage` always created a run + task immediately, with no per-session serialization. The UI papered over this by turning the composer's Send button into a Stop button while a turn was in flight and making a second submit a client-side no-op, but that was a per-client guard, not a runtime invariant — messaging bridges, the CLI, and a second device could all still drive concurrent turns into one session.

The product requirement is a visible message queue: while the agent is mid-turn, the user can keep typing and submitting follow-ups, which stack into a queue (rendered as an expandable "N Queued" pill above the composer) and auto-send one per turn as each turn finishes.

## Why server-side, not client-side

The gateway owns durable state and execution; web, mobile, CLI, and messaging bridges are thin clients of the same `/api/*` contract. Putting the queue on the session record (rather than in each client's local state) means:

- **Implement the policy once.** Web and mobile render the same queue from the same session state instead of each reimplementing enqueue/drain logic.
- **It survives reload and is consistent across devices.** A queued message typed on a phone is visible on the desktop, and a page refresh doesn't lose the queue.
- **It drains even when no client is watching.** Auto-dispatch is driven by task lifecycle on the gateway, so the queue advances whether or not the app is foregrounded.
- **Serialization is a runtime invariant for interactive submissions**, not a web-composer affordance — a second interactive submit to a busy session enqueues instead of starting a concurrent task. (Messaging inbound is the deliberate exception below; it keeps its prior concurrent behavior because its reply-mirror needs a per-message task.)

## Data model

`PendingChatMessage` (`packages/runtime/src/types.ts`) is `{ id; content; images?; clientSurface?; threadId?; parentBlockId?; alsoToMain?; echoBlockId?; createdAt }`. Audio is intentionally absent: a voice message is transcribed to `content` during `prepareChatSubmission`, so only the resulting text plus image refs are queued. `threadId`/`parentBlockId`/`alsoToMain` are set only for a queued thread reply so auto-dispatch can re-run it inside its thread exactly as the run-now path would: dropping `threadId`/`parentBlockId` would drain the reply as a main-chat turn, and dropping `alsoToMain` would silently lose the reply's "also show in main chat" mirror. `echoBlockId` is set only for a queued `kind:"agent"` message that came through the echo-first ack (see "Echo-first instant ack" below): auto-dispatch binds the drained turn to that already-rendered `user_text` block instead of inserting a duplicate bubble, and removing the queued message deletes the block. All are optional, so `pendingMessages` is optional on `ChatSessionRecord` and existing persisted state stays valid without a migration.

The state helpers operate on `RuntimeState` inside a `mutateState` callback, matching the sibling record helpers (`packages/runtime/src/state/records.ts`): `enqueuePendingChatMessage`, `removePendingChatMessage`, `shiftPendingChatMessage`, and `sessionHasInFlightChatTask` (true when `state.tasks` has any task for the session whose status is not terminal — queued/running/waiting_approval all count as in-flight).

## Enqueue policy

`submitChatMessage` (`packages/runtime/src/execution/chat.ts`) runs `prepareChatSubmission` first, so audio transcription and content/image validation surface errors at enqueue time exactly as on the run-now path. The queue-or-run decision itself lives in `queueOrRunChatSubmission`: it enqueues when **either** the session has an in-flight chat task **or** its `pendingMessages` is already non-empty — the second condition keeps a later submit from jumping ahead of earlier queued messages while the current turn runs. On enqueue it appends inside `mutateState`, publishes the updated session via `publishChatSession`, and returns `{ sessionId, queued: true, pendingId }`. Otherwise it delegates to the shared run-now body. For non-routed sessions (topic/channel/bridge) this all happens synchronously inside the POST; for a routed `kind:"agent"` session it runs in the post-ack continuation (see "Echo-first instant ack" below), evaluating at dispatch time exactly as before — no task exists until the routing verdict lands, so the busy-check semantics are unchanged.

### Echo-first instant ack

A message posted in a `kind:"agent"` session must pass through the intake router (ADR chat-topics-tasks-subagents.md, Routing) — a model call — before anyone knows whether it runs chat-direct, in a Topic, or queues. That verdict costs ~1s+, and nothing about *accepting* the message depends on it. So `submitChatMessage` does not make the POST wait: it inserts the user's `user_text` block immediately as a render-only echo (no `taskId`/`runId` — the same shape `dispatchChatMessageToTopic` writes into Chat), resolves the POST with `{ sessionId, accepted: true, blockId }`, and continues routing + dispatch off the request path (`routeAndDispatchChatMessage`). On a chat-direct verdict the dispatch binds the echo to its turn in place (`attachTaskToUserTextBlock` — published, so live subscribers see the association); on a topic verdict the echo stays render-only and the topic path skips its own Chat echo insert; on a busy session the pending entry carries `echoBlockId`. The routing verdict is bounded (`ROUTE_VERDICT_TIMEOUT_MS`) and any router error or timeout degrades to a chat-direct dispatch — an accepted message is never stranded; a dispatch failure after the ack logs `chat.accept.dispatch_failed` and surfaces a `system_note` in the transcript instead of the pre-ack HTTP 500.

An optional `{ bypassQueue: true }` skips the enqueue decision entirely and always runs now. Only the messaging bridge passes it (see "Why messaging bypasses the queue"); a function overload narrows the return type to the run-now shape for that caller so it gets a `taskId` without discriminating on `queued`. Interactive clients omit the option and keep the discriminated union.

### Pre-queue carve-outs: needs-input answer and supersede

Two checks run BEFORE the enqueue decision — in `submitChatMessage` and in the router's `dispatchChatMessageToTopic` alike — because in both cases queueing the message behind the paused turn would be wrong (see ADR task-containers-and-runs.md):

- **A message during a `needs_input` park answers and resumes.** When the session's one live task is parked on an `ask_user` question (a pending `chat.choice` SetupRequest), the message IS the answer: `answerNeedsInputForMessage` resolves the stamped SetupRequest with freeform-answer semantics and resumes the SAME task. Nothing enqueues and no new task is minted.
- **A message during a pending Authorization gate supersedes.** When the session's one live task is `waiting_approval` on pending Authorizations only, `supersedeGatedTaskForMessage` cancels the gated task ("Superseded by your new message"; the gate is denied, never approved — user text never resolves a gate as approval) and the message runs as a fresh turn.

Both carve-outs are deliberately narrow: a **non-empty `pendingMessages` queue disables them** (FIFO order is preserved — the message queues as usual), and a mid-loop (running) task always queues, so mid-run steering stays queue-only. After a supersede, the in-flight re-check happens on fresh state so a turn started concurrently in the cancel window queues the message instead of racing it. **Everything else queues exactly as described above.**

`submitThreadReply` (a reply posted inside a thread) shares the same session-level queue and one-turn-per-session serialization. It validates the session and resolves the thread's `parentBlockId` up front (so a bad reply still fails fast), runs `prepareChatSubmission`, then applies the identical session-scoped guard (`sessionHasInFlightChatTask` or a non-empty queue) and either enqueues the reply — carrying its `threadId`/`parentBlockId`/`alsoToMain` — or runs it now. A queued thread reply therefore waits behind a live turn in its session (including one paused at `waiting_approval`) instead of spawning a second competing task, and auto-dispatch re-runs it back into the same thread (see below).

`runChatSubmission(config, sessionId, prepared)` is the extracted run-now body (create the conversation run, `submitTask`, link the run, persist the user `ChatMessageRecord` + `user_text` `ChatBlock`). Both the immediate path and the auto-dispatch path call it so a queued message becomes an identical real turn when it runs.

## FIFO one-per-turn auto-dispatch

`dispatchNextPendingChatMessage(config, sessionId)` is the **single guarded chokepoint** for draining the queue. It is atomic and idempotent: the in-flight check (`sessionHasInFlightChatTask`) AND the FIFO pop (`shiftPendingChatMessage`) run inside ONE `mutateState`, so a queued message is popped only when the session is truly idle. It then publishes the shrunk queue and runs the popped message: a thread reply (`popped.threadId` set) via `runThreadSubmission` so it re-runs inside its thread, otherwise a main-chat message via `runChatSubmission`. A run failure is logged (`chat.queue.dispatch_failed`) and swallowed so one bad turn doesn't crash the dispatch chain — the remaining queue stays intact for the next terminal transition.

Because `sessionHasInFlightChatTask` treats queued/running/**waiting_approval** as in-flight, calling the chokepoint while a turn is still active or paused for approval pops nothing and no-ops. That makes the function safe to call redundantly from several settle points: at most one queued message drains, and only once no live turn remains for the session.

The chokepoint is fired from four owners, each gated to a top-level chat task (`task.mode === "chat" && task.chatSessionId && !task.parentTaskId`) and firing only AFTER the terminal state is committed:

- **`submitTask` (`packages/runtime/src/agent.ts`)** — the fire-and-forget `runTask(...)` chain gets a `.finally(...)` that calls the chokepoint. This covers an active run's normal completion, failure (the preceding `.catch(failTask)` runs first), and user cancel of a running turn. It also fires when a turn pauses for approval — `runChatTask` returns the non-terminal `waiting_approval` task, resolving the promise — but the in-flight guard makes that a deliberate no-op rather than a premature second turn.
- **`resumeChatTask` (`packages/runtime/src/execution/chat-task.ts`)** — after the resumed loop settles. An approval resume continues the turn inside this separate call path; its original `runTask` promise already resolved at the pause, so the `.finally` would never drain a queue stranded behind the resumed turn.
- **`decideApproval` deny branch (`packages/runtime/src/agent.ts`)** — the deny path flips the paused task to `failed` INLINE in its own `mutateState` (not via `failTask`), and its `runTask` promise already resolved at the pause, so the `.finally` doesn't fire for it.
- **`cancelTask` (`packages/runtime/src/agent.ts`)** — cancelling a `waiting_approval` task sets it terminal with no active `runTask` promise, so the `.finally` never fires for it.

Each dispatched message becomes the new in-flight task; when IT settles the chain fires again, so the queue drains one message per turn. Subagent and imperative tasks are excluded — they have no session queue.

### Stop drains the queue (current decision)

The queue advances whenever the current turn ends, **including a user Stop**. This is the uniform, simplest-to-reason-about rule ("the next queued message sends when the current turn finishes, however it finishes"); the per-item remove (×) button is the escape hatch for unwanted queued messages. The alternative — Stop clears the entire queue — was considered and not chosen; it is the natural place to revisit if the uniform rule proves surprising.

A negligible, documented residual race exists: between shifting the last pending message and the new task being created, a concurrent submit could run instead of enqueue. The window is sub-millisecond for a single user and degrades to the pre-queue concurrent behavior; no additional atomicity is layered on for it.

## Propagation

Every queue mutation publishes the full session over the existing `chat_session` SSE event (`publishChatSession`, `packages/runtime/src/state/chat-session-events.ts`) on the `/api/chat/:id/stream` socket, so the queue pill updates live on every subscribed client. No new event type is introduced.

## HTTP

- `POST /api/chat/:id/messages` on a routed `kind:"agent"` session returns the instant ack `{ sessionId, accepted: true, blockId }` — the run/task ids arrive via the existing block/session SSE streams once the routing verdict dispatches the turn (the echo block identified by `blockId` gains `taskId`/`runId` on a chat-direct run). No shipped client read the old synchronous ids (web, mobile, and the CLI all key off SSE/refetch); a caller that needs the `taskId` polls the blocks for the echo binding, as `scripts/e2e-browser-tools.ts` does. Non-routed sessions (topic/channel/bridge) keep the synchronous shapes: `{ sessionId, runId, taskId, status }` when the message runs immediately, `{ sessionId, queued: true, pendingId }` when it is enqueued.
- `DELETE /api/chat/:id/pending/:pendingId` removes a queued (not-yet-dispatched) message, publishing the updated session; returns `{ removed: true }` or 404 when the id isn't queued.

## Why messaging bypasses the queue

The Telegram/Discord pollers mirror the agent's reply back to the originating chat via a per-inbound-message task: `receiveMessagingInput` (`packages/runtime/src/integrations/messaging.ts`) returns the `taskId` of the task it just created, and the poller's `maintainTypingAndMirrorReply` waits on exactly that task (`syncChatTaskResult`) to show "typing…" and send the reply out (`sendMessagingOutput`). That mirror is the only path that delivers the assistant's response back to the user.

A queued submit returns `{ queued: true }` with no `taskId` — the task is created later at auto-dispatch — so routing messaging through the interactive queue would strand the inbound message without a task for the mirror to wait on, and the agent's eventual reply would never be sent back. This is routine: a user double-texting, or two updates arriving in one poll batch, both produce an inbound message while a turn is already in flight.

So messaging passes `{ bypassQueue: true }` to `submitChatMessage` and always runs each inbound message immediately, retaining its pre-queue concurrent behavior by design. Each inbound message gets its own task and its own reply mirror. The interactive queue is the right model for a human watching a single turn; the messaging bridge is a distinct ingestion path with a different reply contract.

## Acceptance checks

- Idle session: `submitChatMessage` runs immediately (returns `taskId`, no `queued` flag); `pendingMessages` stays empty (`packages/runtime/src/execution/chat-queue.test.ts`).
- Busy session (a non-terminal chat task seeded on the session): `submitChatMessage` enqueues (`queued: true` + `pendingId`, `pendingMessages` grows, no second task) (`packages/runtime/src/execution/chat-queue.test.ts`, `packages/runtime/src/http.test.ts`).
- A submit behind a non-empty queue with no running task still enqueues, preserving FIFO order (`packages/runtime/src/execution/chat-queue.test.ts`).
- `dispatchNextPendingChatMessage` pops FIFO and runs the next message once the session is idle (creates a task + user row for the popped content; the queue shrinks); it is a no-op on an empty queue (`packages/runtime/src/execution/chat-queue.test.ts`).
- The guard holds the queue while a turn is paused at `waiting_approval` (calling the chokepoint pops nothing and starts no second task), then drains the queued message once the paused task reaches a terminal status (`packages/runtime/src/execution/chat-queue.test.ts`).
- A thread reply posted while the session has an in-flight task enqueues (`queued: true`, no second task) with `threadId`/`parentBlockId` on the pending entry; auto-dispatch re-runs it back into the same thread (the dispatched task carries the original `threadId`) (`packages/runtime/src/execution/chat-queue.test.ts`).
- `removePendingChatMessageById` removes the right item and returns false for an unknown id; the DELETE route maps that to 404 (`packages/runtime/src/execution/chat-queue.test.ts`, `packages/runtime/src/http.test.ts`).
- `bypassQueue: true` runs immediately even while a turn is in flight: it returns the run-now shape with a `taskId`, creates a new task, and leaves `pendingMessages` empty (`packages/runtime/src/execution/chat-queue.test.ts`).
- Two inbound bridge messages to the same session bypass the queue and each runs its own task immediately; both user rows land in order, synchronously (`packages/runtime/src/integrations/messaging.test.ts`).
