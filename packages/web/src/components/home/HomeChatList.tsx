"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Archive, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { HomeSectionHeader } from "@/components/home/HomeSectionHeader";
import { selectHomeChatSessions } from "@/components/home/home-chat-sessions";
import { api } from "@/lib/api";
import { useAllChatSessions, useInvalidate, useStatus } from "@/lib/queries";
import { useChatReadState } from "@/lib/use-chat-read-state";
import { cn } from "@/lib/utils";
import type { ChatSession } from "@/lib/view-types";

export function HomeChatList() {
  const router = useRouter();
  const invalidate = useInvalidate();
  const status = useStatus();
  const allSessions = useAllChatSessions();
  const [open, setOpen] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const chats = useMemo(
    () => selectHomeChatSessions(allSessions.data ?? [], status.data?.activeAgent?.id),
    [allSessions.data, status.data?.activeAgent?.id]
  );
  const { isUnread } = useChatReadState(allSessions.data);

  const archive = useMutation({
    mutationFn: (session: ChatSession) =>
      api(`/containers/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true })
      }),
    onSuccess: (_data, session) => {
      toast.success(`"${session.title}" archived`);
      invalidate(["chat", "home", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <HomeSectionHeader
          title="Chats"
          count={chats.length}
          open={open}
          onToggle={() => setOpen((value) => !value)}
        />

        {open && chats.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <span data-ph-capture="true">No chats yet</span>
          </div>
        ) : open ? (
          <ul className="flex flex-col gap-0.5">
            {chats.map((session) => {
              const unread = isUnread(session);
              return (
                <li
                  key={session.id}
                  className="ph-no-capture group/row flex items-center rounded-lg transition-colors hover:bg-accent/45"
                >
                  <button
                    type="button"
                    aria-label={unread ? `${session.title} (unread)` : session.title}
                    onClick={() => router.push(`/chat?session=${session.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span
                      aria-hidden
                      className="w-4 shrink-0 text-center text-sm font-medium text-muted-foreground"
                    >
                      #
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[14px] text-foreground",
                        unread && "font-semibold"
                      )}
                    >
                      {session.title}
                    </span>
                    {unread ? (
                      <span
                        aria-hidden
                        className="size-[7px] shrink-0 rounded-full bg-sidebar-primary"
                      />
                    ) : null}
                  </button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Actions for ${session.title}`}
                        className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onSelect={() => archive.mutate(session)}>
                        <Archive className="size-3.5" />
                        Archive
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleteTarget(session)}
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <DeleteConversationDialog
        session={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={() => invalidate(["chat", "home", "state"])}
      />
    </>
  );
}

// Confirm before permanently deleting a Home Chats row. The server refuses
// while a run is live (409), and the toast keeps that reason visible.
function DeleteConversationDialog({
  session,
  open,
  onOpenChange,
  onDeleted
}: {
  session: ChatSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/containers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(session ? `"${session.title}" deleted` : "Conversation deleted");
      onOpenChange(false);
      onDeleted();
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="ph-no-capture">
            Delete {session ? `"${session.title}"` : "this conversation"}?
          </DialogTitle>
          <DialogDescription>
            <span data-ph-capture="true">
              This permanently deletes the conversation and its full history. This can&apos;t be
              undone.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={remove.isPending}
          >
            <span data-ph-capture="true">Cancel</span>
          </Button>
          <Button
            variant="destructive"
            onClick={() => session && remove.mutate(session.id)}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Deleting…" : <span data-ph-capture="true">Delete</span>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
