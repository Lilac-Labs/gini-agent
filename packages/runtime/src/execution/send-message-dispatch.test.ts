// Tests for the send_message dispatch surface. Exercises tool
// registration, the approval-gate path under approvalMode=strict (where
// the dispatch returns a pending approval), and the validation errors
// for missing/invalid bridgeId / text.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { createTask, mutateState, readState, upsertTask } from "../state";
import { addMessagingBridge, resetMessagingDeps } from "../integrations/messaging";
import { riskForTool } from "./tool-risk";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-send-message-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  resetMessagingDeps();
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string, approvalMode: "strict" | "auto" = "strict"): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`,
    approvalMode
  };
}

async function seedTask(config: RuntimeConfig): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, "test");
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

describe("send_message registration", () => {
  test("registers under toolset 'messaging' and requires bridgeId+text", () => {
    const ts: ToolsetRecord = {
      id: "toolset_messaging",
      instance: "test",
      name: "messaging",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "send_message");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("messaging");
    expect(tool?.function.parameters.required).toEqual(["bridgeId", "text"]);
  });

  test("send_message is classified high-risk via the substring heuristic", () => {
    expect(riskForTool("send_message")).toBe("high");
  });
});

describe("send_message dispatch", () => {
  test("creates a pending approval in strict mode", async () => {
    const config = makeConfig("send-message-strict", "strict");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "demo",
      deliveryTargets: ["chat_a"]
    });
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "send_message",
      "call_send_strict",
      JSON.stringify({ bridgeId: bridge.id, text: "ping", target: "chat_a" })
    );
    expect(result.kind).toBe("pending");

    const approvals = readState(config.instance).authorizations;
    const pending = approvals.find((a) => a.action === "messaging.send" && a.status === "pending");
    expect(pending).toBeDefined();
    expect(pending?.target).toBe(bridge.id);
    expect(pending?.payload.text).toBe("ping");
    expect(pending?.payload.target).toBe("chat_a");
    expect(pending?.payload.toolCallId).toBe("call_send_strict");
  });

  test("rejects missing bridgeId", async () => {
    const config = makeConfig("send-message-no-bridge", "strict");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "send_message", "call_no_b", JSON.stringify({ text: "x" }))
    ).rejects.toThrow(/bridgeId/);
  });

  test("rejects missing text", async () => {
    const config = makeConfig("send-message-no-text", "strict");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "demo",
      deliveryTargets: ["chat_a"]
    });
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "send_message",
        "call_no_t",
        JSON.stringify({ bridgeId: bridge.id })
      )
    ).rejects.toThrow(/text/);
  });

  test("rejects unknown bridge", async () => {
    const config = makeConfig("send-message-bad-bridge", "strict");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "send_message",
        "call_bad_b",
        JSON.stringify({ bridgeId: "msg_nope", text: "hi" })
      )
    ).rejects.toThrow(/Messaging bridge not found/);
  });

  test("refuses target that's not on the bridge's allow-list", async () => {
    // Pin the catalog promise: the description tells the model `target`
    // must come from the bridge's allow-list. Without this gate the
    // request would create an approval row that fails post-approval,
    // which is a worse failure mode than rejecting at tool-call time.
    const config = makeConfig("send-message-bad-target", "strict");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "demo",
      deliveryTargets: ["chat-A"]
    });
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "send_message",
        "call_bad_t",
        JSON.stringify({ bridgeId: bridge.id, text: "ping", target: "chat-B" })
      )
    ).rejects.toThrow(/allow-list/);
    // No approval row should land for a refused target.
    const approvals = readState(config.instance).authorizations;
    const created = approvals.filter((a) => a.action === "messaging.send");
    expect(created.length).toBe(0);
  });
});
