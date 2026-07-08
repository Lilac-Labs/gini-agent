// Inbound Slack bridge supervisor.
//
// Mirrors the Telegram / Discord poller lifecycle: a supervisor
// reconciles per-bridge loops against state, and the runtime aborts
// every loop on SIGTERM via AbortController. The transport differs —
// there is no poll. Inbound arrives over a Socket Mode WebSocket
// (`./slack-socket.ts`), so each loop's job is to hold that socket
// open, route the events it pushes, and watch for the conditions that
// end the loop: bridge disable / status flip (observed on a short
// status-check tick, same self-exit guard as the pollers), token
// rotation (socket re-dialed with the new xapp- token), and socket
// give-up (apps.connections.open rejected the token — the loop marks
// the bridge errored and exits).
//
// Session model (ADR slack-bridge.md): one chat session per THREAD.
// A top-level DM message (no thread_ts, or thread_ts === ts) starts a
// NEW session keyed by its own ts; the reply mirror posts with
// thread_ts = that ts, so the answer lands in a thread under the
// user's message. A message typed inside an existing thread
// (thread_ts !== ts) find-or-creates the session keyed by that
// thread_ts and continues the conversation.
//
// DM-only: events with channel_type !== "im" are dropped entirely, as
// are bot-authored events (bot_id present), the bridge bot's own
// messages (user === botUserId), and anything with a subtype (edits,
// deletes, file_share — plain user messages carry no subtype).
//
// Ack UX: Slack has no bot typing API, so on inbound accept the loop
// adds an 👀 reaction to the user's message, best-effort (a failure is
// logged and never gates the reply).

import type { MessagingBridgeRecord, RuntimeConfig, TaskStatus } from "../types";
import { appendLog, isTerminalTaskStatus, readState } from "../state";
import {
  findSlackChatSession,
  isAppTokenRef,
  isBotTokenRef,
  readBridgeAppToken,
  readBridgeBotToken,
  receiveMessagingInput,
  sendMessagingOutput
} from "./messaging";
import { syncChatTaskResult } from "../execution/chat";
import {
  awaitTerminalTask,
  createDetachedTracker,
  markBridgeError,
  sleepUnlessAborted
} from "./messaging-poller-helpers";
import { createSlackClient, type SlackClient } from "./slack";
import { connectSlackSocket, type SlackSocketEnvelope, type SlackSocketHandle } from "./slack-socket";
import type { PollerSupervisor } from "./discord-poller";

// Cadence for the loop's status-check tick. There is no polling work
// on this tick — it exists so a bridge disabled (or its token rotated)
// between supervisor reconciles self-exits promptly, matching the
// pollers' top-of-loop guard.
const STATUS_CHECK_INTERVAL_MS = 5000;

// Bound on the in-memory event_id dedupe set. Slack redelivers
// envelopes it never saw an ack for, so a retried envelope must not
// double-route — but the set can't grow unbounded across a long-lived
// socket. FIFO eviction; 500 comfortably covers Slack's retry window
// for a personal DM bridge.
const SEEN_EVENT_IDS_MAX = 500;

export interface SlackBridgeDeps {
  clientFactory?: (token: string) => SlackClient;
  // Override the Socket Mode connector for tests — production dials
  // slack.com; tests capture `onEvent` to push synthetic envelopes.
  socketConnector?: (options: {
    appToken: string;
    instance: string;
    bridgeId: string;
    onEvent: (envelope: SlackSocketEnvelope) => void;
  }) => SlackSocketHandle;
  // Status-check tick override (ms). Tests dial it down to step the
  // loop without waiting on real seconds.
  statusCheckIntervalMs?: number;
}

interface RunningLoop {
  controller: AbortController;
  done: Promise<void>;
}

export function createSlackBridgeSupervisor(
  config: RuntimeConfig,
  deps: SlackBridgeDeps = {}
): PollerSupervisor {
  const loops = new Map<string, RunningLoop>();
  const clientFactory = deps.clientFactory ?? ((token: string) => createSlackClient(token));
  const socketConnector = deps.socketConnector ?? ((options) => connectSlackSocket(options));
  const statusCheckIntervalMs = deps.statusCheckIntervalMs ?? STATUS_CHECK_INTERVAL_MS;
  let stopped = false;
  // Shared detached-worker tracker. See messaging-poller-helpers.ts:
  // workers are stopAll-awaited with a bounded timeout so a hung
  // send can't deadlock shutdown.
  const detached = createDetachedTracker(config, "messaging.slack.detached_drain_timeout");

  function shouldRun(bridge: MessagingBridgeRecord): boolean {
    if (bridge.kind !== "slack") return false;
    if (bridge.status !== "configured") return false;
    // Both credentials are required: the bot token drives Web API
    // calls, the app token drives the Socket Mode connection. No
    // deliveryTargets requirement — DM channels are discovered at
    // event time, not configured up front.
    return Boolean(bridge.secretRefs?.some(isBotTokenRef)) && Boolean(bridge.secretRefs?.some(isAppTokenRef));
  }

  function startLoop(bridgeId: string): void {
    if (loops.has(bridgeId) || stopped) return;
    const controller = new AbortController();
    const done = runLoop(
      config,
      bridgeId,
      controller.signal,
      clientFactory,
      socketConnector,
      statusCheckIntervalMs,
      detached.track
    ).finally(() => {
      // Always abort the controller when the loop exits, even for
      // natural returns (bridge disabled, token rotated, status
      // flipped). Detached reply mirrors captured this signal —
      // without an abort here they keep waiting on tasks against the
      // now-orphaned bridge until the underlying task settles.
      controller.abort();
      loops.delete(bridgeId);
    });
    loops.set(bridgeId, { controller, done });
  }

  function stopLoop(bridgeId: string): void {
    const loop = loops.get(bridgeId);
    if (!loop) return;
    loop.controller.abort();
  }

  return {
    reconcile() {
      if (stopped) return;
      const bridges = readState(config.instance).messagingBridges;
      const desired = new Set<string>();
      for (const bridge of bridges) {
        if (shouldRun(bridge)) desired.add(bridge.id);
      }
      for (const id of desired) {
        if (!loops.has(id)) startLoop(id);
      }
      for (const id of loops.keys()) {
        if (!desired.has(id)) stopLoop(id);
      }
    },
    async stopAll() {
      stopped = true;
      for (const loop of loops.values()) loop.controller.abort();
      await Promise.all(Array.from(loops.values()).map((loop) => loop.done.catch(() => {})));
      // Drain detached workers with a bounded timeout so a hung send
      // can't deadlock shutdown.
      await detached.drain();
    },
    size() {
      return loops.size;
    }
  };
}

async function runLoop(
  config: RuntimeConfig,
  bridgeId: string,
  signal: AbortSignal,
  clientFactory: (token: string) => SlackClient,
  socketConnector: (options: {
    appToken: string;
    instance: string;
    bridgeId: string;
    onEvent: (envelope: SlackSocketEnvelope) => void;
  }) => SlackSocketHandle,
  statusCheckIntervalMs: number,
  trackDetached: (work: Promise<void>) => void
): Promise<void> {
  let socket: SlackSocketHandle | undefined;
  let socketAppToken: string | undefined;
  // Loop-scoped mutable refs the socket callback reads. The callback
  // closes over these (not over per-iteration locals) so a token
  // rotation mid-lifecycle swaps the client without re-registering
  // the handler.
  let client: SlackClient | undefined;
  let botUserId: string | undefined;
  // event_id dedupe — Slack retries envelopes it never saw acked.
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];

  const onEvent = (envelope: SlackSocketEnvelope) => {
    if (signal.aborted || !client) return;
    if (envelope.eventId) {
      if (seenEventIds.has(envelope.eventId)) return;
      seenEventIds.add(envelope.eventId);
      seenEventOrder.push(envelope.eventId);
      if (seenEventOrder.length > SEEN_EVENT_IDS_MAX) {
        const evicted = seenEventOrder.shift();
        if (evicted) seenEventIds.delete(evicted);
      }
    }
    const incoming = extractIncomingEvent(envelope.event, botUserId);
    if (!incoming) return;
    // Route + reply-mirror runs detached so a slow agent task can't
    // block the socket callback (which must stay cheap — the ack
    // already went out at the socket layer). The worker is tracked so
    // stopAll can await it — without that a worker mid-state-write at
    // shutdown would land its write against a torn-down runtime (or
    // in tests against a stale GINI_STATE_ROOT after the next test
    // rebinds it).
    const work = routeInboundAndMirrorReply(config, bridgeId, incoming, client, signal).catch((error) => {
      appendLog(config.instance, "messaging.slack.receive_error", {
        bridgeId,
        channelId: incoming.channelId,
        externalId: incoming.ts,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    trackDetached(work);
  };

  try {
    while (!signal.aborted) {
      const bridge = readState(config.instance).messagingBridges.find((item) => item.id === bridgeId);
      if (!bridge || bridge.kind !== "slack" || bridge.status !== "configured") return;
      // Same error contract as the Discord loop: a missing/corrupt
      // secret flips the bridge to "error" so the supervisor's
      // reconcile drops it instead of restarting the loop every tick.
      let botToken: string | undefined;
      let appToken: string | undefined;
      try {
        botToken = readBridgeBotToken(config, bridge);
        appToken = readBridgeAppToken(config, bridge);
      } catch (error) {
        await markBridgeError(
          config,
          bridgeId,
          "messaging.slack.token_error",
          "messaging.slack.mark_error_failed",
          error
        );
        return;
      }
      if (!botToken || !appToken) {
        await markBridgeError(
          config,
          bridgeId,
          "messaging.slack.token_error",
          "messaging.slack.mark_error_failed",
          new Error(!botToken ? "Slack bot token secret is missing." : "Slack app-level token secret is missing.")
        );
        return;
      }

      client = clientFactory(botToken);

      // Resolve the bot's own user id once per loop — it's how
      // self-authored events are dropped. auth.test doubles as the
      // bot-token validity check: a bad token errors the bridge here
      // instead of routing events it could never reply to.
      if (botUserId === undefined) {
        try {
          const me = await client.authTest();
          botUserId = me.userId;
        } catch (error) {
          await markBridgeError(
            config,
            bridgeId,
            "messaging.slack.auth_error",
            "messaging.slack.mark_error_failed",
            error
          );
          return;
        }
        if (signal.aborted) return;
      }

      // Start (or rotate) the Socket Mode connection. Re-use the
      // existing connection unless the app token rotated — the socket
      // reconnects on its own for routine drops (refresh_requested
      // disconnect frames, network blips).
      if (!socket || socketAppToken !== appToken) {
        if (socket) socket.close();
        socketAppToken = appToken;
        socket = socketConnector({
          appToken,
          instance: config.instance,
          bridgeId,
          onEvent
        });
      }

      // Sleep until the next status-check tick OR the socket gives
      // up. `done` only self-resolves on a non-recoverable
      // apps.connections.open failure (bad/revoked app token) — every
      // routine drop reconnects internally — so a resolved `done`
      // here means the bridge can't receive events until the operator
      // fixes the token.
      const outcome = await Promise.race([
        sleepUnlessAborted(statusCheckIntervalMs, signal).then(() => "tick" as const),
        socket.done.then(() => "socket_gave_up" as const)
      ]);
      if (signal.aborted) return;
      if (outcome === "socket_gave_up") {
        socket = undefined;
        await markBridgeError(
          config,
          bridgeId,
          "messaging.slack.socket_error",
          "messaging.slack.mark_error_failed",
          new Error("Slack Socket Mode connection gave up — the app-level token was rejected. Recreate the bridge with a valid xapp- token.")
        );
        return;
      }
    }
  } finally {
    // Always reap the socket, even on a thrown exception out of the
    // loop body. Without this an unexpected throw would leave the
    // WebSocket connected (and routing events) after the loop is gone.
    if (socket) socket.close();
  }
}

interface IncomingSlackMessage {
  channelId: string;
  ts: string;
  // Thread ROOT ts — the session key and the outbound thread anchor.
  // Equals `ts` for a top-level message (which starts its own thread).
  threadTs: string;
  text: string;
}

// Translate a raw Socket Mode message event into the payload the
// routing path consumes, or undefined for events the DM bridge drops:
// non-message types, non-DM channels, subtyped messages (edits /
// deletes / joins — plain user messages carry no subtype), bot-authored
// messages (including our own replies, which arrive with bot_id), the
// bridge bot's own user id, and empty text (attachment-only messages).
function extractIncomingEvent(
  event: Record<string, unknown>,
  botUserId: string | undefined
): IncomingSlackMessage | undefined {
  if (event.type !== "message") return undefined;
  if (event.channel_type !== "im") return undefined;
  if (typeof event.subtype === "string" && event.subtype.length > 0) return undefined;
  if (event.bot_id) return undefined;
  const user = typeof event.user === "string" ? event.user : undefined;
  if (botUserId !== undefined && user === botUserId) return undefined;
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  if (!channelId || !ts) return undefined;
  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!text) return undefined;
  // Top-level message (no thread_ts, or thread_ts === ts) → this
  // message anchors a NEW thread/session keyed by its own ts. Thread
  // reply (thread_ts !== ts) → continue the session keyed by the
  // event's thread_ts (find-or-create, so replies to pre-bridge
  // threads still work).
  const rawThreadTs = typeof event.thread_ts === "string" && event.thread_ts.length > 0
    ? event.thread_ts
    : undefined;
  const threadTs = rawThreadTs && rawThreadTs !== ts ? rawThreadTs : ts;
  return { channelId, ts, threadTs, text };
}

// Inbound routing + reply mirror for one message. Matches the Discord
// poller's maintainTypingAndMirrorReply in spirit, minus the typing
// pulse (Slack has no bot typing API — the 👀 reaction is the ack):
// receive → react → awaitTerminalTask → syncChatTaskResult →
// sendMessagingOutput.
async function routeInboundAndMirrorReply(
  config: RuntimeConfig,
  bridgeId: string,
  incoming: IncomingSlackMessage,
  client: SlackClient,
  signal: AbortSignal
): Promise<void> {
  const record = await receiveMessagingInput(config, bridgeId, {
    text: incoming.text,
    target: incoming.channelId,
    messageId: incoming.ts,
    threadTs: incoming.threadTs
  });

  // Ack the message with an 👀 reaction so the user sees the bridge
  // picked it up while the task runs. Best-effort: requires the
  // reactions:write scope, and a failure (missing scope, deleted
  // message) must never gate the reply.
  try {
    await client.addReaction(incoming.channelId, incoming.ts, "eyes", signal);
  } catch (error) {
    if (!signal.aborted) {
      appendLog(config.instance, "messaging.slack.reaction_error", {
        bridgeId,
        channelId: incoming.channelId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!record.taskId) return;

  // Gate the reply on the task actually reaching terminal state —
  // syncChatTaskResult throws "not ready for chat sync" otherwise.
  const terminalStatus: TaskStatus | undefined = await awaitTerminalTask(
    config,
    record.taskId,
    signal,
    "messaging.slack.task_wait_timeout"
  );

  if (signal.aborted) return;

  if (terminalStatus === undefined || !isTerminalTaskStatus(terminalStatus)) {
    appendLog(config.instance, "messaging.slack.reply_skip_non_terminal", {
      bridgeId,
      taskId: record.taskId,
      status: terminalStatus
    });
    return;
  }

  const session = findSlackChatSession(config, bridgeId, incoming.channelId, incoming.threadTs);
  if (!session || !session.source || session.source.kind !== "slack") return;

  let replyText: string | undefined;
  try {
    const message = await syncChatTaskResult(config, session.id, record.taskId);
    if (message && message.role === "assistant") replyText = message.content;
  } catch (error) {
    appendLog(config.instance, "messaging.slack.sync_error", {
      bridgeId,
      taskId: record.taskId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!replyText || replyText.trim().length === 0) return;

  // Re-check abort just before dispatch. The signal is also threaded
  // into sendMessagingOutput so a hung Slack POST gets cancelled on
  // shutdown — without that, stopAll (which awaits this worker) would
  // block forever on a stuck send.
  if (signal.aborted) return;
  try {
    // threadTs is the session's thread ROOT ts — the reply lands
    // inside the thread anchored on the user's top-level message.
    // Never the inbound message's own ts: for a thread reply that
    // would fork a broken second thread.
    await sendMessagingOutput(
      config,
      bridgeId,
      {
        text: replyText,
        target: session.source.target,
        threadTs: session.source.threadTs
      },
      { signal }
    );
  } catch (error) {
    appendLog(config.instance, "messaging.slack.reply_error", {
      bridgeId,
      taskId: record.taskId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Test seam: exposes the event translator + reply mirror so their
// invariants can be exercised in isolation. Production callers go
// through the supervisor path.
export const __internalsForTests = {
  extractIncomingEvent,
  routeInboundAndMirrorReply
};
