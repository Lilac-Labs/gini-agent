// Unit tests for the memory-tool dispatch surface:
//   - `recall_memory` (read-only on-demand recall against Hindsight)
//
// Pinned-memory CRUD tools (`add_memory` / `update_memory`) were removed
// alongside the `state.memories` consolidation — USER.md / SOUL.md /
// Hindsight are now the three memory surfaces. See ADR
// runtime-identity-files.md.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import {
  bankIdForAgent,
  closeAllMemoryDbs,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  createTask,
  mutateState,
  readState,
  upsertTask
} from "../state";
import { echoEmbed } from "../embeddings";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-memory-dispatch-test";
const TEST_AGENT = "agent_test";
const TEST_BANK = bankIdForAgent(TEST_AGENT);

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  process.env.GINI_RERANKER_PROVIDER = "none";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
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

// Seed an active agent so resolveEffectiveContext returns one — recall
// refuses to run when no agent is active.
async function seedAgent(config: RuntimeConfig): Promise<void> {
  await mutateState(config.instance, (state) => {
    if (!state.agents.find((a) => a.id === TEST_AGENT)) {
      state.agents.push({
        id: TEST_AGENT,
        instance: state.instance,
        name: "test",
        providerName: "echo",
        model: "gini-echo-v0",
        toolsets: [],
        messagingTargets: [],
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    }
    state.activeAgentId = TEST_AGENT;
  });
}

async function seedTask(config: RuntimeConfig): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined, TEST_AGENT);
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

describe("memory tool registration", () => {
  test("recall_memory registers with toolset 'memory' and requires query", () => {
    const ts: ToolsetRecord = {
      id: "toolset_memory",
      instance: "test",
      name: "memory",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "recall_memory");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("memory");
    expect(tool?.function.parameters.required).toEqual(["query"]);
  });

  test("add_memory and update_memory are NOT in the catalog (dropped surfaces)", () => {
    const ts: ToolsetRecord = {
      id: "toolset_memory",
      instance: "test",
      name: "memory",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const names = catalog.map((t) => t.function.name);
    expect(names).not.toContain("add_memory");
    expect(names).not.toContain("update_memory");
  });
});

describe("recall_memory dispatch", () => {
  test("returns a compact JSON summary with seeded units", async () => {
    const instance = "memory-recall-happy";
    const config = makeConfig(instance);
    await seedAgent(config);
    ensureDefaultBank(instance);
    ensureAgentBank(instance, TEST_AGENT);
    const target = insertMemoryUnit(instance, {
      bankId: TEST_BANK,
      agentId: TEST_AGENT,
      text: "alpha bravo charlie delta echo",
      embedding: echoEmbed("alpha bravo charlie delta echo"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "recall_memory",
      "call_recall",
      JSON.stringify({ query: "alpha bravo charlie delta echo" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as {
        units: number;
        totalTokens: number;
        excerpts: Array<{ id: string; content: string; score: number }>;
      };
      expect(parsed.units).toBeGreaterThan(0);
      const excerpt = parsed.excerpts.find((e) => e.id === target.id);
      expect(excerpt).toBeDefined();
    }

    // Audit row pinned to the recall.
    const audit = readState(instance).audit.find((event) => event.action === "memory.recalled");
    expect(audit).toBeDefined();
  });

  test("rejects empty query", async () => {
    const instance = "memory-recall-empty";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "recall_memory", "call_recall_empty", JSON.stringify({}))
    ).rejects.toThrow(/query/);
  });

  test("add_memory dispatch is rejected as unknown tool", async () => {
    const instance = "memory-add-removed";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "add_memory",
        "call_add",
        JSON.stringify({ content: "removed" })
      )
    ).rejects.toThrow(/Unknown tool/);
  });

  test("update_memory dispatch is rejected as unknown tool", async () => {
    const instance = "memory-update-removed";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_memory",
        "call_update",
        JSON.stringify({ memoryId: "mem_x", content: "removed" })
      )
    ).rejects.toThrow(/Unknown tool/);
  });
});
