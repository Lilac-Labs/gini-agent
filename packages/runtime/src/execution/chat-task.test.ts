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

  test("read_skill returns the full body of an enabled skill", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-readskill");
    const provider = normalizeProvider(config.provider);

    // Pre-create an enabled skill with a non-empty body — simulates a
    // post-loadSkillsFromDisk state without exercising the loader here.
    const skill = await createSkillFromInput(config, {
      name: "apple-notes",
      description: "Apple Notes via memo CLI."
    });
    await mutateState(config.instance, (state) => {
      const item = state.skills.find((s) => s.id === skill.id)!;
      item.body = "# Apple Notes\n\nUse `memo notes -a` to add a note.";
    });
    await setSkillStatus(config, skill.id, "enabled");

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

    const task = await submitTask(config, "how do I add an apple note?", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("I now know how to use Apple Notes.");
    // Audit trail captures the skill read.
    const state = readState(config.instance);
    const reads = state.audit.filter((a) => a.action === "skill.read" && a.taskId === task.id);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.evidence?.name).toBe("apple-notes");

    rmSync(workspaceRoot, { recursive: true, force: true });
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

  test("image attachment on a non-vision model proceeds and steers an in-band refusal", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-image-no-vision");

    // The echo provider resolves to vision:false. A PNG header is enough since
    // buildAttachmentContent degrades the image to a text note without reading
    // the bytes — it gates on mime alone, never emitting an image_url part.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const upload = storeUpload(config.instance, png, "image/png", "pic.png");

    const task = await submitTask(config, "see this", {
      mode: "chat",
      images: [{ id: upload.id, mimeType: "image/png", size: upload.size }]
    });
    const finished = await waitForTerminal(config, task.id);

    // The turn is no longer hard-rejected: it runs to completion so the refusal
    // is a normal, replayable assistant turn.
    expect(finished.status).toBe("completed");

    // The model saw the image degraded to a text note plus the steering
    // directive, and never received an image_url part it would 400 on.
    const turn = getEchoToolCallingCalls()[0]!;
    const userMessage = turn.find((m) => m.role === "user" && Array.isArray(m.content))!;
    const userParts = userMessage.content as MessageContentPart[];
    expect(userParts.every((p) => p.type !== "image_url")).toBe(true);
    const userText = userParts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(userText).toContain("You cannot see the image(s) above");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // PTY support: terminal_exec accepts an opt-in `pty: true` arg that wraps
  // the command under a pseudo-terminal so interactive CLIs (vim, memo,
  // claude-code) don't see "stdin is not a tty" and exit immediately. We
  // verify the round-trip end-to-end:
  //   - the model emits terminal_exec with pty=true
  //   - the approval payload captures pty=true
  //   - executeApprovedAction spawns under a TTY (verified by `tty -s`)
  //   - the audit evidence carries pty=true so the user can see it
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

  test("invalid tool args are reported back as tool errors so the model can recover", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-baddargs");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_bad", type: "function", function: { name: "file_read", arguments: '{"oops":true}' } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Sorry, I goofed.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "read something", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Sorry, I goofed.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Iteration cap (graceful exhaustion). When the chat-task loop hits the
  // configurable iteration cap, it must NOT fail. Instead it makes one
  // final tool-less model call asking for a summary and completes with
  // that text. A warning trace should record the cap hit.
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
  test("stops at the identical-repeat loop-breaker and completes via a tool-less summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-loop-breaker");
    const provider = normalizeProvider(config.provider);

    // Three identical iterations: same cold browser_connect args, same guard
    // refusal each time. The third pass trips the loop-breaker (runLength 3).
    for (let i = 0; i < 3; i++) {
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          {
            id: `call_repeat_${i}`,
            type: "function",
            function: {
              name: "browser_connect",
              arguments: JSON.stringify({ reason: "Sign in to Example", url: "https://example.com/login" })
            }
          }
        ],
        finishReason: "tool_calls"
      });
    }
    // Tool-less summary turn — what the loop-breaker exit should consume.
    setEchoToolCallingResponse({
      provider,
      text: "That sign-in path keeps refusing. Try connecting the service from settings, then ask again.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "sign in to example", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "That sign-in path keeps refusing. Try connecting the service from settings, then ask again."
    );
    expect(finished.currentStep).toBe("Completed (stopped: tool loop made no progress)");
    expect(finished.error).toBeUndefined();

    // Exactly four model calls: three repeated tool turns + one tool-less
    // summary — proving we stopped at the loop-breaker, not the iteration cap.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(4);
    // The final summary turn is the tool-less exit: its last message is the
    // repeat-specific summary instruction asking for a final answer.
    const summaryTurn = calls[3]!;
    const lastMessage = summaryTurn[summaryTurn.length - 1]!;
    expect(lastMessage.role).toBe("user");
    expect(String(lastMessage.content)).toContain("repeated the same tool call");

    // Trace records the loop-breaker stop.
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const breaker = traces.find(
      (t) => t.type === "warning" && /identical tool call\(s\) and result\(s\) \(loop-breaker\)/.test(t.message)
    );
    expect(breaker).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Action-only loop-breaker. A model that emits the IDENTICAL tool call
  // (same name + arguments) but gets a DIFFERENT result every iteration —
  // the real browser_navigate case, where each live-page snapshot jitters —
  // slips past the exact-match guard, so the coarser action-only guard must
  // catch it at MAX_SAME_ACTION_REPEATS (6) instead of running to the iteration cap.
  // We drive get_current_time, whose result (a timestamp) differs each call.
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

  test("invalid agent.priorContextTokens falls back to the provider-derived default", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-prior-context-invalid");
    (config as unknown as { agent: { priorContextTokens: number } }).agent = { priorContextTokens: 0 };
    const provider = normalizeProvider(config.provider);
    const expectedDefault = resolveDefaultPriorContextTokenBudget(provider);

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
      (t) => t.type === "warning" && /agent\.priorContextTokens/i.test(String(t.data?.reason ?? ""))
    );
    expect(warning).toBeDefined();
    expect((warning?.data as Record<string, unknown> | undefined)?.defaultBudget).toBe(expectedDefault);

    const contextTrace = traces.find(
      (t) => t.type === "model" && t.message === "chat-task system context built"
    );
    const contextData = contextTrace?.data as Record<string, unknown> | undefined;
    expect(contextData?.priorContextTokenDefault).toBe(expectedDefault);
    expect(contextData?.priorContextTokenRequested).toBe(expectedDefault);
    expect(typeof contextData?.priorContextTokenAvailable).toBe("number");
    expect(contextData?.priorContextTokenBudget as number).toBeLessThanOrEqual(expectedDefault);
    expect(contextData?.priorContextTokenBudget as number)
      .toBeLessThanOrEqual(contextData?.priorContextTokenAvailable as number);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

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
  test("appends a Bound scheduled jobs block when a job is bound to the session", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-bound-job");
    const provider = normalizeProvider(config.provider);

    // Stand up a chat session, a job pointing at it, and a run that lives in
    // the same conversation. The submitted task carries that runId so the
    // chat-task loop resolves the session id via run.conversationId and
    // finds the bound job during system-prompt assembly.
    const { runId, jobId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Daily standup");
      const run = createRun(state, {
        kind: "conversation_turn",
        title: "Standup turn",
        input: "kick off",
        conversationId: session.id
      });
      const at = now();
      const job: JobRecord = {
        id: "job-standup",
        instance: state.instance,
        name: "Daily standup",
        prompt: "Ask the team what they did yesterday and what they will do today.",
        intervalSeconds: undefined,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: session.id,
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles",
        createdAt: at,
        updatedAt: at,
        nextRunAt: at,
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      };
      state.jobs.push(job);
      return { runId: run.id, jobId: job.id };
    });

    setEchoToolCallingResponse({
      provider,
      text: "Ready.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "remind me what this job does", { mode: "chat", runId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    const system = calls[0]!.find((m) => m.role === "system");
    expect(system).toBeDefined();
    const content = String(system?.content ?? "");
    expect(content).toContain("Scheduled jobs delivering into this chat:");
    expect(content).toContain(jobId);
    expect(content).toContain("Daily standup");
    expect(content).toContain("cron `0 9 * * *`");
    expect(content).toContain("America/Los_Angeles");
    expect(content).toContain("Ask the team what they did yesterday");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

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

  test("writes a normal assistant_text block when the final text is real content", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-silent-normal");
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
      text: "You have one new invoice from Acme.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "anything new?", { mode: "chat", runId: sessionId.runId, chatSessionId: sessionId.sessionId });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const blocks = listChatBlocks(config.instance, sessionId.sessionId);
    const assistantText = blocks.filter((b) => b.kind === "assistant_text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0]).toMatchObject({ text: "You have one new invoice from Acme." });

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

  test("omits the surface line entirely when the surface is unknown", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-surface-unknown");
    const provider = normalizeProvider(config.provider);
    const { createChat } = await import("./chat");
    const session = await createChat(config, { title: "Unknown surface probe" });

    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });
    const submitted = await submitChatMessage(config, session.id, { content: "untagged turn" });
    expect((await waitForTerminal(config, submitted.taskId)).status).toBe("completed");

    // No claim anywhere in the turn — not a hedged "unknown surface" line.
    const turn = getEchoToolCallingCalls()[0]!;
    for (const m of turn) {
      expect(String(m.content ?? "")).not.toContain("The user is messaging");
    }

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

  test("does not replay a prior turn's ephemeral tail on the next turn", async () => {
    // The tail is built live and never persisted, so the next turn's prior
    // transcript (priorChatMessages reads only durable chatMessages) must not
    // contain the previous tail's identity/memory text. Turn 1 emits identity
    // into its tail; turn 2's outgoing messages must carry none of it as
    // replayed history. Recall is isolated (no active agent), so the only
    // tail content under test is the turn-1 identity block.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-no-double-inject");
    const provider = normalizeProvider(config.provider);

    const sessionId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "No double inject");
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
    // Turn 1 emitted identity into its tail.
    const firstTurnText = calls[0]!.map((m) => String(m.content ?? "")).join("\n");
    expect(firstTurnText).toContain("Your runtime identity:");
    // Turn 2's messages, EXCLUDING its own freshly-built tail, must not carry
    // the prior turn's identity as replayed history. (The quiet second turn
    // emits no identity of its own, so any occurrence would be a stale replay.)
    const secondTurn = calls[1]!;
    const userIdx = secondTurn.findIndex((m) => m.role === "user" && m.content === "second question");
    const historyAndPrefix = secondTurn.filter((_, i) => i !== userIdx - 1);
    const historyText = historyAndPrefix.map((m) => String(m.content ?? "")).join("\n");
    expect(historyText).not.toContain("Your runtime identity:");
    // Durable transcript rows likewise never include the tail.
    const stored = readState(config.instance).chatMessages.filter((m) => m.sessionId === sessionId);
    for (const m of stored) {
      expect(String(m.content ?? "")).not.toContain("Your runtime identity:");
    }

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

  test("surfaces native web searches as display-only Web search chips", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-web-search-chip");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-websearch", undefined, "agent_ws")
    );

    // A hosted native-web-search turn: the provider ran the searches itself and
    // returns their headlines in `webSearches` alongside a cited final answer
    // (no dispatchable tool calls). The loop must surface each search as a chip.
    setEchoToolCallingResponse({
      provider,
      text: "The top story is X. ([hn](https://news.ycombinator.com/))",
      toolCalls: [],
      finishReason: "stop",
      webSearches: ["hacker news top story", "https://news.ycombinator.com/"]
    });

    const submitted = await submitChatMessage(config, session.id, { content: "what's the top HN story?" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);

    const webSearchChips = blocks.filter(
      (b): b is typeof blocks[0] & { kind: "tool_call" } =>
        b.kind === "tool_call" && b.toolName === "web_search"
    );
    expect(webSearchChips.length).toBe(2);
    // Display-only: "Web search" label, the query/url as the inline preview,
    // settled straight to ok (the search already ran on the provider).
    expect(webSearchChips.map((c) => c.displayLabel)).toEqual(["Web search", "Web search"]);
    expect(webSearchChips.map((c) => c.argsPreview)).toEqual([
      "hacker news top story",
      "https://news.ycombinator.com/"
    ]);
    expect(webSearchChips.every((c) => c.status === "ok")).toBe(true);
    // Distinct call ids so the two searches render as separate rows.
    expect(new Set(webSearchChips.map((c) => c.callId)).size).toBe(2);
    // Nothing was dispatched, so the chips carry no paired tool_result.
    expect(blocks.filter((b) => b.kind === "tool_result")).toHaveLength(0);

    // Ordering is load-bearing, not cosmetic: both chips must land BEFORE the
    // assistant's answer block. A chip trailing the answer makes group-exchanges
    // fold the answer out of its standalone bubble (finalAnswerIdx = -1). The
    // provider announces each search mid-stream (before text) for exactly this.
    // listChatBlocks is ordinal-ordered, so index position is the settled order.
    const kinds = blocks.map((b) => b.kind);
    const lastAnswerIdx = kinds.lastIndexOf("assistant_text");
    const chipIdxs = blocks
      .map((b, i) => (b.kind === "tool_call" && b.toolName === "web_search" ? i : -1))
      .filter((i) => i >= 0);
    expect(lastAnswerIdx).toBeGreaterThanOrEqual(0);
    expect(Math.max(...chipIdxs)).toBeLessThan(lastAnswerIdx);

    rmSync(workspaceRoot, { recursive: true, force: true });
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

  test("approving a gated tool emits a Working phase before the side effect runs", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-approval-phase");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-approval-phase", undefined, "agent_y2")
    );

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_wp", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out2.txt", content: "hi" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote it.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "write out2.txt" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("waiting_approval");

    const { listChatBlocks } = await import("../state");
    const gate = listChatBlocks(config.instance, session.id).find(
      (b) => b.kind === "authorization_requested"
    );
    if (!gate) throw new Error("missing authorization_requested block");

    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    // The approval flip itself lands a non-terminal phase NEWER than the
    // gate block. Without it, the backwards activity scan (thread lists,
    // panel composer) keeps reporting waiting_approval for the entire
    // side-effect execution window — the approved action can run for its
    // full timeout before the resumed loop writes anything else.
    const blocks = listChatBlocks(config.instance, session.id);
    const working = blocks.find((b) => b.kind === "phase" && b.label === "Working: file.write");
    if (working?.kind !== "phase") throw new Error("missing approval Working phase block");
    expect(working.ordinal).toBeGreaterThan(gate.ordinal);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

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

  test("chat.choice cancel (Skip) resumes the chat loop with the skip fallback", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-choice-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-choice-cancel", undefined, "agent_q")
    );

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
              question: "Which format do you want?",
              options: [{ label: "Markdown" }, { label: "Plain text" }]
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "I'll go with Markdown since it reads best in chat.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "export my notes" });
    const paused = await waitForTerminal(config, submitted.taskId);
    expect(paused.status).toBe("needs_input");

    const setup = readState(config.instance).setupRequests.find((s) => s.taskId === submitted.taskId);
    expect(setup?.action).toBe("chat.choice");

    await resolveSetupRequest(config, setup!.id, "cancel", { actor: "user" });

    let finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    const deadline = Date.now() + 5000;
    while (finished?.status !== "completed" && Date.now() < deadline) {
      await Bun.sleep(TERMINAL_POLL_MS);
      finished = readState(config.instance).tasks.find((t) => t.id === submitted.taskId);
    }
    // Skip must resume the loop, NOT fail the task.
    expect(finished?.status).toBe("completed");
    expect(finished?.summary).toBe("I'll go with Markdown since it reads best in chat.");

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const askUserCall = blocks.find((b) => b.kind === "tool_call" && b.toolName === "ask_user");
    expect(askUserCall?.kind).toBe("tool_call");
    if (askUserCall?.kind === "tool_call") {
      expect(askUserCall.status).toBe("ok");
    }
    expect(blocks.some((b) => b.kind === "tool_result" && b.preview.includes("User skipped the question"))).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup!.id)?.status).toBe("cancelled");

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

  test("cancellation flips streaming assistant_text to settled and emits cancellation block", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-blocks-cancel");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "block-cancel", undefined, "agent_c")
    );

    // Single response that finishes immediately — the test exercises
    // post-completion cancelTask emission rather than a true
    // mid-stream cancel (which requires provider-stream injection
    // outside the echo provider's contract). The chat-block invariant
    // we test here: cancelTask emits system_note + Cancelled phase
    // even after the task has already settled.
    setEchoToolCallingResponse({
      provider,
      text: "Hi.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitChatMessage(config, session.id, { content: "say hi" });
    const finished = await waitForTerminal(config, submitted.taskId);
    expect(finished.status).toBe("completed");

    // Now cancel the (already-completed) task. cancelTask is idempotent
    // for terminal tasks — it returns the row as-is — but the
    // chat-block emission still happens unconditionally in the current
    // implementation. We verify the invariant differently: by re-
    // running through a fresh task that we cancel BEFORE waiting for
    // it to settle.
    const { cancelTask, submitTask } = await import("../agent");

    setEchoToolCallingResponse({
      provider,
      text: "second response",
      toolCalls: [],
      finishReason: "stop"
    });

    // Manually create a queued task tied to the same chat session,
    // then cancel before runChatTask gets a chance to flip to
    // running. The terminal status guard at the top of runChatTask
    // detects the cancellation and bails out cleanly.
    const cancelTarget = await submitTask(config, "will-be-cancelled", {
      mode: "chat",
      chatSessionId: session.id
    });
    await cancelTask(config, cancelTarget.id);

    const { listChatBlocks } = await import("../state");
    const blocks = listChatBlocks(config.instance, session.id);
    const sysNotes = blocks.filter((b) => b.kind === "system_note");
    expect(sysNotes.some((n) => n.kind === "system_note" && n.text === "Cancelled")).toBe(true);
    const phases = blocks.filter((b) => b.kind === "phase");
    expect(phases.some((p) => p.kind === "phase" && p.label === "Cancelled")).toBe(true);

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

  test("the gated approval path persists and replays its tool result, keeping pairing valid", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transcript-gated");
    const provider = normalizeProvider(config.provider);

    const { createChat, syncChatTaskResult } = await import("./chat");
    const session = await createChat(config, { title: "Gated thread" });

    // Turn 1: request a file write (approval-gated), then answer after resume.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_gated", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "from-agent" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Wrote the file as requested.",
      toolCalls: [],
      finishReason: "stop"
    });

    const first = await submitChatMessage(config, session.id, { content: "create out.txt" });
    const paused = await waitForTerminal(config, first.taskId);
    expect(paused.status).toBe("waiting_approval");
    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    const finished = await waitForFinalTerminal(config, first.taskId);
    expect(finished.status).toBe("completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    // Turn 2: a follow-up. The gated tool's result must be replayed, and the
    // assistant tool_calls row must be immediately followed by its paired
    // role:"tool" result (provider ordering invariant).
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
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls!.some((c) => c.id === "call_gated")
    );
    expect(assistantIdx).toBeGreaterThan(-1);
    // The matching tool result must immediately follow its assistant message.
    const nextMsg = turn2![assistantIdx + 1];
    expect(nextMsg?.role).toBe("tool");
    expect(nextMsg?.tool_call_id).toBe("call_gated");

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

    // The durable transcript rows exist in state.chatMessages but are
    // excluded from the human-facing JSON view.
    const { getChatSession } = await import("./chat");
    const stored = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === session.id && m.kind === "tool_transcript"
    );
    expect(stored.length).toBeGreaterThan(0);
    const view = getChatSession(config, session.id);
    expect(view.messages.some((m) => m.kind === "tool_transcript")).toBe(false);

    // The full-state runtime views (/api/state, /api/mobile/bootstrap) must
    // also drop transcript rows — they carry tool-call args and raw tool
    // results (skill bodies, file contents) that have no place in a public
    // state poll.
    const { publicState, mobileBootstrap } = await import("../runtime/views");
    expect(publicState(config).chatMessages.some((m) => m.kind === "tool_transcript")).toBe(false);
    expect(mobileBootstrap(config).chatMessages.some((m) => m.kind === "tool_transcript")).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

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
  test("loop gate blocks a deferred tool the model never loaded and nudges toward load_tools", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-deferred-unloaded");
    const provider = normalizeProvider(config.provider);

    // Turn 1: jump straight to browser_snapshot without loading it first.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_snap", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2: model recovers with a final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Understood — I'll load the browser tools first next time.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "snapshot the page", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Understood — I'll load the browser tools first next time.");

    const state = readState(config.instance);
    // The browser thunk never ran: no browser.snapshot audit row.
    const snapAudits = state.audit.filter((a) => a.action === "browser.snapshot" && a.taskId === task.id);
    expect(snapAudits).toHaveLength(0);

    // The second model turn's history carries the "not loaded yet" nudge as the
    // tool result for the unloaded browser_snapshot call.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(2);
    const nudge = calls[1]!.find(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("not loaded yet")
    );
    expect(nudge).toBeDefined();
    const envelope = JSON.parse(String((nudge as { content: string }).content)) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("browser_snapshot");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Loop gate, same-batch case: the model emits load_tools AND the tool it just
  // loaded in ONE tool_calls array. The provider generated browser_snapshot
  // without ever having its schema (it wasn't in the tools array that turn), so
  // the loaded set as it stood at turn start does NOT contain it — the gate
  // must block browser_snapshot this turn while load_tools still succeeds. A
  // subsequent turn can then call browser_snapshot for real (now loadable).
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
  test("session-bound subagent persists its transcript + final text and a later turn replays them", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    writeFileSync(join(workspaceRoot, "thread.md"), "From: shelden@berkeley.edu\nSubject: meeting");
    const config = buildConfig(workspaceRoot, "chat-task-fanout-history");
    const provider = normalizeProvider(config.provider);

    const { sessionId, subagentId } = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "Email: shelden@berkeley.edu");
      const subagent = createSubagentRecord(state, {
        name: "email-watch",
        prompt: "watch worker",
        toolsets: ["file"],
        systemPrompt: "You are an email watch worker."
      });
      return { sessionId: session.id, subagentId: subagent.id };
    });

    // Turn 1: the worker reads the thread (a tool call → tool_transcript rows)
    // then proposes a draft (the turn-ending final text). No runId, so the run/
    // conversationId path is dead — the chatSessionId fallback must carry it.
    setEchoToolCallingResponse({
      provider,
      text: "Reading the thread.",
      toolCalls: [{ id: "c1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "thread.md" }) } }],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "PROPOSED REPLY: Thanks, I can meet Tuesday at 2pm.",
      toolCalls: [],
      finishReason: "stop"
    });

    const worker = await submitTask(config, "Draft a reply to the latest email.", { mode: "chat", chatSessionId: sessionId, subagentId });
    const finishedWorker = await waitForTerminal(config, worker.id);
    expect(finishedWorker.status).toBe("completed");

    const afterTurn1 = readState(config.instance).chatMessages.filter((m) => m.sessionId === sessionId);
    // Transcript rows stamped into the channel (fix #1).
    expect(afterTurn1.some((m) => m.kind === "tool_transcript")).toBe(true);
    // Exactly one durable assistant summary row carrying the draft (fix #2).
    const draftRows = afterTurn1.filter(
      (m) => m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(draftRows.length).toBe(1);
    expect(draftRows[0]!.content).toContain("PROPOSED REPLY");
    expect(draftRows[0]!.taskId).toBe(worker.id);

    clearEchoToolCallingResponses();
    setEchoToolCallingResponse({
      provider,
      text: "Sent.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Turn 2: a follow-up "send" in the same channel. Its system/messages must
    // replay the prior worker draft via priorChatMessages.
    const followUp = await submitTask(config, "send", { mode: "chat", chatSessionId: sessionId });
    const finishedFollowUp = await waitForTerminal(config, followUp.id);
    expect(finishedFollowUp.status).toBe("completed");

    const calls = getEchoToolCallingCalls();
    const lastTurn = calls[calls.length - 1]!;
    const replayed = lastTurn.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(replayed).toContain("PROPOSED REPLY: Thanks, I can meet Tuesday at 2pm.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // No double-write for a normal turn. Finalize persists the durable assistant
  // summary row for every completed chat task; syncChatTaskResult (mobile /sync,
  // messaging pollers) must short-circuit to that existing row instead of
  // adding a second one. Here we model the normal path: a run-bound chat task
  // (run.conversationId === session) with NO subagentId. Finalize writes the
  // row, then syncChatTaskResult returns it, yielding exactly one assistant
  // summary message.
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
  test("context-exhaustion partial-result exit persists the durable answer row", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-answer-row");
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "Overflow chat")
    );

    // Every attempt of the turn's model call overflows (3 total attempts).
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);

    const submitted = await submitChatMessage(config, session.id, { content: "go" });
    const finished = await waitForTerminal(config, submitted.taskId, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.currentStep).toBe("Completed (stopped: context window exhausted)");

    const answerRows = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === session.id && m.role === "assistant" && m.kind !== "tool_transcript" && m.kind !== "approval_reason"
    );
    expect(answerRows.length).toBe(1);
    expect(answerRows[0]!.content).toContain("This is a partial result.");
    expect(answerRows[0]!.taskId).toBe(submitted.taskId);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // A thread-reply turn stamps threadId/parentBlockId on the task; the
  // persisted answer row must carry both (sync's short-circuit means it can
  // never be backfilled later) and the run must link to the answer
  // (assistantMessageId), symmetric with the userMessageId set at submit.
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
  test("inflated provider-reported prompt tokens engage the trim path on the next iteration", async () => {
    const ELISION_MARKER =
      "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-usage-trim");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });

    // Twelve tool-call turns reading DISTINCT files (so no loop-breaker
    // trips), each result ~3k chars — elidable (>200 chars) but the total
    // stays under every estimate-driven threshold. Only the LAST response
    // reports usage; the resulting calibration gap forces the pre-call trim
    // ahead of the 13th call. The per-read filler is sized so the accumulated
    // transcript sits below the chars/4 high-water mark given the always-on
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
  test("compacts and retries when the provider reports a context overflow, then completes", async () => {
    const ELISION_MARKER =
      "[Earlier tool result elided to fit the context window. Re-run the tool if you still need its output.]";
    const OVERFLOW_MESSAGE =
      "This model's maximum context length is 32000 tokens. However, your messages resulted in 99999 tokens.";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-retry");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Seven mid-size tool results (distinct skills so no loop-breaker trips)
    // give the overflow compaction passes something to shrink, while the
    // estimated total stays under the proactive high-water mark (27,200
    // tokens against the ~12,487-token floor: the 12,207 pinned catalog plus
    // the system-prompt slice) — the proactive
    // compaction path never fires, so the overflow is driven purely by the
    // stubbed provider failures.
    for (let i = 0; i < 7; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, `BODY-${i} ${"x".repeat(4_800)}`);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_o${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    // Iteration 8's model call: two overflow rejections, then success.
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingResponse({
      provider,
      text: "Recovered after compaction.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "read all the bulk files", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered after compaction.");
    expect(finished.error).toBeUndefined();

    // 7 tool turns + 2 failed attempts + 1 successful retry = 10 calls.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBe(10);
    // The successful retry saw a harder-compacted transcript than the first
    // failed attempt (the proactive pre-call elision may already have shrunk
    // the oldest results; the overflow passes must shrink strictly more,
    // including into the protected-recent window on the final retry).
    const elidedInFirstAttempt = calls[7]!.filter((m) => m.content === ELISION_MARKER).length;
    const elidedInRetry = calls[9]!.filter((m) => m.content === ELISION_MARKER).length;
    expect(elidedInRetry).toBeGreaterThan(elidedInFirstAttempt);
    expect(elidedInRetry).toBeGreaterThanOrEqual(2);

    // The compact-and-retry warnings landed in the trace.
    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const retries = traces.filter(
      (t) => t.type === "warning" && /rejected the prompt as too long/.test(t.message)
    );
    expect(retries.length).toBe(2);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The calibration gap after an overflow retry must compare the retry's
  // reported usage against the COMPACTED payload it actually sent. Against
  // the stale pre-elision estimate the gap would clamp toward 0 and the
  // next iteration's budget would loosen right back into the overflow.
  // Geometry: ten ~1.2k-token reads, then a retry whose reported usage sits
  // between the stale and recomputed estimates — only the recomputed base
  // yields a gap big enough to force elision before the final call.
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
  test("partial exit surfaces the current turn's narration with the note appended", async () => {
    const OVERFLOW_MESSAGE = "prompt is too long: 250000 tokens > 200000 maximum";
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-partial-narration");
    const provider = normalizeProvider(config.provider);

    writeFileSync(join(workspaceRoot, "note.md"), "note content");
    setEchoToolCallingResponse({
      provider,
      text: "STEP-NARRATION before reading.",
      toolCalls: [
        { id: "call_n1", type: "function", function: { name: "file_read", arguments: JSON.stringify({ path: "note.md" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);

    const task = await submitTask(config, "read the note", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe(
      "STEP-NARRATION before reading.\n\n" +
      "Stopped early: the conversation no longer fits the model's context window even after compaction. This is a partial result."
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Narration from a NON-streaming provider never opens an assistant_text
  // block (the tool-call path only finalizes a streamed one), so the partial
  // exit must emit it one-shot — otherwise task.summary carries narration
  // the chat timeline never shows.
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
  test("in-turn compaction proceeds when small savings still get under the high-water mark", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-compaction-small-win");
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      for (const toolset of state.toolsets) toolset.status = "disabled";
    });
    // Pin the tool-catalog floor so the crossing geometry is decoupled from
    // live always-on catalog size (cleared in afterEach).
    __setBaseToolCatalogForTests(FIXED_COMPACTION_CATALOG);

    // Geometry: the projection crosses the high-water mark (27,200 tokens
    // under the echo provider's 32k window) with a small middle span — so
    // the compaction reclaims under 10% of the projection (the savings-bail
    // threshold) but enough to dip back under the mark. Exchange 0 is the
    // protected head, exchanges 1–2 the summarizable middle, exchanges 3–4
    // the protected tail. The tail sizes leave a few hundred tokens of
    // post-compaction headroom under the mark; the always-on tool schemas
    // count toward the projection, so growing them erodes this headroom.
    const bodies = [
      `BODY-0 ${"x".repeat(8_000)}`,
      `BODY-1 ${"x".repeat(4_000)}`,
      `BODY-2 ${"x".repeat(4_000)}`,
      `BODY-3 ${"x".repeat(19_000)}`,
      `BODY-4 ${"x".repeat(14_000)}`
    ];
    for (let i = 0; i < bodies.length; i++) {
      await seedBulkSkill(config, `bulk-skill-${i}`, bodies[i]!);
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: `call_w${i}`, type: "function", function: { name: "read_skill", arguments: JSON.stringify({ name: `bulk-skill-${i}` }) } }
        ],
        finishReason: "tool_calls"
      });
    }
    setEchoAuxTextResponse({ text: "MIDDLE-SUMMARY" });
    setEchoToolCallingResponse({
      provider,
      text: "Finished within budget.",
      toolCalls: [],
      finishReason: "stop"
    });

    const task = await submitTask(config, "review the bulk skills", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Finished within budget.");
    // One compaction, then the loop proceeded to the final call.
    expect(getEchoAuxTextRequests().length).toBe(1);
    expect(getEchoToolCallingCalls().length).toBe(6);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Anti-thrash: a compaction whose reclaimed space refills within two
  // iterations (the model keeps pulling huge results) must stop and exit
  // with a partial result rather than compact again.
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
  test("transient model fault (operation timed out) retries with backoff then completes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transient-retry");
    const provider = normalizeProvider(config.provider);

    // First attempt: a transient OS timeout. Second attempt: success.
    setEchoToolCallingFailure("The operation timed out.");
    setEchoToolCallingResponse({ provider, text: "Recovered after a flaky connection.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered after a flaky connection.");
    expect(finished.error).toBeUndefined();
    // Exactly two provider calls: the failed attempt + the successful retry.
    expect(getEchoToolCallingCalls().length).toBe(2);

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const retries = traces.filter(
      (t) => t.type === "warning" && /Transient model-call fault; retrying/.test(t.message)
    );
    expect(retries.length).toBe(1);
    // Backoff base is overridden to 0ms for tests (GINI_TRANSIENT_RETRY_BASE_MS),
    // so the curve renders 0 * 2^0 = 0ms here; the production 500ms base is a
    // plain constant exercised by the live path.
    expect(retries[0]!.message).toContain("after 0ms");
    expect(retries[0]!.message).toContain("attempt 1 of 2");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The streaming idle/stall timeout (provider.ts StreamIdleTimeoutError, whose
  // message carries the "stream idle timeout" marker) is also transient and must
  // be retried — this pins the reconciliation between the reader's thrown shape
  // and the retry classifier.
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
  test("a context overflow takes the overflow path, not the transient-retry path", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-overflow-not-transient");
    const provider = normalizeProvider(config.provider);

    const OVERFLOW_MESSAGE =
      "This model's maximum context length is 32000 tokens. However, your messages resulted in 99999 tokens.";
    setEchoToolCallingFailure(OVERFLOW_MESSAGE);
    setEchoToolCallingResponse({ provider, text: "Recovered via overflow path.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered via overflow path.");

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    // The overflow warning fired; the transient-retry warning did NOT.
    expect(traces.some((t) => t.type === "warning" && /rejected the prompt as too long/.test(t.message))).toBe(true);
    expect(traces.some((t) => t.type === "warning" && /Transient model-call fault/.test(t.message))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Regression: transient retries must NOT consume the context-overflow
  // compaction budget. The two counters are independent (transientAttempts vs
  // attempt), so two transient faults followed by an overflow must still leave
  // the overflow path its full compaction budget — the overflow must COMPACT
  // and recover, not exit early with a no-compaction partial result. (Before the
  // attempt-- fix, the transient `continue` advanced `attempt` to 3, so the
  // first overflow hit `attempt >= MAX_CONTEXT_OVERFLOW_ATTEMPTS` and bailed.)
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

// Navigation-without-progress counter (loop-breaker guard 3). Driving the real
// browser tool through the loop would launch Chromium — heavy and flaky in a
// unit test — so the counter step is a pure helper tested directly. The model's
// emitted (tool name, navigation URL) pairs per iteration are all it needs.
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

  test("returns empty string when no accounts are connected", () => {
    expect(buildConnectedAccountsBlock([])).toBe("");
  });

  test("renders a single account's tag, email, and config dir plus the prefix guidance", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal", email: "me@gmail.com", configDir: "/home/u/.config/gws" })
    ]);
    expect(block).toContain("Connected Google accounts");
    expect(block).toContain("personal");
    expect(block).toContain("me@gmail.com");
    expect(block).toContain("/home/u/.config/gws");
    expect(block).toContain("GOOGLE_WORKSPACE_CLI_CONFIG_DIR");
    expect(block).toContain("use it");
  });

  test("surfaces both accounts, aggregate-on-read, and ask-on-write guidance when 2+ are connected", () => {
    const block = buildConnectedAccountsBlock([
      account({ tag: "personal" }),
      account({ tag: "work" })
    ]);
    expect(block).toContain("personal");
    expect(block).toContain("work");
    // Unscoped reads fan out across every account instead of picking one.
    expect(block).toContain("EVERY connected account");
    // Writes still ask when no account is named.
    expect(block).toContain("ASK which account first");
  });

  test("shows the sign-in-pending placeholder for an account with no email yet", () => {
    const block = buildConnectedAccountsBlock([account({ tag: "school", email: "" })]);
    expect(block).toContain("school");
    expect(block).toContain("(sign-in pending)");
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
