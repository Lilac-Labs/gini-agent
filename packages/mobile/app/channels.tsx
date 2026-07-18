import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, isCredentialRejected } from "@/src/api";
import { clearCredentials } from "@/src/auth";
import { consumeLaunchNotificationRoute } from "@/src/push";
import { AgentAvatar } from "@/src/components/chat/AgentAvatar";
import { AgentsDrawer } from "@/src/components/AgentsDrawer";
import { NewAgentSheet } from "@/src/components/NewAgentSheet";
import { chatListTime } from "@/src/format";
import {
  useAgentChat,
  useAgents,
  useArchiveAgent,
  useCreateAgent,
  useTopics,
  useUnarchiveAgent,
  useUnreadCounts,
  useUseAgent
} from "@/src/queries";
import { family, theme } from "@/src/theme";
import type { AgentRecord, ChatSession } from "@/src/types";

// Home — scoped to a single active agent, mirroring the web sidebar's
// one-agent-per-panel model and the Pencil "Mobile — Chat (New Model)" frame.
// The header is the agent switcher (tap opens the slide-out Agents Drawer);
// below it sit the active agent's "Chat" (its one canonical chat) and
// "Topics" (its subject-scoped side-conversations). Recurring jobs are no
// longer a top-level concept here — they surface as Topics.
export default function ChannelsScreen() {
  const agents = useAgents();
  const createAgent = useCreateAgent();
  const useAgentMutation = useUseAgent();
  const archiveMutation = useArchiveAgent();
  const unarchiveMutation = useUnarchiveAgent();
  const unreadCountsQuery = useUnreadCounts();
  const unreadCounts = unreadCountsQuery.data ?? {};

  const agentList = useMemo<AgentRecord[]>(() => agents.data?.agents ?? [], [agents.data]);
  const activeAgentId = agents.data?.activeAgentId;
  const defaultAgentId = agents.data?.defaultAgentId;

  // The active agent drives the whole screen. Fall back to the default (then
  // the first agent) so the header and Chat row still render during the
  // brief window before the runtime reports a selection.
  const activeAgent = useMemo<AgentRecord | undefined>(
    () =>
      agentList.find((a) => a.id === activeAgentId) ??
      agentList.find((a) => a.id === defaultAgentId) ??
      agentList[0],
    [agentList, activeAgentId, defaultAgentId]
  );

  // The active agent's single canonical chat (the "Chat" row). The
  // resolver is idempotent server-side; the cached session feeds the row's
  // preview / unread, and the tap re-resolves to be safe on first paint.
  const activeChat = useAgentChat(activeAgent?.id ?? null);
  const topics = useTopics(activeAgent?.id ?? null);
  const topicList = topics.data ?? [];

  // `archivedAt` is a soft-delete marker orthogonal to `status`. The drawer
  // lists active agents and tucks archived ones into their own subsection.
  const activeAgents = useMemo(
    () => agentList.filter((a) => !a.archivedAt),
    [agentList]
  );
  const archivedAgents = useMemo(
    () => agentList.filter((a) => a.archivedAt),
    [agentList]
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentError, setNewAgentError] = useState<string | null>(null);
  // Opening the canonical chat is a network hop; track the in-flight state so
  // the Chat row shows a spinner instead of a dead press. The ref is the
  // real re-entrancy guard — state alone would weaken a synchronous double-tap.
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

  // Cold-start launch-tap recovery. If a notification tap launched the app
  // from a killed state, iOS doesn't replay it through the response listener;
  // consume the stored launch response here and push the named chat on top of
  // this list. (See the longer note in git history — unchanged from the prior
  // home screen.)
  useEffect(() => {
    consumeLaunchNotificationRoute();
  }, []);

  // Only a REAL gateway rejection (token presented and refused) signs out and
  // redirects. A local "no credentials" 401 — which every background poll
  // throws once signed out — is ignored: we're already logged out, the root
  // auth gate owns routing, and re-navigating would reopen the signed-out screen on a loop
  // while the user sits on it.
  const unauthorized = isCredentialRejected(agents.error);
  useEffect(() => {
    if (!unauthorized) return;
    // A 401 means the stored token is dead (revoked/expired). Drop it before
    // redirecting so the next cold start goes straight to the signed-out screen.
    void clearCredentials();
    router.replace("/");
  }, [unauthorized]);

  // Open the active agent's canonical chat. Resolve the session id directly
  // (idempotent) so the push targets the right route even on the first tap.
  const openActiveChat = useCallback(async () => {
    const agentId = activeAgent?.id;
    if (!agentId || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const session = await api<ChatSession>(`/agents/${agentId}/chat`);
      router.push(`/chat/${session.id}`);
    } catch {
      // A failed resolve is rare (agent just deleted on another device);
      // leave the user on the list rather than pushing a dead route.
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [activeAgent?.id]);

  const selectAgent = useCallback(
    (agent: AgentRecord) => {
      setDrawerOpen(false);
      if (agent.id !== activeAgentId) useAgentMutation.mutate(agent.id);
    },
    [activeAgentId, useAgentMutation]
  );

  // Confirm before archiving — it stops the agent and removes it from the
  // active list. The default agent never reaches here (the drawer renders it
  // as a plain row), matching the server guard that refuses to archive it.
  const confirmArchive = useCallback(
    (agent: AgentRecord) => {
      Alert.alert(
        `Archive ${agent.name}?`,
        `${agent.name} will move to your Archived section and stop running.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Archive",
            style: "destructive",
            onPress: () =>
              archiveMutation.mutate(agent.id, {
                onError: (err) =>
                  Alert.alert("Couldn't archive", err.message || "Please try again.")
              })
          }
        ]
      );
    },
    [archiveMutation]
  );

  const restoreAgent = useCallback(
    (agent: AgentRecord) => {
      unarchiveMutation.mutate(agent.id, {
        onError: (err) =>
          Alert.alert("Couldn't restore", err.message || "Please try again.")
      });
    },
    [unarchiveMutation]
  );

  const onSubmitNewAgent = useCallback(() => {
    const trimmed = newAgentName.trim();
    if (!trimmed) return;
    setNewAgentError(null);
    createAgent.mutate(trimmed, {
      onSuccess: () => {
        setCreateOpen(false);
        setNewAgentName("");
      },
      onError: (err) => setNewAgentError(err.message || "Failed to create agent")
    });
  }, [createAgent, newAgentName]);

  if (unauthorized) return null;

  const refreshing = agents.isFetching && agentList.length > 0;
  const activeName = activeAgent?.name ?? "Gini";
  const online = activeAgent?.status === "ready" || activeAgent?.status === "active";
  const chatSession = activeChat.data;
  const messagesUnread = chatSession ? unreadCounts[chatSession.id] ?? 0 : 0;
  const messagesPreview =
    chatSession?.lastMessagePreview?.trim() ||
    chatSession?.summary?.trim() ||
    "No chats yet";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — the agent switcher. Tapping opens the Agents Drawer. */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setDrawerOpen(true)}
          activeOpacity={0.7}
          style={styles.switcher}
          accessibilityRole="button"
          accessibilityLabel="Switch agent"
        >
          <AgentAvatar name={activeName} size={34} online={online} />
          <Text style={styles.switcherName} numberOfLines={1}>
            {activeName}
          </Text>
          <Feather name="chevron-down" size={18} color={theme.muted} />
        </TouchableOpacity>
      </View>

      {agents.isLoading && agentList.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : agents.isError && agentList.length === 0 ? (
        // Only commandeer the screen with the error + Retry when there's
        // nothing cached to show. A background poll failure with a populated
        // list keeps rendering — the next poll or a pull-to-refresh recovers.
        <View style={styles.center}>
          <Text style={styles.error}>
            {agents.error instanceof Error ? agents.error.message : "Failed to load agents"}
          </Text>
          <TouchableOpacity onPress={() => agents.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                agents.refetch();
                activeChat.refetch();
                topics.refetch();
              }}
              tintColor={theme.muted}
            />
          }
        >
          {/* Chat — the active agent's one canonical chat. */}
          <TouchableOpacity
            onPress={() => void openActiveChat()}
            activeOpacity={0.7}
            style={styles.messagesRow}
            accessibilityRole="button"
            accessibilityLabel={`Open ${activeName} chat`}
          >
            <AgentAvatar name={activeName} size={48} online={online} />
            <View style={styles.messagesBody}>
              <View style={styles.messagesTop}>
                <Text style={styles.messagesTitle} numberOfLines={1}>
                  Chat
                </Text>
                {opening ? (
                  <ActivityIndicator size="small" color={theme.muted} />
                ) : null}
              </View>
              <Text style={styles.messagesPreview} numberOfLines={1}>
                {messagesPreview}
              </Text>
            </View>
            {messagesUnread > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {messagesUnread > 99 ? "99+" : messagesUnread}
                </Text>
              </View>
            ) : null}
          </TouchableOpacity>

          {/* Topics — the active agent's subject-scoped side-conversations. */}
          {topicList.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>Topics</Text>
              {topicList.map((topic) => (
                <TopicRow
                  key={topic.id}
                  topic={topic}
                  unreadCount={unreadCounts[topic.id] ?? 0}
                />
              ))}
            </>
          ) : null}
        </ScrollView>
      )}

      <AgentsDrawer
        visible={drawerOpen}
        agents={activeAgents}
        archivedAgents={archivedAgents}
        activeAgentId={activeAgentId}
        defaultAgentId={defaultAgentId}
        restoringId={unarchiveMutation.isPending ? unarchiveMutation.variables : null}
        onSelect={selectAgent}
        onArchive={confirmArchive}
        onRestore={restoreAgent}
        onNewAgent={() => {
          setDrawerOpen(false);
          setNewAgentError(null);
          setNewAgentName("");
          setCreateOpen(true);
        }}
        onClose={() => setDrawerOpen(false)}
      />

      <NewAgentSheet
        visible={createOpen}
        name={newAgentName}
        error={newAgentError}
        creating={createAgent.isPending}
        onChangeName={setNewAgentName}
        onSubmit={onSubmitNewAgent}
        onCancel={() => setCreateOpen(false)}
      />
    </SafeAreaView>
  );
}

// Topic row — a `#<title>` side-conversation. Tile icon + title/preview +
// unread badge / last-activity time.
function TopicRow({
  topic,
  unreadCount
}: {
  topic: ChatSession;
  unreadCount: number;
}) {
  const title = topic.title?.trim() || "topic";
  const preview =
    topic.lastMessagePreview?.trim() || topic.summary?.trim() || "Topic";
  const time = chatListTime(topic.updatedAt ?? topic.createdAt);
  const isUnread = unreadCount > 0;
  return (
    <TouchableOpacity
      onPress={() => router.push(`/chat/${topic.id}`)}
      activeOpacity={0.7}
      style={styles.topicRow}
      accessibilityRole="button"
      accessibilityLabel={`Open topic ${title}`}
    >
      <View style={styles.topicIcon}>
        <Feather name="hash" size={18} color={theme.placeholder} />
      </View>
      <View style={styles.topicBody}>
        <Text style={styles.topicName} numberOfLines={1}>
          #{title}
        </Text>
        <Text style={styles.topicPreview} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      {isUnread ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </Text>
        </View>
      ) : (
        <Text style={styles.topicTime}>{time}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  switcher: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  switcherName: {
    flexShrink: 1,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19
  },

  content: { paddingHorizontal: 16, paddingBottom: 24 },

  // Chat row — active agent avatar + "Chat" + preview + unread.
  messagesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  messagesBody: { flex: 1, gap: 5 },
  messagesTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8
  },
  messagesTitle: {
    flex: 1,
    color: "#0A0A0A",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  messagesPreview: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    lineHeight: 18
  },

  sectionLabel: {
    color: "#6A6A70",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 13,
    letterSpacing: 0.3,
    paddingTop: 18,
    paddingBottom: 8
  },

  // Topic row — hash tile + title/preview + unread badge / last-activity time.
  topicRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F2F2F2"
  },
  topicIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: "#F2F2F2",
    alignItems: "center",
    justifyContent: "center"
  },
  topicBody: { flex: 1, gap: 2 },
  topicName: {
    color: "#3A3A3A",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  topicPreview: {
    color: theme.placeholder,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },
  topicTime: {
    color: "#B6B6BC",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  },

  badge: {
    minWidth: 20,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "#2F6BFF",
    alignItems: "center",
    justifyContent: "center"
  },
  badgeText: {
    color: "#FFFFFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 12
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 14,
    textAlign: "center"
  },
  retry: { padding: 8 },
  retryText: {
    color: theme.accent,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14
  }
});
