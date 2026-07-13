// Tests for the per-account Gmail label-profile store
// (src/state/google-label-profiles.ts): roundtrip under the account's config
// dir, and the never-throw read (missing, corrupt, and wrong-shape files all
// degrade to "no profile"). Hermetic: HOME points at a per-test scratch dir
// so the machine-global google-accounts root never touches the developer
// machine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { labelProfilePath, readLabelProfile, writeLabelProfile, type GoogleLabelProfile } from "./google-label-profiles";
import { configDirForAccount } from "./google-accounts";

describe("google label profiles", () => {
  let root: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.HOME;
    root = `/tmp/gini-label-profile-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    process.env.HOME = root;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });

  test("writes into the account's config dir and reads the same record back", () => {
    const profile: GoogleLabelProfile = {
      version: 1,
      accountId: "gacct_test",
      email: "user@example.com",
      status: "ready",
      labels: [{ name: "Receipts", color: "#4277FB", rule: "Order receipts", autoArchive: false }],
      sourceLabelCount: 3,
      startedAt: "2026-07-13T00:00:00.000Z",
      generatedAt: "2026-07-13T00:00:05.000Z"
    };
    writeLabelProfile(profile);
    expect(labelProfilePath("gacct_test")).toBe(join(configDirForAccount("gacct_test"), "label-profile.json"));
    expect(existsSync(labelProfilePath("gacct_test"))).toBe(true);
    expect(readLabelProfile("gacct_test")).toEqual(profile);
  });

  test("read never throws: missing, corrupt, and wrong-shape files degrade to undefined", () => {
    expect(readLabelProfile("gacct_missing")).toBeUndefined();

    mkdirSync(configDirForAccount("gacct_corrupt"), { recursive: true });
    writeFileSync(labelProfilePath("gacct_corrupt"), "{not json");
    expect(readLabelProfile("gacct_corrupt")).toBeUndefined();

    // A shape violation anywhere — including inside a label entry — rejects
    // the whole record rather than surfacing a half-valid one.
    mkdirSync(configDirForAccount("gacct_shape"), { recursive: true });
    writeFileSync(
      labelProfilePath("gacct_shape"),
      JSON.stringify({
        version: 1,
        accountId: "gacct_shape",
        email: "user@example.com",
        status: "ready",
        labels: [{ name: "", color: "#4277FB", rule: "x", autoArchive: false }]
      })
    );
    expect(readLabelProfile("gacct_shape")).toBeUndefined();
  });
});
