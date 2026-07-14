// Pure helpers for the People directory screen (testable without the DOM).
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import type { CrmExtractionStatus } from "@runtime/jobs/crm-extractor";

export type PeopleSort = "name" | "recent";
export type PeopleCategory = "all" | "Work" | "Personal";

export const SORT_ITEMS: Array<{ id: PeopleSort; label: string }> = [
  { id: "name", label: "Alphabetical" },
  { id: "recent", label: "Recent" },
];

export const CATEGORY_ITEMS: Array<{ id: PeopleCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "Work", label: "Work" },
  { id: "Personal", label: "Personal" },
];

export function fullName(contact: Pick<CrmContactSummary, "firstName" | "lastName">): string {
  return [contact.firstName, contact.lastName ?? ""].join(" ").trim();
}

// Up to two initials: "Priya Datawell" → PD, "Shelden" → S.
export function initials(contact: Pick<CrmContactSummary, "firstName" | "lastName">): string {
  return [contact.firstName, contact.lastName]
    .map((part) => (part ?? "").trim()[0] ?? "")
    .join("")
    .toUpperCase();
}

// The one-line role under the name in the detail panel: position @ company
// when known, otherwise the roster description.
export function roleLine(
  contact: Pick<CrmContactSummary, "position" | "company" | "description">,
): string {
  if (contact.position && contact.company) return `${contact.position} at ${contact.company}`;
  if (contact.position) return contact.position;
  if (contact.company) return contact.company;
  return contact.description ?? "";
}

// Compact relative timestamp for "Last spoke" / "Updated …".
export function relativeTime(epochMs: number | null, nowMs: number): string {
  if (!epochMs) return "—";
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function filterContacts(
  contacts: CrmContactSummary[],
  category: PeopleCategory,
): CrmContactSummary[] {
  if (category === "all") return contacts;
  // The self row stays visible under any category (it IS the user).
  return contacts.filter((c) => c.isSelf || (c.category ?? "").toLowerCase() === category.toLowerCase());
}

// "name" keeps the server's case-insensitive name order, with the user's own
// reserved row pinned first; "recent" orders by engagement recency (never-
// engaged rows sink, ties fall back to name order).
export function sortContacts(
  contacts: CrmContactSummary[],
  sort: PeopleSort,
): CrmContactSummary[] {
  const pinned = [...contacts].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
  if (sort === "name") return pinned;
  return pinned.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return Number(b.isSelf) - Number(a.isSelf);
    return (b.lastSpokeAt ?? 0) - (a.lastSpokeAt ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Extraction status — the "is the CRM going through my email?" indicator and
// the manual Start control. Both the toolbar line and the empty state read the
// same view model so they can never disagree about what the pipeline is doing.
// ---------------------------------------------------------------------------

export type ExtractionTone = "running" | "idle" | "paused" | "disabled";

export interface ExtractionView {
  tone: ExtractionTone;
  live: boolean; // animate the dot — a run is actively working
  label: string;
  hasAccount: boolean; // a mailbox is connected (start would not 400)
  canStart: boolean; // offer the manual Start/Resume/Refresh control
  startLabel: string; // "" when canStart is false
}

// Threads the pipeline has fully handled (done + skipped + error) — what the
// user reads as progress. pending/ingested are still in flight, not counted.
export function processedCount(status: CrmExtractionStatus): number {
  return status.counts.done + status.counts.skipped + status.counts.error;
}

// Poll fast while a run is active so the indicator feels live; fall back to the
// list's ambient cadence otherwise. Undefined (first load) polls at the idle
// rate. Feeds react-query's refetchInterval.
export function extractionRefetchMs(status: CrmExtractionStatus | undefined): number {
  return status?.runState === "running" ? 3000 : 30_000;
}

// The single view model behind both the toolbar status line and the empty
// state. Returns null before the first status resolves (nothing to show yet).
export function extractionView(
  status: CrmExtractionStatus | undefined,
  nowMs: number,
): ExtractionView | null {
  if (!status) return null;
  const hasAccount = status.source !== null;
  const processed = processedCount(status);
  const suffix = processed > 0 ? ` · ${processed.toLocaleString()} processed` : "";

  if (status.runState === "running") {
    return {
      tone: "running",
      live: true,
      label: processed > 0 ? `Scanning your mail — ${processed.toLocaleString()} processed` : "Scanning your mail…",
      hasAccount,
      canStart: false,
      startLabel: "",
    };
  }
  if (status.runState === "paused") {
    return { tone: "paused", live: false, label: `Paused${suffix}`, hasAccount, canStart: hasAccount, startLabel: "Resume" };
  }
  if (status.runState === "disabled") {
    return { tone: "disabled", live: false, label: "Extraction off", hasAccount, canStart: false, startLabel: "" };
  }
  // idle — never started this session (the pipeline stays "running" once it is,
  // so idle almost always means "has not run for this user yet").
  if (!hasAccount) {
    return {
      tone: "idle",
      live: false,
      label: "Connect a Google account to build your directory",
      hasAccount: false,
      canStart: false,
      startLabel: "",
    };
  }
  if (status.lastActivityAt) {
    return {
      tone: "idle",
      live: false,
      label: `Updated ${relativeTime(status.lastActivityAt, nowMs)}${suffix}`,
      hasAccount,
      canStart: true,
      startLabel: "Refresh",
    };
  }
  return { tone: "idle", live: false, label: "Not started yet", hasAccount, canStart: true, startLabel: "Scan my mail" };
}
