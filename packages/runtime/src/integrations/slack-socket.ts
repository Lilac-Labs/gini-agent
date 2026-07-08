// Minimal Slack Socket Mode client — the bridge's inbound transport.
//
// Unlike Discord (REST poll + Gateway as a latency optimization), the
// WebSocket IS the source of truth for Slack inbound: the
// non-Marketplace rate limits (May 2025 policy) cap
// conversations.history at ~1 request/minute with 15 items, so REST
// polling is unusable, and the Events API over HTTP needs a public
// webhook URL a laptop or Firecracker guest doesn't have. Socket Mode
// needs no inbound routing: we call `apps.connections.open` with the
// app-level xapp- token, get a one-shot wss URL back, and Slack pushes
// event envelopes over the connection.
//
// Protocol shape (https://docs.slack.dev/apis/events-api/using-socket-mode):
//   - first frame is `{"type":"hello"}`
//   - event frames carry an `envelope_id` and MUST be acked within 3
//     seconds by sending `{"envelope_id":"..."}` back. We ack
//     immediately on receipt, BEFORE handing the payload to the
//     consumer — a poison event must not block the ack (same spirit as
//     the Discord poller advancing its watermark regardless).
//   - `{"type":"disconnect"}` frames (~every 30 minutes with reason
//     refresh_requested) tell us to open a FRESH connection: the wss
//     URL is one-shot, so reconnect means a new apps.connections.open
//     call, not re-dialing the old URL.
//   - Slack pings at the WebSocket protocol level; Bun answers pongs
//     automatically, so there is no heartbeat for us to manage.
//
// No backfill: events during a disconnect window are lost (Slack does
// not replay). Documented limitation in ADR slack-bridge.md. Slack
// DOES retry envelopes it never saw an ack for, which is why the
// consumer (slack-bridge.ts) dedupes on event_id.
//
// Test seams: `webSocketImpl` substitutes a stub socket and
// `fetchImpl` a stub apps.connections.open so unit tests exercise the
// ack / disconnect / give-up shape without touching slack.com.

import { appendLog } from "../state";
import { sanitizeBridgeStatusMessage } from "./messaging-poller-helpers";
import type { Instance } from "../types";

const CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";

// Reconnect backoff. Start at 1s, cap at 30s — same envelope as the
// Discord gateway: a flapping connection can't hammer Slack, and a
// genuinely-down service still gets retried often enough to recover
// inside a minute.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// apps.connections.open errors that a retry can never fix: the app
// token is wrong, revoked, or the wrong token type entirely. The
// handle tears down instead of looping; the operator has to recreate
// the bridge with a valid xapp- token.
const NON_RECOVERABLE_OPEN_ERRORS = new Set([
  "invalid_auth",
  "not_allowed_token_type",
  "account_inactive",
  "token_revoked"
]);

// The events_api envelope payload the consumer sees. `eventId` drives
// retry dedupe; `event` is the raw inner event object (message.im
// events carry channel / user / text / ts / thread_ts / channel_type).
export interface SlackSocketEnvelope {
  eventId?: string;
  retryAttempt?: number;
  event: Record<string, unknown>;
}

type WebSocketCtor = new (url: string) => WebSocket;

export interface SlackSocketOptions {
  // App-level token (xapp-) with connections:write — Socket Mode auth
  // is separate from the bot token the Web API calls use.
  appToken: string;
  // Instance is only used for `appendLog` namespacing. Optional so
  // unit tests can omit it.
  instance?: Instance;
  // Bridge id stamped onto every log row so an operator with multiple
  // Slack bridges can disambiguate which connection logged what.
  bridgeId?: string;
  // Invoked once per events_api envelope, AFTER the ack has been
  // sent. Throws are swallowed so a bad consumer can't tear down the
  // socket.
  onEvent: (envelope: SlackSocketEnvelope) => void;
  // Override the WebSocket constructor for tests.
  webSocketImpl?: WebSocketCtor;
  // Override fetch for tests (apps.connections.open stub).
  fetchImpl?: typeof fetch;
  // Override the reconnect timer for tests — the default is the
  // RECONNECT_MIN..MAX backoff window applied across attempts.
  reconnectDelayMs?: number;
}

export interface SlackSocketHandle {
  // Resolves when the connection is fully closed — via `close()` or
  // because apps.connections.open failed non-recoverably. The
  // supervisor races this against its status-poll tick to detect a
  // give-up.
  done: Promise<void>;
  // Idempotent. Stops the reconnect loop and closes any live socket.
  close: () => void;
}

export function connectSlackSocket(options: SlackSocketOptions): SlackSocketHandle {
  const { appToken, instance, bridgeId, onEvent, webSocketImpl, fetchImpl, reconnectDelayMs } = options;
  const WS = webSocketImpl ?? globalThis.WebSocket;
  if (!WS) {
    throw new Error("WebSocket is not available in this runtime; pass webSocketImpl.");
  }
  const doFetch = fetchImpl ?? fetch;

  const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<void>();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let attempt = 0;

  // Scrub Slack xox?- tokens (and the other bridge credential shapes)
  // out of every log payload. The app token travels in the
  // apps.connections.open Authorization header, so a fetch failure
  // message could echo it; the shared sanitizer covers the xox
  // pattern and we belt-and-suspenders redact a direct token echo.
  function scrubLogData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!data) return data;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = typeof value === "string"
        ? sanitizeBridgeStatusMessage(value).split(appToken).join("<redacted>")
        : value;
    }
    return out;
  }

  function logRow(message: string, data?: Record<string, unknown>): void {
    if (!instance) return;
    appendLog(instance, message, {
      ...(bridgeId ? { bridgeId } : {}),
      ...(scrubLogData(data) ?? {})
    });
  }

  function safeClose(code = 1000, reason = "client closing"): void {
    try {
      socket?.close(code, reason);
    } catch {
      // Some WebSocket implementations throw on close-after-close; the
      // outer `closed` flag is the source of truth for the lifecycle
      // so we swallow the throw and let the close event drive the
      // rest of the state machine.
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    attempt += 1;
    const base =
      reconnectDelayMs !== undefined
        ? reconnectDelayMs
        : Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openConnection();
    }, base);
  }

  function giveUp(reason: string): void {
    logRow("messaging.slack.socket_giveup", { error: reason });
    closed = true;
    resolveDone();
  }

  // One connection attempt: apps.connections.open → dial the returned
  // one-shot wss URL. Any failure either gives up (bad token) or
  // schedules a fresh attempt (transient).
  async function openConnection(): Promise<void> {
    if (closed) return;
    let url: string;
    try {
      const response = await doFetch(CONNECTIONS_OPEN_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${appToken}` }
      });
      const parsed = (await response.json()) as { ok?: boolean; url?: string; error?: string };
      if (!parsed.ok || typeof parsed.url !== "string") {
        const error = parsed.error ?? `HTTP ${response.status}`;
        if (NON_RECOVERABLE_OPEN_ERRORS.has(error)) {
          giveUp(`apps.connections.open failed: ${error}`);
          return;
        }
        logRow("messaging.slack.socket_open_error", { error });
        scheduleReconnect();
        return;
      }
      url = parsed.url;
    } catch (error) {
      logRow("messaging.slack.socket_open_error", {
        error: error instanceof Error ? error.message : String(error)
      });
      scheduleReconnect();
      return;
    }
    // close() can land while the fetch above was in flight — don't
    // open a socket the close path will never see.
    if (closed) {
      resolveDone();
      return;
    }

    let next: WebSocket;
    try {
      next = new WS(url);
    } catch (error) {
      logRow("messaging.slack.socket_dial_error", {
        error: error instanceof Error ? error.message : String(error)
      });
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      // Reset the backoff counter once we have a live socket.
      attempt = 0;
      logRow("messaging.slack.socket_open");
    });

    next.addEventListener("message", (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
      } catch (error) {
        logRow("messaging.slack.socket_parse_error", {
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      handleFrame(frame);
    });

    next.addEventListener("close", (event) => {
      socket = null;
      const ce = event as CloseEvent;
      logRow("messaging.slack.socket_close", {
        code: ce.code,
        reason: typeof ce.reason === "string" ? ce.reason : ""
      });
      if (closed) {
        resolveDone();
        return;
      }
      // Every non-client close reconnects — Slack's disconnect frames
      // and routine socket drops are all recoverable; the only
      // non-recoverable failures surface at apps.connections.open
      // (handled above), so there is no give-up close-code set here.
      scheduleReconnect();
    });

    // `error` events on WebSocket carry no detail by spec; treat them
    // as soft and rely on the matching `close` event for the actual
    // teardown + reconnect path.
    next.addEventListener("error", () => {
      logRow("messaging.slack.socket_error");
    });
  }

  function handleFrame(frame: Record<string, unknown>): void {
    // Ack FIRST, unconditionally, for any frame that carries an
    // envelope_id — Slack redelivers unacked envelopes and eventually
    // tears the connection down, and a consumer throw must never
    // block the ack.
    const envelopeId = typeof frame.envelope_id === "string" ? frame.envelope_id : undefined;
    if (envelopeId) {
      sendRaw(JSON.stringify({ envelope_id: envelopeId }));
    }
    const type = typeof frame.type === "string" ? frame.type : "";
    if (type === "hello") {
      logRow("messaging.slack.socket_hello");
      return;
    }
    if (type === "disconnect") {
      // Slack asks for a connection refresh (~every 30 minutes). The
      // wss URL is one-shot, so we close and let the close handler
      // schedule a fresh apps.connections.open.
      logRow("messaging.slack.socket_refresh_requested", {
        reason: typeof (frame as { reason?: unknown }).reason === "string"
          ? String((frame as { reason?: unknown }).reason)
          : ""
      });
      safeClose(4000, "refresh requested");
      return;
    }
    if (type === "events_api") {
      const payload = frame.payload as { event_id?: unknown; event?: unknown } | undefined;
      const event = payload?.event;
      if (!event || typeof event !== "object") return;
      try {
        onEvent({
          event: event as Record<string, unknown>,
          ...(typeof payload?.event_id === "string" ? { eventId: payload.event_id } : {}),
          ...(typeof frame.retry_attempt === "number" ? { retryAttempt: frame.retry_attempt } : {})
        });
      } catch (error) {
        // Intentional swallow — a bad consumer can't be allowed to
        // tear down the socket; the envelope was already acked.
        logRow("messaging.slack.socket_consumer_error", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    // Other frame types (interactive, slash_commands, …) are acked
    // above and otherwise ignored — the bridge only subscribes to
    // message.im events.
  }

  function sendRaw(payload: string): void {
    if (!socket || socket.readyState !== (globalThis.WebSocket?.OPEN ?? 1)) return;
    try {
      socket.send(payload);
    } catch (error) {
      logRow("messaging.slack.socket_send_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  void openConnection();

  return {
    done: donePromise,
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        safeClose(1000, "client closing");
      } else {
        // No live socket and no pending reconnect timer — either the
        // openConnection fetch is in flight (its closed-check resolves
        // done) or nothing is running at all. Resolving here is safe
        // because resolveDone is idempotent.
        resolveDone();
      }
    }
  };
}
