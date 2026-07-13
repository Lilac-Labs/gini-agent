// Tests for the routine-template gallery (ADR routine-templates-gallery.md),
// exercised through the HTTP handler so route wiring + status mapping are
// covered:
//   - catalog buildSpec parity with the onboarding starter-routine specs
//     (prompts/crons/skills, incl. the Auto-inbox zero-behaviors → no spec
//     rule and the label-list prompt enumeration)
//   - resolveSettings validation (unknown keys, per-kind shapes, label
//     caps/canonicalization) and the legacy flat-options mapping
//   - per-account settings (Auto-inbox): resolveInstallSettings shapes (the
//     email-keyed map, flat-body fan-out to every registered account,
//     absent-body seeding, the zero-accounts flat fallback), the
//     multi-account buildSpec prompt, and the accountSettings view join
//     precedence (saved entry > legacy flat stamp > seeded defaults)
//   - GET reflects installed state (templateId join, agent scoping)
//   - install: templateId stamping, settings defaults, idempotent
//     per-template replace, timezone precedence (payload > onboarding record
//     > UTC), skill-resolve 400 with zero side effects, payload validation,
//     unknown template → 404
//   - install persists the resolved settings (defaults merged with
//     overrides) as templateSettings, and GET exposes them as
//     installed.settings — including the legacy templateOptions
//     normalization for jobs predating the field
//   - install provisions a channel session titled after message-delivering
//     routines; reinstall carries the same session forward; uninstall
//     archives it with the job; Auto-inbox gets only a hidden working
//     channel so it can spawn surfaced child tasks while staying out of
//     Messages
//   - uninstall: removes the installed job, 404 when nothing is installed
//   - install/uninstall are agent-scoped: one agent's install never touches
//     another agent's job for the same template
//   - the onboarding routines path stamps the same templateIds (and
//     templateSettings, mapping the retired archiveUnimportant boolean onto
//     per-label auto-archive), and its replace pass reconciles gallery
//     installs (one live job per template)
//
// Hermetic: HOME + GINI_STATE_ROOT point at a per-test scratch dir so
// instance state never touches the developer machine; the provider is the
// echo stub (no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createHandler } from "../http";
import { readState } from "../state";
import { addGoogleAccount, configDirForAccount, setPrimaryGoogleAccountId } from "../state/google-accounts";
import { writeOnboarding } from "../state/onboarding";
import { ROUTINE_TEMPLATES, resolveInstallSettings, resolveSettings, routineTemplate } from "./routine-templates";
import type { PerAccountRoutineSettings, RoutineLabelRule, RoutineSettings } from "./routine-templates";
import type { RuntimeConfig } from "../types";

const DEFAULT_LABEL_NAMES = [
  "new sender",
  "awaiting reply",
  "action needed",
  "newsletters",
  "promotional",
  "orders",
  "travel",
  "updates"
];

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
    const template = routineTemplate("auto-inbox")!;
    const autoInbox = template.buildSpec(resolveSettings(template, undefined), "America/New_York")!;
    expect(autoInbox.templateId).toBe("auto-inbox");
    expect(autoInbox.cronExpression).toBe("*/30 * * * *");
    expect(autoInbox.cronTimezone).toBe("America/New_York");
    expect(autoInbox.skillNames).toEqual(["google-gmail", "google-calendar"]);
    const prompt = autoInbox.prompt as string;
    // The labeling behavior enumerates the exact label list: quoted Gmail
    // label name, an (auto-archive) marker when set, then the rule text.
    // Defaults: no marker on any label line, no Gini/ prefix.
    expect(prompt).toContain(
      "- Label new mail. Classify each new email into the single best-fitting label from this list, creating the Gmail label first when it doesn't exist yet:"
    );
    expect(prompt).toContain(
      '  - "new sender": Direct emails from real people you haven\'t corresponded with before — potential leads, candidates, or business contacts worth reviewing'
    );
    expect(prompt).toContain('  - "newsletters": Subscribed content you opted into');
    expect(prompt).toContain("  When no label fits, leave the email unlabeled — never invent labels outside this list.");
    expect(prompt).toContain(
      "  After labeling, archive (remove the INBOX label from) ONLY emails whose label is marked (auto-archive) above; every other email stays in the inbox."
    );
    expect(prompt).not.toContain('" (auto-archive)');
    expect(prompt).not.toContain('"Gini/');
    // The shared framing lines survive the settings rework unchanged.
    expect(prompt).toContain("Tidy the user's Gmail inbox: work through mail that arrived since the last run.");
    expect(prompt).toContain("- Detect scheduling requests. When a response is needed, spawn a surfaced child task to draft the scheduling reply.");
    expect(prompt).toContain("- Detect important emails awaiting a response. For each one, spawn a surfaced child task to draft the reply.");
    expect(prompt).toContain("Silent behaviors: labeling and archiving happen directly in this Auto-inbox run and need no user-facing delivery.");
    expect(prompt).toContain("spawn_task with surface:true");
    expect(prompt).toContain("email-draft");
    expect(prompt).toContain("Gini never sends email or messages without the user's review — save drafts only, never send.");

    // Prefix, per-label auto-archive markers, and the optional scope/rules
    // text all flow into the prompt; embedded newlines collapse so a rule
    // can't forge extra prompt bullets, and an empty rule drops its colon.
    const custom = template.buildSpec(
      resolveSettings(template, {
        labelPrefix: true,
        labels: [
          { name: "newsletters", color: "#1FA463", rule: "Subscribed\n  digests and roundups", autoArchive: true },
          { name: "vip", color: "#4277FB", rule: "", autoArchive: false }
        ],
        draftRepliesScope: "Only real people I know",
        schedulingRules: "Mornings only,\nnever Fridays"
      }),
      "UTC"
    )!;
    const customPrompt = custom.prompt as string;
    expect(customPrompt).toContain('  - "Gini/newsletters" (auto-archive): Subscribed digests and roundups');
    expect(customPrompt).toContain('  - "Gini/vip"\n');
    expect(customPrompt).toContain(
      "- Detect scheduling requests. When a response is needed, spawn a surfaced child task to draft the scheduling reply. The user's scheduling rules and availability: Mornings only, never Fridays"
    );
    expect(customPrompt).toContain(
      "- Detect important emails awaiting a response. For each one, spawn a surfaced child task to draft the reply. Only draft replies to these kinds of emails: Only real people I know"
    );

    // Without scheduling assist the calendar skill drops off. Labeling
    // contributes a behavior only when the toggle is on AND at least one
    // label exists; with every function off there is no spec at all.
    const gmailOnly = template.buildSpec(resolveSettings(template, { assistScheduling: false }), "UTC")!;
    expect(gmailOnly.skillNames).toEqual(["google-gmail"]);
    expect(
      template.buildSpec(
        resolveSettings(template, { labelNewMail: false, assistScheduling: false, draftReplies: false }),
        "UTC"
      )
    ).toBeUndefined();
    expect(
      template.buildSpec(resolveSettings(template, { labels: [], assistScheduling: false, draftReplies: false }), "UTC")
    ).toBeUndefined();

    const morning = routineTemplate("morning-briefing")!.buildSpec({ personalizedNews: true }, "UTC")!;
    expect(morning.templateId).toBe("morning-briefing");
    expect(morning.cronExpression).toBe("0 8 * * *");
    expect(morning.skillNames).toEqual(["google-gmail", "google-calendar"]);
    // Delivery is the routine's own conversation, never a forward into the
    // (hidden) main agent Chat.
    expect(morning.forwardToChat).toBeUndefined();
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
    expect(meeting.forwardToChat).toBeUndefined();
    expect(meeting.prompt).toBe(
      "Check the user's calendar for meetings starting within the next hour that haven't been briefed yet. When one is found, prepare a prep note: attendees, recent email context with them, and the agenda. Otherwise do nothing and finish quietly."
    );
  });

  test("resolveSettings validates per-kind, caps labels, and canonicalizes values", () => {
    const template = routineTemplate("auto-inbox")!;

    // Missing keys fall back to the catalog defaults — including the full
    // starter label set.
    const defaults = resolveSettings(template, {});
    expect(defaults.labelNewMail).toBe(true);
    expect(defaults.labelPrefix).toBe(false);
    expect(defaults.draftRepliesScope).toBe("");
    expect((defaults.labels as RoutineLabelRule[]).map((label) => label.name)).toEqual(DEFAULT_LABEL_NAMES);
    expect((defaults.labels as RoutineLabelRule[]).every((label) => label.autoArchive === false)).toBe(true);

    expect(() => resolveSettings(template, [])).toThrow("settings must be an object");
    expect(() => resolveSettings(template, { sendEverything: true })).toThrow('unknown setting "sendEverything"');
    expect(() => resolveSettings(template, { labelNewMail: "yes" })).toThrow('setting "labelNewMail" must be a boolean');
    expect(() => resolveSettings(template, { schedulingRules: 3 })).toThrow('setting "schedulingRules" must be a string');
    expect(() => resolveSettings(template, { schedulingRules: "x".repeat(2001) })).toThrow("at most 2000 characters");
    expect(() => resolveSettings(template, { labels: {} })).toThrow('setting "labels" must be an array of labels');
    expect(() =>
      resolveSettings(template, { labels: Array.from({ length: 25 }, (_, i) => ({ name: `label ${i}` })) })
    ).toThrow("at most 24 labels");
    expect(() => resolveSettings(template, { labels: [{ name: "   " }] })).toThrow("label names must be non-empty");
    expect(() => resolveSettings(template, { labels: [{ name: "x".repeat(61) }] })).toThrow("at most 60 characters");
    expect(() => resolveSettings(template, { labels: [{ name: "ok", rule: 5 }] })).toThrow("label rules must be strings");
    expect(() => resolveSettings(template, { labels: [{ name: "ok", rule: "x".repeat(501) }] })).toThrow(
      "at most 500 characters"
    );
    expect(() => resolveSettings(template, { labels: [{ name: "ok", autoArchive: "yes" }] })).toThrow(
      "autoArchive must be a boolean"
    );

    // Canonicalization: names/rules/text trim (rules keep interior
    // whitespace — the prompt collapses it), a malformed color falls back to
    // the palette by list position, and autoArchive defaults to false.
    const resolved = resolveSettings(template, {
      labels: [
        { name: "  Receipts ", rule: " keep these ", color: "red" },
        { name: "VIP", rule: "", color: "#ABCDEF", autoArchive: true }
      ],
      schedulingRules: "  mornings only  "
    });
    expect(resolved.labels).toEqual([
      { name: "Receipts", color: "#4277FB", rule: "keep these", autoArchive: false },
      { name: "VIP", color: "#ABCDEF", rule: "", autoArchive: true }
    ]);
    expect(resolved.schedulingRules).toBe("mornings only");
  });

  test("resolveInstallSettings validates the email-keyed map and picks the shape per registry", () => {
    const template = routineTemplate("auto-inbox")!;

    // Zero registered accounts: every non-account-keyed shape falls back to
    // the flat single blob (the pre-per-account behavior).
    const flat = resolveInstallSettings(template, { settings: { labelNewMail: false } }) as RoutineSettings;
    expect(flat.labelNewMail).toBe(false);
    expect((resolveInstallSettings(template, {}) as RoutineSettings).labelNewMail).toBe(true);

    // An email-keyed map resolves per account regardless of the registry:
    // keys are lowercased, each value passes the same per-field validation.
    const mapped = resolveInstallSettings(template, {
      settings: { "A@X.com": { labelNewMail: false }, "b@y.com": {} }
    }) as PerAccountRoutineSettings;
    expect(Object.keys(mapped.accounts).sort()).toEqual(["a@x.com", "b@y.com"]);
    expect(mapped.accounts["a@x.com"]!.labelNewMail).toBe(false);
    expect(mapped.accounts["b@y.com"]!.labelNewMail).toBe(true);

    // A key without "@" in an otherwise account-keyed map, a whitespace-
    // forgeable key (emails embed into "Account <email>:" prompt lines), a
    // case-collapsed duplicate, and an oversized map are payload mistakes.
    expect(() => resolveInstallSettings(template, { settings: { "a@x.com": {}, nope: {} } })).toThrow(
      'account key "nope" must be an email address'
    );
    expect(() => resolveInstallSettings(template, { settings: { "a b@x.com": {} } })).toThrow(
      "must be an email address"
    );
    expect(() => resolveInstallSettings(template, { settings: { "a@x.com": {}, "A@x.COM": {} } })).toThrow(
      'repeats account "a@x.com"'
    );
    expect(() =>
      resolveInstallSettings(template, {
        settings: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`user${i}@x.com`, {}]))
      })
    ).toThrow("at most 10 accounts");
    // Per-value validation is the same as a flat install's.
    expect(() => resolveInstallSettings(template, { settings: { "a@x.com": { labels: [{ name: "" }] } } })).toThrow(
      "label names must be non-empty"
    );
    // Flat templates never take the map shape: the email key is just an
    // unknown setting there.
    expect(() =>
      resolveInstallSettings(routineTemplate("morning-briefing")!, { settings: { "a@x.com": {} } })
    ).toThrow('unknown setting "a@x.com"');
  });

  test("buildSpec composes the per-account prompt from the { accounts } wrapper", () => {
    const template = routineTemplate("auto-inbox")!;
    const spec = template.buildSpec(
      {
        accounts: {
          "a@x.com": resolveSettings(template, {
            labelPrefix: true,
            labels: [{ name: "vip", color: "#4277FB", rule: "Important people", autoArchive: true }],
            draftReplies: false,
            assistScheduling: false
          }),
          "b@y.com": resolveSettings(template, {
            labelNewMail: false,
            draftRepliesScope: "Only real people",
            assistScheduling: false
          }),
          // Every function off: this account contributes nothing and is
          // omitted from the prompt entirely.
          "c@z.com": resolveSettings(template, { labelNewMail: false, draftReplies: false, assistScheduling: false })
        }
      },
      "UTC"
    )!;
    const prompt = spec.prompt as string;
    expect(prompt).toContain(
      "Work ONLY the Gmail accounts listed below — each account carries its own configuration, applied to that account's inbox and no other:"
    );
    // Each account heading is followed by that account's own behavior lines
    // (a@x.com's prefixed auto-archive label; b@y.com's scoped replies).
    expect(prompt).toContain('Account a@x.com:\n- Label new mail.');
    expect(prompt).toContain('  - "Gini/vip" (auto-archive): Important people');
    expect(prompt).toContain(
      "Account b@y.com:\n- Detect important emails awaiting a response. For each one, spawn a surfaced child task to draft the reply. Only draft replies to these kinds of emails: Only real people"
    );
    expect(prompt).not.toContain("c@z.com");
    // The shared delivery/safety framing survives on the per-account shape.
    expect(prompt).toContain("Gini never sends email or messages without the user's review — save drafts only, never send.");
    // No account assists scheduling, so the calendar skill drops off; the
    // stamped settings are the wrapper itself.
    expect(spec.skillNames).toEqual(["google-gmail"]);
    expect((spec.templateSettings as PerAccountRoutineSettings).accounts["a@x.com"]).toBeDefined();

    const scheduling = template.buildSpec(
      {
        accounts: {
          "a@x.com": resolveSettings(template, { assistScheduling: false }),
          "b@y.com": resolveSettings(template, { schedulingRules: "Mornings only" })
        }
      },
      "UTC"
    )!;
    expect(scheduling.skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(scheduling.prompt as string).toContain("The user's scheduling rules and availability: Mornings only");

    // Every account off ⇒ no spec at all, mirroring the flat zero-behavior rule.
    expect(
      template.buildSpec(
        {
          accounts: {
            "a@x.com": resolveSettings(template, { labelNewMail: false, draftReplies: false, assistScheduling: false })
          }
        },
        "UTC"
      )
    ).toBeUndefined();
  });

  test("install seeds and persists the per-account map for registered accounts", async () => {
    const config = testConfig(root, "templates-per-account-install");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);
    seedGoogleAccount("gacct_a", "A@X.com");
    seedGoogleAccount("gacct_b", "b@y.com");

    // Settings omitted → one seeded entry per registered account (emails
    // lowercased), each the catalog defaults.
    const seeded = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    const seededSettings = seeded.templateSettings as { accounts: Record<string, RoutineSettings> };
    expect(Object.keys(seededSettings.accounts).sort()).toEqual(["a@x.com", "b@y.com"]);
    expect(seededSettings.accounts["a@x.com"]!.labelNewMail).toBe(true);
    expect((seededSettings.accounts["b@y.com"]!.labels as RoutineLabelRule[]).map((l) => l.name)).toEqual(
      DEFAULT_LABEL_NAMES
    );
    expect(seeded.prompt).toContain("Account a@x.com:");
    expect(seeded.prompt).toContain("Account b@y.com:");

    // A legacy flat body (the onboarding wire shape) fans out to every
    // registered account alike — archiveUnimportant lands as per-label
    // auto-archive on each account's default labels.
    const legacy = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { archiveUnimportant: true, draftReplies: false } })
    });
    const legacySettings = legacy.templateSettings as { accounts: Record<string, RoutineSettings> };
    for (const email of ["a@x.com", "b@y.com"]) {
      expect(legacySettings.accounts[email]!.draftReplies).toBe(false);
      expect(
        (legacySettings.accounts[email]!.labels as RoutineLabelRule[]).filter((l) => l.autoArchive).map((l) => l.name)
      ).toEqual(["newsletters", "promotional", "updates"]);
    }

    // An email-keyed body persists exactly the entries it names.
    const explicit = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ settings: { "a@x.com": { labelNewMail: false } } })
    });
    const explicitSettings = explicit.templateSettings as { accounts: Record<string, RoutineSettings> };
    expect(Object.keys(explicitSettings.accounts)).toEqual(["a@x.com"]);
    expect(explicitSettings.accounts["a@x.com"]!.labelNewMail).toBe(false);
  });

  test("GET joins per-account settings with saved > legacy flat > seeded precedence", async () => {
    const config = testConfig(root, "templates-per-account-view");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);
    seedGoogleAccount("gacct_a", "a@x.com");
    seedGoogleAccount("gacct_b", "b@y.com");
    setPrimaryGoogleAccountId("gacct_b");

    // Saved entry for a@x.com only: it renders its saved state (defaults
    // filled), while b@y.com — connected but absent from the persisted map —
    // renders seeded defaults. Exactly the effective primary row is marked.
    await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ settings: { "a@x.com": { labelNewMail: false } } })
    });
    const listed = await call(handler, config, "/api/routines/templates");
    const autoInbox = listed.templates.find((t: { id: string }) => t.id === "auto-inbox");
    expect(autoInbox.installed.settings).toBeUndefined();
    const rows = autoInbox.installed.accountSettings as Array<{
      accountId: string;
      email: string;
      primary?: boolean;
      settings: RoutineSettings;
    }>;
    expect(rows.map((row) => [row.accountId, row.email])).toEqual([
      ["gacct_a", "a@x.com"],
      ["gacct_b", "b@y.com"]
    ]);
    expect(rows.map((row) => row.primary)).toEqual([undefined, true]);
    expect(rows[0]!.settings.labelNewMail).toBe(false);
    expect(rows[0]!.settings.draftReplies).toBe(true);
    expect(rows[1]!.settings.labelNewMail).toBe(true);
    expect((rows[1]!.settings.labels as RoutineLabelRule[]).map((l) => l.name)).toEqual(DEFAULT_LABEL_NAMES);

    // A pre-per-account job (legacy flat templateOptions stamp) shows the
    // same normalized flat state on every account.
    await call(handler, config, "/api/routines/templates/auto-inbox", { method: "DELETE" });
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "Auto-inbox",
        prompt: "legacy",
        cronExpression: "*/30 * * * *",
        skillNames: ["google-gmail"],
        templateId: "auto-inbox",
        templateOptions: { labelNewMail: false, archiveUnimportant: true, assistScheduling: true, draftReplies: true }
      })
    });
    const legacyListed = await call(handler, config, "/api/routines/templates");
    const legacyRows = legacyListed.templates.find((t: { id: string }) => t.id === "auto-inbox").installed
      .accountSettings as Array<{ email: string; settings: RoutineSettings }>;
    for (const row of legacyRows) {
      expect(row.settings.labelNewMail).toBe(false);
      expect(
        (row.settings.labels as RoutineLabelRule[]).filter((l) => l.autoArchive).map((l) => l.name)
      ).toEqual(["newsletters", "promotional", "updates"]);
    }

    // Flat templates keep the flat settings shape even with accounts around.
    const morning = legacyListed.templates.find((t: { id: string }) => t.id === "morning-briefing");
    expect(morning.installed).toBeNull();
    await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    const flatListed = await call(handler, config, "/api/routines/templates");
    const flatMorning = flatListed.templates.find((t: { id: string }) => t.id === "morning-briefing");
    expect(flatMorning.installed.accountSettings).toBeUndefined();
    expect(flatMorning.installed.settings).toEqual({ personalizedNews: true });
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
    // The per-function settings sections the detail page renders, with flat
    // field keys across sections.
    expect(autoInbox.settings.map((s: { key: string }) => s.key)).toEqual(["labeling", "replies", "scheduling"]);
    expect(
      autoInbox.settings.flatMap((s: { fields: Array<{ key: string }> }) => s.fields.map((f) => f.key))
    ).toEqual([
      "labelNewMail",
      "labels",
      "labelPrefix",
      "draftReplies",
      "draftRepliesScope",
      "assistScheduling",
      "schedulingRules"
    ]);

    const job = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    const listed = await call(handler, config, "/api/routines/templates");
    const meeting = listed.templates.find((t: { id: string }) => t.id === "meeting-briefing");
    expect(meeting.installed).toEqual({ jobId: job.id, status: "active", chatSessionId: job.chatSessionId });

    // Agent scoping mirrors GET /api/jobs: a filter naming another agent
    // hides the install; the owning agent's filter shows it.
    const other = await call(handler, config, "/api/routines/templates?agentId=agent_nope");
    expect(other.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed).toBeNull();
    const owner = await call(handler, config, `/api/routines/templates?agentId=${job.agentId}`);
    expect(owner.templates.find((t: { id: string }) => t.id === "meeting-briefing").installed?.jobId).toBe(job.id);
  });

  test("install stamps templateId, applies settings defaults, and replaces idempotently", async () => {
    const config = testConfig(root, "templates-install");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // Settings omitted → the template defaults (every function on).
    const first = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ timezone: "Europe/Berlin" })
    });
    expect(first.templateId).toBe("auto-inbox");
    expect(first.cronExpression).toBe("*/30 * * * *");
    expect(first.cronTimezone).toBe("Europe/Berlin");
    expect(first.skillNames).toEqual(["google-gmail", "google-calendar"]);
    expect(first.prompt).toContain("- Label new mail");
    expect(first.prompt).toContain("- Detect scheduling requests");
    expect(first.prompt).toContain("spawn_task with surface:true");
    expect(first.prompt).toContain("email-draft");
    expect(first.deliveryPolicy).toBe("silent");
    expect(typeof first.chatSessionId).toBe("string");
    const firstSession = readState(config.instance).chatSessions.find((s) => s.id === first.chatSessionId);
    expect(firstSession?.title).toBe("Auto-inbox");
    expect(firstSession?.headless).toBe(true);

    // Re-install with explicit settings: the previous job is replaced, not
    // duplicated, the prompt tracks the new selection, and Auto-inbox reuses
    // its hidden working channel instead of creating a Messages conversation.
    const second = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({
        timezone: "Europe/Berlin",
        settings: { labelNewMail: false, assistScheduling: false, draftReplies: true }
      })
    });
    expect(second.id).not.toBe(first.id);
    expect(second.skillNames).toEqual(["google-gmail"]);
    expect(second.prompt).toContain("- Detect important emails awaiting a response");
    expect(second.prompt).not.toContain("- Label new mail");
    expect(second.deliveryPolicy).toBe("silent");
    expect(second.chatSessionId).toBe(first.chatSessionId);
    const sessions = readState(config.instance).chatSessions.filter((s) => s.title === "Auto-inbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.headless).toBe(true);
    expect(sessions[0]?.archivedAt).toBeUndefined();
    const jobs = readState(config.instance).jobs.filter((j) => j.templateId === "auto-inbox");
    expect(jobs.map((j) => j.id)).toEqual([second.id]);
  });

  test("install provisions a conversation titled after the routine and reinstall reuses it", async () => {
    const config = testConfig(root, "templates-session");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const first = await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(typeof first.chatSessionId).toBe("string");
    const session = readState(config.instance).chatSessions.find((s) => s.id === first.chatSessionId);
    expect(session?.title).toBe("Morning Briefing");
    expect(session?.kind).toBe("channel");
    expect(session?.origin).toBe("job");
    expect(session?.agentId).toBe(first.agentId);
    expect(session?.archivedAt).toBeUndefined();

    // A reinstall (the detail page's Settings save) replaces the job but
    // carries the conversation forward: same session id, still live, and no
    // second "Morning Briefing" thread minted.
    const second = await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({ options: { personalizedNews: false } })
    });
    expect(second.id).not.toBe(first.id);
    expect(second.chatSessionId).toBe(first.chatSessionId);
    const state = readState(config.instance);
    expect(state.chatSessions.find((s) => s.id === first.chatSessionId)?.archivedAt).toBeUndefined();
    expect(state.chatSessions.filter((s) => s.title === "Morning Briefing")).toHaveLength(1);
  });

  test("uninstall archives the routine's conversation; a later install starts fresh", async () => {
    const config = testConfig(root, "templates-session-uninstall");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const job = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    await call(handler, config, "/api/routines/templates/meeting-briefing", { method: "DELETE" });
    // removeJob archives the conversation with the job: it leaves the
    // Messages list but its history stays addressable by id.
    const archived = readState(config.instance).chatSessions.find((s) => s.id === job.chatSessionId);
    expect(archived?.archivedAt).toBeString();

    const again = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(again.chatSessionId).not.toBe(job.chatSessionId);
    expect(readState(config.instance).chatSessions.find((s) => s.id === again.chatSessionId)?.archivedAt).toBeUndefined();
  });

  test("install persists the resolved settings and GET exposes them as installed.settings", async () => {
    const config = testConfig(root, "templates-options");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // Settings omitted → the template defaults, persisted in full. The
    // legacy templateOptions stamp is retired — new installs never carry it.
    const first = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(first.templateOptions).toBeUndefined();
    const firstSettings = first.templateSettings as {
      labelNewMail: boolean;
      labels: RoutineLabelRule[];
      labelPrefix: boolean;
      draftReplies: boolean;
      draftRepliesScope: string;
      assistScheduling: boolean;
      schedulingRules: string;
    };
    expect(firstSettings.labelNewMail).toBe(true);
    expect(firstSettings.labelPrefix).toBe(false);
    expect(firstSettings.draftReplies).toBe(true);
    expect(firstSettings.draftRepliesScope).toBe("");
    expect(firstSettings.assistScheduling).toBe(true);
    expect(firstSettings.schedulingRules).toBe("");
    expect(firstSettings.labels.map((label) => label.name)).toEqual(DEFAULT_LABEL_NAMES);
    expect(firstSettings.labels[0]).toEqual({
      name: "new sender",
      color: "#4277FB",
      rule: "Direct emails from real people you haven't corresponded with before — potential leads, candidates, or business contacts worth reviewing",
      autoArchive: false
    });

    // Partial overrides merge over the defaults before persisting.
    const second = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({
        settings: {
          draftReplies: false,
          labels: [{ name: "receipts", color: "#9B7DF0", rule: "Order receipts", autoArchive: true }]
        }
      })
    });
    const secondSettings = second.templateSettings as { labels: RoutineLabelRule[]; draftReplies: boolean; labelNewMail: boolean };
    expect(secondSettings.draftReplies).toBe(false);
    expect(secondSettings.labelNewMail).toBe(true);
    expect(secondSettings.labels).toEqual([{ name: "receipts", color: "#9B7DF0", rule: "Order receipts", autoArchive: true }]);

    const listed = await call(handler, config, "/api/routines/templates");
    const autoInbox = listed.templates.find((t: { id: string }) => t.id === "auto-inbox");
    expect(autoInbox.installed.jobId).toBe(second.id);
    expect(autoInbox.installed.status).toBe("active");
    expect(autoInbox.installed.settings).toEqual(second.templateSettings);

    // The legacy flat boolean options body still installs: it maps through
    // legacySettings (archiveUnimportant → auto-archive on the unimportant
    // default labels) and persists as templateSettings.
    const legacy = await call(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { archiveUnimportant: true, draftReplies: false } })
    });
    expect(legacy.templateOptions).toBeUndefined();
    const legacySettings = legacy.templateSettings as { labels: RoutineLabelRule[]; draftReplies: boolean };
    expect(legacySettings.draftReplies).toBe(false);
    expect(
      legacySettings.labels.filter((label) => label.autoArchive).map((label) => label.name)
    ).toEqual(["newsletters", "promotional", "updates"]);

    // A template without settings carries no templateSettings at all.
    const meeting = await call(handler, config, "/api/routines/templates/meeting-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(meeting.templateSettings).toBeUndefined();
  });

  test("GET normalizes a legacy templateOptions job onto the settings model", async () => {
    const config = testConfig(root, "templates-legacy");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    // A job persisted before templateSettings existed: templateId +
    // templateOptions only (POST /api/jobs threads both through
    // createScheduledJob unchanged).
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "Auto-inbox",
        prompt: "legacy",
        cronExpression: "*/30 * * * *",
        skillNames: ["google-gmail"],
        templateId: "auto-inbox",
        templateOptions: { labelNewMail: false, archiveUnimportant: true, assistScheduling: true, draftReplies: true }
      })
    });

    const listed = await call(handler, config, "/api/routines/templates");
    const autoInbox = listed.templates.find((t: { id: string }) => t.id === "auto-inbox");
    const settings = autoInbox.installed.settings as Record<string, unknown>;
    // Same-named toggles map by identity; archiveUnimportant becomes
    // auto-archive on the unimportant default labels; fields the legacy map
    // never had fill from the catalog defaults.
    expect(settings.labelNewMail).toBe(false);
    expect(settings.assistScheduling).toBe(true);
    expect(settings.labelPrefix).toBe(false);
    expect(settings.draftRepliesScope).toBe("");
    expect(
      (settings.labels as RoutineLabelRule[]).filter((label) => label.autoArchive).map((label) => label.name)
    ).toEqual(["newsletters", "promotional", "updates"]);
    expect(settings.archiveUnimportant).toBeUndefined();
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

    // Unknown keys are rejected on both wire shapes: an unknown legacy
    // option rides through the legacySettings mapping into the same
    // unknown-setting rejection.
    const unknownOption = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { sendEverything: true } })
    });
    expect(unknownOption.status).toBe(400);
    const unknownSetting = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ settings: { sendEverything: true } })
    });
    expect(unknownSetting.status).toBe(400);

    const nonBoolean = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ options: { labelNewMail: "yes" } })
    });
    expect(nonBoolean.status).toBe(400);

    const badLabels = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({ settings: { labels: [{ name: "" }] } })
    });
    expect(badLabels.status).toBe(400);

    // Every Auto-inbox function off yields no spec — a clean 400, no job.
    const empty = await rawCall(handler, config, "/api/routines/templates/auto-inbox/install", {
      method: "POST",
      body: JSON.stringify({
        settings: { labelNewMail: false, assistScheduling: false, draftReplies: false }
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
    const initial = await call(handler, config, "/api/onboarding/routines", { method: "POST", body: JSON.stringify(payload) });
    const morningSessionId = (initial.jobs as Array<{ templateId?: string; chatSessionId?: string }>).find(
      (j) => j.templateId === "morning-briefing"
    )!.chatSessionId;

    // A gallery reinstall replaces the onboarding job for that template but
    // leaves the onboarding record tracking the stale id — the next apply's
    // replace pass must reconcile by templateId, not just tracked ids.
    const reinstalled = await call(handler, config, "/api/routines/templates/morning-briefing/install", {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(reinstalled.chatSessionId).toBe(morningSessionId);

    const applied = await call(handler, config, "/api/onboarding/routines", { method: "POST", body: JSON.stringify(payload) });
    const jobs = readState(config.instance).jobs;
    expect(jobs.map((j) => j.templateId).sort()).toEqual(["auto-inbox", "meeting-briefing", "morning-briefing"]);
    expect(jobs.map((j) => j.id).sort()).toEqual(applied.jobs.map((j: { id: string }) => j.id).sort());
    // Every writer carried the routine's conversation forward — one live
    // "Morning Briefing" thread across onboarding → gallery → onboarding.
    expect(jobs.find((j) => j.templateId === "morning-briefing")?.chatSessionId).toBe(morningSessionId);
    const sessions = readState(config.instance).chatSessions.filter((s) => s.title === "Morning Briefing");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.archivedAt).toBeUndefined();
  });

  test("the onboarding routines path stamps the same templateIds", async () => {
    const config = testConfig(root, "templates-onboarding");
    const handler = createHandler(config);
    await seedWorkspaceSkills(handler, config);

    const applied = await call(handler, config, "/api/onboarding/routines", {
      method: "POST",
      body: JSON.stringify({
        timezone: "America/New_York",
        autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: true, assistScheduling: true, draftReplies: true },
        morningBriefing: { enabled: true, personalizedNews: true },
        meetingBriefing: { enabled: true }
      })
    });
    expect(applied.jobs.map((j: { templateId?: string }) => j.templateId).sort()).toEqual([
      "auto-inbox",
      "meeting-briefing",
      "morning-briefing"
    ]);

    // The onboarding path persists the resolved settings as
    // templateSettings, mapping the body's flat booleans through the same
    // legacy-options path as the gallery install — archiveUnimportant lands
    // as auto-archive on the unimportant default labels.
    const jobsByTemplate = new Map(applied.jobs.map((j: { templateId?: string }) => [j.templateId, j]));
    const autoInboxSettings = (jobsByTemplate.get("auto-inbox") as { templateSettings?: Record<string, unknown> })
      .templateSettings!;
    expect(autoInboxSettings.labelNewMail).toBe(true);
    expect(autoInboxSettings.assistScheduling).toBe(true);
    expect(autoInboxSettings.draftReplies).toBe(true);
    expect(
      (autoInboxSettings.labels as RoutineLabelRule[]).filter((label) => label.autoArchive).map((label) => label.name)
    ).toEqual(["newsletters", "promotional", "updates"]);
    expect((jobsByTemplate.get("morning-briefing") as { templateSettings?: unknown }).templateSettings).toEqual({
      personalizedNews: true
    });
    expect((jobsByTemplate.get("meeting-briefing") as { templateSettings?: unknown }).templateSettings).toBeUndefined();

    // The onboarding path provisions visible conversations only for
    // message-delivering routines. Auto-inbox gets a hidden working channel
    // for spawned draft tasks and stays out of Messages.
    const sessions = readState(config.instance).chatSessions;
    for (const job of applied.jobs as Array<{ name: string; chatSessionId?: string }>) {
      if (job.name === "Auto-inbox") {
        const session = sessions.find((s) => s.id === job.chatSessionId);
        expect(session?.title).toBe("Auto-inbox");
        expect(session?.kind).toBe("channel");
        expect(session?.headless).toBe(true);
        expect(session?.archivedAt).toBeUndefined();
        continue;
      }
      const session = sessions.find((s) => s.id === job.chatSessionId);
      expect(session?.title).toBe(job.name);
      expect(session?.kind).toBe("channel");
      expect(session?.archivedAt).toBeUndefined();
    }

    // The gallery reflects onboarding-created installs.
    const listed = await call(handler, config, "/api/routines/templates");
    expect(listed.templates.every((t: { installed: unknown }) => t.installed !== null)).toBe(true);
  });
});

// Register a Google account in the (scratch-HOME) machine-global registry so
// per-account installs see it. Emails are stored as given — the settings
// paths own the lowercasing.
function seedGoogleAccount(id: string, email: string): void {
  addGoogleAccount({ id, tag: id, email, configDir: configDirForAccount(id), addedAt: new Date().toISOString() });
}

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
