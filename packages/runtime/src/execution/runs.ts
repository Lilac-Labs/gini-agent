import type { RuntimeConfig, RunRecord, RunStatus, Task } from "../types";
import { createPlanStep, createRun, isTerminalTaskStatus, mutateState, now, readState } from "../state";

export function listRuns(config: RuntimeConfig) {
  const state = readState(config.instance);
  return state.runs.map((run) => hydrateRun(state, run));
}

export function getRun(config: RuntimeConfig, id: string) {
  const state = readState(config.instance);
  const run = state.runs.find((item) => item.id === id);
  if (!run) throw new Error(`Run not found: ${id}`);
  return hydrateRun(state, run);
}

export async function createConversationRun(
  config: RuntimeConfig,
  input: {
    conversationId: string;
    input: string;
    title?: string;
    parentRunId?: string;
  }
) {
  return mutateState(config.instance, (state) => {
    const run = createRun(state, {
      kind: "conversation_turn",
      title: input.title ?? (input.input.slice(0, 80) || "Conversation run"),
      input: input.input,
      conversationId: input.conversationId,
      parentRunId: input.parentRunId
    });
    createPlanStep(state, { runId: run.id, title: "Understand the user request" });
    createPlanStep(state, { runId: run.id, title: "Execute through the runtime when work is needed" });
    return run;
  });
}

export async function linkRunToTask(config: RuntimeConfig, runId: string, task: Task) {
  await mutateState(config.instance, (state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) return;
    run.taskId = task.id;
    run.status = taskToRunStatus(task.status);
    run.startedAt ??= task.createdAt;
    run.updatedAt = now();
    const step = state.planSteps.find((item) => item.runId === run.id && item.title.includes("Execute"));
    if (step) {
      step.taskId = task.id;
      step.status = run.status === "queued" ? "pending" : run.status === "waiting_approval" ? "running" : run.status;
      step.updatedAt = run.updatedAt;
    }
  });
}

export async function updateRunFromTask(config: RuntimeConfig, task: Task) {
  if (!task.runId) return;
  await mutateState(config.instance, (state) => {
    const run = state.runs.find((item) => item.id === task.runId);
    if (!run) return;
    run.taskId = task.id;
    run.status = taskToRunStatus(task.status);
    run.summary = task.summary;
    run.error = task.error;
    run.cost = task.cost;
    run.updatedAt = now();
    if (task.status === "running") run.startedAt ??= run.updatedAt;
    if (isTerminalTaskStatus(task.status)) run.completedAt = run.updatedAt;
    run.approvalIds = Array.from(new Set([...run.approvalIds, ...task.approvalIds]));
    const executeStep = state.planSteps.find((item) => item.runId === run.id && item.taskId === task.id)
      ?? state.planSteps.find((item) => item.runId === run.id && item.title.includes("Execute"));
    if (executeStep) {
      executeStep.taskId = task.id;
      executeStep.status = runStatusToStepStatus(run.status);
      executeStep.summary = task.summary;
      executeStep.error = task.error;
      executeStep.updatedAt = run.updatedAt;
      if (["completed", "failed", "cancelled"].includes(executeStep.status)) executeStep.completedAt = run.updatedAt;
    }
    const understandStep = state.planSteps.find((item) => item.runId === run.id && item.title.includes("Understand"));
    if (understandStep && understandStep.status === "pending") {
      understandStep.status = "completed";
      understandStep.completedAt = run.updatedAt;
      understandStep.updatedAt = run.updatedAt;
    }
  });
}

function hydrateRun(state: ReturnType<typeof readState>, run: RunRecord) {
  return {
    ...run,
    planSteps: state.planSteps.filter((step) => step.runId === run.id),
    childRuns: state.runs.filter((child) => child.parentRunId === run.id),
    task: run.taskId ? state.tasks.find((task) => task.id === run.taskId) : undefined
  };
}

function taskToRunStatus(status: Task["status"]): RunStatus {
  // needs_input is a Task-level refinement of the same park; RunRecord's
  // union deliberately does NOT grow (rename staging — RunRecord is slated
  // for consolidation, so its wire contract stays frozen).
  if (status === "waiting_approval" || status === "needs_input") return "waiting_approval";
  return status;
}

function runStatusToStepStatus(status: RunStatus) {
  if (status === "waiting_approval") return "running";
  if (status === "queued") return "pending";
  return status;
}
