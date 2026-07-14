import { describe, expect, test } from "bun:test";
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import type { CrmExtractionStatus } from "@runtime/jobs/crm-extractor";
import {
  CATEGORY_ITEMS,
  SORT_ITEMS,
  contactsRefetchMs,
  extractionRefetchMs,
  extractionView,
  filterContacts,
  fullName,
  initials,
  processedCount,
  relativeTime,
  roleLine,
  sortContacts,
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

  test("menu item catalogs are stable", () => {
    expect(SORT_ITEMS.map((s) => s.id)).toEqual(["name", "recent"]);
    expect(CATEGORY_ITEMS.map((c) => c.id)).toEqual(["all", "Work", "Personal"]);
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
