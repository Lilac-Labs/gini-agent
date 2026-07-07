import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  queued: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  running: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  waiting_approval: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  needs_input: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  approved: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  enabled: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  applied: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  denied: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  rejected: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  conflicted: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  cancelled: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  expired: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  paused: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  archived: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  proposed: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
  configured: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  disabled: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  degraded: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  pass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  partial: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  missing: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
};

export function StatusPill({ value, className }: { value: string; className?: string }) {
  const tone = TONES[value] ?? "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30";
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px] font-semibold uppercase tracking-wide", tone, className)}>
      {value.replace(/_/g, " ")}
    </Badge>
  );
}

export function RiskPill({ value }: { value: string }) {
  const tone =
    value === "high"
      ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
      : value === "medium"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px] font-semibold uppercase tracking-wide", tone)}>
      {value} risk
    </Badge>
  );
}
