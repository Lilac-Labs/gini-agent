# ADR: Agent Attribution Invariant At Event And Audit Emit Sites

- **Status:** Accepted
- **Date:** 2026-05-18
- **See also:** [Agents Replace Profiles](./agents-replace-profiles.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Every call into `appendEvent` and `addAudit` must declare its agent
attribution context explicitly. The shared `AgentContext` discriminated
union in `packages/runtime/src/state/audit.ts` is required as the third argument:

```ts
export type AgentContext =
  | { agentId: string; system?: never }
  | { taskId: string; agentId?: string; system?: never }
  | { jobId: string; agentId?: string; system?: never }
  | { sessionId: string; agentId?: string; system?: never }
  | { memoryId: string; agentId?: string; system?: never }
  | { system: true; agentId?: never };
```

`resolveAgentId(state, ctx)` is deterministic:

- explicit `agentId` → use it
- `taskId` / `jobId` / `sessionId` / `memoryId` → look up the
  corresponding record and read its `agentId`
- `system: true` → return `undefined` and persist the row unattributed
- a source id provided but the record missing (deleted, race) → return
  `undefined` — **do not** fall back to `state.activeAgentId`

There is no fallback to `state.activeAgentId` anywhere in the inference
path. Forgetting to thread `agentId` is a TypeScript compile error.

## Context

When per-agent scoping landed in the webapp, the runtime gained an
`agentId` field on most record kinds (tasks, jobs, chat sessions,
subagents, approvals) and a corresponding inference helper that emitted
events and audits used to stamp the persisted row. The helper preferred
an explicit `agentId`, then walked a source id (`taskId`, `jobId`,
etc.) to its record, and ultimately fell back to `state.activeAgentId`
if nothing else was available.

That last fallback was a foot-gun. A record carrying an `agentId` could
be attributed correctly at creation time, but a later event or audit
emitter that didn't thread the source id would fall through to
`state.activeAgentId` — which had changed in between because the user
or a scheduler tick activated a different agent. The resulting row
silently mis-attributed activity to whichever agent was active at the
moment of emit rather than the agent that owned the source record.

Each newly-discovered miss could be fixed by adding one more keyword
argument at one more call site, but the pattern was open-ended: the
runtime has ~120 emitter sites, and there was no structural reason the
next reader wouldn't find another. The bug class — silent attribution
leak after an active-agent switch — needed a structural fix.

## Required Now

- `appendEvent` and `addAudit` take a required third parameter of type
  `AgentContext`. The persisted `agentId` field is filled in by
  `resolveAgentId`, not by the caller spreading a field through the
  event input.
- The inference helper does not read `state.activeAgentId` anywhere.
- The `system: true` escape hatch is reserved for events that genuinely
  have no agent owner: instance boot, instance config changes,
  instance-level integration configuration (MCP servers, messaging
  bridges, relays, browser connections, snapshots). Agent lifecycle
  audits (`agent.created`, `agent.activated`, `agent.deleted`) attribute
  to the subject agent itself rather than `system: true`, so the new
  agent's own inbox carries its provenance.
- `migrateRecordAgentIds` re-stamps records whose `agentId` is missing
  or points at a deleted agent onto the default agent — tasks, chat
  sessions, jobs, job runs, subagents, authorizations, setup requests,
  AND email watchers. Including `EmailWatcherRecord` keeps an orphaned
  watcher re-homed in lockstep with its (also re-homed) backing job
  rather than split apart under a dead `agentId`; a split watcher would
  leave the startup email-watch backfill minting a duplicate shared job
  each boot.
- `migrateRecordAgentIds` no longer backfills events or audits. A
  missing `agentId` on those rows is now a first-class signal that the
  row is system-attributed; stamping legacy rows with the migration-
  time active agent would erase that distinction.

## Migration

Approximately 120 call sites across the runtime were migrated to pass
an explicit `AgentContext`. Each site was reviewed for the best source
of attribution available in scope:

- record creation helpers (`packages/runtime/src/state/records.ts`) attribute via the
  just-created record's own context (`taskId`, `jobId`, `sessionId`)
- job lifecycle, chat lifecycle, task lifecycle, subagent, approval
  audits use the source id their owning record carries
- agent lifecycle audits (`agent.created`, `agent.activated`,
  `agent.deleted`) attribute to the agent itself
- instance-level rows (push devices, snapshots, promotions, MCP,
  messaging bridges, connectors, relays, imports, toolsets, skills)
  declare `system: true` so they remain unattributed and surface only
  under the activity feed's "All agents" view

## Consequences

Pro:

- The "I forgot to thread `agentId`" bug class is impossible. The
  compiler rejects every two-argument call.
- The agent-attribution contract lives in one place
  (`packages/runtime/src/state/audit.ts`) and is enforceable by code review without
  expert runtime knowledge.
- `system: true` is now an explicit, auditable marker. Reviewers can
  ask "is this row really system-level?" at the diff instead of
  reasoning about whether `state.activeAgentId` would have been the
  right answer at runtime.

Con:

- Every emitter is verbose: a two-line audit payload is now four
  lines with the `AgentContext` argument on the next line. The
  verbosity is the point — it forces the call site to declare
  attribution rather than picking it up by accident.
- `system: true` is a small attack surface for "I don't want to think
  about this." Reviewers should treat it like an `as any` — it's not
  banned, but it should require justification. Every existing
  `system: true` call site in the migration carries a comment.

## Acceptance Checks

- `bun run typecheck` rejects `appendEvent(state, eventInput)` and
  `addAudit(state, auditInput)` (two arguments). The
  `// @ts-expect-error` guards in `packages/runtime/src/http.test.ts` pin this at the
  type level.
- Resolution tests in `packages/runtime/src/http.test.ts` cover every branch of the
  `AgentContext` union and the missing-source case.
- The active-agent-switch regression — a scheduled job fired after an
  agent switch must attribute to the originating job's agent rather
  than whichever agent is active at the moment the run fires —
  continues to pass.
