import { describe, expect, test } from "bun:test";
import type { JobRecord } from "@runtime/types";
import { customRoutineJobs, isEmailWatchJob, jobDescription, jobDisplayName } from "./custom-jobs";

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "job_1",
    instance: "test",
    agentId: "agent_default",
    name: "morning-debrief",
    prompt: "Summarize my day.",
    status: "active",
    deliveryTargets: [],
    context: [],
    retryLimit: 0,
    timeoutSeconds: 600,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    missedRuns: 0,
    taskIds: [],
    runIds: [],
    ...overrides
  } as JobRecord;
}

describe("isEmailWatchJob", () => {
  test("true for the shared detector's structural marker (skill-script hook at gmail-watch)", () => {
    expect(
      isEmailWatchJob(
        job({ preRunHook: { handlerId: "skill-script", config: { skill: "gmail-watch", script: "detect", watches: [] } } })
      )
    ).toBe(true);
  });

  test("false for a plain job and for hooks at other skills", () => {
    expect(isEmailWatchJob(job({}))).toBe(false);
    // A chat-created watch job running some OTHER skill's script is a custom
    // routine, not email-watch infrastructure.
    expect(
      isEmailWatchJob(job({ preRunHook: { handlerId: "skill-script", config: { skill: "site-watch", script: "detect" } } }))
    ).toBe(false);
  });

  test("never matches by name — an ordinary routine titled 'Email watch' stays visible", () => {
    expect(isEmailWatchJob(job({ name: "Email watch" }))).toBe(false);
  });
});

describe("customRoutineJobs", () => {
  test("keeps chat-created routines (incl. paused), drops template installs and the shared detector", () => {
    const custom = job({ id: "job_a" });
    const paused = job({ id: "job_b", status: "paused" });
    const templated = job({ id: "job_c", templateId: "auto-inbox" });
    const detector = job({
      id: "job_d",
      preRunHook: { handlerId: "skill-script", config: { skill: "gmail-watch", script: "detect", watches: [] } }
    });
    expect(customRoutineJobs([custom, paused, templated, detector]).map((j) => j.id)).toEqual(["job_a", "job_b"]);
  });
});

describe("jobDisplayName", () => {
  test("humanizes dashes/underscores and capitalizes the first letter", () => {
    expect(jobDisplayName(job({ name: "morning-debrief" }))).toBe("Morning debrief");
    expect(jobDisplayName(job({ name: "linkedin_daily_connect" }))).toBe("Linkedin daily connect");
    expect(jobDisplayName(job({ name: "Weekly review" }))).toBe("Weekly review");
  });

  test("falls back to the raw name when it is all separators", () => {
    expect(jobDisplayName(job({ name: "--" }))).toBe("--");
  });
});

describe("jobDescription", () => {
  test("takes the prompt's first non-empty line", () => {
    expect(jobDescription(job({ prompt: "\n\n  Summarize my day.\nThen more detail." }))).toBe("Summarize my day.");
    expect(jobDescription(job({ prompt: "" }))).toBe("");
  });
});
