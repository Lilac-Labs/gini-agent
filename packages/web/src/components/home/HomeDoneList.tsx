"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useTopicPanel } from "@/components/chat/TopicPanelContext";
import { formatRecentTimestamp } from "@/components/chat/relative-time";
import { useHome } from "@/lib/queries";
import { useMounted } from "@/lib/use-mounted";

// The Done section: completed-and-acknowledged containers (server-filtered
// and capped in GET /api/home), collapsible behind a "Done · N" header.
// Empty → the section is omitted entirely; no skeleton — it appears when
// data arrives. Collapse state is local, not persisted. Rows open the
// container thread the same way HomeTaskRow does (right-side TopicPanel
// drawer, falling back to the /chat?session=<id> deep link). Timestamps are
// mount-gated — they render in the viewer's locale/timezone, which SSR
// can't know.
export function HomeDoneList() {
  const home = useHome();
  const mounted = useMounted();
  const router = useRouter();
  const panel = useTopicPanel();
  const [open, setOpen] = useState(true);

  if (!home.data) return null;
  const done = home.data.done ?? [];
  if (done.length === 0) return null;

  const openThread = (id: string) => {
    if (panel) panel.openTopic(id);
    else router.push(`/chat?session=${id}`);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-0.5 pb-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span>Done</span>
        <span className="opacity-60">· {done.length}</span>
      </button>

      {open
        ? done.map((item) => (
            <div
              key={item.id}
              role={panel ? "button" : "link"}
              aria-expanded={panel ? panel.openTopicId === item.id : undefined}
              tabIndex={0}
              onClick={() => openThread(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openThread(item.id);
                }
              }}
              className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-2.5 transition-colors outline-none hover:bg-accent/45 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {/* Non-interactive checked visual — the outcome was already
                  acknowledged; there is nothing left to toggle. */}
              <span className="mt-px flex size-[17px] shrink-0 items-center justify-center rounded-[6px] bg-sidebar-primary">
                <Check className="size-3 text-white" strokeWidth={3} />
              </span>

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="text-[14px] font-medium text-muted-foreground line-through decoration-muted-foreground/55">
                  {item.title}
                </div>
                {item.outcomeLine ? (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground/30" />
                    <span className="min-w-0 truncate">{item.outcomeLine}</span>
                  </div>
                ) : null}
              </div>

              <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
                {mounted ? formatRecentTimestamp(item.completedAt) : ""}
              </span>
            </div>
          ))
        : null}
    </div>
  );
}
