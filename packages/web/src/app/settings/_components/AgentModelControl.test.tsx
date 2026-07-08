/// <reference lib="dom" />

// Agent model card (ADRs per-agent-provider-settings.md,
// model-first-selection.md): the active agent's model override, relocated
// from the retired chat Settings tab. These tests pin the write routing —
// the default agent's picks go through the two-layer default-model write,
// other agents post their own override — plus the status line's
// pinned/following/default states and the "Use default model" snapshot copy.
//
// ModelPicker is stubbed (its popover surface has its own tests); the card's
// endpoint choice and status line are what's under test. This suite runs
// under --isolate (the web posttest), so the stub can't leak into the files
// that test the picker for real.

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ModelSelection } from "@/components/ModelPicker";

const realFetch = globalThis.fetch;

let AgentModelControl: typeof import("./AgentModelControl").AgentModelControl;

beforeAll(async () => {
  mock.module("@/components/ModelPicker", () => ({
    ModelPicker: ({
      value,
      onSelect,
      disabled,
      ariaLabel
    }: {
      value?: ModelSelection | null;
      onSelect: (selection: ModelSelection) => void;
      disabled?: boolean;
      ariaLabel?: string;
    }) => (
      <button
        type="button"
        data-testid="model-picker"
        data-value={value ? `${value.provider}/${value.model}` : ""}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onSelect({ provider: "openai", model: "gpt-5.5" })}
      >
        pick
      </button>
    )
  }));
  AgentModelControl = (await import("./AgentModelControl")).AgentModelControl;
});

interface ActiveAgentFixture {
  id: string;
  name: string;
  resolvedProvider: { name: string; model: string };
  providerSource: "agent" | "instance";
}

// Route the card's reads and capture its writes. /status answers with the
// active agent under test; /agents carries the default agent whose pair
// "Use default model" copies.
function stubFetch(activeAgent: ActiveAgentFixture): Array<{ path: string; body: unknown }> {
  const posts: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, id: activeAgent.id });
    }
    const body =
      path === "/api/runtime/agents"
        ? {
            agents: [
              { id: "agent_default", name: "Gini", providerName: "anthropic", model: "claude-sonnet-4-6" }
            ]
          }
        : path === "/api/runtime/status"
          ? {
              ok: true,
              activeAgent,
              provider: { provider: { name: "anthropic", model: "claude-sonnet-4-6" } }
            }
          : {};
    return Response.json(body);
  }) as unknown as typeof fetch;
  return posts;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    rtlRender(
      <QueryClientProvider client={client}>
        <AgentModelControl />
      </QueryClientProvider>
    );
  });
}

describe("AgentModelControl", () => {
  test("pinned non-default agent: shows the pin and posts picks to the agent's provider route", async () => {
    const posts = stubFetch({
      id: "agent_research",
      name: "Research",
      resolvedProvider: { name: "openai", model: "gpt-4o" },
      providerSource: "agent"
    });
    await renderCard();
    // The card renders before the status/agents queries land — wait for the
    // active agent's data to arrive (Sidebar.test.tsx pattern).
    expect(await screen.findByText(/What Research('|’)s chats use/)).not.toBeNull();
    expect(screen.getByTestId("model-picker").getAttribute("data-value")).toBe("openai/gpt-4o");
    // Regex: the pin line's <p> also carries the separator and the
    // "Use default model" button, so an exact match can't see it.
    expect(screen.getByText(/Pinned for this agent/)).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("model-picker"));
    });
    expect(posts).toEqual([
      {
        path: "/api/runtime/agents/agent_research/provider",
        body: { providerName: "openai", model: "gpt-5.5" }
      }
    ]);
  });

  test("default agent: picks route through the two-layer default-model write", async () => {
    const posts = stubFetch({
      id: "agent_default",
      name: "Gini",
      resolvedProvider: { name: "anthropic", model: "claude-sonnet-4-6" },
      providerSource: "agent"
    });
    await renderCard();
    expect(await screen.findByText("This is the default model")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("model-picker"));
    });
    expect(posts).toEqual([
      {
        path: "/api/runtime/settings/default-model",
        body: { provider: "openai", model: "gpt-5.5" }
      }
    ]);
  });

  test("override-less agent reports it is following the default", async () => {
    stubFetch({
      id: "agent_research",
      name: "Research",
      resolvedProvider: { name: "anthropic", model: "claude-sonnet-4-6" },
      providerSource: "instance"
    });
    await renderCard();
    expect(await screen.findByText("Using the default model")).not.toBeNull();
    expect(screen.queryByText("Use default model")).toBeNull();
  });

  test("'Use default model' copies the CURRENT default pair onto the agent as a new pin", async () => {
    const posts = stubFetch({
      id: "agent_research",
      name: "Research",
      resolvedProvider: { name: "openai", model: "gpt-4o" },
      providerSource: "agent"
    });
    await renderCard();

    const useDefault = await screen.findByText("Use default model");
    await act(async () => {
      fireEvent.click(useDefault);
    });
    // The default agent's pair — not a blank-pair clear — so the agent stays
    // a snapshot, unsynced from future default changes.
    expect(posts).toEqual([
      {
        path: "/api/runtime/agents/agent_research/provider",
        body: { providerName: "anthropic", model: "claude-sonnet-4-6" }
      }
    ]);
  });
});
