import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function HomeSectionHeader({
  title,
  count,
  open,
  onToggle,
  action
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5 pb-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span data-ph-capture="true">{title}</span>
        {count === undefined ? null : <span className="opacity-60">· {count}</span>}
      </button>
      {action}
    </div>
  );
}
