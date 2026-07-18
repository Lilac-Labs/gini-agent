"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ImageIcon, X } from "lucide-react";
import type { PendingChatMessage } from "@runtime/types";
import { cn } from "@/lib/utils";

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

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border bg-background text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Chevron className="size-4 shrink-0" />
        <span>
          {pending.length} Queued
        </span>
      </button>
      {expanded ? (
        <ul className="border-t">
          {pending.map((message) => (
            <li
              key={message.id}
              className="flex items-center gap-2 px-3 py-2 not-last:border-b"
            >
              {message.images && message.images.length > 0 ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                  title={`${message.images.length} image${message.images.length === 1 ? "" : "s"}`}
                >
                  <ImageIcon className="size-3.5" />
                  {message.images.length}
                </span>
              ) : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  message.content.trim().length === 0 && "italic text-muted-foreground"
                )}
              >
                {message.content.trim().length > 0
                  ? message.content
                  : message.images && message.images.length > 0
                    ? "Image"
                    : ""}
              </span>
              <button
                type="button"
                onClick={() => onRemove(message.id)}
                aria-label="Remove queued chat"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
