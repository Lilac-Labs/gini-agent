import type { OnboardingRoutineSuggestion, OnboardingScan } from "@runtime/types";

// Only a completed scan can claim a suggestion is personalized. Older
// onboarding records simply omit the section; the fixed catalog remains in
// Explore instead of masquerading as context-derived advice.
export function suggestedRoutinesFrom(scan: OnboardingScan | undefined): OnboardingRoutineSuggestion[] {
  return scan?.status === "ready" ? (scan.suggestedRoutines ?? []) : [];
}

// Product-authored task brief behind a suggestion's Add button. The task title
// stays compact on Home while the first turn gets the suggestion's actual goal
// plus the two configuration decisions OPE-55 requires before create_job.
export function routineSetupTask(suggestion: OnboardingRoutineSuggestion): { title: string; content: string } {
  const accountQuestion = suggestion.usesEmail
    ? " and which connected email account or accounts it should use"
    : "";
  return {
    title: `Create a routine: ${suggestion.name}`,
    content: [
      `Create the suggested routine “${suggestion.name}” for me.`,
      suggestion.description,
      `Before creating it, ask me how often it should run${accountQuestion}. After I answer the setup question${suggestion.usesEmail ? "s" : ""}, create the scheduled routine.`
    ].join("\n\n")
  };
}
