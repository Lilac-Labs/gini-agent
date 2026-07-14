/// <reference lib="dom" />

// The ExtractionBar renders the extractionView() model: a pulsing live dot +
// "Scanning…" while a run is active, a static tone dot otherwise, and a manual
// Start/Resume control only when the pipeline can be kicked. These tests pin
// the dot variant, the label, and that the control wires onStart.

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExtractionBar } from "./_ExtractionBar";
import type { ExtractionView } from "./_lib";

const RUNNING: ExtractionView = {
  tone: "running",
  live: true,
  label: "Scanning your mail — 3 processed",
  hasAccount: true,
  canStart: false,
  startLabel: "",
};

const IDLE_WITH_ACCOUNT: ExtractionView = {
  tone: "idle",
  live: false,
  label: "Not started yet",
  hasAccount: true,
  canStart: true,
  startLabel: "Scan my mail",
};

const PAUSED: ExtractionView = {
  tone: "paused",
  live: false,
  label: "Paused",
  hasAccount: true,
  canStart: true,
  startLabel: "Resume",
};

const NO_ACCOUNT: ExtractionView = {
  tone: "idle",
  live: false,
  label: "Connect a Google account to build your directory",
  hasAccount: false,
  canStart: false,
  startLabel: "",
};

describe("ExtractionBar", () => {
  test("running: pulsing live dot, scanning label, no control", () => {
    render(<ExtractionBar view={RUNNING} pending={false} onStart={() => {}} />);
    expect(screen.getByTestId("extraction-dot-live")).not.toBeNull();
    expect(screen.queryByTestId("extraction-dot")).toBeNull();
    expect(screen.getByText("Scanning your mail — 3 processed")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("idle with a mailbox: static dot + a Start control that fires onStart", () => {
    const onStart = mock(() => {});
    render(<ExtractionBar view={IDLE_WITH_ACCOUNT} pending={false} onStart={onStart} />);
    expect(screen.getByTestId("extraction-dot")).not.toBeNull();
    expect(screen.queryByTestId("extraction-dot-live")).toBeNull();
    const button = screen.getByRole("button", { name: "Scan my mail" });
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("paused: control resumes", () => {
    render(<ExtractionBar view={PAUSED} pending={false} onStart={() => {}} />);
    expect(screen.getByRole("button", { name: "Resume" })).not.toBeNull();
  });

  test("pending: control shows a spinner label and is disabled", () => {
    render(<ExtractionBar view={IDLE_WITH_ACCOUNT} pending={true} onStart={() => {}} />);
    const button = screen.getByRole("button", { name: "Starting…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("no connected mailbox: no control, connect hint only", () => {
    render(<ExtractionBar view={NO_ACCOUNT} pending={false} onStart={() => {}} />);
    expect(screen.getByText("Connect a Google account to build your directory")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
