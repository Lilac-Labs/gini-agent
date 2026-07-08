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

  test("read_skill chooses an enabled same-name user skill when the bundled row is disabled", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill-same-name");
    const provider = normalizeProvider(config.provider);

    const bundled = await createSkillFromInput(config, {
      name: "same-name",
      description: "Bundled disabled skill."
    });
    const user = await createSkillFromInput(config, {
      name: "same-name",
      description: "User enabled skill."
    });
    await mutateState(config.instance, (state) => {
      const bundledRow = state.skills.find((s) => s.id === bundled.id)!;
      bundledRow.source = "bundled";
      bundledRow.status = "disabled";
      bundledRow.body = "disabled bundled body";
      const userRow = state.skills.find((s) => s.id === user.id)!;
      userRow.source = "user";
      userRow.status = "enabled";
      userRow.body = "enabled user body";
    });

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_same_name", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "same-name" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Loaded the enabled skill.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "use the same-name skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "skill.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.target).toBe(user.id);
    expect(reads[0]?.evidence?.bytes).toBe("enabled user body".length);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("terminal_exec with pty=true runs the command under a real TTY", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-pty");
    const provider = normalizeProvider(config.provider);

    // `tty -s` exits 0 when stdin is a terminal, 1 otherwise. Print the
    // result so we can verify both the exit code and the side channel.
    const command = "tty -s && echo PTY-OK || echo NO-PTY";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_pty", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command, pty: true }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Ran the command under a TTY.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run with pty", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(paused.approvalIds.length).toBe(1);

    // Approval payload should carry pty=true so the executor knows to wrap.
    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.payload.pty).toBe(true);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const stateAfter = readState(config.instance);
    const auditEntry = stateAfter.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    expect(auditEntry).toBeDefined();
    const evidence = auditEntry.evidence as Record<string, unknown>;
    expect(evidence.pty).toBe(true);
    expect(evidence.exitCode).toBe(0);
    // The wrapped command saw a TTY, so the `tty -s` branch ran.
    expect(String(evidence.stdout)).toContain("PTY-OK");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("hits the configurable iteration cap and completes with a tool-less summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-cap-graceful");
    config.agent = { maxIterations: 3 };
    const provider = normalizeProvider(config.provider);

    // Three iterations of tool calls — one per loop pass — each reading a
    // DISTINCT file so the per-iteration signatures differ and the
    // identical-repeat loop-breaker does not pre-empt the genuine cap path.
    // The loop guard is `iterations < cap` so cap=3 means three model turns
    // are consumed before exhaustion.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(workspaceRoot, `hello${i}.md`), `Hello, world! (${i})`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_loop_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: `hello${i}.md` }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the exhaustion path should consume.
    setEchoToolCallingResponse({
      provider,
      text: "Cap reached. I read three files but never produced a final answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "loop forever", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "Cap reached. I read three files but never produced a final answer."
    );
    expect(finished.currentStep).toBe("Completed (iteration cap reached: 3)");
    expect(finished.error).toBeUndefined();

    // Trace should contain a warning event flagging the cap hit.
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find((t) => t.type === "warning" && /Iteration cap \(3\)/.test(t.message));
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.iterations).toBe(3);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("stops at the action-only loop-breaker when results jitter but the action repeats", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-action-loop-breaker");
    const provider = normalizeProvider(config.provider);

    // Six identical get_current_time calls: same name + args every turn, but
    // the clock advances so each result differs. The exact-match guard never
    // fires; the action-only guard trips on the sixth pass (runLength 6).
    for (let i = 0; i < 6; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_clock_${i}`,
            type: "function",
            function: { name: "get_current_time", arguments: JSON.stringify({}) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the loop-breaker exit should consume.
    setEchoToolCallingResponse({
      provider,
      text: "I kept checking the time without making progress on your request.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what time is it", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "I kept checking the time without making progress on your request."
    );
    expect(finished.currentStep).toBe("Completed (stopped: tool loop made no progress)");
    expect(finished.error).toBeUndefined();

    // Exactly seven model calls: six repeated tool turns + one tool-less
    // summary — proving the action-only guard stopped us at 6, not the iteration cap.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(7);

    // Trace records the action-only loop-breaker stop (not the exact-match one).
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const breaker = traces.find(
      (t) =>
        t.type === "warning" &&
        /repeating the same tool call\(s\) with identical arguments \(loop-breaker\)/.test(t.message)
    );
    expect(breaker).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Navigation loop-breaker MUST NOT false-positive on legitimate sequential
  // research. A model that navigates across many DISTINCT URLs (each blocked
  // here by the loopback SSRF gate, so no Chromium launches) is making progress,
  // not looping — the per-URL recent-window guard must let it run to the
  // iteration cap rather than tripping the navigation loop-breaker. (Loopback
  // URLs all yield the same generic block message, so distinct ports differ
  // only in arguments — exactly the trace signature the false-positive showed:
  // climbing nav count with identicalRunLength 1.)
  test("oversized agent.priorContextTokens override is clamped to available provider context", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-clamp");
    config.agent = { priorContextTokens: 1_000_000 };
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

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const warning = traces.find(
      (t) => t.type === "warning" && /exceeds available provider context/i.test(t.message)
    );
    expect(warning).toBeDefined();

    const contextTrace = traces.find(
      (t) => t.type === "model" && t.message === "chat-task system context built"
    );
    const contextData = contextTrace?.data as Record<string, unknown> | undefined;
    expect(contextData?.priorContextTokenRequested).toBe(1_000_000);
    expect(contextData?.priorContextTokenBudget as number)
      .toBeLessThanOrEqual(contextData?.priorContextTokenAvailable as number);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fix 2 (cost accumulation): each iteration's cost must add to the
  // running total instead of overwriting. Tested across a 3-iteration
  // run where the stub provider returns small but nonzero usage on
  // every turn — including the final tool-less summary turn the cap
  // exhaustion path emits.
  test("omits the Bound scheduled jobs block when no job is bound to the session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-bound-job");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "Hi.",
      toolCalls: [],
      finishReason: "stop"
    });

    // No runId / no chat session bound — the system context should not
    // carry the block header and should not pick up stray trailing
    // whitespace from a `${...}\n\n${empty}` template.
    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    expect(system).toBeDefined();
    const content = String(system?.content ?? "");
    expect(content).not.toContain("Scheduled jobs delivering into this chat:");
    // No trailing blank lines from optional sections being concatenated.
    expect(content).toBe(content.trimEnd());

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits the full runtime identity block on the first turn of a chat session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-first");
    const provider = normalizeProvider(config.provider);

    const { runId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity probe");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Identity turn",
        input: "intro",
        conversationId: session.id
      });
      return { runId: run.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Identity acknowledged.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what's your setup?", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    // The emitted identity now rides in the ephemeral role:"user" tail
    // placed immediately before the real user message — NOT in the
    // byte-stable system prefix. See ADR stable-system-prefix.md.
    const turn = calls[0]!;
    const system = turn.find((m) => m.role === "system");
    const systemContent = String(system?.content ?? "");
    expect(systemContent).not.toContain("Your runtime identity:");
    const userIdx = turn.findIndex((m) => m.role === "user" && m.content === "what's your setup?");
    expect(userIdx).toBeGreaterThan(0);
    const tail = turn[userIdx - 1]!;
    expect(tail.role).toBe("user");
    const tailContent = String(tail.content ?? "");
    expect(tailContent).toContain("Your runtime identity:");
    expect(tailContent).toContain(`- instance: ${config.instance}`);
    expect(tailContent).toContain(`- runtime port: ${config.port}`);
    expect(tailContent).toContain("- provider: echo/");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("omits the identity block on a follow-up turn when nothing changed", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-followup");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity follow-up");
      return session.id;
    });

    // Two distinct runs in the same conversation — same session id, two
    // separate user turns. The second turn must not re-emit the identity
    // block because nothing changed under the K=10 refresh threshold.
    const firstRunId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn 1",
        input: "first",
        conversationId: sessionId
      });
      return run.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "First.",
      toolCalls: [],
      finishReason: "stop"
    });

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

    setEchoToolCallingResponse({
      provider,
      text: "Second.",
      toolCalls: [],
      finishReason: "stop"
    });

    const secondTask = await submitTask(config, "second question", { mode: "chat", runId: secondRunId });
    await waitForTerminal(config, secondTask.id);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    // Identity now rides in the ephemeral role:"user" tail, so check every
    // message of each turn — not just the (now identity-free) system prefix.
    const firstTurnText = calls[0]!.map((m) => String(m.content ?? "")).join("\n");
    const secondTurnText = calls[1]!.map((m) => String(m.content ?? "")).join("\n");
    // First turn emits the full identity (in the tail); the system prefix
    // itself never carries it anymore.
    expect(firstTurnText).toContain("Your runtime identity:");
    expect(String(calls[0]!.find((m) => m.role === "system")?.content ?? "")).not.toContain("Your runtime identity:");
    // Quiet follow-up turn: no identity anywhere — neither system nor tail
    // (and with nothing recalled, no tail message is injected at all).
    expect(secondTurnText).not.toContain("Your runtime identity:");
    expect(secondTurnText).not.toContain("Runtime identity changes since last turn:");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("packs prior chat history for the provider without deleting stored history", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-pack", {
      agent: { priorContextTokens: 80 }
    });
    const provider = normalizeProvider(config.provider);
    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Packed history");
      createChatMessage(state, {
        sessionId: session.id,
        role: "user",
        content: `old secret should not be replayed ${"x".repeat(500)}`
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: `old answer should not be replayed ${"y".repeat(500)}`
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "user",
        content: "recent anchor question"
      });
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: "recent anchor answer"
      });
      return session.id;
    });

    const runId = await mutateState(config.instance, (state) => {
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Packed turn",
        input: "current",
        conversationId: sessionId
      });
      return run.id;
    });

    setEchoToolCallingResponse({ provider, text: "Done.", toolCalls: [], finishReason: "stop" });
    const task = await submitTask(config, "current question", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const firstCall = getEchoToolCallingCalls()[0]!;
    const providerText = firstCall.map((m) => String(m.content ?? "")).join("\n");
    expect(providerText).toContain("Earlier chat history is outside the current model context.");
    expect(providerText).toContain("recent anchor question");
    expect(providerText).toContain("recent anchor answer");
    expect(providerText).not.toContain("old secret should not be replayed");
    expect(providerText).not.toContain("old answer should not be replayed");

    const storedText = readState(config.instance).chatMessages.map((m) => m.content).join("\n");
    expect(storedText).toContain("old secret should not be replayed");
    expect(storedText).toContain("old answer should not be replayed");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // ChatBlock protocol pin (ADR chat-block-protocol.md). The loop must
  // emit a typed stream of blocks per chat session: user_text, phase,
  // assistant_text, tool_call, tool_result, approval_requested,
  // system_note. Tests run the loop against the echo provider with
  // pre-loaded responses and assert the block list shape.
  test("completing a setup request lands a Working phase after the gate", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-setup-phase");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-setup-phase", undefined, "agent_z2")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_sp",
          type: "function",
          function: {
            name: "request_connector",
            arguments: JSON.stringify({ provider: "brave-search", reason: "Need web search." })
          }
        }
      ],
      finishReason: "tool_calls"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "search the web" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    const gate = listChatBlocks(config.instance, session.id).find((b) => b.kind === "setup_requested");
    if (gate?.kind !== "setup_requested") throw new Error("missing setup_requested block");

    // The /complete handlers claim the row with resumeChatTask:false and run
    // their (potentially slow) side effects afterwards; connector.request is
    // mapped to emit a Working phase on complete, covering that window so the
    // activity scan stops reading a resolved gate as waiting_approval.
    const { resolveSetupRequest } = await import("../agent");
    await resolveSetupRequest(config, gate.setupRequestId, "complete", {
      actor: "user",
      resumeChatTask: false
    });

    const blocks = listChatBlocks(config.instance, session.id);
    const working = blocks.find((b) => b.kind === "phase" && b.label === "Working: connector.request");
    if (working?.kind !== "phase") throw new Error("missing setup-complete Working phase block");
    expect(working.ordinal).toBeGreaterThan(gate.ordinal);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("request_confirmation pauses the turn with a confirmation.request setup card and no reason bubble", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-confirm");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-confirm", undefined, "agent_c")
    );

    const summary = "Send this reply to Dana in the project thread";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_c",
          type: "function",
          function: {
            name: "request_confirmation",
            arguments: JSON.stringify({ summary, details: "Hi Dana — ship it.", confirmLabel: "Send" })
          }
        }
      ],
      finishReason: "tool_calls"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "reply to Dana that it's good" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("confirmation.request");
    expect(setup?.payload.summary).toBe(summary);
    expect(setup?.payload.confirmLabel).toBe("Send");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const setupBlock = blocks.find((b) => b.kind === "setup_requested");
    if (setupBlock?.kind === "setup_requested") {
      expect(setupBlock.action).toBe("confirmation.request");
      // The summary IS the block summary — that's what transcripts show.
      expect(setupBlock.summary).toBe(summary);
    } else {
      throw new Error("missing setup_requested block");
    }
    // Like chat.choice, no assistant bubble accompanies the card — the summary
    // lives in the card itself.
    expect(blocks.some((b) => b.kind === "assistant_text")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("deleteChatSession cascades and removes all chat blocks", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-cascade");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-cascade", undefined, "agent_d")
    );

    setEchoToolCallingResponse({
      provider,
      text: "Hello back.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "hi" });
    await waitForTerminal(config, submitted.taskId);

    const { listChatBlocks } = await import("../state");
    expect(listChatBlocks(config.instance, session.id).length).toBeGreaterThan(0);

    await mutateState(config.instance, (state) => deleteChatSession(state, session.id));
    expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Tool-calling transcript persistence + replay (ADR
  // agent-loop-tool-calling.md). A prior turn's assistant tool_calls and its
  // paired role:"tool" results are persisted durably (kind:"tool_transcript")
  // and replayed next turn so the model sees the structured results of its
  // own earlier actions instead of re-deriving them.
  test("a gated tool that persists an approval_reason row still replays its call+result next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-gated-reason");
    const provider = normalizeProvider(config.provider);

    const { createChat, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Connector thread" });

    // Turn 1: request_connector (approval-gated) for a provider with no
    // setupSkill, so it goes straight to a pending setup request. Unlike
    // file_write, this path persists a plain assistant kind:"approval_reason"
    // row BETWEEN the assistant tool_calls row and the on-resume tool result,
    // which is exactly what the turn-window pairing must span.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_conn", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "linear", reason: "list my open issues" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Connected to Linear.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "connect linear" });
    const paused = await waitForTerminal(config, first.taskId);
    expect(paused.status).toBe("waiting_approval");

    // An approval_reason row was persisted during dispatch — this is the
    // interleaved non-tool row that the old window logic stopped at.
    const reasonRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === session.id && m.kind === "approval_reason"
    );
    expect(reasonRows.length).toBeGreaterThan(0);

    // Resolve the setup request the way the /complete handler does: the
    // synthesized toolResult is fed back via resumeChatTask, which persists
    // the gated tool result row.
    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === first.taskId);
    expect(setup).toBeDefined();
    await resolveSetupRequest(config, setup!.id, "complete", {
      actor: "user",
      toolResult: "Connected to Linear. Proceed with the original request."
    });
    const finished = await waitForTerminal(config, first.taskId);
    expect(finished.status).toBe("completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The gated tool's call+result must survive replay
    // even though an approval_reason row sits between them in the transcript.
    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "thanks" });
    await waitForTerminal(config, second.taskId);

    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "thanks")
    );
    expect(turn2).toBeDefined();

    const assistantIdx = turn2!.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls!.some((c) => c.id === "call_conn")
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    // The matching tool result must immediately follow its assistant message.
    const nextMsg = turn2![assistantIdx + 1];
    expect(nextMsg?.role).toBe("tool");
    expect(nextMsg?.tool_call_id).toBe("call_conn");
    expect(String(nextMsg?.content)).toContain("Connected to Linear");

    // No orphan tool results: every role:"tool" message in the replay points
    // at an assistant tool_call id that appears earlier in the same array.
    const emittedCallIds = new Set<string>();
    for (const m of turn2!) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) emittedCallIds.add(c.id);
      }
      if (m.role === "tool") {
        expect(typeof m.tool_call_id).toBe("string");
        expect(emittedCallIds.has(m.tool_call_id!)).toBe(true);
      }
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("loop gate blocks a same-batch load+call but lets the tool through on the next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-samebatch");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load_tools(browser_snapshot) AND browser_snapshot(...) together.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_snapshot"] }) } },
        { id: "call_snap", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: model recovers with a final answer (we stop before a real browser
    // call to keep the test hermetic; the point is that the same-batch call was
    // gated while load_tools succeeded).
    setEchoToolCallingResponse({
      provider,
      text: "Browser tools loaded; ready to snapshot.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "snapshot the page", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // browser_snapshot was NOT executed this turn — no browser.snapshot audit.
    const snapAudits = state.audit.filter((a) => a.action === "browser.snapshot" && a.taskId === task.id);
    expect(snapAudits).toHaveLength(0);

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    const secondTurn = calls[1]!;
    // load_tools succeeded: its tool result confirms callability.
    const loadResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("callable directly")
    );
    expect(loadResult).toBeDefined();
    // browser_snapshot got the "not loaded yet" nudge this turn.
    const snapResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("not loaded yet")
    );
    expect(snapResult).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // browser_navigate seeds the deferred browser cluster: a navigation
  // establishes a browsing session whose snapshot is full of actionable @eN
  // refs, so the interaction tools (snapshot, click, type, …) must be live on
  // the NEXT provider call without a load_tools round-trip per tool — and the
  // seeded set must persist on task.loadedTools so a pause/resume keeps it.
  // The navigate here targets a loopback URL (SSRF-blocked pre-flight, no
  // Chromium) — seeding is unconditional on the navigate outcome.
  test("normal chat turn persists exactly one assistant summary (no double-write)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-double-write");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "General chat");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Turn",
        input: "kick off",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Here is your answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what is 2+2?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // Finalize wrote the summary row for the normal turn.
    const beforeSync = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId.sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(beforeSync.length).toBe(1);
    expect(beforeSync[0]!.content).toBe("Here is your answer.");

    const { syncChatTaskResult } = await import("./chat");
    const synced = await syncChatTaskResult(config, sessionId.sessionId, task.id);
    expect(synced?.content).toBe("Here is your answer.");

    const afterSync = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId.sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(afterSync.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Normal chat-turn answer durability. A plain chat turn (no subagentId, no
  // jobId) must land its final answer in durable chatMessages at completion —
  // no client /sync callback required — so the next turn in the same session
  // replays the answer via priorChatMessages instead of seeing the prior
  // question unanswered.
  test("thread-reply turn's persisted answer row carries parentBlockId and links the run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-thread-answer-row");
    const provider = normalizeProvider(config.provider);

    const { sessionId, runId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Threaded chat");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Thread turn",
        input: "follow up",
        conversationId: session.id
      });
      return { sessionId: session.id, runId: run.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Threaded answer.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "follow up", {
      mode: "chat",
      runId,
      chatSessionId: sessionId,
      threadId: "thread_t1",
      parentBlockId: "blk_parent"
    });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const answerRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(answerRows.length).toBe(1);
    expect(answerRows[0]!.content).toBe("Threaded answer.");
    expect(answerRows[0]!.threadId).toBe("thread_t1");
    expect(answerRows[0]!.parentBlockId).toBe("blk_parent");

    const run = readState(config.instance).runs.find((r) => r.id === runId);
    expect(run?.assistantMessageId).toBe(answerRows[0]!.id);
    expect(run?.updatedAt).toBe(answerRows[0]!.createdAt);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A parent-delegated subagent with NO chatSessionId resolves no session, so
  // neither the transcript nor the final text is persisted — its result flows
  // back to the parent as a tool result, not into any channel's history.
  test("overflow retry recalibrates the token estimate to the compacted payload", async () => {
    const ELISION_MARKER =
      "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";
    const OVERFLOW_MESSAGE = "prompt is too long: 33000 tokens > 32000 maximum";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-recalibrate");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });

    for (let i = 0; i < 11; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(4_550)}`);
    }
    for (let i = 0; i < 10; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_g${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    // Iteration 11: one overflow rejection, then a successful retry that
    // reports usage and keeps working (one more read).
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_g10", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "bulk-skill-10" }) } }
      ],
      finishReason: "tool_calls",
      usage: { prompt_tokens: 26_000 }
    });
    setEchoToolCallingResponse({
      provider,
      text: "Recalibrated.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "read all the bulk skills", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recalibrated.");

    // The final call must see MORE elision than the retry left behind —
    // driven purely by the recalibrated gap (no overflow fired after the
    // retry).
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(13);
    const markersInRetry = calls[11]!.filter((m) => m.content === ELISION_MARKER).length;
    const markersInFinal = calls[12]!.filter((m) => m.content === ELISION_MARKER).length;
    expect(markersInFinal).toBeGreaterThan(markersInRetry);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Overflow that persists through every retry must exit gracefully with a
  // partial result — completed, not failed — without making the tool-less
  // summary call (which would itself overflow).
  test("partial exit emits non-streaming narration as a block alongside the note", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const PARTIAL_NOTE =
      "Stopped early: the conversation no longer fits the model's context window even after compaction. This is a partial result.";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-partial-nonstream");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "partial-nonstream")
    );

    writeFileSync(join(workspaceRoot, "note.md"), "note content");
    // Whole-string response (no deltas) narrating before a tool call, then
    // persistent overflow.
    setEchoToolCallingResponse(
      {
        provider,
        text: "ONE-SHOT NARRATION before reading.",
        toolCalls: [
          { id: "call_ns1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "note.md" }) } }
        ],
        finishReason: "tool_calls"
      },
      undefined,
      { nonStreaming: true }
    );
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);

    const submitted = await submitChatMessage(config, session.id, { content: "read the note" });
    const finished = await waitForTerminal(config, submitted.taskId, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(`ONE-SHOT NARRATION before reading.\n\n${PARTIAL_NOTE}`);

    // The narration reaches the timeline as a settled block; the note stays
    // a system note (never folded into the block).
    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const narrationBlocks = blocks.filter(
      (b) => b.kind === "assistant_text" && b.text === "ONE-SHOT NARRATION before reading."
    );
    expect(narrationBlocks.length).toBe(1);
    expect(narrationBlocks[0]!.kind === "assistant_text" && narrationBlocks[0]!.streaming).toBe(false);
    const noteBlocks = blocks.filter((b) => JSON.stringify(b).includes("Stopped early"));
    expect(noteBlocks.length).toBe(1);
    expect(noteBlocks[0]!.kind).toBe("system_note");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A provider can stream part of a response BEFORE throwing the overflow.
  // The retry must start from a clean stream: without a per-attempt reset
  // the failed attempt's text accretes onto the retry's in the route buffer
  // and the in-flight assistant block.
  test("in-turn compaction bails gracefully when the window refills immediately", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction-refill");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Same geometry as the happy path (compaction fires before call 7) plus
    // a 7th huge read that immediately refills the reclaimed space.
    for (let i = 0; i < 7; i++) {
      const chars = i === 6 ? 36_000 : 8_600;
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(chars)}`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_r${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoAuxTextResponse({ text: "REFILL-SUMMARY" });

    const task = await submitTask(config, "review every bulk skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: context window exhausted)");
    expect(finished.summary).toContain("refilled immediately");
    // Exactly one compaction, then the refill bail before an 8th call.
    expect(getEchoAuxTextRequests().length).toBe(1);
    expect(getEchoToolCallingCalls().length).toBe(7);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The per-turn compaction cap: after two compactions (spaced widely enough
  // that the refill guard stays quiet), a third trigger must NOT summarize
  // again — the loop proceeds (the reactive overflow retry is the backstop)
  // and completes normally.
  test("streaming idle-timeout fault retries then completes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-idle-retry");
    const provider = normalizeProvider(config.provider);

    // The exact message provider.ts's StreamIdleTimeoutError produces.
    setEchoToolCallingFailure("Model stream idle timeout: no data for 120000ms");
    setEchoToolCallingResponse({ provider, text: "Back after the stall.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Back after the stall.");
    expect(getEchoToolCallingCalls().length).toBe(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The transient budget is bounded: after MAX_TRANSIENT_RETRIES (2) extra
  // attempts the task fails with the raw fault, just as it would today.
  test("transient retries do not steal the context-overflow compaction budget", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transient-then-overflow");
    const provider = normalizeProvider(config.provider);

    const OVERFLOW_MESSAGE =
      "This model's maximum context length is 32000 tokens. However, your messages resulted in 99999 tokens.";
    // Two transient faults exhaust the transient budget, then a context overflow
    // arrives, then a clean success once compaction shrinks the transcript.
    setEchoToolCallingFailure("The operation timed out.");
    setEchoToolCallingFailure("The operation timed out.");
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingResponse({ provider, text: "Recovered after transient faults + a compaction.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    // The task recovered via compaction — it did NOT exit early with the
    // no-compaction partial-result message.
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered after transient faults + a compaction.");
    expect(finished.summary).not.toContain("no longer fits the model's context window");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    // Both transient retries fired AND the overflow compaction still ran.
    const transientRetries = traces.filter(
      (t) => t.type === "warning" && /Transient model-call fault; retrying/.test(t.message)
    );
    expect(transientRetries.length).toBe(2);
    expect(traces.some((t) => t.type === "warning" && /rejected the prompt as too long/.test(t.message))).toBe(true);
    // 4 provider calls total: 2 transient fails + 1 overflow + 1 successful retry.
    expect(getEchoToolCallingCalls().length).toBe(4);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fallback: a provider that reports no usage (the echo default) keeps the
  // plain chars/4 behavior — the identical transcript never trims.
});