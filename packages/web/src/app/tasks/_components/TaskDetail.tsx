"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusPill } from "@/components/StatusPill";
import type { CostRecord, Task, TraceRecord } from "@runtime/types";
import type { ChatSession } from "@/lib/view-types";
import { TaskTimeline, traceTarget } from "./TaskTimeline";
import { formatDuration, isLive, useNow } from "./observability";

export function TaskDetail({
  data,
  actionPending,
  onAction,
  linkedSession
}: {
  data: { task: Task; trace: TraceRecord[] };
  actionPending: boolean;
  onAction: (op: "retry" | "cancel") => void;
  linkedSession: ChatSession | null;
}) {
  const task = data.task;
  const trace = data.trace;
  const filesChanged = useMemo(() => extractFilesChanged(trace), [trace]);
  const toolsUsed = useMemo(() => extractToolsUsed(trace), [trace]);
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{task.title}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{task.id}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill value={task.status} />
            <Button size="sm" variant="outline" disabled={actionPending} onClick={() => onAction("retry")}>Retry</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending || ["completed", "cancelled"].includes(task.status)}
              onClick={() => onAction("cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="flex h-full flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="related">Related</TabsTrigger>
            <TabsTrigger value="trace">Trace</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <DurationBlock task={task} />
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <Field label="Status" value={task.status} mono />
                  <Field label="Instance" value={task.instance} mono />
                  <Field label="Created" value={new Date(task.createdAt).toLocaleString()} />
                  <Field label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
                  {task.currentStep ? <Field label="Current step" value={task.currentStep} mono /> : null}
                  {task.jobId ? <Field label="Routine" value={task.jobId} mono /> : null}
                  {task.parentTaskId ? <Field label="Parent task" value={task.parentTaskId} mono /> : null}
                  {task.subagentId ? <Field label="Subagent" value={task.subagentId} mono /> : null}
                </div>
                <Section title="Input">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{task.input}</pre>
                </Section>
                {task.summary ? (
                  <Section title="Summary">
                    <pre className="whitespace-pre-wrap text-xs">{task.summary}</pre>
                  </Section>
                ) : null}
                {task.error ? (
                  <Section title="Error">
                    <pre className="whitespace-pre-wrap text-xs text-red-400">{task.error}</pre>
                  </Section>
                ) : null}
                {task.cost ? (
                  <Section title="Cost">
                    <div className="space-y-3">
                      <TokenBar cost={task.cost} />
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <Field label="Provider" value={task.cost.provider} mono />
                        <Field label="Model" value={task.cost.model} mono />
                        {typeof task.cost.inputTokens === "number" ? (
                          <Field label="Input tokens" value={task.cost.inputTokens.toLocaleString()} mono />
                        ) : null}
                        {typeof task.cost.outputTokens === "number" ? (
                          <Field label="Output tokens" value={task.cost.outputTokens.toLocaleString()} mono />
                        ) : null}
                        {typeof task.cost.totalTokens === "number" ? (
                          <Field label="Total tokens" value={task.cost.totalTokens.toLocaleString()} mono />
                        ) : null}
                        {typeof task.cost.estimatedUsd === "number" ? (
                          <Field label="Estimated USD" value={`$${task.cost.estimatedUsd.toFixed(4)}`} mono />
                        ) : null}
                      </div>
                    </div>
                  </Section>
                ) : null}
                {linkedSession ? (
                  <Section title="Originated from chat">
                    <Link
                      href={`/chat?session=${linkedSession.id}`}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1 text-xs hover:bg-accent/50"
                    >
                      <span className="truncate">{linkedSession.title || "Untitled session"}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{linkedSession.id}</span>
                    </Link>
                  </Section>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="timeline" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2 pb-6">
                <TaskTimeline trace={trace} />
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="files" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-3 pb-6">
                <Section title={`Files changed (${filesChanged.length})`}>
                  {filesChanged.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No file writes or patches recorded.</p>
                  ) : (
                    <ul className="space-y-1">
                      {filesChanged.map((entry, index) => (
                        <li
                          key={`${entry.path}-${index}`}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[11px]"
                        >
                          <span className="truncate">{entry.path}</span>
                          <span className={entry.kind === "patch" ? "text-amber-400" : "text-emerald-400"}>
                            {entry.kind === "patch" ? "± patch" : "+ write"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={`Tools used (${toolsUsed.length})`}>
                  {toolsUsed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tools recorded.</p>
                  ) : (
                    <ul className="space-y-1">
                      {toolsUsed.map((entry) => (
                        <li
                          key={entry.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-2 py-1 text-[11px]"
                        >
                          <span className="truncate">{entry.message}</span>
                          {entry.target ? (
                            <span className="font-mono text-[10px] text-muted-foreground truncate">{entry.target}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title="Artifacts produced">
                  {/* No artifact-typed trace records exist in the current runtime
                      (TraceRecord.type does not include "artifact"). Surface as
                      empty-state rather than fake data; v2 can add an artifact
                      record type and this will populate. */}
                  <p className="text-xs text-muted-foreground">No artifacts recorded.</p>
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="related" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-4 pb-6">
                <Section title={`Approvals (${task.approvalIds.length})`}>
                  <IdList ids={task.approvalIds} hint="Open Permissions to act on these." />
                </Section>
                <Section title={`Skills used (${task.skillIds.length})`}>
                  <IdList ids={task.skillIds} hint="Inspect on the Skills page." />
                </Section>
                <Section title={`Audit (${task.auditIds.length})`}>
                  <IdList ids={task.auditIds} hint="Cross-reference on the Activity page." />
                </Section>
              </div>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="trace" className="flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-3">
              <div className="space-y-2 pb-6">
                <p className="text-[11px] text-muted-foreground">{data.trace.length} entries · {task.tracePath}</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(data.trace, null, 2)}
                </pre>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`truncate ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function IdList({ ids, hint }: { ids: string[]; hint: string }) {
  if (ids.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <>
      <ul className="space-y-1">
        {ids.map((id) => (
          <li key={id} className="rounded-md border border-border bg-card/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {id}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </>
  );
}

function extractFilesChanged(trace: TraceRecord[]): Array<{ path: string; kind: "write" | "patch" }> {
  // The agent emits trace.type === "tool" with messages "File written" / "File
  // patched" when an approval is granted (see src/agent.ts:438/462). We pick
  // those out by message rather than tool-name (which isn't in `data`) — the
  // path lives on `data.path`. De-dupe by path+kind to avoid double counting.
  const seen = new Set<string>();
  const out: Array<{ path: string; kind: "write" | "patch" }> = [];
  for (const record of trace) {
    if (record.type !== "tool") continue;
    const path = typeof record.data?.path === "string" ? record.data.path : null;
    if (!path) continue;
    let kind: "write" | "patch" | null = null;
    if (record.message === "File written") kind = "write";
    else if (record.message === "File patched") kind = "patch";
    if (!kind) continue;
    const key = `${kind}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, kind });
  }
  return out;
}

function DurationBlock({ task }: { task: Task }) {
  // Tick once per second only while the task is live; for terminal tasks the
  // duration is frozen at (updatedAt - createdAt), no interval needed.
  const live = isLive(task.status);
  const now = useNow(live, 1000);
  const start = new Date(task.createdAt).getTime();
  const endRef = live ? now : new Date(task.updatedAt).getTime();
  const ms = Math.max(0, endRef - start);
  return (
    <div className="rounded-md border border-border bg-card/50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Duration</p>
      <p className="font-mono text-2xl tabular-nums">{formatDuration(ms)}</p>
      <p className="text-[10px] text-muted-foreground">
        {live ? "Running — counter updates every second." : "Frozen at task completion."}
      </p>
    </div>
  );
}

function TokenBar({ cost }: { cost: CostRecord }) {
  // We need both input and output token counts to render the split bar. If
  // only one side is known we skip the viz rather than fabricate a 100/0
  // split — the numeric grid below still shows whatever fields exist.
  const input = typeof cost.inputTokens === "number" ? cost.inputTokens : null;
  const output = typeof cost.outputTokens === "number" ? cost.outputTokens : null;
  if (input === null || output === null) return null;
  const total = input + output;
  if (total === 0) return null;
  const inputPct = (input / total) * 100;
  const outputPct = 100 - inputPct;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Tokens</span>
        <span className="font-mono tabular-nums normal-case tracking-normal text-foreground">
          {total.toLocaleString()} total
          {typeof cost.estimatedUsd === "number" ? (
            <span className="ml-2 text-muted-foreground">${cost.estimatedUsd.toFixed(4)}</span>
          ) : null}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full border border-border bg-muted">
        <span
          className="block h-full bg-blue-500/70 transition-all duration-300"
          style={{ width: `${inputPct}%` }}
          aria-label={`Input tokens ${input}`}
        />
        <span
          className="block h-full bg-emerald-500/70 transition-all duration-300"
          style={{ width: `${outputPct}%` }}
          aria-label={`Output tokens ${output}`}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500/70 align-middle" />
          Input · {input.toLocaleString()} ({inputPct.toFixed(0)}%)
        </span>
        <span>
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500/70 align-middle" />
          Output · {output.toLocaleString()} ({outputPct.toFixed(0)}%)
        </span>
      </div>
    </div>
  );
}

function extractToolsUsed(trace: TraceRecord[]): Array<{ id: string; message: string; target: string | null }> {
  // All trace records with type "tool" represent tool invocations the agent
  // made. We surface message + first useful identifier so the user can see
  // what happened without diving into raw JSON.
  return trace
    .filter((record) => record.type === "tool")
    .map((record) => ({ id: record.id, message: record.message, target: traceTarget(record) }));
}
