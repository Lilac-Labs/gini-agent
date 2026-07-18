"use client";

import { Repeat2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ToolCallBlock } from "@runtime/types";
import { scheduleLabel } from "@/components/jobs/schedule-label";
import { jobDisplayName } from "@/app/routines/custom-jobs";
import { useAllJobs } from "@/lib/queries";
import { useTopicPanel } from "./TopicPanelContext";

// "Routine created" transcript card for a successful create_job tool call
// (rendersAsRoutineCard in lib/group-exchanges.ts — the block carries the
// created job's structured `jobId`). Renders standalone instead of the
// generic tool row: a violet Routine chip, the routine's name, and a muted
// schedule line. The whole card is the click target — it opens the routine
// details panel beside the chat, or deep-links to the detail page when no
// panel provider is mounted. When the job has since been deleted, the card
// degrades to a non-clickable "Routine removed" state.
// The violet "Routine" pill — shared with HomeTaskRow's right-slot chip so
// the two affordances can't drift visually.
export function RoutineChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[12px] font-medium text-violet-600 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-400">
      <Repeat2 className="size-[13px]" aria-hidden="true" />
      Routine
    </span>
  );
}

export function RoutineCreatedCard({ block }: { block: ToolCallBlock & { jobId: string } }) {
  const jobs = useAllJobs();
  const panel = useTopicPanel();
  const router = useRouter();
  // Resolve from the UNSCOPED jobs list — the agent-scoped list can miss a
  // job owned by another agent. Only a loaded list can rule the job removed;
  // while loading, keep the card clickable and omit the schedule line.
  const job = jobs.data?.find((candidate) => candidate.id === block.jobId);
  const removed = Boolean(jobs.data) && !job;
  const name = job ? jobDisplayName(job) : String(block.argsFull?.name ?? block.argsPreview);

  const chip = <RoutineChip />;
  const body = (
    <span className="min-w-0">
      <span className="block truncate text-sm font-semibold">{name}</span>
      {removed ? (
        <span className="block text-[13px] text-muted-foreground">Routine removed</span>
      ) : job ? (
        <span className="block truncate text-[13px] text-muted-foreground">{scheduleLabel(job)}</span>
      ) : null}
    </span>
  );

  if (removed) {
    return (
      <div className="flex w-fit max-w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        {chip}
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (panel) panel.openRoutine(block.jobId);
        else router.push(`/routines/job/${encodeURIComponent(block.jobId)}`);
      }}
      className="flex w-fit max-w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
    >
      {chip}
      {body}
    </button>
  );
}
