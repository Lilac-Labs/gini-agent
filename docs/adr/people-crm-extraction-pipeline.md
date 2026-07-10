# ADR: People-CRM Extraction Pipeline

- **Status:** Accepted
- **Date:** 2026-07-10
- **See also:** [Per-Agent Structured Database Primitive](./agent-database.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Bulk source-material extraction into the people-CRM (the OPE-70 mailbox
backfill, and the future ongoing trigger) runs as **real chat turns against a
dedicated curator agent**, fully parallel, with correctness owned by the
**database schema** rather than any scheduler coordination:

1. **Curator agent.** A purpose-built agent (toolsets `["database"]`,
   `autoMemory: false`) is the active agent for extraction turns. Toolset
   scoping is what prevents tool wandering; the ambient Hindsight pipeline is
   off because the CRM database *is* this agent's durable memory — measured on
   a 2,139-message mailbox, auto-recall was 44.9% of turn latency (p90 113s
   under 16-way concurrency) and each auto-retain ran minutes of background
   embed/model calls while flooding the bank with 17k email-derived units.
   `AgentRecord.autoMemory` (`POST /api/agents/:id/memory`) exists for exactly
   this class of high-volume mechanical agent.

2. **Convergent seeded schema.** `agent-data-db.ts` seeds `contacts` /
   `relations` so turns can assume them: generated-id primary key (email is
   UNIQUE but nullable — keying by email forces fabrication), CHECK-enforced
   normalization (lowercased address-shaped email, scheme-qualified url,
   E.164 phone), `updated_at` epoch-ms with a **monotonic touch trigger**
   (`MAX(now, old+1)` closes the same-millisecond ABA window), a partial
   unique index arbitrating email-less name collisions, and a unique
   `(a, b, kind)` relations edge. `description` is the one-line roster handle
   so list queries skip multi-KB `profile` dossiers; `last_spoke_at` records
   engagement (below).

3. **Turns are convergent, so execution is at-least-once.** Every UPDATE is
   CAS-guarded by `updated_at` (`changes: 0` → re-read, re-merge, retry);
   INSERT races bounce off UNIQUE into query-then-update; the skill instructs
   both recovery loops plus partial-name matching before insert. Because a
   duplicated or half-cancelled turn converges, the runner needs no
   per-participant locks (an earlier lock design serialized one broadcast
   sender's 19 threads into a 26-minute critical path), timeouts simply retry,
   and **stall-aware hedging** is safe: when a turn's task emits no trace
   events for 60s, a duplicate launches and the first completion wins.
   Progress-aware on purpose — a turn that is landing tool calls is slow for a
   reason and a twin would just contend; a silent one is a provider stall.
   A post-run sweep (SQL candidate detection, parallel merge turns per
   disjoint cluster) converges any same-person-different-key twins the
   row-level constraints cannot see.

4. **Engagement is the validity tier.** A contact is a *relationship* only if
   the user engaged: wrote to them, replied in their thread, or was
   deliberately cc'd into it (the intro shape — which also heals alias
   blindness). `last_spoke_at` records this; roster/importance queries filter
   on it. Measured: only 36 of 134 permissively-extracted contacts had ever
   been written to. Intake defaults to **engaged-only** (process only threads
   the user participated in), which cut model work 4.5× on the reference
   mailbox. The skill additionally skips unsolicited sellers/marketers/
   recruiters even when the user replied — a polite decline is closing a cold
   pitch, not a relationship.

5. **Prefilter is two-tier, and frequency is explicitly rejected.** Tier 1
   (free): self/alias set, an automated-sender regex, and a behavioral
   broadcast rule (sender with ≥3 threads, all single-message, never answered
   — catches AI personas and drips regexes can't). Tier 2: an audit mode
   re-runs dropped threads from person-named senders through the model.
   Measured on labeled ground truth: pure frequency keep-rules lose 45–71% of
   real contacts while keeping most noise (humans are one-shot; machines
   repeat); bulk-mail headers (`List-Unsubscribe` etc.) are also disqualified
   because BD humans send through ESPs (would lose 26/106 contacts). The
   two-tier stack dominated every zero-loss single-pass alternative tested.

## Cost posture (measured)

Seven full-mailbox runs isolating each lever, same model (GPT-5.5 via the
edge): quote-stripping reply tails −27% (reply chains re-pay every prior
message as fresh input); serial execution −14% (cache 71→77%); skill-inlined
message −2%; primary-correspondent batching −4%. **Combined they are
super-additive: −61%** ($19.25 → $7.42 for a 2,139-message mailbox at
~20 min serial; $12.56 at 9.7 min with 16-way parallelism — big merged turns
lose ~11 points of cache under parallelism, so serial is worth −41% inside
the full stack). Cached input is priced (10× under fresh), so the levers
split cleanly into fresh-input reducers (quote-strip), re-read reducers
(fewer calls/turns), and cache-rate improvers (serial).

## Consequences

- Runtime carries: the seeded convergent schema with legacy backfills, the
  `autoMemory` agent switch and route, and skill `people-crm` v1.4 (schema +
  dossier format + folding/engagement/cold-outreach rules).
- The batch runner is a reference implementation outside the repo
  (`~/gini-crm-scratch/crm-harness2.ts` + `turn-runner.ts`, unit-tested
  against a mock gateway): resumable per-thread queue, engaged-only intake,
  batching, hedged turns, audit mode, per-turn cost telemetry. Wiring the
  ongoing extraction trigger into the runtime is the remaining OPE-70 work
  and should reuse these shapes via the chat path — the legacy `/api/tasks`
  path dispatches no tools.
- Judgment-based rules (cold-pitch vs. contact) carry run-to-run membership
  variance of a few borderline rows; the constraints guarantee zero
  duplicates and zero malformed fields regardless.

## Acceptance checks

- `bun test packages/runtime/src/state/agent-data-db.test.ts` — seeded
  schema, CHECK rejections, CAS/trigger monotonicity, legacy backfills,
  unique relations edge.
- `bun test packages/runtime/src/capabilities/agents.test.ts
  packages/runtime/src/execution/effective-context.test.ts
  packages/runtime/src/memory/integration.test.ts` — autoMemory storage,
  resolution, and end-to-end recall/retain skip.
- A bare chat turn ("who are my important contacts?") against the curator
  answers from `last_spoke_at IS NOT NULL` without touching profiles.
