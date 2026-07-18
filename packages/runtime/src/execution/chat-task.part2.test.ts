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

  test("approval-gated tool call pauses the task and resumes after approval", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-gated");
    const provider = normalizeProvider(config.provider);

    // First model turn: request a file write.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "from-agent" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Second model turn (after approval resumes): final reply.
    setEchoToolCallingResponse({
      provider,
      text: "Wrote the file as requested.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "please create out.txt", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.toolCallState).toBeDefined();
    expect(paused.toolCallState?.pending.length).toBe(1);
    expect(paused.toolCallState?.pending[0]?.toolName).toBe("file_write");
    expect(paused.approvalIds.length).toBe(1);

    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    const finished = await waitForFinalTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Wrote the file as requested.");
    // The file should have been written.
    const written = await Bun.file(join(workspaceRoot, "out.txt")).text();
    expect(written).toBe("from-agent");
    // The toolCallState should be cleared on completion.
    expect(finished.toolCallState).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("pending approval halts the rest of the turn — later calls are skipped, not dispatched", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-pending-halt");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w1", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "a.txt", content: "AAA" }) } },
        { id: "call_w2", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "b.txt", content: "BBB" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write a and b", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.toolCallState).toBeDefined();
    // Only the first call goes pending. The second was skipped (its
    // dispatch never ran) — message history carries a synthetic
    // skipped tool_result so the LLM sees both tool_calls paired.
    expect(paused.toolCallState?.pending.length).toBe(1);
    expect(paused.approvalIds.length).toBe(1);

    // Deny the lone pending approval. The task fails. The second
    // file_write never ran in the first place, so its file must not
    // exist on disk either.
    const [firstApprovalId] = paused.approvalIds as [string];
    await decideApproval(config, firstApprovalId, "deny");
    // Deny resumes detached; poll for the final failed state rather than a
    // fixed sleep so the wait tracks the real settle time.
    const failedTask = await waitForFinalTerminal(config, task.id);

    expect(failedTask.status).toBe("failed");
    expect(failedTask.toolCallState).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "a.txt"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "b.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec auto-approves and runs synchronously when the command matches the allowlist", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-auto-approve");
    config.autoApproveCommands = ["echo *"];
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_auto", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hello" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Said hello.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "say hello", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Said hello.");

    const state = readState(config.instance);
    // No approval row should have been created.
    const approvalsForTask = state.authorizations.filter((a) => a.taskId === task.id);
    expect(approvalsForTask).toHaveLength(0);

    // The audit row should exist and be flagged as auto-approved.
    const audit = state.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    expect(audit).toBeDefined();
    expect(audit.risk).toBe("high");
    const evidence = audit.evidence as Record<string, unknown>;
    expect(evidence.autoApproved).toBe(true);
    expect(evidence.autoApprovedReason).toBe("echo *");
    expect(evidence.exitCode).toBe(0);
    expect(String(evidence.stdout)).toContain("hello");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a healthy turn with no needs-reauth record writes no clear audit (no state churn)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-reauth-nochurn");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({ provider, text: "Nothing to clear.", toolCalls: [], finishReason: "stop" });
    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // The clear seam fires only when a record exists — a healthy instance
    // sees neither a record nor a provider.auth.cleared audit row.
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.echo).toBeUndefined();
    expect(state.audit.some((a) => a.action === "provider.auth.cleared")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("STILL trips the navigation loop-breaker on oscillating-URL reload loops", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-nav-oscillate");
    const provider = normalizeProvider(config.provider);
    // Pinned floor for the same reason as the distinct-URL test above.
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Two distinct first-visits seed the recent-URL window (count stays 0),
    // then alternating between them is a repeat every turn so the count climbs
    // to MAX_NAVIGATION_WITHOUT_ACTION (8): 2 seed + 8 repeats = 10 navigations.
    const urls = ["http://127.0.0.1:1/", "http://127.0.0.1:2/"];
    for (let i = 0; i < 10; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_osc_${i}`,
            type: "function",
            function: { name: "browser_navigate", arguments: JSON.stringify({ url: urls[i % 2] }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn the loop-breaker exit consumes.
    setEchoToolCallingResponse({
      provider,
      text: "I kept bouncing between the same two pages without getting anywhere.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "open these pages", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: tool loop made no progress)");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const navBreaker = traces.find(
      (t) => t.type === "warning" && /navigations to recently-visited URLs.*loop-breaker/.test(t.message)
    );
    expect(navBreaker).toBeDefined();
    // Stopped well before the iteration cap: 10 navigation turns + 1 summary turn.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(11);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Invalid `agent.maxIterations` values must fall back to the built-in
  // default and emit a warning trace. We only verify the warning trace
  // here — proving the fallback value matches the default would require running
  // a full-length loop, which is wasteful; the resolver is small enough
  // that the warning's presence is sufficient evidence.
  test("invalid agent.maxIterations warning is emitted at most once across approval resumes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-warn-once");
    (config as unknown as { agent: { maxIterations: number } }).agent = { maxIterations: 0 };
    const provider = normalizeProvider(config.provider);

    // First model turn: request a file write (gated → pauses the task).
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_wo", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Resume turn: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "write and finish", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warnings = traces.filter(
      (t) => t.type === "warning" && /agent\.maxIterations/i.test(String(t.data?.reason ?? ""))
    );
    expect(warnings.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Also accept the same invalid-string case (e.g. "abc") to confirm the
  // resolver's typeof guard rejects non-numbers, not just non-positive
  // integers.
  test("suppresses the assistant_text block when the final turn text is exactly [SILENT]", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-suppress");
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
      text: "[SILENT]",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    expect(blocks.some((b) => b.kind === "assistant_text")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("injects the current message's client-surface line into the ephemeral tail, per turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-surface");
    const provider = normalizeProvider(config.provider);
    const { createChat } = await import("./chat");
    const session = await createChat(config, { title: "Surface probe" });

    // Turn 1 from the web, turn 2 from the phone — the same session can
    // alternate surfaces, so each turn must carry only its OWN surface.
    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });
    const first = await submitChatMessage(config, session.id, { content: "desktop turn", client: "web" });
    expect((await waitForTerminal(config, first.taskId)).status).toBe("completed");

    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });
    const second = await submitChatMessage(config, session.id, { content: "phone turn", client: "mobile" });
    expect((await waitForTerminal(config, second.taskId)).status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    const turn1 = calls[0]!;
    const turn2 = calls[calls.length - 1]!;

    // Turn 1: the web line rides in the tail immediately before the user
    // message, and the system prefix stays surface-free.
    const userIdx1 = turn1.findIndex((m) => m.role === "user" && m.content === "desktop turn");
    expect(userIdx1).toBeGreaterThan(0);
    const tail1 = String(turn1[userIdx1 - 1]!.content ?? "");
    expect(tail1).toContain("The user is messaging from the web app");
    expect(String(turn1.find((m) => m.role === "system")?.content ?? "")).not.toContain("The user is messaging");

    // Turn 2: only the mobile line — the prior turn's web line must not
    // replay into this turn's context.
    const userIdx2 = turn2.findIndex((m) => m.role === "user" && m.content === "phone turn");
    expect(userIdx2).toBeGreaterThan(0);
    const tail2 = String(turn2[userIdx2 - 1]!.content ?? "");
    expect(tail2).toContain("The user is messaging from the mobile app");
    expect(tail2).toContain("a browser handoff can't reach them");
    for (const m of turn2) {
      expect(String(m.content ?? "")).not.toContain("The user is messaging from the web app");
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("message 0 is a byte-stable prefix across two turns in the same session", async () => {
    // Headline cache contract: with no identity/skill/job/connector change
    // between turns, the system message (message 0) must be byte-identical
    // turn-to-turn so automatic provider prefix caching stays warm. Message 0
    // is stable regardless of whether recall returns anything, because the
    // per-turn-varying content (emitted identity, recalled memory) now lives
    // in the ephemeral role:"user" tail rather than in message 0. See ADR
    // stable-system-prefix.md.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-stable-prefix");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Stable prefix");
      return session.id;
    });

    const firstRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 1",
        input: "first",
        conversationId: sessionId
      });
      return run.id;
    });
    setEchoToolCallingResponse({ provider, text: "One.", toolCalls: [], finishReason: "stop" });
    const firstTask = await submitTask(config, "first question", { mode: "chat", runId: firstRunId });
    await waitForTerminal(config, firstTask.id);

    const secondRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 2",
        input: "second",
        conversationId: sessionId
      });
      return run.id;
    });
    setEchoToolCallingResponse({ provider, text: "Two.", toolCalls: [], finishReason: "stop" });
    const secondTask = await submitTask(config, "second question", { mode: "chat", runId: secondRunId });
    await waitForTerminal(config, secondTask.id);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    expect(calls[0]![0]!.role).toBe("system");
    expect(calls[1]![0]!.role).toBe("system");
    // Byte equality of message 0 across the two turns is the whole point.
    expect(calls[0]![0]!.content).toBe(calls[1]![0]!.content);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("connector.request cancel resumes the chat loop with a fallback result", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-connector-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-connector-cancel", undefined, "agent_z")
    );

    const reason = "I need Brave Search access to answer with current weather.";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_c", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "brave-search", reason }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I can't look up current weather without Brave Search access. Connect Brave Search or provide the weather details.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "what is the weather in sf today" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("connector.request");

    await resolveSetupRequest(config, setup!.id, "cancel", { actor: "user" });

    let finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    const deadline = Date.now() + 5000;
    while (finished?.status !== "completed" && Date.now() < deadline) {
      await Bun.sleep(TERMINAL_POLL_MS);
      finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    }
    expect(finished?.status).toBe("completed");
    expect(finished?.summary).toBe(
      "I can't look up current weather without Brave Search access. Connect Brave Search or provide the weather details."
    );

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    let lastPhase = blocks[blocks.length - 1];
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.kind === "phase") {
        lastPhase = blocks[i];
        break;
      }
    }
    expect(lastPhase?.kind).toBe("phase");
    if (lastPhase?.kind === "phase") {
      expect(lastPhase.label).toBe("Completed");
      expect(lastPhase.taskId).toBe(submitted.taskId);
    }
    const requestConnectorCall = blocks.find(
      (b) => b.kind === "tool_call" && b.toolName === "request_connector"
    );
    expect(requestConnectorCall?.kind).toBe("tool_call");
    if (requestConnectorCall?.kind === "tool_call") {
      expect(requestConnectorCall.status).toBe("ok");
    }
    expect(blocks.some((b) => b.kind === "tool_result" && b.preview.includes("User canceled connector setup for brave-search"))).toBe(true);
    expect(blocks.some((b) => b.kind === "assistant_text" && b.text === finished?.summary)).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup!.id)?.status).toBe("cancelled");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits parallel tool_calls with distinct callIds and ordinals", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    writeFileSync(join(workspaceRoot, "a.md"), "alpha");
    writeFileSync(join(workspaceRoot, "b.md"), "beta");
    const config = buildConfig(workspaceRoot, "chat-task-blocks-parallel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-parallel", undefined, "agent_p")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "a.md" }) } },
        { id: "call_b", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "b.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read both.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "read both" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const toolCalls = blocks.filter((b): b is typeof blocks[0] & { kind: "tool_call" } => b.kind === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((c) => c.callId).sort()).toEqual(["call_a", "call_b"]);
    expect(toolCalls.map((c) => c.ordinal)).toEqual(
      toolCalls.map((c) => c.ordinal).slice().sort((x, y) => x - y)
    );
    expect(toolCalls.every((c) => c.status === "ok")).toBe(true);

    const toolResults = blocks.filter((b) => b.kind === "tool_result");
    expect(toolResults).toHaveLength(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("two turns reusing the same tool_call_id each replay with their own result", async () => {
    // The text-backstop path synthesizes call ids from name:args:index, so
    // the same tool called with the same args on two turns yields an
    // identical tool_call_id. Pairing must stay local to each assistant row:
    // turn 1's call gets turn 1's result, turn 2's call gets turn 2's, even
    // though both rows share the id.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-dupid");
    const provider = normalizeProvider(config.provider);
    const fixturePath = join(workspaceRoot, "state.txt");

    const { createChat, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Dup-id thread" });

    // Turn 1: read the file (content "FIRST"), reusing the colliding id.
    writeFileSync(fixturePath, "FIRST");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_dup", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "state.txt" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read FIRST.",
      toolCalls: [],
      finishReason: "stop"
    });
    const first = await submitChatMessage(config, session.id, { content: "read it once" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: read the same file (now "SECOND") with the SAME tool_call_id.
    writeFileSync(fixturePath, "SECOND");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_dup", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "state.txt" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Read SECOND.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "read it again" });
    await waitForTerminal(config, second.taskId);
    await syncChatTaskResult(config, session.id, second.taskId);

    // Turn 3: plain answer — we only inspect the transcript it was handed.
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });
    const third = await submitChatMessage(config, session.id, { content: "what changed?" });
    await waitForTerminal(config, third.taskId);

    const calls = getEchoToolCallingCalls();
    const turn3 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "what changed?")
    );
    expect(turn3).toBeDefined();

    // Both assistant tool_calls rows replay, each immediately followed by its
    // OWN paired result — turn 1 with "FIRST", turn 2 with "SECOND".
    const toolResults: string[] = [];
    for (let i = 0; i < turn3!.length; i++) {
      const m = turn3![i]!;
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call_dup")) {
        const next = turn3![i + 1];
        expect(next?.role).toBe("tool");
        expect(next?.tool_call_id).toBe("call_dup");
        toolResults.push(String(next?.content ?? ""));
      }
    }
    expect(toolResults.length).toBe(2);
    expect(toolResults[0]).toContain("FIRST");
    expect(toolResults[0]).not.toContain("SECOND");
    expect(toolResults[1]).toContain("SECOND");
    expect(toolResults[1]).not.toContain("FIRST");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("the dispatcher's deferred guard nudges toward load_tools and does not over-trigger", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-nudge");

    const { dispatchToolCall } = await import("./tool-dispatch");
    const { isDeferredToolName } = await import("./tool-catalog");
    const { createTask, upsertTask } = await import("../state");
    const taskRow = createTask(config.instance, "nudge probe");
    await mutateState(config.instance, (state) => upsertTask(state, taskRow));

    // A genuinely unknown (non-deferred) tool still throws Unknown tool —
    // the guard is scoped to deferred names and does not over-trigger.
    expect(isDeferredToolName("totally_made_up_tool")).toBe(false);
    let threw = false;
    try {
      await dispatchToolCall(config, taskRow.id, "totally_made_up_tool", "call_x", "{}");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // browser_snapshot is a known deferred tool. The guard helper classifies
    // it as deferred so a not-yet-loaded reference reaching the dispatcher's
    // default case would return the recoverable load_tools nudge rather than
    // throwing Unknown tool.
    expect(isDeferredToolName("browser_snapshot")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The riskiest invariant: a deferred tool the model loaded must stay live
  // across an approval pause/resume. We load two deferred self tools
  // (set_provider + get_self), call set_provider (strict → gates), assert the
  // paused task carries loadedTools, then approve and — on the RESUMED turn —
  // call get_self directly. get_self only dispatches successfully if it is
  // still in providerTools after the resume, which proves runLoop re-seeds
  // loadedToolNames from task.loadedTools (a merely-completing final-text turn
  // would not prove the loaded schema survived).
  test("create_agent direct tool gates, then approval lands the agent and resumes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-create-agent-resume");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load create_agent.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["create_agent"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: call create_agent directly. Strict → gates.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_ca", type: "function", function: { name: "create_agent", arguments: JSON.stringify({ name: "E2E2" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 3: final answer after approval.
    setEchoToolCallingResponse({
      provider,
      text: "Agent created.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "create an agent called E2E2", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id, 10000);
    expect(paused.status).toBe("waiting_approval");

    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.action).toBe("self.config");
    expect(approval.payload.opName).toBe("create_agent");
    // No agent yet — the side effect is deferred to approval time.
    expect(stateBefore.agents.some((a) => a.name === "E2E2")).toBe(false);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForFinalTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Agent created.");

    // The handler ran on approval — the agent row now exists.
    const stateAfter = readState(config.instance);
    expect(stateAfter.agents.some((a) => a.name === "E2E2")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Issue #397: an inline-handled tool (load_tools here; the deferred-not-loaded
  // nudge shares the branch) must PERSIST its tool result to
  // the durable transcript, paired with the assistant tool_use row. Otherwise a
  // later turn (or any rebuild) replays the assistant tool_use with no result,
  // and a tool-pairing-strict provider (Bedrock Converse, Anthropic Messages)
  // 400s the whole request. Pin: after a load_tools turn, the channel's durable
  // chatMessages carry both the assistant call AND a role:"tool" result for it.
  test("a turn cancelled mid-stream replays the interrupt marker to the model on the next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    // Per-instance runtime state persists across reruns in the same worker, so
    // derive the instance from the unique mkdtemp basename — otherwise a rerun
    // replays chatMessages accumulated by the prior run and the assertion races.
    const config = buildConfig(workspaceRoot, `chat-task-interrupt-marker-replay-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { cancelTask } = await import("../agent");

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "General chat");
      return session.id;
    });

    // Turn 1: a held, tool-less model call so the cancel lands mid-stream.
    setEchoToolCallingResponse(
      { provider, text: "drafting a long answer...", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 3000 }
    );
    const task = await submitTask(config, "write me a long essay", { mode: "chat", chatSessionId: sessionId });
    // Wait until it's genuinely running (model call in flight), then cancel.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running") break;
      await Bun.sleep(10);
    }
    await cancelTask(config, task.id);
    const cancelled = await waitForTerminal(config, task.id);
    expect(cancelled.status).toBe("cancelled");

    // Turn 2 in the same session: the replayed provider messages must include
    // the interrupt marker (a user-role row priorChatMessages replays).
    clearEchoToolCallingResponses();
    setEchoToolCallingResponse({ provider, text: "Sure.", toolCalls: [], finishReason: "stop" });
    const followUp = await submitTask(config, "actually, just summarize", { mode: "chat", chatSessionId: sessionId });
    const finishedFollowUp = await waitForTerminal(config, followUp.id);
    expect(finishedFollowUp.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    const lastTurn = calls[calls.length - 1]!;
    const replayed = lastTurn.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(replayed).toContain("[Request interrupted by user]");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The iteration-cap/loop-stall summary exit completes the task with a real
  // user-facing summary, so it must land the same durable assistant answer
  // row as the no-tool-calls path — otherwise a turn that ends on the cap
  // leaves the session with no answer for the next turn to replay.
  test("session-bound subagent with a [SILENT] final persists no summary chatMessage", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-fanout-silent");
    const provider = normalizeProvider(config.provider);

    const { sessionId, subagentId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Email: quiet@example.com");
      const subagent = createSubagentRecord(state, {
        name: "email-watch",
        prompt: "watch worker",
        toolsets: ["file"],
        systemPrompt: "You are an email watch worker."
      });
      return { sessionId: session.id, subagentId: subagent.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "[SILENT]",
      toolCalls: [],
      finishReason: "stop"
    });

    const worker = await submitTask(config, "anything to reply to?", { mode: "chat", chatSessionId: sessionId, subagentId });
    const finished = await waitForTerminal(config, worker.id);
    expect(finished.status).toBe("completed");

    const summaryRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(summaryRows.length).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Provider-reported prompt tokens drive the in-turn trim trigger. The
  // chars/4 estimate here stays under every threshold, so without
  // calibration no elision would ever fire. A stubbed call reporting a real
  // prompt size near the window (29.6k of the echo provider's 32k) must
  // tighten the NEXT iteration's budgets so the oldest unprotected tool
  // results shrink before the following call — via pruning alone, with no
  // summarization (aux) involvement. Toolsets are disabled to pin the tool
  // schemas to the always-on floor (file_read still dispatches; the catalog
  // only shapes what the provider sees).
  test("overflow exhaustion settles the failed attempt's stream", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-stream-exhaust");
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "stream-exhaust")
    );

    // Every attempt streams partial text before throwing the overflow.
    setEchoToolCallingFailure(OVERFLOW_MESSAGE, { streamTextBeforeFailure: "DISCARDED-PARTIAL " });
    setEchoToolCallingFailure(OVERFLOW_MESSAGE, { streamTextBeforeFailure: "DISCARDED-PARTIAL " });
    setEchoToolCallingFailure(OVERFLOW_MESSAGE, { streamTextBeforeFailure: "DISCARDED-PARTIAL " });

    const submitted = await submitChatMessage(config, session.id, { content: "go" });
    const finished = await waitForTerminal(config, submitted.taskId, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toContain("This is a partial result.");
    // The discarded stream never resurrects into the partial summary.
    expect(finished.partialSummary ?? "").toBe("");

    // No block on the completed task is left streaming.
    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const streamingBlocks = blocks.filter((b) => b.kind === "assistant_text" && b.streaming);
    expect(streamingBlocks.length).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The partial-result exit surfaces only THIS turn's narration. The packed
  // prior context inside workingMessages carries earlier turns' assistant
  // answers, so a transcript re-scan would resurrect one of those as this
  // turn's partial result; and the explanatory note must reach the chat
  // exactly once (as a system note), never duplicated into an
  // assistant_text block.
  test("in-turn compaction summarizes the middle, protects head and tail, and continues", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    for (let i = 0; i < 7; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(8_372)}`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_s${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoAuxTextResponse({ text: "SUMMARY-OF-MIDDLE" });
    setEchoToolCallingResponse({
      provider,
      text: "All skills reviewed.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "review every bulk skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("All skills reviewed.");

    // Exactly one aux summarization call, fed ONLY the middle exchanges —
    // at compaction time (before the 7th call) six exchanges exist: BODY-0
    // is the protected head exchange, BODY-4/BODY-5 the protected tail, so
    // the middle is BODY-1..BODY-3. BODY-6 is read after the compaction.
    const auxRequests = getEchoAuxTextRequests();
    expect(auxRequests.length).toBe(1);
    for (const middle of ["BODY-1", "BODY-2", "BODY-3"]) {
      expect(auxRequests[0]!.user).toContain(middle);
    }
    for (const protectedBody of ["BODY-0", "BODY-4", "BODY-5", "BODY-6"]) {
      expect(auxRequests[0]!.user).not.toContain(protectedBody);
    }

    // The final call carries the marked synthetic summary…
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(8);
    const finalCall = calls[7]!;
    const summaryMessage = finalCall.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith(IN_TURN_COMPACTION_NOTE_PREFIX)
    );
    expect(summaryMessage).toBeDefined();
    expect(String(summaryMessage!.content)).toContain("SUMMARY-OF-MIDDLE");
    // …the middle tool results are gone…
    const toolContents = finalCall.filter((m) => m.role === "tool").map((m) => String(m.content));
    for (const middle of ["BODY-1", "BODY-2", "BODY-3"]) {
      expect(toolContents.some((c) => c.includes(middle))).toBe(false);
    }
    // …the recent tail (and the post-compaction read) stay verbatim…
    expect(toolContents.some((c) => c.includes("BODY-4"))).toBe(true);
    expect(toolContents.some((c) => c.includes("BODY-5"))).toBe(true);
    expect(toolContents.some((c) => c.includes("BODY-6"))).toBe(true);
    // …and the head is intact: system prompt, the original ask, and the
    // first in-turn exchange.
    expect(finalCall[0]!.role).toBe("system");
    expect(
      finalCall.some((m) => m.role === "user" && String(m.content).includes("review every bulk skill"))
    ).toBe(true);
    expect(
      finalCall.some((m) => m.role === "assistant" && (m.tool_calls ?? []).some((c) => c.id === "call_s0"))
    ).toBe(true);
    expect(toolContents.some((c) => c.includes("BODY-0"))).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Anti-thrash: when the only summarizable middle is tiny while the
  // protected head/tail carries the bulk, compaction reclaims almost
  // nothing — the loop must bail to the graceful partial exit instead of
  // grinding through pointless aux calls.
  test("in-turn compaction falls back to a graceful partial exit when the aux model is unavailable", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction-aux-fail");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    for (let i = 0; i < 7; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(8_372)}`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_f${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoAuxTextFailure("aux model unavailable");

    const task = await submitTask(config, "review every bulk skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: context window exhausted)");
    expect(finished.summary).toContain("no summarization model was available");
    expect(finished.error).toBeUndefined();
    // The trigger fired before the 7th call, the aux call failed, and no
    // further model call ran.
    expect(getEchoToolCallingCalls().length).toBe(6);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Non-overflow provider errors keep their existing contract: the task
  // fails with the raw error, no compact-and-retry.
  test("a transient fault that streamed partial text trims it before the successful retry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transient-partial-trim");
    const provider = normalizeProvider(config.provider);

    // The failed attempt streams a partial chunk, then errors transiently.
    setEchoToolCallingFailure("The operation timed out.", { streamTextBeforeFailure: "DISCARDED-PARTIAL " });
    setEchoToolCallingResponse({ provider, text: "Clean retry answer.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    // The discarded partial must NOT leak into the final summary.
    expect(finished.summary).toBe("Clean retry answer.");
    expect(finished.summary).not.toContain("DISCARDED-PARTIAL");
    expect(getEchoToolCallingCalls().length).toBe(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A cancel that lands during the transient backoff wait must bail to the
  // cancelled path, never sneak in the retry. Exercises abortableBackoffSleep's
  // abort branch and the catch-and-bailOnTurnAbort handling.
});
