/// <reference lib="dom" />

// useTunnel owns the network wiring for the tunnel UI: a GET on mount, POST
// actions that return the full updated state, and a poll loop while a connect is
// in flight. The global fetch is mocked so every branch (ok/!ok/reject, the
// `provider ? {provider} : undefined` connect body, and the connecting -> poll ->
// connected interval-cleanup path) is exercised without the real network.

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { TunnelState } from "./types";
import { useTunnel } from "./useTunnel";

const BASE = "/api/runtime/tunnel";
const POLL_TICK = 1500;

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return { providers: [], selectedProvider: null, status: "idle", ...over };
}

type ResShape = { ok?: boolean; status?: number; body: unknown };
const res = ({ ok = true, status = 200, body }: ResShape): Response =>
  ({ ok, status, json: async () => body }) as Response;

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  fetchMock = mock(async () => res({ body: makeState() }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

describe("useTunnel", () => {
  test("get() on mount applies state, clears loading, and leaves error null", async () => {
    const mounted = makeState({ status: "connected", url: "https://g31.example" });
    fetchMock.mockResolvedValue(res({ body: mounted }));

    const { result } = renderHook(() => useTunnel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state).toEqual(mounted);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(BASE, { headers: { accept: "application/json" } });
  });

  test("readState !ok with an error body surfaces that message", async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 500, body: { error: "boom" } }));

    const { result } = renderHook(() => useTunnel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  test("readState !ok without an error body falls back to `HTTP <status>`", async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 503, body: {} }));

    const { result } = renderHook(() => useTunnel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("HTTP 503");
  });

  test("get() catch: a rejected fetch sets the error to the thrown message", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useTunnel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("network down");
  });

  test("get() catch: a non-Error rejection is stringified", async () => {
    fetchMock.mockRejectedValue("nope");

    const { result } = renderHook(() => useTunnel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("nope");
  });

  test("connect(provider) POSTs /connect with a provider body", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const connecting = makeState({ status: "connecting", selectedProvider: "tailscale" });
    fetchMock.mockResolvedValueOnce(res({ body: connecting }));

    await act(async () => {
      result.current.connect("tailscale");
    });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ provider: "tailscale" })
    });
  });

  test("connect() with no arg POSTs /connect with an undefined body", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(res({ body: makeState({ status: "connecting" }) }));

    await act(async () => {
      result.current.connect();
    });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: undefined
    });
  });

  test("cancel() POSTs /cancel with no body", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(res({ body: makeState({ status: "idle" }) }));

    await act(async () => {
      result.current.cancel();
    });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: undefined
    });
  });

  test("disconnect() POSTs /disconnect with no body", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(res({ body: makeState({ status: "idle" }) }));

    await act(async () => {
      result.current.disconnect();
    });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: undefined
    });
  });

  test("post() catch: a rejected POST sets the error", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockRejectedValueOnce(new Error("post failed"));

    await act(async () => {
      result.current.disconnect();
    });

    expect(result.current.error).toBe("post failed");
  });

  test("post() catch: a non-Error rejection is stringified", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockRejectedValueOnce("post-nope");

    await act(async () => {
      result.current.cancel();
    });

    expect(result.current.error).toBe("post-nope");
  });

  test("connect() resolves ok:true on success and carries the gateway's failure code on a 400", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(res({ body: makeState({ status: "connecting" }) }));
    let outcome: Awaited<ReturnType<typeof result.current.connect>> | undefined;
    await act(async () => {
      outcome = await result.current.connect("gini-relay");
    });
    expect(outcome).toEqual({ ok: true });

    // The gateway rejects an unavailable provider with a machine-readable
    // code; the result surfaces it so the menu can open the provider's guide.
    fetchMock.mockResolvedValueOnce(
      res({
        ok: false,
        status: 400,
        body: { error: "Tunnel provider Tailscale is not available (requires Tailscale network).", code: "provider_unavailable" }
      })
    );
    await act(async () => {
      outcome = await result.current.connect("tailscale");
    });
    expect(outcome).toEqual({
      ok: false,
      message: "Tunnel provider Tailscale is not available (requires Tailscale network).",
      code: "provider_unavailable"
    });
    expect(result.current.error).toContain("not available");
  });

  test("refresh() triggers a detect=1 get (the panel-open path re-probes drivers); mount stays plain", async () => {
    const { result } = renderHook(() => useTunnel());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(BASE, { headers: { accept: "application/json" } });

    await act(async () => {
      result.current.refresh();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(`${BASE}?detect=1`, { headers: { accept: "application/json" } });
  });

  test("polling: a connecting state arms the interval, and connected clears it", async () => {
    jest.useFakeTimers();

    // Mount resolves to connecting -> the poll effect arms a 1500ms interval.
    fetchMock.mockResolvedValue(res({ body: makeState({ status: "connecting" }) }));

    const { result } = renderHook(() => useTunnel());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("connecting");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advancing the timer fires the interval, which calls get() again.
    await act(async () => {
      jest.advanceTimersByTime(POLL_TICK);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The next poll resolves connected; the effect cleanup clears the interval.
    fetchMock.mockResolvedValue(res({ body: makeState({ status: "connected", url: "u" }) }));
    await act(async () => {
      jest.advanceTimersByTime(POLL_TICK);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.status).toBe("connected"));

    const callsAfterConnected = fetchMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(POLL_TICK * 3);
      await Promise.resolve();
    });
    // No further interval fires once connected — the cleanup ran.
    expect(fetchMock.mock.calls.length).toBe(callsAfterConnected);
  });

  test("a stale GET response does not clobber a newer one", async () => {
    const slow = Promise.withResolvers<Response>();
    const fast = Promise.withResolvers<Response>();
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? slow.promise : fast.promise;
    });

    const { result } = renderHook(() => useTunnel());
    // Mount fired GET #1 (slow, seq 1); fire GET #2 (fast, seq 2) via refresh.
    await act(async () => {
      result.current.refresh();
    });

    // Resolve the NEWER GET (#2) first — it commits "connected".
    await act(async () => {
      fast.resolve(res({ body: makeState({ status: "connected", url: "u" }) }));
    });
    await waitFor(() => expect(result.current.state.status).toBe("connected"));

    // Resolve the STALE GET (#1): its seq is superseded, so it must be ignored.
    await act(async () => {
      slow.resolve(res({ body: makeState({ status: "connecting" }) }));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(result.current.state.status).toBe("connected");
  });

  test("a stale GET in flight does not clobber a POST result", async () => {
    const slowGet = Promise.withResolvers<Response>();
    let call = 0;
    fetchMock.mockImplementation(() => {
      call += 1;
      // #1 is the mount GET (slow); #2 is the POST (resolves immediately).
      return call === 1
        ? slowGet.promise
        : Promise.resolve(res({ body: makeState({ status: "idle", selectedProvider: "gini-relay" }) }));
    });

    const { result } = renderHook(() => useTunnel());
    // A POST (disconnect) commits while the mount GET is still in flight.
    await act(async () => {
      result.current.disconnect();
    });
    await waitFor(() => expect(result.current.state.selectedProvider).toBe("gini-relay"));
    expect(result.current.state.status).toBe("idle");

    // The slow mount GET now resolves with a stale body — the POST bumped the
    // sequence, so this read must be ignored.
    await act(async () => {
      slowGet.resolve(res({ body: makeState({ status: "connecting" }) }));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(result.current.state.status).toBe("idle");
  });
});
