// Per-instance store for the CRM email-extraction pipeline: the resumable
// per-thread work queue, incremental sender-behavior stats (feeding the
// behavioral broadcast filter), and the controller's durable settings (run
// state, incremental-mail cursor, bookkeeping). Lives in its own SQLite file
// beside the other instance state so a runtime restart resumes exactly where
// the pipeline stopped. See ADR people-crm-extraction-pipeline.md.
//
// Thread lifecycle: pending → ingested → done | skipped | error.
//   pending   — known thread id, content not yet fetched/analyzed
//   ingested  — messages fetched once; engagement + primary correspondent
//               recorded; awaiting the decide/turn phase
//   done      — a curator turn processed it
//   skipped   — prefiltered (not engaged / machine-only), no model turn
//   error     — turn failed after retry; a later start() re-queues it
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { instanceRoot } from "../paths";
import type { Instance } from "../types";

export type CrmThreadStatus = "pending" | "ingested" | "done" | "skipped" | "error";
export type CrmRunState = "idle" | "running" | "paused" | "disabled";

export interface CrmQueueRow {
  thread_id: string;
  message_count: number;
  newest_date: number;
  status: CrmThreadStatus;
  engaged: number; // 0/1, meaningful once ingested
  has_human: number; // 0/1, meaningful once ingested — any non-self non-machine participant
  senders_counted: number; // 0/1 — this thread already contributed to sender_stats
  primary_sender: string | null;
  chars: number;
  attempts: number;
  task_id: string | null;
  error: string | null;
  processed_at: number | null;
}

const cache = new Map<string, Database>();

export function crmExtractionDbPath(instance: Instance): string {
  return join(instanceRoot(instance), "crm-extraction.db");
}

export function getCrmExtractionDb(instance: Instance): Database {
  const cached = cache.get(instance);
  if (cached) return cached;
  mkdirSync(instanceRoot(instance), { recursive: true });
  const db = new Database(crmExtractionDbPath(instance), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS thread_queue (
    thread_id TEXT PRIMARY KEY,
    message_count INTEGER NOT NULL DEFAULT 0,
    newest_date INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    engaged INTEGER NOT NULL DEFAULT 0,
    has_human INTEGER NOT NULL DEFAULT 0,
    senders_counted INTEGER NOT NULL DEFAULT 0,
    primary_sender TEXT,
    chars INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    task_id TEXT,
    error TEXT,
    processed_at INTEGER
  )`);
  // Queues created before these columns existed: add them and approximate.
  // has_human: a human primary sender, or engagement, was the old
  // decide-phase proxy (re-ingest refines it on reopen). senders_counted:
  // any row that was ever ingested (message_count > 0) already contributed.
  const queueCols = new Set(
    db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('thread_queue')").all().map((c) => c.name)
  );
  if (!queueCols.has("has_human")) {
    db.exec("ALTER TABLE thread_queue ADD COLUMN has_human INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE thread_queue SET has_human = CASE WHEN primary_sender IS NOT NULL OR engaged = 1 THEN 1 ELSE 0 END");
  }
  if (!queueCols.has("senders_counted")) {
    db.exec("ALTER TABLE thread_queue ADD COLUMN senders_counted INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE thread_queue SET senders_counted = CASE WHEN message_count > 0 OR status <> 'pending' THEN 1 ELSE 0 END");
  }
  // Sender behavior accumulated at ingest time; the behavioral broadcast
  // filter (≥3 threads, all single-message, user never wrote) reads these
  // aggregates so watcher increments keep the filter current without
  // re-scanning the mailbox.
  db.exec(`CREATE TABLE IF NOT EXISTS sender_stats (
    sender TEXT PRIMARY KEY,
    threads INTEGER NOT NULL DEFAULT 0,
    multi_threads INTEGER NOT NULL DEFAULT 0,
    self_wrote_threads INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  cache.set(instance, db);
  return db;
}

export function closeCrmExtractionDb(instance: Instance): void {
  cache.get(instance)?.close();
  cache.delete(instance);
}

export function closeAllCrmExtractionDbs(): void {
  for (const [key, db] of cache) {
    db.close();
    cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export function getCrmMeta(instance: Instance, key: string): string | undefined {
  const row = getCrmExtractionDb(instance)
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(key);
  return row?.value;
}

export function setCrmMeta(instance: Instance, key: string, value: string): void {
  getCrmExtractionDb(instance).run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// The desired run state survives restarts: a pipeline paused by the user
// stays paused across reboots; a running one is resumed by the boot
// reconcile; a disabled one stays off until explicitly re-enabled ("paused"
// is a temporary halt, "disabled" is the master switch — it also blocks the
// onboarding autostart). "idle" means never started.
export function getCrmRunState(instance: Instance): CrmRunState {
  const value = getCrmMeta(instance, "run_state");
  return value === "running" || value === "paused" || value === "disabled" ? value : "idle";
}

export function setCrmRunState(instance: Instance, state: CrmRunState): void {
  setCrmMeta(instance, "run_state", state);
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

// Idempotent enqueue: known threads keep their status; a finished thread
// that GREW (a newer message arrived) is reopened as pending so the watcher
// folds the new mail in.
export function enqueueCrmThreads(
  instance: Instance,
  threads: { threadId: string; newestDate: number }[],
): { added: number; reopened: number } {
  const db = getCrmExtractionDb(instance);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO thread_queue (thread_id, newest_date) VALUES (?, ?)",
  );
  const reopen = db.prepare(
    `UPDATE thread_queue SET status = 'pending', newest_date = ?, error = NULL
     WHERE thread_id = ? AND status IN ('done', 'skipped', 'error') AND newest_date < ?`,
  );
  let added = 0;
  let reopened = 0;
  const tx = db.transaction(() => {
    for (const t of threads) {
      const r = insert.run(t.threadId, t.newestDate);
      if (r.changes > 0) {
        added += 1;
        continue;
      }
      const u = reopen.run(t.newestDate, t.threadId, t.newestDate);
      if (u.changes > 0) reopened += 1;
    }
  });
  tx();
  return { added, reopened };
}

export function listCrmThreads(instance: Instance, statuses: CrmThreadStatus[], limit?: number): CrmQueueRow[] {
  const placeholders = statuses.map(() => "?").join(",");
  return getCrmExtractionDb(instance)
    .query<CrmQueueRow, (string | number)[]>(
      `SELECT * FROM thread_queue WHERE status IN (${placeholders}) ORDER BY newest_date DESC${limit ? ` LIMIT ${Math.floor(limit)}` : ""}`,
    )
    .all(...statuses);
}

// Ingest outcome for one thread: content fetched, engagement + batching key
// recorded. Also folds the thread's senders into sender_stats exactly once
// per thread, tracked by the row's senders_counted flag — reopens and error
// requeues reset status back to 'pending', so status alone cannot tell a
// first ingest from a re-ingest (an earlier status-based guard silently
// double-counted, inflating `threads` past the broadcast threshold for
// legitimate correspondents).
export function markCrmThreadIngested(
  instance: Instance,
  threadId: string,
  info: {
    messageCount: number;
    newestDate: number;
    engaged: boolean;
    hasHuman: boolean;
    primarySender: string | null;
    chars: number;
    senders: { sender: string; multiMessage: boolean; selfWrote: boolean }[];
  },
): void {
  const db = getCrmExtractionDb(instance);
  const wasCounted = db
    .query<{ senders_counted: number }, [string]>("SELECT senders_counted FROM thread_queue WHERE thread_id = ?")
    .get(threadId);
  const tx = db.transaction(() => {
    db.run(
      `UPDATE thread_queue SET status = 'ingested', message_count = ?, newest_date = ?, engaged = ?,
        has_human = ?, senders_counted = 1, primary_sender = ?, chars = ? WHERE thread_id = ?`,
      [info.messageCount, info.newestDate, info.engaged ? 1 : 0, info.hasHuman ? 1 : 0, info.primarySender, info.chars, threadId],
    );
    // Sender aggregates: only the first ingest of a thread contributes —
    // refining a reopened thread's counts is not worth the bookkeeping (the
    // broadcast filter needs shape, not precision).
    if (wasCounted?.senders_counted === 0) {
      for (const s of info.senders) {
        db.run(
          `INSERT INTO sender_stats (sender, threads, multi_threads, self_wrote_threads) VALUES (?, 1, ?, ?)
           ON CONFLICT(sender) DO UPDATE SET
             threads = threads + 1,
             multi_threads = multi_threads + excluded.multi_threads,
             self_wrote_threads = self_wrote_threads + excluded.self_wrote_threads`,
          [s.sender, s.multiMessage ? 1 : 0, s.selfWrote ? 1 : 0],
        );
      }
    }
  });
  tx();
}

export function markCrmThreads(
  instance: Instance,
  threadIds: string[],
  update: { status: CrmThreadStatus; taskId?: string | null; error?: string | null; bumpAttempts?: boolean },
): void {
  const db = getCrmExtractionDb(instance);
  const stmt = db.prepare(
    `UPDATE thread_queue SET status = ?, task_id = COALESCE(?, task_id), error = ?,
       processed_at = ?, attempts = attempts + ? WHERE thread_id = ?`,
  );
  const at = Date.now();
  const tx = db.transaction(() => {
    for (const id of threadIds) {
      stmt.run(update.status, update.taskId ?? null, update.error ?? null, at, update.bumpAttempts ? 1 : 0, id);
    }
  });
  tx();
}

export interface CrmQueueCounts {
  pending: number;
  ingested: number;
  done: number;
  skipped: number;
  error: number;
}

export function crmQueueCounts(instance: Instance): CrmQueueCounts {
  const rows = getCrmExtractionDb(instance)
    .query<{ status: CrmThreadStatus; n: number }, []>(
      "SELECT status, COUNT(*) AS n FROM thread_queue GROUP BY status",
    )
    .all();
  const counts: CrmQueueCounts = { pending: 0, ingested: 0, done: 0, skipped: 0, error: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

// The behavioral broadcast set from accumulated sender behavior: ≥3 threads,
// every one single-message, the user never wrote in any of them.
export function crmBroadcastSenders(instance: Instance): Set<string> {
  const rows = getCrmExtractionDb(instance)
    .query<{ sender: string }, []>(
      `SELECT sender FROM sender_stats
       WHERE threads >= 3 AND multi_threads = 0 AND self_wrote_threads = 0`,
    )
    .all();
  return new Set(rows.map((r) => r.sender));
}

// Boot/start recovery: error rows get another chance; nothing is ever stuck
// in a half-processed state because 'ingested' is re-decided every drain and
// curator turns are convergent (see ADR people-crm-extraction-pipeline.md).
export function requeueCrmErrors(instance: Instance): number {
  const r = getCrmExtractionDb(instance).run(
    "UPDATE thread_queue SET status = 'pending', error = NULL WHERE status = 'error'",
  );
  return r.changes;
}
