// Routine-template catalog + gallery endpoints (ADR
// routine-templates-gallery.md).
//
// The catalog is the single product-owned source for the starter routines:
// each template composes its createScheduledJob payload (prompt, cron,
// skills) server-side and stamps `templateId` so installed jobs stay linked
// back to their template. Two callers share it:
//
//   - the web /routines gallery, through the thin src/http.ts delegations
//     GET /api/routines/templates, POST /api/routines/templates/<id>/install,
//     and DELETE /api/routines/templates/<id> below
//   - the onboarding starter-routines step (src/runtime/onboarding.ts), whose
//     routineJobSpecs maps its POST body onto the same buildSpec calls
//
// Validation errors throw with the "Invalid input:" prefix the gateway maps
// to a 400; an unknown template id — and an uninstall when the owning agent
// has nothing installed — throws "Routine template not found" (404).

import { resolveEffectiveContext } from "../execution/effective-context";
import { assertSkillNamesResolve, createScheduledJob, removeJob } from "../jobs";
import { mutateState, readState, setContainerArchived } from "../state";
import { readGoogleAccounts, readPrimaryGoogleAccountId } from "../state/google-accounts";
import { readLabelProfile, type GoogleLabelProfile } from "../state/google-label-profiles";
import { readOnboarding } from "../state/onboarding";
import { ensureLabelProfile } from "./label-discovery";
import type { GoogleAccount, JobRecord, JobStatus, RuntimeConfig, RuntimeState } from "../types";

// One editable Gmail filtering label: the exact label name, a UI-only swatch
// color (hex — never pushed to Gmail label colors), the natural-language
// classification rule the prompt embeds, and whether mail filed under it is
// archived out of the inbox.
export interface RoutineLabelRule {
  name: string;
  color: string;
  rule: string;
  autoArchive: boolean;
  // Seed provenance, stamped by defaultSettingsForAccount: "existing" =
  // discovered from the user's own mailbox, "suggested" = the standard
  // catalog; absent = hand-added or pre-provenance. Presentation only — the
  // web renders it as a read-only badge, it survives save round-trips
  // (resolveLabelRule), and buildSpec NEVER composes it into the job prompt.
  origin?: "existing" | "suggested";
}

// One editable field in a settings section, discriminated on `kind`.
// `text` fields carry multiline textarea semantics.
export type RoutineSettingField =
  | { kind: "toggle"; key: string; label: string; description?: string; defaultValue: boolean }
  | { kind: "text"; key: string; label: string; description?: string; placeholder?: string; defaultValue: string }
  | { kind: "labelList"; key: string; label: string; description?: string; defaultValue: RoutineLabelRule[] };

// A per-function settings group on a prebuilt routine ("Label new mail",
// "Draft replies to important emails"), rendered as one collapsible card on
// the detail page. Sections are presentation grouping only — field keys stay
// flat across sections and must be unique template-wide.
export interface RoutineSettingsSection {
  key: string;
  title: string;
  fields: RoutineSettingField[];
}

// The resolved settings state, keyed by field key (flat across sections).
export type RoutineSettings = Record<string, boolean | string | RoutineLabelRule[]>;

// The persisted settings shape for per-account templates: one resolved
// settings state per connected Google account, keyed by lowercased email —
// the same address key EmailWatcherRecord.accountEmail matches accounts on,
// and the way the agent addresses accounts in prompts. The wrapper's
// `accounts` object is what distinguishes it from a legacy flat blob when
// reading a persisted templateSettings. Flat templates keep the bare
// RoutineSettings blob, and a per-account template installed with zero
// registered accounts falls back to it too, so instances without a Google
// account keep the flat single-blob behavior.
export interface PerAccountRoutineSettings {
  accounts: Record<string, RoutineSettings>;
}

export function isPerAccountSettings(value: unknown): value is PerAccountRoutineSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const accounts = (value as { accounts?: unknown }).accounts;
  return accounts !== null && typeof accounts === "object" && !Array.isArray(accounts);
}

export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  // Icon key the web maps to a lucide icon — presentation hint only.
  icon: string;
  scheduleHint: string;
  // Whether installing this template should create a visible Messages
  // conversation for job output. Some routines, like Auto-inbox, keep a
  // hidden working thread so they can spawn surfaced child tasks without
  // creating a Messages conversation of their own.
  createsMessagesConversation: boolean;
  settings: RoutineSettingsSection[];
  // Whether this template's settings VALUES are kept per connected Google
  // account (the field schema in `settings` stays shared across accounts).
  // Install persists the { accounts } wrapper instead of one flat blob,
  // buildSpec composes a per-account prompt from it, and the gallery view
  // joins each registered account's resolved state as
  // installed.accountSettings.
  perAccountSettings?: boolean;
  // Map a legacy flat boolean option map — the pre-settings wire shape still
  // sent by POST /api/onboarding/routines and persisted on older jobs as
  // templateOptions — onto the settings model. Keys without a same-named
  // settings field are consumed here (Auto-inbox's retired
  // archiveUnimportant); absent, the option map is used as settings verbatim.
  legacySettings?(options: Record<string, boolean>): RoutineSettings;
  // Compose the createScheduledJob payload for the given resolved settings
  // state — the flat blob, or the { accounts } wrapper for per-account
  // templates. Templates with settings stamp the state as `templateSettings`
  // (next to `templateId`) so the installed job records the configuration it
  // was built from. Returns undefined when the selection yields no behavior
  // at all (an Auto-inbox with every function off — for the per-account
  // shape, off on every account), mirroring the onboarding rule that such a
  // selection creates no job.
  buildSpec(
    settings: RoutineSettings | PerAccountRoutineSettings,
    timezone: string
  ): Record<string, unknown> | undefined;
}

// The design's eight label swatch hexes, in default-label order. Doubles as
// the fallback when a caller-supplied color isn't a #rrggbb hex (cycled by
// list position), as the web editor's palette for newly added labels, and as
// the swatches label discovery assigns to digested labels
// (src/runtime/label-discovery.ts).
export const LABEL_COLOR_PALETTE = ["#4277FB", "#12B5C4", "#F5820A", "#1FA463", "#EC6B9E", "#9B7DF0", "#7DA9FB", "#E8A317"];

// The Gmail namespace the labelPrefix toggle nests labels under
// ("Gini/<name>"). Label discovery (src/runtime/label-discovery.ts) excludes
// this exact prefix at its fetch stage so the routine's own output labels are
// never re-imported as the user's organizational scheme.
export const ROUTINE_LABEL_NAMESPACE = "Gini/";

// The Auto-inbox starter label set (names, colors, and classification rules
// from the GiniRoutineDetail design handoff). Every label starts with
// auto-archive off — archiving is an explicit per-label opt-in. Exported as
// the STANDARD catalog label discovery hands the digest call, so the model
// can mark which standard labels an existing label already functionally
// covers (src/runtime/label-discovery.ts).
export const AUTO_INBOX_DEFAULT_LABELS: RoutineLabelRule[] = [
  { name: "new sender", color: "#4277FB", rule: "Direct emails from real people you haven't corresponded with before — potential leads, candidates, or business contacts worth reviewing", autoArchive: false },
  { name: "awaiting reply", color: "#12B5C4", rule: "Threads where you were the last to respond and are waiting for a reply from someone else", autoArchive: false },
  { name: "action needed", color: "#F5820A", rule: "Notifications requiring near-term action: contracts to sign, payments to process, waitlist updates, and time-sensitive status changes", autoArchive: false },
  { name: "newsletters", color: "#1FA463", rule: "Subscribed content you opted into: recurring digests, blog updates, weekly roundups, and editorial newsletters", autoArchive: false },
  { name: "promotional", color: "#EC6B9E", rule: "Unsolicited marketing emails, sales campaigns, brand promotions, discount offers, and commercial outreach you did not subscribe to", autoArchive: false },
  { name: "orders", color: "#9B7DF0", rule: "Order confirmations, receipts, shipping and delivery notifications, package tracking, and carrier logistics updates (including inbound package alerts) from retailers or shipping carriers.", autoArchive: false },
  { name: "travel", color: "#7DA9FB", rule: "Flight confirmations, hotel reservations, car rental bookings, itinerary updates, boarding passes, and travel alerts", autoArchive: false },
  { name: "updates", color: "#E8A317", rule: "Routine informational updates about apps, services, or accounts (status notices, product updates, policy changes, and account activity) that are not purchase, shipping, travel, or action-needed messages", autoArchive: false }
];

// The retired archiveUnimportant boolean archived "promotions,
// notifications"; the label model expresses that as auto-archive on these
// default labels (legacySettings below).
const LEGACY_AUTO_ARCHIVE_LABEL_NAMES = new Set(["newsletters", "promotional", "updates"]);

// One account's Auto-inbox behavior lines, composed ONLY of the functions
// its settings toggle on. Shared by both buildSpec shapes: the flat blob
// emits them directly, the per-account wrapper emits each account's lines
// under its "Account <email>:" heading.
function autoInboxBehaviors(settings: RoutineSettings): string[] {
  const labels = (Array.isArray(settings.labels) ? settings.labels : []) as RoutineLabelRule[];
  const labelPrefix = settings.labelPrefix === true;
  const draftRepliesScope = collapseWhitespace(typeof settings.draftRepliesScope === "string" ? settings.draftRepliesScope : "");
  const schedulingRules = collapseWhitespace(typeof settings.schedulingRules === "string" ? settings.schedulingRules : "");
  const behaviors: string[] = [];
  if (settings.labelNewMail === true && labels.length > 0) {
    behaviors.push(
      [
        "- Label new mail. Classify each new email into the single best-fitting label from this list, creating the Gmail label first when it doesn't exist yet:",
        ...labels.map((label) => {
          const name = labelPrefix ? `${ROUTINE_LABEL_NAMESPACE}${label.name}` : label.name;
          const rule = collapseWhitespace(label.rule);
          return `  - "${name}"${label.autoArchive ? " (auto-archive)" : ""}${rule ? `: ${rule}` : ""}`;
        }),
        "  When no label fits, leave the email unlabeled — never invent labels outside this list.",
        "  After labeling, archive (remove the INBOX label from) ONLY emails whose label is marked (auto-archive) above; every other email stays in the inbox."
      ].join("\n")
    );
  }
  if (settings.assistScheduling === true) {
    behaviors.push(
      "- Detect scheduling requests. When a response is needed, spawn a surfaced child task to draft the scheduling reply." +
        (schedulingRules ? ` The user's scheduling rules and availability: ${schedulingRules}` : "")
    );
  }
  if (settings.draftReplies === true) {
    behaviors.push(
      "- Detect important emails awaiting a response. For each one, spawn a surfaced child task to draft the reply." +
        (draftRepliesScope ? ` Only draft replies to these kinds of emails: ${draftRepliesScope}` : "")
    );
  }
  return behaviors;
}

// The delivery/safety framing every Auto-inbox prompt ends with, identical
// across the flat and per-account shapes.
const AUTO_INBOX_SHARED_PROMPT = [
  "Silent behaviors: labeling and archiving happen directly in this Auto-inbox run and need no user-facing delivery.",
  "Draft-producing behaviors: do NOT save draft replies in this Auto-inbox run. For every email that needs a reply or scheduling response, call spawn_task with surface:true and await:\"none\" so the user sees a Home task. Use one task per email thread/message, with a stable correlation_key like `auto-inbox:<account>:<message-or-thread-id>` so later runs do not duplicate it.",
  "Each spawned task brief must be self-contained: include the exact Gmail account, message id and thread id when known, sender, subject, relevant body/snippet, why a response is needed, and any scheduling constraints/calendar context already discovered.",
  "The spawned task's goal is to save a Gmail draft and render it as an `email-draft` card with DraftId and Account so the user can review, iterate, and send from the card. If the draft proposes a specific meeting time, the child task must also render the calendar preview required by the google-gmail skill.",
  "Gini never sends email or messages without the user's review — save drafts only, never send."
];

// The starter catalog. Adding a template is one entry here — prompts and
// crons are product-owned (never composed in the browser), and the field
// defaults match the onboarding StepRoutines defaults.
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "auto-inbox",
    name: "Auto-inbox",
    description: "Your inbox, organized without the work.",
    icon: "inbox",
    scheduleHint: "Every 30 minutes",
    createsMessagesConversation: false,
    perAccountSettings: true,
    settings: [
      {
        key: "labeling",
        title: "Label new mail",
        fields: [
          {
            kind: "toggle",
            key: "labelNewMail",
            label: "Label new mail",
            description: "If off, Auto-inbox still analyzes new emails for reply and scheduling decisions, but it will not apply any labels.",
            defaultValue: true
          },
          {
            kind: "labelList",
            key: "labels",
            label: "Filtering labels",
            description: "All label names and rules are editable.",
            defaultValue: AUTO_INBOX_DEFAULT_LABELS
          },
          {
            kind: "toggle",
            key: "labelPrefix",
            label: "Label prefix",
            description: "Prefix labels with 'Gini/' so they appear as 'Gini/LabelName'.",
            defaultValue: false
          }
        ]
      },
      {
        key: "replies",
        title: "Draft replies to important emails",
        fields: [
          {
            kind: "toggle",
            key: "draftReplies",
            label: "Allow draft replies",
            description: "If off, Auto-inbox will never draft email replies.",
            defaultValue: true
          },
          {
            kind: "text",
            key: "draftRepliesScope",
            label: "Only respond to these kinds of emails",
            description: "Optional. Leave blank to handle any email that matches the routine's normal rules.",
            placeholder: "e.g. Emails from real people about active work — never newsletters or automated notifications",
            defaultValue: ""
          }
        ]
      },
      {
        key: "scheduling",
        title: "Assist with scheduling",
        fields: [
          {
            kind: "toggle",
            key: "assistScheduling",
            label: "Draft scheduling responses",
            description: "When someone asks to meet, draft a reply with proposed times based on your availability.",
            defaultValue: true
          },
          {
            kind: "text",
            key: "schedulingRules",
            label: "Scheduling rules & availability",
            description: "Your availability rules and preferences for scheduling meetings.",
            defaultValue: ""
          }
        ]
      }
    ],
    legacySettings: ({ archiveUnimportant, ...rest }) => ({
      // labelNewMail / assistScheduling / draftReplies keep their keys (an
      // unknown legacy key rides through so resolveSettings still rejects
      // it); archiveUnimportant has no field of its own anymore — true means
      // the default label set with auto-archive on the unimportant tiers.
      ...rest,
      ...(archiveUnimportant
        ? {
            labels: AUTO_INBOX_DEFAULT_LABELS.map((label) =>
              LEGACY_AUTO_ARCHIVE_LABEL_NAMES.has(label.name) ? { ...label, autoArchive: true } : { ...label }
            )
          }
        : {})
    }),
    buildSpec: (settings, timezone) => {
      // Per-account shape: each account contributes its own behavior lines
      // under an "Account <email>:" heading (its own labels/prefix, reply
      // scope, scheduling rules). Accounts whose functions are all off are
      // omitted; every account off means no job at all, the same rule as the
      // flat shape. Email keys were validated whitespace-free by
      // resolveInstallSettings, so a key can never forge extra prompt lines.
      if (isPerAccountSettings(settings)) {
        const perAccount = Object.entries(settings.accounts)
          .map(([email, accountSettings]) => ({ email, behaviors: autoInboxBehaviors(accountSettings) }))
          .filter((entry) => entry.behaviors.length > 0);
        if (perAccount.length === 0) return undefined;
        const assistsScheduling = Object.values(settings.accounts).some(
          (accountSettings) => accountSettings.assistScheduling === true
        );
        return {
          name: "Auto-inbox",
          templateId: "auto-inbox",
          templateSettings: { accounts: { ...settings.accounts } },
          cronExpression: "*/30 * * * *",
          cronTimezone: timezone,
          skillNames: assistsScheduling ? ["google-gmail", "google-calendar"] : ["google-gmail"],
          prompt: [
            "Tidy the user's Gmail inboxes: work through mail that arrived since the last run.",
            "Work ONLY the Gmail accounts listed below — each account carries its own configuration, applied to that account's inbox and no other:",
            ...perAccount.flatMap(({ email, behaviors }) => [`Account ${email}:`, ...behaviors]),
            ...AUTO_INBOX_SHARED_PROMPT
          ].join("\n")
        };
      }
      // Flat shape (zero-accounts installs and legacy jobs): the prompt is
      // composed ONLY of the functions the user toggled on.
      const behaviors = autoInboxBehaviors(settings);
      if (behaviors.length === 0) return undefined;
      return {
        name: "Auto-inbox",
        templateId: "auto-inbox",
        templateSettings: { ...settings },
        cronExpression: "*/30 * * * *",
        cronTimezone: timezone,
        skillNames: settings.assistScheduling === true ? ["google-gmail", "google-calendar"] : ["google-gmail"],
        prompt: [
          "Tidy the user's Gmail inbox: work through mail that arrived since the last run.",
          ...behaviors,
          ...AUTO_INBOX_SHARED_PROMPT
        ].join("\n")
      };
    }
  },
  {
    id: "morning-briefing",
    name: "Morning Briefing",
    description: "Start your day knowing exactly what matters.",
    icon: "sunrise",
    scheduleHint: "Daily at 8:00 AM",
    createsMessagesConversation: true,
    settings: [
      {
        key: "content",
        title: "Briefing content",
        fields: [{ kind: "toggle", key: "personalizedNews", label: "Personalized news topics", defaultValue: true }]
      }
    ],
    buildSpec: (state, timezone) => {
      // Flat-only template: the install path builds the { accounts } wrapper
      // only for perAccountSettings templates, so it never reaches here.
      const settings = isPerAccountSettings(state) ? {} : state;
      return {
        name: "Morning Briefing",
        templateId: "morning-briefing",
        templateSettings: { ...settings },
        cronExpression: "0 8 * * *",
        cronTimezone: timezone,
        skillNames: ["google-gmail", "google-calendar"],
        prompt: [
          "Prepare the user's morning briefing: a brief digest of important unread email plus today's calendar.",
          ...(settings.personalizedNews === true
            ? ["Add a short section of news relevant to the user's work, using what you know about them from memory and their profile."]
            : [])
        ].join("\n")
      };
    }
  },
  {
    id: "meeting-briefing",
    name: "Meeting Briefing",
    description: "Get meeting prep in email and Gini.",
    icon: "calendar-check",
    scheduleHint: "Every 15 minutes",
    createsMessagesConversation: true,
    settings: [],
    buildSpec: (_settings, timezone) => ({
      name: "Meeting Briefing",
      templateId: "meeting-briefing",
      cronExpression: "*/15 * * * *",
      cronTimezone: timezone,
      skillNames: ["google-calendar", "google-gmail"],
      prompt:
        "Check the user's calendar for meetings starting within the next hour that haven't been briefed yet. When one is found, prepare a prep note: attendees, recent email context with them, and the agenda. Otherwise do nothing and finish quietly."
    })
  }
];

export function routineTemplate(id: string): RoutineTemplate | undefined {
  return ROUTINE_TEMPLATES.find((template) => template.id === id);
}

// The job's delivery surface: templates that create Messages conversations
// own a live channel-kind session titled after the routine (the "Morning
// Briefing" conversation in Messages), and each fire's final answer lands
// there as an assistant message (dispatchPromptRun /
// finalizeJobRunFromTask). Templates that opt out of visible delivery (Auto-
// inbox) still get a HEADLESS working channel with deliveryPolicy:"silent":
// the parent job can call spawn_task from a container, while user-visible
// work appears only as surfaced child tasks. Absent `reuseSessionId`,
// createScheduledJob mints the session inside the same write as the job
// (the create_job tool's `createDedicatedSession` idiom). On a reinstall the
// caller passes the replaced job's session instead: removeJob archived it
// with the old job, so bind the new job to it and un-archive it
// (idempotent, audited `chat.session.unarchived`) — settings edits never
// churn the conversation or its history. Bind BEFORE un-archiving: a live
// job-origin channel with no referencing job violates the invariant
// archiveOrphanJobChannels (state/store.ts) sweeps on every state load, so a
// channel un-archived first would be re-archived from under the install.
export async function createRoutineJob(
  config: RuntimeConfig,
  spec: Record<string, unknown>,
  reuseSessionId?: string
): Promise<JobRecord> {
  const templateId = typeof spec.templateId === "string" ? spec.templateId : undefined;
  const createsMessagesConversation = templateId ? (routineTemplate(templateId)?.createsMessagesConversation ?? true) : true;
  if (!createsMessagesConversation) {
    const hiddenSpec = { ...spec, deliveryPolicy: "silent" };
    if (reuseSessionId !== undefined) {
      const job = await createScheduledJob(config, { ...hiddenSpec, chatSessionId: reuseSessionId });
      await mutateState(config.instance, (state) => setContainerArchived(state, reuseSessionId, false));
      return job;
    }
    return createScheduledJob(config, { ...hiddenSpec, createDedicatedSession: { title: String(spec.name) } });
  }
  if (reuseSessionId !== undefined) {
    const job = await createScheduledJob(config, { ...spec, chatSessionId: reuseSessionId });
    await mutateState(config.instance, (state) => setContainerArchived(state, reuseSessionId, false));
    return job;
  }
  return createScheduledJob(config, { ...spec, createDedicatedSession: { title: String(spec.name) } });
}

// The session a reinstall should carry forward: the job's own live
// channel-kind session. A caller-bound conversation (kind "agent") or an
// already-archived channel is never reused — the fresh install mints its own.
export function reusableRoutineSessionId(state: RuntimeState, job: JobRecord): string | undefined {
  const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
  return session && session.kind === "channel" && !session.archivedAt ? session.id : undefined;
}

// One connected account's row in a per-account template's installed state:
// the registry identity plus the resolved settings that account renders in
// the Settings tab. Exactly the effective primary row carries `primary`, so
// the web's account switcher can default to it.
export interface RoutineAccountSettingsView {
  accountId: string;
  email: string;
  primary?: boolean;
  settings: RoutineSettings;
}

// The gallery's wire shape: the template presentation fields plus the live
// installed state — the job carrying this templateId (scoped to `agentId`
// when supplied, like GET /api/jobs). `installed.settings` is the resolved
// settings state the job was installed with (absent on templates without
// settings and on jobs predating provenance); per-account templates carry
// `installed.accountSettings` instead — one row per registered Google
// account — falling back to the flat `settings` only when no account is
// registered. `installed.chatSessionId` is the routine's conversation when
// this template delivers to Messages (absent for Auto-inbox and on jobs
// predating session provisioning) so the detail page can deep-link Open
// messages where applicable.
export interface RoutineTemplateView {
  id: string;
  name: string;
  description: string;
  icon: string;
  scheduleHint: string;
  settings: RoutineSettingsSection[];
  installed: {
    jobId: string;
    status: JobStatus;
    settings?: RoutineSettings;
    accountSettings?: RoutineAccountSettingsView[];
    chatSessionId?: string;
  } | null;
}

// GET /api/routines/templates
export function listRoutineTemplates(config: RuntimeConfig, agentId?: string): { templates: RoutineTemplateView[] } {
  const jobs = readState(config.instance).jobs;
  const accounts = registeredGmailAccounts();
  const primaryAccountId = effectivePrimaryId(accounts);
  // Backfill label profiles for accounts that predate discovery (or signed
  // in through a path without the connect trigger). Fire-and-forget, and
  // ONLY for accounts with no profile file at all — a failed profile is
  // retried by a fresh sign-in, never by this poll-driven read.
  if (ROUTINE_TEMPLATES.some((template) => template.perAccountSettings)) {
    for (const account of accounts) {
      if (!readLabelProfile(account.id)) ensureLabelProfile(config, account);
    }
  }
  return {
    templates: ROUTINE_TEMPLATES.map((template) => {
      const job = jobs.find((j) => j.templateId === template.id && (!agentId || j.agentId === agentId));
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        icon: template.icon,
        scheduleHint: template.scheduleHint,
        settings: template.settings,
        installed: job
          ? {
              jobId: job.id,
              status: job.status,
              ...(template.perAccountSettings && accounts.length > 0
                ? {
                    accountSettings: accounts.map((account) => ({
                      accountId: account.id,
                      email: accountEmailKey(account),
                      ...(account.id === primaryAccountId ? { primary: true as const } : {}),
                      settings: installedAccountSettings(template, job, account)
                    }))
                  }
                : { settings: installedSettings(template, job) }),
              ...(template.createsMessagesConversation ? { chatSessionId: job.chatSessionId } : {})
            }
          : null
      };
    })
  };
}

// The settings state an installed job renders in the Settings tab: the job's
// persisted templateSettings when stamped, else its legacy templateOptions
// mapped through the template's legacySettings hook (identity when none) —
// each filled with the catalog defaults so the tab always sees a complete
// state. Absent both stamps (templates without settings, jobs predating
// provenance) → undefined.
function installedSettings(template: RoutineTemplate, job: JobRecord): RoutineSettings | undefined {
  const raw =
    job.templateSettings ??
    (job.templateOptions !== undefined
      ? (template.legacySettings?.(job.templateOptions) ?? job.templateOptions)
      : undefined);
  if (raw === undefined) return undefined;
  return fillSettingsDefaults(template, raw as Record<string, unknown>);
}

// The settings state ONE account renders in a per-account template's
// Settings tab, by precedence: the account's own entry in the persisted
// { accounts } wrapper, else the job's legacy flat stamp (a pre-per-account
// install applies to every account alike), else the account's seeded
// defaults — so an account connected after the install still shows an
// editable state and joins the persisted map on the next save.
function installedAccountSettings(template: RoutineTemplate, job: JobRecord, account: GoogleAccount): RoutineSettings {
  if (isPerAccountSettings(job.templateSettings)) {
    const own = job.templateSettings.accounts[accountEmailKey(account)];
    return own !== undefined
      ? fillSettingsDefaults(template, own as Record<string, unknown>)
      : defaultSettingsForAccount(template, account);
  }
  return installedSettings(template, job) ?? defaultSettingsForAccount(template, account);
}

// The registry rows per-account settings enumerate: every registered Google
// account whose email is known (a trusted-registered row can predate its
// email backfill — it joins once a list read back-fills the live email).
// Sync and registry-only (no gws probes): this runs on every gallery GET.
function registeredGmailAccounts(): GoogleAccount[] {
  return readGoogleAccounts().filter((account) => account.email.trim().length > 0);
}

// The lowercased-email key an account's settings live under — the same
// address form EmailWatcherRecord.accountEmail matches on.
function accountEmailKey(account: GoogleAccount): string {
  return account.email.trim().toLowerCase();
}

// The effective primary among the rows: the persisted primaryAccountId when
// it names one of them, else the first provisioned row, else the first row —
// the same precedence as effectivePrimaryAccountId in
// integrations/connectors/google-accounts.ts, mirrored registry-only here
// (like resolveScanConfigDir in onboarding.ts) so this hot gallery read
// never grows a connectors-layer import.
function effectivePrimaryId(accounts: GoogleAccount[]): string | undefined {
  const persisted = readPrimaryGoogleAccountId();
  if (persisted && accounts.some((account) => account.id === persisted)) return persisted;
  return (accounts.find((account) => account.provisioned) ?? accounts[0])?.id;
}

// POST /api/routines/templates/<id>/install body: { timezone?, settings?,
// options? }. Missing setting keys fall back to the template defaults; the
// legacy flat boolean `options` map is still accepted (mapped through
// legacySettings) so pre-settings clients keep working. For per-account
// templates `settings` is keyed by account email (resolveInstallSettings
// below owns the shapes and fallbacks). Idempotent
// per-template replace: any job the OWNING AGENT already has carrying this
// templateId is deleted, then one fresh job is created — the same
// createScheduledJob call POST /api/jobs makes. The owning agent is resolved
// server-side (never caller-supplied), exactly as createScheduledJob stamps
// the new job's agentId — so install/uninstall mutate only the active
// agent's install and another agent's job with the same templateId is never
// touched. Skills are pre-validated so a disabled Workspace skill surfaces
// as a clean 400 with zero side effects (nothing deleted).
export async function installRoutineTemplate(
  config: RuntimeConfig,
  templateId: string,
  payload: Record<string, unknown>
): Promise<JobRecord> {
  const template = routineTemplate(templateId);
  if (!template) throw new Error(`Routine template not found: ${templateId}`);
  const timezone =
    payload.timezone !== undefined
      ? validateTimezone(payload.timezone)
      : (readOnboarding(config.instance)?.timezone ?? "UTC");
  const settings = resolveInstallSettings(template, payload);
  const spec = template.buildSpec(settings, timezone);
  if (!spec) {
    throw new Error(`Invalid input: enable at least one ${template.name} option`);
  }
  const state = readState(config.instance);
  assertSkillNamesResolve(state, spec.skillNames as string[]);
  const owningAgentId = resolveEffectiveContext(state, config).agentId;
  // Capture the replaced install's conversation BEFORE the replace pass:
  // removeJob archives a job's dedicated channel along with the job, and
  // createRoutineJob un-archives + rebinds it so a Settings save keeps the
  // message-delivering routine's Messages history instead of minting a
  // fresh thread. Templates that opt out of Messages ignore the captured
  // session in createRoutineJob.
  let reuseSessionId: string | undefined;
  for (const job of state.jobs.filter((j) => j.templateId === template.id && j.agentId === owningAgentId)) {
    reuseSessionId ??= reusableRoutineSessionId(state, job);
    try {
      await removeJob(config, job.id);
    } catch {
      // Already removed out-of-band (e.g. via DELETE /api/jobs) — ignore.
    }
  }
  return createRoutineJob(config, spec, reuseSessionId);
}

// DELETE /api/routines/templates/<id> — remove the owning agent's installed
// job(s) carrying this templateId (owning agent resolved server-side, same
// as install). 404 when that agent has none installed, so the gallery's
// Remove is an honest one-click inverse of Install. removeJob archives the
// routine's conversation with the job when one exists — it leaves the
// Messages list but its history stays addressable, and a later re-install
// starts a fresh thread. Templates that opt out of Messages simply remove
// the job.
export async function uninstallRoutineTemplate(
  config: RuntimeConfig,
  templateId: string
): Promise<{ removed: string[] }> {
  const template = routineTemplate(templateId);
  if (!template) throw new Error(`Routine template not found: ${templateId}`);
  const state = readState(config.instance);
  const owningAgentId = resolveEffectiveContext(state, config).agentId;
  const jobs = state.jobs.filter((j) => j.templateId === template.id && j.agentId === owningAgentId);
  if (jobs.length === 0) {
    throw new Error(`Routine template not found: "${templateId}" is not installed`);
  }
  const removed: string[] = [];
  for (const job of jobs) {
    await removeJob(config, job.id);
    removed.push(job.id);
  }
  return { removed };
}

// Validate the caller's settings state against the template's fields
// (unknown keys and wrong-kind values are payload mistakes) and fill missing
// keys from the field defaults. Values are canonicalized on the way in —
// text and label names/rules trimmed, label colors falling back to the
// palette — so what buildSpec composes from and what templateSettings
// persists is always the normalized shape.
export function resolveSettings(template: RoutineTemplate, raw: unknown): RoutineSettings {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("Invalid input: settings must be an object");
  }
  const supplied = (raw ?? {}) as Record<string, unknown>;
  const fields = settingFields(template);
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) {
      throw new Error(`Invalid input: unknown setting "${key}" for template "${template.id}"`);
    }
  }
  const resolved: RoutineSettings = {};
  for (const field of fields) {
    const value = supplied[field.key];
    resolved[field.key] = value === undefined ? defaultSettingValue(field) : resolveSettingValue(field, value);
  }
  return resolved;
}

// Map a legacy flat boolean option map (the pre-settings install body and
// the onboarding routines body) onto the settings model, via the template's
// legacySettings hook when it has one. Returns undefined when no options
// were supplied so resolveSettings falls back to the field defaults.
export function legacyOptionsToSettings(template: RoutineTemplate, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid input: options must be an object of booleans");
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean") {
      throw new Error(`Invalid input: option "${key}" must be a boolean (got ${String(value)})`);
    }
  }
  const options = raw as Record<string, boolean>;
  return template.legacySettings ? template.legacySettings(options) : options;
}

// Resolve an install payload's settings ({ settings?, options? }) into the
// state buildSpec composes from. Flat templates resolve exactly as before
// (settings > legacy options > field defaults). For per-account templates
// the resolved state is the { accounts } wrapper:
//   - a body keyed by email validates each entry through resolveSettings
//     under its lowercased email key;
//   - a flat body — or the legacy boolean options map, which is how the
//     onboarding routines path arrives here — applies alike to every
//     registered account;
//   - an absent body seeds one entry per registered account from the
//     per-account defaults;
//   - with zero registered accounts every non-account-keyed shape falls back
//     to the flat single blob, so instances without a Google account still
//     install.
// Shared by the gallery install and the onboarding routineJobSpecs so both
// writers persist the same shape.
export function resolveInstallSettings(
  template: RoutineTemplate,
  payload: Record<string, unknown>
): RoutineSettings | PerAccountRoutineSettings {
  const raw =
    payload.settings !== undefined && payload.settings !== null
      ? payload.settings
      : legacyOptionsToSettings(template, payload.options);
  if (!template.perAccountSettings) return resolveSettings(template, raw);
  if (isAccountKeyedSettings(raw)) {
    return { accounts: resolveAccountSettingsMap(template, raw as Record<string, unknown>) };
  }
  const accounts = registeredGmailAccounts();
  if (accounts.length === 0) return resolveSettings(template, raw);
  if (raw !== undefined) {
    return {
      accounts: Object.fromEntries(accounts.map((account) => [accountEmailKey(account), resolveSettings(template, raw)]))
    };
  }
  return {
    accounts: Object.fromEntries(
      accounts.map((account) => [accountEmailKey(account), defaultSettingsForAccount(template, account)])
    )
  };
}

// A settings body is account-keyed when any key carries an email's "@" —
// field keys never do — so the flat blob and the per-account map share the
// wire without a wrapper. A map mixing email and field keys fails the
// per-key email validation below, surfacing the payload mistake.
function isAccountKeyedSettings(raw: unknown): boolean {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.some((key) => key.includes("@"));
}

// Bounds on the per-account map: ten entries covers any realistic set of
// connected accounts while keeping a hostile payload from ballooning the
// persisted job record.
const MAX_SETTINGS_ACCOUNTS = 10;
const MAX_ACCOUNT_EMAIL_CHARS = 200;

// Validate an account-keyed settings map: each key must look like an email
// (non-empty, "@", bounded, whitespace-free — keys embed into "Account
// <email>:" prompt lines, so whitespace could otherwise forge extra lines)
// and is lowercased on store; each value passes the same per-field
// validation a flat install does. Emails are NOT checked against the
// registry: the web posts the map it rendered, and an account removed
// between render and save must not fail the save.
function resolveAccountSettingsMap(template: RoutineTemplate, raw: Record<string, unknown>): Record<string, RoutineSettings> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_SETTINGS_ACCOUNTS) {
    throw new Error(`Invalid input: settings allows at most ${MAX_SETTINGS_ACCOUNTS} accounts`);
  }
  const accounts: Record<string, RoutineSettings> = {};
  for (const [key, value] of entries) {
    const email = key.trim().toLowerCase();
    if (email.length === 0 || email.length > MAX_ACCOUNT_EMAIL_CHARS || !email.includes("@") || /\s/.test(email)) {
      throw new Error(`Invalid input: settings account key "${key}" must be an email address`);
    }
    if (accounts[email] !== undefined) {
      throw new Error(`Invalid input: settings repeats account "${email}"`);
    }
    accounts[email] = resolveSettings(template, value);
  }
  return accounts;
}

// One account's seeded default settings: the catalog field defaults, except
// that a labelList field always MERGES the account's discovered Gmail label
// profile (label discovery pulls it on sign-in; see
// src/runtime/label-discovery.ts) with the standard starter set — the user's
// own labels first, then the standard labels no existing label already
// covers. A saved edit beats the seed: this seeding only applies where no
// persisted entry exists.
function defaultSettingsForAccount(template: RoutineTemplate, account: GoogleAccount): RoutineSettings {
  const profile = readLabelProfile(account.id);
  const resolved: RoutineSettings = {};
  for (const field of settingFields(template)) {
    resolved[field.key] = field.kind === "labelList" ? seededLabelList(field, profile) : defaultSettingValue(field);
  }
  return resolved;
}

// The merged seed caps below resolveSettings' MAX_LABELS so a full standard
// append onto a 12-label digest still saves.
const MAX_SEEDED_LABELS = 20;

// One labelList field's merged seed: the account's discovered labels first
// (origin "existing", digest order, swatches kept palette-backed even if a
// hand-edited profile lost its hexes), then the standard catalog labels
// (origin "suggested", catalog order) — skipping standard labels the digest
// marked functionally covered (coveredStandard) and case-insensitive name
// collisions with an existing label. Failed/absent/empty profiles — and
// pre-coveredStandard profiles' uncovered remainder — seed the full standard
// set. Suggested labels truncate first when the merged list exceeds the cap
// (existing lead by construction).
function seededLabelList(field: RoutineSettingField & { kind: "labelList" }, profile: GoogleLabelProfile | undefined): RoutineLabelRule[] {
  const ready = profile?.status === "ready" && profile.labels.length > 0 ? profile : undefined;
  const existing: RoutineLabelRule[] = (ready?.labels ?? []).map((label, index) => ({
    name: label.name,
    color: HEX_COLOR.test(label.color) ? label.color : LABEL_COLOR_PALETTE[index % LABEL_COLOR_PALETTE.length]!,
    rule: label.rule,
    autoArchive: label.autoArchive === true,
    origin: "existing" as const
  }));
  const skip = new Set<string>();
  for (const name of ready?.coveredStandard ?? []) skip.add(name.toLowerCase());
  for (const label of existing) skip.add(label.name.toLowerCase());
  const suggested = field.defaultValue
    .filter((label) => !skip.has(label.name.toLowerCase()))
    .map((label) => ({ ...label, origin: "suggested" as const }));
  return [...existing, ...suggested].slice(0, MAX_SEEDED_LABELS);
}

const MAX_LABELS = 24;
// Exported so label discovery's digest validator clamps to the same label
// bounds this module's resolveSettings enforces.
export const MAX_LABEL_NAME_CHARS = 60;
export const MAX_LABEL_RULE_CHARS = 500;
const MAX_TEXT_CHARS = 2000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function resolveSettingValue(field: RoutineSettingField, value: unknown): RoutineSettings[string] {
  switch (field.kind) {
    case "toggle":
      if (typeof value !== "boolean") {
        throw new Error(`Invalid input: setting "${field.key}" must be a boolean (got ${String(value)})`);
      }
      return value;
    case "text": {
      if (typeof value !== "string") {
        throw new Error(`Invalid input: setting "${field.key}" must be a string`);
      }
      const text = value.trim();
      if (text.length > MAX_TEXT_CHARS) {
        throw new Error(`Invalid input: setting "${field.key}" must be at most ${MAX_TEXT_CHARS} characters`);
      }
      return text;
    }
    case "labelList": {
      if (!Array.isArray(value)) {
        throw new Error(`Invalid input: setting "${field.key}" must be an array of labels`);
      }
      if (value.length > MAX_LABELS) {
        throw new Error(`Invalid input: setting "${field.key}" allows at most ${MAX_LABELS} labels`);
      }
      return value.map((entry, index) => resolveLabelRule(field.key, entry, index));
    }
  }
}

function resolveLabelRule(key: string, entry: unknown, index: number): RoutineLabelRule {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid input: setting "${key}" labels must be objects`);
  }
  const raw = entry as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length === 0 || name.length > MAX_LABEL_NAME_CHARS) {
    throw new Error(`Invalid input: setting "${key}" label names must be non-empty strings of at most ${MAX_LABEL_NAME_CHARS} characters`);
  }
  if (raw.rule !== undefined && typeof raw.rule !== "string") {
    throw new Error(`Invalid input: setting "${key}" label rules must be strings`);
  }
  const rule = typeof raw.rule === "string" ? raw.rule.trim() : "";
  if (rule.length > MAX_LABEL_RULE_CHARS) {
    throw new Error(`Invalid input: setting "${key}" label rules must be at most ${MAX_LABEL_RULE_CHARS} characters`);
  }
  if (raw.autoArchive !== undefined && typeof raw.autoArchive !== "boolean") {
    throw new Error(`Invalid input: setting "${key}" label autoArchive must be a boolean`);
  }
  // The color is UI presentation only (never pushed to Gmail), so a missing
  // or malformed hex falls back to the palette by position instead of
  // failing the install.
  const color = typeof raw.color === "string" && HEX_COLOR.test(raw.color) ? raw.color : LABEL_COLOR_PALETTE[index % LABEL_COLOR_PALETTE.length]!;
  // The provenance tag is presentation only too: a valid value survives the
  // save round-trip, anything else is dropped rather than failing it.
  const origin = raw.origin === "existing" || raw.origin === "suggested" ? raw.origin : undefined;
  return { name, color, rule, autoArchive: raw.autoArchive === true, ...(origin ? { origin } : {}) };
}

// Fill missing field keys from the catalog defaults WITHOUT re-validating
// present values: templateSettings passed resolveSettings when it was
// stamped and legacySettings output is code-built, so this path only
// completes the shape for jobs installed before a field existed. Keys with
// no catalog field (a retired option riding in legacy templateOptions) are
// dropped by construction — only catalog fields are read.
function fillSettingsDefaults(template: RoutineTemplate, supplied: Record<string, unknown>): RoutineSettings {
  const resolved: RoutineSettings = {};
  for (const field of settingFields(template)) {
    const value = supplied[field.key];
    resolved[field.key] = value === undefined ? defaultSettingValue(field) : (value as RoutineSettings[string]);
  }
  return resolved;
}

function settingFields(template: RoutineTemplate): RoutineSettingField[] {
  return template.settings.flatMap((section) => section.fields);
}

// labelList defaults are cloned per resolution so a caller mutating the
// resolved state can never alias-mutate the catalog constants.
function defaultSettingValue(field: RoutineSettingField): RoutineSettings[string] {
  return field.kind === "labelList" ? field.defaultValue.map((label) => ({ ...label })) : field.defaultValue;
}

// Rule and free-text fragments embed into single prompt lines — collapse
// user-entered newlines/runs of whitespace so one field can't visually forge
// additional prompt bullets.
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Probe-validate an IANA timezone by constructing a formatter with it — Intl
// throws a RangeError on unknown zones. A membership check against
// Intl.supportedValuesOf("timeZone") would be wrong here: that list is
// NARROWER than what Intl (and croner, which also resolves zones through
// Intl) accepts — this runtime's ICU lists legacy aliases like Asia/Calcutta
// while browsers report the modern canonical Asia/Kolkata, so real user
// timezones would be rejected. A zone that passes the probe never fails job
// creation. Used by the install path here and the onboarding PATCH/routines
// paths.
export function validateTimezone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid input: timezone must be a non-empty string");
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch {
    throw new Error(`Invalid input: timezone "${value}" is not a valid IANA timezone`);
  }
  return value;
}
