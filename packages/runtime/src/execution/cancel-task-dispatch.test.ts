// Tests for the cancel_task dispatch surface. Exercises tool
// registration, the self-cancel guard (lock-free + serialized in-lock),
// cancellation of a sibling task, and the error paths (unknown taskId,
// already-terminal target).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { cancelTask } from "../agent";
import { createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-cancel-task-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

async function seedTask(config: RuntimeConfig, input = "test"): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, input);
    upsertTask(state, task);
    return task.id;
  });
}

function stateWithToolsets(toolsets: ToolsetRecord[]): RuntimeState {
  return {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
    connectors: [], improvements: [], skillOutcomes: [], learningFindings: [],
    promotions: [], snapshots: [], tools: [], toolsets, subagents: [],
    mcpServers: [], messagingBridges: [], importReports: [], agents: [],
    activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
    jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
    runs: [], planSteps: [], usageLedger: []
  };
}

describe("cancel_task registration", () => {
  test("registers under toolset 'subagents' and requires taskId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_delegation",
      instance: "test",
      name: "subagents",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "cancel_task");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("subagents");
    expect(tool?.function.parameters.required).toEqual(["taskId"]);
  });
});

describe("cancel_task dispatch", () => {
  test("refuses to cancel the current task (self-cancel guard)", async () => {
    const config = makeConfig("cancel-task-self");
    const taskId = await seedTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "cancel_task",
      "call_self",
      JSON.stringify({ taskId })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/cannot cancel the current task/);
    }
    // The task itself should still be queued (not cancelled).
    const tasks = readState(config.instance).tasks;
    expect(tasks.find((t) => t.id === taskId)?.status).toBe("queued");
  });

  test("cancels a sibling task and emits task.cancel.requested audit", async () => {
    const config = makeConfig("cancel-task-sibling");
    const callerId = await seedTask(config, "caller");
    const targetId = await seedTask(config, "target");

    const result = await dispatchToolCall(
      config,
      callerId,
      "cancel_task",
      "call_sibling",
      JSON.stringify({ taskId: targetId })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Cancelled task/);
      expect(result.result).toContain(targetId);
    }

    const target = readState(config.instance).tasks.find((t) => t.id === targetId);
    expect(target?.status).toBe("cancelled");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "task.cancel.requested" && event.actor === "agent" && event.target === targetId
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.targetTaskId).toBe(targetId);
  });

  test("surfaces unknown taskId as an error", async () => {
    const config = makeConfig("cancel-task-unknown");
    const callerId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        callerId,
        "cancel_task",
        "call_unknown",
        JSON.stringify({ taskId: "task_nope" })
      )
    ).rejects.toThrow(/Task not found/);
  });

  test("returns a no-op message for already-terminal targets", async () => {
    const config = makeConfig("cancel-task-terminal");
    const callerId = await seedTask(config);
    const terminalId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "already done");
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      callerId,
      "cancel_task",
      "call_term",
      JSON.stringify({ taskId: terminalId })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/already completed/);
    }
  });

  test("rejects missing taskId", async () => {
    const config = makeConfig("cancel-task-no-id");
    const callerId = await seedTask(config);
    await expect(
      dispatchToolCall(config, callerId, "cancel_task", "call_no_id", JSON.stringify({}))
    ).rejects.toThrow(/taskId/);
  });

  test("serialized in-lock self-cancel guard refuses when caller===target", async () => {
    // The lock-free pre-check inside cancelTaskTool is the fast path —
    // this exercises the authoritative serialized guard inside
    // cancelTask's mutateState callback by invoking cancelTask directly
    // with parentTaskId === taskId. A request that races past the
    // lock-free pre-check (or any other caller that supplies its own
    // parentTaskId) is still refused before any state change lands.
    const config = makeConfig("cancel-task-serialized");
    const taskId = await seedTask(config);
    await expect(cancelTask(config, taskId, { parentTaskId: taskId })).rejects.toThrow(
      /cannot cancel the current task/i
    );
    // Task should still be queued — guard fired before any mutation.
    const tasks = readState(config.instance).tasks;
    expect(tasks.find((t) => t.id === taskId)?.status).toBe("queued");
  });
});
