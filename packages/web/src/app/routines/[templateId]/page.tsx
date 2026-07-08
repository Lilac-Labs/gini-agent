"use client";

import { use, useState } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRightIcon, MessageSquareIcon, PlayIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/components/chat/relative-time";
import {
  useInstallRoutineTemplate,
  useInvalidate,
  useJobRuns,
  useJobs,
  useRoutineTemplates,
  useUninstallRoutineTemplate,
  type RoutineTemplateView
} from "@/lib/queries";
import type { JobRecord } from "@runtime/types";
import { chipFor } from "../chips";

// Routine detail page (GiniRoutineDetail design handoff): breadcrumb, a
// sticky hero card tinted with the template's chip color (enable toggle =
// job pause/resume, Run Now action), and underline tabs — Recent sessions
// (the installed job's run history), Settings (the template's option
// toggles, saved via the idempotent re-install), and Info (real rows +
// Delete routine). A template that isn't added renders the hero with an Add
// button in place of the toggle and tabs.
export default function RoutineDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = use(params);
  const templates = useRoutineTemplates();

  const all = templates.data?.templates;
  const template = all?.find((candidate) => candidate.id === templateId);
  // Only a loaded catalog can rule the id unknown — while loading, show a
  // quiet placeholder instead of flashing the 404 boundary.
  if (all && !template) notFound();

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-4 text-sm">
        <ZapIcon className="size-4 text-muted-foreground" aria-hidden />
        <Link href="/routines" className="text-muted-foreground transition-colors hover:text-foreground">
          Routines
        </Link>
        <ChevronRightIcon className="size-[15px] text-muted-foreground/65" aria-hidden />
        <span className="font-medium">{template?.name ?? "…"}</span>
      </header>
      {template ? (
        <RoutineDetail template={template} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          {templates.error ? templates.error.message : "Loading…"}
        </div>
      )}
    </>
  );
}

function RoutineDetail({ template }: { template: RoutineTemplateView }) {
  const router = useRouter();
  const { icon: Icon, color } = chipFor(template.icon);
  const installed = template.installed;
  const jobs = useJobs();
  const job = installed ? (jobs.data ?? []).find((candidate) => candidate.id === installed.jobId) : undefined;
  const install = useInstallRoutineTemplate();
  const uninstall = useUninstallRoutineTemplate();
  const invalidate = useInvalidate();
  const [tab, setTab] = useState<"sessions" | "settings" | "info">("sessions");

  // Same inline mutation shape as the jobs page: POST /jobs/<id>/{run,pause,resume}.
  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "run" | "pause" | "resume" }) =>
      api<JobRecord>(`/jobs/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(
        vars.op === "run" ? `Running ${template.name}` : `${vars.op === "pause" ? "Paused" : "Resumed"} ${template.name}`
      );
      invalidate(["jobs", "jobRuns", "routine-templates", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const submitAdd = () => {
    install.mutate(
      { id: template.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      {
        onSuccess: () => toast.success(`Added ${template.name}`),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  // Save re-installs with the edited options (idempotent per-template
  // replace server-side — the jobId changes, and the invalidated templates
  // query re-resolves the page onto the new job). The current job's
  // cronTimezone rides along so the schedule's timezone is preserved.
  const submitSave = (options: Record<string, boolean>) => {
    install.mutate(
      {
        id: template.id,
        options,
        timezone: job?.cronTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  const submitDelete = () => {
    uninstall.mutate(template.id, {
      onSuccess: () => {
        toast.success(`Removed ${template.name}`);
        router.push("/routines");
      },
      onError: (error) => toast.error(error.message)
    });
  };

  const tabs = [
    { key: "sessions" as const, label: "Recent sessions" },
    ...(template.options.length > 0 ? [{ key: "settings" as const, label: "Settings" }] : []),
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
              {installed ? (
                <HeroToggle
                  on={installed.status === "active"}
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ id: installed.jobId, op: installed.status === "active" ? "pause" : "resume" })
                  }
                />
              ) : (
                <button
                  type="button"
                  disabled={install.isPending}
                  onClick={submitAdd}
                  className="inline-flex h-[30px] shrink-0 items-center rounded-full bg-white/90 px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ color }}
                >
                  Add
                </button>
              )}
            </div>
            <span className="flex-1" />
            <div className="text-[11px] font-semibold tracking-[0.6px] text-white/70">CREATED BY GINI</div>
            <div className="mt-2 text-[19px] font-bold text-white">{template.name}</div>
            <div className="mt-2 text-[13px] leading-normal text-white/85">{template.description}</div>
          </div>

          {installed ? (
            <div className="mt-5 flex flex-col gap-0.5">
              <button
                type="button"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: installed.jobId, op: "run" })}
                className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                <PlayIcon className="size-[17px] text-muted-foreground" aria-hidden />
                Run Now
              </button>
              {installed.chatSessionId ? (
                // The routine's dedicated conversation — where each run's
                // briefing lands (same idiom as the watcher detail's Open
                // channel). Absent only on installs predating provisioning.
                <button
                  type="button"
                  onClick={() => router.push(`/chat?session=${encodeURIComponent(installed.chatSessionId!)}`)}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted"
                >
                  <MessageSquareIcon className="size-[17px] text-muted-foreground" aria-hidden />
                  Open messages
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Right column */}
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold tracking-tight">{template.name}</h1>
          <p className="mt-2.5 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
            {template.description}
          </p>

          {installed ? (
            <>
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
                <SessionsTab jobId={installed.jobId} />
              ) : tab === "settings" ? (
                // Keyed by jobId: a Save re-installs onto a fresh job, and the
                // remount reseeds the toggles from the newly persisted options.
                <SettingsTab
                  key={installed.jobId}
                  template={template}
                  pending={install.isPending}
                  onSave={submitSave}
                />
              ) : (
                <InfoTab
                  template={template}
                  job={job}
                  deletePending={uninstall.isPending}
                  onDelete={submitDelete}
                />
              )}
            </>
          ) : (
            <div className="mt-8 flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
              <p className="text-sm font-medium">Not added yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add this routine and Gini runs it on a schedule ({template.scheduleHint.toLowerCase()}).
              </p>
              <Button size="sm" className="mt-4" disabled={install.isPending} onClick={submitAdd}>
                Add routine
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The hero card's enable pill (design's on-tint / off-tint over the chip
// color). On = the job is active; toggling pauses/resumes it.
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

// Owns the runs query so it only fetches while the tab is mounted (and never
// falls back to the unscoped /job-runs list when nothing is installed).
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

function SettingsTab({
  template,
  pending,
  onSave
}: {
  template: RoutineTemplateView;
  pending: boolean;
  onSave: (options: Record<string, boolean>) => void;
}) {
  // Seed from the installed job's persisted options; a job predating
  // templateOptions falls back to the catalog defaults.
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      template.options.map((option) => [
        option.key,
        template.installed?.options?.[option.key] ?? option.defaultEnabled
      ])
    )
  );
  const dirty = template.options.some(
    (option) => values[option.key] !== (template.installed?.options?.[option.key] ?? option.defaultEnabled)
  );

  return (
    <div className="mt-6">
      <div className="rounded-xl border border-border bg-card">
        {template.options.map((option, index) => (
          <div
            key={option.key}
            className={cn("flex items-start justify-between gap-5 px-5 py-4", index > 0 && "border-t border-border")}
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">{option.label}</div>
              {option.description ? (
                <div className="mt-1 max-w-[480px] text-[13px] leading-normal text-muted-foreground">
                  {option.description}
                </div>
              ) : null}
            </div>
            <SettingToggle
              on={values[option.key] ?? option.defaultEnabled}
              label={option.label}
              onClick={() => setValues((current) => ({ ...current, [option.key]: !current[option.key] }))}
            />
          </div>
        ))}
      </div>
      <Button size="sm" className="mt-4" disabled={!dirty || pending} onClick={() => onSave(values)}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

function SettingToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative mt-0.5 h-[25px] w-11 shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-foreground/25"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-[19px] rounded-full transition-all",
          on ? "left-[22px] bg-background" : "left-[3px] bg-white"
        )}
      />
    </button>
  );
}

function InfoTab({
  template,
  job,
  deletePending,
  onDelete
}: {
  template: RoutineTemplateView;
  job: JobRecord | undefined;
  deletePending: boolean;
  onDelete: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["Created by", "Gini"],
    ["Schedule", template.scheduleHint],
    ["Skills", job?.skillNames?.join(", ") ?? "—"],
    ["Last run", job?.lastRunAt ? formatRelativeTime(job.lastRunAt) : "Never"]
  ];
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-semibold">Information</h2>
      <div className="mt-2 flex flex-col">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-4 border-b border-border py-[15px]">
            <span className="text-sm text-muted-foreground">{key}</span>
            <span className="text-sm font-semibold">{value}</span>
          </div>
        ))}
      </div>
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
