"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarCheckIcon, CheckIcon, InboxIcon, MoreHorizontalIcon, SunriseIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/PageHeader";
import {
  useInstallRoutineTemplate,
  useRoutineTemplates,
  useUninstallRoutineTemplate,
  type RoutineTemplateView
} from "@/lib/queries";

// Icon-key → presentation mapping for the catalog's `icon` hints. Chip colors
// come from the GiniRoutines design handoff (Auto-inbox blue, Morning Briefing
// gold, Meeting Briefing green); unknown keys fall back to the inbox treatment.
const CHIPS: Record<string, { icon: LucideIcon; bg: string }> = {
  inbox: { icon: InboxIcon, bg: "bg-[#4277FB]" },
  sunrise: { icon: SunriseIcon, bg: "bg-[#E8A317]" },
  "calendar-check": { icon: CalendarCheckIcon, bg: "bg-[#1FA463]" }
};

function chipFor(template: RoutineTemplateView) {
  return CHIPS[template.icon] ?? CHIPS.inbox!;
}

export default function RoutinesPage() {
  const templates = useRoutineTemplates();
  const install = useInstallRoutineTemplate();
  const uninstall = useUninstallRoutineTemplate();
  const [view, setView] = useState<"mine" | "explore">("mine");

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
            {mine.length === 0 ? (
              <div className="mt-[18px] flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
                <p className="text-sm font-medium">No routines yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a pre-built routine and it runs on a schedule.
                </p>
                <Button size="sm" className="mt-4" onClick={() => setView("explore")}>
                  Explore routines
                </Button>
              </div>
            ) : (
              <div className="mt-[18px] grid gap-[18px] md:grid-cols-2 xl:grid-cols-3">
                {mine.map((template) => {
                  const { icon: Icon, bg } = chipFor(template);
                  return (
                    <div
                      key={template.id}
                      className="flex min-h-[150px] flex-col gap-3.5 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[11px]", bg)}>
                          <Icon className="size-5 text-white" aria-hidden />
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`${template.name} options`}
                              className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <MoreHorizontalIcon className="size-[18px]" aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem asChild>
                              <Link href={`/jobs?job=${encodeURIComponent(template.installed!.jobId)}`}>
                                View in Jobs
                              </Link>
                            </DropdownMenuItem>
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
                const { icon: Icon, bg } = chipFor(template);
                return (
                  <div
                    key={template.id}
                    className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border bg-card p-[18px]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-[10px]", bg)}>
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
