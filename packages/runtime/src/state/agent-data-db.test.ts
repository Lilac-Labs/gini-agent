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
      "id", "first_name", "last_name", "email_address", "company", "position", "url", "phone", "description", "profile", "last_spoke_at", "updated_at"
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

  test("migrates the retired email-PK contacts shape to the modern schema on open", () => {
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
    // First runtime open runs the migration ladder: the table is rebuilt to
    // the modern id-PK shape with the data carried over.
    const cols = dbListTables(inst, "agent_legacy").find((t) => t.name === "contacts")!.columns.map((c) => c.name);
    expect(cols).toEqual([
      "id", "first_name", "last_name", "email_address", "company", "position", "url", "phone", "description", "profile", "last_spoke_at", "updated_at"
    ]);
    const row = dbQuery(inst, "agent_legacy", "SELECT * FROM contacts").rows[0]! as Record<string, unknown>;
    expect(String(row.id).length).toBe(32);
    expect(row.email_address).toBe("old@x.io");
    expect(row.profile).toBe("kept");
    expect(row.description).toBeNull();
    expect(typeof row.updated_at).toBe("number");
    // The rebuilt table has the full modern write contract: CAS trigger…
    const before = row as { id: string; updated_at: number };
    dbExecute(inst, "agent_legacy", "UPDATE contacts SET description = 'one-liner' WHERE id = ? AND updated_at = ?", [before.id, before.updated_at]);
    const after = dbQuery(inst, "agent_legacy", "SELECT description, updated_at FROM contacts WHERE id = ?", [before.id]).rows[0]! as { description: string; updated_at: number };
    expect(after.description).toBe("one-liner");
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    const stale = dbExecute(inst, "agent_legacy", "UPDATE contacts SET description = 'x' WHERE id = ? AND updated_at = ?", [before.id, before.updated_at]);
    expect(stale.changes).toBe(0);
    // …and the modern CHECKs.
    expect(() => dbExecute(inst, "agent_legacy", "INSERT INTO contacts (first_name, email_address) VALUES ('Up', 'Case@X.io')")).toThrow(/CHECK/i);
    // Duplicate edges collapsed to the oldest row, and the edge index now
    // rejects re-inserting the same (a, b, kind).
    const edges = dbQuery(inst, "agent_legacy", "SELECT note FROM relations");
    expect(edges.rows.map((r) => r.note)).toEqual(["first"]);
    expect(() => dbExecute(inst, "agent_legacy", "INSERT INTO relations VALUES ('x', 'y', 'coworker', 'again')")).toThrow(/UNIQUE/i);
    // A different kind between the same pair is a distinct edge.
    dbExecute(inst, "agent_legacy", "INSERT INTO relations VALUES ('x', 'y', 'intro', 'ok')");
    // Migrations are recorded and run once: a re-open keeps the same row ids
    // (a second rebuild would have regenerated them).
    closeAgentDataDb(inst, "agent_legacy");
    const again = dbQuery(inst, "agent_legacy", "SELECT id FROM contacts WHERE email_address = 'old@x.io'").rows[0]! as { id: string };
    expect(again.id).toBe(before.id);
    const applied = dbQuery(inst, "agent_legacy", "SELECT id FROM _gini_migrations ORDER BY id");
    expect(applied.rows.map((r) => r.id)).toEqual([
      "0001-contacts-updated-at",
      "0002-contacts-description",
      "0003-contacts-last-spoke-at",
      "0004-contacts-id-pk-rebuild",
    ]);
    // Bookkeeping stays out of the agent's schema view.
    expect(dbListTables(inst, "agent_legacy").map((t) => t.name)).not.toContain("_gini_migrations");
  });

  test("legacy rebuild normalizes values the modern CHECKs would reject, preserving what it can't", () => {
    const inst = "add-legacy-dirty";
    const path = agentDataDbPath(inst, "agent_dirty");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    // updated_at already exists here (mid-generation shape) with a NULL to
    // exercise the timestamp fallback; nickname is an agent-added column
    // that must survive the rebuild.
    raw.exec("CREATE TABLE contacts (email_address TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, position TEXT, url TEXT, phone TEXT, profile TEXT, updated_at INTEGER, nickname TEXT)");
    const ins = raw.prepare("INSERT INTO contacts (email_address, first_name, url, phone, profile, updated_at, nickname) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run("Mixed.Case@X.io", "Ada", "x.io/me", "+1 (404) 729-4874", "p1", 1_000, "Ace");
    ins.run("not-an-email", "Ben", "not a url!", "(404) 729-4874", null, null, null);
    ins.run("", "", null, null, null, 2_000, null);
    raw.close();
    const rows = dbQuery(inst, "agent_dirty", "SELECT * FROM contacts ORDER BY first_name").rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    const [ada, ben, unknown] = rows as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    // Mechanical normalization: email lowercased, bare domain scheme-qualified,
    // phone squeezed to E.164; agent column carried over; timestamp kept.
    expect(ada.email_address).toBe("mixed.case@x.io");
    expect(ada.url).toBe("https://x.io/me");
    expect(ada.phone).toBe("+14047294874");
    expect(ada.nickname).toBe("Ace");
    expect(ada.updated_at).toBe(1_000);
    expect(ada.profile).toBe("p1");
    // Unfixable values move into the profile instead of being dropped: a
    // non-address email, a non-URL, a phone without a country code.
    expect(ben.email_address).toBeNull();
    expect(ben.url).toBeNull();
    expect(ben.phone).toBeNull();
    expect(String(ben.profile)).toContain("email_address: not-an-email");
    expect(String(ben.profile)).toContain("url: not a url!");
    expect(String(ben.profile)).toContain("phone: (404) 729-4874");
    expect(typeof ben.updated_at).toBe("number"); // NULL timestamp backfilled
    // A row with neither name nor usable email still lands (NOT NULL CHECK).
    expect(unknown.first_name).toBe("Unknown");
    expect(unknown.email_address).toBeNull();
    expect(unknown.updated_at).toBe(2_000);
  });

  test("legacy rows that collapse onto one identity merge instead of failing the rebuild", () => {
    const inst = "add-legacy-merge";
    const path = agentDataDbPath(inst, "agent_merge");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE contacts (email_address TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, profile TEXT)");
    // Same address in different case → same modern identity (email UNIQUE).
    raw.run("INSERT INTO contacts VALUES ('dup@x.io', 'Dup', NULL, NULL, 'first profile')");
    raw.run("INSERT INTO contacts VALUES ('DUP@x.io', 'Dup', NULL, 'Acme', 'second profile')");
    // Two malformed emails with the same name → same identity once both
    // emails move aside (partial unique name index).
    raw.run("INSERT INTO contacts VALUES ('bad-one', 'Sam', 'Lee', NULL, NULL)");
    raw.run("INSERT INTO contacts VALUES ('bad-two', 'sam', 'lee', 'Corp', NULL)");
    raw.close();
    const rows = dbQuery(inst, "agent_merge", "SELECT * FROM contacts ORDER BY first_name").rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    const dup = rows.find((r) => r.email_address === "dup@x.io")!;
    // The merge filled the missing company and concatenated both profiles.
    expect(dup.company).toBe("Acme");
    expect(String(dup.profile)).toContain("first profile");
    expect(String(dup.profile)).toContain("second profile");
    const sam = rows.find((r) => r.email_address === null)!;
    expect(sam.company).toBe("Corp");
    expect(String(sam.profile)).toContain("email_address: bad-one");
    expect(String(sam.profile)).toContain("email_address: bad-two");
  });

  test("an id-less table that is not the legacy CRM shape is left alone", () => {
    const inst = "add-legacy-custom";
    const path = agentDataDbPath(inst, "agent_custom");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE contacts (handle TEXT, score INTEGER)");
    raw.run("INSERT INTO contacts VALUES ('ada', 7)");
    raw.close();
    // The rebuild only recognizes the retired email-PK shape; a custom table
    // the agent designed keeps its own schema (plus the additive columns).
    const row = dbQuery(inst, "agent_custom", "SELECT * FROM contacts").rows[0]! as Record<string, unknown>;
    expect(row.handle).toBe("ada");
    expect(row.score).toBe(7);
    const cols = dbListTables(inst, "agent_custom").find((t) => t.name === "contacts")!.columns.map((c) => c.name);
    expect(cols).not.toContain("id");
    expect(cols).toContain("updated_at"); // additive migrations still apply
  });

  test("a failing migration rolls back and surfaces instead of half-applying", () => {
    const inst = "add-legacy-fail";
    const path = agentDataDbPath(inst, "agent_fail");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE contacts (email_address TEXT PRIMARY KEY, first_name TEXT, profile TEXT)");
    raw.run("INSERT INTO contacts VALUES ('a@x.io', 'Ada', NULL)");
    // The rebuild's scratch table already exists → CREATE TABLE fails inside
    // the migration transaction.
    raw.exec("CREATE TABLE contacts_migration_new (blocker TEXT)");
    raw.close();
    expect(() => dbQuery(inst, "agent_fail", "SELECT 1")).toThrow(/migration 0004-contacts-id-pk-rebuild failed/);
    // Nothing half-applied: the legacy table is intact and the failed
    // migration is not recorded, so removing the blocker lets it complete.
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
    const recorded = check.query<{ id: string }, []>("SELECT id FROM _gini_migrations").all().map((r) => r.id);
    expect(recorded).not.toContain("0004-contacts-id-pk-rebuild");
    check.close();
    const fix = new Database(path);
    fix.exec("DROP TABLE contacts_migration_new");
    fix.close();
    const healed = dbQuery(inst, "agent_fail", "SELECT id, email_address FROM contacts").rows[0]! as Record<string, unknown>;
    expect(healed.email_address).toBe("a@x.io");
    expect(String(healed.id).length).toBe(32);
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
    // Quote-awareness both ways: a `;` inside a single-quoted literal or a
    // double-quoted identifier (with escaped quotes) is NOT a separator.
    expect(dbQuery(inst, A, "SELECT ';' AS v").rows[0]!.v).toBe(";");
    expect(dbQuery(inst, A, 'SELECT 1 AS "a;""b"').columns).toEqual(['a;"b']);
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
