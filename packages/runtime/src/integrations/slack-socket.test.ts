import { describe, expect, test } from "bun:test";
import { connectSlackSocket, type SlackSocketEnvelope } from "./slack-socket";

// Stub WebSocket that captures sent frames and lets the test drive
// open/message/close events — same shape as the Discord gateway test.
class StubSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 1; // OPEN — production code only sends when open
  sent: string[] = [];

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(public url: string) {
    StubSocket.lastInstance = this;
    StubSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = StubSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  static lastInstance: StubSocket | null = null;
  static instances: StubSocket[] = [];
  static reset(): void {
    StubSocket.lastInstance = null;
    StubSocket.instances = [];
  }
}

const StubCtor = StubSocket as unknown as new (url: string) => WebSocket;

// apps.connections.open stub. Each call consumes the next scripted
// response; a call past the script tail repeats the last entry so a
// reconnect loop in a test doesn't run dry.
function stubConnectionsOpen(responses: Array<{ ok: boolean; url?: string; error?: string }>) {
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const body = responses.length > 1 ? responses.shift()! : responses[0]!;
    calls.push({
      url: String(input),
      authorization: ((init?.headers ?? {}) as Record<string, string>).authorization
    });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function lastInstance(): StubSocket {
  const inst = StubSocket.lastInstance;
  if (!inst) throw new Error("no socket created");
  return inst;
}

describe("slack-socket", () => {
  test("opens via apps.connections.open with the xapp bearer token and dials the returned url", async () => {
    StubSocket.reset();
    const { fetchImpl, calls } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl
    });
    await waitFor(() => StubSocket.instances.length === 1, "socket to dial");
    expect(calls[0]?.url).toBe("https://slack.com/api/apps.connections.open");
    expect(calls[0]?.authorization).toBe("Bearer xapp-1-abc");
    expect(lastInstance().url).toBe("wss://wss.slack.test/link/1");
    handle.close();
    await handle.done;
  });

  test("acks an events_api envelope immediately and delivers the payload to onEvent", async () => {
    StubSocket.reset();
    const { fetchImpl } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const events: SlackSocketEnvelope[] = [];
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: (envelope) => events.push(envelope),
      webSocketImpl: StubCtor,
      fetchImpl
    });
    await waitFor(() => StubSocket.instances.length === 1, "socket to dial");
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: JSON.stringify({ type: "hello" }) });
    sock.dispatch("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        retry_attempt: 0,
        payload: {
          event_id: "Ev1",
          event: { type: "message", channel: "D1", user: "U1", text: "hi", ts: "1.100", channel_type: "im" }
        }
      })
    });
    // Ack goes out synchronously on receipt — before (and regardless
    // of) consumer processing.
    expect(sock.sent).toContain(JSON.stringify({ envelope_id: "env-1" }));
    expect(events.length).toBe(1);
    expect(events[0]?.eventId).toBe("Ev1");
    expect(events[0]?.event.text).toBe("hi");
    handle.close();
    await handle.done;
  });

  test("a consumer throw does not prevent the ack or take the socket down", async () => {
    StubSocket.reset();
    const { fetchImpl } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {
        throw new Error("simulated bad consumer");
      },
      webSocketImpl: StubCtor,
      fetchImpl
    });
    await waitFor(() => StubSocket.instances.length === 1, "socket to dial");
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", {
      data: JSON.stringify({
        envelope_id: "env-1",
        type: "events_api",
        payload: { event_id: "Ev1", event: { type: "message" } }
      })
    });
    expect(sock.sent).toContain(JSON.stringify({ envelope_id: "env-1" }));
    expect(sock.readyState).toBe(StubSocket.OPEN);
    handle.close();
    await handle.done;
  });

  test("a disconnect frame closes the socket and reconnects via a fresh apps.connections.open", async () => {
    StubSocket.reset();
    const { fetchImpl, calls } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl,
      reconnectDelayMs: 5
    });
    await waitFor(() => StubSocket.instances.length === 1, "first socket to dial");
    const first = lastInstance();
    first.dispatch("open", {});
    // Slack asks for a refresh (~every 30 min). The wss URL is
    // one-shot, so the client must call apps.connections.open again
    // rather than re-dialing.
    first.dispatch("message", { data: JSON.stringify({ type: "disconnect", reason: "refresh_requested" }) });
    await waitFor(() => StubSocket.instances.length === 2, "second socket after refresh");
    expect(calls.length).toBe(2);
    handle.close();
    await handle.done;
  });

  test("apps.connections.open invalid_auth gives up instead of looping (done resolves, no socket)", async () => {
    StubSocket.reset();
    const { fetchImpl, calls } = stubConnectionsOpen([{ ok: false, error: "invalid_auth" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-bad",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl,
      reconnectDelayMs: 5
    });
    await handle.done;
    // No socket ever dialed and no retry attempted.
    expect(StubSocket.instances.length).toBe(0);
    expect(calls.length).toBe(1);
  });

  test("a transient apps.connections.open failure retries after the backoff", async () => {
    StubSocket.reset();
    const { fetchImpl, calls } = stubConnectionsOpen([
      { ok: false, error: "internal_error" },
      { ok: true, url: "wss://wss.slack.test/link/2" }
    ]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl,
      reconnectDelayMs: 5
    });
    await waitFor(() => StubSocket.instances.length === 1, "socket to dial after retry");
    expect(calls.length).toBe(2);
    handle.close();
    await handle.done;
  });

  test("an unexpected socket drop reconnects; close() during the retry window stops the loop", async () => {
    StubSocket.reset();
    const { fetchImpl } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl,
      reconnectDelayMs: 5
    });
    await waitFor(() => StubSocket.instances.length === 1, "first socket to dial");
    const first = lastInstance();
    first.dispatch("open", {});
    first.close(1006, "network blip");
    await waitFor(() => StubSocket.instances.length === 2, "second socket after drop");
    handle.close();
    await handle.done;
    expect(StubSocket.instances[1]?.readyState).toBe(StubSocket.CLOSED);
  });

  test("close() is idempotent and resolves done when no socket is live", async () => {
    StubSocket.reset();
    // The connections.open fetch never resolves before close() lands —
    // simulate by scripting a response but closing synchronously.
    const { fetchImpl } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl
    });
    handle.close();
    handle.close();
    await handle.done;
    // The in-flight open observes `closed` and never dials.
    await Bun.sleep(10);
    expect(StubSocket.instances.length).toBe(0);
  });

  test("malformed JSON frame is dropped silently without disturbing the connection", async () => {
    StubSocket.reset();
    const { fetchImpl } = stubConnectionsOpen([{ ok: true, url: "wss://wss.slack.test/link/1" }]);
    const handle = connectSlackSocket({
      appToken: "xapp-1-abc",
      onEvent: () => {},
      webSocketImpl: StubCtor,
      fetchImpl
    });
    await waitFor(() => StubSocket.instances.length === 1, "socket to dial");
    const sock = lastInstance();
    sock.dispatch("open", {});
    sock.dispatch("message", { data: "not json" });
    expect(sock.readyState).toBe(StubSocket.OPEN);
    handle.close();
    await handle.done;
  });
});
