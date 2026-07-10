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
function contactsDdl(tableName: string, ifNotExists: boolean): string {
  return `
CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}"${tableName}" (
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
  last_spoke_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
`;
}

const MODERN_CONTACT_COLUMNS = [
  "id", "first_name", "last_name", "email_address", "company", "position",
  "url", "phone", "description", "profile", "last_spoke_at", "updated_at",
] as const;

// Trigger + index reference the new-schema columns, so they only apply to a
// contacts table that actually carries them (a fresh seed, or a legacy table
// after the migrations below have rebuilt it). An agent-recreated custom
// table that lacks `id` keeps working without them.
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

function contactsCols(db: Database): Set<string> {
  return new Set(
    db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('contacts')").all().map((c) => c.name)
  );
}

// ---------------------------------------------------------------------------
// One-time schema migrations, tracked in _gini_migrations (id → applied_at).
// Each runs at most once per database, inside its own transaction; a failure
// rolls back and surfaces (the DB is left exactly as it was). Every migration
// checks its own precondition, so on a fresh database the whole ladder records
// as applied without touching anything. The table is runtime bookkeeping —
// dbListTables hides it from the agent's schema view.
// ---------------------------------------------------------------------------

interface Migration {
  id: string;
  up: (db: Database) => void;
}

function addColumnIfMissing(db: Database, column: string, ddl: string): void {
  if (!contactsCols(db).has(column)) db.exec(ddl);
}

// The retired email-PK contacts shape (no id column) is rebuilt into the
// modern id-PK schema: rows are copied through JS so legacy values that the
// modern CHECKs would reject are normalized instead of aborting the open —
// emails lowercased, bare domains scheme-qualified, phones squeezed to
// E.164. A value that can't be normalized is moved into the profile text
// (never silently dropped) and the column set NULL. Agent-added extra
// columns are carried over. Rows that collapse onto the same identity
// (e.g. two emails differing only in case) merge instead of failing.
function rebuildLegacyContacts(db: Database): void {
  const info = db
    .query<{ name: string; type: string }, []>("SELECT name, type FROM pragma_table_info('contacts')")
    .all();
  const names = new Set(info.map((c) => c.name));
  if (names.has("id")) return; // fresh or already-modern table
  // Only rebuild what is recognizably the legacy CRM shape. A fully custom
  // id-less table the agent created is its own design — leave it alone.
  if (!names.has("email_address") || !names.has("first_name")) return;
  const modern = new Set<string>(MODERN_CONTACT_COLUMNS);
  const extras = info.filter((c) => !modern.has(c.name));
  db.exec(contactsDdl("contacts_migration_new", false));
  // The copy needs the same identity arbitration the live table gets from
  // SEED_CONTACTS_AUX (which only lands after migrations): without the
  // partial name index, two rows whose malformed emails both moved aside
  // would coexist instead of merging.
  db.exec(
    "CREATE UNIQUE INDEX contacts_migration_scratch_name ON contacts_migration_new (lower(first_name), lower(COALESCE(last_name, ''))) WHERE email_address IS NULL"
  );
  for (const extra of extras) {
    db.exec(`ALTER TABLE "contacts_migration_new" ADD COLUMN "${extra.name.replace(/"/g, '""')}" ${extra.type || "TEXT"}`);
  }
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM contacts").all();
  const targetCols = [
    ...MODERN_CONTACT_COLUMNS.filter((c) => c !== "id"),
    ...extras.map((c) => c.name),
  ];
  const placeholders = targetCols.map(() => "?").join(", ");
  const quoted = targetCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
  const insert = db.prepare(`INSERT INTO "contacts_migration_new" (${quoted}) VALUES (${placeholders})`);
  for (const row of rows) {
    const values = normalizeLegacyContact(row, extras.map((c) => c.name));
    try {
      insert.run(...(targetCols.map((c) => values[c] ?? null) as never[]));
    } catch (error) {
      if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
      mergeLegacyContact(db, values);
    }
  }
  db.exec("DROP INDEX contacts_migration_scratch_name");
  db.exec("DROP TABLE contacts");
  db.exec('ALTER TABLE "contacts_migration_new" RENAME TO contacts');
}

// Normalize one legacy row toward the modern CHECKs. Unfixable values are
// preserved as text appended to the profile, so the migration never loses
// information — it only moves it out of the constrained column.
function normalizeLegacyContact(
  row: Record<string, unknown>,
  extraCols: string[],
): Record<string, unknown> {
  const kept: string[] = [];
  const text = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };

  let email = text(row.email_address)?.toLowerCase() ?? null;
  if (email !== null && !/^.+@.+\..+$/.test(email)) {
    kept.push(`email_address: ${String(row.email_address)}`);
    email = null;
  }

  let firstName = text(row.first_name);
  if (firstName === null) {
    // The legacy shape keyed rows by email, so a nameless row still has an
    // address to derive a handle from.
    firstName = text(String(row.email_address ?? "").split("@")[0]) ?? "Unknown";
  }

  let url = text(row.url);
  if (url !== null && !/^https?:\/\//.test(url)) {
    if (/^[A-Za-z0-9][A-Za-z0-9./_-]*\.[A-Za-z]{2,}/.test(url)) {
      url = `https://${url}`;
    } else {
      kept.push(`url: ${String(row.url)}`);
      url = null;
    }
  }

  let phone = text(row.phone);
  if (phone !== null) {
    const squeezed = phone.replace(/[\s\-().]/g, "");
    if (/^\+\d{7,15}$/.test(squeezed)) {
      phone = squeezed;
    } else {
      // Digits without a country code stay text: fabricating a +1 (or any
      // prefix) would corrupt non-US numbers.
      kept.push(`phone: ${String(row.phone)}`);
      phone = null;
    }
  }

  let profile = text(row.profile);
  if (kept.length > 0) {
    const note = `[migrated] values kept from the legacy row: ${kept.join("; ")}`;
    profile = profile === null ? note : `${profile}\n\n${note}`;
  }

  const values: Record<string, unknown> = {
    first_name: firstName,
    last_name: text(row.last_name),
    email_address: email,
    company: text(row.company),
    position: text(row.position),
    url,
    phone,
    description: text(row.description),
    profile,
    last_spoke_at: typeof row.last_spoke_at === "number" ? row.last_spoke_at : null,
    updated_at: typeof row.updated_at === "number" ? row.updated_at : Date.now(),
  };
  for (const c of extraCols) values[c] = row[c] ?? null;
  return values;
}

// Two legacy rows can land on the same modern identity (same normalized email,
// or the same name once both lost their malformed emails). Merge the loser
// into the winner: fill columns the winner lacks, concatenate profiles, keep
// the freshest timestamps.
function mergeLegacyContact(db: Database, values: Record<string, unknown>): void {
  const existing = (
    values.email_address !== null
      ? db
          .query<Record<string, unknown>, [string]>(
            'SELECT * FROM "contacts_migration_new" WHERE email_address = ?'
          )
          .get(values.email_address as string)
      : db
          .query<Record<string, unknown>, [string, string]>(
            `SELECT * FROM "contacts_migration_new"
             WHERE email_address IS NULL
               AND lower(first_name) = lower(?) AND lower(COALESCE(last_name, '')) = lower(COALESCE(?, ''))`
          )
          .get(values.first_name as string, (values.last_name as string | null) ?? "")
  );
  if (!existing) throw new Error("legacy contacts merge target not found");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, incoming] of Object.entries(values)) {
    if (col === "profile" || col === "updated_at" || incoming === null) continue;
    if (existing[col] === null || existing[col] === undefined) {
      sets.push(`"${col.replace(/"/g, '""')}" = ?`);
      params.push(incoming);
    }
  }
  const mergedProfile = [existing.profile, values.profile].filter((p) => p !== null && p !== undefined).join("\n\n---\n\n");
  if (mergedProfile !== "") {
    sets.push("profile = ?");
    params.push(mergedProfile);
  }
  sets.push("updated_at = MAX(updated_at, ?)");
  params.push(values.updated_at);
  params.push(existing.id);
  db.run(
    `UPDATE "contacts_migration_new" SET ${sets.join(", ")} WHERE id = ?`,
    ...(params as never[])
  );
}

const MIGRATIONS: Migration[] = [
  {
    // Optimistic-lock token for tables created before it existed. ALTER ADD
    // COLUMN can't carry a non-constant default, so backfill separately.
    id: "0001-contacts-updated-at",
    up(db) {
      if (contactsCols(db).has("updated_at")) return;
      db.exec("ALTER TABLE contacts ADD COLUMN updated_at INTEGER");
      db.exec("UPDATE contacts SET updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE updated_at IS NULL");
    },
  },
  {
    // One-line list handle so roster queries can skip multi-KB dossiers.
    id: "0002-contacts-description",
    up(db) {
      addColumnIfMissing(db, "description", "ALTER TABLE contacts ADD COLUMN description TEXT");
    },
  },
  {
    // When the USER last ENGAGED this person (epoch ms; NULL = never):
    // wrote to them, replied in their thread, or was deliberately cc'd in.
    // Engagement is the strongest importance signal — most inbound mail is
    // one-way cold outreach — so "important contacts" queries filter on it.
    id: "0003-contacts-last-spoke-at",
    up(db) {
      addColumnIfMissing(db, "last_spoke_at", "ALTER TABLE contacts ADD COLUMN last_spoke_at INTEGER");
    },
  },
  {
    id: "0004-contacts-id-pk-rebuild",
    up: rebuildLegacyContacts,
  },
];

function runMigrations(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _gini_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    db.query<{ id: string }, []>("SELECT id FROM _gini_migrations").all().map((r) => r.id)
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.run("INSERT INTO _gini_migrations (id, applied_at) VALUES (?, ?)", [migration.id, Date.now()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`agent database migration ${migration.id} failed: ${message}`);
    }
  }
}

function seedBaselineTables(db: Database): void {
  db.exec(contactsDdl("contacts", true));
  db.exec("CREATE TABLE IF NOT EXISTS relations (a TEXT, b TEXT, kind TEXT, note TEXT)");
  runMigrations(db);
  // One row per edge. Without this, two convergent writers (a retried or
  // hedged turn racing its twin) can both insert the same relation — the
  // contacts table's UNIQUE constraints arbitrate that race but relations
  // had no equivalent. The dedupe stays an every-open guard (not a one-time
  // migration): if the agent drops the index and duplicates creep in, the
  // next open must still be able to recreate it.
  db.exec("DELETE FROM relations WHERE rowid NOT IN (SELECT MIN(rowid) FROM relations GROUP BY a, b, COALESCE(kind, ''))");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS relations_edge ON relations (a, b, COALESCE(kind, ''))");
  // The touch trigger needs id + updated_at. Migration 0004 rebuilds the
  // retired email-PK shape, so after it only an agent-recreated custom table
  // can lack them — that table runs without the trigger rather than failing
  // every open.
  const cols = contactsCols(db);
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
  // Migrations run inside transactions on open; if another process (CLI +
  // runtime on the same file) holds the write lock, wait instead of failing.
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    seedBaselineTables(db);
  } catch (error) {
    db.close();
    throw error;
  }
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
  // _gini_migrations is runtime bookkeeping, not part of the agent's schema.
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_gini_migrations' ORDER BY name"
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
