/// <reference lib="dom" />

// chat.choice rendering: the ask_user question renders as the agent
// speaking — an assistant-style message line (avatar + name + question),
// never the bordered "Question" setup card. Pending WITH options shows
// one-click choice rows beneath the question plus the UI-owned "Other (type
// your answer)" and a subtle Skip; clicking an option POSTs
// { choice: { label } } to /setup-requests/:id/complete immediately. A
// historical question-only row (pre-options-only ask_user) shows just the
// question — no input, no Submit, no Skip — because the composer is the
// answer path. Settled rows keep the question as the agent's message with a
// muted outcome line and no choices.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SetupRequest, SetupRequestedBlock } from "@runtime/types";

// Controllable api() mock: GET queries (setup-requests, providers) resolve
// from `apiImpl`; the option-click POST is captured in `apiCalls`. Installed
// before importing the component so every hook picks up the stub.
type ApiCall = { path: string; init?: RequestInit };
let apiCalls: ApiCall[] = [];
let setupRows: SetupRequest[] = [];
let apiImpl: (path: string, init?: RequestInit) => Promise<unknown> = async (path) =>
  path === "/setup-requests" ? setupRows : [];
const api = mock((path: string, init?: RequestInit) => {
  apiCalls.push({ path, init });
  return apiImpl(path, init);
});
// Replace only api(); keep every other export real. MarkdownContent (the
// question bubble renders through it) imports uploadUrl/uploadInlineUrl from
// this module, and mock.module is process-wide — a partial mock would break
// (or silently rewire) other test files sharing the process.
const actualApi = await import("@/lib/api");
mock.module("@/lib/api", () => ({ ...actualApi, api }));
// The connector dialog and screencast modal drag in unrelated graphs; the
// chat.choice branch never mounts them.
mock.module("@/components/AddConnectorDialog", () => ({ AddConnectorDialog: () => null }));
mock.module("@/components/browser/ScreencastModal", () => ({ ScreencastModal: () => null }));

const { BlockSetupRequested } = await import("./BlockSetupRequested");

function choiceBlock(extra: Partial<SetupRequestedBlock> = {}): SetupRequestedBlock {
  return {
    id: "b1",
    sessionId: "s",
    instance: "test",
    ordinal: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    kind: "setup_requested",
    setupRequestId: "sr1",
    action: "chat.choice",
    summary: "Which venue?",
    ...extra
  };
}

function choiceSetup(extra: Partial<SetupRequest> = {}): SetupRequest {
  return {
    id: "sr1",
    instance: "test",
    taskId: "task_1",
    action: "chat.choice",
    target: "Which venue?",
    reason: "Which venue?",
    status: "pending",
    payload: {
      question: "Which venue?",
      options: [{ label: "Blue Door", description: "Closest" }, { label: "Harbor House" }],
      toolCallId: "call_1"
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...extra
  } as SetupRequest;
}

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  apiCalls = [];
  setupRows = [];
  apiImpl = async (path) => (path === "/setup-requests" ? setupRows : []);
  api.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("BlockSetupRequested chat.choice", () => {
  test("pending with options renders as the agent speaking with choice rows, Other, and Skip", async () => {
    setupRows = [choiceSetup()];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} agent={{ id: "agent_1", name: "Gini" }} />);

    // The question reads as a normal agent message, not a setup card.
    expect(screen.getByText("Which venue?")).not.toBeNull();
    expect(screen.getByText("Gini")).not.toBeNull();
    expect(screen.queryByText("Question")).toBeNull();
    expect(screen.queryByText("Show details")).toBeNull();

    // Choice rows appear once the setup row loads.
    await waitFor(() => expect(screen.queryByText("Blue Door")).not.toBeNull());
    expect(screen.getByText("Harbor House")).not.toBeNull();
    expect(screen.getByText("Closest")).not.toBeNull();
    expect(screen.getByText("Other (type your answer)")).not.toBeNull();
    expect(screen.getByText("Skip")).not.toBeNull();

    // Clicking an option submits { choice: { label } } immediately.
    fireEvent.click(screen.getByText("Blue Door"));
    await waitFor(() =>
      expect(
        apiCalls.some(
          (c) =>
            c.path === "/setup-requests/sr1/complete" &&
            c.init?.body === JSON.stringify({ choice: { label: "Blue Door" } })
        )
      ).toBe(true)
    );
  });

  test("Other expands into a free-text input that submits { choice: { other } }", async () => {
    setupRows = [choiceSetup()];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);
    await waitFor(() => expect(screen.queryByText("Other (type your answer)")).not.toBeNull());

    fireEvent.click(screen.getByText("Other (type your answer)"));
    const input = screen.getByPlaceholderText("Type your answer");
    fireEvent.change(input, { target: { value: "The rooftop place" } });
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() =>
      expect(
        apiCalls.some(
          (c) =>
            c.path === "/setup-requests/sr1/complete" &&
            c.init?.body === JSON.stringify({ choice: { other: "The rooftop place" } })
        )
      ).toBe(true)
    );
  });

  test("Enter in the Other input submits { choice: { other } }", async () => {
    setupRows = [choiceSetup()];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);
    await waitFor(() => expect(screen.queryByText("Other (type your answer)")).not.toBeNull());

    fireEvent.click(screen.getByText("Other (type your answer)"));
    const input = screen.getByPlaceholderText("Type your answer");
    fireEvent.change(input, { target: { value: "The rooftop place" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        apiCalls.some(
          (c) =>
            c.path === "/setup-requests/sr1/complete" &&
            c.init?.body === JSON.stringify({ choice: { other: "The rooftop place" } })
        )
      ).toBe(true)
    );
  });

  test("Skip posts to /setup-requests/:id/cancel and a cancelled row renders \"Skipped\"", async () => {
    setupRows = [choiceSetup()];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);
    await waitFor(() => expect(screen.queryByText("Skip")).not.toBeNull());

    fireEvent.click(screen.getByText("Skip"));
    await waitFor(() =>
      expect(
        apiCalls.some((c) => c.path === "/setup-requests/sr1/cancel" && c.init?.method === "POST")
      ).toBe(true)
    );

    // Post-cancel: the settled row keeps the question with the muted
    // "Skipped" line, choices and Skip gone.
    document.body.innerHTML = "";
    setupRows = [choiceSetup({ status: "cancelled" })];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);
    expect(screen.getByText("Which venue?")).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("Skipped")).not.toBeNull());
    expect(screen.queryByText("Blue Door")).toBeNull();
    expect(screen.queryByText("Skip")).toBeNull();
  });

  test("a missing setup record falls back to block.summary and withholds the choices", async () => {
    // The record can be absent from /setup-requests (e.g. pruned state);
    // without the trusted payload there is nothing safe to submit, so only
    // the question renders — no options, no Other, no Skip.
    setupRows = [];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);

    expect(screen.getByText("Which venue?")).not.toBeNull();
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === "/setup-requests")).toBe(true));
    expect(screen.queryByText("Blue Door")).toBeNull();
    expect(screen.queryByText("Other (type your answer)")).toBeNull();
    expect(screen.queryByText("Skip")).toBeNull();
  });

  test("a historical question-only row renders just the question — no input, no Submit, no Skip", async () => {
    setupRows = [choiceSetup({ payload: { question: "What should the reply say?", options: [], toolCallId: "call_1" } })];
    renderWithQuery(<BlockSetupRequested block={choiceBlock({ summary: "What should the reply say?" })} />);

    expect(screen.getByText("What should the reply say?")).not.toBeNull();
    // Give the setup query a beat to land — nothing actionable may appear.
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === "/setup-requests")).toBe(true));
    expect(screen.queryByText("Submit")).toBeNull();
    expect(screen.queryByText("Skip")).toBeNull();
    expect(screen.queryByPlaceholderText("Type your answer")).toBeNull();
  });

  test("settled rows keep the question as the agent's message with the outcome line, choices gone", async () => {
    setupRows = [
      choiceSetup({ status: "completed", connectOutcome: { ok: true, message: "You selected: Blue Door" } })
    ];
    renderWithQuery(<BlockSetupRequested block={choiceBlock()} />);

    expect(screen.getByText("Which venue?")).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("You selected: Blue Door")).not.toBeNull());
    expect(screen.queryByText("Blue Door", { exact: true })).toBeNull();
    expect(screen.queryByText("Other (type your answer)")).toBeNull();
    expect(screen.queryByText("Skip")).toBeNull();
  });
});
