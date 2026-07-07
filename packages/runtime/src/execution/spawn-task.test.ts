// Tests for the spawn_task tool (unified task model): idempotent spawn via
// correlation_key (dedup survives acknowledge/archive), container-chain depth
// cap, await:"none" fire-and-forget, the surfaced stamp, and the
// brief-not-transcript contract (the child's run 1 starts from the written
// brief, never the parent thread's transcript).
//
// Setup mirrors chat-topic-forward.test.ts: the echo provider makes the child
// agent loop deterministic, HOME points at a unique mkdtemp dir so the
// machine-global Google account registry can't shift system-prompt size, and
// each test uses a unique instance so per-instance state can't bleed across
// reruns in the same worker. The spawning run is a synthetic `running` task
// bound to a real container — the tool is driven directly via
// dispatchToolCall, the same entry the chat-task loop uses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoToolCallingResponses,
  getEchoToolCallingCalls,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import {
  acknowledgeContainer,
  createChatMessage,
  createChatSession,
  createTopic,
  mutateState,
  readState
} from "../state";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { MAX_SUBAGENT_DEPTH } from "../capabilities/subagents";
import { dispatchToolCall } from "./tool-dispatch";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-spawn-task-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  rmSync(scratchHome, { recursive: true, force: true });
});

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-spawn-task-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-spawn-task-test-logs",
    approvalMode: "strict"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 8000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

// Insert a synthetic running task bound to `chatSessionId` — the spawning
// run the tool dispatch acts on behalf of.
function insertRunningTask(state: RuntimeState, id: string, chatSessionId: string): void {
  state.tasks.unshift({
    id,
    title: "spawning run",
    input: "",
    status: "running",
    instance: state.instance,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tracePath: "",
    auditIds: [],
    approvalIds: [],
    skillIds: [],
    mode: "chat",
    chatSessionId
  });
  const session = state.chatSessions.find((s) => s.id === chatSessionId);
  if (session && !session.taskIds.includes(id)) session.taskIds.push(id);
}

async function dispatchSpawnTask(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await dispatchToolCall(config, taskId, "spawn_task", `call_${Math.random().toString(36).slice(2)}`, JSON.stringify(args));
  if (result.kind !== "sync") throw new Error(`expected a sync spawn_task result, got ${result.kind}`);
  return result.result;
}

describe("spawn_task tool", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let prevSpawnPoll: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-spawn-task-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    // Shrink the awaited-child poll granularity: these tests await a child that
    // settles in a few ms via the echo provider, but the parent's wait defaults
    // to a 100ms tick, so each awaited spawn pays up to ~100ms of dead wait.
    // 2ms keeps the poll behaviour under test while removing the floor.
    prevSpawnPoll = process.env.GINI_SPAWN_POLL_MS;
    process.env.GINI_SPAWN_POLL_MS = "2";
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevSpawnPoll === undefined) delete process.env.GINI_SPAWN_POLL_MS;
    else process.env.GINI_SPAWN_POLL_MS = prevSpawnPoll;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // Mint an agent Chat + a parent container + a synthetic running task in it.
  async function seedSpawningRun(config: RuntimeConfig): Promise<{ parentContainerId: string; spawningTaskId: string }> {
    return mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const parent = createTopic(state, {
        agentId: chat.agentId,
        title: "Inbox watch",
        parentChatSessionId: chat.id
      });
      const spawningTaskId = "task_spawner";
      insertRunningTask(state, spawningTaskId, parent.id);
      return { parentContainerId: parent.id, spawningTaskId };
    });
  }

  test("dedup: same correlation_key returns the existing child — including after acknowledge and archive", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-dedup-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { parentContainerId, spawningTaskId } = await seedSpawningRun(config);

    // Child run 1: answers directly.
    setEchoToolCallingResponse({ provider, text: "drafted the reply", toolCalls: [], finishReason: "stop" });

    const first = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Draft reply to Sam",
        prompt: "Draft a reply to Sam's email about the June invoice.",
        correlation_key: "email:msg-123"
      })
    );
    expect(first.deduped).toBeUndefined();
    expect(first.status).toBe("completed");
    expect(first.summary).toBe("drafted the reply");
    expect(typeof first.containerId).toBe("string");

    // The child container hangs off the spawning run's container and records
    // provenance + the dedup key.
    const child = readState(config.instance).chatSessions.find((s) => s.id === first.containerId)!;
    expect(child.parentChatSessionId).toBe(parentContainerId);
    expect(child.spawnedByTaskId).toBe(spawningTaskId);
    expect(child.correlationKey).toBe("email:msg-123");

    // Re-spawn with the same key: dedup, no second container.
    const second = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Draft reply to Sam",
        prompt: "Draft a reply to Sam's email about the June invoice.",
        correlation_key: "email:msg-123"
      })
    );
    expect(second.deduped).toBe(true);
    expect(second.containerId).toBe(first.containerId);
    expect(second.latestRunStatus).toBe("completed");
    expect(second.summary).toBe("drafted the reply");
    const containersAfterSecond = readState(config.instance).chatSessions.filter(
      (s) => s.correlationKey === "email:msg-123"
    );
    expect(containersAfterSecond.length).toBe(1);

    // Dedup must survive the user dismissing the child: acknowledge AND
    // archive it, then re-spawn — still the same container, still no re-mint.
    await mutateState(config.instance, (state) => {
      acknowledgeContainer(state, first.containerId);
      const session = state.chatSessions.find((s) => s.id === first.containerId)!;
      session.archivedAt = new Date().toISOString();
    });
    const third = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Draft reply to Sam",
        prompt: "Draft a reply to Sam's email about the June invoice.",
        correlation_key: "email:msg-123"
      })
    );
    expect(third.deduped).toBe(true);
    expect(third.containerId).toBe(first.containerId);
    const containersAfterThird = readState(config.instance).chatSessions.filter(
      (s) => s.correlationKey === "email:msg-123"
    );
    expect(containersAfterThird.length).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("watch fan-out across two fires: the same correlation_key mints one container, dedups on the second fire, and survives acknowledge", async () => {
    // Two fires of a watch job are two DIFFERENT worker runs spawned into
    // the SAME route session (the fan-out worker in jobs/index.ts reuses the
    // route's channel every tick and never mints containers itself). The
    // correlation key is scoped to that stable parent container, so per-item
    // spawn_task calls from fire 2 must find fire 1's child — including
    // after the user checked the finding off home.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-two-fires-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const routeSessionId = await mutateState(config.instance, (state) => {
      const route = createChatSession(state, "Email watch: newsletters", undefined, undefined, "job", "channel");
      insertRunningTask(state, "task_fire_1", route.id);
      insertRunningTask(state, "task_fire_2", route.id);
      return route.id;
    });

    setEchoToolCallingResponse({ provider, text: "draft ready", toolCalls: [], finishReason: "stop" });
    const first = JSON.parse(
      await dispatchSpawnTask(config, "task_fire_1", {
        title: "Draft reply to msg 42",
        prompt: "Draft a reply to message 42.",
        correlation_key: "email:msg-42",
        surface: true
      })
    );
    expect(first.deduped).toBeUndefined();
    expect(first.status).toBe("completed");
    expect(readState(config.instance).chatSessions.find((s) => s.id === first.containerId)?.parentChatSessionId).toBe(
      routeSessionId
    );

    // The user acknowledges the finding between fires; dedup must survive it.
    await mutateState(config.instance, (state) => {
      acknowledgeContainer(state, first.containerId);
    });

    const second = JSON.parse(
      await dispatchSpawnTask(config, "task_fire_2", {
        title: "Draft reply to msg 42",
        prompt: "Draft a reply to message 42.",
        correlation_key: "email:msg-42"
      })
    );
    expect(second.deduped).toBe(true);
    expect(second.containerId).toBe(first.containerId);
    expect(
      readState(config.instance).chatSessions.filter((s) => s.correlationKey === "email:msg-42").length
    ).toBe(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("depth cap: the container-chain walk refuses spawning past MAX_SUBAGENT_DEPTH nesting", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-depth-${basename(workspaceRoot)}`);

    // Chain: agent Chat → c1 → c2 → c3 (container depth 3). A run inside c3
    // must be refused — its child would nest past the cap. Note none of the
    // chain tasks carry subagentId, so the task-chain walk alone would NOT
    // catch this; the container walk is the enforcing check.
    const { deepestTaskId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      let parentId = chat.id;
      let deepest = "";
      for (let i = 1; i <= MAX_SUBAGENT_DEPTH; i += 1) {
        const container = createTopic(state, {
          agentId: chat.agentId,
          title: `level-${i}`,
          parentChatSessionId: parentId
        });
        parentId = container.id;
        deepest = container.id;
      }
      const deepestTaskId = "task_deep";
      insertRunningTask(state, deepestTaskId, deepest);
      return { deepestTaskId };
    });

    const before = readState(config.instance).chatSessions.length;
    const result = await dispatchSpawnTask(config, deepestTaskId, {
      title: "too deep",
      prompt: "shouldn't run"
    });
    expect(result).toContain("max_task_depth_exceeded");
    // No new container was minted.
    expect(readState(config.instance).chatSessions.length).toBe(before);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("await:'result' returns immediately when the child parks on an approval gate", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-gated-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { spawningTaskId } = await seedSpawningRun(config);

    // The child's model turn requests a file_write — approval-gated in
    // strict mode — so the child parks waiting_approval on a pending
    // Authorization with NO needsInput stamp. The wait must surface the
    // park instead of spinning to its timeout.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_child_write",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "x" }) }
        }
      ],
      finishReason: "tool_calls"
    });

    const result = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Gated child",
        prompt: "Write the file."
      })
    );
    expect(result.status).toBe("waiting_approval");
    expect(typeof result.taskId).toBe("string");

    const state = readState(config.instance);
    const child = state.tasks.find((t) => t.id === result.taskId);
    expect(child?.status).toBe("waiting_approval");
    expect(child?.needsInput).toBeUndefined();
    expect(state.authorizations.some((a) => a.taskId === result.taskId && a.status === "pending")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("a failed spawn deletes the just-minted container so the same correlation_key can retry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-cleanup-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    await mutateState(config.instance, (state) => {
      const route = createChatSession(state, "Email watch", undefined, undefined, "job", "channel");
      insertRunningTask(state, "task_try_1", route.id);
      insertRunningTask(state, "task_try_2", route.id);
    });

    // Force spawnSubagent to throw AFTER the container mint: the spawning
    // task goes terminal between spawn_task's lock-free pre-check (passes
    // while running) and spawnSubagent's serialized parent re-check. The
    // FIFO mutateState queue makes the interleave deterministic — the mint
    // is enqueued in spawn_task's first synchronous segment, the flip below
    // enqueues second, and spawnSubagent's record mutation lands third.
    const pending = dispatchSpawnTask(config, "task_try_1", {
      title: "Draft reply",
      prompt: "Draft it.",
      correlation_key: "email:msg-9"
    });
    await mutateState(config.instance, (state) => {
      const task = state.tasks.find((t) => t.id === "task_try_1");
      if (task) task.status = "failed";
    });
    const result = await pending;
    expect(result).toContain("Error: spawn_task skipped");

    // The just-minted container was deleted — no keyed orphan remains to
    // win future dedup lookups.
    expect(
      readState(config.instance).chatSessions.filter((s) => s.correlationKey === "email:msg-9").length
    ).toBe(0);

    // A retry with the SAME key from the next fire re-mints cleanly.
    setEchoToolCallingResponse({ provider, text: "draft ready", toolCalls: [], finishReason: "stop" });
    const retry = JSON.parse(
      await dispatchSpawnTask(config, "task_try_2", {
        title: "Draft reply",
        prompt: "Draft it.",
        correlation_key: "email:msg-9"
      })
    );
    expect(retry.deduped).toBeUndefined();
    expect(retry.status).toBe("completed");
    expect(
      readState(config.instance).chatSessions.find((s) => s.id === retry.containerId)?.correlationKey
    ).toBe("email:msg-9");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("await:'none' returns immediately with the child's ids while the child is still running", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-nowait-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { parentContainerId, spawningTaskId } = await seedSpawningRun(config);

    // The child's model turn is delayed so it is provably still in flight
    // when the tool result comes back.
    setEchoToolCallingResponse(
      { provider, text: "watch item drafted", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 400 }
    );

    const result = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Watch finding",
        prompt: "Handle the new finding.",
        correlation_key: "finding:1",
        await: "none"
      })
    );
    expect(result.status).toBe("running");
    expect(typeof result.containerId).toBe("string");
    expect(typeof result.taskId).toBe("string");

    // The child task exists and is NOT terminal at return time.
    const child = readState(config.instance).tasks.find((t) => t.id === result.taskId);
    expect(child).toBeDefined();
    expect(["queued", "running"]).toContain(child!.status);
    const container = readState(config.instance).chatSessions.find((s) => s.id === result.containerId)!;
    expect(container.parentChatSessionId).toBe(parentContainerId);
    expect(container.spawnedByTaskId).toBe(spawningTaskId);

    // Let the child settle so teardown doesn't race in-flight mutations.
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("surface:true stamps `surfaced` on the child container; default leaves it unset", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-surface-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { spawningTaskId } = await seedSpawningRun(config);

    setEchoToolCallingResponse({ provider, text: "draft ready", toolCalls: [], finishReason: "stop" });
    setEchoToolCallingResponse({ provider, text: "errand done", toolCalls: [], finishReason: "stop" });

    const surfacedResult = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Draft for review",
        prompt: "Draft the note.",
        surface: true
      })
    );
    const internalResult = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Internal errand",
        prompt: "Fetch the numbers."
      })
    );

    const state = readState(config.instance);
    const surfacedContainer = state.chatSessions.find((s) => s.id === surfacedResult.containerId)!;
    const internalContainer = state.chatSessions.find((s) => s.id === internalResult.containerId)!;
    expect(surfacedContainer.surfaced).toBe(true);
    expect(internalContainer.surfaced).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("child run 1 starts from the written brief, never the parent transcript", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-spawn-task-ws-"));
    const config = buildConfig(workspaceRoot, `spawn-task-brief-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);
    const { parentContainerId, spawningTaskId } = await seedSpawningRun(config);

    // Seed the PARENT container with durable transcript rows carrying a
    // marker that must never reach the child's model context.
    const marker = "PARENT-TRANSCRIPT-SECRET";
    await mutateState(config.instance, (state) => {
      createChatMessage(state, {
        sessionId: parentContainerId,
        role: "user",
        content: `Watch my inbox. ${marker}`
      });
      createChatMessage(state, {
        sessionId: parentContainerId,
        role: "assistant",
        content: `Watching. ${marker}`
      });
    });

    setEchoToolCallingResponse({ provider, text: "brief handled", toolCalls: [], finishReason: "stop" });

    const result = JSON.parse(
      await dispatchSpawnTask(config, spawningTaskId, {
        title: "Reply to Sam",
        prompt: "Draft a short reply agreeing to the Friday call.",
        goal: "Ship a reviewable draft",
        context: "Sam proposed Friday 3pm; the user prefers afternoons."
      })
    );
    expect(result.status).toBe("completed");

    // The child's model context (the only echo calls in this test) carries
    // the brief — prompt as the user message, goal/context as labeled
    // sections in the system prompt — and NOT the parent transcript marker.
    const calls = getEchoToolCallingCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const messages of calls) {
      const joined = messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      expect(joined).not.toContain(marker);
    }
    const childCall = calls.find((messages) =>
      messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Draft a short reply agreeing to the Friday call."))
    );
    expect(childCall).toBeDefined();
    const system = childCall!.find((m) => m.role === "system")!;
    expect(String(system.content)).toContain("## Goal\nShip a reviewable draft");
    expect(String(system.content)).toContain("## Context\nSam proposed Friday 3pm; the user prefers afternoons.");

    // The child thread is self-contained: the brief is a durable user row in
    // the CHILD container, so the thread reads as the context its run used.
    const childMessages = readState(config.instance).chatMessages.filter(
      (m) => m.sessionId === result.containerId && m.role === "user"
    );
    expect(childMessages.some((m) => m.content === "Draft a short reply agreeing to the Friday call.")).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
