/// <reference lib="dom" />

// Settings page managed-mode gating (ADR managed-deployment-mode.md): the
// provider sections — DefaultModelControl, AgentModelControl, and the
// ProviderCard list (which carries the Add-provider affordance) — render for
// a self-hosted deployment
// and disappear when /api/setup/status reports `managed: true`; every other
// card on the page stays. The real useManagedMode hook runs against a stubbed
// fetch, so the wire contract is what these tests pin.
//
// The section cards are stubbed: each is its own surface with its own tests,
// and here only the page's render/omit decision is under test. This suite
// runs under --isolate (the web posttest), so the unreverted src stubs can't
// leak into the files that test those cards for real.

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realFetch = globalThis.fetch;

let SettingsPage: typeof import("./page").default;

beforeAll(async () => {
  mock.module("@/components/PageHeader", () => ({
    PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>
  }));
  mock.module("./_components/DefaultModelControl", () => ({
    DefaultModelControl: () => <div data-testid="default-model-control" />
  }));
  mock.module("./_components/AgentModelControl", () => ({
    AgentModelControl: () => <div data-testid="agent-model-control" />
  }));
  mock.module("./_components/ProviderCard", () => ({
    ProviderCard: () => <div data-testid="provider-card" />
  }));
  mock.module("./_components/ToolsetsCard", () => ({
    ToolsetsCard: () => <div data-testid="toolsets-card" />
  }));
  mock.module("./_components/McpCard", () => ({
    McpCard: () => <div data-testid="mcp-card" />
  }));
  mock.module("./_components/MessagingCard", () => ({
    MessagingCard: () => <div data-testid="messaging-card" />
  }));
  mock.module("./_components/BrowserSettingsCard", () => ({
    BrowserSettingsCard: () => <div data-testid="browser-settings-card" />
  }));
  SettingsPage = (await import("./page")).default;
});

// Route the page's queries: the setup-status probe answers with the `managed`
// flag under test; everything else gets an empty-but-well-formed payload.
function stubFetch(managed: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/setup/status")
      ? { ok: true, providerConfigured: true, managed }
      : url.includes("/agents")
        ? { agents: [] }
        : url.includes("/toolsets")
          ? { toolsets: [] }
          : url.includes("/status")
            ? {}
            : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    rtlRender(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    );
  });
}

describe("SettingsPage managed-mode gating", () => {
  test("self-hosted (managed false): the provider sections render alongside the rest", async () => {
    stubFetch(false);
    await renderPage();
    expect(screen.queryByTestId("default-model-control")).not.toBeNull();
    expect(screen.queryByTestId("agent-model-control")).not.toBeNull();
    expect(screen.queryByTestId("provider-card")).not.toBeNull();
    expect(screen.queryByTestId("browser-settings-card")).not.toBeNull();
    expect(screen.queryByTestId("toolsets-card")).not.toBeNull();
  });

  test("managed: the provider sections are hidden, the rest of the page is intact", async () => {
    stubFetch(true);
    await renderPage();
    // The sections default to visible (self-hosted posture) and withdraw when
    // the setup-status answer lands — wait for that flip.
    await waitFor(() => expect(screen.queryByTestId("default-model-control")).toBeNull());
    expect(screen.queryByTestId("agent-model-control")).toBeNull();
    expect(screen.queryByTestId("provider-card")).toBeNull();
    // Everything below the provider sections stays.
    expect(screen.queryByTestId("browser-settings-card")).not.toBeNull();
    expect(screen.queryByTestId("toolsets-card")).not.toBeNull();
    expect(screen.queryByTestId("mcp-card")).not.toBeNull();
    expect(screen.queryByTestId("messaging-card")).not.toBeNull();
    expect(screen.queryByText("Settings")).not.toBeNull();
  });
});
