"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarCheckIcon, CheckIcon, ClockIcon, InboxIcon, SunriseIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import {
  useInstallRoutineTemplate,
  useRoutineTemplates,
  useUninstallRoutineTemplate,
  type RoutineTemplateView
} from "@/lib/queries";

// Icon-key → presentation mapping for the catalog's `icon` hints. Colors
// match the onboarding StepRoutines cards so the same routine reads the same
// everywhere; unknown keys fall back to the inbox treatment.
const ICONS: Record<string, { icon: LucideIcon; bg: string }> = {
  inbox: { icon: InboxIcon, bg: "bg-[#3554D1]" },
  sunrise: { icon: SunriseIcon, bg: "bg-[#E8834A]" },
  "calendar-check": { icon: CalendarCheckIcon, bg: "bg-[#2E9E6B]" }
};

export default function RoutinesPage() {
  const templates = useRoutineTemplates();
  const install = useInstallRoutineTemplate();
  const uninstall = useUninstallRoutineTemplate();
  // Pre-install checkbox state per template, keyed template id → option key.
  // Missing entries read as the template's defaults; prompts/crons are
  // composed server-side from this toggle state (never in the browser).
  const [options, setOptions] = useState<Record<string, Record<string, boolean>>>({});

  const checked = (template: RoutineTemplateView, key: string): boolean =>
    options[template.id]?.[key] ??
    template.options.find((option) => option.key === key)?.defaultEnabled ??
    false;

  const toggle = (template: RoutineTemplateView, key: string) =>
    setOptions((prev) => ({
      ...prev,
      [template.id]: { ...prev[template.id], [key]: !checked(template, key) }
    }));

  const submitInstall = (template: RoutineTemplateView) => {
    install.mutate(
      {
        id: template.id,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        options: Object.fromEntries(template.options.map((option) => [option.key, checked(template, option.key)]))
      },
      {
        onSuccess: () => toast.success(`Installed ${template.name}`),
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
        description="Routines let Gini handle recurring work for you — install one and it runs on a schedule"
      />
      <div className="flex-1 overflow-auto p-6">
        {templates.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (templates.data?.templates ?? []).length === 0 ? (
          <EmptyState title="No routines available" />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {(templates.data?.templates ?? []).map((template) => {
              const { icon: Icon, bg } = ICONS[template.icon] ?? ICONS.inbox!;
              const pending = install.isPending || uninstall.isPending;
              return (
                <Card key={template.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-center gap-3.5">
                      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px]", bg)}>
                        <Icon className="size-5 text-white" strokeWidth={1.75} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base">{template.name}</CardTitle>
                        <CardDescription>{template.description}</CardDescription>
                      </div>
                      {template.installed ? (
                        <Badge variant="outline" className="shrink-0 text-[10px] text-emerald-600">
                          {template.installed.status === "active" ? "installed" : template.installed.status}
                        </Badge>
                      ) : null}
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-3">
                    {template.options.length > 0 ? (
                      <div
                        className={cn(
                          "flex flex-col",
                          template.installed && "pointer-events-none opacity-50"
                        )}
                      >
                        {template.options.map((option) => (
                          <CheckRow
                            key={option.key}
                            label={option.label}
                            checked={checked(template, option.key)}
                            onChange={() => toggle(template, option.key)}
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ClockIcon className="size-3.5" aria-hidden />
                      {template.scheduleHint}
                    </div>
                    <div className="mt-auto flex items-center gap-2 pt-1">
                      {template.installed ? (
                        <>
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/jobs?job=${encodeURIComponent(template.installed.jobId)}`}>
                              View in Jobs
                            </Link>
                          </Button>
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => submitRemove(template)}>
                            {uninstall.isPending ? "Removing…" : "Remove"}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" disabled={pending} onClick={() => submitInstall(template)}>
                          {install.isPending ? "Installing…" : "Install"}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function CheckRow({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className="flex items-center gap-2.5 py-1.5 text-left"
    >
      <span
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-[5px]",
          checked ? "bg-primary" : "border border-border bg-card"
        )}
        aria-hidden
      >
        {checked ? <CheckIcon className="size-3 text-primary-foreground" strokeWidth={3} /> : null}
      </span>
      <span className={cn("text-sm", checked ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </button>
  );
}
