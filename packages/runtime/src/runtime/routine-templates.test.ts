// Tests for the routine-template gallery (ADR routine-templates-gallery.md),
// exercised through the HTTP handler so route wiring + status mapping are
// covered:
//   - catalog buildSpec parity with the onboarding starter-routine specs
//     (prompts/crons/skills, incl. the Auto-inbox zero-behaviors → no spec
//     rule)
//   - GET reflects installed state (templateId join, agent scoping)
//   - install: templateId stamping, option defaults, idempotent per-template
//     replace, timezone precedence (payload > onboarding record > UTC),
//     skill-resolve 400 with zero side effects, payload validation, unknown
//     template → 404
//   - install persists the resolved options (defaults merged with overrides)
//     as templateOptions, and GET exposes them as installed.options
//   - uninstall: removes the installed job, 404 when nothing is installed
//   - install/uninstall are agent-scoped: one agent's install never touches
//     another agent's job for the same template
//   - the onboarding routines path stamps the same templateIds (and
//     templateOptions), and its replace pass reconciles gallery installs
//     (one live job per template)
//
// Hermetic: HOME + GINI_STATE_ROOT point at a per-test scratch dir so
// instance state never touches the developer machine; the provider is the
// echo stub (no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createHandler } from "../http";
import { readState } from "../state";
import { writeOnboarding } from "../state/onboarding";
import { ROUTINE_TEMPLATES, routineTemplate } from "./routine-templates";
import type { RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

describe("routine templates", () => {
  let env: { HOME?: string; GINI_STATE_ROOT?: string; GINI_LOG_ROOT?: string };
  let root: string;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      GINI_LOG_ROOT: process.env.GINI_LOG_ROOT
    };
    root = `/tmp/gini-routine-template-tests/${tag()}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "home"), { recursive: true });
    process.env.HOME = join(root, "home");
    process.env.GINI_STATE_ROOT = join(root, "state");
    process.env.GINI_LOG_ROOT = join(root, "logs");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key as keyof typeof env];
      else process.env[key as keyof typeof env] = value;
    }
  });

  test("buildSpec composes the starter-routine specs (parity with onboarding)", () => {
    const autoInbox = routineTemplate("auto-inbox")!.buildSpec(
      { labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
      "America/New_York"
    )!;
    expect(autoInbox.templateId).toBe("auto-inbox");
    expect(autoInbox.cronExpression).toBe("*/30 * * * *");
    expect(autoInbox.cronTimezone).toBe("America/New_York");
    expect(autoInbox.skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(autoInbox.prompt).toBe(
      [
        "Tidy the user's Gmail inbox: work through mail that arrived since the last run.",
        "- Label new mail into sensible Gmail labels.",
        "- Detect scheduling requests and propose times based on the user's calendar.",
        "- Draft (never send) replies to important emails awaiting a response.",
        "Gini never sends email or messages without the user's review — save drafts only, never send."
      ].join("\n")
    );

    // Without scheduling assist the calendar skill drops off; every behavior
    // toggled off yields no spec at all.
    const gmailOnly = routineTemplate("auto-inbox")!.buildSpec(
      { labelNewMail: true, archiveUnimportant: true, assistScheduling: false, draftReplies: false },
      "UTC"
    )!;
    expect(gmailOnly.skillNames).toEqual(["google-gmail"]);
    expect(gmailOnly.prompt).toContain("- Archive clearly-unimportant mail");
    expect(
      routineTemplate("auto-inbox")!.buildSpec(
        { labelNewMail: false, archiveUnimportant: false, assistScheduling: false, draftReplies: false },
        "UTC"
      )
    ).toBeUndefined();

    const morning = routineTemplate("morning-briefing")!.buildSpec({ personalizedNews: true }, "UTC")!;
    expect(morning.templateId).toBe("morning-briefing");
    expect(morning.cronExpression).toBe("0 8 * * *");
    expect(morning.skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(morning.forwardToChat).toBe(true);
    expect(morning.prompt).toBe(
      [
        "Prepare the user's morning briefing: a brief digest of important unread email plus today's calendar.",
        "Add a short section of news relevant to the user's work, using what you know about them from memory and their profile."
      ].join("\n")
    );
    const morningNoNews = routineTemplate("morning-briefing")!.buildSpec({ personalizedNews: false }, "UTC")!;
    expect(morningNoNews.prompt).toBe(
      "Prepare the user's morning briefing: a brief digest of important unread email plus today's calendar."
    );

    const meeting = routineTemplate("meeting-briefing")!.buildSpec({}, "UTC")!;
    expect(meeting.templateId).toBe("meeting-briefing");
    expect(meeting.cronExpression).toBe("*/15 * * * *");
    expect(meeting.skillNames).toEqual(["google-calendar", "google-gmail"]);
    expect(meeting.forwardToChat).toBe(true);
    expect(meeting.prompt).toBe(
      "Check the user's calendar for meetings starting within the next hour that haven't been briefed yet. When one is found, prepare a prep note: attendees, recent email context with them, and the agenda. Otherwise do nothing and finish quietly."
    );
  });

  test("GET lists the catalog and reflects installed state per agent", async () => {
    const config = testConfig(root, "templates-list");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const fresh = await call(handler, config, "/api/routines/templates");
    expect(fresh.templates.map((t: { id: string }) => t.id)).toEqual(ROUTINE_TEMPLATES.map((t) => t.id));
    expect(fresh.templates.every((t: { installed: unknown }) => t.installed === null)).toBe(true);
    // The presentation contract the gallery renders from.
    const autoInbox = fresh.templates[0];
    expect(autoInbox.name).toBe("Auto-inbox");
    expect(autoInbox.icon).toBe("inbox");
    expect(autoInbox.scheduleHint).toBe("Every 30 minutes");
    expect(autoInbox.options.map((o: { key: string }) => o.key)).toEqual([
      "labelNewMail",
      "archiveUnimportant",
      "assistScheduling",
      "draftReplies"
    ]);

    const job = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    const listed = await call(handler, config, "/api/routines/templates");
    const meeting = listed.templates.find((t: { id: string }) => t.id === "meeting-briefing");
    expect(meeting.installed).toEqual({ jobId: job.id, status: "active" });

    // Agent scoping mirrors GET /api/jobs: a filter naming another agent
    // hides the install; the owning agent's filter shows it.
    const other = await call(handler, config, "/api/routines/templates?agentId=agent_nope");
    expect(other.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed).toBeNull();
    const owner = await call(handler, config, `/api/routines/templates?agentId=${job.agentId}`);
    expect(owner.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed?.jobId).toBe(job.id);
  });

  test("install stamps templateId, applies option defaults, and replaces idempotently", async () => {
    const config = testConfig(root, "templates-install");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // Options omitted → the template defaults (archiveUnimportant off).
    const first = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ timezone: "Europe/Berlin" })
    });
    expect(first.templateId).toBe("auto-inbox");
    expect(first.cronExpression).toBe("*/30 * * * *");
    expect(first.cronTimezone).toBe("Europe/Berlin");
    expect(first.skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(first.prompt).toContain("- Label new mail");
    expect(first.prompt).not.toContain("- Archive clearly-unimportant mail");

    // Re-install with explicit options: the previous job is replaced, not
    // duplicated, and the prompt tracks the new selection.
    const second = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({
        timezone: "Europe/Berlin",
        options: { labelNewMail: false, archiveUnimportant: true, assistScheduling: false, draftReplies: false }
      })
    });
    expect(second.id).not.toBe(first.id);
    expect(second.skillNames).toEqual(["google-gmail"]);
    expect(second.prompt).toContain("- Archive clearly-unimportant mail");
    expect(second.prompt).not.toContain("- Label new mail");
    const jobs = readState(config.instance).jobs.filter((j) => j.templateId === "auto-inbox");
    expect(jobs.map((j) => j.id)).toEqual([second.id]);
  });

  test("install persists the resolved options and GET exposes them as installed.options", async () => {
    const config = testConfig(root, "templates-options");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // Options omitted → the template defaults, persisted in full.
    const first = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(first.templateOptions).toEqual({
      labelNewMail: true,
      archiveUnimportant: false,
      assistScheduling: true,
      draftReplies: true
    });

    // Partial overrides merge over the defaults before persisting.
    const second = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { archiveUnimportant: true, draftReplies: false } })
    });
    expect(second.templateOptions).toEqual({
      labelNewMail: true,
      archiveUnimportant: true,
      assistScheduling: true,
      draftReplies: false
    });

    const listed = await call(handler, config, "/api/routines/templates");
    const autoInbox = listed.templates.find((t: { id: string }) => t.id === "auto-inbox");
    expect(autoInbox.installed).toEqual({
      jobId: second.id,
      status: "active",
      options: {
        labelNewMail: true,
        archiveUnimportant: true,
        assistScheduling: true,
        draftReplies: false
      }
    });

    // A template without options carries no templateOptions at all.
    const meeting = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(meeting.templateOptions).toBeUndefined();
  });

  test("install timezone precedence: payload > onboarding record > UTC", async () => {
    const config = testConfig(root, "templates-timezone");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const utc = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(utc.cronTimezone).toBe("UTC");

    writeOnboarding(config.instance, {
      version: 1,
      completed: true,
      timezone: "Asia/Kolkata",
      scan: { status: "idle" },
      routineJobIds: []
    });
    const fromRecord = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(fromRecord.cronTimezone).toBe("Asia/Kolkata");

    const fromPayload = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({ timezone: "America/New_York" })
    });
    expect(fromPayload.cronTimezone).toBe("America/New_York");
  });

  test("install validates payload and template id", async () => {
    const config = testConfig(root, "templates-validate");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const missing = await rawCall(handler, config, "/api/routines/templates/nope/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(missing.status).toBe(404);

    const badTz = await rawCall(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({ timezone: "Mars/Olympus" })
    });
    expect(badTz.status).toBe(400);

    const unknownOption = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { sendEverything: true } })
    });
    expect(unknownOption.status).toBe(400);

    const nonBoolean = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { labelNewMail: "yes" } })
    });
    expect(nonBoolean.status).toBe(400);

    // Every Auto-inbox behavior off yields no spec — a clean 400, no job.
    const empty = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({
        options: { labelNewMail: false, archiveUnimportant: false, assistScheduling: false, draftReplies: false }
      })
    });
    expect(empty.status).toBe(400);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("install rejects a disabled skill up front, leaving the previous install intact", async () => {
    const config = testConfig(root, "templates-prevalidate");
    const handler = createHandler(config);
    const skillIds = await seedWorkspaceSkills(handler, config);

    const first = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });

    await call(handler, config, `/api/skills/${skillIds["google-calendar"]}/disable`, { method: "POST" });
    const rejected = await rawCall(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(rejected.status).toBe(400);
    expect(readState(config.instance).jobs.map((j) => j.id)).toEqual([first.id]);
  });

  test("uninstall removes the installed job and 404s when nothing is installed", async () => {
    const config = testConfig(root, "templates-uninstall");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const job = await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    const removed = await call(handler, config, "/api/routines/templates/morning-briefing", { method: "DELETE" });
    expect(removed).toEqual({ removed: [job.id] });
    expect(readState(config.instance).jobs).toHaveLength(0);
    const listed = await call(handler, config, "/api/routines/templates");
    expect(listed.templates.find((t: { id: string }) => t.id === "morning-briefing").installed).toBeNull();

    const again = await rawCall(handler, config, "/api/routines/templates/morning-briefing", { method: "DELETE" });
    expect(again.status).toBe(404);
    const unknown = await rawCall(handler, config, "/api/routines/templates/nope", { method: "DELETE" });
    expect(unknown.status).toBe(404);
  });

  test("install and uninstall mutate only the active agent's install", async () => {
    const config = testConfig(root, "templates-cross-agent");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const jobA = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(jobA.agentId).toBe(defaultAgentId);

    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });

    // The second agent's uninstall 404s while the first agent's install is
    // live — "installed" is per agent, not global.
    const before = await rawCall(handler, config, "/api/routines/templates/meeting-briefing", { method: "DELETE" });
    expect(before.status).toBe(404);

    // The second agent's install replaces nothing of the first agent's: both
    // jobs are live afterwards, each stamped with its owner.
    const jobB = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(jobB.agentId).toBe(second.id);
    const live = readState(config.instance).jobs.filter((j) => j.templateId === "meeting-briefing");
    expect(live.map((j) => j.id).sort()).toEqual([jobA.id, jobB.id].sort());

    // Scoped GET mirrors GET /api/jobs: each agent sees only its own install.
    const scopedA = await call(handler, config, `/api/routines/templates?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedA.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed?.jobId).toBe(jobA.id);
    const scopedB = await call(handler, config, `/api/routines/templates?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedB.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed?.jobId).toBe(jobB.id);

    // The second agent's uninstall removes only its own job; the first
    // agent's install survives.
    const removed = await call(handler, config, "/api/routines/templates/meeting-briefing", { method: "DELETE" });
    expect(removed).toEqual({ removed: [jobB.id] });
    expect(readState(config.instance).jobs.map((j) => j.id)).toEqual([jobA.id]);
  });

  test("onboarding apply reconciles gallery installs to one live job per template", async () => {
    const config = testConfig(root, "templates-reconcile");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const payload = {
      timezone: "America/New_York",
      autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
      morningBriefing: { enabled: true, personalizedNews: true },
      meetingBriefing: { enabled: true }
    };
    await call(handler, config, "/api/onboarding/routines", { method: "POST", body: JSON.stringify(payload) });

    // A gallery reinstall replaces the onboarding job for that template but
    // leaves the onboarding record tracking the stale id — the next apply's
    // replace pass must reconcile by templateId, not just tracked ids.
    await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });

    const applied = await call(handler, config, "/api/onboarding/routines", { method: "POST", body: JSON.stringify(payload) });
    const jobs = readState(config.instance).jobs;
    expect(jobs.map((j) => j.templateId).sort()).toEqual(["auto-inbox", "meeting-briefing", "morning-briefing"]);
    expect(jobs.map((j) => j.id).sort()).toEqual(applied.jobs.map((j: { id: string }) => j.id).sort());
  });

  test("the onboarding routines path stamps the same templateIds", async () => {
    const config = testConfig(root, "templates-onboarding");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const applied = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({
        timezone: "America/New_York",
        autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
        morningBriefing: { enabled: true, personalizedNews: true },
        meetingBriefing: { enabled: true }
      })
    });
    expect(applied.jobs.map((j: { templateId?: string }) => j.templateId).sort()).toEqual([
      "auto-inbox",
      "meeting-briefing",
      "morning-briefing"
    ]);

    // The onboarding path persists the toggle state as templateOptions too.
    const jobsByTemplate = new Map(applied.jobs.map((j: { templateId?: string }) => [j.templateId, j]));
    expect((jobsByTemplate.get("auto-inbox") as { templateOptions?: unknown }).templateOptions).toEqual({
      labelNewMail: true,
      archiveUnimportant: false,
      assistScheduling: true,
      draftReplies: true
    });
    expect((jobsByTemplate.get("morning-briefing") as { templateOptions?: unknown }).templateOptions).toEqual({
      personalizedNews: true
    });
    expect((jobsByTemplate.get("meeting-briefing") as { templateOptions?: unknown }).templateOptions).toBeUndefined();

    // The gallery reflects onboarding-created installs.
    const listed = await call(handler, config, "/api/routines/templates");
    expect(listed.templates.every((t: { installed: unknown }) => t.installed !== null)).toBe(true);
  });
});

// The install path's skillNames validate against ENABLED skills; seed the two
// Workspace skills the specs reference (bundled in production) and return
// their ids by name so tests can disable one.
async function seedWorkspaceSkills(handler: ReturnType<typeof createHandler>, config: RuntimeConfig): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const name of ["google-gmail", "google-calendar"]) {
    const skill = await call(handler, config, "/api/skills", { method: "POST", body: JSON.stringify({ name, description: name }) });
    ids[name] = skill.id;
  }
  return ids;
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
