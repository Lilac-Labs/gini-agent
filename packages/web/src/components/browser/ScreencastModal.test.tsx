/// <reference lib="dom" />

// ScreencastModal transport + placeholder regression.
//
// The hazard pinned here: the sign-in screencast used a BARE EventSource, and
// the BFF answers a request that lands while the gateway is restarting (routine
// on this instance — auto-update / watchdog / hotswap) with a retryable 503.
// Per the SSE spec a non-2xx response PERMANENTLY closes a bare EventSource, so
// the modal stranded on "Reconnecting…" with a src-less <img> painting the
// browser's broken-image glyph. These tests pin that the modal (1) opens the
// frames stream through the RESILIENT wrapper (which reopens on backoff), and
// (2) shows a connecting placeholder — never a broken image — until the first
// frame lands, then paints the frame and drops the placeholder.

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ResilientEventSourceHandle, ResilientEventSourceOptions } from "@/lib/resilient-event-source";

// Capture what the modal passes to openResilientEventSource and drive a fake
// transport through it — proves the modal uses the resilient wrapper without
// standing up a real SSE connection.
let capturedUrl = "";
let capturedOptions: ResilientEventSourceOptions | null = null;
const closeSpy = mock(() => {});
const openResilientEventSource = mock(
  (url: string, options: ResilientEventSourceOptions): ResilientEventSourceHandle => {
    capturedUrl = url;
    capturedOptions = options;
    return { close: closeSpy, current: () => null };
  }
);
mock.module("@/lib/resilient-event-source", () => ({ openResilientEventSource }));

const { ScreencastModal } = await import("./ScreencastModal");

// Minimal EventSource-shape stub for the wrapper's attach(source) callback.
class FakeSource {
  handlers = new Map<string, (event: { data: string }) => void>();
  addEventListener(kind: string, handler: (event: { data: string }) => void): void {
    this.handlers.set(kind, handler);
  }
  emit(kind: string, data: string): void {
    this.handlers.get(kind)?.({ data });
  }
}

function renderModal() {
  return render(
    <ScreencastModal
      setupRequestId="sr1"
      onComplete={() => {}}
      onCancel={() => {}}
      completing={false}
      cancelling={false}
    />
  );
}

// Register listeners the way the real wrapper does (attach on each open).
function openTransport(): FakeSource {
  const source = new FakeSource();
  act(() => capturedOptions!.attach(source as unknown as EventSource));
  return source;
}

const img = () => screen.getByAltText("Agent browser screencast") as HTMLImageElement;

afterEach(() => {
  cleanup();
  capturedUrl = "";
  capturedOptions = null;
  closeSpy.mockClear();
  openResilientEventSource.mockClear();
});

test("opens the frames stream through the resilient wrapper (a gateway-restart 503 then reconnects)", () => {
  renderModal();
  expect(openResilientEventSource).toHaveBeenCalledTimes(1);
  expect(capturedUrl).toBe("/api/runtime/browser/screencast/sr1/frames");
});

test("shows a connecting placeholder, not a broken image, before the first frame", () => {
  renderModal();
  expect(screen.getByText(/connecting to the agent's browser/i)).toBeDefined();
  // The <img> is mounted (imgRef must exist for the frame handler) but has no
  // src and stays hidden, so the browser never paints its broken-image glyph.
  expect(img().getAttribute("src")).toBeNull();
  expect(img().className).toContain("invisible");
});

test("paints the frame and drops the placeholder once a frame arrives", () => {
  renderModal();
  const source = openTransport();
  act(() =>
    source.emit("frame", JSON.stringify({ data: "AQID", meta: { deviceWidth: 1000, deviceHeight: 700 } }))
  );
  expect(img().getAttribute("src")).toBe("data:image/jpeg;base64,AQID");
  expect(img().className).not.toContain("invisible");
  expect(screen.queryByText(/connecting to the agent's browser/i)).toBeNull();
});

test("surfaces a reconnecting state when the transport drops before any frame", () => {
  renderModal();
  act(() => capturedOptions!.onStateChange?.(false));
  expect(screen.getByText(/reconnecting to the agent's browser/i)).toBeDefined();
});

test("closes the transport on unmount", () => {
  const { unmount } = renderModal();
  unmount();
  expect(closeSpy).toHaveBeenCalledTimes(1);
});
