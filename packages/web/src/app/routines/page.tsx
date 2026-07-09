"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckIcon, MoreHorizontalIcon, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import {
  useEmailWatchers,
  useInstallRoutineTemplate,
  useInvalidate,
  useJobs,
  useRemoveEmailWatcher,
  useRoutineTemplates,
  useUninstallRoutineTemplate,
  type RoutineTemplateView
} from "@/lib/queries";
import type { EmailWatcherRecord, JobRecord } from "@runtime/types";
import { chipFor, CUSTOM_JOB_CHIP, WATCHER_CHIP } from "./chips";
import { customRoutineJobs, jobDescription, jobDisplayName } from "./custom-jobs";
import { watcherChannelId, watcherDescription, watcherTitle } from "./watchers";

// The composer seed for conversational routine creation. Trailing space so
// the caret lands after it and the user continues the sentence naturally.
const CREATE_ROUTINE_PROMPT = "Create a routine that ";

export default function RoutinesPage() {
  const router = useRouter();
  const goCreateRoutine = () =>
    router.push("/?compose=message&prompt=" + encodeURIComponent(CREATE_ROUTINE_PROMPT));
  const templates = useRoutineTemplates();
  const install = useInstallRoutineTemplate();
  const uninstall = useUninstallRoutineTemplate();
  const [view, setView] = useState<"mine" | "explore">("mine");

  // Email watchers (created conversationally, e.g. "watch this refund thread")
  // are first-class routines in "My routines", alongside installed templates.
  const watchers = useEmailWatchers();
  const watcherList = watchers.data ?? [];

  // So are the agent's other scheduled jobs (created conversationally via
  // create_job): everything the agent-scoped jobs list holds minus catalog
  // installs (template cards) and the shared email-watch detector (watcher
  // cards / infrastructure).
  const jobs = useJobs();
  const customJobs = customRoutineJobs(jobs.data ?? []);

  const all = templates.data?.templates ?? [];
  const mine = all.filter((template) => template.installed);
  const pending = install.isPending || uninstall.isPending;

  // One-click Add installs with the catalog's default options; prompts/crons
  // are composed server-side. Only the browser timezone rides along.
  const submitInstall = (template: RoutineTemplateView) => {
    install.mutate(
      { id: template.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      {
        onSuccess: () => toast.success(`Added ${template.name}`),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  const submitRemove = (template: RoutineTemplateView) => {
    uninstall.mutate(template.id, {
      onSuccess: () => toast.success(`Removed ${template.name}`),
      onError: (error) => toast.error(error.message)
    });
  };

  return (
    <>
      <PageHeader
        title="Routines"
        description="Routines let your assistant handle recurring work with the right triggers, context, and actions."
        actions={
          <Button size="sm" onClick={goCreateRoutine}>
            <Plus className="size-4" />
            Create routine
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-6">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-muted p-1">
          <ToggleButton active={view === "mine"} onClick={() => setView("mine")}>
            My routines
          </ToggleButton>
          <ToggleButton active={view === "explore"} onClick={() => setView("explore")}>
            Explore
          </ToggleButton>
        </div>

        {templates.isLoading ? (
          <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
        ) : view === "mine" ? (
          <>
            <h2 className="mt-8 text-[17px] font-semibold">My routines</h2>
            {mine.length === 0 && watcherList.length === 0 && customJobs.length === 0 ? (
              <div className="mt-[18px] flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
                <p className="text-sm font-medium">No routines yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a pre-built routine and it runs on a schedule.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <Button size="sm" onClick={goCreateRoutine}>
                    <Plus className="size-4" />
                    Create routine
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setView("explore")}>
                    Explore routines
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-[18px] grid gap-[18px] md:grid-cols-2 xl:grid-cols-3">
                {mine.map((template) => {
                  const { icon: Icon, color } = chipFor(template.icon);
                  return (
                    <div
                      key={template.id}
                      onClick={() => router.push(`/routines/${encodeURIComponent(template.id)}`)}
                      className="flex min-h-[150px] cursor-pointer flex-col gap-3.5 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span
                          className="flex size-10 shrink-0 items-center justify-center rounded-[11px]"
                          style={{ backgroundColor: color }}
                        >
                          <Icon className="size-5 text-white" aria-hidden />
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`${template.name} options`}
                              // Keep the menu from also triggering the card's
                              // navigate-to-detail click.
                              onClick={(event) => event.stopPropagation()}
                              className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <MoreHorizontalIcon className="size-[18px]" aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          {/* The menu renders in a portal, but React portals bubble
                              events through the REACT tree — a click on a menu item
                              would reach the card's navigate-to-detail onClick and
                              clobber the item's own navigation. Stop it at the
                              content boundary. */}
                          <DropdownMenuContent
                            align="end"
                            className="w-40"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <DropdownMenuItem disabled={pending} onSelect={() => submitRemove(template)}>
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="flex flex-col gap-[7px]">
                        <div className="text-sm font-semibold">{template.name}</div>
                        <div className="text-[14px] leading-normal text-muted-foreground">{template.description}</div>
                      </div>
                    </div>
                  );
                })}
                {watcherList.map((watcher) => (
                  <WatcherCard key={watcher.id} watcher={watcher} />
                ))}
                {customJobs.map((job) => (
                  <CustomJobCard key={job.id} job={job} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mt-8 flex flex-col gap-1.5">
              <h2 className="text-[17px] font-semibold">Routines from Gini</h2>
              <p className="text-[14px] text-muted-foreground">Pre-built routines to help you get started</p>
            </div>
            <div className="mt-[18px] grid gap-[18px] md:grid-cols-2 xl:grid-cols-3">
              {all.map((template) => {
                const { icon: Icon, color } = chipFor(template.icon);
                return (
                  <div
                    key={template.id}
                    className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border bg-card p-[18px]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                        style={{ backgroundColor: color }}
                      >
                        <Icon className="size-[18px] text-white" aria-hidden />
                      </span>
                      {template.installed ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => submitRemove(template)}
                          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          <CheckIcon className="size-3.5" aria-hidden />
                          Added
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => submitInstall(template)}
                          className="inline-flex h-[30px] shrink-0 items-center rounded-full bg-secondary px-4 text-xs font-semibold transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          Add
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-[5px]">
                      <div className="text-sm font-semibold">{template.name}</div>
                      <div className="text-[14px] leading-normal text-muted-foreground">{template.description}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// An email-watcher routine card. Same shape as the template card, but the
// chip is the shared watcher cyan, the ⋯ menu deep-links to the watcher's
// channel, and a paused watcher renders dimmed with a Paused pill.
function WatcherCard({ watcher }: { watcher: EmailWatcherRecord }) {
  const router = useRouter();
  const remove = useRemoveEmailWatcher();
  const { icon: Icon, color } = WATCHER_CHIP;
  const channelId = watcherChannelId(watcher);
  const title = watcherTitle(watcher);

  const submitRemove = () => {
    remove.mutate(watcher.id, {
      onSuccess: () => toast.success(`Removed ${title}`),
      onError: (error) => toast.error(error.message)
    });
  };

  return (
    <div
      onClick={() => router.push(`/routines/watch/${encodeURIComponent(watcher.id)}`)}
      className={cn(
        "flex min-h-[150px] cursor-pointer flex-col gap-3.5 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20",
        !watcher.enabled && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-[11px]"
          style={{ backgroundColor: color }}
        >
          <Icon className="size-5 text-white" aria-hidden />
        </span>
        <div className="flex items-center gap-2">
          {!watcher.enabled ? (
            <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
              Paused
            </span>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${title} options`}
                // Keep the menu from also triggering the card's
                // navigate-to-detail click.
                onClick={(event) => event.stopPropagation()}
                className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontalIcon className="size-[18px]" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            {/* The menu renders in a portal, but React portals bubble events
                through the REACT tree — a click on a menu item would reach the
                card's navigate-to-detail onClick and clobber the item's own
                navigation. Stop it at the content boundary. */}
            <DropdownMenuContent
              align="end"
              className="w-40"
              onClick={(event) => event.stopPropagation()}
            >
              {channelId ? (
                <DropdownMenuItem asChild>
                  <Link href={`/chat?session=${encodeURIComponent(channelId)}`}>Open channel</Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={remove.isPending} onSelect={submitRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex flex-col gap-[7px]">
        <div className="line-clamp-2 text-sm font-semibold">{title}</div>
        <div className="line-clamp-2 text-[14px] leading-normal text-muted-foreground">
          {watcherDescription(watcher)}
        </div>
      </div>
    </div>
  );
}

// A custom scheduled-job routine card (chat-created via create_job, no
// catalog template). Same shape as the watcher card: violet chip, humanized
// job name, first prompt line as description, a paused job renders dimmed
// with a Paused pill, and the ⋯ menu deep-links the job's conversation.
function CustomJobCard({ job }: { job: JobRecord }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const { icon: Icon, color } = CUSTOM_JOB_CHIP;
  const title = jobDisplayName(job);
  const paused = job.status === "paused";

  // Same DELETE the jobs page uses; removing the job also drops its run
  // history (its conversation is archived, not deleted).
  const remove = useMutation({
    mutationFn: () => api<JobRecord>(`/jobs/${job.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Removed ${title}`);
      invalidate(["jobs", "jobRuns", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <div
      onClick={() => router.push(`/routines/job/${encodeURIComponent(job.id)}`)}
      className={cn(
        "flex min-h-[150px] cursor-pointer flex-col gap-3.5 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20",
        paused && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-[11px]"
          style={{ backgroundColor: color }}
        >
          <Icon className="size-5 text-white" aria-hidden />
        </span>
        <div className="flex items-center gap-2">
          {paused ? (
            <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
              Paused
            </span>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${title} options`}
                // Keep the menu from also triggering the card's
                // navigate-to-detail click.
                onClick={(event) => event.stopPropagation()}
                className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontalIcon className="size-[18px]" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            {/* The menu renders in a portal, but React portals bubble events
                through the REACT tree — a click on a menu item would reach the
                card's navigate-to-detail onClick and clobber the item's own
                navigation. Stop it at the content boundary. */}
            <DropdownMenuContent
              align="end"
              className="w-40"
              onClick={(event) => event.stopPropagation()}
            >
              {job.chatSessionId ? (
                <DropdownMenuItem asChild>
                  <Link href={`/chat?session=${encodeURIComponent(job.chatSessionId)}`}>Open channel</Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={remove.isPending} onSelect={() => remove.mutate()}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex flex-col gap-[7px]">
        <div className="line-clamp-2 text-sm font-semibold">{title}</div>
        <div className="line-clamp-2 text-[14px] leading-normal text-muted-foreground">{jobDescription(job)}</div>
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-full px-[18px] text-[14px] transition-colors",
        active
          ? "bg-card font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.10)]"
          : "font-medium text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
