import cronstrue from "cronstrue";
import type { JobRecord } from "@runtime/types";

// Shared "how is this job scheduled?" label used by the chat Jobs tab and
// the routine detail pages. Two display modes:
//   - cron-driven:  `At 09:00 AM, Monday through Friday (America/Los_Angeles)`
//                   (human English via cronstrue, timezone appended)
//   - interval:     `every 60s`
// The helper is the single source of truth so list and detail can't drift
// out of sync. A cron-driven JobRecord carries no intervalSeconds at all;
// the cron branch handles that case explicitly so the interval branch only
// sees positive numbers.
export function scheduleLabel(job: JobRecord): string {
  if (job.cronExpression) {
    const tz = job.cronTimezone ?? "UTC";
    const human = humanCron(job.cronExpression);
    // Fall back to the raw expression when cronstrue can't parse it
    // (e.g. a hand-edited or future-extended pattern). The TZ suffix is
    // appended in both cases so the user can see the wall-clock anchor.
    return human ? `${human} (${tz})` : `${job.cronExpression} (${tz})`;
  }
  // Defensive fallback for hand-edited / migrated records that lost their
  // interval — render an explicit marker instead of "every undefineds".
  if (job.intervalSeconds === undefined) return "(no schedule)";
  return `every ${job.intervalSeconds}s`;
}

// Wrap cronstrue's toString with a try/catch so a malformed expression
// (or a future-extended one cronstrue doesn't understand) returns null
// instead of throwing into a React render. Callers fall back to showing
// the raw expression when null is returned.
//
// Exported so EditJobDialog can render a live human description below the
// expression input as helper text without re-implementing this guard.
export function humanCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = cronstrue.toString(trimmed, {
      use24HourTimeFormat: false,
      throwExceptionOnParseError: true,
      verbose: false
    });
    // cronstrue returns a non-empty string on success — guard the empty
    // case anyway so callers can safely use `if (value)` semantics.
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
