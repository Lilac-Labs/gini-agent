import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  closeAllCrmExtractionDbs,
  closeCrmExtractionDb,
  crmBroadcastSenders,
  crmExtractionDbPath,
  crmQueueCounts,
  enqueueCrmThreads,
  getCrmMeta,
  getCrmRunState,
  listCrmThreads,
  markCrmThreadIngested,
  markCrmThreads,
  requeueCrmErrors,
  setCrmMeta,
  setCrmRunState,
} from "./crm-extraction-db";

const ROOT = "/tmp/gini-crm-extraction-db-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});
afterAll(() => {
  closeAllCrmExtractionDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("crm-extraction-db", () => {
  test("meta round-trips and run state defaults to idle then persists across reopen", () => {
    const inst = "crm-meta";
    expect(getCrmRunState(inst)).toBe("idle");
    expect(getCrmMeta(inst, "mail_cursor")).toBeUndefined();
    setCrmMeta(inst, "mail_cursor", "1700000000000");
    setCrmMeta(inst, "mail_cursor", "1700000005000"); // upsert wins
    setCrmRunState(inst, "running");
    closeCrmExtractionDb(inst); // simulate restart
    expect(getCrmMeta(inst, "mail_cursor")).toBe("1700000005000");
    expect(getCrmRunState(inst)).toBe("running");
    setCrmRunState(inst, "paused");
    expect(getCrmRunState(inst)).toBe("paused");
    expect(crmExtractionDbPath(inst)).toContain("crm-extraction.db");
  });

  test("enqueue is idempotent, and reopens finished threads only when newer mail arrived", () => {
    const inst = "crm-queue";
    expect(enqueueCrmThreads(inst, [
      { threadId: "t1", newestDate: 100 },
      { threadId: "t2", newestDate: 200 },
    ])).toEqual({ added: 2, reopened: 0 });
    expect(enqueueCrmThreads(inst, [{ threadId: "t1", newestDate: 100 }]))
      .toEqual({ added: 0, reopened: 0 });

    markCrmThreads(inst, ["t1"], { status: "done", taskId: "task_a" });
    // Same newest date: stays done. Newer mail: reopens for the watcher.
    expect(enqueueCrmThreads(inst, [{ threadId: "t1", newestDate: 100 }]))
      .toEqual({ added: 0, reopened: 0 });
    expect(enqueueCrmThreads(inst, [{ threadId: "t1", newestDate: 300 }]))
      .toEqual({ added: 0, reopened: 1 });
    const pending = listCrmThreads(inst, ["pending"]);
    expect(pending.map((r) => r.thread_id)).toEqual(["t1", "t2"]);
    expect(pending[0]!.task_id).toBe("task_a"); // lineage preserved
  });

  test("ingest records engagement + batching key and accumulates sender stats once", () => {
    const inst = "crm-ingest";
    enqueueCrmThreads(inst, [
      { threadId: "a", newestDate: 1 },
      { threadId: "b", newestDate: 2 },
      { threadId: "c", newestDate: 3 },
      { threadId: "d", newestDate: 4 },
    ]);
    const drip = (tid: string): void =>
      markCrmThreadIngested(inst, tid, {
        messageCount: 1,
        newestDate: 10,
        engaged: false,
        hasHuman: false,
        primarySender: "drip@vendor.com",
        chars: 500,
        senders: [{ sender: "drip@vendor.com", multiMessage: false, selfWrote: false }],
      });
    drip("a");
    drip("b");
    // Two one-way threads: not yet broadcast (needs ≥3).
    expect(crmBroadcastSenders(inst).has("drip@vendor.com")).toBe(false);
    drip("c");
    expect(crmBroadcastSenders(inst).has("drip@vendor.com")).toBe(true);
    // A real correspondent: multi-message thread the user wrote in.
    markCrmThreadIngested(inst, "d", {
      messageCount: 4,
      newestDate: 40,
      engaged: true,
      hasHuman: true,
      primarySender: "friend@x.com",
      chars: 4000,
      senders: [{ sender: "friend@x.com", multiMessage: true, selfWrote: true }],
    });
    expect(crmBroadcastSenders(inst).has("friend@x.com")).toBe(false);
    const [d] = listCrmThreads(inst, ["ingested"]).filter((r) => r.thread_id === "d");
    expect(d!.engaged).toBe(1);
    expect(d!.has_human).toBe(1);
    expect(d!.primary_sender).toBe("friend@x.com");
    expect(d!.chars).toBe(4000);
    // hasHuman persists independently of engagement: the self-to-machine
    // shape (engaged, no human) must survive to the decide phase.
    const [a] = listCrmThreads(inst, ["ingested"]).filter((r) => r.thread_id === "a");
    expect(a!.has_human).toBe(0);

    // Re-ingesting must not double-count sender stats — reopens and error
    // requeues both reset status to 'pending', so the exactly-once guard has
    // to come from the row's own counted flag, not its status. Assert the
    // RAW aggregates: broadcast membership alone is insensitive to drift.
    const rawStats = (sender: string): { threads: number; multi_threads: number; self_wrote_threads: number } => {
      const raw = new Database(crmExtractionDbPath(inst), { readonly: true });
      const row = raw
        .query<{ threads: number; multi_threads: number; self_wrote_threads: number }, [string]>(
          "SELECT threads, multi_threads, self_wrote_threads FROM sender_stats WHERE sender = ?",
        )
        .get(sender)!;
      raw.close();
      return row;
    };
    // Watcher reopen: newer mail grows the thread to 2 messages — a recount
    // would inflate BOTH threads and multi_threads, ejecting the drip sender
    // from the broadcast set (multi_threads must stay 0).
    markCrmThreads(inst, ["a"], { status: "done" });
    enqueueCrmThreads(inst, [{ threadId: "a", newestDate: 99 }]); // reopened → pending
    markCrmThreadIngested(inst, "a", {
      messageCount: 2,
      newestDate: 99,
      engaged: false,
      hasHuman: false,
      primarySender: "drip@vendor.com",
      chars: 900,
      senders: [{ sender: "drip@vendor.com", multiMessage: true, selfWrote: false }],
    });
    expect(rawStats("drip@vendor.com")).toEqual({ threads: 3, multi_threads: 0, self_wrote_threads: 0 });
    expect(crmBroadcastSenders(inst).has("drip@vendor.com")).toBe(true);
    // Error requeue: same content re-ingested — a recount would inflate
    // threads past the ≥3 broadcast threshold for a legitimate human.
    markCrmThreads(inst, ["b"], { status: "error", error: "boom" });
    expect(requeueCrmErrors(inst)).toBe(1);
    drip("b");
    expect(rawStats("drip@vendor.com")).toEqual({ threads: 3, multi_threads: 0, self_wrote_threads: 0 });
  });

  test("marking updates status/error/attempts; counts add up; errors requeue", () => {
    const inst = "crm-marks";
    enqueueCrmThreads(inst, [
      { threadId: "a", newestDate: 3 },
      { threadId: "b", newestDate: 2 },
      { threadId: "c", newestDate: 1 },
    ]);
    markCrmThreads(inst, ["a", "b"], { status: "ingested" });
    markCrmThreads(inst, ["a"], { status: "done", taskId: "task_1", bumpAttempts: true });
    markCrmThreads(inst, ["b"], { status: "error", error: "boom", bumpAttempts: true });
    markCrmThreads(inst, ["c"], { status: "skipped", error: "not engaged" });
    expect(crmQueueCounts(inst)).toEqual({ pending: 0, ingested: 0, done: 1, skipped: 1, error: 1 });
    const [errRow] = listCrmThreads(inst, ["error"]);
    expect(errRow!.attempts).toBe(1);
    expect(errRow!.error).toBe("boom");
    expect(errRow!.processed_at).toBeGreaterThan(0);
    expect(requeueCrmErrors(inst)).toBe(1);
    expect(crmQueueCounts(inst).pending).toBe(1);
    expect(requeueCrmErrors(inst)).toBe(0);
  });

  test("instances are isolated files", () => {
    enqueueCrmThreads("crm-iso-1", [{ threadId: "only-here", newestDate: 1 }]);
    expect(crmQueueCounts("crm-iso-2").pending).toBe(0);
    expect(crmExtractionDbPath("crm-iso-1")).not.toBe(crmExtractionDbPath("crm-iso-2"));
  });

  test("a queue created before the additive columns gains them with sound approximations", () => {
    const inst = "crm-prehuman";
    const path = crmExtractionDbPath(inst);
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec(`CREATE TABLE thread_queue (
      thread_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0,
      newest_date INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      engaged INTEGER NOT NULL DEFAULT 0, primary_sender TEXT,
      chars INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      task_id TEXT, error TEXT, processed_at INTEGER
    )`);
    raw.run("INSERT INTO thread_queue (thread_id, status, engaged, primary_sender) VALUES ('h1', 'ingested', 0, 'human@x.com')");
    raw.run("INSERT INTO thread_queue (thread_id, status, engaged, primary_sender) VALUES ('h2', 'ingested', 1, NULL)");
    raw.run("INSERT INTO thread_queue (thread_id, status, engaged, primary_sender) VALUES ('h3', 'ingested', 0, NULL)");
    raw.close();
    const rows = listCrmThreads(inst, ["ingested"]);
    const byId = new Map(rows.map((r) => [r.thread_id, r]));
    expect(byId.get("h1")!.has_human).toBe(1); // human sender → human
    expect(byId.get("h2")!.has_human).toBe(1); // engaged (old proxy) → human
    expect(byId.get("h3")!.has_human).toBe(0);
    // Rows that ever left 'pending' already contributed to sender_stats.
    for (const id of ["h1", "h2", "h3"]) expect(byId.get(id)!.senders_counted).toBe(1);
  });
});
