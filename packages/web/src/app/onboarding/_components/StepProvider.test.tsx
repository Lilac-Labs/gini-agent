/// <reference lib="dom" />

// StepProvider wiring (ADR web-onboarding-flow.md): the capability-derived
// provider step hosts the shared ProviderPicker and must (a) advance the
// wizard when the picker reports a successful save (onSaved → onDone) and
// (b) always offer "Skip for now" — rendered by the step itself, NOT the
// picker's secondaryAction slot, so it survives a loading or failed catalog.
// The picker's own behavior (catalog, config forms, POST /api/setup/provider)
// is pinned by ProviderPicker.test.tsx; here it is stubbed so these tests pin
// only the step's contract with it.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`,
// and the REAL ProviderPicker is deliberately never imported here — pulling
// it (and its import graph) in would register it for the 100% coverage gate
// without covering it. The stub is left unreverted, Sidebar.test.tsx-style:
// this suite runs under --isolate (the web posttest), which keeps it from
// leaking into the files that test ProviderPicker for real.

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProviderPickerProps } from "@/components/ProviderPicker";

let StepProvider: typeof import("./StepProvider").StepProvider;

beforeAll(async () => {
  mock.module("@/components/ProviderPicker", () => ({
    ProviderPicker: ({ onSaved, submitLabel }: ProviderPickerProps) => (
      <button type="button" onClick={() => onSaved({ provider: "openai", model: "gpt", isCodex: false })}>
        {submitLabel}
      </button>
    )
  }));
  StepProvider = (await import("./StepProvider")).StepProvider;
});

function renderStep() {
  const onDone = mock(() => {});
  const onSkip = mock(() => {});
  render(<StepProvider onDone={onDone} onSkip={onSkip} />);
  return { onDone, onSkip };
}

describe("StepProvider", () => {
  test("renders the connect-a-model frame around the shared picker", () => {
    renderStep();
    expect(screen.getByRole("heading", { name: /connect a model/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /save and continue/i })).toBeTruthy();
  });

  test("a successful provider save advances the wizard", () => {
    const { onDone, onSkip } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  test("Skip for now advances without saving", () => {
    const { onDone, onSkip } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});
