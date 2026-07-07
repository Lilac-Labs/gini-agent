// Shared helpers for the tasks page observability surfaces (TaskList row
// animations, TaskDetail duration/cost viz, FleetDashboard sparklines).

import { useEffect, useState } from "react";
import type { Task, TaskStatus } from "@runtime/types";

// Statuses where the task is actively making progress (or queued to). We
// pulse the row indicator and tick the elapsed timer for these.
export const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "running",
  "waiting_approval",
  "needs_input"
]);

export function isLive(status: TaskStatus): boolean {
  return LIVE_STATUSES.has(status);
}

/**
 * Format a millisecond elapsed duration as a compact human string:
 *   < 1m  → "42s"
 *   < 1h  → "1m 23s"
 *   ≥ 1h  → "2h 13m"
 *
 * Negative or NaN values clamp to "0s" rather than throw — the input usually
 * comes from `Date.now() - new Date(createdAt).getTime()` and we don't want
 * a clock-skew blip to crash the row.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec - totalMin * 60;
    return `${totalMin}m ${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin - hours * 60;
  return `${hours}h ${min}m`;
}

/**
 * Ticking hook — returns `Date.now()` on every `intervalMs` until disabled.
 * The component re-renders on each tick so callers can render a live timer
 * without juggling intervals themselves. When `enabled` flips false (task
 * reaches a terminal state) the interval is cleared, freezing the value.
 */
export function useNow(enabled: boolean, intervalMs: number = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

// ─── Fleet dashboard aggregation ──────────────────────────────────────────

/**
 * Bucket numeric values by hour for the last `hours` hours, ending at `now`.
 *
 * Returns an array of length `hours`, oldest first. Each entry is the summed
 * `value(task)` for tasks whose `createdAt` falls within that hour-window.
 *
 * We bucket by absolute hour offset (now-1h, now-2h, …) rather than
 * calendar-hour boundaries so the rightmost bucket is always "the last hour
 * ending right now" — matches the chart's intuition that the right edge is
 * the present moment.
 */
export function bucketByHour(
  tasks: Task[],
  hours: number,
  value: (task: Task) => number,
  now: number = Date.now()
): number[] {
  const out = new Array<number>(hours).fill(0);
  const hourMs = 60 * 60 * 1000;
  const windowStart = now - hours * hourMs;
  for (const task of tasks) {
    const at = new Date(task.createdAt).getTime();
    // Half-open window `(windowStart, now]`: a task whose createdAt lands
    // exactly on the windowStart boundary is excluded, matching the bounds
    // check below which already drops it (idx would equal `hours`).
    if (!Number.isFinite(at) || at <= windowStart || at > now) continue;
    const offsetHours = Math.floor((now - at) / hourMs);
    // offsetHours=0 → most recent bucket (last index). offsetHours=hours-1
    // → oldest bucket (index 0). Clamp just in case of float boundary.
    const idx = hours - 1 - offsetHours;
    if (idx >= 0 && idx < hours) out[idx] += value(task);
  }
  return out;
}

/** Sum of estimatedUsd across all tasks that carry a cost record. */
export function totalCostUsd(tasks: Task[]): number {
  let sum = 0;
  for (const task of tasks) {
    const usd = task.cost?.estimatedUsd;
    if (typeof usd === "number" && Number.isFinite(usd)) sum += usd;
  }
  return sum;
}

/** True if at least one task has a populated estimatedUsd we can chart. */
export function hasAnyCost(tasks: Task[]): boolean {
  return tasks.some((t) => typeof t.cost?.estimatedUsd === "number");
}
