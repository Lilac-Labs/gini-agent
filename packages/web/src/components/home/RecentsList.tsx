"use client";

import Link from "next/link";
import { FileText, MessageSquare, SquarePen } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRecentTimestamp } from "@/components/chat/relative-time";
import { useHome } from "@/lib/queries";
import { useMounted } from "@/lib/use-mounted";

// The Recents artifact feed: newest terminal-run outcomes across surfaced
// containers (capped server-side). Empty → the section is omitted entirely.
// Timestamps are mount-gated — they render in the viewer's locale/timezone,
// which SSR can't know.
export function RecentsList() {
  const home = useHome();
  const mounted = useMounted();

  if (!home.data) {
    if (home.isError) return null;
    return (
      <div className="flex flex-col gap-0.5">
        <div className="px-0.5 pb-1.5 text-xs text-muted-foreground">Recents</div>
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-[11px] px-1 py-[9px]">
            <Skeleton className="size-[15px] rounded-sm" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    );
  }

  const recents = home.data.recents;
  if (recents.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-0.5 pb-1.5 text-xs text-muted-foreground">Recents</div>
      {recents.map((item) => (
        <Link
          key={item.id}
          href={`/chat?session=${item.containerId}`}
          className="flex items-center gap-[11px] rounded-lg px-1 py-[9px] transition-colors hover:bg-accent/45"
        >
          {item.icon === "chat" ? (
            <MessageSquare className="size-[15px] shrink-0 text-muted-foreground" />
          ) : item.icon === "draft" ? (
            <SquarePen className="size-[15px] shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-[15px] shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{item.title}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {mounted ? formatRecentTimestamp(item.timestamp) : ""}
          </span>
        </Link>
      ))}
    </div>
  );
}
