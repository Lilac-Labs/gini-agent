"use client";

import { X } from "lucide-react";
import { ChatSurface, useChannelSession } from "./ChatSurface";
import { useTopicPanel } from "./TopicPanelContext";

// Right-side Topic drawer — design mirrors the removed thread side panel. A
// 440px column with a left border that renders the OPENED topic's own
// conversation alongside the main chat, without changing the URL or unmounting
// it. It reuses ChatSurface in panel mode so the topic's transcript, tool
// groups, forwarded chips, gates, read-state, SSE, and composer all share the
// main chat's pipeline; the composer posts to the topic (`POST /chat/<topicId>/
// messages`) so the user can continue the topic in place.
export function TopicPanel({ topicId }: { topicId: string }) {
  const { closeTopic } = useTopicPanel()!;
  const session = useChannelSession(topicId);
  const title = `#${session?.title?.trim() || "topic"}`;

  return (
    <aside className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      {session ? (
        // Key on topicId so opening a different topic in the same drawer resets
        // the composer draft and re-arms the scroll snap — no reset effect.
        <ChatSurface
          key={topicId}
          sessionId={topicId}
          session={session}
          headerName={title}
          headerSeed={topicId}
          isChannel={false}
          isTopic
          messageAgent={session.agentId ? { id: session.agentId, name: "Gini" } : undefined}
          panel
          onClosePanel={closeTopic}
        />
      ) : (
        <>
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="truncate text-[15px] font-semibold text-foreground">{title}</h2>
            <button
              type="button"
              onClick={closeTopic}
              aria-label="Close topic panel"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading…
          </div>
        </>
      )}
    </aside>
  );
}
