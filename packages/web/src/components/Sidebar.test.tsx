/// <reference lib="dom" />

// Sidebar managed-mode gating (ADR managed-deployment-mode.md): the
// self-serve footer — the tunnel menu and the UpdateReminder row — renders
// for a self-hosted deployment and disappears when /api/setup/status reports
// `managed: true`. The real useManagedMode hook runs against a stubbed fetch,
// so the wire contract (managed read from the setup-status payload) is what
// these tests pin, not a mocked hook.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`, so
// node_module mocks (next/navigation, next-themes) are captured and restored
// in afterAll. The heavy src siblings (TunnelMenu, the update gate, the agent
// dialogs, AgentAvatar) are replaced with stubs and deliberately NOT imported
// for real — pulling them in would register them (and their import graphs)
// for the 100% coverage gate without covering them. This suite runs under
// --isolate (the web posttest), which keeps those unreverted stubs from
// leaking into the files that test them for real. Sidebar.tsx itself is
// listed in bunfig's coveragePathIgnorePatterns: these are targeted gating
// regressions, not full coverage of the sidebar surface.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realNav = await import("next/navigation");
const realThemes = await import("next-themes");
const realImage = await import("next/image");
const realFetch = globalThis.fetch;

let Sidebar: typeof import("./Sidebar").Sidebar;

beforeAll(async () => {
  mock.module("next/navigation", () => ({
    ...realNav,
    usePathname: () => "/",
    useSearchParams: () => ({ get: () => null }),
    useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} })
  }));
  mock.module("next-themes", () => ({
    ...realThemes,
    useTheme: () => ({ theme: "light", setTheme: () => {} })
  }));
  // next/image's loader can't build its optimizer URL under happy-dom's URL
  // implementation; a plain <img> stands in.
  mock.module("next/image", () => ({
    default: ({ src, alt }: { src: string; alt?: string }) =>
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ""} />
  }));
  mock.module("@/components/tunnel/TunnelMenu", () => ({
    TunnelMenu: () => <div data-testid="tunnel-menu" />
  }));
  // An update IS available and idle — the exact state where the self-hosted
  // UpdateReminder shows its Update button, so "managed hides it" is
  // observable against the strongest counter-case.
  mock.module("@/components/UpdateGate", () => ({
    useUpdateGate: () => ({
      version: { packageVersion: "1.2.3", git: { shortSha: "abc1234" } },
      updateSupported: true,
      updateAvailable: true,
      phase: "idle",
      start: () => {}
    })
  }));
  mock.module("@/components/chat/AgentAvatar", () => ({
    AgentAvatar: () => null
  }));
  mock.module("@/components/CreateAgentDialog", () => ({
    CreateAgentDialog: () => null
  }));
  mock.module("@/components/ArchiveAgentDialog", () => ({
    ArchiveAgentDialog: () => null
  }));
  mock.module("@/components/DeleteAgentDialog", () => ({
    DeleteAgentDialog: () => null
  }));
  ({ Sidebar } = await import("./Sidebar"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
  mock.module("next-themes", () => realThemes);
  mock.module("next/image", () => realImage);
});

// Route the sidebar's queries: the setup-status probe answers with the
// `managed` flag under test; everything else gets an empty-but-well-formed
// payload so the sidebar renders quietly.
function stubFetch(managed: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/setup/status")
      ? { ok: true, providerConfigured: true, managed }
      : url.includes("/status")
        ? { activeAgent: { id: "agent_default", name: "Gini" } }
        : url.includes("/agents")
          ? { agents: [] }
          : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <Sidebar />
    </QueryClientProvider>
  );
}

describe("Sidebar managed-mode gating", () => {
  test("self-hosted (managed false): tunnel menu and update row render", async () => {
    stubFetch(false);
    await act(async () => {
      renderSidebar();
    });
    expect(await screen.findByTestId("tunnel-menu")).not.toBeNull();
    expect(await screen.findByRole("button", { name: /update/i })).not.toBeNull();
    expect(screen.queryByText(/v1\.2\.3/)).not.toBeNull();
  });

  test("managed: tunnel menu and update row are hidden once the flag resolves", async () => {
    stubFetch(true);
    await act(async () => {
      renderSidebar();
    });
    // The footer defaults to visible (self-hosted is the default posture) and
    // withdraws when the setup-status answer lands — wait for that flip.
    await waitFor(() => expect(screen.queryByTestId("tunnel-menu")).toBeNull());
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
    expect(screen.queryByText(/v1\.2\.3/)).toBeNull();
    // The rest of the chrome is untouched: nav links still render.
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeNull();
  });
});
