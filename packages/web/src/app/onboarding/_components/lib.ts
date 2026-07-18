import type { GoogleAccountStatus, OnboardingScan } from "@runtime/types";
import type { OnboardingRoutinesInput } from "@/lib/queries";

// Pure helpers for the onboarding steps. Kept DOM-free so they're directly
// unit-testable (see lib.test.ts).

// Step 2's toggle state, held in the page-level wizard state so it survives
// the step unmounting on 2 → 3 navigation. Shape-locked to the routines
// endpoint's input (minus the timezone, which step 1 owns).
export type RoutinesState = Required<Omit<OnboardingRoutinesInput, "timezone">>;

// The design's defaults: all three routines on, archive-unimportant off.
// Returns a fresh object per call so wizard state never aliases a shared
// module-level object.
export function defaultRoutinesState(): RoutinesState {
  return {
    autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
    morningBriefing: { enabled: true, personalizedNews: true },
    meetingBriefing: { enabled: true }
  };
}

// Whether the wizard shows the capability-derived provider step between
// sign-in and the welcome step: only on a definite "no provider configured"
// answer from /api/setup/status. An unresolved/failed probe must not block the funnel on a guess — the
// scan gating below degrades gracefully either way. The same predicate gates
// the Gmail scan kickoff: the scan's synthesis calls need the model, so
// without a provider it could only ever fail.
export function needsProviderStep(
  status: { providerConfigured: boolean } | undefined
): boolean {
  return status !== undefined && !status.providerConfigured;
}

// Which body the step-3 profile card renders. "idle" normally means the
// page's kickoff POST is about to fire, so it shows the loading state rather
// than flashing the fallback — but once the kickoff mutation has failed, idle
// would spin forever (nothing is running server-side), so it falls through to
// the friendly fallback instead. `scanUnavailable` (no provider configured —
// the user skipped the provider step, so the scan was never kicked off and
// retrying is pointless) short-circuits everything but a ready profile to the
// connect-a-model state: without it an idle scan would spin forever and a
// failed one would offer a "Try again" that can never succeed.
export function profileCardView(
  scan: OnboardingScan | undefined,
  kickoffFailed: boolean,
  scanUnavailable = false
): "loading" | "profile" | "fallback" | "unavailable" {
  if (scan?.status === "ready") return "profile";
  if (scanUnavailable) return "unavailable";
  if (!scan || scan.status === "running" || (scan.status === "idle" && !kickoffFailed)) return "loading";
  return "fallback";
}

// The request body seeding one step-5 task. Must match POST /api/containers
// (startTaskContainer): startedAs "task" is what keeps the seeded container a
// home work item instead of a Home Chats conversation, so a drift here
// silently strands seeded tasks off the task-first home.
export function seedTaskBody(content: string) {
  return { content, client: "web", startedAs: "task" } as const;
}

// Drop the first checked item matching `text` — used to remove a seeded task
// from the step-5 list the moment its POST lands, so a retry after a
// mid-sequence failure only re-sends the remainder.
export function removeSeededItem<T extends { text: string; checked: boolean }>(items: T[], text: string): T[] {
  const index = items.findIndex((item) => item.checked && item.text === text);
  return index < 0 ? items : items.filter((_, i) => i !== index);
}

// Only inbox-derived suggestions become one-click starter tasks. A missing,
// running, failed, or empty scan returns no rows: the tasks step may offer an
// empty state, but it must never seed broad prompts that hide which email or
// meeting Gini will actually work on.
export function suggestedTasksFrom(scan: OnboardingScan | undefined): string[] {
  return scan?.status === "ready" ? (scan.suggestedTasks ?? []) : [];
}

// Whether a scan that turned ready AFTER the step-5 snapshot was taken should
// replace the displayed list: only while the user hasn't touched it (no
// toggle, custom add, or seeding in flight), and only when the scan actually
// produced suggestions. Returns the replacement list, or undefined to keep
// the current one.
export function adoptScanSuggestions(
  scan: OnboardingScan | undefined,
  touched: boolean
): string[] | undefined {
  if (touched || scan?.status !== "ready") return undefined;
  const tasks = scan.suggestedTasks ?? [];
  return tasks.length > 0 ? tasks : undefined;
}

// Human-friendly label for an IANA timezone: "America/Los_Angeles" →
// "Pacific (Los Angeles)". Falls back to the bare city when Intl has no
// generic name for the zone (or the zone is unknown to the runtime).
export function timezoneLabel(zone: string): string {
  const city = (zone.split("/").pop() ?? zone).replace(/_/g, " ");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longGeneric"
    }).formatToParts(new Date());
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    // "Pacific Time" → "Pacific"; "China Standard Time" → "China".
    const region = name.replace(/\s+(Standard\s+|Daylight\s+)?Time$/, "");
    if (region && region !== city && !region.startsWith("GMT")) {
      return `${region} (${city})`;
    }
  } catch {
    // Unknown zone — fall through to the bare city.
  }
  return city;
}

// Split a profile bullet into plain-text and email-address segments so the
// step-3 renderer can linkify addresses in the accent color.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function splitEmailSegments(text: string): Array<{ text: string; email: boolean }> {
  const segments: Array<{ text: string; email: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(EMAIL_RE)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), email: false });
    segments.push({ text: match[0], email: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), email: false });
  return segments;
}

// The "Primary account" on the accounts step: the server-resolved `primary`
// flag means this runtime instance has explicitly selected that attached account.
// Credentials belonging only to other instances are omitted by the server.
export function primaryAccountId(accounts: GoogleAccountStatus[]): string | undefined {
  const flagged = accounts.find((account) => account.primary);
  return (flagged ?? accounts[0])?.id;
}

// Step-4 row order: the primary account renders first, the remaining rows
// keep registry order. Returns a new array; the input is never mutated.
export function accountsPrimaryFirst(accounts: GoogleAccountStatus[]): GoogleAccountStatus[] {
  const primary = primaryAccountId(accounts);
  return [
    ...accounts.filter((account) => account.id === primary),
    ...accounts.filter((account) => account.id !== primary)
  ];
}

// Where the connect-Google buttons send the tab. The gateway's Desktop-client
// PKCE flow runs through the BFF and returns to `returnTo` (with
// googleAddError=1 appended on failure). The gateway must build redirect_uri
// from the browser-facing origin but only sees the BFF's loopback hop, so the
// page passes its own origin along. The gateway validates that it is loopback.
// `intent` names what the completed OAuth does with the account: "signin"
// (the sign-in step's buttons) makes it the persisted primary — so the step-0
// card flips to the account the user just authorized — while "add" (the
// accounts step, the server-side default) never touches the primary. The
// param is only appended for "signin" to keep add-flow URLs unchanged.
export function connectGoogleUrl(
  returnTo: string,
  origin: string,
  intent: "signin" | "add" = "add"
): string {
  const intentParam = intent === "signin" ? "&intent=signin" : "";
  return `/api/runtime/google/login/start?returnTo=${encodeURIComponent(returnTo)}&origin=${encodeURIComponent(origin)}${intentParam}`;
}

// Where the "Reconnect" call-to-action sends the tab when the PRIMARY account's
// sign-in has been revoked. The same Desktop-client PKCE flow re-authorizes the
// account in place and carries signin intent so it is re-persisted as primary.
export function reloginPrimaryUrl(returnTo: string, origin: string): string {
  return connectGoogleUrl(returnTo, origin, "signin");
}

// Which sign-in call-to-action the entry step shows, driven by the PRIMARY
// account's state (the server-resolved primary, else the oldest — see
// primaryAccountId):
// - "reconnect": the primary exists but its sign-in was REVOKED (signed out and
//   tokenRevoked). The user must re-authorize the SAME account via the relogin
//   flow (reloginPrimaryUrl) — adding a different account won't heal it.
// - "continue": a signed-in primary exists — proceed as that account.
// - "connect": no usable primary (empty registry, or a signed-out primary that
//   was NOT revoked, e.g. sign-in still pending) — start a fresh connect.
export function signInCta(accounts: GoogleAccountStatus[]): "continue" | "connect" | "reconnect" {
  const primaryId = primaryAccountId(accounts);
  const primary = accounts.find((account) => account.id === primaryId);
  if (primary && !primary.signedIn && primary.tokenRevoked === true) return "reconnect";
  if (primary?.signedIn) return "continue";
  return "connect";
}

// The wizard's step sequence, held by NAME (not index): the provider step is
// capability-derived and can join the sequence after mount (the setup-status
// probe resolves async), so a numeric position could silently re-label the
// step the user is on. Sign-in and the provider step are prerequisite gates
// and carry no progress dot — the five product steps from "welcome" on are
// the dotted wizard regardless of which prerequisites a deployment needs.
export type OnboardingStep =
  | "signin"
  | "provider"
  | "welcome"
  | "routines"
  | "profile"
  | "accounts"
  | "tasks";

export function onboardingSteps(withProviderStep: boolean): OnboardingStep[] {
  return withProviderStep
    ? ["signin", "provider", "welcome", "routines", "profile", "accounts", "tasks"]
    : ["signin", "welcome", "routines", "profile", "accounts", "tasks"];
}

// Wizard step named by the ?step= query param. Adding a Google account is a
// same-tab OAuth round trip, so it returns the browser to
// /onboarding?step=accounts — the wizard re-enters on the accounts step
// instead of restarting at sign-in. Unknown or absent names start at sign-in.
const STEP_PARAMS: Record<string, OnboardingStep> = { accounts: "accounts" };

export function initialOnboardingStep(param: string | null | undefined): OnboardingStep {
  return STEP_PARAMS[param ?? ""] ?? "signin";
}
