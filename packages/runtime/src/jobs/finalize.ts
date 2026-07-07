// Async finalizer for prompt-job runs. Runs whenever a Task that carries a
// jobId reaches a terminal status (completed | failed | cancelled). It
// flips the linked JobRunRecord from "running" to a terminal status,
// stamps lastSuccessAt/lastFailureAt on the parent JobRecord, and emits a
// job.run.completed/failed event.
//
// Lives in its own file (separate from src/jobs/index.ts) so src/agent.ts
// can import it without re-importing the rest of the jobs module — that
// reverse path would close a cycle (jobs/index.ts already imports
// submitTask from agent.ts).
//
// Idempotent: if the run is already terminal, this is a no-op.

import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { addAudit, appendEvent, appendLog, insertChatBlock, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { getOrCreateAgentChat, syncChatTaskResult } from "../execution/chat";
import { providerAuthFailureText, providerDisplayLabel, providerReauth } from "../provider";
import { isSilentReply } from "./silent";
// `sendMessagingOutput` is imported lazily inside the bridge-dispatch
// helpers to avoid closing a static import cycle. The runtime graph would be:
//   agent.ts -> jobs/finalize.ts -> integrations/messaging.ts -> agent.ts
// (messaging.ts imports submitTask from agent.ts). A static cycle here
// would defeat the deliberate split between agent.ts and jobs/finalize.ts —
// see the leaf-module comment at src/agent.ts:51-55 — so we defer the
// messaging import until call time. Module-init cost is unchanged; the
// dynamic import resolves to the already-loaded module the first time
// a dispatch helper runs.

// Human-readable degradation note naming the skipped recipe(s) + the remedy.
// Shared by the chat system_note and the bridge mirror so both surfaces carry
// the same wording.
function skillSkipNote(skips: Array<{ name: string; reason: string }>): string {
  const named = skips.map((s) => `${s.name} (${s.reason})`).join(", ");
  return `Heads up: this run could not use ${skips.length} attached skill recipe(s) — ${named}. Re-enable the skill or re-attach it via update_job to restore full behavior.`;
}

export async function finalizeJobRunFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!task.jobId) return;
  if (!isTerminalTaskStatus(task.status)) return;
  // Capture session/oneShot context inside the mutateState write so the
  // post-write chat sync uses the same view we used to flip the run.
  // `runFinalized` gates the dispatch tail: a repeat call (run already
  // terminal) must not re-deliver the reply to bridges. The run's fire-time
  // skill skips ride along so the post-write delivery can name the missing
  // recipe(s) on the chat + bridge surfaces.
  let chatSessionIdToSync: string | undefined;
  let runFinalized = false;
  let skillSkips: Array<{ name: string; reason: string }> | undefined;
  // Forward-to-Chat context (ADR chat-topics-tasks-subagents.md, "Jobs →
  // Topics"). Captured inside the write so the post-write forward uses the same
  // view we used to flip the run. When the job opted into forwardToChat, the
  // final answer materialized in the job's Topic is also surfaced in the owning
  // agent's Chat, tagged with the Topic.
  let forwardToChat = false;
  let forwardAgentId: string | undefined;
  let forwardTopicTitle: string | undefined;
  await mutateState(config.instance, (state) => {
    // Match the run by taskId first (most reliable), fall back to the
    // most recent running run for the job (covers older runs whose
    // taskId wasn't recorded yet).
    let run = state.jobRuns.find(
      (candidate) => candidate.jobId === task.jobId && candidate.taskId === task.id && candidate.status === "running"
    );
    if (!run) {
      run = state.jobRuns.find(
        (candidate) => candidate.jobId === task.jobId && candidate.status === "running"
      );
    }
    if (!run) return; // already finalized or never tracked
    runFinalized = true;
    // Capture the run's fire-time skill skips before we flip it terminal so
    // the post-write delivery can name the missing recipe(s).
    if (run.skillSkips && run.skillSkips.length > 0) skillSkips = run.skillSkips;
    const job = state.jobs.find((candidate) => candidate.id === task.jobId);
    const completedAt = now();
    if (task.status === "completed") {
      run.status = "completed";
      run.summary = task.summary;
      run.error = undefined;
    } else {
      run.status = "failed";
      run.summary = task.summary;
      run.error = task.error ?? (task.status === "cancelled" ? "Cancelled" : "Failed");
    }
    run.completedAt = completedAt;
    run.updatedAt = completedAt;
    if (run.taskId === undefined) run.taskId = task.id;
    if (job) {
      if (run.status === "completed") {
        job.lastSuccessAt = completedAt;
        job.lastError = undefined;
      } else {
        job.lastFailureAt = completedAt;
        job.lastError = run.error;
      }
      // One-shot reminders auto-pause after the FIRST terminal run (success
      // or failure). The user can resume manually through /jobs. Audit the
      // transition so the deactivation is traceable.
      if (job.oneShot === true && job.status === "active") {
        job.status = "paused";
        job.updatedAt = completedAt;
        addAudit(
          state,
          {
            actor: "runtime",
            action: "job.oneshot.completed",
            target: job.id,
            risk: "low",
            taskId: task.id,
            evidence: { runId: run.id, runStatus: run.status }
          },
          { jobId: job.id, agentId: job.agentId }
        );
      }
      // Stage the chat sync for after the write closes — calling another
      // mutateState (which syncChatTaskResult does) inside this one would
      // deadlock the state queue.
      if (job.chatSessionId) {
        chatSessionIdToSync = job.chatSessionId;
        // Stage the Topic → Chat forward when the job opted in. The Topic is
        // the dedicated job session; its title is the forward chip label, and
        // job.agentId resolves the owning agent's Chat after the write closes.
        if (job.forwardToChat === true && run.status === "completed" && job.agentId) {
          forwardToChat = true;
          forwardAgentId = job.agentId;
          forwardTopicTitle =
            state.chatSessions.find((s) => s.id === job.chatSessionId)?.title ?? job.name;
        }
      }
    }
    appendEvent(
      state,
      {
        kind: "job",
        action: run.status === "completed" ? "job.run.completed" : "job.run.failed",
        target: task.jobId!,
        jobId: task.jobId,
        taskId: task.id,
        risk: "low",
        summary: run.status === "completed" ? "Prompt job run completed." : "Prompt job run failed.",
        data: { runId: run.id, taskStatus: task.status }
      },
      { taskId: task.id, agentId: task.agentId ?? job?.agentId ?? run.agentId }
    );
  });

  if (!runFinalized) return;

  // Delivery policy for the fan-out gates below. "silent" skips EVERY
  // delivery surface (Topic → Chat forward, origin bridge mirror,
  // deliveryTargets) while keeping the in-thread materialization
  // (syncChatTaskResult) — the working thread is the run's journal. Defaults
  // to "always" (the pre-policy behavior) for records the one-time migration
  // missed, and for a job deleted between the write above and this read.
  const deliveryPolicy =
    readState(config.instance).jobs.find((candidate) => candidate.id === task.jobId)?.deliveryPolicy ?? "always";

  // Materialize the assistant chat message for jobs created via the
  // agent tool with a chat session. syncChatTaskResult is idempotent
  // (no-ops if the message already exists) and only writes for terminal
  // task states. Validate the session still exists BEFORE the sync so
  // a deletion mid-flight doesn't land an orphan ChatMessageRecord
  // (createChatMessage silently skips session linkage when the session
  // is missing — that path is exactly what we don't want here).
  // `liveSessionId` is the session the origin mirror may dispatch to;
  // it stays undefined for session-less jobs (POST /api/jobs, create_job
  // from a non-chat task) and for sessions deleted mid-flight.
  let liveSessionId: string | undefined;
  if (chatSessionIdToSync) {
    const sessionExists = readState(config.instance).chatSessions.some((s) => s.id === chatSessionIdToSync);
    if (!sessionExists) {
      appendLog(config.instance, "job.chat.session.vanished", {
        jobId: task.jobId,
        taskId: task.id,
        sessionId: chatSessionIdToSync
      });
    } else {
      liveSessionId = chatSessionIdToSync;
      try {
        await syncChatTaskResult(config, chatSessionIdToSync, task.id);
      } catch (error) {
        appendLog(config.instance, "job.chat.sync.error", {
          jobId: task.jobId,
          taskId: task.id,
          sessionId: chatSessionIdToSync,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      // Surface fire-time skill skips as ONE deterministic system_note in the
      // job thread, after the synced answer. This is the guaranteed (not
      // model-reliant) user-facing degradation signal for the web surface. Only
      // for a completed run — a failed run's own error already carries the
      // signal. Keyed to land in-thread after the answer; idempotent because
      // finalize early-returns once the run is terminal (so we run once).
      if (skillSkips && task.status === "completed") {
        try {
          insertChatBlock(config.instance, {
            kind: "system_note",
            sessionId: chatSessionIdToSync,
            text: skillSkipNote(skillSkips),
            taskId: task.id,
            runId: task.runId,
            ...(task.threadId != null ? { threadId: task.threadId } : {}),
            ...(task.parentBlockId != null ? { parentBlockId: task.parentBlockId } : {})
          });
        } catch (error) {
          appendLog(config.instance, "job.skill.skip.note.error", {
            jobId: task.jobId,
            taskId: task.id,
            sessionId: chatSessionIdToSync,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      // Topic → Chat forward (ADR chat-topics-tasks-subagents.md, "Jobs →
      // Topics"). When the job opted into forwardToChat, surface a render-only
      // copy of the final answer in the owning agent's Chat, tagged with the
      // job's Topic for a deep-link chip — instead of burying the job's reports
      // inside the user's conversation. The replay-authoritative answer already
      // landed in the Topic (syncChatTaskResult above). Empty / `[SILENT]`
      // replies forward nothing (resolveJobReplyText suppresses them).
      // Best-effort: a forward failure must never fail the job run.
      // A silent-policy job never forwards — the fan-out gate below.
      if (forwardToChat && forwardAgentId && deliveryPolicy !== "silent") {
        try {
          const forwardText = resolveJobReplyText(readState(config.instance), chatSessionIdToSync, task);
          if (forwardText !== undefined) {
            const chat = await getOrCreateAgentChat(config.instance, forwardAgentId);
            insertChatBlock(config.instance, {
              kind: "assistant_text",
              sessionId: chat.id,
              text: forwardText,
              streaming: false,
              taskId: task.id,
              runId: task.runId,
              agentId: forwardAgentId,
              forwardedFromTopicId: chatSessionIdToSync,
              forwardedFromTopicTitle: forwardTopicTitle ?? "Job"
            });
          }
        } catch (error) {
          appendLog(config.instance, "job.chat.forward.error", {
            jobId: task.jobId,
            taskId: task.id,
            topicId: chatSessionIdToSync,
            agentId: forwardAgentId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }
  // Delivery-policy gate: a silent job's terminal run (completed OR failed)
  // skips the remaining delivery fan-out entirely — no origin bridge mirror,
  // no deliveryTargets dispatch. The run's output already landed in the
  // job's (headless) working thread above; a silent watch surfaces findings
  // by spawning keyed child tasks, never by reporting.
  if (deliveryPolicy === "silent") return;
  // Mirror back to the originating bridge on every terminal status —
  // a failed scheduled "remind me in 20s" should still surface SOME
  // signal to the chat the user started in (the agent's error
  // summary is the best we have), otherwise the user just hears
  // silence and assumes the bot dropped the ball. The dispatch
  // helper itself filters out empty / `[SILENT]` content, so the
  // case where the synced assistant message is genuinely empty
  // (failed task with no error summary) still mirrors nothing.
  let mirroredBridgeId: string | undefined;
  if (liveSessionId) {
    mirroredBridgeId = await dispatchJobReplyToBridge(config, liveSessionId, task, skillSkips);
  }
  // Independently of the origin mirror, deliver the same reply to any
  // bridges the job names on its own deliveryTargets — the "send my
  // morning briefing to telegram" surface. This runs on EVERY terminal
  // finalize, including jobs with no chat session at all (the dispatcher
  // falls back to the task summary when no synced assistant message
  // exists).
  await dispatchJobReplyToDeliveryTargets(config, liveSessionId, task, mirroredBridgeId, skillSkips);
}

// The synced assistant message is the most recent one on the session
// keyed to this task; pick it up from chatMessages so we never
// accidentally re-dispatch an older turn.
function findSyncedAssistantMessage(state: RuntimeState, chatSessionId: string, task: Task) {
  return state.chatMessages
    .filter(
      (m) =>
        m.sessionId === chatSessionId &&
        m.taskId === task.id &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

// `[SILENT]` replies explicitly suppress bridge dispatch. The match
// honors the literal sentinel or a TRAILING `[SILENT]` line after a
// no-op preamble, but NOT a prefix — matching the suppression contract
// in src/execution/chat.ts and the system-prompt instruction at
// src/jobs/index.ts that tells the LLM to "respond with exactly
// [SILENT] and nothing else" (see src/jobs/silent.ts). A prefix match
// here would silently drop a legitimate reply like
// `"[SILENT] but here's an update"`, which is the exact failure
// mode the chat-side test pins against.
function suppressSilentReply(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text || text.length === 0) return undefined;
  if (isSilentReply(text)) return undefined;
  return text;
}

// Resolve the assistant reply text the origin mirror should dispatch,
// or undefined when nothing should be sent.
function resolveJobReplyText(state: RuntimeState, chatSessionId: string, task: Task): string | undefined {
  return suppressSilentReply(findSyncedAssistantMessage(state, chatSessionId, task)?.content);
}

// Reply text for deliveryTargets dispatch. Prefer the synced assistant
// chat message; when none exists — session-less jobs never sync one,
// and a vanished session or sync error leaves a sessionful job without
// one — mirror the content selection syncChatTaskResult
// (src/execution/chat.ts) applies. Completed runs deliver the task
// summary under exact-[SILENT] suppression; failed/cancelled runs are
// never suppressed (the chat-side contract honors [SILENT] only for
// successfully completed tasks) and fall through summary → error →
// currentStep, because failed tasks carry task.error rather than
// task.summary (src/agent.ts failTask) and would otherwise deliver
// nothing at all. Provider auth failures render the same actionable,
// provider-named line the chat surface shows.
function resolveJobDeliveryText(
  state: RuntimeState,
  chatSessionId: string | undefined,
  task: Task
): string | undefined {
  if (chatSessionId !== undefined) {
    const message = findSyncedAssistantMessage(state, chatSessionId, task);
    if (message) return suppressSilentReply(message.content);
  }
  if (task.status === "completed") return suppressSilentReply(task.summary);
  const text = task.authErrorProvider
    ? providerAuthFailureText(
        providerDisplayLabel(task.authErrorProvider),
        providerReauth(task.authErrorProvider)
      )
    : task.summary ?? task.error ?? task.currentStep ?? `Task is ${task.status}.`;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Returns the bridge id when the mirror send actually landed, undefined
// when the mirror was suppressed or failed — the deliveryTargets
// dispatcher seeds its dedupe set from this, so an explicitly-listed
// target still gets its own attempt when the mirror failed.
async function dispatchJobReplyToBridge(
  config: RuntimeConfig,
  chatSessionId: string,
  task: Task,
  skillSkips?: Array<{ name: string; reason: string }>
): Promise<string | undefined> {
  const state = readState(config.instance);
  const session = state.chatSessions.find((candidate) => candidate.id === chatSessionId);
  if (!session) return undefined;
  // Prefer outboundMirror (set on dedicated job sessions to keep
  // inbound routing keyed off the live channel session) and fall back
  // to source (set on live channel sessions where the two are the
  // same).
  const dispatchTo = session.outboundMirror ?? session.source;
  if (!dispatchTo) return undefined;
  // Bridge-dispatch only applies to telegram / discord sources. The
  // openclaw provenance source carries no live channel routing
  // (it's just a migration breadcrumb), so a job that landed on a
  // migrated chat has nowhere to mirror its assistant reply.
  if (dispatchTo.kind !== "telegram" && dispatchTo.kind !== "discord") return undefined;
  const replyText = resolveJobReplyText(state, chatSessionId, task);
  if (replyText === undefined) return undefined;
  // Append the one-line degradation note for bridge/CLI users when the run
  // skipped attachments — so the chat system_note isn't the only surface that
  // reports it. Only on a real (non-empty, non-[SILENT]) reply, which
  // resolveJobReplyText already guarantees.
  const bridgeText = skillSkips && skillSkips.length > 0
    ? `${replyText}\n\n${skillSkipNote(skillSkips)}`
    : replyText;
  try {
    const replyToMessageId = dispatchTo.lastInboundMessageId;
    const { sendMessagingOutput } = await import("../integrations/messaging");
    const record = await sendMessagingOutput(config, dispatchTo.bridgeId, {
      text: bridgeText,
      target: dispatchTo.target,
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {})
    });
    // sendMessagingOutput swallows Telegram/Discord API errors into the
    // outbound record (status "failed") instead of throwing — surface
    // those at the job level too, or a revoked token / deleted channel
    // would leave no trace beyond the outbound row.
    if (record.status === "failed") {
      appendLog(config.instance, "job.messaging.dispatch.error", {
        jobId: task.jobId,
        taskId: task.id,
        sessionId: chatSessionId,
        bridgeId: dispatchTo.bridgeId,
        kind: dispatchTo.kind,
        error: record.error ?? "messaging send returned status=failed"
      });
      return undefined;
    }
    return dispatchTo.bridgeId;
  } catch (error) {
    appendLog(config.instance, "job.messaging.dispatch.error", {
      jobId: task.jobId,
      taskId: task.id,
      sessionId: chatSessionId,
      bridgeId: dispatchTo.bridgeId,
      kind: dispatchTo.kind,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

// A delivery failure gets both a structured log line and an audit row —
// the audit trail is how the activity feed surfaces that a scheduled
// job's output never reached its named bridge (the same visibility
// contract as job.oneshot.completed). One row per failed target.
async function recordDeliveryFailure(
  config: RuntimeConfig,
  details: { jobId: string; taskId: string; target: string; bridgeId?: string; reason: string }
): Promise<void> {
  appendLog(config.instance, "job.delivery.target.error", {
    jobId: details.jobId,
    taskId: details.taskId,
    target: details.target,
    ...(details.bridgeId !== undefined ? { bridgeId: details.bridgeId } : {}),
    error: details.reason
  });
  await mutateState(config.instance, (state) => {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "job.delivery.failed",
        target: details.jobId,
        risk: "low",
        taskId: details.taskId,
        evidence: {
          target: details.target,
          ...(details.bridgeId !== undefined ? { bridgeId: details.bridgeId } : {}),
          reason: details.reason
        }
      },
      { jobId: details.jobId }
    );
  });
}

// Deliver the job's final reply to each bridge named on the job's own
// `deliveryTargets`. Runs on every terminal finalize: a job with a live
// chat session delivers the synced assistant reply; otherwise the task
// summary is delivered instead (see resolveJobDeliveryText). Entries
// are persisted as bridge ids by create_job/update_job, so the id tier
// matches first; the name/kind tiers remain for jobs saved before
// entries were normalized to ids, and for raw entries written through
// POST /api/jobs, which persists the strings unvalidated by design
// (src/jobs/index.ts keeps that path permissive). A fire-time miss
// therefore means the bridge was removed after the job was saved, or
// the entry never matched a bridge in the first place. Only telegram /
// discord bridges are dispatchable today; sendMessagingOutput picks the
// target itself (first agent-filter-permitted entry of
// bridge.deliveryTargets, else bridge.deliveryTargets[0], else the
// literal "local"). The bridge
// the origin mirror confirmed delivering to (`mirroredBridgeId`) is
// skipped, as are duplicate entries resolving to the same bridge.
// Resolution failures and send failures — thrown OR recorded as a
// status:"failed" outbound row, which is how sendMessagingOutput
// reports Telegram/Discord API errors — are logged and audited; a
// delivery problem must never fail the run.
async function dispatchJobReplyToDeliveryTargets(
  config: RuntimeConfig,
  chatSessionId: string | undefined,
  task: Task,
  mirroredBridgeId: string | undefined,
  skillSkips?: Array<{ name: string; reason: string }>
): Promise<void> {
  const state = readState(config.instance);
  const job = state.jobs.find((candidate) => candidate.id === task.jobId);
  if (!job || job.deliveryTargets.length === 0) return;
  const resolvedReply = resolveJobDeliveryText(state, chatSessionId, task);
  if (resolvedReply === undefined) return;
  // Append the same one-line degradation note bridge/CLI users get on the
  // origin mirror, so deliveryTargets recipients also see the skipped
  // recipe(s). resolveJobDeliveryText already suppressed empty / [SILENT].
  const replyText = skillSkips && skillSkips.length > 0
    ? `${resolvedReply}\n\n${skillSkipNote(skillSkips)}`
    : resolvedReply;
  // Seed the dedupe set with the bridge the origin mirror actually
  // delivered to. Seeding on confirmed success (not attempt) means an
  // explicitly-listed target still gets its own attempt when the
  // mirror failed.
  const dispatchedBridgeIds = new Set<string>();
  if (mirroredBridgeId !== undefined) dispatchedBridgeIds.add(mirroredBridgeId);
  // Restrict resolution to dispatchable kinds BEFORE the id → name →
  // kind tier chain — the same pre-filter parseDeliveryTargets
  // (src/execution/tool-dispatch.ts) applies at create/update — so a
  // legacy name entry can't first-match a non-dispatchable (e.g. demo)
  // bridge while a dispatchable bridge of the same name exists.
  const dispatchable = state.messagingBridges.filter(
    (candidate) => candidate.kind === "telegram" || candidate.kind === "discord"
  );
  for (const entry of job.deliveryTargets) {
    const lower = entry.toLowerCase();
    const bridge =
      dispatchable.find((candidate) => candidate.id === entry) ??
      dispatchable.find((candidate) => candidate.name.toLowerCase() === lower) ??
      dispatchable.find((candidate) => candidate.kind.toLowerCase() === lower);
    if (!bridge) {
      await recordDeliveryFailure(config, {
        jobId: job.id,
        taskId: task.id,
        target: entry,
        reason: "no dispatchable messaging bridge matches"
      });
      continue;
    }
    if (dispatchedBridgeIds.has(bridge.id)) continue;
    dispatchedBridgeIds.add(bridge.id);
    try {
      const { sendMessagingOutput } = await import("../integrations/messaging");
      const record = await sendMessagingOutput(config, bridge.id, { text: replyText });
      if (record.status === "failed") {
        await recordDeliveryFailure(config, {
          jobId: job.id,
          taskId: task.id,
          target: entry,
          bridgeId: bridge.id,
          reason: record.error ?? "messaging send returned status=failed"
        });
      }
    } catch (error) {
      await recordDeliveryFailure(config, {
        jobId: job.id,
        taskId: task.id,
        target: entry,
        bridgeId: bridge.id,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
