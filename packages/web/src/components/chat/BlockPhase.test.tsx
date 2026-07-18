/// <reference lib="dom" />

import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { PhaseBlock } from "@runtime/types";
import { BlockPhase } from "./BlockPhase";

function phase(label: string): PhaseBlock {
  return {
    id: "phase_1",
    sessionId: "chat_1",
    instance: "test",
    ordinal: 1,
    createdAt: "2026-07-15T12:00:00.000Z",
    kind: "phase",
    label
  };
}

test("hides the internal tool name from a working phase", () => {
  render(<BlockPhase block={phase("Working: terminal.exec")} />);

  expect(screen.getByText("Working")).not.toBeNull();
  expect(screen.queryByText("Working: terminal.exec")).toBeNull();
});
