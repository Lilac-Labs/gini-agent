// Approve-responds-when-durable contract (live-QA bug: the approve HTTP
// response blocked on the executor for the command's full runtime and
// died empty at the server idle timeout). decideApproval("approve") now
// returns once the decision is DURABLE — approval row flipped +
// authorization.approved audit persisted — while the side effect,
// result feed-back, and resume run detached through the same pipeline.
// The execution audit row keeps its exact semantics: written AT
// execution time, stamped with the approvalId (the restart wedge-heal's
// executed-proof depends on it).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideApproval } from "../agent";
import { mutateState, readState } from "../state";
import { createAuthorization } from "../state/records";
import type { RuntimeConfig, Task } from "../types";

let root: string;
let workspaceRoot: string;
let prevState: string | undefined;
let prevLog: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-approve-detached-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approve-detached-ws-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-logs`, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7342,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: root,
    logRoot: `${root}-logs`
  };
}

// Seed a parked task + pending terminal.exec authorization directly (no
// model loop) so the executor timing is the only variable under test.
async function seedParkedTerminalApproval(
  config: RuntimeConfig,
  command: string,
  timeoutMs: number
): Promise<{ taskId: string; approvalId: string }> {
  return mutateState(config.instance, (state) => {
    const at = new Date().toISOString();
    const task: Task = {
      id: "task_gated",
      title: "gated",
      input: "gated",
      status: "waiting_approval",
      currentStep: "Waiting for approval",
      instance: state.instance,
      createdAt: at,
      updatedAt: at,
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: []
    };
    state.tasks.push(task);
    const approval = createAuthorization(state, {
      taskId: task.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "test",
      payload: { command, timeoutMs }
    });
    task.approvalIds.push(approval.id);
    return { taskId: task.id, approvalId: approval.id };
  });
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

test("approve returns once durable — before a slow executor finishes — and the result still feeds back", async () => {
  const config = buildConfig("approve-detached");
  const { taskId, approvalId } = await seedParkedTerminalApproval(config, "sleep 0.5; echo finished", 30_000);

  const started = Date.now();
  const approved = await decideApproval(config, approvalId, "approve");
  const elapsed = Date.now() - started;

  // Durable decision returned immediately — long before the detached
  // executor's ~0.5s command finishes and writes its terminal.exec row.
  // A 0.5s command keeps the durable-but-not-executed window wide enough
  // to observe below (the synchronous read at return happens within a few
  // ms, before the detached executor has even spawned) while keeping the
  // wall-clock floor small; the assertion budget stays well above return.
  expect(elapsed).toBeLessThan(1_500);
  expect(approved.status).toBe("approved");
  const stateAtReturn = readState(config.instance);
  expect(
    stateAtReturn.audit.some((a) => a.action === "authorization.approved" && a.approvalId === approvalId)
  ).toBe(true);
  // The side effect has NOT run yet — no terminal.exec row. This is the
  // durable-but-not-executed window the restart heal hedges on.
  expect(
    stateAtReturn.audit.some((a) => a.action === "terminal.exec" && a.approvalId === approvalId)
  ).toBe(false);

  // Executing signal: while the detached executor runs, the task's
  // currentStep reports execution truthfully (status stays
  // waiting_approval — no new TaskStatus this round). The stamp carries
  // the approval id as an ownership token after the visible prefix.
  expect(
    await pollUntil(() => {
      const t = readState(config.instance).tasks.find((x) => x.id === taskId);
      return (
        t?.currentStep?.startsWith("Executing terminal.exec…") === true &&
        t.currentStep.includes(approvalId) &&
        t.status === "waiting_approval"
      );
    }, 2_000)
  ).toBe(true);

  // Execution completes detached: the terminal.exec audit row is
  // written at execution time with the approvalId, and the task settles.
  expect(
    await pollUntil(() => {
      const state = readState(config.instance);
      return state.audit.some((a) => a.action === "terminal.exec" && a.approvalId === approvalId);
    }, 10_000)
  ).toBe(true);
  expect(
    await pollUntil(() => readState(config.instance).tasks.find((x) => x.id === taskId)?.status === "completed", 10_000)
  ).toBe(true);
  const settled = readState(config.instance).tasks.find((x) => x.id === taskId);
  // The executing stamp was replaced on settle, never left dangling.
  expect(settled?.currentStep).toBe("Completed");
}, 20_000);

test("double-approve while the first approval is executing fails cleanly on the non-pending row", async () => {
  const config = buildConfig("approve-double");
  const { taskId, approvalId } = await seedParkedTerminalApproval(config, "sleep 0.5", 30_000);

  const approved = await decideApproval(config, approvalId, "approve");
  expect(approved.status).toBe("approved");

  // Second approve while the detached executor is still running: the
  // durable-persist claim throws on the non-pending row.
  await expect(decideApproval(config, approvalId, "approve")).rejects.toThrow(/already approved/);

  // Only ONE execution happens.
  await pollUntil(() => readState(config.instance).tasks.find((x) => x.id === taskId)?.status === "completed", 10_000);
  const rows = readState(config.instance).audit.filter(
    (a) => a.action === "terminal.exec" && a.approvalId === approvalId
  );
  expect(rows).toHaveLength(1);
}, 20_000);
