"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// Drives the right-side panel next to the chat. One slot, two variants:
//   - topic:   a forwarded-answer chip in the main Chat transcript calls
//              `openTopic(topicId)` to open the Topic's own conversation in a
//              drawer alongside the chat (instead of navigating away via
//              `?session=`).
//   - routine: a routine-created card calls `openRoutine(jobId)` to open the
//              routine's details panel in the same slot.
// One panel at a time — opening either variant replaces the other, and
// `closeTopic` closes the panel whichever variant is open. `openTopicId` /
// `openRoutineJobId` expose the open variant's id, or null.
type PanelState =
  | { kind: "topic"; topicId: string }
  | { kind: "routine"; jobId: string };

type TopicPanelValue = {
  openTopicId: string | null;
  openTopic: (topicId: string) => void;
  openRoutineJobId: string | null;
  openRoutine: (jobId: string) => void;
  closeTopic: () => void;
};

export const TopicPanelContext = createContext<TopicPanelValue | null>(null);

export function TopicPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const openTopic = useCallback((topicId: string) => setPanel({ kind: "topic", topicId }), []);
  const openRoutine = useCallback((jobId: string) => setPanel({ kind: "routine", jobId }), []);
  const closeTopic = useCallback(() => setPanel(null), []);
  const value = useMemo<TopicPanelValue>(
    () => ({
      openTopicId: panel?.kind === "topic" ? panel.topicId : null,
      openTopic,
      openRoutineJobId: panel?.kind === "routine" ? panel.jobId : null,
      openRoutine,
      closeTopic
    }),
    [panel, openTopic, openRoutine, closeTopic]
  );
  return <TopicPanelContext.Provider value={value}>{children}</TopicPanelContext.Provider>;
}

// Returns the panel controls, or null when no provider is mounted. The chip
// falls back to its `?session=` link in that case so it still works outside the
// chat surface.
export function useTopicPanel(): TopicPanelValue | null {
  return useContext(TopicPanelContext);
}
