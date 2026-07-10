// Per-agent structured datastore — the storage layer behind the agent-database
// primitive (ADR agent-database.md). Each agent gets its OWN SQLite file under
// the instance (agent-data/<agentId>.db), fully isolated from Gini's system
// databases (memory.db, state). The agent designs its own schema and runs its
// own SQL through the db_query / db_execute / db_import tools, so it can keep
// and exhaustively query structured records (contacts, expenses, job apps,
// reading lists, …) — the access pattern Hindsight recall deliberately can't
// serve (it is ranked/top-K/fuzzy; this is exact relational query).
//
// Isolation IS the safety boundary: a separate file per agent means agent SQL
// can never reach another agent's data, Gini's memory/state, or secrets. The
// read tool is SELECT-only and ATTACH/DETACH/load_extension are rejected so the
// sandbox can't be widened to reach those other files.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Instance } from "../types";
import { instanceRoot } from "../paths";

// Cap rows returned to the model so an unbounded SELECT can't flood the context.
// The DB query itself is exhaustive; this only bounds what is materialized back
// to the caller, who should COUNT / aggregate / paginate for larger sets.
export const MAX_RESULT_ROWS = 1000;

const cache = new Map<string, Database>();
// Separate read-only handles back db_query. Enforcing read-only at the SQLite
// connection (not just a regex) closes write vectors a prefix check can miss —
// e.g. `WITH t AS (…) INSERT …`, which begins with WITH yet mutates.
const readonlyCache = new Map<string, Database>();

function sanitizeAgentId(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe) throw new Error("Invalid agent id for data store.");
  return safe;
}

export function agentDataDbPath(instance: Instance, agentId: string): string {
  return join(instanceRoot(instance), "agent-data", `${sanitizeAgentId(agentId)}.db`);
}

// Baseline tables every agent database starts with. The people-crm skill
// documents this schema and assumes the tables exist, so its instructions can
// be pure schema + domain rules with no CREATE TABLE preamble. IF NOT EXISTS
// keeps this a no-op on databases that already carry them (including ones
// where the agent widened the schema with extra columns).
//
// Identity is a generated id, NOT email: keying contacts by email_address
// forces the model to fabricate a key ("jane.doe@unknown") for people it
// meets without an address, which then collides with the real row when the
// address surfaces later. Email stays UNIQUE (the person's primary address)
// but nullable — first_name is the only required fact about a person.
//
// The CHECKs enforce normalization at the write boundary (deterministic,
// unlike skill prose): email lowercased/trimmed and address-shaped, url
// scheme-qualified, phone E.164-shaped (+digits only). A violated CHECK
// surfaces as a db_execute error the model reads and self-corrects on its
// next call — the same recovery loop a UNIQUE violation already exercises.
//
// Concurrency: `updated_at` (epoch ms) is bumped by trigger on every UPDATE,
// so concurrent writers can do optimistic locking — UPDATE … WHERE id = ?
// AND updated_at = <value read>; changes:0 means someone wrote in between,
// re-read and re-merge. The partial unique index stops two concurrent
// INSERTs of the same email-LESS person (same name, no address yet) — the
// email UNIQUE constraint already arbitrates the addressed case.
const SEED_CONTACTS = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  first_name TEXT NOT NULL CHECK (trim(first_name) <> ''),
  last_name TEXT,
  email_address TEXT UNIQUE CHECK (
    email_address IS NULL
    OR (email_address = lower(trim(email_address)) AND email_address LIKE '%_@_%._%')
  ),
  company TEXT, position TEXT,
  url TEXT CHECK (url IS NULL OR url LIKE 'http://%' OR url LIKE 'https://%'),
  phone TEXT CHECK (
    phone IS NULL
    OR (phone GLOB '+[0-9]*' AND phone NOT GLOB '+*[^0-9]*' AND length(phone) BETWEEN 8 AND 16)
  ),
  description TEXT,
  profile TEXT,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
`;

// Trigger + index reference the new-schema columns, so they only apply to a
// contacts table that actually carries them (a fresh seed, or a legacy table
// after the updated_at backfill below). A legacy table that still lacks `id`
// (the retired email-PK shape) keeps working without them.
//
// The bump is MAX(now, old + 1), not bare now: two updates inside the same
// millisecond would otherwise leave the token unchanged, so a concurrent
// writer's stale token would still match and the optimistic-lock guard
// would miss the intervening write. old + 1 guarantees every update moves
// the token. The trigger is dropped + recreated (not IF NOT EXISTS) so
// databases seeded with an earlier trigger body pick up the fix on open.
const SEED_CONTACTS_AUX = `
CREATE UNIQUE INDEX IF NOT EXISTS contacts_name_no_email
  ON contacts (lower(first_name), lower(COALESCE(last_name, ''))) WHERE email_address IS NULL;
DROP TRIGGER IF EXISTS contacts_touch;
CREATE TRIGGER contacts_touch AFTER UPDATE ON contacts
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE contacts
    SET updated_at = MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), OLD.updated_at + 1)
    WHERE id = NEW.id;
END;
`;

function seedBaselineTables(db: Database): void {
  db.exec(SEED_CONTACTS);
  db.exec("CREATE TABLE IF NOT EXISTS relations (a TEXT, b TEXT, kind TEXT, note TEXT)");
  const cols = new Set(
    db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('contacts')").all().map((c) => c.name)
  );
  // Legacy table (pre-updated_at): add the column so optimistic locking works
  // there too. ALTER ADD COLUMN can't carry a non-constant default, so backfill.
  if (!cols.has("updated_at")) {
    db.exec("ALTER TABLE contacts ADD COLUMN updated_at INTEGER");
    db.exec("UPDATE contacts SET updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE updated_at IS NULL");
    cols.add("updated_at");
  }
  // Legacy table (pre-description): the one-line list handle that lets
  // roster-style queries skip the multi-KB profile dossiers.
  if (!cols.has("description")) {
    db.exec("ALTER TABLE contacts ADD COLUMN description TEXT");
    cols.add("description");
  }
  // The touch trigger needs id + updated_at; the retired email-PK shape has no
  // id column, so it runs without the trigger rather than failing every open.
  if (cols.has("id") && cols.has("updated_at")) {
    db.exec(SEED_CONTACTS_AUX);
  }
}

export function getAgentDataDb(instance: Instance, agentId: string): Database {
  const key = `${instance}:${agentId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  mkdirSync(join(instanceRoot(instance), "agent-data"), { recursive: true });
  const db = new Database(agentDataDbPath(instance, agentId), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  seedBaselineTables(db);
  cache.set(key, db);
  return db;
}

// A read-only connection to the same per-agent file, opened lazily after the
// write handle has created the file. Used only by dbQuery.
function getAgentDataDbReadonly(instance: Instance, agentId: string): Database {
  const key = `${instance}:${agentId}`;
  const cached = readonlyCache.get(key);
  if (cached) return cached;
  getAgentDataDb(instance, agentId); // ensure the file (and WAL) exist
  const db = new Database(agentDataDbPath(instance, agentId), { readonly: true });
  readonlyCache.set(key, db);
  return db;
}

export function closeAgentDataDb(instance: Instance, agentId: string): void {
  const key = `${instance}:${agentId}`;
  for (const map of [cache, readonlyCache]) {
    const db = map.get(key);
    if (db) {
      try { db.close(); } catch { /* already closed */ }
      map.delete(key);
    }
  }
}

export function closeAllAgentDataDbs(): void {
  for (const map of [cache, readonlyCache]) {
    // Snapshot keys first — deleting from a Map mid-iteration can skip entries.
    for (const key of [...map.keys()]) {
      const db = map.get(key);
      if (db) {
        try { db.close(); } catch { /* already closed */ }
      }
      map.delete(key);
    }
  }
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number;
}

export interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
}

export class AgentDataError extends Error {}

// Statements that would let the sandbox reach beyond its own file. Rejected on
// both query and execute regardless of read/write classification.
const ESCAPE_PATTERN = /\b(attach|detach)\s+database\b|load_extension\s*\(/i;

function assertNoEscape(sql: string): void {
  if (ESCAPE_PATTERN.test(sql)) {
    throw new AgentDataError("ATTACH/DETACH/load_extension are not allowed in the data store.");
  }
}

// True when `sql` holds more than one statement: a `;` outside any string
// literal with non-whitespace after it. Quote-aware so a literal semicolon
// (e.g. INSERT … VALUES (';')) is NOT mistaken for a separator.
function hasStatementSeparator(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inSingle) {
      if (c === "'") { if (sql[i + 1] === "'") { i++; continue; } inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (sql[i + 1] === '"') { i++; continue; } inDouble = false; }
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === ";" && sql.slice(i + 1).trim().length > 0) return true;
  }
  return false;
}

// Drop a single trailing semicolon, then reject if a real statement separator
// remains — db_query and db_execute each run ONE statement so a query can't
// smuggle a second (write) statement past the read-only gate.
function singleStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (hasStatementSeparator(trimmed)) {
    throw new AgentDataError("Only one SQL statement per call. Split multiple statements into separate calls.");
  }
  return trimmed;
}

// Read-only query. Rejects anything that isn't a SELECT / WITH / read-only
// PRAGMA so writes can only go through db_execute (which is audited).
export function dbQuery(
  instance: Instance,
  agentId: string,
  sql: string,
  params: unknown[] = []
): QueryResult {
  const stmt = singleStatement(sql);
  assertNoEscape(stmt);
  if (!/^\s*(select|with|pragma\s+table_info|pragma\s+table_list)\b/i.test(stmt)) {
    throw new AgentDataError("db_query is read-only — it accepts SELECT / WITH. Use db_execute for writes or DDL.");
  }
  // Run on the read-only connection so even a write smuggled behind a CTE
  // (WITH … INSERT) fails at the engine rather than relying on the regex.
  const db = getAgentDataDbReadonly(instance, agentId);
  let all: Array<Record<string, unknown>>;
  try {
    all = db.query(stmt).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch (error) {
    throw new AgentDataError(error instanceof Error ? error.message : String(error));
  }
  const truncated = all.length > MAX_RESULT_ROWS;
  const rows = truncated ? all.slice(0, MAX_RESULT_ROWS) : all;
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return { columns, rows, rowCount: rows.length, truncated };
}

// Execute one DDL/DML statement (CREATE/ALTER/DROP/INSERT/UPDATE/DELETE …).
export function dbExecute(
  instance: Instance,
  agentId: string,
  sql: string,
  params: unknown[] = []
): ExecuteResult {
  const stmt = singleStatement(sql);
  assertNoEscape(stmt);
  const db = getAgentDataDb(instance, agentId);
  try {
    const result = db.run(stmt, ...(params as never[]));
    return { changes: Number(result.changes ?? 0), lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
  } catch (error) {
    throw new AgentDataError(error instanceof Error ? error.message : String(error));
  }
}

// Introspection: the tables the agent has created and their columns + row
// counts, so the agent can recall what it's already tracking.
export function dbListTables(instance: Instance, agentId: string): TableInfo[] {
  const db = getAgentDataDb(instance, agentId);
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return tables.map((t) => {
    const columns = db
      .query<{ name: string; type: string }, [string]>("SELECT name, type FROM pragma_table_info(?)")
      .all(t.name)
      .map((c) => ({ name: c.name, type: c.type || "TEXT" }));
    let rowCount = 0;
    try {
      // Table name comes from sqlite_master (not user input), so the interpolation
      // is safe; bound params aren't allowed for identifiers.
      const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get();
      rowCount = row?.n ?? 0;
    } catch { /* view-like or transient — leave 0 */ }
    return { name: t.name, columns, rowCount };
  });
}
