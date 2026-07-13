// Unit tests for the Gmail label-discovery pipeline
// (src/runtime/label-discovery.ts): the deterministic fetch stage over a
// fake fetchImpl + injected gws spawn (the fetchMailbox-mirrored auth gate —
// plaintext credential first, gws export fallback for keyring-backed logins;
// the user-label filter incl. the routine's own Gini/ output namespace;
// per-label samples; best-effort enrichment), the digest validator's
// clamp-never-reject rules (name must match a real input label, bounds,
// palette colors, auto-archive pinned off), and the ensureLabelProfile guard
// (failed profile when every credential path fails, no double fire,
// ready/fresh-running skips, stale re-run). Hermetic: HOME + GINI_STATE_ROOT
// point at a per-test scratch dir, the echo provider stubs the digest call,
// and every gws spawn is injected — no gws binary, no network, no
// subprocess.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clearEchoStructuredResponses, setEchoStructuredResponse } from "../provider";
import { configDirForAccount } from "../state/google-accounts";
import { readLabelProfile, writeLabelProfile } from "../state/google-label-profiles";
import type { FetchImpl, GwsSpawn } from "./onboarding-scan";
import {
  buildLabelDigestPrompt,
  ensureLabelProfile,
  fetchLabelUsage,
  runLabelDiscovery,
  validateLabelDigest
} from "./label-discovery";
import type { GoogleAccount, RuntimeConfig } from "../types";

// The plaintext authorized_user credential the fetch stage reads (the same
// shape provisionAccount persists).
const CREDENTIALS = { type: "authorized_user", client_id: "cid-1", client_secret: "csec-9", refresh_token: "rtok-7" };

// A gws spawn that must never run: pins that a present plaintext
// credentials.json short-circuits the export fallback.
const neverSpawn: GwsSpawn = async () => {
  throw new Error("unexpected gws spawn");
};

// A keyring-established login with no plaintext file: `gws auth export
// --unmasked` emits its keyring preamble followed by the credential JSON.
function exportSpawn(): { gwsSpawn: GwsSpawn; calls: Array<{ args: string[]; configDir?: string }> } {
  const calls: Array<{ args: string[]; configDir?: string }> = [];
  const gwsSpawn: GwsSpawn = async (args, configDir) => {
    calls.push({ args, ...(configDir === undefined ? {} : { configDir }) });
    return `Using keyring for credential storage\n${JSON.stringify({ client_id: "cid-1", client_secret: "csec-9", refresh_token: "rtok-7" })}`;
  };
  return { gwsSpawn, calls };
}

// A signed-out dir: no plaintext file AND the export has nothing to emit.
const failedExportSpawn: GwsSpawn = async () => "No encrypted credentials found. Run 'gws auth login' first.";

// Fake fetch routing the token mint + the Gmail label/message endpoints from
// canned data, recording every request.
function fakeFetch(opts: {
  tokenStatus?: number;
  labels?: Array<{ id: string; name: string; type: string }>;
  details?: Record<string, { messagesTotal?: number }>;
  messageIdsByLabel?: Record<string, string[]>;
  metadata?: Record<string, { from?: string; subject?: string }>;
  failDetailIds?: string[];
}): { fetchImpl: FetchImpl; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    requests.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      const status = opts.tokenStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { access_token: "atok-1" } : { error: "invalid_grant" }), {
        status
      });
    }
    if (url.endsWith("/users/me/profile")) return Response.json({ emailAddress: "Me@Example.com" });
    if (url.endsWith("/users/me/labels")) return Response.json({ labels: opts.labels ?? [] });
    const detail = url.match(/\/users\/me\/labels\/([^/?]+)$/);
    if (detail) {
      if (opts.failDetailIds?.includes(detail[1]!)) return new Response("nope", { status: 500 });
      return Response.json(opts.details?.[detail[1]!] ?? {});
    }
    const list = url.match(/\/users\/me\/messages\?labelIds=([^&]+)&/);
    if (list) {
      return Response.json({ messages: (opts.messageIdsByLabel?.[list[1]!] ?? []).map((id) => ({ id })) });
    }
    const message = url.match(/\/users\/me\/messages\/([^?]+)\?format=metadata/);
    if (message) {
      const meta = opts.metadata?.[message[1]!] ?? {};
      const headers = [
        ...(meta.from ? [{ name: "From", value: meta.from }] : []),
        ...(meta.subject ? [{ name: "Subject", value: meta.subject }] : [])
      ];
      return Response.json({ payload: { headers } });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, requests };
}

describe("label discovery", () => {
  let root: string;
  let env: { HOME?: string; GINI_STATE_ROOT?: string };

  beforeEach(() => {
    env = { HOME: process.env.HOME, GINI_STATE_ROOT: process.env.GINI_STATE_ROOT };
    root = `/tmp/gini-label-discovery-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "home"), { recursive: true });
    process.env.HOME = join(root, "home");
    process.env.GINI_STATE_ROOT = join(root, "state");
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key as keyof typeof env];
      else process.env[key as keyof typeof env] = value;
    }
    clearEchoStructuredResponses();
  });

  function seedAccount(id: string, email: string, withCredentials: boolean): GoogleAccount {
    const configDir = configDirForAccount(id);
    if (withCredentials) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "credentials.json"), JSON.stringify(CREDENTIALS));
    }
    return { id, tag: id, email, configDir, addedAt: new Date().toISOString() };
  }

  test("fetchLabelUsage mirrors the fetchMailbox auth gate and assembles per-label usage", async () => {
    // No credentials.json AND a failed export ⇒ no token attempt, no Gmail read.
    const gated = fakeFetch({});
    expect(
      await fetchLabelUsage(failedExportSpawn, { configDir: configDirForAccount("gacct_none"), fetchImpl: gated.fetchImpl })
    ).toEqual({ tokenValid: false });
    expect(gated.requests).toEqual([]);

    const account = seedAccount("gacct_fetch", "me@example.com", true);
    const { fetchImpl } = fakeFetch({
      labels: [
        { id: "L1", name: " Receipts ", type: "user" },
        { id: "SPAM", name: "SPAM", type: "system" },
        { id: "L2", name: "Clients", type: "user" }
      ],
      details: { L1: { messagesTotal: 42 }, L2: { messagesTotal: 7 } },
      messageIdsByLabel: { L1: ["m1", "m2"], L2: [] },
      metadata: {
        m1: { from: "Amazon <ship@amazon.com>", subject: "Your order shipped" },
        m2: { from: "Stripe <receipts@stripe.com>", subject: "x".repeat(200) }
      }
    });
    const fetched = await fetchLabelUsage(neverSpawn, { configDir: account.configDir, fetchImpl });
    if (!fetched.tokenValid) throw new Error("expected a valid token");
    // System labels are never the user's scheme; names trim; the email
    // lowercases; oversized sample subjects truncate.
    expect(fetched.bundle.email).toBe("me@example.com");
    expect(fetched.bundle.labels.map((label) => label.name)).toEqual(["Receipts", "Clients"]);
    expect(fetched.bundle.labels[0]).toEqual({
      name: "Receipts",
      messagesTotal: 42,
      samples: [
        { from: "Amazon <ship@amazon.com>", subject: "Your order shipped" },
        { from: "Stripe <receipts@stripe.com>", subject: "x".repeat(120) }
      ]
    });
    expect(fetched.bundle.labels[1]).toEqual({ name: "Clients", messagesTotal: 7, samples: [] });

    // A refused mint is the same tokenValid:false gate.
    const refused = fakeFetch({ tokenStatus: 400 });
    expect(await fetchLabelUsage(neverSpawn, { configDir: account.configDir, fetchImpl: refused.fetchImpl })).toEqual({
      tokenValid: false
    });

    // A single label's enrichment failing keeps its name-only entry.
    const flaky = fakeFetch({
      labels: [
        { id: "L1", name: "Receipts", type: "user" },
        { id: "L2", name: "Clients", type: "user" }
      ],
      details: { L2: { messagesTotal: 7 } },
      messageIdsByLabel: { L2: [] },
      failDetailIds: ["L1"]
    });
    const partial = await fetchLabelUsage(neverSpawn, { configDir: account.configDir, fetchImpl: flaky.fetchImpl });
    if (!partial.tokenValid) throw new Error("expected a valid token");
    expect(partial.bundle.labels).toEqual([
      { name: "Receipts", samples: [] },
      { name: "Clients", messagesTotal: 7, samples: [] }
    ]);
  });

  test("a keyring-backed account (no credentials.json) succeeds via the gws export fallback", async () => {
    const account = seedAccount("gacct_keyring", "me@example.com", false);
    const { fetchImpl } = fakeFetch({
      labels: [{ id: "L1", name: "Receipts", type: "user" }],
      details: { L1: { messagesTotal: 5 } },
      messageIdsByLabel: { L1: [] }
    });
    const exported = exportSpawn();
    setEchoStructuredResponse("gmail-label-digest", { labels: [{ name: "Receipts", rule: "Receipts and invoices" }] });
    const outcome = await runLabelDiscovery(echoConfig(), account, { gwsSpawn: exported.gwsSpawn, fetchImpl });
    expect(outcome).toEqual({
      status: "ready",
      email: "me@example.com",
      labels: [{ name: "Receipts", color: "#4277FB", rule: "Receipts and invoices", autoArchive: false }],
      sourceLabelCount: 1
    });
    // Exactly one export spawn, targeted at THIS account's config dir.
    expect(exported.calls).toEqual([{ args: ["auth", "export", "--unmasked"], configDir: account.configDir }]);
  });

  test("the routine's own Gini/ labels never reach the digest input, count, or output", async () => {
    const account = seedAccount("gacct_gini", "me@example.com", true);
    const { fetchImpl, requests } = fakeFetch({
      labels: [
        { id: "L1", name: "Receipts", type: "user" },
        { id: "LG1", name: "Gini/updates", type: "user" },
        { id: "LG2", name: "Gini/action needed", type: "user" },
        { id: "L2", name: "gini/personal", type: "user" }
      ],
      details: { L1: { messagesTotal: 3 } },
      messageIdsByLabel: { L1: [], L2: [] }
    });
    // The fetch stage drops the namespace entirely: never in the bundle,
    // never enriched. The match is case-sensitive — "gini/personal" is a
    // user's own label, not the routine's output, and stays.
    const fetched = await fetchLabelUsage(neverSpawn, { configDir: account.configDir, fetchImpl });
    if (!fetched.tokenValid) throw new Error("expected a valid token");
    expect(fetched.bundle.labels.map((label) => label.name)).toEqual(["Receipts", "gini/personal"]);
    expect(buildLabelDigestPrompt(fetched.bundle).user).not.toContain("Gini/");
    expect(requests.some((url) => url.includes("LG"))).toBe(false);

    // Even a model echoing a Gini/ name can't smuggle it into the profile:
    // the validator only accepts names present in the (already filtered)
    // input, and sourceLabelCount counts only that input.
    setEchoStructuredResponse("gmail-label-digest", {
      labels: [
        { name: "Gini/updates", rule: "echoed our own label" },
        { name: "Receipts", rule: "Order receipts" }
      ]
    });
    const outcome = await runLabelDiscovery(echoConfig(), account, { gwsSpawn: neverSpawn, fetchImpl });
    expect(outcome).toEqual({
      status: "ready",
      email: "me@example.com",
      labels: [{ name: "Receipts", color: "#4277FB", rule: "Order receipts", autoArchive: false }],
      sourceLabelCount: 2
    });
  });

  test("the digest prompt renders the usage evidence and the untrusted-data rule", () => {
    const prompt = buildLabelDigestPrompt({
      email: "me@example.com",
      labels: [{ name: "Receipts", messagesTotal: 42, samples: [{ from: "Amazon", subject: "Order" }] }]
    });
    expect(prompt.system).toContain("UNTRUSTED mailbox content");
    expect(prompt.system).toContain("EXACTLY one of the existing label names");
    expect(prompt.user).toContain("Name: Receipts");
    expect(prompt.user).toContain("Messages: 42");
    expect(prompt.user).toContain("Sample: From: Amazon | Subject: Order");
  });

  test("validateLabelDigest clamps to real input labels and pins auto-archive off", () => {
    const source = ["Receipts", "Clients", "x".repeat(61)];
    // Names match case-insensitively but emit the input's exact spelling;
    // invented names, duplicates, junk entries, and over-cap input names
    // drop; rules truncate; colors come from the palette by position.
    const labels = validateLabelDigest(
      {
        labels: [
          { name: "receipts", rule: `  ${"r".repeat(600)}` },
          { name: "Invented", rule: "nope" },
          { name: "RECEIPTS", rule: "duplicate" },
          "junk",
          { name: 5, rule: "wrong type" },
          { name: "x".repeat(61), rule: "over-cap input name" },
          { name: "Clients", rule: "Emails from client contacts", autoArchive: true }
        ]
      },
      source
    )!;
    expect(labels).toEqual([
      { name: "Receipts", color: "#4277FB", rule: "r".repeat(500), autoArchive: false },
      { name: "Clients", color: "#12B5C4", rule: "Emails from client contacts", autoArchive: false }
    ]);

    // The cap keeps the first twelve matches.
    const many = Array.from({ length: 20 }, (_, i) => `Label ${i}`);
    expect(validateLabelDigest({ labels: many.map((name) => ({ name, rule: "" })) }, many)!.length).toBe(12);

    // A shape violation (no labels array) is a model failure, not a clamp.
    expect(validateLabelDigest({}, source)).toBeUndefined();
    expect(validateLabelDigest({ labels: "nope" }, source)).toBeUndefined();
  });

  test("runLabelDiscovery digests via one structured call and never throws", async () => {
    const account = seedAccount("gacct_run", "me@example.com", true);
    const { fetchImpl } = fakeFetch({
      labels: [
        { id: "L1", name: "Receipts", type: "user" },
        { id: "L2", name: "Clients", type: "user" }
      ],
      details: {},
      messageIdsByLabel: {}
    });
    setEchoStructuredResponse("gmail-label-digest", {
      labels: [{ name: "Receipts", rule: "Order confirmations and payment receipts" }]
    });
    const outcome = await runLabelDiscovery(echoConfig(), account, { gwsSpawn: neverSpawn, fetchImpl });
    expect(outcome).toEqual({
      status: "ready",
      email: "me@example.com",
      labels: [{ name: "Receipts", color: "#4277FB", rule: "Order confirmations and payment receipts", autoArchive: false }],
      sourceLabelCount: 2
    });

    // A mailbox with no user labels is ready-and-empty without a model call
    // (the unstubbed echo default {} would fail the validator if reached).
    clearEchoStructuredResponses();
    const empty = fakeFetch({ labels: [{ id: "SPAM", name: "SPAM", type: "system" }] });
    expect(await runLabelDiscovery(echoConfig(), account, { gwsSpawn: neverSpawn, fetchImpl: empty.fetchImpl })).toEqual({
      status: "ready",
      email: "me@example.com",
      labels: [],
      sourceLabelCount: 0
    });

    // A signed-out account (no plaintext file, empty export) resolves to
    // failed — never a throw.
    const gone = seedAccount("gacct_gone", "gone@example.com", false);
    const failed = await runLabelDiscovery(echoConfig(), gone, {
      gwsSpawn: failedExportSpawn,
      fetchImpl: fakeFetch({}).fetchImpl
    });
    expect(failed.status).toBe("failed");
  });

  test("ensureLabelProfile records a failed profile when the plaintext credential and the export both fail", async () => {
    const account = seedAccount("gacct_nocred", "NoCred@Example.com", false);
    ensureLabelProfile(echoConfig(), account, { gwsSpawn: failedExportSpawn, fetchImpl: fakeFetch({}).fetchImpl });
    // Whether a credential exists is the async run's call now: the record
    // starts running and resolves to failed.
    expect(readLabelProfile(account.id)!.status).toBe("running");
    await waitForStatus(account.id, "failed");
    const profile = readLabelProfile(account.id)!;
    expect(profile.email).toBe("nocred@example.com");
    expect(profile.labels).toEqual([]);
    expect(profile.error).toContain("No signed-in Google session");
  });

  test("ensureLabelProfile fires once, skips ready/fresh-running, and re-runs stale-running", async () => {
    const account = seedAccount("gacct_guard", "me@example.com", true);
    const { fetchImpl, requests } = fakeFetch({
      labels: [{ id: "L1", name: "Receipts", type: "user" }],
      details: { L1: { messagesTotal: 3 } },
      messageIdsByLabel: { L1: [] }
    });
    setEchoStructuredResponse("gmail-label-digest", { labels: [{ name: "Receipts", rule: "Receipts" }] });

    const config = echoConfig();
    ensureLabelProfile(config, account, { gwsSpawn: neverSpawn, fetchImpl });
    // The running record lands synchronously; a second call while in flight
    // is a no-op (in-memory guard).
    expect(readLabelProfile(account.id)!.status).toBe("running");
    ensureLabelProfile(config, account, { gwsSpawn: neverSpawn, fetchImpl });
    await waitForStatus(account.id, "ready");
    const ready = readLabelProfile(account.id)!;
    expect(ready.labels.map((label) => label.name)).toEqual(["Receipts"]);
    expect(ready.sourceLabelCount).toBe(1);
    const mintsAfterFirst = requests.filter((url) => url.includes("oauth2")).length;
    expect(mintsAfterFirst).toBe(1);

    // Ready skips — no new pipeline, no new requests.
    ensureLabelProfile(config, account, { gwsSpawn: neverSpawn, fetchImpl });
    expect(requests.filter((url) => url.includes("oauth2")).length).toBe(1);

    // A fresh running record (younger than the stale window) skips too.
    writeLabelProfile({
      version: 1,
      accountId: account.id,
      email: "me@example.com",
      status: "running",
      labels: [],
      startedAt: new Date().toISOString()
    });
    ensureLabelProfile(config, account, { gwsSpawn: neverSpawn, fetchImpl });
    expect(requests.filter((url) => url.includes("oauth2")).length).toBe(1);

    // A stale running record (orphaned by a process death) re-runs.
    writeLabelProfile({
      version: 1,
      accountId: account.id,
      email: "me@example.com",
      status: "running",
      labels: [],
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString()
    });
    ensureLabelProfile(config, account, { gwsSpawn: neverSpawn, fetchImpl });
    await waitForStatus(account.id, "ready");
    expect(requests.filter((url) => url.includes("oauth2")).length).toBe(2);
  });
});

// Poll (never sleep-and-hope) for the background pipeline to finalize.
async function waitForStatus(accountId: string, status: "ready" | "failed"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readLabelProfile(accountId)?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`Label profile for ${accountId} did not reach ${status}`);
}

function echoConfig(): RuntimeConfig {
  return {
    instance: `label-discovery-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: join(process.env.GINI_STATE_ROOT ?? "/tmp", "instances", "label-discovery"),
    logRoot: "/tmp/logs",
    approvalMode: "strict"
  };
}
