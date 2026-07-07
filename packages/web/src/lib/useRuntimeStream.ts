"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openResilientEventSource, type ResilientEventSourceHandle } from "./resilient-event-source";

// Runtime-side event kinds. Source of truth: src/types.ts RuntimeEventKind.
// The server emits each event as `event: <kind>` (named SSE events), so the
// client must register a listener per kind — `EventSource.onmessage` only fires
// for unnamed default events, which the runtime never sends.
const EVENT_KINDS = [
  "task",
  "approval",
  "job",
  "memory",
  "skill",
  "connector",
  "mcp",
  "messaging",
  "provider",
  "runtime",
  "notification",
  "run",
  "onboarding"
] as const;

export type RuntimeStreamEvent = { kind: string; data: string };
type Listener = (event: RuntimeStreamEvent) => void;

// Module-level singletons — one SSE transport per browser tab, shared by every
// `useRuntimeStream` caller and the global `RuntimeStreamBridge`. Subscribing
// from N places does not open N connections. The transport is the resilient
// wrapper, not a bare EventSource: a gateway restart turns the BFF's stream
// route into a 503, which permanently CLOSES a bare EventSource —
// the wrapper reopens it with backoff so live updates resume on their own.
let handle: ResilientEventSourceHandle | null = null;
const listeners = new Set<Listener>();

// Tab-wide connection state for the "reconnecting" UI. Starts true so the
// banner never flashes during initial page load before the first stream
// opens; the wrapper reports the first real transition either way.
let connected = true;
const connectionListeners = new Set<(connected: boolean) => void>();

function notifyConnection(next: boolean): void {
  connected = next;
  for (const listener of connectionListeners) listener(next);
}

function openSseTransport(): void {
  handle = openResilientEventSource("/api/runtime/events/stream", {
    attach: (source) => {
      const fanOut = (kind: string) => (event: MessageEvent) => {
        for (const listener of listeners) listener({ kind, data: event.data });
      };
      for (const kind of EVENT_KINDS) source.addEventListener(kind, fanOut(kind));
      // Default `message` listener kept as a fallback for servers that emit
      // unnamed events; the local runtime does not, but this avoids breakage if
      // the upstream surface changes.
      source.addEventListener("message", fanOut("message"));
    },
    onStateChange: notifyConnection
  });
}

function ensureConnection(): void {
  if (handle) return;
  openSseTransport();
}

function closeConnection(): void {
  // Defense in depth: callers gate this on `listeners.size === 0`, but a
  // resubscribe that races the unsubscribe could leave the listener set
  // non-empty when we arrive here. Closing in that case would strand those
  // subscribers — bail out and let the existing transport keep serving them.
  if (listeners.size > 0) return;
  if (handle) {
    handle.close();
    handle = null;
  }
}

function subscribe(listener: Listener): () => void {
  ensureConnection();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      closeConnection();
    }
  };
}

/**
 * Subscribes to /api/runtime/events/stream (SSE). Multiple callers share a
 * single underlying transport (module-level singleton), so mounting many
 * subscribers across the app does not open many connections.
 *
 * Stability:
 *   The effect deps are EMPTY and `onEvent` is captured via a ref so callers
 *   can pass a fresh closure each render without retriggering the effect or
 *   re-opening the connection.
 */
export function useRuntimeStream(onEvent: Listener): void {
  const callbackRef = useRef(onEvent);
  // Layout effect so the ref updates synchronously after every commit, before
  // any subsequent message can fire.
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    return subscribe((event) => callbackRef.current(event));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Tab-wide gateway-stream connection state. Passive observer: it never opens
 * the transport itself (RuntimeStreamBridge does), it only mirrors the shared
 * state — so the ConnectionBanner can render "reconnecting" without owning a
 * stream subscription.
 */
export function useRuntimeStreamConnected(): boolean {
  const [state, setState] = useState(connected);
  useEffect(() => {
    // Re-sync after mount: the state can have transitioned between the
    // initial useState snapshot and the effect running.
    setState(connected);
    const listener = (next: boolean) => setState(next);
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  }, []);
  return state;
}

/** Test-only hooks for the SSE singleton. */
export const __streamTestHooks = {
  subscribe,
  getSource(): EventSource | null {
    return handle?.current() ?? null;
  },
  listenerCount(): number {
    return listeners.size;
  },
  isConnected(): boolean {
    return connected;
  },
  // Drive the shared connection state directly — lets component tests cover
  // the reconnecting UI without standing up a fake SSE transport.
  setConnectedForTest(next: boolean): void {
    notifyConnection(next);
  },
  reset(): void {
    if (handle) {
      handle.close();
      handle = null;
    }
    listeners.clear();
    connectionListeners.clear();
    connected = true;
  }
};
