import { describe, expect, test } from "bun:test";
import type { CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import {
  CATEGORY_ITEMS,
  FILTER_ITEMS,
  SORT_ITEMS,
  filterContacts,
  fullName,
  initials,
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

  test("filterContacts: engaged keeps self + spoken-to; not-engaged is the complement", () => {
    const you = contact({ id: "you", firstName: "You", isSelf: true });
    const friend = contact({ id: "f", firstName: "Friend", lastSpokeAt: 5 });
    const cold = contact({ id: "c", firstName: "Cold" });
    const all = [you, friend, cold];
    expect(filterContacts(all, "all")).toEqual(all);
    expect(filterContacts(all, "engaged").map((c) => c.id)).toEqual(["you", "f"]);
    expect(filterContacts(all, "not-engaged").map((c) => c.id)).toEqual(["c"]);
  });

  test("filterContacts: category matches case-insensitively, keeps self, composes with status", () => {
    const you = contact({ id: "you", firstName: "You", isSelf: true });
    const work = contact({ id: "w", firstName: "Ada", category: "work", lastSpokeAt: 5 });
    const personal = contact({ id: "p", firstName: "Bea", category: "Personal", lastSpokeAt: 6 });
    const uncategorized = contact({ id: "u", firstName: "Cy", lastSpokeAt: 7 });
    const all = [you, work, personal, uncategorized];
    expect(filterContacts(all, "all", "all")).toEqual(all);
    expect(filterContacts(all, "all", "Work").map((c) => c.id)).toEqual(["you", "w"]);
    expect(filterContacts(all, "all", "Personal").map((c) => c.id)).toEqual(["you", "p"]);
    // Composed: engaged ∩ Personal (self passes both).
    expect(filterContacts(all, "engaged", "Personal").map((c) => c.id)).toEqual(["you", "p"]);
    expect(filterContacts([contact({ id: "cold", firstName: "Z", category: "Work" })], "engaged", "Work")).toEqual([]);
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
    expect(FILTER_ITEMS.map((f) => f.id)).toEqual(["all", "engaged", "not-engaged"]);
    expect(CATEGORY_ITEMS.map((c) => c.id)).toEqual(["all", "Work", "Personal"]);
  });
});
