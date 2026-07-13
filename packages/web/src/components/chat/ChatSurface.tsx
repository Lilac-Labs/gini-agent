"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Maximize2, Pin, PinOff, X } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BlockRenderer } from "@/components/chat/BlockRenderer";
import { BlockToolCallsCollapsed } from "@/components/chat/BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "@/components/chat/GeneratedFilesCard";
import { Composer } from "@/components/chat/Composer";
import { QueuedMessages } from "@/components/chat/QueuedMessages";
import { AgentChatHeader } from "@/components/chat/AgentChatHeader";
import { ChannelViewJob } from "@/components/chat/ChannelViewJob";
import { ChatSearchBox } from "@/components/chat/ChatSearchBox";
import { ChatTabBar, type ChatTab } from "@/components/chat/ChatTabBar";
import { JobsTab } from "@/components/chat/JobsTab";
import { SentDraftsProvider } from "@/components/chat/SentDraftsContext";
import { api, type UploadRef } from "@/lib/api";
import { useChatReadState } from "@/lib/use-chat-read-state";
import { useStickToBottom } from "@/lib/use-stick-to-bottom";
import { groupExchanges, type ChatRenderItem } from "@/lib/group-exchanges";
import {
  latestInFlightTaskId,
  TERMINAL_PHASE_LABELS,
  useAllChatSessions,
  useAllJobs,
  useCancelTask,
  useChatBlocks,
  useChatRuns,
  useChatSessions,
  useInvalidate,
  useRemovePendingChatMessage,
  useSentDrafts
} from "@/lib/queries";
import type { ChatSession } from "@/lib/view-types";

// The job name a render item was delivered by, or undefined for ordinary
// conversation. A file_artifact card has no runId of its own, so the caller
// carries the preceding run's name forward to it (it always trails its run's
// tool group). `tool_group` reads its first call's runId; `block` its own.
function itemJobName(item: ChatRenderItem, runIdToJobName: Map<string, string>): string | undefined {
  if (item.kind === "tool_group") return item.calls[0]?.runId ? runIdToJobName.get(item.calls[0].runId) : undefined;
  if (item.kind === "block") return item.block.runId ? runIdToJobName.get(item.block.runId) : undefined;
  return undefined;
}

export function ChatSurface({
  sessionId,
  session,
  headerName,
  headerSeed,
  isChannel,
  isTopic,
  messageAgent,
  activeAgentId,
  panel = false,
  onClosePanel
}: {
  sessionId: string;
  session: ChatSession;
  headerName: string;
  headerSeed: string;
  isChannel: boolean;
  isTopic: boolean;
  messageAgent?: { id: string; name: string };
  activeAgentId?: string;
  // Panel mode (the right-side Topic drawer): swap the full AgentChatHeader,
  // tab bar, and in-chat search for a compact `#title` + close header, and let
  // the parent constrain the width. The transcript + composer pipeline below is
  // shared verbatim with the full-page surface.
  panel?: boolean;
  onClosePanel?: () => void;
}) {
  const [tab, setTab] = useState<ChatTab>("messages");
  const [text, setText] = useState("");
  // In-chat search: client-side find over the loaded transcript. `query` is the
  // raw input; `activeMatch` indexes into the matched-block list below.
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const invalidate = useInvalidate();

  // On a channel, resolve the originating job by its linked chat session so the
  // header can offer a "Back to job" link. The session carries no jobId, so we
  // match `job.chatSessionId === sessionId` against the unscoped jobs list.
  const allJobs = useAllJobs();
  const job = useMemo(
    () =>
      isChannel ? (allJobs.data ?? []).find((j) => j.chatSessionId === sessionId) : undefined,
    [allJobs.data, isChannel, sessionId]
  );

  const { blocks, isLoading: blocksLoading, refetch, pendingMessages } = useChatBlocks(
    sessionId,
    session.pendingMessages
  );

  // Fire the sent-draft set eagerly on chat mount, in parallel with the blocks.
  // Its payload is small, so it's normally settled before the (heavier) blocks
  // render — letting an already-sent draft card paint "Sent" on first render
  // with no "Send" flash. Provided to the cards via SentDraftsProvider below.
  const sentDrafts = useSentDrafts();

  const sessionsQuery = useChatSessions();
  const { markRead, activityAt } = useChatReadState(sessionsQuery.data);
  // Mark read using the LIST session (it carries `runs`) so the stored
  // timestamp matches what the sidebar's isUnread compares against. The prop
  // session (sourced from the unscoped list) covers the gap while the scoped
  // list resolves — and is the steady state for channels owned by a
  // non-active agent, which the scoped list never contains.
  const liveSession =
    (sessionsQuery.data ?? []).find((s) => s.id === sessionId) ?? session;
  const liveActivityAt = activityAt(liveSession);
  // Topics forward every turn into their parent Chat, so viewing the Chat means the user
  // has seen that forwarded content — mark those child Topics read too, instead of making
  // the user open each one just to clear its sidebar badge (ADR chat-topics-tasks-subagents.md).
  const childTopics = useMemo(
    () =>
      liveSession.kind === "agent"
        ? (sessionsQuery.data ?? []).filter(
            (s) => s.kind === "topic" && s.parentChatSessionId === liveSession.id
          )
        : [],
    [sessionsQuery.data, liveSession.kind, liveSession.id]
  );
  // Re-fire when a Topic forwards new content while the Chat is open.
  const childTopicsActivity = childTopics.map((t) => activityAt(t)).join("|");
  useEffect(() => {
    markRead(liveSession);
    // Re-mark when activity advances while the chat is open (a task finishes
    // or a job run lands) so it doesn't flip back to unread under the user.
    for (const t of childTopics) markRead(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, liveActivityAt, childTopicsActivity, markRead]);

  // The transcript renders the session's full block list in ordinal order —
  // legacy thread-tagged blocks (the agent no longer creates threads) read
  // inline alongside everything else.
  const mainBlocks = blocks;

  // Chat sends resolve with { accepted, blockId } (echo-first ack); queued
  // ones carry { queued, pendingId } and non-routed sessions still return
  // { taskId }. The client treats all of them as success (the pill /
  // transcript update via SSE) and reads none of the fields.
  const send = useMutation({
    mutationFn: ({ content, images }: { content: string; images: UploadRef[] }) =>
      api<{ accepted?: boolean; blockId?: string; taskId?: string; queued?: boolean; pendingId?: string }>(
        `/chat/${sessionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content, client: "web", ...(images.length > 0 ? { images } : {}) })
        }
      ),
    onSuccess: () => {
      invalidate(["chat", "tasks"]);
    },
    onError: (error: Error, variables) => {
      toast.error(error.message);
      // The composer cleared optimistically at submit; give the text back on
      // failure so the message isn't lost — unless the user already started
      // typing something new.
      setText((current) => (current === "" ? variables.content : current));
    }
  });

  const cancel = useCancelTask();
  const removePending = useRemovePendingChatMessage(sessionId);

  // Pin/unpin the container to the sidebar (Topics = pinned === true only).
  // Router-minted topics start unpinned and surface on home, so this toggle
  // is the gesture that keeps a thread in the sidebar.
  const isContainer = liveSession.kind === "topic" || liveSession.kind === "channel";
  const containerPinned = liveSession.pinned === true;
  const setPinned = useMutation({
    mutationFn: (pinned: boolean) =>
      api(`/containers/${sessionId}`, { method: "PATCH", body: JSON.stringify({ pinned }) }),
    onSuccess: () => invalidate(["chat", "home"]),
    onError: (error: Error) => toast.error(error.message)
  });

  const submit = (images: UploadRef[]) => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // Don't gate on send.isPending: successive Enters while a turn runs must
    // each POST so they queue in order. The server serializes (run-vs-queue),
    // so concurrent POSTs are safe.
    //
    // Clear immediately — waiting for the server ack would hold the user's
    // text hostage to the POST round trip; onError restores it.
    setText("");
    send.mutate({ content: trimmed, images });
  };

  // In-flight detection over the main-chat block stream.
  const inflightTaskId: string | null = useMemo(
    () => latestInFlightTaskId(mainBlocks),
    [mainBlocks]
  );

  // Phase blocks are transient — render only the latest while non-terminal.
  const visibleBlocks = useMemo(
    () =>
      mainBlocks.filter((b, i) => {
        if (b.kind !== "phase") return true;
        const isLast = i === mainBlocks.length - 1;
        return isLast && !TERMINAL_PHASE_LABELS.has(b.label);
      }),
    [mainBlocks]
  );

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, (typeof mainBlocks)[number] & { kind: "tool_result" }>();
    for (const b of mainBlocks) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [mainBlocks]);

  // Terminal runs whose "Completed" phase is filtered out before grouping.
  // groupExchanges folds these even when they ended on a tool call with no
  // closing answer. Scope to "Completed" only so failures still surface inline.
  const terminalTaskIds = useMemo(
    () =>
      new Set(
        mainBlocks
          .filter((b) => b.kind === "phase" && b.label === "Completed" && b.taskId)
          .map((b) => b.taskId!)
      ),
    [mainBlocks]
  );

  const renderItems = useMemo<ChatRenderItem[]>(
    () => groupExchanges(visibleBlocks, terminalTaskIds),
    [visibleBlocks, terminalTaskIds]
  );
  const hasBlocks = visibleBlocks.length > 0;

  // Map a job run's runId → its job name so messages delivered by a scheduled
  // job render with a "from <job name>" badge, distinguishing them from the
  // user's own conversation. The runs query carries the full run records
  // (kind/jobId); the jobs list resolves jobId → name.
  const chatRuns = useChatRuns(sessionId);
  const runIdToJobName = useMemo(() => {
    const jobNameById = new Map((allJobs.data ?? []).map((j) => [j.id, j.name]));
    const map = new Map<string, string>();
    for (const run of chatRuns.data ?? []) {
      if (run.kind !== "job" || !run.jobId) continue;
      const name = jobNameById.get(run.jobId);
      if (name) map.set(run.id, name);
    }
    return map;
  }, [chatRuns.data, allJobs.data]);

  // Segment the render items into consecutive runs sharing one job name. A
  // file_artifact card trails its run's tool group with no runId of its own,
  // so it inherits the preceding run's name rather than breaking the segment.
  // Each segment with a jobName renders inside one bordered container with a
  // single "from <job name>" header; segments without one render exactly as
  // before. Grouping happens here, not in groupExchanges.
  const itemSegments = useMemo(() => {
    const segments: { jobName?: string; items: ChatRenderItem[] }[] = [];
    let lastJobName: string | undefined;
    for (const item of renderItems) {
      const ownJobName = itemJobName(item, runIdToJobName);
      const isArtifact = item.kind === "file_artifact";
      const jobName = ownJobName ?? (isArtifact ? lastJobName : undefined);
      lastJobName = isArtifact ? lastJobName : ownJobName;
      const tail = segments[segments.length - 1];
      if (tail && tail.jobName === jobName) tail.items.push(item);
      else segments.push({ jobName, items: [item] });
    }
    return segments;
  }, [renderItems, runIdToJobName]);

  // Pin the transcript to the newest message. Snap instantly when the chat
  // opens or the user returns to the Chat tab (the viewport mounts at the
  // top, so an animated scroll there would be visible); follow smoothly as new
  // blocks arrive mid-turn. Keyed by sessionId so switching agents re-arms the snap.
  const {
    ref: messagesEndRef,
    atBottom: messagesAtBottom,
    scrollToBottom: scrollMessagesToBottom
  } = useStickToBottom(mainBlocks.length, {
    key: sessionId,
    enabled: tab === "messages" && hasBlocks
  });

  // Block ids whose message text contains the query, in display order. Only
  // the searchable message kinds count (not tool calls / phases / files).
  const matches = useMemo<string[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const ids: string[] = [];
    for (const item of renderItems) {
      if (item.kind !== "block") continue;
      const block = item.block;
      if (
        block.kind !== "user_text" &&
        block.kind !== "assistant_text" &&
        block.kind !== "system_note"
      ) {
        continue;
      }
      if (block.text.toLowerCase().includes(needle)) ids.push(block.id);
    }
    return ids;
  }, [renderItems, query]);
  const matchCount = matches.length;
  const activeMatchId = matchCount > 0 ? matches[Math.min(activeMatch, matchCount - 1)] : undefined;

  // Keep the active index in range as matches change (query edits reset it to
  // 0 at the call site; this guards stream-driven match-set shrinkage).
  useEffect(() => {
    if (activeMatch > 0 && activeMatch >= matchCount) setActiveMatch(matchCount === 0 ? 0 : matchCount - 1);
  }, [matchCount, activeMatch]);

  // Scroll the active match into view when it (or the query) changes.
  useEffect(() => {
    if (!activeMatchId) return;
    document
      .getElementById(`chat-msg-${activeMatchId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatchId]);

  // Render one chat item as an <li>. Shared by the plain transcript and the
  // job-grouped containers so job-delivered messages render identically except
  // for their wrapper.
  const renderItem = (item: ChatRenderItem) => {
    if (item.kind === "tool_group") {
      return (
        <li key={item.id}>
          <BlockToolCallsCollapsed calls={item.calls} steps={item.steps} resultsByCallId={toolResultsByCallId} inProgress={item.inProgress} />
        </li>
      );
    }
    if (item.kind === "file_artifact") {
      return (
        <li key={item.id}>
          <GeneratedFilesCard files={item.files} />
        </li>
      );
    }
    const block = item.block;
    const isMatch = matches.includes(block.id);
    const isActiveMatch = block.id === activeMatchId;
    return (
      <li
        key={block.id}
        id={`chat-msg-${block.id}`}
        className={`space-y-2 transition-colors ${
          isActiveMatch
            ? "rounded-lg bg-[#4277FB]/5 ring-2 ring-[#4277FB]/70"
            : isMatch
              ? "rounded-lg bg-[#4277FB]/5"
              : ""
        }`}
      >
        <BlockRenderer
          block={block}
          toolResult={block.kind === "tool_call" ? toolResultsByCallId.get(block.callId) : undefined}
          agent={messageAgent}
          isFinalAnswer={item.isFinalAnswer}
        />
      </li>
    );
  };

  return (
    <>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {panel ? (
          // Compact panel header: `#<topic title>` + open-full-page and close
          // buttons. The full AgentChatHeader / tab bar / search are full-page
          // affordances the drawer doesn't need.
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="truncate text-[15px] font-semibold text-foreground">{headerName}</h2>
            <div className="flex shrink-0 items-center gap-1">
              <Link
                href={`/chat?session=${sessionId}`}
                aria-label="Open full page"
                title="Open full page"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Maximize2 className="size-4" />
              </Link>
              <button
                type="button"
                onClick={onClosePanel}
                aria-label="Close topic panel"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </header>
        ) : (
          <AgentChatHeader
            name={headerName}
            seed={headerSeed}
            lastActiveAt={session.updatedAt}
            subtitle={isChannel ? "routine delivery channel" : isTopic ? "topic" : undefined}
            showAvatar={!isChannel && !isTopic}
            titleAction={
              <>
                {isChannel && job ? (
                  <ChannelViewJob jobId={job.id} agentId={job.agentId} activeAgentId={activeAgentId} />
                ) : null}
                {isContainer ? (
                  <button
                    type="button"
                    onClick={() => setPinned.mutate(!containerPinned)}
                    disabled={setPinned.isPending}
                    aria-label={containerPinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    title={containerPinned ? "Unpin from sidebar" : "Pin to sidebar"}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    {containerPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  </button>
                ) : null}
              </>
            }
            right={
              <ChatSearchBox
                value={query}
                onChange={(q) => {
                  setQuery(q);
                  setActiveMatch(0);
                  if (q && tab !== "messages") setTab("messages");
                }}
                matchCount={matchCount}
                activeIndex={activeMatch}
                onPrev={() => setActiveMatch((i) => (i - 1 + matchCount) % matchCount)}
                onNext={() => setActiveMatch((i) => (i + 1) % matchCount)}
                onClose={() => {
                  setQuery("");
                  setActiveMatch(0);
                }}
              />
            }
          />
        )}
        {/* Topics and channels only expose Chat, so the tab bar is a
            redundant single tab. The transcript still renders by default. */}
        {panel || isTopic ? null : (
          <ChatTabBar
            active={tab}
            onChange={setTab}
            hideJobsTab={isChannel}
            hideWhenSingleTab={isChannel}
          />
        )}

        {tab === "messages" ? (
          <>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ScrollArea className="min-h-0 flex-1">
              <div className={`mx-auto w-full max-w-3xl py-6 ${panel ? "px-4" : "px-6"}`}>
                {blocksLoading && !hasBlocks ? (
                  <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : !hasBlocks ? (
                  <div className="flex min-h-[40vh] items-center justify-center">
                    <h2 className="text-2xl font-semibold">What can I help with?</h2>
                  </div>
                ) : (
                  // The eagerly-fetched sent-draft set reaches each nested
                  // EmailDraftCard through this provider, so a sent card renders
                  // "Sent" on first paint instead of flashing "Send".
                  <SentDraftsProvider value={sentDrafts}>
                    <ul className="space-y-5">
                      {itemSegments.map((segment, segmentIndex) =>
                        segment.jobName ? (
                          // Routine-delivered chat: one light-blue left-bordered
                          // container with a single "from <routine name>" subtitle so
                          // they're distinguishable from the user's own turn.
                          <li key={`job-${segmentIndex}`}>
                            <div className="rounded-r-lg border-l-2 border-sky-500/40 bg-sky-500/5 py-3 pl-4">
                              <p className="mb-2 text-xs text-muted-foreground">from {segment.jobName}</p>
                              <ul className="space-y-5">{segment.items.map(renderItem)}</ul>
                            </div>
                          </li>
                        ) : (
                          segment.items.map(renderItem)
                        )
                      )}
                    </ul>
                  </SentDraftsProvider>
                )}
                <div ref={messagesEndRef} />
              </div>
              </ScrollArea>
              {hasBlocks && !messagesAtBottom ? (
                <button
                  type="button"
                  onClick={scrollMessagesToBottom}
                  aria-label="Scroll to latest chat"
                  className="absolute bottom-3 left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronDown className="size-5" />
                </button>
              ) : null}
            </div>

            <div className={`pb-5 pt-2 ${panel ? "px-4" : "px-6"}`}>
              <div className="mx-auto w-full max-w-3xl">
                <QueuedMessages
                  pending={pendingMessages}
                  onRemove={(pendingId) =>
                    removePending.mutate(pendingId, {
                      onError: (error) => toast.error(error.message)
                    })
                  }
                />
                <Composer
                  value={text}
                  onChange={setText}
                  onSubmit={submit}
                  busy={Boolean(inflightTaskId) || send.isPending}
                  onStop={() => {
                    if (inflightTaskId) {
                      // Reconcile against durable state right away — if a
                      // terminal frame was missed the block list already
                      // holds the terminal phase, so the indicator clears
                      // without waiting on the cancel. Refetch again after
                      // the cancel writes its own Cancelled phase.
                      refetch();
                      cancel.mutate(inflightTaskId, {
                        onSuccess: () => refetch(),
                        onError: (error) => toast.error(error.message)
                      });
                    }
                  }}
                  // Always address the AGENT, never the container: headerName
                  // is the topic/channel TITLE on those surfaces ("#Write a
                  // two-line haiku…"), which reads absurd in a placeholder.
                  placeholder={`Ask ${messageAgent?.name ?? "Gini"} anything`}
                />
              </div>
            </div>
          </>
        ) : tab === "jobs" ? (
          <JobsTab />
        ) : null}
      </section>
    </>
  );
}

// Resolve a pinned session from the unscoped chat list the sidebar fetches —
// channels and agent-chat links live there for every agent, so the lookup
// works even before an active agent is known.
export function useChannelSession(sessionId: string | null): ChatSession | undefined {
  const sessions = useAllChatSessions();
  return useMemo(
    () => (sessionId ? (sessions.data ?? []).find((s) => s.id === sessionId) : undefined),
    [sessions.data, sessionId]
  );
}
