"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, List, Calendar, Trash2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { scheduleLabel } from "@/components/jobs/schedule-label";
import { CalendarView } from "@/components/jobs/calendar/calendar-view";
import { adaptJob, adaptRun } from "@/components/calendar/types";
import { api } from "@/lib/api";
import { useAllChatSessions, useInvalidate, useJobRuns, useJobs } from "@/lib/queries";
import { JobFanout } from "@/components/chat/JobFanout";
import type { ChatSession } from "@/lib/view-types";
import type { JobRecord, JobRunRecord, JobStatus } from "@runtime/types";

type View = "list" | "calendar";
type StatusFilter = "all" | "active" | "paused";

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All",
  active: "Active",
  paused: "Paused"
};

// Per-agent Routines tab — design `pu4J9` ("Agent Page — Routines list").
// A Page Header (Routines title + subtitle and a List⇆Calendar toggle) sits above
// a two-column list body: routines on the left, recent runs on the right.
// `useJobs`/`useJobRuns` are already scoped to the active agent, so both
// columns show only this agent's jobs and runs.
export function JobsTab() {
  const jobs = useJobs();
  const runs = useJobRuns();
  // Unscoped session list (shared cache with the sidebar) — used to resolve
  // each job's delivery binding (channel title vs the agent's chat) for the
  // read-only "Delivers to" line on the card.
  const sessions = useAllChatSessions();
  const invalidate = useInvalidate();
  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Routine pending delete confirmation. Null when the dialog is closed. Deleting a
  // routine cascade-removes its run history, so the confirmation is mandatory.
  const [deletingJob, setDeletingJob] = useState<JobRecord | null>(null);

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "run" | "pause" | "resume" }) =>
      api<JobRecord>(`/jobs/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<JobRecord>(`/jobs/${id}`, { method: "DELETE" }),
    onSuccess: (job) => {
      toast.success(`Deleted ${job.name}`);
      setDeletingJob(null);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const replay = useMutation({
    mutationFn: (runId: string) => api<JobRunRecord>(`/job-runs/${runId}/replay`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Replay queued");
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const allJobs = jobs.data ?? [];
  const sessionsById = useMemo(
    () => new Map((sessions.data ?? []).map((s) => [s.id, s])),
    [sessions.data]
  );
  const selectedJob = useMemo(
    () => (selectedId ? (allJobs.find((j) => j.id === selectedId) ?? null) : null),
    [allJobs, selectedId]
  );
  const filteredJobs = useMemo(
    () => (statusFilter === "all" ? allJobs : allJobs.filter((j) => j.status === statusFilter)),
    [allJobs, statusFilter]
  );

  // Recent runs, newest first, capped. The header count is runs whose
  // createdAt falls within the last 24h (the JobRunRecord has no separate
  // startedAt; createdAt is when the run was claimed).
  const allRuns = runs.data ?? [];
  const recentRuns = useMemo(
    () => allRuns.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    [allRuns]
  );
  const runsLast24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return allRuns.filter((r) => new Date(r.createdAt).getTime() >= cutoff).length;
  }, [allRuns]);

  const calendarJobs = allJobs.map(adaptJob);
  const calendarRuns = allRuns.map(adaptRun);
  const calendarLoading = jobs.isLoading || runs.isLoading;
  const calendarError = jobs.error?.message ?? runs.error?.message ?? null;
  const handleCalendarRefresh = async () => {
    await Promise.all([jobs.refetch(), runs.refetch()]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Page Header — design `ZR4lj` */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-8 py-[22px]">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[28px] font-bold leading-none text-foreground">Routines</h2>
          <p className="text-sm font-medium text-muted-foreground">
            Scheduled routines owned by this agent
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </div>

      {view === "list" && selectedJob ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-8 pb-8 pt-6">
            <JobDetailPanel
              job={selectedJob}
              deliveryLabel={deliveryLabel(selectedJob, sessionsById)}
              actionPending={action.isPending}
              onBack={() => setSelectedId(null)}
              onAction={(op) => action.mutate({ id: selectedJob.id, op })}
              onRequestDelete={() => setDeletingJob(selectedJob)}
            />
          </div>
        </ScrollArea>
      ) : view === "list" ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex gap-6 px-8 pb-8 pt-6">
            {/* Routines column */}
            <div className="flex w-[520px] shrink-0 flex-col gap-3.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
                  Routines · {allJobs.length}
                </span>
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <SelectTrigger
                    size="sm"
                    className="h-auto gap-1 border-0 bg-transparent px-0 py-0 text-[11px] font-semibold text-foreground shadow-none focus-visible:ring-0 [&_svg]:text-muted-foreground"
                  >
                    <SelectValue>{STATUS_FILTER_LABELS[statusFilter]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {filteredJobs.length === 0 ? (
                <EmptyColumn label={allJobs.length === 0 ? "No routines yet" : "No routines match this filter"} />
              ) : (
                filteredJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    deliveryLabel={deliveryLabel(job, sessionsById)}
                    actionPending={action.isPending}
                    onAction={(op) => action.mutate({ id: job.id, op })}
                    onSelect={() => setSelectedId(job.id)}
                    onRequestDelete={() => setDeletingJob(job)}
                  />
                ))
              )}
            </div>

            {/* Runs column */}
            <div className="flex min-w-0 flex-1 flex-col gap-3.5">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">
                  Recent runs · {runsLast24h} in the last 24h
                </span>
                <Link
                  href="/routines"
                  className="flex items-center gap-1 text-[11px] font-semibold text-foreground transition-opacity hover:opacity-80"
                >
                  View all runs
                  <ArrowRight className="size-[11px] text-muted-foreground" />
                </Link>
              </div>
              {recentRuns.length === 0 ? (
                <EmptyColumn label="No runs yet" />
              ) : (
                recentRuns.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    replayPending={replay.isPending}
                    onReplay={() => replay.mutate(run.id)}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-8">
          <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-card">
            <CalendarView
              status={{ enabled: true }}
              jobs={calendarJobs}
              runs={calendarRuns}
              loading={calendarLoading}
              error={calendarError}
              onRefresh={handleCalendarRefresh}
              highlightJobId={null}
            />
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(deletingJob)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeletingJob(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Delete {deletingJob?.name ?? "routine"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            This permanently removes the routine and its run history. This can&rsquo;t be undone.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeletingJob(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deletingJob && remove.mutate(deletingJob.id)}
              disabled={!deletingJob || remove.isPending}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Segmented List ⇆ Calendar control — design View Toggle (`nw3zd`):
// #141418 container, 4px padding, rounded-10; the active segment fills
// #E8E8EC with dark text.
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const segments: { id: View; label: string; Icon: typeof List }[] = [
    { id: "list", label: "List", Icon: List },
    { id: "calendar", label: "Calendar", Icon: Calendar }
  ];
  return (
    <div className="flex gap-1 rounded-[10px] border border-border bg-card p-1">
      {segments.map(({ id, label, Icon }) => {
        const isActive = view === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-[7px] px-4 py-[7px] text-[13px] transition-colors",
              isActive ? "bg-primary font-semibold text-primary-foreground" : "font-bold text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-[13px]" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Read-only delivery-binding label for a routine card: the dedicated channel's
// title when channel-bound, the agent's chat when bound to any other session,
// null (no line) when the job is session-less or the session can't resolve.
function deliveryLabel(job: JobRecord, sessionsById: Map<string, ChatSession>): string | null {
  if (!job.chatSessionId) return null;
  const session = sessionsById.get(job.chatSessionId);
  if (!session) return null;
  return session.kind === "channel" ? `# ${session.title}` : "this agent's chat";
}

// Routine card — design `y6aU9` (Routine List Item). The header is a click target that
// opens the routine details view; the action buttons stop propagation so
// Run/Pause/Resume don't also select.
function JobCard({
  job,
  deliveryLabel,
  actionPending,
  onAction,
  onSelect,
  onRequestDelete
}: {
  job: JobRecord;
  deliveryLabel: string | null;
  actionPending: boolean;
  onAction: (op: "run" | "pause" | "resume") => void;
  onSelect: () => void;
  onRequestDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[10px] border border-border bg-card p-4">
      <button
        type="button"
        onClick={onSelect}
        className="flex items-start justify-between gap-2.5 text-left transition-opacity hover:opacity-80"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="truncate text-[15px] font-semibold text-foreground">{job.name}</p>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={job.cronExpression ?? undefined}>
            {job.id} · {scheduleLabel(job)}
          </p>
        </div>
        <JobStatusBadge status={job.status} />
      </button>
      <div className="flex flex-col gap-[5px] text-[12.5px] text-muted-foreground">
        <span>last run {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"}</span>
        <span>next {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}</span>
        <span className="font-medium text-muted-foreground">
          {job.runCount} runs · {job.missedRuns} missed
        </span>
        {deliveryLabel ? <span className="truncate">Delivers to: {deliveryLabel}</span> : null}
      </div>
      <div className="flex gap-2.5">
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onAction("run")}
          className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Run
        </button>
        {job.status === "active" ? (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAction("pause")}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAction("resume")}
            className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Resume
          </button>
        )}
        <button
          type="button"
          onClick={onRequestDelete}
          aria-label={`Delete ${job.name}`}
          title="Delete routine"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-[15px]" />
          Delete
        </button>
      </div>
    </div>
  );
}

// Routine details view shown when a JobCard is selected. A header card (name,
// schedule, status, and the same Run/Pause/Resume/Delete actions as the list
// card) over the routine's full details — schedule stats, prompt/script, optional
// chip sections — with the fan-out concern list as one final section. JobFanout
// owns the generic-vs-email branch; this panel stays domain-agnostic.
function JobDetailPanel({
  job,
  deliveryLabel,
  actionPending,
  onBack,
  onAction,
  onRequestDelete
}: {
  job: JobRecord;
  deliveryLabel: string | null;
  actionPending: boolean;
  onBack: () => void;
  onAction: (op: "run" | "pause" | "resume") => void;
  onRequestDelete: () => void;
}) {
  return (
    <div className="flex max-w-[680px] flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-[14px]" />
        Back to routines
      </button>

      <div className="flex flex-col gap-3.5 rounded-[10px] border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="truncate text-[17px] font-semibold text-foreground">{job.name}</p>
            <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={job.cronExpression ?? undefined}>
              {job.id} · {scheduleLabel(job)}
            </p>
            {job.cronExpression ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground" title="Raw cron expression">
                {job.cronExpression}
              </p>
            ) : null}
          </div>
          <JobStatusBadge status={job.status} />
        </div>
        <div className="flex gap-2.5">
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAction("run")}
            className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Run
          </button>
          {job.status === "active" ? (
            <button
              type="button"
              disabled={actionPending}
              onClick={() => onAction("pause")}
              className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              disabled={actionPending}
              onClick={() => onAction("resume")}
              className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              Resume
            </button>
          )}
          <button
            type="button"
            onClick={onRequestDelete}
            aria-label={`Delete ${job.name}`}
            title="Delete routine"
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-[15px]" />
            Delete
          </button>
        </div>
      </div>

      <DetailSection title="Details">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <DetailKV label="Last run" value={job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "—"} />
          <DetailKV label="Next run" value={job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"} />
          <DetailKV label="Last success" value={job.lastSuccessAt ? new Date(job.lastSuccessAt).toLocaleString() : "—"} />
          <DetailKV label="Last failure" value={job.lastFailureAt ? new Date(job.lastFailureAt).toLocaleString() : "—"} />
          <DetailKV label="Runs" value={String(job.runCount)} />
          <DetailKV label="Missed" value={String(job.missedRuns)} />
          <DetailKV label="Retry limit" value={String(job.retryLimit ?? "—")} />
          <DetailKV label="Timeout" value={`${job.timeoutSeconds ?? "—"}s`} />
          {deliveryLabel ? <DetailKV label="Delivers to" value={deliveryLabel} /> : null}
          {typeof job.costBudget === "number" ? (
            <DetailKV label="Cost budget" value={`$${job.costBudget.toFixed(2)}`} />
          ) : null}
        </div>
      </DetailSection>

      {(job.skillNames?.length ?? 0) > 0 ? (
        <DetailSection title="Skill attachments">
          <div className="flex flex-wrap gap-1.5">
            {job.skillNames?.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {(job.context?.length ?? 0) > 0 ? (
        <DetailSection title="Context">
          <div className="flex flex-wrap gap-1.5">
            {job.context.map((item, i) => (
              <span
                key={`${item}-${i}`}
                className="rounded-md border border-border bg-card/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {item}
              </span>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title={job.script ? "Prompt & script" : "Prompt"}>
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card/50 p-3 font-mono text-[12px] text-foreground">
          {job.prompt}
        </pre>
        {job.script ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">Script</span>
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card/50 p-3 font-mono text-[12px] text-foreground">
              {job.script}
            </pre>
          </div>
        ) : null}
      </DetailSection>

      {job.lastError ? (
        <DetailSection title="Last error">
          <pre className="whitespace-pre-wrap break-words text-[12px] text-red-400">{job.lastError}</pre>
        </DetailSection>
      ) : null}

      {/* Fan-out concerns — self-hides (renders null) for non-fan-out jobs. */}
      <JobFanout job={job} />
    </div>
  );
}

// Titled card used to group a section of the job details view.
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
      <span className="text-[11px] font-bold uppercase tracking-[0.6px] text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

// Stacked label-over-value pair for the details grid.
function DetailKV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">{label}</span>
      <span className="truncate text-[13px] text-foreground">{value}</span>
    </div>
  );
}

// Run card — design `k0gv7` (Run History Item).
function RunCard({
  run,
  replayPending,
  onReplay
}: {
  run: JobRunRecord;
  replayPending: boolean;
  onReplay: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <p className="truncate font-mono text-[13px] font-medium text-foreground">{run.id}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {run.trigger} · attempt {run.attempt} · {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RunStatusBadge status={run.status} />
          {run.taskId ? (
            <Link
              href={`/tasks?id=${run.taskId}`}
              className="rounded-[7px] border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted"
            >
              View trace
            </Link>
          ) : null}
          <button
            type="button"
            disabled={replayPending}
            onClick={onReplay}
            className="rounded-[7px] border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Replay
          </button>
        </div>
      </div>
      {run.summary ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground">{run.summary}</p>
      ) : null}
      {run.error ? (
        <p className="whitespace-pre-wrap text-[13px] leading-[1.6] text-red-400">{run.error}</p>
      ) : null}
      {run.taskId ? (
        <div className="border-t border-border pt-2.5">
          <p className="font-mono text-[11.5px] text-muted-foreground">
            task {run.taskId} · {run.status}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Routine status badge — ACTIVE (green) / PAUSED (gray) / FAILED (red), per the
// design's badge styling (`yvi2R` active, `w3otfA` paused).
function JobStatusBadge({ status }: { status: JobStatus }) {
  const tone =
    status === "active"
      ? "bg-emerald-500/10 text-emerald-600 dark:bg-[#14331E] dark:text-[#4ADE80]"
      : status === "failed"
        ? "bg-red-500/10 text-red-600 dark:bg-[#3A1A1A] dark:text-[#F87171]"
        : "bg-muted text-muted-foreground";
  return (
    <span className={cn("shrink-0 rounded-md px-[9px] py-1 text-[10px] font-bold uppercase tracking-[0.6px]", tone)}>
      {status}
    </span>
  );
}

// Run status badge — COMPLETED (green) / FAILED (red) / RUNNING (blue), per
// the design's run badge (`wTUcV`).
function RunStatusBadge({ status }: { status: JobRunRecord["status"] }) {
  const tone =
    status === "completed"
      ? "bg-emerald-500/10 text-emerald-600 dark:bg-[#14331E] dark:text-[#4ADE80]"
      : status === "failed"
        ? "bg-red-500/10 text-red-600 dark:bg-[#3A1A1A] dark:text-[#F87171]"
        : "bg-blue-500/10 text-blue-600 dark:bg-[#16243B] dark:text-[#60A5FA]";
  return (
    <span className={cn("rounded-md px-[9px] py-1 text-[10px] font-bold uppercase tracking-[0.6px]", tone)}>
      {status}
    </span>
  );
}

function EmptyColumn({ label }: { label: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-border bg-card/40 px-4 py-8 text-center text-[13px] text-muted-foreground">
      {label}
    </div>
  );
}
