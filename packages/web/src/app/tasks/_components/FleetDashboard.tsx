"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { RuntimeStatus, Task, TaskStatus } from "@runtime/types";
import { bucketByHour, hasAnyCost, totalCostUsd, useNow } from "./observability";

// Fleet dashboard strip — three small charts that summarize the whole task
// list / runtime status without making any extra network calls. The status
// donut reads from RuntimeStatus.taskCounts (pre-aggregated by the runtime);
// both sparklines aggregate from the already-polled Task list. No trace
// data is fetched here — that would scale as N tasks × per-task /tasks/:id
// round trips, which we explicitly ruled out.

const STATUS_ORDER: TaskStatus[] = [
  "running",
  "queued",
  "waiting_approval",
  "needs_input",
  "completed",
  "failed",
  "cancelled"
];

// Tones picked to match StatusPill so the donut + legend reads consistent
// with the per-row pills in TaskList. CSS variable-based tones don't render
// inside SVG fill (svg consumes the value at paint time), so we use literal
// hex values for the donut segments and ship the same hex into the legend
// chip via inline style.
const STATUS_COLOR: Record<TaskStatus, string> = {
  running: "#60a5fa",
  queued: "#a1a1aa",
  waiting_approval: "#fbbf24",
  needs_input: "#fbbf24",
  completed: "#34d399",
  failed: "#f87171",
  cancelled: "#a1a1aa"
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running",
  queued: "Queued",
  waiting_approval: "Waiting",
  needs_input: "Needs input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};

export function FleetDashboard({
  tasks,
  status,
  isPending = false,
  isError = false
}: {
  tasks: Task[];
  status: RuntimeStatus | undefined;
  isPending?: boolean;
  isError?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(true);
  // Re-tick once a minute so the 24h window rolls forward even when React
  // Query's structural sharing keeps the `tasks` array reference stable
  // across polls — without this, `Date.now()` would freeze at first render.
  const nowTick = useNow(true, 60_000);
  // The 60s ticker drives natural left-edge progression (old tasks aging out
  // of the 24h window), but it's too coarse for the right edge: a task whose
  // createdAt is newer than the last tick would fall outside the
  // (windowStart, now] half-open window and silently disappear from the
  // sparkline until the next tick. Extend `now` to include the newest data
  // we currently see so freshly-submitted tasks land in the rightmost bucket
  // immediately. This is cheaper and more correct than tightening the
  // ticker cadence.
  const latestTaskAt = tasks.reduce((acc, t) => {
    const created = new Date(t.createdAt).getTime();
    const updated = new Date(t.updatedAt).getTime();
    return Math.max(acc, created, updated);
  }, 0);
  const effectiveNow = Math.max(nowTick, latestTaskAt);
  // Recompute the 24-hour buckets when the task list changes or the minute
  // ticker advances. Hour-bucket math is cheap (O(n)) but we don't want to
  // thrash on every parent rerender either.
  const buckets = useMemo(() => {
    const taskCounts = bucketByHour(tasks, 24, () => 1, effectiveNow);
    const costCounts = bucketByHour(
      tasks,
      24,
      (t) => (typeof t.cost?.estimatedUsd === "number" ? t.cost.estimatedUsd : 0),
      effectiveNow
    );
    return { taskCounts, costCounts };
  }, [tasks, effectiveNow]);
  const tasksLast24h = buckets.taskCounts.reduce((a, b) => a + b, 0);
  const costLast24h = buckets.costCounts.reduce((a, b) => a + b, 0);
  const showCost = hasAnyCost(tasks);
  const allTimeCost = totalCostUsd(tasks);

  if (isPending || isError) {
    // Match Card chrome so the page doesn't reflow when data arrives. Use
    // muted placeholders for the three columns — no fake numbers.
    const message = isError ? "Failed to load tasks" : "Loading…";
    return (
      <Card size="sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Fleet overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <LoadingColumn label="Status mix" message={message} />
            <LoadingColumn label="Tasks per hour" message={message} />
            <LoadingColumn label="Cost per hour" message={message} />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (tasks.length === 0) {
    // Honest empty state — no fake bars, no fake dot. The whole point of
    // the dashboard is to summarize what the runtime is doing; with no
    // tasks there's literally nothing to summarize.
    return (
      <Card size="sm">
        <CardContent>
          <p className="text-xs text-muted-foreground">
            No tasks yet — submit one to see the dashboard come alive.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Fleet overview</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={open ? "Collapse fleet overview" : "Expand fleet overview"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </CardHeader>
      {open ? (
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <StatusDonut status={status} />
            <Sparkline
              title={`${tasksLast24h} tasks in last 24h`}
              points={buckets.taskCounts}
              tone="#60a5fa"
              valueLabel={(v) => `${v} task${v === 1 ? "" : "s"}`}
            />
            {showCost ? (
              <Sparkline
                title={`$${costLast24h.toFixed(4)} in last 24h`}
                subtitle={`All-time $${allTimeCost.toFixed(4)}`}
                points={buckets.costCounts}
                tone="#34d399"
                valueLabel={(v) => `$${v.toFixed(4)}`}
              />
            ) : (
              <EmptyChartCard title="Cost" message="No cost data yet" />
            )}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function StatusDonut({ status }: { status: RuntimeStatus | undefined }) {
  // We treat taskCounts as the ground truth for current state — runtime
  // computes it from the live task store, which can differ slightly from
  // the polled Task list if a status transitioned mid-poll. If /status
  // hasn't loaded yet, render a placeholder donut rather than nothing so
  // the layout doesn't reflow.
  const counts = status?.taskCounts;
  const segments = STATUS_ORDER.map((s) => ({
    status: s,
    value: counts ? counts[s] ?? 0 : 0
  })).filter((seg) => seg.value > 0);
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="self-start text-xs font-medium text-muted-foreground">Status mix</p>
      <div className="flex w-full items-center justify-center">
        <svg viewBox="0 0 100 100" className="h-32 w-32" aria-label={`Status donut, ${total} tasks total`}>
          {/* Background ring — gives the empty state shape and serves as a
              base for narrow segments so they don't disappear at 0%. Use a
              className-driven stroke so it picks up the theme's muted color
              (--muted is oklch, not hsl, so we can't use stroke="hsl(var(--muted))"). */}
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            strokeWidth="12"
            className="stroke-muted"
          />
          {total > 0 ? <DonutSegments segments={segments} total={total} /> : null}
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-foreground"
            fontSize="18"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {total}
          </text>
          <text
            x="50"
            y="64"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-muted-foreground"
            fontSize="6"
          >
            tasks
          </text>
        </svg>
      </div>
      <ul className="grid w-full grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        {STATUS_ORDER.map((s) => {
          const value = counts ? counts[s] ?? 0 : 0;
          if (value === 0) return null;
          return (
            <li key={s} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: STATUS_COLOR[s] }}
                  aria-hidden
                />
                <span className="text-muted-foreground">{STATUS_LABEL[s]}</span>
              </span>
              <span className="font-mono tabular-nums">{value}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DonutSegments({
  segments,
  total
}: {
  segments: Array<{ status: TaskStatus; value: number }>;
  total: number;
}) {
  // Render the donut as overlapping circle arcs using stroke-dasharray. We
  // walk the segments and accumulate the stroke offset so each segment
  // starts where the previous one ended. Circumference is 2πr with r=40,
  // so the dash array totals 2π·40 ≈ 251.327 units.
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;
  return (
    <g transform="rotate(-90 50 50)">
      {segments.map((seg) => {
        const fraction = seg.value / total;
        const length = fraction * circumference;
        const arc = (
          <circle
            key={seg.status}
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={STATUS_COLOR[seg.status]}
            strokeWidth="12"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-consumed}
          />
        );
        consumed += length;
        return arc;
      })}
    </g>
  );
}

function Sparkline({
  title,
  subtitle,
  points,
  tone,
  valueLabel
}: {
  title: string;
  subtitle?: string;
  points: number[];
  tone: string;
  valueLabel: (value: number) => string;
}) {
  // Layout: 200×60 viewBox, 4px padding on top/bottom for the marker
  // circles, points evenly spaced across width. Empty (all-zero) series
  // still renders a flat baseline so the card has structure rather than
  // collapsing to an unsightly blank.
  const width = 200;
  const height = 60;
  const padding = 4;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const coords = points.map((value, i) => {
    const x = padding + i * step;
    const y = height - padding - (value / max) * (height - padding * 2);
    return { x, y, value };
  });
  const polyline = coords.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  // Area fill underneath the line — light tint of the line color, helps
  // the eye trace volume rather than just slope.
  const area = coords.length
    ? `${padding},${height - padding} ${polyline} ${(width - padding).toFixed(2)},${height - padding}`
    : "";
  const lastValue = points[points.length - 1] ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium">{title}</p>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          now: {valueLabel(lastValue)}
        </span>
      </div>
      {subtitle ? <p className="text-[10px] text-muted-foreground">{subtitle}</p> : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        aria-label={title}
      >
        <polygon points={area} fill={tone} opacity={0.12} />
        <polyline
          points={polyline}
          fill="none"
          stroke={tone}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={1.5} fill={tone} />
        ))}
      </svg>
      <p className="text-[10px] text-muted-foreground">Past 24 hours, hourly buckets</p>
    </div>
  );
}

function LoadingColumn({ label, message }: { label: string; message: string }) {
  // Mirrors the layout of a real column (title row + chart-height block) so
  // the page doesn't jump when data finishes loading. Center cell uses an
  // em dash rather than a fake number.
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex h-16 items-center justify-center rounded-md border border-dashed border-border bg-muted/30">
        <p className="text-[11px] text-muted-foreground">{message}</p>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">—</p>
    </div>
  );
}

function EmptyChartCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium">{title}</p>
      <div className="flex h-16 items-center justify-center rounded-md border border-dashed border-border bg-muted/30">
        <p className="text-[11px] text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
