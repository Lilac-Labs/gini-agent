# ADR: People-CRM Extraction Pipeline

- **Status:** Accepted
- **Date:** 2026-07-10
- **See also:** [Per-Agent Structured Database Primitive](./agent-database.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Bulk source-material extraction into the people-CRM (the OPE-70 mailbox
backfill and the ongoing watcher) runs as **real chat turns against a
dedicated curator persona**, fully parallel, with correctness owned by the
**database schema** rather than any scheduler coordination:

1. **Curator persona.** A persistent `crm-curator` SubagentRecord owned by
   `agent_default` (systemPrompt override, `toolsetIds: ["database"]`,
   `skillNames: ["people-crm"]`, `autoMemory: false`) runs every extraction
   turn, so contacts land in the same agent database the user's assistant
   queries. Turns are submitted with `submitTask(..., { mode: "chat",
   agentId, subagentId })`; the chat loop honors the pinned `Task.agentId`
   (`resolveEffectiveContext` override) so a concurrent active-agent switch
   cannot re-home a turn. Toolset scoping is what prevents tool wandering;
   the ambient Hindsight pipeline is off because the CRM database *is* this
   persona's durable memory — measured on a 2,139-message mailbox,
   auto-recall was 44.9% of turn latency (p90 113s under 16-way concurrency)
   and each auto-retain ran minutes of background embed/model calls while
   flooding the bank with 17k email-derived units. `autoMemory: false` on
   the subagent suppresses both without touching `agent_default`'s own
   ambient memory for normal chats (`AgentRecord.autoMemory` remains the
   per-agent switch).

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

## Runtime subsystem

The pipeline ships in the runtime as a per-instance controller
(`packages/runtime/src/jobs/crm-extractor.ts`) over pure pipeline logic
(`crm-extraction-pipeline.ts`), a mail-source abstraction
(`integrations/crm-mail.ts`: Gmail over REST with token mint from the
registered account's config dir, plus a fixture directory for tests/dev),
and a dedicated queue store (`state/crm-extraction-db.ts`,
`<instanceRoot>/crm-extraction.db`) tracking per-thread status
(`pending → ingested → done | skipped | error`), sender behavior aggregates,
and the persisted run state + mail cursor.

- **Multi-account.** Extraction spans EVERY connected Google account
  (deduped by email; primary first). Each mailbox has its own backfill flag
  and watcher cursor (`backfill_seeded:<accountId>` / `mail_cursor:<id>`;
  the single-account era's bare keys are adopted by the primary so existing
  pipelines never re-backfill), queue rows carry the owning account for
  fetch routing ('' = legacy → primary), and the self set spans all account
  emails — the user speaking from any of their addresses is engagement.
  Sources are re-resolved every loop pass, so an account connected while
  the pipeline runs gets its own backfill on the next iteration. Connecting
  an account never starts mailbox work on its own.
- **Loop phases.** (0) one-time backfill seed per account: full mailbox
  list → thread queue + cursor; (1) ingest: fetch+analyze pending threads, 8-way;
  (2) decide + turns: engaged-only keep/skip with the behavioral broadcast
  rule, primary-correspondent batching, 16 turn workers, 240s turn timeout
  retried once (never after a pause/disable — "nothing new dispatches" is
  the stop contract); (3) watcher: incremental list from `mail_cursor` minus
  a 60s overlap (Gmail `q=after:` — never a rescan), then idle. New mail on
  an already-done thread **reopens** it (`newest_date` grew), so the same
  convergent turns fold updates in.
- **Failure containment.** Each loop iteration is fenced: a transient source
  failure (Gmail 429/5xx, a failed token re-mint, a network blip) parks the
  loop one watcher interval and retries — it never leaves a dead loop behind
  a persisted "running" state. A turn-time failure marks only its batch
  (error + attempts bump, requeued on the next start), mirroring the
  per-thread ingest fence. A failed per-message date fetch retries once then
  fails the whole poll, so the cursor never advances past mail whose real
  date is unknown (a zero date could never satisfy the reopen predicate).
  Sender aggregates count each thread exactly once via the row's own
  `senders_counted` flag — status alone can't distinguish a first ingest
  from a reopen/requeue re-ingest, and a status-based guard would inflate
  `threads` past the broadcast threshold for legitimate correspondents.
- **Endpoints.** `GET /api/crm/extraction` (status: run state, queue counts,
  cursor, in-flight turns, self addresses, source, last error);
  `POST /api/crm/extraction/start|pause|enable|disable`. `paused` is a
  temporary halt (start resumes); `disabled` is the sticky master switch —
  start returns 400 and `enable` returns it to `idle`. Failed error rows are
  requeued on every start.
- **Lifecycle.** The onboarding profile scan may prime normalized recent
  threads for a later run, but extraction remains idle until the user chooses
  **Sync** in People (`POST /api/crm/extraction/start`). Boot reconciliation
  changes a stale `running` state to `paused`; it never resumes Gmail or model
  work after a local restart. A failed explicit start leaves the persisted
  state untouched (setup first, state flip last).
- **Self row.** Start seeds one reserved contact (`description` starting
  `You —`) carrying the connected address. The only self-address the runtime
  knows is the connected account; the skill (v1.5) instructs the curator to
  fold newly-discovered self-addresses into that row as aliases, never as
  new contacts (observed organically on the reference mailbox:
  the model recorded a second address as an alias unprompted).
- **Legacy databases migrate.** Agent databases now carry a
  `_gini_migrations` ladder (see ADR agent-database.md): the retired
  email-PK contacts shape is rebuilt into the modern id-PK schema on first
  open (values normalized toward the CHECKs, unfixable ones preserved in the
  profile text, colliding identities merged), so extraction never runs
  against a shape without the CAS trigger.

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

- Runtime carries: the seeded convergent schema with the migration ladder,
  the `autoMemory` switches (agent + subagent), the extraction controller +
  queue store + mail sources + gateway endpoints, and skill `people-crm`
  v1.5 (schema + dossier format + folding/engagement/cold-outreach/self-row
  rules).
- Extraction turns go through the chat path only — the legacy `/api/tasks`
  path dispatches no tools. Stall-aware hedging remains a harness-side
  technique (the archived reference runner in `~/gini-crm-scratch/`); the
  runtime controller uses timeout + one retry, which the convergent schema
  makes safe.
- Judgment-based rules (cold-pitch vs. contact) carry run-to-run membership
  variance of a few borderline rows; the constraints guarantee zero
  duplicates and zero malformed fields regardless.

## Acceptance checks

- `bun test packages/runtime/src/state/agent-data-db.test.ts` — seeded
  schema, CHECK rejections, CAS/trigger monotonicity, the migration ladder
  (legacy rebuild, dirty-value normalization, identity merges, rollback on
  failure), unique relations edge.
- `bun test packages/runtime/src/state/crm-extraction-db.test.ts
  packages/runtime/src/jobs/crm-extraction-pipeline.test.ts
  packages/runtime/src/jobs/crm-extractor.test.ts
  packages/runtime/src/http-crm-extraction.test.ts
  packages/runtime/src/integrations/crm-mail.test.ts` — queue semantics +
  reopen-on-new-mail, engagement/broadcast/batching rules, the full
  controller lifecycle (backfill → turns → watcher → pause/resume →
  enable/disable → local-boot pause, incremental listing pinned), the
  gateway surface, and both mail sources offline.
- `bun test packages/runtime/src/capabilities/agents.test.ts
  packages/runtime/src/execution/effective-context.test.ts
  packages/runtime/src/memory/integration.test.ts` — autoMemory storage,
  resolution, agent pinning, and end-to-end recall/retain skip.
- A bare chat turn ("who are my important contacts?") answers from
  `last_spoke_at IS NOT NULL` without touching profiles; a bare turn naming
  a watcher-era contact answers from the row the pipeline wrote.
