"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useAllChatSessions, useInvalidate, useStatus, useTask, useTasks } from "@/lib/queries";
import type { Task, TraceRecord } from "@runtime/types";
import type { ChatSession } from "@/lib/view-types";
import { TaskList, type TaskFilter } from "./_components/TaskList";
import { TaskDetail } from "./_components/TaskDetail";
import { FleetDashboard } from "./_components/FleetDashboard";

const FILTERS: readonly TaskFilter[] = [
  { key: "active", label: "Active", match: (t: Task) => ["queued", "running", "waiting_approval", "needs_input"].includes(t.status) },
  { key: "waiting", label: "Waiting", match: (t: Task) => t.status === "waiting_approval" || t.status === "needs_input" },
  { key: "scheduled", label: "Scheduled", match: (t: Task) => Boolean(t.jobId) && (t.status === "queued" || t.status === "running") },
  { key: "completed", label: "Completed", match: (t: Task) => t.status === "completed" },
  { key: "failed", label: "Failed", match: (t: Task) => t.status === "failed" || t.status === "cancelled" },
  { key: "all", label: "All", match: () => true }
] as const;

export default function TasksPage() {
  const params = useSearchParams();
  // Honor ?id=<task-id> so other pages (e.g. Routines "View trace") deep-link
  // straight into a specific task. Falls back to "all" filter so the task
  // is visible in the list panel.
  const initial = params?.get("id") ?? null;
  const [filter, setFilter] = useState<string>(initial ? "all" : "active");
  const [selected, setSelected] = useState<string | null>(initial);
  const tasks = useTasks();
  const detail = useTask(selected);
  const invalidate = useInvalidate();
  // The fleet dashboard reads runtime-aggregated taskCounts from /status
  // (RuntimeStatus) — useState_() returns RuntimeStateSnapshot, which does
  // not carry counts. The sparklines aggregate from the polled task list.
  const status = useStatus();

  useEffect(() => {
    if (initial && initial !== selected) {
      setSelected(initial);
      setFilter("all");
    }
  }, [initial, selected]);

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "retry" | "cancel" }) =>
      api<Task>(`/tasks/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["tasks", "task", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <PageHeader title="Tasks" description="Monitor and inspect tasks" />
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <FleetDashboard
          tasks={tasks.data ?? []}
          status={status.data}
          isPending={tasks.isPending}
          isError={tasks.isError}
        />
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row md:p-6">
        <div className="flex w-full shrink-0 flex-col gap-4 md:w-[420px]">
          <TaskList
            tasks={tasks.data ?? []}
            filters={FILTERS}
            filter={filter}
            selected={selected}
            onFilterChange={setFilter}
            onSelect={setSelected}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!selected ? (
            <EmptyState title="Select a task" description="Pick one from the list to see details and trace." />
          ) : detail.data ? (
            <TaskDetailContainer
              data={detail.data}
              actionPending={action.isPending}
              onAction={(op) => action.mutate({ id: detail.data!.task.id, op })}
            />
          ) : (
            <EmptyState title="Loading…" />
          )}
        </div>
      </div>
    </>
  );
}

function TaskDetailContainer({
  data,
  actionPending,
  onAction
}: {
  data: { task: Task; trace: TraceRecord[] };
  actionPending: boolean;
  onAction: (op: "retry" | "cancel") => void;
}) {
  // Resolve task -> chat session via the field stamped at task creation
  // (and backfilled by normalizeState for legacy state files). Reading
  // task.chatSessionId directly avoids fetching the unscoped chatMessages
  // list from /state for the join. The unscoped session list keeps the
  // lookup working for deep-linked tasks owned by a non-active agent.
  const chats = useAllChatSessions();
  const linkedSession = useMemo<ChatSession | null>(() => {
    const sessionId = data.task.chatSessionId;
    if (!sessionId) return null;
    return (chats.data ?? []).find((s) => s.id === sessionId) ?? null;
  }, [chats.data, data.task.chatSessionId]);
  return (
    <TaskDetail
      data={data}
      actionPending={actionPending}
      onAction={onAction}
      linkedSession={linkedSession}
    />
  );
}
