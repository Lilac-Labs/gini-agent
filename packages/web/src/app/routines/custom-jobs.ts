import type { JobRecord } from "@runtime/types";

// Partition + presentation helpers for custom scheduled jobs (created
// conversationally via create_job, no catalog template) surfaced as
// first-class routines in "My routines" and /routines/job/[jobId].

// The shared email-watch detection job, identified by its structural marker:
// a `skill-script` pre-run hook routed at the gmail-watch detection skill —
// the same identity the runtime provisions and finds it by (findSharedJobId
// in packages/runtime/src/state/email-watchers.ts) and JobFanout branches
// on. Never name-matched: the job title is user-visible copy, the hook
// config is the contract.
export function isEmailWatchJob(job: JobRecord): boolean {
  return job.preRunHook?.handlerId === "skill-script" && job.preRunHook.config.skill === "gmail-watch";
}

// The jobs that render as generic routine cards: everything the (already
// agent-scoped) jobs list holds that is neither a catalog install
// (templateId — represented by template cards) nor the shared email-watch
// detector (represented by watcher cards / infrastructure). Paused jobs
// stay in — the card renders their Paused state.
export function customRoutineJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter((job) => !job.templateId && !isEmailWatchJob(job));
}

// Display-only humanization of the job's machine name ("morning-debrief" →
// "Morning debrief"). Never written back to the record.
export function jobDisplayName(job: JobRecord): string {
  const spaced = job.name.replace(/[-_]+/g, " ").trim();
  return spaced.length === 0 ? job.name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Card/detail description: the prompt's first non-empty line (the card
// clamps it; the full prompt stays on the job record).
export function jobDescription(job: JobRecord): string {
  return (
    job.prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
