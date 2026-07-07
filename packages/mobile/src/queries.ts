import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import EventSource from "react-native-sse";
import { api, ApiError, resolveStreamEndpoint, type UploadRef } from "./api";
import { refreshBadge } from "./push";
import type {
  AgentRecord,
  AgentsResponse,
  ChatBlock,
  ChatSession,
  JobRecord,
  RunRecord,
  RuntimeStatus,
  SetupRequest,
  Task
} from "./types";

// Web parity: chat task statuses where partial text is no longer arriving.
// `waiting_approval` / `needs_input` are included here on the polling side
// because the runtime can't make further progress without user input; we
// don't poll faster while sitting on them.
const CHAT_TERMINAL_TASK_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "waiting_approval",
  "needs_input"
]);

// Request timeout for voice-message sends. A voice POST blocks on
// server-side transcription, and the very first one also waits on the
// local whisper model downloading — the composer warns this "can take a
// minute." The send mutation passes this so the default write timeout
// can't abort a legitimate first-run transcription.
const VOICE_SEND_TIMEOUT_MS = 120_000;



export function useStatus(options?: Partial<UseQueryOptions<RuntimeStatus>>) {
  return useQuery<RuntimeStatus>({
    queryKey: ["status"],
    queryFn: () => api<RuntimeStatus>("/status"),
    ...options
  });
}

// Speech-to-text readiness. `ready` is false until the local whisper model
// has finished its one-time download, which lets the composer warn the user
// that the first voice message will take a moment to set up. Cached for a
// while since readiness only flips once; useSendMessage invalidates this key
// after a successful send so the flip is picked up promptly.
export function useVoiceStatus() {
  return useQuery<{ provider: string; model: string; ready: boolean }>({
    queryKey: ["voice-status"],
    queryFn: () => api<{ provider: string; model: string; ready: boolean }>("/stt/status"),
    staleTime: 60_000
  });
}

export function useAgents() {
  return useQuery<AgentsResponse>({
    queryKey: ["agents"],
    queryFn: () => api<AgentsResponse>("/agents"),
    // Agent list rarely changes; a 30s polling floor is enough to pick
    // up the user creating an agent via the web while the mobile app is
    // backgrounded.
    refetchInterval: 30_000
  });
}

export function useUseAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (agentId: string) =>
      api<AgentRecord>(`/agents/${agentId}/use`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

// Soft-deletes an agent (POST /agents/:id/archive): the runtime stamps
// `archivedAt`, moves it to the Archived section, and stops its scheduled
// jobs. Archiving the active agent hands "active" back to the default
// server-side, so we invalidate the same keys as useUseAgent — the active
// selection (status) and its chat list both shift.
export function useArchiveAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (agentId: string) =>
      api<AgentRecord>(`/agents/${agentId}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

// Restores an archived agent (POST /agents/:id/unarchive): clears
// `archivedAt` so it rejoins the active list (still inactive — restore never
// auto-activates). Same invalidation set as archive for symmetry.
export function useUnarchiveAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (agentId: string) =>
      api<AgentRecord>(`/agents/${agentId}/unarchive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

// POST /api/agents only requires `name`; the runtime copies provider /
// toolsets / messaging targets from the default agent (see
// src/capabilities/agents.ts). The created agent is returned so callers
// can pivot the selection to it immediately.
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation<AgentRecord, Error, string>({
    mutationFn: (name: string) =>
      api<AgentRecord>("/agents", {
        method: "POST",
        body: JSON.stringify({ name })
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
    }
  });
}

// Per-session unread counts for the calling device. Returns a record
// keyed by sessionId; sessions with zero unread blocks are omitted so
// the ChatRow can default to 0 without a separate "is this session in
// the map" check. The query is device-scoped on the server (matches
// /badge); skipping it on web/CLI where there's no X-Device-Token
// avoids the predictable 400 the gateway would return.
export function useUnreadCounts() {
  return useQuery<{ counts: Record<string, number> }, Error, Record<string, number>>({
    queryKey: ["unread"],
    queryFn: () => api<{ counts: Record<string, number> }>("/unread"),
    enabled: Boolean(getCachedDeviceTokenSafe()),
    refetchInterval: 3000,
    select: (data) => data.counts
  });
}

// Lazy access to the cached APNs token. push.ts depends on this module
// transitively through ApiError, so a static import would create a
// cycle that some bundlers resolve to undefined at module-eval time.
// The require() form is the same shape api.ts uses to inject
// X-Device-Token without the cycle.
function getCachedDeviceTokenSafe(): string | null {
  try {
    const mod = require("./push") as { getCachedDeviceToken?: () => string | null };
    return mod.getCachedDeviceToken?.() ?? null;
  } catch {
    return null;
  }
}

// Per-agent chat list. The gateway filters server-side via ?agentId, so
// the React Query key includes the agentId — switching agents triggers a
// fresh fetch instead of briefly flashing the previous agent's chats.
export function useChats(agentId: string | null) {
  return useQuery<ChatSession[]>({
    queryKey: ["chats", agentId],
    queryFn: () =>
      api<ChatSession[]>(`/chat?agentId=${encodeURIComponent(agentId ?? "")}`),
    enabled: Boolean(agentId),
    refetchInterval: 3000
  });
}

// The single canonical chat session for an agent (one-chat-per-agent IA).
// GET /api/agents/:id/chat lazily resolves or creates it, so the result
// is stable across calls for the same agent. The Channels list taps the
// agent row → this resolves the session id → push /chat/[sessionId].
export function useAgentChat(agentId: string | null) {
  return useQuery<ChatSession>({
    queryKey: ["agent-chat", agentId],
    queryFn: () => api<ChatSession>(`/agents/${encodeURIComponent(agentId ?? "")}/chat`),
    enabled: Boolean(agentId),
    // The resolver is idempotent and the title/preview can change as the
    // agent talks; a slow poll keeps the Channels row preview fresh.
    refetchInterval: 30_000
  });
}

// Job records. Pass an agentId to scope to one agent (the chat detail's
// Jobs tab); pass `"all"` to fetch every job in the instance (the
// Channels screen pairs each job with its delivery channel via
// job.chatSessionId so the "Recurring Jobs" rows show the schedule +
// next-run). `null` disables the query.
export function useJobs(agentId: string | null | "all") {
  return useQuery<JobRecord[]>({
    queryKey: ["jobs", agentId],
    queryFn: () =>
      api<JobRecord[]>(
        agentId === "all" ? "/jobs" : `/jobs?agentId=${encodeURIComponent(agentId ?? "")}`
      ),
    enabled: agentId !== null,
    refetchInterval: 30_000
  });
}

// Pending and resolved SetupRequests for the instance. The mobile
// confirmation card (BlockSetupRequested, action "confirmation.request")
// reads this to know whether its request is still pending and to pull the
// trusted payload (details, confirmLabel) — the setup_requested block only
// carries {setupRequestId, action, summary}. Mirrors web useSetupRequests.
// A slow poll picks up a resolution made from the web client; the card's
// own Confirm/Cancel mutations invalidate this key for the immediate flip.
export function useSetupRequests() {
  return useQuery<SetupRequest[]>({
    queryKey: ["setup-requests"],
    queryFn: () => api<SetupRequest[]>("/setup-requests"),
    refetchInterval: 30_000
  });
}

// Run records for one session — used to mark job-delivered chat messages
// with a "from <job name>" badge. GET /chat/:id returns the session's full
// run list (incl. kind/jobId); we select just `runs` and join jobId → name
// against the jobs list at the call site. The stream hook only carries
// runIds, so this is the cheapest source of the kind/jobId join.
export function useChatRuns(sessionId: string | null) {
  return useQuery<{ runs: RunRecord[] }, Error, RunRecord[]>({
    queryKey: ["chat-runs", sessionId],
    queryFn: () => api<{ runs: RunRecord[] }>(`/chat/${sessionId}`),
    enabled: Boolean(sessionId),
    refetchInterval: 30_000,
    select: (detail) => detail.runs ?? []
  });
}

// Phase labels that mean "no task in flight". Anything else (Thinking,
// Working: <tool>, Waiting for approval, …) keeps the in-flight flag
// raised so the polling cadence stays brisk and the composer's busy
// state remains accurate.
const TERMINAL_PHASE_LABELS = new Set<string>(["Completed", "Cancelled", "Failed"]);

// Derives "is the runtime still doing work?" from the block list. The
// chat detail screen drives its composer busy state off this — block
// deltas now arrive over SSE, so the signal updates as soon as the
// gateway emits, without any polling cadence in the loop.
//
// Rules (mirror src/execution/chat-task.ts emission anchors):
//   - The most recent phase block dictates the high-level state. If its
//     label is Completed / Cancelled / Failed → no task in flight.
//   - A tool_call(running) without a status flip means a tool is still
//     working even if the most recent phase block already moved past it
//     (e.g. the model said "Thinking" while a long-running parallel tool
//     is still going). callId pairs the running entry with its terminal
//     status, so we count distinct callIds with no later non-running row.
//   - An authorization_requested or setup_requested block whose
//     tool_call still reads "running" means we're paused on the user —
//     the composer stays busy until the eventual approve/deny/complete
//     flip arrives on the stream.
export function isTaskInFlight(blocks: ChatBlock[]): boolean {
  if (blocks.length === 0) return false;

  // Pass 1: find the most recent phase block.
  let latestPhaseLabel: string | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    if (b.kind === "phase") {
      latestPhaseLabel = b.label;
      break;
    }
  }

  // Pass 2: scan for unresolved tool_calls by callId. A `running` entry
  // is unresolved unless a later block with the same callId carries a
  // terminal status (ok / error / denied).
  const callStatus = new Map<string, "running" | "ok" | "error" | "denied">();
  for (const b of blocks) {
    if (b.kind === "tool_call") callStatus.set(b.callId, b.status);
  }
  let anyRunningCall = false;
  for (const status of callStatus.values()) {
    if (status === "running") {
      anyRunningCall = true;
      break;
    }
  }

  if (anyRunningCall) return true;
  if (!latestPhaseLabel) {
    // No phase block yet (a fresh user_text just landed) → assume the
    // runtime is about to emit Thinking; cadence stays brisk.
    return true;
  }
  return !TERMINAL_PHASE_LABELS.has(latestPhaseLabel);
}

// Chat-detail stream consumer. Combines a one-shot /blocks fetch (seeds
// the initial render and gives us a Last-Event-ID cursor) with an SSE
// subscription to /stream for live updates. The same SSE connection
// delivers two event kinds:
//   - `chat_block` — block inserts / upserts (assistant_text deltas,
//     tool_call status flips, phase markers, …). Backed by chat-blocks
//     pub/sub on the server; client merges by id.
//   - `chat_session` — session-record updates (currently: title renames).
//     Sent once on initial connect so the client always has a title
//     without a separate REST round-trip, then again whenever the
//     gateway renames the chat (explicit /rename or the auto-rename
//     after the first qualifying turn).
//
// Trust + lifecycle model (4-6 lines per CLAUDE.md):
//   - Bearer token is read from the in-memory credential cache on every
//     EventSource open via resolveStreamEndpoint; a 401 from the initial
//     /blocks fetch surfaces as ApiError so the screen's redirect-to-setup
//     effect still fires.
//   - We manage Last-Event-ID ourselves. react-native-sse only retains
//     its `lastEventId` for the life of one EventSource instance; every
//     reconstruction (sessionId change, AppState toggle, error-driven
//     reopen, initial connect after seed) would otherwise reset it. We
//     stash the wire id (`<block_id>:<ts>` for SSE frames, the bare id
//     for the /blocks seed) in lastSeenIdRef and rewrite the header on
//     every open; the gateway parses the suffix in listChatBlocksAfter
//     to replay in-place upserts to the cursor row. chat_session events
//     are not part of the Last-Event-ID cursor — every reconnect re-emits
//     the current session record from the server's initial-send path.
//   - AppState 'background' tears the connection down so an idle device
//     doesn't hold an open XHR; 'active' rebuilds it and the same
//     Last-Event-ID path replays only what was missed.
//
// Returns the typed block list and the session record directly — no
// derivation, no normalization; the renderer is exhaustive over the
// block discriminated union, and the session field is just the wire
// shape from the gateway. Every block for the session renders linearly in
// ordinal order — side-conversations now live in their own Topic sessions
// rather than threading into this one.
export function useChatStream(
  sessionId: string | null
): {
  blocks: ChatBlock[] | undefined;
  session: ChatSession | undefined;
  isPending: boolean;
  error: Error | null;
} {
  // Stream state is tagged with the sessionId it was loaded for so a
  // chat A → chat B switch doesn't paint chat A's blocks under chat B's
  // header for one frame. The reset useEffect only runs after render,
  // so without this gate the very first render after sessionId changes
  // would still see the previous chat's blocks in state. Reading via
  // `forSessionId === sessionId ? blocks : undefined` collapses that
  // window to a single empty paint, matching the loading skeleton. The
  // session field follows the same gate so a stale title from chat A
  // doesn't briefly head chat B.
  type StreamState = {
    forSessionId: string | null;
    blocks: ChatBlock[] | undefined;
    session: ChatSession | undefined;
  };
  const [state, setState] = useState<StreamState>({
    forSessionId: null,
    blocks: undefined,
    session: undefined
  });
  const [error, setError] = useState<Error | null>(null);

  // Latest setters live in refs so the long-lived effect closures (SSE
  // listeners, AppState subscription) don't get torn down on every state
  // update. Without this, every block delta would unsubscribe and
  // reopen the EventSource, defeating the point of streaming.
  const dataRef = useRef<StreamState>({
    forSessionId: null,
    blocks: undefined,
    session: undefined
  });
  useEffect(() => {
    dataRef.current = state;
  }, [state]);

  // Tracks the id of the most recent block observed so we can carry
  // Last-Event-ID across every EventSource reconstruction — react-native-sse
  // tracks its own lastEventId per instance, but a fresh `new EventSource()`
  // after AppState transitions, error-driven reopen, or initial connect
  // starts blank. Passing the header explicitly lets the gateway's
  // listChatBlocksAfter replay only what was missed. The SSE wire id is
  // the same string the server assigns as the block id, so we update this
  // wherever we mutate dataRef.
  const lastSeenIdRef = useRef<string | null>(null);

  // Stable id for THIS hook instance's stream, generated once per mount and
  // sent both on the SSE handshake (?streamId=) and on the unmount unwatch
  // beacon. It lets the gateway clear exactly the stream this screen opened
  // without disturbing another stream the client may hold on the same session.
  const streamIdRef = useRef<string>(
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  );

  useEffect(() => {
    // Reset unconditionally before branching so a sessionId change
    // (chat A → chat B) doesn't leave chat A's blocks rendered until
    // chat B's seed resolves. The previous effect's cleanup tears down
    // the old subscription; this clears the view so the next paint
    // doesn't briefly mix the two chats' contents. Tagging the state
    // with `forSessionId = sessionId` lets the render-time read return
    // `undefined` until the seed for the new chat lands.
    setState({ forSessionId: sessionId, blocks: undefined, session: undefined });
    setError(null);
    dataRef.current = { forSessionId: sessionId, blocks: undefined, session: undefined };
    lastSeenIdRef.current = null;

    if (!sessionId) return;

    let cancelled = false;
    let seeded = false;
    let es: EventSource<"chat_block" | "chat_session"> | null = null;
    let appStateSub: { remove(): void } | null = null;

    // Merge a single block into the list. assistant_text streams in as
    // repeated frames with the same id and a growing `text` payload; we
    // upsert by id so the final list contains one entry per block, with
    // the latest payload. Other kinds also upsert (tool_call status
    // flips reuse the call's block id, etc.) — see chat-block-protocol.md.
    //
    // Race guard: if a stale event from chat A arrives after the
    // sessionId effect has reset to chat B (or vice versa), drop it.
    // dataRef.current.forSessionId is the source of truth — it's set
    // synchronously at the top of this effect, before any async work.
    //
    // `wireEventId` is the raw `id:` line value (e.g. `<block_id>:<ts>`),
    // distinct from `block.id` (the JSON payload's id field). We store
    // the wire form so the next Last-Event-ID header carries the
    // gateway's updated_at snapshot suffix; the gateway parses that
    // suffix to detect in-place upserts to the cursor row.
    const upsert = (block: ChatBlock, wireEventId: string | null): void => {
      if (dataRef.current.forSessionId !== sessionId) return;
      if (block.sessionId !== sessionId) return;
      const current = dataRef.current.blocks ?? [];
      const idx = current.findIndex((b) => b.id === block.id);
      const next =
        idx >= 0
          ? current.map((b, i) => (i === idx ? block : b))
          : [...current, block];
      const session = dataRef.current.session;
      dataRef.current = { forSessionId: sessionId, blocks: next, session };
      if (wireEventId) lastSeenIdRef.current = wireEventId;
      setState({ forSessionId: sessionId, blocks: next, session });
    };

    // Apply a chat_session frame. Race-guarded by forSessionId the same
    // way upsert() is, so a delayed frame from chat A can't overwrite
    // chat B's session record. Not part of the Last-Event-ID cursor:
    // the gateway re-emits the current record on every reconnect, so
    // missing a transient rename frame is harmless.
    const applySession = (session: ChatSession): void => {
      if (dataRef.current.forSessionId !== sessionId) return;
      if (session.id !== sessionId) return;
      const blocks = dataRef.current.blocks;
      dataRef.current = { forSessionId: sessionId, blocks, session };
      setState({ forSessionId: sessionId, blocks, session });
    };

    const openStream = (): void => {
      if (cancelled) return;
      if (es) return;
      let endpoint: { url: string; headers: Record<string, string> };
      try {
        endpoint = resolveStreamEndpoint(
          `/chat/${sessionId}/stream?streamId=${encodeURIComponent(streamIdRef.current)}`
        );
      } catch (err) {
        if (!cancelled) setError(err as Error);
        return;
      }
      // Build a fresh header set per open so a Last-Event-ID accumulated
      // by upsert() or the seed handler rides along on every new XHR.
      // react-native-sse keeps the header for as long as the instance
      // lives; reconstruction (AppState toggle, error reopen, sessionId
      // change) is exactly when the cursor would otherwise reset.
      const headers: Record<string, string> = { ...endpoint.headers };
      if (lastSeenIdRef.current) {
        headers["Last-Event-ID"] = lastSeenIdRef.current;
      }
      const source = new EventSource<"chat_block" | "chat_session">(endpoint.url, {
        headers,
        // 0 disables auto-reconnect; we want it on. The library default
        // (5000ms) is fine — a longer gap means slower recovery from a
        // reconnect but doesn't lose data thanks to Last-Event-ID.
        pollingInterval: 5000
      });
      source.addEventListener("chat_block", (ev) => {
        if (cancelled) return;
        if (!ev.data) return;
        try {
          const block = JSON.parse(ev.data) as ChatBlock;
          upsert(block, ev.lastEventId ?? null);
        } catch {
          // Drop malformed frames; the server controls this format and a
          // parse failure here is a wire-protocol bug, not a user one.
        }
      });
      source.addEventListener("chat_session", (ev) => {
        if (cancelled) return;
        if (!ev.data) return;
        try {
          applySession(JSON.parse(ev.data) as ChatSession);
        } catch {
          // Same rationale as chat_block — wire format is server-controlled.
        }
      });
      source.addEventListener("error", (ev) => {
        if (cancelled) return;
        // 401 means our bearer token was rejected — the library will
        // happily keep retrying with the same dead token, so we surface
        // it to the screen (which already routes 401s to the signed-out screen)
        // and tear the connection down. Other errors are transient
        // network blips; let the library reconnect on its polling
        // interval, where Last-Event-ID will resume the stream.
        if (ev.type === "error" && "xhrStatus" in ev && ev.xhrStatus === 401) {
          setError(new ApiError(401, "Unauthorized"));
          closeStream();
        }
      });
      es = source;
    };

    const closeStream = (): void => {
      if (!es) return;
      // react-native-sse schedules a reconnect poll AFTER our error
      // handler returns: on a non-2xx XHR finish the library dispatches
      // 'error', then unconditionally calls `_pollAgain(interval)` which
      // sets `_pollTimer = setTimeout(open, interval)`. Our inline
      // `close()` clears `_pollTimer` BEFORE the library has set it, so
      // an orphan timer would later fire `open()` and resurrect the
      // dead connection (re-hitting /stream with the same dead bearer
      // token on 401). Capture the dying instance, run the inline
      // teardown, and schedule a deferred `close()` that runs AFTER the
      // library's `_pollAgain` so the post-dispatch timer gets cleared.
      const dying = es;
      es = null;
      dying.removeAllEventListeners();
      dying.close();
      setTimeout(() => {
        try {
          dying.close();
        } catch {
          // close() is idempotent in react-native-sse; the catch is
          // belt-and-suspenders against a future internal change.
        }
      }, 0);
    };

    // Gated open: we must never spin up an EventSource before the seed
    // has resolved (so the seed merge sees an authoritative baseline) or
    // while the app is backgrounded (iOS will tear the XHR down anyway).
    // The AppState callback and the seed completion both route through
    // here so neither path can race past the other.
    const maybeOpenStream = (): void => {
      if (!seeded) return;
      if (cancelled) return;
      if (es) return;
      if (AppState.currentState !== "active") return;
      openStream();
    };

    // Seed both blocks and the session record before opening the stream
    // so the chat renders its persisted history AND its canonical title
    // in a single first paint. The two REST calls fire in parallel
    // (Promise.all) because the chat detail screen needs both up front:
    // without the session in the seed, the header would briefly show
    // the first-user-text fallback before the SSE chat_session frame
    // lands and overwrites it — a visible flash on chat-open.
    //
    // The seed resolve stashes the last block's id into lastSeenIdRef;
    // openStream() reads that ref and injects it as `Last-Event-ID` on
    // the first SSE connect, so the gateway's listChatBlocksAfter only
    // replays what's actually new (typically nothing). If `merged` is
    // empty (fresh chat with no blocks), the header is omitted and the
    // gateway falls back to full backfill; the id-keyed upsert collapses
    // any duplicates.
    (async () => {
      try {
        const [blocks, session] = await Promise.all([
          api<ChatBlock[]>(`/chat/${sessionId}/blocks`),
          api<ChatSession>(`/chat/${sessionId}`)
        ]);
        if (cancelled) return;
        // Merge by id rather than overwrite. If the AppState handler or
        // any other path opened a stream while the seed was in flight,
        // dataRef may already hold deltas that arrived ahead of the
        // /blocks response; overwriting would drop them. Seeded rows
        // win for their own ids; any extra ids already in dataRef are
        // preserved at the tail.
        const existing = dataRef.current.blocks ?? [];
        const seededIds = new Set(blocks.map((b) => b.id));
        const merged: ChatBlock[] = [
          ...blocks,
          ...existing.filter((b) => !seededIds.has(b.id))
        ];
        // Prefer a session record that already arrived over SSE (a
        // mid-seed reconnect could plausibly land one, though with
        // Promise.all the REST response usually wins) — the SSE frame
        // is the more recent snapshot from the same source.
        const liveSession = dataRef.current.session ?? session;
        dataRef.current = { forSessionId: sessionId, blocks: merged, session: liveSession };
        // Seed the resume cursor so the very first SSE open skips
        // the redundant full replay listChatBlocksAfter(null) emits.
        // The /blocks REST response only carries the block's id (no
        // updated_at suffix), so we stash the bare id; the gateway's
        // listChatBlocksAfter falls back to reading the row's current
        // updated_at when the suffix is absent. Subsequent SSE frames
        // will rewrite this with the wire `<id>:<ts>` form.
        lastSeenIdRef.current = merged[merged.length - 1]?.id ?? null;
        setState({ forSessionId: sessionId, blocks: merged, session: liveSession });
        setError(null);
        seeded = true;
        maybeOpenStream();
      } catch (err) {
        if (cancelled) return;
        setError(err as Error);
        // Don't open the stream on a 401 — the screen redirects to the signed-out screen.
        if (!(err instanceof ApiError && err.status === 401)) {
          // Mark as seeded even on transport failure so a foregrounding
          // user can retry via the AppState handler; the gateway will
          // backfill via listChatBlocksAfter(null) on first connect.
          seeded = true;
          maybeOpenStream();
        }
      }
    })();

    // AppState: drop the connection in background, reopen on foreground.
    // iOS may keep the XHR alive briefly after backgrounding, but the OS
    // can suspend it at any time without notifying the JS layer; tearing
    // down explicitly avoids holding a half-dead socket that doesn't
    // resume cleanly on return.
    const onAppState = (state: AppStateStatus): void => {
      if (cancelled) return;
      if (state === "active") {
        maybeOpenStream();
      } else if (state === "background" || state === "inactive") {
        closeStream();
        // Beacon the gateway that we've stopped watching. closeStream()
        // closes our end of the SSE, but behind a relay the gateway-side
        // socket can stay open (keepalive writes keep succeeding into the
        // relay buffer), so the stream's cancel() — which clears watch
        // state — may never fire, leaving the device permanently
        // "watching" and suppressing completion pushes. This discrete POST
        // reaches the gateway even when the long-lived stream's close
        // doesn't, clearing the device's watch bucket so the next
        // completion push is delivered. Fire-and-forget + best-effort: a
        // dropped beacon (instant suspend / no network) self-heals on the
        // next foreground, which re-opens and re-registers the stream.
        void api("/push/unwatch", { method: "POST" }).catch(() => {});
      }
    };
    appStateSub = AppState.addEventListener("change", onAppState);

    return () => {
      cancelled = true;
      closeStream();
      if (appStateSub) appStateSub.remove();
    };
  }, [sessionId]);

  // Unmount unwatch beacon. closeStream() (in the effect above) closes our
  // SSE end, but behind a relay the gateway-side socket can linger, leaving
  // this stream's watch-state stale and suppressing the session's completion
  // pushes. This STREAM-SCOPED unwatch drops only the stream THIS hook opened
  // (matched by the streamId it sent on the handshake), so it can't wipe
  // another stream the client may hold on the same session. Keyed on the
  // [sessionId, streamId] pair (streamId is mount-stable) so it fires once on
  // real teardown. Best-effort; a reopened screen re-registers via its own
  // SSE handshake under a fresh streamId.
  useEffect(() => {
    if (!sessionId) return;
    const streamId = streamIdRef.current;
    return () => {
      void api(
        `/push/unwatch?sessionId=${encodeURIComponent(sessionId)}&streamId=${encodeURIComponent(streamId)}`,
        { method: "POST" }
      ).catch(() => {});
    };
  }, [sessionId]);

  // Gate the rendered value on the loaded-for sessionId. Between the
  // moment `sessionId` flips (chat A → chat B) and the reset effect
  // running, render-time `state` still carries chat A's blocks; the
  // gate returns `undefined` for that one paint so the screen shows
  // the empty/loading state instead of the previous chat's history.
  // The same gate applies to the session record — a stale chat-A title
  // would otherwise briefly head chat B.
  const matches = state.forSessionId === sessionId;
  const blocks: ChatBlock[] | undefined = matches ? state.blocks : undefined;
  const session: ChatSession | undefined = matches ? state.session : undefined;
  const isPending: boolean =
    Boolean(sessionId) && (!matches || state.blocks === undefined);

  return { blocks, session, isPending, error };
}

// Topic sessions for one agent (GET /chat?agentId=…, filtered to
// `kind:"topic"`). Topics are subject-scoped side-conversations with their
// own context window; the agent's final answer in a Topic forwards back into
// its owning Chat. The home's Topics section renders these as `#<title>` rows.
// Archived topics keep their history and stay addressable by deep link, but
// leave the list. Sorted most-recently-updated first.
export function useTopics(agentId: string | null) {
  return useQuery<ChatSession[], Error, ChatSession[]>({
    queryKey: ["topics", agentId],
    queryFn: () =>
      api<ChatSession[]>(`/chat?agentId=${encodeURIComponent(agentId ?? "")}`),
    enabled: Boolean(agentId),
    refetchInterval: 30_000,
    select: (sessions) => {
      // Pinned-aware gateways (the container model) mark sidebar topics
      // `pinned === true` — legacy topics are backfilled by migration — so
      // unpinned work-item containers stay out of the list. Gateways
      // predating the field never send it on any session; fall back to the
      // old kind-based predicate there so the list isn't empty.
      const pinnedAware = sessions.some((s) => typeof s.pinned === "boolean");
      return sessions
        .filter((s) =>
          pinnedAware ? s.pinned === true && !s.archivedAt : s.kind === "topic" && !s.archivedAt
        )
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
        );
    }
  });
}

// POST /api/chat always creates the chat under the runtime's currently
// active agent — there's no body field to pin it to a specific agent.
// Without re-asserting our route's agentId first, another client (web
// session, CLI) switching agents would silently misroute the new chat.
export function useCreateChat(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation<ChatSession, Error, void>({
    mutationFn: async () => {
      if (agentId) {
        await api(`/agents/${agentId}/use`, { method: "POST" });
      }
      return api<ChatSession>("/chat", {
        method: "POST",
        body: JSON.stringify({ title: "" })
      });
    },
    onSuccess: () => {
      // Invalidate this agent's list explicitly so the new chat shows
      // up immediately, plus the broader keys other clients depend on.
      qc.invalidateQueries({ queryKey: ["chats", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    }
  });
}

// DELETE /chat/:id. Powers the chat-list swipe Delete action. We
// optimistically drop the row from the cached list so the swipe
// animation doesn't snap back to "deleting…" before the server
// confirms. The agentId is captured at mutation-construction time so
// the cache update targets the right per-agent list — the runtime
// cascade-deletes blocks too, so a refetch on the chat detail of a
// just-deleted session would 404 anyway.
export function useDeleteChat(agentId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (sessionId: string) =>
      api<{ ok: true }>(`/chat/${sessionId}`, { method: "DELETE" }),
    onMutate: async (sessionId) => {
      await qc.cancelQueries({ queryKey: ["chats", agentId] });
      const previous = qc.getQueryData<ChatSession[]>(["chats", agentId]);
      if (previous) {
        qc.setQueryData<ChatSession[]>(
          ["chats", agentId],
          previous.filter((s) => s.id !== sessionId)
        );
      }
      return { previous };
    },
    onError: (_err, _sessionId, context) => {
      const ctx = context as { previous?: ChatSession[] } | undefined;
      if (ctx?.previous) qc.setQueryData(["chats", agentId], ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["chats", agentId] });
      qc.invalidateQueries({ queryKey: ["unread"] });
    }
  });
}

// DELETE /chat/:id/read. Powers the chat-list swipe Mark Unread action.
// The runtime cursor is monotonic, so this is the only way to put a
// chat back into the badge from the client. Refreshes the badge after
// the cursor drops so the app icon dot pops back up immediately.
export function useMarkChatUnread() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (sessionId: string) =>
      api<{ ok: true }>(`/chat/${sessionId}/read`, { method: "DELETE" }),
    onSuccess: () => {
      void refreshBadge();
      qc.invalidateQueries({ queryKey: ["chats"] });
      qc.invalidateQueries({ queryKey: ["unread"] });
    }
  });
}

export interface SendMessageInput {
  content: string;
  images?: UploadRef[];
  // Voice-message attachment. When set with empty content the gateway
  // transcribes the audio and uses the transcript as the message text;
  // the ref is also persisted so the thread renders a playable bubble.
  audio?: { id: string; mimeType: string; size: number; durationMs?: number };
}

// Run-now responses carry { taskId }; enqueued ones carry { queued, pendingId }.
// The server decides based on whether a turn is already in flight; the client
// treats both as success (the transcript / pill updates via the chat SSE frame).
export type SendMessageResult = { taskId?: string; queued?: boolean; pendingId?: string };

export function useSendMessage(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<SendMessageResult, Error, SendMessageInput>({
    mutationFn: ({ content, images, audio }: SendMessageInput) => {
      if (!sessionId) throw new Error("No session selected");
      const body: Record<string, unknown> = { content, client: "mobile" };
      if (images && images.length > 0) body.images = images;
      if (audio) body.audio = audio;
      return api<SendMessageResult>(`/chat/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
        // Voice sends block on transcription (first run also downloads the
        // model), so the default write timeout would cut them off.
        ...(audio ? { timeoutMs: VOICE_SEND_TIMEOUT_MS } : {})
      });
    },
    onSuccess: () => {
      // useChatBlocks is now SSE-driven, so the new user_text + assistant
      // blocks arrive without an explicit invalidation. We still bump the
      // legacy session query (used by older list affordances) and the
      // sidebar chat list so titles + previews refresh promptly.
      qc.invalidateQueries({ queryKey: ["chat", sessionId] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      // A successful send means the local STT model has finished downloading
      // (transcription ran), so re-fetch readiness — the first-run setup
      // notice should only appear once.
      qc.invalidateQueries({ queryKey: ["voice-status"] });
    }
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation<Task, Error, string>({
    mutationFn: (taskId: string) => api<Task>(`/tasks/${taskId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
      // The cancel settles any open gate to `cancelled` server-side, but the
      // setup-request cache only polls (no SSE bridge on mobile, unlike web's
      // RuntimeStreamBridge). Without this, a setup card's Confirm/Choice
      // controls keep reading `status === "pending"` and stay tappable until
      // the next poll, firing a POST to a now-dead gate (issue #395).
      qc.invalidateQueries({ queryKey: ["setup-requests"] });
    }
  });
}

// Remove a queued follow-up message. The pending list is server truth and
// streams over the chat_session SSE frame, so this just fires the DELETE —
// the frame drains the row (ADR chat-message-queue.md). Response is
// { removed: true } | 404 (already drained/removed).
export function useRemovePendingChatMessage(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ removed: boolean }, Error, string>({
    mutationFn: (pendingId: string) => {
      if (!sessionId) throw new Error("No session selected");
      return api<{ removed: boolean }>(`/chat/${sessionId}/pending/${pendingId}`, {
        method: "DELETE"
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat"] });
      qc.invalidateQueries({ queryKey: ["chats"] });
    }
  });
}

export function useSyncChatTask(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (taskId: string) => {
      if (!sessionId) throw new Error("No session selected");
      return api(`/chat/${sessionId}/tasks/${taskId}/sync`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chat", sessionId] });
    }
  });
}
