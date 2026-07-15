"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ToolCallBlock, ToolResultBlock } from "@runtime/types";
import { useCancelTask } from "@/lib/queries";
import { terminalCommandPresentation } from "@/lib/tool-call-presentation";
import { iconForTool } from "./tool-icons";

// Pencil "Gini Webapp" tool call row:
//   [icon 15px #9A9AA0] [label HankenGrotesk 13/600 #D6D6DC] [chip flex-1 #2B2B31 monospace 12 #C8C8D2]
// All three sit on a single horizontal row, vertically centered, gap 9.
// Icon is contextual (terminal/file/globe/...) so the user can scan
// the kind of tool at a glance. The whole row is the click target —
// tapping toggles the matching tool_result preview below.
//
// Three render variants:
//   - Default (any tool, any status): the row above. Failed (error/denied)
//     tool calls surface the error string below the row — red by default,
//     muted gray when errorSeverity is "info" (a calm needs-setup notice,
//     e.g. web_search with no connector). terminal_exec renders no chip
//     (its argsPreview is masked server-side); the full command lives in
//     argsFull.command and is revealed on expand, prefixed with `$ `. Gmail
//     commands are the exception: they render as plain-language email actions
//     and keep the CLI syntax + machine-local account path hidden.
//   - Inline spinner (status === "running" && !result, no runningHint):
//     a small Loader2 sits after the chip while the dispatch is in flight.
//     Right for short tools (web_fetch, code_exec).
//   - Amber waiting-card (status === "running" && !result && runningHint):
//     the row is wrapped in an amber-bordered card with the runningHint
//     copy folded in and a Cancel button. Reserved for tools that park on
//     an external event the agent can't drive (e.g. wait_for_messaging_pair
//     blocking on an inbound DM — up to 600s). The Composer's global Stop
//     button still works as an escape hatch; this just co-locates the
//     cancel affordance with the load-bearing state.

export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const cancel = useCancelTask();
  const failed = block.status === "error" || block.status === "denied";
  const running = block.status === "running" && !result;
  const waitingCard = running && Boolean(block.runningHint);
  const inlineSpinner = running && !waitingCard;
  const rawCommand =
    block.toolName === "terminal_exec" ? String(block.argsFull?.command ?? "") : "";
  const presentation = terminalCommandPresentation(block.displayLabel, rawCommand);
  const command = presentation.command;
  const canExpand = Boolean(result) || Boolean(command);
  const Icon = iconForTool(block.toolName);

  const row = (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 py-0.5 text-left disabled:cursor-default"
      disabled={!canExpand}
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
    >
      <Icon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 text-[13px] font-semibold text-foreground">
        {presentation.label}
      </span>
      {block.argsPreview ? (
        <span className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-[3px] font-mono text-[12px] text-foreground">
          {block.argsPreview}
        </span>
      ) : null}
      {inlineSpinner ? (
        <Loader2
          className="size-[14px] shrink-0 animate-spin text-muted-foreground"
          aria-label="Running"
        />
      ) : null}
    </button>
  );

  if (waitingCard) {
    const onCancel = () => {
      if (!block.taskId || cancel.isPending) return;
      cancel.mutate(block.taskId, {
        onError: (err: Error) => toast.error(`Cancel failed: ${err.message}`)
      });
    };
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2.5">
          {row}
          <Loader2
            className="size-[14px] shrink-0 animate-spin text-amber-400"
            aria-label="Waiting"
          />
        </div>
        {block.runningHint ? (
          <p className="text-[13px] leading-snug text-foreground">{block.runningHint}</p>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-amber-400/80">
            Waiting on external event
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={!block.taskId || cancel.isPending}
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px] font-semibold text-amber-300 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {row}
      {failed && block.errorMessage ? (
        <span
          className={`pl-[23px] text-[12px] ${
            block.errorSeverity === "info" ? "text-muted-foreground" : "text-red-400/90"
          }`}
        >
          {block.errorMessage}
        </span>
      ) : null}
      {expanded && (command || result) ? (
        <div className="ml-[23px] flex flex-col gap-1.5">
          {command ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 font-mono text-[12px] text-foreground">
              <span className="select-none text-muted-foreground">$ </span>
              {command}
            </pre>
          ) : null}
          {result ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 font-mono text-[12px] text-foreground">
              {result.preview}
              {result.truncated ? "\n\n[truncated]" : ""}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
