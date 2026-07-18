// Pure helpers for the People directory screen (testable without the DOM).
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import type { CrmExtractionStatus } from "@runtime/jobs/crm-extractor";

export type PeopleSort = "name" | "recent";
export type PeopleCategory = "all" | "Work" | "Personal";

// Recent first: it's the default sort, and the dropdown lists it at the top.
export const SORT_ITEMS: Array<{ id: PeopleSort; label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "name", label: "Alphabetical" },
];

// The default the People page opens on — most-recently-engaged first.
export const DEFAULT_SORT: PeopleSort = "recent";

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

// Free-text search over the fields a user scans by: name, company, email,
// position, and the one-line description. Case/whitespace-insensitive; a blank
// query is a no-op. Unlike the category filter, search does NOT pin the self
// row — a search is a deliberate lookup, so "you" only matches if it matches.
export function searchContacts(contacts: CrmContactSummary[], query: string): CrmContactSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return contacts;
  return contacts.filter((c) => {
    const haystack = [fullName(c), c.company, c.email, c.position, c.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

// The list description is a one-line handle; long doss's-worth summaries blow
// out the row height, so clamp to a sensible width with an ellipsis. Cuts on a
// word boundary when one is near the limit so a word isn't sliced mid-token.
export const DESCRIPTION_MAX = 100;
export function truncateDescription(description: string | null | undefined, max = DESCRIPTION_MAX): string {
  const text = (description ?? "").trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > max - 15 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
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

// Fixed page size for the People table — kept small so the list fits without
// scrolling (rows are tall: avatar, company, multi-line description).
export const PAGE_SIZE = 10;

export interface Page<T> {
  items: T[];
  page: number; // clamped, 1-based
  pageCount: number; // always >= 1
  total: number;
  start: number; // 1-based index of the first item shown (0 when empty)
  end: number; // 1-based index of the last item shown (0 when empty)
}

// Slice `items` to the requested 1-based page. `page` is clamped into range so
// a stale page number (e.g. after a search shrinks the list) can't strand the
// user on an empty page — it snaps to the last page instead.
export function paginate<T>(items: T[], page = 1, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const startIdx = (clamped - 1) * pageSize;
  const slice = items.slice(startIdx, startIdx + pageSize);
  return {
    items: slice,
    page: clamped,
    pageCount,
    total,
    start: total === 0 ? 0 : startIdx + 1,
    end: startIdx + slice.length,
  };
}

// ---------------------------------------------------------------------------
// Extraction status — the "is the CRM going through my email?" indicator and
// the manual Sync control. Both the toolbar line and the empty state read the
// same view model so they can never disagree about what the pipeline is doing.
// ---------------------------------------------------------------------------

export type ExtractionTone = "running" | "idle" | "paused" | "disabled";

export interface ExtractionView {
  tone: ExtractionTone;
  live: boolean; // animate the dot — a run is actively working
  label: string;
  hasAccount: boolean; // a mailbox is connected (sync would not 400)
  canSync: boolean; // offer the manual Sync control (mailbox present, not disabled)
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

// The contacts list itself: refresh briskly while a run is active so people a
// manual Sync just found appear within seconds, not after the ambient minute.
export function contactsRefetchMs(status: CrmExtractionStatus | undefined): number {
  return status?.runState === "running" ? 5000 : 60_000;
}

// The single view model behind both the toolbar status line and the empty
// state. Returns null before the first status resolves (nothing to show yet).
export function extractionView(
  status: CrmExtractionStatus | undefined,
  nowMs: number,
): ExtractionView | null {
  if (!status) return null;
  const hasAccount = status.source !== null;
  // Sync is offered whenever a mailbox is connected and extraction isn't
  // disabled: it starts an idle pipeline, resumes a paused one, and forces an
  // immediate poll on a running one.
  const canSync = hasAccount && status.runState !== "disabled";
  const processed = processedCount(status);
  const suffix = processed > 0 ? ` · ${processed.toLocaleString()} processed` : "";

  if (status.runState === "running") {
    // "running" is a persistent state — the watcher keeps polling forever once
    // caught up. Only pulse "Scanning…" while work is actually in flight; once
    // the backlog drains, settle to a calm "Up to date" so a live watcher with
    // nothing to do doesn't look like it's forever mid-scan.
    const working = status.counts.pending + status.counts.ingested > 0 || status.inFlightTurns > 0;
    if (working) {
      return {
        tone: "running",
        live: true,
        label: processed > 0 ? `Scanning your mail — ${processed.toLocaleString()} processed` : "Scanning your mail…",
        hasAccount,
        canSync,
      };
    }
    return {
      tone: "running",
      live: false,
      label: processed > 0 ? `Up to date · ${processed.toLocaleString()} processed` : "Up to date",
      hasAccount,
      canSync,
    };
  }
  if (status.runState === "paused") {
    return { tone: "paused", live: false, label: `Paused${suffix}`, hasAccount, canSync };
  }
  if (status.runState === "disabled") {
    return { tone: "disabled", live: false, label: "Extraction off", hasAccount, canSync };
  }
  // idle — the pipeline stays "running" once it is, so idle almost always means
  // "has not run for this user yet".
  if (!hasAccount) {
    return { tone: "idle", live: false, label: "Connect a Google account to build your directory", hasAccount, canSync };
  }
  if (status.lastActivityAt) {
    return { tone: "idle", live: false, label: `Updated ${relativeTime(status.lastActivityAt, nowMs)}${suffix}`, hasAccount, canSync };
  }
  return { tone: "idle", live: false, label: "Not started yet", hasAccount, canSync };
}
