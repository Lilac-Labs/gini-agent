import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { theme } from "@/src/theme";
import type { PendingChatMessage } from "@/src/types";

// The "N Queued" pill above the composer. While a turn is in flight, follow-up
// follow-up chat entries are queued server-side and rendered from the session's
// `pendingMessages` (ADR chat-message-queue.md). Collapsed by default; expands
// to list each queued entry with a × to remove it. The list is server truth
// (kept live via the chat_session SSE frame), so removal here just fires the
// DELETE — the frame drains the row.
export function QueuedMessages({
  pending,
  onRemove
}: {
  pending: PendingChatMessage[];
  onRemove: (pendingId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (pending.length === 0) return null;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${pending.length} queued`}
      >
        <Feather
          name={expanded ? "chevron-down" : "chevron-right"}
          size={16}
          color={theme.subtle}
        />
        <Text style={styles.headerText}>{pending.length} Queued</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.list}>
          {pending.map((message, index) => {
            const trimmed = message.content.trim();
            const imageCount = message.images?.length ?? 0;
            const label =
              trimmed.length > 0 ? trimmed : imageCount > 0 ? "Image" : "";
            return (
              <View
                key={message.id}
                style={[styles.row, index > 0 && styles.rowDivider]}
              >
                {imageCount > 0 ? (
                  <View style={styles.imageIndicator}>
                    <Feather name="image" size={13} color={theme.muted} />
                    <Text style={styles.imageCount}>{imageCount}</Text>
                  </View>
                ) : null}
                <Text
                  style={[styles.rowText, trimmed.length === 0 && styles.rowTextEmpty]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
                <TouchableOpacity
                  onPress={() => onRemove(message.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Remove queued chat"
                  style={styles.remove}
                >
                  <Feather name="x" size={14} color={theme.muted} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    backgroundColor: theme.bg,
    overflow: "hidden"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  headerText: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.subtle
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  imageIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3
  },
  imageCount: {
    fontSize: 12,
    color: theme.muted
  },
  rowText: {
    flex: 1,
    fontSize: 14,
    color: theme.text
  },
  rowTextEmpty: {
    fontStyle: "italic",
    color: theme.muted
  },
  remove: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center"
  }
});
