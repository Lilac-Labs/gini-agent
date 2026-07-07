// Job delivery-policy tests (JobDeliveryPolicy in types.ts).
//
// What these cover:
// - create/update validation: enum rejection, the silent × oneShot rejection
//   (create time AND a later patch), persistence through createScheduledJob,
//   updateJob, and the raw HTTP POST/PATCH /api/jobs path
// - headless mint: a silent job's dedicated working thread is created
//   `headless: true` and excluded from unscoped GET /api/chat (still
//   addressable by id)
// - the [SILENT] hint is injected into the dispatched prompt ONLY for
//   deliveryPolicy "on_findings"
// - finalizeJobRunFromTask policy matrix × completed/failed: "silent" skips
//   the Topic → Chat forward and the deliveryTargets fan-out entirely (while
//   the in-thread sync still lands); "always" and "on_findings" keep
//   delivering, with the [SILENT] sentinel honored under every policy.

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "../http";
import { createScheduledJob, runJobNow, updateJob } from "./index";
import { finalizeJobRunFromTask } from "./finalize";
import { dispatchToolCall } from "../execution/tool-dispatch";
import {
  createJobRun,
  createTask,
  createTopic,
  listChatBlocks,
  mutateState,
  readState,
  upsertTask
} from "../state";
import type { JobRecord, RuntimeConfig, Task } from "../types";

describe("job delivery policy", () => {
  test("createScheduledJob rejects an unknown deliveryPolicy value", async () => {
    const config = testConfig("delivery-policy-bad-enum");
    await expect(
      createScheduledJob(config, { name: "bad", prompt: "p", intervalSeconds: 60, deliveryPolicy: "sometimes" })
    ).rejects.toThrow("Invalid input: deliveryPolicy");
  });

  test("createScheduledJob rejects deliveryPolicy 'silent' on a one-shot reminder", async () => {
    const config = testConfig("delivery-policy-silent-oneshot");
    await expect(
      createScheduledJob(config, { name: "reminder", prompt: "p", intervalSeconds: 60, oneShot: true, deliveryPolicy: "silent" })
    ).rejects.toThrow('deliveryPolicy "silent" is not allowed on one-shot reminder jobs');
    // The rejection left no job behind.
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("createScheduledJob persists the supplied policy and defaults absent to 'always'", async () => {
    const config = testConfig("delivery-policy-persist");
    const watch = await createScheduledJob(config, { name: "watch", prompt: "p", intervalSeconds: 60, deliveryPolicy: "on_findings" });
    const plain = await createScheduledJob(config, { name: "plain", prompt: "p", intervalSeconds: 60 });
    expect(watch.deliveryPolicy).toBe("on_findings");
    expect(plain.deliveryPolicy).toBe("always");
  });

  test("updateJob patches deliveryPolicy but rejects 'silent' on a one-shot job", async () => {
    const config = testConfig("delivery-policy-update");
    const job = await createScheduledJob(config, { name: "digest", prompt: "p", intervalSeconds: 60 });
    const patched = await updateJob(config, job.id, { deliveryPolicy: "on_findings" });
    expect(patched.deliveryPolicy).toBe("on_findings");

    const reminder = await createScheduledJob(config, { name: "reminder", prompt: "p", intervalSeconds: 60, oneShot: true });
    await expect(updateJob(config, reminder.id, { deliveryPolicy: "silent" })).rejects.toThrow(
      'deliveryPolicy "silent" is not allowed on one-shot reminder jobs'
    );
    expect(readState(config.instance).jobs.find((j) => j.id === reminder.id)?.deliveryPolicy).toBe("always");
  });

  // Seed a running task so the update_job tool path (which audits against a
  // live parent task) can be driven directly via dispatchToolCall.
  async function seedRunningTask(config: RuntimeConfig): Promise<string> {
    return mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "manage jobs");
      task.status = "running";
      upsertTask(state, task);
      return task.id;
    });
  }

  async function updateJobViaTool(
    config: RuntimeConfig,
    taskId: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const result = await dispatchToolCall(config, taskId, "update_job", `call_${Math.random().toString(36).slice(2)}`, JSON.stringify(args));
    if (result.kind !== "sync") throw new Error(`expected a sync update_job result, got ${result.kind}`);
    return result.result;
  }

  test("update_job rejects oneShot:true when the same call flips deliveryPolicy to 'silent'", async () => {
    const config = testConfig("delivery-policy-tool-same-call");
    const job = await createScheduledJob(config, {
      name: "watch",
      prompt: "p",
      intervalSeconds: 60,
      createDedicatedSession: { title: "Watch" }
    });
    const taskId = await seedRunningTask(config);
    await expect(
      updateJobViaTool(config, taskId, { jobId: job.id, deliveryPolicy: "silent", oneShot: true })
    ).rejects.toThrow('deliveryPolicy "silent" is not allowed on one-shot reminder jobs');
    // The rejection is atomic: NOTHING from the refused call persists. The
    // policy stays audible, the job stays recurring, and the dedicated
    // channel never flips headless — a half-patched job (policy committed,
    // oneShot refused) would silently hide the channel while the tool
    // reports "Invalid input".
    const after = readState(config.instance).jobs.find((j) => j.id === job.id)!;
    expect(after.deliveryPolicy).toBe("always");
    expect(after.oneShot).not.toBe(true);
    expect(
      readState(config.instance).chatSessions.find((s) => s.id === job.chatSessionId)?.headless
    ).toBeUndefined();
  });

  test("update_job converts a one-shot reminder to a recurring silent watch in one call", async () => {
    const config = testConfig("delivery-policy-tool-reminder-to-watch");
    const reminder = await createScheduledJob(config, {
      name: "follow up",
      prompt: "p",
      intervalSeconds: 60,
      oneShot: true,
      createDedicatedSession: { title: "Follow up" }
    });
    const taskId = await seedRunningTask(config);
    // The silent × one-shot rejection must judge the EFFECTIVE post-patch
    // shape: this call also clears oneShot, so silent is legal in the same
    // call (no two-step dance required).
    const result = await updateJobViaTool(config, taskId, {
      jobId: reminder.id,
      deliveryPolicy: "silent",
      oneShot: false
    });
    expect(result).toContain("Updated job");
    const after = readState(config.instance).jobs.find((j) => j.id === reminder.id)!;
    expect(after.deliveryPolicy).toBe("silent");
    expect(after.oneShot).toBe(false);
    expect(
      readState(config.instance).chatSessions.find((s) => s.id === reminder.chatSessionId)?.headless
    ).toBe(true);
  });

  test("update_job rejects oneShot:true on an already-silent job", async () => {
    const config = testConfig("delivery-policy-tool-oneshot-on-silent");
    const job = await createScheduledJob(config, {
      name: "quiet watch",
      prompt: "p",
      intervalSeconds: 60,
      deliveryPolicy: "silent"
    });
    const taskId = await seedRunningTask(config);
    await expect(
      updateJobViaTool(config, taskId, { jobId: job.id, oneShot: true })
    ).rejects.toThrow('deliveryPolicy "silent" is not allowed on one-shot reminder jobs');
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.oneShot).not.toBe(true);
  });

  test("updateJob deliveryPolicy flips sync the dedicated channel's headless bit in both directions", async () => {
    const config = testConfig("delivery-policy-headless-sync");
    const job = await createScheduledJob(config, {
      name: "inbox watch",
      prompt: "scan",
      intervalSeconds: 60,
      createDedicatedSession: { title: "Inbox watch" }
    });
    const sessionOf = () => readState(config.instance).chatSessions.find((s) => s.id === job.chatSessionId);
    expect(sessionOf()?.headless).toBeUndefined();

    // Flipping TO silent hides the working thread (same invariant as the
    // createScheduledJob / rebindJobDelivery mint paths).
    await updateJob(config, job.id, { deliveryPolicy: "silent" });
    expect(sessionOf()?.headless).toBe(true);

    // Flipping AWAY from silent surfaces it again.
    await updateJob(config, job.id, { deliveryPolicy: "always" });
    expect(sessionOf()?.headless).toBeUndefined();
  });

  test("HTTP POST /api/jobs and PATCH /api/jobs accept deliveryPolicy", async () => {
    const config = testConfig("delivery-policy-http");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "http watch", prompt: "p", intervalSeconds: 60, deliveryPolicy: "silent" })
    });
    expect(job.deliveryPolicy).toBe("silent");
    const patched = await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ deliveryPolicy: "always" })
    });
    expect(patched.deliveryPolicy).toBe("always");
  });

  test("a silent job's dedicated working thread is minted headless; other policies stay visible", async () => {
    const config = testConfig("delivery-policy-headless-mint");
    const silent = await createScheduledJob(config, {
      name: "inbox watch",
      prompt: "scan",
      intervalSeconds: 60,
      deliveryPolicy: "silent",
      createDedicatedSession: { title: "Inbox watch" }
    });
    const audible = await createScheduledJob(config, {
      name: "daily digest",
      prompt: "digest",
      intervalSeconds: 60,
      createDedicatedSession: { title: "Daily digest" }
    });
    const sessions = readState(config.instance).chatSessions;
    expect(sessions.find((s) => s.id === silent.chatSessionId)?.headless).toBe(true);
    expect(sessions.find((s) => s.id === audible.chatSessionId)?.headless).toBeUndefined();
  });

  test("headless containers are excluded from unscoped GET /api/chat but stay addressable by id", async () => {
    const config = testConfig("delivery-policy-headless-list");
    const handler = createHandler(config);
    const { headlessId, visibleId } = await mutateState(config.instance, (state) => {
      const visible = createTopic(state, { title: "Visible topic" });
      const headless = createTopic(state, { title: "Watch thread", headless: true });
      return { headlessId: headless.id, visibleId: visible.id };
    });
    const sessions = await call(handler, config, "/api/chat");
    expect(sessions.some((s: { id: string }) => s.id === visibleId)).toBe(true);
    expect(sessions.some((s: { id: string }) => s.id === headlessId)).toBe(false);
    const direct = await call(handler, config, `/api/chat/${headlessId}`);
    expect(direct.id).toBe(headlessId);
  });

  test("the [SILENT] hint is injected into the dispatched prompt only for 'on_findings'", async () => {
    const config = testConfig("delivery-policy-hint-gate");
    const onFindings = await createScheduledJob(config, { name: "watch", prompt: "scan the inbox", intervalSeconds: 3600, deliveryPolicy: "on_findings" });
    const always = await createScheduledJob(config, { name: "digest", prompt: "write the digest", intervalSeconds: 3600 });
    const silent = await createScheduledJob(config, { name: "quiet watch", prompt: "scan quietly", intervalSeconds: 3600, deliveryPolicy: "silent" });

    const dispatched: Record<string, string> = {};
    for (const job of [onFindings, always, silent]) {
      const result = await runJobNow(config, job.id);
      const taskId = (result as { taskId: string }).taskId;
      dispatched[job.id] = readState(config.instance).tasks.find((t) => t.id === taskId)!.input;
    }
    // The scheduled-job framing reaches every policy; the sentinel
    // invitation reaches only on_findings.
    for (const job of [onFindings, always, silent]) {
      expect(dispatched[job.id]).toContain("You are running as a scheduled job");
    }
    expect(dispatched[onFindings.id]).toContain('respond with exactly "[SILENT]"');
    expect(dispatched[always.id]).not.toContain("[SILENT]");
    expect(dispatched[silent.id]).not.toContain("[SILENT]");

    // Let the echo turns settle so teardown doesn't race in-flight writes.
    await waitFor(
      () => readState(config.instance).tasks.every((t) => ["completed", "failed", "cancelled"].includes(t.status)),
      8_000
    );
  });

  // ─── finalizeJobRunFromTask policy matrix ────────────────────────────────
  // Each scenario builds a job with a dedicated Topic, forwardToChat, and a
  // deliveryTargets entry that resolves to NO bridge — so an ATTEMPTED
  // deliveryTargets dispatch is observable as a job.delivery.failed audit
  // row, and a skipped fan-out leaves none. The Topic → Chat forward is
  // observable as an assistant_text block in the agent chat tagged
  // forwardedFromTopicId.

  async function seedFinalizedRun(
    config: RuntimeConfig,
    input: { name: string; deliveryPolicy?: string },
    outcome: { status: "completed" | "failed"; summary?: string; error?: string }
  ): Promise<{ job: JobRecord; task: Task }> {
    const job = await createScheduledJob(config, {
      name: input.name,
      prompt: "watch the inbox",
      intervalSeconds: 3600,
      forwardToChat: true,
      deliveryTargets: ["telegram"],
      createDedicatedSession: { title: input.name },
      ...(input.deliveryPolicy ? { deliveryPolicy: input.deliveryPolicy } : {})
    });
    const task = await mutateState(config.instance, (state) => {
      const t = createTask(state.instance, "fire", job.id, undefined, undefined, undefined, job.agentId, job.chatSessionId);
      t.status = outcome.status;
      t.summary = outcome.summary;
      t.error = outcome.error;
      upsertTask(state, t);
      const run = createJobRun(state, { jobId: job.id, trigger: "schedule", agentId: job.agentId });
      run.taskId = t.id;
      return t;
    });
    await finalizeJobRunFromTask(config, task);
    return { job, task };
  }

  function forwardedBlocks(config: RuntimeConfig, job: JobRecord) {
    const agentChat = readState(config.instance).chatSessions.find(
      (s) => s.kind === "agent" && s.agentId === job.agentId
    );
    if (!agentChat) return [];
    return listChatBlocks(config.instance, agentChat.id).filter(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === job.chatSessionId
    );
  }

  function deliveryAttempted(config: RuntimeConfig, jobId: string): boolean {
    return readState(config.instance).audit.some(
      (event) => event.action === "job.delivery.failed" && event.target === jobId
    );
  }

  test("always + completed: the reply forwards to Chat and deliveryTargets dispatch is attempted", async () => {
    const config = testConfig("delivery-policy-always-completed");
    const { job, task } = await seedFinalizedRun(config, { name: "always job" }, { status: "completed", summary: "Found two receipts." });
    const run = readState(config.instance).jobRuns.find((r) => r.taskId === task.id);
    expect(run?.status).toBe("completed");
    expect(forwardedBlocks(config, job).length).toBe(1);
    expect(deliveryAttempted(config, job.id)).toBe(true);
  });

  test("always + failed: the error still reaches deliveryTargets (unchanged semantics)", async () => {
    const config = testConfig("delivery-policy-always-failed");
    const { job, task } = await seedFinalizedRun(config, { name: "failing job" }, { status: "failed", error: "boom" });
    const run = readState(config.instance).jobRuns.find((r) => r.taskId === task.id);
    expect(run?.status).toBe("failed");
    expect(deliveryAttempted(config, job.id)).toBe(true);
    // forwardToChat only forwards completed runs — unchanged.
    expect(forwardedBlocks(config, job).length).toBe(0);
  });

  test("silent + completed: run finalizes and the reply lands in the working thread, but no forward and no deliveryTargets dispatch", async () => {
    const config = testConfig("delivery-policy-silent-completed");
    const { job, task } = await seedFinalizedRun(
      config,
      { name: "silent watch", deliveryPolicy: "silent" },
      { status: "completed", summary: "Drafted a reply for msg 42." }
    );
    const run = readState(config.instance).jobRuns.find((r) => r.taskId === task.id);
    expect(run?.status).toBe("completed");
    // The in-thread sync still materializes the assistant reply — the
    // (headless) working thread is the run's journal.
    const synced = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === job.chatSessionId && m.taskId === task.id && m.role === "assistant"
    );
    expect(synced.length).toBe(1);
    expect(forwardedBlocks(config, job).length).toBe(0);
    expect(deliveryAttempted(config, job.id)).toBe(false);
  });

  test("silent + failed: the delivery fan-out is skipped for failed runs too", async () => {
    const config = testConfig("delivery-policy-silent-failed");
    const { job, task } = await seedFinalizedRun(
      config,
      { name: "silent watch", deliveryPolicy: "silent" },
      { status: "failed", error: "boom" }
    );
    const run = readState(config.instance).jobRuns.find((r) => r.taskId === task.id);
    expect(run?.status).toBe("failed");
    expect(forwardedBlocks(config, job).length).toBe(0);
    expect(deliveryAttempted(config, job.id)).toBe(false);
  });

  test("on_findings + real reply delivers; on_findings + [SILENT] suppresses", async () => {
    const config = testConfig("delivery-policy-on-findings");
    const finding = await seedFinalizedRun(
      config,
      { name: "watch with finding", deliveryPolicy: "on_findings" },
      { status: "completed", summary: "New invoice from Acme." }
    );
    expect(forwardedBlocks(config, finding.job).length).toBe(1);
    expect(deliveryAttempted(config, finding.job.id)).toBe(true);

    const quiet = await seedFinalizedRun(
      config,
      { name: "watch without finding", deliveryPolicy: "on_findings" },
      { status: "completed", summary: "[SILENT]" }
    );
    expect(forwardedBlocks(config, quiet.job).length).toBe(0);
    expect(deliveryAttempted(config, quiet.job.id)).toBe(false);
    // The suppression is audited on the sync path, same as today.
    expect(
      readState(config.instance).audit.some(
        (event) => event.action === "chat.message.suppressed_silent" && event.taskId === quiet.task.id
      )
    ).toBe(true);
  });

  test("always + [SILENT]: an emitted sentinel is still honored (existing-job semantics unchanged)", async () => {
    const config = testConfig("delivery-policy-always-silent-reply");
    const { job, task } = await seedFinalizedRun(
      config,
      { name: "legacy watch" },
      { status: "completed", summary: "[SILENT]" }
    );
    expect(forwardedBlocks(config, job).length).toBe(0);
    expect(deliveryAttempted(config, job.id)).toBe(false);
    expect(
      readState(config.instance).audit.some(
        (event) => event.action === "chat.message.suppressed_silent" && event.taskId === task.id
      )
    ).toBe(true);
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) }
  }));
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-delivery-policy-tests";
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}
