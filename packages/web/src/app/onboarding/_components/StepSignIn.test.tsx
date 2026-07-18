/// <reference lib="dom" />

// Sign-in step "Skip for now" (ADR web-onboarding-flow.md): the quiet skip —
// the path that lets a user without a Google account reach the app — renders
// exactly when the page provides `onSkip`, fires on click, and
// locks while the completion PATCH is pending. fetch is stubbed to hang: the
// account registry stays unresolved, which is exactly the fresh-instance
// state the skip must remain usable in.
//
// LEAK SAFETY: mock.module is process-wide in `bun test`, so the next/image
// mock is captured and restored in afterAll.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realImage = await import("next/image");
const realFetch = globalThis.fetch;

let StepSignIn: typeof import("./StepSignIn").StepSignIn;

beforeAll(async () => {
  // next/image's loader can't build its optimizer URL under happy-dom's URL
  // implementation; a plain <img> stands in.
  mock.module("next/image", () => ({
    default: ({ src, alt }: { src: string; alt?: string }) =>
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ""} />
  }));
  StepSignIn = (await import("./StepSignIn")).StepSignIn;
});

afterAll(() => {
  mock.module("next/image", () => realImage);
});

beforeEach(() => {
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderStep(opts: { onSkip?: () => void; skipPending?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    rtlRender(
      <QueryClientProvider client={client}>
        <StepSignIn onContinue={() => {}} onSkip={opts.onSkip} skipPending={opts.skipPending} />
      </QueryClientProvider>
    );
  });
}

describe("StepSignIn skip path", () => {
  test("renders the quiet Skip for now when the page provides it, and fires on click", async () => {
    const onSkip = mock(() => {});
    await renderStep({ onSkip });
    const skip = screen.getByRole("button", { name: /skip for now/i });
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  test("no skip without onSkip", async () => {
    await renderStep();
    expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull();
    // The step still renders its sign-in surface.
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeTruthy();
  });

  test("skip locks while the completion PATCH is pending", async () => {
    const onSkip = mock(() => {});
    await renderStep({ onSkip, skipPending: true });
    const skip = screen.getByRole("button", { name: /skip for now/i }) as HTMLButtonElement;
    expect(skip.disabled).toBe(true);
  });
});
