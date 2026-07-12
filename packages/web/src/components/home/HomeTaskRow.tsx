"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RoutineChip } from "@/components/chat/RoutineCreatedCard";
import { useTopicPanel } from "@/components/chat/TopicPanelContext";
import { HomeNeedsInput } from "@/components/home/HomeNeedsInput";
import { api } from "@/lib/api";
import { useAcknowledgeTask, useInvalidate, type HomeView } from "@/lib/queries";
import type { HomeTaskItem } from "@runtime/types";

// One attention-queue row. The whole row (and the review button) opens the
// container thread in the home page's right-side TopicPanel drawer; without
// a panel provider it falls back to the /chat?session=<id> deep link (the
// TopicForwardChip idiom). Interactive children (checkbox, review button,
// the needs-input expander) stop propagation. The row is a div-with-onClick,
// not a Link, because it nests buttons/inputs.
export function HomeTaskRow({
  item,
  workingText
}: {
  item: HomeTaskItem;
  workingText?: string;
}) {
  const router = useRouter();
  const panel = useTopicPanel();
  const acknowledge = useAcknowledgeTask();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const [expanded, setExpanded] = useState(false);
  const href = `/chat?session=${item.id}`;
  // Re-ask a failed run: POST /api/containers/:id/retry — the server looks
  // up the failed run's original input and re-submits it into the container
  // thread (follow-up continuity mints the new run). The row flips to
  // working optimistically; the refetch confirms.
  const retry = useMutation({
    mutationFn: () => api(`/containers/${item.id}/retry`, { method: "POST" }),
    onSuccess: () => {
      qc.setQueriesData<HomeView>({ queryKey: ["home"] }, (prev) =>
        prev
          ? {
              ...prev,
              tasks: prev.tasks.map((t) =>
                t.id === item.id
                  ? {
                      ...t,
                      attention: "working",
                      failed: undefined,
                      outcomeLine: undefined
                    }
                  : t
              )
            }
          : prev
      );
      invalidate(["home", "chat", "tasks"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  // Optimistic rows carry a client-minted id until useStartTask swaps in the
  // real container id — neither the deep link nor acknowledge exists yet.
  const isOptimistic = item.id.startsWith("optimistic-");
  // Only a finished-but-unseen outcome is acknowledgeable; on live rows the
  // checkbox renders identically but stays inert (there is no outcome yet).
  const acknowledgeable = item.attention === "done_unacknowledged";
  // Open the container thread: in the home right-side panel when the provider
  // is mounted, else full-page navigation.
  const openThread = () => {
    if (isOptimistic) return;
    if (panel) panel.openTopic(item.id);
    else router.push(href);
  };

  return (
    <div
      role={panel ? "button" : "link"}
      aria-expanded={panel ? panel.openTopicId === item.id : undefined}
      tabIndex={0}
      onClick={openThread}
      onKeyDown={(event) => {
        // Only keys pressed on the row itself activate it — Enter/Space on
        // the nested checkbox/expander/review controls bubble up here.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openThread();
        }
      }}
      className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-2.5 transition-colors outline-none hover:bg-accent/45 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <button
        type="button"
        aria-disabled={!acknowledgeable}
        aria-label={
          acknowledgeable
            ? item.acknowledged
              ? "Acknowledged"
              : `Mark ${item.title} done`
            : `${item.title} has no outcome to acknowledge yet`
        }
        onClick={(event) => {
          event.stopPropagation();
          if (!isOptimistic && !item.acknowledged && acknowledgeable) acknowledge.mutate(item.id);
        }}
        className="group/check -m-1.5 mt-[-4px] shrink-0 p-1.5"
      >
        <span className="relative block size-[17px] rounded-sm border-[1.5px] border-foreground/30 transition-colors group-hover/check:border-sidebar-primary">
          {item.acknowledged ? (
            <span className="absolute -inset-[1.5px] flex items-center justify-center rounded-sm bg-sidebar-primary">
              <Check className="size-3 text-white" strokeWidth={3} />
            </span>
          ) : null}
        </span>
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-[14px] font-medium text-foreground">{item.title}</div>

        {item.attention === "done_unacknowledged" && item.outcomeLine ? (
          // A failed outcome must not read like a normal done line: the
          // design HTML has no error-row treatment, so it takes the app's
          // destructive token (red in both themes) for the dot and text.
          <div
            className={`flex items-center gap-2 text-xs ${
              item.failed ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                item.failed ? "bg-destructive" : "bg-sidebar-primary"
              }`}
            />
            <span className="min-w-0 truncate">{item.outcomeLine}</span>
          </div>
        ) : null}

        {item.attention === "working" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="gini-live-dot text-sidebar-primary"
              style={{ backgroundColor: "currentColor" }}
              aria-hidden
            />
            <span className="min-w-0 truncate">{workingText ?? "Working…"}</span>
          </div>
        ) : null}

        {item.attention === "needs_input" ? (
          item.needsInput ? (
            <>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded((v) => !v);
                }}
                className="text-left text-xs text-muted-foreground"
              >
                <span className="font-semibold text-sidebar-primary">Needs input:</span>{" "}
                {item.needsInput.question}
              </button>
              {expanded ? (
                <div onClick={(event) => event.stopPropagation()}>
                  <HomeNeedsInput containerId={item.id} needsInput={item.needsInput} />
                </div>
              ) : null}
            </>
          ) : (
            // Defensive: a needs_input row whose payload didn't materialize
            // (e.g. the stored status says parked but no pending question row
            // backs it) must never render as a dead row. No expander without
            // a payload — the sub-line still reads truthfully and the row
            // itself navigates to the thread.
            <div className="text-xs text-muted-foreground">
              <span className="font-semibold text-sidebar-primary">Needs input:</span>{" "}
              Waiting for your answer
            </div>
          )
        ) : null}
      </div>

      {item.attention === "review" && item.review ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={(event) => {
            event.stopPropagation();
            openThread();
          }}
        >
          {item.review.kind === "email" ? <Send /> : <FileText />}
          {item.review.label}
        </Button>
      ) : null}

      {item.failed ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={retry.isPending}
          onClick={(event) => {
            event.stopPropagation();
            if (!isOptimistic && !retry.isPending) retry.mutate();
          }}
        >
          <RotateCcw />
          Retry
        </Button>
      ) : null}

      {item.routineJobId ? (
        // This task created a routine (server-mapped via job.chatSessionId).
        // The chip opens the routine details panel — NOT the row's topic
        // thread, hence the stopPropagation.
        <button
          type="button"
          aria-label={`Open routine details for ${item.title}`}
          className="shrink-0 transition-opacity hover:opacity-75"
          onClick={(event) => {
            event.stopPropagation();
            if (panel) panel.openRoutine(item.routineJobId!);
            else router.push(`/routines/job/${encodeURIComponent(item.routineJobId!)}`);
          }}
        >
          <RoutineChip />
        </button>
      ) : null}
    </div>
  );
}
