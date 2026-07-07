"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Sentinel for "no snap has happened for this mounted view yet". A plain
// boolean can't distinguish "first content" from "switched to a different
// conversation in a reused instance", so the latch stores the last-snapped
// `key` instead and compares identity.
const NOT_SNAPPED = Symbol("not-snapped");

// How close to the bottom (in px) still counts as "pinned". The end sentinel
// renders below 24px of bottom padding (py-6) inside the ScrollArea, so a user
// resting at the bottom sits ~that far from the absolute maximum; 64px clears
// that resting gap with margin while staying far under a viewport height, so
// scrolling up past even one short message un-pins the follow.
const PIN_THRESHOLD_PX = 64;

function findScroller(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

/**
 * Keeps a scroll container pinned to its newest content via an end-sentinel
 * `<div ref>` placed after the last item.
 *
 * The point of the hook is the *first* scroll: when a transcript opens (agent
 * switch, channel open, thread open) its viewport mounts at scrollTop 0, so a
 * `behavior: "smooth"` scroll there makes the user watch the list animate
 * up-from-top down to the bottom. Instead, the first snap for a given view runs
 * with `behavior: "auto"` inside a layout effect — it lands at the bottom
 * before the browser paints, so the transcript simply opens already scrolled
 * down.
 *
 * `itemCount` is the trigger: the effect re-evaluates only when it changes, so
 * pass the rendered item/block count. A later count change within the same view
 * follows the bottom — but only while the user is still pinned there. If they
 * have scrolled up to read history, a new block (a streamed reply, or a message
 * arriving on a live relay) must NOT yank them back down. "Pinned" is sampled
 * from a scroll listener so the read happens *before* the new block grows the
 * content; measuring in the layout effect would see the already-appended block
 * and misjudge a pinned user as scrolled-up.
 *
 * Content can also change size with NO count change and NO scroll event: gate
 * cards (setup / authorization requests) mount compact and expand when their
 * payload query resolves, streamed assistant text accretes under a stable
 * block id, and the autosizing composer can shrink the viewport itself. Any of
 * these would strand the last block clipped under the composer with the
 * jump-to-bottom button still hidden (its sample is stale). A ResizeObserver
 * on the scroller and its content wrapper covers this: while pinned it
 * re-snaps; while scrolled up it re-samples so the button appears over the
 * newly hidden content instead of scrolling.
 *
 * Every scroll here is instant (`behavior: "auto"`), never smooth. An animated
 * follow IS the visible scrolling this hook exists to suppress; worse, a
 * smooth scroll's in-flight position is reported by the scroll listener and
 * would corrupt the pinned sample for the next block arriving mid-animation,
 * leaving a pinned user stranded short of the bottom.
 *
 * "First for a given view" is tracked by `key`: pass a stable conversation id
 * so a reused instance (the cross-agent thread inbox opens different threads in
 * one panel) re-arms the instant snap when the id changes. The first snap
 * always lands at the bottom regardless of scroll position. Pass `enabled:
 * false` while the view is hidden or empty (e.g. a non-active chat tab) so
 * background growth doesn't consume the instant-snap latch — it re-arms on the
 * next enable so returning to the view snaps instantly too.
 */
export function useStickToBottom(
  itemCount: number,
  opts: { key?: unknown; enabled?: boolean } = {}
) {
  const { key, enabled = true } = opts;
  const endRef = useRef<HTMLDivElement | null>(null);
  const snappedKeyRef = useRef<unknown>(NOT_SNAPPED);
  // Whether the user is currently parked at the bottom. Sampled on scroll
  // (before any content growth) and assumed true until the user scrolls away.
  const pinnedRef = useRef(true);
  // Same value mirrored into render state so a "jump to bottom" affordance can
  // appear only while the user has scrolled up. The ref drives the auto-follow
  // (so sampling stays render-free); this state drives the button.
  const [atBottom, setAtBottom] = useState(true);

  // Track the pinned state from the scroll container. Re-binds when the view
  // (key/enabled) changes, since that can swap which element scrolls.
  useEffect(() => {
    const scroller = findScroller(endRef.current);
    if (!scroller) return;
    const sample = () => {
      const pinned =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PIN_THRESHOLD_PX;
      pinnedRef.current = pinned;
      setAtBottom((prev) => (prev === pinned ? prev : pinned));
    };
    sample();
    scroller.addEventListener("scroll", sample, { passive: true });
    // Follow size changes that arrive without a count change or scroll event
    // (see the note above): re-snap while pinned, re-sample otherwise. Instant,
    // like every other scroll here. Observing the scroller catches viewport
    // shrinkage (the composer autosizing taller); its content wrapper catches
    // transcript growth (a gate card expanding, streamed text accreting).
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (pinnedRef.current) {
              endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
              return;
            }
            sample();
          });
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", sample);
      observer?.disconnect();
    };
  }, [key, enabled]);

  useLayoutEffect(() => {
    if (!enabled) {
      // Re-arm: the next time this view is shown, snap instantly rather than
      // animating from the top.
      snappedKeyRef.current = NOT_SNAPPED;
      return;
    }
    const firstForKey = snappedKeyRef.current !== key;
    // The first snap for a view always lands at the bottom (even from scrollTop
    // 0 on open); later growth only follows while the user is still pinned
    // there. Always instant — see the note above on why smooth is wrong here.
    if (firstForKey || pinnedRef.current) {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      pinnedRef.current = true;
      setAtBottom(true);
    }
    snappedKeyRef.current = key;
  }, [itemCount, key, enabled]);

  // Explicit "jump to bottom" for the button. Instant, like every other scroll
  // in this hook — a smooth animation's intermediate scroll samples would flip
  // `atBottom` back to false mid-flight and flash the button. Re-pins so the
  // next block keeps following.
  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    pinnedRef.current = true;
    setAtBottom(true);
  }, []);

  return { ref: endRef, atBottom, scrollToBottom };
}
