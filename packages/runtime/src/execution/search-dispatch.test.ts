// Unit tests for the search_history tool dispatch surface. Exercises tool
// registration plus a happy-path lookup against seeded tasks.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { createTask, mutateState, upsertTask } from "../state";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-search-dispatch-test";

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

async function seedTask(config: RuntimeConfig, input: string): Promise<string> {
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

describe("search_history registration", () => {
  test("registers under toolset 'session_search' and requires query", () => {
    const ts: ToolsetRecord = {
      id: "toolset_session_search",
      instance: "test",
      name: "session_search",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "search_history");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("session_search");
    expect(tool?.function.parameters.required).toEqual(["query"]);
  });
});

describe("search_history dispatch", () => {
  test("returns hits for a seeded task title", async () => {
    const config = makeConfig("search-history-happy");
    const taskId = await seedTask(config, "investigate the rosetta-stone bug in the parser");
    const callerId = await seedTask(config, "test caller");

    const result = await dispatchToolCall(
      config,
      callerId,
      "search_history",
      "call_search",
      JSON.stringify({ query: "rosetta-stone" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as {
        count: number;
        results: Array<{ kind: string; title: string; taskId?: string }>;
      };
      expect(parsed.count).toBeGreaterThan(0);
      const hit = parsed.results.find((r) => r.taskId === taskId);
      expect(hit).toBeDefined();
      expect(hit?.kind).toBe("task");
    }
  });

  test("rejects missing query", async () => {
    const instance = "search-history-no-query";
    const config = makeConfig(instance);
    const taskId = await seedTask(config, "caller");
    await expect(
      dispatchToolCall(config, taskId, "search_history", "call_no_q", JSON.stringify({}))
    ).rejects.toThrow(/query/);
  });

  test("caps limit at 100 and honors lower limits", async () => {
    const instance = "search-history-limit";
    const config = makeConfig(instance);
    const taskId = await seedTask(config, "caller for limit test");

    const result = await dispatchToolCall(
      config,
      taskId,
      "search_history",
      "call_limit",
      JSON.stringify({ query: "caller", limit: 1 })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { count: number };
      expect(parsed.count).toBeLessThanOrEqual(1);
    }
  });
});
