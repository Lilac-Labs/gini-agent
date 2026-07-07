"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { UsageDay } from "@/lib/queries";
import type { AgentRow } from "@/lib/view-types";

// Sentinel for the "sum across every agent" option in the agent dropdown; any
// concrete agent id pins the chart to that agent. Exported so the home page,
// which owns the filter state, agrees on the value.
export const TOKEN_USAGE_ALL_AGENTS = "__all__";

// Daily token-usage chart for the home page. Renders a stacked bar per day
// (input on the bottom, output on top) over the supplied window, plus a
// headline for today's tokens + USD and a legend with window totals. Data is
// the server-side usage ledger (GET /api/usage), so it covers every generative
// call — chat, jobs, subagents, memory, titles, vision — not just task.cost.
// Hand-built SVG to match the in-house viz style (StatusDonut / Sparkline /
// TokenBar); the web app ships no charting library.

// Match TokenBar in TaskDetail.tsx: input = blue-500/70, output = emerald-500/70.
const INPUT_COLOR = "#3b82f6";
const OUTPUT_COLOR = "#10b981";
const SERIES_OPACITY = 0.7;

// Label every Nth bar on the date axis so 14 ticks don't crowd. Today and the
// oldest day are always labeled.
const AXIS_LABEL_EVERY = 3;

function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

// Tokens charted per day = input + output (what the stacked bar shows). We key
// off this rather than the ledger's `total` so the bar height and the labels
// always agree, even when a provider's total bundles cache tokens.
function dayTokens(d: UsageDay): number {
  return d.input + d.output;
}

export function TokenUsageChart({
  days,
  agents,
  selectedAgentId,
  onSelectAgent
}: {
  days: UsageDay[];
  agents: AgentRow[];
  selectedAgentId: string;
  onSelectAgent: (value: string) => void;
}) {
  const today = days[days.length - 1];
  const todayTokens = today ? dayTokens(today) : 0;
  const todayUsd = today?.estimatedUsd ?? 0;
  const windowInput = days.reduce((sum, d) => sum + d.input, 0);
  const windowOutput = days.reduce((sum, d) => sum + d.output, 0);
  const windowUsd = days.reduce((sum, d) => sum + d.estimatedUsd, 0);
  const maxTotal = days.reduce((max, d) => Math.max(max, dayTokens(d)), 0);
  const hasData = maxTotal > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Token usage</CardTitle>
            <CardDescription>Input vs output tokens per day · last {days.length || 14} days</CardDescription>
          </div>
          <Select value={selectedAgentId} onValueChange={onSelectAgent}>
            <SelectTrigger size="sm" aria-label="Filter token usage by agent" className="min-w-[9rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOKEN_USAGE_ALL_AGENTS}>All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{todayTokens.toLocaleString()}</span>
            <span className="font-mono text-sm tabular-nums text-muted-foreground">{formatUsd(todayUsd)}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="text-muted-foreground">today</span>
            <Swatch color={INPUT_COLOR} label="Input" value={today?.input ?? 0} />
            <Swatch color={OUTPUT_COLOR} label="Output" value={today?.output ?? 0} />
          </p>
        </div>

        {hasData ? (
          <DailyBars days={days} maxTotal={maxTotal} />
        ) : (
          <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border bg-muted/30">
            <p className="text-[11px] text-muted-foreground">No token usage yet — run a task to see consumption.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-[11px]">
          <Swatch color={INPUT_COLOR} label="Input" value={windowInput} />
          <Swatch color={OUTPUT_COLOR} label="Output" value={windowOutput} />
          <span className="font-mono tabular-nums text-muted-foreground">
            {(windowInput + windowOutput).toLocaleString()} tokens · {formatUsd(windowUsd)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function DailyBars({ days, maxTotal }: { days: UsageDay[]; maxTotal: number }) {
  // Square viewBox stretched to the box (preserveAspectRatio="none"); only
  // axis-free rects live in it, so the horizontal stretch is harmless. Each
  // day owns a band; the bar fills 70% of the band, stacked input-on-bottom.
  const H = 100;
  const W = 100;
  const band = W / days.length;
  const barW = band * 0.7;
  const inset = (band - barW) / 2;
  const lastIndex = days.length - 1;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label="Daily token usage, input and output tokens per day"
      >
        {days.map((day, i) => {
          const total = day.input + day.output;
          // A nonzero day always shows at least a 2-unit sliver so it never
          // visually reads as empty; a true-zero day stays flat.
          const totalH = total > 0 ? Math.max((total / maxTotal) * H, 2) : 0;
          const inputH = total > 0 ? (day.input / total) * totalH : 0;
          const outputH = totalH - inputH;
          const x = i * band + inset;
          return (
            <g key={day.day}>
              {/* Full-band transparent hit target so every day — including
                  empty ones — surfaces a hover tooltip. */}
              <rect x={i * band} y={0} width={band} height={H} fill="transparent">
                <title>{tooltip(day)}</title>
              </rect>
              {total > 0 ? (
                <>
                  <rect x={x} y={H - inputH} width={barW} height={inputH} fill={INPUT_COLOR} opacity={SERIES_OPACITY} />
                  <rect x={x} y={H - totalH} width={barW} height={outputH} fill={OUTPUT_COLOR} opacity={SERIES_OPACITY} />
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex">
        {days.map((day, i) => {
          const showLabel = i === lastIndex || i === 0 || i % AXIS_LABEL_EVERY === 0;
          const isToday = i === lastIndex;
          return (
            <span
              key={day.day}
              className={`min-w-0 flex-1 text-center text-[9px] tabular-nums ${isToday ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              {showLabel ? formatAxis(day.dayStart) : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Swatch({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: color, opacity: SERIES_OPACITY }}
        aria-hidden
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value.toLocaleString()}</span>
    </span>
  );
}

// Tooltip for a bar: the date, in/out/total tokens + USD, then the per-source
// breakdown (chat / job / subagent / memory / …) so the user can see where the
// day's tokens went.
function tooltip(day: UsageDay): string {
  const total = day.input + day.output;
  const header = `${formatDay(day.dayStart)} — ${day.input.toLocaleString()} in · ${day.output.toLocaleString()} out (${total.toLocaleString()} tokens · ${formatUsd(day.estimatedUsd)})`;
  const sources = Object.entries(day.bySource)
    .map(([source, s]) => ({ source, tokens: (s?.input ?? 0) + (s?.output ?? 0) }))
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((s) => `${s.source}: ${s.tokens.toLocaleString()}`);
  return sources.length > 0 ? `${header}\n${sources.join("\n")}` : header;
}

// "Jun 17" — full label for tooltips.
function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "17" — compact day-of-month for the axis.
function formatAxis(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric" });
}
