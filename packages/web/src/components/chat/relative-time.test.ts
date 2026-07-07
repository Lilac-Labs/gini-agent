// relative-time tests. Locale-rendered expectations (clock times, month/day)
// are computed with the same Intl calls the implementation uses, so the
// assertions hold under any test-runner locale.

import { describe, expect, test } from "bun:test";
import { formatMessageTimestamp, formatRecentTimestamp, formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  test("returns empty for unparseable or non-positive inputs", () => {
    expect(formatRelativeTime("not a date")).toBe("");
    expect(formatRelativeTime(0)).toBe("");
    expect(formatRelativeTime(-5)).toBe("");
  });

  test("clamps future timestamps to 'just now'", () => {
    expect(formatRelativeTime(Date.now() + 60_000)).toBe("just now");
  });

  test("buckets recent timestamps by age", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 30_000)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000 - 2_000)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000 - 2_000)).toBe("3h ago");
    expect(formatRelativeTime(now - 30 * 3_600_000)).toBe("Yesterday");
    expect(formatRelativeTime(now - 3 * 86_400_000 - 2_000)).toBe("3d ago");
    expect(formatRelativeTime(now - 14 * 86_400_000 - 2_000)).toBe("2w ago");
  });

  test("falls back to a month/day date beyond four weeks, accepting ISO strings", () => {
    const ts = Date.now() - 35 * 86_400_000;
    const expected = new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(formatRelativeTime(new Date(ts).toISOString())).toBe(expected);
  });
});

describe("formatRecentTimestamp", () => {
  test("returns empty for unparseable or non-positive inputs", () => {
    expect(formatRecentTimestamp("garbage")).toBe("");
    expect(formatRecentTimestamp(0)).toBe("");
  });

  test("same-day timestamps render the clock time only", () => {
    const now = Date.now();
    const expected = new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatRecentTimestamp(now)).toBe(expected);
  });

  test("older timestamps render the short month/day only", () => {
    const old = new Date();
    old.setDate(old.getDate() - 2);
    const expected = old.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(formatRecentTimestamp(old.toISOString())).toBe(expected);
  });
});

describe("formatMessageTimestamp", () => {
  test("returns empty for unparseable or non-positive inputs", () => {
    expect(formatMessageTimestamp("garbage")).toBe("");
    expect(formatMessageTimestamp(0)).toBe("");
  });

  test("same-day timestamps render the clock time only", () => {
    const now = Date.now();
    const expected = new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatMessageTimestamp(now)).toBe(expected);
  });

  test("calendar-yesterday timestamps are prefixed with 'Yesterday'", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const time = yesterday.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatMessageTimestamp(yesterday.toISOString())).toBe(`Yesterday ${time}`);
  });

  test("older timestamps render month/day plus the clock time", () => {
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const md = old.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = old.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(formatMessageTimestamp(old.toISOString())).toBe(`${md}, ${time}`);
  });
});
