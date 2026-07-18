import type { PhaseBlock } from "@runtime/types";

// Phase indicator driven by the block's `label`. The runtime emits phase
// strings ("Thinking", "Working: <tool>", "Completed", "Cancelled",
// "Failed"). Tool rows already describe the active work, so the chat keeps
// the working phase generic instead of exposing the internal tool name.
//
// The bouncing-dots animation only renders for non-terminal phases. A
// completed/cancelled/failed phase is a historical marker and should sit
// quietly in the transcript without pulling the eye.
const TERMINAL_LABELS = new Set(["Completed", "Cancelled", "Failed"]);

export function BlockPhase({ block }: { block: PhaseBlock }) {
  const isTerminal = TERMINAL_LABELS.has(block.label);
  const label = block.label.startsWith("Working:") ? "Working" : block.label;
  return (
    <div className="flex min-h-8 items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {isTerminal ? null : (
        <div className="inline-flex items-center gap-1" aria-hidden="true">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
        </div>
      )}
    </div>
  );
}
