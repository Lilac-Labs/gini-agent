import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  AgentDataError,
  MAX_RESULT_ROWS,
  agentDataDbPath,
  closeAgentDataDb,
  closeAllAgentDataDbs,
  dbExecute,
  dbListTables,
  dbQuery
} from "./agent-data-db";

const ROOT = "/tmp/gini-agent-data-db-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});
afterAll(() => {
  closeAllAgentDataDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

const A = "agent_a";

describe("agent-data-db", () => {
  test("execute DDL/DML, query returns all rows, schema introspection", () => {
    const inst = "add-basic";
    dbExecute(inst, A, "CREATE TABLE people (name TEXT, company TEXT)");
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Ada", "Google"]);
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Ben", "Google"]);
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Cleo", "Stripe"]);

    const all = dbQuery(inst, A, "SELECT name FROM people WHERE company = ? ORDER BY name", ["Google"]);
    expect(all.rowCount).toBe(2);
    expect(all.columns).toEqual(["name"]);
    expect(all.rows.map((r) => r.name)).toEqual(["Ada", "Ben"]);
    expect(all.truncated).toBe(false);

    const count = dbQuery(inst, A, "SELECT COUNT(*) AS n FROM people");
    expect(count.rows[0]!.n).toBe(3);

    // Alongside the created table, every DB carries the seeded CRM baseline.
    const schema = dbListTables(inst, A);
    expect(schema.map((t) => t.name).sort()).toEqual(["contacts", "people", "relations"]);
    const people = schema.find((t) => t.name === "people")!;
    expect(people.rowCount).toBe(3);
    expect(people.columns.map((c) => c.name).sort()).toEqual(["company", "name"]);
  });

  test("seeds the baseline CRM tables on a fresh database", () => {
    const inst = "add-seed";
    const tables = dbListTables(inst, A);
    const contacts = tables.find((t) => t.name === "contacts")!;
    expect(contacts.rowCount).toBe(0);
    expect(contacts.columns.map((c) => c.name)).toEqual([
      "id", "first_name", "last_name", "email_address", "company", "position", "url", "phone", "description", "profile", "updated_at"
    ]);
    expect(tables.find((t) => t.name === "relations")!.columns.map((c) => c.name)).toEqual(["a", "b", "kind", "note"]);
    // Identity: id auto-generates, email is optional but unique when present.
    dbExecute(inst, A, "INSERT INTO contacts (first_name) VALUES ('NoEmail')");
    const row = dbQuery(inst, A, "SELECT id, email_address FROM contacts WHERE first_name = 'NoEmail'").rows[0]!;
    expect(String(row.id).length).toBe(32); // hex(randomblob(16))
    expect(row.email_address).toBeNull();
    dbExecute(inst, A, "INSERT INTO contacts (first_name, email_address) VALUES ('Ada', 'a@b.c')");
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, email_address) VALUES ('Dup', 'a@b.c')")).toThrow();
    // Normalization CHECKs: fabricated/denormalized values are rejected at write.
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, email_address) VALUES ('Fab', 'jane-doe-unknown')")).toThrow(/CHECK/i);
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, email_address) VALUES ('Up', 'Jane@X.com')")).toThrow(/CHECK/i);
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, url) VALUES ('U', 'slashy.com')")).toThrow(/CHECK/i);
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, phone) VALUES ('P', '(404) 729-4874')")).toThrow(/CHECK/i);
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name) VALUES ('  ')")).toThrow(/CHECK/i);
    dbExecute(inst, A, "INSERT INTO contacts (first_name, email_address, url, phone) VALUES ('Ok', 'ok@x.io', 'https://x.io', '+14047294874')");
    // Two email-less people with the same name collide (partial unique index);
    // the same name WITH an email doesn't.
    dbExecute(inst, A, "INSERT INTO contacts (first_name, last_name) VALUES ('Tony', NULL)");
    expect(() => dbExecute(inst, A, "INSERT INTO contacts (first_name, last_name) VALUES ('tony', NULL)")).toThrow(/UNIQUE/i);
    dbExecute(inst, A, "INSERT INTO contacts (first_name, last_name, email_address) VALUES ('Tony', NULL, 'tony@x.io')");
    // Optimistic locking: updated_at auto-bumps on UPDATE, and a stale-guarded
    // UPDATE misses (changes: 0) after another writer touched the row.
    const before = dbQuery(inst, A, "SELECT id, updated_at FROM contacts WHERE email_address = 'ok@x.io'").rows[0]! as { id: string; updated_at: number };
    // changes counts the touch trigger's inner UPDATE too — the contract is
    // 0 = stale token, >0 = applied.
    const r1 = dbExecute(inst, A, "UPDATE contacts SET company = 'X' WHERE id = ? AND updated_at = ?", [before.id, before.updated_at]);
    expect(r1.changes).toBeGreaterThanOrEqual(1);
    const after = dbQuery(inst, A, "SELECT updated_at FROM contacts WHERE id = ?", [before.id]).rows[0]! as { updated_at: number };
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    const r2 = dbExecute(inst, A, "UPDATE contacts SET company = 'Y' WHERE id = ? AND updated_at = ?", [before.id, before.updated_at]);
    expect(r2.changes).toBe(0); // stale token → no write
    // Seeding is idempotent and never clobbers data or agent-added columns.
    dbExecute(inst, A, "ALTER TABLE contacts ADD COLUMN nickname TEXT");
    dbExecute(inst, A, "UPDATE contacts SET nickname = 'Ace' WHERE email_address = 'a@b.c'");
    closeAgentDataDb(inst, A); // force a re-open → re-runs the seed
    expect(dbQuery(inst, A, "SELECT nickname FROM contacts WHERE email_address = 'a@b.c'").rows[0]!.nickname).toBe("Ace");
  });

  test("backfills legacy contacts shapes on open (retired email-PK table)", () => {
    // Simulate the retired shape (email PRIMARY KEY, no id/updated_at/
    // description) by creating the file before the runtime ever opens it.
    const inst = "add-legacy";
    const path = agentDataDbPath(inst, "agent_legacy");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE contacts (email_address TEXT PRIMARY KEY, first_name TEXT, profile TEXT)");
    raw.run("INSERT INTO contacts VALUES ('old@x.io', 'Old', 'kept')");
    // Legacy relations with a duplicate edge: the seed must dedupe (keeping
    // the oldest row) so the unique edge index can land.
    raw.exec("CREATE TABLE relations (a TEXT, b TEXT, kind TEXT, note TEXT)");
    raw.run("INSERT INTO relations VALUES ('x', 'y', 'coworker', 'first')");
    raw.run("INSERT INTO relations VALUES ('x', 'y', 'coworker', 'second')");
    raw.close();
    // First runtime open runs the seed: updated_at + description are added
    // and backfilled; the id-less shape skips the touch trigger + index
    // rather than failing the open.
    const cols = dbListTables(inst, "agent_legacy").find((t) => t.name === "contacts")!.columns.map((c) => c.name);
    expect(cols).toContain("updated_at");
    expect(cols).toContain("description");
    const row = dbQuery(inst, "agent_legacy", "SELECT * FROM contacts").rows[0]! as Record<string, unknown>;
    expect(row.profile).toBe("kept");
    expect(row.description).toBeNull();
    expect(typeof row.updated_at).toBe("number");
    // Writes still work without the trigger/index pair.
    dbExecute(inst, "agent_legacy", "UPDATE contacts SET description = 'one-liner' WHERE email_address = 'old@x.io'");
    expect(dbQuery(inst, "agent_legacy", "SELECT description FROM contacts").rows[0]!.description).toBe("one-liner");
    // Duplicate edges collapsed to the oldest row, and the edge index now
    // rejects re-inserting the same (a, b, kind).
    const edges = dbQuery(inst, "agent_legacy", "SELECT note FROM relations");
    expect(edges.rows.map((r) => r.note)).toEqual(["first"]);
    expect(() => dbExecute(inst, "agent_legacy", "INSERT INTO relations VALUES ('x', 'y', 'coworker', 'again')")).toThrow(/UNIQUE/i);
    // A different kind between the same pair is a distinct edge.
    dbExecute(inst, "agent_legacy", "INSERT INTO relations VALUES ('x', 'y', 'intro', 'ok')");
  });

  test("each agent has an isolated database file", () => {
    const inst = "add-iso";
    expect(agentDataDbPath(inst, "agent_x")).not.toBe(agentDataDbPath(inst, "agent_y"));
    dbExecute(inst, "agent_x", "CREATE TABLE secrets (v TEXT)");
    dbExecute(inst, "agent_x", "INSERT INTO secrets VALUES ('x-only')");
    // agent_y's DB doesn't see agent_x's table — only its own seeded baseline.
    expect(dbListTables(inst, "agent_y").map((t) => t.name).sort()).toEqual(["contacts", "relations"]);
    expect(() => dbQuery(inst, "agent_y", "SELECT * FROM secrets")).toThrow();
  });

  test("db_query is read-only — writes are rejected", () => {
    const inst = "add-readonly";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    expect(() => dbQuery(inst, A, "INSERT INTO t VALUES (1)")).toThrow(AgentDataError);
    expect(() => dbQuery(inst, A, "DROP TABLE t")).toThrow(AgentDataError);
    expect(() => dbQuery(inst, A, "UPDATE t SET n = 2")).toThrow(AgentDataError);
  });

  test("rejects multi-statement smuggling and sandbox-escape statements", () => {
    const inst = "add-guard";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    expect(() => dbQuery(inst, A, "SELECT 1; DROP TABLE t")).toThrow(/one SQL statement/i);
    expect(() => dbExecute(inst, A, "ATTACH DATABASE 'x.db' AS x")).toThrow(/not allowed/i);
    expect(() => dbExecute(inst, A, "DETACH DATABASE x")).toThrow(/not allowed/i);
    expect(() => dbQuery(inst, A, "SELECT load_extension('evil')")).toThrow(/not allowed/i);
    // A trailing semicolon on a single statement is fine.
    expect(dbQuery(inst, A, "SELECT 1 AS one;").rows[0]!.one).toBe(1);
  });

  test("a write smuggled behind a CTE (WITH … INSERT) is rejected by the read-only connection", () => {
    const inst = "add-cte-write";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    dbExecute(inst, A, "INSERT INTO t VALUES (1)");
    // Begins with WITH (passes the prefix regex) but mutates — must still fail.
    expect(() => dbQuery(inst, A, "WITH c(x) AS (SELECT 2) INSERT INTO t(n) SELECT x FROM c")).toThrow(AgentDataError);
    expect(dbQuery(inst, A, "SELECT COUNT(*) AS n FROM t").rows[0]!.n).toBe(1); // unchanged
  });

  test("caps result rows and flags truncation", () => {
    const inst = "add-cap";
    dbExecute(inst, A, "CREATE TABLE big (n INTEGER)");
    dbExecute(
      inst,
      A,
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${MAX_RESULT_ROWS + 50}) INSERT INTO big(n) SELECT x FROM c`
    );
    const res = dbQuery(inst, A, "SELECT n FROM big");
    expect(res.truncated).toBe(true);
    expect(res.rowCount).toBe(MAX_RESULT_ROWS);
    // The agent can still get the true total via COUNT.
    expect(dbQuery(inst, A, "SELECT COUNT(*) AS n FROM big").rows[0]!.n).toBe(MAX_RESULT_ROWS + 50);
  });

  test("relationship JOIN works (mutual-connections shape)", () => {
    const inst = "add-join";
    dbExecute(inst, A, "CREATE TABLE rel (a TEXT, b TEXT)");
    // Alice-Carol, Bob-Carol  → Carol is mutual to Alice & Bob.
    dbExecute(inst, A, "INSERT INTO rel VALUES ('Alice','Carol'),('Bob','Carol'),('Alice','Dave')");
    const mutual = dbQuery(
      inst,
      A,
      "SELECT r1.b AS who FROM rel r1 JOIN rel r2 ON r1.b = r2.b WHERE r1.a = ? AND r2.a = ?",
      ["Alice", "Bob"]
    );
    expect(mutual.rows.map((r) => r.who)).toEqual(["Carol"]);
  });
});
