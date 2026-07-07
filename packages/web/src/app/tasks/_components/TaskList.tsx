"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import type { Task, TaskStatus } from "@runtime/types";
import { formatDuration, isLive, useNow } from "./observability";

export interface TaskFilter {
  key: string;
  label: string;
  match: (task: Task) => boolean;
}

export function TaskList({
  tasks,
  filters,
  filter,
  selected,
  onFilterChange,
  onSelect
}: {
  tasks: Task[];
  filters: readonly TaskFilter[];
  filter: string;
  selected: string | null;
  onFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const matcher = filters.find((f) => f.key === filter)?.match ?? (() => true);
  const filtered = tasks.filter(matcher).slice().reverse();
  const activeLabel = filters.find((f) => f.key === filter)?.label ?? filter;
  // Tick once per second so any visible "running" task row updates its
  // elapsed timer in lockstep. We pay one render/sec for the whole list,
  // not one per row — and only when at least one row actually renders a
  // timer (running rows only; queued/waiting rows have no visible timer).
  const hasLiveRow = filtered.some((t) => t.status === "running");
  const now = useNow(hasLiveRow, 1000);
  return (
    <Tabs value={filter} onValueChange={onFilterChange}>
      <TabsList className="w-full">
        {filters.map((f) => (
          <TabsTrigger key={f.key} value={f.key} className="text-xs">
            {f.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {filters.map((f) => (
        <TabsContent key={f.key} value={f.key} className="mt-3">
          <ScrollArea className="h-[calc(100vh-360px)]">
            {filtered.length === 0 ? (
              <EmptyState title={`No ${activeLabel.toLowerCase()} tasks`} />
            ) : (
              <ul className="space-y-2">
                {filtered.map((task) => (
                  <li key={task.id}>
                    <TaskListRow
                      task={task}
                      selected={selected === task.id}
                      now={now}
                      onSelect={() => onSelect(task.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function TaskListRow({
  task,
  selected,
  now,
  onSelect
}: {
  task: Task;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const live = isLive(task.status);
  // Smooth transition between status-driven colors so the row doesn't snap
  // when a task moves from queued → running → completed.
  const containerClass = `flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors duration-300 ${
    selected ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
  }`;
  const subline =
    task.status === "running"
      ? task.currentStep || task.partialSummary || null
      : null;
  return (
    <button onClick={onSelect} className={containerClass}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {live ? <LiveDot status={task.status} /> : null}
          <span className="line-clamp-1 text-sm font-medium">{task.title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task.status === "running" ? (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatDuration(now - new Date(task.createdAt).getTime())}
            </span>
          ) : null}
          <StatusPill value={task.status} className="transition-colors duration-300" />
        </div>
      </div>
      {subline ? (
        <span className="truncate text-xs text-muted-foreground">{subline}</span>
      ) : null}
      <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
    </button>
  );
}

// Tone the live-dot color to match the StatusPill palette so the row reads
// as a unit (blue=running, amber=waiting, zinc=queued).
const DOT_TONE: Partial<Record<TaskStatus, string>> = {
  queued: "text-zinc-400",
  running: "text-blue-400",
  waiting_approval: "text-amber-400",
  needs_input: "text-amber-400"
};

function LiveDot({ status }: { status: TaskStatus }) {
  const tone = DOT_TONE[status] ?? "text-zinc-400";
  return (
    <span
      className={`gini-live-dot ${tone}`}
      style={{ backgroundColor: "currentColor" }}
      aria-hidden
    />
  );
}
