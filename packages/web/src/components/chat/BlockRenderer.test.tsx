/// <reference lib="dom" />

// BlockRenderer dispatches the typed ChatBlock union to the per-kind row
// component. These tests pin two things: every kind routes to its component,
// and a gate (setup_requested / authorization_requested) forwarded from a Topic
// gets the TopicForwardChip deep-link rendered under its (still actionable)
// card while a non-forwarded gate renders the bare card. The child components
// are stubbed so the dispatcher is exercised without its react-query / api
// graph.

import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type {
  AuthorizationRequestedBlock,
  ChatBlock,
  SetupRequestedBlock
} from "@runtime/types";

mock.module("./BlockAuthorizationRequested", () => ({
  BlockAuthorizationRequested: () => <div data-testid="auth-card" />
}));
mock.module("./BlockSetupRequested", () => ({
  BlockSetupRequested: () => <div data-testid="setup-card" />
}));
mock.module("./BlockAssistantText", () => ({
  BlockAssistantText: () => <div data-testid="assistant-text" />
}));
mock.module("./BlockPhase", () => ({ BlockPhase: () => <div data-testid="phase" /> }));
mock.module("./BlockSystemNote", () => ({ BlockSystemNote: () => <div data-testid="system-note" /> }));
mock.module("./BlockToolCall", () => ({ BlockToolCall: () => <div data-testid="tool-call" /> }));
mock.module("./BlockUserText", () => ({ BlockUserText: () => <div data-testid="user-text" /> }));
mock.module("./RoutineCreatedCard", () => ({
  RoutineCreatedCard: ({ block }: { block: { jobId: string } }) => (
    <div data-testid="routine-card" data-job-id={block.jobId} />
  )
}));
mock.module("./TopicForwardChip", () => ({
  TopicForwardChip: ({ topicId, topicTitle }: { topicId: string; topicTitle?: string }) => (
    <div data-testid="forward-chip" data-topic-id={topicId} data-topic-title={topicTitle ?? ""} />
  )
}));

const { BlockRenderer } = await import("./BlockRenderer");

const base = {
  id: "b1",
  sessionId: "s",
  instance: "test" as const,
  ordinal: 0,
  createdAt: "2026-01-01T00:00:00.000Z"
};

function setupBlock(extra: Partial<SetupRequestedBlock> = {}): SetupRequestedBlock {
  return {
    ...base,
    kind: "setup_requested",
    setupRequestId: "sr1",
    action: "connector.request",
    summary: "Connect your account",
    ...extra
  };
}

function authBlock(extra: Partial<AuthorizationRequestedBlock> = {}): AuthorizationRequestedBlock {
  return {
    ...base,
    kind: "authorization_requested",
    authorizationId: "az1",
    action: "terminal.exec",
    risk: "high",
    summary: "Run a command",
    ...extra
  };
}

describe("BlockRenderer", () => {
  test("a forwarded setup_requested gate renders the card and the topic chip below it", () => {
    render(
      <BlockRenderer
        block={setupBlock({ forwardedFromTopicId: "topic-9", forwardedFromTopicTitle: "Taxes" })}
      />
    );
    expect(screen.getByTestId("setup-card")).not.toBeNull();
    const chip = screen.getByTestId("forward-chip");
    expect(chip.getAttribute("data-topic-id")).toBe("topic-9");
    expect(chip.getAttribute("data-topic-title")).toBe("Taxes");
  });

  test("a non-forwarded setup_requested gate renders the bare card with no chip", () => {
    render(<BlockRenderer block={setupBlock()} />);
    expect(screen.getByTestId("setup-card")).not.toBeNull();
    expect(screen.queryByTestId("forward-chip")).toBeNull();
  });

  test("a forwarded authorization_requested gate renders the card and the topic chip below it", () => {
    render(
      <BlockRenderer
        block={authBlock({ forwardedFromTopicId: "topic-5", forwardedFromTopicTitle: "Trip" })}
      />
    );
    expect(screen.getByTestId("auth-card")).not.toBeNull();
    const chip = screen.getByTestId("forward-chip");
    expect(chip.getAttribute("data-topic-id")).toBe("topic-5");
  });

  test("a non-forwarded authorization_requested gate renders the bare card with no chip", () => {
    render(<BlockRenderer block={authBlock()} />);
    expect(screen.getByTestId("auth-card")).not.toBeNull();
    expect(screen.queryByTestId("forward-chip")).toBeNull();
  });

  test("a forwarded final answer renders the chip", () => {
    render(
      <BlockRenderer
        isFinalAnswer
        block={{
          ...base,
          kind: "assistant_text",
          updatedAt: base.createdAt,
          text: "hi",
          streaming: false,
          forwardedFromTopicId: "topic-1"
        }}
      />
    );
    expect(screen.getByTestId("assistant-text")).not.toBeNull();
    expect(screen.getByTestId("forward-chip")).not.toBeNull();
  });

  test("forwarded intermediate narration (not the final answer) renders no chip", () => {
    // A forwarded Topic turn mirrors its per-iteration narration as
    // assistant_text too; only the final answer should carry the "# topic"
    // deep-link, so a narration line (isFinalAnswer unset) shows the bare text.
    render(
      <BlockRenderer
        block={{
          ...base,
          kind: "assistant_text",
          updatedAt: base.createdAt,
          text: "let me check",
          streaming: false,
          forwardedFromTopicId: "topic-1"
        }}
      />
    );
    expect(screen.getByTestId("assistant-text")).not.toBeNull();
    expect(screen.queryByTestId("forward-chip")).toBeNull();
  });

  test("routes the remaining kinds to their components", () => {
    const { rerender } = render(
      <BlockRenderer block={{ ...base, kind: "user_text", text: "hi" }} />
    );
    expect(screen.getByTestId("user-text")).not.toBeNull();

    rerender(
      <BlockRenderer
        block={{
          ...base,
          kind: "assistant_text",
          updatedAt: base.createdAt,
          text: "hi",
          streaming: false
        }}
      />
    );
    expect(screen.getByTestId("assistant-text")).not.toBeNull();

    rerender(
      <BlockRenderer
        block={{
          ...base,
          kind: "tool_call",
          updatedAt: base.createdAt,
          toolName: "shell",
          displayLabel: "Run",
          argsPreview: "ls",
          argsFull: {},
          status: "ok",
          callId: "c1"
        }}
      />
    );
    expect(screen.getByTestId("tool-call")).not.toBeNull();

    // tool_result renders nothing (shown inline under its parent tool_call).
    const { container } = render(
      <BlockRenderer
        block={{ ...base, kind: "tool_result", callId: "c1", preview: "ok", truncated: false }}
      />
    );
    expect(container.querySelector("[data-testid]")).toBeNull();

    rerender(<BlockRenderer block={{ ...base, kind: "phase", label: "Thinking" }} />);
    expect(screen.getByTestId("phase")).not.toBeNull();

    rerender(<BlockRenderer block={{ ...base, kind: "system_note", text: "note" }} />);
    expect(screen.getByTestId("system-note")).not.toBeNull();
  });

  test("a jobId-stamped create_job routes to the routine card; without a jobId it keeps the tool row", () => {
    const createJob = {
      ...base,
      kind: "tool_call" as const,
      updatedAt: base.createdAt,
      toolName: "create_job",
      displayLabel: "Create scheduled job",
      argsPreview: "hn-mentions",
      argsFull: { name: "hn-mentions" },
      status: "ok" as const,
      callId: "c-job"
    };
    const { rerender } = render(<BlockRenderer block={{ ...createJob, jobId: "job_1" }} />);
    const card = screen.getByTestId("routine-card");
    expect(card.getAttribute("data-job-id")).toBe("job_1");
    expect(screen.queryByTestId("tool-call")).toBeNull();

    // No jobId (failed call / legacy block): generic tool row.
    rerender(<BlockRenderer block={createJob} />);
    expect(screen.getByTestId("tool-call")).not.toBeNull();
    expect(screen.queryByTestId("routine-card")).toBeNull();
  });

  test("an unknown kind throws via the exhaustive guard", () => {
    // Call the dispatcher directly rather than through render(): React's
    // reconciler swallows the synchronous throw into its own error path, which
    // leaves the guard branch unattributed by coverage. A plain function call
    // runs the switch in the test's own stack so the branch is counted.
    expect(() =>
      BlockRenderer({ block: { ...base, kind: "nope" } as unknown as ChatBlock })
    ).toThrow(/Unexpected value/);
  });
});
