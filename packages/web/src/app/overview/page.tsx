"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import {
  useAuthorizations,
  useChatSessions,
  useEvents,
  useInvalidate,
  useSetupRequests,
  useStatus,
  useTasks,
  useUsage
} from "@/lib/queries";
import { TokenUsageChart, TOKEN_USAGE_ALL_AGENTS } from "./_components/TokenUsageChart";
import type { Authorization, SetupRequest } from "@runtime/types";
import type { AgentRow } from "@/lib/view-types";

const HOME_APPROVAL_LIMIT = 3;

const TOKEN_HISTORY_DAYS = 14;

export default function OverviewPage() {
  const status = useStatus();
  const tasks = useTasks();
  const authorizations = useAuthorizations();
  const setupRequests = useSetupRequests();
  const events = useEvents();
  const chatSessions = useChatSessions();
  const invalidate = useInvalidate();

  // SSE invalidation is handled globally by RuntimeStreamBridge — no local
  // useRuntimeStream subscription needed.

  const decideAuth = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Authorization>(`/authorizations/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["authorizations", "approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const cancelSetup = useMutation({
    mutationFn: (id: string) =>
      api<SetupRequest>(`/setup-requests/${id}/cancel`, { method: "POST" }),
    onSuccess: (_, id) => {
      toast.success(`cancelled: ${id}`);
      invalidate(["setup-requests", "approvals", "tasks", "task", "state", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Tasks don't carry back-refs to their chat session, so build a lookup from
  // session.taskIds. Last-write-wins is fine; in practice a task lives in one
  // session.
  const taskToSession = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of chatSessions.data ?? []) {
      for (const taskId of session.taskIds ?? []) {
        map.set(taskId, session.id);
      }
    }
    return map;
  }, [chatSessions.data]);

  const activeTasks = (tasks.data ?? []).filter((t) => ["queued", "running", "waiting_approval", "needs_input"].includes(t.status));
  const pendingAuth = (authorizations.data ?? []).filter((a) => a.status === "pending");
  const pendingSetup = (setupRequests.data ?? []).filter((s) => s.status === "pending");
  const pendingAuthVisible = pendingAuth.slice(0, HOME_APPROVAL_LIMIT);
  const pendingSetupVisible = pendingSetup.slice(0, HOME_APPROVAL_LIMIT);
  const pendingAuthExtra = pendingAuth.length - pendingAuthVisible.length;
  const pendingSetupExtra = pendingSetup.length - pendingSetupVisible.length;
  const pendingTotal = pendingAuth.length + pendingSetup.length;
  const recent = (events.data ?? []).slice().reverse().slice(0, 8);

  // Daily token consumption (input vs output, plus USD) over the trailing
  // window, read from the server-side usage ledger via /api/usage. The ledger
  // captures every generative call — chat, jobs, subagents, memory, titles,
  // vision — not just what lands on task.cost, and survives task pruning.
  // Summed across all agents by default; the chart's agent dropdown narrows it.
  const [usageAgentFilter, setUsageAgentFilter] = useState<string>(TOKEN_USAGE_ALL_AGENTS);
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const effectiveUsageAgentId = usageAgentFilter === TOKEN_USAGE_ALL_AGENTS ? undefined : usageAgentFilter;
  const usage = useUsage(TOKEN_HISTORY_DAYS, effectiveUsageAgentId);

  return (
    <>
      <PageHeader title="Overview" description="Live runtime overview" />
      <div className="flex-1 space-y-6 overflow-auto p-4 md:p-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat title="Health" value={status.data?.ok ? "Healthy" : status.isLoading ? "…" : "Down"} sub={`port ${status.data?.port ?? "—"}`} />
          <Stat title="Active tasks" value={String(activeTasks.length)} sub={activeTasks.length > 0 ? "in flight" : "no work in flight"} />
          <Stat title="Pending approvals" value={String(pendingTotal)} sub={pendingTotal > 0 ? "needs review" : "all clear"} />
        </div>

        <TokenUsageChart
          days={usage.data ?? []}
          agents={agentsQuery.data?.agents ?? []}
          selectedAgentId={usageAgentFilter}
          onSelectAgent={setUsageAgentFilter}
        />

        {pendingAuth.length > 0 ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="text-sm">Pending authorizations</CardTitle>
                  <CardDescription>Agent actions blocked on your approval</CardDescription>
                </div>
                {pendingAuthExtra > 0 ? (
                  <Link
                    href="/permissions"
                    className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-accent"
                  >
                    View all ({pendingAuth.length})
                  </Link>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {pendingAuthVisible.map((authorization) => (
                  <li key={authorization.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px]">{authorization.action}</span>
                        <RiskPill value={authorization.risk} />
                      </div>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{authorization.target}</p>
                      <p className="line-clamp-2 text-sm">{authorization.reason}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        disabled={decideAuth.isPending}
                        onClick={() => decideAuth.mutate({ id: authorization.id, op: "approve" })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={decideAuth.isPending}
                        onClick={() => decideAuth.mutate({ id: authorization.id, op: "deny" })}
                      >
                        Deny
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {pendingSetup.length > 0 ? (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="text-sm">Pending setup steps</CardTitle>
                  <CardDescription>The agent is waiting for you to finish a setup step</CardDescription>
                </div>
                {pendingSetupExtra > 0 ? (
                  <Link
                    href="/permissions"
                    className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium hover:bg-accent"
                  >
                    View all ({pendingSetup.length})
                  </Link>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {pendingSetupVisible.map((setup) => {
                  const isBrowserConnect = setup.action === "browser.connect";
                  const title = isBrowserConnect ? "Connect to agent's browser" : setup.action;
                  const body = isBrowserConnect
                    ? (typeof setup.payload.reason === "string" && setup.payload.reason.length > 0
                        ? setup.payload.reason
                        : setup.target)
                    : setup.reason;
                  return (
                    <li key={setup.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[11px]">{title}</span>
                        </div>
                        {isBrowserConnect ? null : (
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{setup.target}</p>
                        )}
                        <p className="line-clamp-2 text-sm">{body}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[11px] text-muted-foreground">Open chat to continue.</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancelSetup.isPending}
                          onClick={() => cancelSetup.mutate(setup.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Active tasks</CardTitle>
            <CardDescription>Tasks currently queued, running, or waiting for approval</CardDescription>
          </CardHeader>
          <CardContent>
            {activeTasks.length === 0 ? (
              <EmptyState title="No active tasks" description="Submit a task from the Tasks tab." />
            ) : (
              <ul className="divide-y divide-border">
                {activeTasks.map((task) => {
                  const sessionId = taskToSession.get(task.id);
                  const body = (
                    <>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{task.title}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{task.id}</p>
                      </div>
                      <StatusPill value={task.status} />
                    </>
                  );
                  return (
                    <li key={task.id}>
                      {sessionId ? (
                        <Link
                          href={`/chat?session=${sessionId}`}
                          className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="flex items-center justify-between gap-3 py-2">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent events</CardTitle>
            <CardDescription>Latest runtime activity from /api/events</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              <ul className="space-y-2">
                {recent.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 rounded-md border border-border bg-card/50 px-3 py-2">
                    <StatusPill value={event.kind} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{event.summary || event.action}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {event.action} · {event.target}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">{new Date(event.at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Stat({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-[11px] uppercase tracking-wide">{title}</CardDescription>
        <CardTitle className="text-2xl font-semibold">{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{sub}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
