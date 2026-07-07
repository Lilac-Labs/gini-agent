/// <reference lib="dom" />

// Providers wires ThemeProvider + QueryClientProvider + Toaster and gates the
// global RuntimeStreamBridge off the /login route. These tests mock the heavy
// children (next-themes, sonner's Toaster, RuntimeStreamBridge) and next/
// navigation's usePathname to cover: the bridge mounts on a normal route and is
// skipped on /login, a null pathname coerces to "not on login", and the
// module-level console.error wrap both swallows the next-themes script-tag
// warning and passes every other error through.
//
// LEAK SAFETY: mock.module is process-wide in `bun test` and can outlive the file
// that set it, so the third-party overrides SPREAD the real module and revert in
// afterAll. The local component stubs (RuntimeStreamBridge, ConnectionBanner,
// UpdateGate) are NOT reverted on purpose — importing the real modules for a
// spread would register them (plus their query/stream deps) against the 100%
// coverage gate without covering them. Their own test files render the real
// components, which is safe because the suite runs with --isolate (fresh module
// registry per file — the structural backstop for all module mocks here).

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";

// next/navigation, next-themes and sonner are node_modules — importing them for
// spread+revert does not register anything for the coverage gate. We do NOT
// import the real ./RuntimeStreamBridge src file (that would register it, plus
// its useRuntimeStream/queries deps, for the 100% gate without covering it); the
// stub fully replaces it and no other test imports it, so no revert is needed.
const realNav = await import("next/navigation");
const realThemes = await import("next-themes");
const realSonner = await import("sonner");

let pathname: string | null = "/";
let Providers: typeof import("./providers").Providers;

beforeAll(async () => {
  mock.module("next/navigation", () => ({ ...realNav, usePathname: () => pathname }));
  mock.module("next-themes", () => ({
    ...realThemes,
    ThemeProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="theme-provider">{children}</div>
    )
  }));
  mock.module("sonner", () => ({ ...realSonner, Toaster: () => <div data-testid="toaster-stub" /> }));
  mock.module("./RuntimeStreamBridge", () => ({
    RuntimeStreamBridge: () => <div data-testid="stream-bridge-stub" />
  }));
  // Same rationale: the real ConnectionBanner (and its useRuntimeStream dep)
  // is covered by its own test file; the stub keeps this one's imports lean.
  mock.module("./ConnectionBanner", () => ({
    ConnectionBanner: () => <div data-testid="connection-banner-stub" />
  }));
  // Same rationale as RuntimeStreamBridge: don't pull the real UpdateGate src
  // (and its query/mutation deps) into the coverage gate. The stub renders its
  // children so the wrapped app still appears on non-/login routes.
  mock.module("./UpdateGate", () => ({
    UpdateGateProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="update-gate-stub">{children}</div>
    )
  }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const providersPath = "./providers?providers-test";
  ({ Providers } = (await import(providersPath)) as typeof import("./providers"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
  mock.module("next-themes", () => realThemes);
  mock.module("sonner", () => realSonner);
});

const CHILD = <div data-testid="child">child</div>;

beforeEach(() => {
  pathname = "/";
});

describe("Providers", () => {
  test("normal route: mounts the RuntimeStreamBridge, children, and Toaster", () => {
    pathname = "/chat";
    render(<Providers>{CHILD}</Providers>);
    expect(screen.queryByTestId("stream-bridge-stub")).not.toBeNull();
    expect(screen.queryByTestId("connection-banner-stub")).not.toBeNull();
    expect(screen.queryByTestId("update-gate-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("toaster-stub")).not.toBeNull();
    expect(screen.queryByTestId("theme-provider")).not.toBeNull();
  });

  test("/login: skips the RuntimeStreamBridge, banner, and update gate but still renders children", () => {
    pathname = "/login";
    render(<Providers>{CHILD}</Providers>);
    expect(screen.queryByTestId("stream-bridge-stub")).toBeNull();
    expect(screen.queryByTestId("connection-banner-stub")).toBeNull();
    expect(screen.queryByTestId("update-gate-stub")).toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
  });

  test("null pathname is treated as not-on-login and mounts the bridge", () => {
    pathname = null;
    render(<Providers>{CHILD}</Providers>);
    expect(screen.queryByTestId("stream-bridge-stub")).not.toBeNull();
  });

  test("the top-level import installed the idempotent console.error wrap", () => {
    const wrapped = console.error as typeof console.error & { __giniNextThemesFilter?: true };
    expect(wrapped.__giniNextThemesFilter).toBe(true);
  });

  test("a fresh import re-wraps a bare console.error and filters the script-tag warning while forwarding others", async () => {
    // Install a clean recorder WITHOUT the marker so a fresh module import takes
    // the `if (!__giniNextThemesFilter)` branch and closes over it. This lets us
    // observe the wrap's two outcomes: drop the script-tag warning, forward
    // everything else to the captured delegate.
    const realError = console.error;
    const calls: unknown[][] = [];
    const recorder = ((...args: unknown[]) => {
      calls.push(args);
    }) as typeof console.error;
    console.error = recorder;
    try {
      const rewrapPath = "./providers?providers-rewrap";
      const fresh = (await import(rewrapPath)) as typeof import("./providers");
      const wrapped = console.error as typeof console.error & { __giniNextThemesFilter?: true };
      expect(wrapped.__giniNextThemesFilter).toBe(true);
      expect(wrapped).not.toBe(recorder);

      // Script-tag warning: swallowed, recorder NOT called.
      wrapped("Encountered a script tag while rendering React component: <script>");
      expect(calls.length).toBe(0);

      // Unrelated string: forwarded to the recorder.
      wrapped("some unrelated warning");
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("some unrelated warning");

      // Non-string first arg: forwarded too (not a string -> no fragment match).
      const err = new Error("real error");
      wrapped(err, "ctx");
      expect(calls.length).toBe(2);
      expect(calls[1][0]).toBe(err);

      // The freshly imported Providers still renders.
      pathname = "/chat";
      render(<fresh.Providers>{CHILD}</fresh.Providers>);
      expect(screen.queryByTestId("child")).not.toBeNull();
    } finally {
      console.error = realError;
    }
  });
});
