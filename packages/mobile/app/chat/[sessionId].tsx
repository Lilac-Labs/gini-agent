import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, isCredentialRejected, uploadImage, type UploadRef } from "@/src/api";
import { clearCredentials } from "@/src/auth";
import { AttachmentSheet } from "@/src/components/AttachmentSheet";
import { AgentAvatar } from "@/src/components/chat/AgentAvatar";
import { BlockRenderer } from "@/src/components/chat/BlockRenderer";
import { BlockToolCallsCollapsed } from "@/src/components/chat/BlockToolCallsCollapsed";
import { GeneratedFilesCard } from "@/src/components/chat/GeneratedFilesCard";
import { QueuedMessages } from "@/src/components/chat/QueuedMessages";
import { VoiceRecorder, type VoiceRef } from "@/src/components/chat/VoiceRecorder";
import { chatListTime, jobCadence } from "@/src/format";
import { groupExchanges, type ChatRenderItem } from "@/src/group-exchanges";
import { getCachedDeviceToken, refreshBadge, registerForPushAsync } from "@/src/push";
import {
  isTaskInFlight,
  useAgents,
  useCancelTask,
  useChatRuns,
  useChatStream,
  useJobs,
  useRemovePendingChatMessage,
  useSendMessage,
  useVoiceStatus
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { ChatBlock, JobRecord } from "@/src/types";

type ChatTab = "messages" | "jobs";

interface PendingAttachment {
  localId: string;
  kind: "image" | "file";
  // Set only for images — the tray renders a thumbnail from it. Non-image
  // files render a chip instead and carry no preview.
  previewUri?: string;
  filename: string;
  mimeType: string;
  size?: number;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
  ref?: UploadRef;
}

// B / KB / MB for a file chip's size line. Files can be anything (PDF,
// CSV, logs), so the tray shows a human-readable byte count.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Pull a reasonable filename + mime from the picker asset. iOS hands us
// the original photo extension (.HEIC/.jpg/...) when available; when it
// doesn't, we fall back to .jpg since the picker re-encodes HEIC for us
// only on explicit request. `mediaTypes: ["images"]` already guarantees
// the asset is an image, so a defaulted image/jpeg type is safe enough
// for the gateway's mime-prefix guard.
function describeAsset(asset: ImagePicker.ImagePickerAsset): {
  filename: string;
  mimeType: string;
} {
  const uriName = asset.fileName ?? asset.uri.split("/").pop() ?? "image.jpg";
  const filename = uriName.includes(".") ? uriName : `${uriName}.jpg`;
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeFromExt =
    ext === "png"
      ? "image/png"
      : ext === "gif"
        ? "image/gif"
        : ext === "webp"
          ? "image/webp"
          : ext === "heic" || ext === "heif"
            ? "image/heic"
            : "image/jpeg";
  return { filename, mimeType: asset.mimeType ?? mimeFromExt };
}

const TERMINAL_PHASE_LABELS = new Set<string>(["Completed", "Cancelled", "Failed"]);

function findInFlightTaskId(blocks: ChatBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    if (b.kind === "phase") {
      if (TERMINAL_PHASE_LABELS.has(b.label)) return null;
      return b.taskId ?? null;
    }
    if (b.kind === "setup_requested" || b.kind === "authorization_requested") {
      return b.taskId ?? null;
    }
    if (b.kind === "tool_call" && b.status === "running") {
      return b.taskId ?? null;
    }
  }
  return null;
}

// The job name a render item was delivered by, or undefined for ordinary
// conversation. A file_artifact card has no runId of its own, so the caller
// carries the preceding run's name forward to it (it always trails its run's
// tool group). `tool_group` reads its first call's runId; `block` its own.
function itemJobName(item: ChatRenderItem, runIdToJobName: Map<string, string>): string | undefined {
  if (item.kind === "tool_group") return item.calls[0]?.runId ? runIdToJobName.get(item.calls[0].runId) : undefined;
  if (item.kind === "block") return item.block.runId ? runIdToJobName.get(item.block.runId) : undefined;
  return undefined;
}

// Single-agent chat: an agent header, a Chat / Routines tab bar, and the
// active tab's content. Chat renders every block of the session linearly
// in ordinal order (side-conversations now live in their own Topic sessions,
// not threads). Routines lists the agent's recurring jobs. The composer stays
// mounted under every tab. A `kind:"topic"` session reads as `#<title>` in the
// header and hides the Routines tab.
export default function ChatDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const stream = useChatStream(sessionId ?? null);
  const send = useSendMessage(sessionId ?? null);
  const voice = useVoiceStatus();
  const cancel = useCancelTask();
  const removePending = useRemovePendingChatMessage(sessionId ?? null);
  const agents = useAgents();
  const qc = useQueryClient();

  const [tab, setTab] = useState<ChatTab>("messages");
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingAttachment[]>([]);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [voicePending, setVoicePending] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const pinnedToBottomRef = useRef<boolean>(true);
  // Mirrors pinnedToBottomRef as state so the "jump to latest" button can show
  // when the user has scrolled up. The ref drives auto-scroll (no re-render);
  // this drives the button's visibility (needs a re-render).
  const [atBottom, setAtBottom] = useState(true);

  // Only a REAL gateway rejection (token presented and refused) signs out and
  // redirects. A local "no credentials" 401 (already signed out) is ignored —
  // the root auth gate owns routing, and re-navigating would just reopen the signed-out screen.
  const unauthorized = isCredentialRejected(stream.error);
  useEffect(() => {
    // Clear the dead token (revoked/expired) before redirecting so a cold start
    // doesn't replay route-to-app → 401 → signed-out (the cold-start flash).
    if (unauthorized) {
      void clearCredentials();
      router.replace("/");
    }
  }, [unauthorized]);

  useEffect(() => {
    void registerForPushAsync();
  }, []);

  const list = useMemo<ChatBlock[]>(() => stream.blocks ?? [], [stream.blocks]);

  // Resolve the owning agent so the header shows the right name + avatar.
  const agent = useMemo(() => {
    const agentId = stream.session?.agentId;
    if (!agentId) return undefined;
    return agents.data?.agents.find((a) => a.id === agentId);
  }, [agents.data, stream.session]);
  const agentName = agent?.name ?? stream.session?.title?.trim() ?? "Chat";
  const agentOnline = agent?.status === "ready" || agent?.status === "active";

  // A `kind:"topic"` session is a subject-scoped side-conversation: it carries
  // its own title and reads as `#<title>` in the header. Its Routines tab is hidden
  // (topics don't own recurring jobs) and it shows no agent online status.
  const isTopic = stream.session?.kind === "topic";
  const headerName = isTopic
    ? `#${stream.session?.title?.trim() || "topic"}`
    : agentName;

  // The Routines tab is per-agent; gate the fetch on the resolved agent id so
  // it doesn't run before the session record loads.
  const jobs = useJobs(agent?.id ?? null);

  // Mark the chat as read once we know which block id is latest.
  const lastReadBlockIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    if (list.length === 0) return;
    const latestId = list[list.length - 1]!.id;
    if (lastReadBlockIdRef.current === latestId) return;
    lastReadBlockIdRef.current = latestId;
    if (!getCachedDeviceToken()) return;
    void (async () => {
      try {
        await api(`/chat/${sessionId}/read`, {
          method: "POST",
          body: JSON.stringify({ lastReadBlockId: latestId })
        });
        await refreshBadge();
        qc.invalidateQueries({ queryKey: ["unread"] });
      } catch {
        // Best-effort — read state is rebuilt on the next navigation.
      }
    })();
  }, [list, sessionId, qc]);

  // Phase blocks are transient — only render the latest active one.
  const visible = useMemo<ChatBlock[]>(() => {
    return list.filter((b, i) => {
      if (b.kind !== "phase") return true;
      const isLast = i === list.length - 1;
      if (!isLast) return false;
      return (
        b.label !== "Completed" &&
        b.label !== "Cancelled" &&
        b.label !== "Failed"
      );
    });
  }, [list]);

  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, Extract<ChatBlock, { kind: "tool_result" }>>();
    for (const b of list) {
      if (b.kind === "tool_result") map.set(b.callId, b);
    }
    return map;
  }, [list]);

  // Terminal runs whose "Completed" phase is filtered out before grouping.
  // groupExchanges folds these even when they ended on a tool call with no
  // closing answer. Scope to "Completed" only so failures still surface inline.
  const terminalTaskIds = useMemo(
    () =>
      new Set(
        list
          .filter((b) => b.kind === "phase" && b.label === "Completed" && b.taskId)
          .map((b) => b.taskId!)
      ),
    [list]
  );

  const renderItems = useMemo<ChatRenderItem[]>(
    () => groupExchanges(visible, terminalTaskIds),
    [visible, terminalTaskIds]
  );

  // Map a job run's runId → its job name so messages delivered by a scheduled
  // job render with a "from <job name>" badge. The session detail carries the
  // full run records (kind/jobId); the jobs list resolves jobId → name. The
  // name lookup uses the UNSCOPED jobs list (not the per-agent `jobs` above):
  // a job owned by a different agent can still deliver into this session, so
  // scoping the name join to this agent would drop its badge.
  const chatRuns = useChatRuns(sessionId ?? null);
  const allJobs = useJobs("all");
  const runIdToJobName = useMemo(() => {
    const jobNameById = new Map((allJobs.data ?? []).map((j) => [j.id, j.name]));
    const map = new Map<string, string>();
    for (const run of chatRuns.data ?? []) {
      if (run.kind !== "job" || !run.jobId) continue;
      const name = jobNameById.get(run.jobId);
      if (name) map.set(run.id, name);
    }
    return map;
  }, [chatRuns.data, allJobs.data]);

  // Segment the render items into consecutive runs sharing one job name (a
  // file_artifact card inherits the preceding item's name since it trails its
  // run's tool group). Each segment with a jobName renders inside one bordered
  // container with a single "from <job name>" header; segments without one
  // render exactly as before.
  const itemSegments = useMemo(() => {
    const segments: { jobName?: string; items: ChatRenderItem[] }[] = [];
    let lastJobName: string | undefined;
    for (const item of renderItems) {
      const ownJobName = itemJobName(item, runIdToJobName);
      // A file_artifact card trails its run's tool group with no runId of its
      // own, so it inherits the preceding run's job name rather than breaking
      // the segment.
      const isArtifact = item.kind === "file_artifact";
      const jobName = ownJobName ?? (isArtifact ? lastJobName : undefined);
      lastJobName = isArtifact ? lastJobName : ownJobName;
      const tail = segments[segments.length - 1];
      if (tail && tail.jobName === jobName) tail.items.push(item);
      else segments.push({ jobName, items: [item] });
    }
    return segments;
  }, [renderItems, runIdToJobName]);

  const inFlight = useMemo(() => isTaskInFlight(list), [list]);
  const inFlightTaskId = useMemo(() => findInFlightTaskId(list), [list]);

  // Server-side queue of follow-up messages submitted while a turn is in
  // flight. Delivered live on the session record via the chat_session SSE
  // frame (applySession) and reset with the session on switch. The pill above
  // the composer renders from this; it drains FIFO one-per-turn server-side.
  const pendingMessages = useMemo(
    () => stream.session?.pendingMessages ?? [],
    [stream.session]
  );

  const lastAssistantUpdatedAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]!;
      if (b.kind === "assistant_text") return b.updatedAt;
    }
    return "";
  }, [list]);

  // Auto-scroll only on the Chat tab (the other tabs are short lists
  // that don't stream). Skipped when the user has scrolled up.
  useEffect(() => {
    if (tab !== "messages") return;
    if (!pinnedToBottomRef.current) return;
    const id = setTimeout(() => {
      if (!pinnedToBottomRef.current) return;
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(id);
  }, [list.length, sessionId, lastAssistantUpdatedAt, voicePending, tab]);

  useEffect(() => {
    pinnedToBottomRef.current = true;
    setAtBottom(true);
  }, [sessionId]);

  // When the keyboard opens, the composer rises above it and the message
  // viewport shrinks from the bottom, covering the latest messages. Follow the
  // user down only if they were already reading at the bottom; if they'd
  // scrolled up, leave their position so they stay on what they're looking at.
  // keyboardDidShow (not willShow) fires after KeyboardAvoidingView's padding
  // animation settles, so scrollToEnd lands on the true, shrunk-viewport bottom.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      if (!pinnedToBottomRef.current) return;
      scrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  const trimmed = text.trim();
  const readyImages = useMemo(
    () => images.filter((image) => image.status === "ready" && image.ref).map((image) => image.ref!),
    [images]
  );
  const anyUploading = images.some((image) => image.status === "uploading");
  const showSendBusy = send.isPending || inFlight;
  const hasContent = Boolean(trimmed) || readyImages.length > 0;
  // Submission is allowed even while a turn is in flight — the message is
  // queued server-side (ADR chat-message-queue.md). It gates only on having
  // content, nothing uploading, a session, and no voice recording in progress.
  const canSubmit = hasContent && !anyUploading && !!sessionId && !voiceBusy;
  // The Send button only shows/enables when idle; it stays gated on content.
  const sendDisabled = !canSubmit || showSendBusy;
  const canStop = Boolean(inFlightTaskId) && !cancel.isPending;

  const submit = () => {
    // Don't gate on busy: successive submits while a turn runs each POST so they
    // queue in order server-side (the server serializes run-vs-queue).
    if (!canSubmit) return;
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    // Clear immediately — holding the composer until the server acks reads as
    // send lag; onError restores text + attachments unless the user has
    // already started composing something new.
    const attachmentsAtSubmit = images;
    setText("");
    setImages([]);
    send.mutate(
      { content: trimmed, images: readyImages },
      {
        onError: () => {
          setText((current) => (current === "" ? trimmed : current));
          setImages((current) => (current.length === 0 ? attachmentsAtSubmit : current));
        }
      }
    );
  };

  const sendVoice = (audio: VoiceRef): void => {
    if (!sessionId) return;
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    setVoicePending(true);
    send.mutate(
      { content: "", audio },
      {
        onError: (err) => {
          Alert.alert("Voice chat failed", err.message);
        },
        onSettled: () => {
          setVoicePending(false);
        }
      }
    );
  };

  const stopTask = () => {
    if (!inFlightTaskId || cancel.isPending) return;
    cancel.mutate(inFlightTaskId, {
      onError: (err) => {
        Alert.alert("Stop failed", err.message);
      }
    });
  };

  const beginUpload = async (asset: ImagePicker.ImagePickerAsset): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { filename, mimeType } = describeAsset(asset);
    setImages((prev) => [
      ...prev,
      {
        localId,
        kind: "image",
        previewUri: asset.uri,
        filename,
        mimeType,
        size: asset.fileSize,
        status: "uploading"
      }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: filename, mimeType });
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId ? { ...image, status: "ready", ref } : image
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId
            ? { ...image, status: "error", errorMessage: message }
            : image
        )
      );
      Alert.alert("Upload failed", message);
    }
  };

  const pickingFileRef = useRef(false);

  const pickFile = async (): Promise<void> => {
    if (pickingFileRef.current) return;
    pickingFileRef.current = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true
      });
      if (result.canceled) return;
      for (const asset of result.assets) void beginFileUpload(asset);
    } catch (err) {
      Alert.alert("Couldn't open Files", err instanceof Error ? err.message : String(err));
    } finally {
      pickingFileRef.current = false;
    }
  };

  const beginFileUpload = async (
    asset: DocumentPicker.DocumentPickerAsset
  ): Promise<void> => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mimeType = asset.mimeType ?? "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    setImages((prev) => [
      ...prev,
      {
        localId,
        kind: isImage ? "image" : "file",
        previewUri: isImage ? asset.uri : undefined,
        filename: asset.name,
        mimeType,
        size: asset.size,
        status: "uploading"
      }
    ]);
    try {
      const ref = await uploadImage({ uri: asset.uri, name: asset.name, mimeType });
      setImages((prev) =>
        prev.map((a) => (a.localId === localId ? { ...a, status: "ready", ref } : a))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImages((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, status: "error", errorMessage: message } : a
        )
      );
      Alert.alert("Upload failed", message);
    }
  };

  const pickFromLibrary = async (): Promise<void> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photo access required",
        "Enable photo library access in Settings to attach images."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.85
    });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const takePhoto = async (): Promise<void> => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Camera access required",
        "Enable camera access in Settings to capture photos."
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.85
    });
    if (result.canceled) return;
    for (const asset of result.assets) void beginUpload(asset);
  };

  const openAttachmentMenu = (): void => {
    Keyboard.dismiss();
    setAttachMenuVisible(true);
  };

  const removeImage = (localId: string): void => {
    setImages((prev) => prev.filter((image) => image.localId !== localId));
  };

  const scrollToBottom = (): void => {
    pinnedToBottomRef.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  // Render one chat item. Shared by the plain transcript and the job-grouped
  // containers so job-delivered messages render identically except for their
  // wrapper.
  const renderItem = (item: ChatRenderItem) => {
    if (item.kind === "tool_group") {
      return (
        <BlockToolCallsCollapsed
          key={item.id}
          calls={item.calls}
          steps={item.steps}
          resultsByCallId={toolResultsByCallId}
          inProgress={item.inProgress}
        />
      );
    }
    if (item.kind === "file_artifact") {
      return <GeneratedFilesCard key={item.id} files={item.files} />;
    }
    const block = item.block;
    return (
      <BlockRenderer
        key={block.id}
        block={block}
        toolResult={block.kind === "tool_call" ? toolResultsByCallId.get(block.callId) : undefined}
        isFinalAnswer={item.isFinalAnswer}
      />
    );
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Agent header — back arrow, avatar, name + status, search/more. */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.headerBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={26} color={theme.text} />
        </TouchableOpacity>
        <AgentAvatar name={isTopic ? headerName : agentName} size={38} />
        <View style={styles.headerText}>
          <Text style={styles.headerName} numberOfLines={1}>
            {headerName}
          </Text>
          {/* A topic isn't an agent, so it shows no online status — just the
              subject title. The agent surface keeps its Ready/Idle dot. */}
          {isTopic ? (
            <Text style={styles.headerStatus}>topic</Text>
          ) : (
            <View style={styles.headerStatusRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: agentOnline ? "#34C759" : "#C7C7CC" }
                ]}
              />
              <Text style={styles.headerStatus}>{agentOnline ? "Ready" : "Idle"}</Text>
            </View>
          )}
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {/* Tab bar — Chat / Routines (count). The Routines tab is hidden on a
          topic surface (topics don't own recurring routines). */}
      <View style={styles.tabBar}>
        <TabButton
          label="Chat"
          active={tab === "messages"}
          onPress={() => setTab("messages")}
        />
        {!isTopic ? (
          <TabButton
            label="Routines"
            active={tab === "jobs"}
            count={jobs.data?.length ?? 0}
            onPress={() => setTab("jobs")}
          />
        ) : null}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        {tab === "messages" ? (
          <View style={styles.messagesArea}>
          {stream.isPending && !stream.blocks ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.muted} />
            </View>
          ) : (
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={styles.messages}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } =
                  e.nativeEvent;
                const distanceFromBottom =
                  contentSize.height -
                  (contentOffset.y + layoutMeasurement.height);
                const pinned = distanceFromBottom < 40;
                pinnedToBottomRef.current = pinned;
                setAtBottom(pinned);
              }}
            >
              {visible.length > 0 ? (
                itemSegments.map((segment, segmentIndex) =>
                  segment.jobName ? (
                    // Routine-delivered chat: one light-blue left-bordered
                    // container with a single "from <routine name>" subtitle so
                    // they're distinguishable from the user's own turn.
                    <View key={`job-${segmentIndex}`} style={styles.jobRun}>
                      <Text style={styles.jobRunLabel}>from {segment.jobName}</Text>
                      {segment.items.map(renderItem)}
                    </View>
                  ) : (
                    segment.items.map(renderItem)
                  )
                )
              ) : !voicePending ? (
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>What can I help with?</Text>
                </View>
              ) : null}
              {voicePending ? (
                <View style={styles.voicePendingRow}>
                  <View style={styles.voicePendingBubble}>
                    <ActivityIndicator color={theme.muted} size="small" />
                    <Text style={styles.voicePendingText}>
                      {voice.data?.ready === false
                        ? "Setting up voice chat — first time only, this can take a minute."
                        : "Transcribing…"}
                    </Text>
                  </View>
                </View>
              ) : null}
            </ScrollView>
          )}
          {/* Floating "jump to latest" button — shown once the user scrolls
              up off the bottom. It lives inside the message area (a flex child
              that shrinks with the keyboard), so it floats just above the
              composer whether the keyboard is up or down. */}
          {!atBottom && visible.length > 0 ? (
            <TouchableOpacity
              onPress={scrollToBottom}
              activeOpacity={0.85}
              style={styles.jumpToBottom}
              accessibilityRole="button"
              accessibilityLabel="Scroll to latest chat"
            >
              <Feather name="chevron-down" size={24} color={theme.text} />
            </TouchableOpacity>
          ) : null}
          </View>
        ) : (
          <JobsTab jobs={jobs.data ?? []} loading={jobs.isLoading} />
        )}

        {/* Composer — shared across tabs; sending always posts to the
            session's chat. */}
        <View style={styles.inputBar}>
          <QueuedMessages
            pending={pendingMessages}
            onRemove={(pendingId) =>
              removePending.mutate(pendingId, {
                onError: (err) => {
                  Alert.alert("Couldn't remove", err.message);
                }
              })
            }
          />
          {images.length > 0 ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              style={styles.thumbTray}
              contentContainerStyle={styles.thumbTrayContent}
            >
              {images.map((image) =>
                image.kind === "image" ? (
                  <View
                    key={image.localId}
                    style={[
                      styles.thumb,
                      image.status === "error" && styles.thumbError
                    ]}
                  >
                    <Image source={{ uri: image.previewUri }} style={styles.thumbImage} />
                    {image.status === "uploading" ? (
                      <View style={styles.thumbOverlay}>
                        <ActivityIndicator color={theme.buttonText} />
                      </View>
                    ) : null}
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View
                    key={image.localId}
                    style={[
                      styles.fileChip,
                      image.status === "error" && styles.thumbError
                    ]}
                  >
                    <Feather name="file" size={20} color={theme.subtle} />
                    <View style={styles.fileChipBody}>
                      <Text style={styles.fileChipName} numberOfLines={1}>
                        {image.filename}
                      </Text>
                      <Text style={styles.fileChipMeta} numberOfLines={1}>
                        {image.size !== undefined ? formatBytes(image.size) : image.mimeType}
                      </Text>
                    </View>
                    {image.status === "uploading" ? (
                      <View style={styles.thumbOverlay}>
                        <ActivityIndicator color={theme.buttonText} />
                      </View>
                    ) : null}
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Remove attachment"
                      onPress={() => removeImage(image.localId)}
                      style={styles.thumbRemove}
                      hitSlop={6}
                    >
                      <Feather name="x" size={12} color={theme.buttonText} />
                    </TouchableOpacity>
                  </View>
                )
              )}
            </ScrollView>
          ) : null}
          <View style={styles.inputPill}>
            <TouchableOpacity
              onPress={openAttachmentMenu}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              hitSlop={8}
              style={styles.plusButton}
            >
              <Feather name="plus" size={24} color={theme.codeChipText} />
            </TouchableOpacity>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={`Chat with ${headerName}…`}
              placeholderTextColor={theme.inputPlaceholder}
              multiline
              editable={!!sessionId}
              onSubmitEditing={submit}
              blurOnSubmit={false}
              style={styles.inputText}
              accessibilityLabel="Chat input"
            />
            {canStop ? (
              <>
                {canSubmit ? (
                  <Pressable
                    onPress={submit}
                    style={[styles.sendButton, styles.queueButton]}
                    accessibilityRole="button"
                    accessibilityLabel="Queue chat"
                  >
                    {send.isPending ? (
                      <ActivityIndicator color={theme.buttonText} />
                    ) : (
                      <Feather name="arrow-up" size={22} color={theme.buttonText} />
                    )}
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={stopTask}
                  disabled={cancel.isPending}
                  style={[
                    styles.sendButton,
                    styles.stopButton,
                    cancel.isPending && styles.sendButtonDisabled
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Stop response"
                >
                  {cancel.isPending ? (
                    <ActivityIndicator color={theme.buttonText} />
                  ) : (
                    <Feather name="square" size={16} color={theme.buttonText} />
                  )}
                </Pressable>
              </>
            ) : !voiceBusy && (trimmed || readyImages.length > 0 || Platform.OS !== "ios") ? (
              <Pressable
                onPress={submit}
                disabled={sendDisabled}
                style={[
                  styles.sendButton,
                  sendDisabled && styles.sendButtonDisabled
                ]}
                accessibilityRole="button"
                accessibilityLabel="Send"
              >
                {send.isPending ? (
                  <ActivityIndicator color={theme.buttonText} />
                ) : (
                  <Feather name="arrow-up" size={22} color={theme.buttonText} />
                )}
              </Pressable>
            ) : (
              <VoiceRecorder
                disabled={!sessionId || showSendBusy || anyUploading}
                onSend={sendVoice}
                onBusyChange={setVoiceBusy}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      <AttachmentSheet
        visible={attachMenuVisible}
        sources={[
          { key: "camera", label: "Camera", icon: "camera", onPress: () => void takePhoto() },
          { key: "photos", label: "Photos", icon: "image", onPress: () => void pickFromLibrary() },
          { key: "files", label: "Files", icon: "file-plus", onPress: () => void pickFile() }
        ]}
        onClose={() => setAttachMenuVisible(false)}
      />
    </SafeAreaView>
  );
}

function TabButton({
  label,
  active,
  count,
  onPress
}: {
  label: string;
  active: boolean;
  count?: number;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <View style={[styles.tabRow, active && styles.tabRowActive]}>
        <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
        {count && count > 0 ? (
          <View style={styles.tabCount}>
            <Text style={styles.tabCountText}>{count}</Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// Routines tab — the agent's recurring routines, mirroring the channel rows on
// the Channels screen.
function JobsTab({ jobs, loading }: { jobs: JobRecord[]; loading: boolean }) {
  if (loading && jobs.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (jobs.length === 0) {
    return (
      <View style={styles.tabEmpty}>
        <Feather name="clock" size={28} color={theme.placeholder} />
        <Text style={styles.tabEmptyText}>No routines yet</Text>
        <Text style={styles.tabEmptySub}>
          Recurring routines run on a schedule and deliver to a channel.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.tabListContent}>
      {jobs.map((job) => (
        <View key={job.id} style={styles.jobRow}>
          <View style={styles.jobIcon}>
            <Feather name="clock" size={18} color={theme.placeholder} />
          </View>
          <View style={styles.jobBody}>
            <Text style={styles.jobName} numberOfLines={1}>
              {job.name}
            </Text>
            <View style={styles.jobSchedule}>
              <Feather name="repeat" size={11} color="#B0B0B6" />
              <Text style={styles.jobCadence} numberOfLines={1}>
                {jobCadence(job)}
              </Text>
            </View>
          </View>
          <Text style={styles.jobNext}>
            {job.nextRunAt ? chatListTime(job.nextRunAt) : ""}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Agent header.
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerBack: { width: 28, alignItems: "flex-start", justifyContent: "center" },
  headerText: { flex: 1, gap: 3 },
  headerName: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  headerStatusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  headerStatus: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  headerSpacer: { width: 4 },

  // Tab bar.
  tabBar: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  tab: { alignItems: "center" },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderBottomColor: "transparent"
  },
  tabRowActive: { borderBottomColor: theme.text },
  tabLabel: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14
  },
  tabLabelActive: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700)
  },
  tabCount: {
    backgroundColor: "#EAEAEA",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 1
  },
  tabCountText: {
    color: "#5A5A5A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 11
  },

  // Chat transcript.
  messages: {
    padding: 16,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 16
  },
  // Routine-delivered run container: light-blue left border + faint tint so a
  // scheduled job's messages stand apart from the user's own conversation.
  jobRun: {
    gap: 16,
    paddingLeft: 12,
    paddingVertical: 8,
    borderLeftWidth: 2,
    borderLeftColor: theme.accent,
    backgroundColor: "#EAF3FF",
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8
  },
  jobRunLabel: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  emptyChat: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center"
  },
  emptyChatText: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 18
  },

  // Routines tab list.
  tabListContent: { paddingVertical: 4 },
  tabEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10
  },
  tabEmptyText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  tabEmptySub: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20
  },

  // Routine list row.
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F2F2F2"
  },
  jobIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: "#F2F2F2",
    alignItems: "center",
    justifyContent: "center"
  },
  jobBody: { flex: 1, gap: 2 },
  jobName: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  jobSchedule: { flexDirection: "row", alignItems: "center", gap: 5 },
  jobCadence: {
    flex: 1,
    color: theme.placeholder,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  jobNext: {
    color: "#B6B6BC",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },

  // Chat area — wraps the transcript ScrollView so the floating jump
  // button can be absolutely positioned relative to it. As a flex child it
  // shrinks when the keyboard opens, keeping the button above the composer.
  messagesArea: { flex: 1 },

  // Floating "jump to latest" button, anchored to the bottom-right of the
  // message area (just above the composer).
  jumpToBottom: {
    position: "absolute",
    right: 16,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3
  },

  // Composer (unchanged geometry from the prior chat detail).
  inputBar: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    backgroundColor: theme.bg,
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  inputPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 4
  },
  plusButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center"
  },
  thumbTray: { marginBottom: 10, maxHeight: 76 },
  thumbTrayContent: { gap: 8, paddingRight: 4 },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: theme.codeChipBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    position: "relative"
  },
  thumbError: { borderColor: theme.danger },
  thumbImage: { width: "100%", height: "100%" },
  thumbOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center"
  },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center"
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    width: 180,
    height: 64,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: theme.codeChipBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    position: "relative"
  },
  fileChipBody: { flex: 1 },
  fileChipName: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14
  },
  fileChipMeta: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    marginTop: 2
  },
  inputText: {
    flex: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 17,
    paddingVertical: 8,
    maxHeight: 120
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.button,
    alignItems: "center",
    justifyContent: "center"
  },
  sendButtonDisabled: { backgroundColor: theme.buttonDisabled },
  stopButton: { backgroundColor: theme.danger },
  queueButton: { marginRight: 8 },

  voicePendingRow: { alignSelf: "flex-end", maxWidth: "80%" },
  voicePendingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.codeChipBg,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18
  },
  voicePendingText: {
    flex: 1,
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 19
  }
});
