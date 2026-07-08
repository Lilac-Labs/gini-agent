/// <reference lib="dom" />

// Step 3 Continue-gating: the profile card must BLOCK Continue while the Gmail
// scan is still building the profile (the "loading" view) so the user waits for
// a complete profile instead of skipping past a half-built one, and must
// RE-ENABLE it the moment the scan turns ready or falls back (failed / no
// account / kickoff-failed idle) so a slow or failed scan never traps the user
// on this step. scanUnavailable (the user skipped the provider step, so no
// scan was ever kicked off) must render the connect-a-model state — no
// eternal spinner, no "Try again" that can only fail — while a ready profile
// still wins. The onboarding record is seeded straight into the query cache
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

function renderStep(scan: OnboardingScan, opts: { kickoffFailed?: boolean; scanUnavailable?: boolean } = {}) {
  const onDone = mock(() => {});
  const record: OnboardingRecord = { version: 1, completed: false, scan, routineJobIds: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["onboarding"], record);
  render(
    <QueryClientProvider client={client}>
      <StepProfile
        kickoffFailed={opts.kickoffFailed ?? false}
        scanUnavailable={opts.scanUnavailable ?? false}
        onRetry={() => {}}
        retryPending={false}
        onDone={onDone}
      />
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

describe("StepProfile connect-a-model state (provider skipped)", () => {
  test("an idle scan renders the connect-a-model copy with no spinner and no Try again", () => {
    // With no provider the scan was never kicked off: idle would otherwise
    // spin forever, and a retry could only fail the same way.
    const { onDone, continueButton } = renderStep({ status: "idle" }, { scanUnavailable: true });
    expect(screen.getByText(/connect a model first/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("a ready profile still renders even when the provider was later removed", () => {
    renderStep(
      { status: "ready", profile: { displayName: "Ada Lovelace", sections: [] } },
      { scanUnavailable: true }
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByText(/connect a model first/i)).toBeNull();
  });
});
