import type {
  Authorization,
  ChatSessionRecord,
  ContainerAttention,
  HomeDoneItem,
  HomeTaskItem,
  JobRecord,
  RecentItem,
  RuntimeConfig,
  SetupRequest,
  Task
} from "../types";
import {
  buildDailyUsage,
  buildContainerAttentionIndex,
  deriveContainerAttention,
  isTerminalTaskStatus,
  latestRunOutcome,
  readState,
  type ContainerAttentionIndex,
  type ContainerRunOutcome,
  type DayUsage
} from "../state";
import { status } from "./index";

// Daily token-usage rollup for the home chart. Reads the durable usage ledger
// (not task.cost), so it captures all generative spend — chat, jobs,
// subagents, memory, titles, vision — and survives task pruning. `days` is
// clamped to a sane window; agentId scopes to one agent (unattributed overhead
// is included in every agent view). See ADR usage-accounting.md.
export function dailyUsage(
  config: RuntimeConfig,
  opts: { days?: number; agentId?: string } = {}
): DayUsage[] {
  const state = readState(config.instance);
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 14), 1), 90);
  return buildDailyUsage(state.usageLedger ?? [], days, opts.agentId);
}

export function mobileBootstrap(config: RuntimeConfig) {
  const state = publicState(config);
  return {
    runtime: status(config),
    instance: config.instance,
    tasks: state.tasks,
    authorizations: state.authorizations,
    setupRequests: state.setupRequests,
    skills: state.skills,
    jobs: state.jobs,
    connectors: state.connectors,
    improvements: state.improvements,
    toolsets: state.toolsets,
    tools: state.tools,
    subagents: state.subagents,
    mcpServers: state.mcpServers,
    messagingBridges: state.messagingBridges,
    importReports: state.importReports,
    agents: state.agents,
    activeAgentId: state.activeAgentId,
    relays: state.relays,
    notifications: state.notifications,
    events: state.events,
    jobRuns: state.jobRuns,
    chatSessions: state.chatSessions,
    chatMessages: state.chatMessages.filter((m) => m.kind !== "tool_transcript"),
    messagingMessages: state.messagingMessages,
    runs: state.runs,
    planSteps: state.planSteps
  };
}

export function publicState(config: RuntimeConfig) {
  const state = readState(config.instance);
  return {
    ...state,
    chatMessages: state.chatMessages.filter((m) => m.kind !== "tool_transcript")
  };
}

// Home surfaces decisions first: rows sort by attention precedence, then
// recency within each band.
const HOME_ATTENTION_ORDER: Record<ContainerAttention, number> = {
  needs_input: 0,
  review: 1,
  working: 2,
  done_unacknowledged: 3,
  none: 4
};

// Bound the Recents artifact feed — home is a daily surface, not an archive.
const HOME_RECENTS_CAP = 10;

// Same bound for the collapsible Done section.
const HOME_DONE_CAP = 10;

// Truncation cap for a home row's outcome line — same one-liner budget as
// the chat list's lastMessagePreview.
const HOME_OUTCOME_LINE_CHARS = 140;

// Who initiated the container. Facts only: a job-origin container was minted
// by a schedule fire; a container carrying spawn provenance was minted by the
// agent during a run; everything else traces to a user gesture.
function containerStartedBy(session: ChatSessionRecord): HomeTaskItem["startedBy"] {
  if (session.origin === "job") return "schedule";
  if (session.spawnedByTaskId) return "agent";
  return "user";
}

// First line of the latest outcome's summary (error for failures), bounded.
function outcomeLineFor(outcome: ContainerRunOutcome): string {
  const raw =
    outcome.status === "completed"
      ? outcome.summary ?? "Done"
      : outcome.status === "failed"
        ? outcome.error ?? outcome.summary ?? "Failed"
        : "Cancelled";
  const firstLine = raw.split("\n", 1)[0]!.trim();
  return firstLine.length > HOME_OUTCOME_LINE_CHARS
    ? `${firstLine.slice(0, HOME_OUTCOME_LINE_CHARS).trimEnd()}…`
    : firstLine;
}

// Saved Gmail drafts render from a fenced email-draft block and do not create
// a messaging.send authorization until the user chooses Send on the card.
function taskProducedEmailDraft(task: Task): boolean {
  return (
    typeof task.summary === "string" &&
    /(?:^|\r?\n)[ \t]*```email-draft[ \t]*(?:\r?\n|$)/.test(task.summary)
  );
}

// Map a pending Authorization to the home review affordance. `kind` drives
// the row icon: an outbound message send reads as an email-style review,
// file writes as a document review, everything else generic. The label is
// kind-derived button copy — the card with full context lives in the thread
// the button deep-links to.
function reviewForAuthorization(auth: { id: string; action: string }): NonNullable<HomeTaskItem["review"]> {
  const kind =
    auth.action === "messaging.send"
      ? "email"
      : auth.action === "file.write" || auth.action === "file.patch"
        ? "document"
        : "generic";
  const label = kind === "email" ? "Review & send" : kind === "document" ? "Review document" : "Review";
  return { label, kind, authorizationId: auth.id };
}

// Lean home read path (GET /api/home). Deliberately does NOT reuse
// listChatSessions — that view embeds full message arrays per session; home
// only needs derived attention + a few facts per container.
//
// A container is a home task row iff its derived attention ≠ none (an
// acknowledged/quiet container never appears as a task row — this IS the
// server-side acknowledged filter) AND the inclusion predicate holds:
//   startedBy === "user"
//   OR attention ∈ {needs_input, review}
//   OR surfaced === true.
// So user-started work shows its full lifecycle, agent-spawned internal
// errands surface only when they need a decision, and containers the spawner
// explicitly marked user-facing surface on any live attention. Headless and
// archived containers never appear; the root Chat (kind:"agent") and bridge
// sessions are not containers on home — Chat is its own surface.
// Message-mode conversations (startedAs === "message") also skip the TASKS
// list — they live in Home's Chats tab, so a parked question or
// finished reply there never reads as a task row. They still feed Recents.
//
// Acknowledged containers whose latest outcome is a completed run resurface
// in `done` (the collapsible Done section) under the same visibility rules;
// acknowledged failures and cancellations disappear entirely.
export function homeView(
  config: RuntimeConfig,
  agentId?: string
): { owner?: { firstName: string }; tasks: HomeTaskItem[]; done: HomeDoneItem[]; recents: RecentItem[] } {
  const state = readState(config.instance);
  const index = buildContainerAttentionIndex(state);
  // Tasks that produced an outbound-message draft render with the draft icon
  // in Recents; message-mode containers render with the chat icon instead.
  // Authorizations cover approval-gated sends; the final summary covers saved
  // Gmail drafts rendered as cards before any send is requested.
  const draftTaskIds = new Set<string>();
  for (const auth of state.authorizations) {
    if (auth.action === "messaging.send" && auth.taskId) draftTaskIds.add(auth.taskId);
  }
  // Session → the newest scheduled job created from that conversation (a
  // chat-created job stamps its originating session on job.chatSessionId).
  // Precomputed in one pass so each row lookup is O(1); the newest job wins
  // when several point at one conversation. Drives the row's Routine chip.
  const routineJobBySession = new Map<string, JobRecord>();
  for (const job of state.jobs) {
    if (!job.chatSessionId) continue;
    const current = routineJobBySession.get(job.chatSessionId);
    if (!current || job.createdAt > current.createdAt) routineJobBySession.set(job.chatSessionId, job);
  }
  const tasks: HomeTaskItem[] = [];
  const done: HomeDoneItem[] = [];
  const recents: RecentItem[] = [];
  for (const session of state.chatSessions) {
    if (session.kind !== "topic" && session.kind !== "channel") continue;
    if (session.archivedAt || session.headless) continue;
    if (agentId && session.agentId !== agentId) continue;
    const startedBy = containerStartedBy(session);
    const userFacing = startedBy === "user" || session.surfaced === true;
    if (userFacing) {
      // One Recents entry per container, titled by the CONTAINER: the newest
      // completed run wins, so a follow-up run updates the entry's recency
      // instead of adding a second row titled with the follow-up text.
      let newest: Task | undefined;
      for (const task of index.tasksBySession.get(session.id) ?? []) {
        if (task.status !== "completed") continue;
        if (!newest || task.updatedAt > newest.updatedAt) newest = task;
      }
      if (newest) {
        recents.push({
          id: newest.id,
          containerId: session.id,
          icon:
            session.startedAs === "message"
              ? "chat"
              : draftTaskIds.has(newest.id) || taskProducedEmailDraft(newest)
                ? "draft"
                : "document",
          title: session.title,
          timestamp: newest.updatedAt
        });
      }
    }
    // Recents above still applies; only the task-row path skips message-mode
    // conversations (they belong to Home's Chats tab, not the
    // home tasks queue). Undefined startedAs (older records, router topics)
    // keeps the row exactly as before.
    if (session.startedAs === "message") continue;
    const attention = deriveContainerAttention(state, session, index);
    if (attention === "none") {
      // Acknowledged containers leave the task queue; the ones whose latest
      // outcome is a success resurface in the Done section. Acknowledged
      // failures/cancellations disappear entirely, and agent-spawned
      // internal errands never show (same visibility rule as task rows).
      if (!userFacing) continue;
      const outcome = latestRunOutcome(state, session, index);
      if (outcome && outcome.status === "completed") {
        const doneItem: HomeDoneItem = { id: session.id, title: session.title, completedAt: outcome.at };
        if (outcome.summary) doneItem.outcomeLine = outcomeLineFor(outcome);
        done.push(doneItem);
      }
      continue;
    }
    if (!userFacing && attention !== "needs_input" && attention !== "review") continue;
    const outcome = latestRunOutcome(state, session, index);
    const item: HomeTaskItem = {
      id: session.id,
      title: session.title,
      attention,
      // Every served row is unacknowledged by construction: live attention
      // (needs_input/review/working) means the current run has no outcome to
      // acknowledge yet — a previously acked outcome never pre-checks the box
      // for a new run — and done_unacknowledged means the latest outcome is
      // newer than acknowledgedAt. Acknowledged containers derive attention
      // "none" and were filtered above; the field exists so the client can
      // flip it optimistically after POST /acknowledge.
      acknowledged: false,
      startedBy,
      updatedAt: session.updatedAt
    };
    const routineJob = routineJobBySession.get(session.id);
    if (routineJob) item.routineJobId = routineJob.id;
    if (attention === "done_unacknowledged" && outcome) {
      item.outcomeLine = outcomeLineFor(outcome);
      // Only a failure gets the destructive treatment + Retry; cancelled
      // stays a neutral outcome (a superseded container immediately has a
      // new live run anyway). Retry is POST /api/containers/:id/retry — the
      // server re-reads the failed run's input there, so the row carries
      // only the flag.
      if (outcome.status === "failed") item.failed = true;
    }
    if (attention === "needs_input") {
      const setup = newestPendingChoice(session, index);
      if (setup) {
        const payload = setup.payload as { question?: unknown; options?: unknown };
        const options = Array.isArray(payload.options)
          ? payload.options
              .map((o) => (o && typeof o === "object" ? String((o as { label?: unknown }).label ?? "") : ""))
              .filter((label) => label.length > 0)
          : undefined;
        item.needsInput = {
          question: typeof payload.question === "string" ? payload.question : setup.reason,
          ...(options && options.length > 0 ? { options } : {}),
          setupRequestId: setup.id
        };
      }
    }
    if (attention === "review") {
      const auth = newestPendingAuthorization(session, index);
      if (auth) item.review = reviewForAuthorization(auth);
    }
    tasks.push(item);
  }
  tasks.sort((a, b) => {
    const byAttention = HOME_ATTENTION_ORDER[a.attention] - HOME_ATTENTION_ORDER[b.attention];
    return byAttention !== 0 ? byAttention : b.updatedAt.localeCompare(a.updatedAt);
  });
  done.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  recents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const firstName = config.ownerFirstName?.trim();
  return {
    ...(firstName ? { owner: { firstName } } : {}),
    tasks,
    done: done.slice(0, HOME_DONE_CAP),
    recents: recents.slice(0, HOME_RECENTS_CAP)
  };
}

// The newest pending gate across a session's LIVE tasks (a stale pending row
// on a terminal task never drives home affordances). Gate lists are in state
// order (newest first), so the first hit wins.
function newestPendingChoice(
  session: ChatSessionRecord,
  index: ContainerAttentionIndex
): SetupRequest | undefined {
  for (const task of index.tasksBySession.get(session.id) ?? []) {
    if (isTerminalTaskStatus(task.status)) continue;
    const gates = index.pendingChoicesByTask.get(task.id);
    if (gates && gates.length > 0) return gates[0];
  }
  return undefined;
}

function newestPendingAuthorization(
  session: ChatSessionRecord,
  index: ContainerAttentionIndex
): Authorization | undefined {
  for (const task of index.tasksBySession.get(session.id) ?? []) {
    if (isTerminalTaskStatus(task.status)) continue;
    const gates = index.pendingAuthorizationsByTask.get(task.id);
    if (gates && gates.length > 0) return gates[0];
  }
  return undefined;
}
