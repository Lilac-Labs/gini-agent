// Unit tests for the schedule-label helper used by the chat Jobs tab,
// the routine detail pages, and EditJobDialog. Three modes to cover:
//   - cron with TZ: cronstrue renders human English + we append "(TZ)"
//   - interval: humanized when the seconds divide cleanly into
//     minutes/hours/days; raw "every Ns" otherwise
//   - invalid cron: helper returns the raw expression so the UI doesn't
//     surface a stack trace under the input
//
// These are pure-JS tests (no React/DOM) — they import the helper module
// directly and exercise its return value.

import { describe, expect, test } from "bun:test";
import type { JobRecord } from "@runtime/types";
import { humanCron, scheduleLabel } from "./schedule-label";

function buildJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "job_test",
    instance: "test",
    name: "test",
    prompt: "x",
    status: "active",
    deliveryTargets: [],
    context: [],
    retryLimit: 0,
    timeoutSeconds: 600,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:01:00.000Z",
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    runIds: [],
    ...overrides
  };
}

describe("scheduleLabel", () => {
  test("cron with timezone renders human English + appended TZ", () => {
    const label = scheduleLabel(buildJob({
      cronExpression: "0 9 * * 1-5",
      cronTimezone: "America/Los_Angeles"
    }));
    // Exact wording is cronstrue's; we don't pin the whole string, but the
    // human-friendly fragment ("Monday through Friday") and the TZ suffix
    // must both appear.
    expect(label).toContain("Monday through Friday");
    expect(label).toContain("(America/Los_Angeles)");
    // No raw cron tokens leaked into the primary label.
    expect(label).not.toContain("* * 1-5");
  });

  test("cron without explicit TZ defaults to UTC suffix", () => {
    const label = scheduleLabel(buildJob({
      cronExpression: "0 9 * * 1-5"
    }));
    expect(label).toContain("Monday through Friday");
    expect(label).toContain("(UTC)");
  });

  test("clean intervals humanize into the largest dividing unit", () => {
    expect(scheduleLabel(buildJob({ intervalSeconds: 60 }))).toBe("every minute");
    expect(scheduleLabel(buildJob({ intervalSeconds: 600 }))).toBe("every 10 minutes");
    expect(scheduleLabel(buildJob({ intervalSeconds: 3600 }))).toBe("every hour");
    expect(scheduleLabel(buildJob({ intervalSeconds: 7200 }))).toBe("every 2 hours");
    expect(scheduleLabel(buildJob({ intervalSeconds: 86400 }))).toBe("every day");
    expect(scheduleLabel(buildJob({ intervalSeconds: 172800 }))).toBe("every 2 days");
    // 90 minutes divides into minutes, not hours — the largest CLEAN unit wins.
    expect(scheduleLabel(buildJob({ intervalSeconds: 5400 }))).toBe("every 90 minutes");
  });

  test("odd second counts keep the raw 'every Ns' shape", () => {
    expect(scheduleLabel(buildJob({ intervalSeconds: 45 }))).toBe("every 45s");
    expect(scheduleLabel(buildJob({ intervalSeconds: 90 }))).toBe("every 90s");
  });

  test("invalid cron falls back to the raw expression + TZ", () => {
    const label = scheduleLabel(buildJob({
      cronExpression: "this is not cron",
      cronTimezone: "UTC"
    }));
    // The raw expression survives the fallback so power users can still
    // read what was stored.
    expect(label).toContain("this is not cron");
    expect(label).toContain("(UTC)");
  });

  test("missing intervalSeconds AND no cron renders an explicit marker", () => {
    // Defensive: a hand-edited / migrated record with no schedule fields
    // shouldn't render "every undefineds".
    const label = scheduleLabel(buildJob({ intervalSeconds: undefined }));
    expect(label).toBe("(no schedule)");
  });
});

describe("humanCron", () => {
  test("returns human English for a valid expression", () => {
    expect(humanCron("0 9 * * 1-5")).toContain("Monday through Friday");
  });

  test("returns null for an empty expression", () => {
    expect(humanCron("")).toBeNull();
    expect(humanCron("   ")).toBeNull();
  });

  test("returns null for an unparseable expression (no exception leaks)", () => {
    // cronstrue throws on malformed input when throwExceptionOnParseError
    // is true — the helper must catch and return null so the UI can hide
    // the helper line rather than surface a stack trace.
    expect(humanCron("not a cron")).toBeNull();
    // Wrong field count.
    expect(humanCron("0 9 * *")).toBeNull();
  });
});
