# ADR: Job Delivery Policy

- **Status:** Accepted (2026-07-03)
- **Date:** 2026-07-03
- **See also:** [Task Containers And Runs](./task-containers-and-runs.md), [Job Concern Fan-Out](./job-concern-fanout.md), [Email Watch](./email-watch.md), [Chat → Topics → Tasks → Subagents](./chat-topics-tasks-subagents.md) (Jobs → Topics)

## Decision

`JobRecord` gains `deliveryPolicy?: "always" | "on_findings" | "silent"`
(`packages/runtime/src/types.ts`), a declarative statement of what a scheduled run's
terminal result does at the delivery boundary:

- **`always`** — every terminal result delivers (Topic → Chat forward, origin bridge
  mirror, `deliveryTargets` fan-out). This is the default and IS the pre-policy
  behavior, including the model-driven `[SILENT]` sentinel: a run that replies with
  the exact sentinel still suppresses delivery (`packages/runtime/src/jobs/silent.ts`).
- **`on_findings`** — same delivery machinery, but the run's prompt is *invited* to
  stay silent: the `[SILENT]` hint line is injected into the cron execution hint
  **only for this policy** (`cronExecutionHint`, `packages/runtime/src/jobs/index.ts`).
  The suppression machinery itself is policy-independent; the policy only controls
  whether the model is told about it.
- **`silent`** — the run NEVER delivers: `finalizeJobRunFromTask`
  (`packages/runtime/src/jobs/finalize.ts`) skips the Chat forward, the bridge
  mirror, and the `deliveryTargets` fan-out on completed AND failed runs. The
  in-thread materialization (`syncChatTaskResult`) is kept — the working thread
  remains the run's journal. A silent job that needs the user reaches them by
  **spawning a surfaced child task** during the run, never by delivering its own
  result.

Enforcement is at the delivery boundary, not in the prompt: a misbehaving model can
leak nothing under `silent` because the skip happens in `finalize.ts`, after the run.

## Guardrails

- **`silent` is rejected for one-shot reminder jobs** at create/update time
  (`createScheduledJob`/`updateJob`, mirrored by `POST`/`PATCH /api/jobs` and the
  `create_job`/`update_job` tools). A reminder whose only observable effect is its
  delivery would be a no-op by construction — reject early instead of scheduling
  dead work.
- **Silent jobs run headless.** A dedicated thread minted for a `silent` job (and a
  fresh channel from a delivery rebind) sets `headless: true` on the container, so
  the watch's working thread stays out of home, the sidebar, unscoped session lists,
  and router candidates (see ADR task-containers-and-runs.md). Headless containers
  also cannot park on `ask_user` questions (the surface guard fails the tool
  synchronously), so a silent watch can never stall its schedule behind user input.
- **Migration:** `migrations.jobsDeliveryPolicyDefaulted`
  (`packages/runtime/src/state/store.ts`) backfills existing jobs with `"always"`
  once, and the finalize read defaults `?? "always"` for any record the migration
  missed — absent policy always means the pre-policy behavior.

## Fan-out idempotency

The watch pattern is: a headless `silent` job scans on a schedule and spawns a keyed
child task per finding that needs the user (`spawn_task` with a per-item
`correlation_key`, e.g. `email:<message-id>`, and `surface: true`).

The fan-out worker (ADR job-concern-fanout.md) deliberately does **not** mint
containers itself — per-item work is agent-driven `spawn_task` from the route
worker's turn. Because a correlation key is scoped to the **parent container** and
each route worker runs in its stable per-route session, the same key re-fired on a
later tick finds the existing child and dedups — across fires, with zero fan-out
plumbing. Dedup survives acknowledge and archive, so a draft the user dismissed is
not re-minted on the next scan. The known scope-reset limit (recreating the watch
job mints a new parent container, so old findings re-draft once) is documented in
ADR task-containers-and-runs.md.

## Consequences

Pro: watch-style jobs are expressible without prompt contortions ("respond [SILENT]
unless…"); silence is enforced structurally, not behaviorally; the default preserves
every existing job's behavior byte-for-byte; per-item findings are idempotent across
fires by construction.

Con: a `silent` job's health is only visible in its (headless) journal thread and
the jobs page — a misconfigured watch fails quietly; `on_findings` still trusts the
model to use the sentinel correctly (it is an invitation, not a gate).

## Acceptance checks

- Policy matrix × completed/failed: `always` delivers (sentinel still suppresses),
  `on_findings` injects the hint, `silent` skips forward + bridge + deliveryTargets
  on both terminal states while the journal materializes
  (`packages/runtime/src/jobs/delivery-policy.test.ts`).
- Migration defaults existing jobs to `always` exactly once (store tests).
- `silent` on a one-shot job is rejected at create and update; the tools and HTTP
  routes accept and validate the enum.
- Silent job threads mint `headless: true`; headless containers are excluded from
  unscoped `GET /api/chat` listings.
- Two scheduled fires with the same per-item correlation keys mint each child once
  (`packages/runtime/src/execution/spawn-task.test.ts`).
