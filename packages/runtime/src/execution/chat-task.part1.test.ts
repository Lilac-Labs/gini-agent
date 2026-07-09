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

  test("dispatches a low-risk tool call then completes with a final answer", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-sync");
    const provider = normalizeProvider(config.provider);

    // First model turn: ask to read the file.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Second model turn: respond with the file contents.
    setEchoToolCallingResponse({
      provider,
      text: "The file says: Hello, world!",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "what does hello.md say?", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("The file says: Hello, world!");
    // Audit trail should include the file.read.
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "file.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("read_skill rejects disabled skills with a recoverable error", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill-disabled");
    const provider = normalizeProvider(config.provider);

    // Create a disabled skill. The agent loop should see an
    // error tool result and recover.
    const skill = await createSkillFromInput(config, {
      name: "disabled-skill",
      description: "Currently disabled."
    });
    await setSkillStatus(config, skill.id, "disabled");
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "Some disabled content.";
    });

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_disabled", type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: "disabled-skill" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Got it — that skill is disabled.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "use the disabled skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Got it — that skill is disabled.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // One-pending-per-turn regression. When the LLM emits multiple
  // tool calls in a single assistant turn and the first one returns
  // a pending approval, all subsequent dispatches MUST be deferred
  // so their side effects don't race the user's approval decision.
  // The chat-task loop skips remaining calls and synthesizes a
  // "skipped" tool_result for message-history symmetry; the LLM
  // re-evaluates from the new state on the next turn after the
  // approval resolves.
  test("terminal_exec without pty sees no TTY and stays on the legacy spawn path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-pty");
    const provider = normalizeProvider(config.provider);

    const command = "tty -s && echo PTY-OK || echo NO-PTY";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_nopty", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Ran without TTY.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "run without pty", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    const stateBefore = readState(config.instance);
    const approval = stateBefore.authorizations.find((a) => a.id === paused.approvalIds[0]!)!;
    expect(approval.payload.pty).toBe(false);

    await decideApproval(config, approval.id, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const stateAfter = readState(config.instance);
    const auditEntry = stateAfter.audit.find((a) => a.action === "terminal.exec" && a.taskId === task.id)!;
    const evidence = auditEntry.evidence as Record<string, unknown>;
    expect(evidence.pty).toBe(false);
    expect(String(evidence.stdout)).toContain("NO-PTY");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Auto-approve allowlist (Fix 2). When the user has added a matching
  // pattern to RuntimeConfig.autoApproveCommands, terminal_exec should
  // execute synchronously and write a high-risk audit row with
  // evidence.autoApproved=true plus the matched pattern. No approval row
  // should be created — the loop must continue without pausing.
  test("a successful provider call clears the persistent needs-reauth record", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-reauth-clear");
    const provider = normalizeProvider(config.provider);

    // A prior turn recorded an echo auth failure (issue #233).
    await mutateState(config.instance, (state) => {
      recordProviderAuthFailure(state, { provider: "echo", detail: "token expired", taskId: "task_prior" });
    });
    expect(readState(config.instance).providerAuthFailures?.echo).toBeDefined();

    setEchoToolCallingResponse({ provider, text: "All good again.", toolCalls: [], finishReason: "stop" });
    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // The successful call dropped the record and audited the clear.
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.echo).toBeUndefined();
    const cleared = state.audit.find((a) => a.action === "provider.auth.cleared" && a.target === "echo");
    expect(cleared).toBeDefined();
    expect(cleared?.evidence).toMatchObject({ provider: "echo", reason: "provider call succeeded" });

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("does NOT trip the navigation loop-breaker on distinct-URL research", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-nav-distinct");
    config.agent = { maxIterations: 9 };
    const provider = normalizeProvider(config.provider);
    // Pin the tool-catalog floor so the many-iteration geometry is decoupled
    // from live always-on catalog size (cleared in afterEach) — this test is
    // about the nav guard, not the context window. Dispatch keys on the call
    // name, so browser_navigate still hits the SSRF gate as before.
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Nine navigations to nine DISTINCT loopback URLs. Each is SSRF-blocked
    // pre-flight (deterministic, no browser), but the nav guard counts the
    // call regardless of result — and since every URL is new, the count never
    // climbs. The loop exhausts the iteration cap instead.
    for (let i = 1; i <= 9; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_nav_${i}`,
            type: "function",
            function: { name: "browser_navigate", arguments: JSON.stringify({ url: `http://127.0.0.1:${i}/` }) }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn the cap-exhaustion exit consumes.
    setEchoToolCallingResponse({
      provider,
      text: "I checked nine different pages but ran out of steps before finishing.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "research across pages", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    // Reached the iteration cap — NOT the loop-breaker.
    expect(finished.currentStep).toBe("Completed (iteration cap reached: 9)");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    // No navigation loop-breaker warning fired.
    const navBreaker = traces.find(
      (t) => t.type === "warning" && /navigations to recently-visited URLs.*loop-breaker/.test(t.message)
    );
    expect(navBreaker).toBeUndefined();
    // The cap warning is what stopped us.
    const capWarning = traces.find((t) => t.type === "warning" && /Iteration cap \(9\)/.test(t.message));
    expect(capWarning).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The navigation loop-breaker's protection MUST NOT regress: a model that
  // oscillates between a small set of URLs (the degenerate reload/ping-pong
  // pattern behind the original context-overflow incident) still trips it at
  // the existing threshold. Oscillating between TWO URLs keeps the exact-match
  // and action-only guards from firing (arguments alternate every turn), so
  // only the navigation guard can catch it — isolating the guard under test.
  test("accumulates cost across iterations including the cap-exhaustion summary turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-cost-accum");
    config.agent = { maxIterations: 2 };
    const provider = normalizeProvider(config.provider);

    // Two tool-call iterations, each reporting 10 in / 5 out / 15 total.
    for (let i = 0; i < 2; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_acc_${i}`,
            type: "function",
            function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) }
          }
        ],
        finishReason: "tool_calls",
        cost: { provider: "echo", model: "gini-echo-v0", inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      });
    }
    // Cap-exhaustion summary turn — adds another 4 in / 6 out / 10 total.
    setEchoToolCallingResponse({
      provider,
      text: "Cap reached.",
      toolCalls: [],
      finishReason: "stop",
      cost: { provider: "echo", model: "gini-echo-v0", inputTokens: 4, outputTokens: 6, totalTokens: 10 }
    });

    const task = await submitTask(config, "loop a bit", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Cap reached.");
    // 10 + 10 + 4 = 24 input tokens, 5 + 5 + 6 = 16 output tokens, 15 + 15 + 10 = 40 total.
    expect(finished.cost?.inputTokens).toBe(24);
    expect(finished.cost?.outputTokens).toBe(16);
    expect(finished.cost?.totalTokens).toBe(40);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Fix 4 (warning de-duplication): the invalid-config warning should be
  // emitted at most once per task even when runLoop is re-entered after
  // approval pauses. We force a pause via a gated tool call, approve it,
  // then assert the trace contains exactly one matching warning.
  test("subagent path preserves the subagent prompt and still appends the bound-jobs block", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-bound-job-subagent");
    const provider = normalizeProvider(config.provider);

    const SUBAGENT_PROMPT = "You are a narrow research subagent. Stay terse.";
    const { runId, subagentId, jobId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Research thread");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Research turn",
        input: "kick off",
        conversationId: session.id
      });
      const subagent = createSubagentRecord(state, {
        name: "researcher",
        prompt: "research subagent",
        toolsets: ["file"],
        systemPrompt: SUBAGENT_PROMPT
      });
      const at = now();
      const job: JobRecord = {
        id: "job-research",
        instance: state.instance,
        name: "Weekly research digest",
        prompt: "Summarize this week's top three industry stories.",
        intervalSeconds: 604800,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: session.id,
        createdAt: at,
        updatedAt: at,
        nextRunAt: at,
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      };
      state.jobs.push(job);
      return { runId: run.id, subagentId: subagent.id, jobId: job.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "go", { mode: "chat", runId, subagentId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    // Subagent prompt preserved verbatim at the top of system context.
    expect(content.startsWith(SUBAGENT_PROMPT)).toBe(true);
    // Scheduled-jobs context block still appended after the subagent prompt.
    expect(content).toContain("Scheduled jobs delivering into this chat:");
    expect(content).toContain(jobId);
    expect(content).toContain("Weekly research digest");
    expect(content).toContain("every 604800s");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // [SILENT] sentinel suppression at the chat-block layer. A scheduled
  // job (or fan-out subagent worker) that has nothing to report responds
  // with exactly "[SILENT]". The legacy message layer drops the
  // ChatMessageRecord, but the UI renders chat blocks — so a completed
  // turn whose final text is exactly "[SILENT]" must NOT leave a visible
  // assistant_text block behind.
  test("subagent path skips runtime identity injection", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-subagent");
    const provider = normalizeProvider(config.provider);

    const SUBAGENT_PROMPT = "You are a narrow research subagent. Stay terse.";
    const { runId, subagentId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Identity subagent probe");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Subagent turn",
        input: "kick off",
        conversationId: session.id
      });
      const subagent = createSubagentRecord(state, {
        name: "researcher",
        prompt: "research subagent",
        toolsets: ["file"],
        systemPrompt: SUBAGENT_PROMPT
      });
      return { runId: run.id, subagentId: subagent.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "go", { mode: "chat", runId, subagentId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const turn = calls[0]!;
    const system = turn.find((m) => m.role === "system");
    const content = String(system?.content ?? "");
    expect(content.startsWith(SUBAGENT_PROMPT)).toBe(true);
    expect(content).not.toContain("Your runtime identity:");
    expect(content).not.toContain("Runtime identity changes since last turn:");
    // Subagents keep their single override prompt + the real user message:
    // no ephemeral identity/memory tail is injected on the subagent path.
    expect(turn.filter((m) => m.role === "user").length).toBe(1);
    for (const m of turn) {
      const text = String(m.content ?? "");
      expect(text).not.toContain("Your runtime identity:");
      expect(text).not.toContain("Runtime identity changes since last turn:");
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Client-surface injection: the surface of the message that started THIS
  // turn rides in the ephemeral role:"user" tail (never the byte-stable
  // system prefix), and is omitted entirely when unknown. See ADR
  // client-surface-context.md.
  test("deferred snapshot write skips when the chat session was deleted before the model returned", async () => {
    // Race: snapshot decision is made up-front in runChatTask, but the
    // write is deferred to runLoop after the first model call. If the
    // chat session is deleted during that window, the deferred write
    // must not recreate an orphan snapshot keyed on a now-deleted
    // session id. We deterministically simulate the race by deleting
    // the session before the task ever runs -- the run still exists,
    // so runChatTask resolves the conversationId, but the deferred
    // write's session-existence check inside mutateState catches the
    // deletion and skips the write.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-identity-orphan-guard");
    const provider = normalizeProvider(config.provider);

    const { runId, sessionId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Soon-to-be-deleted");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Orphan probe",
        input: "go",
        conversationId: session.id
      });
      return { runId: run.id, sessionId: session.id };
    });

    // Delete the chat session before the task runs. runChatTask will
    // still build identity from the run.conversationId, but the
    // deferred write must observe that the session is gone.
    await mutateState(config.instance, (state) => {
      deleteChatSession(state, sessionId);
    });

    setEchoToolCallingResponse({
      provider,
      text: "Done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything", { mode: "chat", runId });
    await waitForTerminal(config, task.id);

    expect(readState(config.instance).identitySnapshots?.[sessionId]).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("emits typed blocks for a successful tool-calling turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const fixturePath = join(workspaceRoot, "hello.md");
    writeFileSync(fixturePath, "Hello, world!");
    const config = buildConfig(workspaceRoot, "chat-task-blocks-success");
    const provider = normalizeProvider(config.provider);

    // Set up the session BEFORE submitting the task so chatSessionId
    // is bound to the task. submitTask threads chatSessionId through
    // to createTask which the emission resolver reads.
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-test", undefined, "agent_x")
    );

    setEchoToolCallingResponse({
      provider,
      text: "Sure, reading it now.",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "hello.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "The file says: Hello, world!",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "what does hello.md say?" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    // Expected sequence in ordinal order:
    //   user_text → phase("Thinking") → assistant_text("Sure, reading it now.")
    //   → phase("Working: file_read") → tool_call(file_read, ok)
    //   → tool_result(call_1) → phase("Thinking") → assistant_text(final)
    //   → phase("Completed")
    const kinds = blocks.map((b) => b.kind);
    expect(kinds[0]).toBe("user_text");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds[kinds.length - 1]).toBe("phase");

    const user = blocks.find((b) => b.kind === "user_text");
    expect(user?.kind === "user_text" && user.text).toBe("what does hello.md say?");

    const toolCall = blocks.find((b) => b.kind === "tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.toolName).toBe("file_read");
      expect(toolCall.displayLabel).toBe("Read file");
      expect(toolCall.argsPreview).toBe("hello.md");
      expect(toolCall.argsFull).toEqual({ path: "hello.md" });
      expect(toolCall.status).toBe("ok");
      expect(toolCall.callId).toBe("call_1");
    } else {
      throw new Error("missing tool_call block");
    }

    const toolResult = blocks.find((b) => b.kind === "tool_result");
    if (toolResult?.kind === "tool_result") {
      expect(toolResult.callId).toBe("call_1");
    } else {
      throw new Error("missing tool_result block");
    }

    // Final assistant_text is the model's reply (after the tool result
    // turn) — settled with streaming:false.
    const assistantTexts = blocks.filter((b): b is typeof blocks[0] & { kind: "assistant_text" } =>
      b.kind === "assistant_text"
    );
    expect(assistantTexts.length).toBeGreaterThan(0);
    const finalAssistant = assistantTexts[assistantTexts.length - 1]!;
    expect(finalAssistant.streaming).toBe(false);
    expect(finalAssistant.text).toContain("Hello, world!");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("connector.request surfaces the reason as an assistant bubble above the setup card", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-connector");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-connector", undefined, "agent_z")
    );

    const reason = "Brave Search would help me find a fresh answer here. Want to connect it?";
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_c", type: "function", function: { name: "request_connector", arguments: JSON.stringify({ provider: "brave-search", reason }) } }
      ],
      finishReason: "tool_calls"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "search the web for the best cafe" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);

    // The minimal setup card carries no inline reason; the reason is its
    // own assistant bubble, ordered above the card.
    const setupIdx = blocks.findIndex((b) => b.kind === "setup_requested");
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    const setup = blocks[setupIdx];
    if (setup?.kind === "setup_requested") {
      expect(setup.action).toBe("connector.request");
    } else {
      throw new Error("missing setup_requested block");
    }
    const reasonIdx = blocks.findIndex((b) => b.kind === "assistant_text" && b.text === reason);
    expect(reasonIdx).toBeGreaterThanOrEqual(0);
    expect(reasonIdx).toBeLessThan(setupIdx);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("confirmation.request cancel resumes the chat loop with {confirmed:false}", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-confirm-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-confirm-cancel", undefined, "agent_c")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_c",
          type: "function",
          function: {
            name: "request_confirmation",
            arguments: JSON.stringify({ summary: "Send the reply to Dana" })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Okay, I won't send it. What should I change?",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "reply to Dana" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("confirmation.request");

    await resolveSetupRequest(config, setup!.id, "cancel", { actor: "user" });

    let finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    const deadline = Date.now() + 5000;
    while (finished?.status !== "completed" && Date.now() < deadline) {
      await Bun.sleep(TERMINAL_POLL_MS);
      finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    }
    // Cancel must resume the loop, NOT fail the task.
    expect(finished?.status).toBe("completed");
    expect(finished?.summary).toBe("Okay, I won't send it. What should I change?");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    // The model receives an unambiguous boolean from the cancel.
    expect(blocks.some((b) => b.kind === "tool_result" && b.preview.includes('"confirmed":false'))).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup!.id)?.status).toBe("cancelled");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a structured tool result from a prior turn is replayed on the next turn", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-id");
    const provider = normalizeProvider(config.provider);
    const fixturePath = join(workspaceRoot, "issue.json");
    // The "create issue" stand-in: a tool the loop dispatches synchronously
    // whose result carries an id the agent must remember next turn.
    const issueResult = JSON.stringify({ ok: true, issueId: "ISSUE-4242" });
    writeFileSync(fixturePath, issueResult);

    const { createChat, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Issue thread" });

    // Turn 1: read the file (returns the issue id), then a final answer.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_issue", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "issue.json" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Created issue ISSUE-4242.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "create an issue" });
    await waitForTerminal(config, first.taskId);
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: the model just answers — we only care about the transcript it
    // was handed.
    setEchoToolCallingResponse({
      provider,
      text: "Editing ISSUE-4242 as requested.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, session.id, { content: "now edit that issue" });
    await waitForTerminal(config, second.taskId);

    // Locate turn 2's provider call: the one whose user message is the
    // second prompt.
    const calls = getEchoToolCallingCalls();
    const turn2 = calls.find((messages) =>
      messages.some((m) => m.role === "user" && m.content === "now edit that issue")
    );
    expect(turn2).toBeDefined();

    // The replayed transcript carries the assistant tool_calls message AND
    // the paired role:"tool" result with the issue id.
    const assistantToolCalls = turn2!.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    expect(assistantToolCalls).toBeDefined();
    expect(assistantToolCalls!.tool_calls![0]!.id).toBe("call_issue");

    const toolResult = turn2!.find((m) => m.role === "tool" && m.tool_call_id === "call_issue");
    expect(toolResult).toBeDefined();
    expect(String(toolResult!.content)).toContain("ISSUE-4242");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("advertises deferred tools on demand and loads one via load_tools, feeding back a callable confirmation", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-load");
    const provider = normalizeProvider(config.provider);

    // Turn 1: load the browser_snapshot schema via load_tools. (We stop at the
    // load round-trip rather than driving a real browser — the load branch is
    // what this test pins; the browser dispatch itself is exercised live.)
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_snapshot"] }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: final answer (no browser call, to keep the test hermetic).
    setEchoToolCallingResponse({
      provider,
      text: "Browser tools are ready.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "get ready to browse", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Browser tools are ready.");
    // loadedTools is cleared on terminal completion.
    expect(finished.loadedTools).toBeUndefined();

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    // First model call: system prompt advertises the on-demand index with
    // browser_snapshot by name.
    const firstSystem = String(calls[0]!.find((m) => m.role === "system")?.content ?? "");
    expect(firstSystem).toContain("Tools available on demand");
    expect(firstSystem).toContain("browser_snapshot");

    // After the load, the second model call's message history carries the
    // load_tools tool result confirming the tool is now callable.
    const secondTurn = calls[1]!;
    const loadResult = secondTurn.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("callable directly")
    );
    expect(loadResult).toBeDefined();
    const envelope = JSON.parse(String((loadResult as { content: string }).content)) as {
      ok: boolean;
      loaded: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.loaded).toContain("browser_snapshot");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("browser_navigate seeds the deferred browser cluster live on the next turn and persists it on loadedTools", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    // strict so the turn-2 file_write gates, snapshotting loadedTools mid-task.
    const config = buildConfig(workspaceRoot, "chat-task-navigate-seeds");
    const provider = normalizeProvider(config.provider);

    // Turn 1: navigate WITHOUT any load_tools call.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_nav", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify({ url: "http://127.0.0.1:9/" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: file_write (core, strict → pauses) so the paused task row
    // exposes the persisted loadedTools.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "notes.txt", content: "seeded" }) } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 3 (resumed): final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Browsing session ready.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "open the page", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id, 10000);
    expect(paused.status).toBe("waiting_approval");
    // The whole browser cluster persisted onto the task after the navigate.
    expect(paused.loadedTools).toContain("browser_snapshot");
    expect(paused.loadedTools).toContain("browser_click");
    expect(paused.loadedTools).toContain("browser_type");

    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Browsing session ready.");
    // Cleared on terminal completion.
    expect(finished.loadedTools).toBeUndefined();

    // Provider tools array per call: deferred browser tools absent on the
    // navigate turn, live on the next turn, and still live on the resumed turn
    // (re-seeded from task.loadedTools).
    const toolNames = getEchoToolCallingToolNames();
    expect(toolNames.length).toBe(3);
    expect(toolNames[0]).toContain("browser_navigate");
    expect(toolNames[0]).not.toContain("browser_snapshot");
    expect(toolNames[1]).toContain("browser_snapshot");
    expect(toolNames[1]).toContain("browser_click");
    expect(toolNames[2]).toContain("browser_snapshot");

    // The seed leaves a trace entry so "why is this tool live?" is answerable.
    const { readTrace } = await import("../state");
    const seedTrace = readTrace(config.instance, task.id).find(
      (t) => t.message === "Deferred browser tools seeded by browser_navigate"
    );
    expect(seedTrace).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // create_agent approve/resume regression: the direct self tool routes
  // through the unchanged self.config approval branch. Approving the gate
  // must run the create_agent handler (agent row lands) and resume the loop.
  test("normal chat turn persists its final answer and the next turn replays it", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-normal-answer-history");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "General chat");
      return session.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "Section 413 has better sightlines than Cat2.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "is 413 better than Cat2?", { mode: "chat", chatSessionId: sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    // Exactly one durable assistant answer row (not a transcript/approval row).
    const answerRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(answerRows.length).toBe(1);
    expect(answerRows[0]!.content).toBe("Section 413 has better sightlines than Cat2.");
    expect(answerRows[0]!.taskId).toBe(task.id);
    expect(answerRows[0]!.kind).toBeUndefined();

    clearEchoToolCallingResponses();
    setEchoToolCallingResponse({
      provider,
      text: "Noted.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Turn 2 in the same session: the provider messages must replay the
    // prior turn's answer via priorChatMessages.
    const followUp = await submitTask(config, "ok thanks", { mode: "chat", chatSessionId: sessionId });
    const finishedFollowUp = await waitForTerminal(config, followUp.id);
    expect(finishedFollowUp.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    const lastTurn = calls[calls.length - 1]!;
    const replayed = lastTurn.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(replayed).toContain("Section 413 has better sightlines than Cat2.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The interrupt-context marker persisted on cancel must reach the model: the
  // turn AFTER a cancelled one replays "[Request interrupted by user]" via
  // priorChatMessages, so the model knows the prior response was stopped and
  // doesn't blindly re-attempt it. Mirrors Claude Code's interrupt injection.
  test("parent-delegated subagent with no chat session persists nothing", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-delegated-subagent");
    const provider = normalizeProvider(config.provider);

    const subagentId = await mutateState(config.instance, (state) => {
      const subagent = createSubagentRecord(state, {
        name: "researcher",
        prompt: "research subagent",
        toolsets: ["file"],
        systemPrompt: "You are a research subagent."
      });
      return subagent.id;
    });

    setEchoToolCallingResponse({
      provider,
      text: "Research complete: the answer is 42.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "research the question", { mode: "chat", subagentId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const messages = readState(config.instance).chatMessages.filter((m) => m.taskId === task.id);
    expect(messages.length).toBe(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // [SILENT] from a session-bound subagent persists NO summary chatMessage —
  // the suppression that holds for blocks/the legacy layer must also gate the
  // finalize persistence so a "nothing to report" watch run leaves no row.
  test("persistent context overflow exits gracefully with a partial result", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-exhaust");
    const provider = normalizeProvider(config.provider);

    // Two small tool turns first so the partial exit has prior work behind it.
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(workspaceRoot, `note${i}.md`), `note-${i} content`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_x${i}`, type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: `note${i}.md` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    // Every attempt of iteration 3's model call overflows (3 total attempts).
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);

    const task = await submitTask(config, "read the notes", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: context window exhausted)");
    expect(finished.summary).toContain("This is a partial result.");
    expect(finished.error).toBeUndefined();

    // 2 tool turns + 3 failed attempts, and no summary call after exhaustion.
    expect(getEchoToolCallingCalls().length).toBe(5);

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    expect(
      traces.some((t) => t.type === "warning" && /overflow persisted after 3 attempts/.test(t.message))
    ).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A provider can stream text before EVERY overflow failure. When the
  // attempts exhaust, the exit must settle the failed attempt's in-flight
  // assistant block (streaming:false) and drain queued flushes so the
  // discarded partial text can't land on the completed task.
  test("a stream that fails with overflow does not leak its partial text into the retry", async () => {
    const OVERFLOW_MESSAGE = "Error code 400: context_length_exceeded";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-stream-reset");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "stream-reset")
    );

    writeFileSync(join(workspaceRoot, "note.md"), "note content");
    // Attempt 1 streams partial text, then fails with overflow. The retry
    // narrates cleanly and calls a tool (so its narration settles as a
    // block); the final iteration completes the task.
    setEchoToolCallingFailure(OVERFLOW_MESSAGE, { streamTextBeforeFailure: "LEAKED-PARTIAL " });
    setEchoToolCallingResponse({
      provider,
      text: "Clean narration.",
      toolCalls: [
        { id: "call_s1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "note.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "Done.", toolCalls: [], finishReason: "stop" });

    const submitted = await submitChatMessage(config, session.id, { content: "read the note" });
    const finished = await waitForTerminal(config, submitted.taskId, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Done.");

    // No settled block carries the failed attempt's partial stream.
    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const assistantTexts = blocks.filter((b): b is typeof blocks[0] & { kind: "assistant_text" } =>
      b.kind === "assistant_text"
    );
    expect(assistantTexts.length).toBeGreaterThan(0);
    for (const block of assistantTexts) {
      expect(block.text).not.toContain("LEAKED-PARTIAL");
    }
    expect(assistantTexts.some((b) => b.text === "Clean narration.")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // In-turn compaction happy path. Token geometry under the echo provider
  // (32k window, high-water 27,200): the always-on tool schemas + system
  // prompt occupy ~15.4k tokens, so six ~2.2k-token read_skill results cross
  // the high-water mark before the 7th call — and pruning can't help (all
  // six results sit inside the elision layer's protected-recent window). The
  // loop must summarize the middle exchanges via ONE aux call, splice in the
  // marked summary message, protect the head and the recent tail, and keep
  // going to completion. The schema floor is pinned to FIXED_COMPACTION_CATALOG
  // (installed below) so the crossing geometry is decoupled from live
  // always-on catalog growth; toolsets are also disabled, and read_skill is in
  // the fixed catalog so the calls still dispatch.
  test("in-turn compaction respects the per-turn cap and proceeds without a third summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction-cap");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    const queueRead = (i: number): void => {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_c${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    };
    // Twelve ~2.2k-token reads. The high-water mark trips after every sixth
    // accumulated full result, so compactions land at iterations 7 and 10 —
    // three iterations apart, wide enough that the refill guard stays quiet
    // — and the third trigger at iteration 13 hits the cap.
    for (let i = 0; i < 12; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(8_372)}`);
      queueRead(i);
    }
    setEchoAuxTextResponse({ text: "SUMMARY-ONE" });
    setEchoAuxTextResponse({ text: "SUMMARY-TWO" });
    setEchoToolCallingResponse({
      provider,
      text: "Finished after two compactions.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "review every bulk skill", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Finished after two compactions.");
    // Exactly two aux summaries — the third trigger hit the cap and the
    // loop proceeded to the final call instead of summarizing again.
    expect(getEchoAuxTextRequests().length).toBe(2);
    expect(getEchoToolCallingCalls().length).toBe(13);

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const compactions = traces.filter(
      (t) => t.type === "warning" && /In-turn compaction replaced/.test(t.message)
    );
    expect(compactions.length).toBe(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // No aux model → compaction is impossible. Cheap pruning already failed
  // to bring the projection under the mark, so the loop must exit
  // gracefully with a partial result instead of failing the task.
  test("a persistent transient fault gives up after the retry cap and fails the task", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transient-cap");

    // 1 initial attempt + 2 retries = 3 total, all failing transiently.
    setEchoToolCallingFailure("connection reset by peer");
    setEchoToolCallingFailure("connection reset by peer");
    setEchoToolCallingFailure("connection reset by peer");

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("connection reset");
    // Exactly three provider calls: initial + 2 retries, then it gives up.
    expect(getEchoToolCallingCalls().length).toBe(3);

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const retries = traces.filter(
      (t) => t.type === "warning" && /Transient model-call fault; retrying/.test(t.message)
    );
    // Two retry warnings (one per extra attempt); the third failure exhausts
    // the budget and falls through to the hard-throw. Backoff base is 0ms for
    // tests, so both retries render "after 0ms" (the production base * 2^n curve
    // is a plain constant; only the attempt counter and cap matter here).
    expect(retries.length).toBe(2);
    expect(retries[1]!.message).toContain("after 0ms");
    expect(retries[1]!.message).toContain("attempt 2 of 2");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A transient failure that streamed partial text before erroring must have
  // that partial trimmed from partialSummary before the retry (mirrors the
  // overflow path's discard). Exercises the surfacedTextLen > 0 reset branch.
  test("without provider usage the trim path stays on the chars/4 estimate and never engages", async () => {
    const ELISION_MARKER =
      "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-usage-trim");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the no-trim geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Twelve modest reads (~880 tokens each). With echo reporting no usage the
    // calibration gap stays 0, so the only trim trigger is the chars/4 live
    // budget — and the accumulated transcript stays well under it (the budget
    // is 32,000 − 1,600 reserve − ~12,739 floor [12,207 pinned catalog + the
    // system-prompt slice] ≈ 17,661 tokens), so no
    // elision and no proactive compaction ever engages.
    for (let i = 0; i < 12; i++) {
      await seedBulkSkill(config, `chunk-skill-${i}`, `chunk-${i} ${"x".repeat(3_396)}`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_n${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `chunk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
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

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(13);
    for (const call of calls) {
      expect(call.some((m) => m.content === ELISION_MARKER)).toBe(false);
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("nextNavStallState", () => {
  // Convenience: thread a sequence of single-call iterations through the state
  // and return the running count after each one.
  function counts(steps: { name: string; url?: string }[]): number[] {
    let state = initialNavStallState();
    const out: number[] = [];
    for (const s of steps) {
      state = nextNavStallState(state, [s]);
      out.push(state.count);
    }
    return out;
  }

  test("repeated navigation to the SAME url climbs; page-actions reset", () => {
    expect(
      counts([
        { name: "browser_navigate", url: "https://a.com" }, // 0: first visit is progress
        { name: "browser_navigate", url: "https://a.com" }, // 1: repeat
        { name: "browser_navigate", url: "https://a.com" }, // 2: repeat
        { name: "browser_click" }, // 0: page-action resets
        { name: "browser_navigate", url: "https://a.com" } // 0: still in window but reset wins on the click line; new line is a repeat
      ])
    ).toEqual([0, 1, 2, 0, 1]);
  });

  test("navigating to a NEW url is progress and resets the count", () => {
    // Reload the same page twice (climb), then move to a fresh URL (reset).
    expect(
      counts([
        { name: "browser_navigate", url: "https://a.com" }, // 0
        { name: "browser_navigate", url: "https://a.com" }, // 1
        { name: "browser_navigate", url: "https://b.com" }, // 0: new URL
        { name: "browser_navigate", url: "https://c.com" } // 0: new URL
      ])
    ).toEqual([0, 1, 0, 0]);
  });

  test("a browser_console data extraction resets the count (the research pattern)", () => {
    // navigate -> console-extract -> navigate across DISTINCT pages never climbs:
    // a fresh URL is already progress, and the console reset reinforces it.
    expect(
      counts([
        { name: "browser_navigate", url: "https://a.com" }, // 0
        { name: "browser_console" }, // 0: progress
        { name: "browser_navigate", url: "https://b.com" }, // 0: new URL
        { name: "browser_console" }, // 0
        { name: "browser_navigate", url: "https://c.com" } // 0: new URL
      ])
    ).toEqual([0, 0, 0, 0, 0]);
    // A console extraction resets even a climbing reload count (the model pulled
    // data off the page — genuine progress), though the URL stays in the window.
    expect(
      counts([
        { name: "browser_navigate", url: "https://a.com" }, // 0
        { name: "browser_navigate", url: "https://a.com" }, // 1: repeat
        { name: "browser_navigate", url: "https://a.com" }, // 2: repeat
        { name: "browser_console" }, // 0: progress resets
        { name: "browser_navigate", url: "https://a.com" } // 1: still in window, repeat again
      ])
    ).toEqual([0, 1, 2, 0, 1]);
  });

  test("browser_snapshot is NEUTRAL — re-snapshotting the same page does NOT reset", () => {
    // The degenerate overflow incident: navigate then re-snapshot the same URL
    // repeatedly. Snapshot must not reset the stall, so the reload count climbs.
    expect(
      counts([
        { name: "browser_navigate", url: "https://a.com" }, // 0
        { name: "browser_snapshot" }, // 0 (neutral, count unchanged)
        { name: "browser_navigate", url: "https://a.com" }, // 1: repeat URL
        { name: "browser_snapshot" }, // 1 (neutral)
        { name: "browser_navigate", url: "https://a.com" } // 2: repeat URL
      ])
    ).toEqual([0, 0, 1, 1, 2]);
  });

  test("multiple tools in one iteration apply in order (last write wins on reset)", () => {
    // navigate (repeat) then click in the same turn nets a reset.
    let s = nextNavStallState({ count: 4, recentUrls: ["https://a.com"] }, [
      { name: "browser_navigate", url: "https://a.com" },
      { name: "browser_click" }
    ]);
    expect(s.count).toBe(0);
    // click then navigate-to-known ends at 1 (reset, then a repeat).
    s = nextNavStallState({ count: 4, recentUrls: ["https://a.com"] }, [
      { name: "browser_click" },
      { name: "browser_navigate", url: "https://a.com" }
    ]);
    expect(s.count).toBe(1);
  });

  test("oscillation between two URLs climbs to the threshold (the case guard 2 misses)", () => {
    // Alternating navigate targets keep the ACTION signature flipping so the
    // action-only guard resets every turn — but both URLs stay in the recent
    // window, so each navigation is a repeat and the stall climbs monotonically.
    let state = initialNavStallState();
    // Seed both URLs into the window first (two distinct first-visits).
    state = nextNavStallState(state, [{ name: "browser_navigate", url: "https://a.com" }]);
    state = nextNavStallState(state, [{ name: "browser_navigate", url: "https://b.com" }]);
    for (let i = 0; i < 8; i++) {
      const url = i % 2 === 0 ? "https://a.com" : "https://b.com";
      state = nextNavStallState(state, [{ name: "browser_navigate", url }]);
    }
    expect(state.count).toBeGreaterThanOrEqual(8);
  });

  test("a long run of DISTINCT urls never trips (the legitimate-research case)", () => {
    let state = initialNavStallState();
    for (let i = 0; i < 12; i++) {
      state = nextNavStallState(state, [{ name: "browser_navigate", url: `https://site.com/page-${i}` }]);
    }
    expect(state.count).toBe(0);
  });

  test("repeated browser_back oscillation climbs (back has no url of its own)", () => {
    let state = initialNavStallState();
    const out: number[] = [];
    for (let i = 0; i < 10; i++) {
      state = nextNavStallState(state, [{ name: "browser_back" }]);
      out.push(state.count);
    }
    // First back is the first visit of the back-sentinel (0), then it repeats.
    expect(out[0]).toBe(0);
    expect(out[8]).toBeGreaterThanOrEqual(8);
  });
});

// In-loop tool-result elision. A pure function over a messages array + budget,
// so a direct unit test is deterministic — no need to force a real provider
// overflow through the loop.
describe("elideOldToolResultsToBudget", () => {
  const ELISION_MARKER =
    "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";

  function bigToolResult(id: string, fill: string): ToolCallingMessage {
    return { role: "tool", tool_call_id: id, content: fill.repeat(400) };
  }

  test("no-op when already within budget", () => {
    const messages: ToolCallingMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "call_0", content: "small result" }
    ];
    const before = JSON.stringify(messages);
    expect(elideOldToolResultsToBudget(messages, 1_000_000)).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("shrinks oldest tool results first while protecting the most-recent six", () => {
    // Ten oversized tool results plus interleaving assistant rows. With a tiny
    // budget, the elidable set is everything but the most-recent six; the
    // helper walks oldest→newest until it fits.
    const messages: ToolCallingMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: null, tool_calls: [] });
      messages.push(bigToolResult(`call_${i}`, `X${i}-`));
    }

    const elided = elideOldToolResultsToBudget(messages, 100);
    expect(elided).toBeGreaterThan(0);

    const toolMessages = messages.filter((m) => m.role === "tool");
    // The four oldest tool results (10 total − 6 protected) are elided…
    for (let i = 0; i < 4; i++) {
      expect(toolMessages[i]!.content).toBe(ELISION_MARKER);
      // role + tool_call_id stay intact so codex call/output pairing survives.
      expect(toolMessages[i]!.tool_call_id).toBe(`call_${i}`);
    }
    // …and the most-recent six are never touched.
    for (let i = 4; i < 10; i++) {
      expect(toolMessages[i]!.content).not.toBe(ELISION_MARKER);
    }
  });

  test("never drops a message — only shrinks content", () => {
    const messages: ToolCallingMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      messages.push(bigToolResult(`call_${i}`, `Y${i}-`));
    }
    const lengthBefore = messages.length;
    elideOldToolResultsToBudget(messages, 50);
    expect(messages.length).toBe(lengthBefore);
  });

  test("leaves small tool results and non-tool messages alone", () => {
    // A short tool result (≤ 200 chars) isn't worth shrinking; assistant/user
    // rows are never elidable regardless of size.
    const messages: ToolCallingMessage[] = [
      { role: "assistant", content: "Z".repeat(5000), tool_calls: [] },
      { role: "tool", tool_call_id: "call_small", content: "tiny" },
      bigToolResult("call_big", "W-")
    ];
    elideOldToolResultsToBudget(messages, 10);
    expect(messages[0]!.content).not.toBe(ELISION_MARKER);
    expect(messages[1]!.content).toBe("tiny");
  });
});

// Group-aligned middle-span selection for in-turn compaction. Pure over a
// messages array, so the pairing/protection rules are pinned directly.
describe("compactionMiddleSpan", () => {
  const asst = (id: string, calls = 1): ToolCallingMessage => ({
    role: "assistant",
    content: null,
    tool_calls: Array.from({ length: calls }, (_, i) => ({
      id: `${id}_${i}`,
      type: "function" as const,
      function: { name: "t", arguments: "{}" }
    }))
  });
  const tool = (id: string): ToolCallingMessage => ({ role: "tool", tool_call_id: id, content: "r" });

  test("protects the head (initial messages + first exchange) and the recent-tail exchanges", () => {
    const messages: ToolCallingMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      asst("a"), tool("a_0"),
      asst("b"), tool("b_0"),
      asst("c"), tool("c_0"),
      asst("d"), tool("d_0"),
      asst("e"), tool("e_0")
    ];
    // initialCount=2 (system+user). Head also covers exchange a; tail keeps
    // exchanges d and e; middle = exchanges b and c (indices 4..8).
    expect(compactionMiddleSpan(messages, 2, 2)).toEqual({ start: 4, end: 8 });
  });

  test("keeps multi-result exchanges whole (group-aligned boundaries)", () => {
    const messages: ToolCallingMessage[] = [
      { role: "user", content: "u" },
      asst("a", 2), tool("a_0"), tool("a_1"),
      asst("b", 2), tool("b_0"), tool("b_1"),
      asst("c"), tool("c_0"),
      asst("d"), tool("d_0")
    ];
    // Middle = exchange b only (indices 4..7) — both of its tool results
    // travel with their assistant row.
    expect(compactionMiddleSpan(messages, 1, 2)).toEqual({ start: 4, end: 7 });
  });

  test("returns undefined when everything is protected", () => {
    const messages: ToolCallingMessage[] = [
      { role: "user", content: "u" },
      asst("a"), tool("a_0"),
      asst("b"), tool("b_0"),
      asst("c"), tool("c_0")
    ];
    expect(compactionMiddleSpan(messages, 1, 2)).toBeUndefined();
    expect(compactionMiddleSpan([], 0, 2)).toBeUndefined();
  });
});

describe("renderMessagesForCompaction", () => {
  test("renders roles, tool-call signatures, and content", () => {
    const rendered = renderMessagesForCompaction([
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "x", type: "function", function: { name: "file_read", arguments: '{"path":"a.md"}' } }]
      },
      { role: "tool", tool_call_id: "x", content: "file body" }
    ]);
    expect(rendered).toContain('assistant -> file_read({"path":"a.md"}): checking');
    expect(rendered).toContain("tool: file body");
  });

  test("caps oversized messages and the total input", () => {
    const big = "z".repeat(10_000);
    const rendered = renderMessagesForCompaction([{ role: "tool", tool_call_id: "x", content: big }]);
    expect(rendered.length).toBeLessThan(5_000);
    expect(rendered).toContain("[truncated]");

    const many = Array.from({ length: 30 }, (_, i): ToolCallingMessage => ({
      role: "tool",
      tool_call_id: `t${i}`,
      content: "y".repeat(9_000)
    }));
    const total = renderMessagesForCompaction(many);
    expect(total.length).toBeLessThan(70_000);
    expect(total).toContain("[remaining messages omitted from summary input]");
  });
});

// Provider usage records carry the real prompt size under different keys per
// provider family; the extractor must accept both and reject junk.
describe("promptTokensFromUsage", () => {
  test("reads input_tokens (anthropic/bedrock) and prompt_tokens (openai-compatible)", () => {
    expect(promptTokensFromUsage({ input_tokens: 1234 })).toBe(1234);
    expect(promptTokensFromUsage({ prompt_tokens: 567 })).toBe(567);
    // input_tokens wins when both are present (normalized Converse usage).
    expect(promptTokensFromUsage({ input_tokens: 10, prompt_tokens: 20 })).toBe(10);
  });

  test("rejects missing, non-numeric, and negative counts", () => {
    expect(promptTokensFromUsage(undefined)).toBeUndefined();
    expect(promptTokensFromUsage({})).toBeUndefined();
    expect(promptTokensFromUsage({ prompt_tokens: "9" })).toBeUndefined();
    expect(promptTokensFromUsage({ input_tokens: Number.NaN })).toBeUndefined();
    expect(promptTokensFromUsage({ input_tokens: -5 })).toBeUndefined();
  });
});

describe("buildAgentIdentity", () => {
  function makeToolset(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
    const at = "2026-05-19T00:00:00.000Z";
    return {
      id: `toolset_${name}`,
      instance: "test-instance",
      name,
      description: "",
      status,
      toolNames: [],
      scopes: ["task"],
      createdAt: at,
      updatedAt: at
    };
  }

  function makeState(toolsets: ToolsetRecord[]): RuntimeState {
    // Build on top of the canonical empty-state seed so this fixture
    // automatically inherits any new top-level RuntimeState field
    // without per-test churn. Override only the slices the
    // buildAgentIdentity tests actually exercise.
    const state = createEmptyState("test-instance");
    state.toolsets = toolsets;
    state.agents = [{
      id: "agent_x",
      instance: "test-instance",
      name: "alpha",
      status: "active",
      toolsets: [],
      messagingTargets: [],
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z"
    }];
    state.activeAgentId = "agent_x";
    return state;
  }

  const baseConfig: RuntimeConfig = {
    instance: "test-instance",
    port: 9999,
    token: "test",
    provider: { name: "echo", model: "test-model" },
    workspaceRoot: "/tmp/ws",
    stateRoot: "/tmp/state",
    logRoot: "/tmp/logs"
  };

  test("renders the actual enabled toolset names when the agent imposes no filter", () => {
    const state = makeState([
      makeToolset("file"),
      makeToolset("terminal"),
      makeToolset("memory"),
      makeToolset("disabled-thing", "disabled")
    ]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      autoMemory: true,
      warnings: []
      // no toolsetFilter — unrestricted
    };
    const identity: AgentIdentity = buildAgentIdentity(baseConfig, state, effective);
    // Disabled toolsets must NOT appear; enabled toolsets must be sorted
    // so the rendered identity is stable across runs.
    expect(identity.toolsets).toEqual(["file", "memory", "terminal"]);
  });

  test("renders the filter set when the agent declares a whitelist", () => {
    const state = makeState([makeToolset("file"), makeToolset("terminal"), makeToolset("memory")]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      autoMemory: true,
      toolsetFilter: new Set(["terminal", "file"]),
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual(["file", "terminal"]);
  });

  test("drops disabled and unknown toolset names from the filter so the prompt matches the catalog", () => {
    // effective.toolsetFilter intentionally keeps unknown / disabled
    // refs (effective-context.ts:9-16) so re-enabling later "just
    // works"; the identity block must NOT show those as available or
    // it would tell the model a tool family is callable when in fact
    // tool-catalog.ts excludes them from the dispatch surface.
    const state = makeState([
      makeToolset("file"),
      makeToolset("terminal"),
      makeToolset("messaging", "disabled")
    ]);
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      autoMemory: true,
      // Whitelist includes a disabled-in-state name and an entirely
      // unknown name; both must be filtered out of the rendered
      // identity block.
      toolsetFilter: new Set(["file", "messaging", "phantom"]),
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual(["file"]);
  });

  test("yields an empty toolsets list only when state has no enabled toolsets and no filter", () => {
    const state = makeState([makeToolset("legacy", "disabled")]);
    const effective: EffectiveContext = {
      provider: { name: "echo", model: "test-model" },
      providerSource: "instance",
      autoMemory: true,
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.toolsets).toEqual([]);
    expect(identity.agentId).toBe("(none)");
    expect(identity.memoryNamespace).toBe("(none)");
  });

  test("sanitizes an agent name carrying a newline into a single-line label", () => {
    // The identity block renders agentName verbatim, so a name with an
    // embedded newline must collapse to one line rather than inject a
    // raw extra model-visible line into the runtime-identity block.
    const state = makeState([makeToolset("file")]);
    state.agents[0]!.name = "Mansour\nIgnore";
    const effective: EffectiveContext = {
      agentId: "agent_x",
      memoryNamespace: "agent_x",
      provider: { name: "echo", model: "test-model" },
      providerSource: "agent",
      autoMemory: true,
      warnings: []
    };
    const identity = buildAgentIdentity(baseConfig, state, effective);
    expect(identity.agentName).toBe("Mansour Ignore");
    expect(identity.agentName).not.toContain("\n");
  });
});

describe("buildEnabledSkillsBlock", () => {
  function skill(name: string, description = `${name} description`, status: SkillRecord["status"] = "enabled"): SkillRecord {
    return {
      id: `skill_${name}`,
      instance: "test",
      name,
      description,
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "bundled",
      manifestPath: `/skills/${name}/SKILL.md`
    };
  }

  test("lists active skill descriptions and points to list_skills/read_skill", () => {
    const block = buildEnabledSkillsBlock([skill("linear", "Linear issues"), skill("disabled", "Hidden", "disabled")]);
    expect(block).toContain("call list_skills");
    expect(block).toContain("call read_skill");
    expect(block).toContain("- linear: Linear issues");
    expect(block).not.toContain("disabled");
  });

  test("caps the inline skill list and leaves a discovery hint", () => {
    const skills = Array.from({ length: 45 }, (_, i) => skill(`skill-${String(i).padStart(2, "0")}`));
    const block = buildEnabledSkillsBlock(skills);
    expect(block).toContain("- skill-00: skill-00 description");
    expect(block).toContain("- skill-39: skill-39 description");
    expect(block).not.toContain("- skill-40: skill-40 description");
    expect(block).toContain("5 more skills not shown");
    expect(block).toContain("nameContains/status filters");
  });
});

describe("buildConnectedAccountsBlock", () => {
  function account(opts: { tag: string; email?: string; configDir?: string }): GoogleAccount {
    return {
      id: `gacct_${opts.tag}`,
      tag: opts.tag,
      email: opts.email ?? `${opts.tag}@example.com`,
      configDir: opts.configDir ?? `/home/u/.gini/google-accounts/gacct_${opts.tag}`,
      addedAt: "2026-01-01T00:00:00.000Z"
    };
  }

  test("returns empty string when no accounts are registered", () => {
    expect(buildConnectedAccountsBlock([])).toBe("");
  });

  test("renders a single account's tag, email, and config dir plus the prefix guidance", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal", email: "me@gmail.com", configDir: "/home/u/.config/gws" })
    ]);
    expect(block).toContain("Registered Google accounts");
    expect(block).toContain("personal");
    expect(block).toContain("me@gmail.com");
    expect(block).toContain("/home/u/.config/gws");
    expect(block).toContain("GOOGLE_WORKSPACE_CLI_CONFIG_DIR");
    expect(block).toContain("use it");
  });

  test("surfaces both accounts, aggregate-on-read, and ask-on-write guidance when 2+ are registered", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal" }),
      account({ tag: "work" })
    ]);
    expect(block).toContain("personal");
    expect(block).toContain("work");
    // Unscoped reads fan out across every account instead of picking one.
    expect(block).toContain("EVERY registered account");
    // Writes still ask when no account is named.
    expect(block).toContain("ASK which account first");
  });

  test("shows the sign-in-pending placeholder for an account with no email yet", () => {
    const block = buildConnectedAccountsBlock([account({ tag: "school", email: "" })]);
    expect(block).toContain("school");
    expect(block).toContain("(sign-in pending)");
  });

  test("never asserts sign-in state and directs the model to verify before claiming it", () => {
    // The registry is presence-only — the block must not frame registration as
    // "connected" (the model would repeat that framing as per-account status
    // it never checked).
    for (const block of [
      buildConnectedAccountsBlock([account({ tag: "personal" })]),
      buildConnectedAccountsBlock([account({ tag: "personal" }), account({ tag: "work" })])
    ]) {
      expect(block).not.toContain("Connected Google accounts");
      expect(block).not.toContain("are connected");
      expect(block).not.toContain("is connected");
      // The verify-before-asserting instruction: sign-in status is NOT in this
      // list, check list_connectors, and route auth failures to reconnect.
      expect(block).toContain("does NOT include sign-in status");
      expect(block).toContain("list_connectors");
      expect(block).toContain("googleAccounts");
      expect(block).toContain("auth error");
      expect(block).toContain("Integrations page");
    }
  });
});

describe("buildInactiveSkillsBlock", () => {
  // Minimal SkillRecord factory. Only the fields the block builder
  // reads (name, description, status, requiredCredentials, source) carry
  // meaningful values; the rest are stubbed so the type checks. Skills now
  // declare credentials BY NAME; the block maps each name to its provider
  // (LINEAR_API_KEY → linear, google-workspace-oauth → google-oauth-desktop).
  function makeSkill(opts: {
    name: string;
    description?: string;
    requiredCredentials?: string[];
    status?: SkillRecord["status"];
    source?: SkillRecord["source"];
  }): SkillRecord {
    const at = "2026-05-19T00:00:00.000Z";
    return {
      id: `skill_${opts.name}`,
      instance: "test-instance",
      name: opts.name,
      description: opts.description ?? "(no description)",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: opts.status ?? "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      requiredCredentials: opts.requiredCredentials,
      source: opts.source
    };
  }

  test("routes the google-workspace-oauth credential to request_connector with the provider id", () => {
    // google-workspace-oauth maps to google-oauth-desktop. In hosted this
    // provider declares no setup skill (the credential is baked into the guest
    // at provisioning), so the block emits the bare request_connector shortcut
    // for the provider id — no read_skill / setup-skill detour.
    const skill = makeSkill({
      name: "google-calendar",
      description: "Google Calendar",
      requiredCredentials: ["google-workspace-oauth"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("google-oauth-desktop");
    expect(block).toContain("call `request_connector` with provider id `google-oauth-desktop`");
    // No setup skill is declared, so the block must not tell the model to
    // read_skill first.
    expect(block).not.toMatch(/read_skill/);
  });

  test("collapses multiple skills sharing one credential into a single line", () => {
    // All Google Workspace product skills share one credential — the block
    // should emit ONE provider line, not one per skill.
    const skills = [
      makeSkill({ name: "google-calendar", requiredCredentials: ["google-workspace-oauth"] }),
      makeSkill({ name: "google-gmail", requiredCredentials: ["google-workspace-oauth"] }),
      makeSkill({ name: "google-drive", requiredCredentials: ["google-workspace-oauth"] })
    ];
    const block = buildInactiveSkillsBlock(skills);
    const providerLines = block.split("\n").filter((line) => line.includes("google-oauth-desktop"));
    expect(providerLines).toHaveLength(1);
    expect(providerLines[0]).toContain("google-calendar");
    expect(providerLines[0]).toContain("google-gmail");
    expect(providerLines[0]).toContain("google-drive");
    expect(providerLines[0]).toContain("call `request_connector` with provider id `google-oauth-desktop`");
  });

  test("falls back to request_connector guidance for providers without a setup skill", () => {
    // LINEAR_API_KEY → linear, which does not declare setupSkill, so the
    // block must emit the default request_connector instruction.
    const skill = makeSkill({
      name: "needs-linear",
      description: "Test skill that needs Linear.",
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("linear");
    expect(block).toContain("call `request_connector` with provider id `linear`");
    // Must NOT mention read_skill — no setup skill is declared.
    expect(block).not.toMatch(/read_skill/);
  });

  test("instructs a templateless request_connector for a credential with no registered provider", () => {
    // SOME_SERVICE_API_KEY maps to no provider module, so providerForCredential
    // falls back to the name itself. The block must NOT emit the bare
    // provider-id shortcut (there is no provider to connect) — it must tell the
    // model to call request_connector with the {name, type, skillId} shape so
    // the user can enter the secret in chat. The name is UPPER_SNAKE so the
    // inferred type is api-key.
    const skill = makeSkill({
      name: "needs-some-service",
      description: "Test skill that needs an unmapped credential.",
      requiredCredentials: ["SOME_SERVICE_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("SOME_SERVICE_API_KEY");
    expect(block).toContain('name: "SOME_SERVICE_API_KEY"');
    expect(block).toContain('type: "api-key"');
    expect(block).toContain(`skillId: "${skill.id}"`);
    // No provider-id shortcut and no read_skill dead-end for a name with no
    // registered provider.
    expect(block).not.toContain("call `request_connector` with provider id `SOME_SERVICE_API_KEY`");
    expect(block).not.toMatch(/read_skill/);
    expect(block).not.toContain("will be rejected");
  });

  // Minimal RuntimeState carrying only the connectors the block reads.
  function stateWithConnectors(connectors: RuntimeState["connectors"]): RuntimeState {
    return {
      version: 1,
      instance: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
      connectors, improvements: [], skillOutcomes: [], learningFindings: [],
      promotions: [], snapshots: [], tools: [], toolsets: [], subagents: [],
      mcpServers: [], messagingBridges: [], importReports: [], agents: [],
      activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
      jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
      runs: [], planSteps: [], usageLedger: []
    };
  }

  test("a disabled generic connector sharing the credential name still yields the api-key templateless line by NAME", () => {
    // Regression: a disabled/unhealthy "generic" connector row sharing the
    // credential name must NOT masquerade as the owning provider. The earlier
    // code returned the row's provider ("generic"), grouped under that key, and
    // emitted a bogus `{name:"generic", type:"oauth2"}` line. The line must name
    // the actual credential and be api-key (templateless is api-key only).
    const skill = makeSkill({
      name: "needs-some-service",
      requiredCredentials: ["SOME_SERVICE_API_KEY"]
    });
    const state = stateWithConnectors([
      {
        id: "id_generic_row",
        instance: "test",
        name: "SOME_SERVICE_API_KEY",
        provider: "generic",
        status: "disabled",
        scopes: [],
        secretRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        health: "unknown",
        source: "user"
      }
    ]);
    const block = buildInactiveSkillsBlock([skill], state);
    expect(block).toContain('name: "SOME_SERVICE_API_KEY"');
    expect(block).toContain('type: "api-key"');
    // Never the bogus generic/oauth2 line.
    expect(block).not.toContain('name: "generic"');
    expect(block).not.toContain('type: "oauth2"');
  });

  test("returns an empty string when no inactive-with-credential skills are present", () => {
    expect(buildInactiveSkillsBlock([])).toBe("");
    // Skills with no requiredCredentials are filtered out before the
    // grouping step.
    const skill = makeSkill({ name: "no-cred", requiredCredentials: [] });
    expect(buildInactiveSkillsBlock([skill])).toBe("");
  });

  test("opens with the dual-path intro so the model knows both routing options", () => {
    const skill = makeSkill({
      name: "needs-linear",
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toMatch(/^Skills below need an external connector\./);
    // Both request_connector routing options are advertised: a registered
    // provider id, and the templateless api-key {name, type:"api-key", skillId}
    // shape for a credential with no registered provider.
    expect(block).toContain("request_connector");
    expect(block).toContain("provider id");
    expect(block).toContain('{name, type:"api-key", skillId}');
  });

  test("emits no browser-shortcut directive for the Google Workspace credential", () => {
    // On hosted, the Google account is connected at sign-in through the host
    // and google-oauth-desktop declares no setup skill, so the Google credential
    // routes through the bare request_connector line — with no read_skill detour
    // and no "ONLY correct path" browser-shortcut directive.
    const skill = makeSkill({
      name: "google-calendar",
      requiredCredentials: ["google-workspace-oauth"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).toContain("google-oauth-desktop");
    expect(block).not.toContain("ONLY correct path");
    expect(block).not.toContain("browser_navigate");
    expect(block).not.toMatch(/read_skill/);
  });

  test("skips the no-browser-shortcut directive when no provider declares a setup skill", () => {
    // request_connector is the only path advertised when no setup skill is
    // declared, so the browser-shortcut directive is unnecessary noise.
    const skill = makeSkill({
      name: "needs-linear",
      requiredCredentials: ["LINEAR_API_KEY"]
    });
    const block = buildInactiveSkillsBlock([skill]);
    expect(block).not.toContain("ONLY correct path");
    expect(block).not.toContain("browser_navigate");
  });
});

describe("buildMcpServersBlock", () => {
  function stateWith(servers: RuntimeState["mcpServers"]): RuntimeState {
    return {
      version: 1,
      instance: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
      connectors: [], improvements: [], skillOutcomes: [], learningFindings: [],
      promotions: [], snapshots: [], tools: [], toolsets: [], subagents: [],
      mcpServers: servers, messagingBridges: [], importReports: [], agents: [],
      activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
      jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
      runs: [], planSteps: [], usageLedger: []
    };
  }

  function server(name: string, tools: Array<{ name: string }>): RuntimeState["mcpServers"][number] {
    return {
      id: `mcp_${name}`,
      instance: "test",
      name,
      command: "",
      args: [],
      envKeys: [],
      status: "configured",
      exposedTools: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      transport: "http",
      url: "https://example.test/mcp",
      tools
    };
  }

  test("returns empty string when no servers are configured", () => {
    expect(buildMcpServersBlock(stateWith([]))).toBe("");
  });

  test("lists tool names per server so the model has the full inventory", () => {
    // The inventory line is what lets the model reach for a tool the skill
    // never documented. Skills should not have to be re-edited every time
    // an MCP server adds a tool.
    const state = stateWith([
      server("linear", [
        { name: "list_issues" },
        { name: "save_issue" },
        { name: "list_initiatives" },
        { name: "extract_images" }
      ])
    ]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("- linear (4 tools)");
    expect(block).toContain("tools: extract_images, list_initiatives, list_issues, save_issue");
  });

  test("includes the default-yes posture instruction", () => {
    // Without this, the model treats the skill's documented tools as
    // exhaustive and refuses tasks for tools that actually exist on the
    // server's inventory list.
    const state = stateWith([server("linear", [{ name: "list_issues" }])]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("Do not refuse");
    expect(block).toContain("validation error on bad args");
  });

  test("omits the per-server inventory line when a server has no cached tools yet", () => {
    // Health probe hasn't populated tools yet — show the server but skip
    // the inventory line so we don't lie about emptiness. (The default-yes
    // posture sentence below still mentions the word `tools:`, so we
    // assert on the indented inventory line specifically.)
    const state = stateWith([server("linear", [])]);
    const block = buildMcpServersBlock(state);
    expect(block).toContain("- linear");
    expect(block).not.toMatch(/^ {2}tools:/m);
  });

  test("alphabetizes both servers and their tool name lists for determinism", () => {
    // Toolset hashes and prompt-cache stability depend on stable ordering
    // across boots even when the order tools were registered varies.
    const state = stateWith([
      server("zenith", [{ name: "z_one" }, { name: "a_two" }]),
      server("acme", [{ name: "c_one" }, { name: "a_two" }])
    ]);
    const block = buildMcpServersBlock(state);
    const acmeIdx = block.indexOf("- acme");
    const zenithIdx = block.indexOf("- zenith");
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(zenithIdx).toBeGreaterThan(acmeIdx);
    expect(block).toContain("tools: a_two, c_one");
    expect(block).toContain("tools: a_two, z_one");
  });
});

describe("buildSkillScriptsBlock", () => {
  // listEnabledSkillScripts statSyncs the real scripts/ dir under each
  // skill's manifestPath, so the seeded skills need real files on disk.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gini-skill-scripts-block-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedSkill(
    state: RuntimeState,
    name: string,
    scripts: string[],
    opts: { status?: SkillRecord["status"] } = {}
  ): void {
    const skillDir = join(dir, name);
    const scriptsDir = join(skillDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    for (const script of scripts) {
      writeFileSync(join(scriptsDir, script), "console.log('{}')");
    }
    state.skills.push({
      id: `skill_${name}`,
      instance: state.instance,
      name,
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: opts.status ?? "enabled",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "bundled",
      manifestPath: join(skillDir, "SKILL.md")
    });
  }

  test("returns empty string when no visible skill ships scripts", () => {
    const state = createEmptyState("test");
    seedSkill(state, "no-scripts", []);
    expect(buildSkillScriptsBlock(state, new Set(["no-scripts"]))).toBe("");
  });

  test("lists each visible skill's scripts, alphabetized by skill and script", () => {
    const state = createEmptyState("test");
    seedSkill(state, "bbb", ["alpha.sh"]);
    seedSkill(state, "aaa", ["two.ts", "one.ts"]);
    const block = buildSkillScriptsBlock(state, new Set(["aaa", "bbb"]));
    expect(block).toBe(
      [
        "Skill scripts (invoke with skill_run, never re-implement in terminal_exec; call list_skills/read_skill for omitted skills):",
        "- aaa: one, two",
        "- bbb: alpha"
      ].join("\n")
    );
  });

  test("caps the inline skill script list and leaves a discovery hint", () => {
    const state = createEmptyState("test");
    const names = new Set<string>();
    for (let i = 0; i < 45; i++) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      names.add(name);
      seedSkill(state, name, ["run.ts"]);
    }
    const block = buildSkillScriptsBlock(state, names);
    expect(block).toContain("- skill-00: run");
    expect(block).toContain("- skill-39: run");
    expect(block).not.toContain("- skill-40: run");
    expect(block).toContain("5 more skill script entries not shown");
    expect(block).toContain("call list_skills");
  });

  test("omits skills that are enabled but not visible (inactive connector)", () => {
    const state = createEmptyState("test");
    seedSkill(state, "visible", ["go.ts"]);
    seedSkill(state, "hidden", ["go.ts"]);
    const block = buildSkillScriptsBlock(state, new Set(["visible"]));
    expect(block).toContain("- visible: go");
    expect(block).not.toContain("hidden");
  });
});
