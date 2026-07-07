// Shared resume-with-recovery helper for /connect-style flows.
//
// Background: after a /connect handler resolves an approval and
// performs its side effect, it must hand the outcome string back to
// the chat-task loop via resumeChatTask. That call flips the task
// status from waiting_approval to running and re-enters the chat
// loop. A throw inside that loop (model provider rate limit,
// dispatch error, downstream tool failure, etc.) leaves the task in
// status="running" with no live executor, no in-flight registry
// entry, and no scheduler to retry — orphaning it.
//
// Both runFillSecretConnect and runMessagingBridgeConnect need the
// same recovery: trace the failure, call failTask to flip the task
// out of the orphan-running state, and swallow any failTask throw
// since it's a best-effort recovery from an already-failed resume.
// This module is the single home for that shape so a future change
// (different trace category, different recovery primitive) lands in
// one place instead of being scattered across each /connect branch.

import type { AuditEvent, RuntimeConfig, RuntimeState, SetupRequest } from "../types";
import { failTask } from "../agent";
import { appendTrace, mutateState, readState } from "../state";
import { isChatTaskResumeInFlight, resumeChatTask } from "./chat-task";
import { approvalToolCallId } from "./tool-dispatch";

export interface SafeResumeOptions {
  // Human-readable origin string for the trace message
  // (e.g. "fill_secret", "messaging.add_bridge"). Goes into the
  // trace row's `message` field so operators debugging an orphaned
  // task can tell which /connect branch's resume threw.
  context: string;
  // Approval id the resume was completing. Threaded into trace
  // evidence for join-by-approval reconstruction.
  approvalId: string;
}

// Wrap resumeChatTask in the standard fail-recovery envelope. A
// throw from the chat-task loop traces the failure and triggers
// failTask so the task doesn't sit orphaned in "running". failTask's
// own throw is silently swallowed — the next external trigger
// (user message, supervisor reconcile) will see whatever status
// failTask managed to land and move on.
// Persist the outcome of a /connect-style side effect onto the
// approval row so a future reload of the resolved approval card
// renders the truthful past-tense summary. The React component
// keeps a sticky `setBridgeResultOk` for the in-session render,
// but that state evaporates on reload — without a persisted
// outcome, a failed addMessagingBridge that landed on a row whose
// status was already flipped to "approved" by resolveApproval will
// fall back to rendering as success and lie to the operator.
//
// Best-effort: a swallowed throw here is preferable to failing
// the entire /connect response (the side effect itself already
// happened — the outcome record is just a postscript).
export async function persistConnectOutcome(
  config: RuntimeConfig,
  approvalId: string,
  outcome: { ok: boolean; message?: string }
): Promise<void> {
  try {
    await mutateState(config.instance, (state) => {
      // Messaging connect actions are SetupRequests on the post-merge
      // model, so the outcome record lands on state.setupRequests
      // (the UI reads setup.connectOutcome via useSetupRequests()).
      const setupRequest = state.setupRequests.find((s) => s.id === approvalId);
      if (!setupRequest) return;
      setupRequest.connectOutcome = outcome;
      setupRequest.updatedAt = new Date().toISOString();
    });
  } catch {
    // Outcome persistence is a UI honesty postscript, not load-
    // bearing — swallow rather than failing the response.
  }
}

export async function safeResume(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  result: string,
  opts: SafeResumeOptions
): Promise<void> {
  try {
    await resumeChatTask(config, taskId, toolCallId, result);
  } catch (resumeError) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: `resumeChatTask threw during ${opts.context} completion`,
      data: {
        approvalId: opts.approvalId,
        toolCallId,
        error: resumeError instanceof Error ? resumeError.message : String(resumeError)
      }
    });
    try {
      await failTask(config, taskId, resumeError);
    } catch {
      // Best-effort recovery — leaving the task in whatever status
      // failTask managed to land is preferable to throwing on top of
      // the original failure.
    }
  }
}

// Settled-park heal. Every gate resolution persists its outcome FIRST and
// resumes the parked chat task through a DETACHED safeResume second — so a
// process death in between leaves a task parked (needs_input /
// waiting_approval) on gates that are all terminal. Nothing external will
// ever move that task again: /complete sees a non-pending row, a thread
// message finds no pending gate to answer, and the boot reconcile only
// claims running/queued orphans. This helper is the single idempotent
// recovery used by every entry point that can encounter the wedge (boot
// reconcile, a /complete replay on the settled row, a message posted into
// the wedged container): it re-checks the wedge signature from durable
// state, synthesizes each settled gate's tool result from its persisted
// outcome, and kicks the standard detached resume. Safe to call
// concurrently — resumeChatTask's park→running flip admits exactly one
// loop re-entry — and a live in-process resume (the normal answer flow
// between its gate claim and loop re-entry, or a double-answer race)
// declines the kick via the in-flight registry.
//
// Returns true when a resume was kicked; false when the task is not wedged
// (not parked, gates still pending, resume already in flight, or a gate
// whose outcome can't be accounted for — never guess a result).
export function resumeParkIfGatesSettled(config: RuntimeConfig, taskId: string): boolean {
  const state = readState(config.instance);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || (task.status !== "waiting_approval" && task.status !== "needs_input")) return false;
  if (isChatTaskResumeInFlight(config.instance, taskId)) return false;
  const hasPendingGate =
    state.setupRequests.some((s) => s.taskId === taskId && s.status === "pending") ||
    state.authorizations.some((a) => a.taskId === taskId && a.status === "pending");
  if (hasPendingGate) return false;
  const pending = task.toolCallState?.pending;
  if (!pending || pending.length === 0) return false;
  const kicks: Array<{ toolCallId: string; result: string; gateId: string }> = [];
  for (const entry of pending) {
    if (typeof entry.result === "string") continue;
    const settled = settledGateResult(state, taskId, entry.toolCallId);
    if (!settled) return false;
    kicks.push({ toolCallId: entry.toolCallId, ...settled });
  }
  if (kicks.length === 0) {
    // The crash landed between the resume's stage-1 result write and its
    // loop re-entry: every entry already carries its result. Re-kick with
    // the last entry — stageResume rewrites the same result and re-enters
    // once all are resolved.
    const last = pending[pending.length - 1]!;
    const gate = settledGateResult(state, taskId, last.toolCallId);
    kicks.push({ toolCallId: last.toolCallId, result: last.result as string, gateId: gate?.gateId ?? "" });
  }
  appendTrace(config.instance, taskId, {
    type: "task",
    message: "Resuming parked task whose gates are already settled",
    data: { toolCallIds: kicks.map((k) => k.toolCallId) }
  });
  // Detached like every gate resolution's resume; sequential so a multi-gate
  // park re-enters the loop exactly once, on the final result.
  void (async () => {
    for (const kick of kicks) {
      await safeResume(config, taskId, kick.toolCallId, kick.result, {
        context: "settled-park",
        approvalId: kick.gateId
      });
    }
  })();
  return true;
}

// Reconstruct the tool result a settled gate's dead resume would have
// carried. Chat-choice answers rebuild the exact live-path strings from the
// persisted connectOutcome; confirmation gates rebuild the unambiguous
// boolean; an approved Authorization is looked up in the audit trail — a
// side-effect row stamped with its approvalId proves execution (synthesized
// executed result + do-not-re-run), no row keeps an honest interrupted
// marker. Returns undefined for a gate whose outcome can't be accounted for.
function settledGateResult(
  state: RuntimeState,
  taskId: string,
  toolCallId: string
): { result: string; gateId: string } | undefined {
  const setup = state.setupRequests.find(
    (s) => s.taskId === taskId && approvalToolCallId(s.payload) === toolCallId
  );
  if (setup) {
    if (setup.status === "completed") return { gateId: setup.id, result: completedSetupResult(setup) };
    if (setup.status === "cancelled") return { gateId: setup.id, result: cancelledSetupResult(setup) };
    return undefined;
  }
  const auth = state.authorizations.find(
    (a) => a.taskId === taskId && approvalToolCallId(a.payload) === toolCallId
  );
  if (auth?.status === "approved") {
    // Execution is provable when it happened: every approved side-effect
    // executor writes its audit row stamped with the approvalId AT EXECUTION
    // time (terminal.exec, file.write, file.patch, browser.upload_file and
    // their _aborted variants), while authorization.*/setup.* rows are
    // decision-lifecycle bookkeeping. A matching side-effect row therefore
    // proves the action ran before the crash — synthesize the executed
    // result from its evidence so the resumed model never re-runs it.
    // Absence proves NOTHING (the audit write and the effect aren't strictly
    // atomic), so the no-row branch keeps the honest hedge.
    const executed = state.audit.find(
      (row) =>
        row.approvalId === auth.id &&
        !row.action.startsWith("authorization.") &&
        !row.action.startsWith("setup.")
    );
    if (executed) {
      return { gateId: auth.id, result: executedApprovedResult(executed) };
    }
    return {
      gateId: auth.id,
      result:
        "Approved, but the gateway restarted before this action's result was captured. " +
        "The action may or may not have executed — verify the current state before re-running it."
    };
  }
  return undefined;
}

// Truthful reconstruction for an approved action whose audit row proves it
// executed before the restart. The captured tool result died with the
// process, but the audit evidence carries the durable facts (exit code,
// output excerpts, byte counts) — surface those instead of hedging, and
// forbid a re-run so the resumed model never repeats the side effect.
function executedApprovedResult(row: AuditEvent): string {
  const evidence = row.evidence ?? {};
  const details: string[] = [];
  if (typeof evidence.exitCode === "number") details.push(`exit code ${evidence.exitCode}`);
  if (typeof evidence.beforeBytes === "number" && typeof evidence.afterBytes === "number") {
    details.push(`${evidence.beforeBytes} bytes before, ${evidence.afterBytes} bytes after`);
  }
  if (typeof evidence.stdout === "string" && evidence.stdout.length > 0) {
    details.push(`stdout:\n${evidence.stdout}`);
  }
  if (typeof evidence.stderr === "string" && evidence.stderr.length > 0) {
    details.push(`stderr:\n${evidence.stderr}`);
  }
  return [
    "Approved and executed before the gateway restarted; the captured result was lost. " +
      "Do NOT re-run this action — the audit record below confirms it already executed.",
    `Executed: ${row.action} — ${row.target}`,
    ...details
  ].join("\n");
}

function completedSetupResult(setup: SetupRequest): string {
  const outcome = typeof setup.connectOutcome?.message === "string" ? setup.connectOutcome.message : undefined;
  if (setup.action === "chat.choice") {
    // Rebuild the exact tool-result strings the live answer paths produce
    // ("User answered/selected: …") from the persisted outcome message
    // ("You answered/selected: …").
    if (outcome?.startsWith("You answered: ")) {
      return `User answered: "${outcome.slice("You answered: ".length)}"`;
    }
    if (outcome?.startsWith("You selected: ")) {
      const label = outcome.slice("You selected: ".length);
      const options = Array.isArray(setup.payload.options)
        ? (setup.payload.options as Array<{ label?: unknown; description?: unknown }>)
        : [];
      const match = options.find((o) => o && typeof o === "object" && o.label === label);
      const description = match && typeof match.description === "string" ? match.description : "";
      return `User selected: "${label}"${description ? ` — ${description}` : ""}`;
    }
    // Claimed but the crash beat the outcome persist — the answer itself is
    // unrecoverable. Say so instead of fabricating one.
    return "The user answered this question, but the gateway restarted before the answer was recorded. Ask again if you still need it.";
  }
  if (setup.action === "confirmation.request") return JSON.stringify({ confirmed: true });
  return (
    outcome ??
    `Setup request "${setup.target}" was completed, but the gateway restarted before its result reached this run. Verify the outcome before repeating any side effects.`
  );
}

// Mirrors resolveSetupRequest's cancel-path resume fallbacks (agent.ts): a
// cancelled resumable gate resumes with the same continuation contract
// whether the resume ran live or is being replayed after a restart.
function cancelledSetupResult(setup: SetupRequest): string {
  if (setup.action === "confirmation.request") return JSON.stringify({ confirmed: false });
  if (setup.action === "chat.choice") {
    return "User skipped the question. Continue with your best judgment, or explain what you need if you cannot proceed without an answer.";
  }
  return (
    `User canceled connector setup for ${setup.target}. ` +
    "Continue without that connector if possible. If the original request requires it, tell the user what input or connector is needed."
  );
}
