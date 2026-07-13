"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, CircleAlert, X } from "lucide-react";
import type { ChatSession } from "@/lib/view-types";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./relative-time";

export interface SessionItemProps {
  session: ChatSession;
  isActive: boolean;
  isUnread?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export function SessionItem({
  session,
  isActive,
  isUnread = false,
  onSelect,
  onDelete,
  onRename
}: SessionItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title || "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const startEdit = () => {
    setDraft(session.title || "");
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const finishEdit = (commit: boolean) => {
    if (!editing) return;
    setEditing(false);
    if (!commit) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === session.title) return;
    onRename(trimmed);
  };

  const label = (() => {
    const raw = session.title?.trim() || "New chat";
    return raw.length <= 50 ? raw : `${raw.slice(0, 50)}...`;
  })();

  const time = formatRelativeTime(session.updatedAt ?? session.createdAt);
  const pendingApprovalCount = session.pendingApprovalCount ?? 0;
  const needsApproval = pendingApprovalCount > 0;
  const approvalTitle = needsApproval
    ? pendingApprovalCount === 1
      ? "Awaiting your approval"
      : `Awaiting your approval (${pendingApprovalCount})`
    : undefined;

  return (
    <li>
      <div
        className={cn(
          "group flex h-9 items-center gap-2 rounded-[10px] px-2.5 text-sm transition-colors",
          isActive ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60"
        )}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finishEdit(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finishEdit(true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                finishEdit(false);
              }
            }}
            className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onSelect}
            onDoubleClick={startEdit}
            className="flex min-w-0 flex-1 items-center gap-2 truncate text-left"
            aria-label={(() => {
              const suffixes: string[] = [];
              if (isUnread) suffixes.push("unread");
              if (session.origin === "job") suffixes.push("created by a routine");
              if (needsApproval) suffixes.push("awaiting approval");
              return suffixes.length > 0 ? `${label} (${suffixes.join(", ")})` : label;
            })()}
          >
            {isUnread ? (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
            {session.origin === "job" ? (
              <span
                title="Created by a routine"
                aria-hidden="true"
                className="flex shrink-0 items-center"
              >
                <Bot className="size-3.5 text-muted-foreground" />
              </span>
            ) : null}
            {needsApproval ? (
              <span
                title={approvalTitle}
                aria-hidden="true"
                className="flex shrink-0 items-center"
              >
                <CircleAlert className="size-3.5 text-amber-500" />
              </span>
            ) : null}
            <span className={cn("truncate", isUnread && "font-semibold")}>
              {label}
            </span>
          </button>
        )}
        {!editing && time ? (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground group-hover:hidden">
            {time}
          </span>
        ) : null}
        {!editing ? (
          <button
            type="button"
            aria-label="Delete chat"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
