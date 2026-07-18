// Tests for the web onboarding API (ADR web-onboarding-flow.md), exercised
// through the HTTP handler so route wiring + status mapping are covered:
//   - grandfathering: existing USER usage (contentful session, task, or job)
//     → completed on first GET; fresh → not; runtime-created sessions/tasks
//     and empty auto-materialized agent sessions alone never grandfather
//   - PATCH validation (timezone/theme/completed) and completedAt stamping
//   - scan: no_account detection, background run→ready/failed finalization
//     (with an `onboarding` event pushed), idempotency, failed→resubmit retry,
//     and the staleness guard that reclaims a restart-orphaned running scan
//   - routines: exactly the enabled jobs with the specced cron/tz/skills,
//     idempotent replace on re-apply, missing ids ignored, skill resolution
//     pre-validated before the replace pass, created ids tracked through a
//     mid-apply failure
//   - validateScanProfile / validateScanTasks / validateScanRoutines
//     shape-check + clamping unit coverage
//
// Hermetic: HOME + GINI_STATE_ROOT point at a per-test scratch dir so the
// google-accounts registry, ~/.config/gws probe, and instance state never
// touch the developer machine; the provider is the echo stub (no network). The
// deterministic scan pipeline (onboarding-scan.ts, which spawns gws) is mocked
// so these tests exercise only the record-state transitions, never a
// subprocess; the pipeline itself is unit-tested in onboarding-scan.test.ts.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Controllable stub for the background scan pipeline, installed before ../http
// (and thus ../runtime/onboarding, which statically imports runProfileScan) is
// evaluated. Tests set `scanOutcome` / `scanDelayMs` to steer a run's result
// without spawning gws or hitting the model. Defaults to a ready profile.
let scanOutcome:
  | {
      status: "ready";
      profile: OnboardingProfile;
      suggestedTasks?: string[];
      suggestedRoutines?: OnboardingRoutineSuggestion[];
    }
  | { status: "failed"; error: string } = {
  status: "ready",
  profile: { displayName: "Stub User", sections: [{ title: "Professional Identity", bullets: ["Founder"] }] },
  suggestedTasks: ["Reply to the investor thread"],
  suggestedRoutines: [
    { name: "Draft a weekly founder update", description: "Draft a weekly progress update for review.", usesEmail: true }
  ]
};
let scanCalls = 0;
mock.module("./onboarding-scan", () => ({
  runProfileScan: async (_config: RuntimeConfig, opts?: { onMailboxFetched?: (snapshot: unknown) => void }) => {
    scanCalls += 1;
    opts?.onMailboxFetched?.({
      threads: [{
        threadId: "thread_from_onboarding",
        messages: [{
          id: "message_from_onboarding",
          threadId: "thread_from_onboarding",
          date: 1_000,
          from: { address: "user@example.com" },
          to: [{ address: "friend@example.com" }],
          cc: [],
          subject: "Hello",
          body: "Recent onboarding mail",
        }],
      }],
    });
    return scanOutcome;
  }
}));

import { createHandler } from "../http";
import * as jobsModule from "../jobs";
import { createJob, mutateState, readState, upsertTask, createChatSession } from "../state";
import { attachGoogleAccountToInstance } from "../state/google-account-bindings";
import { writeGoogleAccounts } from "../state/google-accounts";
import { onboardingPath, readOnboarding, writeOnboarding } from "../state/onboarding";
import { validateScanProfile, validateScanRoutines, validateScanTasks } from "./onboarding";
import { __crmOnboardingThreadCountForTests } from "../jobs/crm-extractor";
import { getCrmRunState } from "../state/crm-extraction-db";
import type { OnboardingProfile, OnboardingRecord, OnboardingRoutineSuggestion, RuntimeConfig, Task, TaskStatus } from "../types";

// Snapshot of the real jobs module, captured before any mock.module call:
// once a mock is installed the namespace's live bindings point at the mock,
// so restoring requires the pre-mock references.
const jobsOriginals = { ...jobsModule };

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function bindTestGoogleAccount(instance: string): void {
  const account = {
    id: "gacct_test",
    tag: "personal",
    email: "user@example.com",
    configDir: "/tmp/none",
    addedAt: new Date().toISOString()
  };
  writeGoogleAccounts([account]);
  attachGoogleAccountToInstance(instance, account, { primary: true });
}

describe("web onboarding api", () => {
  let env: {
    HOME?: string;
    GINI_STATE_ROOT?: string;
    GINI_LOG_ROOT?: string;
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE?: string;
  };
  let root: string;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      GINI_LOG_ROOT: process.env.GINI_LOG_ROOT,
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE
    };
    root = `/tmp/gini-onboarding-tests/${tag()}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "home"), { recursive: true });
    // HOME drives the google-accounts registry and the ~/.config/gws probe;
    // GINI_STATE_ROOT drives instanceRoot (state.json + onboarding.json).
    process.env.HOME = join(root, "home");
    process.env.GINI_STATE_ROOT = join(root, "state");
    process.env.GINI_LOG_ROOT = join(root, "logs");
    delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    scanCalls = 0;
    scanOutcome = {
      status: "ready",
      profile: { displayName: "Stub User", sections: [{ title: "Professional Identity", bullets: ["Founder"] }] },
      suggestedTasks: ["Reply to the investor thread"],
      suggestedRoutines: [
        { name: "Draft a weekly founder update", description: "Draft a weekly progress update for review.", usesEmail: true }
      ]
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key as keyof typeof env];
      else process.env[key as keyof typeof env] = value;
    }
  });

  test("grandfathers instances with existing usage on first read", async () => {
    const config = testConfig(root, "grandfather");
    const handler = createHandler(config);
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Existing chat");
      session.messageIds.push("msg_existing");
    });

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(true);
    expect(record.completedAt).toBeString();
    // Persisted immediately so later reads don't re-derive it.
    expect(readOnboarding(config.instance)?.completed).toBe(true);
  });

  test("grandfathers instances whose only usage is scheduled jobs", async () => {
    const config = testConfig(root, "grandfather-jobs");
    const handler = createHandler(config);
    // An existing instance can hold nothing but jobs (every session
    // job-origin, every task jobId-stamped) — still an existing user.
    await mutateState(config.instance, (state) =>
      createJob(state, { name: "Existing job", prompt: "do the thing", intervalSeconds: 3600, nextRunAt: new Date().toISOString() })
    );

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(true);
    expect(readOnboarding(config.instance)?.completed).toBe(true);
  });

  test("runtime-created sessions and job tasks alone do not grandfather", async () => {
    const config = testConfig(root, "no-grandfather-runtime");
    const handler = createHandler(config);
    // The daily skill-review tick creates a job-origin, feature-stamped
    // channel on its own after 24h uptime, and cron jobs create tasks plus
    // subagent children — none of that is a human using the instance.
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Skill review", undefined, undefined, "job", "channel");
      session.feature = "skill-review";
    });
    await seedTask(config, "task_from_job", "completed", { jobId: "job_1" });
    await seedTask(config, "task_subagent", "completed", { parentTaskId: "task_from_job" });

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(false);
    expect(existsSync(onboardingPath(config.instance))).toBe(false);
  });

  test("an empty auto-materialized agent session does not grandfather", async () => {
    const config = testConfig(root, "no-grandfather-empty-agent");
    const handler = createHandler(config);
    // GET /api/agents/:id/chat materializes the agent's canonical kind:"agent"
    // session as a side effect — empty, no human involved. Only a session
    // with content counts as user evidence.
    await mutateState(config.instance, (state) => createChatSession(state, "Gini", undefined, "agent_main", undefined, "agent"));

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(false);
    expect(existsSync(onboardingPath(config.instance))).toBe(false);
  });

  test("fresh instances start not completed and persist nothing on GET", async () => {
    const config = testConfig(root, "fresh");
    const handler = createHandler(config);

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(false);
    expect(record.scan.status).toBe("idle");
    expect(record.routineJobIds).toEqual([]);
    expect(existsSync(onboardingPath(config.instance))).toBe(false);
  });

  test("an existing record is never re-grandfathered", async () => {
    const config = testConfig(root, "no-regrandfather");
    const handler = createHandler(config);
    await call(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ theme: "light" }) });
    await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Later chat");
      session.messageIds.push("msg_later");
    });

    const record = await call(handler, config, "/api/onboarding");

    expect(record.completed).toBe(false);
  });

  test("PATCH validates timezone, theme, and completed", async () => {
    const config = testConfig(root, "patch-validate");
    const handler = createHandler(config);

    const badTz = await rawCall(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ timezone: "Not/AZone" }) });
    const badTheme = await rawCall(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ theme: "blue" }) });
    const badCompleted = await rawCall(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ completed: "yes" }) });

    expect(badTz.status).toBe(400);
    expect(badTheme.status).toBe(400);
    expect(badCompleted.status).toBe(400);
    // Rejected patches persist nothing.
    expect(readOnboarding(config.instance)).toBeUndefined();

    const patched = await call(handler, config, "/api/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ timezone: "America/Los_Angeles", theme: "dark" })
    });
    expect(patched.timezone).toBe("America/Los_Angeles");
    expect(patched.theme).toBe("dark");
    expect(patched.completed).toBe(false);

    // Canonical zones browsers report (Asia/Kolkata, Europe/Kyiv) are absent
    // from this runtime's supportedValuesOf list, which only carries their
    // legacy aliases — the probe-based validation must accept them anyway.
    const kolkata = await call(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ timezone: "Asia/Kolkata" }) });
    expect(kolkata.timezone).toBe("Asia/Kolkata");
    const kyiv = await call(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ timezone: "Europe/Kyiv" }) });
    expect(kyiv.timezone).toBe("Europe/Kyiv");

    const completed = await call(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ completed: true }) });
    expect(completed.completed).toBe(true);
    expect(completed.completedAt).toBeString();
  });

  test("scan lands in no_account without Google access, then runs after an account registers", async () => {
    const config = testConfig(root, "scan-no-account");
    const handler = createHandler(config);

    const denied = await call(handler, config, "/api/onboarding/scan", { method: "POST" });
    expect(denied.scan.status).toBe("no_account");
    expect(scanCalls).toBe(0);

    // A registered account explicitly bound to this instance flips the retry
    // to a real background run.
    bindTestGoogleAccount(config.instance);
    const started = await call(handler, config, "/api/onboarding/scan", { method: "POST" });
    // Returns immediately as running (no taskId — no agent task) while the
    // pipeline runs in the background.
    expect(started.scan.status).toBe("running");
    expect(started.scan).not.toHaveProperty("taskId");
    expect(started.scan.startedAt).toBeString();

    // The background pipeline finalizes the record to ready and pushes an
    // onboarding event so the browser refetches.
    const ready = await waitForScan(config, "ready");
    expect(ready.scan.profile.displayName).toBe("Stub User");
    expect(ready.scan.suggestedTasks).toEqual(["Reply to the investor thread"]);
    expect(ready.scan.suggestedRoutines?.[0]?.name).toBe("Draft a weekly founder update");
    expect(ready.scan.finishedAt).toBeString();
    expect(scanCalls).toBe(1);
    expect(__crmOnboardingThreadCountForTests(config.instance)).toBe(1);
    expect(getCrmRunState(config.instance)).toBe("idle");
    expect(readState(config.instance).events.some((e) => e.kind === "onboarding" && e.action === "onboarding.scan")).toBe(true);
  });

  test("completing onboarding leaves People extraction idle until explicit sync", async () => {
    const config = testConfig(root, "completion-keeps-people-idle");
    const handler = createHandler(config);

    expect(getCrmRunState(config.instance)).toBe("idle");
    const completed = await call(handler, config, "/api/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ completed: true }),
    });
    expect(completed.completed).toBe(true);
    expect(getCrmRunState(config.instance)).toBe("idle");
  });

  test("a failed pipeline finalizes the scan as failed", async () => {
    const config = testConfig(root, "scan-pipeline-failed");
    const handler = createHandler(config);
    bindTestGoogleAccount(config.instance);
    scanOutcome = { status: "failed", error: "No signed-in Google session — connect an account and try again." };

    const started = await call(handler, config, "/api/onboarding/scan", { method: "POST" });
    expect(started.scan.status).toBe("running");

    const failed = await waitForScan(config, "failed");
    expect(failed.scan.error).toContain("No signed-in Google session");
    expect(failed.scan.finishedAt).toBeString();
    expect(readState(config.instance).events.some((e) => e.kind === "onboarding")).toBe(true);
  });

  test("scan is idempotent while running and once ready", async () => {
    const config = testConfig(root, "scan-idempotent");
    const handler = createHandler(config);
    // A fresh running scan (started just now) is left in flight — a second POST
    // must not kick a second pipeline.
    writeOnboarding(config.instance, runningRecord());

    const running = await call(handler, config, "/api/onboarding/scan", { method: "POST" });
    expect(running.scan.status).toBe("running");
    expect(scanCalls).toBe(0);

    const ready: OnboardingRecord = { version: 1, completed: false, scan: { status: "ready", profile: { displayName: "U", sections: [] } }, routineJobIds: [] };
    writeOnboarding(config.instance, ready);
    const kept = await call(handler, config, "/api/onboarding/scan", { method: "POST" });
    expect(kept.scan.status).toBe("ready");
    expect(scanCalls).toBe(0);
  });

  test("a failed scan resubmits as a fresh run on the next POST", async () => {
    const config = testConfig(root, "scan-retry");
    const handler = createHandler(config);
    bindTestGoogleAccount(config.instance);
    // The web's step-3 "Try again" hits POST /onboarding/scan on exactly this
    // shape: a failed scan must flip back to running with a cleared error and
    // kick a fresh pipeline, while running/ready stay idempotent (pinned above).
    writeOnboarding(config.instance, {
      version: 1,
      completed: false,
      scan: { status: "failed", error: "provider exploded", finishedAt: new Date().toISOString() },
      routineJobIds: []
    });

    const retried = await call(handler, config, "/api/onboarding/scan", { method: "POST" });

    expect(retried.scan.status).toBe("running");
    expect(retried.scan.error).toBeUndefined();
    const ready = await waitForScan(config, "ready");
    expect(ready.scan.profile.displayName).toBe("Stub User");
    expect(scanCalls).toBe(1);
  });

  test("scan is a no-op once onboarding is completed", async () => {
    const config = testConfig(root, "scan-completed");
    const handler = createHandler(config);
    // Google access present and the scan idle — without the completed guard
    // this would submit a real task. The hazard: a completed user mounts
    // /onboarding briefly before the gate redirects home, and the page fires
    // POST /onboarding/scan on mount.
    bindTestGoogleAccount(config.instance);
    writeOnboarding(config.instance, {
      version: 1,
      completed: true,
      completedAt: new Date().toISOString(),
      scan: { status: "idle" },
      routineJobIds: []
    });

    const record = await call(handler, config, "/api/onboarding/scan", { method: "POST" });

    expect(record.completed).toBe(true);
    expect(record.scan.status).toBe("idle");
    expect(scanCalls).toBe(0);
  });

  test("GET leaves a fresh running scan in flight but fails a restart-orphaned one", async () => {
    const config = testConfig(root, "scan-staleness");
    const handler = createHandler(config);

    // A recently-started running scan is still finalizing via its background
    // pipeline — GET must not disturb it.
    writeOnboarding(config.instance, runningRecord());
    const live = await call(handler, config, "/api/onboarding");
    expect(live.scan.status).toBe("running");

    // A running scan whose startedAt is older than the staleness threshold was
    // orphaned by a runtime restart (its in-process pipeline died) — GET flips
    // it to failed so the web's "Try again" can resubmit.
    writeOnboarding(config.instance, {
      version: 1,
      completed: false,
      scan: { status: "running", startedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      routineJobIds: []
    });
    const stale = await call(handler, config, "/api/onboarding");
    expect(stale.scan.status).toBe("failed");
    expect(stale.scan.error).toContain("interrupted");
    // Persisted, so the next GET doesn't re-derive it.
    expect(readOnboarding(config.instance)?.scan.status).toBe("failed");
  });

  test("routines creates exactly the enabled jobs and replaces them on re-apply", async () => {
    const config = testConfig(root, "routines");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const first = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({
        timezone: "America/New_York",
        autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
        morningBriefing: { enabled: true, personalizedNews: true },
        meetingBriefing: { enabled: true }
      })
    });

    expect(first.jobs).toHaveLength(3);
    expect(first.record.routineJobIds).toHaveLength(3);
    const byName = Object.fromEntries(first.jobs.map((job: { name: string }) => [job.name, job]));
    expect(byName["Auto-inbox"].cronExpression).toBe("*/30 * * * *");
    expect(byName["Auto-inbox"].cronTimezone).toBe("America/New_York");
    expect(byName["Auto-inbox"].skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(byName["Auto-inbox"].status).toBe("active");
    expect(byName["Auto-inbox"].prompt).toContain("Label new mail");
    // archiveUnimportant:false ⇒ no label line carries the (auto-archive)
    // marker (the marker always follows the label name's closing quote).
    expect(byName["Auto-inbox"].prompt).not.toContain('" (auto-archive)');
    expect(byName["Auto-inbox"].prompt).toContain("never sends email");
    expect(byName["Morning Briefing"].cronExpression).toBe("0 8 * * *");
    expect(byName["Morning Briefing"].skillNames).toEqual(["google-gmail", "google-calendar"]);
    // Delivery is the routine's own conversation, never a forward into the
    // (hidden) main agent Chat.
    expect(byName["Morning Briefing"].forwardToChat).toBeUndefined();
    expect(byName["Morning Briefing"].prompt).toContain("news");
    expect(byName["Meeting Briefing"].cronExpression).toBe("*/15 * * * *");
    expect(byName["Meeting Briefing"].skillNames).toEqual(["google-calendar", "google-gmail"]);
    expect(byName["Meeting Briefing"].forwardToChat).toBeUndefined();

    // Re-apply with a smaller selection: the previous jobs are replaced, not
    // duplicated, and the omitted timezone falls back to the PATCHed record.
    await call(handler, config, "/api/onboarding", { method: "PATCH", body: JSON.stringify({ timezone: "Europe/Berlin" }) });
    const second = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ morningBriefing: { enabled: true, personalizedNews: false } })
    });
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0].name).toBe("Morning Briefing");
    expect(second.jobs[0].cronTimezone).toBe("Europe/Berlin");
    expect(second.jobs[0].prompt).not.toContain("news");
    const jobs = readState(config.instance).jobs.filter((job) => ["Auto-inbox", "Morning Briefing", "Meeting Briefing"].includes(job.name));
    expect(jobs).toHaveLength(1);
    expect(second.record.routineJobIds).toEqual([second.jobs[0].id]);

    // A routine job deleted out-of-band is ignored by the replace pass.
    await call(handler, config, `/api/jobs/${second.jobs[0].id}`, { method: "DELETE" });
    const third = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ meetingBriefing: { enabled: true } })
    });
    expect(third.jobs).toHaveLength(1);
    expect(third.jobs[0].name).toBe("Meeting Briefing");
  });

  test("routines skips a disabled Auto-inbox and one with no behaviors, and rejects a bad timezone", async () => {
    const config = testConfig(root, "routines-edge");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const none = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({
        autoInbox: { enabled: false, labelNewMail: true, archiveUnimportant: true, assistScheduling: true, draftReplies: true },
        morningBriefing: { enabled: false, personalizedNews: true }
      })
    });
    expect(none.jobs).toHaveLength(0);
    expect(none.record.routineJobIds).toEqual([]);

    const emptyAutoInbox = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({
        autoInbox: { enabled: true, labelNewMail: false, archiveUnimportant: false, assistScheduling: false, draftReplies: false }
      })
    });
    expect(emptyAutoInbox.jobs).toHaveLength(0);

    const badTz = await rawCall(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ timezone: "Mars/Olympus", meetingBriefing: { enabled: true } })
    });
    expect(badTz.status).toBe(400);

    // A canonical zone absent from the runtime's supportedValuesOf list still
    // round-trips into the job's cronTimezone (croner resolves through Intl
    // too, so what the probe accepts never fails job creation).
    const kolkata = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ timezone: "Asia/Kolkata", meetingBriefing: { enabled: true } })
    });
    expect(kolkata.jobs).toHaveLength(1);
    expect(kolkata.jobs[0].cronTimezone).toBe("Asia/Kolkata");
  });

  test("routines rejects a disabled skill up front, leaving the previous jobs intact", async () => {
    const config = testConfig(root, "routines-prevalidate");
    const handler = createHandler(config);
    const skillIds = await seedWorkspaceSkills(handler, config);

    const first = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ timezone: "America/New_York", morningBriefing: { enabled: true, personalizedNews: false } })
    });
    expect(first.jobs).toHaveLength(1);

    // Meeting Briefing needs google-calendar; with that skill disabled the
    // apply must fail as a clean 400 BEFORE the replace pass deletes anything.
    await call(handler, config, `/api/skills/${skillIds["google-calendar"]}/disable`, { method: "POST" });
    const rejected = await rawCall(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ meetingBriefing: { enabled: true } })
    });
    expect(rejected.status).toBe(400);
    expect(readState(config.instance).jobs.map((job) => job.id)).toEqual([first.jobs[0].id]);
    expect(readOnboarding(config.instance)?.routineJobIds).toEqual([first.jobs[0].id]);
  });

  test("a job created before a mid-apply failure is tracked, so a retry replaces it", async () => {
    const config = testConfig(root, "routines-midloop");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // Force the SECOND creation to throw — the hazard pre-validation cannot
    // rule out (e.g. a skill disabled concurrently after the check). The job
    // created before the throw must already be tracked in routineJobIds.
    let calls = 0;
    mock.module("../jobs", () => ({
      ...jobsOriginals,
      createScheduledJob: ((...args: Parameters<typeof jobsOriginals.createScheduledJob>) => {
        calls += 1;
        if (calls === 2) throw new Error("Invalid input: injected creation failure");
        return jobsOriginals.createScheduledJob(...args);
      }) as typeof jobsOriginals.createScheduledJob
    }));
    try {
      const rejected = await rawCall(handler, config, "/api/onboarding/routines", {
        method: "POST",
        body: JSON.stringify({
          morningBriefing: { enabled: true, personalizedNews: false },
          meetingBriefing: { enabled: true }
        })
      });
      expect(rejected.status).toBe(400);
    } finally {
      mock.module("../jobs", () => jobsOriginals);
    }
    const survivors = readState(config.instance).jobs;
    expect(survivors).toHaveLength(1);
    expect(survivors[0].name).toBe("Morning Briefing");
    expect(readOnboarding(config.instance)?.routineJobIds).toEqual([survivors[0].id]);

    // The retry replaces the tracked survivor instead of duplicating it.
    const retry = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({ meetingBriefing: { enabled: true } })
    });
    expect(retry.jobs).toHaveLength(1);
    expect(readState(config.instance).jobs.map((job) => job.id)).toEqual([retry.jobs[0].id]);
  });

  test("validateScanProfile accepts the profile contract and rejects bad shapes", () => {
    const ok = validateScanProfile({ profile: { displayName: "U", sections: [{ title: "T", bullets: ["b"] }] } });
    expect(ok?.displayName).toBe("U");
    expect(ok?.sections[0]?.title).toBe("T");

    // Missing displayName, a section with no title, and non-objects are rejected.
    expect(validateScanProfile("nope")).toBeUndefined();
    expect(validateScanProfile({ profile: { sections: [] } })).toBeUndefined();
    expect(validateScanProfile({ profile: { displayName: "U", sections: [{ note: "missing title" }] } })).toBeUndefined();
  });

  test("validateScanProfile clamps oversized profiles", () => {
    const long = "x".repeat(400);
    const result = validateScanProfile({
      profile: {
        displayName: long,
        sections: Array.from({ length: 20 }, (_, i) => ({
          title: `section ${i} ${long}`,
          bullets: Array.from({ length: 20 }, () => long),
          note: "y".repeat(2000)
        }))
      }
    });

    expect(result?.displayName).toHaveLength(300);
    expect(result?.sections).toHaveLength(12);
    expect(result?.sections[0]?.bullets).toHaveLength(12);
    expect(result?.sections[0]?.bullets?.[0]).toHaveLength(300);
    expect(result?.sections[0]?.note).toHaveLength(1000);
  });

  test("validateScanTasks clamps the suggestion list and rejects non-list shapes", () => {
    // Non-string and empty entries are dropped rather than rejected.
    expect(validateScanTasks({ suggestedTasks: ["ok", 5, ""] })).toEqual(["ok"]);

    // A missing/non-array field and non-objects are rejected.
    expect(validateScanTasks("nope")).toBeUndefined();
    expect(validateScanTasks({})).toBeUndefined();
    expect(validateScanTasks({ suggestedTasks: "reply to boss" })).toBeUndefined();

    // The oversized suggestion is dropped (never a pre-checked one-click
    // seed), then the starter-task list caps at ten rows.
    const long = "x".repeat(400);
    const clamped = validateScanTasks({ suggestedTasks: [long, ...Array.from({ length: 14 }, (_, i) => `task ${i}`)] });
    expect(clamped).toHaveLength(10);
    expect(clamped?.[0]).toBe("task 0");
  });

  test("validateScanRoutines canonicalizes, dedupes, caps, and rejects bad shapes", () => {
    expect(
      validateScanRoutines({
        suggestedRoutines: [
          { name: "  Weekly   customer brief ", description: " Review\ncustomer themes each week. ", usesEmail: true },
          { name: "weekly customer brief", description: "duplicate", usesEmail: false },
          { name: "Missing email marker", description: "invalid" },
          null
        ]
      })
    ).toEqual([
      { name: "Weekly customer brief", description: "Review customer themes each week.", usesEmail: true }
    ]);

    expect(validateScanRoutines("nope")).toBeUndefined();
    expect(validateScanRoutines({})).toBeUndefined();
    expect(validateScanRoutines({ suggestedRoutines: "nope" })).toBeUndefined();

    const long = "x".repeat(400);
    const clamped = validateScanRoutines({
      suggestedRoutines: Array.from({ length: 8 }, (_, index) => ({
        name: `Routine ${index} ${long}`,
        description: long,
        usesEmail: index % 2 === 0
      }))
    });
    expect(clamped).toHaveLength(5);
    expect(clamped?.[0]?.name).toHaveLength(80);
    expect(clamped?.[0]?.description).toHaveLength(300);
  });
});

function runningRecord(): OnboardingRecord {
  return {
    version: 1,
    completed: false,
    scan: { status: "running", startedAt: new Date().toISOString() },
    routineJobIds: []
  };
}

function seedTask(config: RuntimeConfig, id: string, status: TaskStatus, fields: Partial<Task> = {}): Promise<Task> {
  const at = new Date().toISOString();
  return mutateState(config.instance, (state) =>
    upsertTask(state, {
      id,
      title: "Onboarding scan",
      input: "scan",
      status,
      instance: config.instance,
      createdAt: at,
      updatedAt: at,
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: [],
      ...fields
    })
  );
}

// The routines endpoint's skillNames validate against ENABLED skills; seed
// the two Workspace skills the specs reference (bundled in production) and
// return their ids by name so tests can disable one.
async function seedWorkspaceSkills(handler: ReturnType<typeof createHandler>, config: RuntimeConfig): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const name of ["google-gmail", "google-calendar"]) {
    const skill = await call(handler, config, "/api/skills", { method: "POST", body: JSON.stringify({ name, description: name }) });
    ids[name] = skill.id;
  }
  return ids;
}

// Poll (no fixed sleeps) until the background scan pipeline finalizes the
// persisted record to the expected terminal status, then return the record.
// Typed loosely (like the `call()` results) so assertions read the ready scan's
// profile/suggestions without narrowing the optional fields at every site.
async function waitForScan(config: RuntimeConfig, status: "ready" | "failed"): Promise<any> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const record = readOnboarding(config.instance);
    if (record?.scan.status === status) return record;
    await Bun.sleep(5);
  }
  throw new Error(`Scan did not reach ${status}`);
}

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) }
  }));
}

function testConfig(root: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: join(root, "state", "instances", instance),
    logRoot: join(root, "logs", instance),
    approvalMode: "strict"
  };
}
