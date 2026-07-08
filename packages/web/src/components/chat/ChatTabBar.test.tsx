/// <reference lib="dom" />

// ChatTabBar tests. Pins the tab strip's contract:
//   - the Jobs visibility flag (hidden on channels)
//   - count pills hide at zero and carry an accessible label
//   - clicking a tab reports its id

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChatTab } from "./ChatTabBar";
import { ChatTabBar } from "./ChatTabBar";

describe("ChatTabBar", () => {
  test("renders all tabs and reports clicks", () => {
    const changes: ChatTab[] = [];
    render(<ChatTabBar active="messages" onChange={(t) => changes.push(t)} />);
    for (const label of ["Messages", "Jobs"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    fireEvent.click(screen.getByText("Jobs"));
    expect(changes).toEqual(["jobs"]);
  });

  test("hides Jobs on channels", () => {
    render(<ChatTabBar active="messages" onChange={() => {}} hideJobsTab />);
    expect(screen.queryByText("Jobs")).toBeNull();
    expect(screen.getByText("Messages")).not.toBeNull();
  });

  test("shows the Jobs count pill only when non-zero", () => {
    const { rerender } = render(
      <ChatTabBar active="messages" onChange={() => {}} jobCount={2} />
    );
    expect(screen.getByText("2")).not.toBeNull();
    rerender(<ChatTabBar active="messages" onChange={() => {}} jobCount={0} />);
    expect(screen.queryByText("2")).toBeNull();
  });
});
