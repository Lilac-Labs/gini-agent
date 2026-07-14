"use client";

// The People-page extraction indicator + manual Sync control. Presentational:
// it renders the view model from extractionView() and calls onSync when the
// user asks to sync (which starts an idle pipeline, resumes a paused one, or
// forces an immediate poll on a running one). Kept separate from page.tsx so
// the dot/label/button rendering is unit-testable without the DOM-heavy page.
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtractionTone, ExtractionView } from "./_lib";

// Static-dot color per state (the running case uses the pulsing .gini-live-dot
// instead). Amber flags paused as a user-owned halt, distinct from idle/off.
const STATIC_DOT: Record<ExtractionTone, string> = {
  running: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
  paused: "bg-amber-500",
  disabled: "bg-muted-foreground/40",
};

export function ExtractionBar({
  view,
  pending,
  onSync,
}: {
  view: ExtractionView;
  pending: boolean;
  onSync: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {view.live ? (
          <span className="gini-live-dot text-emerald-500" data-testid="extraction-dot-live" />
        ) : (
          <span className={`size-[7px] rounded-full ${STATIC_DOT[view.tone]}`} data-testid="extraction-dot" />
        )}
        {view.label}
      </span>
      {view.canSync ? (
        <Button variant="outline" size="sm" disabled={pending} onClick={onSync}>
          <RefreshCw className={pending ? "animate-spin" : ""} />
          {pending ? "Syncing…" : "Sync"}
        </Button>
      ) : null}
    </div>
  );
}
