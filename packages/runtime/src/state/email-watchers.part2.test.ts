// CRUD + query-building tests for email watchers (ADR email-watch.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import "../hooks/builtins"; // populates the registry so createScheduledJob resolves isKnownHook("skill-script")
import { createScheduledJob } from "../jobs";
import {
  addEmailWatcher,
  backfillEmailWatcherJobs,
  buildWatcherQuery,
  closeAllMemoryDbs,
  createAgentRecord,
  createChatSession,
  getEmailWatcher,
  listEmailWatchers,
  mutateState,
  readState,
  removeEmailWatcher,
  renameChatSession,
  setEmailTriageEnabled,
  setEmailWatcherEnabled,
  setEmailWatcherObjective,
  clearEmailWatcherObjective,
  updateEmailWatcher,
  validateObjective,
  validateThreadId
} from ".";
import { accountSelectionHint, resolveWatchAccount } from "./email-watchers";

const ROOT = mkdtempSync(join(tmpdir(), "gini-email-watchers-test-"));

// Isolate the machine-global google-accounts registry (resolved under
// process.env.HOME) so account→configDir resolution sees a CONTROLLED registry,
// not the developer's real signed-in accounts — otherwise the watch-shape
// assertions would non-deterministically pick up a live account's configDir.
const PRIOR_HOME = process.env.HOME;

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.HOME = ROOT;
});

afterAll(() => {
  closeAllMemoryDbs();
  if (PRIOR_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = PRIOR_HOME;
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("thread-keyed watchers", () => {
  test("add with threadId stores the id, a thread:<id> label, and no sender", async () => {
    const config = buildConfig("ew-thread-add");
    const watcher = await addEmailWatcher(config, { threadId: "t-123", sender: "support@x.com" });
    expect(watcher.threadId).toBe("t-123");
    expect(watcher.query).toBe("thread:t-123");
    // Thread mode has no automated-sender heuristic, so no bypass key.
    expect(watcher.sender).toBeUndefined();
    // The shared job's watch entry carries the authoritative threadId.
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { threadId?: string }[] }).watches ?? [];
    expect(watches[0]?.threadId).toBe("t-123");
  });

  test("a blank or out-of-charset threadId is rejected before provisioning", async () => {
    const config = buildConfig("ew-thread-blank");
    await expect(addEmailWatcher(config, { threadId: "  " })).rejects.toThrow("Invalid input: threadId");
    // A threadId carrying shell metacharacters never reaches the gws sink — the
    // charset gate rejects it (threadIds are opaque hex-ish tokens).
    await expect(addEmailWatcher(config, { threadId: "x'; touch /tmp/PWNED; '" })).rejects.toThrow(
      "Invalid input: threadId may only contain"
    );
    expect(readState(config.instance).emailWatchers).toHaveLength(0);
  });

  test("validateThreadId accepts the gmail token charset and rejects the rest", () => {
    expect(validateThreadId(" 18f_ab-CD ")).toBe("18f_ab-CD");
    expect(() => validateThreadId(42)).toThrow("Invalid input: threadId must be a string");
    expect(() => validateThreadId("   ")).toThrow("Invalid input: threadId must be a non-empty string");
    expect(() => validateThreadId("a'b")).toThrow("Invalid input: threadId may only contain");
    expect(() => validateThreadId("a b")).toThrow("Invalid input: threadId may only contain");
  });

  test("followUpAfterHours requires a thread watch and a positive number", async () => {
    const config = buildConfig("ew-followup-validate");
    // Rejected on query watches — silence is a thread-level predicate.
    await expect(addEmailWatcher(config, { sender: "a@x.com", followUpAfterHours: 24 })).rejects.toThrow(
      "Invalid input: followUpAfterHours is only supported on thread watches"
    );
    await expect(addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: 0 })).rejects.toThrow(
      "Invalid input: followUpAfterHours must be a positive number"
    );
    await expect(addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: -2 })).rejects.toThrow(
      "Invalid input: followUpAfterHours must be a positive number"
    );
    expect(readState(config.instance).emailWatchers).toHaveLength(0);
    // Accepted on a thread watch; the watch entry carries it.
    const watcher = await addEmailWatcher(config, { threadId: "t-1", followUpAfterHours: 24 });
    expect(watcher.followUpAfterHours).toBe(24);
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { followUpAfterHours?: number }[] }).watches ?? [];
    expect(watches[0]?.followUpAfterHours).toBe(24);
  });
});

describe("watcher objective", () => {
  test("validateObjective trims, rejects empty, caps at 2000 chars", () => {
    expect(validateObjective("  get a refund  ")).toBe("get a refund");
    expect(() => validateObjective("   ")).toThrow("Invalid input: objective must not be empty");
    expect(() => validateObjective(42)).toThrow("Invalid input: objective must be a string");
    expect(() => validateObjective("x".repeat(2001))).toThrow("Invalid input: objective must be at most 2000 characters");
    expect(validateObjective("x".repeat(2000))).toBe("x".repeat(2000));
  });

  test("add stores the validated objective and the watch list carries it", async () => {
    const config = buildConfig("ew-objective-add");
    const watcher = await addEmailWatcher(config, { sender: "alice@x.com", objective: " Get a refund or a replacement " });
    expect(watcher.objective).toBe("Get a refund or a replacement");
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBe("Get a refund or a replacement");
  });

  test("a rejected objective on the FIRST add leaves no orphan shared job", async () => {
    const config = buildConfig("ew-objective-reject");
    await expect(addEmailWatcher(config, { sender: "a@x.com", objective: "  " })).rejects.toThrow("Invalid input");
    const state = readState(config.instance);
    expect(state.emailWatchers).toHaveLength(0);
    expect(state.jobs.filter((j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch")).toHaveLength(0);
  });

  test("setEmailWatcherObjective revises the goal and pushes it into the watch list", async () => {
    const config = buildConfig("ew-objective-update");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com", objective: "Get a refund" });
    const updated = await setEmailWatcherObjective(config, watcher.id, " Accept a replacement instead ");
    expect(updated?.objective).toBe("Accept a replacement instead");
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBe("Accept a replacement instead");
    // A missing watcher returns undefined.
    expect(await setEmailWatcherObjective(config, "nope", "x")).toBeUndefined();
  });

  test("clearEmailWatcherObjective drops the goal and the watch list omits it", async () => {
    const config = buildConfig("ew-objective-clear");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com", objective: "Get a refund" });
    const cleared = await clearEmailWatcherObjective(config, watcher.id);
    expect(cleared?.objective).toBeUndefined();
    const job = readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    const watches = (job?.preRunHook?.config as { watches?: { objective?: string }[] }).watches ?? [];
    expect(watches[0]?.objective).toBeUndefined();
    // A missing watcher returns undefined.
    expect(await clearEmailWatcherObjective(config, "nope")).toBeUndefined();
  });
});

describe("derived watcher health (per-watcher byWatcher state)", () => {
  // Write the detection script's per-watch health blob onto the shared job's
  // hookState.byWatcher the way a tick would, then assert the email read path
  // surfaces it as the watcher's status/lastError.
  async function setByWatcher(
    config: ReturnType<typeof buildConfig>,
    jobId: string,
    watcherId: string,
    perWatcher: Record<string, unknown>
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) return;
      const hookState = (job.hookState ?? {}) as { byWatcher?: Record<string, unknown> };
      hookState.byWatcher = { ...(hookState.byWatcher ?? {}), [watcherId]: perWatcher };
      job.hookState = hookState as Record<string, unknown>;
    });
  }

  test("per-watcher needs_auth surfaces on list + get, isolated from a healthy sibling", async () => {
    const config = buildConfig("ew-health-needsauth");
    const w1 = await addEmailWatcher(config, { sender: "ken@x.com" });
    const w2 = await addEmailWatcher(config, { sender: "lena@x.com" });
    const jobId = w1.jobId!;
    await setByWatcher(config, jobId, w1.id, { cursor: "1000", seen: [], status: "needs_auth" });
    await setByWatcher(config, jobId, w2.id, { cursor: "2000", seen: [], status: "ok" });
    expect(listEmailWatchers(config).find((w) => w.id === w1.id)?.status).toBe("needs_auth");
    expect(getEmailWatcher(config, w1.id)?.status).toBe("needs_auth");
    // The sibling stays ok — per-watcher isolation.
    expect(getEmailWatcher(config, w2.id)?.status).toBe("ok");
  });

  test("a per-watcher gws error surfaces error + the scrubbed lastError", async () => {
    const config = buildConfig("ew-health-error");
    const watcher = await addEmailWatcher(config, { sender: "lara@x.com" });
    await setByWatcher(config, watcher.jobId!, watcher.id, {
      cursor: "1000",
      seen: [],
      status: "error",
      lastError: "gws failed reading <path>"
    });
    const derived = getEmailWatcher(config, watcher.id);
    expect(derived?.status).toBe("error");
    expect(derived?.lastError).toBe("gws failed reading <path>");
  });

  test("a healthy tick surfaces ok and clears a prior lastError", async () => {
    const config = buildConfig("ew-health-ok");
    const watcher = await addEmailWatcher(config, { sender: "mona@x.com" });
    await setByWatcher(config, watcher.jobId!, watcher.id, { status: "error", lastError: "boom" });
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("error");
    await setByWatcher(config, watcher.jobId!, watcher.id, { cursor: "2000", seen: ["m"], status: "ok" });
    const derived = getEmailWatcher(config, watcher.id);
    expect(derived?.status).toBe("ok");
    expect(derived?.lastError).toBeUndefined();
  });

  test("a watcher with no byWatcher entry yet keeps its stored status", async () => {
    const config = buildConfig("ew-health-none");
    const watcher = await addEmailWatcher(config, { sender: "nina@x.com" });
    // No hookState written yet (pre-first-tick) => stored status is surfaced.
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("ok");
  });

  test("health derives from the flat per-route hookState key (the current shape)", async () => {
    const config = buildConfig("ew-health-flat");
    const watcher = await addEmailWatcher(config, { sender: "owen@x.com" });
    // The current detect.ts writes per-route state at the TOP level of hookState
    // (keyed by routeKey = watcher id), NOT nested under byWatcher.
    await mutateState(config.instance, (state) => {
      const job = state.jobs.find((j) => j.id === watcher.jobId);
      if (job) job.hookState = { [watcher.id]: { cursor: "9", seen: [], status: "needs_auth" } };
    });
    expect(getEmailWatcher(config, watcher.id)?.status).toBe("needs_auth");
  });
});

describe("per-concern channels + fan-out routes", () => {
  test("add provisions a per-concern channel and a route targeting it", async () => {
    const config = buildConfig("ew-concern-add");
    const watcher = await addEmailWatcher(config, { sender: "pat@x.com" });
    expect(watcher.channelId).toBeString();
    // The channel is its OWN session, distinct from the shared job session.
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    expect(watcher.channelId).not.toBe(job?.chatSessionId);
    // The shared job's route table dispatches this concern's bucket into its channel.
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(watcher.channelId);
    expect(job?.routes?.[watcher.id]?.prompt).toContain("email-watch agent");
    // The per-concern channel carries the email-watch feature marker.
    const channel = readState(config.instance).chatSessions.find((s) => s.id === watcher.channelId);
    expect(channel?.feature).toBe("email-watch");
    expect(channel?.kind).toBe("channel");
  });

  test("a targeted concern's channel is titled distinctly, and the title survives a backfill", async () => {
    const config = buildConfig("ew-concern-title");
    const sender = await addEmailWatcher(config, { sender: "nadia@x.com" });
    const thread = await addEmailWatcher(config, { threadId: "thread-abc123" });
    const senderChannel = () =>
      readState(config.instance).chatSessions.find((s) => s.id === sender.channelId);
    const threadChannel = () =>
      readState(config.instance).chatSessions.find((s) => s.id === thread.channelId);
    expect(senderChannel()?.title).toBe("Email: nadia@x.com");
    expect(threadChannel()?.title).toBe("Email thread: thread-abc123");

    // The legacy rename-heal runs in backfill and renames the SHARED session to
    // "Email watch"; it must never clobber a per-concern channel's distinct title.
    await backfillEmailWatcherJobs(config);
    expect(senderChannel()?.title).toBe("Email: nadia@x.com");
    expect(threadChannel()?.title).toBe("Email thread: thread-abc123");
  });

  test("a persona watcher routes with a layered systemPrompt; toolsets pass through", async () => {
    const config = buildConfig("ew-concern-persona");
    const watcher = await addEmailWatcher(config, { sender: "quinn@x.com" });
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) {
        w.persona = "Be terse and formal.";
        w.toolsets = ["gmail"];
      }
    });
    // Re-stamp the persona/toolsets into the route via a rebuild (an enable no-op
    // is the simplest rebuild trigger that re-runs buildJobRoutes).
    await setEmailWatcherEnabled(config, watcher.id, true);
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    const route = job?.routes?.[watcher.id];
    expect(route?.systemPrompt).toContain("Be terse and formal.");
    expect(route?.systemPrompt).toContain("email-watch agent"); // layered over the shared playbook
    expect(route?.toolsets).toEqual(["gmail"]);
  });

  test("removing a concern drops its route and reclaims its channel", async () => {
    const config = buildConfig("ew-concern-remove");
    const keep = await addEmailWatcher(config, { sender: "rita@x.com" });
    const drop = await addEmailWatcher(config, { sender: "sam@x.com" });
    const dropChannelId = drop.channelId!;
    await removeEmailWatcher(config, drop.id);
    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === keep.jobId);
    // The removed concern's route is gone; the surviving concern's stays.
    expect(job?.routes?.[drop.id]).toBeUndefined();
    expect(job?.routes?.[keep.id]?.chatSessionId).toBe(keep.channelId);
    // The removed concern's channel was reclaimed; the survivor's was NOT swept.
    expect(state.chatSessions.some((s) => s.id === dropChannelId)).toBe(false);
    expect(state.chatSessions.some((s) => s.id === keep.channelId)).toBe(true);
  });

  test("disabling a concern drops its route but keeps its channel for re-enable", async () => {
    const config = buildConfig("ew-concern-disable");
    const watcher = await addEmailWatcher(config, { sender: "tom@x.com" });
    const channelId = watcher.channelId!;
    await setEmailWatcherEnabled(config, watcher.id, false);
    // Disabling the last enabled watcher tears the shared job down, so re-enable to
    // re-provision and confirm the SAME concern channel is reused (never swept).
    await setEmailWatcherEnabled(config, watcher.id, true);
    const reenabled = getEmailWatcher(config, watcher.id);
    expect(reenabled?.channelId).toBe(channelId);
    const job = readState(config.instance).jobs.find((j) => j.id === reenabled?.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(channelId);
    expect(readState(config.instance).chatSessions.some((s) => s.id === channelId)).toBe(true);
  });

  test("channel migration backfills an enabled watcher that predates per-concern channels (once)", async () => {
    const config = buildConfig("ew-concern-migrate");
    const watcher = await addEmailWatcher(config, { sender: "uma@x.com" });
    // Simulate a pre-migration install: strip the channel + the run-once marker,
    // leaving the watcher routing to the shared session only.
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) w.channelId = undefined;
      state.emailWatcherChannelsMigratedAt = undefined;
      const job = state.jobs.find((j) => j.id === watcher.jobId);
      if (job) job.routes = {};
    });
    await backfillEmailWatcherJobs(config);
    const migrated = getEmailWatcher(config, watcher.id);
    expect(migrated?.channelId).toBeString();
    const job = readState(config.instance).jobs.find((j) => j.id === migrated?.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(migrated?.channelId);
    expect(readState(config.instance).emailWatcherChannelsMigratedAt).toBeString();

    // Idempotent: a second backfill neither re-migrates nor mints a new channel.
    const channelId = migrated?.channelId;
    await backfillEmailWatcherJobs(config);
    expect(getEmailWatcher(config, watcher.id)?.channelId).toBe(channelId);
  });

  test("an unmigrated watcher routes to the shared session until it gets a channel", async () => {
    const config = buildConfig("ew-concern-fallback");
    const watcher = await addEmailWatcher(config, { sender: "vera@x.com" });
    const sharedSessionId = readState(config.instance).jobs.find((j) => j.id === watcher.jobId)?.chatSessionId;
    // Drop the channel WITHOUT running migration (marker stays set) — the route
    // must fall back to the shared session, never losing delivery.
    await mutateState(config.instance, (state) => {
      const w = state.emailWatchers.find((x) => x.id === watcher.id);
      if (w) w.channelId = undefined;
    });
    await setEmailWatcherEnabled(config, watcher.id, true); // rebuild routes
    const job = readState(config.instance).jobs.find((j) => j.id === watcher.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(sharedSessionId);
  });
});

describe("broad/topic watch delivers into the originating session", () => {
  // Mint the conversation/topic the watch was set up in, owned by the active
  // agent (the one addEmailWatcher stamps onto its watchers), and return its id.
  async function createTopic(config: ReturnType<typeof buildConfig>, title: string): Promise<string> {
    const agentId = readState(config.instance).activeAgentId;
    return mutateState(config.instance, (state) =>
      createChatSession(state, title, undefined, agentId, undefined, "topic").id
    );
  }

  test("a broad watch with deliverToSessionId routes drafts into that session, minting no generic channel", async () => {
    const config = buildConfig("ew-broad-deliver");
    const topicId = await createTopic(config, "Investor inbound");
    const watcher = await addEmailWatcher(config, {
      query: "in:inbox",
      objective: "Flag investor intros",
      deliverToSessionId: topicId
    });
    // The watcher delivers into the originating topic, not a new concern channel.
    expect(watcher.channelId).toBe(topicId);
    const state = readState(config.instance);
    // The shared job routes this concern's bucket into the originating topic.
    const job = state.jobs.find((j) => j.id === watcher.jobId);
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(topicId);
    // No generic "Email watch" concern channel was minted for this watch — the
    // only email-watch-feature sessions are the shared job session (and nothing
    // else titled "Email watch" as a NEW channel for this concern).
    const concernChannels = state.chatSessions.filter(
      (s) => s.kind === "channel" && s.feature === "email-watch" && s.id !== job?.chatSessionId
    );
    expect(concernChannels).toHaveLength(0);
    // The originating topic keeps its own identity (not stamped as email-watch).
    expect(state.chatSessions.find((s) => s.id === topicId)?.feature).toBeUndefined();
  });

  test("a broad watch with a non-existent deliverToSessionId falls back to a created concern channel", async () => {
    const config = buildConfig("ew-broad-fallback-missing");
    const watcher = await addEmailWatcher(config, {
      query: "in:inbox",
      deliverToSessionId: "does-not-exist"
    });
    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === watcher.jobId);
    // No matching session => fall back to a dedicated concern channel (current behavior).
    expect(watcher.channelId).toBeString();
    expect(watcher.channelId).not.toBe("does-not-exist");
    expect(watcher.channelId).not.toBe(job?.chatSessionId);
    const channel = state.chatSessions.find((s) => s.id === watcher.channelId);
    expect(channel?.feature).toBe("email-watch");
    expect(channel?.kind).toBe("channel");
    expect(job?.routes?.[watcher.id]?.chatSessionId).toBe(watcher.channelId);
  });

  test("a SENDER watch ignores deliverToSessionId and keeps its descriptive concern channel", async () => {
    const config = buildConfig("ew-sender-ignores-deliver");
    const topicId = await createTopic(config, "Receipts");
    const watcher = await addEmailWatcher(config, {
      sender: "alice@x.com",
      deliverToSessionId: topicId
    });
    // The broad-only gate: a sender watch never delivers into the originating
    // session — it gets its own descriptive "Email: <sender>" channel.
    expect(watcher.channelId).not.toBe(topicId);
    const channel = readState(config.instance).chatSessions.find((s) => s.id === watcher.channelId);
    expect(channel?.title).toBe("Email: alice@x.com");
    expect(channel?.feature).toBe("email-watch");
  });

  test("removing a broad watch whose channel is the originating topic does NOT delete that topic", async () => {
    const config = buildConfig("ew-broad-remove-keeps-topic");
    const topicId = await createTopic(config, "Investor inbound");
    const watcher = await addEmailWatcher(config, { query: "in:inbox", deliverToSessionId: topicId });
    expect(watcher.channelId).toBe(topicId);
    await removeEmailWatcher(config, watcher.id);
    const state = readState(config.instance);
    // The watcher is gone; the originating topic survives the teardown + orphan sweep
    // (it carries no email-watch feature marker, so the identity sweep never deletes it).
    expect(state.emailWatchers.find((w) => w.id === watcher.id)).toBeUndefined();
    expect(state.chatSessions.some((s) => s.id === topicId)).toBe(true);
    expect(state.chatSessions.find((s) => s.id === topicId)?.feature).toBeUndefined();
  });
});

describe("triage concern + intelligent router", () => {
  // The agent's triage channel by identity (feature marker + the triage title).
  function triageChannels(config: ReturnType<typeof buildConfig>) {
    return readState(config.instance).chatSessions.filter(
      (s) => s.kind === "channel" && s.feature === "email-watch" && s.title === "Inbox triage"
    );
  }
  function sharedJob(config: ReturnType<typeof buildConfig>) {
    return readState(config.instance).jobs.find(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
  }
  function allWatches(config: ReturnType<typeof buildConfig>) {
    return (sharedJob(config)?.preRunHook?.config as { watches?: { watcherId: string; routeKey?: string; query: string }[] }).watches ?? [];
  }
  // Opt the ACTIVE agent (the one addEmailWatcher stamps onto its watchers) in or
  // out of whole-inbox triage — mirrors how the tool/API resolve the agent.
  function enableTriage(config: ReturnType<typeof buildConfig>, enabled: boolean) {
    return setEmailTriageEnabled(config, readState(config.instance).activeAgentId, enabled);
  }

  test("a sender/thread watch alone provisions NO triage (triage is opt-in)", async () => {
    const config = buildConfig("ew-triage-optin-default-off");
    await addEmailWatcher(config, { sender: "alice@x.com" });
    await addEmailWatcher(config, { threadId: "t-no-triage" });
    // No triage channel, no triage watch, no triage route — only the targeted watches.
    expect(triageChannels(config)).toHaveLength(0);
    expect(allWatches(config).some((w) => w.watcherId === "triage")).toBe(false);
    expect(sharedJob(config)?.routes?.triage).toBeUndefined();
  });

  test("opting in (triage:true) provisions a SINGLE triage channel + a broad in:inbox triage watch + route", async () => {
    const config = buildConfig("ew-triage-provision");
    await addEmailWatcher(config, { sender: "alice@x.com" });
    // Before opt-in there is no triage.
    expect(triageChannels(config)).toHaveLength(0);
    await enableTriage(config, true);
    // Exactly one triage channel for the agent.
    expect(triageChannels(config)).toHaveLength(1);
    const triageId = triageChannels(config)[0]!.id;
    // The watch list carries the constant triage watch: broad in:inbox, keyed by
    // the constant "triage" routeKey, with no sender/threadId (so detect treats it
    // as the non-targeted remainder bucket).
    const triageWatch = allWatches(config).find((w) => w.watcherId === "triage");
    expect(triageWatch).toMatchObject({ watcherId: "triage", routeKey: "triage", query: "in:inbox" });
    expect((triageWatch as { sender?: string }).sender).toBeUndefined();
    expect((triageWatch as { threadId?: string }).threadId).toBeUndefined();
    // The shared job routes the "triage" bucket into the triage channel.
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);
  });

  test("triage-only lifecycle: enabling with ZERO targeted watchers provisions the job; disabling tears it down", async () => {
    const config = buildConfig("ew-triage-only-lifecycle");
    // The "watch my inbox and handle investor inbound" path: triage is opted in
    // with NO targeted watcher ever added, so triage alone must provision + own
    // the backing job. Before opt-in nothing exists.
    expect(sharedJob(config)).toBeUndefined();
    expect(triageChannels(config)).toHaveLength(0);

    await enableTriage(config, true);
    // Exactly one shared gmail-watch job is provisioned, so Gmail is actually polled.
    const jobs = readState(config.instance).jobs.filter(
      (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
    );
    expect(jobs).toHaveLength(1);
    // Its watch list is the broad triage watch ALONE, and its routes include triage.
    expect(new Set(allWatches(config).map((w) => w.watcherId))).toEqual(new Set(["triage"]));
    expect(allWatches(config).find((w) => w.watcherId === "triage")).toMatchObject({
      watcherId: "triage",
      routeKey: "triage",
      query: "in:inbox"
    });
    const triageId = triageChannels(config)[0]!.id;
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);

    // Disabling with zero targeted watchers tears the job AND the triage channel down.
    await enableTriage(config, false);
    expect(
      readState(config.instance).jobs.filter(
        (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
      )
    ).toHaveLength(0);
    expect(triageChannels(config)).toHaveLength(0);
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(false);
  });

  test("opting out (triage:false) removes the triage channel + watch + route", async () => {
    const config = buildConfig("ew-triage-optout");
    const watcher = await addEmailWatcher(config, { sender: "bob@x.com" });
    await enableTriage(config, true);
    const triageId = triageChannels(config)[0]!.id;
    expect(triageId).toBeString();
    await enableTriage(config, false);
    // Triage gone; the targeted watcher and its route survive untouched.
    expect(triageChannels(config)).toHaveLength(0);
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(false);
    expect(allWatches(config).some((w) => w.watcherId === "triage")).toBe(false);
    expect(sharedJob(config)?.routes?.triage).toBeUndefined();
    expect(sharedJob(config)?.routes?.[watcher.id]?.chatSessionId).toBe(watcher.channelId);
  });

  test("opting in is idempotent — it never duplicates the triage concern", async () => {
    const config = buildConfig("ew-triage-idempotent");
    await addEmailWatcher(config, { sender: "bob@x.com" });
    await enableTriage(config, true);
    const triageId = triageChannels(config)[0]!.id;
    await enableTriage(config, true);
    await addEmailWatcher(config, { sender: "carol@x.com" });
    await addEmailWatcher(config, { query: "subject:invoice" });
    // Still exactly one triage channel (same id), one triage watch, one triage route.
    expect(triageChannels(config)).toHaveLength(1);
    expect(triageChannels(config)[0]!.id).toBe(triageId);
    expect(allWatches(config).filter((w) => w.watcherId === "triage")).toHaveLength(1);
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);
  });

  test("the triage route is a CONSTRAINED subagent: respond-or-flag systemPrompt + minimal toolset whitelist", async () => {
    const config = buildConfig("ew-triage-route");
    await addEmailWatcher(config, { sender: "dave@x.com" });
    await enableTriage(config, true);
    const route = sharedJob(config)?.routes?.triage;
    expect(route).toBeDefined();
    // The respond-or-flag playbook, with the untrusted-fence rule preserved.
    expect(route?.systemPrompt).toContain("triaging newly-arrived emails that matched no specific watch");
    expect(route?.systemPrompt).toContain("UNTRUSTED quoted data");
    // Work from the included body; an optional thread fetch is by exact id, never
    // a search, and a failed fetch must not bail.
    expect(route?.systemPrompt).toContain("work from its included `body`");
    expect(route?.systemPrompt).toContain("NEVER search by subject, sender, or keywords to locate it");
    expect(route?.systemPrompt).toContain("work from the PROVIDED BODY anyway");
    expect(route?.systemPrompt).toContain("SAFE structured identifiers");
    expect(route?.systemPrompt).toContain("⏸ Needs your input");
    expect(route?.systemPrompt).toContain("PROPOSED reply");
    // It can escalate a coherent thread into its own concern via email_watch.
    expect(route?.systemPrompt).toContain("email_watch");
    expect(route?.systemPrompt).toContain("[SILENT]");
    // The minimal whitelist: email (owns email_watch) + terminal (owns the gws CLI
    // via terminal_exec). read_skill / the gmail skill ride in unconstrained.
    expect(route?.toolsets).toEqual(["email", "terminal"]);
    expect(route?.toolsets).not.toContain("messaging");
  });

  test("removing the last targeted watcher while triage stays on keeps the job + triage channel alive", async () => {
    const config = buildConfig("ew-triage-teardown");
    const watcher = await addEmailWatcher(config, { sender: "erin@x.com" });
    await enableTriage(config, true);
    const triageId = triageChannels(config)[0]!.id;
    expect(triageId).toBeString();
    await removeEmailWatcher(config, watcher.id);
    // Triage is a self-sufficient reason for the shared job to exist: removing the
    // last targeted watcher must NOT tear it down while triage is still opted in.
    expect(sharedJob(config)).toBeDefined();
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(true);
    // The job now polls the whole inbox via the broad triage watch + route alone.
    expect(new Set(allWatches(config).map((w) => w.watcherId))).toEqual(new Set(["triage"]));
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);
    // Opting OUT then tears the job + triage channel down (no watchers, triage off).
    await enableTriage(config, false);
    expect(sharedJob(config)).toBeUndefined();
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(false);
  });

  test("the triage channel survives removing a non-last watcher (never swept while live)", async () => {
    const config = buildConfig("ew-triage-survives");
    const keep = await addEmailWatcher(config, { sender: "frank@x.com" });
    const drop = await addEmailWatcher(config, { sender: "grace@x.com" });
    await enableTriage(config, true);
    const triageId = triageChannels(config)[0]!.id;
    await removeEmailWatcher(config, drop.id);
    // The remove rebuild + orphan sweep ran; the triage channel must NOT be swept.
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(true);
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);
    expect(sharedJob(config)?.routes?.[keep.id]?.chatSessionId).toBe(keep.channelId);
  });

  test("escalation: an email_watch add from a triage context mints a concern + its own route", async () => {
    const config = buildConfig("ew-triage-escalate");
    // A live install with triage opted in, running over one watcher.
    const existing = await addEmailWatcher(config, { sender: "heidi@x.com" });
    await enableTriage(config, true);
    const job = sharedJob(config)!;
    expect(job.routes?.triage).toBeDefined();
    // The triage worker, having recognized an ongoing thread, calls email_watch —
    // the SAME addEmailWatcher path a triage-context tool call reaches. It mints a
    // dedicated concern (its own channel + route) and the next rebuild wires it.
    const escalated = await addEmailWatcher(config, {
      threadId: "t-escalated",
      objective: "Resolve the billing dispute"
    });
    expect(escalated.channelId).toBeString();
    expect(escalated.channelId).not.toBe(existing.channelId);
    const after = sharedJob(config)!;
    // The new concern has its own route into its own channel.
    expect(after.routes?.[escalated.id]?.chatSessionId).toBe(escalated.channelId);
    // The new concern is a targeted (thread) watch, so detect claims its mail before
    // triage — the watch list carries it, and the triage watch is still present.
    const ids = new Set(allWatches(config).map((w) => w.watcherId));
    expect(ids.has(escalated.id)).toBe(true);
    expect(ids.has("triage")).toBe(true);
    expect(allWatches(config).find((w) => w.watcherId === escalated.id)).toMatchObject({ query: "thread:t-escalated" });
  });

  test("backfill never force-deletes an existing opted-in triage concern", async () => {
    const config = buildConfig("ew-triage-backfill-preserve");
    await addEmailWatcher(config, { sender: "ivan@x.com" });
    await enableTriage(config, true);
    const triageId = triageChannels(config)[0]!.id;
    expect(triageId).toBeString();
    // The startup self-heal must not strip a triage concern the agent opted into.
    await backfillEmailWatcherJobs(config);
    expect(readState(config.instance).chatSessions.some((s) => s.id === triageId)).toBe(true);
    expect(allWatches(config).some((w) => w.watcherId === "triage")).toBe(true);
    expect(sharedJob(config)?.routes?.triage?.chatSessionId).toBe(triageId);
  });

  test("backfill does NOT auto-create triage for an install that never opted in", async () => {
    const config = buildConfig("ew-triage-backfill-no-optin");
    await addEmailWatcher(config, { sender: "judy@x.com" });
    await backfillEmailWatcherJobs(config);
    // No opt-in => no triage, even after the self-heal pass.
    expect(triageChannels(config)).toHaveLength(0);
    expect(allWatches(config).some((w) => w.watcherId === "triage")).toBe(false);
    expect(sharedJob(config)?.routes?.triage).toBeUndefined();
  });
});
