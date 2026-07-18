// Tests for the deterministic auth preflight block builder. The module shells
// out to the real `yc` and `gws` CLIs (this build targets a provisioned fleet
// where both are installed). To test the BUILDER's logic without those
// binaries — and without paying a real `bash -lc` login-shell boot plus a live
// OAuth probe per test — we inject a stub CommandRunner that reports "not
// authenticated" deterministically. That drives the same "NOT authenticated"
// branch whose wording (the action directives) we want to lock down, with zero
// subprocess boots.

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthPreflightBlock, type CommandRunner, type AccountConfigDirsLookup } from "./auth-preflight";

// An env that gets past the provisioned gate. The PATH no longer matters for
// the probe outcome (the injected runner below decides that), but we keep a
// sane one so nothing else in the env surprises us.
let sanitizedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  const emptyDir = mkdtempSync(join(tmpdir(), "auth-preflight-empty-"));
  // Set GINI_RELAY_PROVISIONED so these tests get past the provisioned gate and
  // actually exercise the probes; the injected runner makes them report unauthed.
  sanitizedEnv = { ...process.env, PATH: `${emptyDir}:/usr/bin:/bin`, GINI_RELAY_PROVISIONED: "1" };
});

// Stub runner: every probe resolves as "not authenticated" — `yc me` exits
// non-zero (command-not-found, no "(" in stdout) and `gws auth status` returns
// stdout with no valid token AND no refresh token (a never-signed-in dir, not
// a revoked grant). This reproduces the real not-signed-in outcome the tests
// pin, with zero subprocess boots.
const notAuthedRun: CommandRunner = async (_cmd, args) => {
  const script = args[args.length - 1] ?? "";
  if (script.includes("yc me")) return { code: 127, stdout: "", stderr: "bash: yc: command not found" };
  return { code: 0, stdout: JSON.stringify({ token_valid: false }), stderr: "" };
};

// Revoked runner: `gws auth status` reports a stored refresh token that no
// longer yields a session — the classification parseGwsAuthStatus maps to
// tokenRevoked, i.e. the genuine re-auth case (vs never signed in).
const revokedRun: CommandRunner = async (_cmd, args) => {
  const script = args[args.length - 1] ?? "";
  if (script.includes("yc me")) return { code: 127, stdout: "", stderr: "bash: yc: command not found" };
  return {
    code: 0,
    stdout: JSON.stringify({ token_valid: false, has_refresh_token: true, token_error: "Token has been expired or revoked." }),
    stderr: ""
  };
};

// Hostile runner: throws, standing in for an environment where even spawning
// the probe blows up. The builder must catch and degrade to "" (a string),
// never throw into the turn.
const throwingRun: CommandRunner = async () => {
  throw new Error("cannot spawn probe");
};

// Fully-authed runner: `yc me` succeeds with a parenthesized identity (the "(" the
// parser keys on) and `gws auth status` reports a valid token. Drives the two
// success branches so the OK-path wording ("- <tool>: OK — signed in ...") is
// pinned too, not just the failure directives.
const authedRun: CommandRunner = async (_cmd, args) => {
  const script = args[args.length - 1] ?? "";
  if (script.includes("yc me")) return { code: 0, stdout: "user@example.com (org-1)\n", stderr: "" };
  return { code: 0, stdout: JSON.stringify({ token_valid: true, user: "user@example.com" }), stderr: "" };
};

// Account-config lookups, injected so the gws branch is decided by the test,
// not by whatever ~/.gini/google-accounts/accounts.json holds on this machine
// (homedir() is not env-overridable at runtime, so the real lookup can't be
// sandboxed via HOME). `withAccount` drives the "account attached -> probe its
// dir" path; `noAccount` drives the "no Google account" branch.
const withAccount: AccountConfigDirsLookup = () => ["/tmp/gws-cfg"];
const noAccount: AccountConfigDirsLookup = () => [];

describe("buildAuthPreflightBlock", () => {
  test("passes the runtime instance to the Google account lookup", async () => {
    let requestedInstance: string | undefined;
    const lookup: AccountConfigDirsLookup = (instance) => {
      requestedInstance = instance;
      return ["/tmp/gws-cfg"];
    };
    await buildAuthPreflightBlock(sanitizedEnv, authedRun, lookup, "inst-a");
    expect(requestedInstance).toBe("inst-a");
  });

  test("emits a directive block when tools are not authenticated", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    // Something is not authed in this sanitized env, so the block is non-empty.
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("AUTH PREFLIGHT");
    expect(block).toContain("END AUTH PREFLIGHT");
  });

  test("the block informs+routes (does not prescribe the procedure)", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    // The hook's contract: it tells the agent it MUST act, and routes it to
    // the sanctioned mechanism — it does not itself perform the login. Only
    // the yc line still routes via "your own instructions and skills"; the
    // gws lines name their affordance (request_google_account, below).
    expect(block).toContain("does not perform any login");
    expect(block).toContain("following your own instructions and skills");
    expect(block).toContain("this notice only tells you that you must act, not how");
  });

  test("gws branches direct the agent to request_google_account (reauth and first-time)", async () => {
    // Reauth: an account is attached and gws classifies its grant as revoked.
    const reauth = await buildAuthPreflightBlock(sanitizedEnv, revokedRun, withAccount);
    expect(reauth).toContain("RE-AUTH");
    // First-time: no account attached to this instance at all.
    const firstTime = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, noAccount);
    expect(firstTime).toContain("no Google account attached to this Gini instance");
    for (const block of [reauth, firstTime]) {
      const gwsLine = block.split("\n").find((line) => line.startsWith("- google (gws):")) ?? "";
      // The gws directive names the concrete mechanism: surface the in-chat
      // button, hand off to the user, and never drive OAuth agent-side. The
      // act-but-no-mechanism wording is what made an agent improvise
      // `gws auth login` — it must not come back.
      expect(gwsLine).toContain("request_google_account");
      expect(gwsLine).toContain("Integrations page");
      expect(gwsLine).toContain("gws auth login");
      expect(gwsLine).not.toContain("act, not how");
    }
  });

  test("any live account silences the gws directive even when others are revoked", async () => {
    // Two attached accounts: one revoked, one live. One live session means
    // Google is usable — the preflight must not order a reconnect (the dead
    // account surfaces at gws-call time through the skills' auth guidance).
    const dirs: AccountConfigDirsLookup = () => ["/tmp/gws-dead", "/tmp/gws-live"];
    const run: CommandRunner = async (_cmd, args) => {
      const script = args[args.length - 1] ?? "";
      if (script.includes("yc me")) return { code: 0, stdout: "user@example.com (org-1)\n", stderr: "" };
      if (script.includes("/tmp/gws-dead")) {
        return {
          code: 0,
          stdout: JSON.stringify({ token_valid: false, has_refresh_token: true, token_error: "Token has been expired or revoked." }),
          stderr: ""
        };
      }
      return { code: 0, stdout: JSON.stringify({ token_valid: true, user: "live@example.com" }), stderr: "" };
    };
    // Nothing to flag at all: yc is authed and gws has a live session.
    expect(await buildAuthPreflightBlock(sanitizedEnv, run, dirs)).toBe("");
  });

  test("first-time branch sends the user directly to the local account flow", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, noAccount);
    const gwsLine = block.split("\n").find((line) => line.startsWith("- google (gws):")) ?? "";
    expect(gwsLine).toContain("request_google_account");
    expect(gwsLine).not.toContain("list_connectors");
    expect(gwsLine).not.toContain("RE-AUTH");
  });

  test("attached-but-never-signed-in accounts get first-time text, not the reauth CTA", async () => {
    // An attached row whose dir holds no live grant and no revoked token (e.g.
    // a credential awaiting its first completed login). Ordering a reconnect
    // here is the false positive this branch exists to avoid.
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    const gwsLine = block.split("\n").find((line) => line.startsWith("- google (gws):")) ?? "";
    expect(gwsLine).toContain("no live Google session on any attached account");
    expect(gwsLine).not.toContain("list_connectors");
    expect(gwsLine).not.toContain("RE-AUTH");
  });

  test("the directive is unconditional — act even if the tool is irrelevant", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    expect(block).toContain("even if");
    expect(block.toLowerCase()).toContain("do not weigh relevance");
  });

  test("each failing tool carries a REQUIRED ACTION line", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    expect(block).toContain("REQUIRED ACTION:");
  });

  test("flags yc when it cannot authenticate", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, withAccount);
    expect(block).toContain("yc");
  });

  test("returns a string (never throws) even on a hostile env", async () => {
    // The injected runner throws (standing in for an env where even spawning the
    // probe blows up); the module must degrade gracefully (best-effort, catch ->
    // "") rather than throw into the turn. Keep the gate open so we exercise the
    // probe path, not the early no-op.
    const block = await buildAuthPreflightBlock({ ...process.env, PATH: "", GINI_RELAY_PROVISIONED: "1" }, throwingRun, withAccount);
    expect(typeof block).toBe("string");
  });

  test("emits nothing when BOTH tools are authenticated (happy-path no-op)", async () => {
    // Both probes succeed (yc identity parses, gws token valid): the builder has
    // nothing to flag, so it returns "" and injects no noise into the turn. This
    // pins the OK branches of checkYc/checkGws (the "signed in" details).
    const block = await buildAuthPreflightBlock(sanitizedEnv, authedRun, withAccount);
    expect(block).toBe("");
  });

  test("still emits a block when yc is out even though gws is signed in", async () => {
    // Mixed state: gws authed (OK line), yc not (REQUIRED ACTION). The block is
    // non-empty and lists gws as OK while directing action on yc — exercising the
    // per-tool OK vs failing rendering in one pass.
    const run: CommandRunner = async (_cmd, args) => {
      const script = args[args.length - 1] ?? "";
      if (script.includes("yc me")) return { code: 127, stdout: "", stderr: "bash: yc: command not found" };
      return { code: 0, stdout: JSON.stringify({ token_valid: true, user: "user@example.com" }), stderr: "" };
    };
    const block = await buildAuthPreflightBlock(sanitizedEnv, run, withAccount);
    expect(block).toContain("AUTH PREFLIGHT");
    expect(block).toContain("google (gws): OK");
    expect(block).toContain("REQUIRED ACTION:");
  });

  test("flags the missing-Google-account branch when no account is attached", async () => {
    // With no account, checkGws takes its early-return "no Google account" branch
    // (no subprocess). yc is also unauthed here, so the block lists both failures.
    const block = await buildAuthPreflightBlock(sanitizedEnv, notAuthedRun, noAccount);
    expect(block).toContain("no Google account attached to this Gini instance");
    expect(block).toContain("REQUIRED ACTION:");
  });

  test("the default runner + account lookup are wired (real probe path, best-effort)", async () => {
    // Exercises the production defaults: buildAuthPreflightBlock() with only an
    // env runs realRun (a single cheap `bash -lc yc me` that 127s here) and
    // realAccountConfigDir. We assert only that it returns a string — the exact
    // content depends on this machine's yc/gws/accounts.json state — so the test
    // stays hermetic while keeping the default seams covered.
    const block = await buildAuthPreflightBlock({ ...sanitizedEnv, GINI_RELAY_PROVISIONED: "1" });
    expect(typeof block).toBe("string");
  });
});

describe("buildAuthPreflightBlock provisioned gate", () => {
  test("no-ops (empty string) when GINI_RELAY_PROVISIONED is absent", async () => {
    const env = { ...sanitizedEnv };
    delete (env as Record<string, string | undefined>).GINI_RELAY_PROVISIONED;
    const block = await buildAuthPreflightBlock(env, notAuthedRun);
    expect(block).toBe("");
  });

  test("no-ops (empty string) when GINI_RELAY_PROVISIONED is empty/whitespace", async () => {
    expect(await buildAuthPreflightBlock({ ...sanitizedEnv, GINI_RELAY_PROVISIONED: "" }, notAuthedRun)).toBe("");
    expect(await buildAuthPreflightBlock({ ...sanitizedEnv, GINI_RELAY_PROVISIONED: "   " }, notAuthedRun)).toBe("");
  });

  test("runs the checks when GINI_RELAY_PROVISIONED is set (non-empty block in a no-tools env)", async () => {
    const block = await buildAuthPreflightBlock({ ...sanitizedEnv, GINI_RELAY_PROVISIONED: "1" }, notAuthedRun);
    expect(block).toContain("AUTH PREFLIGHT");
  });
});
