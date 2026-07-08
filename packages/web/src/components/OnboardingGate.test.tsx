/// <reference lib="dom" />

// OnboardingGate render-blocking matrix: children stay HIDDEN until the
// onboarding record has loaded (no flash of the home chrome before an
// incomplete user is routed to /onboarding), stay hidden while a redirect is
// in flight (incomplete off /onboarding → /onboarding; completed on
// /onboarding → home), and render once the route is confirmed correct. The
// other hazard pinned here: an explicit chat-session deep link (/chat with a
// `session` query param) must render immediately and never redirect —
// onboarding's "Add account" opens exactly that URL in a new tab for the
// Google OAuth chat, and hijacking (or blanking) it makes the OAuth flow
// unreachable mid-funnel. /setup gets the same exemption: it stays the
// provider-setup surface for a completed instance whose provider is missing
// (the proxy still bounces that state to /setup), and re-redirecting it into
// the funnel would break it.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`, so
// only next/navigation is mocked (spread + overrides, reverted in afterAll —
// node_modules aren't counted for coverage). The gate itself is imported
// through a query-suffixed specifier so this file evaluates the REAL module
// even when AppShell.test.tsx (which stubs the plain
// "@/components/OnboardingGate" specifier) ran earlier in the same process.
// The onboarding record is seeded straight into the query cache (fresh +
// Infinity staleTime, non-running scan → no refetch interval), and fetch is
// stubbed to hang so the not-yet-loaded test never touches the network.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingRecord } from "@runtime/types";

const realNav = await import("next/navigation");
const realFetch = globalThis.fetch;

let pathname: string | null = "/";
let search = new URLSearchParams();
let replace: ReturnType<typeof mock>;
let OnboardingGate: typeof import("./OnboardingGate").OnboardingGate;

beforeAll(async () => {
  mock.module("next/navigation", () => ({
    ...realNav,
    usePathname: () => pathname,
    useSearchParams: () => search,
    useRouter: () => ({ replace })
  }));
  // The query suffix is a runtime cache-bust; keep it in a variable so tsc
  // treats the dynamic import as `any` instead of trying to resolve the
  // suffixed path.
  const gatePath = "./OnboardingGate?onboarding-gate-test";
  ({ OnboardingGate } = (await import(gatePath)) as typeof import("./OnboardingGate"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
});

beforeEach(() => {
  pathname = "/";
  search = new URLSearchParams();
  replace = mock(() => {});
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function buildRecord(overrides: Partial<OnboardingRecord> = {}): OnboardingRecord {
  return { version: 1, completed: false, scan: { status: "idle" }, routineJobIds: [], ...overrides };
}

function renderGate(record?: OnboardingRecord) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (record) client.setQueryData(["onboarding"], record);
  return render(
    <QueryClientProvider client={client}>
      <OnboardingGate>
        <div data-testid="gated-child" />
      </OnboardingGate>
    </QueryClientProvider>
  );
}

function childVisible(): boolean {
  return screen.queryByTestId("gated-child") !== null;
}

describe("OnboardingGate", () => {
  test("hides children and redirects an incomplete user off a normal route", () => {
    pathname = "/tasks";
    renderGate(buildRecord());
    expect(replace).toHaveBeenCalledWith("/onboarding");
    expect(childVisible()).toBe(false);
  });

  test("renders an explicit chat-session deep link untouched while incomplete", () => {
    pathname = "/chat";
    search = new URLSearchParams("session=cs_oauth");
    renderGate(buildRecord());
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("a chat-session deep link renders even before the record loads", () => {
    pathname = "/chat";
    search = new URLSearchParams("session=cs_oauth");
    renderGate();
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("/chat WITHOUT a session param is still gated into the funnel", () => {
    pathname = "/chat";
    renderGate(buildRecord());
    expect(replace).toHaveBeenCalledWith("/onboarding");
    expect(childVisible()).toBe(false);
  });

  test("/setup renders untouched while incomplete (exempt provider-setup surface)", () => {
    pathname = "/setup";
    renderGate(buildRecord());
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("/setup renders even before the record loads", () => {
    pathname = "/setup";
    renderGate();
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("a session param off /chat does not exempt the route", () => {
    pathname = "/tasks";
    search = new URLSearchParams("session=cs_oauth");
    renderGate(buildRecord());
    expect(replace).toHaveBeenCalledWith("/onboarding");
    expect(childVisible()).toBe(false);
  });

  test("an incomplete user on /onboarding (or a subpath) sees the funnel", () => {
    pathname = "/onboarding";
    renderGate(buildRecord());
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("an incomplete user on an /onboarding subpath sees the funnel", () => {
    pathname = "/onboarding/step";
    renderGate(buildRecord());
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("a completed user landing on /onboarding is sent home, funnel hidden", () => {
    pathname = "/onboarding";
    renderGate(buildRecord({ completed: true }));
    expect(replace).toHaveBeenCalledWith("/");
    expect(childVisible()).toBe(false);
  });

  test("a completed user everywhere else renders normally", () => {
    pathname = "/chat";
    renderGate(buildRecord({ completed: true }));
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(true);
  });

  test("children stay hidden (and nothing redirects) until the record loads", () => {
    pathname = "/tasks";
    renderGate();
    expect(replace).not.toHaveBeenCalled();
    expect(childVisible()).toBe(false);
  });
});
