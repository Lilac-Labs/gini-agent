"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentChatHeader } from "@/components/chat/AgentChatHeader";
import { ChatTabBar } from "@/components/chat/ChatTabBar";
import { ChatSurface, useChannelSession } from "@/components/chat/ChatSurface";
import { TopicPanel } from "@/components/chat/TopicPanel";
import { TopicPanelProvider, useTopicPanel } from "@/components/chat/TopicPanelContext";
import { RoutineDetailsPanel } from "@/components/jobs/RoutineDetailsPanel";
import { useAgentChat, useStatus } from "@/lib/queries";
import type { ChatSession } from "@/lib/view-types";

export default function ChatPage() {
  // The TopicPanel context lives at the page root so a forwarded-answer chip
  // anywhere in the transcript can open a Topic in the right-side drawer
  // without unmounting the main chat.
  return (
    <TopicPanelProvider>
      <ChatPageBody />
    </TopicPanelProvider>
  );
}

function ChatPageBody() {
  const params = useSearchParams();
  const router = useRouter();
  // ?session= deep-links open a specific session (a recurring-job channel
  // from the sidebar, or an agent-chat link from Home/Tasks). Without it, the
  // surface is the active agent's single canonical chat.
  const pinnedSessionId = params?.get("session") ?? null;

  // The bare-/chat root agent chat is hidden from the chrome for now:
  // redirect home. ?session= deep links are untouched, and the root-chat
  // rendering path below is deliberately kept so the surface comes back by
  // removing this redirect.
  useEffect(() => {
    if (!pinnedSessionId) router.replace("/");
  }, [pinnedSessionId, router]);

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;
  const activeAgentName = status.data?.activeAgent?.name ?? "Gini";

  const agentChat = useAgentChat(pinnedSessionId ? null : activeAgentId);
  const pinnedSession = useChannelSession(pinnedSessionId);

  const session: ChatSession | undefined = pinnedSessionId ? pinnedSession : agentChat.data;
  const sessionId = session?.id ?? null;
  // A pinned session is a "channel" surface only when it's a recurring-job
  // channel; a pinned agent-chat link still renders as the agent surface.
  const isChannel = Boolean(
    pinnedSessionId && (session?.kind === "channel" || session?.origin === "job")
  );
  // A pinned `kind:"topic"` session is the Topic surface: its own subject-scoped
  // conversation. Like a channel it carries the topic's own title and the owning
  // agent as the assistant, but it's headed as `#<title>` and hides the Routines tab.
  const isTopic = Boolean(pinnedSessionId && session?.kind === "topic");

  const headerName = isTopic
    ? `#${session?.title?.trim() || "topic"}`
    : isChannel
      ? session?.title?.trim() || "Channel"
      : activeAgentName;
  const headerSeed = isTopic
    ? sessionId ?? "topic"
    : isChannel
      ? sessionId ?? "channel"
      : activeAgentId ?? "agent";
  // The agent whose messages render in the transcript. On the agent surface
  // this is the active agent; on a channel or topic the assistant is the
  // session's owning agent (named "Gini" by default since the title isn't the
  // agent's name). Keys the colored-initial message-row avatar.
  const messageAgent = isChannel || isTopic
    ? session?.agentId
      ? { id: session.agentId, name: "Gini" }
      : undefined
    : activeAgentId
      ? { id: activeAgentId, name: activeAgentName }
      : undefined;
  const resolving = !sessionId && (pinnedSessionId ? !pinnedSession : agentChat.isLoading);

  // The forwarded-Topic drawer / routine details panel (one slot). When set
  // (a chip's "View topic →" or a routine card was clicked) the panel renders
  // to the right of the main chat without touching the URL or unmounting it.
  // A pinned `?session=` topic surface never opens its own panel over itself.
  const { openTopicId, openRoutineJobId } = useTopicPanel()!;
  const panelTopicId = !isTopic && openTopicId ? openTopicId : null;

  // Redirecting (see the effect above) — render nothing for the frame.
  if (!pinnedSessionId) return null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      {!sessionId ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AgentChatHeader name={headerName} seed={headerSeed} showAvatar={!isChannel && !isTopic} />
          <ChatTabBar active="messages" onChange={() => {}} hideJobsTab={isChannel || isTopic} />
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {resolving ? "Loading…" : "No chat yet — say hello below."}
          </div>
        </section>
      ) : (
        // Key on sessionId so all transient view state (active tab, composer
        // draft) resets cleanly when the user switches agents or opens a
        // channel — no reset effect needed.
        <ChatSurface
          key={sessionId}
          sessionId={sessionId}
          session={session!}
          headerName={headerName}
          headerSeed={headerSeed}
          isChannel={isChannel}
          isTopic={isTopic}
          messageAgent={messageAgent}
          activeAgentId={activeAgentId}
        />
      )}
      {panelTopicId ? (
        <TopicPanel topicId={panelTopicId} />
      ) : openRoutineJobId ? (
        <RoutineDetailsPanel jobId={openRoutineJobId} />
      ) : null}
    </div>
  );
}
