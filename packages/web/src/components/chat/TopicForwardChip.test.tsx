/// <reference lib="dom" />

// The TopicForwardChip is the deep-link pill rendered under a forwarded Topic
// answer in the main Chat. With the TopicPanel context present (the chat
// surface) "View topic →" is a button that opens the Topic drawer in place via
// `openTopic`; without a provider it falls back to a `?session=<id>` link. It
// always shows the Topic's `#title`, defaulting to "#topic" when blank.

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopicForwardChip } from "./TopicForwardChip";
import { TopicPanelContext } from "./TopicPanelContext";

describe("TopicForwardChip", () => {
  test("renders the topic title and a deep-link fallback when no panel context", () => {
    render(<TopicForwardChip topicId="topic-123" topicTitle="World Cup trip" />);
    expect(screen.getByText("#World Cup trip")).not.toBeNull();
    const link = screen.getByText("View topic →").closest("a");
    expect(link?.getAttribute("href")).toBe("/chat?session=topic-123");
  });

  test("falls back to a generic label when the title is missing or blank", () => {
    render(<TopicForwardChip topicId="topic-456" topicTitle="   " />);
    expect(screen.getByText("#topic")).not.toBeNull();
    const link = screen.getByText("View topic →").closest("a");
    expect(link?.getAttribute("href")).toBe("/chat?session=topic-456");
  });

  test("opens the topic panel via the context instead of navigating", () => {
    const openTopic = mock(() => {});
    render(
      <TopicPanelContext.Provider
        value={{ openTopicId: null, openTopic, openRoutineJobId: null, openRoutine: () => {}, closeTopic: () => {} }}
      >
        <TopicForwardChip topicId="topic-789" topicTitle="Trip" />
      </TopicPanelContext.Provider>
    );
    const trigger = screen.getByText("View topic →");
    // It's a button (no navigation), not an anchor.
    expect(trigger.closest("a")).toBeNull();
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    expect(openTopic).toHaveBeenCalledTimes(1);
    expect(openTopic).toHaveBeenCalledWith("topic-789");
  });
});
