// Hindsight-style phase 1 — per-instance SQLite memory store (schema + scaffolding only).
//
// Gini implements the public hindsight memory model locally: four networks,
// link/entity vocabulary, and the paper's schema shape (Eq. 1, §3.1). The
// reference service uses Postgres + pgvector; this module keeps the design on
// bun:sqlite so Gini stays a single Bun binary with no external services.
//
// This module is additive in phase 1. The legacy in-state `MemoryRecord`
// store remains the source of truth for user-facing memory behavior. Phases
// 2-6 will build retain/recall/reflect/integration/migration on top of this
// schema.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Instance } from "../types";
import { instanceRoot } from "../paths";
import { id, now } from "./ids";

// Bumped to 4 for the push-device registry: adds the `devices` table used
// by src/state/devices.ts to persist iOS APNs push tokens. Lookup is keyed
// by credential_id (the paired-device id or "owner" for the runtime
// config token) so the APNs dispatcher can fan a notification out to every
// iOS install that belongs to the same human credential.
//
// Bumped to 3 for the ChatBlock protocol (ADR chat-block-protocol.md):
// adds the `chat_blocks` table used by src/state/chat-blocks.ts to
// persist runtime-emitted semantic conversation blocks (user_text,
// assistant_text, tool_call, tool_result, phase, approval_requested,
// system_note) alongside the legacy ChatMessageRecord path.
//
// Previous bump (Phase C → 2): added agent_id columns to memory_banks and
// memory_units for per-agent memory isolation. New SQLite installs add the
// columns through CREATE TABLE; existing installs add them via the additive
// migration in applyMigrations().
// Bumped to 6 for per-device chat_read_state: switches the read-state
// PK from (session_id, credential_id) to (session_id, device_token) so
// two iPhones owned by the same human (sharing one "owner" credential)
// don't share a cursor. Implemented as a copy-forward migration:
// existing v5 rows are joined against the devices table to duplicate
// each credential's cursor onto every device registered to that
// credential. Sessions owned by credentials with no registered
// devices are dropped (no devices → no badge to bias).
//
// Bumped to 7 for devices.origin: tags each push-device row with the
// network path it arrived over. Always `loopback` now — the operator's
// local browser or a device paired over the LAN.
//
// Bumped to 8 for the Cloudflare-tunnel removal: narrows the
// devices.origin CHECK to `IN ('loopback')` and purges any legacy
// non-loopback (tunnel-paired) rows on open, so a device paired over the
// removed tunnel can no longer receive pushes.
//
// Bumped to 9 for chat-block threading: adds thread_id / parent_block_id
// columns to chat_blocks so a thread is a span of blocks inside an
// agent's single session (no per-thread session). Fresh installs get the
// columns through CREATE TABLE; existing installs add them via additive
// ensureColumn calls. The (session_id, thread_id, ordinal) index covers
// thread playback; the existing UNIQUE(session_id, ordinal) is untouched.
//
// Bumped to 10 for the Chat → Topics model (ADR
// chat-topics-tasks-subagents.md): legacy threads are converted into linear
// Chat history by nulling chat_blocks.thread_id / parent_block_id once on
// upgrade from a pre-10 schema, so previously-threaded blocks read as
// main-chat in ordinal order. The idx_chat_blocks_thread index is left in
// place (later-phase cleanup). Fresh installs skip the UPDATE — their
// thread tags are already NULL.
//
// The agent-database primitive (ADR agent-database.md) intentionally lives in a
// SEPARATE per-agent SQLite file (src/state/agent-data-db.ts), NOT here — so the
// agent's own SQL can never reach memory.db. This DB stays Gini-system-only.
export const MEMORY_SCHEMA_VERSION = 10;
export const DEFAULT_BANK_ID = "bank_default";

// Builds a deterministic per-agent bank id from an agent id. Used by
// ensureAgentBank so each agent's hindsight data lives in its own bank.
export function bankIdForAgent(agentId: string): string {
  return `bank_${agentId}`;
}

export type Network = "world" | "experience" | "opinion" | "observation";
export type LinkType = "temporal" | "semantic" | "entity" | "causal";
export type CausalSubtype = "causes" | "caused_by" | "enables" | "prevents";
export type EntityType =
  | "PERSON"
  | "ORGANIZATION"
  | "LOCATION"
  | "PRODUCT"
  | "CONCEPT"
  | "OTHER";
export type MemoryUnitStatus =
  | "proposed"
  | "active"
  | "archived"
  | "rejected"
  | "conflicted";

export interface MemoryBank {
  id: string;
  // agentId is the per-agent isolation key (Phase C). NULL on legacy banks
  // that pre-date Phase C; the normalizeState migration backfills these by
  // pointing them at whoever was the active agent at migration time. The
  // ambient default bank stays untagged so legacy reads keep working.
  agentId: string | null;
  name: string;
  agentName: string | null;
  background: string | null;
  skepticism: number;
  literalism: number;
  empathy: number;
  biasStrength: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUnit {
  id: string;
  bankId: string;
  // agentId is denormalized on each unit row so recall queries can filter
  // on a single indexed column without a JOIN through memory_banks. NULL
  // only on legacy rows that the migration hasn't seen yet.
  agentId: string | null;
  text: string;
  embedding: Float32Array | null;
  embeddingDim: number | null;
  embeddingModel: string | null;
  occurredStart: string | null;
  occurredEnd: string | null;
  mentionedAt: string;
  network: Network;
  confidence: number | null;
  metadata: Record<string, unknown>;
  sourceTaskId: string | null;
  sourceSessionId: string | null;
  status: MemoryUnitStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
}

export interface Entity {
  id: string;
  bankId: string;
  canonicalName: string;
  entityType: EntityType;
  createdAt: string;
}

export interface EntityMention {
  unitId: string;
  entityId: string;
  surface: string;
}

export interface MemoryLink {
  fromUnit: string;
  toUnit: string;
  linkType: LinkType;
  weight: number;
  causalSubtype: CausalSubtype | null;
  entityId: string | null;
}

export function memoryDbPath(instance: Instance): string {
  return join(instanceRoot(instance), "memory.db");
}

// Per-instance Database handle cache. bun:sqlite handles are cheap to keep open,
// and reusing them lets prepared statements stay hot across requests within
// a single CLI/runtime process. Reset clears the entry so callers get a fresh
// handle pointing at the recreated file.
const dbCache = new Map<Instance, Database>();

export function getMemoryDb(instance: Instance): Database {
  const cached = dbCache.get(instance);
  if (cached) return cached;
  mkdirSync(instanceRoot(instance), { recursive: true });
  const db = new Database(memoryDbPath(instance), { create: true });
  // WAL gives us non-blocking reads while a writer holds the lock and is the
  // standard recommendation for SQLite under concurrent access. NORMAL sync
  // is fine for a local memory store — a hard crash would lose at most the
  // last few transactions, and the legacy JSON store remains authoritative
  // for now.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  dbCache.set(instance, db);
  return db;
}

export function closeMemoryDb(instance: Instance): void {
  const cached = dbCache.get(instance);
  if (!cached) return;
  try { cached.close(); } catch { /* already closed */ }
  dbCache.delete(instance);
}

export function closeAllMemoryDbs(): void {
  for (const instance of [...dbCache.keys()]) closeMemoryDb(instance);
}

// Removes the on-disk SQLite file (and its WAL/SHM siblings) for a instance,
// closing the cached handle first so the OS releases the descriptors. Called
// by instance reset/destroy; safe to call when the file does not exist.
export function removeMemoryDb(instance: Instance): void {
  closeMemoryDb(instance);
  const path = memoryDbPath(instance);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

// Migrations run on every open via CREATE ... IF NOT EXISTS so reopening is
// always safe. The schema_meta row records the current version for future
// rounds — phase 2+ may need data migrations rather than just additive DDL.
function applyMigrations(db: Database): void {
  // Step 1: create tables and indexes that do NOT reference agent_id.
  //
  // We MUST NOT issue CREATE INDEX ... ON memory_units(agent_id) yet:
  // on a pre-Phase-C database the agent_id column doesn't exist on the
  // existing tables, and `CREATE TABLE IF NOT EXISTS` is a no-op against
  // the existing schema (so it won't add the column either). SQLite
  // parse-validates column references in CREATE INDEX even with
  // IF NOT EXISTS, so emitting the agent_id indexes here would throw
  // "no such column: agent_id" on every v1 upgrade.
  //
  // Step 2 (ensureColumn) backfills agent_id on existing tables.
  // Step 3 emits the agent_id-referencing indexes once the column is
  // guaranteed to exist.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_banks (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      name TEXT NOT NULL,
      agent_name TEXT,
      background TEXT,
      skepticism INTEGER NOT NULL DEFAULT 3,
      literalism INTEGER NOT NULL DEFAULT 3,
      empathy INTEGER NOT NULL DEFAULT 3,
      bias_strength REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Eq. 1 (paper §3.1): a memory unit is text + provenance + temporal scope
    -- + a network label drawn from {world, experience, opinion, observation}.
    CREATE TABLE IF NOT EXISTS memory_units (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
      agent_id TEXT,
      text TEXT NOT NULL,
      embedding BLOB,
      embedding_dim INTEGER,
      embedding_model TEXT,
      occurred_start TEXT,
      occurred_end TEXT,
      mentioned_at TEXT NOT NULL,
      network TEXT NOT NULL CHECK (network IN ('world','experience','opinion','observation')),
      confidence REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_task_id TEXT,
      source_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','archived','rejected','conflicted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_units_bank ON memory_units(bank_id);
    CREATE INDEX IF NOT EXISTS idx_memory_units_network ON memory_units(bank_id, network);
    CREATE INDEX IF NOT EXISTS idx_memory_units_temporal ON memory_units(bank_id, occurred_start, occurred_end);
    CREATE INDEX IF NOT EXISTS idx_memory_units_status ON memory_units(bank_id, status);

    -- BM25 (paper Eq. 11) — FTS5 mirror of memory_units.text, kept in sync via
    -- triggers so retain/recall (phases 2-3) can run lexical queries without
    -- maintaining a parallel index. content='memory_units' makes the FTS table
    -- a contentless mirror that points back at the source rowid.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts USING fts5(
      text, content='memory_units', content_rowid='rowid', tokenize='porter'
    );

    CREATE TRIGGER IF NOT EXISTS memory_units_ai AFTER INSERT ON memory_units BEGIN
      INSERT INTO memory_units_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_units_ad AFTER DELETE ON memory_units BEGIN
      INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_units_au AFTER UPDATE ON memory_units BEGIN
      INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO memory_units_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
      canonical_name TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('PERSON','ORGANIZATION','LOCATION','PRODUCT','CONCEPT','OTHER')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_bank_name ON entities(bank_id, canonical_name);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      unit_id TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      surface TEXT NOT NULL,
      PRIMARY KEY (unit_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);

    -- Causal links share the row shape with the other link types but carry a
    -- subtype drawn from {causes, caused_by, enables, prevents} (paper Eq. 4).
    -- Including causal_subtype in the PK lets multiple causal edges between
    -- the same pair coexist (e.g. A causes B and A enables B).
    CREATE TABLE IF NOT EXISTS memory_links (
      from_unit TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      to_unit TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL CHECK (link_type IN ('temporal','semantic','entity','causal')),
      weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 1.0),
      causal_subtype TEXT CHECK (causal_subtype IN ('causes','caused_by','enables','prevents')),
      entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_unit, to_unit, link_type, causal_subtype)
    );
    CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_unit, link_type);
    CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_unit, link_type);
    CREATE INDEX IF NOT EXISTS idx_links_entity ON memory_links(entity_id) WHERE entity_id IS NOT NULL;
  `);

  // Read the version already on disk (schema_meta exists after the block
  // above) BEFORE the INSERT OR REPLACE at the end rewrites it. Used to gate
  // one-time data migrations that must NOT re-run on every open. A fresh DB
  // has no row → 0; a legacy row parses to its stored version.
  const priorVersion = Number(
    db
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("version")?.value ?? "0"
  );

  // Step 2 — Phase C additive migration: pre-Phase-C databases were created
  // without the agent_id columns on memory_banks / memory_units. Add them
  // in-place with a runtime check — SQLite has no IF NOT EXISTS on ALTER
  // TABLE ADD COLUMN, so we probe PRAGMA table_info and ALTER only when the
  // column is missing. Idempotent: a fresh DB created from the CREATE TABLE
  // above already has the column and falls through.
  ensureColumn(db, "memory_banks", "agent_id", "TEXT");
  ensureColumn(db, "memory_units", "agent_id", "TEXT");

  // Step 3 — agent_id-referencing indexes. Safe to issue now that the
  // column is guaranteed to exist on both fresh and upgraded DBs.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_banks_agent ON memory_banks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_units_agent ON memory_units(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_units_agent_network ON memory_units(agent_id, network);
  `);

  // Step 4 — chat_blocks table (schema version 3). Backs the ChatBlock
  // protocol described in ADR chat-block-protocol.md. Runtime emits one
  // row per semantic block (user_text, assistant_text streaming deltas,
  // tool_call, tool_result, phase, approval_requested, system_note); the
  // legacy ChatMessageRecord path keeps writing during the migration
  // window. `ordinal` is allocated as `MAX(ordinal) + 1` per session_id
  // inside the insert transaction so writers compete cleanly for the
  // next slot. The agent_id index covers per-agent inbox views; the
  // session+ordinal index covers ordered playback; the task_id partial
  // index covers run-detail joins without bloating ordinary rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_blocks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      agent_id TEXT,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'user_text','assistant_text','tool_call','tool_result',
        'phase','approval_requested','authorization_requested',
        'setup_requested','system_note'
      )),
      payload_json TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      thread_id TEXT,
      parent_block_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_session ON chat_blocks(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_task ON chat_blocks(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_agent ON chat_blocks(agent_id);
  `);

  // Pre-v9 installs already have a chat_blocks table without the thread
  // columns; the CREATE TABLE IF NOT EXISTS above is a no-op against them.
  // Add the columns in-place so existing rows read back as main-chat
  // (NULL thread_id). The (session_id, thread_id, ordinal) index is
  // deferred until after the columns exist, otherwise SQLite's parse-time
  // validation would reject it on the legacy shape.
  ensureColumn(db, "chat_blocks", "thread_id", "TEXT");
  ensureColumn(db, "chat_blocks", "parent_block_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_blocks_thread ON chat_blocks(session_id, thread_id, ordinal);");

  // Partial index over streaming assistant_text rows so the boot-time
  // stuck-cursor heal (healOrphanedStreamingBlocks) is O(stuck rows), not a
  // full scan of a multi-hundred-MB chat_blocks table on every gateway start.
  // The expression matches the heal's WHERE predicate exactly. SQLite supports
  // indexes on json_extract expressions; the partial WHERE keeps the index
  // tiny since streaming rows are transient and few at rest.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chat_blocks_streaming ON chat_blocks(updated_at) " +
      "WHERE kind = 'assistant_text' AND json_extract(payload_json, '$.streaming') = 1;"
  );

  // Recreate chat_blocks if its CHECK constraint predates the
  // authorization_requested / setup_requested kinds. The old single
  // approval_requested block was split into those two; the CREATE TABLE
  // IF NOT EXISTS above is a no-op on an existing table, so a db created
  // before the split keeps the stale constraint and rejects every new
  // setup_requested / authorization_requested insert at runtime.
  ensureChatBlocksKindConstraint(db);

  // Schema v10 (ADR chat-topics-tasks-subagents.md) — convert legacy threads
  // into linear Chat history by nulling the thread tags. Runs ONCE, only when
  // upgrading from a pre-10 schema (priorVersion < 10), so it can't wipe tags
  // a later phase may set. Placed after the ensureColumn / recreate paths
  // above so both leave thread tags NULL: the recreate copies thread_id /
  // parent_block_id forward, and this UPDATE then nulls those copied values.
  // Threaded blocks already share the session's one ordinal stream, so once
  // the tags are NULL they read back as main-chat in ordinal order.
  if (priorVersion < 10) {
    db.exec("UPDATE chat_blocks SET thread_id = NULL, parent_block_id = NULL;");
  }

  // Step 5 — devices table (schema version 4). Stores APNs push tokens
  // per credential so the runtime can fan an `approval_requested` block
  // out to every iOS install that belongs to the operator.
  // `credential_id` is the upstream caller's identity as resolved by
  // the http.ts owner-token bearer gate — always the literal "owner"
  // (see ADR owner-token-auth.md). Indexed on credential_id because the dispatcher's hot
  // path is "give me every device for this credential". The CHECK on
  // platform pins us to iOS for now; Step 2/3/4 are iOS-only this round.
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      token TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios')),
      bundle_id TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'loopback' CHECK (origin IN ('loopback'))
    );
    CREATE INDEX IF NOT EXISTS devices_by_credential ON devices(credential_id);
  `);
  // Pre-v7 installs already have a devices table without the origin
  // column; the CREATE TABLE IF NOT EXISTS above is a no-op against
  // them. Add the column with the same default so legacy registrations
  // retain their identity. Index creation is deferred until after the
  // column exists, otherwise SQLite's parse-time validation would
  // reject `CREATE INDEX ... ON devices(origin)` on the legacy shape.
  ensureColumn(db, "devices", "origin", "TEXT NOT NULL DEFAULT 'loopback'");
  db.exec("CREATE INDEX IF NOT EXISTS devices_by_origin ON devices(origin);");
  // Purge push-device rows paired over the removed Cloudflare tunnel. Those
  // rows carry a non-loopback origin and can survive an in-place upgrade: the
  // narrowed CHECK only governs new writes and SQLite never re-validates it
  // against existing rows. listAllDevices does not filter by origin, so the
  // dispatcher would otherwise keep fanning approval/completion pushes out to a
  // device that can no longer reach the runtime — delete them on open.
  db.exec("DELETE FROM devices WHERE origin <> 'loopback';");

  // Step 6 — chat_read_state table (schema version 6). Tracks the
  // last block id each device has acknowledged seeing on a given chat
  // session. Used to compute the iOS app's badge count and to drive
  // silent-push suppression for completion phases. Composite primary
  // key on (session_id, device_token) so two iPhones owned by the
  // same human (sharing one "owner" credential under the runtime's
  // single-tenant credential model) each track their own per-session
  // cursor.
  //
  // Upgrade from v5: the previous schema used (session_id, credential_id).
  // Under multi-device ownership those rows collapsed every device's
  // read state onto one credential cursor. The migration duplicates
  // each v5 row onto every device currently registered under the same
  // credential — the resulting v6 rows may over-report unread (a device
  // that never actually opened the session inherits a "read"
  // acknowledgement from a sibling device's cursor), but that's
  // strictly better than the v5 collapse and far better than dropping
  // every cursor and over-counting unread badges across the install
  // base on first launch.
  ensureChatReadStateDeviceTokenSchema(db);

  db.run(
    "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', ?)",
    [String(MEMORY_SCHEMA_VERSION)]
  );
}

function ensureColumn(db: Database, table: string, column: string, type: string): void {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Migration helper for the v5 → v6 chat_read_state shape change.
// Creates the device-keyed table from scratch if missing; if a v5
// (credential_id-keyed) table exists, copies each v5 row forward
// into one v6 row per registered device for that credential.
//
// Migration semantics:
//   - v5 schema: PRIMARY KEY (session_id, credential_id). One cursor
//     per credential, regardless of how many physical iPhones the
//     credential authorised. Under multi-device ownership two iPhones
//     would clobber each other's cursor.
//   - v6 schema: PRIMARY KEY (session_id, device_token). Each
//     physical iPhone tracks its own cursor.
//   - Migration: JOIN chat_read_state v5 against devices on
//     credential_id. Every device registered under credential C
//     inherits credential C's session cursors. The inherited cursor
//     may over-report "read" (a device that never opened the session
//     starts out marked-as-read up to the credential's last position),
//     but that's strictly less wrong than the v5 collapse and far
//     better than dropping all cursors and badge-spiking every
//     session as unread on first launch after upgrade.
//   - Credentials with no registered devices contribute nothing to
//     v6: no device means no badge to bias.
export function ensureChatReadStateDeviceTokenSchema(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(chat_read_state)")
    .all();
  const hasCredentialId = cols.some((c) => c.name === "credential_id");
  const hasDeviceToken = cols.some((c) => c.name === "device_token");

  if (cols.length === 0) {
    // Fresh DB — create the device-keyed table directly.
    db.exec(`
      CREATE TABLE chat_read_state (
        session_id TEXT NOT NULL,
        device_token TEXT NOT NULL,
        last_read_block_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, device_token)
      );
      CREATE INDEX chat_read_state_by_device ON chat_read_state(device_token);
    `);
    return;
  }

  if (hasDeviceToken && !hasCredentialId) {
    // Already on v6 schema (or post-v6 fresh install). No-op.
    return;
  }

  if (hasCredentialId) {
    // v5 → v6: copy v5 rows forward onto every device registered for
    // the same credential, then drop the old table. The copy uses a
    // staging table so the drop + rename pattern keeps the final
    // table name identical and indexed correctly.
    db.exec(`
      CREATE TABLE chat_read_state_v6 (
        session_id TEXT NOT NULL,
        device_token TEXT NOT NULL,
        last_read_block_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, device_token)
      );
      INSERT INTO chat_read_state_v6 (session_id, device_token, last_read_block_id, updated_at)
        SELECT cr.session_id, d.token, cr.last_read_block_id, cr.updated_at
        FROM chat_read_state cr
        JOIN devices d ON d.credential_id = cr.credential_id;
      DROP INDEX IF EXISTS chat_read_state_by_credential;
      DROP TABLE chat_read_state;
      ALTER TABLE chat_read_state_v6 RENAME TO chat_read_state;
      CREATE INDEX chat_read_state_by_device ON chat_read_state(device_token);
    `);
  }
}

// Recreate chat_blocks when its CHECK constraint predates the
// authorization_requested / setup_requested kinds. SQLite can't ALTER a
// CHECK constraint in place, so the fix is the standard staging-table
// copy-forward + drop + rename. Detection reads the table's stored DDL
// from sqlite_master: a pre-split table's CHECK omits "setup_requested",
// so its presence in the SQL is the upgrade marker. Existing rows only
// carry kinds already in the new allow-set (the old set is a strict
// subset), so the row copy can't violate the new constraint.
export function ensureChatBlocksKindConstraint(db: Database): void {
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_blocks'"
    )
    .get();
  if (!row || row.sql.includes("setup_requested")) return;
  // The copy-forward below selects thread_id / parent_block_id. A pre-split
  // table predates those columns too, so add them first — this keeps the
  // recreate self-sufficient regardless of migration call order.
  ensureColumn(db, "chat_blocks", "thread_id", "TEXT");
  ensureColumn(db, "chat_blocks", "parent_block_id", "TEXT");
  db.exec(`
    CREATE TABLE chat_blocks_v3 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      agent_id TEXT,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'user_text','assistant_text','tool_call','tool_result',
        'phase','approval_requested','authorization_requested',
        'setup_requested','system_note'
      )),
      payload_json TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      thread_id TEXT,
      parent_block_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, ordinal)
    );
    INSERT INTO chat_blocks_v3
      (id, session_id, instance, agent_id, ordinal, kind, payload_json, task_id, run_id, thread_id, parent_block_id, created_at, updated_at)
      SELECT id, session_id, instance, agent_id, ordinal, kind, payload_json, task_id, run_id, thread_id, parent_block_id, created_at, updated_at
      FROM chat_blocks;
    DROP TABLE chat_blocks;
    ALTER TABLE chat_blocks_v3 RENAME TO chat_blocks;
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_session ON chat_blocks(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_task ON chat_blocks(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_agent ON chat_blocks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_thread ON chat_blocks(session_id, thread_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_streaming ON chat_blocks(updated_at)
      WHERE kind = 'assistant_text' AND json_extract(payload_json, '$.streaming') = 1;
  `);
}

// Float32Array <-> Buffer round-trip.
//
// Quirk worth noting for phase 2: bun:sqlite returns BLOBs as a Uint8Array
// (NOT a Node Buffer) whose .buffer may have a non-zero byteOffset because
// it shares an underlying ArrayBuffer with sibling rows in the result set.
// We must slice on byteOffset/byteLength before constructing the Float32Array
// or we'll either misalign or read past the end of the row's bytes.
export function serializeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deserializeEmbedding(
  blob: Uint8Array | Buffer | null | undefined,
  dim: number | null | undefined
): Float32Array | null {
  if (!blob || !dim) return null;
  // Copy into a fresh ArrayBuffer to detach from sqlite's row-shared buffer
  // and to guarantee 4-byte alignment for Float32Array's underlying buffer.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, dim);
}

// --------------------------------------------------------------------------
// Bank helpers
// --------------------------------------------------------------------------

export function ensureDefaultBank(instance: Instance): MemoryBank {
  const db = getMemoryDb(instance);
  const existing = db
    .query<MemoryBankRow, [string]>("SELECT * FROM memory_banks WHERE id = ?")
    .get(DEFAULT_BANK_ID);
  if (existing) return rowToBank(existing);
  const at = now();
  const bank: MemoryBank = {
    id: DEFAULT_BANK_ID,
    agentId: null,
    name: "default",
    agentName: null,
    background: null,
    skepticism: 3,
    literalism: 3,
    empathy: 3,
    biasStrength: 0.5,
    createdAt: at,
    updatedAt: at
  };
  db.run(
    `INSERT INTO memory_banks
       (id, agent_id, name, agent_name, background, skepticism, literalism, empathy, bias_strength, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bank.id, bank.agentId, bank.name, bank.agentName, bank.background, bank.skepticism, bank.literalism, bank.empathy, bank.biasStrength, bank.createdAt, bank.updatedAt]
  );
  return bank;
}

// Phase C — lazy per-agent bank. Each agent owns one hindsight bank so the
// behavioural profile sliders + namespacing are agent-local. New agents get
// an empty bank on first access: config copied, content NOT — there is no
// inheritance from the default agent or any other bank.
export function ensureAgentBank(instance: Instance, agentId: string): MemoryBank {
  if (!agentId) throw new Error("ensureAgentBank: agentId is required");
  const db = getMemoryDb(instance);
  const bankId = bankIdForAgent(agentId);
  const existing = db
    .query<MemoryBankRow, [string]>("SELECT * FROM memory_banks WHERE id = ?")
    .get(bankId);
  if (existing) return rowToBank(existing);
  const at = now();
  const bank: MemoryBank = {
    id: bankId,
    agentId,
    name: agentId,
    agentName: null,
    background: null,
    skepticism: 3,
    literalism: 3,
    empathy: 3,
    biasStrength: 0.5,
    createdAt: at,
    updatedAt: at
  };
  db.run(
    `INSERT INTO memory_banks
       (id, agent_id, name, agent_name, background, skepticism, literalism, empathy, bias_strength, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bank.id, bank.agentId, bank.name, bank.agentName, bank.background, bank.skepticism, bank.literalism, bank.empathy, bank.biasStrength, bank.createdAt, bank.updatedAt]
  );
  return bank;
}

// Hard-deletes a memory bank and all of its memory_units in a single
// transaction. Returns counts so the caller can audit how much state was
// removed. Idempotent: if the bank doesn't exist, returns
// `{ unitsDeleted: 0, bankDeleted: false }`. Memory units are removed
// explicitly first even though `ON DELETE CASCADE` would cover them, so
// the returned count is exact. Triggers on memory_units also fan out to
// the FTS mirror and entity_mentions.
export function deleteBankAndUnits(
  instance: Instance,
  bankId: string
): { unitsDeleted: number; bankDeleted: boolean } {
  const db = getMemoryDb(instance);
  db.exec("BEGIN");
  try {
    const unitsBefore = db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM memory_units WHERE bank_id = ?")
      .get(bankId)?.c ?? 0;
    db.run("DELETE FROM memory_units WHERE bank_id = ?", [bankId]);
    const bankResult = db.run("DELETE FROM memory_banks WHERE id = ?", [bankId]);
    const bankDeleted = (bankResult.changes ?? 0) > 0;
    db.exec("COMMIT");
    return { unitsDeleted: unitsBefore, bankDeleted };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listBanks(instance: Instance): MemoryBank[] {
  const db = getMemoryDb(instance);
  return db
    .query<MemoryBankRow, []>("SELECT * FROM memory_banks ORDER BY created_at ASC")
    .all()
    .map(rowToBank);
}

// --------------------------------------------------------------------------
// Memory unit helpers (minimal — phase 2 will expand insertion APIs)
// --------------------------------------------------------------------------

export interface InsertMemoryUnitInput {
  bankId?: string;
  // Phase C: each unit is stamped with the active agent at write time so
  // recall can filter to a single agent's pool without joining through
  // memory_banks. Optional in the type so legacy callers / tests that don't
  // route through resolveEffectiveContext can still insert; production paths
  // (retain, reflect.persistOpinions, migrate) always supply it.
  agentId?: string | null;
  text: string;
  embedding?: Float32Array | null;
  embeddingModel?: string | null;
  occurredStart?: string | null;
  occurredEnd?: string | null;
  mentionedAt?: string;
  network: Network;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  sourceTaskId?: string | null;
  sourceSessionId?: string | null;
  status?: MemoryUnitStatus;
}

export function insertMemoryUnit(instance: Instance, input: InsertMemoryUnitInput): MemoryUnit {
  const db = getMemoryDb(instance);
  const at = now();
  const unit: MemoryUnit = {
    id: id("mu"),
    bankId: input.bankId ?? DEFAULT_BANK_ID,
    agentId: input.agentId ?? null,
    text: input.text,
    embedding: input.embedding ?? null,
    embeddingDim: input.embedding ? input.embedding.length : null,
    embeddingModel: input.embeddingModel ?? null,
    occurredStart: input.occurredStart ?? null,
    occurredEnd: input.occurredEnd ?? null,
    mentionedAt: input.mentionedAt ?? at,
    network: input.network,
    confidence: input.confidence ?? null,
    metadata: input.metadata ?? {},
    sourceTaskId: input.sourceTaskId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    status: input.status ?? "active",
    createdAt: at,
    updatedAt: at,
    lastUsedAt: null,
    usageCount: 0
  };
  db.run(
    `INSERT INTO memory_units
       (id, bank_id, agent_id, text, embedding, embedding_dim, embedding_model,
        occurred_start, occurred_end, mentioned_at, network, confidence,
        metadata, source_task_id, source_session_id, status,
        created_at, updated_at, last_used_at, usage_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      unit.id,
      unit.bankId,
      unit.agentId,
      unit.text,
      unit.embedding ? serializeEmbedding(unit.embedding) : null,
      unit.embeddingDim,
      unit.embeddingModel,
      unit.occurredStart,
      unit.occurredEnd,
      unit.mentionedAt,
      unit.network,
      unit.confidence,
      JSON.stringify(unit.metadata),
      unit.sourceTaskId,
      unit.sourceSessionId,
      unit.status,
      unit.createdAt,
      unit.updatedAt,
      unit.lastUsedAt,
      unit.usageCount
    ]
  );
  return unit;
}

export function getMemoryUnit(instance: Instance, unitId: string): MemoryUnit | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<MemoryUnitRow, [string]>("SELECT * FROM memory_units WHERE id = ?")
    .get(unitId);
  return row ? rowToUnit(row) : null;
}

// Active units in a bank, sorted by mentioned_at DESC. Optional `limit` caps
// the candidate pool — phases 2-3 use this to bound the brute-force semantic
// scan to a recent window. Optional `network` filter narrows to a single
// network (e.g. opinions only, world facts only).
export interface ListUnitsOptions {
  network?: Network | Network[];
  status?: MemoryUnitStatus | MemoryUnitStatus[];
  limit?: number;
  excludeIds?: string[];
  // Phase C agent isolation — when supplied, restricts results to units
  // owned by the agent. Optional so legacy callers / tests that haven't
  // moved to per-agent banks still work; production paths pass it through.
  agentId?: string;
}

export function listMemoryUnits(instance: Instance, bankId: string, options: ListUnitsOptions = {}): MemoryUnit[] {
  const db = getMemoryDb(instance);
  const where: string[] = ["bank_id = ?"];
  const params: (string | number | null)[] = [bankId];
  const status = options.status ?? "active";
  const statuses = Array.isArray(status) ? status : [status];
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (options.agentId) {
    where.push("agent_id = ?");
    params.push(options.agentId);
  }
  if (options.network) {
    const networks = Array.isArray(options.network) ? options.network : [options.network];
    if (networks.length > 0) {
      where.push(`network IN (${networks.map(() => "?").join(",")})`);
      params.push(...networks);
    }
  }
  if (options.excludeIds && options.excludeIds.length > 0) {
    where.push(`id NOT IN (${options.excludeIds.map(() => "?").join(",")})`);
    params.push(...options.excludeIds);
  }
  let sql = `SELECT * FROM memory_units WHERE ${where.join(" AND ")} ORDER BY mentioned_at DESC`;
  if (typeof options.limit === "number") {
    sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
  }
  return db.query<MemoryUnitRow, (string | number | null)[]>(sql).all(...params).map(rowToUnit);
}

export function recentMemoryUnitIds(instance: Instance, bankId: string, limit: number): string[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM memory_units WHERE bank_id = ? AND status = 'active' ORDER BY mentioned_at DESC LIMIT ?"
    )
    .all(bankId, limit)
    .map((row) => row.id);
}

// Returns memory units that mention a given entity, ordered most-recent
// first. Used by observation regeneration (phase 2.4) and recall.
export function unitsForEntity(instance: Instance, entityId: string, limit?: number): MemoryUnit[] {
  const db = getMemoryDb(instance);
  const sql = `SELECT mu.* FROM memory_units mu
               JOIN entity_mentions em ON em.unit_id = mu.id
               WHERE em.entity_id = ? AND mu.status = 'active'
               ORDER BY mu.mentioned_at DESC
               ${typeof limit === "number" ? `LIMIT ${Math.max(0, Math.floor(limit))}` : ""}`;
  return db.query<MemoryUnitRow, [string]>(sql).all(entityId).map(rowToUnit);
}

// Used by observation regeneration to upsert a single observation row per
// (bank, entity) pair. Implementation: archive any prior observation for the
// entity, insert the new one with metadata.entityId set.
export function upsertObservationUnit(
  instance: Instance,
  bankId: string,
  entityId: string,
  text: string,
  embedding: Float32Array | null,
  embeddingModel: string | null,
  agentId?: string | null
): MemoryUnit {
  const db = getMemoryDb(instance);
  // Archive any existing observation rows for this entity in this bank.
  db.run(
    `UPDATE memory_units SET status = 'archived', updated_at = ?
     WHERE bank_id = ? AND network = 'observation' AND status = 'active'
       AND id IN (
         SELECT mu.id FROM memory_units mu
         JOIN entity_mentions em ON em.unit_id = mu.id
         WHERE em.entity_id = ?
       )`,
    [now(), bankId, entityId]
  );
  const unit = insertMemoryUnit(instance, {
    bankId,
    agentId: agentId ?? null,
    text,
    embedding,
    embeddingModel,
    network: "observation",
    metadata: { entityId }
  });
  linkUnitToEntity(instance, unit.id, entityId, text.slice(0, 80));
  return unit;
}

export function updateMemoryUnitConfidence(
  instance: Instance,
  unitId: string,
  confidence: number | null
): void {
  const db = getMemoryDb(instance);
  db.run(
    "UPDATE memory_units SET confidence = ?, updated_at = ? WHERE id = ?",
    [confidence, now(), unitId]
  );
}

export interface UpdateUnitStatsOptions {
  status?: MemoryUnitStatus;
  lastUsedAt?: string;
  bumpUsageCount?: boolean;
}

export function updateMemoryUnitStats(
  instance: Instance,
  unitId: string,
  options: UpdateUnitStatsOptions
): void {
  const db = getMemoryDb(instance);
  const fragments: string[] = [];
  const params: (string | number | null)[] = [];
  if (options.status) {
    fragments.push("status = ?");
    params.push(options.status);
  }
  if (options.lastUsedAt) {
    fragments.push("last_used_at = ?");
    params.push(options.lastUsedAt);
  }
  if (options.bumpUsageCount) {
    fragments.push("usage_count = usage_count + 1");
  }
  if (fragments.length === 0) return;
  fragments.push("updated_at = ?");
  params.push(now());
  params.push(unitId);
  db.run(`UPDATE memory_units SET ${fragments.join(", ")} WHERE id = ?`, params);
}

export function findEntitiesByMentions(instance: Instance, unitId: string): Entity[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ id: string; bank_id: string; canonical_name: string; entity_type: EntityType; created_at: string }, [string]>(
      `SELECT e.* FROM entities e
       JOIN entity_mentions em ON em.entity_id = e.id
       WHERE em.unit_id = ?`
    )
    .all(unitId)
    .map((row) => ({
      id: row.id,
      bankId: row.bank_id,
      canonicalName: row.canonical_name,
      entityType: row.entity_type,
      createdAt: row.created_at
    }));
}

export function entityMentionsForUnit(instance: Instance, unitId: string): EntityMention[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ unit_id: string; entity_id: string; surface: string }, [string]>(
      "SELECT * FROM entity_mentions WHERE unit_id = ?"
    )
    .all(unitId)
    .map((row) => ({ unitId: row.unit_id, entityId: row.entity_id, surface: row.surface }));
}

// Listing memory links from a set of seed unit IDs (used by recall's graph
// channel). One round-trip per seed keeps the SQL simple and avoids needing
// a recursive CTE for two-hop expansion.
export function linksFromMany(instance: Instance, unitIds: string[]): MemoryLink[] {
  if (unitIds.length === 0) return [];
  const db = getMemoryDb(instance);
  const placeholders = unitIds.map(() => "?").join(",");
  return db
    .query<MemoryLinkRow, string[]>(
      `SELECT * FROM memory_links WHERE from_unit IN (${placeholders})`
    )
    .all(...unitIds)
    .map(rowToLink);
}

export function getBank(instance: Instance, bankId: string): MemoryBank | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<MemoryBankRow, [string]>("SELECT * FROM memory_banks WHERE id = ?")
    .get(bankId);
  return row ? rowToBank(row) : null;
}

export interface UpdateBankInput {
  name?: string;
  agentName?: string | null;
  background?: string | null;
  skepticism?: number;
  literalism?: number;
  empathy?: number;
  biasStrength?: number;
}

export function updateBank(instance: Instance, bankId: string, patch: UpdateBankInput): MemoryBank | null {
  const db = getMemoryDb(instance);
  const fragments: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) { fragments.push("name = ?"); params.push(patch.name); }
  if (patch.agentName !== undefined) { fragments.push("agent_name = ?"); params.push(patch.agentName); }
  if (patch.background !== undefined) { fragments.push("background = ?"); params.push(patch.background); }
  if (typeof patch.skepticism === "number") { fragments.push("skepticism = ?"); params.push(clampInt(patch.skepticism, 1, 5)); }
  if (typeof patch.literalism === "number") { fragments.push("literalism = ?"); params.push(clampInt(patch.literalism, 1, 5)); }
  if (typeof patch.empathy === "number") { fragments.push("empathy = ?"); params.push(clampInt(patch.empathy, 1, 5)); }
  if (typeof patch.biasStrength === "number") { fragments.push("bias_strength = ?"); params.push(Math.max(0, Math.min(1, patch.biasStrength))); }
  if (fragments.length === 0) return getBank(instance, bankId);
  fragments.push("updated_at = ?");
  params.push(now());
  params.push(bankId);
  db.run(`UPDATE memory_banks SET ${fragments.join(", ")} WHERE id = ?`, params);
  return getBank(instance, bankId);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function countMemoryUnits(instance: Instance): number {
  const db = getMemoryDb(instance);
  const row = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units")
    .get();
  return row?.c ?? 0;
}

export interface NetworkCounts {
  world: number;
  experience: number;
  opinion: number;
  observation: number;
}

// Per-bank histogram of embedding_model -> active unit count. Used by
// `gini embedding status` and `gini doctor` to surface model mixing — a
// bank with units across multiple models has stale vectors that semantic
// recall will skip until reembedded.
export interface EmbeddingModelCount {
  bankId: string;
  embeddingModel: string | null;
  count: number;
}

export function countUnitsByEmbeddingModel(instance: Instance, bankId?: string): EmbeddingModelCount[] {
  const db = getMemoryDb(instance);
  const rows = bankId
    ? db
        .query<{ bank_id: string; embedding_model: string | null; c: number }, [string]>(
          `SELECT bank_id, embedding_model, COUNT(*) AS c
           FROM memory_units
           WHERE status = 'active' AND bank_id = ?
           GROUP BY bank_id, embedding_model
           ORDER BY bank_id, c DESC`
        )
        .all(bankId)
    : db
        .query<{ bank_id: string; embedding_model: string | null; c: number }, []>(
          `SELECT bank_id, embedding_model, COUNT(*) AS c
           FROM memory_units
           WHERE status = 'active'
           GROUP BY bank_id, embedding_model
           ORDER BY bank_id, c DESC`
        )
        .all();
  return rows.map((row) => ({ bankId: row.bank_id, embeddingModel: row.embedding_model, count: row.c }));
}

// Update the embedding/embedding_dim/embedding_model triple for an existing
// unit. Used by the reembed CLI to swap vectors after a provider change.
// Pass null/null/null to clear (e.g. for migration). updated_at is bumped.
export function updateMemoryUnitEmbedding(
  instance: Instance,
  unitId: string,
  embedding: Float32Array | null,
  embeddingModel: string | null
): void {
  const db = getMemoryDb(instance);
  db.run(
    `UPDATE memory_units
     SET embedding = ?, embedding_dim = ?, embedding_model = ?, updated_at = ?
     WHERE id = ?`,
    [
      embedding ? serializeEmbedding(embedding) : null,
      embedding ? embedding.length : null,
      embeddingModel,
      now(),
      unitId
    ]
  );
}

export function countByNetwork(instance: Instance): NetworkCounts {
  const db = getMemoryDb(instance);
  const counts: NetworkCounts = { world: 0, experience: 0, opinion: 0, observation: 0 };
  const rows = db
    .query<{ network: Network; c: number }, []>(
      "SELECT network, COUNT(*) AS c FROM memory_units GROUP BY network"
    )
    .all();
  for (const row of rows) counts[row.network] = row.c;
  return counts;
}

// --------------------------------------------------------------------------
// Entity + link helpers
// --------------------------------------------------------------------------

export interface InsertEntityInput {
  bankId?: string;
  canonicalName: string;
  entityType: EntityType;
}

export function insertEntity(instance: Instance, input: InsertEntityInput): Entity {
  const db = getMemoryDb(instance);
  const entity: Entity = {
    id: id("ent"),
    bankId: input.bankId ?? DEFAULT_BANK_ID,
    canonicalName: input.canonicalName,
    entityType: input.entityType,
    createdAt: now()
  };
  db.run(
    `INSERT INTO entities (id, bank_id, canonical_name, entity_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [entity.id, entity.bankId, entity.canonicalName, entity.entityType, entity.createdAt]
  );
  return entity;
}

export function linkUnitToEntity(
  instance: Instance,
  unitId: string,
  entityId: string,
  surface: string
): EntityMention {
  const db = getMemoryDb(instance);
  db.run(
    `INSERT OR IGNORE INTO entity_mentions (unit_id, entity_id, surface) VALUES (?, ?, ?)`,
    [unitId, entityId, surface]
  );
  return { unitId, entityId, surface };
}

export interface InsertLinkInput {
  fromUnit: string;
  toUnit: string;
  linkType: LinkType;
  weight: number;
  causalSubtype?: CausalSubtype | null;
  entityId?: string | null;
}

export function insertLink(instance: Instance, input: InsertLinkInput): MemoryLink {
  if (input.weight < 0 || input.weight > 1) {
    throw new Error(`memory link weight must be in [0,1], got ${input.weight}`);
  }
  const link: MemoryLink = {
    fromUnit: input.fromUnit,
    toUnit: input.toUnit,
    linkType: input.linkType,
    weight: input.weight,
    causalSubtype: input.causalSubtype ?? null,
    entityId: input.entityId ?? null
  };
  const db = getMemoryDb(instance);
  db.run(
    `INSERT OR REPLACE INTO memory_links
       (from_unit, to_unit, link_type, weight, causal_subtype, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      link.fromUnit,
      link.toUnit,
      link.linkType,
      link.weight,
      link.causalSubtype,
      link.entityId,
      now()
    ]
  );
  return link;
}

export function linksFrom(instance: Instance, unitId: string, linkType?: LinkType): MemoryLink[] {
  const db = getMemoryDb(instance);
  const rows = linkType
    ? db
        .query<MemoryLinkRow, [string, string]>(
          "SELECT * FROM memory_links WHERE from_unit = ? AND link_type = ?"
        )
        .all(unitId, linkType)
    : db
        .query<MemoryLinkRow, [string]>(
          "SELECT * FROM memory_links WHERE from_unit = ?"
        )
        .all(unitId);
  return rows.map(rowToLink);
}

// --------------------------------------------------------------------------
// Row <-> object marshaling
// --------------------------------------------------------------------------

interface MemoryBankRow {
  id: string;
  agent_id: string | null;
  name: string;
  agent_name: string | null;
  background: string | null;
  skepticism: number;
  literalism: number;
  empathy: number;
  bias_strength: number;
  created_at: string;
  updated_at: string;
}

interface MemoryUnitRow {
  id: string;
  bank_id: string;
  agent_id: string | null;
  text: string;
  embedding: Uint8Array | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string;
  network: Network;
  confidence: number | null;
  metadata: string;
  source_task_id: string | null;
  source_session_id: string | null;
  status: MemoryUnitStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  usage_count: number;
}

interface MemoryLinkRow {
  from_unit: string;
  to_unit: string;
  link_type: LinkType;
  weight: number;
  causal_subtype: CausalSubtype | null;
  entity_id: string | null;
  created_at: string;
}

function rowToBank(row: MemoryBankRow): MemoryBank {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    agentName: row.agent_name,
    background: row.background,
    skepticism: row.skepticism,
    literalism: row.literalism,
    empathy: row.empathy,
    biasStrength: row.bias_strength,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToUnit(row: MemoryUnitRow): MemoryUnit {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; }
    catch { metadata = {}; }
  }
  return {
    id: row.id,
    bankId: row.bank_id,
    agentId: row.agent_id,
    text: row.text,
    embedding: deserializeEmbedding(row.embedding, row.embedding_dim),
    embeddingDim: row.embedding_dim,
    embeddingModel: row.embedding_model,
    occurredStart: row.occurred_start,
    occurredEnd: row.occurred_end,
    mentionedAt: row.mentioned_at,
    network: row.network,
    confidence: row.confidence,
    metadata,
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count
  };
}

function rowToLink(row: MemoryLinkRow): MemoryLink {
  return {
    fromUnit: row.from_unit,
    toUnit: row.to_unit,
    linkType: row.link_type,
    weight: row.weight,
    causalSubtype: row.causal_subtype,
    entityId: row.entity_id
  };
}

// Probe used by `gini doctor`. Reports ok=true even on a brand-new instance
// (the tables exist after migration); ok=false only if something breaks.
export interface MemoryDbProbe {
  ok: boolean;
  path: string;
  exists: boolean;
  schemaVersion: number | null;
  banks: number;
  memoryUnits: number;
  byNetwork: NetworkCounts;
  entities: number;
  links: number;
  error?: string;
}

export function probeMemoryDb(instance: Instance): MemoryDbProbe {
  const path = memoryDbPath(instance);
  const exists = existsSync(path);
  try {
    const db = getMemoryDb(instance);
    const versionRow = db
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("version");
    const banks = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_banks").get()?.c ?? 0;
    const memoryUnits = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units").get()?.c ?? 0;
    const entities = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM entities").get()?.c ?? 0;
    const links = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_links").get()?.c ?? 0;
    return {
      ok: true,
      path,
      exists,
      schemaVersion: versionRow ? Number(versionRow.value) : null,
      banks,
      memoryUnits,
      byNetwork: countByNetwork(instance),
      entities,
      links
    };
  } catch (error) {
    return {
      ok: false,
      path,
      exists,
      schemaVersion: null,
      banks: 0,
      memoryUnits: 0,
      byNetwork: { world: 0, experience: 0, opinion: 0, observation: 0 },
      entities: 0,
      links: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
