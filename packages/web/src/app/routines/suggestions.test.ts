import { describe, expect, test } from "bun:test";
import { routineSetupTask, suggestedRoutinesFrom } from "./suggestions";

const EMAIL_SUGGESTION = {
  name: "Draft a weekly founder update",
  description: "Turn recent work and email context into a founder-update draft for review.",
  usesEmail: true
};

describe("suggestedRoutinesFrom", () => {
  test("returns only suggestions from a ready onboarding scan", () => {
    expect(suggestedRoutinesFrom({ status: "ready", suggestedRoutines: [EMAIL_SUGGESTION] })).toEqual([
      EMAIL_SUGGESTION
    ]);
    expect(suggestedRoutinesFrom({ status: "running", suggestedRoutines: [EMAIL_SUGGESTION] })).toEqual([]);
    expect(suggestedRoutinesFrom({ status: "ready" })).toEqual([]);
    expect(suggestedRoutinesFrom(undefined)).toEqual([]);
  });
});

describe("routineSetupTask", () => {
  test("asks for cadence and email accounts before creating an email routine", () => {
    expect(routineSetupTask(EMAIL_SUGGESTION)).toEqual({
      title: "Create a routine: Draft a weekly founder update",
      content: [
        "Create the suggested routine “Draft a weekly founder update” for me.",
        "Turn recent work and email context into a founder-update draft for review.",
        "Before creating it, ask me how often it should run and which connected email account or accounts it should use. After I answer the setup questions, create the scheduled routine."
      ].join("\n\n")
    });
  });

  test("asks only for cadence when the routine does not use email", () => {
    const task = routineSetupTask({
      name: "Track competitor launches",
      description: "Research competitor launches and draft a weekly briefing.",
      usesEmail: false
    });
    expect(task.content).toContain("ask me how often it should run.");
    expect(task.content).toContain("After I answer the setup question, create the scheduled routine.");
    expect(task.content).not.toContain("email account");
  });
});
