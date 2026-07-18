import { describe, expect, test } from "bun:test";
import type { ChatSession } from "@/lib/view-types";
import { selectHomeChatSessions } from "./home-chat-sessions";

let ordinal = 0;

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  ordinal += 1;
  return {
    id: `chat-${ordinal}`,
    instance: "test",
    agentId: "agent-1",
    title: `Chat ${ordinal}`,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: `2026-07-15T00:${String(ordinal).padStart(2, "0")}:00.000Z`,
    messageIds: [],
    taskIds: [],
    runIds: [],
    kind: "topic",
    ...overrides
  };
}

describe("selectHomeChatSessions", () => {
  test("keeps active-agent conversations and routine channels newest first", () => {
    const manual = session({ title: "Manual", startedAs: "message" });
    const routine = session({
      title: "Routine",
      kind: "channel",
      origin: "job",
      updatedAt: "2026-07-15T01:00:00.000Z"
    });

    expect(selectHomeChatSessions([manual, routine], "agent-1").map((chat) => chat.title)).toEqual([
      "Routine",
      "Manual"
    ]);
  });

  test("excludes sessions owned by tasks, features, other agents, or other chrome", () => {
    const visible = session({ startedAs: "message" });
    const sessions = [
      visible,
      session({ startedAs: "task" }),
      session({ startedAs: "message", pinned: true }),
      session({ startedAs: "message", archivedAt: "2026-07-15T02:00:00.000Z" }),
      session({ startedAs: "message", headless: true }),
      session({ startedAs: "message", spawnedByTaskId: "task-1" }),
      session({ startedAs: "message", agentId: "agent-2" }),
      session({ startedAs: "message", kind: "agent" }),
      session({ startedAs: "message", origin: "job" }),
      session({ kind: "channel", origin: "job", feature: "email-watch" }),
      session({ kind: "channel", origin: "job", feature: "skill-review" }),
      session()
    ];

    expect(selectHomeChatSessions(sessions, "agent-1")).toEqual([visible]);
  });

  test("preserves the existing 15-chat cap and unscoped loading behavior", () => {
    const sessions = Array.from({ length: 18 }, () => session({ startedAs: "message" }));
    const selected = selectHomeChatSessions(sessions, undefined);

    expect(selected).toHaveLength(15);
    expect(selected[0]?.updatedAt > selected.at(-1)!.updatedAt).toBe(true);
  });
});
