import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { closeAllAgentDataDbs, dbExecute, dbQuery, dbListTables } from "../state/agent-data-db";
import { importTableFromFile, parseCsv } from "./import-table";

const ROOT = mkdtempSync(join(tmpdir(), "gini-import-table-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
});
afterAll(() => {
  closeAllAgentDataDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

const A = "agent_a";

function cfg(instance: string): RuntimeConfig {
  const workspaceRoot = join(ROOT, instance, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  return { instance, port: 0, token: "t", provider: { name: "echo", model: "" }, workspaceRoot, stateRoot: ROOT, logRoot: `${ROOT}/logs` };
}

// LinkedIn export: 3 preamble lines, then the header — the importer must skip
// the preamble with no LinkedIn-specific knowledge.
const LINKEDIN = `Notes:
"some preamble note"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Aisha,Khan,https://lnkd/a,,Google,Staff Engineer,05 Jun 2024
Liam,"O'Brien, Jr.",https://lnkd/l,,Google,Product Manager,01 Jan 2023
Sofia,Rossi,https://lnkd/s,sofia@x.com,Stripe,Account Executive,02 Feb 2022
`;

describe("parseCsv", () => {
  test("quoted commas, escaped quotes, CRLF, no trailing newline", () => {
    expect(parseCsv(`a,b\n1,"two, 2"\n`)[1]).toEqual(["1", "two, 2"]);
    expect(parseCsv(`x,y\r\n1,2`)).toEqual([["x", "y"], ["1", "2"]]);
    expect(parseCsv(`p\n"a""b"`)[1]).toEqual(['a"b']);
  });
});

describe("importTableFromFile", () => {
  test("skips preamble, derives snake_case columns, one row per record", async () => {
    const config = cfg("imp-linkedin");
    writeFileSync(join(config.workspaceRoot, "Connections.csv"), LINKEDIN);
    const report = await importTableFromFile(config, A, "Connections.csv", "contacts");
    expect(report.table).toBe("contacts");
    expect(report.rowsInserted).toBe(3);
    expect(report.columns).toEqual(["first_name", "last_name", "url", "email_address", "company", "position", "connected_on"]);

    // Now exhaustively queryable via SQL.
    const google = dbQuery(config.instance, A, "SELECT first_name FROM contacts WHERE company = 'Google' ORDER BY first_name");
    expect(google.rows.map((r) => r.first_name)).toEqual(["Aisha", "Liam"]);
    // Quoted comma in a field survived.
    const liam = dbQuery(config.instance, A, "SELECT last_name FROM contacts WHERE first_name = 'Liam'");
    expect(liam.rows[0]!.last_name).toBe("O'Brien, Jr.");
    // Empty email cell stored as NULL.
    const noEmail = dbQuery(config.instance, A, "SELECT COUNT(*) AS n FROM contacts WHERE email_address IS NULL");
    expect(noEmail.rows[0]!.n).toBe(2);
  });

  test("append vs recreate", async () => {
    const config = cfg("imp-recreate");
    writeFileSync(join(config.workspaceRoot, "c.csv"), LINKEDIN);
    await importTableFromFile(config, A, "c.csv", "contacts");
    // Default append doubles the rows.
    await importTableFromFile(config, A, "c.csv", "contacts");
    expect(dbQuery(config.instance, A, "SELECT COUNT(*) AS n FROM contacts").rows[0]!.n).toBe(6);
    // recreate resets it.
    const r = await importTableFromFile(config, A, "c.csv", "contacts", { recreate: true });
    expect(r.rowsInserted).toBe(3);
    expect(dbQuery(config.instance, A, "SELECT COUNT(*) AS n FROM contacts").rows[0]!.n).toBe(3);
  });

  test("generic file with simple header (no preamble) and column de-dup", async () => {
    const config = cfg("imp-generic");
    writeFileSync(join(config.workspaceRoot, "exp.csv"), "Item,Amount,Amount\nCoffee,5,5\nBooks,40,40\n");
    const report = await importTableFromFile(config, A, "exp.csv", "expenses");
    expect(report.columns).toEqual(["item", "amount", "amount_2"]); // duplicate header disambiguated
    expect(dbListTables(config.instance, A).find((t) => t.name === "expenses")?.rowCount).toBe(2);
  });

  test("sanitizes the destination table name", async () => {
    const config = cfg("imp-tname");
    writeFileSync(join(config.workspaceRoot, "x.csv"), "a,b\n1,2\n");
    const report = await importTableFromFile(config, A, "x.csv", "My Reading List!");
    expect(report.table).toBe("my_reading_list");
  });

  test("replaces an EMPTY mismatched table (the seeded contacts baseline), refuses a non-empty one", async () => {
    const config = cfg("imp-seeded");
    // The seeded `contacts` baseline (email_address PK, …, profile) doesn't
    // match the LinkedIn header shape; empty → silently replaced (covered by
    // the LinkedIn tests too). Non-empty with different columns → refuse.
    writeFileSync(join(config.workspaceRoot, "c.csv"), LINKEDIN);
    dbExecute(config.instance, A, "INSERT INTO contacts (first_name, email_address, profile) VALUES ('Kept', 'kept@x.com', 'dossier')");
    await expect(importTableFromFile(config, A, "c.csv", "contacts")).rejects.toThrow(/different columns/);
    // The existing row survived the refused import.
    expect(dbQuery(config.instance, A, "SELECT COUNT(*) AS n FROM contacts").rows[0]!.n).toBe(1);
    // recreate: true is the explicit override.
    const r = await importTableFromFile(config, A, "c.csv", "contacts", { recreate: true });
    expect(r.rowsInserted).toBe(3);
  });
});
