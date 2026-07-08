// Cron lifecycle tests. Pairs with src/http.test.ts (kept untouched) — same
// helpers, separate file to keep concerns siloed.
//
// What these cover (Plan B from the cron-hardening context):
// - paused jobs are not picked up by the scheduler tick
// - drift-free nextRunAt advance + missedRuns increment
// - overlap protection: a second scheduled run is skipped while the first
//   is still in-flight
// - prompt-job runs finalize asynchronously when the spawned task settles
// - manual run does not implicitly resume a paused job
// - removeJob cascade-deletes the JobRunRecords
// - replay against a removed job returns 404
// - intervalSeconds validation surfaces 400

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import "./hooks/builtins"; // populates the registry so create_job's preRunHook resolves isKnownHook("skill-script")
import { createHandler } from "./http";
import { removeJob, runDueJobs, runJobNow } from "./jobs";
import { advanceCronNextRunAt, createScheduledJob, rebindJobDelivery, updateJob } from "./jobs/index";
import { createChatMessage, createTask, mutateState, readState, upsertTask } from "./state";
import { dispatchToolCall } from "./execution/tool-dispatch";
import { syncChatTaskResult } from "./execution/chat";
import type { RuntimeConfig } from "./types";


describe("cron lifecycle", () => {
  test("scheduler skips paused jobs even when they're due", async () => {
    const config = testConfig("jobs-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused job", script: "echo ok", intervalSeconds: 1 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });

    // Force the job to be due in the past so the only thing keeping it
    // from running is its paused status.
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 5_000).toISOString();
    });

    await runDueJobs(config);
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(0);
  });

  test("runDueJobs advances nextRunAt drift-free and increments missedRuns", async () => {
    const config = testConfig("jobs-drift");
    const handler = createHandler(config);

    // intervalSeconds=10, set nextRunAt 25s in the past => the loop should
    // consume one interval (the run we claim) and skip 2 more, landing on
    // 5s in the future (3 total advances from -25 = +5). missedRuns counts
    // the *extra* skipped intervals (the consumed one is not a "miss").
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "drift job", script: "true", intervalSeconds: 10 })
    });
    const setupNow = Date.now();
    const dueAt = setupNow - 25_000;
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(dueAt).toISOString();
    });

    await runDueJobs(config);

    const after = readState(config.instance);
    const updated = after.jobs.find((candidate) => candidate.id === job.id)!;
    const runs = after.jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(1);
    // The advance loop walks: dueAt + 10s = -15s (still due, miss), -15 + 10
    // = -5s (still due, miss), -5 + 10 = +5s (future, stop). So missedRuns
    // should jump by 2 (the two extra advances).
    expect(updated.missedRuns).toBe(2);
    const newNextMs = new Date(updated.nextRunAt).getTime();
    expect(newNextMs).toBeGreaterThan(setupNow);
    // Sanity: the new nextRunAt must be on the original cadence — i.e.
    // (newNext - originalDue) is a positive multiple of the interval.
    const stepMs = 10_000;
    const delta = newNextMs - dueAt;
    expect(delta % stepMs).toBe(0);
    expect(delta / stepMs).toBe(3);
  });

  test("overlap protection: a second scheduled run is skipped while the first is in flight", async () => {
    const config = testConfig("jobs-overlap");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      // sleep 1 keeps the first run "running" while we try to claim a
      // second one. A bare `sleep 1` is enough on any Bun-supported host.
      body: JSON.stringify({ name: "overlap job", script: "sleep 1", intervalSeconds: 60, timeoutSeconds: 5 })
    });

    // Inject a fake running JobRunRecord directly so we don't have to race
    // a real `sleep 1`. The runJobNow with trigger=schedule must observe
    // the in-flight run and refuse to start a second one.
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: "jobrun_overlap_test",
        instance: state.instance,
        jobId: job.id,
        status: "running",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const result = await runJobNow(config, job.id, "schedule");
    expect(result).toBeUndefined();
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    // Still just the one fake "running" run we injected — no new run.
    expect(runs.filter((run) => run.id !== "jobrun_overlap_test")).toHaveLength(0);
    // And the runtime audited the skip.
    const audit = readState(config.instance).audit.find((event) => event.action === "job.run.skipped_overlap" && event.target === job.id);
    expect(audit).toBeDefined();
  });

  test("a due job fires even while its session has a live turn (deferral retired)", async () => {
    const config = testConfig("jobs-no-defer-live-turn");
    const handler = createHandler(config);

    const sessionId = "chat_defer_test";
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "watcher job", script: "true", intervalSeconds: 60 })
    });

    // Make the job chat-bound and due now, and inject a live (user-initiated)
    // turn for that session: a non-terminal task with no jobId. The job now
    // ALWAYS runs in its own Topic and forwards a single standalone block, so
    // there is no ordinal interleave to defer against (ADR
    // chat-topics-tasks-subagents.md, "Jobs → Topics").
    const dueAt = new Date(Date.now() - 5_000).toISOString();
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.chatSessionId = sessionId;
      item.nextRunAt = dueAt;
      const liveTurn = createTask(state.instance, "you can send", undefined, undefined, undefined, undefined, undefined, sessionId);
      liveTurn.status = "running";
      upsertTask(state, liveTurn);
    });

    await runDueJobs(config);

    // No longer deferred: the job claims and runs despite the live turn.
    const after = readState(config.instance);
    expect(after.jobRuns.filter((run) => run.jobId === job.id)).toHaveLength(1);
    expect(after.jobs.find((candidate) => candidate.id === job.id)!.nextRunAt).not.toBe(dueAt);
  });

  test("prompt-job run finalizes asynchronously when the task settles", async () => {
    const config = testConfig("jobs-async-prompt");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "prompt job", prompt: "summarize today", intervalSeconds: 60 })
    });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.taskId).toBeString();
    expect(result.runId).toBeString();

    // Run should be `running` immediately after submitTask returns — the
    // finalize step waits for the spawned task to settle.
    const inFlight = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(inFlight?.status).toBe("running");
    expect(inFlight?.taskId).toBe(result.taskId);

    await waitForTask(handler, config, result.taskId);
    // Give the finalize hook a beat to land — runTask awaits the
    // finalizer before returning, but the task watcher polls on its own.
    await waitFor(() => readState(config.instance).jobRuns.find((run) => run.id === result.runId)?.status === "completed", 2_000);

    const settled = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(settled?.status).toBe("completed");
    const settledJob = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(settledJob?.lastSuccessAt).toBeString();
  });

  test("manual run does not resume a paused job", async () => {
    const config = testConfig("jobs-manual-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused-manual", script: "echo manual", intervalSeconds: 60 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.exitCode).toBe(0);

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(after?.status).toBe("paused");
  });

  test("removeJob cascades JobRunRecord deletion", async () => {
    const config = testConfig("jobs-remove-cascade");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cascade", script: "echo cascade", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(runResult.exitCode).toBe(0);

    // Sanity: a run exists.
    const beforeRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(beforeRuns.length).toBeGreaterThanOrEqual(1);

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    const afterRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(afterRuns).toHaveLength(0);
    // The /api/job-runs listing also shouldn't include them.
    const allRuns = await call(handler, config, "/api/job-runs");
    expect(allRuns.filter((run: { jobId: string }) => run.jobId === job.id)).toHaveLength(0);
  });

  test("removeJob archives the job's dedicated channel so it leaves the rails (issue #369)", async () => {
    const config = testConfig("jobs-remove-archives-channel");

    // A job with its own dedicated channel — the shape create_job's default
    // deliverTo:"channel" produces (kind:"channel", origin:"job").
    const job = await createScheduledJob(config, {
      name: "news-watch",
      prompt: "Check news.",
      intervalSeconds: 600,
      createDedicatedSession: { title: "news-watch" }
    });
    const channelId = job.chatSessionId!;
    expect(channelId).toBeString();
    // A delivered fire's message must survive the archive (history intact).
    await mutateState(config.instance, (state) => {
      createChatMessage(state, { sessionId: channelId, role: "assistant", content: "No major news this cycle." });
    });

    await removeJob(config, job.id);

    const state = readState(config.instance);
    // The job is gone, but the channel is archived in place — still present,
    // history intact, archivedAt stamped so it leaves the Recurring Jobs rails.
    expect(state.jobs.find((j) => j.id === job.id)).toBeUndefined();
    const channel = state.chatSessions.find((s) => s.id === channelId);
    expect(channel).toBeDefined();
    expect(channel?.archivedAt).toBeString();
    expect(channel?.messageIds).toHaveLength(1);
    expect(
      state.audit.some((e) => e.action === "chat.session.archived" && e.target === channelId)
    ).toBe(true);
    // The job.removed audit records which channel it archived.
    const removed = state.audit.find((e) => e.action === "job.removed" && e.target === job.id);
    expect(removed?.evidence?.archivedSessionId).toBe(channelId);
  });

  test("removeJob leaves a chat-bound (non-channel) session untouched", async () => {
    const config = testConfig("jobs-remove-keeps-chat");

    // Seed a plain conversation session, then bind a job's delivery to it
    // (the deliverTo:"chat" shape — JobRecord.chatSessionId points at a
    // normal agent chat, not a dedicated channel).
    const sessionId = "session_plain_chat";
    await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "My chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
    });
    const job = await createScheduledJob(config, {
      name: "in-chat-reminder",
      prompt: "Remind me.",
      intervalSeconds: 600,
      chatSessionId: sessionId
    });

    await removeJob(config, job.id);

    const state = readState(config.instance);
    const session = state.chatSessions.find((s) => s.id === sessionId);
    // The user's conversation is never job-owned — it must NOT be archived.
    expect(session).toBeDefined();
    expect(session?.archivedAt).toBeUndefined();
    expect(state.audit.some((e) => e.action === "chat.session.archived")).toBe(false);
    const removed = state.audit.find((e) => e.action === "job.removed" && e.target === job.id);
    expect(removed?.evidence?.archivedSessionId).toBeUndefined();
  });

  test("removeJob does not archive a channel another job still delivers into", async () => {
    const config = testConfig("jobs-remove-shared-channel");

    // First job mints a dedicated channel.
    const jobA = await createScheduledJob(config, {
      name: "briefing-a",
      prompt: "A.",
      intervalSeconds: 600,
      createDedicatedSession: { title: "shared-briefing" }
    });
    const channelId = jobA.chatSessionId!;
    // A second job is bound to the SAME channel (bindable via the
    // chatSessionId input — raw POST/PATCH /api/jobs allows it).
    const jobB = await createScheduledJob(config, {
      name: "briefing-b",
      prompt: "B.",
      intervalSeconds: 600,
      chatSessionId: channelId
    });
    expect(jobB.chatSessionId).toBe(channelId);

    await removeJob(config, jobA.id);

    const state = readState(config.instance);
    // jobB still delivers into the channel, so archiving it would hide a live
    // delivery surface — the channel stays active.
    const channel = state.chatSessions.find((s) => s.id === channelId);
    expect(channel?.archivedAt).toBeUndefined();
    expect(state.audit.some((e) => e.action === "chat.session.archived" && e.target === channelId)).toBe(false);

    // Removing the LAST job bound to it now archives the channel.
    await removeJob(config, jobB.id);
    const after = readState(config.instance);
    expect(after.chatSessions.find((s) => s.id === channelId)?.archivedAt).toBeString();
    expect(after.audit.some((e) => e.action === "chat.session.archived" && e.target === channelId)).toBe(true);
  });

  test("replay after the underlying job was removed returns 404", async () => {
    const config = testConfig("jobs-replay-404");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "replay-404", script: "echo gone", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    // Capture the runId before we cascade-delete, then resurrect it as a
    // dangling row (state migrated from an older version had this shape).
    const runId = runResult.runId;
    expect(runId).toBeString();

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    // After removeJob the run is gone — but to test the "job vanished"
    // path of replayJobRun specifically, we re-insert a dangling run
    // record pointing at the removed job. This simulates older data
    // shapes (cron-hardening context says this used to be possible).
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: runId,
        instance: state.instance,
        jobId: job.id,
        status: "completed",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const response = await rawCall(handler, config, `/api/job-runs/${runId}/replay`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("overdue manual run advances nextRunAt drift-free and bumps missedRuns", async () => {
    // Setup mirrors the scheduler drift-test, but invokes runJobNow with
    // trigger="manual" instead of letting runDueJobs claim it. Without the
    // overdue-advance, runDueJobs would re-claim this job ~1s later and
    // double-fire it.
    const config = testConfig("jobs-manual-overdue");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "manual overdue", script: "true", intervalSeconds: 10 })
    });
    const setupNow = Date.now();
    const dueAt = setupNow - 25_000;
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(dueAt).toISOString();
    });

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!;
    const newNextMs = new Date(after.nextRunAt).getTime();
    // The advance must have moved nextRunAt past now so the scheduler
    // tick won't re-claim immediately.
    expect(newNextMs).toBeGreaterThan(Date.now());
    // missedRuns counts only the EXTRA skipped intervals — the first
    // advance corresponds to "the manual run satisfied the overdue
    // tick". -25s -> -15s (miss), -15s -> -5s (miss), -5s -> +5s (stop).
    // Two extra advances => missed = 2.
    expect(after.missedRuns).toBe(2);
    // Cadence sanity: new nextRunAt - original due is a multiple of 10s.
    const stepMs = 10_000;
    const delta = newNextMs - dueAt;
    expect(delta % stepMs).toBe(0);
    expect(delta / stepMs).toBe(3);
  });

  test("paused manual run does NOT advance nextRunAt", async () => {
    // The schedule is paused — pretending it kept ticking while paused
    // would surface a misleading "next run in N seconds" once the user
    // resumes. Manual run on a paused job must leave nextRunAt alone.
    const config = testConfig("jobs-manual-paused-noadvance");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused manual", script: "echo paused", intervalSeconds: 10 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });

    const setupNow = Date.now();
    const originalNextRun = new Date(setupNow - 25_000).toISOString();
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = originalNextRun;
      // missedRuns starts from whatever the previous test path left;
      // record the baseline so we can assert it's unchanged.
    });
    const baseMissedRuns = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!.missedRuns;

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!;
    // Paused -> nextRunAt unchanged.
    expect(after.nextRunAt).toBe(originalNextRun);
    expect(after.missedRuns).toBe(baseMissedRuns);
    // And the job stays paused (existing behavior; covered separately
    // by "manual run does not resume a paused job", but reaffirm).
    expect(after.status).toBe("paused");
  });

  test("invalid intervalSeconds returns 400", async () => {
    const config = testConfig("jobs-validation");
    const handler = createHandler(config);

    const negative = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: -5 })
    });
    expect(negative.status).toBe(400);

    const nan = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: Number.NaN })
    });
    // JSON.stringify turns NaN into null, which Number(...) rejects via
    // the assertPositiveInt validator. Either way we expect 400.
    expect(nan.status).toBe(400);
  });

  test("create_job dispatch from a chat-bound task binds the job to the originating session", async () => {
    const config = testConfig("jobs-create-tool-chat");
    // Build a chat session and a task whose runId points at it. This is
    // the shape submitChatMessage produces — we synthesize it directly so
    // the dispatch test isn't gated on the full chat-task agent loop.
    const { taskId, sessionId } = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: "session_test_chat",
        instance: state.instance,
        title: "Test chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const at = new Date().toISOString();
      state.runs.unshift({
        id: "run_test_chat",
        instance: state.instance,
        kind: "conversation_turn",
        status: "running",
        title: "test",
        input: "test",
        createdAt: at,
        updatedAt: at,
        conversationId: "session_test_chat",
        planStepIds: [],
        childRunIds: [],
        approvalIds: []
      });
      const task = createTask(state.instance, "test", undefined, undefined, undefined, "run_test_chat");
      upsertTask(state, task);
      return { taskId: task.id, sessionId: "session_test_chat" };
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_1",
      JSON.stringify({ name: "test-reminder", intervalSeconds: 60, prompt: "Remind me.", oneShot: true })
    );
    expect(result.kind).toBe("sync");

    const stateAfter = readState(config.instance);
    const jobs = stateAfter.jobs;
    expect(jobs).toHaveLength(1);
    // The job binds to the ORIGINATING session — each fire delivers into the
    // conversation it was created from. No separate dedicated channel is
    // minted (the Topic→Chat mirror surfaces Topic fires in the parent Chat),
    // and forwardToChat stays unset so the final answer isn't double-posted.
    expect(jobs[0]?.chatSessionId).toBe(sessionId);
    expect(jobs[0]?.forwardToChat).toBeUndefined();
    expect(jobs[0]?.oneShot).toBe(true);
    expect(jobs[0]?.intervalSeconds).toBe(60);
    expect(jobs[0]?.prompt).toBe("Remind me.");

    // No new chat session was created — the originating one is reused as-is.
    expect(stateAfter.chatSessions).toHaveLength(1);
    const originating = stateAfter.chatSessions.find((s) => s.id === sessionId)!;
    expect(originating.kind).toBeUndefined();
    expect(originating.title).toBe("Test chat");

    // Confirmation string contains the new job id, cadence, and the bound
    // session id so the model can reference both in its reply to the user.
    if (result.kind === "sync") {
      expect(result.result).toContain(jobs[0]!.id);
      expect(result.result).toContain("one-shot");
      expect(result.result).toContain(sessionId);
    }
    // Audit row with actor:"agent" action:"job.created".
    const audit = stateAfter.audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.actor).toBe("agent");
  });

  test("createScheduledJob with requireChatSession rejects a vanished chat session and persists no job", async () => {
    const config = testConfig("jobs-create-require-chat-session");
    // The tool path resolves the originating session from a lock-free
    // readState; requireChatSession makes the mutateState callback
    // re-verify it. A session deleted between check and write must throw
    // the recognizable error instead of persisting a job bound to a dead
    // conversation.
    await expect(
      createScheduledJob(config, {
        name: "dead-session",
        intervalSeconds: 60,
        prompt: "x",
        chatSessionId: "session_deleted_in_race"
      }, { requireChatSession: true })
    ).rejects.toThrow(/chat session session_deleted_in_race no longer exists/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("createScheduledJob without requireChatSession keeps the permissive chatSessionId behavior", async () => {
    const config = testConfig("jobs-create-permissive-chat-session");
    // The raw POST /api/jobs path does not opt into the strict re-check:
    // callers may pre-create or backfill sessions out of band.
    const job = await createScheduledJob(config, {
      name: "backfilled-session",
      intervalSeconds: 60,
      prompt: "x",
      chatSessionId: "session_not_yet_created"
    });
    expect(job.chatSessionId).toBe("session_not_yet_created");
    expect(readState(config.instance).jobs).toHaveLength(1);
  });

  test("create_job dispatch from an imperative task leaves chatSessionId undefined", async () => {
    const config = testConfig("jobs-create-tool-cli");
    // An imperative task — no runId, no conversation — looks like a CLI
    // task. The job should still get created but without chatSessionId.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_imperative",
      JSON.stringify({ name: "cli-cron", intervalSeconds: 30, prompt: "Heartbeat." })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.chatSessionId).toBeUndefined();
    // The dispatcher coerces an omitted `oneShot` to false so the field
    // has a stable shape for downstream reads. Recurring behavior either
    // way (oneShot must be strictly === true to trigger the auto-pause).
    expect(jobs[0]?.oneShot).toBe(false);
    // No chat session was created for the imperative path. The runtime
    // only mints a dedicated thread when the agent invokes create_job
    // from inside a chat task.
    expect(readState(config.instance).chatSessions).toHaveLength(0);
  });

  test("HTTP POST /jobs does not auto-create a chat session (legacy path)", async () => {
    // The dedicated-session behavior is specifically for agent-driven
    // create_job tool calls. The legacy CLI path (`gini jobs add`) and
    // HTTP POST /api/jobs path must continue to behave as today — no chat
    // session is minted, the job carries no chatSessionId, and the user
    // controls delivery through deliveryTargets / replay UI.
    const config = testConfig("jobs-http-no-session");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "legacy", script: "true", intervalSeconds: 60 })
    });
    expect(job.chatSessionId).toBeUndefined();
    expect(readState(config.instance).chatSessions).toHaveLength(0);
  });

  test("create_job rejection inside mutateState leaves no orphan chat session", async () => {
    // Atomicity guarantee: createScheduledJob mints the dedicated chat
    // session and the JobRecord inside the SAME mutateState callback. If
    // that callback throws — e.g. the parent task transitioned terminal
    // between the dispatcher's lock-free pre-check and the serialized
    // re-check — mutateState's read-modify-write contract discards the
    // in-memory mutations and nothing is persisted. We exercise that
    // path by injecting a cancelled parent task and asserting both the
    // JobRecord and any chat row are absent.
    const config = testConfig("jobs-orphan-rollback");
    const { createScheduledJob } = await import("./jobs");
    const parentTaskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "parent", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });
    const beforeSessions = readState(config.instance).chatSessions.length;
    await expect(
      createScheduledJob(config, {
        name: "rollback",
        intervalSeconds: 60,
        prompt: "x",
        createDedicatedSession: { title: "Scheduled: rollback" },
        parentTaskId
      })
    ).rejects.toThrow(/Cannot create scheduled job/);
    expect(readState(config.instance).chatSessions.length).toBe(beforeSessions);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("dedicated session stores parent's messaging source on outboundMirror so future inbound stays routed to the live session", async () => {
    // Regression: when a messaging-sourced parent task creates a
    // dedicated job session, the descriptor must NOT land on the new
    // session's `source` field. If it did, both sessions would match
    // findOrCreate{Discord,Telegram}ChatSession's (bridgeId,
    // channelId|chatId) routing key and the next inbound on that
    // channel could attach to the job thread instead of the live one.
    const config = testConfig("jobs-outbound-mirror-no-routing-conflict");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { createScheduledJob } = await import("./jobs");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Live session that the poller would have created on first
    // inbound. Its `source` is the routing key for chan-1.
    const liveSession = await mutateState(config.instance, (state) =>
      findOrCreateDiscordChatSession(state, bridge.id, "chan-1")
    );
    expect(liveSession.source?.kind).toBe("discord");

    // Parent task associated with the live session, completed.
    const parentTaskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "parent", undefined, undefined, undefined, undefined);
      task.status = "completed";
      upsertTask(state, task);
      const session = state.chatSessions.find((s) => s.id === liveSession.id);
      if (session && !session.taskIds.includes(task.id)) session.taskIds.push(task.id);
      return task.id;
    });

    await createScheduledJob(config, {
      name: "reminder",
      intervalSeconds: 60,
      prompt: "remind",
      createDedicatedSession: { title: "Scheduled: reminder" },
      parentTaskId
    });

    const sessions = readState(config.instance).chatSessions;
    const dedicated = sessions.find((s) => s.id !== liveSession.id);
    expect(dedicated).toBeDefined();
    // The architectural invariant: dedicated session has
    // outboundMirror but NO source.
    expect(dedicated?.source).toBeUndefined();
    expect(dedicated?.outboundMirror?.kind).toBe("discord");
    expect((dedicated?.outboundMirror as { channelId?: string } | undefined)?.channelId).toBe("chan-1");

    // Routing key check: a subsequent inbound on chan-1 must return
    // the live session, not the dedicated job session.
    const resolved = await mutateState(config.instance, (state) =>
      findOrCreateDiscordChatSession(state, bridge.id, "chan-1")
    );
    expect(resolved.id).toBe(liveSession.id);
  });

  test("create_job dispatch persists the per-job auto-approve envelope", async () => {
    // The agent passes `autoApproveCommands`, `dangerouslyAutoApprove`, and
    // `timeoutSeconds` through the tool spec to schedule an unattended job.
    // The dispatch path must forward all three onto the JobRecord so
    // `dispatchPromptRun` can clone them into the spawned task's config.
    const config = testConfig("jobs-create-tool-envelope");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_envelope",
      JSON.stringify({
        name: "envelope-job",
        intervalSeconds: 60,
        prompt: "do work",
        autoApproveCommands: ["git *", "gh *"],
        dangerouslyAutoApprove: true,
        timeoutSeconds: 600
      })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.autoApproveCommands).toEqual(["git *", "gh *"]);
    expect(jobs[0]?.dangerouslyAutoApprove).toBe(true);
    expect(jobs[0]?.timeoutSeconds).toBe(600);

    // Audit row carries the envelope so a reviewer can see exactly what
    // the agent opted into when it scheduled the job.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.dangerouslyAutoApprove).toBe(true);
    expect(audit?.evidence?.autoApproveCommands).toEqual(["git *", "gh *"]);
    expect(audit?.evidence?.timeoutSeconds).toBe(600);
  });

  test("create_job dispatch rejects non-boolean dangerouslyAutoApprove", async () => {
    const config = testConfig("jobs-create-tool-validate-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_flag",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", dangerouslyAutoApprove: "true" })
      )
    ).rejects.toThrow(/dangerouslyAutoApprove must be a boolean/);
    // No job should have been persisted.
    expect(readState(config.instance).jobs).toHaveLength(0);
  });
});

// update_job deliverTo: rebinding a job's delivery after creation
// (rebindJobDelivery in src/jobs/index.ts via the update_job tool).
// chat→channel mints a FRESH dedicated channel and never archives the
// user's conversation; channel→chat rebinds to the originating
// conversation and archives the orphaned channel (history preserved,
// excluded from lists). Watcher jobs (preRunHook / routes) reject the
// field entirely.
describe("update_job deliverTo rebinding", () => {
  // Seed a chat-bound task: a plain conversation session, a running
  // conversation_turn run pointing at it, and a task attached to that run —
  // the same shape the create_job deliverTo tests use.
  async function seedChatTask(config: RuntimeConfig, suffix: string) {
    return mutateState(config.instance, (state) => {
      const sessionId = `session_rebind_${suffix}`;
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Test chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const at = new Date().toISOString();
      state.runs.unshift({
        id: `run_rebind_${suffix}`,
        instance: state.instance,
        kind: "conversation_turn",
        status: "running",
        title: "test",
        input: "test",
        createdAt: at,
        updatedAt: at,
        conversationId: sessionId,
        planStepIds: [],
        childRunIds: [],
        approvalIds: []
      });
      const task = createTask(state.instance, "test", undefined, undefined, undefined, `run_rebind_${suffix}`);
      upsertTask(state, task);
      return { taskId: task.id, sessionId };
    });
  }

  test("deliverTo \"channel\" clears forwardToChat, keeps the job's Topic, and no-ops on repeat", async () => {
    const config = testConfig("jobs-rebind-chat-to-channel");
    const { taskId, sessionId } = await seedChatTask(config, "c2ch");
    // Seed a forward-to-chat job directly: a dedicated Topic that ALSO forwards
    // into chat — the shape the rebind operates on.
    const jobBefore = await createScheduledJob(config, {
      name: "haiku-job",
      intervalSeconds: 60,
      prompt: "Haiku.",
      createDedicatedSession: { title: "haiku-job" },
      forwardToChat: true,
      parentTaskId: taskId
    });
    const jobId = jobBefore.id;
    const topicId = jobBefore.chatSessionId!;
    // The job runs in its own dedicated Topic, distinct from the originating
    // conversation, with forwardToChat set.
    expect(topicId).not.toBe(sessionId);
    expect(jobBefore.forwardToChat).toBe(true);

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rebind_to_channel",
      JSON.stringify({ jobId, deliverTo: "channel" })
    );
    expect(result.kind).toBe("sync");

    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    // The job KEEPS its Topic — only forwardToChat flips off. No fresh channel.
    expect(job.chatSessionId).toBe(topicId);
    expect(job.forwardToChat).toBe(false);
    const topic = state.chatSessions.find((s) => s.id === topicId);
    expect(topic?.kind).toBe("channel");
    expect(topic?.origin).toBe("job");
    expect(topic?.archivedAt).toBeUndefined();
    // The user's conversation is NOT archived — it was never job-owned.
    const conversation = state.chatSessions.find((s) => s.id === sessionId);
    expect(conversation?.archivedAt).toBeUndefined();
    expect(state.audit.some((e) => e.action === "job.delivery.rebound" && e.target === jobId)).toBe(true);
    if (result.kind === "sync") {
      expect(result.result).toContain(job.chatSessionId!);
    }

    // Repeat call: already channel-only — no change, no new session.
    const sessionCount = state.chatSessions.length;
    const repeat = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rebind_to_channel_again",
      JSON.stringify({ jobId, deliverTo: "channel" })
    );
    const after = readState(config.instance);
    expect(after.jobs.find((j) => j.id === jobId)?.chatSessionId).toBe(job.chatSessionId);
    expect(after.chatSessions.length).toBe(sessionCount);
    if (repeat.kind === "sync") {
      expect(repeat.result).toContain("no change");
    }
  });

  test("deliverTo \"chat\" sets forwardToChat, keeps the job's Topic (no archive), and no-ops on repeat", async () => {
    const config = testConfig("jobs-rebind-channel-to-chat");
    const { taskId, sessionId } = await seedChatTask(config, "ch2c");
    // Seed a channel-only job directly: a dedicated Topic, no forward.
    const jobBefore = await createScheduledJob(config, {
      name: "briefing",
      intervalSeconds: 60,
      prompt: "Brief.",
      createDedicatedSession: { title: "briefing" },
      parentTaskId: taskId
    });
    const jobId = jobBefore.id;
    const topicId = jobBefore.chatSessionId!;
    expect(topicId).not.toBe(sessionId);
    expect(jobBefore.forwardToChat ?? false).toBe(false);
    // A delivered fire in the Topic — must survive the rebind untouched.
    await mutateState(config.instance, (state) => {
      createChatMessage(state, { sessionId: topicId, role: "assistant", content: "fire output" });
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rebind_to_chat",
      JSON.stringify({ jobId, deliverTo: "chat" })
    );
    expect(result.kind).toBe("sync");

    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    // The Topic is KEPT and never archived just because delivery moved to chat.
    expect(job.chatSessionId).toBe(topicId);
    expect(job.forwardToChat).toBe(true);
    const topic = state.chatSessions.find((s) => s.id === topicId);
    expect(topic).toBeDefined();
    expect(topic?.archivedAt).toBeUndefined();
    expect(topic?.messageIds).toHaveLength(1);
    expect(state.audit.some((e) => e.action === "chat.session.archived" && e.target === topicId)).toBe(false);
    expect(state.audit.some((e) => e.action === "job.delivery.rebound" && e.target === jobId)).toBe(true);
    if (result.kind === "sync") {
      expect(result.result).toContain("forwards");
    }

    // Repeat call: already forwarding — no change.
    const repeat = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rebind_to_chat_again",
      JSON.stringify({ jobId, deliverTo: "chat" })
    );
    const after = readState(config.instance);
    expect(after.jobs.find((j) => j.id === jobId)?.chatSessionId).toBe(topicId);
    expect(after.jobs.find((j) => j.id === jobId)?.forwardToChat).toBe(true);
    if (repeat.kind === "sync") {
      expect(repeat.result).toContain("no change");
    }
  });

  test("deliverTo \"chat\" from a non-chat-bound task is a tool error and mutates nothing", async () => {
    const config = testConfig("jobs-rebind-nochat");
    const job = await createScheduledJob(config, { name: "orphan", intervalSeconds: 60, prompt: "x" });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rebind_nochat",
      JSON.stringify({ jobId: job.id, deliverTo: "chat" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Error:");
      expect(result.result).toContain("requires invocation from a chat conversation");
    }
    const state = readState(config.instance);
    expect(state.jobs.find((j) => j.id === job.id)?.chatSessionId).toBeUndefined();
    expect(state.audit.some((e) => e.action === "job.delivery.rebound")).toBe(false);
  });

  test("rebindJobDelivery to \"chat\" sets forwardToChat and keeps the job's Topic (no archive)", async () => {
    const config = testConfig("jobs-rebind-keeps-topic");
    // Channel-only job with a dedicated Topic. Rebinding to "chat" must keep
    // that same Topic and only flip forwardToChat — never archive it.
    const job = await createScheduledJob(config, {
      name: "race",
      intervalSeconds: 60,
      prompt: "x",
      createDedicatedSession: { title: "race" }
    });
    const topicId = job.chatSessionId!;
    const result = await rebindJobDelivery(config, job.id, "chat");
    expect(result.outcome).toBe("rebound");
    const state = readState(config.instance);
    const after = state.jobs.find((j) => j.id === job.id)!;
    // Same Topic, forwardToChat flipped on, Topic NOT archived.
    expect(after.chatSessionId).toBe(topicId);
    expect(after.forwardToChat).toBe(true);
    const topic = state.chatSessions.find((s) => s.id === topicId);
    expect(topic?.archivedAt).toBeUndefined();
    expect(state.audit.some((e) => e.action === "chat.session.archived")).toBe(false);
    expect(state.audit.some((e) => e.action === "job.delivery.rebound" && e.target === job.id)).toBe(true);
  });

  test("deliverTo is rejected for watcher jobs (preRunHook or fan-out routes)", async () => {
    const config = testConfig("jobs-rebind-watcher-guard");
    const { taskId } = await seedChatTask(config, "watcher");
    const hooked = await createScheduledJob(config, { name: "watch-a", intervalSeconds: 60, prompt: "x" });
    const routed = await createScheduledJob(config, { name: "watch-b", intervalSeconds: 60, prompt: "x" });
    // Stamp the routing state directly — validation of hook payloads is
    // create-time concern; the guard only cares about presence.
    await mutateState(config.instance, (state) => {
      state.jobs.find((j) => j.id === hooked.id)!.preRunHook = { handlerId: "skill-script", config: {} };
      state.jobs.find((j) => j.id === routed.id)!.routes = { bucket: { chatSessionId: "chat_route" } };
    });

    for (const jobId of [hooked.id, routed.id]) {
      const result = await dispatchToolCall(
        config,
        taskId,
        "update_job",
        `call_rebind_watcher_${jobId}`,
        JSON.stringify({ jobId, deliverTo: "channel" })
      );
      expect(result.kind).toBe("sync");
      if (result.kind === "sync") {
        expect(result.result).toContain("Error:");
        expect(result.result).toContain("not supported for jobs with a preRunHook or fan-out routes");
      }
    }
    const state = readState(config.instance);
    expect(state.jobs.find((j) => j.id === hooked.id)?.chatSessionId).toBeUndefined();
    expect(state.jobs.find((j) => j.id === routed.id)?.chatSessionId).toBeUndefined();
    expect(state.audit.some((e) => e.action === "job.delivery.rebound")).toBe(false);
  });

  test("deliverTo \"chat\" clones the conversation's bridge source onto the job's Topic as outboundMirror", async () => {
    const config = testConfig("jobs-rebind-mirror-clone");
    const { taskId, sessionId } = await seedChatTask(config, "mirror");
    const source = { kind: "telegram" as const, bridgeId: "bridge_tg", chatId: 42, target: "42" };
    await mutateState(config.instance, (state) => {
      const session = state.chatSessions.find((s) => s.id === sessionId)!;
      session.source = source;
      // The dedicated-Topic mirror clone resolves the parent session via its
      // taskIds (as a real chat turn does), so seed the link.
      if (!session.taskIds.includes(taskId)) session.taskIds.push(taskId);
    });
    // A dedicated-Topic job; create-time minting clones the originating
    // conversation's `source` onto the Topic's outboundMirror so scheduled
    // fires keep reaching the bridge.
    const seededJob = await createScheduledJob(config, {
      name: "mirror-job",
      intervalSeconds: 60,
      prompt: "x",
      createDedicatedSession: { title: "mirror-job" },
      forwardToChat: true,
      parentTaskId: taskId
    });
    const jobId = seededJob.id;
    const topicId = seededJob.chatSessionId!;
    const topic = readState(config.instance).chatSessions.find((s) => s.id === topicId);
    expect(topic?.kind).toBe("channel");
    expect(topic?.outboundMirror).toEqual(source);
    expect(topic?.source).toBeUndefined();

    // Rebinding to "channel" keeps the same Topic (and its mirror) — only the
    // forwardToChat flag flips off.
    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_mirror_rebind",
      JSON.stringify({ jobId, deliverTo: "channel" })
    );
    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    expect(job.chatSessionId).toBe(topicId);
    expect(job.forwardToChat).toBe(false);
    expect(state.chatSessions.find((s) => s.id === topicId)?.outboundMirror).toEqual(source);
  });

  test("deliverTo \"channel\" on an archived-channel binding mints a fresh channel and keeps the bridge mirror", async () => {
    const config = testConfig("jobs-rebind-archived-channel");
    const { taskId } = await seedChatTask(config, "archch");
    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_arch_create",
      JSON.stringify({ name: "arch-job", intervalSeconds: 60, prompt: "x" })
    );
    const jobId = readState(config.instance).jobs[0]!.id;
    const channelId = readState(config.instance).jobs[0]!.chatSessionId!;
    const mirror = { kind: "telegram" as const, bridgeId: "bridge_tg", chatId: 7, target: "7" };
    // A job can end up bound to an archived channel via raw PATCH
    // /api/jobs; the rebind must not no-op on it — archived means hidden
    // from the lists, so the job's fires would be invisible.
    await mutateState(config.instance, (state) => {
      const channel = state.chatSessions.find((s) => s.id === channelId)!;
      channel.archivedAt = new Date().toISOString();
      channel.outboundMirror = mirror;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_arch_rebind",
      JSON.stringify({ jobId, deliverTo: "channel" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).not.toContain("no change");
    }

    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    expect(job.chatSessionId).toBeDefined();
    expect(job.chatSessionId).not.toBe(channelId);
    const fresh = state.chatSessions.find((s) => s.id === job.chatSessionId);
    expect(fresh?.kind).toBe("channel");
    expect(fresh?.archivedAt).toBeUndefined();
    // The archived channel carried only outboundMirror (no source); the
    // fresh channel inherits it so bridge delivery survives the rebind.
    expect(fresh?.outboundMirror).toEqual(mirror);
  });

  test("deliverTo \"chat\" on an archived-channel binding mints a fresh Topic and sets forwardToChat", async () => {
    const config = testConfig("jobs-rebind-archived-chat");
    const { taskId } = await seedChatTask(config, "archchat");
    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_archchat_create",
      JSON.stringify({ name: "archchat-job", intervalSeconds: 60, prompt: "x" })
    );
    const jobId = readState(config.instance).jobs[0]!.id;
    const channelId = readState(config.instance).jobs[0]!.chatSessionId!;
    const stampedAt = "2026-01-01T00:00:00.000Z";
    await mutateState(config.instance, (state) => {
      state.chatSessions.find((s) => s.id === channelId)!.archivedAt = stampedAt;
    });

    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_archchat_rebind",
      JSON.stringify({ jobId, deliverTo: "chat" })
    );

    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    // The job had no LIVE Topic (its channel was archived), so it gets a fresh
    // one; forwardToChat flips on. The old archived channel is untouched: its
    // stamp is preserved and no new archive audit is emitted.
    expect(job.chatSessionId).not.toBe(channelId);
    expect(job.forwardToChat).toBe(true);
    const fresh = state.chatSessions.find((s) => s.id === job.chatSessionId);
    expect(fresh?.kind).toBe("channel");
    expect(fresh?.archivedAt).toBeUndefined();
    expect(state.chatSessions.find((s) => s.id === channelId)?.archivedAt).toBe(stampedAt);
    expect(state.audit.some((e) => e.action === "chat.session.archived")).toBe(false);
  });

  test("a same-call name patch titles a freshly minted channel when the job had no live Topic", async () => {
    const config = testConfig("jobs-rebind-rename-title");
    const { taskId } = await seedChatTask(config, "rename");
    // Channel-only job, then force its Topic archived so the rebind must mint a
    // fresh one — the name patch (applied first) titles that fresh channel.
    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_rename_create",
      JSON.stringify({ name: "old-name", intervalSeconds: 60, prompt: "x" })
    );
    const jobId = readState(config.instance).jobs[0]!.id;
    const channelId = readState(config.instance).jobs[0]!.chatSessionId!;
    await mutateState(config.instance, (state) => {
      state.chatSessions.find((s) => s.id === channelId)!.archivedAt = new Date().toISOString();
    });

    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_rename_rebind",
      JSON.stringify({ jobId, name: "new-name", deliverTo: "chat" })
    );

    const state = readState(config.instance);
    const job = state.jobs.find((j) => j.id === jobId)!;
    const channel = state.chatSessions.find((s) => s.id === job.chatSessionId);
    expect(channel?.kind).toBe("channel");
    expect(channel?.id).not.toBe(channelId);
    // The name patch applies before the rebind, so the new channel takes
    // the PATCHED name as its title.
    expect(channel?.title).toBe("new-name");
    expect(job.name).toBe("new-name");
    expect(job.forwardToChat).toBe(true);
  });
});

// Delivery of a finished prompt-job's output to the bridges named on
// job.deliveryTargets (src/jobs/finalize.ts dispatchJobReplyToDeliveryTargets).
// This is the path for jobs created from web/CLI chats — sessions with no
// originating bridge to mirror back to. Stubs the Discord client via
// setMessagingDeps so no test touches the network.
describe("job deliveryTargets delivery", () => {
  // Stub client factory shared by every test below; each test resets
  // sendCalls and messaging deps around its body. `failSends` makes the
  // first N sendMessage calls throw (after recording the attempt) so
  // tests can exercise the failed-send paths; Infinity fails every call.
  function discordStub(
    sendCalls: Array<{ channelId: string; content: string }>,
    options: { failSends?: number } = {}
  ) {
    let remainingFailures = options.failSends ?? 0;
    return () => ({
      async getMe() {
        return { id: "100", username: "Gini", discriminator: "0000", bot: true };
      },
      async sendMessage(channelId: string, content: string) {
        sendCalls.push({ channelId, content });
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("Unknown Channel");
        }
        return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
      },
      async triggerTypingIndicator() {
        return true as const;
      },
      async fetchChannelMessages() {
        return [];
      }
    });
  }

  // Seed a plain chat session (no bridge source), an active job pointing
  // at it with the given deliveryTargets, a running run, and a terminal
  // task carrying the summary. Returns the Task object ready for
  // finalizeJobRunFromTask. `session: "none"` seeds a job with no
  // chatSessionId at all (the POST /api/jobs / non-chat-task shape);
  // `session: "vanished"` points chatSessionId at a session that no
  // longer exists (deleted mid-flight). Failed tasks carry `error`
  // (falling back to `summary` when omitted) — a failed task with no
  // summary at all mirrors the real failTask shape (src/agent.ts),
  // which only sets task.error.
  async function seedJobRun(
    config: RuntimeConfig,
    options: {
      deliveryTargets: string[];
      summary?: string;
      error?: string;
      sessionId?: string;
      status?: "completed" | "failed";
      session?: "none" | "vanished";
    }
  ) {
    const taskId = await mutateState(config.instance, (state) => {
      let sessionId = options.sessionId;
      if (!sessionId && options.session === undefined) {
        sessionId = "session_delivery";
        state.chatSessions.unshift({
          id: sessionId,
          instance: state.instance,
          title: "Delivery",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageIds: [],
          taskIds: [],
          runIds: []
        });
      }
      if (options.session === "vanished") sessionId = "session_gone";
      const t = createTask(state.instance, "scheduled", undefined, undefined, undefined, undefined);
      t.status = options.status ?? "completed";
      t.summary = options.summary;
      if (t.status === "failed") t.error = options.error ?? options.summary;
      t.jobId = "job_delivery";
      upsertTask(state, t);
      const session = state.chatSessions.find((s) => s.id === sessionId);
      if (session) session.taskIds.push(t.id);
      state.jobs.push({
        id: "job_delivery",
        instance: state.instance,
        name: "briefing",
        status: "active",
        prompt: "p",
        deliveryTargets: options.deliveryTargets,
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: options.session === "none" ? undefined : sessionId,
        runIds: [],
        taskIds: [],
        runCount: 0,
        missedRuns: 0,
        nextRunAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.jobRuns.push({
        id: "run_delivery",
        instance: state.instance,
        jobId: "job_delivery",
        status: "running",
        taskId: t.id,
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return t.id;
    });
    return readState(config.instance).tasks.find((t) => t.id === taskId)!;
  }

  test("delivers the final output to the named bridge when the session has no origin bridge", async () => {
    const config = testConfig("jobs-delivery-happy");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Morning briefing: all clear." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("chan-1");
      expect(sendCalls[0]?.content).toContain("Morning briefing");
      // The run itself finalized normally.
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
    } finally {
      resetMessagingDeps();
    }
  });

  test("delivers the failure summary on failed runs — parity with the origin mirror, which surfaces failures rather than going silent", async () => {
    const config = testConfig("jobs-delivery-failed");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Briefing failed: calendar fetch errored.",
        status: "failed"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("calendar fetch errored");
    } finally {
      resetMessagingDeps();
    }
  });

  test("exact '[SILENT]' suppresses deliveryTargets delivery", async () => {
    const config = testConfig("jobs-delivery-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "[SILENT]" });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("resolves by case-insensitive name, id, and kind, deduping to one send per bridge", async () => {
    const config = testConfig("jobs-delivery-dedupe");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const first = await addMessagingBridge(config, {
        name: "disc-one",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      await addMessagingBridge(config, {
        name: "disc-two",
        kind: "discord",
        deliveryTargets: ["chan-2"],
        botToken: "TOK"
      });
      // "DISC-ONE" (case-insensitive name), the raw record id, and
      // "discord" (kind → first matching bridge) all resolve to the same
      // bridge; only one send may land on it. "disc-two" is distinct.
      const task = await seedJobRun(config, {
        deliveryTargets: ["DISC-ONE", first.id, "discord", "disc-two"],
        summary: "Multi-target briefing."
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId).sort()).toEqual(["chan-1", "chan-2"]);
    } finally {
      resetMessagingDeps();
    }
  });

  test("skips a target the origin mirror already dispatched to", async () => {
    const config = testConfig("jobs-delivery-origin-dedupe");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const origin = await addMessagingBridge(config, {
        name: "disc-origin",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      await addMessagingBridge(config, {
        name: "disc-extra",
        kind: "discord",
        deliveryTargets: ["chan-2"],
        botToken: "TOK"
      });
      // The job's session originates from disc-origin, so the mirror
      // (dispatchJobReplyToBridge) already sends there. Naming the same
      // bridge in deliveryTargets must NOT double-send; the extra bridge
      // still gets its copy.
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, origin.id, "chan-1");
        return session.id;
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc-origin", "disc-extra"],
        summary: "Origin-dedupe briefing.",
        sessionId
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId).sort()).toEqual(["chan-1", "chan-2"]);
    } finally {
      resetMessagingDeps();
    }
  });

  test("an unresolvable target at fire time logs job.delivery.target.error, audits job.delivery.failed, and the run still completes", async () => {
    const config = testConfig("jobs-delivery-missing-bridge");
    const { setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      // No bridge named "ghost" exists (it was removed after the job was
      // saved). Delivery must skip it without failing the finalize.
      const task = await seedJobRun(config, { deliveryTargets: ["ghost"], summary: "Briefing for nobody." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("ghost");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.target).toBe("job_delivery");
      expect(audit?.evidence?.target).toBe("ghost");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a provider send failure surfaces as job.delivery.target.error + job.delivery.failed without failing the run", async () => {
    const config = testConfig("jobs-delivery-send-failure");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // Every send throws — sendMessagingOutput swallows the provider
    // error into a status:"failed" outbound record instead of throwing,
    // so the failure must be picked up from the returned record.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: Infinity }) });
    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing that bounces." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("Unknown Channel");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.target).toBe("job_delivery");
      expect(audit?.evidence?.bridgeId).toBe(bridge.id);
      expect(audit?.evidence?.reason).toContain("Unknown Channel");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a job with no chat session delivers the task summary", async () => {
    const config = testConfig("jobs-delivery-sessionless");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // POST /api/jobs and create_job from a non-chat task produce jobs
      // with no chatSessionId — there is no synced assistant message,
      // so delivery falls back to the task summary.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Sessionless briefing.",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("chan-1");
      expect(sendCalls[0]?.content).toContain("Sessionless briefing");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a session-less job's exact '[SILENT]' summary is suppressed", async () => {
    const config = testConfig("jobs-delivery-sessionless-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "[SILENT]",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a vanished chat session does not block deliveryTargets delivery", async () => {
    const config = testConfig("jobs-delivery-vanished-session");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The job's chatSessionId points at a deleted session. The chat
      // sync is skipped (job.chat.session.vanished) but the named
      // bridge still receives the task summary.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Briefing without a home.",
        session: "vanished"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("Briefing without a home");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.chat.session.vanished");
    } finally {
      resetMessagingDeps();
    }
  });

  test("an origin-mirror failure does not suppress an explicitly-listed target on the same bridge", async () => {
    const config = testConfig("jobs-delivery-origin-failed");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // First send (the origin mirror) fails; the second (deliveryTargets)
    // succeeds. The dedupe set is seeded only on a CONFIRMED mirror
    // send, so the explicit entry for the same bridge must still be
    // attempted.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: 1 }) });
    try {
      const origin = await addMessagingBridge(config, {
        name: "disc-origin",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, origin.id, "chan-1");
        return session.id;
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc-origin"],
        summary: "Mirror-failure briefing.",
        sessionId
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId)).toEqual(["chan-1", "chan-1"]);
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.messaging.dispatch.error");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a bridge with no delivery targets falls back to the literal 'local' target and the failed send is logged", async () => {
    const config = testConfig("jobs-delivery-empty-targets");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // A real Discord send to channel "local" 400s; the stub throws to
    // model that, producing a status:"failed" outbound record.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: Infinity }) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: [],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing to nowhere." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("local");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(readState(config.instance).audit.some((a) => a.action === "job.delivery.failed")).toBe(true);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a disabled bridge makes sendMessagingOutput throw; the failure is caught, logged, and audited", async () => {
    const config = testConfig("jobs-delivery-disabled-bridge");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // sendMessagingOutput rejects non-"configured" bridges up front
      // (throws instead of returning a failed record) — the dispatcher
      // must catch that path too.
      await mutateState(config.instance, (state) => {
        const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
        live.status = "disabled";
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing to a dark bridge." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("not configured");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.evidence?.reason).toContain("not configured");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a session-less failed run with no summary delivers the task error", async () => {
    const config = testConfig("jobs-delivery-sessionless-failed-error");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // Failed tasks carry task.error, not task.summary (src/agent.ts
      // failTask). A summary-only fallback would deliver nothing here
      // and the user would hear silence about the broken briefing.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        error: "calendar fetch errored: 503",
        status: "failed",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("calendar fetch errored: 503");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a failed run with summary '[SILENT]' still delivers — suppression applies only to completed runs", async () => {
    const config = testConfig("jobs-delivery-failed-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The [SILENT] contract (src/execution/chat.ts) honors the token
      // only for successfully COMPLETED tasks — a failure must still
      // surface a signal even when the model emitted the sentinel.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "[SILENT]",
        status: "failed",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a legacy name entry resolves past a non-dispatchable demo bridge to the telegram bridge of the same name", async () => {
    const config = testConfig("jobs-delivery-demo-shadow");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    setMessagingDeps({
      telegramClientFactory: () =>
        ({
          async getMe() {
            return { id: 1, is_bot: true, first_name: "Gini" };
          },
          async sendMessage(chatId: string | number, text: string) {
            sendCalls.push({ chatId, text });
            return { message_id: 1, chat: { id: chatId }, date: 0 };
          }
        }) as unknown as import("./integrations/telegram").TelegramClient
    });
    try {
      await addMessagingBridge(config, {
        name: "briefings",
        kind: "telegram",
        deliveryTargets: ["42"],
        botToken: "TOK"
      });
      // Bridges are unshifted into state, so this demo bridge sits in
      // front of the telegram one. A name-tier match over the full
      // bridge list would hit the demo bridge first and fail as
      // non-dispatchable; resolution must pre-filter to dispatchable
      // kinds, the way parseDeliveryTargets does at create/update.
      await addMessagingBridge(config, { name: "briefings", kind: "demo" });
      const task = await seedJobRun(config, {
        deliveryTargets: ["briefings"],
        summary: "Shadowed name briefing",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(String(sendCalls[0]?.chatId)).toBe("42");
      // The default Telegram send path renders MarkdownV2, so assert on
      // text free of escape-prone characters.
      expect(sendCalls[0]?.text).toContain("Shadowed name briefing");
      expect(readState(config.instance).audit.some((a) => a.action === "job.delivery.failed")).toBe(false);
    } finally {
      resetMessagingDeps();
    }
  });

  test("finalizing the same terminal task twice sends exactly once", async () => {
    const config = testConfig("jobs-delivery-idempotent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The runFinalized gate: once the run is terminal, a repeat
      // finalize (duplicate task event, restart replay) must not
      // re-deliver to bridges.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Once-only briefing.",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
    } finally {
      resetMessagingDeps();
    }
  });
});

describe("advanceCronNextRunAt", () => {
  test("hourly cron without missed fires returns the immediate next match", () => {
    // Regression: previously the helper called cron.nextRun twice and
    // skipped one occurrence per advance, so a 09:00 prev + 09:01 now
    // would jump to 11:00 instead of 10:00.
    const prev = Date.UTC(2026, 0, 1, 9, 0, 0);
    const now = Date.UTC(2026, 0, 1, 9, 1, 0);
    const result = advanceCronNextRunAt("0 * * * *", "UTC", prev, now);
    expect(result.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    expect(result.missed).toBe(0);
  });

  test("hourly cron catches up after a 3h offline gap", () => {
    const prev = Date.UTC(2026, 0, 1, 9, 0, 0);
    const now = Date.UTC(2026, 0, 1, 12, 30, 0);
    const result = advanceCronNextRunAt("0 * * * *", "UTC", prev, now);
    // 10:00, 11:00, 12:00 are all in the past; 13:00 is the new fire.
    expect(result.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 13, 0, 0));
    expect(result.missed).toBe(3);
  });

  test("DST spring-forward in America/Los_Angeles still lands on the configured hour", () => {
    // 2026-03-08 is the US spring-forward day: clocks jump 02:00 -> 03:00 LA.
    const prev = Date.UTC(2026, 2, 7, 10, 0, 0); // 2026-03-07 02:00 LA (PST, UTC-8)
    const now = Date.UTC(2026, 2, 9, 0, 0, 0); // well past the DST transition
    const result = advanceCronNextRunAt("0 2 * * *", "America/Los_Angeles", prev, now);
    expect(result.nextRunAtMs).toBeGreaterThan(now);
    expect(result.missed).toBeGreaterThanOrEqual(0);
    const hourInLA = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false
    }).format(new Date(result.nextRunAtMs));
    // Intl can render midnight as "24"; normalize before comparing.
    const hourNumber = Number(hourInLA) % 24;
    expect(hourNumber).toBe(2);
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const auth = token ?? config.token;
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, ...(init.headers ?? {}) }
  }));
  return response;
}

function testConfig(instance: string): RuntimeConfig {
  const root = `/tmp/gini-jobs-tests-${import.meta.file}`;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

async function waitForTask(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval", "cancelled"].includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}
