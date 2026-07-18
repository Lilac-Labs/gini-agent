/// <reference lib="dom" />

// The ExtractionBar renders the extractionView() model: a pulsing live dot +
// "Scanning…" while a run is active, a static tone dot otherwise, and a single
// manual Sync control offered whenever a mailbox is connected and extraction
// isn't disabled. These tests pin the dot variant, the label, and that the
// control wires onSync.

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExtractionBar } from "./_ExtractionBar";
import type { ExtractionView } from "./_lib";

const RUNNING: ExtractionView = {
  tone: "running",
  live: true,
  label: "Scanning your mail — 3 processed",
  hasAccount: true,
  canSync: true,
};

const CAUGHT_UP: ExtractionView = {
  tone: "running",
  live: false,
  label: "Up to date · 1,684 processed",
  hasAccount: true,
  canSync: true,
};

const IDLE_WITH_ACCOUNT: ExtractionView = {
  tone: "idle",
  live: false,
  label: "Not started yet",
  hasAccount: true,
  canSync: true,
};

const DISABLED: ExtractionView = {
  tone: "disabled",
  live: false,
  label: "Extraction off",
  hasAccount: true,
  canSync: false,
};

const NO_ACCOUNT: ExtractionView = {
  tone: "idle",
  live: false,
  label: "Connect a Google account to build your directory",
  hasAccount: false,
  canSync: false,
};

describe("ExtractionBar", () => {
  test("running: pulsing live dot, scanning label, sync still offered", () => {
    const onSync = mock(() => {});
    render(<ExtractionBar view={RUNNING} pending={false} onSync={onSync} />);
    expect(screen.getByTestId("extraction-dot-live")).not.toBeNull();
    expect(screen.queryByTestId("extraction-dot")).toBeNull();
    expect(screen.getByText("Scanning your mail — 3 processed")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  test("running but caught up: static (non-pulsing) dot, 'Up to date', sync still offered", () => {
    render(<ExtractionBar view={CAUGHT_UP} pending={false} onSync={() => {}} />);
    expect(screen.getByTestId("extraction-dot")).not.toBeNull();
    expect(screen.queryByTestId("extraction-dot-live")).toBeNull();
    expect(screen.getByText("Up to date · 1,684 processed")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sync" })).not.toBeNull();
  });

  test("idle with a mailbox: static dot + a Sync control that fires onSync", () => {
    const onSync = mock(() => {});
    render(<ExtractionBar view={IDLE_WITH_ACCOUNT} pending={false} onSync={onSync} />);
    expect(screen.getByTestId("extraction-dot")).not.toBeNull();
    expect(screen.queryByTestId("extraction-dot-live")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  test("pending: control shows the syncing label and is disabled", () => {
    render(<ExtractionBar view={IDLE_WITH_ACCOUNT} pending={true} onSync={() => {}} />);
    const button = screen.getByRole("button", { name: "Syncing…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("disabled extraction: no sync control", () => {
    render(<ExtractionBar view={DISABLED} pending={false} onSync={() => {}} />);
    expect(screen.getByText("Extraction off")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("no connected mailbox: no control, connect hint only", () => {
    render(<ExtractionBar view={NO_ACCOUNT} pending={false} onSync={() => {}} />);
    expect(screen.getByText("Connect a Google account to build your directory")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
