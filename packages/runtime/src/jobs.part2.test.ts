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
  test("create_job dispatch rejects non-string entries in autoApproveCommands", async () => {
    const config = testConfig("jobs-create-tool-validate-2");
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
        "call_bad_entry",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", autoApproveCommands: ["ok", 7] })
      )
    ).rejects.toThrow(/autoApproveCommands entries must be strings/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch accepts approvalMode and persists it", async () => {
    const config = testConfig("jobs-create-tool-approval-mode");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_mode",
      JSON.stringify({
        name: "mode-job",
        intervalSeconds: 60,
        prompt: "x",
        approvalMode: "yolo"
      })
    );

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.approvalMode).toBe("yolo");
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.approvalMode).toBe("yolo");
  });

  test("create_job dispatch rejects invalid approvalMode value", async () => {
    const config = testConfig("jobs-create-tool-bad-mode");
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
        "call_bad_mode",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", approvalMode: "loose" })
      )
    ).rejects.toThrow(/approvalMode must be one of/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch accepts both approvalMode and legacy dangerouslyAutoApprove (alias)", async () => {
    // Both fields are accepted on the same payload. approvalMode is
    // the canonical signal; the legacy flag is preserved on the
    // JobRecord as a deprecated alias.
    const config = testConfig("jobs-create-tool-both-fields");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_both",
      JSON.stringify({
        name: "both-fields",
        intervalSeconds: 60,
        prompt: "x",
        approvalMode: "yolo",
        dangerouslyAutoApprove: true
      })
    );

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.approvalMode).toBe("yolo");
    expect(jobs[0]?.dangerouslyAutoApprove).toBe(true);
  });

  test("create_job dispatch accepts and persists preRunHook", async () => {
    // The tool passes preRunHook through to createScheduledJob unvalidated —
    // the same seam the HTTP /api/jobs route uses — so the persisted
    // JobRecord must carry the validated hook verbatim, and the audit row
    // must pin the handler id.
    const config = testConfig("jobs-create-tool-prerunhook");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_hook",
      JSON.stringify({
        name: "call-watch c-123",
        intervalSeconds: 30,
        prompt: "report the call result",
        timeoutSeconds: 120,
        preRunHook: {
          handlerId: "skill-script",
          config: { skill: "phone-call", script: "call-watch", callId: "c-123" },
          timeoutMs: 25000
        }
      })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.preRunHook).toEqual({
      handlerId: "skill-script",
      config: { skill: "phone-call", script: "call-watch", callId: "c-123" },
      timeoutMs: 25000
    });
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.preRunHookHandlerId).toBe("skill-script");
  });

  test("create_job dispatch rejects an unknown preRunHook handlerId", async () => {
    // The registry gate in createScheduledJob is the security boundary: an
    // unregistered handlerId must be rejected at create time and persist
    // nothing.
    const config = testConfig("jobs-create-tool-prerunhook-bad");
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
        "call_create_job_hook_bad",
        JSON.stringify({
          name: "bad-hook",
          intervalSeconds: 60,
          prompt: "x",
          preRunHook: { handlerId: "not-a-handler", config: {} }
        })
      )
    ).rejects.toThrow(/not a known hook handler/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects a null preRunHook config", async () => {
    // `typeof null === "object"`, so a bare typeof check would let
    // config: null through to a hook that can never resolve its payload.
    const config = testConfig("jobs-create-tool-prerunhook-null-config");
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
        "call_create_job_hook_null_config",
        JSON.stringify({
          name: "null-hook-config",
          intervalSeconds: 60,
          prompt: "x",
          preRunHook: { handlerId: "skill-script", config: null }
        })
      )
    ).rejects.toThrow(/preRunHook\.config must be an object/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch persists cronExpression + cronTimezone", async () => {
    // Happy-path cron creation through the tool dispatch surface. The
    // agent should be able to schedule a wall-clock job by name +
    // expression + tz, and the resulting JobRecord must carry both fields
    // verbatim (plus intervalSeconds=0 as the "not interval-driven"
    // sentinel).
    const config = testConfig("jobs-create-tool-cron");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_cron",
      JSON.stringify({
        name: "daily-9am",
        prompt: "morning report",
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles"
      })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.cronExpression).toBe("0 9 * * *");
    expect(jobs[0]?.cronTimezone).toBe("America/Los_Angeles");
    // Cron-driven jobs carry no intervalSeconds (field is optional).
    expect(jobs[0]?.intervalSeconds).toBeUndefined();

    // Audit + return-message both reflect the cron cadence so a reviewer
    // and the agent's follow-up reply describe the schedule correctly.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.cronExpression).toBe("0 9 * * *");
    expect(audit?.evidence?.cronTimezone).toBe("America/Los_Angeles");
    if (result.kind === "sync") {
      expect(result.result).toContain("cron");
      expect(result.result).toContain("America/Los_Angeles");
    }
  });

  test("create_job dispatch rejects both intervalSeconds and cronExpression set", async () => {
    const config = testConfig("jobs-create-tool-mutex");
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
        "call_both",
        JSON.stringify({
          name: "both",
          prompt: "x",
          intervalSeconds: 60,
          cronExpression: "0 9 * * *"
        })
      )
    ).rejects.toThrow(/mutually exclusive/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects when neither intervalSeconds nor cronExpression is set", async () => {
    const config = testConfig("jobs-create-tool-neither");
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
        "call_neither",
        JSON.stringify({ name: "neither", prompt: "x" })
      )
    ).rejects.toThrow(/requires either intervalSeconds or cronExpression/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects malformed cronExpression", async () => {
    const config = testConfig("jobs-create-tool-bad-cron");
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
        "call_bad_cron",
        JSON.stringify({ name: "bad", prompt: "x", cronExpression: "foo bar baz qux quux" })
      )
    ).rejects.toThrow(/Invalid input: cronExpression/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects non-integer timeoutSeconds", async () => {
    const config = testConfig("jobs-create-tool-validate-3");
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
        "call_bad_timeout",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", timeoutSeconds: -5 })
      )
    ).rejects.toThrow(/timeoutSeconds must be a positive integer/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("list_jobs dispatch returns a compact summary of all jobs", async () => {
    const config = testConfig("jobs-list-tool");
    const handler = createHandler(config);
    // Two jobs of mixed schedule shape so we can confirm both cron and
    // interval drivers surface correctly in the summary.
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "alpha-reminder", script: "true", intervalSeconds: 60 })
    });
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "beta-daily",
        script: "true",
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles"
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_list_1",
      JSON.stringify({})
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { count: number; jobs: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(2);
    const names = new Set(parsed.jobs.map((j) => j.name));
    expect(names.has("alpha-reminder")).toBe(true);
    expect(names.has("beta-daily")).toBe(true);
    const cronEntry = parsed.jobs.find((j) => j.name === "beta-daily");
    expect(cronEntry?.cronExpression).toBe("0 9 * * *");
    expect(cronEntry?.cronTimezone).toBe("America/Los_Angeles");

    // The listing call writes an audit row so the log records when the
    // agent pulled the job inventory.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.listed"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.total).toBe(2);
    expect(audit?.evidence?.returned).toBe(2);
  });

  test("list_jobs dispatch filters by nameContains (case-insensitive)", async () => {
    const config = testConfig("jobs-list-tool-filter");
    const handler = createHandler(config);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "Daily Report", script: "true", intervalSeconds: 60 })
    });
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cake-reminder", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_list_filter",
      JSON.stringify({ nameContains: "DAILY" })
    );
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { count: number; jobs: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.jobs[0]?.name).toBe("Daily Report");
  });

  test("list_jobs dispatch rejects non-string nameContains", async () => {
    const config = testConfig("jobs-list-tool-bad-filter");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "list_jobs",
        "call_bad_filter",
        JSON.stringify({ nameContains: 7 })
      )
    ).rejects.toThrow(/nameContains must be a string/);
  });

  test("list_jobs dispatch truncates long prompts to ~200 chars", async () => {
    const config = testConfig("jobs-list-tool-truncate");
    const handler = createHandler(config);
    const longPrompt = "x".repeat(500);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "long", prompt: longPrompt, intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_truncate",
      JSON.stringify({})
    );
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { jobs: Array<{ prompt: string }> };
    // Truncated form is 200 chars + ellipsis marker.
    expect(parsed.jobs[0]?.prompt.length).toBeLessThan(longPrompt.length);
    expect(parsed.jobs[0]?.prompt.endsWith("…")).toBe(true);
  });

  test("list_jobs dispatch returns verbatim prompts when fullPrompt is true", async () => {
    // The agent needs the unstruncated prompt when it intends to edit it
    // (append, search-and-replace), since update_job's prompt field is
    // REPLACE-only. With `fullPrompt: true` the handler returns the
    // entire stored prompt unchanged.
    const config = testConfig("jobs-list-tool-full-prompt");
    const handler = createHandler(config);
    const longPrompt = "y".repeat(300);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "verbatim", prompt: longPrompt, intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const verbatim = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_full",
      JSON.stringify({ fullPrompt: true })
    );
    if (verbatim.kind !== "sync") throw new Error("expected sync result");
    const verbatimParsed = JSON.parse(verbatim.result) as { jobs: Array<{ prompt: string }> };
    expect(verbatimParsed.jobs[0]?.prompt.length).toBe(longPrompt.length);
    expect(verbatimParsed.jobs[0]?.prompt).toBe(longPrompt);
    expect(verbatimParsed.jobs[0]?.prompt.endsWith("…")).toBe(false);

    // Same job, without the flag, falls back to the 200-char truncation
    // so a long prompt doesn't blow up the tool-result context.
    const truncated = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_trunc",
      JSON.stringify({})
    );
    if (truncated.kind !== "sync") throw new Error("expected sync result");
    const truncatedParsed = JSON.parse(truncated.result) as { jobs: Array<{ prompt: string }> };
    expect(truncatedParsed.jobs[0]?.prompt.length).toBeLessThan(longPrompt.length);
    expect(truncatedParsed.jobs[0]?.prompt.endsWith("…")).toBe(true);
  });

  test("list_jobs dispatch rejects non-boolean fullPrompt", async () => {
    const config = testConfig("jobs-list-tool-full-prompt-bad");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "list_jobs",
        "call_full_bad",
        JSON.stringify({ fullPrompt: "yes" })
      )
    ).rejects.toThrow(/fullPrompt must be a boolean/);
  });

  test("update_job dispatch patches schedule and writes job.updated audit", async () => {
    const config = testConfig("jobs-update-tool");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-update", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_update_1",
      JSON.stringify({
        jobId: job.id,
        cronExpression: "0 23 * * *",
        cronTimezone: "America/Los_Angeles",
        intervalSeconds: null,
        name: "renamed"
      })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.cronExpression).toBe("0 23 * * *");
    expect(after?.cronTimezone).toBe("America/Los_Angeles");
    expect(after?.intervalSeconds).toBeUndefined();
    expect(after?.name).toBe("renamed");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.updated" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.appliedFields).toContain("cronExpression");
    expect(audit?.evidence?.appliedFields).toContain("name");
    // The audit row pins the prior schedule shape so the change is
    // reconstructable from the log alone.
    expect((audit?.evidence?.previousSchedule as Record<string, unknown>)?.intervalSeconds).toBe(60);
  });

  test("update_job dispatch can pause a running job", async () => {
    const config = testConfig("jobs-update-tool-pause");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-pause", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_pause",
      JSON.stringify({ jobId: job.id, status: "paused" })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.status).toBe("paused");
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.updated" && event.target === job.id && event.actor === "agent"
    );
    expect(audit?.evidence?.appliedFields).toContain("status");
    // The return string must not claim a next-fire moment for a paused
    // job — the scheduler skips it while paused, so "next fires at ..."
    // would be a lie.
    if (result.kind === "sync") {
      expect(result.result).not.toContain("next fires at");
      expect(result.result).toContain("will not fire until resumed");
    }
  });

  test("update_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-update-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_no_id",
        JSON.stringify({ name: "x" })
      )
    ).rejects.toThrow(/jobId/);
  });

  test("update_job dispatch rejects empty patch", async () => {
    const config = testConfig("jobs-update-tool-empty");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "empty-patch", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_empty_patch",
        JSON.stringify({ jobId: job.id })
      )
    ).rejects.toThrow(/at least one field/);
  });

  test("update_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-update-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_unknown",
        JSON.stringify({ jobId: "job_does_not_exist", name: "x" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("update_job dispatch applies autoApproveCommands and dangerouslyAutoApprove onto the JobRecord", async () => {
    const config = testConfig("jobs-update-tool-auto-approve");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "approve-me", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_auto_approve",
      JSON.stringify({
        jobId: job.id,
        autoApproveCommands: ["ls", "git status"],
        dangerouslyAutoApprove: true
      })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.dangerouslyAutoApprove).toBe(true);
    expect(after?.autoApproveCommands).toEqual(["ls", "git status"]);

    // Clearing via empty array drops the override entirely.
    const cleared = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_auto_approve_clear",
      JSON.stringify({
        jobId: job.id,
        autoApproveCommands: [],
        dangerouslyAutoApprove: false
      })
    );
    expect(cleared.kind).toBe("sync");
    const afterClear = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(afterClear?.dangerouslyAutoApprove).toBe(false);
    expect(afterClear?.autoApproveCommands).toBeUndefined();
  });

  test("update_job dispatch rejects null prompt", async () => {
    // `prompt: null` is not a valid clear signal — JobRecord.prompt is
    // string-typed. Throw `Invalid input` so the agent's follow-up
    // can't misreport a phantom prompt change.
    const config = testConfig("jobs-update-tool-null-prompt");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "null-prompt", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_null_prompt",
        JSON.stringify({ jobId: job.id, prompt: null })
      )
    ).rejects.toThrow(/Invalid input: prompt must be a non-empty string/);
  });

  test("update_job dispatch rejects non-string name", async () => {
    const config = testConfig("jobs-update-tool-numeric-name");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-rename", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_numeric_name",
        JSON.stringify({ jobId: job.id, name: 123 })
      )
    ).rejects.toThrow(/Invalid input: name must be a non-empty string/);
  });

  test("update_job dispatch rejects empty-string name", async () => {
    const config = testConfig("jobs-update-tool-empty-name");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_empty_name",
        JSON.stringify({ jobId: job.id, name: "" })
      )
    ).rejects.toThrow(/Invalid input: name must be a non-empty string/);
  });

  test("update_job dispatch rejects invalid status value", async () => {
    const config = testConfig("jobs-update-tool-bad-status");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad-status", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_status",
        JSON.stringify({ jobId: job.id, status: "failed" })
      )
    ).rejects.toThrow(/status must be 'active' or 'paused'/);
  });

  test("create_job dispatch persists deliveryTargets as the resolved bridge id", async () => {
    const config = testConfig("jobs-create-tool-delivery");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_delivery",
      JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["disc"] })
    );

    // The entry is stored as the bridge id, not the name the caller
    // typed — names and kinds are not unique, and bridge ordering
    // shifts as records are added, so the id pins the user's choice.
    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.deliveryTargets).toEqual([bridge.id]);
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.deliveryTargets).toEqual([bridge.id]);
  });

  test("create_job dispatch rejects an unknown deliveryTargets entry, listing dispatchable bridge names", async () => {
    const config = testConfig("jobs-create-tool-delivery-bad");
    const { addMessagingBridge } = await import("./integrations/messaging");
    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // The error names the dispatchable bridges so the agent can relay a
    // fixable message ("did you mean 'disc'?") instead of a dead end.
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_delivery_bad",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["whatsapp"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'whatsapp'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects a non-dispatchable (demo) bridge as a deliveryTargets entry", async () => {
    const config = testConfig("jobs-create-tool-delivery-demo");
    const { addMessagingBridge } = await import("./integrations/messaging");
    // Demo bridges are common (CLI default kind) but the finalizer can
    // only send to telegram/discord — accepting one here would validate
    // a target that fails on every fire.
    await addMessagingBridge(config, { name: "demo-bridge", kind: "demo" });
    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
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
        "call_delivery_demo",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["demo-bridge"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'demo-bridge'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects a Slack bridge with no configured delivery channel", async () => {
    const config = testConfig("jobs-create-tool-delivery-slack-dm");
    const { addMessagingBridge } = await import("./integrations/messaging");
    // A DM-only Slack bridge has empty deliveryTargets by design (DM
    // channels are discovered at event time) — accepting it here would
    // make generic dispatch fall back to the literal "local" target and
    // fail with channel_not_found on every fire.
    await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });
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
        "call_delivery_slack_dm",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["slk"] })
      )
    ).rejects.toThrow(/Slack bridge 'slk' has no delivery channel configured/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch accepts a Slack bridge that has a delivery channel configured", async () => {
    const config = testConfig("jobs-create-tool-delivery-slack-channel");
    const { addMessagingBridge } = await import("./integrations/messaging");
    // The manual channel-id escape hatch: an operator-configured
    // channel gives the text-only job dispatch a real target.
    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: ["C123"],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_delivery_slack_channel",
      JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["slk"] })
    );

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.deliveryTargets).toEqual([bridge.id]);
  });

  test("create_job dispatch rejects an ambiguous deliveryTargets entry, listing the candidates", async () => {
    const config = testConfig("jobs-create-tool-delivery-ambiguous");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const a = await addMessagingBridge(config, {
      name: "disc-a",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const b = await addMessagingBridge(config, {
      name: "disc-b",
      kind: "discord",
      deliveryTargets: ["chan-2"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // "discord" matches both bridges by kind — first-match would
    // silently pick whichever record happens to sort first, so the
    // entry is rejected with both candidates named.
    let message = "";
    try {
      await dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_delivery_ambiguous",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["discord"] })
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ambiguous");
    expect(message).toContain(`disc-a (${a.id})`);
    expect(message).toContain(`disc-b (${b.id})`);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("update_job dispatch sets deliveryTargets and clears them with []", async () => {
    const config = testConfig("jobs-update-tool-delivery");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-route", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_set_delivery",
      JSON.stringify({ jobId: job.id, deliveryTargets: ["disc"] })
    );
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([bridge.id]);

    // An unknown entry is rejected with the dispatchable names and the
    // previously-set targets stay untouched.
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_delivery",
        JSON.stringify({ jobId: job.id, deliveryTargets: ["slackk"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'slackk'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([bridge.id]);

    // Empty array is the documented "clear" signal.
    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_clear_delivery",
      JSON.stringify({ jobId: job.id, deliveryTargets: [] })
    );
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([]);
  });

  test("delete_job dispatch removes the job and writes job.deleted audit", async () => {
    const config = testConfig("jobs-delete-tool");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "to-delete",
        script: "true",
        cronExpression: "0 9 * * *",
        cronTimezone: "UTC"
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "delete_job",
      "call_delete_1",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("to-delete");
      // delete_job deliberately carries NO structured jobId (unlike
      // create_job/update_job) — a routine card pointing at a deleted job
      // could only ever render its tombstone state.
      expect(result.jobId).toBeUndefined();
    }

    expect(readState(config.instance).jobs.find((j) => j.id === job.id)).toBeUndefined();
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.deleted" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.name).toBe("to-delete");
    // The audit row pins the prior schedule shape so the deleted job is
    // reconstructable from the log alone.
    const prev = audit?.evidence?.previousSchedule as Record<string, unknown> | undefined;
    expect(prev?.cronExpression).toBe("0 9 * * *");
    expect(prev?.cronTimezone).toBe("UTC");
  });

  test("delete_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-delete-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "delete_job",
        "call_delete_bad",
        JSON.stringify({})
      )
    ).rejects.toThrow(/jobId/);
  });

  test("delete_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-delete-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "delete_job",
        "call_delete_unknown",
        JSON.stringify({ jobId: "job_nope" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("update_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Defense-in-depth: when the parent task has gone terminal between
    // the chat-task per-tool guard and dispatch, update_job must skip
    // the mutation entirely so a cancelled task can't leak a patched
    // job past the cancellation. Pre-check returns an Error string; the
    // JobRecord stays untouched.
    const config = testConfig("jobs-update-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_update_terminal",
      JSON.stringify({ jobId: job.id, name: "should-not-apply" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: update_job skipped/);
    }
    // JobRecord is unchanged — name still "to-keep".
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.name).toBe("to-keep");
  });

  test("updateJob oneShot patch applies when parent task is completed", async () => {
    // Consistency invariant: a `completed` parent task may still manage
    // jobs (schedule a follow-up, flip a finished one-shot back to
    // recurring, etc.). The shared job mutators in src/jobs/index.ts
    // (createScheduledJob, updateJob, updateJobStatus, removeJob)
    // permit `completed` and refuse only on `cancelled`/`failed`. The
    // oneShot patch rides inside updateJob's single mutateState, so it is
    // covered by the exact same predicate as every sibling field — no
    // partial application (name landed, oneShot refused) is possible.
    //
    // The dispatcher's lock-free entry-level pre-check is stricter
    // (it short-circuits all terminal statuses to avoid touching the
    // lock for the common case), so this test verifies the invariant
    // at the authoritative serialization point — the shared mutator —
    // which is where the asymmetry would actually leak through under
    // a race (parent transitions to `completed` between the pre-check
    // and the serialized re-check).
    const config = testConfig("jobs-update-tool-oneshot-completed-parent");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "flip-oneshot", prompt: "ping", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });

    // The shared mutator path (updateJob) accepts a `completed`
    // parent — this is what permits a completed task's final action
    // to be a legitimate job patch.
    await updateJob(config, job.id, { name: "renamed-from-completed-parent" }, taskId);
    const afterName = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(afterName?.name).toBe("renamed-from-completed-parent");

    // The oneShot patch goes through the same production path (updateJob's
    // dedicated parameter) and must apply under the same predicate.
    await updateJob(config, job.id, {}, taskId, true);
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.oneShot).toBe(true);
  });

  test("delete_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Same defense-in-depth as update_job: a cancelled parent task must
    // not be able to delete a JobRecord through the agent tool path.
    const config = testConfig("jobs-delete-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "delete_job",
      "call_delete_terminal",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: delete_job skipped/);
    }
    // JobRecord is still present.
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after).toBeDefined();
  });

  test("run_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-run-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "run_job",
        "call_run_bad",
        JSON.stringify({})
      )
    ).rejects.toThrow(/jobId/);
  });

  test("run_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-run-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "run_job",
        "call_run_unknown",
        JSON.stringify({ jobId: "job_nope" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("run_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Same defense-in-depth as update_job / delete_job: a cancelled
    // parent task must not be able to fire a fresh job run through the
    // agent tool path. The tool handler does a lock-free pre-check and
    // `runJobNow` re-checks inside its serialized `mutateState` block; this
    // test exercises the pre-check path.
    const config = testConfig("jobs-run-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-fire", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_terminal",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: run_job skipped/);
    }
    // No new JobRunRecord was created.
    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(0);
  });

  test("run_job dispatch fires a prompt job, spawns a task, and writes job.run.manual audit", async () => {
    const config = testConfig("jobs-run-tool-happy");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "manual-fire",
        prompt: "ping",
        intervalSeconds: 3600
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_happy",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("manual-fire");
      expect(result.result).toMatch(/run /);
      expect(result.result).toMatch(/task /);
    }

    // A new JobRunRecord exists with a spawned task linked.
    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    expect(runs[0]?.taskId).toBeDefined();

    // The audit row uses action "job.run.manual" and points at the
    // spawned task + new run id.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.spawnedTaskId).toBe(runs[0]?.taskId);
  });

  test("run_job dispatch reports script-job success with exit 0", async () => {
    // Script-backed jobs execute synchronously inside `runJobNow`, so by
    // the time the tool returns the run is already complete. The handler
    // must report the exit code (not "Triggered ...") and the audit row
    // must pin exitCode for postmortems.
    const config = testConfig("jobs-run-tool-script-ok");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script-ok", script: "true", intervalSeconds: 3600 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_script_ok",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("script-ok");
      expect(result.result).toMatch(/completed/);
      expect(result.result).toMatch(/exit 0/);
    }

    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    // Script jobs don't spawn a task.
    expect(runs[0]?.taskId).toBeUndefined();

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.exitCode).toBe(0);
  });

  test("run_job dispatch reports script-job failure with non-zero exit", async () => {
    // Failure path: tool return string must say "failed", surface the
    // non-zero exit, and the audit row must capture exitCode so
    // postmortems don't have to cross-reference the JobRun record.
    const config = testConfig("jobs-run-tool-script-fail");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script-fail", script: "exit 1", intervalSeconds: 3600 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_script_fail",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("script-fail");
      expect(result.result).toMatch(/failed/);
      expect(result.result).toMatch(/exit 1/);
    }

    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    expect(runs[0]?.status).toBe("failed");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.exitCode).toBe(1);
  });

  test("scheduled prompt job with chatSessionId delivers an assistant chat message", async () => {
    // End-to-end test: create a job linked to a chat session, force its
    // nextRunAt into the past, let runDueJobs claim + dispatch it, wait
    // for the task to settle, then assert that finalizeJobRunFromTask
    // produced a ChatMessageRecord with role="assistant" in that session.
    const config = testConfig("jobs-chat-delivery");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "delivery test" })
    });

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "delivery-job",
        prompt: "echo ping",
        intervalSeconds: 60,
        chatSessionId: session.id,
        oneShot: true
      })
    });
    expect(job.chatSessionId).toBe(session.id);
    expect(job.oneShot).toBe(true);

    // Force the job due so runDueJobs claims it on the next tick.
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 1_000).toISOString();
    });

    await runDueJobs(config);

    // Diagnostic: confirm runDueJobs claimed the job and spawned a task.
    const afterClaim = readState(config.instance);
    const claimedRun = afterClaim.jobRuns.find((run) => run.jobId === job.id);
    expect(claimedRun).toBeDefined();
    expect(claimedRun?.taskId).toBeString();
    const spawnedTask = afterClaim.tasks.find((t) => t.id === claimedRun?.taskId);
    expect(spawnedTask?.mode).toBe("chat");

    // Wait for the spawned task to settle, then for the assistant message
    // to appear in the session (finalize is async).
    await waitFor(() => {
      const state = readState(config.instance);
      const jobRun = state.jobRuns.find((run) => run.jobId === job.id);
      return jobRun?.status === "completed" || jobRun?.status === "failed";
    }, 5_000);

    await waitFor(() => {
      const state = readState(config.instance);
      return state.chatMessages.some(
        (m) => m.sessionId === session.id && m.role === "assistant"
      );
    }, 5_000);

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === session.id && m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // The job should be paused now because oneShot=true.
    const finalJob = stateAfter.jobs.find((candidate) => candidate.id === job.id);
    expect(finalJob?.status).toBe("paused");

    // Audit row for the one-shot completion.
    const audit = stateAfter.audit.find(
      (event) => event.action === "job.oneshot.completed" && event.target === job.id
    );
    expect(audit).toBeDefined();
  });

  test("a forwardToChat job materializes its answer in its Topic AND forwards a tagged block into the owning agent's Chat", async () => {
    // End-to-end: a job that runs in its own Topic and forwards each fire's
    // final answer into the owning agent's Chat (ADR
    // chat-topics-tasks-subagents.md, "Jobs → Topics").
    const { getOrCreateAgentChat } = await import("./execution/chat");
    const { listChatBlocks, createChatSession } = await import("./state");
    const config = testConfig("jobs-forward-to-chat");

    // Resolve the owning agent + its Chat, then mint a dedicated Topic for the
    // job and a forwardToChat job bound to it.
    const agentId = readState(config.instance).agents[0]!.id;
    const chat = await getOrCreateAgentChat(config.instance, agentId);
    const topicId = await mutateState(config.instance, (state) => {
      const topic = createChatSession(state, "ping-watch", undefined, agentId, "job", "channel");
      return topic.id;
    });
    const job = await createScheduledJob(config, {
      name: "ping-watch",
      prompt: "echo ping",
      intervalSeconds: 60,
      chatSessionId: topicId,
      forwardToChat: true,
      oneShot: true
    }, { originatingAgentId: agentId });
    expect(job.forwardToChat).toBe(true);

    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 1_000).toISOString();
    });

    await runDueJobs(config);

    await waitFor(() => {
      const jobRun = readState(config.instance).jobRuns.find((run) => run.jobId === job.id);
      return jobRun?.status === "completed" || jobRun?.status === "failed";
    }, 5_000);

    // The replay-authoritative answer landed in the Topic.
    await waitFor(
      () => readState(config.instance).chatMessages.some((m) => m.sessionId === topicId && m.role === "assistant"),
      5_000
    );

    // …and a forwarded render-only block landed in the owning agent's Chat,
    // tagged with the Topic for the deep-link chip.
    await waitFor(() => {
      return listChatBlocks(config.instance, chat.id).some(
        (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId
      );
    }, 5_000);

    const forwarded = listChatBlocks(config.instance, chat.id).find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId
    );
    expect(forwarded).toBeDefined();
    if (forwarded?.kind === "assistant_text") {
      expect(forwarded.forwardedFromTopicTitle).toBe("ping-watch");
      expect(forwarded.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("a channel-only job forwards NOTHING into the owning agent's Chat", async () => {
    const { getOrCreateAgentChat } = await import("./execution/chat");
    const { listChatBlocks, createChatSession } = await import("./state");
    const config = testConfig("jobs-channel-only-no-forward");

    const agentId = readState(config.instance).agents[0]!.id;
    const chat = await getOrCreateAgentChat(config.instance, agentId);
    const topicId = await mutateState(config.instance, (state) => {
      const topic = createChatSession(state, "report", undefined, agentId, "job", "channel");
      return topic.id;
    });
    // No forwardToChat: the answer stays in the Topic only.
    const job = await createScheduledJob(config, {
      name: "report",
      prompt: "echo ping",
      intervalSeconds: 60,
      chatSessionId: topicId,
      oneShot: true
    }, { originatingAgentId: agentId });
    expect(job.forwardToChat ?? false).toBe(false);

    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 1_000).toISOString();
    });

    await runDueJobs(config);

    // The answer materializes in the Topic.
    await waitFor(() => {
      const jobRun = readState(config.instance).jobRuns.find((run) => run.jobId === job.id);
      return jobRun?.status === "completed" || jobRun?.status === "failed";
    }, 5_000);
    await waitFor(
      () => readState(config.instance).chatMessages.some((m) => m.sessionId === topicId && m.role === "assistant"),
      5_000
    );

    // Nothing forwarded into the agent's Chat.
    expect(listChatBlocks(config.instance, chat.id).filter((b) => b.kind === "assistant_text")).toHaveLength(0);
  });

  test("syncChatTaskResult suppresses delivery when the task summary is [SILENT]", async () => {
    // The cron-execution hint instructs the LLM to emit "[SILENT]" when a
    // scheduled run has nothing new to report. syncChatTaskResult must
    // recognize the sentinel, skip creating an assistant ChatMessageRecord,
    // and audit the suppression.
    const config = testConfig("jobs-silent-suppress");

    const sessionId = "session_silent_test";
    const taskId = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Silent test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const task = createTask(state.instance, "watch for change", undefined, undefined, undefined, undefined);
      task.status = "completed";
      task.summary = "[SILENT]";
      task.updatedAt = new Date().toISOString();
      upsertTask(state, task);
      return task.id;
    });

    const result = await syncChatTaskResult(config, sessionId, taskId);
    expect(result).toBeNull();

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(0);

    const audit = stateAfter.audit.find(
      (event) => event.action === "chat.message.suppressed_silent" && event.target === sessionId
    );
    expect(audit).toBeDefined();
    expect(audit?.taskId).toBe(taskId);
  });

  test("syncChatTaskResult delivers when summary contains [SILENT] alongside other text", async () => {
    // The sentinel must match exactly. A summary like "[SILENT] but also..."
    // or a lowercase variant should NOT be suppressed — otherwise a reminder
    // that happens to mention the word could be silently dropped.
    const config = testConfig("jobs-silent-not-exact");

    const sessionId = "session_silent_strict";
    const taskId = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Strict",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const task = createTask(state.instance, "watch", undefined, undefined, undefined, undefined);
      task.status = "completed";
      task.summary = "[SILENT] with extra";
      task.updatedAt = new Date().toISOString();
      upsertTask(state, task);
      return task.id;
    });

    const result = await syncChatTaskResult(config, sessionId, taskId);
    expect(result).not.toBeNull();

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe("[SILENT] with extra");
  });

  test("dispatchJobReplyToBridge suppresses ONLY exact '[SILENT]'; any prefix-only match still dispatches", async () => {
    // Mirror invariant of the syncChatTaskResult test above, but for
    // the bridge dispatch path. Earlier code used `startsWith` here
    // which would have silently dropped a legitimate reply like
    // "[SILENT] but here's an update" while syncChatTaskResult
    // (correctly) delivered it to chat — meaning a scheduled job
    // would land in chat UI but never reach Telegram/Discord.
    const config = testConfig("jobs-silent-dispatch-strict");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({
      discordClientFactory: () => ({
        async getMe() {
          return { id: "100", username: "Gini", discriminator: "0000", bot: true };
        },
        async sendMessage(channelId, content) {
          sendCalls.push({ channelId, content });
          return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
        },
        async triggerTypingIndicator() {
          return true as const;
        },
        async fetchChannelMessages() {
          return [];
        }
      })
    });

    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, bridge.id, "chan-1");
        return session.id;
      });

      // "[SILENT] but here's an update" — must NOT be suppressed.
      const taskA = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT] but here's an update";
        t.jobId = "job_x";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        state.jobs.push({
          id: "job_x",
          instance: state.instance,
          name: "x",
          status: "active",
          prompt: "p",
          deliveryTargets: [],
          context: [],
          retryLimit: 0,
          timeoutSeconds: 600,
          chatSessionId: sessionId,
          runIds: [],
          taskIds: [],
          runCount: 0,
          missedRuns: 0,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.jobRuns.push({
          id: "run_x",
          instance: state.instance,
          jobId: "job_x",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });
      const taskAObj = readState(config.instance).tasks.find((t) => t.id === taskA)!;
      await finalizeJobRunFromTask(config, taskAObj);
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0]?.content).toContain("but here's an update");

      // Exact "[SILENT]" — must be suppressed.
      sendCalls.length = 0;
      const taskB = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled-silent", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT]";
        t.jobId = "job_x";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        state.jobRuns.push({
          id: "run_y",
          instance: state.instance,
          jobId: "job_x",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });
      const taskBObj = readState(config.instance).tasks.find((t) => t.id === taskB)!;
      await finalizeJobRunFromTask(config, taskBObj);
      expect(sendCalls.length).toBe(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("dispatchJobReplyToBridge threads a Slack mirror on the session's thread ROOT ts, never lastInboundMessageId", async () => {
    // The Slack session source carries two message coordinates:
    // threadTs (the thread root the session is keyed on) and
    // lastInboundMessageId (the most recent inbound ts, updated on
    // every message). chat.postMessage's thread_ts MUST be the root —
    // anchoring on a reply's own ts makes Slack fork a broken second
    // thread — so the finalizer's slack branch reads threadTs and
    // ignores lastInboundMessageId entirely.
    const config = testConfig("jobs-slack-thread-root");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateSlackChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const postCalls: Array<{ channel: string; text: string; threadTs?: string }> = [];
    setMessagingDeps({
      slackClientFactory: () => ({
        async authTest() {
          return { userId: "UBOT", user: "gini", teamId: "T1", team: "Acme" };
        },
        async postMessage(channel, text, options) {
          postCalls.push({ channel, text, ...(options?.threadTs ? { threadTs: options.threadTs } : {}) });
          return { channel, ts: "1700000010.000900" };
        },
        async addReaction() {
          return true as const;
        }
      })
    });

    try {
      const bridge = await addMessagingBridge(config, {
        name: "slk",
        kind: "slack",
        deliveryTargets: [],
        botToken: "xoxb-TOK",
        appToken: "xapp-TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateSlackChatSession(state, bridge.id, "D1", "1700000001.000100");
        // A follow-up inside the thread advanced the inbound stamp —
        // the dispatch must NOT anchor on it.
        if (session.source?.kind === "slack") {
          session.source.lastInboundMessageId = "1700000005.000500";
        }
        return session.id;
      });

      const taskId = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "reminder fired";
        t.jobId = "job_slk";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        state.jobs.push({
          id: "job_slk",
          instance: state.instance,
          name: "slk",
          status: "active",
          prompt: "p",
          deliveryTargets: [],
          context: [],
          retryLimit: 0,
          timeoutSeconds: 600,
          chatSessionId: sessionId,
          runIds: [],
          taskIds: [],
          runCount: 0,
          missedRuns: 0,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.jobRuns.push({
          id: "run_slk",
          instance: state.instance,
          jobId: "job_slk",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });
      const taskObj = readState(config.instance).tasks.find((t) => t.id === taskId)!;
      await finalizeJobRunFromTask(config, taskObj);
      expect(postCalls.length).toBe(1);
      expect(postCalls[0]?.channel).toBe("D1");
      expect(postCalls[0]?.threadTs).toBe("1700000001.000100");
      expect(postCalls[0]?.text).toContain("reminder fired");
    } finally {
      resetMessagingDeps();
    }
  });

  test("dispatchJobReplyToBridge ignores tool_transcript rows so a [SILENT] tool-using job stays suppressed", async () => {
    // A tool-using turn persists assistant rows tagged kind:"tool_transcript"
    // (model-facing replay narration) before the terminal summary. The bridge
    // dispatch picks the newest assistant row for the task; if it considered
    // the transcript row it would mirror that narration to Telegram/Discord
    // even though the terminal summary is "[SILENT]" — bypassing suppression.
    const config = testConfig("jobs-silent-tool-transcript");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({
      discordClientFactory: () => ({
        async getMe() {
          return { id: "100", username: "Gini", discriminator: "0000", bot: true };
        },
        async sendMessage(channelId, content) {
          sendCalls.push({ channelId, content });
          return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
        },
        async triggerTypingIndicator() {
          return true as const;
        },
        async fetchChannelMessages() {
          return [];
        }
      })
    });

    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, bridge.id, "chan-1");
        return session.id;
      });

      const taskId = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled-tool", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT]";
        t.jobId = "job_tool";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        // Seed a model-facing transcript assistant row with non-empty
        // narration for the same task — this must never be mirrored.
        createChatMessage(state, {
          sessionId,
          role: "assistant",
          content: "Let me check the calendar before replying.",
          taskId: t.id,
          runId: t.runId,
          kind: "tool_transcript"
        });
        state.jobs.push({
          id: "job_tool",
          instance: state.instance,
          name: "x",
          status: "active",
          prompt: "p",
          deliveryTargets: [],
          context: [],
          retryLimit: 0,
          timeoutSeconds: 600,
          chatSessionId: sessionId,
          runIds: [],
          taskIds: [],
          runCount: 0,
          missedRuns: 0,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.jobRuns.push({
          id: "run_tool",
          instance: state.instance,
          jobId: "job_tool",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });

      const taskObj = readState(config.instance).tasks.find((t) => t.id === taskId)!;
      await finalizeJobRunFromTask(config, taskObj);
      expect(sendCalls.length).toBe(0);
    } finally {
      resetMessagingDeps();
    }
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
