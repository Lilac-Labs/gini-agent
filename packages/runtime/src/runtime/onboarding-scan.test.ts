// Unit tests for the deterministic Gmail profile-scan pipeline
// (src/runtime/onboarding-scan.ts). A fake `gwsSpawn` serves the one
// `auth export --unmasked` call and a fake `fetchImpl` routes the token mint +
// every Gmail read, so fetchMailbox is exercised without a binary or network;
// the echo provider stubs the three parallel synthesis calls so runProfileScan
// never reaches a model. Hermetic: GINI_STATE_ROOT points at a scratch dir so
// providerOverrideForRuntime's state read never touches the developer machine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { clearEchoStructuredResponses, setEchoStructuredResponse } from "../provider";
import type { FetchImpl, GwsSpawn } from "./onboarding-scan";
import { buildProfilePrompt, buildRoutinesPrompt, buildTasksPrompt, fetchMailbox, runProfileScan } from "./onboarding-scan";
import type { RuntimeConfig } from "../types";

// Base64url-encode a plain-text body the way Gmail returns part data.
function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

// The credential document `gws auth export --unmasked` emits, preceded by the
// keyring preamble the tolerant first-`{` parse must skip.
const EXPORT_CREDS = { client_id: "cid-1", client_secret: "csec-9", refresh_token: "rtok-7", type: "authorized_user" };
const EXPORT_STDOUT = `Using system keyring\n${JSON.stringify(EXPORT_CREDS)}`;

// Fake gws spawn: the pipeline's ONLY subprocess is `auth export --unmasked`.
function fakeExportSpawn(stdout: string = EXPORT_STDOUT): { spawn: GwsSpawn; calls: string[][]; configDirs: (string | undefined)[] } {
  const calls: string[][] = [];
  const configDirs: (string | undefined)[] = [];
  const spawn: GwsSpawn = async (args, configDir) => {
    calls.push(args);
    configDirs.push(configDir);
    return stdout;
  };
  return { spawn, calls, configDirs };
}

// Fake fetch routing the token endpoint + the Gmail endpoints from canned
// data. Records every request (with its Authorization header and token-mint
// body) and tracks the max number of Gmail requests in flight at once.
function fakeFetch(opts: {
  tokenStatus?: number;
  tokenBody?: unknown;
  selfEmail?: string;
  inboxIds?: string[];
  sentIds?: string[];
  threadIds?: Record<string, string>;
  metadata?: Record<string, { from?: string; to?: string; subject?: string; date?: string; snippet?: string }>;
  bodies?: Record<string, string>;
  failMetadataIds?: string[];
  failBodyIds?: string[];
  failThreadIds?: string[];
  failList?: "inbox" | "sent";
  delayMs?: number;
}): {
  fetchImpl: FetchImpl;
  gmailRequests: { url: string; auth?: string }[];
  tokenBodies: string[];
  maxInFlight: () => number;
} {
  const gmailRequests: { url: string; auth?: string }[] = [];
  const tokenBodies: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenBodies.push(String(init?.body ?? ""));
      const status = opts.tokenStatus ?? 200;
      const body = opts.tokenBody ?? (status === 200 ? { access_token: "atok-1" } : { error: "invalid_grant" });
      return new Response(JSON.stringify(body), { status });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    gmailRequests.push({ url, ...(auth ? { auth } : {}) });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      if (url.includes("/users/me/profile")) {
        return Response.json(opts.selfEmail ? { emailAddress: opts.selfEmail } : {});
      }
      if (url.includes("/users/me/messages?")) {
        const q = new URL(url).searchParams.get("q") ?? "";
        const isSent = q.includes("in:sent");
        if (opts.failList === (isSent ? "sent" : "inbox")) return new Response("boom", { status: 500 });
        const ids = (isSent ? opts.sentIds : opts.inboxIds) ?? [];
        return Response.json({ messages: ids.map((id) => ({ id, threadId: opts.threadIds?.[id] ?? id })) });
      }
      const threadMatch = url.match(/\/users\/me\/threads\/([^?]+)\?/);
      if (threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1]!);
        if (opts.failThreadIds?.includes(threadId)) return new Response("boom", { status: 500 });
        const ids = [...(opts.inboxIds ?? []), ...(opts.sentIds ?? [])].filter(
          (id) => (opts.threadIds?.[id] ?? id) === threadId && !opts.failMetadataIds?.includes(id)
        );
        return Response.json({
          id: threadId,
          messages: ids.map((id) => {
            const meta = opts.metadata?.[id] ?? {};
            const headers = [
              meta.from ? { name: "From", value: meta.from } : undefined,
              meta.to ? { name: "To", value: meta.to } : undefined,
              meta.subject ? { name: "Subject", value: meta.subject } : undefined,
              meta.date ? { name: "Date", value: meta.date } : undefined
            ].filter(Boolean);
            const body = opts.failBodyIds?.includes(id) ? undefined : opts.bodies?.[id];
            return {
              id,
              threadId,
              internalDate: String(Date.parse(meta.date ?? "") || 0),
              snippet: meta.snippet,
              payload: {
                headers,
                ...(body ? { mimeType: "text/plain", body: { data: b64(body) } } : {})
              }
            };
          })
        });
      }
      const match = url.match(/\/users\/me\/messages\/([^?]+)\?(.*)$/);
      if (match) {
        const id = match[1]!;
        if (match[2]!.includes("format=full")) {
          if (opts.failBodyIds?.includes(id)) return new Response("boom", { status: 500 });
          const meta = opts.metadata?.[id] ?? {};
          const headers = [
            meta.from ? { name: "From", value: meta.from } : undefined,
            meta.to ? { name: "To", value: meta.to } : undefined,
            meta.subject ? { name: "Subject", value: meta.subject } : undefined,
            meta.date ? { name: "Date", value: meta.date } : undefined
          ].filter(Boolean);
          const body = opts.bodies?.[id];
          return Response.json({
            snippet: opts.metadata?.[id]?.snippet,
            payload: {
              headers,
              ...(body ? { mimeType: "text/plain", body: { data: b64(body) } } : {})
            }
          });
        }
        if (opts.failMetadataIds?.includes(id)) return new Response("boom", { status: 500 });
        const meta = opts.metadata?.[id] ?? {};
        const headers = [
          meta.from ? { name: "From", value: meta.from } : undefined,
          meta.to ? { name: "To", value: meta.to } : undefined,
          meta.subject ? { name: "Subject", value: meta.subject } : undefined,
          meta.date ? { name: "Date", value: meta.date } : undefined
        ].filter(Boolean);
        return Response.json({ snippet: meta.snippet, payload: { headers } });
      }
      return new Response("not found", { status: 404 });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, gmailRequests, tokenBodies, maxInFlight: () => peak };
}

describe("onboarding scan pipeline", () => {
  let root: string;
  let priorStateRoot: string | undefined;

  beforeEach(() => {
    priorStateRoot = process.env.GINI_STATE_ROOT;
    root = `/tmp/gini-onboarding-scan-tests/${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    process.env.GINI_STATE_ROOT = join(root, "state");
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (priorStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = priorStateRoot;
    clearEchoStructuredResponses();
  });

  test("fetchMailbox mints one token from the exported credentials and assembles the bundle over HTTP", async () => {
    const { spawn, calls, configDirs } = fakeExportSpawn();
    const { fetchImpl, gmailRequests, tokenBodies } = fakeFetch({
      selfEmail: "me@example.com",
      inboxIds: ["i1", "i2"],
      sentIds: ["s1"],
      metadata: {
        i1: { from: "boss@corp.com", to: "me@example.com", subject: "Q3 plan", date: "Mon", snippet: "let's sync" },
        i2: { from: "vendor@x.com", subject: "invoice", snippet: "amount due" },
        s1: { from: "me@example.com", to: "boss@corp.com", subject: "Re: Q3 plan", snippet: "sounds good" }
      },
      bodies: { i1: "Full body of the Q3 plan email." }
    });

    const result = await fetchMailbox(spawn, { configDir: "/tmp/acct", fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    // The ONLY subprocess is the credential export, against the account's dir.
    expect(calls).toEqual([["auth", "export", "--unmasked"]]);
    expect(configDirs).toEqual(["/tmp/acct"]);
    // Exactly one mint, carrying the exported refresh credentials.
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]).toContain("grant_type=refresh_token");
    expect(tokenBodies[0]).toContain("refresh_token=rtok-7");
    expect(tokenBodies[0]).toContain("client_id=cid-1");
    // Every Gmail read reuses the single minted bearer token.
    expect(gmailRequests.length).toBeGreaterThan(0);
    expect(gmailRequests.every((r) => r.auth === "Bearer atok-1")).toBe(true);
    // Bundle shape is identical to the subprocess-era pipeline's.
    expect(result.bundle.selfEmail).toBe("me@example.com");
    expect(result.bundle.inbox).toHaveLength(2);
    expect(result.bundle.inbox[0]?.from).toBe("boss@corp.com");
    expect(result.bundle.inbox[0]?.subject).toBe("Q3 plan");
    // The most-recent inbox message gets its full body fetched.
    expect(result.bundle.inbox[0]?.body).toBe("Full body of the Q3 plan email.");
    expect(result.bundle.sent).toHaveLength(1);
    expect(result.bundle.sent[0]?.subject).toBe("Re: Q3 plan");
    // Sent messages are metadata-only (voice evidence, not content).
    expect(result.bundle.sent[0]?.body).toBeUndefined();
    // Inbox + sent messages sharing a Gmail thread are downloaded once, and
    // the complete normalized thread is handed to the later People backfill.
    expect(gmailRequests.filter((r) => r.url.includes("/threads/")).length).toBe(3);
    expect(result.snapshot.threads.map((thread) => thread.threadId)).toEqual(["i1", "i2", "s1"]);
  });

  test("fetchMailbox treats a garbled or credential-less export as signed out without touching the network", async () => {
    const noJson = fakeExportSpawn("gws: no stored credentials");
    const noJsonFetch = fakeFetch({});
    const garbled = await fetchMailbox(noJson.spawn, { fetchImpl: noJsonFetch.fetchImpl });
    expect(garbled.tokenValid).toBe(false);
    expect(noJsonFetch.tokenBodies).toHaveLength(0);
    expect(noJsonFetch.gmailRequests).toHaveLength(0);

    const noRefresh = fakeExportSpawn(JSON.stringify({ client_id: "cid-1", client_secret: "csec-9" }));
    const noRefreshFetch = fakeFetch({});
    const missing = await fetchMailbox(noRefresh.spawn, { fetchImpl: noRefreshFetch.fetchImpl });
    expect(missing.tokenValid).toBe(false);
    expect(noRefreshFetch.tokenBodies).toHaveLength(0);
    expect(noRefreshFetch.gmailRequests).toHaveLength(0);
  });

  test("fetchMailbox treats a refused token mint as signed out without a Gmail request", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl, gmailRequests, tokenBodies } = fakeFetch({ tokenStatus: 400, inboxIds: ["i1"] });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(false);
    expect(tokenBodies).toHaveLength(1);
    expect(gmailRequests).toHaveLength(0);
  });

  test("fetchMailbox caps the inbox window and the body-fetch count", async () => {
    const inboxIds = Array.from({ length: 80 }, (_, i) => `i${i}`);
    const metadata = Object.fromEntries(inboxIds.map((id) => [id, { from: `${id}@x.com`, subject: id }]));
    const { spawn } = fakeExportSpawn();
    const bodies = Object.fromEntries(inboxIds.map((id) => [id, `body ${id}`]));
    const { fetchImpl, gmailRequests } = fakeFetch({ selfEmail: "me@example.com", inboxIds, sentIds: [], metadata, bodies });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    // The list request itself asks Gmail for at most 50 recent inbox messages.
    const listUrls = gmailRequests.filter((r) => r.url.includes("/users/me/messages?"));
    expect(listUrls[0]?.url).toContain("maxResults=50");
    // The inbox is capped at 50 messages regardless of how many were listed.
    expect(result.bundle.inbox).toHaveLength(50);
    // Each unique recent thread is fetched once. Only the first 15 inbox
    // messages expose bodies to the synthesis prompt even though the reusable
    // thread snapshot contains normalized content for People.
    const fullGets = gmailRequests.filter((r) => r.url.includes("/threads/") && r.url.includes("format=full"));
    expect(fullGets).toHaveLength(50);
    expect(result.bundle.inbox.filter((message) => message.body !== undefined)).toHaveLength(15);
  });

  test("fetchMailbox runs message gets in parallel with at most 8 in flight", async () => {
    const inboxIds = Array.from({ length: 20 }, (_, i) => `i${i}`);
    const metadata = Object.fromEntries(inboxIds.map((id) => [id, { from: `${id}@x.com`, subject: id }]));
    const { spawn } = fakeExportSpawn();
    const { fetchImpl, maxInFlight } = fakeFetch({ selfEmail: "me@example.com", inboxIds, sentIds: [], metadata, delayMs: 2 });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    expect(result.bundle.inbox).toHaveLength(20);
    // The worker pool overlaps requests but never exceeds the concurrency cap.
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
  });

  test("fetchMailbox downloads a shared inbox/sent thread once and snapshots every message in it", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl, gmailRequests } = fakeFetch({
      selfEmail: "me@example.com",
      inboxIds: ["i1"],
      sentIds: ["s1"],
      threadIds: { i1: "t-shared", s1: "t-shared" },
      metadata: {
        i1: { from: "boss@corp.com", to: "me@example.com", subject: "Plan", date: "2026-07-13T10:00:00Z" },
        s1: { from: "me@example.com", to: "boss@corp.com", subject: "Re: Plan", date: "2026-07-13T11:00:00Z" }
      },
      bodies: { i1: "Can we review this?", s1: "Yes, this afternoon." }
    });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    expect(gmailRequests.filter((request) => request.url.includes("/threads/t-shared?format=full"))).toHaveLength(1);
    expect(result.bundle.inbox[0]?.body).toBe("Can we review this?");
    expect(result.bundle.sent[0]?.body).toBeUndefined();
    expect(result.snapshot.threads).toHaveLength(1);
    expect(result.snapshot.threads[0]?.messages.map((message) => message.id)).toEqual(["i1", "s1"]);
  });

  test("fetchMailbox drops a message whose get fails and keeps a metadata-only message on a body failure", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({
      selfEmail: "me@example.com",
      inboxIds: ["i1", "i2", "i3"],
      sentIds: [],
      metadata: {
        i1: { from: "a@x.com", subject: "one" },
        i2: { from: "b@x.com", subject: "two" },
        i3: { from: "c@x.com", subject: "three" }
      },
      bodies: { i1: "body one", i3: "body three" },
      failMetadataIds: ["i2"],
      failBodyIds: ["i1"]
    });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    // i2's metadata get 500ed — that message drops, the others survive.
    expect(result.bundle.inbox.map((m) => m.subject)).toEqual(["one", "three"]);
    // i1's body get 500ed — the metadata-only message is kept.
    expect(result.bundle.inbox[0]?.body).toBeUndefined();
    expect(result.bundle.inbox[1]?.body).toBe("body three");
  });

  test("fetchMailbox falls back to the prior per-message path when a full thread read fails", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl, gmailRequests } = fakeFetch({
      selfEmail: "me@example.com",
      inboxIds: ["i1"],
      sentIds: [],
      metadata: {
        i1: { from: "boss@corp.com", to: "me@example.com", subject: "Fallback", date: "2026-07-13T10:00:00Z" }
      },
      bodies: { i1: "Still available through messages.get." },
      failThreadIds: ["i1"]
    });

    const result = await fetchMailbox(spawn, { fetchImpl });

    expect(result.tokenValid).toBe(true);
    if (!result.tokenValid) throw new Error("unreachable");
    expect(result.bundle.inbox[0]).toMatchObject({ subject: "Fallback", body: "Still available through messages.get." });
    expect(result.snapshot.threads).toEqual([]);
    expect(gmailRequests.some((request) => request.url.includes("/messages/i1?format=full"))).toBe(true);
  });

  test("a list-level failure fails the scan", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({ selfEmail: "me@example.com", inboxIds: ["i1"], failList: "inbox" });

    await expect(fetchMailbox(spawn, { fetchImpl })).rejects.toThrow("Gmail request failed");

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain("Gmail request failed");
  });

  test("runProfileScan maps all three synthesis calls to one ready scan", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({
      selfEmail: "me@example.com",
      inboxIds: ["i1"],
      sentIds: [],
      metadata: { i1: { from: "boss@corp.com", subject: "hi" } }
    });
    setEchoStructuredResponse("onboarding-scan-profile", {
      profile: { displayName: "Ada Lovelace", sections: [{ title: "Professional Identity", bullets: ["Engineer"] }] }
    });
    setEchoStructuredResponse("onboarding-scan-tasks", { suggestedTasks: ["Reply to boss about the plan"] });
    setEchoStructuredResponse("onboarding-scan-routines", {
      suggestedRoutines: [
        {
          name: "Draft a weekly founder update",
          description: "Turn recent work and email context into a founder-update draft for review.",
          usesEmail: true
        }
      ]
    });

    const snapshots: string[][] = [];
    const outcome = await runProfileScan(echoConfig(), {
      gwsSpawn: spawn,
      fetchImpl,
      onMailboxFetched: (snapshot) => snapshots.push(snapshot.threads.map((thread) => thread.threadId))
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("unreachable");
    expect(outcome.profile.displayName).toBe("Ada Lovelace");
    expect(outcome.suggestedTasks).toEqual(["Reply to boss about the plan"]);
    expect(snapshots).toEqual([["i1"]]);
    expect(outcome.suggestedRoutines).toEqual([
      {
        name: "Draft a weekly founder update",
        description: "Turn recent work and email context into a founder-update draft for review.",
        usesEmail: true
      }
    ]);
  });

  test("runProfileScan fails instead of dropping rejected task suggestions", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({ selfEmail: "me@example.com", inboxIds: [], sentIds: [] });
    setEchoStructuredResponse("onboarding-scan-profile", {
      profile: { displayName: "Ada Lovelace", sections: [] }
    });
    // The invalid stub rejects both the parallel attempt and its one retry.
    // The scan must stay retryable instead of silently seeding generic tasks.
    setEchoStructuredResponse("onboarding-scan-tasks", { suggestedTasks: "not a list" });
    setEchoStructuredResponse("onboarding-scan-routines", {
      suggestedRoutines: [
        { name: "Track customer themes", description: "Review customer threads each week and draft a theme brief.", usesEmail: true }
      ]
    });

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain("suggestedTasks contract");
  });

  test("runProfileScan keeps task suggestions when the routines call fails", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({ selfEmail: "me@example.com", inboxIds: [], sentIds: [] });
    setEchoStructuredResponse("onboarding-scan-profile", {
      profile: { displayName: "Ada Lovelace", sections: [] }
    });
    setEchoStructuredResponse("onboarding-scan-tasks", { suggestedTasks: ["Reply to boss"] });
    setEchoStructuredResponse("onboarding-scan-routines", { suggestedRoutines: "not a list" });

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("unreachable");
    expect(outcome.suggestedTasks).toEqual(["Reply to boss"]);
    expect(outcome.suggestedRoutines).toBeUndefined();
  });

  test("runProfileScan fails when the profile call misses the profile contract", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl } = fakeFetch({ selfEmail: "me@example.com", inboxIds: [], sentIds: [] });
    // The tasks call succeeding cannot rescue a failed profile call.
    setEchoStructuredResponse("onboarding-scan-profile", { profile: { sections: [] } });
    setEchoStructuredResponse("onboarding-scan-tasks", { suggestedTasks: ["Reply to boss"] });
    setEchoStructuredResponse("onboarding-scan-routines", { suggestedRoutines: [] });

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });

    expect(outcome.status).toBe("failed");
  });

  test("runProfileScan surfaces a failed mint as the no-session error without leaking credentials", async () => {
    const { spawn } = fakeExportSpawn();
    const { fetchImpl, gmailRequests } = fakeFetch({ tokenStatus: 400, tokenBody: { error: "invalid_grant", error_description: "rtok-7 csec-9" } });

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain("signed-in");
    // The exported secrets and the token endpoint's response body never reach
    // the user-facing error.
    expect(outcome.error).not.toContain("rtok-7");
    expect(outcome.error).not.toContain("csec-9");
    expect(outcome.error).not.toContain("cid-1");
    expect(outcome.error).not.toContain("invalid_grant");
    // No Gmail request (and no synthesis) fired.
    expect(gmailRequests).toHaveLength(0);
  });

  test("runProfileScan fails (never throws) when the gws spawn rejects", async () => {
    const spawn: GwsSpawn = async () => {
      throw new Error("gws not found");
    };
    const { fetchImpl } = fakeFetch({});

    const outcome = await runProfileScan(echoConfig(), { gwsSpawn: spawn, fetchImpl });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain("gws not found");
  });

  test("buildProfilePrompt carries the profile content rules verbatim", () => {
    const { system } = buildProfilePrompt({
      selfEmail: "me@example.com",
      inbox: [{ from: "a@b.com", subject: "hi" }],
      sent: []
    });

    // Section order + titles, person-centric guardrails, and the displayName
    // form must all survive the split.
    for (const marker of [
      "Professional Identity",
      "Communication Style",
      "Work Patterns",
      "Personal Details",
      "Key Contacts Sample",
      "SENT mail",
      '"Name (legal name: X)"',
      "Do NOT put invoices, receipts, vendor charges",
      "belong ONLY in suggestedTasks",
      "Keep every bullet to a single short sentence."
    ]) {
      expect(system).toContain(marker);
    }
    // The tasks deliverable's rules live in the OTHER call.
    expect(system).not.toContain("up to 10 high-value concrete tasks");
    expect(system).not.toContain("Check who sent the LAST message");
  });

  test("buildTasksPrompt carries the suggestedTasks rules verbatim", () => {
    const { system } = buildTasksPrompt({
      selfEmail: "me@example.com",
      inbox: [{ from: "a@b.com", subject: "hi" }],
      sent: []
    });

    // The shapes, who-wrote-last check, title-only form, one-per-thread cap,
    // and ranking rules must all survive the split.
    for (const marker of [
      "work Gini can complete on its own",
      "up to 10 high-value concrete tasks",
      "Check who sent the LAST message",
      "draft a follow-up for an email the USER sent that got no response",
      "6–12 words",
      "their organization when the mailbox supports it",
      'Reply titles must begin "Draft a reply to"',
      "Never output a generic selector",
      "summaries are not starter tasks",
      "At most ONE task per email thread",
      "never restate or re-send what the user already said",
      "must never displace an important thread",
      "Never suggest a task the user must perform themselves"
    ]) {
      expect(system).toContain(marker);
    }
    // The profile deliverable's rules live in the OTHER call.
    expect(system).not.toContain("Communication Style");
    expect(system).not.toContain("displayName");
  });

  test("buildRoutinesPrompt requires evidence that work repeats", () => {
    const { system } = buildRoutinesPrompt({
      selfEmail: "me@example.com",
      inbox: [{ from: "a@b.com", subject: "hi" }],
      sent: []
    });

    for (const marker of [
      "up to 5 high-value recurring automations",
      "at least two separate messages or threads",
      "an explicit recurring cadence or trigger",
      "Do not infer a routine from a single email",
      "return fewer than 3",
      "repeated trigger and a repeatable outcome",
      "category-triggered triage and draft replies",
      "stakeholder or project update drafts",
      "spend, invoice, usage, or operations recaps",
      "credits, benefits, renewals, or expirations",
      "abstract archetypes, not templates",
      "generic inbox triage",
      "Auto-inbox, Morning Briefing, or Meeting Briefing",
      "usesEmail true",
      "no speculation, sensitive-trait inference"
    ]) {
      expect(system).toContain(marker);
    }
    expect(system).not.toContain("Check who sent the LAST message");
    expect(system).not.toContain("displayName");
  });

  test("all prompts render the same mailbox as untrusted evidence", () => {
    const bundle = {
      selfEmail: "me@example.com",
      inbox: [{ from: "boss@corp.com", subject: "Q3", snippet: "sync please", body: "the full body" }],
      sent: [{ from: "me@example.com", subject: "Re: Q3" }]
    };
    const profile = buildProfilePrompt(bundle);
    const tasks = buildTasksPrompt(bundle);
    const routines = buildRoutinesPrompt(bundle);

    // The tasks call needs who-wrote-last evidence and the profile call needs
    // sent mail for voice — both read the SAME rendered mailbox.
    expect(profile.user).toBe(tasks.user);
    expect(profile.user).toBe(routines.user);
    expect(profile.system).toContain("UNTRUSTED");
    expect(tasks.system).toContain("UNTRUSTED");
    expect(routines.system).toContain("UNTRUSTED");
    expect(profile.user).toContain("me@example.com");
    expect(profile.user).toContain("boss@corp.com");
    expect(profile.user).toContain("the full body");
    expect(profile.user).toContain("RECENT SENT MAIL");
  });
});

function echoConfig(): RuntimeConfig {
  return {
    instance: `scan-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: join(process.env.GINI_STATE_ROOT ?? "/tmp", "instances", "scan"),
    logRoot: "/tmp/logs",
    approvalMode: "strict"
  };
}
