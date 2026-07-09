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

  // A provider-side transient fault (here the exact non-streamed Bedrock
  // InternalServerException prose) must retry the same way an OS timeout does —
  // it is classified by the provider's isRetryableProviderError, not the
  // client-fault markers, so this pins that the whole loop survives it.
  test("transient provider fault (Bedrock InternalServerException) retries with backoff then completes", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-ws-"));
    const config = buildConfig(workspaceRoot, "chat-task-transient-provider-retry");
    const provider = normalizeProvider(config.provider);

    // First attempt: a transient Bedrock 500. Second attempt: success.
    setEchoToolCallingFailure("The system encountered an unexpected error during processing. Try your request again.");
    setEchoToolCallingResponse({ provider, text: "Recovered after a Bedrock hiccup.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say hi", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id, 10000);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Recovered after a Bedrock hiccup.");
    expect(finished.error).toBeUndefined();
    // Exactly two provider calls: the failed attempt + the successful retry.
    expect(getEchoToolCallingCalls().length).toBe(2);

    const { readTrace } = await import("../state");
    const traces = readTrace(config.instance, task.id);
    const retries = traces.filter(
      (t) => t.type === "warning" && /Transient model-call fault; retrying/.test(t.message)
    );
    expect(retries.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // The streaming idle/stall timeout (provider.ts StreamIdleTimeoutError, whose
  // message carries the "stream idle timeout" marker) is also transient and must
  // be retried — this pins the reconciliation between the reader's thrown shape
  // and the retry classifier.
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
});