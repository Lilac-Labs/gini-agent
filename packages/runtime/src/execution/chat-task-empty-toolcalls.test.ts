// OPE-66: the agentic loop must not treat a finishReason of "tool_calls" with
// an EMPTY toolCalls array as a clean "model chose to stop". That shape means a
// tool call the model asked for was dropped by the provider parser (a truncated
// id/name delta). The loop re-issues the model call a bounded number of times so
// a transient parse gap self-heals instead of silently completing the turn
// mid-task; after the budget is spent it falls through to a (traced) finish.
//
// Harness mirrors chat-task.part1.test.ts: the echo provider makes the loop
// deterministic, HOME is a mkdtemp dir so the machine-global Google registry
// can't leak into the system prompt, and each test uses a unique instance.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { submitTask } from "../agent";
import { readState } from "../state";
import type { RuntimeConfig, Task } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
let prevState: string | undefined;
let prevLog: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-emptytc-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  root = mkdtempSync(join(tmpdir(), "gini-emptytc-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  clearEchoToolCallingResponses();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-logs`, { recursive: true, force: true });
  clearEchoToolCallingResponses();
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7349,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "auto"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(2);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("chat-task empty-toolCalls reconciliation (OPE-66)", () => {
  test("re-issues a dropped tool call, then completes on a clean stop", async () => {
    const config = buildConfig("emptytc-recover");
    const provider = normalizeProvider(config.provider);

    // First turn: the provider reports it wanted a tool call, but none parsed —
    // the dropped-tool-call anomaly. The loop must NOT complete here.
    setEchoToolCallingResponse({ provider, text: "", toolCalls: [], finishReason: "tool_calls" });
    // Retry turn: a genuine stop with an answer. The loop completes normally.
    setEchoToolCallingResponse({ provider, text: "Recovered.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "work the list", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered.");
    // Two model calls prove the anomaly was re-issued rather than completed.
    expect(getEchoToolCallingCalls().length).toBe(2);
  });

  test("gives up after the retry budget and completes rather than spinning", async () => {
    const config = buildConfig("emptytc-exhaust");
    const provider = normalizeProvider(config.provider);

    // Four consecutive anomalies: three are re-issued (attempts 1-3), then the
    // fourth exceeds the budget and falls through to a normal completion.
    for (let i = 0; i < 4; i += 1) {
      setEchoToolCallingResponse({ provider, text: "", toolCalls: [], finishReason: "tool_calls" });
    }

    const task = await submitTask(config, "work the list", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    // Exactly four calls: three bounded retries plus the budget-exhausted finish.
    expect(getEchoToolCallingCalls().length).toBe(4);
  });
});
