// Tests for createTopic (ADR chat-topics-tasks-subagents.md) and the
// container record helpers (acknowledgeContainer, setContainerPinned,
// findChildContainerByCorrelationKey).
//
// Pins that a Topic is a kind:"topic" chat session that reuses the
// chat-session machinery: it carries the given title and parentChatSessionId,
// honors an optional origin, and emits the same chat.session.created event the
// other session constructors do (so SSE / inbox attribution still fire).
// The container helpers pin the home-surface facts: acknowledge stamps
// without re-sorting recency lists, pinning is an explicit gesture, and
// correlation-key dedup survives acknowledge/archive.
//
// Hermetic: an in-memory state from createEmptyState (no disk I/O), but the
// env root is scoped to this slice so parallel files can't collide.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState } from "./store";
import {
  acknowledgeContainer,
  createTaskContainer,
  createTopic,
  findChildContainerByCorrelationKey,
  setContainerArchived,
  setContainerPinned
} from "./records";

const ROOT = "/tmp/gini-records-create-topic-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("createTopic", () => {
  test("creates a kind:'topic' session with title, parent, and origin, and appends chat.session.created", () => {
    const state = createEmptyState("topic-create");
    const topic = createTopic(state, {
      agentId: "agent_a",
      title: "World cup trip with dad",
      parentChatSessionId: "chat_parent",
      origin: "job"
    });

    expect(topic.kind).toBe("topic");
    expect(topic.agentId).toBe("agent_a");
    expect(topic.title).toBe("World cup trip with dad");
    expect(topic.parentChatSessionId).toBe("chat_parent");
    expect(topic.origin).toBe("job");

    // The session is registered in state and the created event fired.
    expect(state.chatSessions.find((s) => s.id === topic.id)).toBeDefined();
    const created = state.events.find(
      (e) => e.target === topic.id && e.action === "chat.session.created"
    );
    expect(created).toBeDefined();
  });

  test("omits parentChatSessionId when not supplied", () => {
    const state = createEmptyState("topic-no-parent");
    const topic = createTopic(state, { title: "Standalone topic" });

    expect(topic.kind).toBe("topic");
    expect(topic.title).toBe("Standalone topic");
    expect(topic.parentChatSessionId).toBeUndefined();
    expect(topic.origin).toBeUndefined();
  });

  test("stamps the container facts when supplied and omits them otherwise", () => {
    const state = createEmptyState("topic-container-facts");
    const child = createTopic(state, {
      title: "Watch finding",
      parentChatSessionId: "chat_parent",
      headless: true,
      correlationKey: "email:msg-1",
      spawnedByTaskId: "task_spawner",
      surfaced: true
    });
    expect(child.headless).toBe(true);
    expect(child.correlationKey).toBe("email:msg-1");
    expect(child.spawnedByTaskId).toBe("task_spawner");
    expect(child.surfaced).toBe(true);
    // `pinned` is always serialized (false when not requested) so fresh
    // gateways expose the field to pinned-aware clients.
    expect(child.pinned).toBe(false);

    const pinned = createTopic(state, { title: "Pinned topic", pinned: true });
    expect(pinned.pinned).toBe(true);
    expect(pinned.headless).toBeUndefined();
    expect(pinned.surfaced).toBeUndefined();
  });

  test("stamps the creation gesture when supplied and leaves it absent otherwise", () => {
    const state = createEmptyState("topic-started-as");
    const message = createTopic(state, { title: "Chatting", startedAs: "message" });
    expect(message.startedAs).toBe("message");
    const task = createTopic(state, { title: "Working", startedAs: "task" });
    expect(task.startedAs).toBe("task");
    // Absent stays absent — unknown is meaningful (pre-field / router /
    // agent / job mints carry no gesture).
    const unknown = createTopic(state, { title: "Routed" });
    expect(unknown.startedAs).toBeUndefined();
  });

  test("createTaskContainer is the same constructor under the container vocabulary", () => {
    expect(createTaskContainer).toBe(createTopic);
  });
});

describe("acknowledgeContainer", () => {
  test("stamps acknowledgedAt without bumping updatedAt and appends the event", () => {
    const state = createEmptyState("container-ack");
    const container = createTopic(state, { title: "Finished errand" });
    const updatedAtBefore = container.updatedAt;

    const acked = acknowledgeContainer(state, container.id);
    expect(acked.acknowledgedAt).toBeString();
    // Checking a row off is a read gesture — it must not re-sort
    // recency-ordered session lists.
    expect(acked.updatedAt).toBe(updatedAtBefore);
    expect(
      state.events.some((e) => e.action === "chat.session.acknowledged" && e.target === container.id)
    ).toBe(true);
  });

  test("throws for an unknown session", () => {
    const state = createEmptyState("container-ack-missing");
    expect(() => acknowledgeContainer(state, "chat_missing")).toThrow("Chat session not found");
  });
});

describe("setContainerPinned", () => {
  test("pins and unpins, bumping updatedAt and appending the events", () => {
    const state = createEmptyState("container-pin");
    const container = createTopic(state, { title: "Trip planning" });
    expect(container.pinned).toBe(false);

    setContainerPinned(state, container.id, true);
    expect(container.pinned).toBe(true);
    setContainerPinned(state, container.id, false);
    expect(container.pinned).toBe(false);

    expect(state.events.some((e) => e.action === "chat.session.pinned" && e.target === container.id)).toBe(true);
    expect(state.events.some((e) => e.action === "chat.session.unpinned" && e.target === container.id)).toBe(true);
  });
});

describe("setContainerArchived", () => {
  test("archives and un-archives, bumping updatedAt and appending the events", () => {
    const state = createEmptyState("container-archive");
    const container = createTopic(state, { title: "Old conversation" });
    expect(container.archivedAt).toBeUndefined();

    setContainerArchived(state, container.id, true);
    expect(container.archivedAt).toBeString();
    setContainerArchived(state, container.id, false);
    expect(container.archivedAt).toBeUndefined();

    expect(state.events.some((e) => e.action === "chat.session.archived" && e.target === container.id)).toBe(true);
    expect(state.events.some((e) => e.action === "chat.session.unarchived" && e.target === container.id)).toBe(true);
  });

  test("re-asserting the current state is a no-op: same stamp, no extra event", () => {
    const state = createEmptyState("container-archive-idempotent");
    const container = createTopic(state, { title: "Old conversation" });

    setContainerArchived(state, container.id, true);
    const stamp = container.archivedAt;
    setContainerArchived(state, container.id, true);
    expect(container.archivedAt).toBe(stamp);
    expect(state.events.filter((e) => e.action === "chat.session.archived" && e.target === container.id)).toHaveLength(1);
  });

  test("throws for an unknown session", () => {
    const state = createEmptyState("container-archive-missing");
    expect(() => setContainerArchived(state, "chat_missing", true)).toThrow("Chat session not found");
  });
});

describe("findChildContainerByCorrelationKey", () => {
  test("resolves by (parent, key) and is scoped to the parent", () => {
    const state = createEmptyState("container-correlation");
    const child = createTopic(state, {
      title: "Reply to Sarah",
      parentChatSessionId: "chat_parent",
      correlationKey: "email:msg-1"
    });
    createTopic(state, {
      title: "Same key, other parent",
      parentChatSessionId: "chat_other",
      correlationKey: "email:msg-1"
    });

    expect(findChildContainerByCorrelationKey(state, "chat_parent", "email:msg-1")?.id).toBe(child.id);
    expect(findChildContainerByCorrelationKey(state, "chat_parent", "email:msg-2")).toBeUndefined();
  });

  test("still matches acknowledged and archived children — dedup survives dismiss", () => {
    const state = createEmptyState("container-correlation-dismissed");
    const child = createTopic(state, {
      title: "Old finding",
      parentChatSessionId: "chat_parent",
      correlationKey: "email:msg-9"
    });
    acknowledgeContainer(state, child.id);
    child.archivedAt = "2026-07-01T10:00:00.000Z";

    expect(findChildContainerByCorrelationKey(state, "chat_parent", "email:msg-9")?.id).toBe(child.id);
  });
});
