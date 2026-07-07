// UI-shaped types for the mobile client. Mirrors the wire shapes the
// runtime gateway sends; we keep only the fields the mobile screens
// actually read so a runtime field rename doesn't silently fan out
// across the app.

// ChatBlock is the typed conversation block the runtime emits over the
// /api/chat/:id/blocks (and /stream) endpoints. We re-export from
// `@runtime/types` so the mobile client cannot drift from the wire
// contract — adding a new block kind to src/types.ts immediately fans
// out into the renderer's exhaustive switch here.
export type {
  ChatBlock,
  ChatBlockKind,
  UserTextBlock,
  AudioAttachment,
  ImageAttachment,
  AssistantTextBlock,
  ToolCallBlock,
  ToolCallStatus,
  ToolResultBlock,
  PhaseBlock,
  AuthorizationRequestedBlock,
  SetupRequestedBlock,
  SetupRequest,
  SetupRequestStatus,
  SystemNoteBlock,
  JobRecord,
  RunRecord
} from "@runtime/types";

export interface ChatSession {
  id: string;
  instance: string;
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  runIds?: string[];
  summary?: string;
  source?: string;
  // Server-computed latest user_text / assistant_text content for the
  // session, truncated to ~140 chars on the runtime side. Null when the
  // session has no qualifying blocks yet (empty chat). Used by the chat
  // list to render a one-line subtitle below the title.
  lastMessagePreview?: string | null;
  // Role in the chats IA. `"agent"` = an agent's single canonical chat;
  // `"channel"` = a recurring-job-derived channel; `"topic"` = a
  // subject-scoped session with its own context window. Undefined for legacy /
  // non-canonical sessions.
  kind?: "agent" | "channel" | "topic";
  // `"job"` marks a session spawned by a scheduled job — channels carry
  // both this and `kind: "channel"`.
  origin?: "job";
  // Archived marker (absent = active). Archived sessions keep their history
  // and stay directly addressable, but are excluded from session lists.
  archivedAt?: string;
  // Sidebar membership (the container model): a session belongs in the
  // Topics list iff the user pinned it. Legacy topics are backfilled true
  // by a gateway migration; gateways predating the field never send it.
  pinned?: boolean;
  // Follow-up messages queued server-side while a turn is in flight. Drains
  // FIFO one-per-turn; the "N Queued" pill above the composer renders from
  // this. Kept live by the chat_session SSE frame. See ADR
  // chat-message-queue.md.
  pendingMessages?: PendingChatMessage[];
}

// A chat message held in the per-session queue while a turn is in flight.
// Mirrors the runtime `PendingChatMessage` (src/types.ts) — we keep only the
// fields the pill reads. `images` carries upload refs (id + mimeType + size);
// the pill shows a count/indicator, not the bytes. Audio is intentionally
// absent: a voice message is transcribed to `content` at prepare time.
export interface PendingChatMessage {
  id: string;
  content: string;
  images?: { id: string; mimeType: string; size: number }[];
  clientSurface?: ChatClientSurface;
  createdAt: string;
}

// Client surface a queued message was sent from. Mirrors the runtime
// `ChatClientSurface`; carried through on the pending record but not rendered.
export type ChatClientSurface =
  | "web"
  | "mobile"
  | "cli"
  | "telegram"
  | "discord"
  | "openclaw";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  instance: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  status: TaskStatus;
  currentStep?: string;
  summary?: string;
  agentId?: string;
}

export interface AgentRecord {
  id: string;
  instance: string;
  name: string;
  status: string;
  providerName?: string;
  model?: string;
  toolsets?: unknown[];
  messagingTargets?: unknown[];
  createdAt: string;
  updatedAt: string;
  // Archived marker (absent = active). Archived agents keep their memory
  // pool and history but move to the UI's Archived section and stop running.
  archivedAt?: string;
}

export interface AgentsResponse {
  activeAgentId?: string;
  // The always-present fallback agent. It can't be archived server-side, so
  // the agent list suppresses the archive affordance for this id.
  defaultAgentId?: string;
  agents: AgentRecord[];
}

export interface RuntimeStatus {
  instance?: string;
  activeAgent?: { id: string; name: string } | null;
}

export type ChatSessionDetail = ChatSession & {
  messages: ChatMessage[];
  tasks: Task[];
};
