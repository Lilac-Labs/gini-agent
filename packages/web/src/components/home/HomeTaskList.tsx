"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeSectionHeader } from "@/components/home/HomeSectionHeader";
import { HomeTaskRow } from "@/components/home/HomeTaskRow";
import { useHome, useTasks } from "@/lib/queries";
import type { ApiError } from "@/lib/api";

// First non-empty line of a task's streaming partial summary.
function firstLine(text: string | undefined): string | undefined {
  const line = text?.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

// The home attention queue. Rows come pre-sorted and pre-filtered from
// GET /api/home; the only client-side join is the live status line on
// working rows (currentStep / partialSummary from the tasks poll — the
// home payload deliberately stays lean).
export function HomeTaskList() {
  const home = useHome();
  const tasksQuery = useTasks();
  const [open, setOpen] = useState(true);

  // containerId → live status line. Last write wins; a container has at most
  // one live run (serial per container), so collisions don't happen in
  // practice.
  const workingTextBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasksQuery.data ?? []) {
      if (!task.chatSessionId) continue;
      if (task.status !== "running" && task.status !== "queued") continue;
      const text = task.currentStep ?? firstLine(task.partialSummary);
      if (text) map.set(task.chatSessionId, text);
    }
    return map;
  }, [tasksQuery.data]);

  const tasks = home.data?.tasks;
  let body: ReactNode;
  if (!home.data) {
    if (home.isError) {
      const unreachable = (home.error as ApiError).unreachable === true;
      body = (
        <div className="py-4 text-center text-xs text-muted-foreground">
          {unreachable ? (
            "Reconnecting…"
          ) : (
            <button
              type="button"
              onClick={() => home.refetch()}
              className="transition-colors hover:text-foreground"
            >
              Couldn&apos;t load tasks — retry
            </button>
          )}
        </div>
      );
    } else {
      // Skeleton mirrors the loaded task rows so the swap to real data doesn't
      // shift the layout. The disclosure header itself stays stable.
      body = (
        <div className="flex flex-col gap-0.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 px-1 py-2.5">
              <Skeleton className="mt-px size-[17px] rounded-sm" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      );
    }
  } else if (home.data.tasks.length === 0) {
    body = (
      <div className="py-4 text-center text-sm text-muted-foreground">
        What should I take on first?
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-0.5">
        {home.data.tasks.map((item) => (
          <HomeTaskRow
            key={item.id}
            item={item}
            workingText={workingTextBySession.get(item.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <HomeSectionHeader
        title="Tasks"
        count={tasks?.length}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open ? body : null}
    </div>
  );
}
