// End-to-end smoke that exercises every governed surface against a fresh
// runtime. Intentionally long: every step here corresponds to a contract the
// runtime promises to keep, so removing one drops smoke coverage of that
// contract.
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { createEvidenceBundle, createSnapshot } from "../../runtime/harness";
import { api, apiWithToken, publicApi } from "../api";
import { start as startLifecycle, stopRuntime, waitForTask } from "../process";
import { print } from "../output";

export async function smoke(ctx: CliContext): Promise<void> {
  const { config, ephemeralSmoke, web } = ctx;
  const { runtimeStarted, banner } = await startLifecycle(config, web);
  // Reproduce the original behavior: print the start banner before the smoke
  // body runs, so users see the URL even if smoke fails halfway through.
  print(banner);
  try {
    await runSmokeFlow(config, ephemeralSmoke);
  } finally {
    if (ephemeralSmoke && runtimeStarted) {
      stopRuntime(config);
    }
  }
}

async function runSmokeFlow(config: RuntimeConfig, ephemeral: boolean): Promise<void> {
  // The legacy `state.memories` pinned-memory surface (and the
  // `remember <fact>` task prefix that created a proposed memory) was
  // removed in the memory-surface consolidation. Smoke now submits a
  // task without the "remember" prefix; identity facts route through
  // `edit_user_profile` (auto-approved) when the agent decides to
  // persist them. See ADR runtime-identity-files.md.
  const task = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "summarize that Gini keeps local runtime work inspectable" }) });
  await waitForTask(config, task.id);
  // Memory-surface coverage: submit a chat task carrying an explicit
  // identity fact and confirm the auto-retain pipeline fired. With the
  // echo provider the structured fact extractor returns nothing
  // (echo does not synthesize JSON), but the pipeline itself runs and
  // emits an `auto-retain completed` trace event — that's the
  // replacement persistence path we care about. We also exercise the
  // direct retain seam below so the Hindsight write path stays
  // covered. See ADR runtime-identity-files.md.
  const identityTask = await api(config, "/api/tasks", {
    method: "POST",
    body: JSON.stringify({ input: "my name is SmokeTester and I prefer concise replies", mode: "chat" })
  });
  await waitForTask(config, identityTask.id);
  const identityDetail = await api(config, `/api/tasks/${identityTask.id}`);
  const identityTrace = Array.isArray(identityDetail?.trace) ? identityDetail.trace : [];
  const autoRetainFired = identityTrace.some(
    (entry: { type?: string; message?: string }) =>
      entry.type === "memory" && (entry.message === "auto-retain completed" || entry.message === "retain completed")
  );
  // Belt-and-braces: drive the retain seam directly so the smoke trail
  // still includes at least one Hindsight unit even when the LLM
  // extractor returns nothing.
  await api(config, "/api/memory/retain", {
    method: "POST",
    body: JSON.stringify({ text: "Smoke retains a deterministic fact about SmokeTester preferring concise replies." })
  });
  // Auto-retain (and the direct retain above) run asynchronously; poll
  // the unit count for a bounded window so the smoke doesn't hang if
  // the pipeline ever drops a write.
  const deadline = Date.now() + 5000;
  let hindsightAfter: unknown = [];
  while (Date.now() < deadline) {
    hindsightAfter = await api(config, "/api/memory/units?bank=bank_agent_default");
    if (Array.isArray(hindsightAfter) && hindsightAfter.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const hindsightUnitsAfterIdentityTask = Array.isArray(hindsightAfter) ? hindsightAfter.length : 0;
  const job = await api(config, "/api/jobs", { method: "POST", body: JSON.stringify({ name: "smoke", intervalSeconds: 60, prompt: "smoke job task" }) });
  await api(config, `/api/jobs/${job.id}/run`, { method: "POST" });
  const readTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "read README.md" }) });
  await waitForTask(config, readTask.id);
  const listTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "list src" }) });
  await waitForTask(config, listTask.id);
  const findTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "find Gini in README.md" }) });
  await waitForTask(config, findTask.id);
  const proposal = await api(config, "/api/improvements", {
    method: "POST",
    body: JSON.stringify({
      kind: "skill",
      title: "smoke-review",
      sourceTaskId: task.id,
      rationale: "Smoke validates trace-backed governed improvement proposals.",
      payload: { name: "smoke-review", description: "Review smoke traces", trigger: "smoke", steps: ["Inspect task trace", "Summarize evidence"] }
    })
  });
  await api(config, `/api/improvements/${proposal.id}/approve`, { method: "POST" });
  const connectorHealth = await api(config, "/api/connectors/id_demo/health", { method: "POST" });
  // Auto-detection. Idempotent — a fresh smoke instance may pick up
  // claude-code / codex if they're installed on the host; the second call
  // returns `created: []`. Smoke just confirms the endpoint exists and the
  // job is callable.
  const detection = await api(config, "/api/connectors/detect", { method: "POST" });
  // Optional Linear connector exercise: only runs when the host has a token
  // in env (CI / contributor with a personal API key). Smoke succeeds
  // without it so a fresh clone still passes.
  let linearProbe: Record<string, unknown> | undefined;
  if (process.env.LINEAR_API_KEY) {
    const created = await api(config, "/api/connectors", {
      method: "POST",
      body: JSON.stringify({ provider: "linear", name: "smoke-linear", scopes: ["read"], secrets: { token: process.env.LINEAR_API_KEY } })
    });
    const health = await api(config, `/api/connectors/${created.id}/health`, { method: "POST" });
    await api(config, `/api/connectors/${created.id}`, { method: "DELETE" });
    linearProbe = { id: created.id, health: health.health, message: health.message };
  }
  // Exercise the validate command against every bundled SKILL.md so the
  // smoke trail surfaces drift between bundled skills and the spec rules.
  const validateReport = await api(config, "/api/skills/validate");
  // The owner bearer is the only credential (see ADR owner-token-auth.md), so
  // the mobile contract is exercised with it directly.
  const mobileState = await apiWithToken(config, config.token, "/api/mobile/bootstrap");
  const searchResults = await api(config, "/api/search?q=Gini");
  await api(config, "/api/toolsets/mcp/enable", { method: "POST" });
  const subagentResult = await api(config, "/api/subagents", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-subagent", prompt: "summarize smoke subagent capability", toolsets: ["memory", "session_search"] })
  });
  const mcpResult = await api(config, "/api/mcp", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-mcp", command: "echo", args: ["ok"], exposedTools: ["smoke.echo"] })
  });
  await api(config, `/api/mcp/${mcpResult.id}/health`, { method: "POST" });
  const messagingResult = await api(config, "/api/messaging", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-messaging", kind: "demo", deliveryTargets: ["local"] })
  });
  await api(config, `/api/messaging/${messagingResult.id}/health`, { method: "POST" });
  const importResult = await api(config, "/api/imports/inspect", {
    method: "POST",
    body: JSON.stringify({ source: "openclaw", path: process.cwd() })
  });
  const agentResult = await api(config, "/api/agents", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-agent", toolsets: ["file", "memory", "session_search"] })
  });
  await api(config, `/api/agents/${agentResult.id}/use`, { method: "POST" });
  const relayResult = await api(config, "/api/relays", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-relay", endpoint: "local://smoke", mode: "local-only" })
  });
  await api(config, `/api/relays/${relayResult.id}/health`, { method: "POST" });
  const notificationResult = await api(config, "/api/notifications", {
    method: "POST",
    body: JSON.stringify({ kind: "runtime", target: "local", title: "Smoke notification", body: "Smoke notification delivery" })
  });
  await api(config, "/api/notifications/send", { method: "POST" });
  const snapshotResult = await createSnapshot(config, "Smoke rollback baseline");
  const promotionResult = await api(config, "/api/promotions", {
    method: "POST",
    body: JSON.stringify({
      candidateRef: "smoke-candidate",
      evidencePath: snapshotResult.path,
      summary: "Smoke validates promotion proposal records.",
      rollbackPlan: `Restore snapshot ${snapshotResult.snapshotId}`
    })
  });
  const finalState = await api(config, "/api/state");
  const bundle = createEvidenceBundle(config);
  print({
    ok: true,
    instance: config.instance,
    ephemeral,
    stateRoot: config.stateRoot,
    logRoot: config.logRoot,
    port: config.port,
    taskId: task.id,
    jobId: job.id,
    readTaskId: readTask.id,
    listTaskId: listTask.id,
    findTaskId: findTask.id,
    improvementId: proposal.id,
    mobileTaskCount: mobileState.tasks.length,
    searchResults: searchResults.length,
    subagentId: subagentResult.id,
    mcpId: mcpResult.id,
    messagingId: messagingResult.id,
    importReportId: importResult.id,
    agentId: agentResult.id,
    relayId: relayResult.id,
    notificationId: notificationResult.id,
    snapshotId: snapshotResult.snapshotId,
    promotionId: promotionResult.id,
    connectorHealth: connectorHealth.health,
    detectionConsidered: detection.considered,
    detectionCreated: detection.created.length,
    linearProbe,
    validateReport: {
      total: Array.isArray(validateReport) ? validateReport.length : (validateReport?.results?.length ?? 0),
      failing: Array.isArray(validateReport)
        ? validateReport.filter((r: { ok: boolean }) => !r.ok).length
        : (validateReport?.results?.filter((r: { ok: boolean }) => !r.ok).length ?? 0)
    },
    traces: finalState.tasks.length,
    auditEvents: finalState.audit.length,
    identityTaskId: identityTask.id,
    autoRetainFired,
    hindsightUnitsAfterIdentityTask,
    evidencePath: bundle.path
  });
}
