# ADR: Task Containers And Runs (Unified Task Model)

- **Status:** Accepted (2026-07-03; shipped in phases on the implementing branch)
- **Date:** 2026-07-03
- **Supersedes in part:** [Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md) (the Topic-as-a-distinct-tier framing and the Task tier's needs-input-as-return-value; the routing, forwarding, and context-isolation decisions stand)
- **Updates:** [Server-Side Chat Message Queue](./chat-message-queue.md) (two pre-queue carve-outs), [Subagent Delegation](./subagent-delegation.md) (vocabulary narrowed to in-run helpers)
- **See also:** [Job Delivery Policy](./job-delivery-policy.md), [User Choice Prompt](./user-choice-prompt.md), [Authorization vs SetupRequest](./authorization-vs-setup-request.md), [Approval And Audit Substrate](./approval-and-audit-substrate.md)

## Decision

Collapse the Chat → Topic → Task hierarchy's *container* side into **one container
primitive — the task**: a durable thread (blocks + context) plus a lifecycle plus a
derived attention state. Storage stays on `ChatSessionRecord`
(`packages/runtime/src/types.ts`) — no new table. Everything that used to look like a
distinct container type is a fact on that one record:

- **Topic** is not a type. A topic is a task container the **user pinned**
  (`pinned === true`). The sidebar lists pinned containers only; nothing the agent or
  the intake router creates is ever auto-pinned.
- **Headless** (`headless === true`) is a container never surfaced in chrome — home,
  sidebar, unscoped session lists, router candidates — e.g. a silent watch job's
  working thread. It stays directly addressable by id.
- **Chat remains the root `kind:"agent"` container** (the Messages surface), one per
  agent, resolved by `getOrCreateAgentChat`. It is a router + inbox, not a work item.

The *execution* side keeps today's backend `Task` record as the *run*: one agent-loop
execution inside a container. The `Task`→`Run` rename is staged, not started (see
Rename staging below).

## Settled ontology

This is the conceptual language for all naming decisions going forward.

- **Two primitives**: **task** (container: thread + lifecycle + attention) and **run**
  (one burst of execution). *Topic* and *subagent* are not types — topic = a task the
  user pinned; **"subagent" refers ONLY to invisible in-run helpers** (parallel
  fan-out, heavy reads, narrowed-tool chunks). Agent-created user-facing work (a
  watch's email drafts) is a **child task** (`surfaced: true`), never a subagent.
- **Actors vs records**: user, agent, and clock (schedules) *act*; task, run, and job
  are *records*. **The agent acts only inside runs** — every agent decision (spawn,
  tool call) is journaled in the run where it happened. `spawnedByTaskId` on a child
  container records provenance, not agency. Jobs never create tasks; a job wakes the
  agent, and the agent creates tasks during the scheduled run.
- **Run creation is triggered, never decided**: a user message, a schedule fire, or a
  spawn mints a run; the agent executes it. A run cannot mint sibling runs —
  continuation is a new run (follow-up or schedule) or a child task (delegation).
  Answering `needs_input` resumes the SAME run; feedback on a pending Authorization
  gate supersedes (new run); a message mid-loop queues.
- **Every task's run 1 starts from its creator's brief** — the user's composer text,
  or the agent's written brief (goal + relevant slice), **never the parent's
  transcript**. Child threads are therefore self-contained: the thread you read IS the
  context its runs used (legibility + replay correctness). The first run of a spawned
  task is an ordinary run; the subagent machinery is reused only as the mechanical
  carrier of the brief and constraints.
- **Two reporting chains**:
  - *helper → spawning run*: an in-run helper reports **one hop**, as a tool result,
    to the run that spawned it — never to the task, home, or the user. An awaited
    helper's needs-input bubbles to the run, which re-asks via its own `ask_user`.
  - *child task → its own runs → its task → mirrored into the parent thread →
    surfaces*: a child container's results mirror emit-time into the parent thread
    (`resolveEmitContext`, `packages/runtime/src/execution/chat-task-emit.ts`) and
    reach home through the child's own derived attention.

## Derived attention

A container's attention is **computed on read, never stored**
(`deriveContainerAttention`, `packages/runtime/src/state/attention.ts`):

```
needs_input > review > working > done_unacknowledged > none
```

- `needs_input` — a live run is parked on a pending `chat.choice` SetupRequest (the
  `ask_user` card).
- `review` — a live run is parked on a pending Authorization (a confirm/send card).
- `working` — a live run with no pending user decision.
- `done_unacknowledged` — the latest terminal run outcome is newer than the
  container's `acknowledgedAt`.
- `none` — nothing live; the latest outcome (if any) is acknowledged.

Only **facts** persist on `ChatSessionRecord`: `pinned`, `headless`, `acknowledgedAt`,
`correlationKey`, `spawnedByTaskId`, `surfaced`, `startedAs`. `acknowledgedAt` is the
home checkbox (`acknowledgeContainer` deliberately does not bump `updatedAt` — checking
a row off is a read gesture, not activity). `startedAs` (`"task" | "message"`) records
the composer gesture that minted the container — immutable presentation intent, not
lifecycle; Home's Chats tab lists `startedAs === "message"` only, and the
field stays absent on router/agent/job mints and pre-field records (unknown ≠ either).

## The home surface

`GET /api/home` returns the attention queue + done list + recents via a lean read path
(`homeView`, `packages/runtime/src/runtime/views.ts`) — it does not reuse
`listChatSessions`, which embeds full message arrays. **Inclusion predicate**: a
container is a home task row iff its derived attention ≠ none AND

```
startedBy === "user"
OR attention ∈ {needs_input, review}
OR surfaced === true
```

`startedBy` is itself derived from facts: `origin === "job"` → schedule,
`spawnedByTaskId` → agent, else user. So user-started work shows its full lifecycle;
agent-spawned internal errands surface only when they need a decision; containers the
spawner explicitly marked user-facing (`surfaced`, set by `spawn_task`'s
`surface: true`) surface on any live attention. Without the predicate, derived
`done_unacknowledged` would flood home with every background errand. Runs, in-run
helpers, silent children, and silent job runs never appear on home — home shows
decisions and outcomes, never machinery.

Acknowledged success resurfaces once more: a user-facing container (same
`startedBy === "user" OR surfaced` rule) whose derived attention is `none` and whose
latest terminal outcome is `completed` returns in a separate `done` array
(`HomeDoneItem`: `id`, `title`, optional `outcomeLine`, `completedAt`), feeding the
collapsible Done section under the tasks queue — sorted newest-first, capped at 10.
Acknowledged failures and cancellations still disappear entirely.

Container mutations ride `POST /api/containers` (direct start, bypasses the intake
router; optional `startedAs`), `POST /api/containers/:id/acknowledge`,
`PATCH /api/containers/:id` (`pinned`, `title`, `archived` — archiving hides the
container from list surfaces while deep links keep resolving), and
`DELETE /api/containers/:id` (cascades the session row + transcript via
`deleteChatSession`, retains the run journal; 400 for the root Chat and headless job
threads, 409 while a run is live; children keep a dangling `parentChatSessionId` —
forwarding already guards on the parent existing). Existing `/api/chat*` stays the
thread surface.

**Streaming note:** attention has no dedicated SSE stream. Home freshness is a client
poll plus invalidation off the existing session/task events — deliberate for now; a
dedicated attention event is a follow-up if polling proves too coarse.

## `needs_input` status

`TaskStatus` gains `"needs_input"`, a sibling of `waiting_approval`. This is a
**reclassification of an existing park**, not new machinery: `ask_user` already minted
a `chat.choice` SetupRequest and parked the loop. The park
(`packages/runtime/src/execution/chat-task.ts`) now classifies: all pending gates are
`chat.choice` → `needs_input` with the question payload stamped on `Task.needsInput`
(`{ question, options?, setupRequestId?, blockId? }`); any pending Authorization keeps
`waiting_approval`. Resume accepts both statuses and clears the stamp.

A plain message posted into the parked container **is the answer**: it resolves the
stamped SetupRequest with freeform-answer semantics and resumes the SAME run
(`answerNeedsInputForMessage`, `packages/runtime/src/execution/chat.ts`) — zero client
changes for CLI and bridges. `POST /api/setup-requests/:id/complete` keeps working for
the card; a lost race between the two fails gracefully (the second answer is never
double-applied).

**Escape hatch:** `GINI_NEEDS_INPUT_STATUS=0` parks the same gates under
`waiting_approval` while the internal machinery (stamp, answer path) keeps working —
a one-release compatibility valve for clients that render statuses exhaustively.

## Supersede — and the click-only approval invariant

**A gated side effect executes ONLY via the explicit approve action**
(`POST /api/authorizations/:id/approve` — the button on the confirm card). **User text
during a pending gate ALWAYS takes the supersede path and never approves — even a
literal "yes, send it."** There is no affirmation or intent classification,
permanently. This is an invariant, not a heuristic: text is feedback, clicks are
decisions.

The approve POST responds once the decision is durable; the side effect runs detached,
during which the task's stored status stays `waiting_approval` with `currentStep`
stamped `Executing <action>…` — a distinct `executing` `TaskStatus` is a designed
follow-up (flipping status there would interact with the resume stage-2 claim the
restart heal depends on).

The supersede path (`supersedeGatedTaskForMessage`,
`packages/runtime/src/execution/chat.ts`): when a container's single live run is
`waiting_approval` on pending Authorizations only, with an empty message queue, a new
user message cancels the gated run (pending Authorizations → denied, system note
"Superseded by your new message", `supersededByTaskId` stamped) and starts a fresh run
with the message as input. Deliberately narrow: a non-empty queue preserves FIFO
(message queues), a mid-loop run queues (steering stays queue-only), and a pending
SetupRequest park is a question to answer, not a decision to override (the answer path
above owns it). In `submitChatMessage` both carve-outs run before the intake-routing
decision AND the queue decision — a message posted while the root Chat's own live run
is parked answers or supersedes that run in place instead of being routed into a Topic
(which would strand the parked gate) — and in the router's
`dispatchChatMessageToTopic` they run before the queue decision, so Chat-routed and
direct posts behave identically. See ADR chat-message-queue.md.

## Child tasks: idempotent spawn + depth caps

`spawn_task` (`packages/runtime/src/execution/tool-dispatch.ts`) mints a durable child
task container — its own thread, `parentChatSessionId` = the spawning container,
`spawnedByTaskId` = the spawning run — and lands the creator's brief in the child
thread as a durable block, so the child is self-contained (ontology above). Execution
composes with the existing subagent machinery (cancel cascade, terminal-parent
recheck); `await: "result"` waits for the child's terminal state and returns
immediately if the child parks on `needs_input`; `await: "none"` returns ids (watch
mode).

**Idempotency:** `correlation_key` is scoped to the parent container. A re-fired spawn
with the same key finds the existing child (`findChildContainerByCorrelationKey`,
`packages/runtime/src/state/records.ts`) and returns
`{ deduped: true, containerId, latestRunStatus }` instead of minting a duplicate — the
lookup deliberately ignores `acknowledgedAt` and `archivedAt`, so **dedup survives
acknowledge and archive** (dismissing a draft must not resurrect it on the next watch
fire). Known limit: because keys are scoped to the parent container, recreating a
watch job (a new headless container) resets the scope and re-drafts old findings once.
Accepted — the alternative (a global key namespace) couples unrelated spawners.

**Depth:** child-container chains and in-run helper chains share one cap
(`MAX_SUBAGENT_DEPTH`, `packages/runtime/src/capabilities/subagents.ts`) — enforced on
both the run-parent chain (`subagentDepth`) and the container-parent chain
(`containerChainDepth`), so recursion cannot hide by alternating mechanisms.

## Concurrency model

- **Runs are serial per task.** One live run per container —
  `sessionHasInFlightChatTask` treats queued/running/`waiting_approval`/`needs_input`
  as in-flight, and new triggers queue in `pendingMessages` (one thread, one writer).
  Known limitation: the in-flight check is check-then-act across separate state
  reads, so two truly concurrent submissions into the same container have a narrow
  double-mint window (pre-existing, shared by every message path); the designated
  fix is an atomic in-flight claim inside a single `mutateState`.
- **Parallelism lives across tasks** (the fleet) **and inside a run** (helper
  fan-out) — never as sibling runs inside one container.
- **Overlapping job fires are skipped, not stacked** — intended semantics, not a gap:
  the scheduler's atomic claim refuses a scheduled fire while the previous run is
  in-flight (audited `job.run.skipped_overlap`, `packages/runtime/src/jobs/index.ts`),
  `nextRunAt` untouched so the next tick retries after completion; manual/replay runs
  are exempt. No backlog ever accumulates.
- **A clock's own runs can never stall a schedule behind user input:** the `ask_user`
  surface guard rejects the tool in headless containers (and bridge sessions), so a
  scheduled run's shape is scan → spawn → exit; questions belong to surfaced child
  tasks. Surfaced (non-headless) job containers MAY park on `needs_input` — their
  thread is answerable in the web chat.

## Rename staging

The `Task`→`Run` rename does **not** start yet. Container vocabulary ships in new
endpoints only (`/api/home`, `/api/containers*`); every existing endpoint keeps its
current names and shapes. The blocker is the legacy `RunRecord`
(`packages/runtime/src/types.ts`, hydrated in `packages/runtime/src/execution/runs.ts`
and served by `/api/runs*`) — renaming `Task` to `Run` while `RunRecord` exists would
collide. The staged plan, each stage an independent PR:

1. Fold `RunRecord` into the `Task` serialization (a `Task` already carries everything
   `/api/runs*` derives from it via `taskToRunStatus`).
2. Delete the `execution/runs.ts` wrappers.
3. Rename `Task`→`Run` with type aliases for the transition.

`/api/tasks*` and `/api/runs*` stay byte-compatible throughout, until the oldest
mobile build in circulation has passed (precedent: the chat-blocks dual-publish
window).

Vocabulary alias table (settled term → today's record):

| Settled term | Today | Staging |
|---|---|---|
| task (container) | `ChatSessionRecord` `kind:"topic"`/`"channel"` | stays; new endpoints use container vocabulary |
| topic | container with `pinned === true` | not a type — a user gesture |
| run | backend `Task` record | rename deferred behind RunRecord consolidation |
| — (absorbed) | legacy `RunRecord` | fold into Task serialization, delete wrappers |
| in-run helper ("subagent") | `SubagentRecord` + `spawn_subagent` | unchanged; see ADR subagent-delegation.md |
| child task | `spawn_task` → child container | shipped |
| job (clock) | `JobRecord` | unchanged; see ADR job-delivery-policy.md |

## Consequences

Pro: one container primitive ends the container/execution conflation; attention is
derivable and therefore never stale; the sidebar stops flooding (pinning is explicit);
the click-only invariant makes approval semantics unspoofable by text; child tasks are
self-contained and replayable; watch-style fan-out is idempotent by construction.

Con: router-minted containers no longer auto-appear in the sidebar (they surface on
home; pinning keeps them) — a behavior change users must learn; home freshness is
poll-based for now; the correlation-key scope reset re-drafts old findings once when a
watch is recreated; the rename staging leaves a two-vocabulary window (`Task` in code,
"run" in prose) until the window closes.

## Acceptance checks

- Attention precedence matrix and ack-clears-done
  (`packages/runtime/src/state/attention.test.ts`); correlation finder survives
  acknowledge/archive (records tests); migrations idempotent (store tests).
- Supersede: literal "yes, send it" during a pending gate cancels and never executes;
  non-empty queue queues instead; mid-loop queues; topic-dispatch path superseded
  (`packages/runtime/src/execution/chat-supersede.test.ts`).
- `needs_input`: park payload, message-answer resumes the SAME task (direct and via
  `dispatchChatMessageToTopic`), `/complete` still works, mixed gates stay
  `waiting_approval`, double-answer race fails gracefully, restart-reconcile leaves the
  park, escape hatch (`packages/runtime/src/execution/chat-needs-input.test.ts`).
- `spawn_task`: dedup on same key incl. after acknowledge/archive, depth cap,
  `await:"none"`, one-level-up mirroring
  (`packages/runtime/src/execution/spawn-task.test.ts`).
- Router: `new_topic` mints unpinned; headless containers excluded from candidates
  (`packages/runtime/src/execution/chat-route.test.ts`).
- `bun run typecheck`, `bun run test`, `bun run gini smoke` green.
