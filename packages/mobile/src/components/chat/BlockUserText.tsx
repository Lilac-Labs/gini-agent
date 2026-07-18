import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useRef, useState } from "react";
import { Image, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { authHeader, uploadUrl } from "@/src/api";
import { useImagePreview } from "@/src/components/ImagePreview";
import { family, theme } from "@/src/theme";
import type { AudioAttachment, UserTextBlock } from "@/src/types";
import { SelectableBlockText } from "./SelectableBlockText";

// Right-aligned dark bubble. The asymmetric corner geometry has a
// sharper bottom-left so the bubble visually "points" toward the
// user-bubble corner of the conversation (which is the closest edge to
// the input bar). No author/time header — the design uses alignment
// and color alone as the role signal.
//
// Attached images render as a wrapped grid of thumbnails above the
// bubble. The bubble itself is omitted when the user only sent images
// (no text), so an image-only message doesn't show an empty pill.
// Non-image attachments (PDF, CSV, logs) render as static file chips —
// the block carries no filename (ImageAttachment is {id, mimeType,
// size}), so the chip shows the mime subtype + size, not a name. Without
// this branch a sent file would render as a broken <Image>.
export function BlockUserText({ block }: { block: UserTextBlock }) {
  const attachments = block.images ?? [];
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));
  const hasText = block.text.length > 0;
  // Gateway uploads require the same bearer token the SSE / REST paths
  // use; <Image> on RN supports a headers prop on its source object.
  const headers = authHeader();
  const { open } = useImagePreview();
  return (
    <View style={styles.row}>
      {images.length > 0 ? (
        <View style={styles.imageGrid}>
          {images.map((image) => {
            const uri = uploadUrl(image.id);
            return (
              <Pressable
                key={image.id}
                style={styles.imageWrapper}
                onPress={() => open({ uri, headers })}
                accessibilityRole="button"
                accessibilityLabel="Open image"
              >
                <Image
                  source={{ uri, headers }}
                  style={styles.image}
                  resizeMode="cover"
                />
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.fileColumn}>
          {files.map((file) => (
            <View key={file.id} style={styles.fileChip}>
              <Feather name="file" size={18} color={theme.userBubbleText} />
              <View style={styles.fileChipBody}>
                <Text style={styles.fileChipLabel} numberOfLines={1}>
                  {fileTypeLabel(file.mimeType)}
                </Text>
                <Text style={styles.fileChipMeta} numberOfLines={1}>
                  {formatBytes(file.size)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {block.audio ? <VoiceBubble audio={block.audio} /> : null}
      {hasText ? (
        <View style={styles.bubble}>
          <SelectableBlockText style={styles.text}>
            {block.text}
          </SelectableBlockText>
        </View>
      ) : null}
    </View>
  );
}

// Telegram-style playable voice bubble. The recording is streamed from
// the gateway, which requires the same bearer header the <Image> path
// uses — expo-audio's remote AudioSource accepts a `headers` map. The
// track fills as playback advances; tapping play after the clip finishes
// restarts it from the beginning.
// Map a horizontal touch x (px, relative to the track's left edge) and the
// track's measured width to a clamped [0,1] fraction. Pulled out as a pure
// function so the scrub math is unit-testable without a gesture/layout harness.
// A zero/unmeasured width yields 0 so a touch before layout can't divide by 0.
export function seekFractionFromTouch(x: number, trackWidth: number): number {
  if (trackWidth <= 0) return 0;
  return Math.min(1, Math.max(0, x / trackWidth));
}

// VoiceOver "adjustable" increment/decrement step. A swipe up/down moves the
// playhead by this fraction of the clip; 0.1 gives 11 reachable stops (0%, 10%,
// …, 100%), enough to scrub a short voice message without VoiceOver users
// needing the touch track (which they can't see to aim at).
const SEEK_STEP = 0.1;

// Clamped next position for an accessibility increment/decrement. Pure so the
// stepping is unit-testable without a VoiceOver harness.
export function steppedSeekFraction(current: number, action: "increment" | "decrement"): number {
  const next = action === "increment" ? current + SEEK_STEP : current - SEEK_STEP;
  return Math.min(1, Math.max(0, next));
}

export function VoiceBubble({ audio }: { audio: AudioAttachment }) {
  const player = useAudioPlayer({ uri: uploadUrl(audio.id), headers: authHeader() });
  const status = useAudioPlayerStatus(player);

  // Measured pixel width of the track, captured on layout so a touch x can be
  // turned into a 0..1 position. A ref (not state) because only the gesture
  // callbacks read it, and the fill/thumb are percentage-positioned, so a
  // width change needs no re-render.
  const trackWidthRef = useRef(0);
  // While the finger is down we show the dragged position instead of the
  // playhead so the fill tracks the thumb smoothly; null means "not scrubbing,
  // follow playback". The actual player.seekTo fires once on release.
  const [scrubFraction, setScrubFraction] = useState<number | null>(null);

  // Prefer the decoded duration once it's known; fall back to the
  // client-measured length so the m:ss reads correctly before load.
  const durationMs =
    status.duration > 0 ? status.duration * 1000 : (audio.durationMs ?? 0);
  const positionMs = status.currentTime * 1000;
  const playbackProgress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  // When scrubbing, the fill and the time readout follow the finger; otherwise
  // they follow the playhead.
  const progress = scrubFraction ?? playbackProgress;
  const shownPositionMs = scrubFraction != null ? scrubFraction * durationMs : positionMs;
  const remainingMs =
    scrubFraction != null || status.playing
      ? Math.max(0, durationMs - shownPositionMs)
      : durationMs;

  const onTrackLayout = (e: LayoutChangeEvent): void => {
    trackWidthRef.current = e.nativeEvent.layout.width;
  };

  // Commit a scrub fraction to the player. seekTo is async; once it resolves we
  // drop the scrub override so the fill resumes following the (now-moved)
  // playhead. Seeking does not change play/pause state — a paused clip stays
  // paused at the new spot, a playing clip keeps playing from it.
  const seekToFraction = (fraction: number): void => {
    if (durationMs <= 0) {
      setScrubFraction(null);
      return;
    }
    void player.seekTo((fraction * durationMs) / 1000).then(() => setScrubFraction(null));
  };

  const toggle = (): void => {
    if (status.playing) {
      player.pause();
      return;
    }
    // Replaying a finished clip must rewind to 0 BEFORE starting, and the seek
    // is async: calling play() in the same tick starts the AVQueuePlayer at the
    // end (itemTime == duration), which the native player treats as
    // play-then-immediately-StopAtEnd, so nothing is heard and the control
    // snaps back to "play". Only a fully-played clip needs the rewind — guard on
    // a known (loaded) duration so a pre-load tap (duration still 0) doesn't
    // count as "at the end" and seek needlessly. Await the seek, then play.
    const atEnd =
      status.didJustFinish ||
      (status.duration > 0 && status.currentTime >= status.duration);
    if (atEnd) {
      void player.seekTo(0).then(() => player.play());
    } else {
      player.play();
    }
  };

  // Pan tracks the drag and previews the position live; its onEnd commits the
  // seek. runOnJS keeps the JS callbacks on the JS thread (no reanimated
  // worklet needed for setState).
  const pan = Gesture.Pan()
    .minDistance(0)
    .runOnJS(true)
    .onBegin((e) => setScrubFraction(seekFractionFromTouch(e.x, trackWidthRef.current)))
    .onUpdate((e) => setScrubFraction(seekFractionFromTouch(e.x, trackWidthRef.current)))
    .onEnd((e) => seekToFraction(seekFractionFromTouch(e.x, trackWidthRef.current)))
    // A cancelled/failed gesture (e.g. the row scrolls) must not leave the fill
    // stuck at the preview — drop the override without seeking.
    .onFinalize((_e, success) => {
      if (!success) setScrubFraction(null);
    });
  // A stationary tap never moves far enough to activate Pan, so handle it
  // explicitly: tapping anywhere on the track jumps the playhead to that point.
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => seekToFraction(seekFractionFromTouch(e.x, trackWidthRef.current)));
  // Race so whichever the user does — a quick tap or a drag — is handled; the
  // first to activate wins.
  const scrub = Gesture.Race(pan, tap);

  // VoiceOver can't aim at the touch track, so expose the same seek as
  // increment/decrement actions: a swipe up/down on the focused control steps
  // the playhead by SEEK_STEP. Reads the live displayed `progress` so each step
  // is relative to where the playhead actually is.
  const onAccessibilityAction = (event: {
    nativeEvent: { actionName: string };
  }): void => {
    const name = event.nativeEvent.actionName;
    if (name === "increment" || name === "decrement") {
      seekToFraction(steppedSeekFraction(progress, name));
    }
  };

  return (
    <View style={styles.voiceBubble}>
      <Pressable
        onPress={toggle}
        hitSlop={8}
        style={styles.voicePlay}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause voice chat" : "Play voice chat"}
      >
        <Feather
          name={status.playing ? "pause" : "play"}
          size={16}
          color={theme.userBubbleText}
        />
      </Pressable>
      <GestureDetector gesture={scrub}>
        {/* Taller transparent hit area so the 3px track is easy to grab; the
            visible bar sits centered inside it. */}
        <View
          // `accessible` collapses the track into one focusable node (without
          // it the role/actions can be flattened away inside GestureDetector)
          // and makes VoiceOver expose it as a single adjustable slider.
          accessible
          style={styles.voiceTrackHit}
          accessibilityRole="adjustable"
          accessibilityLabel="Seek voice chat"
          accessibilityValue={{ now: Math.round(progress * 100), min: 0, max: 100 }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={onAccessibilityAction}
        >
          <View style={styles.voiceTrack} onLayout={onTrackLayout}>
            <View style={[styles.voiceProgress, { width: `${progress * 100}%` }]} />
          </View>
          <View style={[styles.voiceThumb, { left: `${progress * 100}%` }]} />
        </View>
      </GestureDetector>
      <Text style={styles.voiceDuration}>{formatDuration(remainingMs)}</Text>
    </View>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The block carries no original filename, so the chip's primary line is a
// short type label derived from the mime subtype (e.g. "application/pdf"
// → "PDF", "text/csv" → "CSV").
function fileTypeLabel(mimeType: string): string {
  const sub = mimeType.split("/")[1] ?? mimeType;
  return sub.toUpperCase();
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    alignItems: "flex-end",
    gap: 6
  },
  bubble: {
    backgroundColor: theme.userBubble,
    paddingVertical: 12,
    paddingHorizontal: 16,
    // RN takes the four corner radii individually — top-left, top-right,
    // bottom-right, bottom-left. The bottom-right corner is the sharp
    // one for the user bubble (mirrors the Pencil design).
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  text: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    lineHeight: 22
  },
  // Voice control reuses the user-bubble color + corner geometry so it
  // reads as part of the same right-aligned message.
  voiceBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 200,
    backgroundColor: theme.userBubble,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  voicePlay: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center"
  },
  // Transparent, taller-than-the-bar grab zone so the thin track is an easy
  // drag/tap target; the visible 3px bar is centered within it.
  voiceTrackHit: {
    flex: 1,
    height: 24,
    justifyContent: "center"
  },
  voiceTrack: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "rgba(255,255,255,0.3)",
    overflow: "hidden"
  },
  voiceProgress: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: theme.userBubbleText
  },
  // Draggable knob centered on the playhead. marginLeft pulls it half its width
  // left so its center (not its left edge) sits at the progress fraction.
  voiceThumb: {
    position: "absolute",
    top: "50%",
    width: 12,
    height: 12,
    marginTop: -6,
    marginLeft: -6,
    borderRadius: 6,
    backgroundColor: theme.userBubbleText
  },
  voiceDuration: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13,
    minWidth: 34,
    textAlign: "right"
  },
  imageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6
  },
  // Sent non-image files stack as right-aligned chips reusing the
  // user-bubble color so they read as part of the same message.
  fileColumn: {
    alignItems: "flex-end",
    gap: 6
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 180,
    maxWidth: 240,
    backgroundColor: theme.userBubble,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  fileChipBody: { flex: 1 },
  fileChipLabel: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14
  },
  fileChipMeta: {
    color: theme.userBubbleText,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    opacity: 0.7,
    marginTop: 2
  },
  imageWrapper: {
    width: 160,
    height: 160,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: theme.codeChipBg
  },
  image: {
    width: "100%",
    height: "100%"
  }
});
