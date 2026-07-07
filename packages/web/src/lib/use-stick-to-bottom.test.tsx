/// <reference lib="dom" />

// useStickToBottom: every scroll is instant ("auto") — the first snap so a
// transcript opens already at the bottom, and later growth so a pinned user
// keeps following with no visible animation. Growth scrolls ONLY while the user
// is still pinned to the bottom — a new block must not yank a reader who
// scrolled up. Size changes with no count change (a gate card expanding when
// its payload resolves, the composer autosizing) follow via a ResizeObserver
// under the same pinned guard. A key change (panel reused for a different
// conversation) and an enabled false→true cycle (tab hidden then shown again)
// both re-arm the snap. scrollIntoView isn't implemented in happy-dom, so it's
// spied; the scroll container's metrics are stubbed to drive the guard;
// ResizeObserver doesn't exist in happy-dom, so a manually-triggered fake
// stands in.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { useStickToBottom } from "./use-stick-to-bottom";

let behaviors: (ScrollBehavior | undefined)[] = [];
const original = Element.prototype.scrollIntoView;

// happy-dom has no ResizeObserver; the hook's growth-follow path is driven by
// triggering this fake's callback by hand.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger() {
    act(() => {
      this.callback([], this as unknown as ResizeObserver);
    });
  }
}

function triggerResize() {
  FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1]!.trigger();
}

beforeEach(() => {
  behaviors = [];
  Element.prototype.scrollIntoView = mock((arg?: boolean | ScrollIntoViewOptions) => {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
  });
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  Element.prototype.scrollIntoView = original;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

function Harness({ count, k, enabled }: { count: number; k?: unknown; enabled?: boolean }) {
  const { ref } = useStickToBottom(count, { key: k, enabled });
  return <div ref={ref} data-testid="end" />;
}

// Harness whose sentinel lives inside a real scroll-area viewport, so the hook
// finds a scroller and the near-bottom guard engages.
function ScrollerHarness({ count, k }: { count: number; k?: unknown }) {
  const { ref } = useStickToBottom(count, { key: k });
  return (
    <div data-slot="scroll-area-viewport">
      <div ref={ref} data-testid="end" />
    </div>
  );
}

// Surfaces the button-driving outputs: `atBottom` (drives visibility) and
// `scrollToBottom` (the click handler).
function ButtonHarness({ count, k }: { count: number; k?: unknown }) {
  const { ref, atBottom, scrollToBottom } = useStickToBottom(count, { key: k });
  return (
    <div data-slot="scroll-area-viewport">
      <div ref={ref} data-testid="end" />
      <span data-testid="at-bottom">{String(atBottom)}</span>
      <button type="button" data-testid="jump" onClick={scrollToBottom} />
    </div>
  );
}

// Stub the layout metrics the guard reads, without firing any event — the
// stale-sample scenarios (content resized, nothing scrolled) start here.
// gap = scrollHeight - scrollTop - clientHeight.
function setMetrics(vp: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(vp, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(vp, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(vp, "scrollTop", { configurable: true, writable: true, value: scrollTop });
}

// Stub the metrics, then fire a scroll so the hook samples the new pinned state.
function setScroll(vp: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  setMetrics(vp, scrollHeight, clientHeight, scrollTop);
  // Wrap in act so the sample's setState (which drives `atBottom`) flushes
  // before the test reads it.
  act(() => {
    vp.dispatchEvent(new Event("scroll"));
  });
}

describe("useStickToBottom", () => {
  test("first snap and later growth are both instant", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    rerender(<Harness count={3} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto", "auto"]);
  });

  test("changing the key re-arms the snap", () => {
    const { rerender } = render(<Harness count={1} k="s1" />);
    rerender(<Harness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    // Same instance, different conversation → snap again (and the guard is
    // bypassed for the first snap of the new key).
    rerender(<Harness count={5} k="s2" />);
    expect(behaviors).toEqual(["auto", "auto", "auto"]);
  });

  test("disabling skips the scroll and re-arms on re-enable", () => {
    const { rerender } = render(<Harness count={1} k="s1" enabled />);
    expect(behaviors).toEqual(["auto"]);

    // Hidden view: background growth must not scroll or consume the latch.
    rerender(<Harness count={2} k="s1" enabled={false} />);
    expect(behaviors).toEqual(["auto"]);

    // Returning to the view snaps instantly.
    rerender(<Harness count={2} k="s1" enabled />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("defaults to enabled with an undefined key", () => {
    const { rerender } = render(<Harness count={1} />);
    expect(behaviors).toEqual(["auto"]);
    rerender(<Harness count={2} />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("growth follows while the user is pinned to the bottom", () => {
    const { container, rerender } = render(<ScrollerHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 580 - 400 = 20 <= 64 → pinned.
    setScroll(vp, 1000, 400, 580);

    rerender(<ScrollerHarness count={2} k="s1" />);
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("growth does NOT scroll when the user has scrolled up", () => {
    const { container, rerender, unmount } = render(<ScrollerHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 100 - 400 = 500 > 64 → scrolled up, not pinned.
    setScroll(vp, 1000, 400, 100);

    rerender(<ScrollerHarness count={2} k="s1" />);
    // No yank: the follow is suppressed.
    expect(behaviors).toEqual(["auto"]);

    // A fresh view (key change) still snaps instantly even while scrolled up.
    rerender(<ScrollerHarness count={9} k="s2" />);
    expect(behaviors).toEqual(["auto", "auto"]);

    // Unmount detaches the scroll listener.
    unmount();
  });

  test("content resize without a new block re-snaps while pinned", () => {
    const { container } = render(<ScrollerHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // A gate card expands after its payload query resolves: the content grows
    // with no count change and no scroll event, so the mount-time pinned
    // sample is all the hook has. The observer must re-snap.
    setMetrics(vp, 621, 517, 0);
    triggerResize();
    expect(behaviors).toEqual(["auto", "auto"]);
  });

  test("content resize does NOT scroll when the user has scrolled up", () => {
    const { container, getByTestId } = render(<ButtonHarness count={1} k="s1" />);
    expect(behaviors).toEqual(["auto"]);

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 100 - 400 = 500 > 64 → scrolled up, not pinned.
    setScroll(vp, 1000, 400, 100);
    expect(getByTestId("at-bottom").textContent).toBe("false");

    // Growth below: no yank, just a re-sample (button stays visible).
    setMetrics(vp, 1200, 400, 100);
    triggerResize();
    expect(behaviors).toEqual(["auto"]);
    expect(getByTestId("at-bottom").textContent).toBe("false");

    // Shrinkage that leaves the user near the bottom (a transient phase block
    // filtered out) re-pins through the same sample, hiding the button.
    setMetrics(vp, 520, 400, 100);
    triggerResize();
    expect(getByTestId("at-bottom").textContent).toBe("true");
  });

  test("atBottom tracks scroll position; scrollToBottom snaps and re-pins", () => {
    const { container, getByTestId } = render(<ButtonHarness count={1} k="s1" />);
    // Mounts pinned to the bottom.
    expect(getByTestId("at-bottom").textContent).toBe("true");

    const vp = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // gap = 1000 - 100 - 400 = 500 > 64 → scrolled up, button should show.
    setScroll(vp, 1000, 400, 100);
    expect(getByTestId("at-bottom").textContent).toBe("false");

    // Clicking jumps to the bottom instantly and re-pins (button hides).
    act(() => {
      getByTestId("jump").click();
    });
    expect(behaviors[behaviors.length - 1]).toBe("auto");
    expect(getByTestId("at-bottom").textContent).toBe("true");
  });
});
