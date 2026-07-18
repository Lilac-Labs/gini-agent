"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ClockIcon, SparklesIcon, Trash2Icon, X } from "lucide-react";
import { toast } from "sonner";
import type { JobRecord } from "@runtime/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/components/chat/relative-time";
import { useTopicPanel } from "@/components/chat/TopicPanelContext";
import { useAllJobs, useInvalidate, useRoutineTemplates } from "@/lib/queries";
import { CUSTOM_JOB_CHIP, chipFor } from "@/app/routines/chips";
import { jobDescription, jobDisplayName } from "@/app/routines/custom-jobs";
import { RoutineTools } from "./RoutineTools";
import { scheduleLabel } from "./schedule-label";

// Right-side routine details panel — the routine variant of the TopicPanel
// slot, opened by clicking a RoutineCreatedCard in the transcript. Same
// 440px drawer idiom as TopicPanel: hero row (icon chip, name, enable
// toggle), description, Settings (Triggers / Tools / Skills), the
// information rows the detail page's Info tab shows, and a footer with
// "Open Settings" (the full /routines/job/[jobId] page) and
// "Delete Routine". The job resolves from the UNSCOPED jobs list — the
// agent-scoped list can miss a job owned by another agent.
export function RoutineDetailsPanel({ jobId }: { jobId: string }) {
  const { closeTopic } = useTopicPanel()!;
  const jobs = useAllJobs();
  const job = jobs.data?.find((candidate) => candidate.id === jobId);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="truncate text-[15px] font-semibold text-foreground">Details</h2>
        <button
          type="button"
          onClick={closeTopic}
          aria-label="Close routine panel"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>
      {job ? (
        <RoutineDetailsBody job={job} onClose={closeTopic} />
      ) : (
        // Only a loaded list can rule the id unknown (deleted mid-view);
        // while loading, show a quiet placeholder.
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {jobs.data ? "Routine not found" : "Loading…"}
        </div>
      )}
    </aside>
  );
}

const STATUS_LABELS: Record<JobRecord["status"], string> = {
  active: "Active",
  paused: "Paused",
  failed: "Failed"
};

function RoutineDetailsBody({ job, onClose }: { job: JobRecord; onClose: () => void }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  // Template-installed jobs reuse their catalog chip; chat-created customs
  // get the violet custom-job treatment.
  const templates = useRoutineTemplates();
  const template = job.templateId
    ? templates.data?.templates.find((candidate) => candidate.id === job.templateId)
    : undefined;
  const { icon: Icon, color } = template ? chipFor(template.icon) : CUSTOM_JOB_CHIP;
  const name = jobDisplayName(job);
  const description = jobDescription(job);

  // Same pause/resume + delete mutations as the routine detail page.
  const action = useMutation({
    mutationFn: (op: "pause" | "resume") => api<JobRecord>(`/jobs/${job.id}/${op}`, { method: "POST" }),
    onSuccess: (_, op) => {
      toast.success(`${op === "pause" ? "Paused" : "Resumed"} ${name}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const remove = useMutation({
    mutationFn: () => api<JobRecord>(`/jobs/${job.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Removed ${name}`);
      // "home" too: a home task row may be showing this routine's chip
      // (HomeTaskItem.routineJobId), which would otherwise linger until the
      // home view's 30s idle refetch.
      invalidate(["jobs", "jobRuns", "events", "home"]);
      onClose();
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const infoRows: Array<[string, string]> = [
    ["Created", formatRelativeTime(job.createdAt)],
    ["Last run", job.lastRunAt ? formatRelativeTime(job.lastRunAt) : "Never"],
    ["Status", STATUS_LABELS[job.status]]
  ];

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="flex items-center gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: color }}
          >
            <Icon className="size-[22px] text-white" aria-hidden />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{name}</h3>
          <PanelToggle
            on={job.status === "active"}
            disabled={action.isPending}
            onClick={() => action.mutate(job.status === "active" ? "pause" : "resume")}
          />
        </div>
        {description ? (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}

        <h4 className="mt-7 text-[17px] font-semibold">Settings</h4>
        <div className="mt-2 flex flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-border py-[13px]">
            <span className="text-sm text-muted-foreground">Triggers</span>
            <span className="flex min-w-0 items-center gap-2">
              <ClockIcon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-sm font-semibold">{scheduleLabel(job)}</span>
            </span>
          </div>
          {job.skillNames && job.skillNames.length > 0 ? (
            <div className="flex items-center justify-between gap-4 border-b border-border py-[13px]">
              <span className="text-sm text-muted-foreground">Skills</span>
              <span className="flex min-w-0 items-center gap-2">
                <SparklesIcon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate text-sm font-semibold">{job.skillNames.join(", ")}</span>
              </span>
            </div>
          ) : null}
        </div>
        <RoutineTools jobId={job.id} />

        <h4 className="mt-7 text-[17px] font-semibold">Information</h4>
        <div className="mt-2 flex flex-col">
          {infoRows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 border-b border-border py-[13px]">
              <span className="text-sm text-muted-foreground">{key}</span>
              <span className="min-w-0 truncate text-sm font-semibold">{value}</span>
            </div>
          ))}
        </div>
        {job.lastError ? (
          <p className="mt-3 text-[13px] leading-normal text-destructive">{job.lastError}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={() => router.push(`/routines/job/${encodeURIComponent(job.id)}`)}
          className="inline-flex h-[38px] w-full items-center justify-center rounded-lg border border-border text-sm font-medium transition-colors hover:bg-muted"
        >
          Open Settings
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className="inline-flex h-[38px] w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          <Trash2Icon className="size-4" aria-hidden />
          {remove.isPending ? "Deleting…" : "Delete Routine"}
        </button>
      </div>
    </>
  );
}

// The hero row's enable pill — the detail page's HeroToggle recolored for the
// panel's plain background (that one sits on a tinted hero card).
function PanelToggle({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? "Pause routine" : "Resume routine"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative h-[25px] w-11 shrink-0 rounded-full transition-colors disabled:opacity-70",
        on ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-[19px] rounded-full bg-background shadow-sm transition-all",
          on ? "left-[22px]" : "left-[3px]"
        )}
      />
    </button>
  );
}
