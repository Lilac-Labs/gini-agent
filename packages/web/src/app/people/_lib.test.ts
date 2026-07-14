import { describe, expect, test } from "bun:test";
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import type { CrmExtractionStatus } from "@runtime/jobs/crm-extractor";
import {
  CATEGORY_ITEMS,
  DEFAULT_SORT,
  DESCRIPTION_MAX,
  PAGE_SIZE,
  SORT_ITEMS,
  contactsRefetchMs,
  extractionRefetchMs,
  extractionView,
  filterContacts,
  fullName,
  initials,
  paginate,
  processedCount,
  relativeTime,
  roleLine,
  searchContacts,
  sortContacts,
  truncateDescription,
} from "./_lib";

function contact(over: Partial<CrmContactSummary> & { id: string; firstName: string }): CrmContactSummary {
  return {
    lastName: null,
    email: null,
    company: null,
    position: null,
    category: null,
    phone: null,
    url: null,
    description: null,
    lastSpokeAt: null,
    updatedAt: null,
    isSelf: false,
    ...over,
  };
}

describe("people/_lib", () => {
  test("fullName and initials handle single and double names", () => {
    expect(fullName({ firstName: "Priya", lastName: "Datawell" })).toBe("Priya Datawell");
    expect(fullName({ firstName: "Shelden", lastName: null })).toBe("Shelden");
    expect(initials({ firstName: "Priya", lastName: "Datawell" })).toBe("PD");
    expect(initials({ firstName: "Shelden", lastName: null })).toBe("S");
    expect(initials({ firstName: "", lastName: null })).toBe("");
  });

  test("roleLine prefers position at company, degrades gracefully", () => {
    expect(roleLine({ position: "CEO", company: "Slashy", description: "d" })).toBe("CEO at Slashy");
    expect(roleLine({ position: "CEO", company: null, description: "d" })).toBe("CEO");
    expect(roleLine({ position: null, company: "Slashy", description: "d" })).toBe("Slashy");
    expect(roleLine({ position: null, company: null, description: "d" })).toBe("d");
    expect(roleLine({ position: null, company: null, description: null })).toBe("");
  });

  test("relativeTime buckets", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe("3mo ago");
    expect(relativeTime(now - 3 * 365 * 86_400_000, now)).toBe("3y ago");
    expect(relativeTime(now + 60_000, now)).toBe("just now"); // clock skew clamps
  });

  test("filterContacts: category matches case-insensitively and always keeps the self row", () => {
    const you = contact({ id: "you", firstName: "You", isSelf: true });
    const work = contact({ id: "w", firstName: "Ada", category: "work", lastSpokeAt: 5 });
    const personal = contact({ id: "p", firstName: "Bea", category: "Personal", lastSpokeAt: 6 });
    const uncategorized = contact({ id: "u", firstName: "Cy", lastSpokeAt: 7 });
    const all = [you, work, personal, uncategorized];
    expect(filterContacts(all, "all")).toEqual(all);
    expect(filterContacts(all, "Work").map((c) => c.id)).toEqual(["you", "w"]);
    expect(filterContacts(all, "Personal").map((c) => c.id)).toEqual(["you", "p"]);
  });

  test("sortContacts pins self first; recent orders by lastSpokeAt desc with never-engaged last", () => {
    const you = contact({ id: "you", firstName: "You", isSelf: true });
    const older = contact({ id: "older", firstName: "Alice", lastSpokeAt: 10 });
    const newer = contact({ id: "newer", firstName: "Zoe", lastSpokeAt: 20 });
    const never = contact({ id: "never", firstName: "Bob" });
    // Server order is name-sorted; self is pinned to the top either way.
    expect(sortContacts([older, never, you, newer], "name").map((c) => c.id)).toEqual([
      "you", "older", "never", "newer",
    ]);
    expect(sortContacts([older, never, you, newer], "recent").map((c) => c.id)).toEqual([
      "you", "newer", "older", "never",
    ]);
  });

  test("menu item catalogs are stable; Recent leads and is the default", () => {
    expect(SORT_ITEMS.map((s) => s.id)).toEqual(["recent", "name"]);
    expect(DEFAULT_SORT).toBe("recent");
    expect(CATEGORY_ITEMS.map((c) => c.id)).toEqual(["all", "Work", "Personal"]);
  });

  test("searchContacts matches across name, company, email, position, and description", () => {
    const rows = [
      contact({ id: "a", firstName: "Priya", lastName: "Datawell", company: "Northwind", email: "priya@northwind.io", position: "VP Sales", description: "met at a dinner" }),
      contact({ id: "b", firstName: "Tomasz", lastName: "Vega", company: "Meridian Freight", email: "tv@meridian.io", description: "logistics lead" }),
      contact({ id: "c", firstName: "You", isSelf: true }),
    ];
    expect(searchContacts(rows, "northwind").map((c) => c.id)).toEqual(["a"]); // company
    expect(searchContacts(rows, "VEGA").map((c) => c.id)).toEqual(["b"]); // name, case-insensitive
    expect(searchContacts(rows, "meridian.io").map((c) => c.id)).toEqual(["b"]); // email
    expect(searchContacts(rows, "vp sales").map((c) => c.id)).toEqual(["a"]); // position
    expect(searchContacts(rows, "dinner").map((c) => c.id)).toEqual(["a"]); // description
    expect(searchContacts(rows, "  ").map((c) => c.id)).toEqual(["a", "b", "c"]); // blank = no-op, self included
    expect(searchContacts(rows, "nobody")).toEqual([]);
    // Search does not pin the self row — it only appears if it matches.
    expect(searchContacts(rows, "you").map((c) => c.id)).toEqual(["c"]);
    expect(searchContacts(rows, "priya").map((c) => c.id)).toEqual(["a"]);
  });

  test("truncateDescription clamps at the limit with an ellipsis, on a word boundary", () => {
    expect(truncateDescription(null)).toBe("");
    expect(truncateDescription("short and sweet")).toBe("short and sweet");
    const exactly100 = "x".repeat(100);
    expect(truncateDescription(exactly100)).toBe(exactly100); // <= max is untouched
    const long = "Alice Nakamura is the founder and CEO of Slashy, a fintech startup she launched in 2024 after leaving Google";
    const out = truncateDescription(long);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX + 1); // + the ellipsis char
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
    // A no-space blob past the limit is hard-cut (no boundary near the end).
    const blob = "a".repeat(150);
    expect(truncateDescription(blob)).toBe("a".repeat(100) + "…");
  });

  test("paginate slices, reports the window, and clamps out-of-range pages", () => {
    const items = Array.from({ length: 57 }, (_, i) => i);
    const p1 = paginate(items, 1, 25);
    expect(p1.items).toEqual(items.slice(0, 25));
    expect(p1).toMatchObject({ page: 1, pageCount: 3, total: 57, start: 1, end: 25 });
    const p3 = paginate(items, 3, 25);
    expect(p3.items).toEqual(items.slice(50, 57));
    expect(p3).toMatchObject({ page: 3, pageCount: 3, start: 51, end: 57 });
    // Over-range snaps to the last page; under-range/garbage snaps to 1.
    expect(paginate(items, 99, 25).page).toBe(3);
    expect(paginate(items, 0, 25).page).toBe(1);
    expect(paginate(items, -5, 25).page).toBe(1);
    // Empty list is one empty page with a zeroed window.
    expect(paginate([], 1, 25)).toMatchObject({ items: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
    // Default page size is applied when omitted.
    expect(paginate(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => i)).pageCount).toBe(2);
  });
});

function status(over: Partial<CrmExtractionStatus> = {}): CrmExtractionStatus {
  return {
    runState: "idle",
    counts: { pending: 0, ingested: 0, done: 0, skipped: 0, error: 0 },
    backfillSeeded: false,
    mailCursor: null,
    inFlightTurns: 0,
    selfEmail: null,
    selfAddresses: [],
    accounts: [],
    agentId: null,
    subagentId: null,
    turnModel: null,
    source: "gmail",
    lastError: null,
    lastActivityAt: null,
    ...over,
  };
}

describe("people/_lib extraction status", () => {
  test("processedCount sums done+skipped+error, ignoring in-flight rows", () => {
    expect(processedCount(status({ counts: { pending: 9, ingested: 7, done: 1000, skipped: 200, error: 34 } }))).toBe(1234);
    expect(processedCount(status())).toBe(0);
  });

  test("extractionRefetchMs polls fast only while running", () => {
    expect(extractionRefetchMs(undefined)).toBe(30_000);
    expect(extractionRefetchMs(status({ runState: "running" }))).toBe(3000);
    expect(extractionRefetchMs(status({ runState: "idle" }))).toBe(30_000);
    expect(extractionRefetchMs(status({ runState: "paused" }))).toBe(30_000);
    expect(extractionRefetchMs(status({ runState: "disabled" }))).toBe(30_000);
  });

  test("contactsRefetchMs refreshes the list briskly only while running", () => {
    expect(contactsRefetchMs(undefined)).toBe(60_000);
    expect(contactsRefetchMs(status({ runState: "running" }))).toBe(5000);
    expect(contactsRefetchMs(status({ runState: "idle" }))).toBe(60_000);
    expect(contactsRefetchMs(status({ runState: "paused" }))).toBe(60_000);
  });

  const NOW = 1_700_000_000_000;

  test("no status yet → null (nothing to render)", () => {
    expect(extractionView(undefined, NOW)).toBeNull();
  });

  test("running with a queue backlog: pulsing dot, scanning label, syncable", () => {
    expect(extractionView(status({ runState: "running", counts: { pending: 5, ingested: 0, done: 0, skipped: 0, error: 0 } }), NOW)).toEqual({
      tone: "running",
      live: true,
      label: "Scanning your mail…",
      hasAccount: true,
      canSync: true,
    });
  });

  test("running with work in flight: label carries the localized processed count", () => {
    const v = extractionView(
      status({ runState: "running", counts: { pending: 3, ingested: 0, done: 1200, skipped: 30, error: 4 } }),
      NOW,
    );
    expect(v?.label).toBe("Scanning your mail — 1,234 processed");
    expect(v?.live).toBe(true);
  });

  test("running with an in-flight turn but an empty queue still counts as working", () => {
    const v = extractionView(status({ runState: "running", counts: { pending: 0, ingested: 0, done: 2, skipped: 0, error: 0 }, inFlightTurns: 1 }), NOW);
    expect(v?.live).toBe(true);
    expect(v?.label).toBe("Scanning your mail — 2 processed");
  });

  test("running with the backlog drained: calm 'Up to date', not a perpetual scan", () => {
    expect(extractionView(status({ runState: "running", counts: { pending: 0, ingested: 0, done: 82, skipped: 1602, error: 0 } }), NOW)).toEqual({
      tone: "running",
      live: false,
      label: "Up to date · 1,684 processed",
      hasAccount: true,
      canSync: true,
    });
  });

  test("running, caught up with nothing processed yet: bare 'Up to date'", () => {
    expect(extractionView(status({ runState: "running" }), NOW)?.label).toBe("Up to date");
  });

  test("paused: amber, syncable, keeps the processed suffix", () => {
    expect(extractionView(status({ runState: "paused", counts: { pending: 0, ingested: 0, done: 5, skipped: 0, error: 0 } }), NOW)).toEqual({
      tone: "paused",
      live: false,
      label: "Paused · 5 processed",
      hasAccount: true,
      canSync: true,
    });
  });

  test("paused with nothing processed drops the suffix", () => {
    expect(extractionView(status({ runState: "paused" }), NOW)?.label).toBe("Paused");
  });

  test("disabled: off, no sync control", () => {
    expect(extractionView(status({ runState: "disabled" }), NOW)).toEqual({
      tone: "disabled",
      live: false,
      label: "Extraction off",
      hasAccount: true,
      canSync: false,
    });
  });

  test("idle without a mailbox: connect prompt, no sync control", () => {
    expect(extractionView(status({ runState: "idle", source: null }), NOW)).toEqual({
      tone: "idle",
      live: false,
      label: "Connect a Google account to build your directory",
      hasAccount: false,
      canSync: false,
    });
  });

  test("idle with a mailbox, never run: 'Not started yet' + syncable", () => {
    expect(extractionView(status({ runState: "idle" }), NOW)).toEqual({
      tone: "idle",
      live: false,
      label: "Not started yet",
      hasAccount: true,
      canSync: true,
    });
  });

  test("idle with prior activity: shows relative update time and stays syncable", () => {
    const v = extractionView(
      status({ runState: "idle", lastActivityAt: NOW - 3 * 3_600_000, counts: { pending: 0, ingested: 0, done: 42, skipped: 0, error: 0 } }),
      NOW,
    );
    expect(v).toEqual({
      tone: "idle",
      live: false,
      label: "Updated 3h ago · 42 processed",
      hasAccount: true,
      canSync: true,
    });
  });

  test("fixture source still counts as a connected mailbox", () => {
    expect(extractionView(status({ runState: "idle", source: "fixture" }), NOW)?.hasAccount).toBe(true);
  });
});
