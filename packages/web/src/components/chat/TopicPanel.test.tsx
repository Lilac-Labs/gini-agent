/// <reference lib="dom" />

// TopicPanel is the right-side Topic drawer opened from a forwarded-answer
// chip. It resolves the topic session, renders its `#title` + a close button,
// and reuses ChatSurface in panel mode for the topic's own transcript +
// composer. ChatSurface (and its useChannelSession resolver) are stubbed so the
// panel is exercised without the full chat query/SSE graph.

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatSession } from "@/lib/view-types";
import { TopicPanelContext } from "./TopicPanelContext";

let mockSession: ChatSession | undefined;
mock.module("./ChatSurface", () => ({
  useChannelSession: () => mockSession,
  ChatSurface: ({
    sessionId,
    headerName,
    panel,
    onClosePanel
  }: {
    sessionId: string;
    headerName: string;
    panel?: boolean;
    onClosePanel?: () => void;
  }) => (
    <div
      data-testid="chat-surface"
      data-session-id={sessionId}
      data-header={headerName}
      data-panel={panel ? "1" : "0"}
    >
      <button type="button" onClick={onClosePanel}>
        surface-close
      </button>
    </div>
  )
}));

const { TopicPanel } = await import("./TopicPanel");

function topicSession(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "topic-1",
    instance: "test",
    kind: "topic",
    title: "World Cup Final Trip",
    agentId: "agent-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  } as ChatSession;
}

function renderPanel(closeTopic = () => {}) {
  return render(
    <TopicPanelContext.Provider
      value={{ openTopicId: "topic-1", openTopic: () => {}, openRoutineJobId: null, openRoutine: () => {}, closeTopic }}
    >
      <TopicPanel topicId="topic-1" />
    </TopicPanelContext.Provider>
  );
}

describe("TopicPanel", () => {
  test("renders the topic title and reuses ChatSurface in panel mode", () => {
    mockSession = topicSession();
    renderPanel();
    const surface = screen.getByTestId("chat-surface");
    expect(surface.getAttribute("data-session-id")).toBe("topic-1");
    expect(surface.getAttribute("data-header")).toBe("#World Cup Final Trip");
    expect(surface.getAttribute("data-panel")).toBe("1");
  });

  test("close button calls closeTopic", () => {
    mockSession = topicSession();
    const closeTopic = mock(() => {});
    renderPanel(closeTopic);
    // The surface forwards onClosePanel; clicking it dismisses the drawer.
    fireEvent.click(screen.getByText("surface-close"));
    expect(closeTopic).toHaveBeenCalledTimes(1);
  });

  test("shows a loading header with a working close button before the session resolves", () => {
    mockSession = undefined;
    const closeTopic = mock(() => {});
    renderPanel(closeTopic);
    expect(screen.getByText("#topic")).not.toBeNull();
    expect(screen.getByText("Loading…")).not.toBeNull();
    expect(screen.queryByTestId("chat-surface")).toBeNull();
    fireEvent.click(screen.getByLabelText("Close topic panel"));
    expect(closeTopic).toHaveBeenCalledTimes(1);
  });
});
