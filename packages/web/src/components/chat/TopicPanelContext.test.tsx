/// <reference lib="dom" />

// TopicPanelProvider holds the currently-open side panel (a Topic drawer or a
// routine details panel — one slot). These tests pin the open/close
// transitions, that opening one variant closes the other, and that
// useTopicPanel returns null with no provider mounted (the chip's deep-link
// fallback path).

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopicPanelProvider, useTopicPanel } from "./TopicPanelContext";

function Probe() {
  const panel = useTopicPanel();
  return (
    <div>
      <span data-testid="open-id">{panel?.openTopicId ?? "none"}</span>
      <span data-testid="routine-id">{panel?.openRoutineJobId ?? "none"}</span>
      <button type="button" onClick={() => panel?.openTopic("topic-1")}>
        open
      </button>
      <button type="button" onClick={() => panel?.openRoutine("job-1")}>
        open-routine
      </button>
      <button type="button" onClick={() => panel?.closeTopic()}>
        close
      </button>
    </div>
  );
}

describe("TopicPanelProvider", () => {
  test("openTopic sets the open topic and closeTopic clears it", () => {
    render(
      <TopicPanelProvider>
        <Probe />
      </TopicPanelProvider>
    );
    expect(screen.getByTestId("open-id").textContent).toBe("none");

    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("open-id").textContent).toBe("topic-1");

    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("open-id").textContent).toBe("none");
  });

  test("the panel slot holds one variant at a time — opening a routine closes the topic and vice versa", () => {
    render(
      <TopicPanelProvider>
        <Probe />
      </TopicPanelProvider>
    );
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("open-routine"));
    expect(screen.getByTestId("open-id").textContent).toBe("none");
    expect(screen.getByTestId("routine-id").textContent).toBe("job-1");

    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("open-id").textContent).toBe("topic-1");
    expect(screen.getByTestId("routine-id").textContent).toBe("none");

    fireEvent.click(screen.getByText("open-routine"));
    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("routine-id").textContent).toBe("none");
  });

  test("useTopicPanel returns null with no provider", () => {
    render(<Probe />);
    // No provider: the hook yields null, so the probe shows the fallback label.
    expect(screen.getByTestId("open-id").textContent).toBe("none");
  });
});
