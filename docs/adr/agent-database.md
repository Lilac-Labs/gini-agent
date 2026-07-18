# ADR: Per-Agent Structured Database Primitive

- **Status:** Accepted
- **Date:** 2026-06-05
- **See also:** [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Memory](../memory.md), [Skills As Packages, Connectors As Credentials](./skills-and-connectors.md)

## Decision

Give each agent its own sandboxed SQL database it can design and query directly,
as a core primitive — "Gini knows how to use a database." It is exposed as four
tools — `db_query` (read-only SELECT/WITH), `db_execute` (one DDL/DML statement),
`db_import` (CSV/XLSX file → table), and `db_schema` (introspection) — under an
enabled-by-default `database` toolset.

Each agent's data lives in its **own SQLite file**, `~/.gini/instances/<inst>/
agent-data/<agentId>.db` (`packages/runtime/src/state/agent-data-db.ts`), entirely separate from
Gini's system databases (`memory.db`, `state.json`). The agent defines its own
schema; everything imported is TEXT until the agent reshapes it.

Use-case-specific behavior built on this primitive — a people-CRM from LinkedIn
connections, an expense log, a job-application tracker — is a **skill**, not core.
The first such skill is `skills/personal/people-crm`.

## Context

Gini's memory (Hindsight) is an associative recall engine: semantic + BM25 +
graph + temporal channels fused, reranked over the top candidates, packed into a
token budget (top-50 per channel, rerank top-25, ~2000-token pack). That is the
right shape for "what do I know about Alice?" — relevant facts, then stop.

It is the wrong shape for any question that needs **complete, exact** answers
over a set of structured records: "how many of my connections work at Google,
list them all", "total spend on travel last quarter", "which job applications are
still open". On a top-K/fuzzy/budgeted pipeline those silently undercount. The
missing capability is not "contacts" — it is the general ability to keep and
exhaustively query structured records. That generalizes across many use cases, so
it belongs in core as a primitive; the per-use-case shaping belongs in skills.

We considered a narrower structured-collections API (define/upsert/query with
fixed filter operators). Rejected: it cannot express joins or aggregates, so it
fails the relationship-graph query ("mutual connections of A and B" is a
self-join) and "group by company" — and it reinvents a query language the model
already knows. Raw SQL over a sandbox is both more general and simpler.

## Trust boundary

The agent runs its own SQL, so isolation is the safety property:

- **One file per agent.** Different agents get different database files, so agent
  SQL can never read or write another agent's data — isolation is filesystem
  level, not a WHERE clause.
- **Separate from system data.** The agent database is a distinct file from
  `memory.db`/state, so the agent's SQL cannot reach Gini's memory, chat history,
  secrets, or config.
- **No widening the sandbox.** `ATTACH`/`DETACH DATABASE` and `load_extension(`
  are rejected on both tools, so the agent can't attach `memory.db` or load
  native code to escape the file.
- **Read/write split.** `db_query` accepts only `SELECT`/`WITH` (+ read-only
  `PRAGMA table_info/table_list`); writes must go through `db_execute`, which is
  audited. Each tool runs exactly one statement (a trailing `;` is tolerated; a
  second statement is rejected), so a read can't smuggle a write.
- **No-approval, like memory.** Writes are auto (no approval gate): this is the
  agent's own private, local, recoverable data store, mirroring how auto-retain
  writes memory. The isolation above — not an approval prompt — is the boundary.
  Every call is audited (`db.query`/`db.execute`/`db.import`/`db.schema`).

## Required Now

- `packages/runtime/src/state/agent-data-db.ts`: per-(instance, agentId) cached SQLite handle
  (WAL); `dbQuery` (read-only guard + row cap `MAX_RESULT_ROWS` with a
  `truncated` flag so an unbounded SELECT can't flood context), `dbExecute`,
  `dbListTables`.
- **Schema migrations.** Every open runs a recorded migration ladder
  (`_gini_migrations` table: id → applied_at; hidden from `dbListTables`).
  Each migration runs at most once per database, inside its own transaction —
  a failure rolls back, surfaces, and is retried on the next open. The ladder
  currently backfills `updated_at`/`description`/`last_spoke_at` and rebuilds
  the retired email-PK contacts shape into the modern id-PK schema: rows are
  copied through JS so values the modern CHECKs would reject are normalized
  (emails lowercased, bare-domain urls scheme-qualified, phones squeezed to
  E.164) instead of aborting the open; unfixable values move into the profile
  text rather than being dropped; agent-added extra columns are carried over;
  rows that collapse onto one identity (same normalized email, or same name
  once malformed emails move aside) merge instead of failing. Idempotent
  guards that agent DDL could undo (baseline `CREATE IF NOT EXISTS`, the
  relations edge dedupe + unique index, the `updated_at` touch trigger) stay
  every-open, outside the ladder.
- `packages/runtime/src/data/import-table.ts`: deterministic CSV/XLSX → table loader. Domain
  agnostic — columns come from the file's own header (sanitized to snake_case,
  de-duplicated), preamble lines (`< 2` non-empty cells) are skipped (or pinned
  with `skipLines`), one file row → one table row in a transaction. Reuses the
  `xlsx` dependency for spreadsheets.
- Tools `db_query/db_execute/db_import/db_schema` in the catalog + dispatch;
  `database` toolset enabled by default and in `DEFAULT_AGENT_TOOLSETS` (existing
  default agents union it in via the historical-snapshot migration in store.ts).
- Default agent instructions point find/list/count questions at the database
  (not recall) and tell the agent to `db_import` roster files and to check
  `read_skill` for a use-case skill.

## Consequences

- Any "track a set of things and answer exactly over them" use case works with no
  new core code — only a skill (or nothing).
- The people-CRM that motivated this is now a skill (`people-crm`) layered on the
  primitive, not a hardcoded vertical.
- Hindsight stays the home for fuzzy, associative "what's this person like" color;
  the database is for exact structured query. They are complementary.

## Acceptance Checks

- `bun test packages/runtime/src/state/agent-data-db.test.ts packages/runtime/src/data/import-table.test.ts
  packages/runtime/src/execution/db-dispatch.test.ts` pass, including read-only enforcement,
  ATTACH/multi-statement rejection, per-agent file isolation, the row cap, and a
  mutual-connections JOIN.
- With the `people-crm` skill, importing a LinkedIn `Connections.csv` and asking
  in a fresh chat "how many connections work at Google? list them all" returns the
  complete set via `db_query` (verified in dogfooding) — where recall-only
  behavior returned a fuzzy partial and fell back to browser scraping.

## Future

- Optional strict-mode approval gate on `db_execute` (destructive DDL) if the
  no-approval default proves too sharp for some operators.
- A read-only `/api/agent-data/query` surface if web/mobile clients need to read
  agent tables (deliberately omitted now — the primitive is tool-only).
