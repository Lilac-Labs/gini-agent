// Tests for the Slice 4 subagent runtime: spawn_subagent tool dispatch,
// nesting-depth cap, end-to-end summary propagation, and parent-cancel
// cascade.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { cancelTask, submitTask } from "../agent";
import { mutateState, readState } from "../state";
import type { RuntimeConfig, Task } from "../types";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "./subagents";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-subagent-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-subagent-test-logs",
    // Keep these tests on the gated path; they assert pause + cascade
    // behavior that needs an approval row to land.
    approvalMode: "strict"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 8000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")
    ) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("subagent runtime (Slice 4)", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-subagent-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-subagent-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("spawn_subagent tool creates a record + child task with the right system prompt and constraints", async () => {
    const config = buildConfig(workspaceRoot, "subagent-spawn");
    const provider = normalizeProvider(config.provider);

    // Parent turn 1: model calls spawn_subagent.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({
              name: "research",
              prompt: "find a thing",
              system_prompt: "You are a research assistant. Be terse.",
              toolsets: ["file"],
              skills: ["apple-notes"]
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn: it just answers directly.
    setEchoToolCallingResponse({
      provider,
      text: "found one thing",
      toolCalls: [],
      finishReason: "stop"
    });
    // Parent turn 2: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Subagent reports: found one thing",
      toolCalls: [],
      finishReason: "stop"
    });

    const parent = await submitTask(config, "delegate this", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Subagent reports: found one thing");

    const state = readState(config.instance);
    expect(state.subagents.length).toBe(1);
    const sub = state.subagents[0]!;
    expect(sub.name).toBe("research");
    expect(sub.prompt).toBe("find a thing");
    expect(sub.systemPrompt).toBe("You are a research assistant. Be terse.");
    expect(sub.toolsetIds).toEqual(["file"]);
    expect(sub.skillNames).toEqual(["apple-notes"]);
    expect(sub.parentTaskId).toBe(parent.id);
    expect(sub.taskId).toBeDefined();
    expect(sub.status).toBe("completed");
    expect(sub.resultSummary).toBe("found one thing");

    // The child task linked to the subagent should be a chat-mode task.
    const childTask = state.tasks.find((t) => t.id === sub.taskId);
    expect(childTask).toBeDefined();
    expect(childTask?.mode).toBe("chat");
    expect(childTask?.subagentId).toBe(sub.id);
    expect(childTask?.parentTaskId).toBe(parent.id);

    // The audit trail should include subagent.spawn (medium risk).
    const spawnAudits = state.audit.filter((a) => a.action === "subagent.spawn");
    expect(spawnAudits.length).toBe(1);
    expect(spawnAudits[0]?.risk).toBe("medium");
    expect(spawnAudits[0]?.taskId).toBe(parent.id);
  });

  test("a contiguous batch of spawn_subagent calls runs concurrently, not serially", async () => {
    const config = buildConfig(workspaceRoot, "subagent-parallel");
    const provider = normalizeProvider(config.provider);

    // Concurrency is proven by INTERVAL OVERLAP, not wall-clock magnitude.
    // Each child's lifetime is [createdAt, completedAt] on its SubagentRecord.
    // Each child turn sleeps DELAY_MS, so every child's interval has real
    // width. Under concurrent dispatch all children are created (spawned)
    // before any completes, so max(createdAt) < min(completedAt) — the
    // intervals share a common instant. Under serial dispatch child B is
    // created only after child A has completed, so that inequality is false.
    // This ordering test is independent of machine load: a busy CI box
    // stretches every timestamp uniformly and cannot turn a serial ordering
    // into an overlapping one (or vice versa). Interval overlap is the chosen
    // signal — rather than a wall-clock ceiling — precisely because magnitude
    // tracks load while ordering does not.
    const DELAY_MS = 200;
    const CHILDREN = 3;

    // Parent turn 1: emit THREE spawn_subagent calls in a single assistant turn
    // — the contiguous batch the loop should run under Promise.all.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_a",
          type: "function",
          function: { name: "spawn_subagent", arguments: JSON.stringify({ name: "lane-a", prompt: "research lane A" }) }
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "spawn_subagent", arguments: JSON.stringify({ name: "lane-b", prompt: "research lane B" }) }
        },
        {
          id: "call_c",
          type: "function",
          function: { name: "spawn_subagent", arguments: JSON.stringify({ name: "lane-c", prompt: "research lane C" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    // Three identical delayed child turns. The children consume these
    // concurrently; because the stubs are identical, the FIFO order they're
    // claimed in doesn't affect the observed behavior.
    for (let i = 0; i < CHILDREN; i += 1) {
      setEchoToolCallingResponse(
        { provider, text: "lane done", toolCalls: [], finishReason: "stop" },
        undefined,
        { delayMs: DELAY_MS }
      );
    }
    // Parent turn 2: final answer (consumed only after ALL children terminal,
    // so it can never be claimed by a child — FIFO stays well-ordered).
    setEchoToolCallingResponse({
      provider,
      text: "All lanes reported in.",
      toolCalls: [],
      finishReason: "stop"
    });

    const parent = await submitTask(config, "fan out three lanes", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id, 8000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("All lanes reported in.");

    // All subagents really ran and completed.
    const state = readState(config.instance);
    const subs = state.subagents.filter((s) => s.parentTaskId === parent.id);
    expect(subs.length).toBe(CHILDREN);
    expect(subs.every((s) => s.status === "completed")).toBe(true);

    // Every child must carry a real lifetime interval.
    const intervals = subs.map((s) => {
      expect(s.createdAt).toBeDefined();
      expect(s.completedAt).toBeDefined();
      return { start: Date.parse(s.createdAt), end: Date.parse(s.completedAt!) };
    });
    expect(intervals.every((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end))).toBe(true);

    // Concurrency proof (load-independent): the last child to be spawned
    // started before the first child finished, so all three lifetimes share a
    // common instant. A serial dispatch would spawn each child only after the
    // previous one finished, making latestStart >= earliestEnd.
    const latestStart = Math.max(...intervals.map((iv) => iv.start));
    const earliestEnd = Math.min(...intervals.map((iv) => iv.end));
    expect(latestStart).toBeLessThan(earliestEnd);
  });

  test("a non-spawn call between two spawns breaks the batch (they run serially)", async () => {
    const config = buildConfig(workspaceRoot, "subagent-interleaved");
    const provider = normalizeProvider(config.provider);

    // Only CONTIGUOUS runs of spawn calls batch. A non-spawn tool call
    // between two spawns splits them into two length-1 runs, neither of
    // which meets the >=2 threshold, so both fall to the serial await path.
    // This is the inverse of the concurrency proof: serial dispatch spawns
    // the second child only after the first reaches terminal, so the two
    // lifetimes are disjoint (latestStart >= earliestEnd). Like the positive
    // test, the assertion is on ordering, not wall-clock magnitude, so it is
    // load-independent.
    const DELAY_MS = 200;

    // Parent turn 1: spawn, then an interleaved sync tool, then spawn.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_a",
          type: "function",
          function: { name: "spawn_subagent", arguments: JSON.stringify({ name: "lane-a", prompt: "research lane A" }) }
        },
        {
          id: "call_time",
          type: "function",
          function: { name: "get_current_time", arguments: "{}" }
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "spawn_subagent", arguments: JSON.stringify({ name: "lane-b", prompt: "research lane B" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    // One delayed child turn per spawn (claimed in dispatch order; the
    // interleaved get_current_time is a sync tool and consumes no stub).
    setEchoToolCallingResponse(
      { provider, text: "lane done", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: DELAY_MS }
    );
    setEchoToolCallingResponse(
      { provider, text: "lane done", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: DELAY_MS }
    );
    // Parent turn 2: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Both lanes reported in.",
      toolCalls: [],
      finishReason: "stop"
    });

    const parent = await submitTask(config, "spawn, clock, spawn", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id, 8000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Both lanes reported in.");

    const state = readState(config.instance);
    const subs = state.subagents.filter((s) => s.parentTaskId === parent.id);
    expect(subs.length).toBe(2);
    expect(subs.every((s) => s.status === "completed")).toBe(true);

    const intervals = subs.map((s) => {
      expect(s.createdAt).toBeDefined();
      expect(s.completedAt).toBeDefined();
      return { start: Date.parse(s.createdAt), end: Date.parse(s.completedAt!) };
    });

    // Serial proof: the second spawn's child was created only after the first
    // child finished, so the lifetimes are disjoint.
    const latestStart = Math.max(...intervals.map((iv) => iv.start));
    const earliestEnd = Math.min(...intervals.map((iv) => iv.end));
    expect(latestStart).toBeGreaterThanOrEqual(earliestEnd);
  });

  test("nesting depth cap rejects spawning past depth 3", async () => {
    const config = buildConfig(workspaceRoot, "subagent-depth");

    // Synthesize a depth-3 ancestor chain in state directly (simpler than
    // running 4 nested chat loops). subagentDepth walks parentTaskId; tasks
    // must each carry a subagentId to count as a subagent ancestor.
    const built = await mutateState(config.instance, (state) => {
      const ids: string[] = [];
      let parentTaskId: string | undefined = undefined;
      for (let i = 0; i < 3; i += 1) {
        const subagentId = `sub_${i}`;
        const taskId = `task_${i}`;
        state.subagents.unshift({
          id: subagentId,
          instance: state.instance,
          name: `level-${i}`,
          prompt: "",
          status: "running",
          parentTaskId,
          taskId,
          toolsets: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          systemPrompt: ""
        });
        state.tasks.unshift({
          id: taskId,
          title: `level-${i}`,
          input: "",
          status: "running",
          instance: state.instance,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tracePath: "",
          auditIds: [],
          approvalIds: [],
          skillIds: [],
          parentTaskId,
          subagentId,
          mode: "chat"
        });
        ids.push(taskId);
        parentTaskId = taskId;
      }
      return { ids };
    });

    // The deepest existing task is at depth 3 (3 ancestors with subagentId).
    const state = readState(config.instance);
    const deepest = built.ids[built.ids.length - 1]!;
    expect(subagentDepth(state, deepest)).toBe(3);

    // Spawning from the deepest task should be rejected.
    let caught: Error | undefined;
    try {
      await spawnSubagent(config, {
        name: "too-deep",
        prompt: "shouldn't run",
        parentTaskId: deepest
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("max_subagent_depth_exceeded");
    // No new subagent record was created beyond the synthetic 3.
    const after = readState(config.instance);
    expect(after.subagents.length).toBe(3);
  });

  test("MAX_SUBAGENT_DEPTH constant is 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  test("cancelling the parent task cancels in-flight subagent descendants", async () => {
    const config = buildConfig(workspaceRoot, "subagent-cancel");
    const provider = normalizeProvider(config.provider);

    // Parent: spawn a subagent. Subagent then makes a tool call to file_write
    // which gates on approval — the subagent task pauses, we cancel the
    // parent, and the cascade should hit the child task.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({ name: "writer", prompt: "write a file" })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn 1: tries to write.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: {
            name: "file_write",
            arguments: JSON.stringify({ path: "out.txt", content: "ok" })
          }
        }
      ],
      finishReason: "tool_calls"
    });

    const parent = await submitTask(config, "delegate a write", { mode: "chat" });

    // Wait for the subagent task to pause on the file_write approval.
    const deadline = Date.now() + 8000;
    let pausedSubTaskId: string | undefined;
    while (Date.now() < deadline) {
      const state = readState(config.instance);
      const sub = state.subagents.find((s) => s.parentTaskId === parent.id);
      if (sub && sub.taskId) {
        const subTask = state.tasks.find((t) => t.id === sub.taskId);
        if (subTask?.status === "waiting_approval") {
          pausedSubTaskId = subTask.id;
          break;
        }
      }
      await Bun.sleep(20);
    }
    expect(pausedSubTaskId).toBeDefined();

    // Cancel the parent — should cascade to the child.
    await cancelTask(config, parent.id);

    // Wait for the cascade + the parent's chat-task loop to settle so
    // the test root isn't torn down with in-flight mutateState calls.
    const settleDeadline = Date.now() + 5000;
    while (Date.now() < settleDeadline) {
      const state = readState(config.instance);
      const childTask = state.tasks.find((t) => t.id === pausedSubTaskId);
      const parentTask = state.tasks.find((t) => t.id === parent.id);
      const parentSettled =
        parentTask?.status === "cancelled" ||
        parentTask?.status === "failed" ||
        parentTask?.status === "completed";
      if (childTask?.status === "cancelled" && parentSettled) {
        break;
      }
      await Bun.sleep(20);
    }

    const stateAfter = readState(config.instance);
    const child = stateAfter.tasks.find((t) => t.id === pausedSubTaskId);
    expect(child?.status).toBe("cancelled");
    const subRecord = stateAfter.subagents.find((s) => s.parentTaskId === parent.id);
    expect(subRecord?.status).toBe("cancelled");
  });

  test("a subagent's unanswerable ask_user bubbles up as status:needs_input (no timeout)", async () => {
    const config = buildConfig(workspaceRoot, "subagent-needs-input");
    const provider = normalizeProvider(config.provider);

    // Parent turn 1: spawn a subagent (with a short timeout so a regression to
    // the busy-poll-to-timeout path would be caught quickly by waitForTerminal,
    // not mask itself as a pass).
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({ name: "picker", prompt: "decide a thing", timeout_ms: 4000 })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn 1: it calls ask_user. The child task has no chat surface,
    // so the surface guard returns the structured needs_input marker as the
    // tool result instead of parking on waiting_approval.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_ask",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({
              question: "Which option do you want?",
              options: [{ label: "A" }, { label: "B" }]
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn 2: having seen the marker, it just finishes (its own loop
    // produces a final answer and the child task completes — terminal).
    setEchoToolCallingResponse({
      provider,
      text: "I need to know which option.",
      toolCalls: [],
      finishReason: "stop"
    });
    // Parent turn 2: final answer (consumed after the subagent terminates).
    setEchoToolCallingResponse({
      provider,
      text: "Relaying the subagent's question.",
      toolCalls: [],
      finishReason: "stop"
    });

    const parent = await submitTask(config, "delegate a decision", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id, 8000);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    const sub = state.subagents.find((s) => s.parentTaskId === parent.id);
    expect(sub).toBeDefined();
    // The record mirrors the bubbled-up question WITH the option labels, so
    // the parent can re-ask with the same choices.
    expect(sub!.resultNeedsInput).toEqual({ question: "Which option do you want?", options: ["A", "B"] });
    // The child task is terminal (completed) — NOT stranded in waiting_approval,
    // and NOT timed out.
    const childTask = state.tasks.find((t) => t.id === sub!.taskId);
    expect(childTask?.status).toBe("completed");
    expect(childTask?.needsInput).toEqual({ question: "Which option do you want?", options: ["A", "B"] });

    // The parent's spawn_subagent tool result is a parseable JSON string
    // carrying status:"needs_input" + the question and options, so the
    // parent model can re-ask via its own ask_user with the same choices.
    const calls = getEchoToolCallingCalls();
    const parentTurn2 = calls[calls.length - 1]!;
    const toolMsg = parentTurn2.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("\"status\":\"needs_input\"")
    );
    expect(toolMsg).toBeDefined();
    const payload = JSON.parse(String(toolMsg!.content));
    expect(payload.status).toBe("needs_input");
    expect(payload.needsInput).toEqual({ question: "Which option do you want?", options: ["A", "B"] });
  });

  test("goal and context render as labeled sections in the subagent system prompt", async () => {
    const config = buildConfig(workspaceRoot, "subagent-goal-context");
    const provider = normalizeProvider(config.provider);

    // Parent turn 1: spawn with goal + context framing fields.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({
              name: "framed",
              prompt: "do the framed work",
              goal: "Ship the report",
              context: "The deadline is Friday and the data is in /tmp/data."
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn: answers directly.
    setEchoToolCallingResponse({ provider, text: "framed done", toolCalls: [], finishReason: "stop" });
    // Parent turn 2: final answer.
    setEchoToolCallingResponse({ provider, text: "All set.", toolCalls: [], finishReason: "stop" });

    const parent = await submitTask(config, "delegate with framing", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    const sub = state.subagents.find((s) => s.parentTaskId === parent.id)!;
    expect(sub.goal).toBe("Ship the report");
    expect(sub.context).toBe("The deadline is Friday and the data is in /tmp/data.");

    // The subagent's system message (first message of its model call) carries
    // the labeled Goal/Context sections ahead of the prompt.
    const calls = getEchoToolCallingCalls();
    const subagentCall = calls.find((messages) => {
      const system = messages.find((m) => m.role === "system");
      return typeof system?.content === "string" && system.content.includes("## Goal\nShip the report");
    });
    expect(subagentCall).toBeDefined();
    const system = subagentCall!.find((m) => m.role === "system")!;
    const systemText = String(system.content);
    expect(systemText).toContain("## Goal\nShip the report");
    expect(systemText).toContain("## Context\nThe deadline is Friday and the data is in /tmp/data.");
  });
});
