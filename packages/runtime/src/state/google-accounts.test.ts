// Tests for the machine-global Google account registry persistence.
//
// HOME is pointed at a unique mkdtemp dir per test so the registry lands under
// a throwaway ~/.gini/google-accounts and never touches the developer's real
// state. The interesting branches: empty→[], add+read-back, retag,
// case-insensitive tag-uniqueness rejection, remove, corrupt-file→[].

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GoogleAccount } from "../types";
import {
  addGoogleAccount,
  getGoogleAccount,
  googleAccountsRegistryPath,
  googleAccountsRoot,
  newAccountId,
  readGoogleAccounts,
  readPrimaryGoogleAccountId,
  removeGoogleAccount,
  retagGoogleAccount,
  setPrimaryGoogleAccountId,
  writeGoogleAccounts
} from "./google-accounts";

let scratchHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-gaccts-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

function account(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    id: newAccountId(),
    tag: "personal",
    email: "me@example.com",
    configDir: "/tmp/gws-personal",
    addedAt: "2026-06-09T00:00:00.000Z",
    ...overrides
  };
}

describe("google account registry", () => {
  test("missing registry → []", () => {
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("add then read back", () => {
    const a = account();
    addGoogleAccount(a);
    expect(readGoogleAccounts()).toEqual([a]);
    expect(getGoogleAccount(a.id)).toEqual(a);
  });

  test("write lands at mode 0600 under the gini root", () => {
    addGoogleAccount(account());
    expect(googleAccountsRoot()).toBe(join(scratchHome, ".gini", "google-accounts"));
    const mode = statSync(googleAccountsRegistryPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Mode bits are only meaningful on POSIX platforms; skip on Windows.
  test.skipIf(process.platform === "win32")("root dir is 0700 (holds per-account token dirs)", () => {
    addGoogleAccount(account());
    const mode = statSync(googleAccountsRoot()).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("retag renames an existing account", () => {
    const a = account({ tag: "personal" });
    addGoogleAccount(a);
    retagGoogleAccount(a.id, "home");
    expect(getGoogleAccount(a.id)?.tag).toBe("home");
  });

  test("add rejects a duplicate tag (case-insensitive)", () => {
    addGoogleAccount(account({ tag: "Work" }));
    expect(() => addGoogleAccount(account({ tag: "work", configDir: "/tmp/gws-other" })))
      .toThrow(/unique/);
  });

  test("retag rejects colliding with another account's tag (case-insensitive)", () => {
    const a = addAndReturn(account({ tag: "personal" }));
    addGoogleAccount(account({ tag: "Work", configDir: "/tmp/gws-work" }));
    expect(() => retagGoogleAccount(a.id, "WORK")).toThrow(/unique/);
  });

  test("retag to the account's own tag (different case) is allowed", () => {
    const a = addAndReturn(account({ tag: "Work" }));
    expect(() => retagGoogleAccount(a.id, "work")).not.toThrow();
    expect(getGoogleAccount(a.id)?.tag).toBe("work");
  });

  test("re-adding the same id upserts in place", () => {
    const a = account({ tag: "personal" });
    addGoogleAccount(a);
    addGoogleAccount({ ...a, email: "new@example.com" });
    const all = readGoogleAccounts();
    expect(all).toHaveLength(1);
    expect(all[0]?.email).toBe("new@example.com");
  });

  test("remove drops the account", () => {
    const a = addAndReturn(account());
    removeGoogleAccount(a.id);
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("corrupt registry file → []", () => {
    mkdirSync(googleAccountsRoot(), { recursive: true });
    writeFileSync(googleAccountsRegistryPath(), "{ not json", "utf8");
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("writeGoogleAccounts round-trips the registry shape", () => {
    const accts = [account({ tag: "a", configDir: "/tmp/a" }), account({ tag: "b", configDir: "/tmp/b" })];
    writeGoogleAccounts(accts);
    expect(readGoogleAccounts()).toEqual(accts);
  });
});

describe("primary account id", () => {
  test("missing registry / registry without the field → undefined", () => {
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    addGoogleAccount(account());
    // A registry written before the field existed carries no primaryAccountId.
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
  });

  test("set then read back", () => {
    const a = addAndReturn(account());
    setPrimaryGoogleAccountId(a.id);
    expect(readPrimaryGoogleAccountId()).toBe(a.id);
  });

  test("set undefined clears the field", () => {
    const a = addAndReturn(account());
    setPrimaryGoogleAccountId(a.id);
    setPrimaryGoogleAccountId(undefined);
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    expect(readGoogleAccounts()).toEqual([a]);
  });

  test("account writes preserve the persisted primary", () => {
    const a = addAndReturn(account({ tag: "a", configDir: "/tmp/a" }));
    setPrimaryGoogleAccountId(a.id);
    const b = addAndReturn(account({ tag: "b", configDir: "/tmp/b" }));
    retagGoogleAccount(b.id, "c");
    writeGoogleAccounts(readGoogleAccounts());
    expect(readPrimaryGoogleAccountId()).toBe(a.id);
  });

  test("removing the primary account clears the field; removing another keeps it", () => {
    const a = addAndReturn(account({ tag: "a", configDir: "/tmp/a" }));
    const b = addAndReturn(account({ tag: "b", configDir: "/tmp/b" }));
    setPrimaryGoogleAccountId(a.id);
    removeGoogleAccount(b.id);
    expect(readPrimaryGoogleAccountId()).toBe(a.id);
    removeGoogleAccount(a.id);
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("corrupt registry / non-string field → undefined", () => {
    mkdirSync(googleAccountsRoot(), { recursive: true });
    writeFileSync(googleAccountsRegistryPath(), "{ not json", "utf8");
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    writeFileSync(googleAccountsRegistryPath(), JSON.stringify({ version: 1, accounts: [], primaryAccountId: 7 }), "utf8");
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
  });
});

function addAndReturn(a: GoogleAccount): GoogleAccount {
  addGoogleAccount(a);
  return a;
}
