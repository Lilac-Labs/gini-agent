/// <reference lib="dom" />

// Step 3 Continue-gating: the profile card must BLOCK Continue while the Gmail
// scan is still building the profile (the "loading" view) so the user waits for
// a complete profile instead of skipping past a half-built one, and must
// RE-ENABLE it the moment the scan turns ready or falls back (failed / no
// account / kickoff-failed idle) so a slow or failed scan never traps the user
// on this step. The onboarding record is seeded straight into the query cache
// (fresh + Infinity staleTime → no refetch on mount); fetch is stubbed to hang
// so a running scan's 2.5s poll never touches the network if the timer fires.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingRecord, OnboardingScan } from "@runtime/types";
import { StepProfile } from "./StepProfile";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderStep(scan: OnboardingScan, opts: { kickoffFailed?: boolean } = {}) {
  const onDone = mock(() => {});
  const record: OnboardingRecord = { version: 1, completed: false, scan, routineJobIds: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["onboarding"], record);
  render(
    <QueryClientProvider client={client}>
      <StepProfile kickoffFailed={opts.kickoffFailed ?? false} onRetry={() => {}} retryPending={false} onDone={onDone} />
    </QueryClientProvider>
  );
  const continueButton = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
  return { onDone, continueButton };
}

describe("StepProfile Continue gating", () => {
  test("blocks Continue while the scan is still building the profile", () => {
    const { onDone, continueButton } = renderStep({ status: "running" });
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(onDone).not.toHaveBeenCalled();
  });

  test("blocks Continue on an idle scan still awaiting kickoff", () => {
    const { continueButton } = renderStep({ status: "idle" }, { kickoffFailed: false });
    expect(continueButton().disabled).toBe(true);
  });

  test("enables Continue once the profile is ready", () => {
    const { onDone, continueButton } = renderStep({
      status: "ready",
      profile: { displayName: "Ada Lovelace", sections: [] }
    });
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("enables Continue when the scan fell back after failing", () => {
    const { onDone, continueButton } = renderStep({ status: "failed", error: "boom" });
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("enables Continue when a kickoff-failed idle scan falls back", () => {
    const { continueButton } = renderStep({ status: "idle" }, { kickoffFailed: true });
    expect(continueButton().disabled).toBe(false);
  });
});
