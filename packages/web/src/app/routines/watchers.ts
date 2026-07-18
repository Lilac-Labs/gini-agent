import type { EmailWatcherRecord } from "@runtime/types";

// Presentation helpers for email-watcher routines, shared by the gallery and
// the watcher detail page. Matcher precedence mirrors the runtime's
// sender / thread / raw-query order (see JobFanout's matcherLabel), but the
// thread id itself is omitted — it's an opaque Gmail id, noise as a title.
export function watcherMatcherLabel(watcher: EmailWatcherRecord): string {
  if (watcher.sender) return `Email: ${watcher.sender}`;
  if (watcher.threadId) return "Email thread";
  return watcher.query;
}

// Card title: prefer the user's stated objective (Town-style — "Get the Plaud
// refund" reads better than the matcher), fall back to the matcher label.
export function watcherTitle(watcher: EmailWatcherRecord): string {
  return watcher.objective?.trim() || watcherMatcherLabel(watcher);
}

// Card description: whichever of objective/matcher the title didn't use.
export function watcherDescription(watcher: EmailWatcherRecord): string {
  return watcher.objective?.trim() ? watcherMatcherLabel(watcher) : watcher.query;
}

// The concern's own channel, falling back to the legacy shared session for
// watchers predating per-concern channels (same fallback the runtime uses).
export function watcherChannelId(watcher: EmailWatcherRecord): string | undefined {
  return watcher.channelId ?? watcher.chatSessionId;
}
