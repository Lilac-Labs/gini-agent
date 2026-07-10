// Pure helpers for the People directory screen (testable without the DOM).
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";

export type PeopleSort = "name" | "recent";
export type PeopleFilter = "all" | "engaged" | "not-engaged";
export type PeopleCategory = "all" | "Work" | "Personal";

export const SORT_ITEMS: Array<{ id: PeopleSort; label: string }> = [
  { id: "name", label: "Alphabetical" },
  { id: "recent", label: "Recent" },
];

export const FILTER_ITEMS: Array<{ id: PeopleFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "engaged", label: "Engaged" },
  { id: "not-engaged", label: "Not engaged" },
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
  filter: PeopleFilter,
  category: PeopleCategory = "all",
): CrmContactSummary[] {
  let kept = contacts;
  if (filter === "engaged") kept = kept.filter((c) => c.isSelf || c.lastSpokeAt !== null);
  if (filter === "not-engaged") kept = kept.filter((c) => !c.isSelf && c.lastSpokeAt === null);
  if (category !== "all") {
    // The self row stays visible under any category (it IS the user).
    kept = kept.filter((c) => c.isSelf || (c.category ?? "").toLowerCase() === category.toLowerCase());
  }
  return kept;
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
