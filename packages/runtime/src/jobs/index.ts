import { submitTask } from "../agent";
import { spawnSubagent } from "../capabilities/subagents";
import type { JobDeliveryPolicy, JobRecord, JobRoute, JobRunRecord, RuntimeConfig, RuntimeState, SkillRecord } from "../types";
import { addAudit, appendEvent, appendLog, appendTrace, createChatMessage, createChatSession, createJob, createJobRun, createRun, insertChatBlock, mutateState, now, readState } from "../state";
import { isSkillActive } from "../integrations/connectors";
import { resolveEffectiveContext } from "../execution/effective-context";
import { isKnownHook, runHook, type HookConfig } from "../hooks";
import { isSilentReply } from "./silent";
import { spawn } from "bun";
import { Cron } from "croner";

export { finalizeJobRunFromTask } from "./finalize";

// Prepended to every scheduled-job prompt so the LLM produces output the
// runtime can deliver. Without this, a scheduled task run inside a chat
// session inherits the prior conversation context and the LLM tends to
// respond conversationally ("Scheduled: feed-cat will fire in 45 seconds.")
// instead of actually delivering the reminder ("Feed the cat now.").
const CRON_EXECUTION_HINT_LINES = [
  "[IMPORTANT: You are running as a scheduled job, not as part of a live conversation.",
  "DELIVERY: Your final response IS the deliverable. The runtime ships it back to the originating chat (or other configured target) automatically — do NOT try to schedule another job, do NOT acknowledge the schedule, do NOT say 'I will remind you'. Just produce the reminder/report/output the user wanted."
];

// The `[SILENT]` sentinel invitation. Injected ONLY for deliveryPolicy
// "on_findings" (watch-style jobs where "nothing new" is the common case) —
// see syncChatTaskResult for the suppression path, which honors an emitted
// sentinel under EVERY policy; only the prompt-side invitation is gated.
const CRON_SILENT_HINT_LINE =
  "SILENT: If there is genuinely nothing new to report (e.g. a watcher job with no change), respond with exactly \"[SILENT]\" and nothing else to suppress delivery. Never combine [SILENT] with content.";

function cronExecutionHint(deliveryPolicy: JobRecord["deliveryPolicy"]): string {
  const lines = [...CRON_EXECUTION_HINT_LINES];
  if ((deliveryPolicy ?? "always") === "on_findings") lines.push(CRON_SILENT_HINT_LINE);
  return `${lines.join("\n")}]\n`;
}

function withCronHint(
  jobPrompt: string,
  context: string[],
  skillBlock: string | undefined,
  deliveryPolicy: JobRecord["deliveryPolicy"]
): string {
  // The skill block (trusted, operator-registered instructions) precedes
  // the context block, which may carry untrusted fenced hook content.
  // Absent skillBlock keeps the assembled prompt byte-identical to the
  // pre-attachment behavior.
  const skillSection = skillBlock ? `${skillBlock}\n\n` : "";
  const contextBlock = context.length > 0 ? `Context:\n${context.join("\n")}\n\n` : "";
  return `${cronExecutionHint(deliveryPolicy)}\n${skillSection}${contextBlock}${jobPrompt}`;
}

function assertPositiveInt(label: string, value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid input: ${label} must be a positive integer (got ${String(value)})`);
  }
  return num;
}

function assertNonNegativeInt(label: string, value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid input: ${label} must be a non-negative integer (got ${String(value)})`);
  }
  return num;
}

// Hard cap on how many skills a single job may attach. Each attached
// skill's FULL body is inlined into every fire's prompt, so the cap bounds
// per-fire prompt growth at the source. See ADR job-skill-attachments.md.
const MAX_JOB_SKILL_NAMES = 8;

// Total-character budget for inlined skill bodies per fire. A skill that
// overflows the budget is truncated with an in-prompt note pointing the
// model at read_skill, and the truncation is traced — see
// resolveJobSkillAttachments.
const MAX_INLINED_SKILL_CHARS = 32_000;

// Shape validation for the skillNames field, shared by create and update.
// Duplicate names are dropped (first occurrence wins) before the cap is
// enforced, so a repeated name can never inline a body twice or burn a cap
// slot. Registry resolution happens separately inside the mutateState
// callback (assertSkillNamesResolve) so it serializes with skill
// enable/disable writes.
function parseSkillNamesInput(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid input: skillNames must be an array of strings (got ${typeof value})`);
  }
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("Invalid input: skillNames entries must be non-empty strings");
    }
    if (!cleaned.includes(entry)) cleaned.push(entry);
  }
  if (cleaned.length > MAX_JOB_SKILL_NAMES) {
    throw new Error(`Invalid input: skillNames may list at most ${MAX_JOB_SKILL_NAMES} skills (got ${cleaned.length})`);
  }
  return cleaned;
}

// Resolve a job-attached skill name with the same semantics as the
// read_skill tool (src/execution/tool-dispatch.ts): exact name match,
// enabled bundled preferred over enabled user. Returns undefined when no
// ENABLED record matches — the caller decides whether that's a create-time
// `Invalid input` or a fire-time skip.
function resolveEnabledSkill(state: RuntimeState, name: string): SkillRecord | undefined {
  const matches = state.skills.filter((s) => s.name === name && s.status === "enabled");
  return matches.find((s) => (s.source ?? "user") === "bundled") ?? matches[0];
}

// Validate a skillNames list against the registry, naming the first bad
// entry in a typed `Invalid input: …` so the caller (agent or HTTP client)
// can correct it. createScheduledJob and updateJob both route here — the
// single choke point for CLI, HTTP, and the agent's create_job/update_job
// tools, which all delegate to those two functions. Also exported so the
// onboarding routines endpoint can pre-validate every spec before deleting
// the jobs it is replacing.
export function assertSkillNamesResolve(state: RuntimeState, skillNames: string[]): void {
  for (const name of skillNames) {
    if (!resolveEnabledSkill(state, name)) {
      throw new Error(`Invalid input: skillNames entry "${name}" does not match any enabled skill`);
    }
  }
}

export interface CreateScheduledJobOptions {
  // Trusted attribution override. Only internal callers (the in-task
  // `create_job` tool, `applyImprovement`) thread the originating agent
  // here so the new job inherits from the record that requested it rather
  // than whichever agent happens to be active at this exact tick. The HTTP
  // path never sets this — public clients must not be able to spoof
  // `agentId` through the request body.
  originatingAgentId?: string;
  // Strict chat-session binding for the in-task `create_job` tool. The
  // dispatcher resolves the originating conversation from a lock-free
  // `readState`, so the session can be deleted between that check and the
  // write below; setting this makes the `mutateState` callback re-verify
  // the supplied `chatSessionId` still exists (same serialization
  // rationale as the parent-task terminal re-check). The HTTP path never
  // sets it — `POST /api/jobs` stays permissive about caller-supplied
  // session ids.
  requireChatSession?: boolean;
}

export async function createScheduledJob(
  config: RuntimeConfig,
  input: Record<string, unknown>,
  options: CreateScheduledJobOptions = {}
) {
  // Strip any `agentId` the caller pasted into the public input bag. Trust
  // only the typed `options.originatingAgentId` and the runtime's active
  // agent fallback below.
  if ("agentId" in input) {
    delete (input as Record<string, unknown>).agentId;
  }
  // Cron-vs-interval mutual exclusion. A job is driven by EITHER a 5-field
  // Unix cron expression (wall-clock + per-job IANA timezone) OR an
  // interval-from-now (`intervalSeconds`). Reject payloads that explicitly
  // set both — the caller is ambiguous and silently picking one would
  // surprise the user. `intervalSeconds === undefined` (the absent case)
  // is the "not set" sentinel even though JSON.stringify(NaN) === "null"
  // — `null` flows into assertPositiveInt below and gets rejected.
  let cronExpression: string | undefined;
  let cronTimezone: string | undefined;
  if (input.cronExpression !== undefined && input.cronExpression !== null) {
    if (typeof input.cronExpression !== "string" || input.cronExpression.trim().length === 0) {
      throw new Error(`Invalid input: cronExpression must be a non-empty string (got ${String(input.cronExpression)})`);
    }
    cronExpression = input.cronExpression.trim();
    if (input.intervalSeconds !== undefined) {
      throw new Error("Invalid input: cronExpression and intervalSeconds are mutually exclusive");
    }
  }
  if (input.cronTimezone !== undefined && input.cronTimezone !== null) {
    if (typeof input.cronTimezone !== "string" || input.cronTimezone.length === 0) {
      throw new Error(`Invalid input: cronTimezone must be a non-empty string (got ${String(input.cronTimezone)})`);
    }
    cronTimezone = input.cronTimezone;
  }
  // If a cron timezone is supplied without a cronExpression, that's a
  // payload mistake — the timezone is meaningless on an interval job.
  if (cronTimezone !== undefined && cronExpression === undefined) {
    throw new Error("Invalid input: cronTimezone may only be set when cronExpression is set");
  }

  // Validate the cron expression + timezone by constructing a Cron
  // instance. Croner throws synchronously on either an unparseable
  // pattern or an unknown IANA TZ — re-throw as `Invalid input: …` so
  // the HTTP layer surfaces a typed 400. Default timezone is "UTC".
  let initialCronNextRunMs: number | undefined;
  if (cronExpression !== undefined) {
    const tz = cronTimezone ?? "UTC";
    // Croner validates the cron expression eagerly in the constructor
    // but defers IANA timezone validation until the first nextRun() call
    // (the timezone is only consulted when converting a Date). Wrap both
    // calls so we surface a typed `Invalid input: …` regardless of which
    // input was bad. Pattern errors look like `CronPattern: …`; timezone
    // errors mention `timezone` in the message.
    let cron: Cron;
    try {
      cron = new Cron(cronExpression, { timezone: tz });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timezone/i.test(message)) {
        throw new Error(`Invalid input: cronTimezone "${tz}" is not a valid IANA timezone (${message})`);
      }
      throw new Error(`Invalid input: cronExpression is not a valid 5-field Unix cron (${message})`);
    }
    let next: Date | null;
    try {
      next = cron.nextRun();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timezone/i.test(message)) {
        throw new Error(`Invalid input: cronTimezone "${tz}" is not a valid IANA timezone (${message})`);
      }
      throw new Error(`Invalid input: cronExpression is not a valid 5-field Unix cron (${message})`);
    }
    if (!next) {
      // Cron returned null — e.g. a pattern that can never fire. Treat as
      // input error so the agent rewrites the expression.
      throw new Error(`Invalid input: cronExpression "${cronExpression}" has no future runs`);
    }
    initialCronNextRunMs = next.getTime();
  }

  // Only fall back to defaults when the field is truly absent. An explicit
  // NaN-from-JSON arrives as `null`, and `null ?? 60` would silently
  // promote a bogus payload to a happy path — instead, validate it.
  // When cronExpression is set, the JobRecord stores no intervalSeconds
  // at all (the field is optional on the type). Interval-driven jobs
  // default to 60s when the field is absent.
  const intervalSeconds: number | undefined = cronExpression !== undefined
    ? undefined
    : input.intervalSeconds === undefined
      ? 60
      : assertPositiveInt("intervalSeconds", input.intervalSeconds);
  const timeoutSeconds = input.timeoutSeconds === undefined
    ? 600
    : assertPositiveInt("timeoutSeconds", input.timeoutSeconds);
  const retryLimit = input.retryLimit === undefined
    ? 0
    : assertNonNegativeInt("retryLimit", input.retryLimit);
  // Optional session linkage + one-shot semantics. We validate types
  // up-front so a bogus payload returns a typed `Invalid input: …` (which
  // the HTTP layer turns into 400) instead of silently coercing.
  let chatSessionId: string | undefined;
  if (input.chatSessionId !== undefined && input.chatSessionId !== null) {
    if (typeof input.chatSessionId !== "string" || input.chatSessionId.length === 0) {
      throw new Error(`Invalid input: chatSessionId must be a non-empty string (got ${String(input.chatSessionId)})`);
    }
    chatSessionId = input.chatSessionId;
  }
  // Dedicated-session option. When the agent's `create_job` tool fires (we
  // detect that in the dispatcher and forward this flag), the new job
  // should publish its future fires into a FRESH chat thread instead of
  // burying the originating conversation under 365 daily reports. The
  // session row is created inside the same `mutateState` write as the
  // JobRecord below so a validation failure leaves no orphan thread. The
  // resolved session id overwrites any caller-supplied `chatSessionId`.
  let createDedicatedSessionTitle: string | undefined;
  if (input.createDedicatedSession !== undefined && input.createDedicatedSession !== null) {
    if (typeof input.createDedicatedSession !== "object" || Array.isArray(input.createDedicatedSession)) {
      throw new Error(`Invalid input: createDedicatedSession must be an object`);
    }
    const opt = input.createDedicatedSession as { title?: unknown };
    if (typeof opt.title !== "string" || opt.title.length === 0) {
      throw new Error(`Invalid input: createDedicatedSession.title must be a non-empty string`);
    }
    createDedicatedSessionTitle = opt.title;
  }
  let oneShot: boolean | undefined;
  if (input.oneShot !== undefined && input.oneShot !== null) {
    if (typeof input.oneShot !== "boolean") {
      throw new Error(`Invalid input: oneShot must be a boolean (got ${String(input.oneShot)})`);
    }
    oneShot = input.oneShot;
  }
  // Terminal-run delivery fan-out policy (see JobDeliveryPolicy in types.ts).
  // Absent defaults to "always" — the pre-policy behavior, [SILENT] sentinel
  // included. "silent" is rejected on one-shot reminders: a reminder that
  // delivers nothing is a no-op the user would read as a dropped ball.
  let deliveryPolicy: JobDeliveryPolicy | undefined;
  if (input.deliveryPolicy !== undefined && input.deliveryPolicy !== null) {
    if (input.deliveryPolicy !== "always" && input.deliveryPolicy !== "on_findings" && input.deliveryPolicy !== "silent") {
      throw new Error(`Invalid input: deliveryPolicy must be one of "always" | "on_findings" | "silent" (got ${String(input.deliveryPolicy)})`);
    }
    deliveryPolicy = input.deliveryPolicy;
  }
  if (deliveryPolicy === "silent" && oneShot === true) {
    throw new Error(`Invalid input: deliveryPolicy "silent" is not allowed on one-shot reminder jobs`);
  }
  // Forward-to-Chat flag (ADR chat-topics-tasks-subagents.md). When true, each
  // fire forwards its final answer into the owning agent's Chat (in addition to
  // materializing it in the job's dedicated Topic). The tool dispatcher sets
  // this from `deliverTo:"chat"`; the job still runs in its own Topic either
  // way. Absent ⇒ channel-only delivery.
  let forwardToChat: boolean | undefined;
  if (input.forwardToChat !== undefined && input.forwardToChat !== null) {
    if (typeof input.forwardToChat !== "boolean") {
      throw new Error(`Invalid input: forwardToChat must be a boolean (got ${String(input.forwardToChat)})`);
    }
    forwardToChat = input.forwardToChat;
  }
  // Pre-LLM hook. Validate shape up-front so a bad payload returns a typed
  // `Invalid input: …` (400 at the HTTP layer) instead of persisting a job
  // whose hook can never resolve. The handlerId MUST be a key in the trusted
  // registry — a model/user can't smuggle in an arbitrary handler.
  let preRunHook: HookConfig | undefined;
  if (input.preRunHook !== undefined && input.preRunHook !== null) {
    if (typeof input.preRunHook !== "object" || Array.isArray(input.preRunHook)) {
      throw new Error(`Invalid input: preRunHook must be an object`);
    }
    const hook = input.preRunHook as { handlerId?: unknown; config?: unknown; timeoutMs?: unknown };
    if (typeof hook.handlerId !== "string" || hook.handlerId.length === 0) {
      throw new Error(`Invalid input: preRunHook.handlerId must be a non-empty string`);
    }
    if (!isKnownHook(hook.handlerId)) {
      throw new Error(`Invalid input: preRunHook.handlerId "${hook.handlerId}" is not a known hook handler`);
    }
    if (hook.config === undefined || hook.config === null || typeof hook.config !== "object" || Array.isArray(hook.config)) {
      throw new Error(`Invalid input: preRunHook.config must be an object`);
    }
    let timeoutMs: number | undefined;
    if (hook.timeoutMs !== undefined && hook.timeoutMs !== null) {
      timeoutMs = assertPositiveInt("preRunHook.timeoutMs", hook.timeoutMs);
    }
    preRunHook = {
      handlerId: hook.handlerId,
      config: hook.config as Record<string, unknown>,
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    };
  }
  // Per-job auto-approve envelope. All fields are optional; reject malformed
  // payloads up-front so a typo doesn't silently fall back to legacy behavior.
  // See ADR approval-mode.md ("Per-job scope") for the approval model.
  let dangerouslyAutoApprove: boolean | undefined;
  if (input.dangerouslyAutoApprove !== undefined && input.dangerouslyAutoApprove !== null) {
    if (typeof input.dangerouslyAutoApprove !== "boolean") {
      throw new Error(`Invalid input: dangerouslyAutoApprove must be a boolean (got ${String(input.dangerouslyAutoApprove)})`);
    }
    dangerouslyAutoApprove = input.dangerouslyAutoApprove;
  }
  let approvalMode: "strict" | "auto" | "yolo" | undefined;
  if (input.approvalMode !== undefined && input.approvalMode !== null) {
    if (input.approvalMode !== "strict" && input.approvalMode !== "auto" && input.approvalMode !== "yolo") {
      throw new Error(`Invalid input: approvalMode must be one of "strict" | "auto" | "yolo" (got ${String(input.approvalMode)})`);
    }
    approvalMode = input.approvalMode;
  }
  let autoApproveCommands: string[] | undefined;
  if (input.autoApproveCommands !== undefined && input.autoApproveCommands !== null) {
    if (!Array.isArray(input.autoApproveCommands)) {
      throw new Error(`Invalid input: autoApproveCommands must be an array of strings (got ${typeof input.autoApproveCommands})`);
    }
    const cleaned: string[] = [];
    for (const entry of input.autoApproveCommands) {
      if (typeof entry !== "string") {
        throw new Error(`Invalid input: autoApproveCommands entries must be strings (got ${typeof entry})`);
      }
      if (entry.length === 0) {
        throw new Error(`Invalid input: autoApproveCommands entries must be non-empty strings`);
      }
      cleaned.push(entry);
    }
    autoApproveCommands = cleaned;
  }
  let dangerousTerminalPatterns: string[] | undefined;
  if (input.dangerousTerminalPatterns !== undefined && input.dangerousTerminalPatterns !== null) {
    if (!Array.isArray(input.dangerousTerminalPatterns)) {
      throw new Error(`Invalid input: dangerousTerminalPatterns must be an array of strings (got ${typeof input.dangerousTerminalPatterns})`);
    }
    const cleaned: string[] = [];
    for (const entry of input.dangerousTerminalPatterns) {
      if (typeof entry !== "string") {
        throw new Error(`Invalid input: dangerousTerminalPatterns entries must be strings (got ${typeof entry})`);
      }
      // Trim before persisting so a padded entry like " docker run "
      // is stored as "docker run". The matcher uses substring
      // semantics, so a padded entry would never match a real command
      // — silently disabling the rule the operator thought they
      // added.
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        throw new Error(`Invalid input: dangerousTerminalPatterns entries must be non-empty strings`);
      }
      cleaned.push(trimmed);
    }
    dangerousTerminalPatterns = cleaned;
  }
  // Skill attachments. Shape-validate up-front; the names resolve against
  // the registry inside the mutateState callback below so validation
  // serializes with concurrent skill enable/disable writes. An empty array
  // normalizes to "no attachments" (field absent on the record).
  let skillNames: string[] | undefined;
  if (input.skillNames !== undefined && input.skillNames !== null) {
    const parsed = parseSkillNamesInput(input.skillNames);
    if (parsed.length > 0) skillNames = parsed;
  }
  // Routine-template provenance (see ADR routine-templates-gallery.md). The
  // gallery install and onboarding routine paths stamp the catalog id so
  // installed state and per-template replace/remove can key on it.
  let templateId: string | undefined;
  if (input.templateId !== undefined && input.templateId !== null) {
    if (typeof input.templateId !== "string" || input.templateId.length === 0) {
      throw new Error(`Invalid input: templateId must be a non-empty string (got ${String(input.templateId)})`);
    }
    templateId = input.templateId;
  }
  // Resolved routine-template options (JobRecord.templateOptions): the
  // option state buildSpec composed the spec from, stamped next to
  // templateId so the gallery's Settings view can render the installed
  // selection.
  let templateOptions: Record<string, boolean> | undefined;
  if (input.templateOptions !== undefined && input.templateOptions !== null) {
    if (typeof input.templateOptions !== "object" || Array.isArray(input.templateOptions)) {
      throw new Error("Invalid input: templateOptions must be an object of booleans");
    }
    for (const [key, value] of Object.entries(input.templateOptions as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        throw new Error(`Invalid input: templateOptions.${key} must be a boolean (got ${String(value)})`);
      }
    }
    templateOptions = { ...(input.templateOptions as Record<string, boolean>) };
  }
  // Resolved routine-template settings (JobRecord.templateSettings): the
  // settings state buildSpec composed the spec from, stamped next to
  // templateId so the gallery's Settings view can render the installed
  // configuration. Values are template-owned shapes (booleans, strings,
  // label-rule lists) validated per-field by resolveSettings upstream; here
  // only the container shape is checked.
  let templateSettings: Record<string, unknown> | undefined;
  if (input.templateSettings !== undefined && input.templateSettings !== null) {
    if (typeof input.templateSettings !== "object" || Array.isArray(input.templateSettings)) {
      throw new Error("Invalid input: templateSettings must be a plain object");
    }
    templateSettings = { ...(input.templateSettings as Record<string, unknown>) };
  }
  // A parent task that has already transitioned terminal must not
  // create a durable scheduled job. Without this, a `cancelTask`
  // queued between the dispatcher's lock-free pre-check and our
  // `mutateState` below would win the lock, mark the task
  // cancelled, and still leave a fresh recurring job behind. By
  // doing the terminal check INSIDE the `mutateState` callback the
  // per-instance lock serializes "is the task cancelled?" and
  // "create the job" so neither can interleave.
  const parentTaskId =
    typeof input.parentTaskId === "string" ? input.parentTaskId : undefined;
  return mutateState(config.instance, (state) => {
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      // Refuse on `cancelled` (operator cancel) AND `failed`
      // (sibling denial / runtime failure mid-turn). `completed` is
      // permitted because a legitimate parent's final action can
      // be "schedule a recurring follow-up job."
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot create scheduled job: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    // Re-resolve the caller-supplied chat session INSIDE the lock. The
    // dispatcher's originating-session id came from a lock-free
    // `readState`; without this, a session deleted between that check and
    // this write would persist a job bound to a dead conversation.
    if (options.requireChatSession && chatSessionId !== undefined) {
      if (!state.chatSessions.some((candidate) => candidate.id === chatSessionId)) {
        throw new Error(`Cannot create scheduled job: chat session ${chatSessionId} no longer exists.`);
      }
    }
    // Skill attachments resolve against the registry here, inside the
    // per-instance lock, so a concurrent disable can't slip a stale name
    // past validation.
    if (skillNames !== undefined) assertSkillNamesResolve(state, skillNames);
    // Dedicated-session creation. Done INSIDE the mutateState callback so
    // it shares the same write as `createJob`: a validation failure (e.g.
    // a bad parent task state) leaves no orphan chat row. The new
    // session's id replaces any caller-supplied chatSessionId so the job's
    // future fires post into the fresh thread.
    const effective = resolveEffectiveContext(state, config);
    // Callers driven by a record stamped at an earlier moment (e.g. a
    // running task's `create_job` tool) thread the originating agent
    // through the trusted `options.originatingAgentId` parameter so the
    // new job belongs to the originating agent rather than whichever
    // agent is active at this exact tick. The HTTP path never sets it —
    // see the input-sanitization guard at the top of the function for
    // why we can't read `agentId` off the caller-supplied payload.
    const owningAgentId = options.originatingAgentId ?? effective.agentId;
    //
    // If the parent task came from a messaging-sourced chat session
    // (Discord, Telegram), copy the source descriptor onto the new
    // dedicated session AS `outboundMirror` (not `source`) so
    // finalizeJobRunFromTask can still dispatch the scheduled-fire
    // reply back to the originating chat. Storing the descriptor as
    // `source` would make findOrCreate{Discord,Telegram}ChatSession
    // match the dedicated session for inbound on the same channel —
    // the very next user message could land in the job thread
    // instead of the live channel thread. `outboundMirror` is
    // outbound-only by contract and the findOrCreate helpers
    // explicitly ignore it.
    let resolvedChatSessionId = chatSessionId;
    if (createDedicatedSessionTitle !== undefined) {
      // Recurring-job-derived sessions are channels in the new chats IA;
      // they always carry origin: "job" as well.
      const session = createChatSession(state, createDedicatedSessionTitle, undefined, owningAgentId, "job", "channel");
      // A silent (watch-shaped) job's working thread never surfaces in
      // chrome: mint it headless so it stays out of session lists and
      // router candidates while remaining addressable by id.
      if (deliveryPolicy === "silent") session.headless = true;
      if (parentTaskId) {
        const parentSession = state.chatSessions.find((candidate) =>
          candidate.id !== session.id && candidate.taskIds.includes(parentTaskId)
        );
        if (parentSession?.source) {
          // Clone so a later mutation on the parent session's source
          // doesn't aliased-mutate the dedicated session's copy.
          session.outboundMirror = { ...parentSession.source };
        }
      }
      resolvedChatSessionId = session.id;
    }
    // Initial nextRunAt: cron-driven jobs anchor to the next cron-matched
    // wall-clock moment (resolved above via Cron.nextRun()), interval-driven
    // jobs anchor `intervalSeconds` from now. By construction
    // intervalSeconds is a positive number on the non-cron branch (the
    // ternary above assigned `60` or the validated input value), and
    // undefined when cronExpression is set — we only read it in the
    // interval branch so the `!` assertion is sound.
    const initialNextRunAtMs = cronExpression !== undefined
      ? (initialCronNextRunMs as number)
      : Date.now() + intervalSeconds! * 1000;
    return createJob(state, {
      name: String(input.name ?? "Untitled job"),
      prompt: String(input.prompt ?? ""),
      script: typeof input.script === "string" && input.script.trim() ? input.script : undefined,
      intervalSeconds,
      cronExpression,
      cronTimezone: cronExpression !== undefined ? (cronTimezone ?? "UTC") : undefined,
      nextRunAt: new Date(initialNextRunAtMs).toISOString(),
      deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : [],
      context: Array.isArray(input.context) ? input.context.map(String) : [],
      skillNames,
      templateId,
      templateOptions,
      templateSettings,
      retryLimit,
      timeoutSeconds,
      costBudget: typeof input.costBudget === "number" ? input.costBudget : undefined,
      chatSessionId: resolvedChatSessionId,
      oneShot,
      deliveryPolicy: deliveryPolicy ?? "always",
      forwardToChat,
      preRunHook,
      dangerouslyAutoApprove,
      approvalMode,
      autoApproveCommands,
      dangerousTerminalPatterns,
      agentId: owningAgentId
    });
  });
}

// Returns the most recent running run for the given jobId, or undefined.
function findRunningRun(state: RuntimeState, jobId: string): JobRunRecord | undefined {
  return state.jobRuns.find((run) => run.jobId === jobId && run.status === "running");
}

// Drift-free advance: starting from the previous nextRunAt, advance forward
// by intervalSeconds until the next scheduled time is in the future. The
// first advance consumes the run we just claimed; each subsequent advance is
// a missed run we're skipping. Returns the new nextRunAt and the number of
// extra missed runs (>= 0).
function advanceNextRunAt(prevNextRunAtMs: number, intervalSeconds: number, nowMs: number): { nextRunAtMs: number; missed: number } {
  const stepMs = intervalSeconds * 1000;
  let next = prevNextRunAtMs + stepMs;
  let missed = 0;
  while (next <= nowMs) {
    next += stepMs;
    missed += 1;
  }
  return { nextRunAtMs: next, missed };
}

// Cron-driven equivalent of advanceNextRunAt. Returns the next cron-matched
// moment strictly after the run we just claimed, walking past any matches
// that have already drifted into the past (e.g. the runtime was offline).
// Delegates the "what's the next match?" math to croner so DST transitions,
// leap years, and month-end edge cases are handled natively. Returns the
// new nextRunAt (ms) and the count of EXTRA missed cron fires (>= 0).
export function advanceCronNextRunAt(
  cronExpression: string,
  cronTimezone: string,
  prevNextRunAtMs: number,
  nowMs: number
): { nextRunAtMs: number; missed: number } {
  const cron = new Cron(cronExpression, { timezone: cronTimezone });
  // `cron.nextRun(prev)` returns the first cron-matched moment strictly
  // after `prev`, so it already IS the next scheduled fire — no extra
  // "consume" step needed. The loop then walks subsequent matches and
  // counts each that's still in the past as a missed fire.
  let next = cron.nextRun(new Date(prevNextRunAtMs));
  if (!next) {
    // Defensive: a pathological pattern that returns null. We treat it
    // as a fallback to "stay where we are" so the scheduler doesn't
    // crash. createScheduledJob's validation already rejected unfire-able
    // patterns at submit time, so reaching this branch implies clock
    // skew or a truly degenerate edge.
    return { nextRunAtMs: prevNextRunAtMs, missed: 0 };
  }
  let missed = 0;
  while (next.getTime() <= nowMs) {
    const after = cron.nextRun(next);
    if (!after) break;
    next = after;
    missed += 1;
  }
  return { nextRunAtMs: next.getTime(), missed };
}

// Runs the job's preRun hook (if any) and returns what the dispatch loop should
// do next. No hook => { action: "proceed", context: [] }, byte-identical to the
// pre-hook behavior. This is a thin adapter over the generic hooks primitive:
// the runner (src/hooks) resolves the trusted handler, enforces the per-hook
// timeout, validates + renders the typed result, and reports a neutral
// `transient` flag. This adapter applies the JOBS-side fatality policy:
//   - TRANSIENT error (timeout / handler throw): fatal:false — the run fails but
//     the scheduled job stays active so it self-recovers on its next tick.
//     Deactivating a watcher on a transient stall would silently kill it.
//   - NON-transient error (unknown handlerId, a handler-returned { kind:"error" }
//     — the skill-script handler uses this for a missing/unknown skill|script or
//     malformed script output — or a malformed result): fatal:true — a draft is
//     meaningless and retrying won't fix it, so the scheduled job is deactivated.
// The runner decided transience; jobs decides what that means for a SCHEDULE.
async function runPreRunHook(
  config: RuntimeConfig,
  job: JobRecord,
  _run: JobRunRecord
): Promise<
  | {
      action: "proceed";
      context: string[];
      buckets?: Record<string, string[]>;
      onDispatched?: () => void | Promise<void>;
      state?: Record<string, unknown>;
    }
  | { action: "shortCircuit"; summary?: string; state?: Record<string, unknown> }
  | { action: "error"; message: string; fatal: boolean }
> {
  const hook = job.preRunHook;
  if (!hook) return { action: "proceed", context: [] };

  // The JOB owns the hook's state: thread the current blob in as the run's input
  // (the runner merges `payload` into the handler's hookConfig, so a pure handler
  // reads hookConfig.state) and carry the handler's newState back out. The
  // persistence TIMING below preserves at-least-once across the delivery boundary.
  const outcome = await runHook(config, hook, { state: job.hookState });
  if (outcome.kind === "shortCircuit") {
    return {
      action: "shortCircuit",
      summary: outcome.summary,
      ...(outcome.state !== undefined ? { state: outcome.state } : {})
    };
  }
  if (outcome.kind === "context") {
    return {
      action: "proceed",
      context: outcome.context,
      // Surface routed buckets when the handler returned them; the scheduler
      // fans out one worker per non-empty bucket. Absent ⇒ the legacy flat path.
      ...(outcome.buckets ? { buckets: outcome.buckets } : {}),
      ...(outcome.onDispatched ? { onDispatched: outcome.onDispatched } : {}),
      ...(outcome.state !== undefined ? { state: outcome.state } : {})
    };
  }
  return { action: "error", message: outcome.message, fatal: !outcome.transient };
}

// Persist a pure handler's new state onto the backing job inside the per-instance
// lock. Used at the at-least-once commit boundary: immediately for a shortCircuit
// (nothing was delivered), and only after the drafting turn dispatches for a
// context result (so a dispatch failure leaves the OLD state and the matches
// re-detect next tick). No state = no-op.
async function persistHookState(
  config: RuntimeConfig,
  jobId: string,
  state: Record<string, unknown> | undefined
): Promise<void> {
  if (state === undefined) return;
  await mutateState(config.instance, (s) => {
    const job = s.jobs.find((candidate) => candidate.id === jobId);
    if (job) job.hookState = state;
  });
}

// Post a hook's short-circuit summary into the job's chat session as a
// runtime-authored assistant message — NO model turn, no spawned task. This is
// the generic "a hook can notify without a model turn" capability: a hook that
// short-circuits (skipping the drafting turn) can still deliver a one-off notice
// (e.g. the gmail-watch backlog notice). It mirrors the assistant-message
// materialization syncChatTaskResult uses (a legacy ChatMessageRecord via
// createChatMessage) AND emits the assistant_text chat block so the same
// SSE/APNs notify path the chat UI listens on fires. The caller has already
// filtered out the empty/"[SILENT]" case, so this always has real content to
// deliver.
async function deliverHookSummary(
  config: RuntimeConfig,
  sessionId: string,
  summary: string
): Promise<void> {
  const message = await mutateState(config.instance, (state) => {
    // A session deleted between the claim and here drops the delivery — match
    // syncChatTaskResult's "missing session" handling (skip, don't orphan).
    if (!state.chatSessions.some((s) => s.id === sessionId)) return undefined;
    return createChatMessage(state, { sessionId, role: "assistant", content: summary });
  });
  if (!message) return;
  // Dual-publish the assistant_text ChatBlock so the per-session SSE stream (and
  // the block-protocol web/mobile UI) sees the message. Best-effort: a SQLite
  // failure here must not roll back the legacy ChatMessageRecord above (mirrors
  // submitChatMessage's user_text dual-publish tolerance).
  try {
    const block = insertChatBlock(config.instance, {
      kind: "assistant_text",
      sessionId,
      text: summary,
      streaming: false
    });
    if (block.kind === "assistant_text") {
      // The APNs dispatcher fires its completion alert on a terminal `phase`
      // block, so emit one so a backgrounded device is woken for the notice.
      insertChatBlock(config.instance, { kind: "phase", sessionId, label: "Completed" });
    }
  } catch (error) {
    appendLog(config.instance, "job.hook.notify.error", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Finalize a short-circuited run with NO model turn. The run never spawned a
// task (no taskId), so we finalize it INLINE by run.id rather than routing a
// synthetic Task through finalizeJobRunFromTask — that path's chat sync calls
// syncChatTaskResult, which throws "Task not found" for a task that was never in
// state.tasks (the dominant idle 60s email path), leaving the [SILENT]
// suppression dead and spamming job.chat.sync.error every tick. Binding by
// run.id is exact (no order-dependent "most-recent running run" heuristic, which
// mis-binds under concurrent manual/replay runs). We replicate the parts of the
// completed-run finalize that apply with no task: completed status, job
// lastSuccessAt + cleared lastError, oneShot auto-pause + its audit, and the
// job.run.completed event.
//
// Delivery: a silent/empty summary delivers nothing and emits the
// chat.message.suppressed_silent audit explicitly (preserving the suppression
// audit the dead path used to produce only by a swallowed throw). A genuinely
// NON-silent summary IS delivered — posted directly into the job's chat session
// as a runtime-authored assistant message via deliverHookSummary (no model turn,
// no spawned task), which is how a short-circuiting hook surfaces a one-off
// notice (the gmail-watch backlog notice).
//
// A cancelTask that landed between the claim and here already flipped the run
// terminal, so the `status === "running"` guard makes this a no-op (no double
// finalize).
async function finalizeShortCircuit(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  summary?: string
): Promise<void> {
  // Empty / "[SILENT]" suppresses chat + bridge delivery — a "nothing new" tick
  // delivers nothing. A trailing-line sentinel after a no-op preamble also
  // suppresses, mirroring the chat-side suppression contract
  // (src/execution/chat.ts) and the cron-hint instruction (see src/jobs/silent.ts).
  const effectiveSummary = summary ?? "[SILENT]";
  const trimmed = effectiveSummary.trim();
  const isSilent = trimmed.length === 0 || isSilentReply(effectiveSummary);

  const outcome = await mutateState(config.instance, (state) => {
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    const jobItem = state.jobs.find((candidate) => candidate.id === job.id);
    if (!runItem) return undefined;
    if (runItem.status !== "running") return undefined;
    const completedAt = now();
    runItem.status = "completed";
    runItem.summary = effectiveSummary;
    runItem.error = undefined;
    runItem.completedAt = completedAt;
    runItem.updatedAt = completedAt;
    if (jobItem) {
      jobItem.lastSuccessAt = completedAt;
      jobItem.lastError = undefined;
      // One-shot reminders auto-pause after the FIRST terminal run, matching
      // finalizeJobRunFromTask's oneShot handling.
      if (jobItem.oneShot === true && jobItem.status === "active") {
        jobItem.status = "paused";
        jobItem.updatedAt = completedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "job.oneshot.completed",
            target: jobItem.id,
            risk: "low",
            evidence: { runId: run.id, runStatus: runItem.status }
          },
          { jobId: jobItem.id, agentId: jobItem.agentId }
        );
      }
    }
    // The silent/empty short-circuit delivers nothing — record the suppression
    // audit explicitly so the audit trail still shows the run produced no chat
    // message (the chat-side suppression path never runs because no task synced).
    if (isSilent && job.chatSessionId) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "chat.message.suppressed_silent",
          target: job.chatSessionId,
          risk: "low",
          evidence: { runId: run.id }
        },
        { jobId: job.id, agentId: job.agentId }
      );
    }
    appendEvent(
      state,
      {
        kind: "job",
        action: "job.run.completed",
        target: job.id,
        jobId: job.id,
        risk: "low",
        summary: "Pre-run hook short-circuited the run.",
        data: { runId: run.id, shortCircuit: true }
      },
      { jobId: job.id, agentId: job.agentId }
    );
    return { taskId: runItem.taskId };
  });

  // Deliver a genuinely non-silent summary as a runtime-authored assistant
  // message (no model turn) so a short-circuiting hook can still surface a
  // one-off notice. Only runs when the run actually finalized here (outcome
  // defined) and the job is bound to a chat session.
  if (outcome && !isSilent && job.chatSessionId) {
    await deliverHookSummary(config, job.chatSessionId, trimmed);
  }
}

// Finalize a run that the hook failed. No model turn, no draft. Mirrors
// dispatchPromptRun's catch shape: guard run.status === "running" (cancel race),
// stamp the run failed, stamp lastFailureAt + lastError on the job.
//
// `fatal` decides whether a scheduled job is DEACTIVATED. A CONFIG error
// (fatal: unknown handler, missing watcher, malformed result) flips
// job.status="failed" so a job that can never succeed stops claiming the
// scheduler. A TRANSIENT error (non-fatal: timeout or handler throw) leaves
// job.status="active" so the job self-recovers on its next tick — flipping it to
// "failed" on a transient stall would silently kill a watcher (and the orphaned
// handler promise could later write a healthy-looking status, masking the death).
async function finalizeHookError(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  message: string,
  trigger: "schedule" | "manual" | "replay",
  fatal: boolean
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    const jobItem = state.jobs.find((candidate) => candidate.id === job.id);
    if (!runItem) return;
    if (runItem.status !== "running") return;
    runItem.status = "failed";
    runItem.error = message;
    runItem.completedAt = now();
    runItem.updatedAt = runItem.completedAt;
    if (jobItem) {
      jobItem.lastFailureAt = runItem.completedAt;
      jobItem.lastError = message;
      if (fatal && trigger === "schedule") jobItem.status = "failed";
    }
    appendEvent(
      state,
      {
        kind: "job",
        action: "job.run.failed",
        target: job.id,
        jobId: job.id,
        risk: "low",
        summary: "Pre-run hook failed.",
        data: { runId: run.id, error: message }
      },
      { jobId: job.id, agentId: job.agentId }
    );
  });
}

export async function runDueJobs(config: RuntimeConfig): Promise<void> {
  // Atomic claim: select due jobs, skip ones that already have a running
  // run (overlap protection), advance nextRunAt drift-free, and create the
  // JobRunRecord — all inside one mutateState write so a slow tick can't
  // race itself.
  const claimed = await mutateState(config.instance, (state) => {
    const dateNow = Date.now();
    const out: Array<{ job: JobRecord; run: JobRunRecord }> = [];
    for (const job of state.jobs) {
      if (job.status !== "active") continue;
      // Suppress scheduled runs for an archived (soft-deleted) owning agent.
      // The job stays "active" so restoring the agent resumes it; we just
      // skip claiming it while the agent is archived.
      if (state.agents.find((agent) => agent.id === job.agentId)?.archivedAt) continue;
      const dueAt = new Date(job.nextRunAt).getTime();
      if (dueAt > dateNow) continue;
      // Overlap protection: never start a scheduled run when another run
      // for the same job is still in-flight. Leave nextRunAt alone — the
      // next tick will retry once the in-flight run completes.
      if (findRunningRun(state, job.id)) continue;

      // Drift-free nextRunAt + missedRuns. The first advance consumes the
      // tick we're claiming now; each additional advance is a missed run.
      // Cron-driven jobs use the cron-aware helper so DST + month-end
      // boundaries are handled natively; interval jobs keep the linear
      // step math. An interval-driven job must have a positive
      // intervalSeconds by construction (creation + update guard); the
      // assert here catches a state file hand-edited into an unfireable
      // shape rather than silently looping forever.
      if (!job.cronExpression && (job.intervalSeconds === undefined || job.intervalSeconds <= 0)) {
        throw new Error(`Job ${job.id} has neither cronExpression nor a positive intervalSeconds`);
      }
      const { nextRunAtMs, missed } = job.cronExpression
        ? advanceCronNextRunAt(job.cronExpression, job.cronTimezone ?? "UTC", dueAt, dateNow)
        : advanceNextRunAt(dueAt, job.intervalSeconds as number, dateNow);
      job.nextRunAt = new Date(nextRunAtMs).toISOString();
      if (missed > 0) job.missedRuns += missed;
      job.lastRunAt = now();
      job.runCount += 1;
      job.updatedAt = now();
      const run = createJobRun(state, { jobId: job.id, trigger: "schedule", agentId: job.agentId });
      job.runIds.unshift(run.id);
      out.push({ job, run });
    }
    return out;
  });

  for (const { job, run } of claimed) {
    // Regression guard: see review note 2026-05-10. A per-job dispatch
    // failure must NOT escape and strand the OTHER already-claimed runs
    // in `running` forever. dispatchPromptRun finalizes its own run as
    // failed before rethrowing, so the catch here is purely about not
    // derailing the rest of the loop. Log the iteration error so an
    // operator can see what happened.
    try {
      if (job.script) {
        // executeScriptJob handles its own try/catch to keep the scheduler
        // tick from crashing on a script-runtime error.
        await executeScriptJob(config, job.id, run.id, job.script, job.timeoutSeconds, "schedule");
        continue;
      }
      // Pre-LLM hook runs between the claim and the model turn. shortCircuit
      // finalizes the run with NO turn; error finalizes it failed with no
      // draft; proceed dispatches the drafting turn with any injected context.
      const hook = await runPreRunHook(config, job, run);
      if (hook.action === "shortCircuit") {
        // A shortCircuit delivered nothing, so the handler's new state commits
        // IMMEDIATELY (no at-least-once concern).
        await persistHookState(config, job.id, hook.state);
        await finalizeShortCircuit(config, job, run, hook.summary);
        continue;
      }
      if (hook.action === "error") {
        await finalizeHookError(config, job, run, hook.message, "schedule", hook.fatal);
        continue;
      }
      // Routed (fan-out) path: spawn one worker per non-empty bucket into its
      // route's session, then finalize the ONE per-tick run "completed". Commit
      // ONLY the dispatched buckets' sub-state (per-bucket at-least-once). The
      // legacy single-turn path below is untouched when there are no buckets.
      if (hook.buckets && Object.keys(hook.buckets).length > 0) {
        const { dispatchedRouteKeys, attemptedRouteKeys } = await dispatchFanOut(config, job, run, "schedule", hook.buckets);
        await persistFanOutState(config, job.id, hook.state, dispatchedRouteKeys, attemptedRouteKeys);
        await finalizeFanOutRun(config, job, run, dispatchedRouteKeys);
        if (hook.onDispatched) await hook.onDispatched();
        continue;
      }
      await dispatchPromptRun(config, job, run, "schedule", hook.context);
      // Commit the hook's deferred post-delivery state ONLY after dispatch
      // resolved (the drafting turn is spawned). dispatchPromptRun finalizes its
      // own run + rethrows on a spawn failure, so a throw skips this — leaving
      // the handler's newState un-committed so the matches re-detect next tick
      // (at-least-once across the delivery boundary).
      await persistHookState(config, job.id, hook.state);
      if (hook.onDispatched) await hook.onDispatched();
    } catch (error) {
      appendLog(config.instance, "scheduler.iteration.error", {
        jobId: job.id,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
  }
}

// Fire-time resolution of a job's skill attachments. Returns undefined for
// jobs without attachments so both dispatch call sites (dispatchPromptRun,
// dispatchFanOut) stay byte-identical to the pre-attachment behavior. For
// jobs WITH attachments:
//   - each name re-resolves with read_skill semantics (resolveEnabledSkill)
//     plus the isSkillActive connector gate; a name that no longer resolves
//     is SKIPPED — the fire proceeds without that skill's instructions
//     (read_skill rejects missing/disabled/inactive skills too, so the skip
//     is final for the fire) — and reported in `skipped` for the per-task
//     trace.
//   - inlined bodies share the MAX_INLINED_SKILL_CHARS budget; a skill that
//     overflows it is truncated with an in-prompt note pointing at
//     read_skill (valid here: a truncated skill is enabled and active) and
//     reported in `truncated`.
// See ADR job-skill-attachments.md.
interface JobSkillAttachments {
  // The prompt block to inline, or undefined only when the job has NO
  // attachments at all. When every skill was skipped the block is just the
  // informational skip directive (sections empty) so the model is still told
  // the recipes are unavailable — see the directive below.
  block: string | undefined;
  attached: Array<{ id: string; name: string; version: number; chars: number }>;
  skipped: Array<{ name: string; reason: string }>;
  truncated: string[];
}

function resolveJobSkillAttachments(state: RuntimeState, job: JobRecord): JobSkillAttachments | undefined {
  if (!job.skillNames || job.skillNames.length === 0) return undefined;
  const attached: JobSkillAttachments["attached"] = [];
  const skipped: JobSkillAttachments["skipped"] = [];
  const truncated: string[] = [];
  const sections: string[] = [];
  let remaining = MAX_INLINED_SKILL_CHARS;
  for (const name of job.skillNames) {
    const skill = resolveEnabledSkill(state, name);
    if (!skill) {
      skipped.push({ name, reason: "missing or disabled" });
      continue;
    }
    if (!isSkillActive(state, skill)) {
      skipped.push({ name, reason: "inactive (required connectors not healthy)" });
      continue;
    }
    let body = skill.body;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n[truncated: total inlined skill content exceeds the per-fire cap; call read_skill("${skill.name}") for the full instructions]`;
      truncated.push(skill.name);
    }
    remaining -= Math.min(skill.body.length, remaining);
    sections.push(`<skill name="${skill.name}" version="${skill.version}">\n${body}\n</skill>`);
    attached.push({ id: skill.id, name: skill.name, version: skill.version, chars: body.length });
  }
  // When some attachments were skipped, prepend an INFORMATIONAL directive so
  // the model knows the requested recipe is unavailable this fire and must
  // not invent results that depend on it. This is model-awareness only — the
  // user-facing degradation notice is owned by the deterministic surfaces in
  // finalizeJobRunFromTask (chat system_note + bridge note), so we do NOT ask
  // the model to emit its own notice (avoids double-noting). All-skipped (no
  // sections) still yields a block of just this directive so the model is
  // informed even when nothing inlined.
  const skipDirective = skipped.length > 0
    ? `Note: ${skipped.length} requested skill recipe(s) are unavailable this run (${skipped
        .map((s) => `${s.name}: ${s.reason}`)
        .join("; ")}). Proceed without them and do not fabricate results that would require those skills.`
    : undefined;
  const inlinedBlock = sections.length > 0
    ? `Attached skill instructions (operator-registered; follow these recipes instead of rediscovering CLI usage):\n${sections.join("\n")}`
    : undefined;
  const block = [skipDirective, inlinedBlock].filter((part) => part !== undefined).join("\n\n") || undefined;
  return { block, attached, skipped, truncated };
}

// Per-task trace of a fire's skill attachments: one event per skipped or
// truncated skill naming it, plus one summary of what was inlined. Runs
// only after the spawned task exists (trace files are task-keyed).
function traceSkillAttachments(
  config: RuntimeConfig,
  taskId: string,
  jobId: string,
  runId: string,
  attachments: JobSkillAttachments
): void {
  for (const skip of attachments.skipped) {
    appendTrace(config.instance, taskId, {
      type: "job",
      message: `Job skill attachment skipped: ${skip.name} (${skip.reason})`,
      data: { jobId, runId, skillName: skip.name, reason: skip.reason }
    });
  }
  for (const name of attachments.truncated) {
    appendTrace(config.instance, taskId, {
      type: "job",
      message: `Job skill attachment truncated: ${name} (per-fire inline cap ${MAX_INLINED_SKILL_CHARS} chars)`,
      data: { jobId, runId, skillName: name }
    });
  }
  if (attachments.attached.length > 0) {
    appendTrace(config.instance, taskId, {
      type: "job",
      message: "Job skill attachments inlined",
      data: {
        jobId,
        runId,
        skills: attachments.attached.map(({ name, version }) => ({ name, version })),
        totalChars: attachments.attached.reduce((sum, skill) => sum + skill.chars, 0)
      }
    });
  }
}

// Build the per-task RuntimeConfig the spawned job-task will see. The
// returned object is always a fresh clone so we never mutate the
// operator's global config object. When the job carries no per-job
// envelope, the clone is byte-identical to the input and the spawned task
// inherits current behavior. When the job opts in, we overlay:
//   - `approvalMode` (per-job override of the operator default)
//   - `autoApproveCommands` merged onto the cloned array (operator's
//     allowlist still applies; the job widens it for its own task)
//   - `dangerousTerminalPatterns` for the per-job blocklist
// Audit rows on the spawned task's side effects automatically pick up
// the usual `autoApprovedReason` markers (matched pattern,
// "approval-mode-auto", or "approval-mode-yolo") via the existing
// tool-dispatch path — the only thing that changes per-job is which
// config object the spawned task sees. See ADR approval-mode.md
// ("Per-Job Scope").
function buildTaskConfig(config: RuntimeConfig, job: JobRecord): RuntimeConfig {
  const clone: RuntimeConfig = {
    ...config,
    autoApproveCommands: Array.isArray(config.autoApproveCommands)
      ? [...config.autoApproveCommands]
      : undefined
  };
  // approvalMode overlay. The job's explicit `approvalMode` always
  // wins over the operator instance default. For back-compat, the
  // legacy `dangerouslyAutoApprove: true` field on a job aliases to
  // `approvalMode: "yolo"` when no approvalMode is set on the job.
  if (job.approvalMode) {
    clone.approvalMode = job.approvalMode;
  } else if (job.dangerouslyAutoApprove === true) {
    clone.approvalMode = "yolo";
  }
  if (Array.isArray(job.autoApproveCommands) && job.autoApproveCommands.length > 0) {
    const base = clone.autoApproveCommands ?? [];
    clone.autoApproveCommands = [...base, ...job.autoApproveCommands];
  }
  if (Array.isArray(job.dangerousTerminalPatterns)) {
    clone.dangerousTerminalPatterns = [...job.dangerousTerminalPatterns];
  }
  return clone;
}

// Spawns the prompt task for an already-claimed JobRunRecord. Leaves the
// run in `running` — it will be finalized via finalizeJobRunFromTask once
// the spawned task reaches a terminal state. If submitTask itself throws,
// finalize the run as failed defensively so it doesn't hang.
//
// When the job carries a `chatSessionId` (created via the agent's
// `create_job` tool), we additionally:
//   - create a fresh RunRecord linked to that conversation so the chat
//     UI shows the spawned task in the same thread
//   - submit the task with mode:"chat" + that runId so the tool-calling
//     agent loop is used (multi-turn context, structured tool calls)
//   - push task.id onto session.taskIds so getChatSession picks up the
//     in-flight task and synthesizes a placeholder
// Final delivery (assistant message) is wired up in finalizeJobRunFromTask
// via syncChatTaskResult.
async function dispatchPromptRun(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  trigger: "schedule" | "manual" | "replay",
  hookContext: string[] = []
): Promise<{ jobId: string; runId: string; taskId: string }> {
  // Hook context joins the job's static context block at the single assembly
  // point, traveling alongside the prompt into the same model turn (Claude
  // Code's additionalContext-alongside-the-prompt semantics). Default [] keeps
  // every non-hook caller byte-identical. Skill attachments resolve at fire
  // time so a stale name skips (traced below) instead of failing the fire.
  const attachments = resolveJobSkillAttachments(readState(config.instance), job);
  const prompt = withCronHint(job.prompt, [...job.context, ...hookContext], attachments?.block, job.deliveryPolicy);
  // Persist any fire-time skill skips on the run BEFORE submitTask so the
  // degradation is durable on /api/job-runs and finalizeJobRunFromTask sees it
  // — submitTask dispatches the chat task detached, and that task's own
  // finalize reads run.skillSkips, so stamping it after submitTask returns
  // would race the finalize. Only stamp when non-empty (absent = no skips).
  if (attachments && attachments.skipped.length > 0) {
    await mutateState(config.instance, (state) => {
      const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
      if (runItem) runItem.skillSkips = attachments.skipped;
    });
  }
  // Per-job approval envelope: clone the RuntimeConfig (NEVER mutate the
  // original — it's the per-instance runtime-wide config) and overlay the
  // job's opt-in fields before handing it to submitTask. The spawned task
  // and every approval-gated dispatch inside it see the cloned config; the
  // operator's global RuntimeConfig stays untouched. See ADR
  // approval-mode.md ("Per-Job Scope") for the approval model.
  const taskConfig: RuntimeConfig = buildTaskConfig(config, job);

  // Resolve session linkage up-front. If the job points at a session that
  // no longer exists (deleted by the user), audit the gap and fall through
  // to the legacy imperative path so the job still produces a result.
  let chatRunId: string | undefined;
  if (job.chatSessionId) {
    const sessionRunId = await mutateState(config.instance, (state) => {
      const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
      if (!session) {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "job.session.missing",
            target: job.id,
            risk: "low",
            evidence: { jobId: job.id, runId: run.id, chatSessionId: job.chatSessionId }
          },
          { jobId: job.id, agentId: job.agentId }
        );
        return undefined;
      }
      const chatRun = createRun(state, {
        kind: "job",
        title: job.name,
        input: prompt,
        conversationId: job.chatSessionId,
        jobId: job.id
      });
      // createRun pushes the runId onto session.runIds automatically when
      // conversationId is set. session.taskIds is updated post-submitTask
      // (we don't have task.id yet).
      return chatRun.id;
    });
    chatRunId = sessionRunId;
  }

  let task;
  try {
    if (chatRunId) {
      task = await submitTask(taskConfig, prompt, {
        jobId: job.id,
        runId: chatRunId,
        mode: "chat",
        agentId: job.agentId,
        chatSessionId: job.chatSessionId
      });
    } else {
      task = await submitTask(taskConfig, prompt, { jobId: job.id, agentId: job.agentId });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (state) => {
      const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
      const jobItem = state.jobs.find((candidate) => candidate.id === job.id);
      if (!runItem) return;
      if (runItem.status !== "running") return;
      runItem.status = "failed";
      runItem.error = message;
      runItem.completedAt = now();
      runItem.updatedAt = runItem.completedAt;
      if (jobItem) {
        jobItem.lastFailureAt = runItem.completedAt;
        jobItem.lastError = message;
        // Only flip status="failed" for scheduled runs; manual/replay
        // failures should leave the configured status untouched.
        if (trigger === "schedule") jobItem.status = "failed";
      }
      appendEvent(
        state,
        {
          kind: "job",
          action: "job.run.failed",
          target: job.id,
          jobId: job.id,
          risk: "low",
          summary: "Prompt job dispatch failed.",
          data: { runId: run.id, error: message }
        },
        { jobId: job.id, agentId: job.agentId }
      );
    });
    throw error;
  }
  await mutateState(config.instance, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id);
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    if (!item || !runItem) return;
    item.taskIds.unshift(task.id);
    runItem.taskId = task.id;
    // Leave runItem.status === "running" so finalizeJobRunFromTask can
    // complete it when the task settles. Do NOT set lastSuccessAt here.
    if (job.chatSessionId) {
      const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
      if (session && !session.taskIds.includes(task.id)) {
        session.taskIds.push(task.id);
        session.updatedAt = now();
      }
    }
    // Stamp the inlined skills onto the spawned task so the UI/telemetry
    // shows skill usage without parsing the trace file.
    if (attachments && attachments.attached.length > 0) {
      const taskItem = state.tasks.find((candidate) => candidate.id === task.id);
      if (taskItem) {
        for (const { id } of attachments.attached) {
          if (!taskItem.skillIds.includes(id)) taskItem.skillIds.push(id);
        }
      }
    }
  });
  appendTrace(config.instance, task.id, {
    type: "job",
    message: "Job spawned task",
    data: { jobId: job.id, runId: run.id, deliveryTargets: job.deliveryTargets, chatSessionId: job.chatSessionId, chatRunId }
  });
  if (attachments) traceSkillAttachments(config, task.id, job.id, run.id, attachments);
  return { jobId: job.id, runId: run.id, taskId: task.id };
}

// Finalize the ONE per-tick JobRunRecord "completed" after a fan-out dispatched
// all its buckets. A fan-out tick spawns N independent worker tasks (each a
// constrained subagent into its route's session); each worker delivers its own
// assistant message via the normal chat path. The tick's run is NOT bound to any
// single one of those tasks, so we finalize it INLINE by run.id — never routing
// it through finalizeJobRunFromTask (which assumes one run -> one task and would
// mis-bind to one worker). Mirrors finalizeShortCircuit's inline completed write:
// completed status, job lastSuccessAt + cleared lastError, oneShot auto-pause +
// audit, and the job.run.completed event. The `status === "running"` guard makes
// a cancel race a no-op (no double finalize).
async function finalizeFanOutRun(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  dispatchedRouteKeys: string[]
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    const jobItem = state.jobs.find((candidate) => candidate.id === job.id);
    if (!runItem) return;
    if (runItem.status !== "running") return;
    const completedAt = now();
    runItem.status = "completed";
    runItem.summary = "[SILENT]";
    runItem.error = undefined;
    runItem.completedAt = completedAt;
    runItem.updatedAt = completedAt;
    if (jobItem) {
      jobItem.lastSuccessAt = completedAt;
      jobItem.lastError = undefined;
      if (jobItem.oneShot === true && jobItem.status === "active") {
        jobItem.status = "paused";
        jobItem.updatedAt = completedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "job.oneshot.completed",
            target: jobItem.id,
            risk: "low",
            evidence: { runId: run.id, runStatus: runItem.status }
          },
          { jobId: jobItem.id, agentId: jobItem.agentId }
        );
      }
    }
    appendEvent(
      state,
      {
        kind: "job",
        action: "job.run.completed",
        target: job.id,
        jobId: job.id,
        risk: "low",
        summary: "Fan-out dispatched all routed buckets.",
        data: { runId: run.id, fanOut: true, dispatchedRouteKeys }
      },
      { jobId: job.id, agentId: job.agentId }
    );
  });
}

// Fan out a routed pre-run hook result: for each non-empty bucket, spawn ONE
// constrained worker (subagent) into that route's chat session, fed the route's
// worker config + the bucket's fenced context. Empty buckets spawn nothing
// (per-concern short-circuit; an idle concern costs zero model turns). Returns
// the routeKeys that successfully dispatched so the caller can advance ONLY their
// sub-cursors (per-bucket at-least-once: a failed bucket keeps its prior cursor
// and re-detects next tick).
//
// Each route dispatch is wrapped in its own try/catch so one failing route can't
// derail its siblings. A route with no JobRecord.routes entry falls back to the
// job's own chatSessionId (audited job.route.missing); a route pointing at a
// deleted session is audited (job.route.session_missing) and skipped without
// blocking siblings. The ONE per-tick JobRunRecord is finalized by the caller via
// finalizeFanOutRun — workers deliver independently via the chat path.
async function dispatchFanOut(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  trigger: "schedule" | "manual" | "replay",
  buckets: Record<string, string[]>
): Promise<{ dispatchedRouteKeys: string[]; attemptedRouteKeys: string[] }> {
  const dispatchedRouteKeys: string[] = [];
  const attemptedRouteKeys: string[] = [];
  // Skill attachments resolve ONCE per tick — every route's worker shares
  // the job's attachment list, mirroring dispatchPromptRun's fire-time
  // skip/truncate semantics.
  const attachments = resolveJobSkillAttachments(readState(config.instance), job);
  // Persist fire-time skips onto the per-tick run so /api/job-runs surfaces
  // the degradation. Fan-out workers deliver independently (not via
  // finalizeJobRunFromTask), so the deterministic chat/bridge skip notes
  // don't apply on this path — the in-prompt directive reaches the workers
  // and the run record records the skip. See ADR job-skill-attachments.md.
  if (attachments && attachments.skipped.length > 0) {
    await mutateState(config.instance, (state) => {
      const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
      if (runItem) runItem.skillSkips = attachments.skipped;
    });
  }
  for (const [routeKey, bucketContext] of Object.entries(buckets)) {
    // Empty bucket → no worker (zero-idle-turn discipline).
    if (bucketContext.length === 0) continue;
    // A non-empty bucket is an attempted dispatch — its cursor must roll back to
    // the old slice if the dispatch does not complete (per-bucket at-least-once).
    attemptedRouteKeys.push(routeKey);
    try {
      // Resolve the route. An unmapped routeKey falls back to the job's own
      // session so the bucket still gets delivered (audited so a missing route is
      // visible). A mapped route whose session was deleted is audited + skipped.
      const route: JobRoute | undefined = job.routes?.[routeKey];
      let chatSessionId: string;
      if (route) {
        const sessionExists = readState(config.instance).chatSessions.some((s) => s.id === route.chatSessionId);
        if (!sessionExists) {
          await mutateState(config.instance, (state) => {
            addAudit(
              state,
              {
                actor: "runtime",
                action: "job.route.session_missing",
                target: job.id,
                risk: "low",
                evidence: { jobId: job.id, runId: run.id, routeKey, chatSessionId: route.chatSessionId }
              },
              { jobId: job.id, agentId: job.agentId }
            );
          });
          continue;
        }
        chatSessionId = route.chatSessionId;
      } else {
        if (!job.chatSessionId) {
          // No route and no job session to fall back to — nothing to deliver into.
          await mutateState(config.instance, (state) => {
            addAudit(
              state,
              {
                actor: "runtime",
                action: "job.route.missing",
                target: job.id,
                risk: "low",
                evidence: { jobId: job.id, runId: run.id, routeKey, fellBackTo: null }
              },
              { jobId: job.id, agentId: job.agentId }
            );
          });
          continue;
        }
        await mutateState(config.instance, (state) => {
          addAudit(
            state,
            {
              actor: "runtime",
              action: "job.route.missing",
              target: job.id,
              risk: "low",
              evidence: { jobId: job.id, runId: run.id, routeKey, fellBackTo: job.chatSessionId }
            },
            { jobId: job.id, agentId: job.agentId }
          );
        });
        chatSessionId = job.chatSessionId;
      }

      // Per-route prompt: the route's prompt (or the job's) + the job's static
      // context + this bucket's fenced items, assembled at the same point
      // dispatchPromptRun assembles its single-turn prompt (including the
      // job's inlined skill attachments).
      const prompt = withCronHint(route?.prompt ?? job.prompt, [...job.context, ...bucketContext], attachments?.block, job.deliveryPolicy);
      // Spawn one constrained worker into the route's session. NO parentTaskId
      // (a parentless constrained subagent — the depth cap no-ops without a
      // parent chain), so the worker runs under the route's systemPrompt/toolsets/
      // skills whitelist exactly like a delegated subagent.
      const worker = await spawnSubagent(config, {
        name: job.name,
        prompt,
        systemPrompt: route?.systemPrompt,
        toolsets: route?.toolsets,
        skills: route?.skills,
        chatSessionId
      });
      if (attachments) traceSkillAttachments(config, worker.taskId, job.id, run.id, attachments);
      dispatchedRouteKeys.push(routeKey);
    } catch (error) {
      // One route's failure must not derail its siblings. Log it; the bucket's
      // cursor stays un-advanced (caller merges only dispatched routeKeys), so it
      // re-detects next tick (per-bucket at-least-once).
      appendLog(config.instance, "job.route.dispatch.error", {
        jobId: job.id,
        runId: run.id,
        routeKey,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { dispatchedRouteKeys, attemptedRouteKeys };
}

// Commit the handler's new hookState while preserving per-bucket at-least-once.
// Domain-agnostic contract: a routed handler returns its new `state` keyed by
// routeKey at the top level — each top-level key IS a bucket's routeKey. The
// handler legitimately advances a watch's cursor on a SILENT result too (seeding
// a baseline, dropping all mail as automated/self, a triage tick that only
// claimed mail) — those routeKeys carry a fresh cursor but open no bucket, so they
// are neither dispatched nor attempted. We adopt EVERY fresh top-level slice from
// the handler (matching the legacy whole-blob write), then roll back ONLY the
// routeKeys that were ATTEMPTED (had a non-empty bucket this tick) but FAILED to
// dispatch back to their OLD slice — so a failed dispatch re-detects next tick
// while every silent advance commits.
async function persistFanOutState(
  config: RuntimeConfig,
  jobId: string,
  newState: Record<string, unknown> | undefined,
  dispatchedRouteKeys: string[],
  attemptedRouteKeys: string[]
): Promise<void> {
  if (newState === undefined) return;
  const dispatched = new Set(dispatchedRouteKeys);
  const failedRouteKeys = attemptedRouteKeys.filter((routeKey) => !dispatched.has(routeKey));
  await mutateState(config.instance, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return;
    const oldState: Record<string, unknown> = { ...(job.hookState ?? {}) };
    const merged: Record<string, unknown> = { ...oldState, ...newState };
    // Roll back attempted-but-failed buckets to their old slice (or drop the key
    // if it had no old slice) so their cursor does not advance over un-delivered mail.
    for (const routeKey of failedRouteKeys) {
      if (routeKey in oldState) merged[routeKey] = oldState[routeKey];
      else delete merged[routeKey];
    }
    job.hookState = merged;
  });
}

export async function runJobNow(
  config: RuntimeConfig,
  jobId: string,
  trigger: "schedule" | "manual" | "replay" = "manual",
  parentTaskId?: string
) {
  const claim = await mutateState(config.instance, (state) => {
    // When invoked from the agent tool path with a `parentTaskId`, refuse
    // to fire if the parent task has been cancelled or failed. The
    // lock-free pre-check in the tool handler is the fast path; this
    // serialized re-check is the authoritative guard against a
    // `cancelTask` landing between the pre-check and our write. Matches
    // the module-wide pattern (`createScheduledJob`, `updateJob`,
    // `updateJobStatus`, `removeJob`): `completed` is treated as a
    // non-blocking status for job mutations, only `cancelled` / `failed`
    // block.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot run job: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    const item = state.jobs.find((candidate) => candidate.id === jobId);
    if (!item) throw new Error(`Job not found: ${jobId}`);
    // Overlap protection for scheduled triggers: refuse to start a second
    // run while another is in-flight. Manual/replay are explicit user
    // actions and may run alongside an in-flight run.
    if (trigger === "schedule" && findRunningRun(state, jobId)) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "job.run.skipped_overlap",
          target: jobId,
          risk: "low",
          evidence: { reason: "previous run still running" }
        },
        { jobId, agentId: item.agentId }
      );
      return undefined;
    }
    item.lastRunAt = now();
    item.runCount += 1;
    // For trigger="schedule", advancing nextRunAt is owned by runDueJobs
    // (drift-free). For manual/replay we usually leave nextRunAt alone —
    // a user clicking Run shouldn't itself reschedule the next tick.
    //
    // BUT: if the manual run is happening AFTER the scheduled tick was
    // already overdue, we must advance nextRunAt or the scheduler will
    // re-fire the same job ~1s later and double-run it. Only do this
    // for active jobs — advancing on a paused job would imply the
    // schedule kept ticking while paused, which it didn't.
    //
    // The first advance corresponds to "this manual run satisfies the
    // overdue tick" and is NOT counted as a missed run; only additional
    // advances (further skipped intervals) bump missedRuns.
    if (trigger !== "schedule" && item.status === "active") {
      const dueAt = new Date(item.nextRunAt).getTime();
      const dateNow = Date.now();
      if (dueAt <= dateNow) {
        // Same well-formedness guard as in runDueJobs: a non-cron job must
        // carry a positive intervalSeconds. The assert is defense in depth
        // against hand-edited state files; the create/update paths enforce
        // this invariant on every write.
        if (!item.cronExpression && (item.intervalSeconds === undefined || item.intervalSeconds <= 0)) {
          throw new Error(`Job ${item.id} has neither cronExpression nor a positive intervalSeconds`);
        }
        const { nextRunAtMs, missed } = item.cronExpression
          ? advanceCronNextRunAt(item.cronExpression, item.cronTimezone ?? "UTC", dueAt, dateNow)
          : advanceNextRunAt(dueAt, item.intervalSeconds as number, dateNow);
        item.nextRunAt = new Date(nextRunAtMs).toISOString();
        if (missed > 0) item.missedRuns += missed;
      }
    }
    item.updatedAt = now();
    const run = createJobRun(state, { jobId, trigger, agentId: item.agentId });
    item.runIds.unshift(run.id);
    return { job: item, run };
  });
  if (!claim) return undefined;
  const { job, run } = claim;
  if (job.script) return executeScriptJob(config, job.id, run.id, job.script, job.timeoutSeconds, trigger);
  // Manual/replay runs honor the preRun hook too.
  const hook = await runPreRunHook(config, job, run);
  if (hook.action === "shortCircuit") {
    // Nothing delivered => commit the handler's new state immediately.
    await persistHookState(config, job.id, hook.state);
    await finalizeShortCircuit(config, job, run, hook.summary);
    return { jobId: job.id, runId: run.id, shortCircuited: true };
  }
  if (hook.action === "error") {
    await finalizeHookError(config, job, run, hook.message, trigger, hook.fatal);
    return { jobId: job.id, runId: run.id, error: hook.message };
  }
  // Routed (fan-out) path mirrors runDueJobs: one worker per non-empty bucket,
  // per-bucket at-least-once commit, then finalize the ONE per-tick run.
  if (hook.buckets && Object.keys(hook.buckets).length > 0) {
    const { dispatchedRouteKeys, attemptedRouteKeys } = await dispatchFanOut(config, job, run, trigger, hook.buckets);
    await persistFanOutState(config, job.id, hook.state, dispatchedRouteKeys, attemptedRouteKeys);
    await finalizeFanOutRun(config, job, run, dispatchedRouteKeys);
    if (hook.onDispatched) await hook.onDispatched();
    return { jobId: job.id, runId: run.id, fanOut: true, dispatchedRouteKeys };
  }
  const dispatched = await dispatchPromptRun(config, job, run, trigger, hook.context);
  // Commit the hook's deferred post-delivery state only after dispatch resolved.
  // A spawn failure rethrows from dispatchPromptRun (skipping this), so the
  // un-committed newState leaves the matches to re-detect on the next fire
  // (at-least-once).
  await persistHookState(config, job.id, hook.state);
  if (hook.onDispatched) await hook.onDispatched();
  return dispatched;
}

export async function updateJobStatus(
  config: RuntimeConfig,
  jobId: string,
  statusValue: "active" | "paused",
  parentTaskId?: string
) {
  return mutateState(config.instance, (state) => {
    // When invoked from the agent tool path with a `parentTaskId`, refuse
    // to mutate if the parent task has gone terminal. The lock-free
    // pre-check in the tool handler is the fast path; this serialized
    // re-check is the authoritative guard against a `cancelTask` landing
    // between the pre-check and our write.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot update job status: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = statusValue;
    job.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: `job.${statusValue}`,
        target: jobId,
        risk: "low"
      },
      { jobId, agentId: job.agentId }
    );
    return job;
  });
}

export async function updateJob(
  config: RuntimeConfig,
  jobId: string,
  input: Record<string, unknown>,
  parentTaskId?: string,
  // One-shot patch, supplied ONLY by the update_job tool. It rides as a
  // separate parameter (never an `input` key) because the raw HTTP PATCH
  // /api/jobs handler forwards its body straight into `input` — the HTTP
  // surface must stay unable to patch oneShot. Applying it inside this
  // function's single mutateState keeps the silent × one-shot guards and
  // every sibling field atomic: a rejection aborts the whole patch.
  oneShotPatch?: boolean
) {
  // Validate up-front so 400-class errors come back as `Invalid input: ...`
  // before we open a mutateState write. Only validate fields the caller
  // actually supplied.
  //
  // The patch shape lets callers swap a job between interval-driven and
  // cron-driven without removing/recreating it. The four transitions are:
  //   - interval -> interval: { intervalSeconds: N }
  //   - cron -> cron: { cronExpression, cronTimezone? } (TZ alone is also legal
  //     when the job is already cron-driven)
  //   - interval -> cron: { cronExpression, cronTimezone?, intervalSeconds: null }
  //   - cron -> interval: { intervalSeconds: N, cronExpression: null, cronTimezone?: null }
  // `null` on cronExpression / cronTimezone / intervalSeconds means "clear"
  // (mirrors the existing `costBudget: null` precedent below). The mutual-
  // exclusion rule is: a single patch may not set BOTH a positive
  // intervalSeconds AND a cronExpression — that's ambiguous, same as in
  // `createScheduledJob`.
  const setsIntervalPositive =
    input.intervalSeconds !== undefined && input.intervalSeconds !== null;
  const setsCronExpression =
    input.cronExpression !== undefined && input.cronExpression !== null;
  if (setsIntervalPositive && setsCronExpression) {
    throw new Error("Invalid input: cronExpression and intervalSeconds are mutually exclusive");
  }
  if (setsIntervalPositive) assertPositiveInt("intervalSeconds", input.intervalSeconds);
  if (input.timeoutSeconds !== undefined) assertPositiveInt("timeoutSeconds", input.timeoutSeconds);
  if (input.retryLimit !== undefined) assertNonNegativeInt("retryLimit", input.retryLimit);

  // `name` and `prompt` are both string-typed on the JobRecord; throw on
  // type/empty-string mismatches up-front so a bad patch surfaces as
  // `Invalid input: …` instead of being silently no-op'd at the
  // assignment below. Without this, dishonest reporting bugs creep in:
  // dispatchers built appliedFields from `Object.keys(patch)` and would
  // claim a name/prompt change happened even when the underlying
  // assignment was skipped.
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw new Error(`Invalid input: name must be a non-empty string (got ${String(input.name)})`);
    }
  }
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== "string" || input.prompt.length === 0) {
      throw new Error(`Invalid input: prompt must be a non-empty string (got ${String(input.prompt)})`);
    }
  }

  // Validate the cron fields' shape (but not the expression semantics yet —
  // that requires the existing job to compute the effective timezone, so we
  // defer to inside mutateState).
  let cronExpressionPatch: string | undefined;
  if (setsCronExpression) {
    if (typeof input.cronExpression !== "string" || input.cronExpression.trim().length === 0) {
      throw new Error(`Invalid input: cronExpression must be a non-empty string (got ${String(input.cronExpression)})`);
    }
    cronExpressionPatch = input.cronExpression.trim();
  }
  let cronTimezonePatch: string | undefined;
  const setsCronTimezone =
    input.cronTimezone !== undefined && input.cronTimezone !== null;
  if (setsCronTimezone) {
    if (typeof input.cronTimezone !== "string" || input.cronTimezone.length === 0) {
      throw new Error(`Invalid input: cronTimezone must be a non-empty string (got ${String(input.cronTimezone)})`);
    }
    cronTimezonePatch = input.cronTimezone;
  }

  // Per-job auto-approve envelope. Same validation shape as
  // `createScheduledJob` above. `undefined` means "no change"; an empty
  // array on `autoApproveCommands` means "clear the list"; explicit
  // `null` on either field also means "clear" so callers can drop the
  // override entirely. See ADR dangerously-auto-approve.md.
  let dangerouslyAutoApprovePatch: boolean | undefined;
  let clearDangerouslyAutoApprove = false;
  if (input.dangerouslyAutoApprove === null) {
    clearDangerouslyAutoApprove = true;
  } else if (input.dangerouslyAutoApprove !== undefined) {
    if (typeof input.dangerouslyAutoApprove !== "boolean") {
      throw new Error(`Invalid input: dangerouslyAutoApprove must be a boolean (got ${String(input.dangerouslyAutoApprove)})`);
    }
    dangerouslyAutoApprovePatch = input.dangerouslyAutoApprove;
  }
  let autoApproveCommandsPatch: string[] | undefined;
  let clearAutoApproveCommands = false;
  if (input.autoApproveCommands === null) {
    clearAutoApproveCommands = true;
  } else if (input.autoApproveCommands !== undefined) {
    if (!Array.isArray(input.autoApproveCommands)) {
      throw new Error(`Invalid input: autoApproveCommands must be an array of strings (got ${typeof input.autoApproveCommands})`);
    }
    const cleaned: string[] = [];
    for (const entry of input.autoApproveCommands) {
      if (typeof entry !== "string") {
        throw new Error(`Invalid input: autoApproveCommands entries must be strings (got ${typeof entry})`);
      }
      if (entry.length === 0) {
        throw new Error(`Invalid input: autoApproveCommands entries must be non-empty strings`);
      }
      cleaned.push(entry);
    }
    if (cleaned.length === 0) {
      // Empty array is a "clear" signal (same as null) — leaving an empty
      // array on the JobRecord would be functionally equivalent but
      // misleading next time the job is read.
      clearAutoApproveCommands = true;
    } else {
      autoApproveCommandsPatch = cleaned;
    }
  }

  // Delivery-policy patch. `undefined`/`null` = no change (the field always
  // reads with an "always" default, so there is no meaningful "clear"). The
  // silent × oneShot rejection is re-checked against the live record inside
  // mutateState below.
  let deliveryPolicyPatch: JobDeliveryPolicy | undefined;
  if (input.deliveryPolicy !== undefined && input.deliveryPolicy !== null) {
    if (input.deliveryPolicy !== "always" && input.deliveryPolicy !== "on_findings" && input.deliveryPolicy !== "silent") {
      throw new Error(`Invalid input: deliveryPolicy must be one of "always" | "on_findings" | "silent" (got ${String(input.deliveryPolicy)})`);
    }
    deliveryPolicyPatch = input.deliveryPolicy;
  }

  // Skill attachments patch. `undefined` = no change; `null` or `[]` =
  // clear (mirrors the autoApproveCommands precedent above). A non-empty
  // list REPLACES the job's previous attachments wholesale — no merge.
  let skillNamesPatch: string[] | undefined;
  let clearSkillNames = false;
  if (input.skillNames === null) {
    clearSkillNames = true;
  } else if (input.skillNames !== undefined) {
    const parsed = parseSkillNamesInput(input.skillNames);
    if (parsed.length === 0) clearSkillNames = true;
    else skillNamesPatch = parsed;
  }

  return mutateState(config.instance, (state) => {
    // When invoked from the agent tool path with a `parentTaskId`, refuse
    // to mutate if the parent task has gone terminal. The lock-free
    // pre-check in the tool handler is the fast path; this serialized
    // re-check is the authoritative guard against a `cancelTask` landing
    // between the pre-check and our write.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot update job: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (typeof input.name === "string") job.name = input.name;
    if (typeof input.prompt === "string") job.prompt = input.prompt;
    if (typeof input.script === "string") job.script = input.script || undefined;
    if (Array.isArray(input.deliveryTargets)) job.deliveryTargets = input.deliveryTargets.map(String);
    if (Array.isArray(input.context)) job.context = input.context.map(String);
    if (typeof input.retryLimit === "number") job.retryLimit = input.retryLimit;
    if (typeof input.timeoutSeconds === "number") job.timeoutSeconds = input.timeoutSeconds;
    if (typeof input.costBudget === "number") job.costBudget = Math.max(0, input.costBudget);
    else if (input.costBudget === null) job.costBudget = undefined;

    // Schedule-mode transitions. The block below handles three orthogonal
    // intents the caller can express in one patch:
    //   1. clear cron (cronExpression: null) — implies switching to interval
    //      (or the patch must also supply intervalSeconds; we don't refuse
    //      here since `nextRunAt` is recomputed below).
    //   2. set/replace cron expression and/or timezone.
    //   3. set a positive intervalSeconds — implies switching off cron if it
    //      was set.
    // After applying intent, we recompute nextRunAt exactly once so the
    // scheduler picks up the new cadence on its next tick.
    const clearingCron =
      input.cronExpression === null ||
      (setsIntervalPositive && !setsCronExpression && job.cronExpression !== undefined);
    const clearingInterval = input.intervalSeconds === null;
    const clearingCronTimezone = input.cronTimezone === null;

    // Resolve the NEW (post-patch) cron expression + timezone. We need these
    // both to validate via croner and to recompute nextRunAt.
    let newCronExpression: string | undefined = job.cronExpression;
    let newCronTimezone: string | undefined = job.cronTimezone;
    if (clearingCron) {
      newCronExpression = undefined;
      // Dropping the expression also drops the timezone — a TZ alone is
      // meaningless on an interval job (mirrors createScheduledJob's rule).
      newCronTimezone = undefined;
    } else if (cronExpressionPatch !== undefined) {
      newCronExpression = cronExpressionPatch;
      // If a TZ is provided alongside, use it; otherwise default to the
      // job's existing TZ if any, else "UTC".
      if (cronTimezonePatch !== undefined) newCronTimezone = cronTimezonePatch;
      else if (clearingCronTimezone) newCronTimezone = "UTC";
      else if (newCronTimezone === undefined) newCronTimezone = "UTC";
    } else if (cronTimezonePatch !== undefined) {
      // Timezone-only update. Legal ONLY if the job is already cron-driven
      // (or just became cron-driven in this patch — handled above).
      if (newCronExpression === undefined) {
        throw new Error("Invalid input: cronTimezone may only be set when cronExpression is set");
      }
      newCronTimezone = cronTimezonePatch;
    } else if (clearingCronTimezone) {
      // Explicit null on timezone with no cronExpression change: only legal
      // if cron is also being cleared (handled above) — otherwise refuse,
      // since "cron job with no timezone" is not a valid state.
      if (newCronExpression !== undefined && !clearingCron) {
        throw new Error("Invalid input: cronTimezone may not be cleared while cronExpression is set");
      }
      newCronTimezone = undefined;
    }

    // If we end up cron-driven, validate via croner and recompute nextRunAt
    // from the cron schedule. If we end up interval-driven, recompute
    // nextRunAt from `now + intervalSeconds`. Cron-driven jobs leave
    // intervalSeconds undefined entirely — no sentinel.
    let newIntervalSeconds: number | undefined = job.intervalSeconds;
    if (typeof input.intervalSeconds === "number") {
      newIntervalSeconds = input.intervalSeconds;
    } else if (clearingInterval && newCronExpression !== undefined) {
      // Interval cleared and we're cron-driven post-patch — drop the field.
      newIntervalSeconds = undefined;
    } else if (newCronExpression !== undefined && job.cronExpression === undefined) {
      // Caller is switching interval -> cron but didn't explicitly null the
      // intervalSeconds. Drop the field so the JobRecord stays coherent
      // (no leftover stale interval on a cron job).
      newIntervalSeconds = undefined;
    } else if (
      newCronExpression === undefined &&
      job.cronExpression !== undefined &&
      (job.intervalSeconds === undefined || job.intervalSeconds <= 0)
    ) {
      // Cron -> interval requested (cronExpression: null) but caller forgot
      // to supply a positive intervalSeconds. Refuse so we don't leave the
      // job in an unfireable shape.
      throw new Error("Invalid input: clearing cronExpression requires a positive intervalSeconds in the same patch");
    }

    // Recompute nextRunAt for any schedule-shape change.
    const scheduleChanged =
      newCronExpression !== job.cronExpression ||
      newCronTimezone !== job.cronTimezone ||
      (typeof input.intervalSeconds === "number" && newIntervalSeconds !== job.intervalSeconds);
    if (scheduleChanged) {
      if (newCronExpression !== undefined) {
        const tz = newCronTimezone ?? "UTC";
        // Re-validate via croner — same error shapes as createScheduledJob.
        let cron: Cron;
        try {
          cron = new Cron(newCronExpression, { timezone: tz });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/timezone/i.test(message)) {
            throw new Error(`Invalid input: cronTimezone "${tz}" is not a valid IANA timezone (${message})`);
          }
          throw new Error(`Invalid input: cronExpression is not a valid 5-field Unix cron (${message})`);
        }
        let next: Date | null;
        try {
          next = cron.nextRun();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/timezone/i.test(message)) {
            throw new Error(`Invalid input: cronTimezone "${tz}" is not a valid IANA timezone (${message})`);
          }
          throw new Error(`Invalid input: cronExpression is not a valid 5-field Unix cron (${message})`);
        }
        if (!next) {
          throw new Error(`Invalid input: cronExpression "${newCronExpression}" has no future runs`);
        }
        job.nextRunAt = new Date(next.getTime()).toISOString();
      } else {
        // Interval-driven post-patch. Anchor nextRunAt to now + interval.
        if (newIntervalSeconds === undefined || !Number.isFinite(newIntervalSeconds) || newIntervalSeconds <= 0) {
          throw new Error("Invalid input: a non-cron job requires a positive intervalSeconds");
        }
        job.nextRunAt = new Date(Date.now() + newIntervalSeconds * 1000).toISOString();
      }
    }

    job.cronExpression = newCronExpression;
    job.cronTimezone = newCronTimezone;
    job.intervalSeconds = newIntervalSeconds;

    // Apply auto-approve patch fields. `clear*` is "drop the override
    // entirely" so the job falls back to the runtime/agent default.
    if (clearDangerouslyAutoApprove) {
      job.dangerouslyAutoApprove = undefined;
    } else if (dangerouslyAutoApprovePatch !== undefined) {
      job.dangerouslyAutoApprove = dangerouslyAutoApprovePatch;
    }
    if (clearAutoApproveCommands) {
      job.autoApproveCommands = undefined;
    } else if (autoApproveCommandsPatch !== undefined) {
      job.autoApproveCommands = autoApproveCommandsPatch;
    }

    // One-shot patch (tool path only — see the parameter note above).
    // Applied BEFORE the delivery-policy block so the silent guard below
    // reads the effective post-patch value: converting a reminder to a
    // recurring silent watch ({ deliveryPolicy: "silent", oneShot: false })
    // works in one call. Flipping TO one-shot re-checks the effective
    // policy — this call's patch if supplied, else the live record, which a
    // concurrent update may have flipped silent since the caller's
    // lock-free pre-flight.
    if (oneShotPatch !== undefined) {
      if (
        oneShotPatch === true &&
        (deliveryPolicyPatch ?? job.deliveryPolicy ?? "always") === "silent"
      ) {
        throw new Error(`Invalid input: deliveryPolicy "silent" is not allowed on one-shot reminder jobs`);
      }
      job.oneShot = oneShotPatch;
    }

    // Delivery-policy patch, re-checked inside the lock against the record —
    // which already reflects a same-call oneShot patch applied just above —
    // so a patch can't flip a one-shot reminder silent (same rule as create
    // time), and a caller that never patches oneShot (the HTTP PATCH
    // surface) is judged on the live value.
    if (deliveryPolicyPatch !== undefined) {
      if (deliveryPolicyPatch === "silent" && job.oneShot === true) {
        throw new Error(`Invalid input: deliveryPolicy "silent" is not allowed on one-shot reminder jobs`);
      }
      job.deliveryPolicy = deliveryPolicyPatch;
      // Keep the dedicated channel's `headless` bit in sync across the
      // silent boundary, mirroring the mint invariant in createScheduledJob
      // and rebindJobDelivery: a silent (watch-shaped) job's working thread
      // never surfaces in chrome, and a job flipped audible must surface
      // again. Scoped to the job's dedicated channel only — a job bound to
      // a conversation session must never be hidden by a policy flip.
      const session = job.chatSessionId !== undefined
        ? state.chatSessions.find((s) => s.id === job.chatSessionId)
        : undefined;
      if (session?.kind === "channel") {
        if (deliveryPolicyPatch === "silent") session.headless = true;
        else if (session.headless) delete session.headless;
      }
    }

    // Skill attachments resolve inside the lock (same rationale as in
    // createScheduledJob): a throw here aborts the whole patch — no write.
    if (clearSkillNames) {
      job.skillNames = undefined;
    } else if (skillNamesPatch !== undefined) {
      assertSkillNamesResolve(state, skillNamesPatch);
      job.skillNames = skillNamesPatch;
    }

    job.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "job.updated",
        target: job.id,
        risk: "low"
      },
      { jobId: job.id, agentId: job.agentId }
    );
    return job;
  });
}

// Rebind a job's delivery mode, after creation. Tool-path only (the
// `update_job` tool's `deliverTo` field) — the raw PATCH /api/jobs stays
// permissive and never routes here. The job ALWAYS runs in its own dedicated
// Topic (ADR chat-topics-tasks-subagents.md, "Jobs → Topics"); `deliverTo` now
// toggles the `forwardToChat` flag, NOT the job's session binding. Semantics:
//   - "channel": set forwardToChat=false (deliver into the Topic only).
//   - "chat": set forwardToChat=true (each fire ALSO forwards its final answer
//     into the owning agent's Chat, tagged with the Topic). The Topic is NEVER
//     archived just because delivery moved to Chat.
// Either mode first ensures the job has a LIVE channel Topic: a job stuck on an
// archived channel, on a `kind:"agent"` session (a legacy deliverTo:"chat"
// rebind result), or with no session at all gets a FRESH dedicated channel
// session (kind "channel", origin "job", title = job name; bridge mirror
// preserved). No-op when the job already has a live Topic AND the forward flag
// already matches.
// Jobs with a preRunHook or fan-out routes are rejected: their sessions
// carry routing state (watcher dedupe anchors, per-concern channels) that
// a rebind would orphan.
// Everything happens inside ONE mutateState write so a validation failure
// leaves no half-rebound job or orphan channel.
export interface RebindJobDeliveryOptions {
  // Same trusted parent-task terminal re-check as the sibling mutators.
  parentTaskId?: string;
}

export type RebindJobDeliveryResult =
  | { outcome: "noop"; job: JobRecord }
  | { outcome: "rebound"; job: JobRecord; previousSessionId?: string };

export async function rebindJobDelivery(
  config: RuntimeConfig,
  jobId: string,
  deliverTo: "channel" | "chat",
  options: RebindJobDeliveryOptions = {}
): Promise<RebindJobDeliveryResult> {
  return mutateState(config.instance, (state) => {
    if (options.parentTaskId) {
      const parent = state.tasks.find((t) => t.id === options.parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot rebind job delivery: parent task ${options.parentTaskId} is already ${parent.status}.`);
      }
    }
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.preRunHook || (job.routes && Object.keys(job.routes).length > 0)) {
      throw new Error(`Cannot rebind job delivery: job ${jobId} has a preRunHook or fan-out routes, and its sessions carry routing state.`);
    }
    const current = job.chatSessionId !== undefined
      ? state.chatSessions.find((s) => s.id === job.chatSessionId)
      : undefined;
    // The job ALWAYS runs in its own dedicated Topic (ADR
    // chat-topics-tasks-subagents.md, "Jobs → Topics"); `deliverTo` now toggles
    // the `forwardToChat` flag, NOT the job's session binding. "chat" forwards
    // each fire's final answer into the owning agent's Chat (tagged with the
    // Topic); "channel" delivers into the Topic only. The Topic is never
    // archived just because delivery moved to Chat.
    const desiredForward = deliverTo === "chat";
    const hasLiveTopic = current !== undefined && current.kind === "channel" && !current.archivedAt;
    // No-op when the job already has a live Topic AND the forward flag already
    // matches — there is nothing to change.
    if (hasLiveTopic && (job.forwardToChat ?? false) === desiredForward) {
      return { outcome: "noop", job };
    }
    const previousSessionId = job.chatSessionId;
    // Ensure the job has a live channel Topic. A job stuck on an archived
    // channel, on a `kind:"agent"` session (a legacy deliverTo:"chat" rebind
    // result), or with no session at all gets a fresh dedicated Topic — an
    // archived channel is hidden from the lists, so leaving the job there would
    // make its fires invisible.
    if (!hasLiveTopic) {
      const session = createChatSession(state, job.name, undefined, job.agentId, "job", "channel");
      // Mirror createScheduledJob's create-time semantics: a job created from a
      // messaging-sourced conversation carries that conversation's `source`
      // onto its dedicated channel as `outboundMirror` so scheduled fires still
      // reach the bridge. `current` is either a conversation (carries `source`)
      // or an archived previously-dedicated channel (carries only
      // `outboundMirror`) — clone whichever is present so the rebind never
      // silently drops bridge delivery. Spread-cloned so a later mutation on
      // the old session's descriptor doesn't aliased-mutate the new channel's
      // copy within this write.
      const mirror = current?.source ?? current?.outboundMirror;
      if (mirror) session.outboundMirror = { ...mirror };
      // Preserve the mint invariant from createScheduledJob: a silent
      // (watch-shaped) job's working thread is always headless.
      if ((job.deliveryPolicy ?? "always") === "silent") session.headless = true;
      job.chatSessionId = session.id;
    }
    job.forwardToChat = desiredForward;
    job.updatedAt = now();
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.delivery.rebound",
        target: job.id,
        risk: "low",
        evidence: { deliverTo, forwardToChat: desiredForward, from: previousSessionId, to: job.chatSessionId }
      },
      { jobId: job.id, agentId: job.agentId }
    );
    return { outcome: "rebound", job, previousSessionId };
  });
}

export async function removeJob(config: RuntimeConfig, jobId: string, parentTaskId?: string) {
  return mutateState(config.instance, (state) => {
    // When invoked from the agent tool path with a `parentTaskId`, refuse
    // to delete if the parent task has gone terminal. The lock-free
    // pre-check in the tool handler is the fast path; this serialized
    // re-check is the authoritative guard against a `cancelTask` landing
    // between the pre-check and our write.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot delete job: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
    if (index < 0) throw new Error(`Job not found: ${jobId}`);
    const [job] = state.jobs.splice(index, 1);
    // Cascade-remove orphan JobRunRecords so /api/job-runs and replay
    // can't 500 on a vanished job. We splice in place instead of filter
    // because mutateState wants the same array reference.
    let removedRuns = 0;
    for (let i = state.jobRuns.length - 1; i >= 0; i -= 1) {
      if (state.jobRuns[i]!.jobId === job.id) {
        state.jobRuns.splice(i, 1);
        removedRuns += 1;
      }
    }
    // Archive the job's dedicated channel so it stops cluttering the
    // Recurring Jobs rails (web sidebar + mobile channels) once the job
    // that fed it is gone — otherwise the channel keeps matching the
    // clients' `(kind:"channel" || origin:"job") && !archivedAt` filter
    // with no job left to decorate it. Mirrors rebindJobDelivery's
    // deliverTo:"chat" archive: history is preserved and the session stays
    // addressable by id/URL, it just leaves the lists. Same guards as that
    // path — only a LIVE channel (already-archived re-stamping would lie
    // about when it left the lists), never an email-watch channel (the
    // email-watch subsystem owns those via its own delete/heal paths), and
    // never one another job still delivers into via its chatSessionId or a
    // fan-out route (raw POST/PATCH /api/jobs can bind several jobs to one
    // channel; archiving would hide their live delivery surface).
    let archivedSessionId: string | undefined;
    const channel = job.chatSessionId !== undefined
      ? state.chatSessions.find((s) => s.id === job.chatSessionId)
      : undefined;
    if (channel && channel.kind === "channel" && !channel.archivedAt && channel.feature !== "email-watch") {
      const shared = state.jobs.some(
        (other) =>
          other.chatSessionId === channel.id ||
          Object.values(other.routes ?? {}).some((route) => route.chatSessionId === channel.id)
      );
      if (!shared) {
        channel.archivedAt = now();
        channel.updatedAt = now();
        archivedSessionId = channel.id;
        addAudit(
          state,
          {
            actor: "user",
            action: "chat.session.archived",
            target: channel.id,
            risk: "low",
            evidence: { jobId: job.id, reason: "job.removed" }
          },
          { jobId: job.id, agentId: job.agentId }
        );
      }
    }
    addAudit(
      state,
      {
        actor: "user",
        action: "job.removed",
        target: job.id,
        risk: "medium",
        evidence: { removedRuns, ...(archivedSessionId ? { archivedSessionId } : {}) }
      },
      { jobId: job.id, agentId: job.agentId }
    );
    return job;
  });
}

export function listJobs(config: RuntimeConfig) {
  return readState(config.instance).jobs;
}

export function listJobRuns(config: RuntimeConfig, jobId?: string) {
  const runs = readState(config.instance).jobRuns;
  return jobId ? runs.filter((run) => run.jobId === jobId) : runs;
}

export async function replayJobRun(config: RuntimeConfig, runId: string) {
  const state = readState(config.instance);
  const run = state.jobRuns.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Job run not found: ${runId}`);
  // Cascade-removed jobs leave dangling runs only when state was migrated
  // from an older version. Today removeJob deletes runs alongside the job,
  // so this guard mainly serves replay-against-removed-job: surface a
  // typed error so the HTTP layer maps it to 404.
  const job = state.jobs.find((candidate) => candidate.id === run.jobId);
  if (!job) throw new Error(`Job not found: ${run.jobId}`);
  return runJobNow(config, run.jobId, "replay");
}

async function executeScriptJob(
  config: RuntimeConfig,
  jobId: string,
  runId: string,
  script: string,
  timeoutSeconds: number,
  trigger: "schedule" | "manual" | "replay"
) {
  try {
    const proc = spawn(["zsh", "-lc", script], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    return mutateState(config.instance, (state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      const run = state.jobRuns.find((candidate) => candidate.id === runId);
      // Defensive: don't throw if the job/run vanished (e.g. removeJob
      // raced with the script). Just return so the scheduler tick keeps
      // turning.
      if (!run) return { jobId, runId, exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) };
      run.status = exitCode === 0 ? "completed" : "failed";
      run.completedAt = now();
      run.updatedAt = run.completedAt;
      run.summary = stdout.slice(0, 4000);
      run.error = exitCode === 0 ? undefined : stderr.slice(0, 4000) || `Script exited ${exitCode}`;
      if (job) {
        if (exitCode === 0) {
          job.lastSuccessAt = run.completedAt;
          job.lastError = undefined;
          // Only force status="active" for scheduled runs. Manual/replay
          // successes leave the configured status untouched (so a paused
          // job stays paused after a manual run).
          if (trigger === "schedule") job.status = "active";
        } else {
          job.lastFailureAt = run.completedAt;
          job.lastError = run.error;
          // Same rule: only flip to "failed" for scheduled runs.
          if (trigger === "schedule") job.status = "failed";
        }
      }
      appendEvent(
        state,
        {
          kind: "job",
          action: exitCode === 0 ? "job.run.completed" : "job.run.failed",
          target: jobId,
          jobId,
          risk: "low",
          summary: exitCode === 0 ? "Script job completed." : "Script job failed.",
          data: { runId, exitCode, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) }
        },
        { jobId, agentId: job?.agentId ?? run.agentId }
      );
      addAudit(
        state,
        {
          actor: "runtime",
          action: "job.script.executed",
          target: jobId,
          risk: "medium",
          evidence: { runId, exitCode, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) }
        },
        { jobId, agentId: job?.agentId ?? run.agentId }
      );
      return { jobId, runId, exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (state) => {
      const run = state.jobRuns.find((candidate) => candidate.id === runId);
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!run) return;
      if (run.status !== "running") return;
      run.status = "failed";
      run.completedAt = now();
      run.updatedAt = run.completedAt;
      run.error = message;
      if (job) {
        job.lastFailureAt = run.completedAt;
        job.lastError = message;
        if (trigger === "schedule") job.status = "failed";
      }
      appendEvent(
        state,
        {
          kind: "job",
          action: "job.run.failed",
          target: jobId,
          jobId,
          risk: "low",
          summary: "Script job crashed.",
          data: { runId, error: message }
        },
        { jobId, agentId: job?.agentId ?? run.agentId }
      );
    });
    return { jobId, runId, exitCode: -1, stdout: "", stderr: message };
  }
}
