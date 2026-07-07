"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { TopicPanel } from "@/components/chat/TopicPanel";
import { TopicPanelContext } from "@/components/chat/TopicPanelContext";
import { Greeting } from "@/components/home/Greeting";
import { HomeComposer } from "@/components/home/HomeComposer";
import { HomeTaskList } from "@/components/home/HomeTaskList";
import { RecentsList } from "@/components/home/RecentsList";

// The home page: a task-first daily surface — greeting, "Give Gini a task"
// composer, the attention-queue task list, and the Recents artifact feed.
// The old ops dashboard lives on at /overview (linked from Settings). No
// PageHeader — the greeting is the header.
//
// Clicking a task row opens that container's thread in the right-side
// TopicPanel drawer (the chat page's forwarded-topic pattern) instead of
// navigating away. Unlike the chat page's state-backed TopicPanelProvider,
// the open panel here lives in the URL (`/?panel=<sessionId>`) via shallow
// history.replaceState (the `?compose=` idiom — no router navigation), so a
// reload restores the panel and closing it cleans the URL.
export default function HomePage() {
  const params = useSearchParams();
  const panelSessionId = params?.get("panel") || null;

  const openTopic = useCallback((topicId: string) => {
    window.history.replaceState(null, "", `/?panel=${encodeURIComponent(topicId)}`);
  }, []);
  const closeTopic = useCallback(() => {
    window.history.replaceState(null, "", "/");
  }, []);
  const panel = useMemo(
    () => ({ openTopicId: panelSessionId, openTopic, closeTopic }),
    [panelSessionId, openTopic, closeTopic]
  );

  return (
    <TopicPanelContext.Provider value={panel}>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[26px] px-4 py-6 pb-20 md:px-6">
            <Greeting />
            <HomeComposer />
            <HomeTaskList />
            <RecentsList />
          </div>
        </div>
        {panelSessionId ? <TopicPanel topicId={panelSessionId} /> : null}
      </div>
    </TopicPanelContext.Provider>
  );
}
