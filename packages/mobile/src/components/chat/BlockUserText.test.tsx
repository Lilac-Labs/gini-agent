import { beforeEach, describe, expect, mock, test } from "bun:test";
// Importing the shared setup installs the (process-global) module mocks before
// the component under test is imported. bun's mock.module is process-global, so
// this file MUST reuse the same react-native/react/theme superset as the other
// chat component tests (BlockAssistantText.test, linkContextMenu.test) — a
// divergent narrow mock here clobbers theirs and breaks them when the suite
// runs in one process (bun's --parallel does not isolate files into processes).
import { hostStateRef, Image, Pressable, Text, View } from "./chatMockSetup";

// Modules BlockUserText needs that the shared setup doesn't cover. None of the
// sibling chat components import these, so registering them here can't collide.
const player = {
  play: mock(() => {
    calls.push("play");
  }),
  pause: mock(() => {
    calls.push("pause");
  }),
  // seekTo is async (returns a Promise) exactly like the native module, so a
  // test can assert play() is chained AFTER the seek settles, not fired in the
  // same tick — the ordering that, when violated, starts the AVQueuePlayer at
  // the clip end and is silently stopped (StopAtEnd).
  seekTo: mock((_seconds: number) => {
    calls.push("seekTo");
    return new Promise<void>((resolve) => {
      seekResolves.push(() => {
        calls.push("seekResolved");
        resolve();
      });
    });
  })
};
const calls: string[] = [];
let seekResolves: Array<() => void> = [];
let playerStatus: {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
};

mock.module("expo-audio", () => ({
  useAudioPlayer: () => player,
  useAudioPlayerStatus: () => playerStatus
}));

const openPreview = mock((_: { uri: string; headers: Record<string, string> }) => {});
mock.module("@/src/api", () => ({
  uploadUrl: (id: string) => `http://gw.local/api/uploads/${id}`,
  authHeader: () => ({ Authorization: "Bearer t" })
}));
mock.module("@/src/components/ImagePreview", () => ({
  useImagePreview: () => ({ open: openPreview })
}));

// react-native-gesture-handler needs native modules at import, so stub it. The
// Pan and Tap builders record the last-registered callbacks of each kind so a
// test can drive the scrub gesture directly; Race just returns its first arg so
// the detector is non-null. No sibling mobile test imports RNGH, so this
// process-global mock can't collide. GestureDetector renders its child so the
// track/thumb stay reachable in the tree.
let panHandlers: {
  onBegin?: (e: { x: number }) => void;
  onUpdate?: (e: { x: number }) => void;
  onEnd?: (e: { x: number }) => void;
  onFinalize?: (e: unknown, success: boolean) => void;
} = {};
let tapHandlers: { onEnd?: (e: { x: number }) => void } = {};
function makePan() {
  const builder = {
    minDistance: () => builder,
    runOnJS: () => builder,
    onBegin(cb: (e: { x: number }) => void) {
      panHandlers.onBegin = cb;
      return builder;
    },
    onUpdate(cb: (e: { x: number }) => void) {
      panHandlers.onUpdate = cb;
      return builder;
    },
    onEnd(cb: (e: { x: number }) => void) {
      panHandlers.onEnd = cb;
      return builder;
    },
    onFinalize(cb: (e: unknown, success: boolean) => void) {
      panHandlers.onFinalize = cb;
      return builder;
    }
  };
  return builder;
}
function makeTap() {
  const builder = {
    runOnJS: () => builder,
    onEnd(cb: (e: { x: number }) => void) {
      tapHandlers.onEnd = cb;
      return builder;
    }
  };
  return builder;
}
function GestureDetector({ children }: { children: unknown }) {
  return children;
}
mock.module("react-native-gesture-handler", () => ({
  Gesture: { Pan: makePan, Tap: makeTap, Race: (first: unknown) => first },
  GestureDetector
}));

const { VoiceBubble, BlockUserText, seekFractionFromTouch, steppedSeekFraction } = await import(
  "@/src/components/chat/BlockUserText"
);

type El =
  | { type: unknown; props: { children?: unknown; [k: string]: unknown } }
  | null
  | undefined
  | string
  | number
  | boolean;

function flatten(node: El, out: Array<Exclude<El, null | undefined | string | number | boolean>> = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  const kids = (node as { props?: { children?: unknown } }).props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const k of list) flatten(k as El, out);
  return out;
}

// Render the voice bubble and return the play/pause Pressable's onPress (the toggle).
function getToggle() {
  const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
    audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
  });
  const pressable = flatten(tree).find(
    (n) => n.type === Pressable && typeof n.props.onPress === "function"
  );
  if (!pressable) throw new Error("play/pause Pressable not found");
  return pressable.props.onPress as () => void;
}

// Render the bubble, prime the track width via its onLayout, and return the
// captured Pan handlers so a test can drive a tap/drag. chatMockSetup stubs
// useState to return hostStateRef.current, so set that BEFORE calling to
// simulate the scrub-in-progress state in render assertions.
function renderVoice(durationMs = 4000, trackWidth = 100) {
  const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
    audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs }
  });
  const track = flatten(tree).find((n) => n.type === View && typeof n.props.onLayout === "function");
  (track!.props.onLayout as (e: { nativeEvent: { layout: { width: number } } }) => void)({
    nativeEvent: { layout: { width: trackWidth } }
  });
  return { tree, handlers: panHandlers, tap: tapHandlers };
}

function renderBlock(block: Record<string, unknown>) {
  return (BlockUserText as unknown as (p: { block: unknown }) => El)({ block });
}

function textLabels(tree: El): unknown[] {
  return flatten(tree)
    .filter((n) => n.type === Text)
    .map((n) => n.props.children);
}

beforeEach(() => {
  calls.length = 0;
  seekResolves = [];
  player.play.mockClear();
  player.pause.mockClear();
  player.seekTo.mockClear();
  openPreview.mockClear();
  panHandlers = {};
  tapHandlers = {};
  hostStateRef.current = null;
  playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
});

describe("VoiceBubble playback toggle", () => {
  test("a fresh (unloaded) clip plays without a needless seek", () => {
    // duration still 0 (not decoded yet): a pre-load tap must NOT be treated as
    // 'at the end' — it should just play from the start.
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    getToggle()();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(calls).toEqual(["play"]);
  });

  test("a loaded, mid-clip paused position resumes without seeking", () => {
    playerStatus = { playing: false, currentTime: 2, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["play"]);
  });

  test("tapping while playing pauses (and never starts a second stream)", () => {
    playerStatus = { playing: true, currentTime: 3, duration: 9, didJustFinish: false };
    getToggle()();
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  test("replaying a finished clip rewinds to 0 BEFORE playing (seek then play)", async () => {
    // didJustFinish marks the clip as ended. The fix: await the seek, then play
    // — so the AVQueuePlayer restarts at 0 instead of at the end (which the
    // native player silently stops as StopAtEnd).
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: true };
    getToggle()();
    // play() must NOT have fired yet — it's chained behind the pending seek.
    expect(calls).toEqual(["seekTo"]);
    expect(player.play).not.toHaveBeenCalled();
    // Settle the seek; play runs only after the rewind resolves.
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
    expect(player.seekTo).toHaveBeenCalledWith(0);
  });

  test("a clip parked at the end (currentTime >= duration) also rewinds before play", async () => {
    playerStatus = { playing: false, currentTime: 9, duration: 9, didJustFinish: false };
    getToggle()();
    expect(calls).toEqual(["seekTo"]);
    seekResolves[0]();
    await Promise.resolve();
    expect(calls).toEqual(["seekTo", "seekResolved", "play"]);
  });
});

describe("VoiceBubble rendering", () => {
  test("shows the decoded duration once known, overriding the client estimate", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 9, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 1000 }
    });
    // The duration label renders 0:09 (decoded) rather than 0:01 (the estimate).
    expect(textLabels(tree)).toContain("0:09");
  });

  test("falls back to the client duration before the clip decodes", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 4000 }
    });
    expect(textLabels(tree)).toContain("0:04");
  });
});

describe("seekFractionFromTouch", () => {
  test("maps a touch x to a clamped 0..1 fraction of the track width", () => {
    expect(seekFractionFromTouch(0, 100)).toBe(0);
    expect(seekFractionFromTouch(50, 100)).toBe(0.5);
    expect(seekFractionFromTouch(100, 100)).toBe(1);
  });

  test("clamps out-of-range touches and guards a zero/unmeasured width", () => {
    expect(seekFractionFromTouch(-20, 100)).toBe(0);
    expect(seekFractionFromTouch(180, 100)).toBe(1);
    expect(seekFractionFromTouch(40, 0)).toBe(0);
  });
});

describe("VoiceBubble scrub-to-seek", () => {
  test("dragging seeks the player to the released fraction of the duration", async () => {
    // 8s clip, 100px track. Release at x=25 → 25% → 2.0s.
    playerStatus = { playing: false, currentTime: 0, duration: 8, didJustFinish: false };
    const { handlers } = renderVoice(8000, 100);
    handlers.onBegin!({ x: 25 });
    handlers.onUpdate!({ x: 25 });
    handlers.onEnd!({ x: 25 });
    expect(player.seekTo).toHaveBeenCalledWith(2);
    // The seek does not start playback — a paused clip stays paused.
    expect(player.play).not.toHaveBeenCalled();
  });

  test("a stationary tap on the track seeks to that point (Tap gesture, not Pan)", () => {
    // A tap never moves far enough to activate Pan, so a separate Tap gesture
    // handles it. Tap at mid-track on a 10s clip → 5s.
    playerStatus = { playing: true, currentTime: 1, duration: 10, didJustFinish: false };
    const { tap } = renderVoice(10000, 200);
    tap.onEnd!({ x: 100 });
    expect(player.seekTo).toHaveBeenCalledWith(5);
    // Seeking a playing clip doesn't pause it.
    expect(player.pause).not.toHaveBeenCalled();
  });

  test("after the seek resolves, the scrub override is dropped (fill follows playhead again)", async () => {
    playerStatus = { playing: false, currentTime: 0, duration: 8, didJustFinish: false };
    hostStateRef.current = 0.25; // a preview was showing during the drag
    const { handlers } = renderVoice(8000, 100);
    handlers.onEnd!({ x: 50 }); // release at 50% → seekTo(4)
    expect(player.seekTo).toHaveBeenCalledWith(4);
    // Settle the seek promise; the .then clears the scrub override.
    seekResolves[0]();
    await Promise.resolve();
    expect(hostStateRef.current).toBeNull();
  });

  test("an out-of-bounds release clamps the seek to the clip end", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 6, didJustFinish: false };
    const { handlers } = renderVoice(6000, 100);
    handlers.onEnd!({ x: 999 });
    expect(player.seekTo).toHaveBeenCalledWith(6);
  });

  test("a scrub before the clip loads (duration 0) does not seek", () => {
    playerStatus = { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
    const { handlers } = renderVoice(0, 100);
    handlers.onEnd!({ x: 50 });
    expect(player.seekTo).not.toHaveBeenCalled();
  });

  test("a cancelled gesture drops the scrub preview without seeking", () => {
    // setScrubFraction is the chatMockSetup setRequest stub, which writes
    // hostStateRef.current — assert the finalize handler resets it to null on a
    // failed gesture and leaves it alone on a successful one (the onEnd already
    // committed + cleared in that case).
    playerStatus = { playing: false, currentTime: 0, duration: 8, didJustFinish: false };
    const { handlers } = renderVoice(8000, 100);
    hostStateRef.current = 0.5; // pretend a preview is showing
    handlers.onFinalize!({}, false);
    expect(hostStateRef.current).toBeNull();
    expect(player.seekTo).not.toHaveBeenCalled();

    // A successful gesture: onFinalize must NOT clobber state (onEnd owns it).
    hostStateRef.current = 0.5;
    handlers.onFinalize!({}, true);
    expect(hostStateRef.current).toBe(0.5);
  });

  test("while scrubbing, the fill + time readout follow the finger, not the playhead", () => {
    // Simulate scrub-in-progress: chatMockSetup's useState returns
    // hostStateRef.current, so a scrubFraction of 0.25 stands in for "finger at
    // 25%". Playhead is at 0s, but the bubble should show the dragged position.
    hostStateRef.current = 0.25;
    playerStatus = { playing: false, currentTime: 0, duration: 8, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 8000 }
    });
    // The progress fill width reflects 25%, and the remaining time is 8s - 2s = 6s.
    const fill = flatten(tree).find(
      (n) => n.type === View && typeof (n.props.style as unknown[])?.find === "function" &&
        (n.props.style as Array<{ width?: string }>).some((s) => s?.width === "25%")
    );
    expect(fill).toBeTruthy();
    expect(textLabels(tree)).toContain("0:06");
  });
});

describe("steppedSeekFraction", () => {
  test("increments and decrements by 0.1, clamped to [0,1]", () => {
    expect(steppedSeekFraction(0.5, "increment")).toBeCloseTo(0.6, 5);
    expect(steppedSeekFraction(0.5, "decrement")).toBeCloseTo(0.4, 5);
    // Clamp at the ends.
    expect(steppedSeekFraction(0.95, "increment")).toBe(1);
    expect(steppedSeekFraction(0.05, "decrement")).toBe(0);
    expect(steppedSeekFraction(1, "increment")).toBe(1);
    expect(steppedSeekFraction(0, "decrement")).toBe(0);
  });
});

describe("VoiceBubble accessibility (VoiceOver adjustable)", () => {
  // The seek control must be operable without sight of the touch track: it's an
  // adjustable slider whose increment/decrement actions step the playhead.
  function getSeekControl(tree: El) {
    return flatten(tree).find(
      (n) => (n.props as { accessibilityRole?: string }).accessibilityRole === "adjustable"
    );
  }

  test("the track is an accessible adjustable with a percent value and step actions", () => {
    playerStatus = { playing: false, currentTime: 2, duration: 8, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 8000 }
    });
    const seek = getSeekControl(tree);
    expect(seek).toBeTruthy();
    expect(seek!.props.accessible).toBe(true);
    expect(seek!.props.accessibilityLabel).toBe("Seek voice chat");
    // 2s of 8s → 25%.
    expect(seek!.props.accessibilityValue).toEqual({ now: 25, min: 0, max: 100 });
    expect(seek!.props.accessibilityActions).toEqual([{ name: "increment" }, { name: "decrement" }]);
    expect(typeof seek!.props.onAccessibilityAction).toBe("function");
  });

  test("an increment action steps the playhead forward by 10% of the clip", () => {
    // Playhead at 2s of 8s (25%); increment → 35% → 2.8s.
    playerStatus = { playing: false, currentTime: 2, duration: 8, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 8000 }
    });
    const seek = getSeekControl(tree)!;
    (seek.props.onAccessibilityAction as (e: { nativeEvent: { actionName: string } }) => void)({
      nativeEvent: { actionName: "increment" }
    });
    expect(player.seekTo).toHaveBeenCalledWith(2.8);
  });

  test("a decrement action steps the playhead back by 10% of the clip", () => {
    // Playhead at 4s of 10s (40%); decrement → 30% → 3s.
    playerStatus = { playing: true, currentTime: 4, duration: 10, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 10000 }
    });
    const seek = getSeekControl(tree)!;
    (seek.props.onAccessibilityAction as (e: { nativeEvent: { actionName: string } }) => void)({
      nativeEvent: { actionName: "decrement" }
    });
    // 30% of 10s → 3s (float-tolerant: 0.4-0.1 carries IEEE error).
    expect(player.seekTo).toHaveBeenCalledTimes(1);
    expect(player.seekTo.mock.calls[0][0]).toBeCloseTo(3, 5);
    // A11y seek doesn't change play/pause state.
    expect(player.pause).not.toHaveBeenCalled();
  });

  test("an unknown accessibility action is ignored (no seek)", () => {
    playerStatus = { playing: false, currentTime: 2, duration: 8, didJustFinish: false };
    const tree = (VoiceBubble as unknown as (p: { audio: unknown }) => El)({
      audio: { id: "abc", mimeType: "audio/wav", size: 1000, durationMs: 8000 }
    });
    const seek = getSeekControl(tree)!;
    (seek.props.onAccessibilityAction as (e: { nativeEvent: { actionName: string } }) => void)({
      nativeEvent: { actionName: "activate" }
    });
    expect(player.seekTo).not.toHaveBeenCalled();
  });
});

describe("BlockUserText attachments", () => {
  test("renders image attachments as a tappable grid that opens the previewer", () => {
    const tree = renderBlock({
      text: "",
      images: [{ id: "img1", mimeType: "image/png", size: 2048 }]
    });
    const nodes = flatten(tree);
    const img = nodes.find((n) => n.type === Image);
    expect(img).toBeTruthy();
    expect((img!.props.source as { uri: string }).uri).toBe("http://gw.local/api/uploads/img1");
    const opener = nodes.find(
      (n) => n.type === Pressable && (n.props as { accessibilityLabel?: string }).accessibilityLabel === "Open image"
    );
    expect(opener).toBeTruthy();
    (opener!.props.onPress as () => void)();
    expect(openPreview).toHaveBeenCalledWith({
      uri: "http://gw.local/api/uploads/img1",
      headers: { Authorization: "Bearer t" }
    });
  });

  test("renders a non-image attachment as a file chip with type label and size", () => {
    const labels = textLabels(
      renderBlock({ text: "", images: [{ id: "f1", mimeType: "application/pdf", size: 2_500_000 }] })
    );
    // fileTypeLabel uppercases the mime subtype; formatBytes renders MB at this size.
    expect(labels).toContain("PDF");
    expect(labels).toContain("2.4 MB");
  });

  test("formats small and mid-size files as B and KB", () => {
    const small = textLabels(renderBlock({ text: "", images: [{ id: "s", mimeType: "text/csv", size: 512 }] }));
    expect(small).toContain("512 B");
    expect(small).toContain("CSV");

    const kb = textLabels(renderBlock({ text: "", images: [{ id: "k", mimeType: "text/plain", size: 4096 }] }));
    expect(kb).toContain("4 KB");
  });

  test("a mime with no subtype falls back to the whole type for the label", () => {
    const labels = textLabels(renderBlock({ text: "", images: [{ id: "x", mimeType: "weirdtype", size: 10 }] }));
    expect(labels).toContain("WEIRDTYPE");
  });

  test("renders the text bubble (via SelectableBlockText) when the message carries text", () => {
    const tree = renderBlock({ text: "hello there" });
    // SelectableBlockText is the REAL component (siblings rely on it too); on the
    // mocked iOS platform it renders a TextInput whose children are the text.
    const labels = flatten(tree)
      .flatMap((n) => {
        const kids = n.props?.children;
        return Array.isArray(kids) ? kids : [kids];
      })
      .filter((k) => typeof k === "string");
    expect(labels).toContain("hello there");
  });

  test("renders a VoiceBubble element when the message carries audio", () => {
    const tree = renderBlock({ text: "", audio: { id: "a1", mimeType: "audio/wav", size: 100, durationMs: 2000 } });
    // BlockUserText embeds <VoiceBubble audio=.../> as a child element; it isn't
    // invoked here, so assert the element node is present with the audio prop
    // forwarded (the toggle/render behavior is covered by the VoiceBubble suite).
    const voice = flatten(tree).find((n) => n.type === VoiceBubble);
    expect(voice).toBeTruthy();
    expect((voice!.props as { audio: { id: string } }).audio.id).toBe("a1");
  });

  test("an image-only message omits the empty text bubble", () => {
    const tree = renderBlock({ text: "", images: [{ id: "img1", mimeType: "image/png", size: 10 }] });
    const voice = flatten(tree).find((n) => n.type === VoiceBubble);
    expect(voice).toBeUndefined();
    // No text → the message carries only the image grid (no SelectableBlockText text).
    const strings = flatten(tree)
      .flatMap((n) => {
        const kids = n.props?.children;
        return Array.isArray(kids) ? kids : [kids];
      })
      .filter((k) => typeof k === "string");
    expect(strings.length).toBe(0);
  });
});
