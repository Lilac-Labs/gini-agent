// End-to-end controller tests: fixture mail source + echo provider drive the
// real loop — backfill seeding, ingest, decide, curator turns as pinned-agent
// subagent tasks, the infinite watcher, reopen-on-new-mail, pause/resume,
// and boot reconcile.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  __awaitCrmLoopExitForTests,
  __setCrmMailSourceForTests,
  __setCrmMailSourcesForTests,
  CRM_CURATOR_SUBAGENT_NAME,
  autostartCrmExtractionAfterOnboarding,
  crmExtractionStatus,
  disableCrmExtraction,
  enableCrmExtraction,
  pauseCrmExtraction,
  primeCrmExtractionThreads,
  reconcileCrmExtraction,
  startCrmExtraction,
} from "./crm-extractor";
import type { CrmMail } from "./crm-extraction-pipeline";
import type { CrmMailSource } from "../integrations/crm-mail";
import { crmQueueCounts, enqueueCrmThreads, getCrmMeta, listCrmThreads, markCrmThreadIngested, markCrmThreads, setCrmMeta, setCrmRunState, closeAllCrmExtractionDbs, getCrmRunState } from "../state/crm-extraction-db";
import { closeAllAgentDataDbs, dbExecute, dbQuery } from "../state/agent-data-db";
import { closeAllMemoryDbs, mutateState, readState, readTrace } from "../state";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearEchoToolCallingResponses, normalizeProvider, setEchoToolCallingFailure, setEchoToolCallingResponse } from "../provider";
import { install } from "../runtime";
import { attachGoogleAccountToInstance } from "../state/google-account-bindings";
import type { RuntimeConfig } from "../types";

// Process-unique because parallel test processes can run this file at once;
// deleting a shared SQLite root underneath another process yields IOERR_VNODE.
const ROOT = `/tmp/gini-crm-extractor-test-${process.pid}`;
const SELF = "me@corp.io";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  process.env.GINI_RERANKER_PROVIDER = "none";
  process.env.GINI_CRM_WATCH_INTERVAL_MS = "50";
  // Poll settled tasks tightly: turns settle in <1 tick in tests, so the
  // default 500ms per-turn poll was pure wall-clock floor across ~23 tests.
  process.env.GINI_CRM_TURN_POLL_MS = "20";
  delete process.env.GINI_CRM_FIXTURE_DIR;
});
afterAll(() => {
  closeAllCrmExtractionDbs();
  closeAllAgentDataDbs();
  closeAllMemoryDbs();
  clearEchoToolCallingResponses();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
  delete process.env.GINI_CRM_WATCH_INTERVAL_MS;
  delete process.env.GINI_CRM_TURN_POLL_MS;
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`,
  };
}

function mail(over: Partial<CrmMail> & { id: string; threadId: string }): CrmMail {
  return { date: 1_000, to: [], cc: [], subject: "s", body: "b", ...over };
}

// A mutable fixture: tests push messages to simulate future mail arriving.
function mutableSource(messages: CrmMail[]): CrmMailSource {
  return {
    kind: "fixture",
    async listMessages(afterMs?: number) {
      return messages
        .filter((m) => !afterMs || m.date > afterMs)
        .map((m) => ({ id: m.id, threadId: m.threadId, internalDate: m.date }));
    },
    async fetchThread(threadId: string) {
      return messages.filter((m) => m.threadId === threadId);
    },
  };
}

async function until(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("crm-extractor", () => {
  test("backfill → curator turn under pinned agent+subagent → watcher → reopen → pause/resume", async () => {
    const instance = "crmx-main";
    const config = makeConfig(instance);
    await install(config);
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "CRM updated.", toolCalls: [], finishReason: "stop" });

    const messages: CrmMail[] = [
      // Engaged thread: friend wrote, user replied.
      mail({ id: "m1", threadId: "T-eng", date: 1_000, from: { address: "friend@x.com" }, to: [{ address: SELF }] }),
      mail({ id: "m2", threadId: "T-eng", date: 2_000, from: { address: SELF }, to: [{ address: "friend@x.com" }] }),
      // Cold one-way inbound: skipped without a turn.
      mail({ id: "m3", threadId: "T-cold", date: 3_000, from: { address: "sdr@pitch.io" }, to: [{ address: SELF }] }),
    ];
    setCrmMeta(instance, "self_email", SELF);
    const inner = mutableSource(messages);
    const fetchCounts = new Map<string, number>();
    __setCrmMailSourceForTests(instance, {
      ...inner,
      async fetchThread(threadId) {
        fetchCounts.set(threadId, (fetchCounts.get(threadId) ?? 0) + 1);
        return inner.fetchThread(threadId);
      },
    });

    const status = await startCrmExtraction(config);
    expect(status.runState).toBe("running");
    expect(status.source).toBe("fixture");

    await until("backfill drains (1 done, 1 skipped)", () => {
      const c = crmQueueCounts(instance);
      return c.done === 1 && c.skipped === 1 && c.pending === 0 && c.ingested === 0;
    });

    // The skipped row carries the reason; the done row carries the task id.
    const [skippedRow] = listCrmThreads(instance, ["skipped"]);
    expect(skippedRow!.thread_id).toBe("T-cold");
    expect(skippedRow!.error).toContain("not engaged");
    const [doneRow] = listCrmThreads(instance, ["done"]);
    expect(doneRow!.thread_id).toBe("T-eng");
    expect(doneRow!.task_id).toBeTruthy();
    expect(fetchCounts.get("T-eng")).toBe(1);
    expect(fetchCounts.get("T-cold")).toBe(1);
    expect(doneRow!.messages_json).toBeNull();

    // Curator persona: constrained, memory-off, owned by the default agent.
    const state = readState(instance);
    const subagent = state.subagents.find((s) => s.name === CRM_CURATOR_SUBAGENT_NAME);
    expect(subagent).toBeDefined();
    expect(subagent!.autoMemory).toBe(false);
    expect(subagent!.toolsetIds).toEqual(["database"]);
    expect(subagent!.skillNames).toEqual(["people-crm"]);
    expect(subagent!.agentId).toBe("agent_default");

    // The turn ran as a pinned-agent subagent task with the skill inlined.
    const task = state.tasks.find((t) => t.id === doneRow!.task_id)!;
    expect(task.agentId).toBe("agent_default");
    expect(task.subagentId).toBe(subagent!.id);
    expect(task.input).toContain("```people-crm-skill");
    expect(task.input).toContain("```email-thread");
    expect(task.input).toContain(`I'm ${SELF}.`);
    // Ambient memory suppressed by the subagent persona (agent_default's own
    // autoMemory stays on for normal chats).
    const trace = readTrace(instance, task.id);
    expect(trace.some((r) => r.message === "auto-recall skipped: agent autoMemory off")).toBe(true);

    // The reserved self row exists in the DEFAULT agent's database.
    const you = dbQuery(instance, "agent_default", "SELECT first_name, email_address, description FROM contacts WHERE description LIKE 'You —%'");
    expect(you.rows.length).toBe(1);
    expect(you.rows[0]!.email_address).toBe(SELF);

    // Phase 2.5: after the backfill drains, exactly one whole-directory
    // reconciliation turn runs (pinned to the same persona, skill inlined)
    // and the per-account meta flag stops it from re-arming.
    await until("reconcile turn marks its meta flag", () => getCrmMeta(instance, "reconciled") === "1");
    const reconcileTasks = readState(instance).tasks.filter(
      (t) => typeof t.input === "string" && t.input.includes("Reconcile my people-CRM directory"),
    );
    expect(reconcileTasks.length).toBe(1);
    expect(reconcileTasks[0]!.agentId).toBe("agent_default");
    expect(reconcileTasks[0]!.subagentId).toBe(subagent!.id);
    expect(reconcileTasks[0]!.input).toContain("```people-crm-skill");

    // Watcher: a brand-new engaged thread arrives later → processed without
    // any restart (the infinite watcher).
    messages.push(
      mail({ id: "m4", threadId: "T-new", date: Date.now(), from: { address: SELF }, to: [{ address: "newpal@z.com" }] }),
    );
    await until("watcher picks up the new thread", () => crmQueueCounts(instance).done === 2);
    // Still exactly one reconcile turn after the watcher-era thread.
    expect(
      readState(instance).tasks.filter(
        (t) => typeof t.input === "string" && t.input.includes("Reconcile my people-CRM directory"),
      ).length,
    ).toBe(1);

    // Reopen: NEW mail lands on the already-done thread → it re-runs.
    messages.push(
      mail({ id: "m5", threadId: "T-eng", date: Date.now() + 1_000, from: { address: "friend@x.com" }, to: [{ address: SELF }] }),
    );
    await until("reopened thread re-processes", () => {
      const row = listCrmThreads(instance, ["done"]).find((r) => r.thread_id === "T-eng");
      return !!row && row.attempts >= 2;
    });

    // Pause: state persists, loop exits, new mail is NOT processed.
    const paused = await pauseCrmExtraction(config);
    expect(paused.runState).toBe("paused");
    await __awaitCrmLoopExitForTests(instance);
    const doneBefore = crmQueueCounts(instance).done;
    messages.push(
      mail({ id: "m6", threadId: "T-during-pause", date: Date.now() + 2_000, from: { address: SELF }, to: [{ address: "later@z.com" }] }),
    );
    await Bun.sleep(400);
    expect(crmQueueCounts(instance).done).toBe(doneBefore);
    expect(getCrmRunState(instance)).toBe("paused");

    // Boot reconcile respects paused.
    reconcileCrmExtraction(config);
    await Bun.sleep(200);
    expect(crmExtractionStatus(config).inFlightTurns).toBe(0);
    expect(crmQueueCounts(instance).done).toBe(doneBefore);

    // Resume: the queued-up mail flows.
    await startCrmExtraction(config);
    await until("resume processes the pause-era thread", () => crmQueueCounts(instance).done === doneBefore + 1);

    // Shut down cleanly for the rest of the file.
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 60_000);

  test("start on a running pipeline wakes the watcher for an immediate sync", async () => {
    const instance = "crmx-sync-wake";
    const config = makeConfig(instance);
    await install(config);
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "CRM updated.", toolCalls: [], finishReason: "stop" });

    const messages: CrmMail[] = [
      mail({ id: "w1", threadId: "T-a", date: 1_000, from: { address: "pal@x.com" }, to: [{ address: SELF }] }),
      mail({ id: "w2", threadId: "T-a", date: 2_000, from: { address: SELF }, to: [{ address: "pal@x.com" }] }),
    ];
    // Count list polls so the assertion can prove the wake — not the periodic
    // timer — is what re-scanned the mailbox.
    let listCalls = 0;
    const source: CrmMailSource = {
      kind: "fixture",
      async listMessages(afterMs?: number) {
        listCalls += 1;
        return messages
          .filter((m) => !afterMs || m.date > afterMs)
          .map((m) => ({ id: m.id, threadId: m.threadId, internalDate: m.date }));
      },
      async fetchThread(threadId: string) {
        return messages.filter((m) => m.threadId === threadId);
      },
    };
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(instance, source);

    // A watcher interval long enough that the periodic poll cannot be what
    // picks up the second thread within the test window — only a manual wake can.
    const prev = process.env.GINI_CRM_WATCH_INTERVAL_MS;
    process.env.GINI_CRM_WATCH_INTERVAL_MS = "600000";
    try {
      await startCrmExtraction(config);
      // Backfill (list #1) then the first idle watcher poll (list #2): the loop
      // is now asleep for 10 minutes with the first thread done.
      await until("first thread done and watcher settled", () => crmQueueCounts(instance).done === 1 && listCalls >= 2);
      const callsBeforeSync = listCalls;

      // New engaged mail arrives; the sleeping watcher won't poll again on its own.
      messages.push(
        mail({ id: "w3", threadId: "T-b", date: Date.now(), from: { address: SELF }, to: [{ address: "newpal@z.com" }] }),
      );
      // Manual "Sync": start on the already-running pipeline wakes the watcher now.
      await startCrmExtraction(config);
      await until("wake forced a fresh poll that ingests the new thread", () => crmQueueCounts(instance).done === 2, 15_000);
      expect(listCalls).toBeGreaterThan(callsBeforeSync);
    } finally {
      if (prev === undefined) delete process.env.GINI_CRM_WATCH_INTERVAL_MS;
      else process.env.GINI_CRM_WATCH_INTERVAL_MS = prev;
      await pauseCrmExtraction(config);
      await __awaitCrmLoopExitForTests(instance);
      __setCrmMailSourceForTests(instance, undefined);
    }
  }, 60_000);

  test("start works against a legacy email-PK contacts table (no id column)", async () => {
    // Real-world hazard: an agent database created before the id-PK schema
    // still has the retired email-PK contacts shape. Opening it migrates the
    // table to the modern schema, and the self-row seed lands on the result.
    const instance = "crmx-legacy";
    const config = makeConfig(instance);
    const { agentDataDbPath } = await import("../state/agent-data-db");
    const path = agentDataDbPath(instance, "agent_default");
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(path), { recursive: true });
    const { Database } = await import("bun:sqlite");
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE contacts (email_address TEXT PRIMARY KEY, first_name TEXT, profile TEXT)");
    raw.run("INSERT INTO contacts VALUES ('old@x.io', 'Old', 'kept')");
    raw.close();
    await install(config);
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(instance, mutableSource([]));
    const status = await startCrmExtraction(config);
    expect(status.runState).toBe("running");
    const you = dbQuery(instance, "agent_default", "SELECT id, email_address FROM contacts WHERE description LIKE 'You —%'");
    expect(you.rows.length).toBe(1);
    expect(you.rows[0]!.email_address).toBe(SELF);
    expect(String(you.rows[0]!.id).length).toBe(32); // migrated to the id-PK shape
    const old = dbQuery(instance, "agent_default", "SELECT profile FROM contacts WHERE email_address = 'old@x.io'");
    expect(old.rows[0]!.profile).toBe("kept"); // pre-migration data survived
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 30_000);

  test("start without any mail source throws the connect-account error", async () => {
    const instance = "crmx-nosource";
    const config = makeConfig(instance);
    await install(config);
    const prevHome = process.env.HOME;
    process.env.HOME = `${ROOT}/fake-home`; // no ~/.gini/google-accounts here
    try {
      expect(startCrmExtraction(config)).rejects.toThrow(/Google account/);
      // A failed start must not leave the persisted state claiming "running"
      // (setup runs first; the state flip is the last step of start).
      expect(getCrmRunState(instance)).toBe("idle");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("a fresh onboarding snapshot feeds People without another thread download", async () => {
    const instance = "crmx-onboarding-snapshot";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    const cached = mail({
      id: "snap-1",
      threadId: "T-snapshot",
      date: 2_000,
      from: { address: SELF },
      to: [{ address: "friend@x.com" }],
      body: "Downloaded during onboarding.",
    });
    let fetches = 0;
    __setCrmMailSourcesForTests(instance, [{
      accountId: "gacct_primary",
      email: SELF,
      source: {
        kind: "fixture",
        async listMessages(afterMs?: number) {
          return !afterMs || cached.date > afterMs
            ? [{ id: cached.id, threadId: cached.threadId, internalDate: cached.date }]
            : [];
        },
        async fetchThread() {
          fetches += 1;
          throw new Error("fresh snapshot should satisfy the thread read");
        },
      },
    }]);
    primeCrmExtractionThreads(instance, "gacct_primary", [{ threadId: cached.threadId, messages: [cached] }]);

    await startCrmExtraction(config);
    await until("snapshot-backed thread completes", () => crmQueueCounts(instance).done === 1);

    expect(fetches).toBe(0);
    const task = readState(instance).tasks.find((row) => row.subagentId && row.input.includes("Downloaded during onboarding."));
    expect(task).toBeDefined();
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    __setCrmMailSourcesForTests(instance, undefined);
  }, 90_000);

  test("People refetches a thread when the onboarding snapshot predates the mailbox list", async () => {
    const instance = "crmx-stale-onboarding-snapshot";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    const stale = mail({ id: "old", threadId: "T-stale", date: 1_000, from: { address: SELF }, to: [{ address: "friend@x.com" }] });
    const current = mail({ id: "new", threadId: "T-stale", date: 2_000, from: { address: "friend@x.com" }, to: [{ address: SELF }], body: "Arrived during onboarding." });
    let fetches = 0;
    __setCrmMailSourcesForTests(instance, [{
      accountId: "gacct_primary",
      email: SELF,
      source: {
        kind: "fixture",
        async listMessages(afterMs?: number) {
          return [stale, current]
            .filter((message) => !afterMs || message.date > afterMs)
            .map((message) => ({ id: message.id, threadId: message.threadId, internalDate: message.date }));
        },
        async fetchThread() {
          fetches += 1;
          return [stale, current];
        },
      },
    }]);
    primeCrmExtractionThreads(instance, "gacct_primary", [{ threadId: stale.threadId, messages: [stale] }]);

    await startCrmExtraction(config);
    await until("stale snapshot thread completes", () => crmQueueCounts(instance).done === 1);

    expect(fetches).toBe(1);
    const task = readState(instance).tasks.find((row) => row.subagentId && row.input.includes("Arrived during onboarding."));
    expect(task).toBeDefined();
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    __setCrmMailSourcesForTests(instance, undefined);
  }, 90_000);

  test("boot reconcile pauses a pipeline that was running when the process died", async () => {
    const instance = "crmx-reconcile-local";
    const config = makeConfig(instance);
    await install(config);
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(instance, mutableSource([]));
    // Simulate "was running when the process died": persisted run state only.
    setCrmRunState(instance, "running");
    reconcileCrmExtraction(config);
    await Bun.sleep(100);
    expect(getCrmRunState(instance)).toBe("paused");
    expect(crmQueueCounts(instance).done).toBe(0);
    __setCrmMailSourceForTests(instance, undefined);
  }, 30_000);

  test("mail listing is incremental after the one-time backfill", async () => {
    const instance = "crmx-incremental";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    // A recent date so cursor − overlap stays positive (visible as a real
    // incremental bound in the assertions below).
    const seeded = Date.now();
    const messages = [mail({ id: "i1", threadId: "T-i", date: seeded, from: { address: SELF }, to: [{ address: "pal@z.com" }] })];
    const listCalls: Array<number | undefined> = [];
    const inner = mutableSource(messages);
    __setCrmMailSourceForTests(instance, {
      kind: "fixture",
      async listMessages(afterMs?: number) {
        listCalls.push(afterMs);
        return inner.listMessages(afterMs);
      },
      fetchThread: inner.fetchThread,
    });
    await startCrmExtraction(config);
    await until("backfill drains", () => crmQueueCounts(instance).done === 1);
    await until("several watcher polls happened", () => listCalls.length >= 4);
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    // Exactly ONE full list (the backfill seed); every watcher poll passes
    // the persisted cursor minus the 60s overlap — never a full rescan.
    expect(listCalls.filter((a) => a === undefined).length).toBe(1);
    expect(listCalls[0]).toBeUndefined();
    for (const after of listCalls.slice(1)) {
      expect(after).toBe(seeded - 60_000);
    }
  }, 30_000);

  test("engaged threads with no human (user replying to a machine) skip without a turn", async () => {
    // Regression: the decide phase must read the PERSISTED hasHuman, not
    // approximate it from engagement — a user replying to a no-reply bot is
    // engaged yet human-less, and burning a curator turn on it is waste.
    const instance = "crmx-no-human";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(
      instance,
      mutableSource([
        mail({ id: "n1", threadId: "T-bot", date: 1_000, from: { address: "no-reply@robot.com" }, to: [{ address: SELF }] }),
        mail({ id: "n2", threadId: "T-bot", date: 2_000, from: { address: SELF }, to: [{ address: "no-reply@robot.com" }] }),
      ]),
    );
    await startCrmExtraction(config);
    await until("bot thread settles", () => crmQueueCounts(instance).skipped === 1);
    const [row] = listCrmThreads(instance, ["skipped"]);
    expect(row!.thread_id).toBe("T-bot");
    expect(row!.engaged).toBe(1);
    expect(row!.has_human).toBe(0);
    expect(row!.error).toBe("all senders automated/self");
    expect(row!.task_id).toBeNull(); // no curator turn ran
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 30_000);

  test("multi-account: every mailbox is backfilled, engagement spans all self addresses, and a mid-run account joins", async () => {
    const instance = "crmx-multi";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    const WORK = "me@corp.io";
    const SIDE = "me@side.dev";
    // Mailbox A (work): a friend thread the user answered FROM THE SIDE
    // ADDRESS — only a multi-account self set counts that as engaged.
    const workMail = [
      mail({ id: "w1", threadId: "T-work", date: 1_000, from: { address: "friend@x.com" }, to: [{ address: WORK }] }),
      mail({ id: "w2", threadId: "T-work", date: 2_000, from: { address: SIDE }, to: [{ address: "friend@x.com" }] }),
    ];
    // Mailbox B (side): its own engaged thread.
    const sideMail = [
      mail({ id: "s1", threadId: "T-side", date: 3_000, from: { address: SIDE }, to: [{ address: "pal@z.com" }] }),
    ];
    const workSource = mutableSource(workMail);
    const sideSource = mutableSource(sideMail);
    __setCrmMailSourcesForTests(instance, [
      { accountId: "gacct_work", email: WORK, source: workSource },
      { accountId: "gacct_side", email: SIDE, source: sideSource },
    ]);

    const started = await startCrmExtraction(config);
    expect(started.selfEmail).toBe(WORK); // first account is primary
    expect(started.selfAddresses.sort()).toEqual([WORK, SIDE].sort());
    expect(started.accounts.map((a) => a.accountId)).toEqual(["gacct_work", "gacct_side"]);

    await until("both mailboxes drain", () => crmQueueCounts(instance).done === 2);
    const rows = listCrmThreads(instance, ["done"]);
    expect(rows.find((r) => r.thread_id === "T-work")!.account).toBe("gacct_work");
    expect(rows.find((r) => r.thread_id === "T-side")!.account).toBe("gacct_side");
    // Cross-account engagement: T-work was kept (user replied from SIDE).
    expect(rows.find((r) => r.thread_id === "T-work")!.engaged).toBe(1);
    // Per-account seed flags + cursors.
    const status = crmExtractionStatus(config);
    expect(status.backfillSeeded).toBe(true);
    expect(status.accounts.every((a) => a.backfillSeeded)).toBe(true);

    // A third account connects while the pipeline runs: the loop discovers
    // it on the next pass and backfills ONLY that mailbox.
    const NEW = "me@new.org";
    const newSource = mutableSource([
      mail({ id: "n1", threadId: "T-new-acct", date: Date.now(), from: { address: NEW }, to: [{ address: "fresh@q.com" }] }),
    ]);
    __setCrmMailSourcesForTests(instance, [
      { accountId: "gacct_work", email: WORK, source: workSource },
      { accountId: "gacct_side", email: SIDE, source: sideSource },
      { accountId: "gacct_new", email: NEW, source: newSource },
    ]);
    await until("new account's mailbox processed by the running loop", () => crmQueueCounts(instance).done === 3);
    expect(listCrmThreads(instance, ["done"]).find((r) => r.thread_id === "T-new-acct")!.account).toBe("gacct_new");

    // Watcher: new mail lands in mailbox B only — its cursor advances and
    // the thread reopens; mailbox A is untouched.
    sideMail.push(mail({ id: "s2", threadId: "T-side", date: Date.now() + 1_000, from: { address: "pal@z.com" }, to: [{ address: SIDE }] }));
    await until("side thread reopened and reprocessed", () => {
      const row = listCrmThreads(instance, ["done"]).find((r) => r.thread_id === "T-side");
      return !!row && row.attempts >= 2;
    });

    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    __setCrmMailSourcesForTests(instance, undefined);
  }, 60_000);

  test("multi-account: duplicate registry emails collapse to one mailbox", async () => {
    const instance = "crmx-multi-dup";
    const config = makeConfig(instance);
    await install(config);
    const source = mutableSource([]);
    __setCrmMailSourcesForTests(instance, [
      { accountId: "gacct_a", email: "same@x.io", source },
      { accountId: "gacct_b", email: "SAME@x.io", source },
    ]);
    // The override seam bypasses registry dedup, so exercise the status
    // surface via the real resolver path instead: registry rows with the
    // same email (different case) yield ONE account.
    __setCrmMailSourcesForTests(instance, undefined);
    const prevHome = process.env.HOME;
    const home = `${ROOT}/dup-home`;
    const registryDir = join(home, ".gini", "google-accounts");
    mkdirSync(registryDir, { recursive: true });
    const first = { id: "gacct_a", tag: "a", email: "same@x.io", configDir: `${home}/a`, addedAt: "2026-01-01T00:00:00Z" };
    const primary = { id: "gacct_b", tag: "b", email: "SAME@x.io", configDir: `${home}/b`, addedAt: "2026-01-02T00:00:00Z" };
    const other = { id: "gacct_c", tag: "c", email: "other@y.io", configDir: `${home}/c`, addedAt: "2026-01-03T00:00:00Z" };
    writeFileSync(
      join(registryDir, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [first, primary, other],
      }),
    );
    attachGoogleAccountToInstance(instance, first);
    attachGoogleAccountToInstance(instance, primary, { primary: true });
    attachGoogleAccountToInstance(instance, other);
    process.env.HOME = home;
    try {
      const status = crmExtractionStatus(config);
      // Primary-first ordering, case-insensitive email dedup: gacct_b wins
      // its email, gacct_a is dropped, gacct_c remains.
      expect(status.accounts.map((a) => a.accountId)).toEqual(["gacct_b", "gacct_c"]);
      expect(status.selfEmail).toBe("same@x.io");
      expect(status.selfAddresses.sort()).toEqual(["other@y.io", "same@x.io"]);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("a single-account-era pipeline adopts its bare meta instead of re-backfilling", async () => {
    const instance = "crmx-legacy-meta";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    // Single-account era state: bare keys, '' rows, everything done.
    setCrmMeta(instance, "self_email", SELF);
    setCrmMeta(instance, "backfill_seeded", "1");
    setCrmMeta(instance, "mail_cursor", String(Date.now()));
    enqueueCrmThreads(instance, [{ threadId: "T-old", newestDate: 1_000 }]);
    markCrmThreads(instance, ["T-old"], { status: "done", taskId: "task_old" });
    let fullLists = 0;
    __setCrmMailSourcesForTests(instance, [{
      accountId: "gacct_now",
      email: SELF,
      source: {
        kind: "gmail",
        async listMessages(afterMs?: number) {
          if (afterMs === undefined) fullLists += 1;
          return [];
        },
        async fetchThread() {
          return [];
        },
      },
    }]);
    await startCrmExtraction(config);
    await until("meta adopted for the account", () => crmExtractionStatus(config).accounts[0]?.backfillSeeded === true);
    await Bun.sleep(300); // several loop passes
    expect(fullLists).toBe(0); // never re-listed the whole mailbox
    expect(crmQueueCounts(instance).done).toBe(1); // done work untouched
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    __setCrmMailSourcesForTests(instance, undefined);
  }, 30_000);

  test("a fixture_dir meta entry resolves as the single fixture account", async () => {
    const instance = "crmx-fixture-meta";
    const config = makeConfig(instance);
    await install(config);
    const dir = `${ROOT}/fixture-meta`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "messages.json"), "[]");
    setCrmMeta(instance, "fixture_dir", dir);
    setCrmMeta(instance, "self_email", SELF);
    const status = crmExtractionStatus(config);
    expect(status.source).toBe("fixture");
    expect(status.selfEmail).toBe(SELF);
    expect(status.accounts).toEqual([{ accountId: "", email: SELF, backfillSeeded: false, mailCursor: null }]);
  });

  test("resolves the instance-bound Google account from the machine registry", async () => {
    const instance = "crmx-gmail-resolve";
    const config = makeConfig(instance);
    await install(config);
    const prevHome = process.env.HOME;
    const home = `${ROOT}/gmail-home`;
    const registryDir = join(home, ".gini", "google-accounts");
    mkdirSync(registryDir, { recursive: true });
    const account = (id: string, email: string) => ({ id, tag: id, email, configDir: `${home}/${id}`, addedAt: "2026-01-01T00:00:00Z" });
    process.env.HOME = home;
    try {
      // Machine-global registry rows are not enough: the mailbox must be bound
      // to this instance, and the instance primary wins (email lowercased).
      const first = account("gacct_a", "a@x.io");
      const primary = account("gacct_b", "B@Y.io");
      writeFileSync(
        join(registryDir, "accounts.json"),
        JSON.stringify({ version: 1, accounts: [first, primary] }),
      );
      let status = crmExtractionStatus(config);
      expect(status.source).toBeNull();
      attachGoogleAccountToInstance(instance, first);
      attachGoogleAccountToInstance(instance, primary, { primary: true });
      status = crmExtractionStatus(config);
      expect(status.source).toBe("gmail");
      expect(status.selfEmail).toBe("b@y.io");
      // A stale bound primary id falls back to the remaining attached account.
      writeFileSync(
        join(registryDir, "accounts.json"),
        JSON.stringify({ version: 1, accounts: [first] }),
      );
      status = crmExtractionStatus(config);
      expect(status.selfEmail).toBe("a@x.io");
      // An account row without a usable email resolves to no source.
      writeFileSync(
        join(registryDir, "accounts.json"),
        JSON.stringify({ version: 1, accounts: [account("gacct_a", "")] }),
      );
      expect(crmExtractionStatus(config).source).toBeNull();
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("a transient mail-source crash parks the loop and it recovers on its own", async () => {
    // The always-on contract: a Gmail 429/network blip must never leave a
    // dead loop behind a persisted "running" state — the iteration fence
    // records the error, sleeps one interval, and retries.
    const instance = "crmx-loop-error";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    const inner = mutableSource([
      mail({ id: "e1", threadId: "T-heal", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] }),
    ]);
    let failures = 2;
    __setCrmMailSourceForTests(instance, {
      kind: "fixture",
      async listMessages(afterMs?: number) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("mailbox exploded");
        }
        return inner.listMessages(afterMs);
      },
      fetchThread: inner.fetchThread,
    });
    await startCrmExtraction(config);
    await until("outage recorded", () => crmExtractionStatus(config).lastError === "mailbox exploded");
    expect(getCrmRunState(instance)).toBe("running");
    // The source heals → the same loop (no restart) drains the backfill.
    await until("loop recovered and processed the thread", () => crmQueueCounts(instance).done === 1);
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    __setCrmMailSourceForTests(instance, undefined);
  }, 30_000);

  test("a fallback turn-time fetch failure costs one batch, not the loop", async () => {
    // An ingested row from before the transient-payload column (or a corrupt
    // cache entry) still falls back to the source. A phase-2 fetch error marks
    // only that batch and leaves the loop alive.
    const instance = "crmx-turn-fetch-fail";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    const good = mail({ id: "g1", threadId: "T-good", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] });
    const doomed = mail({ id: "x1", threadId: "T-doomed", date: 2_000, from: { address: SELF }, to: [{ address: "other@z.com" }] });
    setCrmMeta(instance, "backfill_seeded", "1");
    setCrmMeta(instance, "mail_cursor", "2000");
    enqueueCrmThreads(instance, [
      { threadId: good.threadId, newestDate: good.date },
      { threadId: doomed.threadId, newestDate: doomed.date },
    ]);
    const ingest = (message: CrmMail): void => markCrmThreadIngested(instance, message.threadId, {
      messageCount: 1,
      newestDate: message.date,
      engaged: true,
      hasHuman: true,
      primarySender: message.to[0]?.address ?? null,
      chars: message.body.length,
      senders: [],
      // Deliberately absent: this exercises the compatibility fallback.
      messagesJson: null,
    });
    ingest(good);
    ingest(doomed);
    __setCrmMailSourceForTests(instance, {
      kind: "fixture",
      async listMessages() { return []; },
      async fetchThread(threadId: string) {
        if (threadId === "T-doomed") throw new Error("fetch died mid-turn");
        return [good, doomed].filter((m) => m.threadId === threadId);
      },
    });
    await startCrmExtraction(config);
    await until("good thread done, doomed thread errored", () => {
      const c = crmQueueCounts(instance);
      return c.done === 1 && c.error === 1;
    });
    const [errRow] = listCrmThreads(instance, ["error"]);
    expect(errRow!.thread_id).toBe("T-doomed");
    expect(errRow!.error).toContain("turn: fetch died mid-turn");
    // The loop survived the throw: it is still watching (pause exits cleanly).
    expect(getCrmRunState(instance)).toBe("running");
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 30_000);

  test("a timeout is not retried after pause — nothing new dispatches post-stop", async () => {
    const instance = "crmx-no-retry-after-pause";
    const config = makeConfig(instance);
    await install(config);
    clearEchoToolCallingResponses();
    // Two delayed stubs: if the post-pause retry were still dispatched, it
    // would consume the second one and a second task row would exist.
    for (let i = 0; i < 2; i++) {
      setEchoToolCallingResponse(
        { provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" },
        undefined,
        { delayMs: 10_000 },
      );
    }
    process.env.GINI_CRM_TURN_TIMEOUT_MS = "3000";
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(
      instance,
      mutableSource([mail({ id: "p1", threadId: "T-p", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })]),
    );
    try {
      await startCrmExtraction(config);
      await until("turn in flight", () => crmExtractionStatus(config).inFlightTurns === 1);
      await pauseCrmExtraction(config); // stop requested while attempt 1 polls
      await until("thread errored as timeout", () => crmQueueCounts(instance).error === 1, 30_000);
      const curatorTasks = readState(instance).tasks.filter((t) => t.subagentId);
      expect(curatorTasks.length).toBe(1); // no post-pause retry dispatch
      await __awaitCrmLoopExitForTests(instance);
    } finally {
      delete process.env.GINI_CRM_TURN_TIMEOUT_MS;
    }
  }, 30_000);

  test("losing the mail source mid-run parks the loop with a clear error", async () => {
    const instance = "crmx-source-lost";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(
      instance,
      mutableSource([mail({ id: "s1", threadId: "T-s", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })]),
    );
    await startCrmExtraction(config);
    await until("backfill drains", () => crmQueueCounts(instance).done === 1);
    const prevHome = process.env.HOME;
    process.env.HOME = `${ROOT}/empty-home`; // no registry → no fallback source
    try {
      __setCrmMailSourceForTests(instance, undefined);
      await until("loop parks on missing source", () =>
        (crmExtractionStatus(config).lastError ?? "").includes("no mail source"),
      );
      expect(getCrmRunState(instance)).toBe("running"); // still wants to run
    } finally {
      process.env.HOME = prevHome;
      await pauseCrmExtraction(config);
      await __awaitCrmLoopExitForTests(instance);
    }
  }, 30_000);

  test("ingest failures: vanished threads skip, fetch errors mark error, late-vanish skips at turn time", async () => {
    const instance = "crmx-ingest-fail";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    const late = mail({ id: "l1", threadId: "T-late", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] });
    const fetches = new Map<string, number>();
    __setCrmMailSourceForTests(instance, {
      kind: "fixture",
      async listMessages() {
        return [
          { id: "g1", threadId: "T-gone", internalDate: 1_000 },
          { id: "b1", threadId: "T-boom", internalDate: 2_000 },
          { id: "l1", threadId: "T-late", internalDate: 3_000 },
        ];
      },
      async fetchThread(threadId: string) {
        fetches.set(threadId, (fetches.get(threadId) ?? 0) + 1);
        if (threadId === "T-gone") return [];
        if (threadId === "T-boom") throw new Error("fetch blew up");
        // T-late: present at ingest, vanished by turn time.
        return fetches.get("T-late")! <= 1 ? [late] : [];
      },
    });
    await startCrmExtraction(config);
    await until("all three threads settled", () => {
      const c = crmQueueCounts(instance);
      return c.skipped === 2 && c.error === 1;
    });
    const rows = listCrmThreads(instance, ["skipped", "error"]);
    expect(rows.find((r) => r.thread_id === "T-gone")!.error).toContain("thread vanished");
    expect(rows.find((r) => r.thread_id === "T-boom")!.error).toContain("ingest: fetch blew up");
    expect(rows.find((r) => r.thread_id === "T-late")!.error).toContain("thread vanished");
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 30_000);

  test("turn outcomes: provider failure, stuck approval, vanished task, and timeout-with-retry", async () => {
    // Each scenario gets its own instance with one engaged thread. The flip
    // helper rewrites the curator task row WHILE THE TURN IS STILL RUNNING —
    // the echo response is delayed, so the flip lands its terminal state before
    // the task ever legitimately completes. This is deterministic: it does not
    // depend on out-racing the turn-wait's poll interval (an earlier version
    // flipped only after `completed` and relied on a slow 2s poll not yet
    // having observed it — fragile, and wrong once the poll got fast).
    const engaged = (threadId: string) =>
      mutableSource([mail({ id: `${threadId}-m`, threadId, date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })]);
    const provider = normalizeProvider(makeConfig("x").provider);

    async function runScenario(
      instance: string,
      opts: { echo: boolean; echoDelayMs?: number; flip?: (taskId: string) => void; env?: Record<string, string> },
    ): Promise<string> {
      const config = makeConfig(instance);
      await install(config);
      clearEchoToolCallingResponses();
      if (opts.echo) {
        // Stubs are consumed one per provider call; queue two so the
        // timeout scenario's retry attempt is also delayed (the no-stub
        // fallback would complete instantly and win the race). Flip scenarios
        // delay the turn so the flip can land mid-run (see below).
        const delayMs = opts.echoDelayMs ?? (opts.flip ? 300 : undefined);
        for (let i = 0; i < 2; i++) {
          setEchoToolCallingResponse(
            { provider, text: "ok", toolCalls: [], finishReason: "stop" },
            undefined,
            delayMs ? { delayMs } : undefined,
          );
        }
      } else {
        setEchoToolCallingFailure("provider exploded");
      }
      for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
      setCrmMeta(instance, "self_email", SELF);
      __setCrmMailSourceForTests(instance, engaged(`T-${instance}`));
      try {
        await startCrmExtraction(config);
        if (opts.flip) {
          // Flip the RUNNING curator task's row to its terminal state before
          // the delayed turn completes, so the turn-wait observes the flipped
          // state deterministically (not a race against the poll interval).
          let flipped = false;
          await until("running task flipped", () => {
            const task = readState(instance).tasks.find(
              (t) => t.subagentId && (t.status === "running" || t.status === "queued"),
            );
            if (task && !flipped) {
              flipped = true;
              opts.flip!(task.id);
            }
            return flipped;
          });
        }
        await until(`thread errored (${instance})`, () => crmQueueCounts(instance).error === 1, 30_000);
        return listCrmThreads(instance, ["error"])[0]!.error ?? "";
      } finally {
        for (const k of Object.keys(opts.env ?? {})) delete process.env[k];
        await pauseCrmExtraction(config);
        await __awaitCrmLoopExitForTests(instance);
      }
    }

    // No echo response configured → the chat task itself fails.
    expect(await runScenario("crmx-turn-fail", { echo: false })).toMatch(/failed/);
    // A task stuck waiting on approval is not retried — surfaced as stuck.
    expect(
      await runScenario("crmx-turn-stuck", {
        echo: true,
        flip: (taskId) =>
          void mutateState("crmx-turn-stuck", (state) => {
            state.tasks.find((t) => t.id === taskId)!.status = "waiting_approval";
            return null;
          }),
      }),
    ).toContain("stuck: waiting_approval");
    // A task row that disappears entirely.
    expect(
      await runScenario("crmx-turn-gone", {
        echo: true,
        flip: (taskId) =>
          void mutateState("crmx-turn-gone", (state) => {
            state.tasks = state.tasks.filter((t) => t.id !== taskId);
            return null;
          }),
      }),
    ).toContain("task disappeared");
    // A 1ms deadline times out (the echo response is delayed past it),
    // retries once, then errors. 300ms delay >> the 1ms deadline, so it still
    // reliably times out, without the old 3s-per-attempt wall-clock cost.
    const timeoutError = await runScenario("crmx-turn-timeout", {
      echo: true,
      echoDelayMs: 300,
      env: { GINI_CRM_TURN_TIMEOUT_MS: "1" },
    });
    expect(timeoutError).toBe("timeout");
    const attempts = listCrmThreads("crmx-turn-timeout", ["error"])[0]!.attempts;
    expect(attempts).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("onboarding autostart: fires when idle with a source, never otherwise, and survives failure", async () => {
    // (a) idle + source → starts.
    const a = makeConfig("crmx-auto-a");
    await install(a);
    setEchoToolCallingResponse({ provider: normalizeProvider(a.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(a.instance, "self_email", SELF);
    __setCrmMailSourceForTests(a.instance, mutableSource([]));
    autostartCrmExtractionAfterOnboarding(a);
    await until("autostart flips to running", () => getCrmRunState(a.instance) === "running");
    await pauseCrmExtraction(a);
    await __awaitCrmLoopExitForTests(a.instance);

    // (b) not idle (paused) → untouched.
    autostartCrmExtractionAfterOnboarding(a);
    await Bun.sleep(100);
    expect(getCrmRunState(a.instance)).toBe("paused");

    // (c) idle + no source anywhere → stays idle.
    const c = makeConfig("crmx-auto-c");
    await install(c);
    const prevHome = process.env.HOME;
    process.env.HOME = `${ROOT}/empty-home-c`;
    try {
      autostartCrmExtractionAfterOnboarding(c);
      await Bun.sleep(100);
      expect(getCrmRunState(c.instance)).toBe("idle");
    } finally {
      process.env.HOME = prevHome;
    }

    // (d) start throws inside the autostart → caught, state stays idle.
    const d = makeConfig("crmx-auto-d");
    await install(d);
    setCrmMeta(d.instance, "self_email", SELF);
    __setCrmMailSourceForTests(d.instance, mutableSource([]));
    dbExecute(d.instance, "agent_default", "DROP TABLE contacts");
    dbExecute(d.instance, "agent_default", "CREATE TABLE contacts (x TEXT)");
    autostartCrmExtractionAfterOnboarding(d);
    await Bun.sleep(300);
    expect(getCrmRunState(d.instance)).toBe("idle"); // failed start left no state behind
    __setCrmMailSourceForTests(d.instance, undefined);
  }, 30_000);

  test("start is idempotent: a second start joins the running loop instead of duplicating it", async () => {
    const instance = "crmx-double-start";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    __setCrmMailSourceForTests(
      instance,
      mutableSource([mail({ id: "ds1", threadId: "T-ds", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })]),
    );
    const [first, second] = await Promise.all([startCrmExtraction(config), startCrmExtraction(config)]);
    expect(first.runState).toBe("running");
    expect(second.runState).toBe("running");
    await until("thread drains once", () => crmQueueCounts(instance).done === 1);
    await Bun.sleep(300); // give a hypothetical second loop time to double-process
    const [row] = listCrmThreads(instance, ["done"]);
    expect(row!.attempts).toBe(1); // one loop, one turn
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
  }, 30_000);

  test("disable during an in-flight turn lets the turn finish, then stops everything", async () => {
    const instance = "crmx-disable-midturn";
    const config = makeConfig(instance);
    await install(config);
    clearEchoToolCallingResponses();
    setEchoToolCallingResponse(
      { provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 1_500 },
    );
    setCrmMeta(instance, "self_email", SELF);
    const messages = [mail({ id: "dm1", threadId: "T-dm", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })];
    __setCrmMailSourceForTests(instance, mutableSource(messages));
    await startCrmExtraction(config);
    await until("turn in flight", () => crmExtractionStatus(config).inFlightTurns === 1);
    const disabled = await disableCrmExtraction(config);
    expect(disabled.runState).toBe("disabled");
    // The in-flight turn completes and is recorded (convergent turns are
    // cheap to let finish); nothing new is processed afterward.
    await until("in-flight turn recorded", () => crmQueueCounts(instance).done === 1);
    await __awaitCrmLoopExitForTests(instance);
    messages.push(mail({ id: "dm2", threadId: "T-dm2", date: Date.now(), from: { address: SELF }, to: [{ address: "x@z.com" }] }));
    await Bun.sleep(300);
    expect(crmQueueCounts(instance).done).toBe(1);
    expect(getCrmRunState(instance)).toBe("disabled");
    await enableCrmExtraction(config);
  }, 30_000);

  test("disable is a sticky master switch; enable returns to idle", async () => {
    const instance = "crmx-disable";
    const config = makeConfig(instance);
    await install(config);
    setEchoToolCallingResponse({ provider: normalizeProvider(config.provider), text: "ok", toolCalls: [], finishReason: "stop" });
    setCrmMeta(instance, "self_email", SELF);
    const messages = [mail({ id: "d1", threadId: "T-d", date: 1_000, from: { address: SELF }, to: [{ address: "pal@z.com" }] })];
    __setCrmMailSourceForTests(instance, mutableSource(messages));

    await startCrmExtraction(config);
    await until("initial thread done", () => crmQueueCounts(instance).done === 1);

    // Disable stops the loop and persists.
    const disabled = await disableCrmExtraction(config);
    expect(disabled.runState).toBe("disabled");
    await __awaitCrmLoopExitForTests(instance);
    // New mail is NOT processed while disabled.
    messages.push(mail({ id: "d2", threadId: "T-d2", date: Date.now(), from: { address: SELF }, to: [{ address: "x@z.com" }] }));
    await Bun.sleep(300);
    expect(crmQueueCounts(instance).done).toBe(1);
    // Start refuses, pause is a no-op, autostart and reconcile stay away.
    expect(startCrmExtraction(config)).rejects.toThrow(/disabled/);
    expect((await pauseCrmExtraction(config)).runState).toBe("disabled");
    autostartCrmExtractionAfterOnboarding(config);
    reconcileCrmExtraction(config);
    await Bun.sleep(200);
    expect(getCrmRunState(instance)).toBe("disabled");
    expect(crmQueueCounts(instance).done).toBe(1);

    // Enable → idle (not auto-started), then start flows again and the
    // mail that arrived while disabled is processed.
    const enabled = await enableCrmExtraction(config);
    expect(enabled.runState).toBe("idle");
    await startCrmExtraction(config);
    await until("disabled-era mail processed after enable", () => crmQueueCounts(instance).done === 2);
    await pauseCrmExtraction(config);
    await __awaitCrmLoopExitForTests(instance);
    // Enabling a non-disabled pipeline changes nothing.
    expect((await enableCrmExtraction(config)).runState).toBe("paused");
  }, 60_000);
});
