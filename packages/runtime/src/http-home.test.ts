// Pins the phase-1 container/home HTTP surface:
//   - GET /api/home returns { owner?, tasks, done, recents } over the lean
//     derived-attention read path: the inclusion predicate (startedBy ===
//     "user" OR attention ∈ {needs_input, review} OR surfaced), server-side
//     acknowledged filtering (attention "none" never appears as a task row;
//     acknowledged completions land in `done`), headless/archived/Chat
//     exclusion, attention-precedence ordering, and the needsInput/review
//     affordance payloads. `owner` appears only when config.ownerFirstName is
//     set — never derived from anything else.
//   - POST /api/containers/:id/acknowledge stamps acknowledgedAt and moves the
//     row from tasks to done on the next read.
//   - PATCH /api/containers/:id updates pinned/title/archived.
//   - DELETE /api/containers/:id guards (404 unknown, 400 agent-kind/headless,
//     409 live run) and cascades per deleteChatSession (session + transcript
//     gone, run journal retained).
//
// Hermetic and provider-free: state is seeded directly via mutateState (no
// chat turns), so the file stays fast.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "./http";
import {
  createAuthorization,
  createChatMessage,
  createChatSession,
  createSetupRequest,
  createTask,
  createTopic,
  mutateState,
  readState
} from "./state";
import type { HomeDoneItem, HomeTaskItem, RecentItem, RuntimeConfig, RuntimeState, Task } from "./types";

const ROOT = "/tmp/gini-http-home-tests";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string, extra: Partial<RuntimeConfig> = {}): RuntimeConfig {
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  // Prime the instance the way a booted gateway does: create the state file
  // and run one normalize pass so the one-time migration markers (e.g.
  // containersAckSeeded) are set BEFORE any test seeding. Without this, the
  // first seeding mutateState would land sessions in a pre-migration state
  // file and the next read's ack-seed pass would stamp them acknowledged.
  readState(instance);
  return {
    instance,
    port: 7343,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`,
    approvalMode: "strict",
    ...extra
  };
}

async function call(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) }
  }));
}

type HomeResponse = {
  owner?: { firstName?: string };
  tasks: HomeTaskItem[];
  done: HomeDoneItem[];
  recents: RecentItem[];
};

async function getHome(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  query = ""
): Promise<HomeResponse> {
  const response = await call(handler, config, `/api/home${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as HomeResponse;
}

function seedTask(
  state: RuntimeState,
  sessionId: string,
  status: Task["status"],
  at: string,
  extra: Partial<Task> = {}
): Task {
  const task = createTask(state.instance, `run in ${sessionId}`, undefined, undefined, undefined, undefined, undefined, sessionId);
  task.title = extra.title ?? task.title;
  task.status = status;
  task.updatedAt = at;
  Object.assign(task, extra);
  state.tasks.unshift(task);
  return task;
}

describe("GET /api/home", () => {
  test("applies the inclusion predicate, derives attention, and orders by precedence", async () => {
    const config = buildConfig("home-shape");
    const handler = createHandler(config);

    const ids = await mutateState(config.instance, (state) => {
      // needs_input: user topic parked on a chat.choice.
      const asking = createTopic(state, { title: "Pick a venue" });
      const askingTask = seedTask(state, asking.id, "waiting_approval", "2026-07-01T10:00:00.000Z");
      const setup = createSetupRequest(state, {
        taskId: askingTask.id,
        action: "chat.choice",
        target: "Which venue?",
        reason: "Which venue?",
        payload: { question: "Which venue?", options: [{ label: "Blue Door" }, { label: "Harbor House" }], toolCallId: "call_1" }
      });

      // review: agent-spawned, NOT surfaced — still appears because a
      // decision is pending. messaging.send maps to the email review kind.
      const reviewing = createTopic(state, { title: "Reply to Sarah", spawnedByTaskId: "task_watch" });
      const reviewingTask = seedTask(state, reviewing.id, "waiting_approval", "2026-07-01T11:00:00.000Z");
      const auth = createAuthorization(state, {
        taskId: reviewingTask.id,
        action: "messaging.send",
        target: "sarah@example.com",
        risk: "medium",
        reason: "Send the reply draft",
        payload: {}
      });

      // working: user topic with a live run.
      const working = createTopic(state, { title: "Splitwise June" });
      seedTask(state, working.id, "running", "2026-07-01T12:00:00.000Z");

      // done_unacknowledged: user topic with an unacknowledged outcome.
      const done = createTopic(state, { title: "Book the table" });
      seedTask(state, done.id, "completed", "2026-07-01T09:00:00.000Z", {
        summary: "Booked for Friday 7pm.\nDetails in thread."
      });

      // Acknowledged done row: filtered from tasks, but its outcome still
      // feeds Recents (recents survive acknowledge).
      const acked = createTopic(state, { title: "Yesterday's errand" });
      seedTask(state, acked.id, "completed", "2026-07-01T08:00:00.000Z", {
        summary: "All set.",
        title: "Yesterday's errand run"
      });
      acked.acknowledgedAt = "2026-07-01T08:30:00.000Z";

      // Agent-spawned, surfaced, done → appears (surfaced AND attention ≠ none)
      // with startedBy "agent"; its messaging.send authorization marks the
      // Recents icon as a draft.
      const surfaced = createTopic(state, { title: "Drafted reply", spawnedByTaskId: "task_watch", surfaced: true });
      const surfacedTask = seedTask(state, surfaced.id, "completed", "2026-07-01T13:00:00.000Z", {
        summary: "Draft ready.",
        title: "Drafted reply to Alex"
      });
      const surfacedAuth = createAuthorization(state, {
        taskId: surfacedTask.id,
        action: "messaging.send",
        target: "alex@example.com",
        risk: "medium",
        reason: "Send it",
        payload: {}
      });
      surfacedAuth.status = "approved";

      // Never on home: agent-spawned+unsurfaced working errand, headless
      // container, archived topic, and the root Chat itself.
      const silent = createTopic(state, { title: "Internal errand", spawnedByTaskId: "task_watch" });
      seedTask(state, silent.id, "running", "2026-07-01T12:30:00.000Z");
      const headless = createTopic(state, { title: "Watch thread", headless: true, surfaced: true });
      seedTask(state, headless.id, "running", "2026-07-01T12:31:00.000Z");
      const archived = createTopic(state, { title: "Archived" });
      archived.archivedAt = "2026-06-30T00:00:00.000Z";
      seedTask(state, archived.id, "running", "2026-07-01T12:32:00.000Z");
      const chat = createChatSession(state, "Main chat", undefined, undefined, undefined, "agent");
      seedTask(state, chat.id, "running", "2026-07-01T12:33:00.000Z");

      return {
        asking: asking.id,
        setupId: setup.id,
        reviewing: reviewing.id,
        authId: auth.id,
        working: working.id,
        done: done.id,
        acked: acked.id,
        ackedTaskId: state.tasks.find((t) => t.chatSessionId === acked.id)!.id,
        surfaced: surfaced.id,
        surfacedTaskId: surfacedTask.id
      };
    });

    const home = await getHome(handler, config);

    // No ownerFirstName configured → owner omitted entirely.
    expect(home.owner).toBeUndefined();

    expect(home.tasks.map((t) => t.id)).toEqual([
      ids.asking,
      ids.reviewing,
      ids.working,
      ids.surfaced,
      ids.done
    ]);

    const asking = home.tasks.find((t) => t.id === ids.asking)!;
    expect(asking.attention).toBe("needs_input");
    expect(asking.startedBy).toBe("user");
    expect(asking.needsInput).toEqual({
      question: "Which venue?",
      options: ["Blue Door", "Harbor House"],
      setupRequestId: ids.setupId
    });

    const reviewing = home.tasks.find((t) => t.id === ids.reviewing)!;
    expect(reviewing.attention).toBe("review");
    expect(reviewing.startedBy).toBe("agent");
    expect(reviewing.review).toEqual({ label: "Review & send", kind: "email", authorizationId: ids.authId });

    const working = home.tasks.find((t) => t.id === ids.working)!;
    expect(working.attention).toBe("working");
    expect(working.outcomeLine).toBeUndefined();
    // No outcome yet → nothing to acknowledge; the checkbox must render
    // unchecked while the run is live.
    expect(working.acknowledged).toBe(false);

    const done = home.tasks.find((t) => t.id === ids.done)!;
    expect(done.attention).toBe("done_unacknowledged");
    expect(done.acknowledged).toBe(false);
    // First line only.
    expect(done.outcomeLine).toBe("Booked for Friday 7pm.");

    const surfaced = home.tasks.find((t) => t.id === ids.surfaced)!;
    expect(surfaced.attention).toBe("done_unacknowledged");
    expect(surfaced.startedBy).toBe("agent");

    // Recents: one entry per user-started/surfaced container with a
    // completed run, newest first, INCLUDING the acknowledged container's
    // outcome (recents survive acknowledge). Titles are the CONTAINER's
    // title, not the run's. The surfaced task's messaging.send authorization
    // flips its icon to draft.
    expect(home.recents.map((r) => r.containerId)).toEqual([ids.surfaced, ids.done, ids.acked]);
    expect(home.recents[0]).toEqual({
      id: ids.surfacedTaskId,
      containerId: ids.surfaced,
      icon: "draft",
      title: "Drafted reply",
      timestamp: "2026-07-01T13:00:00.000Z"
    });
    expect(home.recents[2]).toEqual({
      id: ids.ackedTaskId,
      containerId: ids.acked,
      icon: "document",
      title: "Yesterday's errand",
      timestamp: "2026-07-01T08:00:00.000Z"
    });
  });

  test("surfaces a child task even when the parent watcher container is headless", async () => {
    const config = buildConfig("home-headless-parent-child");
    const handler = createHandler(config);

    const ids = await mutateState(config.instance, (state) => {
      const parent = createTopic(state, { title: "Auto-inbox", headless: true });
      seedTask(state, parent.id, "completed", "2026-07-01T10:00:00.000Z");

      const child = createTopic(state, {
        title: "Draft reply to Alex about renewal",
        parentChatSessionId: parent.id,
        spawnedByTaskId: "task_auto_inbox",
        surfaced: true
      });
      const childTask = seedTask(state, child.id, "completed", "2026-07-01T10:05:00.000Z", {
        summary: "Draft ready for review."
      });
      return { parent: parent.id, child: child.id, childTask: childTask.id };
    });

    const home = await getHome(handler, config);

    expect(home.tasks.map((task) => task.id)).toEqual([ids.child]);
    expect(home.tasks[0]).toMatchObject({
      id: ids.child,
      title: "Draft reply to Alex about renewal",
      startedBy: "agent",
      attention: "done_unacknowledged",
      outcomeLine: "Draft ready for review."
    });
    expect(home.recents).toEqual([
      {
        id: ids.childTask,
        containerId: ids.child,
        icon: "document",
        title: "Draft reply to Alex about renewal",
        timestamp: "2026-07-01T10:05:00.000Z"
      }
    ]);
    expect(home.tasks.some((task) => task.id === ids.parent)).toBe(false);
  });

  test("recents dedupe to one entry per container: newest completed run wins", async () => {
    const config = buildConfig("home-recents-dedupe");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      // A container with two completed runs — an original ask and a
      // follow-up. Home must show ONE recents entry titled by the container,
      // stamped with the newest run's timestamp (the follow-up updates
      // recency instead of adding a row titled with the follow-up text).
      const haiku = createTopic(state, { title: "Write a two-line haiku" });
      seedTask(state, haiku.id, "completed", "2026-07-01T09:00:00.000Z", {
        title: "Write a two-line haiku"
      });
      const followUp = seedTask(state, haiku.id, "completed", "2026-07-01T11:00:00.000Z", {
        title: "Make it about lock screens instead"
      });
      return { haiku: haiku.id, followUpTaskId: followUp.id };
    });

    const home = await getHome(handler, config);
    expect(home.recents).toEqual([
      {
        id: ids.followUpTaskId,
        containerId: ids.haiku,
        icon: "document",
        title: "Write a two-line haiku",
        timestamp: "2026-07-01T11:00:00.000Z"
      }
    ]);
  });

  test("a message-mode container's recents entry carries the chat icon", async () => {
    const config = buildConfig("home-recents-chat-icon");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      // A user-started conversation (Message mode) with a completed run. It
      // skips the tasks list (it lives in the sidebar Messages section) but
      // still feeds Recents, where it renders with the chat icon.
      const convo = createTopic(state, { title: "Chat with Gini", startedAs: "message" });
      const run = seedTask(state, convo.id, "completed", "2026-07-01T10:00:00.000Z", { summary: "Answered." });
      return { convo: convo.id, runId: run.id };
    });

    const home = await getHome(handler, config);
    expect(home.tasks).toEqual([]);
    expect(home.recents).toEqual([
      {
        id: ids.runId,
        containerId: ids.convo,
        icon: "chat",
        title: "Chat with Gini",
        timestamp: "2026-07-01T10:00:00.000Z"
      }
    ]);
  });

  test("a failed newest outcome stamps failed; completed does not", async () => {
    const config = buildConfig("home-failed");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      const failed = createTopic(state, { title: "Book the flight" });
      seedTask(state, failed.id, "failed", "2026-07-01T10:00:00.000Z", {
        input: "Book me a flight to Lisbon on Friday",
        error: "Browser session expired"
      });

      const done = createTopic(state, { title: "Summarize the doc" });
      seedTask(state, done.id, "completed", "2026-07-01T09:00:00.000Z", { summary: "Done." });

      // Cancelled stays neutral: no failed flag.
      const cancelled = createTopic(state, { title: "Old errand" });
      seedTask(state, cancelled.id, "cancelled", "2026-07-01T08:00:00.000Z");

      return { failed: failed.id, done: done.id, cancelled: cancelled.id };
    });

    const home = await getHome(handler, config);
    const failed = home.tasks.find((t) => t.id === ids.failed)!;
    expect(failed.attention).toBe("done_unacknowledged");
    expect(failed.failed).toBe(true);
    expect(failed.outcomeLine).toBe("Browser session expired");
    // The failed run's input never rides the row — Retry is a server-side
    // lookup (POST /api/containers/:id/retry), so the 3s home poll stays lean.
    expect("retryContent" in failed).toBe(false);

    const done = home.tasks.find((t) => t.id === ids.done)!;
    expect(done.failed).toBeUndefined();

    const cancelled = home.tasks.find((t) => t.id === ids.cancelled)!;
    expect(cancelled.attention).toBe("done_unacknowledged");
    expect(cancelled.failed).toBeUndefined();
  });

  test("served rows are never pre-checked: acknowledged is scoped to the current run", async () => {
    const config = buildConfig("home-ack-scope");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      // Working with no outcome at all: nothing to acknowledge yet.
      const fresh = createTopic(state, { title: "Fresh run" });
      seedTask(state, fresh.id, "running", "2026-07-01T10:00:00.000Z");

      // Prior outcome acknowledged, then a NEW run started: the checkbox
      // refers to the run in flight, so the row returns unchecked — the old
      // ack must not pre-check it.
      const rerun = createTopic(state, { title: "Running again" });
      seedTask(state, rerun.id, "completed", "2026-07-01T09:00:00.000Z", { summary: "First pass done." });
      rerun.acknowledgedAt = "2026-07-01T09:30:00.000Z";
      seedTask(state, rerun.id, "running", "2026-07-01T10:30:00.000Z");

      // Done and acknowledged with nothing live: attention "none" → the row
      // never appears (the server-side acknowledged filter).
      const settled = createTopic(state, { title: "Settled" });
      seedTask(state, settled.id, "completed", "2026-07-01T08:00:00.000Z", { summary: "Done." });
      settled.acknowledgedAt = "2026-07-01T08:30:00.000Z";

      return { fresh: fresh.id, rerun: rerun.id, settled: settled.id };
    });

    const home = await getHome(handler, config);
    const fresh = home.tasks.find((t) => t.id === ids.fresh)!;
    expect(fresh.attention).toBe("working");
    expect(fresh.acknowledged).toBe(false);
    const rerun = home.tasks.find((t) => t.id === ids.rerun)!;
    expect(rerun.attention).toBe("working");
    expect(rerun.acknowledged).toBe(false);
    expect(home.tasks.some((t) => t.id === ids.settled)).toBe(false);
  });

  test("owner.firstName comes from config.ownerFirstName, trimmed", async () => {
    const config = buildConfig("home-owner", { ownerFirstName: "  Shelden  " });
    const handler = createHandler(config);
    const home = await getHome(handler, config);
    expect(home.owner).toEqual({ firstName: "Shelden" });
    expect(home.tasks).toEqual([]);
    expect(home.recents).toEqual([]);
  });

  test("scopes to ?agentId=", async () => {
    const config = buildConfig("home-agent-filter");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      // Register real agents — normalizeState re-homes records whose agentId
      // points at a non-existent agent, which would defeat the filter.
      const at = "2026-07-01T00:00:00.000Z";
      state.agents.push(
        { id: "agent_a", instance: state.instance, name: "a", status: "inactive", toolsets: [], messagingTargets: [], createdAt: at, updatedAt: at },
        { id: "agent_b", instance: state.instance, name: "b", status: "inactive", toolsets: [], messagingTargets: [], createdAt: at, updatedAt: at }
      );
      const mine = createTopic(state, { agentId: "agent_a", title: "Mine" });
      seedTask(state, mine.id, "running", "2026-07-01T10:00:00.000Z");
      const other = createTopic(state, { agentId: "agent_b", title: "Other" });
      seedTask(state, other.id, "running", "2026-07-01T10:00:00.000Z");
      return { mine: mine.id };
    });

    const home = await getHome(handler, config, "?agentId=agent_a");
    expect(home.tasks.map((t) => t.id)).toEqual([ids.mine]);
  });
});

describe("POST /api/containers/:id/acknowledge", () => {
  test("stamps acknowledgedAt and the row moves from tasks to done on the next read", async () => {
    const config = buildConfig("home-ack");
    const handler = createHandler(config);
    const containerId = await mutateState(config.instance, (state) => {
      const done = createTopic(state, { title: "Finished" });
      seedTask(state, done.id, "completed", "2026-07-01T09:00:00.000Z", { summary: "Done." });
      return done.id;
    });

    const before = await getHome(handler, config);
    expect(before.tasks.map((t) => t.id)).toEqual([containerId]);
    expect(before.done).toEqual([]);

    const response = await call(handler, config, `/api/containers/${containerId}/acknowledge`, { method: "POST" });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; acknowledgedAt: string };
    expect(payload.ok).toBe(true);
    expect(payload.acknowledgedAt).toBeString();

    const after = await getHome(handler, config);
    expect(after.tasks).toEqual([]);
    expect(after.done).toEqual([
      {
        id: containerId,
        title: "Finished",
        outcomeLine: "Done.",
        completedAt: "2026-07-01T09:00:00.000Z"
      }
    ]);
    const session = readState(config.instance).chatSessions.find((s) => s.id === containerId);
    expect(session?.acknowledgedAt).toBe(payload.acknowledgedAt);
  });

  test("404s for an unknown container", async () => {
    const config = buildConfig("home-ack-missing");
    const handler = createHandler(config);
    const response = await call(handler, config, "/api/containers/chat_missing/acknowledge", { method: "POST" });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/containers/:id", () => {
  test("updates pinned and title, together or separately", async () => {
    const config = buildConfig("home-patch");
    const handler = createHandler(config);
    const containerId = await mutateState(config.instance, (state) => createTopic(state, { title: "Trip" }).id);

    const pinResponse = await call(handler, config, `/api/containers/${containerId}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned: true })
    });
    expect(pinResponse.status).toBe(200);
    expect(((await pinResponse.json()) as { pinned?: boolean }).pinned).toBe(true);

    const bothResponse = await call(handler, config, `/api/containers/${containerId}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned: false, title: "Trip to Lisbon" })
    });
    expect(bothResponse.status).toBe(200);
    const updated = (await bothResponse.json()) as { pinned?: boolean; title: string };
    expect(updated.pinned).toBe(false);
    expect(updated.title).toBe("Trip to Lisbon");

    const session = readState(config.instance).chatSessions.find((s) => s.id === containerId);
    expect(session?.pinned).toBe(false);
    expect(session?.title).toBe("Trip to Lisbon");
  });

  test("archives and un-archives; archived rows leave home but stay addressable", async () => {
    const config = buildConfig("home-patch-archive");
    const handler = createHandler(config);
    const containerId = await mutateState(config.instance, (state) => {
      const container = createTopic(state, { title: "Old thread" });
      seedTask(state, container.id, "completed", "2026-07-01T09:00:00.000Z", { summary: "Done." });
      return container.id;
    });

    expect((await getHome(handler, config)).tasks.map((t) => t.id)).toEqual([containerId]);

    const archiveResponse = await call(handler, config, `/api/containers/${containerId}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true })
    });
    expect(archiveResponse.status).toBe(200);
    expect(((await archiveResponse.json()) as { archivedAt?: string }).archivedAt).toBeString();

    // Hidden from home, but the container is only hidden — not deleted:
    // GET /api/chat/:id (deep links) still resolves it.
    expect((await getHome(handler, config)).tasks).toEqual([]);
    const byId = await call(handler, config, `/api/chat/${containerId}`);
    expect(byId.status).toBe(200);

    const unarchiveResponse = await call(handler, config, `/api/containers/${containerId}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false })
    });
    expect(unarchiveResponse.status).toBe(200);
    expect(((await unarchiveResponse.json()) as { archivedAt?: string }).archivedAt).toBeUndefined();
    expect((await getHome(handler, config)).tasks.map((t) => t.id)).toEqual([containerId]);
  });

  test("404s for an unknown container", async () => {
    const config = buildConfig("home-patch-missing");
    const handler = createHandler(config);
    const response = await call(handler, config, "/api/containers/chat_missing", {
      method: "PATCH",
      body: JSON.stringify({ pinned: true })
    });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/containers/:id", () => {
  test("deletes the container and its transcript; the run journal survives", async () => {
    const config = buildConfig("home-delete");
    const handler = createHandler(config);
    const ids = await mutateState(config.instance, (state) => {
      const container = createTopic(state, { title: "Done deal" });
      const run = seedTask(state, container.id, "completed", "2026-07-01T09:00:00.000Z");
      createChatMessage(state, { sessionId: container.id, role: "user", content: "hi" });
      return { containerId: container.id, taskId: run.id };
    });

    const response = await call(handler, config, `/api/containers/${ids.containerId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

    const state = readState(config.instance);
    expect(state.chatSessions.find((s) => s.id === ids.containerId)).toBeUndefined();
    expect(state.chatMessages.filter((m) => m.sessionId === ids.containerId)).toEqual([]);
    // The run journal is retained (deleteChatSession's existing semantics,
    // same retention deleteAgent's cascade keeps) alongside the audit event.
    expect(state.tasks.find((t) => t.id === ids.taskId)).toBeDefined();
    expect(state.events.some((e) => e.action === "chat.session.deleted" && e.target === ids.containerId)).toBe(true);

    // The deep link is gone for real: GET by id now 404s.
    expect((await call(handler, config, `/api/chat/${ids.containerId}`)).status).toBe(404);
  });

  test("404s for an unknown container", async () => {
    const config = buildConfig("home-delete-missing");
    const handler = createHandler(config);
    const response = await call(handler, config, "/api/containers/chat_missing", { method: "DELETE" });
    expect(response.status).toBe(404);
  });

  test("400s for the agent's root Chat", async () => {
    const config = buildConfig("home-delete-agent-kind");
    const handler = createHandler(config);
    const chatId = await mutateState(config.instance, (state) =>
      createChatSession(state, "Chat", undefined, "agent_a", undefined, "agent").id
    );
    const response = await call(handler, config, `/api/containers/${chatId}`, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(readState(config.instance).chatSessions.find((s) => s.id === chatId)).toBeDefined();
  });

  test("400s for a headless job thread", async () => {
    const config = buildConfig("home-delete-headless");
    const handler = createHandler(config);
    const containerId = await mutateState(config.instance, (state) =>
      createTopic(state, { title: "Silent watch", headless: true }).id
    );
    const response = await call(handler, config, `/api/containers/${containerId}`, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(readState(config.instance).chatSessions.find((s) => s.id === containerId)).toBeDefined();
  });

  test("409s while a run is live, leaving everything intact", async () => {
    const config = buildConfig("home-delete-live");
    const handler = createHandler(config);
    const containerId = await mutateState(config.instance, (state) => {
      const container = createTopic(state, { title: "Working on it" });
      seedTask(state, container.id, "running", "2026-07-01T09:00:00.000Z");
      return container.id;
    });
    const response = await call(handler, config, `/api/containers/${containerId}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(readState(config.instance).chatSessions.find((s) => s.id === containerId)).toBeDefined();
  });
});
