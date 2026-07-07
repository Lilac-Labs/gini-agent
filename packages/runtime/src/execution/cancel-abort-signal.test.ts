// Regression tests for the per-turn AbortSignal (the #395 "full fix"):
// cancelTask aborts the in-flight model call at the source, so a turn cancelled
// mid-stream stops deterministically instead of running to the provider
// connection's natural end. Also covers the resume-path stuck-cursor finalize
// and the boot-time orphan heal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { cancelTask, decideApproval, submitTask } from "../agent";
import {
  closeAllMemoryDbs,
  createAuthorization,
  createChatSession,
  createTask,
  deleteChatSession,
  getMemoryDb,
  healOrphanedStreamingBlocks,
  insertChatBlock,
  isTerminalTaskStatus,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import { __inFlightSnapshot } from "./approval-execution";
import { __turnSnapshot } from "./turn-abort";
import {
  addMessagingBridge,
  checkMessagingBridge,
  resetMessagingDeps,
  setMessagingDeps
} from "../integrations/messaging";
import type { TelegramClient } from "../integrations/telegram";
import type { RuntimeConfig, TaskStatus } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevState: string | undefined;
let prevLog: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
const workspaceDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "gini-abort-ws-"));
  workspaceDirs.push(dir);
  return dir;
}

// Unique instance name per call. getMemoryDb caches the SQLite handle by
// instance, and afterEach deletes the state root; a fixed name reused across
// runs (e.g. `bun test --rerun-each`) would reopen a stale cached handle
// pointing at a deleted file (SQLITE_IOERR_VNODE / "no such savepoint"). A
// fresh name per test never collides with a cached handle.
let instanceCounter = 0;
function uniqueInstance(base: string): string {
  instanceCounter += 1;
  return `${base}-${instanceCounter}`;
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-abort-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  root = mkdtempSync(join(tmpdir(), "gini-abort-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  clearEchoToolCallingResponses();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  // Close cached SQLite handles before deleting the state root so a stale
  // handle can't outlive its file (the cache is keyed by instance name).
  closeAllMemoryDbs();
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  for (const dir of workspaceDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearEchoToolCallingResponses();
  // Drop any injected messaging client so it can't leak into another test.
  resetMessagingDeps();
});

function buildConfig(workspaceRoot: string, instance: string, approvalMode: "auto" | "strict" = "auto"): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? root,
    logRoot: process.env.GINI_LOG_ROOT ?? `${root}-logs`,
    approvalMode
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

describe("per-turn AbortSignal", () => {
  test("cancel aborts the in-flight model call at the source — the held call stops well before its full delay", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("abort-midcall"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "abort-midcall", undefined, "agent_a")
    );

    // A model call held open for a LONG delay that would (if it ran to
    // completion) resolve to a tool call. The abort must cut it short.
    const LONG_DELAY = 4000;
    setEchoToolCallingResponse(
      {
        provider,
        text: "",
        toolCalls: [
          { id: "call_would_run", type: "function", function: { name: "get_current_time", arguments: "{}" } }
        ],
        finishReason: "tool_calls"
      },
      undefined,
      { delayMs: LONG_DELAY }
    );

    const task = await submitTask(config, "do a slow thing", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");
    // The turn is registered in the abort registry while its model call is in
    // flight.
    await waitFor(() => __turnSnapshot(config.instance).some((e) => e.taskId === task.id));

    const cancelAt = Date.now();
    await cancelTask(config, task.id);
    // cancelTask flips status synchronously, so polling status is vacuous (it
    // would pass even if the held call kept spinning in the background). The
    // load-bearing observable is the turn-abort REGISTRY: runLoop releases its
    // entry only when the held model call actually returns/throws. With
    // source-level abort the held call rejects immediately, so the entry clears
    // well under the 4000ms delay. Without it, the entry lingers for the full
    // delay (verified: the test fails when the cancelTask→abort wiring is
    // reverted).
    await waitFor(() => !__turnSnapshot(config.instance).some((e) => e.taskId === task.id), LONG_DELAY - 500);
    const elapsed = Date.now() - cancelAt;
    expect(elapsed).toBeLessThan(LONG_DELAY - 1000);

    const finalStatus = readState(config.instance).tasks.find((t) => t.id === task.id)?.status;
    expect(finalStatus).toBe("cancelled");

    // The tool the held call would have produced must NEVER have been
    // dispatched — the model call was aborted before it returned the call.
    const blocks = listChatBlocks(config.instance, session.id);
    expect(blocks.some((b) => b.kind === "tool_call" && b.callId === "call_would_run")).toBe(false);
    // No assistant_text block left stuck streaming.
    expect(blocks.some((b) => b.kind === "assistant_text" && b.streaming)).toBe(false);
  });

  test("an aborted turn is cancelled, not failed, and records no provider auth failure", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("abort-not-failed"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "abort-not-failed", undefined, "agent_b")
    );
    setEchoToolCallingResponse(
      { provider, text: "I am answering slowly...", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 3000 }
    );

    const task = await submitTask(config, "answer slowly", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");
    await cancelTask(config, task.id);
    await waitFor(() => isTerminalTaskStatus(readState(config.instance).tasks.find((t) => t.id === task.id)?.status ?? "running"));

    const finished = readState(config.instance).tasks.find((t) => t.id === task.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.status).not.toBe("failed");
    // The abort must not be misread as an expired credential.
    expect(finished?.authErrorProvider).toBeUndefined();
    expect(Object.keys(readState(config.instance).providerAuthFailures ?? {})).toHaveLength(0);
  });

  test("healOrphanedStreamingBlocks settles a terminal task's stuck block but leaves running/queued and post-cutoff blocks alone", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("boot-heal"));
    const cutoff = "2026-06-17T12:00:00.000Z";
    const before = "2026-06-17T11:00:00.000Z"; // < cutoff
    const after = "2026-06-17T13:00:00.000Z"; // >= cutoff

    const setup = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "boot-heal", undefined, "agent_h");
      const mk = (id: string, status: TaskStatus): void => {
        const t = createTask(config.instance, "x", undefined, undefined, undefined, undefined, undefined, session.id);
        t.id = id;
        t.status = status;
        state.tasks.push(t);
      };
      mk("task_done", "completed");
      mk("task_running", "running");
      mk("task_waiting", "waiting_approval");
      return { sessionId: session.id };
    });

    // Helper to plant a streaming:true assistant_text block with a chosen
    // task_id and updated_at, bypassing the live emit path.
    const plant = (callIdMarker: string, taskId: string | null, updatedAt: string): string => {
      const block = insertChatBlock(config.instance, {
        kind: "assistant_text",
        text: `partial ${callIdMarker}`,
        streaming: true,
        sessionId: setup.sessionId,
        ...(taskId ? { taskId } : {})
      });
      // insertChatBlock stamps created_at/updated_at = now(); rewrite updated_at
      // directly so the cutoff predicate is exercised deterministically.
      getMemoryDb(config.instance).run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [updatedAt, block.id]);
      return block.id;
    };

    const doneBlock = plant("done", "task_done", before); // terminal + pre-cutoff → heal
    const waitingBlock = plant("waiting", "task_waiting", before); // waiting_approval + pre-cutoff → heal
    const orphanBlock = plant("orphan", "task_gone", before); // absent task + pre-cutoff → heal
    const nullBlock = plant("null", null, before); // no task + pre-cutoff → heal
    const runningBlock = plant("running", "task_running", before); // running → SKIP
    const recentBlock = plant("recent", "task_done", after); // terminal but post-cutoff → SKIP

    const tasksAtBoot = new Map(readState(config.instance).tasks.map((t) => [t.id, t.status]));
    const healed = healOrphanedStreamingBlocks(config.instance, cutoff, (taskId) => {
      if (taskId === null) return true;
      const status = tasksAtBoot.get(taskId);
      if (status === undefined) return true;
      if (status === "running" || status === "queued") return false;
      return isTerminalTaskStatus(status) || status === "waiting_approval";
    });
    expect(healed).toBe(4);

    const blocks = listChatBlocks(config.instance, setup.sessionId);
    const streamingOf = (id: string): boolean =>
      blocks.find((b) => b.id === id && b.kind === "assistant_text")?.kind === "assistant_text" &&
      (blocks.find((b) => b.id === id) as { streaming?: boolean }).streaming === true;
    expect(streamingOf(doneBlock)).toBe(false);
    expect(streamingOf(waitingBlock)).toBe(false);
    expect(streamingOf(orphanBlock)).toBe(false);
    expect(streamingOf(nullBlock)).toBe(false);
    // Running task's block and the post-cutoff block stay streaming.
    expect(streamingOf(runningBlock)).toBe(true);
    expect(streamingOf(recentBlock)).toBe(true);

    // Healed blocks preserve their partial text verbatim.
    const doneText = blocks.find((b) => b.id === doneBlock);
    expect(doneText?.kind === "assistant_text" && doneText.text).toBe("partial done");
  });

  test("resume-path finalize settles a stale streaming block left by a prior process before the resumed turn runs", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("resume-finalize"));
    const provider = normalizeProvider(config.provider);

    // Simulate a boot-resumed orphan: a top-level chat task left at status
    // "running" by a dead process, with a streaming:true assistant_text block
    // it never finalized. reconcileInFlightTasks re-dispatches such a task back
    // through runChatTask — which is what we invoke directly here.
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "resume-finalize", undefined, "agent_r");
      const t = createTask(config.instance, "resume me", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "running";
      t.mode = "chat";
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    const staleBlock = insertChatBlock(config.instance, {
      kind: "assistant_text",
      text: "half a sentence from the dead process",
      streaming: true,
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    // The resumed turn's model call answers immediately (no delay).
    setEchoToolCallingResponse({ provider, text: "Fresh answer.", toolCalls: [], finishReason: "stop" });

    const { runChatTask } = await import("./chat-task");
    await runChatTask(config, seeded.taskId);

    const blocks = listChatBlocks(config.instance, seeded.sessionId);
    // The stale pre-restart block must be settled (no longer streaming) with
    // its partial text preserved — not left as a perpetual stuck cursor.
    const stale = blocks.find((b) => b.id === staleBlock.id);
    expect(stale?.kind === "assistant_text" && stale.streaming).toBe(false);
    expect(stale?.kind === "assistant_text" && stale.text).toBe("half a sentence from the dead process");
    // And no assistant_text block is left streaming at all after the turn.
    expect(blocks.some((b) => b.kind === "assistant_text" && b.streaming)).toBe(false);
  });

  test("cancel denies only UNRESOLVED gated tool_call rows — a resolved one being settled by resume stays ok", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-resolved-skip"));

    // A task paused at waiting_approval whose toolCallState.pending holds two
    // gated calls: one already RESOLVED (result set — an approval that resolved
    // and whose row the resume path settled to `ok`, not yet cleared from the
    // snapshot) and one still UNRESOLVED. cancelTask must deny only the
    // unresolved one; re-flipping the resolved `ok` row to `denied` would
    // mislabel a tool that genuinely ran.
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-resolved-skip", undefined, "agent_s");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [
          { toolCallId: "call_resolved", toolName: "terminal_exec", approvalId: "authz_a", result: "ran ok" },
          { toolCallId: "call_unresolved", toolName: "terminal_exec", approvalId: "authz_b" }
        ]
      };
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    // The resolved call's row was already settled to `ok` by the resume path.
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo ok",
      argsFull: { command: "echo ok" },
      status: "ok",
      callId: "call_resolved",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });
    // The unresolved call's row is still running (genuinely awaiting approval).
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo wait",
      argsFull: { command: "echo wait" },
      status: "running",
      callId: "call_unresolved",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    const resolved = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_resolved");
    const unresolved = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_unresolved");
    // The resolved tool keeps its `ok` — not demoted to `denied` by the cancel.
    expect(resolved?.kind === "tool_call" && resolved.status).toBe("ok");
    // The genuinely-unresolved gated tool is settled to `denied`.
    expect(unresolved?.kind === "tool_call" && unresolved.status).toBe("denied");
  });

  test("cancel does NOT touch a tool whose approval already left pending — that row is owned by the execute/resume path", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-skips-approved"));

    // `approved` is set BEFORE the side effect runs, so it is not proof of
    // execution — the action may run or be skipped. cancelTask must therefore
    // NOT settle such a row at all (settling it `ok` would mislabel a
    // skipped/aborted action as success; settling it `denied` would mislabel a
    // completed one). It only denies still-`pending` gates; the row here is
    // left for executeApprovedAction (skip → denied) or resumeChatTask (ran →
    // ok) to settle. This test pins that cancelTask leaves the approved row
    // alone (it stays `running` — a later site settles it; the point is cancel
    // must not GUESS).
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-skips-approved", undefined, "agent_p");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      const auth = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo ran",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo ran", toolCallId: "call_approved" }
      });
      auth.status = "approved"; // resolved — no longer pending.
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [{ toolCallId: "call_approved", toolName: "terminal_exec", approvalId: auth.id }]
      };
      t.approvalIds.push(auth.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo ran",
      argsFull: { command: "echo ran" },
      status: "running",
      callId: "call_approved",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    const approved = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_approved");
    // cancelTask must not have GUESSED — it neither denied nor ok'd the row.
    expect(approved?.kind === "tool_call" && approved.status).not.toBe("denied");
    expect(approved?.kind === "tool_call" && approved.status).not.toBe("ok");
  });

  test("resumeChatTask settles an approved tool's row to ok even when the task was cancelled before re-entry", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("resume-after-cancel-ok"));

    // The side effect ran (resume is called WITH its result) but the task was
    // cancelled while it ran — so resumeChatTask bails on the terminal task. It
    // must still settle the tool_call row to `ok` (and surface the result),
    // because the loop won't re-enter to do it and cancelTask deliberately left
    // the approved row alone. Otherwise the row stays stuck `running` for a
    // tool that succeeded (issue #395).
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "resume-after-cancel-ok", undefined, "agent_r");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      // Already cancelled (the cancel landed while the side effect ran).
      t.status = "cancelled";
      t.mode = "chat";
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [{ toolCallId: "call_ran", toolName: "terminal_exec", approvalId: "authz_r" }]
      };
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo ran",
      argsFull: { command: "echo ran" },
      status: "running",
      callId: "call_ran",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    const { resumeChatTask } = await import("./chat-task");
    await resumeChatTask(config, seeded.taskId, "call_ran", "Command output: ran");

    const blocks = listChatBlocks(config.instance, seeded.sessionId);
    const ran = blocks.find((b) => b.kind === "tool_call" && b.callId === "call_ran");
    // The tool ran, so resume settles its row to `ok`, not left `running`.
    expect(ran?.kind === "tool_call" && ran.status).toBe("ok");
    // And the result is surfaced.
    expect(blocks.some((b) => b.kind === "tool_result" && b.callId === "call_ran")).toBe(true);
  });

  test("an approved terminal.exec aborted mid-run settles `denied`, never `ok` — a killed command is not a success", async () => {
    const workspace = makeWorkspace();
    const config = buildConfig(workspace, uniqueInstance("approved-abort-not-ok"), "strict");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "approved-abort-not-ok", undefined, "agent_k")
    );

    // The command writes a marker into the workspace, THEN sleeps. The marker
    // is proof the process actually spawned and `zsh -lc` began executing —
    // so polling for it before cancelling guarantees the abort lands in the
    // mid-run window (proc.kill → `winner === "aborted"`), not the pre-spawn
    // `signal.aborted` branch. Both branches settle `denied`, so without this
    // proof-of-spawn the test could silently pass via pre-spawn and never
    // exercise the mid-run kill it means to pin. The cwd is config.workspaceRoot.
    const marker = join(workspace, "spawned.marker");
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_sleep",
          type: "function",
          function: { name: "terminal_exec", arguments: JSON.stringify({ command: "touch spawned.marker; sleep 30" }) }
        }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "run a long command", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "waiting_approval");

    const approvalId = readState(config.instance).authorizations.find((a) => a.taskId === task.id && a.status === "pending")?.id;
    expect(approvalId).toBeDefined();

    // Approve WITHOUT awaiting: executeApprovedAction spawns the command and
    // blocks on it. We cancel only once the marker proves the proc spawned, so
    // the abort fires the claimed controller → `proc.kill()` → mid-run kill.
    const approving = decideApproval(config, approvalId!, "approve");
    // Proof-of-spawn: the registry claim happens BEFORE the spawn, so waiting
    // on __inFlightSnapshot alone could let the cancel land pre-spawn. The
    // marker file only exists once the shell actually ran.
    await waitFor(() => existsSync(marker));

    await cancelTask(config, task.id);
    // decideApproval returns at decision durability (execution detached),
    // so awaiting it does NOT mean the killed proc unwound — wait for the
    // abort's own observables: the terminal.exec_aborted audit row and the
    // gated row settling off `running`.
    await approving;
    await waitFor(() => isTerminalTaskStatus(readState(config.instance).tasks.find((t) => t.id === task.id)?.status ?? "running"));
    await waitFor(() =>
      readState(config.instance).audit.some((a) => a.action === "terminal.exec_aborted" && a.taskId === task.id)
    );
    await waitFor(() => {
      const row = listChatBlocks(config.instance, session.id).find(
        (b) => b.kind === "tool_call" && b.callId === "call_sleep"
      );
      return row?.kind === "tool_call" && row.status !== "running";
    });

    const blocks = listChatBlocks(config.instance, session.id);
    const sleepRow = blocks.find((b) => b.kind === "tool_call" && b.callId === "call_sleep");
    // The killed command must NOT read as a success. Before the fix the resume
    // terminal-bail hard-coded `ok`; now executeApprovedAction settles the
    // aborted row `denied` and never routes the abort-result through resume.
    expect(sleepRow?.kind === "tool_call" && sleepRow.status).toBe("denied");
    expect(sleepRow?.kind === "tool_call" && sleepRow.status).not.toBe("ok");
    // No tool_result block may surface the aborted command's output as a
    // completed result (resume's emitToolResult is skipped for the abort).
    expect(blocks.some((b) => b.kind === "tool_result" && b.callId === "call_sleep")).toBe(false);
    expect(readState(config.instance).tasks.find((t) => t.id === task.id)?.status).toBe("cancelled");

    // Pin that the MID-RUN kill path ran, not the pre-spawn branch: the mid-run
    // audit carries captured-output evidence (stdoutBytes) that the pre-spawn
    // emitTerminalAborted row (which sets spawnSkipped:true) never writes. This
    // makes the test fail if the abort ever regresses to landing pre-spawn.
    const abortedAudit = readState(config.instance).audit.find(
      (a) => a.action === "terminal.exec_aborted" && a.taskId === task.id
    );
    expect(abortedAudit).toBeDefined();
    expect((abortedAudit?.evidence as { spawnSkipped?: boolean } | undefined)?.spawnSkipped).toBeUndefined();
    expect((abortedAudit?.evidence as { stdoutBytes?: number } | undefined)?.stdoutBytes).toBeDefined();
  });

  test("an approved messaging.send aborted mid-send settles `denied`, never `ok` — the bridge swallows the AbortError but the signal still tells the truth", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("approved-msg-abort-not-ok"), "strict");

    // The telegram client holds the send open until the abort fires, then
    // throws an AbortError. sendMessagingOutput CATCHES that internally and
    // returns a `status: "failed"` record (it never rejects out), so the
    // messaging.send branch has no structural `winner === "aborted"` signal —
    // the only truthful signal is `signal.aborted`. This is the exact gap that
    // would otherwise let the killed send be painted `ok` by resume's terminal
    // bail (issue #395 follow-up).
    const heldClient: TelegramClient = {
      getMe: async () => ({ id: 11, is_bot: true, username: "ginibot" }),
      sendMessage: async (_chatId, _text, opts) => {
        const { promise, reject } = Promise.withResolvers<never>();
        const sig = opts?.signal;
        if (sig) {
          if (sig.aborted) reject(new DOMException("Aborted", "AbortError"));
          else sig.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }
        return promise;
      },
      sendChatAction: async () => true as const,
      sendPhoto: async () => ({ message_id: 2, date: 0, chat: { id: 1, type: "private" } }),
      getFile: async (fileId) => ({ file_id: fileId, file_unique_id: fileId, file_path: `photos/${fileId}.jpg` }),
      downloadFile: async () => new Uint8Array([1, 2, 3]).buffer,
      getUpdates: async () => []
    };
    setMessagingDeps({ telegramClientFactory: () => heldClient });

    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["chat_x"],
      botToken: "TOK"
    });
    // Health-check so the bridge is `configured` — sendMessagingOutput only
    // attempts a real send (status starts "sent") for a configured bridge.
    await checkMessagingBridge(config, bridge.id);

    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "approved-msg-abort-not-ok", undefined, "agent_m");
      const t = createTask(config.instance, "send a message", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      const auth = createAuthorization(state, {
        taskId: t.id,
        action: "messaging.send",
        target: bridge.id,
        risk: "high",
        reason: "Send a message",
        payload: { bridgeId: bridge.id, text: "ping", target: "chat_x", toolCallId: "call_msg" }
      });
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [{ toolCallId: "call_msg", toolName: "send_message", approvalId: auth.id }]
      };
      t.approvalIds.push(auth.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id, approvalId: auth.id };
    });
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "send_message",
      displayLabel: "Send a message",
      argsPreview: "ping",
      argsFull: { bridgeId: bridge.id, text: "ping", target: "chat_x" },
      status: "running",
      callId: "call_msg",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    // Approve WITHOUT awaiting: the send blocks on the held client. Cancel
    // once it is genuinely in flight so the abort fires the claimed controller.
    const approving = decideApproval(config, seeded.approvalId, "approve");
    await waitFor(() => __inFlightSnapshot(config.instance).some((e) => e.taskId === seeded.taskId));

    await cancelTask(config, seeded.taskId);
    // Same detached-approve contract as above: wait for the abort's own
    // observables (the messaging.send audit row + the gated row settle),
    // not the returned promise.
    await approving;
    await waitFor(() => isTerminalTaskStatus(readState(config.instance).tasks.find((t) => t.id === seeded.taskId)?.status ?? "running"));
    await waitFor(() =>
      readState(config.instance).audit.some((a) => a.action === "messaging.send" && a.taskId === seeded.taskId)
    );
    await waitFor(() => {
      const row = listChatBlocks(config.instance, seeded.sessionId).find(
        (b) => b.kind === "tool_call" && b.callId === "call_msg"
      );
      return row?.kind === "tool_call" && row.status !== "running";
    });

    const blocks = listChatBlocks(config.instance, seeded.sessionId);
    const msgRow = blocks.find((b) => b.kind === "tool_call" && b.callId === "call_msg");
    // The killed send must NOT read as a success even though the bridge
    // normalized the AbortError into a `status: "failed"` record.
    expect(msgRow?.kind === "tool_call" && msgRow.status).toBe("denied");
    expect(msgRow?.kind === "tool_call" && msgRow.status).not.toBe("ok");
    expect(blocks.some((b) => b.kind === "tool_result" && b.callId === "call_msg")).toBe(false);
    expect(readState(config.instance).tasks.find((t) => t.id === seeded.taskId)?.status).toBe("cancelled");
    // The messaging.send audit row carries the `aborted` marker so a
    // cancel-killed send is distinguishable from an ordinary delivery failure.
    const sendAudit = readState(config.instance).audit.find((a) => a.action === "messaging.send" && a.taskId === seeded.taskId);
    expect(sendAudit).toBeDefined();
    expect((sendAudit?.evidence as { aborted?: boolean } | undefined)?.aborted).toBe(true);
  });

  test("cancel denies a live pending gate even when a resolved row of the SAME task shares its deterministic callId", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-dup-callid"), "strict");

    // callId is non-unique within a task: the codex text-backstop synthesizes a
    // deterministic, content-derived id, so the SAME gated call re-emitted in a
    // later iteration of the SAME task carries the SAME callId — and the
    // earlier emission's resolved authorization row persists alongside the new
    // pending one. cancelTask must still deny the LIVE pending gate; subtracting
    // it just because a resolved sibling shares the id would leave the gate
    // card spinning after "Cancelled" (issue #395).
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-dup-callid", undefined, "agent_d");
      const t = createTask(config.instance, "re-run the same gated call", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      // Earlier emission: an APPROVED (resolved) authorization carrying callId X.
      const resolved = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo hi",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo hi", toolCallId: "call_textbackstop_dup" }
      });
      resolved.status = "approved";
      // Current emission: a PENDING authorization carrying the SAME callId X.
      const pending = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo hi",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo hi", toolCallId: "call_textbackstop_dup" }
      });
      // The loop snapshot also carries X as a still-pending entry (no result).
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 2,
        pending: [{ toolCallId: "call_textbackstop_dup", toolName: "terminal_exec", approvalId: pending.id }]
      };
      t.approvalIds.push(resolved.id, pending.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    // The live pending gate's running tool_call row (the one the user sees).
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo hi",
      argsFull: { command: "echo hi" },
      status: "running",
      callId: "call_textbackstop_dup",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    // The live gate is settled to `denied` (not left spinning) despite the
    // resolved sibling row sharing its callId.
    expect(toolCalls.some((b) => b.kind === "tool_call" && b.callId === "call_textbackstop_dup" && b.status === "denied")).toBe(true);
    expect(toolCalls.every((b) => b.kind === "tool_call" && b.status !== "running")).toBe(true);
    expect(readState(config.instance).tasks.find((t) => t.id === seeded.taskId)?.status).toBe("cancelled");
  });

  test("a duplicate Stop on an already-cancelled task does not append a second Cancelled block", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-duplicate-stop"), "auto");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "cancel-duplicate-stop", undefined, "agent_dup")
    );
    // A held model call so the first cancel lands on a genuinely-running turn.
    setEchoToolCallingResponse(
      { provider, text: "thinking...", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 2000 }
    );

    const task = await submitTask(config, "do a thing", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");

    // First Stop performs the cancel and emits the terminal "Cancelled" blocks.
    await cancelTask(config, task.id);
    await waitFor(() => !__turnSnapshot(config.instance).some((e) => e.taskId === task.id), 2000);
    const countCancelledPhases = (): number =>
      listChatBlocks(config.instance, session.id).filter((b) => b.kind === "phase" && b.label === "Cancelled").length;
    const countCancelledNotes = (): number =>
      listChatBlocks(config.instance, session.id).filter((b) => b.kind === "system_note" && b.text === "Cancelled").length;
    expect(countCancelledPhases()).toBe(1);
    expect(countCancelledNotes()).toBe(1);

    // A second Stop on the now-terminal task is a no-op: it must NOT append a
    // duplicate "Cancelled" system_note or phase.
    await cancelTask(config, task.id);
    await cancelTask(config, task.id);
    expect(countCancelledPhases()).toBe(1);
    expect(countCancelledNotes()).toBe(1);
  });

  // Interrupt-context marker: a cancelled chat turn persists a model-facing
  // user-role row so the NEXT turn's replay tells the model the prior response
  // was stopped by the user — matching Claude Code's [Request interrupted by
  // user] / [Request interrupted by user for tool use]. priorChatMessages reads
  // the durable chatMessages, so asserting on those rows is asserting on what
  // the next turn replays to the provider.
  const interruptMarkers = (instance: string, sessionId: string) =>
    readState(instance).chatMessages.filter(
      (m) =>
        m.sessionId === sessionId &&
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith("[Request interrupted by user")
    );

  test("cancelling a mid-stream turn persists a plain [Request interrupted by user] marker for the next turn", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-plain"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "interrupt-marker-plain", undefined, "agent_im")
    );
    // A held, tool-less model call so the cancel lands mid-stream (no tool use).
    setEchoToolCallingResponse(
      { provider, text: "answering slowly...", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 3000 }
    );

    const task = await submitTask(config, "tell me a long story", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");
    await cancelTask(config, task.id);
    await waitFor(() => !__turnSnapshot(config.instance).some((e) => e.taskId === task.id), 3000);

    const markers = interruptMarkers(config.instance, session.id);
    expect(markers.length).toBe(1);
    // Plain variant — no tool was in flight.
    expect(markers[0]?.content).toBe("[Request interrupted by user]");
    // Model-facing only: tagged tool_transcript so it's excluded from the human
    // chat views and never becomes the session summary.
    expect(markers[0]?.kind).toBe("tool_transcript");
    expect(markers[0]?.taskId).toBe(task.id);
    // It does NOT surface as a chat block in the UI stream (only the Cancelled
    // system_note/phase do).
    const blocks = listChatBlocks(config.instance, session.id);
    expect(blocks.some((b) => "text" in b && typeof b.text === "string" && b.text.startsWith("[Request interrupted"))).toBe(false);
  });

  test("cancelling a turn parked on an approval gate persists the [...for tool use] marker variant", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-tool"), "strict");
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "interrupt-marker-tool", undefined, "agent_it")
    );
    // The model asks to run a shell command — gates in strict mode, parking the
    // task at waiting_approval with a live tool gate. Cancelling there is a
    // tool-use interrupt.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_x", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hi" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "run echo hi", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "waiting_approval");
    await cancelTask(config, task.id);

    const markers = interruptMarkers(config.instance, session.id);
    expect(markers.length).toBe(1);
    expect(markers[0]?.content).toBe("[Request interrupted by user for tool use]");
  });

  // The mid-dispatch window (issue #395): a gate row already exists but the
  // loop hasn't yet persisted the task's `waiting_approval` status or its
  // tool-call snapshot, so the first-approximation signal (status / snapshot)
  // reads "no tool use" while a pending authorization proves otherwise.
  // cancelTask folds that pending-gate set into the variant choice, so the
  // marker is still `…for tool use`, not the plain one.
  test("cancelling in the mid-dispatch window (pending gate, not yet waiting_approval) still gets the [...for tool use] variant", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-middispatch"));
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "interrupt-marker-middispatch", undefined, "agent_md");
      const t = createTask(config.instance, "run a gated command", undefined, undefined, undefined, undefined, undefined, session.id);
      // Deliberately NOT waiting_approval and NO toolCallState snapshot — this
      // is exactly the window the first-approximation signal misses.
      t.status = "running";
      t.mode = "chat";
      // The only durable evidence a tool is in flight: a live pending gate row.
      const pending = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo hi",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo hi", toolCallId: "call_middispatch" }
      });
      t.approvalIds.push(pending.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    await cancelTask(config, seeded.taskId);

    const markers = interruptMarkers(config.instance, seeded.sessionId);
    expect(markers.length).toBe(1);
    expect(markers[0]?.content).toBe("[Request interrupted by user for tool use]");
  });

  // A NON-gated tool (file_read, web_fetch, browser_*, …) executes outside any
  // mutateState, between the loop committing a `running` recentToolCalls entry
  // and flipping it to done/error. It creates no gate row and never populates
  // toolCallState.pending, so the only in-state evidence it is mid-flight is the
  // `running` recentToolCalls entry. A cancel landing there must still get the
  // `…for tool use` variant — the plain marker would lose the tool-use nuance.
  test("cancelling during a non-gated tool's execution (running recentToolCall, no gate) gets the [...for tool use] variant", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-nongated"));
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "interrupt-marker-nongated", undefined, "agent_ng");
      const t = createTask(config.instance, "read a big file", undefined, undefined, undefined, undefined, undefined, session.id);
      // Mid-execution of a sync tool: running, no gate, no snapshot — only a
      // `running` recentToolCalls entry marks the in-flight tool.
      t.status = "running";
      t.mode = "chat";
      t.recentToolCalls = [
        { id: "call_fileread", name: "file_read", argsPreview: "big.md", status: "running", startedAt: new Date().toISOString() }
      ];
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    await cancelTask(config, seeded.taskId);

    const markers = interruptMarkers(config.instance, seeded.sessionId);
    expect(markers.length).toBe(1);
    expect(markers[0]?.content).toBe("[Request interrupted by user for tool use]");
  });

  // A completed (status:"done") recentToolCall is NOT in-flight: a tool that ran
  // earlier in the turn and finished, then the model streamed a text answer that
  // got cancelled, is a PLAIN interrupt — the tool wasn't running at cancel time.
  test("cancelling with only a completed recentToolCall (tool already finished) gets the plain variant", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-doneonly"));
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "interrupt-marker-doneonly", undefined, "agent_do");
      const t = createTask(config.instance, "read then answer", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "running";
      t.mode = "chat";
      t.recentToolCalls = [
        { id: "call_done", name: "file_read", argsPreview: "big.md", status: "done", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
      ];
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    await cancelTask(config, seeded.taskId);

    const markers = interruptMarkers(config.instance, seeded.sessionId);
    expect(markers.length).toBe(1);
    expect(markers[0]?.content).toBe("[Request interrupted by user]");
  });

  // deleteChatSession removes a session and its chatMessages but does not
  // cancel the session's in-flight tasks, so a task can be cancelled after its
  // session is gone. The marker write must skip in that case — createChatMessage
  // would otherwise push a row that links to no session, recreating the orphan
  // the delete just cleared (there is no orphan-chatMessages sweep to reclaim
  // it). The session-existence guard runs inside the same mutateState as the
  // delete, so the check is decisive.
  test("cancelling a task whose chat session was already deleted does NOT recreate an orphan marker", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-orphan"));
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "interrupt-marker-orphan", undefined, "agent_orph");
      const t = createTask(config.instance, "a turn that outlives its session", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "running";
      t.mode = "chat";
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    // Delete the session out from under the still-running task.
    await mutateState(config.instance, (state) => {
      deleteChatSession(state, seeded.sessionId);
    });

    await cancelTask(config, seeded.taskId);

    // No marker row was recreated for the deleted session.
    expect(interruptMarkers(config.instance, seeded.sessionId).length).toBe(0);
    // And no orphan chatMessage (one with no surviving session) leaked at all.
    const orphans = readState(config.instance).chatMessages.filter(
      (m) => !readState(config.instance).chatSessions.some((s) => s.id === m.sessionId)
    );
    expect(orphans.length).toBe(0);
  });

  test("a turn that completes normally does NOT get an interrupt marker", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("interrupt-marker-none"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "interrupt-marker-none", undefined, "agent_in")
    );
    // Fast, tool-less completion — never cancelled.
    setEchoToolCallingResponse({ provider, text: "done.", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "say done", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "completed");

    expect(interruptMarkers(config.instance, session.id).length).toBe(0);
  });
});
