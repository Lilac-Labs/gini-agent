// Authoritative agent system prompt + memory assembly.
//
// Lives outside provider.ts because the prompt is content (agent identity),
// not transport (LLM I/O). Both the legacy single-shot path in provider.ts
// and the chat-task agent loop in execution/ pull from here so they ship
// the same instructions to the model.

/// <reference path="./file-imports.d.ts" />
// The reference directive above makes the `*.md` file-import ambient type (for
// the `with { type: "file" }` import below) travel WITH this file across
// package boundaries. The runtime package's own tsconfig picks up
// file-imports.d.ts via its `src/**/*.ts` include, but the web/mobile packages
// follow `@runtime/*` imports into this module under THEIR tsconfig, which does
// not include the runtime's .d.ts — without this directive, tsc there can't
// resolve the .md module. See ADR compiled-runtime-binary.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentIdentity, ChatClientSurface, IdentitySnapshotRecord, JobRecord } from "./types";

// Number of user turns in the same chat session between full identity
// re-emissions. Below this threshold the model receives only field-level
// deltas (or nothing when nothing changed); at or above it the next turn
// re-emits the full identity block. Bounds the worst-case delta-
// reconstruction depth the model has to perform to recover ground-truth
// identity and gives the prompt cache a clean periodic resync point.
export const IDENTITY_FULL_REFRESH_INTERVAL = 10;

const IDENTITY_HEADER = "Your runtime identity:";
const IDENTITY_DELTA_HEADER = "Runtime identity changes since last turn:";

// Path to the canonical default operating-rules file. The bytes of this
// file are the single source of truth for the baseline preamble shipped
// with the runtime. `getDefaultGiniInstructions()` reads it on first call
// and caches the trimmed content; `scaffoldInstanceIdentityFiles` copies
// the same file bytes-as-is into freshly-installed instances. Keeping the
// two paths anchored on one disk artifact ensures the seeded
// INSTRUCTIONS.md and the runtime fallback never drift. See ADR
// runtime-identity-files.md.
export const DEFAULT_INSTRUCTIONS_PATH = join(import.meta.dir, "runtime", "defaults", "INSTRUCTIONS.md");

// Per-process memoized read. The file is a shipped build asset and never
// changes between calls; reading it on every chat turn would be wasted
// disk IO. We resolve it lazily so importing this module does not touch
// the filesystem (tests construct prompts without needing the asset).
let cachedDefaultInstructions: string | undefined;

// Active resolver for the default-instructions path. Production code uses
// the constant above; tests can swap a missing path in to exercise the
// failure-mode branch and restore the original via the reset helper.
let activeInstructionsPath: string = DEFAULT_INSTRUCTIONS_PATH;

// Read the canonical default operating-rules file and return its trimmed
// content. The bytes live in `src/runtime/defaults/INSTRUCTIONS.md` and
// ship with the runtime — a missing file is an unrecoverable build
// problem, so this throws loudly rather than falling back to a hardcoded
// sentinel. See ADR runtime-identity-files.md.
export function getDefaultGiniInstructions(): string {
  if (cachedDefaultInstructions !== undefined) return cachedDefaultInstructions;
  let raw: string;
  try {
    raw = readFileSync(activeInstructionsPath, "utf8");
  } catch (error) {
    throw new Error(
      `default INSTRUCTIONS.md missing from bundle at ${activeInstructionsPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  cachedDefaultInstructions = raw.trim();
  return cachedDefaultInstructions;
}

// Test-only: drop the memoized read and point the active path back at
// the bundled file (or to an overridden path for the failure-mode test).
// Production code must never call this — the bundled file does not change
// at runtime — so the helper is gated behind a `__` prefix to signal
// intent. Pass `undefined` to restore the default.
export function __resetDefaultGiniInstructionsCacheForTest(overridePath?: string): void {
  cachedDefaultInstructions = undefined;
  activeInstructionsPath = overridePath ?? DEFAULT_INSTRUCTIONS_PATH;
}

export interface AgentSystemContextOptions {
  // When set, replaces the default operating-rules preamble (from
  // `getDefaultGiniInstructions`). Sourced from
  // ~/.gini/instances/<inst>/INSTRUCTIONS.md by the call sites; absent
  // files fall back to the default.
  instructionsOverride?: string;
  // Per-agent persona body sourced from
  // ~/.gini/instances/<inst>/agents/<agentId>/SOUL.md. Sits between
  // instructions and the user profile in the stable prefix.
  soul?: string;
  // Instance-scoped user profile body sourced from
  // ~/.gini/instances/<inst>/USER.md. Last block of the stable prefix so the
  // model encounters "who am I talking to" before the per-turn ephemeral
  // tail (recalled memory) that follows the transcript.
  userProfile?: string;
}

// Soft caps surfaced to the model in the system-prompt block headers so
// the model can see how full the file is and self-manage consolidation.
// Deliberately not enforced — we never truncate identity content (hostile
// UX). The header just nudges the model to consolidate when usage gets
// high; the cap is a guideline, not a wall.
//
// 1500 chars is roughly 350-400 tokens, sized so a comfortably-populated
// USER.md / SOUL.md fits inside the typical per-turn budget without
// dominating the system prompt. The model can let either file overshoot
// — the budget line in the header just shifts to "over cap — please
// consolidate" and an audit trace fires.
export const USER_SOFT_CAP_CHARS = 1500;
export const SOUL_SOFT_CAP_CHARS = 1500;
// When usage crosses this fraction of the cap, the header reads
// "near cap — consolidate" to nudge the model to consolidate proactively
// rather than waiting to overshoot.
const BUDGET_NEAR_CAP_FRACTION = 0.8;

// Render a single-line budget header above a USER.md or SOUL.md block.
// The fraction is rounded to the nearest percent so the model sees a
// stable, clean number. Three regions:
//   - usage < 80% → "USER profile (412 / 1500 chars, 27%):"
//   - 80% ≤ usage ≤ 100% → adds " — near cap, consolidate"
//   - usage > 100% → "USER profile (1612 / 1500 chars, 107% — over cap, please consolidate):"
//
// The numerator is the actual character count of the block content;
// the denominator is the per-file soft cap above.
function renderBudgetHeader(label: string, content: string, softCapChars: number): string {
  const used = content.length;
  const pct = Math.round((used / softCapChars) * 100);
  if (used > softCapChars) {
    return `${label} (${used} / ${softCapChars} chars, ${pct}% — over cap, please consolidate):`;
  }
  if (used / softCapChars >= BUDGET_NEAR_CAP_FRACTION) {
    return `${label} (${used} / ${softCapChars} chars, ${pct}% — near cap, consolidate):`;
  }
  return `${label} (${used} / ${softCapChars} chars, ${pct}%):`;
}

export function renderUserProfileBlock(content: string): string {
  return `${renderBudgetHeader("USER profile", content, USER_SOFT_CAP_CHARS)}\n${content}`;
}

export function renderSoulBlock(content: string): string {
  return `${renderBudgetHeader("SOUL persona", content, SOUL_SOFT_CAP_CHARS)}\n${content}`;
}

// Pure inspection: report whether a USER.md / SOUL.md content blob is
// over the soft cap. Used by the call sites to emit an "over cap" trace
// event so operators can see the model is sailing past the budget.
export function identityBudgetState(
  content: string,
  softCapChars: number
): { used: number; cap: number; pct: number; overCap: boolean; nearCap: boolean } {
  const used = content.length;
  const pct = Math.round((used / softCapChars) * 100);
  return {
    used,
    cap: softCapChars,
    pct,
    overCap: used > softCapChars,
    nearCap: used / softCapChars >= BUDGET_NEAR_CAP_FRACTION
  };
}

// Assemble the byte-stable system-area prefix. The block order encodes a
// stable "agent → persona → user-curated facts" progression so the model
// encounters its own operating rules and persona before any user facts.
// Every block here is stable across turns for a fixed instance config, so
// the system message can serve as a warm prompt-cache prefix. Per-turn
// content (recalled memory, emitted identity) lives in an ephemeral
// role:"user" tail instead — see `renderEphemeralContext` and ADR
// stable-system-prefix.md.
//
// Order (each block elided when empty):
//   1. INSTRUCTIONS — operating rules (file override or default).
//   2. SOUL.md      — per-agent persona.
//   3. USER.md      — instance-scoped user profile.
//
// The legacy "Pinned memories about this user" block was removed when
// `state.memories` was consolidated into USER.md / SOUL.md / Hindsight.
// See ADR runtime-identity-files.md.
// Agent names flow into the system prompt (the runtime-identity block's
// "- agent: <name>" line and the per-agent SOUL.md seed), so they must
// stay a single-line label. Collapse every whitespace run (incl. embedded
// \n/\r/\t) to a single space and trim. Returns undefined when nothing
// is left, so callers can fall back. "Gini" is unchanged → byte-identical.
export function sanitizeAgentName(name: string | undefined): string | undefined {
  const collapsed = name?.replace(/\s+/g, " ").trim();
  return collapsed && collapsed.length > 0 ? collapsed : undefined;
}

export function buildAgentSystemContext(options?: AgentSystemContextOptions): string {
  const instructions = options?.instructionsOverride && options.instructionsOverride.trim().length > 0
    ? options.instructionsOverride
    : getDefaultGiniInstructions();
  const parts: string[] = [instructions];
  if (options?.soul && options.soul.trim().length > 0) {
    // BLOCKED notices are emitted by the load path as a one-line
    // sentinel; they're a safety message, not file content, so the
    // budget header is suppressed for them. Healthy bodies get a
    // budget header so the model can see how full the file is and
    // self-manage consolidation.
    parts.push(
      options.soul.startsWith("[BLOCKED:")
        ? options.soul
        : renderSoulBlock(options.soul)
    );
  }
  if (options?.userProfile && options.userProfile.trim().length > 0) {
    parts.push(
      options.userProfile.startsWith("[BLOCKED:")
        ? options.userProfile
        : renderUserProfileBlock(options.userProfile)
    );
  }
  return parts.join("\n\n");
}

// Render the ephemeral per-turn context body that rides in a role:"user"
// message placed after the full prior transcript and immediately before
// the real user message. It carries the per-turn-varying blocks that
// would break the cacheable system prefix:
//   1. client surface  — which surface the CURRENT message came from, when
//      known (see buildClientSurfaceBlock).
//   2. emitted identity — the tell-once/delta/refresh block, when emitted.
//   3. recalled memory  — Hindsight long-term memory for this turn's query.
// Blocks are joined by a blank line (identity before memory, as they used
// to sit in the system prompt); each is elided when empty. Returns ""
// when all are empty so the caller can skip injecting a tail message
// entirely. See ADR stable-system-prefix.md.
export function renderEphemeralContext(emittedIdentity?: string, recalledContext?: string, clientSurfaceNote?: string): string {
  const parts: string[] = [];
  if (clientSurfaceNote && clientSurfaceNote.length > 0) {
    parts.push(clientSurfaceNote);
  }
  if (emittedIdentity && emittedIdentity.length > 0) {
    parts.push(emittedIdentity);
  }
  if (recalledContext && recalledContext.trim().length > 0) {
    parts.push(`Long-term memory of prior conversations with this user (use these facts when answering):\n${recalledContext}`);
  }
  return parts.join("\n\n");
}

// Container-aware handoff framing for runs inside a surfaced task container
// (session kind "topic"/"channel", non-headless, non-subagent). Generic
// "prefer ask_user" instructions lose to chat-conversational habits because
// they read as style advice; the load-bearing signal is CONTEXTUAL — in a
// handed-off task container the user is watching home rows, not the thread,
// so a prose question reaches them only as the finished run's outcome line.
// The push toward ask_user carries an explicit carve-out for user-authored
// content (mirroring the tool description and INSTRUCTIONS.md): ask_user is
// options-only, and inventing options for substance only the user can author
// would misrepresent them. Injected per-container by the chat-task prompt
// assembly (INSTRUCTIONS.md cannot be conditional on container kind); the
// root agent Chat (the user IS in the thread) and headless channels (no user
// surface; ask_user is excluded there) never carry it. Constant bytes keep
// the per-session system prefix stable.
export const TASK_CONTAINER_HANDOFF_BLOCK =
  "This run executes a task the user handed off; they are not watching this thread. " +
  "If you need their input, call the ask_user tool with your best concrete options (its UI adds a free-text Other) — it parks the task as needs-input on their home screen, while a question asked in prose just ends the run, reaching them only as the finished task's outcome line. " +
  "Exception: when only the user can author the substance (their words, their voice, a decision between alternatives you cannot name), do NOT invent options — offer genuine direction options if any exist; otherwise end the run with the question as your final text so it becomes that outcome line.";

// Date-only line for the byte-stable system prefix (message 0). DATE
// granularity — not a timestamp — is the load-bearing choice: it keeps
// message 0 byte-identical across every turn within a local calendar day,
// so the automatic prefix cache stays warm; it rolls at most once per day.
// Anchoring the model on the real date stops it hallucinating the year from
// its training cutoff (the most common, silent failure). Precise wall-clock
// time is deliberately NOT here — it changes every minute and would bust the
// day-stable prefix — so the get_current_time tool serves it on demand.
// See ADR stable-system-prefix.md.
export function buildCurrentDateBlock(now: Date, timeZone: string): string {
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone
  });
  return `Current date: ${date} (${timeZone}). For the exact current wall-clock time, call get_current_time.`;
}

// Per-turn client-surface line for the ephemeral role:"user" tail. Names
// the surface the CURRENT inbound message was sent from and what that
// implies for a browser sign-in / handoff: the agent's browser is headless,
// and a sign-in or handoff surfaces as a LIVE IN-CHAT SCREENCAST of it that
// only the web app renders — so it reaches a user on the web app (or one at
// the gateway machine who can open it), but not a mobile or messaging-bridge
// user. Per-message (NOT in the byte-stable system prefix, and never cached
// per-session) because the same session can alternate between phone and
// desktop. Returns "" for an unknown surface so the prompt makes no claim
// rather than guessing. See ADR client-surface-context.md.
export function buildClientSurfaceBlock(surface: ChatClientSurface | undefined): string {
  switch (surface) {
    case "web":
      return "The user is messaging from the web app on a computer — the in-chat sign-in / handoff screencast of the agent's browser renders right here, so a browser handoff can reach them.";
    case "cli":
      return "The user is messaging from the CLI on the gateway machine — they can open the web app there to use the in-chat sign-in / handoff screencast, so a browser handoff can reach them.";
    case "mobile":
      return "The user is messaging from the mobile app on their phone — the in-chat browser screencast used for a sign-in / handoff isn't available there, so a browser handoff can't reach them.";
    case "telegram":
      return "The user is messaging from Telegram — the in-chat browser screencast used for a sign-in / handoff isn't available there, so a browser handoff can't reach them.";
    case "discord":
      return "The user is messaging from Discord — the in-chat browser screencast used for a sign-in / handoff isn't available there, so a browser handoff can't reach them.";
    case "slack":
      return "The user is messaging from Slack — the in-chat browser screencast used for a sign-in / handoff isn't available there, so a browser handoff can't reach them.";
    case "openclaw":
      return "The user is messaging through an OpenClaw bridge — the in-chat browser screencast used for a sign-in / handoff isn't available there, so a browser handoff can't reach them.";
    default:
      return "";
  }
}

// Structured, unambiguous current-time string returned by the
// get_current_time tool. Leads with the user's local wall clock (what
// "what time is it" asks for) and appends the absolute UTC ISO for a
// machine-precise, timezone-independent reference.
export function buildCurrentTimeResult(now: Date, timeZone: string): string {
  const human = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone
  });
  return `${human} (${timeZone}). UTC: ${now.toISOString()}`;
}

// Resolve the runtime's IANA timezone (e.g. "America/Los_Angeles"). The
// gateway runs on the user's machine, so this is the user's wall-clock zone.
// Single-sourced so the cacheable date block and the get_current_time tool
// always agree on the zone. Falls back to UTC if the runtime returns nothing
// (the spec requires a canonical name, so this guard is belt-and-suspenders).
export function resolveLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function describeToolsets(toolsets: string[]): string {
  return toolsets.length > 0 ? toolsets.join(", ") : "(none)";
}

// Render the full runtime-identity block. Emitted on the first turn of a
// conversation and at every IDENTITY_FULL_REFRESH_INTERVAL-th turn.
export function renderFullIdentity(identity: AgentIdentity): string {
  return [
    IDENTITY_HEADER,
    `- instance: ${identity.instance}`,
    `- runtime port: ${identity.runtimePort}`,
    `- agent: ${identity.agentName} (${identity.agentId})`,
    `- provider: ${identity.provider}`,
    `- toolsets enabled: ${describeToolsets(identity.toolsets)}`,
    `- memory namespace: ${identity.memoryNamespace}`
  ].join("\n");
}

// Render the field-level delta between two identity snapshots. Returns an
// empty string when nothing changed so the caller can omit the section
// entirely rather than emitting a header with no entries underneath.
export function renderIdentityDelta(prior: AgentIdentity, current: AgentIdentity): string {
  const changes: string[] = [];
  if (prior.instance !== current.instance) {
    changes.push(`- instance: ${current.instance} (was ${prior.instance})`);
  }
  if (prior.runtimePort !== current.runtimePort) {
    changes.push(`- runtime port: ${current.runtimePort} (was ${prior.runtimePort})`);
  }
  if (prior.agentName !== current.agentName || prior.agentId !== current.agentId) {
    changes.push(
      `- agent: ${current.agentName} (${current.agentId}) (was ${prior.agentName} (${prior.agentId}))`
    );
  }
  if (prior.provider !== current.provider) {
    changes.push(`- provider: ${current.provider} (was ${prior.provider})`);
  }
  const priorToolsets = describeToolsets(prior.toolsets);
  const currentToolsets = describeToolsets(current.toolsets);
  if (priorToolsets !== currentToolsets) {
    changes.push(`- toolsets enabled: ${currentToolsets} (was ${priorToolsets})`);
  }
  if (prior.memoryNamespace !== current.memoryNamespace) {
    changes.push(`- memory namespace: ${current.memoryNamespace} (was ${prior.memoryNamespace})`);
  }
  if (changes.length === 0) return "";
  return [IDENTITY_DELTA_HEADER, ...changes].join("\n");
}

// Pure decision: given the current identity, the persisted snapshot from
// the last turn, and the current turn index, decide what identity content
// (if any) to emit into the ephemeral role:"user" tail and what snapshot
// to persist for the next turn. Three outcomes:
//   - first turn or refresh due → full block, snapshot resets lastFullTurn
//   - delta non-empty           → delta block, snapshot keeps lastFullTurn
//   - delta empty               → "", no snapshot update
// The caller writes nextSnapshot to state only when it's defined.
export function decideIdentityEmission(
  current: AgentIdentity,
  snapshot: IdentitySnapshotRecord | undefined,
  currentTurn: number
): { content: string; nextSnapshot?: IdentitySnapshotRecord } {
  const refreshDue = snapshot ? currentTurn - snapshot.lastFullTurn >= IDENTITY_FULL_REFRESH_INTERVAL : true;
  if (refreshDue) {
    return {
      content: renderFullIdentity(current),
      nextSnapshot: { identity: current, lastFullTurn: currentTurn }
    };
  }
  const delta = renderIdentityDelta(snapshot!.identity, current);
  if (delta.length === 0) return { content: "" };
  return {
    content: delta,
    nextSnapshot: { identity: current, lastFullTurn: snapshot!.lastFullTurn }
  };
}

// Build a context block listing scheduled jobs that deliver into the
// current chat session. The chat-task loop scans `state.jobs` for any
// record whose `chatSessionId` matches the session backing the current
// task and passes the matching records here. The block is pure context —
// no directives about how the model should resolve user phrasing — so the
// model can infer relevance the same way it does for any other ambient
// state in the system prompt.
//
// Returns an empty string when no jobs apply — the caller can guard
// against stray whitespace by checking the empty case before appending.
export function buildBoundJobsBlock(jobs: JobRecord[]): string {
  if (jobs.length === 0) return "";
  const entries = jobs.map((job) => {
    const lines: string[] = [];
    lines.push(`- id: ${job.id}`);
    lines.push(`  name: ${job.name}`);
    lines.push(`  schedule: ${describeJobSchedule(job)}`);
    // Prompts are user-authored content, not untrusted external data, so we
    // include the full text. The model needs it to reason about edits like
    // "change the topic from X to Y" or "make it remind me about Z instead".
    appendPromptLines(lines, job.prompt);
    return lines.join("\n");
  });
  return [`Scheduled jobs delivering into this chat:`, ...entries].join("\n");
}

function describeJobSchedule(job: JobRecord): string {
  if (job.cronExpression) {
    const tz = job.cronTimezone ?? "UTC";
    return `cron \`${job.cronExpression}\` (${tz})`;
  }
  if (typeof job.intervalSeconds === "number") {
    return `every ${job.intervalSeconds}s`;
  }
  return "(no schedule)";
}

// Render the job's prompt onto `lines`. Single-line prompts (and the empty
// placeholder) sit inline after `prompt:`; multi-line prompts break onto
// their own indented block under a bare `prompt:` label so the inline
// branch never leaves a trailing space after the colon.
function appendPromptLines(lines: string[], prompt: string): void {
  if (!prompt) {
    lines.push(`  prompt: (empty)`);
    return;
  }
  if (!prompt.includes("\n")) {
    lines.push(`  prompt: ${prompt}`);
    return;
  }
  lines.push(`  prompt:`);
  for (const promptLine of prompt.split("\n")) {
    lines.push(`    ${promptLine}`);
  }
}
