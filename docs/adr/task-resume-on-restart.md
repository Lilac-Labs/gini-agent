# ADR: Resume in-flight tasks after a gateway restart

## Decision

When the gateway boots, `reconcileInFlightTasks` (in `packages/runtime/src/agent.ts`) reconciles
every task left in-flight by the previous process so none hang forever. A
top-level chat turn interrupted mid-flight is **resumed** by re-running the turn
from durable chat state; every other orphaned task is **failed** so its UI
spinner clears.

The boot hook lives in `packages/runtime/src/server.ts`: it captures `bootStartedAt = now()`
before `install()`, and after the HTTP port binds (so tool callbacks to
localhost work) and the `runtime.started` log, it fires
`reconcileInFlightTasks(config, { cutoffIso: bootStartedAt })` best-effort —
never blocking or crashing boot.

This closes the boot-reconciliation gap: previously a graceful SIGTERM drain
(launchd/watchdog restart, self-update) landing the instant a chat turn was
mid-flight left the durable task frozen at `status: running` /
`currentStep: Thinking`, so the web UI showed a perpetual spinner with a dead
Stop button. See [Local runtime architecture](local-runtime-architecture.md)
for the process/state model this builds on.

## Orphan definition and the cutoff race-guard

An **orphan** is a task whose `status` is `running` or `queued` AND whose
`updatedAt` predates this process's boot time (`updatedAt < cutoffIso`). The
cutoff is the single race-guard: the reconcile runs after the HTTP server binds,
so a client could POST a new message in the window before the reconcile fires.
Comparing each task's `updatedAt` against the process boot time cleanly excludes
any task created or updated by THIS process (its `updatedAt >= cutoffIso`), so
the pass only ever claims true orphans from the previous process. `bootStartedAt`
is captured at the top of boot, before any state work, precisely so it sits
earlier than every timestamp this process will write.

Terminal statuses (`completed`, `failed`, `cancelled`) are NEVER touched. A
park (`waiting_approval` / `needs_input`) with any PENDING gate is likewise
never touched: it is a durable, legitimate pause waiting on the user — not an
orphan — so the common side-effect path (a side-effecting tool parked at an
approval gate) is never re-run by a restart.

A park whose gates are ALL terminal is different: every gate resolution
persists its outcome FIRST and resumes the chat-task loop through a DETACHED
call second, so a process death in between leaves the task parked with
nothing left to ever move it — /complete sees a non-pending row, a thread
message finds no pending gate to answer. The reconcile passes these parked
candidates (cutoff-guarded like orphans) to `resumeParkIfGatesSettled`
(`packages/runtime/src/execution/safe-resume.ts`), the idempotent settled-park
heal shared with the /complete replay and message-into-wedged-container entry
points. It re-checks the wedge signature from durable state, synthesizes each
settled gate's tool result from its persisted outcome (chat-choice answers
rebuild the exact live strings from `connectOutcome`; an approved
Authorization gets an honest interrupted marker because its side effect's
real result died with the process), and kicks the standard detached
`resumeChatTask` — never `dispatch`, which would replay the turn from the
user message instead of continuing from the park. The approved-Authorization
hedge consults `state.audit` for the approvalId-stamped side-effect row
written at execution time: row present → executed, do NOT re-run (with the
row's evidence quoted); absent → the honest hedge. The approve endpoint
responding at decision-durability (execution detached) WIDENS the
durable-but-not-executed window this branch covers, but the proof semantics
are unchanged — the execution audit row is still written only at execution
time. Double kicks are safe: the
park→running flip inside `resumeChatTask` is the claim, so exactly one
concurrent resumer re-enters the loop, and a live in-process resume declines
the heal via an in-flight registry.

## Resume vs. fail

- **RESUME** — top-level chat orphans: `mode === "chat"` AND no `parentTaskId`
  AND under the crash-loop cap. The claim pass increments `bootResumeCount`,
  clears `partialSummary` (because `appendTaskPartial` APPENDS, a stale partial
  from the interrupted turn would otherwise concatenate onto the resumed turn's
  streamed text), resets `currentStep` to `Thinking`, bumps `updatedAt`, then
  fire-and-forget dispatches via `runTask` (which routes chat tasks to
  `runChatTask`). Resume is clean because `priorChatMessages`
  (`packages/runtime/src/execution/chat-task.ts`) replays only OTHER tasks' committed rows
  (`m.taskId !== task.id`) and rebuilds the current user message from
  `task.input`, so re-running the turn produces no duplicate user message and the
  defensive tool-call pairing pass drops any partially-persisted tool round.
- **FAIL** — every other orphan: subagent children (`parentTaskId` set),
  imperative tasks (`mode !== "chat"`), and any chat task over the crash-loop
  cap. `failTask` emits a terminal `Failed` phase so the UI spinner clears. A
  resumed chat parent re-spawns its own subagents fresh, so orphaned old
  subagent children are dead records — failing them avoids duplicate or zombie
  subagents.

## Crash-loop cap

A poison task that crashes the process on every resume would brick the gateway in
a restart loop. The per-task cumulative counter `bootResumeCount` (on the `Task`
interface in `packages/runtime/src/types.ts`) caps re-dispatches at `MAX_BOOT_RESUMES = 3`; over
the cap the task is failed instead of resumed. No progress-reset is needed: a
normal chat turn runs for seconds, so the only way to accumulate 3
boot-interruptions on ONE task is a task that keeps failing to complete across
restarts — exactly the poison signal. A task that completes keeps its count but
is never reconciled again, and the next turn is a fresh task with count 0.

## Side-effect re-execution limitation

Resume re-runs the WHOLE turn rather than replaying mid-iteration, which is the
correct granularity given that the only durable mid-turn snapshot is the
approval `toolCallState`. Read-only tools (the overwhelming majority) just re-run
harmlessly. The narrow known limitation: if a side-effecting, approval-gated tool
had been approved AND executed AND the crash landed before the turn finished,
re-running could re-trigger it (the model re-requests approval, the user
re-approves, the effect fires again). Tasks durably parked at `waiting_approval`
are not resumed, so the common side-effect path is safe; this limitation only
covers a side effect that completed and then the process died before the turn
did. Exactly-once-across-crashes for side effects (tool idempotency keys) is a
separate, larger reliability concern and is future work, not solved here.

## Consequences

- A gateway restart mid-turn no longer strands a chat thread at "Thinking…"
  forever; the interrupted turn resumes and completes, or the orphan is failed
  with a clear terminal state.
- Each boot emits a `tasks.reconciled` log event with `{ resumed, failed }`
  counts; reconcile errors are logged as `tasks.reconcile.error` without
  crashing boot.
- The `Task` interface gains an optional `bootResumeCount`.

## Acceptance checks

- `bun run typecheck` clean.
- `bun run test` clean.
- `packages/runtime/src/agent-reconcile.test.ts` covers: running and queued chat orphans resume
  (dispatched, `partialSummary` cleared, `bootResumeCount === 1`);
  `waiting_approval` and terminal tasks untouched; a `running` chat task with
  `updatedAt >= cutoffIso` untouched (race guard); subagent and imperative
  orphans fail without dispatch; a chat orphan at the cap fails without dispatch.
- `packages/runtime/src/execution/chat-needs-input.test.ts` ("wedged park
  recovery") covers the settled-park heal: both park flavors resume at boot
  (needs_input with a completed chat.choice gate; waiting_approval with an
  approved Authorization), a park with a PENDING gate stays untouched, and
  the /complete-replay and message entry points kick the same heal.
