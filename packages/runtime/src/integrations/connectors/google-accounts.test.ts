// Orchestration tests for the tagged Google account registry.
//
// The gws subprocess boundary is stubbed via the injected `statusForDir` dep,
// so these never spawn a real `gws`. HOME is pointed at a unique mkdtemp dir so
// the registry writes land in a throwaway ~/.gini/google-accounts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  disconnectInstanceGoogleAccount,
  effectivePrimaryAccountId,
  ensureHostedPrimaryAccount,
  googleAuthMode,
  listAccountsWithStatus,
  normalizeHostedGwsEnv,
  provisionAccount,
  registerAccount,
  registerAccountForInstance,
  removeAccount,
  retagAccount,
  signOutInstanceGoogleAccounts,
  useAccountForInstance
} from "./google-accounts";
import type { GwsSessionStatus } from "./gws-session";
import { attachGoogleAccountToInstance, getGoogleAccountBindings } from "../../state/google-account-bindings";
import { defaultOnboardingRecord, writeOnboarding } from "../../state/onboarding";
import {
  configDirForAccount,
  googleAccountsRoot,
  readGoogleAccounts,
  readPrimaryGoogleAccountId,
  setPrimaryGoogleAccountId
} from "../../state/google-accounts";

let scratchHome: string;
let prevHome: string | undefined;
let prevStateRoot: string | undefined;
let prevHosted: string | undefined;
let prevCredentialsFile: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-gaccts-orch-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevStateRoot = process.env.GINI_STATE_ROOT;
  process.env.GINI_STATE_ROOT = join(scratchHome, "state");
  // The hosted markers drive googleAuthMode/ensureHostedPrimaryAccount/
  // hostedPrimaryConfigDir; clear them so each test states exactly the
  // environment it needs (CONFIG_DIR is now the primary-dir source, so a leak
  // would silently misroute the primary in another test).
  prevHosted = process.env.GINI_HOSTED;
  prevCredentialsFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  delete process.env.GINI_HOSTED;
  delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevStateRoot;
  if (prevHosted === undefined) delete process.env.GINI_HOSTED;
  else process.env.GINI_HOSTED = prevHosted;
  if (prevCredentialsFile === undefined) delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  else process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = prevCredentialsFile;
  rmSync(scratchHome, { recursive: true, force: true });
});

function signedIn(email: string, scopes: string[] = []): GwsSessionStatus {
  const has = (needle: string) => scopes.some((s) => s.includes(needle));
  return {
    installed: true,
    clientConfigured: true,
    signedIn: true,
    services: {
      calendar: has("/auth/calendar"),
      gmail: has("/auth/gmail"),
      drive: has("/auth/drive"),
      docs: has("/auth/documents"),
      sheets: has("/auth/spreadsheets"),
      forms: has("/auth/forms"),
      meet: has("/auth/meetings")
    },
    scopes,
    email,
    message: "Signed in to Google"
  };
}

function signedOut(): GwsSessionStatus {
  return {
    installed: true,
    clientConfigured: true,
    signedIn: false,
    services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
    scopes: [],
    message: "Google sign-in needed"
  };
}

function revoked(): GwsSessionStatus {
  return {
    installed: true,
    clientConfigured: true,
    signedIn: false,
    tokenRevoked: true,
    services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
    scopes: [],
    message: "Google sign-in expired — re-auth needed"
  };
}

describe("registerAccount", () => {
  test("registers a signed-in dir and captures its email", async () => {
    const fetcher = async () => signedIn("me@example.com");
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    expect(account.tag).toBe("personal");
    expect(account.email).toBe("me@example.com");
    expect(account.configDir).toBe("/tmp/gws-personal");
    expect(account.id).toMatch(/^gacct_/);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("throws when the dir has no signed-in session", async () => {
    const fetcher = async () => signedOut();
    await expect(
      registerAccount({ tag: "work", configDir: "/tmp/gws-empty" }, { statusForDir: fetcher })
    ).rejects.toThrow("No signed-in Google session in /tmp/gws-empty");
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("a configDir under the gini root takes its id from the dir basename", async () => {
    const configDir = configDirForAccount("gacct_abc12345");
    const account = await registerAccount(
      { tag: "personal", configDir },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.id).toBe("gacct_abc12345");
    // The dir↔id coupling holds, so removeAccount can reconstruct the dir.
    expect(configDirForAccount(account.id)).toBe(account.configDir);
    expect(account.configDir.startsWith(googleAccountsRoot())).toBe(true);
  });

  test("an adopted dir outside the root keeps a minted id", async () => {
    const account = await registerAccount(
      { tag: "default-gws", configDir: "/tmp/outside/.config/gws", adopt: true },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.id).toMatch(/^gacct_/);
    expect(account.id).not.toBe("gws");
  });

  test("re-registering the same configDir reuses the existing id", async () => {
    const fetcher = async () => signedIn("me@example.com");
    const first = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    const again = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    expect(again.id).toBe(first.id);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("a missing tag defaults to the live session's email local-part", async () => {
    const account = await registerAccount(
      { configDir: "/tmp/gws-derived" },
      { statusForDir: async () => signedIn("ada@example.com") }
    );
    expect(account.tag).toBe("ada");
    expect(account.email).toBe("ada@example.com");
  });

  test("a defaulted tag is uniquified against existing tags instead of colliding", async () => {
    await registerAccount(
      { tag: "Ada", configDir: "/tmp/gws-first" },
      { statusForDir: async () => signedIn("ada@work.example.com") }
    );
    // Same local-part, different account: the default must not throw on the
    // case-insensitive collision the way an explicit "ada" would.
    const second = await registerAccount(
      { configDir: "/tmp/gws-second" },
      { statusForDir: async () => signedIn("ada@example.com") }
    );
    expect(second.tag).toBe("ada-2");
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("a tag-less re-register keeps the existing row's tag", async () => {
    const fetcher = async () => signedIn("me@example.com");
    const first = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-keep" },
      { statusForDir: fetcher }
    );
    const again = await registerAccount({ configDir: "/tmp/gws-keep" }, { statusForDir: fetcher });
    expect(again.id).toBe(first.id);
    expect(again.tag).toBe("personal");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("no tag and no live email falls back to a \"google\" tag", async () => {
    const status = signedIn("");
    delete (status as { email?: string }).email;
    const account = await registerAccount(
      { configDir: "/tmp/gws-noemail" },
      { statusForDir: async () => status }
    );
    expect(account.tag).toBe("google");
  });

  test("trusted:true registers without probing gws (gws may not be installed yet)", async () => {
    const configDir = configDirForAccount("gacct_trust01");
    // statusForDir must NOT be called on the trusted path — fail loudly if it is.
    const account = await registerAccount(
      { tag: "workspace", configDir, trusted: true },
      {
        statusForDir: async () => {
          throw new Error("statusForDir must not run on the trusted path");
        }
      }
    );
    expect(account.id).toBe("gacct_trust01");
    expect(account.tag).toBe("workspace");
    expect(account.email).toBe(""); // back-filled later by listAccountsWithStatus
    expect(account.provisioned).toBe(true); // immutable relay provenance
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("trusted:true preserves an existing account's email on re-register", async () => {
    const configDir = configDirForAccount("gacct_trust02");
    await registerAccount(
      { tag: "workspace", configDir },
      { statusForDir: async () => signedIn("known@example.com") }
    );
    // A later trusted re-register (e.g. re-provision) must not blank the email
    // that the earlier live probe captured.
    const again = await registerAccount(
      { tag: "workspace", configDir, trusted: true },
      {
        statusForDir: async () => {
          throw new Error("statusForDir must not run on the trusted path");
        }
      }
    );
    expect(again.email).toBe("known@example.com");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("a non-trusted register does NOT mark an account provisioned", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-user" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.provisioned).toBeUndefined();
  });

  test("the provisioned flag is sticky: a later non-trusted re-register keeps it", async () => {
    const configDir = configDirForAccount("gacct_trust03");
    const first = await registerAccount({ tag: "workspace", configDir, trusted: true });
    expect(first.provisioned).toBe(true);
    // Re-register the SAME dir on the probed path (e.g. a manual retag flow):
    // provenance must not be strippable.
    const again = await registerAccount(
      { tag: "renamed", configDir },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(again.provisioned).toBe(true);
    expect(again.tag).toBe("renamed");
  });
});

describe("listAccountsWithStatus", () => {
  test("merges the registry with injected live status", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    await registerAccount(
      { tag: "work", configDir: "/tmp/gws-work" },
      { statusForDir: async () => signedIn("work@corp.com") }
    );

    const statuses: Record<string, GwsSessionStatus> = {
      "/tmp/gws-personal": signedIn("me@example.com", ["https://www.googleapis.com/auth/gmail.modify"]),
      "/tmp/gws-work": signedOut()
    };
    const list = await listAccountsWithStatus({
      statusForDir: async (dir) => statuses[dir]!
    });

    const personal = list.find((a) => a.tag === "personal");
    const work = list.find((a) => a.tag === "work");
    expect(personal?.signedIn).toBe(true);
    expect(personal?.services.gmail).toBe(true);
    expect(work?.signedIn).toBe(false);
    expect(work?.message).toBe("Google sign-in needed");
  });

  test("a rejecting status fetch degrades that account to signed-out", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const list = await listAccountsWithStatus({
      statusForDir: async () => { throw new Error("gws blew up"); }
    });
    expect(list[0]?.signedIn).toBe(false);
    expect(list[0]?.tokenRevoked).toBe(false);
    expect(list[0]?.message).toBe("gws blew up");
  });

  test("a revoked live status surfaces tokenRevoked on the account", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const list = await listAccountsWithStatus({ statusForDir: async () => revoked() });
    expect(list[0]?.signedIn).toBe(false);
    expect(list[0]?.tokenRevoked).toBe(true);
  });

  test("empty registry → []", async () => {
    expect(await listAccountsWithStatus({ statusForDir: async () => signedOut() })).toEqual([]);
  });

  test("a fresh instance does not surface another instance's global credentials", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );

    const list = await listAccountsWithStatus("fresh", { statusForDir: async () => signedOut() });
    expect(list).toEqual([]);
  });

  test("completed legacy instances adopt the old global primary once", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    setPrimaryGoogleAccountId(account.id);
    writeOnboarding("legacy", { ...defaultOnboardingRecord(), completed: true });

    const list = await listAccountsWithStatus("legacy", { statusForDir: async () => signedOut() });

    expect(list[0]?.primary).toBe(true);
    expect(list[0]?.attached).toBe(true);
    expect(getGoogleAccountBindings("legacy").legacyPrimaryMigratedAt).toBeDefined();
  });

  test("returns only accounts attached to the requested instance", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const work = await registerAccount(
      { tag: "work", configDir: "/tmp/gws-work" },
      { statusForDir: async () => signedIn("work@corp.com") }
    );
    attachGoogleAccountToInstance("inst-a", work, { primary: true });

    const list = await listAccountsWithStatus("inst-a", { statusForDir: async () => signedOut() });
    expect(list.map((account) => account.tag)).toEqual(["work"]);
    expect(list[0]?.primary).toBe(true);
    expect(list[0]?.attached).toBe(true);
  });

  test("without an instance, listing does not infer primary from global registry", async () => {
    const first = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    let list = await listAccountsWithStatus({ statusForDir: async () => signedOut() });
    expect(list.find((a) => a.id === first.id)?.primary).toBeUndefined();
    expect(effectivePrimaryAccountId()).toBe(first.id);

    const provisioned = await registerAccount({
      tag: "workspace",
      configDir: configDirForAccount("gacct_prov0001"),
      trusted: true
    });
    list = await listAccountsWithStatus({ statusForDir: async () => signedOut() });
    expect(effectivePrimaryAccountId()).toBe(provisioned.id);
    expect(list.find((a) => a.id === provisioned.id)?.primary).toBeUndefined();
    expect(list.find((a) => a.id === first.id)?.primary).toBeUndefined();
  });

  test("a stale persisted primary id falls back to the heuristic", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    setPrimaryGoogleAccountId("gacct_gone");
    expect(effectivePrimaryAccountId()).toBe(account.id);
    const list = await listAccountsWithStatus({ statusForDir: async () => signedOut() });
    expect(list[0]?.primary).toBeUndefined();
  });

  test("the primary flag survives a rejecting status fetch (degraded row keeps it)", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    attachGoogleAccountToInstance("inst-a", account, { primary: true });
    const list = await listAccountsWithStatus("inst-a", {
      statusForDir: async () => { throw new Error("gws blew up"); }
    });
    expect(list[0]?.signedIn).toBe(false);
    expect(list[0]?.primary).toBe(true);
  });
});

describe("removeAccount", () => {
  test("removing the primary account clears the persisted primary", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    setPrimaryGoogleAccountId(account.id);
    removeAccount(account.id);
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    expect(readGoogleAccounts()).toEqual([]);
  });
});

describe("instance sign-in helpers", () => {
  test("registerAccountForInstance attaches the row and makes only the first one primary", async () => {
    const first = await registerAccountForInstance(
      "inst-a",
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const second = await registerAccountForInstance(
      "inst-a",
      { tag: "work", configDir: "/tmp/gws-work" },
      { statusForDir: async () => signedIn("me@work.com") }
    );

    expect(getGoogleAccountBindings("inst-a").attachedAccountIds).toEqual([first.id, second.id]);
    expect(getGoogleAccountBindings("inst-a").primaryAccountId).toBe(first.id);
    expect(getGoogleAccountBindings("inst-b").attachedAccountIds).toEqual([]);
  });

  test("useAccountForInstance requires a live account and binds only that instance", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );

    const row = await useAccountForInstance("inst-a", account.id, {
      statusForDir: async () => signedIn("me@example.com")
    });

    expect(row.primary).toBe(true);
    expect(row.attached).toBe(true);
    expect(getGoogleAccountBindings("inst-a").primaryAccountId).toBe(account.id);
    expect(getGoogleAccountBindings("inst-b").primaryAccountId).toBeUndefined();
  });

  test("signOutInstanceGoogleAccounts clears active instance bindings and keeps credentials", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    attachGoogleAccountToInstance("inst-a", account, { primary: true });

    signOutInstanceGoogleAccounts("inst-a");

    expect(getGoogleAccountBindings("inst-a").primaryAccountId).toBeUndefined();
    expect(getGoogleAccountBindings("inst-a").attachedAccountIds).toEqual([]);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("disconnectInstanceGoogleAccount protects the primary and detaches only the requested secondary", async () => {
    const primary = await registerAccountForInstance(
      "inst-a",
      { tag: "primary", configDir: "/tmp/gws-primary" },
      { statusForDir: async () => signedIn("primary@example.com") }
    );
    const secondary = await registerAccountForInstance(
      "inst-a",
      { tag: "secondary", configDir: "/tmp/gws-secondary" },
      { statusForDir: async () => signedIn("secondary@example.com") }
    );
    attachGoogleAccountToInstance("inst-b", secondary, { primary: true });

    expect(() => disconnectInstanceGoogleAccount("inst-a", primary.id)).toThrow(
      "Primary Google account cannot be disconnected"
    );
    disconnectInstanceGoogleAccount("inst-a", secondary.id);

    expect(getGoogleAccountBindings("inst-a").attachedAccountIds).toEqual([primary.id]);
    expect(getGoogleAccountBindings("inst-b").attachedAccountIds).toEqual([secondary.id]);
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("disconnectInstanceGoogleAccount rejects an account not attached to the instance", () => {
    expect(() => disconnectInstanceGoogleAccount("inst-a", "gacct_missing")).toThrow(
      "Google account is not connected to this instance"
    );
  });
});

describe("provisionAccount", () => {
  const input = {
    clientId: "edge-client.apps.googleusercontent.com",
    clientSecret: "edge-secret",
    refreshToken: "1//refresh-a",
    email: "Ada.Lovelace@example.com",
    principal: "sub-ada"
  };

  test("fresh mint: managed dir, 0600 credential with the caller's client, tag from the email local-part", async () => {
    const account = await provisionAccount(input);

    expect(account.tag).toBe("Ada.Lovelace");
    expect(account.provisioned).toBe(true);
    expect(account.principal).toBe("sub-ada");
    // The Google-verified email is stored, so later re-adds can match on it.
    expect(account.email).toBe(input.email);
    expect(account.configDir.startsWith(googleAccountsRoot())).toBe(true);
    expect(account.configDir).toBe(configDirForAccount(account.id));
    const credPath = join(account.configDir, "credentials.json");
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual({
      type: "authorized_user",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken
    });
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("re-provisioning the same principal overwrites in place — no duplicate row", async () => {
    const first = await provisionAccount(input);
    const again = await provisionAccount({ ...input, refreshToken: "1//refresh-b", tag: "ignored" });

    expect(again.id).toBe(first.id);
    expect(again.configDir).toBe(first.configDir);
    // The existing tag sticks (a user retag must survive a re-add).
    expect(again.tag).toBe("Ada.Lovelace");
    const cred = JSON.parse(readFileSync(join(again.configDir, "credentials.json"), "utf8"));
    expect(cred.refresh_token).toBe("1//refresh-b");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("a different principal mints its own account instead of clobbering the first", async () => {
    const first = await provisionAccount(input);
    const second = await provisionAccount({ ...input, email: "bob@example.com", principal: "sub-bob" });

    expect(second.id).not.toBe(first.id);
    expect(second.configDir).not.toBe(first.configDir);
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("the principal match wins over another row's stored-email match", async () => {
    const byPrincipal = await provisionAccount(input);
    const byEmail = await registerAccount(
      { tag: "work", configDir: configDirForAccount("gacct_email001") },
      { statusForDir: async () => signedIn("shared@example.com") }
    );

    const again = await provisionAccount({
      ...input,
      refreshToken: "1//refresh-b",
      email: "shared@example.com"
    });

    expect(again.id).toBe(byPrincipal.id);
    expect(readGoogleAccounts()).toHaveLength(2);
    // The email-matched row was left alone — no credential landed in its dir.
    expect(existsSync(join(byEmail.configDir, "credentials.json"))).toBe(false);
  });

  test("a stored-email match (case-insensitive) refreshes that row in place", async () => {
    // A chat-flow row: registered via the probed path, so it has a stored
    // email but no principal and no provisioned flag.
    const row = await registerAccount(
      { tag: "work", configDir: configDirForAccount("gacct_chat0001") },
      { statusForDir: async () => signedIn("Ada.Lovelace@example.com") }
    );
    expect(row.provisioned).toBeUndefined();

    const account = await provisionAccount({ ...input, email: "ada.lovelace@EXAMPLE.com" });

    expect(account.id).toBe(row.id);
    expect(account.configDir).toBe(row.configDir);
    expect(account.tag).toBe("work");
    expect(account.provisioned).toBe(true);
    expect(account.principal).toBe("sub-ada");
    // Backfill only fills empties: the already-captured stored email wins.
    expect(account.email).toBe("Ada.Lovelace@example.com");
    const cred = JSON.parse(readFileSync(join(row.configDir, "credentials.json"), "utf8"));
    expect(cred.refresh_token).toBe(input.refreshToken);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("an empty-email row is matched by live probe and its email backfilled; stored-email rows are never probed", async () => {
    await registerAccount(
      { tag: "other", configDir: configDirForAccount("gacct_other001") },
      { statusForDir: async () => signedIn("other@example.com") }
    );
    // The hosted boot-registered primary: trusted, no principal, email "".
    const bootPrimary = await registerAccount({
      tag: "primary",
      configDir: configDirForAccount("gacct_boot0001"),
      trusted: true
    });
    expect(bootPrimary.email).toBe("");

    const probed: string[] = [];
    const account = await provisionAccount(input, {
      statusForDir: async (dir) => {
        probed.push(dir);
        return signedIn("ada.lovelace@example.com");
      }
    });

    expect(probed).toEqual([bootPrimary.configDir]);
    expect(account.id).toBe(bootPrimary.id);
    expect(account.tag).toBe("primary");
    expect(account.provisioned).toBe(true);
    expect(account.principal).toBe("sub-ada");
    expect(account.email).toBe(input.email); // backfilled from the verified email
    const cred = JSON.parse(readFileSync(join(bootPrimary.configDir, "credentials.json"), "utf8"));
    expect(cred.refresh_token).toBe(input.refreshToken);
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("a rejecting live probe is best-effort: no match mints a fresh row", async () => {
    await registerAccount({
      tag: "unreadable",
      configDir: configDirForAccount("gacct_broken01"),
      trusted: true
    });

    const account = await provisionAccount(input, {
      statusForDir: async () => { throw new Error("gws blew up"); }
    });

    expect(account.tag).toBe("Ada.Lovelace");
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("no input email skips email matching — empty-email rows are never probed", async () => {
    await registerAccount({
      tag: "primary",
      configDir: configDirForAccount("gacct_boot0002"),
      trusted: true
    });

    const probed: string[] = [];
    const account = await provisionAccount(
      {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: "1//refresh-d",
        principal: "sub-new"
      },
      {
        statusForDir: async (dir) => {
          probed.push(dir);
          return signedIn("primary@example.com");
        }
      }
    );

    expect(probed).toEqual([]);
    expect(account.tag).toBe("google");
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("a colliding default tag is uniquified case-insensitively", async () => {
    await registerAccount(
      { tag: "ADA.lovelace", configDir: "/tmp/gws-taken" },
      { statusForDir: async () => signedIn("other@example.com") }
    );
    const account = await provisionAccount({ ...input, principal: "sub-ada2" });
    expect(account.tag).toBe("Ada.Lovelace-2");
  });

  test("an explicit tag wins over the email local-part; no email or tag falls back to \"google\"", async () => {
    const tagged = await provisionAccount({ ...input, principal: "sub-1", tag: "work" });
    expect(tagged.tag).toBe("work");
    const bare = await provisionAccount({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: "1//refresh-c",
      principal: "sub-2"
    });
    expect(bare.tag).toBe("google");
  });

  test("makePrimary:true persists the provisioned account as the primary", async () => {
    const account = await provisionAccount({ ...input, makePrimary: true });
    expect(readPrimaryGoogleAccountId()).toBe(account.id);
  });

  test("makePrimary flips the primary to a MATCHED existing row (the sign-in-intent re-auth)", async () => {
    const first = await provisionAccount({ ...input, makePrimary: true });
    const second = await provisionAccount({ ...input, email: "bob@example.com", principal: "sub-bob" });
    expect(readPrimaryGoogleAccountId()).toBe(first.id);
    // Signing in as the already-known second account flips the primary to it.
    const again = await provisionAccount({
      ...input,
      email: "bob@example.com",
      principal: "sub-bob",
      makePrimary: true
    });
    expect(again.id).toBe(second.id);
    expect(readPrimaryGoogleAccountId()).toBe(second.id);
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("without makePrimary an add never touches the persisted primary", async () => {
    const first = await provisionAccount({ ...input, makePrimary: true });
    await provisionAccount({ ...input, email: "bob@example.com", principal: "sub-bob" });
    expect(readPrimaryGoogleAccountId()).toBe(first.id);
  });

  test("makePrimary with an instance binds the account only to that instance", async () => {
    const account = await provisionAccount({ ...input, makePrimary: true, instance: "inst-a" });
    expect(getGoogleAccountBindings("inst-a").primaryAccountId).toBe(account.id);
    expect(getGoogleAccountBindings("inst-b").primaryAccountId).toBeUndefined();
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
  });
});

describe("provisionAccount primary heal (hosted baked credential)", () => {
  const input = {
    clientId: "edge-client.apps.googleusercontent.com",
    clientSecret: "edge-secret",
    refreshToken: "1//refresh-primary",
    email: "Ada.Lovelace@example.com",
    principal: "sub-ada"
  };
  function bakeHostedPrimary(): { credentialsFile: string; configDir: string } {
    const credentialsFile = join(scratchHome, ".config", "gws-hosted", "credentials.json");
    mkdirSync(dirname(credentialsFile), { recursive: true });
    writeFileSync(credentialsFile, "{}");
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialsFile;
    return { credentialsFile, configDir: dirname(credentialsFile) };
  }

  test("primary:true rewrites the baked file even for a REVOKED primary with no live email", async () => {
    // The scenario the probe-based match can't handle: a revoked primary yields
    // no live email, has no principal and no stored email — yet gws reads only
    // this baked file, so the fresh token MUST land here to heal.
    const { credentialsFile, configDir } = bakeHostedPrimary();
    const primary = await ensureHostedPrimaryAccount();
    expect(primary?.configDir).toBe(configDir);

    const probed: string[] = [];
    const account = await provisionAccount(
      { ...input, primary: true },
      { statusForDir: async (dir) => { probed.push(dir); return revoked(); } }
    );

    expect(account.id).toBe(primary!.id);
    expect(account.configDir).toBe(configDir);
    expect(account.tag).toBe("primary");
    expect(account.principal).toBe("sub-ada");
    const cred = JSON.parse(readFileSync(credentialsFile, "utf8"));
    expect(cred.type).toBe("authorized_user");
    expect(cred.refresh_token).toBe(input.refreshToken);
    // The baked-dir match short-circuits before any probe; no duplicate row.
    expect(probed).toEqual([]);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("primary:true is inert off a hosted guest — mints a normal managed account", async () => {
    // beforeEach cleared the hosted markers, so hostedPrimaryConfigDir() is
    // undefined and the flag can't misroute a local provision.
    const account = await provisionAccount({ ...input, primary: true });
    expect(account.configDir.startsWith(googleAccountsRoot())).toBe(true);
    expect(account.tag).toBe("Ada.Lovelace");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("primary:true with no registered primary row falls through to identity matching", async () => {
    bakeHostedPrimary(); // env set, but ensureHostedPrimaryAccount NOT called
    const account = await provisionAccount({ ...input, primary: true });
    expect(account.configDir.startsWith(googleAccountsRoot())).toBe(true);
    expect(account.principal).toBe("sub-ada");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("WITHOUT primary:true, an add of a different mailbox never overwrites the baked primary", async () => {
    const { configDir } = bakeHostedPrimary();
    const primary = await ensureHostedPrimaryAccount();
    const account = await provisionAccount(
      { ...input, email: "bob@example.com", principal: "sub-bob" },
      { statusForDir: async () => revoked() }
    );
    expect(account.id).not.toBe(primary!.id);
    expect(account.configDir).not.toBe(configDir);
    expect(readGoogleAccounts()).toHaveLength(2);
  });
});

describe("googleAuthMode", () => {
  test("GINI_HOSTED=1 → edge; anything else → loopback", () => {
    expect(googleAuthMode()).toBe("loopback");
    process.env.GINI_HOSTED = "1";
    expect(googleAuthMode()).toBe("edge");
    process.env.GINI_HOSTED = "0";
    expect(googleAuthMode()).toBe("loopback");
  });
});

describe("ensureHostedPrimaryAccount", () => {
  function bakeHostedCredential(): string {
    const credentialsFile = join(scratchHome, ".config", "gws-hosted", "credentials.json");
    mkdirSync(dirname(credentialsFile), { recursive: true });
    writeFileSync(credentialsFile, "{}");
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialsFile;
    return credentialsFile;
  }

  test("registers the credential dir as the trusted \"primary\" account once", async () => {
    const credentialsFile = bakeHostedCredential();

    const account = await ensureHostedPrimaryAccount();
    expect(account?.tag).toBe("primary");
    expect(account?.configDir).toBe(dirname(credentialsFile));
    expect(account?.provisioned).toBe(true);
    expect(readGoogleAccounts()).toHaveLength(1);
    // Boot also persists the boot account as the primary (the field was unset).
    expect(readPrimaryGoogleAccountId()).toBe(account!.id);

    // Second boot: the dir is already registered → no-op, no duplicate.
    expect(await ensureHostedPrimaryAccount()).toBeUndefined();
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("sets primaryAccountId only when unset — a user's sign-in choice survives reboots", async () => {
    bakeHostedCredential();
    const boot = await ensureHostedPrimaryAccount();
    const other = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    // The user later signed in as another account (sign-in intent).
    setPrimaryGoogleAccountId(other.id);
    expect(await ensureHostedPrimaryAccount()).toBeUndefined();
    expect(readPrimaryGoogleAccountId()).toBe(other.id);
    expect(boot).toBeDefined();
  });

  test("binds the hosted primary on an instance whose row already exists, and logs the write", async () => {
    // A guest provisioned before the primary field existed: registry row
    // present, field unset. The next boot heals the field without
    // re-registering — and since the already-registered return is undefined
    // (nothing for the boot caller to log), the connector logs the backfill
    // itself so the registry write is observable. GINI_LOG_ROOT pins the log
    // to the scratch dir (the default log path resolves through os.homedir(),
    // which caches getpwuid on macOS and ignores the test's HOME override).
    const credentialsFile = bakeHostedCredential();
    const row = await registerAccount({
      tag: "primary",
      configDir: dirname(credentialsFile),
      trusted: true
    });
    const prevLogRoot = process.env.GINI_LOG_ROOT;
    process.env.GINI_LOG_ROOT = join(scratchHome, "logs");
    try {
      expect(await ensureHostedPrimaryAccount("boot-test")).toBeUndefined();
    } finally {
      if (prevLogRoot === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = prevLogRoot;
    }
    expect(readGoogleAccounts()).toHaveLength(1);
    expect(getGoogleAccountBindings("boot-test").primaryAccountId).toBe(row.id);
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
    const logged = readFileSync(join(scratchHome, "logs", "boot-test", "runtime.jsonl"), "utf8");
    expect(JSON.parse(logged)).toMatchObject({
      message: "google.hosted_primary.primary_bound",
      data: { id: row.id }
    });
  });

  test("no-op without BOTH hosted markers", async () => {
    // Credential env alone (a local machine using the gws env var).
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = join(scratchHome, "creds.json");
    expect(await ensureHostedPrimaryAccount()).toBeUndefined();
    // Hosted flag alone (a guest whose login granted no Workspace scopes).
    delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    process.env.GINI_HOSTED = "1";
    expect(await ensureHostedPrimaryAccount()).toBeUndefined();
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("a taken \"primary\" tag is uniquified instead of failing the boot registration", async () => {
    await registerAccount(
      { tag: "Primary", configDir: "/tmp/gws-elsewhere" },
      { statusForDir: async () => signedIn("other@example.com") }
    );
    bakeHostedCredential();
    const account = await ensureHostedPrimaryAccount();
    expect(account?.tag).toBe("primary-2");
    expect(readGoogleAccounts()).toHaveLength(2);
  });

  test("registers the baked CONFIG_DIR dir (new-guest scheme) as a managed primary", async () => {
    // New guests bake GOOGLE_WORKSPACE_CLI_CONFIG_DIR (not the tier-2 credentials
    // file) pointing at a managed dir under the google-accounts root.
    const configDir = configDirForAccount("gacct_primary");
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = configDir;
    const account = await ensureHostedPrimaryAccount();
    expect(account?.tag).toBe("primary");
    expect(account?.configDir).toBe(configDir);
    expect(account?.id).toBe("gacct_primary"); // managed dir → id from basename
    expect(account?.provisioned).toBe(true);
    expect(readGoogleAccounts()).toHaveLength(1);
    // Second boot: already registered → no-op.
    expect(await ensureHostedPrimaryAccount()).toBeUndefined();
  });

  test("CONFIG_DIR wins over a stray legacy CREDENTIALS_FILE", async () => {
    const configDir = configDirForAccount("gacct_primary");
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = configDir;
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = join(scratchHome, ".config", "gws-hosted", "credentials.json");
    const account = await ensureHostedPrimaryAccount();
    expect(account?.configDir).toBe(configDir);
  });

  test("registers via the baked gacct_primary dir ON DISK when no gws env is set (snapshot-resume)", async () => {
    // A snapshot-resumed guest: GINI_HOSTED is present (baked into the golden) but
    // the tenant gws env is NOT (the resumed process never sourced it). The
    // credential is baked at the stable path, so hostedPrimaryConfigDir falls back
    // to it on disk and the primary still registers.
    const bakedDir = configDirForAccount("gacct_primary");
    mkdirSync(bakedDir, { recursive: true });
    writeFileSync(join(bakedDir, "credentials.json"), "{}");
    process.env.GINI_HOSTED = "1"; // no CONFIG_DIR, no CREDENTIALS_FILE (beforeEach cleared them)
    const account = await ensureHostedPrimaryAccount();
    expect(account?.id).toBe("gacct_primary");
    expect(account?.configDir).toBe(bakedDir);
    expect(account?.tag).toBe("primary");
    expect(readGoogleAccounts()).toHaveLength(1);
  });
});

describe("listAccountsWithStatus hosted self-heal", () => {
  test("registers the baked primary on read when boot never ran (snapshot-resume)", async () => {
    // On a resumed guest the boot-time registration never runs, so the registry
    // starts empty even though the credential is baked. The first accounts read
    // (onboarding polls this) self-heals it — no second consent needed.
    const bakedDir = configDirForAccount("gacct_primary");
    mkdirSync(bakedDir, { recursive: true });
    writeFileSync(join(bakedDir, "credentials.json"), "{}");
    process.env.GINI_HOSTED = "1";
    expect(readGoogleAccounts()).toHaveLength(0);

    const rows = await listAccountsWithStatus("hosted-read", {
      statusForDir: async () => signedIn("wilson@lilaclabs.ai", ["/auth/gmail.modify", "/auth/calendar"])
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("gacct_primary");
    expect(rows[0].primary).toBe(true);
    expect(rows[0].signedIn).toBe(true);
  });

  test("off-hosted: the read has no self-heal side effect", async () => {
    // Not hosted → ensureHostedPrimaryAccount is inert, so a plain list neither
    // registers anything nor errors.
    const rows = await listAccountsWithStatus({ statusForDir: async () => signedIn("x@y.z") });
    expect(rows).toEqual([]);
    expect(readGoogleAccounts()).toEqual([]);
  });
});

describe("normalizeHostedGwsEnv", () => {
  test("hosted + tier-2 credentials file, no config dir → derives CONFIG_DIR and drops the pin", () => {
    const env = {
      GINI_HOSTED: "1",
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/home/bun/.config/gws-hosted/credentials.json"
    } as NodeJS.ProcessEnv;
    normalizeHostedGwsEnv(env);
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe("/home/bun/.config/gws-hosted");
    expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
  });

  test("an already-set CONFIG_DIR is preserved; only the tier-2 pin is dropped", () => {
    const env = {
      GINI_HOSTED: "1",
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/home/bun/.gini/google-accounts/gacct_primary",
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/home/bun/.config/gws-hosted/credentials.json"
    } as NodeJS.ProcessEnv;
    normalizeHostedGwsEnv(env);
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe("/home/bun/.gini/google-accounts/gacct_primary");
    expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
  });

  test("off a hosted guest it is a no-op (both vars preserved)", () => {
    const env = { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/x/credentials.json" } as NodeJS.ProcessEnv;
    normalizeHostedGwsEnv(env);
    expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe("/x/credentials.json");
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBeUndefined();
  });

  test("hosted with no tier-2 pin leaves CONFIG_DIR untouched and is idempotent", () => {
    const env = {
      GINI_HOSTED: "1",
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/home/bun/.gini/google-accounts/gacct_primary"
    } as NodeJS.ProcessEnv;
    normalizeHostedGwsEnv(env);
    normalizeHostedGwsEnv(env);
    expect(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe("/home/bun/.gini/google-accounts/gacct_primary");
    expect(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
  });

  test("defaults to process.env when no env is passed", () => {
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = join(scratchHome, ".config", "gws-hosted", "credentials.json");
    normalizeHostedGwsEnv();
    expect(process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(join(scratchHome, ".config", "gws-hosted"));
    expect(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBeUndefined();
  });
});

describe("removeAccount", () => {
  test("deletes a gini-managed account's config dir", async () => {
    const configDir = configDirForAccount("gacct_rm00001");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "credentials.json"), "{}");
    await registerAccount({ tag: "work", configDir, trusted: true });
    removeAccount("gacct_rm00001");
    expect(readGoogleAccounts()).toEqual([]);
    expect(existsSync(configDir)).toBe(false);
  });

  test("never wipes the hosted primary's dir — the row drops but the credential survives", async () => {
    // Under the unified layout the primary lives under the managed root, so the
    // generic delete branch WOULD remove it; the primary-dir guard prevents that
    // so it self-heals at the next boot.
    const configDir = configDirForAccount("gacct_primary");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "credentials.json"), "{}");
    process.env.GINI_HOSTED = "1";
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = configDir;
    const primary = await ensureHostedPrimaryAccount();
    removeAccount(primary!.id);
    expect(readGoogleAccounts()).toEqual([]); // row dropped
    expect(existsSync(join(configDir, "credentials.json"))).toBe(true); // creds survive
  });

  test("is a no-op for an unknown id", () => {
    removeAccount("gacct_nope0001");
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("retagAccount renames an account's tag", async () => {
    const configDir = configDirForAccount("gacct_retag01");
    await registerAccount({ tag: "work", configDir, trusted: true });
    retagAccount("gacct_retag01", "personal");
    expect(readGoogleAccounts()[0]!.tag).toBe("personal");
  });

  test("never deletes an adopted dir outside the managed root", async () => {
    const configDir = join(scratchHome, ".config", "gws");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "credentials.json"), "{}");
    await registerAccount(
      { tag: "default", configDir, adopt: true },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const id = readGoogleAccounts()[0]!.id;
    removeAccount(id);
    expect(readGoogleAccounts()).toEqual([]);
    expect(existsSync(join(configDir, "credentials.json"))).toBe(true);
  });
});
