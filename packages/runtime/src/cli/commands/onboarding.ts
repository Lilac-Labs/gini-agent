import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

// Explicit developer escape hatch for testing surfaces behind OnboardingGate.
// It uses the normal completion contract so the selected instance stays
// internally consistent; callers must start that instance's gateway first.
export async function onboarding(ctx: CliContext): Promise<void> {
  if (ctx.cliArgs[1] !== "skip") {
    throw new Error("Usage: gini onboarding skip");
  }
  print(await api(ctx.config, "/api/onboarding", {
    method: "PATCH",
    body: JSON.stringify({ completed: true })
  }));
}
