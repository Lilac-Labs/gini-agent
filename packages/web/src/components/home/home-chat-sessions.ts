import type { ChatSession } from "@/lib/view-types";

// Conversations shown in Home's Chats section: user-started message containers
// plus routine delivery channels. Task-mode, pinned, archived, headless, and
// feature-owned containers belong to their existing surfaces instead.
export function selectHomeChatSessions(
  sessions: ChatSession[],
  activeAgentId: string | undefined
): ChatSession[] {
  return sessions
    .filter(
      (session) =>
        (session.kind === "topic" || session.kind === "channel") &&
        session.pinned !== true &&
        !session.archivedAt &&
        session.headless !== true &&
        (activeAgentId == null || session.agentId === activeAgentId) &&
        ((session.startedAs === "message" &&
          !session.spawnedByTaskId &&
          session.origin !== "job") ||
          (session.kind === "channel" &&
            session.origin === "job" &&
            session.feature === undefined))
    )
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 15);
}
