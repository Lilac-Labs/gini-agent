// End-to-end tests for the chat-task agent loop.
//
// We use the echo provider with stubbed tool-calling responses so the loop
// is fully deterministic. The test covers:
//   - one tool call → result fed back → final answer
//   - approval-gated tool call → task pauses with toolCallState
//   - resume after approval → task completes
//
// HOME is pointed at a unique mkdtemp dir per test (same pattern as
// src/state/google-accounts.test.ts): the loop reads the machine-global
// Google account registry (buildConnectedAccountsBlock(readGoogleAccounts())
// in the system prompt; isSkillActive via credentialExternallySatisfied), so
// a developer machine with registered accounts would otherwise shift the
// system-prompt size and skill activity these tests depend on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoAuxTextResponses,
  clearEchoToolCallingResponses,
  getEchoAuxTextRequests,
  getEchoToolCallingCalls,
  getEchoToolCallingToolNames,
  setEchoAuxTextFailure,
  setEchoAuxTextResponse,
  setEchoToolCallingFailure,
  setEchoToolCallingResponse,
  normalizeProvider,
  type MessageContentPart,
  type ToolCallingMessage
} from "../provider";
import { submitTask, decideApproval, resolveSetupRequest } from "../agent";
import {
  bankIdForAgent,
  createChatMessage,
  createChatSession,
  createEmptyState,
  createRun,
  createSubagentRecord,
  deleteChatSession,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  listChatBlocks,
  mutateState,
  now,
  readState,
  recordProviderAuthFailure
} from "../state";
import { echoEmbed } from "../embeddings";
import { storeUpload } from "../state/uploads";
import { resolveDefaultPriorContextTokenBudget } from "../provider-capabilities";
import type { AgentIdentity, GoogleAccount, JobRecord, RuntimeConfig, RuntimeState, SkillRecord, Task, ToolsetRecord } from "../types";
import { createSkillFromInput, setSkillStatus } from "../capabilities/skills";
import {
  __setBaseToolCatalogForTests,
  buildAgentIdentity,
  buildConnectedAccountsBlock,
  buildEnabledSkillsBlock,
  buildInactiveSkillsBlock,
  buildMcpServersBlock,
  buildSkillScriptsBlock,
  compactionMiddleSpan,
  elideOldToolResultsToBudget,
  IN_TURN_COMPACTION_NOTE_PREFIX,
  initialNavStallState,
  nextNavStallState,
  promptTokensFromUsage,
  renderMessagesForCompaction
} from "./chat-task";
import type { ToolCatalogTool } from "./tool-catalog";
import type { EffectiveContext } from "./effective-context";
import { __resetDefaultGiniInstructionsCacheForTest } from "../system-prompt";

// Compaction geometry in this file is calibrated against a FIXED instructions
// size (alongside the pinned tool catalog). The real default INSTRUCTIONS.md
// changes over time, which would otherwise shift the system-prompt slice and
// move the compaction crossing point opaquely. Pin a frozen fixture (byte-for-
// byte the default as of this calibration) so edits to the shipped default
// never perturb these tests.
const COMPACTION_INSTRUCTIONS_FIXTURE = join(
  import.meta.dir,
  "..",
  "runtime",
  "__fixtures__",
  "instructions-compaction-geometry.md"
);

// These tests submit on idle sessions, which always run immediately. They also
// don't seed a "chat-route" stub, so the router coerces to a chat-direct
// decision and the turn runs in the submitted session. Narrow the submit union
// to the chat-direct run-now branch so the existing `.taskId` reads stay typed
// (a queued or topic-dispatched result here is a test-setup bug). See ADR
// chat-message-queue.md.
async function submitChatMessage(
  config: RuntimeConfig,
  sessionId: string,
  input: Record<string, unknown>
): Promise<{ sessionId: string; runId?: string; taskId: string; status: Task["status"] }> {
  const { submitChatMessage: submitChatMessageRaw } = await import("./chat");
  const { settleSubmittedChatMessage } = await import("./chat-test-support");
  const result = await submitChatMessageRaw(config, sessionId, input);
  const settled = await settleSubmittedChatMessage(
    config,
    sessionId,
    result,
    String(input.content ?? "")
  );
  if ("queued" in settled) throw new Error("expected run-now submission, got queued");
  if ("topicId" in settled) throw new Error("expected chat-direct submission, got topic dispatch");
  return settled;
}

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-chat-task-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  // Pin embeddings to echo: the local provider is unavailable under bun
  // test, and the fallback chain otherwise picks the openai provider on
  // machines with ~/.codex/auth.json (resolved via os.homedir(), which
  // ignores the HOME override above) — turning every memory embed in the
  // loop into a real network call.
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  // Pin instructions to the frozen geometry fixture so the compaction tests'
  // system-prompt slice is independent of edits to the shipped default.
  __resetDefaultGiniInstructionsCacheForTest(COMPACTION_INSTRUCTIONS_FIXTURE);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  __resetDefaultGiniInstructionsCacheForTest();
  rmSync(scratchHome, { recursive: true, force: true });
});

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-task-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-task-test-logs",
    // These tests predate the approvalMode flip and pin the
    // approval-gated loop behavior. Force "strict" so the chat-task
    // loop continues to exercise the pause+resume path here; the new
    // default-auto matrix lives in approval-mode.test.ts.
    approvalMode: "strict",
    ...opts
  };
}

// Seed an enabled skill with an arbitrary (large) body. read_skill returns
// the body verbatim, which makes it the simplest way to drive big tool
// results through the loop without touching the filesystem caps.
async function seedBulkSkill(config: RuntimeConfig, name: string, body: string): Promise<void> {
  const skill = await createSkillFromInput(config, { name, description: `Bulk ${name}` });
  await mutateState(config.instance, (state) => {
    const item = state.skills.find((s) => s.id === skill.id)!;
    item.body = body;
  });
  await setSkillStatus(config, skill.id, "enabled");
}

// Fixed, test-owned tool catalog for the in-turn-compaction geometry tests.
// Those tests size skill bodies against the always-on `toolSchemaTokens`
// floor; growing any always-on tool description (as create_job's did) would
// otherwise shift that floor and move the compaction crossing point opaquely.
// Installing this constant via __setBaseToolCatalogForTests pins the floor so
// no live-catalog change can perturb the geometry.
//
// Shape: `read_skill` (the only tool the compaction scripts dispatch — the
// loop must run to completion with it) plus uniform filler tools whose count
// is chosen so the serialized provider catalog tokenizes to a known floor.
// Measured floor: toolSchemaTokens = ceil(JSON.stringify(toProviderTools)/4)
// = 12,207 tokens (read_skill ≈ 90 tokens + 47 filler tools ≈ 258 tokens
// each). The high-water mark is floor(32,000 × 0.85) = 27,200 under the echo
// provider (no usage → promptTokenEstimateGap 0), so the message budget
// before the mark is 27,200 − 12,207 ≈ 14,993 tokens. Each in-turn exchange
// is one ~8,600-char read_skill result (≈ 2,150 tokens) plus its assistant
// tool_call row; with the protected head + system prompt, six accumulated
// results cross the mark before the 7th call. The filler count is the ONE
// knob that sets the floor; bodies below are derived from it.
const FIXED_COMPACTION_CATALOG_FILLER = 47;
const FIXED_COMPACTION_CATALOG: ToolCatalogTool[] = [
  {
    toolset: "skills",
    type: "function",
    function: {
      name: "read_skill",
      description: "Return the full body of an enabled skill by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name." } },
        required: ["name"]
      }
    }
  },
  ...Array.from({ length: FIXED_COMPACTION_CATALOG_FILLER }, (_unused, i) => ({
    toolset: "core",
    type: "function" as const,
    function: {
      name: `fixed_floor_tool_${i}`,
      description: "X".repeat(900),
      parameters: { type: "object", properties: {}, required: [] as string[] }
    }
  }))
];

// Poll cadence for the terminal-state waiters. The task settles on a detached
// microtask/timer, so the wait resolves at the NEXT poll after it lands — a
// tight interval keeps the wall-clock cost near the real settle time instead of
// rounding every wait up to a coarse tick. Kept as a named constant so the
// cadence is tunable in one place (and small enough that 100+ sequential waits
// don't dominate the suite).
const TERMINAL_POLL_MS = 2;

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval" || task.status === "needs_input")) {
      return task;
    }
    await Bun.sleep(TERMINAL_POLL_MS);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

// Post-approve wait: decideApproval("approve") returns once the decision is
// durable while the side effect + resume run detached, so the task is still
// parked at waiting_approval when the call returns — waitForTerminal's
// parked-inclusive accept set would return the pre-approve park immediately.
// Poll for a genuinely final status instead.
async function waitForFinalTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(TERMINAL_POLL_MS);
  }
  throw new Error(`Task ${taskId} did not reach a final terminal state within ${timeoutMs}ms`);
}

describe("chat-task loop", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let prevTransientBackoff: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-task-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    prevTransientBackoff = process.env.GINI_TRANSIENT_RETRY_BASE_MS;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    // Run the transient-retry backoff at 0ms so these tests never burn real
    // wall-clock sleep (the production curve is verified separately by the
    // trace-message assertions); keeps the suite fast and deterministic.
    process.env.GINI_TRANSIENT_RETRY_BASE_MS = "0";
    clearEchoToolCallingResponses();
    clearEchoAuxTextResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevTransientBackoff === undefined) delete process.env.GINI_TRANSIENT_RETRY_BASE_MS;
    else process.env.GINI_TRANSIENT_RETRY_BASE_MS = prevTransientBackoff;
    // Clear any fixed-catalog override a compaction test installed so the
    // rest of the suite sees the live buildToolCatalog.
    __setBaseToolCatalogForTests(null);
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoAuxTextResponses();
  });

  test("falls back to a final answer when the model emits no tool calls", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-direct");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Sure, here's a direct answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Sure, here's a direct answer.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("resumeChatTask is a no-op for a task that has already failed", async () => {
    // Standalone test of resumeChatTask's terminal-task guard. We construct
    // a task in the failed state and call resumeChatTask directly; it must
    // return without flipping the task back to running and without
    // re-entering the loop.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-resume-failed");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_x", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "x.txt", content: "X" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write x", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    const approvalId = paused.approvalIds[0]!;

    // Deny — fails the task and clears the snapshot. Deny resumes detached, so
    // poll for the failed state instead of a fixed sleep.
    await decideApproval(config, approvalId, "deny");
    const failedBefore = await waitForFinalTerminal(config, task.id);
    expect(failedBefore.status).toBe("failed");

    // Now call resumeChatTask directly. Must no-op.
    const { resumeChatTask } = await import("../execution/chat-task");
    const result = await resumeChatTask(config, task.id, "call_x", "should-not-resume");
    expect(result.status).toBe("failed");

    // Status / partialSummary unchanged after the no-op resume.
    const after = readState(config.instance).tasks.find((t) => t.id === task.id)!;
    expect(after.status).toBe("failed");
    expect(after.toolCallState).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "x.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec falls through to the approval gate when no allowlist pattern matches", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-auto-approve-miss");
    config.autoApproveCommands = ["memo *"];
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_miss", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "rm -rf /tmp/x" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "rm something", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvalIds.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("an auth failure on the iteration-cap summary call persists the needs-reauth record", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    writeFileSync(join(workspaceRoot, "hello0.md"), "Hello (0)");
    writeFileSync(join(workspaceRoot, "hello1.md"), "Hello (1)");
    // The summary-failure path settles the task itself (it does not route
    // through failTask), so it must write the persistent record on its own.
    // Drive it with a REAL provider transport (openai + stubbed fetch): two
    // streamed tool-call turns reach the cap, then the tool-less summary call
    // gets a 401 whose body names a key fragment that must be redacted.
    const config = buildConfig(workspaceRoot, "chat-task-reauth-summary", {
      provider: { name: "openai", model: "gpt-test" },
      agent: { maxIterations: 2 }
    });

    const prevKey = process.env.OPENAI_API_KEY;
    const prevEmbed = process.env.GINI_EMBEDDING_PROVIDER;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "sk-test-summary";
    // Pin embeddings to the in-process echo provider so memory recall never
    // routes through the stubbed fetch.
    process.env.GINI_EMBEDDING_PROVIDER = "echo";

    const sseToolCall = (i: number): Response => {
      const events = [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_s${i}`, type: "function", function: { name: "file_read", arguments: "" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: `hello${i}.md` }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    let calls = 0;
    globalThis.fetch = ((() => {
      calls += 1;
      if (calls <= 2) return Promise.resolve(sseToolCall(calls - 1));
      // The tool-less summary call is non-streaming; reject it like a dead
      // credential would.
      return Promise.resolve(new Response(
        JSON.stringify({ error: { message: "Incorrect API key provided: sk-livefail123456" } }),
        { status: 401, headers: { "content-type": "application/json" } }
      ));
    }) as unknown) as typeof fetch;

    try {
      const task = await submitTask(config, "loop forever", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id, 10000);

      expect(finished.status).toBe("failed");
      expect(finished.authErrorProvider).toBe("openai");
      expect(finished.error).toBe("Incorrect API key provided: sk-***");

      const state = readState(config.instance);
      expect(state.providerAuthFailures?.openai).toMatchObject({
        provider: "openai",
        detail: "Incorrect API key provided: sk-***",
        taskId: task.id
      });
      // The raw key fragment never lands in state.json.
      expect(JSON.stringify(state.providerAuthFailures)).not.toContain("sk-livefail123456");
      expect(
        state.audit.find((a) => a.action === "provider.auth.needs_reauth" && a.target === "openai")
      ).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevEmbed === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
      else process.env.GINI_EMBEDDING_PROVIDER = prevEmbed;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  // Loop-breaker (identical-repeat). A model that emits the IDENTICAL tool
  // call and gets the IDENTICAL result several iterations in a row is stuck;
  // the loop must stop at MAX_IDENTICAL_TOOL_REPEATS (3) — well before the
  // iteration cap — and route to the same graceful tool-less summary exit.
  // We drive a cold browser_connect (no page open → deterministic ok:false
  // guard refusal every turn) to reproduce the real stuck-loop scenario.
  test("invalid agent.maxIterations falls back to the default and emits a warning trace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-invalid");
    // Invalid: 0 is non-positive. Loose-typed cast so the test can simulate
    // a config.json that was hand-edited with a bad value.
    (config as unknown as { agent: { maxIterations: number } }).agent = { maxIterations: 0 };
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Direct answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say something", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Direct answer.");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.defaultCap).toBe(200);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("non-numeric agent.maxIterations also falls back with a warning", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-invalid-string");
    (config as unknown as { agent: { maxIterations: string } }).agent = { maxIterations: "abc" };
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Hello.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hi again", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Bound-jobs system block: when the chat session backing the current task
  // has one or more JobRecords whose `chatSessionId` matches, the chat-task
  // loop must surface them in the system prompt. The model uses that block
  // to short-circuit list_jobs and call update_job / delete_job directly.
  test("does NOT suppress when the final text merely contains [SILENT]", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-contains");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Inbox triage");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Watcher turn",
        input: "kick off",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "[SILENT] but here's an update",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    const assistantText = blocks.filter((b) => b.kind === "assistant_text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0]).toMatchObject({ text: "[SILENT] but here's an update" });

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("derives the surface line from a bridge session without a client field", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-surface-bridge");
    const provider = normalizeProvider(config.provider);
    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Telegram probe", {
        kind: "telegram",
        bridgeId: "bridge_1",
        chatId: 42,
        target: "42"
      });
      return session.id;
    });

    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });
    const submitted = await submitChatMessage(config, sessionId, { content: "bridge turn" });
    expect((await waitForTerminal(config, submitted.taskId)).status).toBe("completed");

    const turn = getEchoToolCallingCalls()[0]!;
    const userIdx = turn.findIndex((m) => m.role === "user" && m.content === "bridge turn");
    expect(userIdx).toBeGreaterThan(0);
    const tail = String(turn[userIdx - 1]!.content ?? "");
    expect(tail).toContain("The user is messaging from Telegram");
    expect(tail).toContain("a browser handoff can't reach them");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("delivers emitted identity then recalled memory in a role:user tail before the user message", async () => {
    // Both per-turn blocks must still reach the model: the emitted identity
    // (turn 1 of a session) and the recalled-memory block, in that order,
    // inside a single role:"user" message placed immediately before the real
    // user message. Recall is driven through the real pipeline with the echo
    // embedder and the reranker pinned to `none` so it returns the seeded
    // unit deterministically and offline.
    const prevEmbed = process.env.GINI_EMBEDDING_PROVIDER;
    const prevReranker = process.env.GINI_RERANKER_PROVIDER;
    process.env.GINI_EMBEDDING_PROVIDER = "echo";
    process.env.GINI_RERANKER_PROVIDER = "none";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-tail-delivery");
    const provider = normalizeProvider(config.provider);
    const MEMORY_TEXT = "the user keeps bees on a rooftop in Lisbon";

    try {
      // Active agent so resolveEffectiveContext yields a memory namespace and
      // recall runs; seed one matching unit into that agent's bank.
      const agentId = "agent_tail";
      const sessionId = await mutateState(config.instance, (state) => {
        state.agents.push({
          id: agentId,
          instance: state.instance,
          name: "tail",
          providerName: "echo",
          model: "gini-echo-v0",
          toolsets: [],
          messagingTargets: [],
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        });
        state.activeAgentId = agentId;
        const session = createChatSession(state, "Tail delivery");
        return session.id;
      });
      ensureDefaultBank(config.instance);
      ensureAgentBank(config.instance, agentId);
      insertMemoryUnit(config.instance, {
        bankId: bankIdForAgent(agentId),
        agentId,
        text: MEMORY_TEXT,
        embedding: echoEmbed(MEMORY_TEXT),
        embeddingModel: "echo-embed-v0",
        network: "world"
      });

      const runId = await mutateState(config.instance, (state) => {
        const run = createRun(state, {
          kind: "conversation_turn",
          title: "Tail turn",
          input: "intro",
          conversationId: sessionId
        });
        return run.id;
      });

      setEchoToolCallingResponse({ provider, text: "Noted.", toolCalls: [], finishReason: "stop" });
      const task = await submitTask(config, MEMORY_TEXT, { mode: "chat", runId });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const calls = getEchoToolCallingCalls();
      expect(calls.length).toBeGreaterThan(0);
      const turn = calls[0]!;
      // The stable system prefix carries neither block anymore.
      const systemContent = String(turn.find((m) => m.role === "system")?.content ?? "");
      expect(systemContent).not.toContain("Your runtime identity:");
      expect(systemContent).not.toContain("Long-term memory of prior conversations");
      // The tail is the role:"user" message immediately before the real input.
      const userIdx = turn.findIndex((m) => m.role === "user" && m.content === MEMORY_TEXT);
      expect(userIdx).toBeGreaterThan(0);
      const tail = turn[userIdx - 1]!;
      expect(tail.role).toBe("user");
      const tailContent = String(tail.content ?? "");
      const identityIdx = tailContent.indexOf("Your runtime identity:");
      const memoryIdx = tailContent.indexOf("Long-term memory of prior conversations");
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(memoryIdx).toBeGreaterThanOrEqual(0);
      expect(tailContent).toContain(MEMORY_TEXT);
      // Identity before memory, mirroring the old system-prompt order.
      expect(identityIdx).toBeLessThan(memoryIdx);
    } finally {
      if (prevEmbed === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
      else process.env.GINI_EMBEDDING_PROVIDER = prevEmbed;
      if (prevReranker === undefined) delete process.env.GINI_RERANKER_PROVIDER;
      else process.env.GINI_RERANKER_PROVIDER = prevReranker;
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("emits authorization_requested with the action field for gated tools", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-approval");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-approval", undefined, "agent_y")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "hi" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "write out.txt" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    let blocks = listChatBlocks(config.instance, session.id);
    const approval = blocks.find((b) => b.kind === "authorization_requested");
    if (approval?.kind === "authorization_requested") {
      expect(approval.authorizationId).toBe(paused.approvalIds[0]);
      expect(approval.action).toBe("file.write");
      expect(approval.risk).toBeDefined();
    } else {
      throw new Error("missing authorization_requested block");
    }

    // Resume by approving; the tool_call flips ok and a tool_result lands.
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    blocks = listChatBlocks(config.instance, session.id);
    const toolCall = blocks.find((b) => b.kind === "tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.status).toBe("ok");
    } else {
      throw new Error("missing tool_call block");
    }
    const toolResult = blocks.find((b) => b.kind === "tool_result");
    expect(toolResult).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("ask_user pauses the turn with a chat.choice setup card and no reason bubble", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-choice");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-choice", undefined, "agent_q")
    );

    const question = "How should I search the web?";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_q",
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({
              question,
              options: [
                { label: "Set up Brave only" },
                { label: "Neither — use web_fetch", description: "No setup needed" }
              ]
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "find the best cafe" });
    const paused = await waitForTerminal(config, submitted.taskId);
    // An all-chat.choice park is reclassified as needs_input.
    expect(paused.status).toBe("needs_input");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("chat.choice");
    expect(setup?.payload.question).toBe(question);

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const setupBlock = blocks.find((b) => b.kind === "setup_requested");
    if (setupBlock?.kind === "setup_requested") {
      expect(setupBlock.action).toBe("chat.choice");
      // The summary IS the question — that's what transcripts/sessions show.
      expect(setupBlock.summary).toBe(question);
    } else {
      throw new Error("missing setup_requested block");
    }
    // Unlike connector.request, no assistant bubble accompanies the card —
    // the question lives in the card itself.
    expect(blocks.some((b) => b.kind === "assistant_text")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("subagent tasks (no chat session) skip block emission entirely", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-subagent");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Subagent done.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Submit a task without a chatSessionId — equivalent to a subagent
    // child or a CLI imperative task. The loop should run to
    // completion but no chat_blocks rows should land.
    const task = await submitTask(config, "subagent prompt", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // No session => no rows in chat_blocks for this task. We can't
    // grep by taskId alone (no helper exposed) so just confirm we
    // wrote zero rows by asking the DB directly via getMemoryDb.
    const { getMemoryDb } = await import("../state");
    const db = getMemoryDb(config.instance);
    const count = db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM chat_blocks WHERE task_id = ?")
      .get(task.id)?.c ?? 0;
    expect(count).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a read_skill body from a prior turn persists into the next turn's transcript", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-skill");
    const provider = normalizeProvider(config.provider);

    const skill = await createSkillFromInput(config, {
      name: "apple-notes",
      description: "Apple Notes via memo CLI."
    });
    const skillBody = "# Apple Notes\n\nUse `memo notes -a` to add a note.";
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = skillBody;
    });
    await setSkillStatus(config, skill.id, "enabled");

    const { createChat, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Skill thread" });

    // Turn 1: read the skill, then answer.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_skill", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "apple-notes" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I now know how to use Apple Notes.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "how do I add an apple note?" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The skill body must be in the replayed transcript
    // so the model need not re-read it (Claude Code skill behavior).
    setEchoToolCallingResponse({
      provider,
      text: "Adding your note now.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "add a note that says hi" });
    await waitForTerminal(config, second.taskId);

    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "add a note that says hi")
    );
    expect(turn2).toBeDefined();
    const skillToolResult = turn2!.find((m) => m.role === "tool" && m.tool_call_id === "call_skill");
    expect(skillToolResult).toBeDefined();
    expect(String(skillToolResult!.content)).toContain("memo notes -a");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("loaded deferred tool set persists across an approval pause/resume and dispatches after resume", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    // strict so set_provider gates instead of auto-resolving.
    const config = buildConfig(workspaceRoot, "chat-task-deferred-resume");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load set_provider AND get_self.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["set_provider", "get_self"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: call set_provider directly (top-level args). Strict → pauses.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_sp", type: "function", function: { name: "set_provider", arguments: JSON.stringify({ provider: "echo" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 3 (the RESUMED turn): call the previously-loaded get_self directly.
    // It's a query op → resolves sync (no second gate) and writes a self.get
    // audit row, proving the loaded schema survived the resume.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_gs", type: "function", function: { name: "get_self", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 4: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Provider set.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "switch to echo", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id, 10000);
    expect(paused.status).toBe("waiting_approval");
    // The loaded set survived onto the task across the pause snapshot.
    expect(paused.loadedTools).toContain("set_provider");
    expect(paused.loadedTools).toContain("get_self");
    expect(paused.toolCallState).toBeDefined();
    expect(paused.toolCallState?.pending[0]?.toolName).toBe("set_provider");
    expect(paused.approvalIds.length).toBe(1);

    // Approve → resume. runLoop re-seeds loadedToolNames from task.loadedTools
    // so get_self is live again on the resumed iteration.
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Provider set.");
    // get_self dispatched on the resumed turn — proving the loaded deferred
    // tool was in providerTools post-resume (not nudged as unloaded).
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "self.get" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    // Cleared on terminal completion.
    expect(finished.loadedTools).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Loop gate, never-loaded case: the model emits a deferred tool it never
  // loaded. The chat-task loop gate (NOT the dispatcher's default-case
  // backstop, which browser_snapshot never reaches — it has its own dispatch
  // case) must block execution and feed back a "not loaded yet" nudge, and the
  // loop must continue to a final answer. We assert NO browser.snapshot audit
  // row exists (proving the thunk never ran).
  test("inline load_tools persists a paired tool_result row in the durable transcript", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    // This turn opens memory.db (recall + auto-retain), and memory-db.ts caches
    // SQLite handles by instance NAME across the process. Derive the instance
    // from the unique mkdtemp basename so a rerun in the same worker can't reuse
    // a cached handle pointing at this run's already-removed state dir.
    const config = buildConfig(workspaceRoot, `chat-task-inline-persist-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Inline persist").id
    );

    // Turn 1: an inline load_tools call. Turn 2: a tool-less final answer.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_inline_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_snapshot"] }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "Ready.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "load the browser tools", { mode: "chat", chatSessionId: sessionId });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");

    const durable = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.kind === "tool_transcript"
    );
    // The assistant tool_use row was persisted...
    const assistantCall = durable.find(
      (m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === "call_inline_load")
    );
    expect(assistantCall).toBeDefined();
    // ...AND its inline result is now a paired durable row (the fix).
    const pairedResult = durable.find((m) => m.role === "tool" && m.toolCallId === "call_inline_load");
    expect(pairedResult).toBeDefined();
    expect(String(pairedResult?.content)).toContain("callable directly");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fan-out watch worker history. A session-bound subagent (chatSessionId set,
  // no run.conversationId — exactly how dispatchFanOut spawns a concern-channel
  // worker) must land its turn in the channel's durable chatMessages so a later
  // turn in the same channel replays the draft instead of seeing empty history.
  test("iteration-cap summary exit persists the durable answer row", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-answer-row");
    config.agent = { maxIterations: 3 };
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Cap chat");
      return session.id;
    });

    // Three distinct tool-call turns consume the cap without tripping the
    // identical-repeat loop-breaker, then the tool-less summary turn fires.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(workspaceRoot, `cap${i}.md`), `cap content (${i})`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_cap_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: `cap${i}.md` }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoToolCallingResponse({
      provider,
      text: "Cap summary: I read three files but could not finish.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "loop forever", { mode: "chat", chatSessionId: sessionId });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (iteration cap reached: 3)");

    const answerRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(answerRows.length).toBe(1);
    expect(answerRows[0]!.content).toBe("Cap summary: I read three files but could not finish.");
    expect(answerRows[0]!.taskId).toBe(task.id);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The context-exhaustion partial-result exit also completes with a real
  // user-facing summary and must persist the same durable answer row.
  test("inflated provider-reported prompt tokens engage the trim path on the next iteration", async () => {
    const ELISION_MARKER =
      "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-usage-trim");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the trim geometry below is decoupled
    // from the live always-on catalog size (cleared in afterEach). The
    // accumulated transcript is calibrated to sit under the high-water mark
    // through call 12; with the live catalog, growing any always-on tool
    // description could push the pre-usage estimate across the mark and
    // flip this test from pure pruning into compaction. file_read replaces
    // read_skill as the dispatched tool; the filler tools set the floor.
    __setBaseToolCatalogForTests([
      {
        toolset: "file",
        type: "function",
        function: {
          name: "file_read",
          description: "Read a UTF-8 text file from the workspace. Returns up to 12000 characters.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Workspace-relative path." } },
            required: ["path"]
          }
        }
      },
      ...FIXED_COMPACTION_CATALOG.slice(1)
    ]);

    // Twelve tool-call turns reading DISTINCT files (so no loop-breaker
    // trips), each result ~3k chars — elidable (>200 chars) but the total
    // stays under every estimate-driven threshold. Only the LAST response
    // reports usage; the resulting calibration gap forces the pre-call trim
    // ahead of the 13th call. The per-read filler is sized so the accumulated
    // transcript sits below the chars/4 high-water mark given the pinned
    // tool-schema floor and system-prompt slice.
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(workspaceRoot, `chunk${i}.md`), `chunk-${i} `.repeat(325));
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_u${i}`, type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: `chunk${i}.md` }) } }
        ],
        finishReason: "tool_calls",
        ...(i === 11 ? { usage: { prompt_tokens: 29_600 } } : {})
      });
    }
    setEchoToolCallingResponse({
      provider,
      text: "Done reading.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "read all the chunks", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Done reading.");

    // The 13th provider call (after the usage report) must see the oldest
    // tool results elided — oldest-first, with the recent tail untouched —
    // and the trim must be pure pruning (no aux summarization).
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(13);
    const finalToolMessages = calls[12]!.filter((m) => m.role === "tool");
    expect(finalToolMessages.length).toBe(12);
    const markerCount = finalToolMessages.filter((m) => m.content === ELISION_MARKER).length;
    expect(markerCount).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < finalToolMessages.length; i++) {
      if (i < markerCount) expect(finalToolMessages[i]!.content).toBe(ELISION_MARKER);
      else expect(finalToolMessages[i]!.content).toContain(`chunk-${i}`);
    }
    expect(getEchoAuxTextRequests().length).toBe(0);
    // No call BEFORE the usage report saw any elision.
    for (let c = 0; c < 12; c++) {
      expect(calls[c]!.some((m) => m.content === ELISION_MARKER)).toBe(false);
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Reactive overflow recovery: a provider that rejects the prompt as too
  // long gets a compacted transcript on retry (bounded attempts). Two
  // overflow failures followed by a success must complete the task with the
  // retried call's answer — and the retried call must carry elided results.
  test("partial exit never resurrects a prior turn's answer and emits the note once", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const PARTIAL_NOTE =
      "Stopped early: the conversation no longer fits the model's context window even after compaction. This is a partial result.";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-partial-prior-turn");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "partial-exit")
    );

    // Turn 1 completes normally with a distinctive answer.
    setEchoToolCallingResponse({ provider, text: "PRIOR-TURN-ANSWER", toolCalls: [], finishReason: "stop" });
    const first = await submitChatMessage(config, session.id, { content: "first question" });
    const firstDone = await waitForTerminal(config, first.taskId, 10000);
    expect(firstDone.summary).toBe("PRIOR-TURN-ANSWER");

    // Turn 2: a narration-less tool turn, then persistent overflow.
    writeFileSync(join(workspaceRoot, "note.md"), "note content");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_p1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "note.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    const second = await submitChatMessage(config, session.id, { content: "second question" });
    const finished = await waitForTerminal(config, second.taskId, 10000);

    expect(finished.status).toBe("completed");
    // Note-only: no narration happened this turn — the prior turn's answer
    // must not be presented as this turn's partial result.
    expect(finished.summary).toBe(PARTIAL_NOTE);

    // The note reaches the chat exactly once, as a system note.
    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const noteBlocks = blocks.filter((b) => JSON.stringify(b).includes("Stopped early"));
    expect(noteBlocks.length).toBe(1);
    expect(noteBlocks[0]!.kind).toBe("system_note");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // When the turn DID narrate before exhausting the window, the partial
  // exit surfaces that narration (cleaned) with the note appended.
  test("in-turn compaction bails gracefully when the savings are too small", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction-savings");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Exchange sizes: big, tiny, big, big. The middle span (everything
    // between the protected first exchange and the protected last two) is
    // ONLY the tiny exchange, so the summary cannot reclaim anything.
    const bodies = [`BODY-0 ${"x".repeat(19_000)}`, "tiny note", `BODY-2 ${"x".repeat(19_000)}`, `BODY-3 ${"x".repeat(19_000)}`];
    for (let i = 0; i < bodies.length; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, bodies[i]!);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_v${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoAuxTextResponse({ text: "TINY-SUMMARY" });

    const task = await submitTask(config, "review the bulk skills", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: context window exhausted)");
    expect(finished.summary).toContain("could not reclaim enough");
    // One compaction was attempted (the tiny middle), then the bail fired —
    // no further model calls.
    expect(getEchoAuxTextRequests().length).toBe(1);
    expect(getEchoToolCallingCalls().length).toBe(4);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The savings bail only applies while the projection is still ABOVE the
  // high-water mark. A compaction that reclaims little in absolute terms
  // but gets the next call back under the mark is a success — the turn
  // must proceed, not exit one call short of finishing.
  test("non-overflow provider errors still fail the task without retrying", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-provider-error");

    setEchoToolCallingFailure("upstream exploded (500)");

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("upstream exploded");
    // Exactly one provider call — no retry on a non-overflow failure.
    expect(getEchoToolCallingCalls().length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A transient fault (dropped connection / OS timeout) is retried with bounded
  // backoff: the conversation is valid, so the next attempt may simply succeed.
  test("a cancel during the transient backoff wait bails to cancelled, not a retry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, `chat-task-transient-cancel-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { cancelTask } = await import("../agent");

    // This is the ONE transient test that needs a real backoff window to cancel
    // inside. Override the (otherwise-0ms) base to a long, fixed value so the
    // cancel deterministically lands DURING the wait regardless of CI load — the
    // test never actually waits it out (the cancel aborts the sleep at once).
    // The retry warning is written synchronously right before the sleep starts,
    // so once we observe it there is a full 60s window to cancel: no race.
    const prevBase = process.env.GINI_TRANSIENT_RETRY_BASE_MS;
    process.env.GINI_TRANSIENT_RETRY_BASE_MS = "60000";
    try {
      // One transient failure arms the backoff; the success stub after it must
      // NEVER run because we cancel during that backoff window.
      setEchoToolCallingFailure("The operation timed out.");
      setEchoToolCallingResponse({ provider, text: "SHOULD-NOT-APPEAR", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "say hi", { mode: "chat" });
      // The transient-retry warning is appended right before the backoff sleep —
      // poll for it, then cancel inside the (60s) backoff window.
      const { readTrace } = await import("../state");
      const deadline = Date.now() + 5000;
      let sawRetryWarning = false;
      while (Date.now() < deadline) {
        sawRetryWarning = readTrace(config.instance, task.id).some(
          (t) => t.type === "warning" && /Transient model-call fault; retrying/.test(t.message)
        );
        if (sawRetryWarning) break;
        await Bun.sleep(5);
      }
      // Assert the retry actually armed BEFORE we cancel — otherwise a regression
      // that never enters the backoff would let the cancel land on a non-backoff
      // task and still satisfy the assertions below, silently masking the break.
      expect(sawRetryWarning).toBe(true);
      await cancelTask(config, task.id);
      const cancelled = await waitForTerminal(config, task.id, 10000);

      expect(cancelled.status).toBe("cancelled");
      // The retry's success stub must not have run: only the failed first call.
      expect(getEchoToolCallingCalls().length).toBe(1);
      expect(cancelled.summary ?? "").not.toContain("SHOULD-NOT-APPEAR");
    } finally {
      if (prevBase === undefined) delete process.env.GINI_TRANSIENT_RETRY_BASE_MS;
      else process.env.GINI_TRANSIENT_RETRY_BASE_MS = prevBase;
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A context overflow is NOT a transient fault — it must take the compact-and-
  // retry path on its own budget, never the transient-retry path. (The transient
  // markers and the overflow markers are disjoint by construction.)
});