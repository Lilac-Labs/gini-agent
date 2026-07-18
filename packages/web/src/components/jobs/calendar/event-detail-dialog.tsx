"use client";

import React from "react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { CalendarRunEntry as CronRunLogEntry } from "@/components/calendar/types";
import { cn } from "@/lib/utils";
import { COLOR_CLASSES, type EventColor } from "@/components/calendar/calendar-colors";
import {
  type CalendarEvent,
  formatTimestamp,
  getScheduleDescription,
  getTaskContent,
  isSameDay,
  runKey
} from "@/components/calendar/calendar-utils";

type Tab = "run" | "task";

interface EventDetailDialogProps {
  event: CalendarEvent | null;
  color: EventColor | null;
  today: Date;
  runStatusMap: Map<string, CronRunLogEntry>;
  onClose: () => void;
}

export function EventDetailDialog({
  event,
  color,
  today,
  runStatusMap,
  onClose
}: EventDetailDialogProps) {
  const [tab, setTab] = React.useState<Tab>("run");
  const accentClasses = color ? COLOR_CLASSES[color] : null;
  const job = event?.job ?? null;

  // Reset to "run" tab when a new event is selected
  React.useEffect(() => {
    if (event) setTab("run");
  }, [event]);

  const isPast = event != null && event.day.getTime() < today.getTime();
  const isFuture = event != null && event.day.getTime() > today.getTime();
  const isToday = event != null && isSameDay(event.day, today);

  const runEntry = event && job ? runStatusMap.get(runKey(job.id, event.day)) : undefined;

  const runDateLabel = event
    ? event.day.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric"
      })
    : "";

  return (
    <Dialog
      open={event !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {accentClasses && (
              <span className={cn("h-2.5 w-2.5 rounded-full", accentClasses.dot)} />
            )}
            {job?.name || job?.id || "Scheduled task"}
          </DialogTitle>
          <DialogDescription>{job ? getScheduleDescription(job) : ""}</DialogDescription>
        </DialogHeader>

        {job && (
          <div className="space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === "run"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setTab("run")}
              >
                Run
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === "task"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setTab("task")}
              >
                Task
              </button>
            </div>

            {tab === "run" && (
              <div className="space-y-3">
                {/* Run date */}
                <div className="text-sm font-medium text-foreground">{runDateLabel}</div>

                {/* Completed run data (past or today) */}
                {runEntry && (
                  <>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={cn(
                          "text-xs",
                          runEntry.status === "ok"
                            ? "border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
                            : runEntry.status === "error"
                              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                              : "border-border bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {runEntry.status === "ok"
                          ? "Success"
                          : runEntry.status === "error"
                            ? "Failed"
                            : "Skipped"}
                      </Badge>
                      {runEntry.durationMs != null && (
                        <span className="text-xs text-muted-foreground">
                          {(runEntry.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div className="text-muted-foreground">Ran at</div>
                      <div className="text-foreground">
                        {formatTimestamp(runEntry.runAtMs ?? runEntry.ts)}
                      </div>
                      {runEntry.model && (
                        <>
                          <div className="text-muted-foreground">Model</div>
                          <div className="text-foreground">{runEntry.model}</div>
                        </>
                      )}
                    </div>

                    {runEntry.summary && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap text-foreground">
                        {runEntry.summary}
                      </div>
                    )}
                  </>
                )}

                {/* Past day with no run data */}
                {isPast && !runEntry && (
                  <p className="text-sm text-muted-foreground">No run data available for this date.</p>
                )}

                {/* Future, or today without a completed run */}
                {(isFuture || (isToday && !runEntry)) && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="text-muted-foreground">Scheduled</div>
                    <div className="text-foreground">
                      {event?.timeLabel && event.timeLabel !== "Any time"
                        ? event.timeLabel
                        : "Any time"}
                    </div>
                    {job.state?.nextRunAtMs && (
                      <>
                        <div className="text-muted-foreground">Next run</div>
                        <div className="text-foreground">
                          {formatTimestamp(job.state.nextRunAtMs)}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Error details */}
                {runEntry?.error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                    {runEntry.error}
                  </div>
                )}
              </div>
            )}

            {tab === "task" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={
                      job.enabled
                        ? "border-green-300 bg-green-50 text-green-800 text-xs dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
                        : "border-red-300 bg-red-50 text-red-800 text-xs dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                    }
                  >
                    {job.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap text-foreground">
                  {getTaskContent(job)}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
