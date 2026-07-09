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
import { readOnboarding } from "../state/onboarding";
import type { JobRecord, JobStatus, RuntimeConfig, RuntimeState } from "../types";

export interface RoutineTemplateOption {
  key: string;
  label: string;
  defaultEnabled: boolean;
  description?: string;
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
  options: RoutineTemplateOption[];
  // Compose the createScheduledJob payload for the given option state.
  // Templates with options stamp the resolved state as `templateOptions`
  // (next to `templateId`) so the installed job records the selection it
  // was built from. Returns undefined when the selection yields no behavior
  // at all (an Auto-inbox with every sub-option off), mirroring the
  // onboarding rule that such a selection creates no job.
  buildSpec(options: Record<string, boolean>, timezone: string): Record<string, unknown> | undefined;
}

// The starter catalog. Adding a template is one entry here — prompts and
// crons are product-owned (never composed in the browser), and the option
// defaults match the onboarding StepRoutines defaults.
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "auto-inbox",
    name: "Auto-inbox",
    description: "Your inbox, organized without the work.",
    icon: "inbox",
    scheduleHint: "Every 30 minutes",
    createsMessagesConversation: false,
    options: [
      { key: "labelNewMail", label: "Label new mail", defaultEnabled: true },
      { key: "archiveUnimportant", label: "Archive unimportant emails", defaultEnabled: false },
      { key: "assistScheduling", label: "Assist with scheduling", defaultEnabled: true },
      { key: "draftReplies", label: "Draft replies to important emails", defaultEnabled: true }
    ],
    buildSpec: (options, timezone) => {
      // The prompt is composed ONLY of the behaviors the user toggled on.
      const behaviors: string[] = [];
      if (options.labelNewMail) {
        behaviors.push("- Label new mail into sensible Gmail labels.");
      }
      if (options.archiveUnimportant) {
        behaviors.push("- Archive clearly-unimportant mail (promotions, notifications) — never anything personal or important.");
      }
      if (options.assistScheduling) {
        behaviors.push("- Detect scheduling requests. When a response is needed, spawn a surfaced child task to draft the scheduling reply.");
      }
      if (options.draftReplies) {
        behaviors.push("- Detect important emails awaiting a response. For each one, spawn a surfaced child task to draft the reply.");
      }
      if (behaviors.length === 0) return undefined;
      return {
        name: "Auto-inbox",
        templateId: "auto-inbox",
        templateOptions: { ...options },
        cronExpression: "*/30 * * * *",
        cronTimezone: timezone,
        skillNames: options.assistScheduling ? ["google-gmail", "google-calendar"] : ["google-gmail"],
        prompt: [
          "Tidy the user's Gmail inbox: work through mail that arrived since the last run.",
          ...behaviors,
          "Silent behaviors: labeling and archiving happen directly in this Auto-inbox run and need no user-facing delivery.",
          "Draft-producing behaviors: do NOT save draft replies in this Auto-inbox run. For every email that needs a reply or scheduling response, call spawn_task with surface:true and await:\"none\" so the user sees a Home task. Use one task per email thread/message, with a stable correlation_key like `auto-inbox:<account>:<message-or-thread-id>` so later runs do not duplicate it.",
          "Each spawned task brief must be self-contained: include the exact Gmail account, message id and thread id when known, sender, subject, relevant body/snippet, why a response is needed, and any scheduling constraints/calendar context already discovered.",
          "The spawned task's goal is to save a Gmail draft and render it as an `email-draft` card with DraftId and Account so the user can review, iterate, and send from the card. If the draft proposes a specific meeting time, the child task must also render the calendar preview required by the google-gmail skill.",
          "Gini never sends email or messages without the user's review — save drafts only, never send."
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
    options: [{ key: "personalizedNews", label: "Personalized news topics", defaultEnabled: true }],
    buildSpec: (options, timezone) => ({
      name: "Morning Briefing",
      templateId: "morning-briefing",
      templateOptions: { ...options },
      cronExpression: "0 8 * * *",
      cronTimezone: timezone,
      skillNames: ["google-gmail", "google-calendar"],
      prompt: [
        "Prepare the user's morning briefing: a brief digest of important unread email plus today's calendar.",
        ...(options.personalizedNews
          ? ["Add a short section of news relevant to the user's work, using what you know about them from memory and their profile."]
          : [])
      ].join("\n")
    })
  },
  {
    id: "meeting-briefing",
    name: "Meeting Briefing",
    description: "Get meeting prep in email and Gini.",
    icon: "calendar-check",
    scheduleHint: "Every 15 minutes",
    createsMessagesConversation: true,
    options: [],
    buildSpec: (_options, timezone) => ({
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
// (idempotent, audited `chat.session.unarchived`) — option edits never churn
// the conversation or its history. Bind BEFORE un-archiving: a live
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

// The gallery's wire shape: the template presentation fields plus the live
// installed state — the job carrying this templateId (scoped to `agentId`
// when supplied, like GET /api/jobs). `installed.options` is the resolved
// option state the job was installed with (absent on templates without
// options and on jobs predating templateOptions); `installed.chatSessionId`
// is the routine's conversation when this template delivers to Messages
// (absent for Auto-inbox and on jobs predating session provisioning) so the
// detail page can deep-link Open messages where applicable.
export interface RoutineTemplateView {
  id: string;
  name: string;
  description: string;
  icon: string;
  scheduleHint: string;
  options: RoutineTemplateOption[];
  installed: { jobId: string; status: JobStatus; options?: Record<string, boolean>; chatSessionId?: string } | null;
}

// GET /api/routines/templates
export function listRoutineTemplates(config: RuntimeConfig, agentId?: string): { templates: RoutineTemplateView[] } {
  const jobs = readState(config.instance).jobs;
  return {
    templates: ROUTINE_TEMPLATES.map((template) => {
      const job = jobs.find((j) => j.templateId === template.id && (!agentId || j.agentId === agentId));
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        icon: template.icon,
        scheduleHint: template.scheduleHint,
        options: template.options,
        installed: job
          ? {
              jobId: job.id,
              status: job.status,
              options: job.templateOptions,
              ...(template.createsMessagesConversation ? { chatSessionId: job.chatSessionId } : {})
            }
          : null
      };
    })
  };
}

// POST /api/routines/templates/<id>/install body: { timezone?, options? }.
// Missing option keys fall back to the template defaults. Idempotent
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
  const options = resolveOptions(template, payload.options);
  const spec = template.buildSpec(options, timezone);
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

// Validate the caller's option state against the template (unknown keys and
// non-boolean values are payload mistakes) and fill missing keys from the
// template defaults.
function resolveOptions(template: RoutineTemplate, raw: unknown): Record<string, boolean> {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("Invalid input: options must be an object of booleans");
  }
  const supplied = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(template.options.map((option) => option.key));
  for (const [key, value] of Object.entries(supplied)) {
    if (!known.has(key)) {
      throw new Error(`Invalid input: unknown option "${key}" for template "${template.id}"`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`Invalid input: option "${key}" must be a boolean (got ${String(value)})`);
    }
  }
  const resolved: Record<string, boolean> = {};
  for (const option of template.options) {
    resolved[option.key] = (supplied[option.key] as boolean | undefined) ?? option.defaultEnabled;
  }
  return resolved;
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
