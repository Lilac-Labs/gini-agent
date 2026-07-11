// Tests for per-instance Google account binding state. The machine-global
// credential registry is covered by google-accounts.test.ts; this file only
// verifies instance-local sign-in metadata.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GoogleAccount } from "../types";
import {
  attachGoogleAccountToInstance,
  getGoogleAccountBindings,
  googleAccountBindingsPath,
  signOutGoogleAccountsForInstance
} from "./google-account-bindings";

let scratchRoot: string;
let prevStateRoot: string | undefined;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "gini-gacct-bindings-"));
  prevStateRoot = process.env.GINI_STATE_ROOT;
  process.env.GINI_STATE_ROOT = scratchRoot;
});

afterEach(() => {
  if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevStateRoot;
  rmSync(scratchRoot, { recursive: true, force: true });
});

const account = (id: string, email: string): GoogleAccount => ({
  id,
  tag: email.split("@")[0]!,
  email,
  configDir: `/tmp/${id}`,
  addedAt: "2026-07-10T00:00:00.000Z",
  principal: `sub-${id}`,
  provisioned: true
});

describe("google account bindings", () => {
  test("missing bindings read as an empty per-instance state", () => {
    expect(getGoogleAccountBindings("a")).toEqual({ version: 1, attachedAccountIds: [], accounts: {} });
  });

  test("attaching a primary account is scoped to one instance", () => {
    attachGoogleAccountToInstance("a", account("gacct_a", "a@example.com"), { primary: true });

    expect(getGoogleAccountBindings("a").primaryAccountId).toBe("gacct_a");
    expect(getGoogleAccountBindings("a").attachedAccountIds).toEqual(["gacct_a"]);
    expect(getGoogleAccountBindings("b").primaryAccountId).toBeUndefined();
    expect(statSync(googleAccountBindingsPath("a")).isFile()).toBe(true);
  });

  test("sign out clears active bindings but keeps non-secret history", () => {
    attachGoogleAccountToInstance("a", account("gacct_a", "a@example.com"), { primary: true });
    signOutGoogleAccountsForInstance("a");

    const bindings = getGoogleAccountBindings("a");
    expect(bindings.primaryAccountId).toBeUndefined();
    expect(bindings.attachedAccountIds).toEqual([]);
    expect(bindings.accounts.gacct_a?.email).toBe("a@example.com");
    expect(bindings.accounts.gacct_a?.lastSignedOutAt).toBeDefined();
  });
});
