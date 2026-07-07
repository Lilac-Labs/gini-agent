// Unit tests for groupExchanges. Two behaviors matter: (1) a completed
// exchange with file writes emits one grouped file_artifact, and (2) blocks
// are partitioned into exchanges by taskId — a single agent turn or job
// cycle — so a recurring-job channel (no user_text) renders one tool group
// per cron cycle, and interleaved task blocks still reunite by task. Every
// fixture carries a taskId, mirroring production (a turn's user_text,
// assistant_text, and tool calls all share that turn's taskId). These are
// pure-JS tests over minimal ChatBlock fixtures.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, ToolCallBlock } from "@runtime/types";
import { groupExchanges } from "./group-exchanges";

let ordinal = 0;

function user(text: string, taskId: string): ChatBlock {
  return { kind: "user_text", id: `u${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", text, taskId } as ChatBlock;
}

function assistant(text: string, taskId: string, streaming = false): ChatBlock {
  return { kind: "assistant_text", id: `a${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", text, streaming, taskId } as ChatBlock;
}

function toolCall(overrides: Partial<ToolCallBlock>): ChatBlock {
  return {
    kind: "tool_call",
    id: `t${ordinal}`,
    sessionId: "s",
    instance: "test",
    ordinal: ordinal++,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    toolName: "file_write",
    displayLabel: "Write file",
    argsPreview: "",
    argsFull: {},
    status: "ok",
    callId: `call-${ordinal}`,
    ...overrides
  } as ChatBlock;
}

function toolResult(callId: string, taskId: string, preview = ""): ChatBlock {
  return { kind: "tool_result", id: `r${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", callId, preview, truncated: false, taskId } as ChatBlock;
}

function setupRequested(summary: string, taskId: string): ChatBlock {
  return { kind: "setup_requested", id: `sr${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", setupRequestId: `setup-${ordinal}`, action: "chat.choice", summary, taskId } as ChatBlock;
}

// A job-cycle exchange: an assistant preamble, a tool call, and a final
// reply, all stamped with the same taskId. Recurring-job channels emit these
// with no user_text — the cycle is triggered by cron, not a user message.
function cycle(taskId: string, query: string, streaming = false): ChatBlock[] {
  return [
    assistant("checking", taskId),
    toolCall({ toolName: "web_search", argsPreview: query, argsFull: { query }, status: "ok", taskId }),
    assistant("No major news this cycle.", taskId, streaming)
  ];
}

describe("groupExchanges file artifacts", () => {
  test("a completed exchange with a successful file_write yields one grouped file_artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_1"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_1" }),
      assistant("done", "task_1")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(1);
    expect(artifacts[0]!.files[0]).toMatchObject({ path: "note.md", toolName: "file_write" });
    // The card renders below the agent's reply: file_artifact comes after the
    // assistant_text block.
    const assistantIdx = items.findIndex((i) => i.kind === "block" && i.block.kind === "assistant_text");
    const artifactIdx = items.findIndex((i) => i.kind === "file_artifact");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(artifactIdx).toBeGreaterThan(assistantIdx);
  });

  test("two distinct paths group into one artifact carrying both files", () => {
    const items = groupExchanges([
      user("write two", "task_2"),
      toolCall({ toolName: "file_write", argsFull: { path: "a.md" }, status: "ok", taskId: "task_2" }),
      toolCall({ toolName: "file_write", argsFull: { path: "b.md" }, status: "ok", taskId: "task_2" }),
      assistant("done", "task_2")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(2);
    expect(artifacts[0]!.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });

  test("two writes to the same path dedupe to one file", () => {
    const items = groupExchanges([
      user("write twice", "task_3"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_3" }),
      toolCall({ toolName: "file_patch", argsFull: { path: "note.md" }, status: "ok", taskId: "task_3" }),
      assistant("done", "task_3")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(1);
    // Last occurrence's toolName wins.
    expect(artifacts[0]!.files[0]).toMatchObject({ path: "note.md", toolName: "file_patch" });
  });

  test("a failed file_write yields no artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_4"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "error", taskId: "task_4" }),
      assistant("failed", "task_4")
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });

  test("an incomplete exchange yields no artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_5"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_5" }),
      assistant("typing", "task_5", true)
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });
});

describe("groupExchanges by taskId", () => {
  test("each cron cycle (no user_text, distinct taskId) gets its own tool group", () => {
    const items = groupExchanges([
      ...cycle("task_a", "breaking news today"),
      ...cycle("task_b", "stock market June 15"),
      ...cycle("task_c", "AI launch June 15")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(3);
    // Each group holds exactly the one cycle's tool call, not a merged pile.
    expect(groups.every((g) => g.calls.length === 1)).toBe(true);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual([
      "breaking news today",
      "stock market June 15",
      "AI launch June 15"
    ]);
  });

  test("a single cycle's multiple tool calls stay in one group", () => {
    const taskId = "task_solo";
    const items = groupExchanges([
      assistant("checking", taskId),
      toolCall({ toolName: "web_search", argsPreview: "q1", status: "ok", taskId }),
      toolCall({ toolName: "web_fetch", argsPreview: "q2", status: "ok", taskId }),
      assistant("done", taskId)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.length).toBe(2);
  });

  test("a still-streaming cycle folds like a completed one, with its streaming reply as the trailing bubble", () => {
    const items = groupExchanges([
      ...cycle("task_done", "first"),
      ...cycle("task_live", "second", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    // Both cycles fold — the in-flight one no longer leaks its tool call inline.
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["first", "second"]);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
    // Each cycle's reply (the streaming one included) stays a standalone bubble.
    const bubbles = items.filter((i) => i.kind === "block" && i.block.kind === "assistant_text");
    expect(bubbles.length).toBe(2);
  });

  test("interleaved task blocks still group by task (manual run overlapping a scheduled run)", () => {
    // task_a emits its tool call, then task_b runs to completion, then task_a
    // emits its final reply — out of order in the session's ordinal stream.
    // Grouping by taskId (not contiguous run) must still form both groups.
    const items = groupExchanges([
      assistant("checking", "task_a"),
      toolCall({ toolName: "web_search", argsPreview: "alpha", status: "ok", taskId: "task_a" }),
      assistant("checking", "task_b"),
      toolCall({ toolName: "web_search", argsPreview: "beta", status: "ok", taskId: "task_b" }),
      assistant("done b", "task_b"),
      assistant("done a", "task_a")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(2);
    // Exchange order follows each task's first appearance: task_a, then task_b.
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["alpha", "beta"]);
    // Both groups are complete (each task's final reply closes its exchange),
    // so neither tool call leaks out as an inline block.
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
  });

  test("a completed exchange with no tool calls passes its blocks through untouched", () => {
    const items = groupExchanges([user("hi", "task_chat"), assistant("hello there", "task_chat")]);
    expect(items.every((i) => i.kind === "block")).toBe(true);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.length).toBe(2);
  });

  test("an exchange mid-tool-call (no final reply) folds into a group, not a loose inline tool call", () => {
    const items = groupExchanges([
      user("search", "task_run"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "running", taskId: "task_run" })
    ]);
    // In flight with a tool call → folds immediately (the collapsed group grows
    // as the turn runs); the running call lives in the group, not inline.
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.length).toBe(1);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
  });

  test("a block with no taskId forms its own single-block exchange in place", () => {
    const items = groupExchanges([
      { kind: "phase", id: "p0", sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", label: "thinking" } as ChatBlock
    ]);
    // No tool calls in the exchange ⇒ it passes through as a raw block, never
    // a group.
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items).toEqual([{ kind: "block", block: expect.objectContaining({ kind: "phase" }) }]);
  });

  test("a user turn in a job channel groups separately from the cron cycles", () => {
    const items = groupExchanges([
      ...cycle("task_a", "auto cycle"),
      user("hey, anything on sports?", "task_user"),
      assistant("checking", "task_user"),
      toolCall({ toolName: "web_search", argsPreview: "sports scores", status: "ok", taskId: "task_user" }),
      assistant("here you go", "task_user")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["auto cycle", "sports scores"]);
  });
});

describe("groupExchanges narration folding", () => {
  test("a completed multi-tool exchange folds non-final narration into the process and keeps only the final answer standalone", () => {
    const items = groupExchanges([
      user("look into it", "task_n"),
      assistant("let me check", "task_n"),
      toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_n" }),
      assistant("found it", "task_n"),
      toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_n" }),
      assistant("answer", "task_n")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    // calls is retained — tool_call blocks only.
    expect(group.calls.length).toBe(2);
    expect(group.calls.map((c) => c.argsPreview)).toEqual(["first", "second"]);
    // steps preserve exchange order: narration, tool, narration, tool.
    expect(group.steps.map((s) => s.kind)).toEqual([
      "narration",
      "tool_call",
      "narration",
      "tool_call"
    ]);
    expect(
      group.steps.map((s) =>
        s.kind === "narration" ? s.block.text : s.block.argsPreview
      )
    ).toEqual(["let me check", "first", "found it", "second"]);
    // The only standalone assistant_text is the final answer; the
    // narration never leaks out as its own bubble.
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    expect(
      standaloneAssistant[0]!.kind === "block" &&
        standaloneAssistant[0]!.block.kind === "assistant_text" &&
        standaloneAssistant[0]!.block.text
    ).toBe("answer");
    // The standalone final answer is flagged so a forwarded turn shows its
    // "# topic" chip only here, not under every folded narration line.
    expect(standaloneAssistant[0]!.kind === "block" && standaloneAssistant[0]!.isFinalAnswer).toBe(true);
  });

  test("an in-flight version folds narration into the group as Thinking steps, with only the streaming answer standalone", () => {
    const items = groupExchanges([
      user("look into it", "task_stream"),
      assistant("let me check", "task_stream"),
      toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_stream" }),
      assistant("found it", "task_stream"),
      toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_stream" }),
      assistant("answer", "task_stream", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.calls.length).toBe(2);
    // Narration folds in as "Thinking" steps, interleaved with the tool calls —
    // exactly as it would once the turn completes (no reflow on finish).
    expect(group.steps.map((s) => s.kind)).toEqual([
      "narration",
      "tool_call",
      "narration",
      "tool_call"
    ]);
    // Only the still-streaming final answer remains a standalone bubble.
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    const finalBubble = standaloneAssistant[0]!;
    expect(
      finalBubble.kind === "block" &&
        finalBubble.block.kind === "assistant_text" &&
        finalBubble.block.text
    ).toBe("answer");
    // The trailing answer slot is the final answer (streaming or settled), so it
    // carries isFinalAnswer; the folded narration never does, so a forwarded turn
    // shows its "# topic" chip only on this closing reply.
    expect(finalBubble.kind === "block" && finalBubble.isFinalAnswer).toBe(true);
  });

  test("a completed no-tool exchange flags only its lone reply as the final answer", () => {
    const items = groupExchanges([user("hi", "task_q"), assistant("hello there", "task_q")]);
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    expect(standaloneAssistant[0]!.kind === "block" && standaloneAssistant[0]!.isFinalAnswer).toBe(true);
  });

  // Native (server-side) web search surfaces as a display-only "Web search"
  // tool_call chip with NO paired tool_result. The runtime emits it mid-stream
  // so it lands BEFORE the answer; this pins that ordering renders the answer as
  // a standalone final-answer bubble with the chip folded into the group.
  test("a native web_search chip before the answer keeps the answer a standalone bubble", () => {
    const items = groupExchanges([
      user("what's the top HN story?", "task_ws"),
      toolCall({ toolName: "web_search", argsPreview: "top hacker news story", argsFull: { query: "top hacker news story" }, status: "ok", taskId: "task_ws" }),
      assistant("The top story is X.", "task_ws")
    ], new Set(["task_ws"]));
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.calls.length).toBe(1);
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    expect(
      standaloneAssistant[0]!.kind === "block" &&
        standaloneAssistant[0]!.block.kind === "assistant_text" &&
        standaloneAssistant[0]!.block.text
    ).toBe("The top story is X.");
    expect(standaloneAssistant[0]!.kind === "block" && standaloneAssistant[0]!.isFinalAnswer).toBe(true);
  });

  // The contrapositive that makes the mid-stream ordering load-bearing: a
  // display-only chip emitted AFTER the answer (the naive post-turn approach)
  // pushes the last tool-call index past the answer, so finalAnswerIdx stays -1
  // and the answer is demoted into the collapsed group with no standalone bubble.
  test("a native web_search chip after the answer folds the answer out of its bubble", () => {
    const items = groupExchanges([
      user("what's the top HN story?", "task_ws2"),
      assistant("The top story is X.", "task_ws2"),
      toolCall({ toolName: "web_search", argsPreview: "top hacker news story", status: "ok", taskId: "task_ws2" })
    ], new Set(["task_ws2"]));
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(0);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.steps.some((s) => s.kind === "narration" && s.block.text === "The top story is X.")).toBe(true);
  });
});

describe("groupExchanges ask_user exemption", () => {
  // ask_user renders as the agent speaking: the chat.choice setup_requested
  // block is the sole representation, so the tool_call must produce neither
  // a tool-group row nor a loose inline block.
  test("an ask_user call never renders a tool row — its chat.choice block is the sole representation", () => {
    const items = groupExchanges([
      user("book a table", "task_ask"),
      toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Which venue?", status: "ok", taskId: "task_ask" }),
      setupRequested("Which venue?", "task_ask")
    ]);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "setup_requested")).toBe(true);
  });

  // The ask_user tool_result survives the tool_call filter, so a turn whose
  // ONLY call was ask_user takes the no-tool passthrough. The result must not
  // leak out as a block item — BlockRenderer renders tool_result as null, so
  // it would become an empty transcript row (an empty <li>).
  test("an ask_user-only turn's tool_result never passes through as a block item", () => {
    const items = groupExchanges([
      user("book a table", "task_ask_res"),
      toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Which venue?", status: "ok", callId: "call-ask", taskId: "task_ask_res" }),
      toolResult("call-ask", "task_ask_res"),
      setupRequested("Which venue?", "task_ask_res")
    ]);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_result")).toBe(false);
    // Only the user's message and the chat.choice block render.
    expect(items.length).toBe(2);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "setup_requested")).toBe(true);
  });

  // When the ask is the turn's FIRST process-eligible block (no narration or
  // call before it) and the answered run goes on to make a real tool call,
  // the ask's orphaned tool_result sits before the group anchor. It must not
  // pass through as a block item — that would render an empty transcript row
  // between the settled ask and the tool group.
  test("a settled ask followed by a real tool call never leaks the ask's orphaned tool_result", () => {
    const items = groupExchanges(
      [
        user("which repo?", "task_ask_resume"),
        toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Which repo?", status: "ok", callId: "call-ask2", taskId: "task_ask_resume" }),
        setupRequested("Which repo?", "task_ask_resume"),
        toolResult("call-ask2", "task_ask_resume"),
        toolCall({ toolName: "web_search", argsPreview: "repo docs", status: "ok", callId: "call-ws", taskId: "task_ask_resume" }),
        toolResult("call-ws", "task_ask_resume"),
        assistant("here you go", "task_ask_resume")
      ],
      new Set(["task_ask_resume"])
    );
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_result")).toBe(false);
    // The settled ask stays in place, directly followed by the tool group.
    const kinds = items.map((i) => (i.kind === "block" ? i.block.kind : i.kind));
    expect(kinds).toEqual(["user_text", "setup_requested", "tool_group", "assistant_text"]);
  });

  // A rejected ask_user (the dispatcher refused to mint a choice —
  // option-less or malformed args) produces no chat.choice block, so the
  // call must render as a tool row instead of the turn showing nothing. The
  // graceful steer settles the call "ok" and carries the rejection only in
  // the paired tool_result's `{"ok":false,...}` JSON.
  test("a rejected ask_user call (graceful ok:false result) still renders a tool row", () => {
    const items = groupExchanges([
      user("reply to dana", "task_ask_rej"),
      toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "What should the reply say?", status: "ok", callId: "call-rej", taskId: "task_ask_rej" }),
      toolResult("call-rej", "task_ask_rej", '{"ok":false,"error":"ask_user only presents choices — `options` (2-6 entries…'),
      assistant("What should the reply say?", "task_ask_rej")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.map((c) => c.toolName)).toEqual(["ask_user"]);
  });

  test("an error-status ask_user call still renders a tool row", () => {
    const items = groupExchanges([
      user("pick one", "task_ask_err"),
      toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Pick?", status: "error", callId: "call-err", taskId: "task_ask_err" }),
      assistant("Pick?", "task_ask_err")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.map((c) => c.toolName)).toEqual(["ask_user"]);
  });

  // The successful path is untouched by the rejection carve-out: an answered
  // ask's tool_result reads `User selected: ...`, not ok:false JSON, so the
  // call stays hidden and the chat.choice block remains the representation.
  test("an answered ask_user still never renders a tool row", () => {
    const items = groupExchanges(
      [
        user("book a table", "task_ask_ans"),
        toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Which venue?", status: "ok", callId: "call-ans", taskId: "task_ask_ans" }),
        setupRequested("Which venue?", "task_ask_ans"),
        toolResult("call-ans", "task_ask_ans", 'User selected: "Blue Door"'),
        assistant("Booked.", "task_ask_ans")
      ],
      new Set(["task_ask_ans"])
    );
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "setup_requested")).toBe(true);
  });

  test("a mixed turn folds only the non-ask_user calls into the group", () => {
    const items = groupExchanges([
      user("find a venue", "task_ask_mixed"),
      toolCall({ toolName: "web_search", argsPreview: "venues nearby", status: "ok", taskId: "task_ask_mixed" }),
      toolCall({ toolName: "ask_user", displayLabel: "Ask user", argsPreview: "Which venue?", status: "ok", taskId: "task_ask_mixed" }),
      setupRequested("Which venue?", "task_ask_mixed")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.map((c) => c.toolName)).toEqual(["web_search"]);
    expect(
      groups[0]!.steps.every((s) => s.kind !== "tool_call" || s.block.toolName !== "ask_user")
    ).toBe(true);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "setup_requested")).toBe(true);
  });
});

describe("groupExchanges in-flight expansion", () => {
  // The tool_group carries `inProgress` so the renderer can keep an actively
  // generating turn EXPANDED (each tool call visible as it lands) and collapse
  // it to the one-line summary only once the turn settles.
  test("a turn still mid-tool-call is inProgress", () => {
    const items = groupExchanges([
      user("search", "task_live"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "running", taskId: "task_live" })
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.inProgress).toBe(true);
  });

  test("a turn whose reply is still streaming is inProgress", () => {
    const items = groupExchanges([
      user("look", "task_stream2"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_stream2" }),
      assistant("typing", "task_stream2", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(true);
  });

  test("a settled turn is not inProgress (collapses to the summary)", () => {
    const items = groupExchanges([
      user("look", "task_done2"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_done2" }),
      assistant("here you go", "task_done2")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(false);
  });

  test("a terminal run that stopped on a tool call is not inProgress", () => {
    const items = groupExchanges(
      [
        toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_term3" }),
        toolResult("call-x", "task_term3")
      ],
      new Set(["task_term3"])
    );
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(false);
  });
});

describe("groupExchanges terminal narration folding", () => {
  test("a terminal run that ended on a tool call (no final answer) folds all narration with no standalone bubble", () => {
    // The run carries a "Completed" phase (terminal) but the model stopped
    // after a tool call — its last assistant_text precedes that call. The
    // caller passes the taskId in terminalTaskIds; everything folds.
    const items = groupExchanges(
      [
        assistant("narration", "task_term"),
        toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_term" }),
        toolResult("call-1", "task_term"),
        assistant("court", "task_term"),
        toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_term" }),
        toolResult("call-2", "task_term")
      ],
      new Set(["task_term"])
    );
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.calls.length).toBe(2);
    expect(group.calls.map((c) => c.argsPreview)).toEqual(["first", "second"]);
    // Both pre-tool narration lines fold into the process as steps.
    const narrationSteps = group.steps.filter((s) => s.kind === "narration");
    expect(narrationSteps.map((s) => s.kind === "narration" && s.block.text)).toEqual([
      "narration",
      "court"
    ]);
    // No assistant_text leaks out as a standalone bubble.
    expect(items.some((i) => i.kind === "block" && i.block.kind === "assistant_text")).toBe(false);
  });
});
