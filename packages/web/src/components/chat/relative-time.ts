/** Format an ISO string or Unix ms timestamp as a relative time string. */
export function formatRelativeTime(input: string | number): string {
  const ts = typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Format a home Recents row timestamp: same-day renders the clock time only
 * ("12:19 PM"), anything older renders a short month/day ("Jul 1").
 */
export function formatRecentTimestamp(input: string | number): string {
  const ts = typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Format an ISO/ms timestamp for display next to a chat message. */
export function formatMessageTimestamp(input: string | number): string {
  const ts = typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  if (isYesterday) return `Yesterday ${time}`;
  const md = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${md}, ${time}`;
}
