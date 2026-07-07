// Tests for reconcileInFlightTasks — the boot reconciliation pass that
// resumes top-level chat turns interrupted by a previous process and fails
// every other orphan so nothing hangs. A fake dispatch captures the resumed
// ids so no real model call runs. See ADR task-resume-on-restart.md.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { reconcileInFlightTasks } from "./agent";
import { createTask, mutateState, now, readState, upsertTask } from "./state";
import type { RuntimeConfig, Task, TaskStatus } from "./types";

const ROOT = "/tmp/gini-agent-reconcile-test";
// A timestamp earlier than any task this process writes, so orphans seeded
// with `updatedAt: OLD` predate the cutoff. The cutoff itself is captured per
// test via now() so freshly-seeded tasks fall on the right side of it.
const OLD = "2020-01-01T00:00:00.000Z";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;
let instance = "";
let config: RuntimeConfig;

beforeEach(() => {
  // Unique instance per test so state never bleeds across cases.
  instance = `reconcile-${counter++}`;
  config = {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
});

// Seed one task with arbitrary status/mode/parent/timestamps directly into
// state, returning its id.
async function seed(overrides: Partial<Task> & { status: TaskStatus }): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, overrides.input ?? "do a thing");
    Object.assign(task, overrides);
    upsertTask(state, task);
    return task.id;
  });
}

function getTask(id: string): Task {
  const task = readState(config.instance).tasks.find((t) => t.id === id);
  if (!task) throw new Error(`task ${id} missing`);
  return task;
}

// A dispatch that records which ids were dispatched and resolves immediately,
// so resume never invokes the real chat loop / provider.
function fakeDispatch(): { ids: string[]; fn: (c: RuntimeConfig, id: string) => Promise<unknown> } {
  const ids: string[] = [];
  return {
    ids,
    fn: async (_c, id) => {
      ids.push(id);
    }
  };
}

// Let the fire-and-forget dispatch promises in reconcileInFlightTasks settle.
async function flush(): Promise<void> {
  await Bun.sleep(5);
}

describe("reconcileInFlightTasks", () => {
  test("resumes a running top-level chat orphan, clearing partialSummary", async () => {
    const id = await seed({
      status: "running",
      mode: "chat",
      updatedAt: OLD,
      partialSummary: "stale streamed text"
    });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.resumed).toEqual([id]);
    expect(result.failed).toEqual([]);
    expect(dispatch.ids).toEqual([id]);
    const task = getTask(id);
    expect(task.partialSummary).toBe("");
    expect(task.bootResumeCount).toBe(1);
    expect(task.currentStep).toBe("Thinking");
  });

  test("resumes a queued chat orphan", async () => {
    const id = await seed({ status: "queued", mode: "chat", updatedAt: OLD });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.resumed).toEqual([id]);
    expect(dispatch.ids).toEqual([id]);
  });

  test("leaves a waiting_approval task with a pending gate untouched", async () => {
    // A real park always has a pending gate — durable state waiting on the
    // user. (A gate-less park with no resume snapshot is a different shape:
    // an unrecoverable failure-path artifact the reconcile fails honestly —
    // pinned in chat-needs-input.test.ts.)
    const id = await seed({ status: "waiting_approval", mode: "chat", updatedAt: OLD });
    await mutateState(config.instance, (state) => {
      state.authorizations.push({
        id: "auth_pending",
        instance: state.instance,
        status: "pending",
        createdAt: OLD,
        updatedAt: OLD,
        taskId: id,
        action: "terminal.exec",
        target: "echo hi",
        risk: "high",
        reason: "test gate",
        payload: {}
      });
    });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.resumed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(id).status).toBe("waiting_approval");
  });

  test("leaves terminal tasks untouched", async () => {
    const completed = await seed({ status: "completed", mode: "chat", updatedAt: OLD });
    const failed = await seed({ status: "failed", mode: "chat", updatedAt: OLD });
    const cancelled = await seed({ status: "cancelled", mode: "chat", updatedAt: OLD });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.resumed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(completed).status).toBe("completed");
    expect(getTask(failed).status).toBe("failed");
    expect(getTask(cancelled).status).toBe("cancelled");
  });

  test("ignores a running chat task updated after the cutoff (race guard)", async () => {
    // updatedAt defaults to now() at seed time, which is >= the cutoff we pass.
    const cutoff = now();
    await Bun.sleep(2);
    const id = await seed({ status: "running", mode: "chat" });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: cutoff, dispatch: dispatch.fn });
    await flush();

    expect(result.resumed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(id).status).toBe("running");
  });

  test("fails a subagent orphan without dispatching", async () => {
    const id = await seed({ status: "running", mode: "chat", parentTaskId: "task_parent", updatedAt: OLD });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.failed).toEqual([id]);
    expect(result.resumed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(id).status).toBe("failed");
  });

  test("fails an imperative orphan without dispatching", async () => {
    const id = await seed({ status: "running", mode: "imperative", updatedAt: OLD });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.failed).toEqual([id]);
    expect(result.resumed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(id).status).toBe("failed");
  });

  test("fails a chat orphan that would exceed the resume cap without dispatching", async () => {
    const id = await seed({ status: "running", mode: "chat", updatedAt: OLD, bootResumeCount: 3 });
    const dispatch = fakeDispatch();

    const result = await reconcileInFlightTasks(config, { cutoffIso: now(), dispatch: dispatch.fn });
    await flush();

    expect(result.failed).toEqual([id]);
    expect(result.resumed).toEqual([]);
    expect(dispatch.ids).toEqual([]);
    expect(getTask(id).status).toBe("failed");
  });
});
