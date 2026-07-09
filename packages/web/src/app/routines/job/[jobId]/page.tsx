"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRightIcon, MessageSquareIcon, PencilIcon, PlayIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/components/chat/relative-time";
import { useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import type { JobRecord } from "@runtime/types";
import { scheduleLabel } from "@/components/jobs/schedule-label";
import { EditJobDialog } from "@/components/jobs/EditJobDialog";
import { CUSTOM_JOB_CHIP } from "../../chips";
import { jobDescription, jobDisplayName } from "../../custom-jobs";

// Detail page for a custom scheduled-job routine (chat-created via
// create_job, no catalog template). Same visual language as the template
// detail (/routines/[templateId]): breadcrumb, sticky tinted hero (enable
// toggle = job pause/resume, Run Now + Edit schedule + Open messages
// actions) and underline tabs — Recent sessions (the job's run history) and
// Info (schedule, skills, status, Delete routine). No Settings tab: prompt
// editing lives in chat.
//
// This is the canonical per-job URL (the /jobs?job= redirect lands here for
// ANY job id): a job carrying a templateId forwards to its template detail
// page, everything else renders the generic detail below.
export default function JobRoutineDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const router = useRouter();
  const jobs = useJobs();

  const all = jobs.data;
  const job = all?.find((candidate) => candidate.id === jobId);

  const templateId = job?.templateId;
  useEffect(() => {
    if (templateId) router.replace(`/routines/${encodeURIComponent(templateId)}`);
  }, [templateId, router]);

  // Only a loaded list can rule the id unknown — while loading, show a quiet
  // placeholder instead of flashing the 404 boundary.
  if (all && !job) notFound();

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-4 text-sm">
        <ZapIcon className="size-4 text-muted-foreground" aria-hidden />
        <Link href="/routines" className="text-muted-foreground transition-colors hover:text-foreground">
          Routines
        </Link>
        <ChevronRightIcon className="size-[15px] text-muted-foreground/65" aria-hidden />
        <span className="font-medium">{job ? jobDisplayName(job) : "…"}</span>
      </header>
      {job && !job.templateId ? (
        <JobRoutineDetail job={job} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          {jobs.error ? jobs.error.message : "Loading…"}
        </div>
      )}
    </>
  );
}

function JobRoutineDetail({ job }: { job: JobRecord }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const { icon: Icon, color } = CUSTOM_JOB_CHIP;
  const [tab, setTab] = useState<"sessions" | "info">("sessions");

  const name = jobDisplayName(job);
  const description = jobDescription(job);

  // Inline job-action mutation: POST /jobs/<id>/{run,pause,resume}.
  const action = useMutation({
    mutationFn: (op: "run" | "pause" | "resume") =>
      api<JobRecord>(`/jobs/${job.id}/${op}`, { method: "POST" }),
    onSuccess: (_, op) => {
      toast.success(op === "run" ? `Running ${name}` : `${op === "pause" ? "Paused" : "Resumed"} ${name}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const remove = useMutation({
    mutationFn: () => api<JobRecord>(`/jobs/${job.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Removed ${name}`);
      invalidate(["jobs", "jobRuns", "events"]);
      router.push("/routines");
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const tabs = [
    { key: "sessions" as const, label: "Recent sessions" },
    { key: "info" as const, label: "Info" }
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-10 md:flex-row md:gap-13">
        {/* Left sticky column: hero + actions */}
        <div className="w-full shrink-0 md:sticky md:top-0 md:w-[300px]">
          <div
            className="relative flex min-h-[310px] flex-col overflow-hidden rounded-2xl p-5"
            style={{
              backgroundColor: color,
              backgroundImage: "radial-gradient(rgba(255,255,255,0.22) 1.3px, transparent 1.3px)",
              backgroundSize: "15px 15px"
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/90">
                <Icon className="size-[22px]" style={{ color }} aria-hidden />
              </span>
              <HeroToggle
                on={job.status === "active"}
                disabled={action.isPending}
                onClick={() => action.mutate(job.status === "active" ? "pause" : "resume")}
              />
            </div>
            <span className="flex-1" />
            <div className="text-[11px] font-semibold tracking-[0.6px] text-white/70">CREATED FROM CHAT</div>
            <div className="mt-2 text-[19px] font-bold text-white">{name}</div>
            <div className="mt-2 line-clamp-4 text-[13px] leading-normal text-white/85">{description}</div>
          </div>

          <div className="mt-5 flex flex-col gap-0.5">
            <button
              type="button"
              disabled={action.isPending}
              onClick={() => action.mutate("run")}
              className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <PlayIcon className="size-[17px] text-muted-foreground" aria-hidden />
              Run Now
            </button>
            {/* Interval/cron/timezone (plus retry/timeout/budget/delivery)
                editing — the dialog the jobs page used to own. */}
            <EditJobDialog
              job={job}
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted"
                >
                  <PencilIcon className="size-[17px] text-muted-foreground" aria-hidden />
                  Edit schedule
                </button>
              }
            />
            {job.chatSessionId ? (
              // The job's delivery conversation (same idiom as the template
              // detail's Open messages).
              <button
                type="button"
                onClick={() => router.push(`/chat?session=${encodeURIComponent(job.chatSessionId!)}`)}
                className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted"
              >
                <MessageSquareIcon className="size-[17px] text-muted-foreground" aria-hidden />
                Open messages
              </button>
            ) : null}
          </div>
        </div>

        {/* Right column */}
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold tracking-tight">{name}</h1>
          <p className="mt-2.5 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">{description}</p>

          <div className="mt-6 flex items-center gap-7 border-b border-border">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                className={cn(
                  "-mb-px border-b-2 pb-3 text-[15px] transition-colors",
                  tab === entry.key
                    ? "border-foreground font-semibold"
                    : "border-transparent font-medium text-muted-foreground hover:text-foreground"
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "sessions" ? (
            <SessionsTab jobId={job.id} />
          ) : (
            <InfoTab job={job} deletePending={remove.isPending} onDelete={() => remove.mutate()} />
          )}
        </div>
      </div>
    </div>
  );
}

// The hero card's enable pill (same treatment as the template detail hero).
// On = the job is active; toggling pauses/resumes it.
function HeroToggle({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
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
        on ? "bg-black/30" : "bg-white/35"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-[19px] rounded-full bg-white transition-all",
          on ? "left-[22px]" : "left-[3px]"
        )}
      />
    </button>
  );
}

// Owns the runs query so it only fetches while the tab is mounted.
function SessionsTab({ jobId }: { jobId: string }) {
  const runs = useJobRuns(jobId);
  const loading = runs.isLoading;
  const sorted = (runs.data ?? []).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <div>
      <h2 className="mt-6 text-[17px] font-semibold">Recent sessions</h2>
      {loading ? (
        <div className="mt-4 text-sm text-muted-foreground">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="No sessions yet" description="Runs appear here after the routine fires." />
        </div>
      ) : (
        <div className="mt-2 flex flex-col">
          {sorted.map((run) => (
            <div key={run.id} className="flex items-center gap-5 border-b border-border/60 px-1 py-[11px]">
              <span className="w-[78px] shrink-0 text-[13px] text-muted-foreground">
                {formatRelativeTime(run.createdAt)}
              </span>
              <span className="shrink-0 text-sm capitalize">
                {run.status === "running" ? "Running" : run.trigger === "manual" ? "Manual run" : run.status}
              </span>
              {run.summary || run.error ? (
                <>
                  <span className="text-muted-foreground/55">|</span>
                  <span className={cn("min-w-0 truncate text-sm", run.error ? "text-destructive" : "text-muted-foreground")}>
                    {run.error ?? run.summary}
                  </span>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<JobRecord["status"], string> = {
  active: "Active",
  paused: "Paused",
  failed: "Failed"
};

function InfoTab({
  job,
  deletePending,
  onDelete
}: {
  job: JobRecord;
  deletePending: boolean;
  onDelete: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["Schedule", scheduleLabel(job)],
    ...(job.skillNames && job.skillNames.length > 0
      ? ([["Skills", job.skillNames.join(", ")]] as Array<[string, string]>)
      : []),
    ["Created", formatRelativeTime(job.createdAt)],
    ["Last run", job.lastRunAt ? formatRelativeTime(job.lastRunAt) : "Never"],
    ["Status", STATUS_LABELS[job.status]]
  ];
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-semibold">Information</h2>
      <div className="mt-2 flex flex-col">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-4 border-b border-border py-[15px]">
            <span className="text-sm text-muted-foreground">{key}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{value}</span>
          </div>
        ))}
      </div>
      {job.lastError ? (
        <p className="mt-3 text-[13px] leading-normal text-destructive">{job.lastError}</p>
      ) : null}
      <button
        type="button"
        disabled={deletePending}
        onClick={onDelete}
        className="mt-6 inline-flex h-[38px] items-center gap-2 rounded-lg px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
      >
        <Trash2Icon className="size-4" aria-hidden />
        {deletePending ? "Deleting…" : "Delete routine"}
      </button>
    </div>
  );
}
