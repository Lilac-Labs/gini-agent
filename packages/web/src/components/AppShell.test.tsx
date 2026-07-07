/// <reference lib="dom" />

// AppShell picks the layout from the route: /login (and /login/*) renders
// children bare (no app chrome and no gate); /onboarding wraps children
// in the OnboardingGate without the sidebar; every other route wraps the FULL
// shell (Sidebar + MobileTopBar + children) inside the OnboardingGate, so the
// gate can hold back the whole chrome until the onboarding record resolves.
// Only usePathname drives that branch.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`, so we
// only mock specifiers that no OTHER test renders as its subject:
//   - next/navigation (node_module; spread + usePathname override; reverted so it
//     can't leak — node_modules aren't counted for coverage)
//   - @/components/Sidebar (no other test imports it, so the stub needs no revert)
//   - @/components/OnboardingGate (same rationale; the real gate pulls in
//     lib/queries + react-query, which would need a QueryClientProvider here)
// We deliberately do NOT import the real @/components/Sidebar: pulling that src
// file in would register it (and its heavy AgentSwitcher / CreateAgentDialog
// deps) for the 100% coverage gate without covering it. The stub fully replaces
// it, so the shell branch is observable purely via the Sidebar / MobileTopBar
// stubs.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";

const realNav = await import("next/navigation");

let pathname: string | null = "/";
let AppShell: typeof import("./AppShell").AppShell;

beforeAll(async () => {
  mock.module("next/navigation", () => ({ ...realNav, usePathname: () => pathname }));
  mock.module("@/components/Sidebar", () => ({
    Sidebar: () => <div data-testid="sidebar-stub" />,
    MobileTopBar: () => <div data-testid="mobile-topbar-stub" />
  }));
  // Pass-through wrapper stub: the real gate hides children until the record
  // loads; here only the wrapping relationship (gate around content) is under
  // test, so the stub always renders its children.
  mock.module("@/components/OnboardingGate", () => ({
    OnboardingGate: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="onboarding-gate-stub">{children}</div>
    )
  }));
  // The query suffix is a runtime cache-bust; keep it in a variable so tsc treats
  // the dynamic import as `any` instead of trying to resolve the suffixed path.
  const appShellPath = "./AppShell?appshell-test";
  ({ AppShell } = (await import(appShellPath)) as typeof import("./AppShell"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
});

const CHILD = <div data-testid="child">child content</div>;

function renderShell() {
  return render(<AppShell>{CHILD}</AppShell>);
}

beforeEach(() => {
  pathname = "/";
});

describe("AppShell", () => {
  test("normal route: the gate wraps the full shell (Sidebar + MobileTopBar + children)", () => {
    pathname = "/chat";
    const { container } = renderShell();
    const gate = screen.getByTestId("onboarding-gate-stub");
    // The WHOLE chrome sits inside the gate, so a still-loading record can
    // hold back the sidebar and content together (no home-chrome flash).
    expect(gate.querySelector('[data-testid="sidebar-stub"]')).not.toBeNull();
    expect(gate.querySelector('[data-testid="mobile-topbar-stub"]')).not.toBeNull();
    expect(gate.querySelector('[data-testid="child"]')).not.toBeNull();
    // The shell's distinctive flex container is present on non-/login routes.
    expect(container.querySelector(".flex.h-screen")).not.toBeNull();
  });

  test("/login: renders only children, no app chrome, no gate", () => {
    pathname = "/login";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).toBeNull();
    expect(screen.queryByTestId("onboarding-gate-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("/onboarding: the gate wraps children without the sidebar", () => {
    pathname = "/onboarding";
    const { container } = renderShell();
    const gate = screen.getByTestId("onboarding-gate-stub");
    expect(gate.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("a /login-prefixed route like /logins still gets the full shell (exact match, not prefix)", () => {
    pathname = "/logins";
    const { container } = renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(container.querySelector(".flex.h-screen")).not.toBeNull();
  });

  test("/login/* subpaths also render bare", () => {
    pathname = "/login/done";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("a null pathname falls through to the full shell", () => {
    pathname = null;
    renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
  });
});
