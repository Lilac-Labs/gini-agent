// Browser-facing web onboarding endpoints (ADR web-onboarding-flow.md).
//
// The webapp's /onboarding first-run flow drives four endpoints, all thin
// delegations from src/http.ts into this module:
//
//   - GET  /api/onboarding          → getOnboarding (grandfathering on first
//     read; staleness guard for a running scan orphaned by a restart)
//   - PATCH /api/onboarding         → patchOnboarding (timezone/theme/completed)
//   - POST /api/onboarding/scan     → startOnboardingScan (kick off the
//     deterministic profile scan; idempotent; no_account when Gmail is
//     unreachable)
//   - POST /api/onboarding/routines → applyOnboardingRoutines (idempotent
//     replace of the starter routine jobs via the jobs module)
//
// The record itself persists at ~/.gini/instances/<instance>/onboarding.json
// (src/state/onboarding.ts). The scan is a deterministic in-runtime pipeline
// (src/runtime/onboarding-scan.ts): one `gws auth export` mints a Gmail access
// token, direct parallel Gmail HTTP reads fetch the mailbox with no model and
// no tool loop, then two parallel structured model calls synthesize the
// profile and the suggested tasks. startOnboardingScan runs it in the
// background and finalizes the record + pushes an `onboarding` event over the
// events stream (the browser is notified instead of polling). Validation
// errors throw with the "Invalid input:" prefix the gateway maps to a 400.

import { resolveEffectiveContext } from "../execution/effective-context";
import { assertSkillNamesResolve, removeJob } from "../jobs";
import { autostartCrmExtractionAfterOnboarding, primeCrmExtractionThreads } from "../jobs/crm-extractor";
import { appendEvent, mutateState, readState } from "../state";
import { getGoogleAccountBindings } from "../state/google-account-bindings";
import { readGoogleAccounts } from "../state/google-accounts";
import { now } from "../state/ids";
import { defaultOnboardingRecord, readOnboarding, writeOnboarding } from "../state/onboarding";
import { runProfileScan } from "./onboarding-scan";
import {
  ROUTINE_TEMPLATES,
  createRoutineJob,
  resolveInstallSettings,
  reusableRoutineSessionId,
  routineTemplate,
  validateTimezone
} from "./routine-templates";
import type { ChatSessionRecord, GoogleAccount, JobRecord, OnboardingProfile, OnboardingRecord, OnboardingScan, RuntimeConfig, Task } from "../types";

// A running scan older than this is treated as orphaned by a runtime restart
// (the background pipeline died with the process) and flipped to failed on the
// next GET, so the web's "Try again" resubmits it. The deterministic pipeline
// (one parallel HTTP fetch window + two parallel model calls) settles well
// within this.
const SCAN_STALE_MS = 5 * 60_000;

// Read the record, applying the two lazy side effects the contract assigns to
// GET: (a) grandfathering — an instance with existing USER usage (any
// user-attributable chat session, task, or scheduled job) on FIRST read is
// marked completed immediately, so existing users are never funneled into the
// first-run flow;
// (b) a "running" scan orphaned by a runtime restart (older than SCAN_STALE_MS)
// is flipped to failed so the web can resubmit it. A genuinely fresh instance
// gets the default record WITHOUT persisting it; the first PATCH/scan write
// creates the file.
export function getOnboarding(config: RuntimeConfig): OnboardingRecord {
  const record = readOnboarding(config.instance);
  if (!record) {
    const fresh = defaultOnboardingRecord();
    const state = readState(config.instance);
    // Scheduled jobs count as user evidence too: an existing instance may
    // hold nothing but jobs (every session job-origin, every task
    // jobId-stamped). Onboarding-created jobs can't feed back into this
    // check — the record file is persisted before any routine job exists.
    if (state.chatSessions.some(isUserSession) || state.tasks.some(isUserTask) || state.jobs.length > 0) {
      fresh.completed = true;
      fresh.completedAt = now();
      writeOnboarding(config.instance, fresh);
    }
    return fresh;
  }
  failStaleScan(config, record);
  return record;
}

// Grandfathering keys on user-attributable usage only: the runtime creates
// sessions and tasks of its own accord — job-spawned channel sessions (the
// daily skill-review digest), feature-stamped channels, cron-fired job tasks
// and their subagent children — and none of those mean a human has ever used
// this instance.
function isUserSession(session: ChatSessionRecord): boolean {
  if (session.origin === "job" || session.feature !== undefined) return false;
  // Auto-materialized canonical chats are empty: reading an agent's chat
  // creates its kind:"agent" session as a GET side effect. Only a session
  // with actual content (messages or tasks) is evidence a human used it.
  return (session.messageIds?.length ?? 0) > 0 || (session.taskIds?.length ?? 0) > 0;
}

function isUserTask(task: Task): boolean {
  return task.jobId === undefined && task.parentTaskId === undefined;
}

// Staleness guard: a scan whose background pipeline was orphaned by a runtime
// restart stays "running" forever (the in-process pipeline died with the
// process). Flip a running scan older than SCAN_STALE_MS to failed so the web's
// "Try again" resubmits it; a genuinely in-flight scan (younger, or with no
// startedAt) is left untouched — it finalizes itself via the background
// pipeline's event push. Mutates + persists the record in place.
function failStaleScan(config: RuntimeConfig, record: OnboardingRecord): void {
  if (record.scan.status !== "running") return;
  const startedAt = record.scan.startedAt ? Date.parse(record.scan.startedAt) : NaN;
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < SCAN_STALE_MS) return;
  record.scan = { ...record.scan, status: "failed", error: "Scan interrupted — please try again.", finishedAt: now() };
  writeOnboarding(config.instance, record);
}

// PATCH body: { timezone?, theme?, completed? }. Each field is validated
// before any write; completed:true stamps completedAt once.
export function patchOnboarding(config: RuntimeConfig, payload: Record<string, unknown>): OnboardingRecord {
  const record = getOnboarding(config);
  const wasCompleted = record.completed;
  if (payload.timezone !== undefined) {
    record.timezone = validateTimezone(payload.timezone);
  }
  if (payload.theme !== undefined) {
    if (payload.theme !== "light" && payload.theme !== "dark") {
      throw new Error(`Invalid input: theme must be "light" or "dark" (got ${String(payload.theme)})`);
    }
    record.theme = payload.theme;
  }
  if (payload.completed !== undefined) {
    if (typeof payload.completed !== "boolean") {
      throw new Error(`Invalid input: completed must be a boolean (got ${String(payload.completed)})`);
    }
    record.completed = payload.completed;
    if (payload.completed) record.completedAt ??= now();
    else delete record.completedAt;
  }
  writeOnboarding(config.instance, record);
  if (!wasCompleted && record.completed) {
    // The recent Gmail snapshot is already available by the final wizard step,
    // so this is the first safe point to launch the heavy People backfill. It
    // remains detached and can never fail the completion response.
    autostartCrmExtractionAfterOnboarding(config);
  }
  return record;
}

// Kick off the Gmail profile scan. A completed record is returned untouched:
// a completed user mounts /onboarding just long enough for the gate to
// redirect home, and that mount must never spawn a scan (defense in depth
// behind the web-side idle guard). Otherwise idempotent: a scan that is still
// running (a second POST is a no-op — the first pipeline is the only one) or
// already ready is returned as-is. With no detectable Google access the scan
// lands in "no_account" without running the pipeline; idle/failed/no_account
// all (re)submit, so a retry after connecting an account just works.
//
// The deterministic pipeline (mint a Gmail token via gws auth export →
// parallel HTTP mailbox fetch → two parallel structured model calls) runs in
// the BACKGROUND: the record is flipped to "running" and returned immediately,
// and finalizeScan writes the terminal record + pushes an `onboarding` event
// when it settles.
export async function startOnboardingScan(config: RuntimeConfig): Promise<OnboardingRecord> {
  const record = getOnboarding(config);
  if (record.completed) return record;
  if (record.scan.status === "running" || record.scan.status === "ready") return record;
  const account = resolveScanAccount(config);
  if (!account) {
    record.scan = { status: "no_account" };
    writeOnboarding(config.instance, record);
    return record;
  }
  record.scan = { status: "running", startedAt: now() };
  writeOnboarding(config.instance, record);
  // Fire-and-forget: run the pipeline off the request, then finalize. Any
  // pipeline fault already resolves inside runProfileScan (never throws); the
  // extra .catch is belt-and-suspenders so an unexpected throw still finalizes.
  void runProfileScan(config, {
    configDir: account.configDir,
    onMailboxFetched: (snapshot) => primeCrmExtractionThreads(config.instance, account.id, snapshot.threads),
  })
    .catch((error): { status: "failed"; error: string } => ({
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    }))
    .then((outcome) => finalizeScan(config, outcome));
  return record;
}

// Write the terminal scan record and push an `onboarding` event so the browser
// refetches (no polling). Re-reads the record so a concurrent PATCH (theme/tz)
// isn't clobbered, and only applies when the scan is still "running" — a
// completed user or a resubmit that raced ahead wins. The event is
// system-attributed (the scan has no agent owner).
function finalizeScan(config: RuntimeConfig, outcome: { status: "ready"; profile: OnboardingProfile; suggestedTasks?: string[] } | { status: "failed"; error: string }): void {
  const record = readOnboarding(config.instance);
  if (!record || record.scan.status !== "running") return;
  const scan: OnboardingScan =
    outcome.status === "ready"
      ? { ...record.scan, status: "ready", profile: outcome.profile, ...(outcome.suggestedTasks ? { suggestedTasks: outcome.suggestedTasks } : {}), finishedAt: now() }
      : { ...record.scan, status: "failed", error: outcome.error, finishedAt: now() };
  record.scan = scan;
  writeOnboarding(config.instance, record);
  void mutateState(config.instance, (state) => {
    appendEvent(
      state,
      { kind: "onboarding", action: "onboarding.scan", target: "scan", risk: "low", summary: `Onboarding scan ${scan.status}` },
      { system: true }
    );
  });
}

// The account the scan should target: the persisted instance primary when it
// still names a registered row. Returning the whole row lets the completed
// fetch hand its normalized threads to the same account's People queue.
// Machine-global credentials alone are not enough: a fresh local instance must
// not scan whatever Gmail account happens to exist elsewhere on the machine.
function resolveScanAccount(config: RuntimeConfig): GoogleAccount | undefined {
  const accounts = readGoogleAccounts();
  if (accounts.length === 0) return undefined;
  const bindings = getGoogleAccountBindings(config.instance);
  const primary = bindings.primaryAccountId
    ? accounts.find((account) => account.id === bindings.primaryAccountId)
    : undefined;
  return primary;
}

// Account registration/provisioning happens before the first onboarding scan
// on a new instance, but after onboarding for later account additions. Keep the
// call sites simple and centralize that distinction here; getOnboarding also
// grandfathers existing instances before deciding.
export function autostartCrmForCompletedOnboarding(config: RuntimeConfig): void {
  if (!getOnboarding(config).completed) return;
  autostartCrmExtractionAfterOnboarding(config);
}

// POST /api/onboarding/routines body:
//   { timezone?, autoInbox?: { enabled, labelNewMail, archiveUnimportant,
//     assistScheduling, draftReplies }, morningBriefing?: { enabled,
//     personalizedNews }, meetingBriefing?: { enabled } }
// Idempotent replace: delete the jobs a previous pass created — plus the
// owning agent's live jobs carrying a catalog templateId, which the
// /routines gallery may have installed — then create one job per enabled
// routine via createRoutineJob, which also provisions (or carries forward)
// a dedicated conversation for templates that deliver into Messages.
export async function applyOnboardingRoutines(
  config: RuntimeConfig,
  payload: Record<string, unknown>
): Promise<{ record: OnboardingRecord; jobs: JobRecord[] }> {
  const record = getOnboarding(config);
  const timezone = payload.timezone !== undefined ? validateTimezone(payload.timezone) : (record.timezone ?? "UTC");
  const specs = routineJobSpecs(payload, timezone);
  // Every spec's skills must resolve BEFORE the previous jobs are deleted: a
  // disabled Workspace skill then surfaces as a clean 400 with zero side
  // effects, instead of createScheduledJob throwing mid-loop after the old
  // routine jobs are already gone.
  const state = readState(config.instance);
  for (const spec of specs) {
    assertSkillNamesResolve(state, spec.skillNames as string[]);
  }
  // The replace pass deletes BOTH the ids this record tracks AND any live
  // job of the owning agent stamped with a catalog templateId: the /routines
  // gallery (src/runtime/routine-templates.ts) installs the same templates
  // without updating routineJobIds, so record ids alone can go stale — the
  // templateId sweep is what keeps "at most one live job per template per
  // agent" an invariant across both writers. Owning agent resolved
  // server-side, same as createScheduledJob stamps agentId on the
  // replacements below.
  const owningAgentId = resolveEffectiveContext(state, config).agentId;
  const catalogIds = new Set(ROUTINE_TEMPLATES.map((template) => template.id));
  // Capture each replaced template's conversation BEFORE the replace pass:
  // removeJob archives a job's dedicated channel with the job, and
  // createRoutineJob un-archives + rebinds it so a re-apply keeps
  // message-delivering routines' history (same reuse rule as the gallery
  // install). Hidden-worker templates (Auto-inbox) reuse the captured
  // headless channel so their spawned child-task dedup keys stay scoped to
  // one stable parent container.
  const reusableSessions = new Map<string, string>();
  for (const job of state.jobs) {
    if (job.agentId !== owningAgentId || job.templateId === undefined || !catalogIds.has(job.templateId)) continue;
    if (reusableSessions.has(job.templateId)) continue;
    const sessionId = reusableRoutineSessionId(state, job);
    if (sessionId !== undefined) reusableSessions.set(job.templateId, sessionId);
  }
  const staleJobIds = new Set([
    ...record.routineJobIds,
    ...state.jobs
      .filter((j) => j.templateId !== undefined && catalogIds.has(j.templateId) && j.agentId === owningAgentId)
      .map((j) => j.id)
  ]);
  for (const jobId of staleJobIds) {
    try {
      await removeJob(config, jobId);
    } catch {
      // Already removed out-of-band (e.g. via DELETE /api/jobs) — ignore.
    }
  }
  // Persist the tracked ids after every creation, so a job that lands before
  // a later creation throws is never orphaned outside routineJobIds — the
  // next apply's replace pass still deletes it.
  record.routineJobIds = [];
  writeOnboarding(config.instance, record);
  const jobs: JobRecord[] = [];
  for (const spec of specs) {
    const job = await createRoutineJob(config, spec, reusableSessions.get(spec.templateId as string));
    jobs.push(job);
    record.routineJobIds.push(job.id);
    writeOnboarding(config.instance, record);
  }
  // Existing/completed users may re-apply this endpoint directly. A new user
  // is still mid-wizard here, so wait for PATCH completed:true where the recent
  // Gmail snapshot is guaranteed to be ready before People starts.
  if (record.completed) autostartCrmExtractionAfterOnboarding(config);
  return { record, jobs };
}

// Build the createScheduledJob payloads for the enabled routines by mapping
// the POST body's toggle state onto the shared routine-template catalog
// (src/runtime/routine-templates.ts) — the prompts/crons/skills are
// product-owned there (never composed in the browser). The body's flat
// booleans go through the same resolveInstallSettings path the gallery
// install uses (each template's legacySettings hook, field defaults filled,
// and for per-account templates the flat selection applied to every
// registered account), and the Auto-inbox spec is composed ONLY of the
// behaviors the user toggled on (zero behaviors ⇒ buildSpec returns
// undefined ⇒ no job).
function routineJobSpecs(payload: Record<string, unknown>, timezone: string): Record<string, unknown>[] {
  const selections: Array<{ templateId: string; section: unknown; options: string[] }> = [
    { templateId: "auto-inbox", section: payload.autoInbox, options: ["labelNewMail", "archiveUnimportant", "assistScheduling", "draftReplies"] },
    { templateId: "morning-briefing", section: payload.morningBriefing, options: ["personalizedNews"] },
    { templateId: "meeting-briefing", section: payload.meetingBriefing, options: [] }
  ];
  const specs: Record<string, unknown>[] = [];
  for (const { templateId, section, options } of selections) {
    if (!flag(section, "enabled")) continue;
    const template = routineTemplate(templateId);
    if (!template) continue;
    const legacyOptions = Object.fromEntries(options.map((key) => [key, flag(section, key)]));
    const settings = resolveInstallSettings(template, { options: legacyOptions });
    const spec = template.buildSpec(settings, timezone);
    if (spec) specs.push(spec);
  }
  return specs;
}

// Strict boolean read off an untyped sub-object: only `true` counts.
function flag(section: unknown, key: string): boolean {
  return !!section && typeof section === "object" && (section as Record<string, unknown>)[key] === true;
}

// Upper bounds folded over the scan deliverable. The deliverable is model
// text derived from attacker-controllable email, and suggestedTasks render as
// pre-checked one-click task seeds — so oversized output is clamped rather
// than rejected (bounds are generous relative to the prompt's asks).
const MAX_SUGGESTED_TASKS = 10;
const MAX_PROFILE_SECTIONS = 12;
const MAX_SECTION_BULLETS = 12;
const MAX_LINE_CHARS = 300;
const MAX_NOTE_CHARS = 1000;

// Shape-check + clamp the profile call's structured deliverable
// `{ profile: { displayName, sections[] } }`, returning the clamped profile or
// undefined on an invalid shape. Reused as the profile synthesis call's
// structured-output validator (src/runtime/onboarding-scan.ts).
export function validateScanProfile(value: unknown): OnboardingProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const profile = (value as { profile?: unknown }).profile;
  if (!isProfile(profile)) return undefined;
  return clampProfile(profile);
}

// Shape-check + clamp the tasks call's structured deliverable
// `{ suggestedTasks: [...] }`, returning the clamped list (possibly empty once
// invalid entries drop) or undefined when the field is missing/not an array.
// Reused as the tasks synthesis call's structured-output validator.
export function validateScanTasks(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rawTasks = (value as { suggestedTasks?: unknown }).suggestedTasks;
  if (!Array.isArray(rawTasks)) return undefined;
  return rawTasks
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= MAX_LINE_CHARS)
    .slice(0, MAX_SUGGESTED_TASKS);
}

// Truncate profile strings and cap section/bullet counts — keep what fits,
// drop the rest.
function clampProfile(profile: OnboardingProfile): OnboardingProfile {
  return {
    displayName: profile.displayName.slice(0, MAX_LINE_CHARS),
    sections: profile.sections.slice(0, MAX_PROFILE_SECTIONS).map((section) => ({
      title: section.title.slice(0, MAX_LINE_CHARS),
      ...(section.bullets
        ? { bullets: section.bullets.slice(0, MAX_SECTION_BULLETS).map((bullet) => bullet.slice(0, MAX_LINE_CHARS)) }
        : {}),
      ...(section.note !== undefined ? { note: section.note.slice(0, MAX_NOTE_CHARS) } : {})
    }))
  };
}

function isProfile(value: unknown): value is OnboardingProfile {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.displayName !== "string" || o.displayName.length === 0) return false;
  if (!Array.isArray(o.sections)) return false;
  return o.sections.every(isProfileSection);
}

function isProfileSection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.title !== "string" || o.title.length === 0) return false;
  if (o.bullets !== undefined && !(Array.isArray(o.bullets) && o.bullets.every((b) => typeof b === "string"))) return false;
  if (o.note !== undefined && typeof o.note !== "string") return false;
  return true;
}
