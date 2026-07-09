"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { JobRecord } from "@runtime/types";
import { humanCron } from "./schedule-label";

type ScheduleMode = "interval" | "cron";

// `trigger` swaps the default "Edit" button for a caller-styled element
// (rendered via DialogTrigger asChild), so surfaces like the routine detail
// hero can open the dialog from their own action row.
export function EditJobDialog({ job, trigger }: { job: JobRecord; trigger?: React.ReactNode }) {
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  // Schedule mode: interval-driven (intervalSeconds) or cron-driven
  // (cronExpression + cronTimezone). Initial mode is derived from the job
  // record so a cron job opens straight into cron mode. The runtime accepts
  // four transitions (interval->interval, cron->cron, interval->cron,
  // cron->interval); we just produce the right patch shape in submit().
  const [mode, setMode] = useState<ScheduleMode>(job.cronExpression ? "cron" : "interval");
  // Per the brief: editable fields are schedule (interval seconds OR cron
  // expression + timezone), retryLimit, timeoutSeconds, costBudget,
  // deliveryTargets[].
  // For a cron-driven job (no intervalSeconds), prefill the input with "60"
  // as a sensible default for when the user switches the mode toggle to
  // Interval. For an interval-driven job, prefill with the current value.
  // A defensive fallback of "" handles a record that's lost its interval
  // (hand-edited state) so the input doesn't render "undefined".
  const [intervalSeconds, setIntervalSeconds] = useState(
    job.cronExpression
      ? "60"
      : job.intervalSeconds !== undefined
        ? String(job.intervalSeconds)
        : ""
  );
  const [cronExpression, setCronExpression] = useState(job.cronExpression ?? "");
  const [cronTimezone, setCronTimezone] = useState(job.cronTimezone ?? "UTC");
  const [retryLimit, setRetryLimit] = useState(String(job.retryLimit));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(job.timeoutSeconds));
  const [costBudget, setCostBudget] = useState(typeof job.costBudget === "number" ? String(job.costBudget) : "");
  const [deliveryTargetsRaw, setDeliveryTargetsRaw] = useState((job.deliveryTargets ?? []).join(", "));

  // The selected job can change while this component instance is reused
  // (a parent can re-render with a different `job` record). Reset form
  // state when the job id changes
  // OR when the dialog opens — otherwise edits silently overwrite the wrong
  // record with stale field values from the previous selection. The mode
  // gets reset alongside the fields so opening on a cron job after editing
  // an interval one doesn't strand the form in the wrong shape.
  useEffect(() => {
    setMode(job.cronExpression ? "cron" : "interval");
    setIntervalSeconds(
      job.cronExpression
        ? "60"
        : job.intervalSeconds !== undefined
          ? String(job.intervalSeconds)
          : ""
    );
    setCronExpression(job.cronExpression ?? "");
    setCronTimezone(job.cronTimezone ?? "UTC");
    setRetryLimit(String(job.retryLimit));
    setTimeoutSeconds(String(job.timeoutSeconds));
    setCostBudget(typeof job.costBudget === "number" ? String(job.costBudget) : "");
    setDeliveryTargetsRaw((job.deliveryTargets ?? []).join(", "));
  }, [job.id, job.intervalSeconds, job.cronExpression, job.cronTimezone, job.retryLimit, job.timeoutSeconds, job.costBudget, job.deliveryTargets, open]);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<JobRecord>(`/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success(`Job updated: ${job.id}`);
      invalidate(["jobs", "events"]);
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  function submit() {
    const patch: Record<string, unknown> = {};
    // Schedule fields depend on the selected mode. We send the inactive
    // mode's fields as `null` so the runtime clears them — that's how the
    // cron->interval and interval->cron switches stay in a coherent shape
    // server-side (mirrors how `costBudget: null` already clears the budget).
    if (mode === "interval") {
      const interval = Number(intervalSeconds);
      if (Number.isFinite(interval) && interval > 0) patch.intervalSeconds = interval;
      patch.cronExpression = null;
      patch.cronTimezone = null;
    } else {
      const expr = cronExpression.trim();
      if (expr.length > 0) patch.cronExpression = expr;
      const tz = cronTimezone.trim();
      patch.cronTimezone = tz.length > 0 ? tz : "UTC";
      patch.intervalSeconds = null;
    }
    const retry = Number(retryLimit);
    if (Number.isFinite(retry) && retry >= 0) patch.retryLimit = retry;
    const timeout = Number(timeoutSeconds);
    if (Number.isFinite(timeout) && timeout > 0) patch.timeoutSeconds = timeout;
    if (costBudget.trim() === "") {
      // Empty input means "clear the budget". The runtime's updateJob
      // explicitly handles `costBudget: null` as the clearing path; sending
      // `undefined` (or omitting the field) would leave the prior value
      // in place.
      patch.costBudget = null;
    } else {
      const budget = Number(costBudget);
      if (Number.isFinite(budget) && budget >= 0) patch.costBudget = budget;
    }
    const targets = deliveryTargetsRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    patch.deliveryTargets = targets;
    update.mutate(patch);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button size="sm" variant="outline">Edit</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit job</DialogTitle>
          <DialogDescription className="font-mono text-[11px]">{job.id}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Schedule mode</Label>
            <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Schedule mode">
              <Button
                type="button"
                size="sm"
                variant={mode === "interval" ? "default" : "ghost"}
                role="radio"
                aria-checked={mode === "interval"}
                onClick={() => setMode("interval")}
              >
                Interval
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "cron" ? "default" : "ghost"}
                role="radio"
                aria-checked={mode === "cron"}
                onClick={() => setMode("cron")}
              >
                Cron
              </Button>
            </div>
          </div>
          {mode === "interval" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="job-interval">Schedule (interval seconds)</Label>
              <Input
                id="job-interval"
                type="number"
                min={1}
                value={intervalSeconds}
                onChange={(event) => setIntervalSeconds(event.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="job-cron-expression">Cron expression</Label>
                <Input
                  id="job-cron-expression"
                  className="font-mono"
                  placeholder="0 9 * * *"
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.target.value)}
                />
                {(() => {
                  // Live human-English rendering of the user's cron input
                  // via cronstrue. Returns null for unparseable patterns;
                  // we just hide the helper line in that case rather than
                  // surface a stack trace under the input.
                  const human = humanCron(cronExpression);
                  return human ? (
                    <p className="text-[11px] text-foreground">{human}</p>
                  ) : null;
                })()}
                <p className="text-[10px] text-muted-foreground">
                  5-field Unix cron: minute hour day-of-month month day-of-week. 0=Sunday.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="job-cron-timezone">Timezone</Label>
                <Input
                  id="job-cron-timezone"
                  className="font-mono"
                  placeholder="America/Los_Angeles"
                  value={cronTimezone}
                  onChange={(event) => setCronTimezone(event.target.value)}
                />
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="job-retry">Retry limit</Label>
              <Input
                id="job-retry"
                type="number"
                min={0}
                value={retryLimit}
                onChange={(event) => setRetryLimit(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-timeout">Timeout (seconds)</Label>
              <Input
                id="job-timeout"
                type="number"
                min={1}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-budget">Cost budget (USD)</Label>
            <Input
              id="job-budget"
              type="number"
              min={0}
              step="0.01"
              placeholder="—"
              value={costBudget}
              onChange={(event) => setCostBudget(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="job-targets">Delivery targets</Label>
            <Input
              id="job-targets"
              placeholder="local, slack-bridge"
              value={deliveryTargetsRaw}
              onChange={(event) => setDeliveryTargetsRaw(event.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">Comma-separated.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={update.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
